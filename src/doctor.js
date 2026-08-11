'use strict';

// Advisory doctor / model-API live canary.
// Separates local binary/config preflight from a real harness/model lifecycle probe.
// Never treats binary-in-PATH success as live success. Not a promotion gate (see T09).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KINDS, resolveModel } = require('./kinds');
const ledger = require('./ledger');
const live = require('./live');

const SCHEMA_VERSION = 'doctor-v1';
const DEFAULT_LIVE_TIMEOUT_MS = 120000;
const DEFAULT_CONFIRM_START_MS = 15000;
/** Same tail window for baseline and post-read — unequal windows are forbidden. */
const OUTPUT_CAPTURE_TAIL = 200;
const SANITIZE_MAX_LEN = 400;

/** Stable error codes surfaced in JSON (and mapped to nonzero exit by CLI). */
const ERROR_CODES = Object.freeze({
  OK: null,
  KIND_REQUIRED_FOR_LIVE: 'kind_required_for_live',
  UNSUPPORTED_KIND: 'unsupported_kind',
  UNSUPPORTED_MODEL: 'unsupported_model',
  EXECUTABLE_UNAVAILABLE: 'executable_unavailable',
  HERDR_UNAVAILABLE: 'herdr_unavailable',
  SPAWN_FAILED: 'spawn_failed',
  AMBIGUOUS_TRANSPORT: 'ambiguous_transport',
  TIMEOUT: 'timeout',
  LIFECYCLE_WITHOUT_TOKEN: 'lifecycle_without_token',
  STALE_PREEXISTING_TOKEN: 'stale_preexisting_token',
  STALE_OUTPUT_AMBIGUOUS: 'stale_output_ambiguous',
  AUTH_OR_API_FAILURE: 'auth_or_api_failure',
  CLEANUP_FAILED: 'cleanup_failed',
  CLEANUP_GUARDED: 'cleanup_guarded',
  LIVE_PROBE_FAILED: 'live_probe_failed',
});

const AUTH_API_RE =
  /unauthoriz|authentication|api[\s_-]?key|invalid[\s_-]?key|entitlement|quota|rate[\s_-]?limit|model[\s_-]?not[\s_-]?found|unknown[\s_-]?model|does[\s_-]?not[\s_-]?exist|permission[\s_-]?denied|403|401/i;

function reverseToken(token) {
  return Array.from(String(token)).reverse().join('');
}

/** Non-reversible audit digest for public doctor JSON (never emit raw token/marker). */
function sha256Digest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

/**
 * Build unique probe token + expected response marker.
 * Marker is derived (reversed) so mere prompt echo of the raw token is not enough.
 * Raw token/marker stay internal; public reports expose only digests.
 */
function buildProbeMaterial(opts = {}) {
  const raw =
    opts.token ||
    `HLDOC_${crypto.randomBytes(8).toString('hex')}`;
  const expectedMarker = `DOCTOR_REV:${reverseToken(raw)}`;
  const promptText =
    opts.promptText ||
    [
      'This is a herdr-live doctor model/API probe (advisory diagnostic only).',
      `Secret token: ${raw}`,
      `Reply with exactly one line: DOCTOR_REV: followed immediately by the reverse of the secret token.`,
      'Example shape: DOCTOR_REV:<reversed-token>',
      'No tools. No preamble. No trailing commentary.',
    ].join('\n');
  return {
    token: raw,
    expectedMarker,
    promptText,
    tokenDigest: sha256Digest(raw),
    markerDigest: sha256Digest(expectedMarker),
  };
}

function makeProbeName(opts = {}) {
  if (opts.probeName) return String(opts.probeName);
  const stamp = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `hl-doc-${stamp}-${process.pid}-${rnd}`;
}

/**
 * Sanitize externally sourced text before inclusion in doctor JSON.
 * Redacts secrets, probe token/marker, prompt bodies; bounds length.
 */
function sanitizeDoctorText(text, opts = {}) {
  let s = String(text == null ? '' : text);
  // Common secret / credential shapes first (may also appear outside prompt bodies).
  s = s.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-<redacted>');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>');
  s = s.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*\S+/gi,
    '$1=<redacted>'
  );
  s = s.replace(
    /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*=\s*\S+/g,
    '$1=<redacted>'
  );
  if (opts.probeToken) {
    const tok = String(opts.probeToken);
    if (tok) s = s.split(tok).join('<probe-token>');
    const marker = `DOCTOR_REV:${reverseToken(tok)}`;
    s = s.split(marker).join('<probe-marker>');
  }
  if (opts.expectedMarker) {
    s = s.split(String(opts.expectedMarker)).join('<probe-marker>');
  }
  // Drop herdr agent prompt command bodies (target kept, body redacted).
  s = s.replace(
    /(herdr\s+agent\s+prompt\s+\S+)\s+[\s\S]*/i,
    '$1 <prompt-body-redacted>'
  );
  // Avoid dumping huge stderr/stdout.
  if (s.length > SANITIZE_MAX_LEN) {
    s = `${s.slice(0, SANITIZE_MAX_LEN)}…<truncated>`;
  }
  return s;
}

/**
 * Prove a strictly post-baseline suffix using one comparable capture window.
 * Only accepts post that starts with baseline (monotonic extension).
 * Never falls back to searching the full post-read when relation is unknown.
 */
function extractPostBaselineSuffix(baseline, post) {
  const base = String(baseline == null ? '' : baseline);
  const cur = String(post == null ? '' : post);
  if (base.length === 0) {
    return {
      ok: false,
      code: ERROR_CODES.STALE_OUTPUT_AMBIGUOUS,
      message:
        'empty baseline capture; cannot prove post-submission output relation (fail-closed)',
      suffix: '',
    };
  }
  if (!cur.startsWith(base)) {
    return {
      ok: false,
      code: ERROR_CODES.STALE_OUTPUT_AMBIGUOUS,
      message:
        'post-read is not a monotonic extension of the baseline capture; ' +
        'refusing full-buffer fallback (fail-closed)',
      suffix: '',
    };
  }
  return { ok: true, code: null, message: null, suffix: cur.slice(base.length) };
}

function checkExecutable(command, executableInPathFn) {
  const fn = executableInPathFn || live.executableInPath;
  return {
    command: command || null,
    in_path: Boolean(command) && fn(command),
  };
}

function resolveKindModel(kind, model) {
  if (!kind) {
    const err = new Error('--live 需要 --kind（cursor|claude|codex）');
    err.code = ERROR_CODES.KIND_REQUIRED_FOR_LIVE;
    throw err;
  }
  if (!KINDS[kind]) {
    const err = new Error(
      `未配置的 agent kind：${kind}（支持：${Object.keys(KINDS).join(', ')}）`
    );
    err.code = ERROR_CODES.UNSUPPORTED_KIND;
    throw err;
  }
  let resolvedModel;
  try {
    resolvedModel = resolveModel(kind, model);
  } catch (e) {
    const err = new Error(e.message || String(e));
    err.code = /未配置的 agent kind/.test(String(e.message))
      ? ERROR_CODES.UNSUPPORTED_KIND
      : ERROR_CODES.UNSUPPORTED_MODEL;
    throw err;
  }
  return { kind, model: resolvedModel, profile: KINDS[kind] };
}

function emptyLiveProbe(requested) {
  return {
    requested: Boolean(requested),
    ok: requested ? false : null,
    status: requested ? 'pending' : 'not_requested',
    probe_name: null,
    // Public correlation only — never emit raw probe token / derived marker.
    probe_token_digest: null,
    expected_marker_digest: null,
    token_in_output: false,
    lifecycle_observed: false,
    transport_phase: null,
    receipt: null,
    error_code: null,
    error: null,
    scratch_cwd: null,
    cleanup: {
      attempted: false,
      ok: true,
      outcome: requested ? 'pending' : 'not_needed',
      details: null,
    },
  };
}

/**
 * Final public-report scrub: strip legacy raw fields, re-sanitize free text,
 * and normalize non-terminal placeholders so they never escape a completed result.
 */
function scrubPublicReport(report, sanitizeOpts) {
  if (!report || typeof report !== 'object') return report;
  const lp = report.live_probe;
  if (lp && typeof lp === 'object') {
    delete lp.probe_token;
    delete lp.expected_marker;

    // doctor() is synchronous: "pending" is internal-only and must not escape.
    if (lp.status === 'pending') {
      lp.status = lp.requested ? 'skipped' : 'not_requested';
    }
    if (!lp.cleanup || typeof lp.cleanup !== 'object') {
      lp.cleanup = {
        attempted: false,
        ok: true,
        outcome: 'not_needed',
        details: null,
      };
    } else if (lp.cleanup.outcome === 'pending') {
      // Pre-pane / early returns never created a probe to clean up.
      lp.cleanup = {
        attempted: false,
        ok: true,
        outcome: 'not_needed',
        details: null,
      };
    }

    if (sanitizeOpts) {
      if (lp.error != null) {
        lp.error = sanitizeDoctorText(lp.error, sanitizeOpts);
      }
      if (Array.isArray(report.local_preflight && report.local_preflight.details)) {
        report.local_preflight.details = report.local_preflight.details.map((d) =>
          sanitizeDoctorText(d, sanitizeOpts)
        );
      }
      if (lp.cleanup && lp.cleanup.details && typeof lp.cleanup.details === 'object') {
        const d = lp.cleanup.details;
        if (d.error != null) d.error = sanitizeDoctorText(d.error, sanitizeOpts);
        if (Array.isArray(d.errors)) {
          d.errors = d.errors.map((e) => sanitizeDoctorText(e, sanitizeOpts));
        }
      }
    }
  }
  return report;
}

/**
 * Local-only preflight: binary/config availability. Never spawns or calls a model.
 */
function localPreflight(opts = {}) {
  const {
    kind = null,
    model = null,
    executableInPathFn = live.executableInPath,
    herdrAvailableFn = null,
  } = opts;

  const details = [];
  let errorCode = null;
  let resolvedKind = null;
  let resolvedModel = null;
  const executables = {};

  const herdrCheck =
    typeof herdrAvailableFn === 'function'
      ? Boolean(herdrAvailableFn())
      : live.executableInPath('herdr');
  if (!herdrCheck) {
    details.push('herdr 不在 PATH');
    errorCode = ERROR_CODES.HERDR_UNAVAILABLE;
  }

  if (kind != null && String(kind).length > 0) {
    try {
      const resolved = resolveKindModel(kind, model);
      resolvedKind = resolved.kind;
      resolvedModel = resolved.model;
      const exe = checkExecutable(resolved.profile.command, executableInPathFn);
      executables[resolved.kind] = exe;
      if (!exe.in_path) {
        details.push(`kind=${resolved.kind} 可执行文件 ${exe.command} 不在 PATH`);
        errorCode = errorCode || ERROR_CODES.EXECUTABLE_UNAVAILABLE;
      }
    } catch (e) {
      details.push(sanitizeDoctorText(e.message || String(e)));
      errorCode = errorCode || e.code || ERROR_CODES.UNSUPPORTED_KIND;
    }
  } else {
    for (const [k, profile] of Object.entries(KINDS)) {
      const exe = checkExecutable(profile.command, executableInPathFn);
      executables[k] = exe;
      if (!exe.in_path) {
        details.push(`kind=${k} 可执行文件 ${exe.command} 不在 PATH`);
      }
    }
  }

  const ok = errorCode == null;
  return {
    ok,
    error_code: errorCode,
    herdr_env: process.env.HERDR_ENV === '1',
    herdr_in_path: herdrCheck,
    kind: resolvedKind,
    model: resolvedModel,
    executables,
    details,
  };
}

function classifyLiveFailure({
  transportPhase,
  markerFound,
  outputText,
  timedOut,
  error,
  relationFailed,
}) {
  if (relationFailed) {
    return {
      code: ERROR_CODES.STALE_OUTPUT_AMBIGUOUS,
      message: String(error || 'output baseline relation unproven (fail-closed)'),
    };
  }
  if (timedOut) {
    return { code: ERROR_CODES.TIMEOUT, message: String(error || 'live probe timeout') };
  }
  if (transportPhase === 'ambiguous') {
    return {
      code: ERROR_CODES.AMBIGUOUS_TRANSPORT,
      message: String(error || 'transport ambiguous（禁止自动重发）'),
    };
  }
  if (transportPhase && transportPhase !== 'lifecycle_observed') {
    return {
      code: ERROR_CODES.AMBIGUOUS_TRANSPORT,
      message: String(error || `transport_phase=${transportPhase}`),
    };
  }
  if (!markerFound) {
    if (AUTH_API_RE.test(String(outputText || '')) || AUTH_API_RE.test(String(error || ''))) {
      return {
        code: ERROR_CODES.AUTH_OR_API_FAILURE,
        message: String(
          error || 'lifecycle/output suggests auth/API/model failure; marker missing'
        ),
      };
    }
    return {
      code: ERROR_CODES.LIFECYCLE_WITHOUT_TOKEN,
      message: String(
        error ||
          'lifecycle evidence without expected probe marker in post-submission output'
      ),
    };
  }
  return {
    code: ERROR_CODES.LIVE_PROBE_FAILED,
    message: String(error || 'live probe failed'),
  };
}

function summarizeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  return {
    submission_id: receipt.submission_id || null,
    transport_phase: receipt.transport_phase || null,
    confirmed: Boolean(receipt.confirmed),
    submitted: Boolean(receipt.submitted),
    prompt_digest: receipt.prompt_digest || null,
    baseline: receipt.baseline || null,
    observed: receipt.observed || null,
    target: receipt.target
      ? {
          name: receipt.target.name || null,
          pane_id: receipt.target.pane_id || null,
          kind: receipt.target.kind || null,
          via: receipt.target.via || null,
        }
      : null,
  };
}

function finalizeReport(report, sanitizeOpts) {
  if (report.mode === 'local') {
    report.ok = Boolean(report.local_preflight && report.local_preflight.ok);
    report.error_code = report.ok
      ? null
      : (report.local_preflight && report.local_preflight.error_code) || null;
    return scrubPublicReport(report, sanitizeOpts);
  }

  if (!report.live_probe.cleanup.ok) {
    report.live_probe.ok = false;
    if (report.live_probe.status === 'pass') report.live_probe.status = 'fail';
    const guarded =
      report.live_probe.cleanup.outcome === 'guarded' ||
      report.live_probe.error_code === ERROR_CODES.CLEANUP_GUARDED;
    const code = guarded ? ERROR_CODES.CLEANUP_GUARDED : ERROR_CODES.CLEANUP_FAILED;
    report.error_code = code;
    report.live_probe.error_code = code;
    report.live_probe.error =
      report.live_probe.error ||
      (guarded
        ? 'probe cleanup guarded (working/blocked/unknown); left for inspection; never auto-force'
        : 'probe cleanup failed (exact probe only; never kill --all; never auto-force)');
  }

  report.ok =
    Boolean(report.local_preflight && report.local_preflight.ok) &&
    report.live_probe.status === 'pass' &&
    Boolean(report.live_probe.ok) &&
    Boolean(report.live_probe.cleanup.ok);

  if (report.ok) {
    report.error_code = null;
  } else if (!report.error_code) {
    report.error_code =
      (report.live_probe && report.live_probe.error_code) ||
      (report.local_preflight && report.local_preflight.error_code) ||
      ERROR_CODES.LIVE_PROBE_FAILED;
  }
  return scrubPublicReport(report, sanitizeOpts);
}

/**
 * Guarded cleanup only — never auto-force.
 * If kill returns guarded / not closed, leave the exact probe for inspection.
 */
async function cleanupProbe(report, probeName, killFn, sanitizeOpts) {
  report.live_probe.cleanup.attempted = true;
  try {
    // Intentionally no force: same safeguards as normal herdr-live kill.
    const killRes = killFn(probeName);
    const errors = ((killRes && killRes.errors) || []).map((e) =>
      sanitizeDoctorText(e, sanitizeOpts)
    );
    report.live_probe.cleanup.details = {
      name: killRes && killRes.name,
      closed: killRes && killRes.closed,
      reclaimed: killRes && killRes.reclaimed,
      guarded: killRes && killRes.guarded,
      state: killRes && killRes.state,
      force: false,
      errors,
    };
    if (killRes && killRes.guarded) {
      report.live_probe.cleanup.ok = false;
      report.live_probe.cleanup.outcome = 'guarded';
      report.live_probe.error_code = ERROR_CODES.CLEANUP_GUARDED;
      report.live_probe.error = sanitizeDoctorText(
        `cleanup guarded: agent state=${killRes.state || 'unknown'}; left for inspection; never auto-force`,
        sanitizeOpts
      );
    } else if (killRes && killRes.closed) {
      report.live_probe.cleanup.ok = true;
      report.live_probe.cleanup.outcome = 'closed';
    } else if (killRes && killRes.reclaimed) {
      report.live_probe.cleanup.ok = true;
      report.live_probe.cleanup.outcome = 'already_gone';
    } else {
      report.live_probe.cleanup.ok = false;
      report.live_probe.cleanup.outcome = 'failed';
      report.live_probe.error_code = ERROR_CODES.CLEANUP_FAILED;
    }
  } catch (e) {
    const msg = String(e.message || e);
    if (/台账里没有|not found|gone/i.test(msg)) {
      report.live_probe.cleanup.ok = true;
      report.live_probe.cleanup.outcome = 'already_gone';
      report.live_probe.cleanup.details = {
        error: sanitizeDoctorText(msg, sanitizeOpts),
        force: false,
      };
    } else {
      report.live_probe.cleanup.ok = false;
      report.live_probe.cleanup.outcome = 'failed';
      report.live_probe.cleanup.details = {
        error: sanitizeDoctorText(msg, sanitizeOpts),
        force: false,
      };
      report.live_probe.error_code = ERROR_CODES.CLEANUP_FAILED;
    }
  }
}

/**
 * Run doctor diagnostic.
 *
 * @param {object} opts
 * @param {boolean} [opts.live=false]
 * @param {string} [opts.kind]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.cwd] scratch workdir for live probe (default: mkdtemp)
 * @param {object} [opts.hooks] test seams — override spawn/submitPrompt/read/wait/kill/etc.
 * @returns {Promise<object>} structured doctor report
 */
async function doctor(opts = {}) {
  const liveRequested = Boolean(opts.live);
  const timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : DEFAULT_LIVE_TIMEOUT_MS;
  const confirmStartMs =
    opts.confirmStartMs != null ? Number(opts.confirmStartMs) : DEFAULT_CONFIRM_START_MS;
  const captureTail =
    opts.captureTail != null ? Number(opts.captureTail) : OUTPUT_CAPTURE_TAIL;
  const hooks = opts.hooks || {};

  const spawnFn = hooks.spawn || ((name, o) => live.spawn(name, o));
  const submitPromptFn = hooks.submitPrompt || ((o) => live.submitPrompt(o));
  const readFn = hooks.read || ((name, o) => live.read(name, o));
  const waitFn = hooks.wait || ((name, o) => live.wait(name, o));
  const killFn = hooks.kill || ((name, o) => live.kill(name, o));
  const executableInPathFn = hooks.executableInPath || live.executableInPath;
  const herdrAvailableFn = hooks.herdrAvailable;
  const mkdtempFn =
    hooks.mkdtempSync || ((prefix) => fs.mkdtempSync(prefix));
  const rmSyncFn = hooks.rmSync || ((p, o) => fs.rmSync(p, o));

  const report = {
    schema_version: SCHEMA_VERSION,
    advisory: true,
    ok: false,
    mode: liveRequested ? 'live' : 'local',
    error_code: null,
    local_preflight: null,
    live_probe: emptyLiveProbe(liveRequested),
  };

  // --- local preflight (always; never spawns) ---
  const preflightKind = liveRequested ? opts.kind : opts.kind || null;
  report.local_preflight = localPreflight({
    kind: preflightKind,
    model: opts.model,
    executableInPathFn,
    herdrAvailableFn,
  });

  if (!report.local_preflight.ok) {
    report.error_code = report.local_preflight.error_code;
    report.live_probe.status = liveRequested ? 'skipped' : 'not_requested';
    report.live_probe.ok = liveRequested ? false : null;
    return finalizeReport(report, null);
  }

  if (!liveRequested) {
    report.live_probe.status = 'not_requested';
    report.live_probe.ok = null;
    return finalizeReport(report, null);
  }

  // --- live path: resolve exact kind/model again (fail before pane) ---
  let resolved;
  try {
    resolved = resolveKindModel(opts.kind, opts.model);
  } catch (e) {
    report.local_preflight.ok = false;
    report.local_preflight.error_code = e.code || ERROR_CODES.UNSUPPORTED_KIND;
    report.local_preflight.details.push(sanitizeDoctorText(e.message || String(e)));
    report.error_code = e.code || ERROR_CODES.UNSUPPORTED_KIND;
    report.live_probe.status = 'skipped';
    report.live_probe.error_code = report.error_code;
    report.live_probe.error = sanitizeDoctorText(e.message || String(e));
    return finalizeReport(report, null);
  }

  const exe = checkExecutable(resolved.profile.command, executableInPathFn);
  report.local_preflight.kind = resolved.kind;
  report.local_preflight.model = resolved.model;
  report.local_preflight.executables[resolved.kind] = exe;
  if (!exe.in_path) {
    report.local_preflight.ok = false;
    report.local_preflight.error_code = ERROR_CODES.EXECUTABLE_UNAVAILABLE;
    report.local_preflight.details.push(
      `kind=${resolved.kind} 可执行文件 ${exe.command} 不在 PATH；未创建 pane`
    );
    report.error_code = ERROR_CODES.EXECUTABLE_UNAVAILABLE;
    report.live_probe.status = 'skipped';
    report.live_probe.error_code = ERROR_CODES.EXECUTABLE_UNAVAILABLE;
    report.live_probe.error = report.local_preflight.details.slice(-1)[0];
    return finalizeReport(report, null);
  }

  const material = buildProbeMaterial({
    token: opts.probeToken,
    promptText: opts.probePromptText,
  });
  const sanitizeOpts = {
    probeToken: material.token,
    expectedMarker: material.expectedMarker,
  };
  const probeName = makeProbeName({ probeName: opts.probeName });
  let scratchCwd = opts.cwd || null;
  let createdScratch = false;
  if (!scratchCwd) {
    scratchCwd = mkdtempFn(path.join(os.tmpdir(), 'herdr-live-doctor-'));
    createdScratch = true;
  }

  report.live_probe.probe_name = probeName;
  report.live_probe.probe_token_digest = material.tokenDigest;
  report.live_probe.expected_marker_digest = material.markerDigest;
  report.live_probe.scratch_cwd = scratchCwd;
  report.live_probe.capture_tail = captureTail;

  let shouldCleanup = false;

  try {
    let aborted = false;
    try {
      spawnFn(probeName, {
        kind: resolved.kind,
        model: resolved.model,
        cwd: scratchCwd,
        label: `doctor-${probeName}`,
      });
      shouldCleanup = true;
    } catch (e) {
      shouldCleanup = Boolean(ledger.get(probeName));
      report.live_probe.status = 'fail';
      report.live_probe.error_code = ERROR_CODES.SPAWN_FAILED;
      report.live_probe.error = sanitizeDoctorText(e.message || String(e), sanitizeOpts);
      report.error_code = ERROR_CODES.SPAWN_FAILED;
      aborted = true;
    }

    if (!aborted) {
      try {
        await waitFn(probeName, {
          until: ['idle', 'working', 'done'],
          timeoutMs: Math.min(timeoutMs, 60000),
        });
      } catch (e) {
        report.live_probe.status = 'fail';
        report.live_probe.error_code = ERROR_CODES.TIMEOUT;
        report.live_probe.error = sanitizeDoctorText(e.message || String(e), sanitizeOpts);
        report.error_code = ERROR_CODES.TIMEOUT;
        aborted = true;
      }
    }

    let baselineOut = '';
    if (!aborted) {
      try {
        baselineOut = String(readFn(probeName, { tail: captureTail }) || '');
      } catch (e) {
        baselineOut = '';
      }
      if (baselineOut.includes(material.expectedMarker)) {
        report.live_probe.status = 'fail';
        report.live_probe.error_code = ERROR_CODES.STALE_PREEXISTING_TOKEN;
        report.live_probe.error = sanitizeDoctorText(
          'expected probe marker already present in agent output before submission',
          sanitizeOpts
        );
        report.live_probe.token_in_output = true;
        report.error_code = ERROR_CODES.STALE_PREEXISTING_TOKEN;
        aborted = true;
      }
    }

    let receipt = null;
    let transportPhase = null;
    if (!aborted) {
      try {
        receipt = await submitPromptFn({
          target: probeName,
          text: material.promptText,
          waitUntil: ['idle', 'done'],
          timeoutMs,
          confirmStartMs,
          settleMs: opts.settleMs != null ? Number(opts.settleMs) : undefined,
          forcePaste: true,
          forceProfile: opts.forceProfile || undefined,
          skipLock: Boolean(opts.skipLock),
        });
        transportPhase = receipt && receipt.transport_phase;
        report.live_probe.receipt = summarizeReceipt(receipt);
        report.live_probe.transport_phase = transportPhase;
        report.live_probe.lifecycle_observed = transportPhase === 'lifecycle_observed';
      } catch (e) {
        receipt = e.receipt || null;
        transportPhase = (receipt && receipt.transport_phase) || e.transport_phase || null;
        report.live_probe.receipt = summarizeReceipt(receipt);
        report.live_probe.transport_phase = transportPhase;
        report.live_probe.lifecycle_observed = transportPhase === 'lifecycle_observed';
        const rawMsg = e.message || String(e);
        const timedOut = /timeout|超时/i.test(String(rawMsg));
        const classified = classifyLiveFailure({
          transportPhase,
          markerFound: false,
          outputText: '',
          timedOut,
          error: rawMsg,
        });
        report.live_probe.status = 'fail';
        report.live_probe.error_code = classified.code;
        report.live_probe.error = sanitizeDoctorText(classified.message, sanitizeOpts);
        report.error_code = classified.code;
        aborted = true;
      }
    }

    if (!aborted) {
      let outputText = '';
      try {
        // Same capture tail as baseline — unequal windows are a false-pass vector.
        outputText = String(readFn(probeName, { tail: captureTail }) || '');
      } catch (e) {
        outputText = '';
      }
      const relation = extractPostBaselineSuffix(baselineOut, outputText);
      if (!relation.ok) {
        report.live_probe.status = 'fail';
        report.live_probe.ok = false;
        report.live_probe.token_in_output = false;
        report.live_probe.error_code = relation.code;
        report.live_probe.error = sanitizeDoctorText(relation.message, sanitizeOpts);
        report.error_code = relation.code;
      } else {
        const markerFound = relation.suffix.includes(material.expectedMarker);
        report.live_probe.token_in_output = markerFound;

        if (transportPhase === 'lifecycle_observed' && markerFound) {
          report.live_probe.status = 'pass';
          report.live_probe.ok = true;
          report.live_probe.error_code = null;
          report.live_probe.error = null;
        } else {
          const classified = classifyLiveFailure({
            transportPhase,
            markerFound,
            outputText: relation.suffix,
            timedOut: false,
            error: null,
          });
          report.live_probe.status = 'fail';
          report.live_probe.ok = false;
          report.live_probe.error_code = classified.code;
          report.live_probe.error = sanitizeDoctorText(classified.message, sanitizeOpts);
          report.error_code = classified.code;
        }
      }
    }
  } finally {
    if (shouldCleanup) {
      await cleanupProbe(report, probeName, killFn, sanitizeOpts);
    } else {
      report.live_probe.cleanup.attempted = false;
      report.live_probe.cleanup.ok = true;
      report.live_probe.cleanup.outcome = 'not_needed';
    }

    if (createdScratch && scratchCwd) {
      try {
        rmSyncFn(scratchCwd, { recursive: true, force: true });
      } catch (e) {
        // best-effort scratch dir cleanup
      }
    }
  }

  return finalizeReport(report, sanitizeOpts);
}

module.exports = {
  SCHEMA_VERSION,
  ERROR_CODES,
  DEFAULT_LIVE_TIMEOUT_MS,
  OUTPUT_CAPTURE_TAIL,
  SANITIZE_MAX_LEN,
  doctor,
  localPreflight,
  buildProbeMaterial,
  reverseToken,
  sha256Digest,
  makeProbeName,
  resolveKindModel,
  classifyLiveFailure,
  sanitizeDoctorText,
  extractPostBaselineSuffix,
  scrubPublicReport,
};
