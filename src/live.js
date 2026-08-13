'use strict';

// herdr-live 的五个核心动词：spawn / prompt / read / wait / kill。
// 每个动词把一段易错的 herdr 底层序列变成语义明确的调用，把踩过的坑固化进来：
//  - spawn：tab create 拿 pane_id/tab_id + agent start 按 kind 拼对 flags；缺 --model 时用 kind 默认；
//  - prompt / submitPrompt：版本感知的 canonical prompt transport + 结构化 fail-closed receipt；
//    submitPrompt 的 target 同时支持 herdr-live 台账名与 pane_id（叫醒场景常无台账）；
//  - wait：轮询 herdr 实时状态到目标态，超时报错；
//  - read：agent read 取终端，可选只取尾部；
//  - kill：关 tab 收资源，清台账。

const fs = require('fs');
const path = require('path');
const herdrMod = require('./herdr');
const { result, deepId } = herdrMod;
const {
  adapterFlags,
  submitNeedsEnter,
  resolveModel,
  defaultSettleMs,
  buildBriefPointer,
  PASTE_SOFT_LIMIT_BYTES,
  KINDS,
} = require('./kinds');
const ledger = require('./ledger');
const receiptMod = require('./receipt');
const { acquireTargetLock } = require('./target_lock');
const {
  resolveVersionProfile,
  shouldSendEnter,
  assertTransportAllowed,
} = require('./version_profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 投喂后必须在此时间内观察到相对 baseline 的生命周期证据，否则 ambiguous。 */
const DEFAULT_CONFIRM_START_MS = 15000;
/** Workspace Trust 识别只扫 recent-unwrapped 末尾若干行，不并进通用权限 UI。 */
const WORKSPACE_TRUST_READ_LINES = 80;

function executableInPath(command) {
  if (!command || command.includes('/') || command.includes('\\')) return false;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  });
}

/** herdr pane_id 形如 w3:p16 / w3:p3G（workspace:pane）。 */
function isPaneId(target) {
  return typeof target === 'string' && /^w\d+:p[\w]+$/i.test(target.trim());
}

/**
 * 解析投喂目标：pane_id（可无台账）或 herdr-live/herdr 名。
 * 返回 { herdrTarget, name, pane_id, kind, cwd, via }。
 */
function resolveSubmitTarget(target, opts = {}) {
  if (target == null || String(target).trim() === '') {
    throw new herdrMod.HerdrError('submitPrompt 需要 target（pane_id 或 agent name）');
  }
  const raw = String(target).trim();

  if (isPaneId(raw) || opts.asPaneId) {
    let kind = opts.kind || null;
    let cwd = opts.cwd || null;
    let pane_id = raw;
    // 尽量从 herdr 实时记录补 kind/cwd（settle 默认依赖 kind）
    try {
      const rec = herdrMod.agentRecord(raw);
      const agentKind = herdrMod.unwrap(rec.agent || rec.kind);
      if (!kind && typeof agentKind === 'string' && KINDS[agentKind]) kind = agentKind;
      if (!cwd && rec.cwd) cwd = herdrMod.unwrap(rec.cwd);
      if (rec.pane_id) pane_id = herdrMod.unwrap(rec.pane_id) || pane_id;
    } catch (e) {
      // pane 可能瞬时不可查；仍用 pane_id 直调 herdr
    }
    return {
      herdrTarget: raw,
      name: null,
      pane_id,
      kind,
      cwd,
      via: 'pane_id',
    };
  }

  const entry = ledger.get(raw);
  if (entry) {
    return {
      herdrTarget: raw,
      name: raw,
      pane_id: entry.pane_id || null,
      kind: opts.kind || entry.kind || null,
      cwd: opts.cwd || entry.cwd || null,
      via: 'ledger_name',
    };
  }

  // 不在台账：仍按 herdr agent name 直调（命名 agent / 外部起的）
  let kind = opts.kind || null;
  let cwd = opts.cwd || null;
  let pane_id = null;
  try {
    const rec = herdrMod.agentRecord(raw);
    const agentKind = herdrMod.unwrap(rec.agent || rec.kind);
    if (!kind && typeof agentKind === 'string' && KINDS[agentKind]) kind = agentKind;
    if (!cwd && rec.cwd) cwd = herdrMod.unwrap(rec.cwd);
    if (rec.pane_id) pane_id = herdrMod.unwrap(rec.pane_id);
  } catch (e) {
    // 留给后续 herdr 调用报错
  }
  return {
    herdrTarget: raw,
    name: raw,
    pane_id,
    kind,
    cwd,
    via: 'herdr_name',
  };
}

function currentState(herdrTarget) {
  try {
    return herdrMod.agentState(herdrMod.agentRecord(herdrTarget));
  } catch (e) {
    return 'unknown';
  }
}

function snapshotLifecycle(herdrTarget) {
  try {
    const rec = herdrMod.agentRecord(herdrTarget);
    const state = herdrMod.agentState(rec);
    let seq = null;
    try {
      const raw = herdrMod.unwrap(rec.state_change_seq);
      if (raw != null && raw !== '') seq = Number(raw);
      if (!Number.isFinite(seq)) seq = null;
    } catch (e) {
      seq = null;
    }
    return { state, state_change_seq: seq };
  } catch (e) {
    return { state: 'unknown', state_change_seq: null };
  }
}

const ACTIVE_STATES = new Set(['working', 'done', 'blocked']);

/**
 * 识别 Cursor Workspace Trust 对话框。这不是权限 UI，不得并进 resolve-attention。
 * 真实形状：``Workspace Trust Required`` 加 ``[a]`` / ``[q]``。
 */
function detectWorkspaceTrustPrompt(terminal) {
  const text = String(terminal || '');
  const checks = {
    banner: /workspace trust required/i.test(text),
    allow: /\[a\]/i.test(text),
    quit: /\[q\]/i.test(text),
  };
  return {
    recognized: Boolean(checks.banner && checks.allow && checks.quit),
    kind: 'cursor-workspace-trust',
    checks,
  };
}

function readRecentTerminal(herdrTarget, lines = WORKSPACE_TRUST_READ_LINES) {
  try {
    return String(
      herdrMod.herdr([
        'agent',
        'read',
        herdrTarget,
        '--source',
        'recent-unwrapped',
        '--lines',
        String(lines),
        '--format',
        'text',
      ]) || ''
    );
  } catch (e) {
    return '';
  }
}

/**
 * 若 pane 正显示 Workspace Trust，按一次 ``a``。已按过则只报告是否仍在显示。
 * 读 pane / 按键失败不得抛出——交给调用方继续观察。
 */
function tryAllowWorkspaceTrust(herdrTarget, alreadyAccepted) {
  const detected = detectWorkspaceTrustPrompt(readRecentTerminal(herdrTarget));
  if (!detected.recognized) {
    return { showing: false, accepted: Boolean(alreadyAccepted), pressed: false };
  }
  if (alreadyAccepted) {
    return { showing: true, accepted: true, pressed: false };
  }
  try {
    herdrMod.herdr(['agent', 'send-keys', herdrTarget, 'a']);
    return { showing: true, accepted: true, pressed: true };
  } catch (e) {
    return { showing: true, accepted: false, pressed: false };
  }
}

async function clearWorkspaceTrust(herdrTarget, { timeoutMs = DEFAULT_CONFIRM_START_MS, pollMs = 100 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let accepted = false;
  let showing = false;
  do {
    const trust = tryAllowWorkspaceTrust(herdrTarget, accepted);
    if (trust.accepted) accepted = true;
    showing = trust.showing;
    if (!showing) {
      return { showing: false, accepted };
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  return { showing, accepted };
}

/**
 * Confirm lifecycle evidence for *this* submission.
 * An already-working/done/blocked baseline is NOT evidence for the new prompt —
 * require state_change_seq to advance (or a transition into an active state from
 * a non-active baseline).
 *
 * Workspace Trust 在观察窗内自动按 ``a``，本身不是开工证据，也不把该屏写成失败。
 */
async function confirmLifecycle(herdrTarget, baseline, { timeoutMs = DEFAULT_CONFIRM_START_MS, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = snapshotLifecycle(herdrTarget);
  let workspaceTrustAccepted = false;
  const baselineActive = ACTIVE_STATES.has(String(baseline && baseline.state));
  const baselineSeq =
    baseline && baseline.state_change_seq != null && Number.isFinite(Number(baseline.state_change_seq))
      ? Number(baseline.state_change_seq)
      : null;

  while (Date.now() < deadline) {
    last = snapshotLifecycle(herdrTarget);
    const active = ACTIVE_STATES.has(last.state);
    const seq = last.state_change_seq;
    let advanced = false;
    if (baselineSeq != null && seq != null && seq > baselineSeq) {
      advanced = true;
    } else if (!baselineActive && active) {
      // Non-active → active without seq is weak but accepted when seq unavailable.
      advanced = baselineSeq == null || seq == null ? true : seq > baselineSeq;
    }
    if (active && advanced) {
      return { ...last, confirmed: true, workspace_trust_accepted: workspaceTrustAccepted };
    }
    const trust = tryAllowWorkspaceTrust(herdrTarget, workspaceTrustAccepted);
    if (trust.accepted) workspaceTrustAccepted = true;
    await sleep(pollMs);
  }
  const err = new herdrMod.HerdrError(
    `prompt 未确认生命周期（${timeoutMs}ms；baseline=${baseline && baseline.state}/seq=${baseline && baseline.state_change_seq}；` +
      `observed=${last.state}/seq=${last.state_change_seq}）。` +
      `已 working 的 baseline 不能当作新 prompt 证据；超时后 receipt=ambiguous，禁止自动重发。`
  );
  err.observed = last;
  err.workspace_trust_accepted = workspaceTrustAccepted;
  throw err;
}

// spawn：起一个 live agent。= tab create（拿 pane_id/tab_id）+ agent start（按 kind 拼 flags）。
// model 可省略：用 kinds.js 里与 herdr-orchestrator 对齐的 defaultModel。
// 返回 { name, pane_id, tab_id, kind, model, cwd, state }。
function spawn(name, { kind, model, cwd, label } = {}) {
  if (!name) throw new herdrMod.HerdrError('spawn 需要 name');
  if (!kind) throw new herdrMod.HerdrError('spawn 需要 --kind');
  let resolvedModel;
  try {
    resolvedModel = resolveModel(kind, model);
  } catch (e) {
    throw new herdrMod.HerdrError(e.message || String(e));
  }
  const workdir = cwd || process.cwd();
  const command = KINDS[kind] && KINDS[kind].command;
  if (!executableInPath(command)) {
    throw new herdrMod.HerdrError(
      `启动前检查失败：kind=${kind} 的可执行文件 ${JSON.stringify(command)} 不在 PATH；` +
        `未创建 Herdr tab。请先修复安装再重试。`
    );
  }

  const createArgs = ['tab', 'create', '--cwd', workdir, '--no-focus', '--label', label || `live-${name}`];
  const payload = result(herdrMod.herdr(createArgs, { parseJson: true }));
  const paneId = deepId(payload, ['pane_id', 'id']);
  const tabId = deepId(payload, ['tab_id']);
  if (!paneId) throw new herdrMod.HerdrError('无法从 tab create 结果识别 pane_id');

  const flags = adapterFlags(kind, { model: resolvedModel, cwd: workdir });
  // Register immediately after tab creation. If agent start times out or the
  // harness launches an installer/updater, the resource remains discoverable
  // for inspection instead of becoming an untracked orphan.
  const entry = ledger.put(name, {
    pane_id: paneId,
    tab_id: tabId,
    kind,
    model: resolvedModel,
    cwd: workdir,
  });
  try {
    herdrMod.herdr(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--', ...flags]);
  } catch (e) {
    throw new herdrMod.HerdrError(
      `${e.message || e}\nspawn 已创建并登记 ${name}（pane=${paneId}, tab=${tabId}）。` +
        `先检查 pane 输出；确认无更新、安装、迁移等关键操作后，再用 kill --force 回收。`
    );
  }

  // 启动刚返回时 Trust 屏可能已在；按一次 a。对话框稍后才出现时由 wait / prompt 接着处理。
  // spawn 本身不因 idle 或 Trust 失败。
  const trust = tryAllowWorkspaceTrust(name, false);
  const workspaceTrustAccepted = Boolean(trust.accepted);

  let state = 'unknown';
  try {
    state = herdrMod.agentState(herdrMod.agentRecord(name));
  } catch (e) {
    // agent 刚起，list 可能还没收敛——状态留 unknown，不阻断 spawn。
  }

  return { ...entry, state, workspace_trust_accepted: workspaceTrustAccepted };
}

/**
 * 校验将要 paste 进输入框的正文体积。超软上限则拒绝（可用 forcePaste 覆盖）。
 * @param {string} text
 * @param {{ forcePaste?: boolean }} [opts]
 */
function assertPasteSize(text, opts = {}) {
  const bytes = Buffer.byteLength(String(text), 'utf8');
  if (bytes <= PASTE_SOFT_LIMIT_BYTES) return bytes;
  if (opts.forcePaste || process.env.HERDR_LIVE_ALLOW_LARGE_PASTE === '1') {
    return bytes;
  }
  throw new herdrMod.HerdrError(
    `prompt 正文 ${bytes}B 超过输入框软上限 ${PASTE_SOFT_LIMIT_BYTES}B。` +
      `大内容请落盘并用 --brief-file（短指针）；确需整段 paste 时加 --force-paste 或 HERDR_LIVE_ALLOW_LARGE_PASTE=1。`
  );
}

function finalizeReceipt(receipt, opts = {}) {
  if (opts.receiptPath) {
    receiptMod.persistReceipt(receipt, opts.receiptPath);
    receipt.evidence = {
      ...receipt.evidence,
      receipt_path: path.resolve(String(opts.receiptPath)),
    };
  } else if (opts.persistReceipt) {
    const p = receiptMod.defaultReceiptPath(receipt.submission_id);
    receiptMod.persistReceipt(receipt, p);
    receipt.evidence = { ...receipt.evidence, receipt_path: p };
  }
  return receipt;
}

/**
 * 库级完整投喂：版本感知 transport + per-target lock + 结构化 receipt。
 * 仅 transport_phase=not_sent 可自动重试；任何 post-transport 不确定结果为 ambiguous。
 *
 * @returns {Promise<object>} versioned receipt（兼兼容旧 submitted/confirmed 字段）
 */
async function submitPrompt(opts = {}) {
  const {
    target,
    text,
    file,
    waitUntil,
    timeoutMs = 120000,
    settleMs,
    confirmStartMs = DEFAULT_CONFIRM_START_MS,
    skipConfirmStart = false,
    forcePaste = false,
    briefFile,
    briefStyle,
    kind: kindOpt,
    cwd: cwdOpt,
    asPaneId = false,
    submissionId = null,
    receiptPath = null,
    persistReceipt = false,
    forceProfile = null,
    versionText = null,
    lockRoot = null,
    skipLock = false,
  } = opts;

  let receipt = receiptMod.createReceipt({
    submission_id: submissionId || undefined,
  });
  let lockHandle = null;
  let transportStarted = false;

  const failNotSent = (error) => {
    receiptMod.setPhase(receipt, 'not_sent', { error: String(error && error.message ? error.message : error) });
    finalizeReceipt(receipt, { receiptPath, persistReceipt });
    const err = error instanceof Error ? error : new herdrMod.HerdrError(String(error));
    err.receipt = receipt;
    err.transport_phase = 'not_sent';
    throw err;
  };

  const failAmbiguous = (error, observed) => {
    receiptMod.setPhase(receipt, 'ambiguous', {
      error: String(error && error.message ? error.message : error),
      observed: observed || receipt.observed,
    });
    finalizeReceipt(receipt, { receiptPath, persistReceipt });
    const err = new herdrMod.HerdrError(
      `transport ambiguous（禁止自动重发）：${error && error.message ? error.message : error}`
    );
    err.receipt = receipt;
    err.transport_phase = 'ambiguous';
    throw err;
  };

  try {
    let resolved;
    try {
      resolved = resolveSubmitTarget(target, {
        kind: kindOpt,
        cwd: cwdOpt,
        asPaneId,
      });
    } catch (e) {
      return failNotSent(e);
    }

    const { herdrTarget, kind, cwd } = resolved;
    receipt.target = {
      name: resolved.name,
      pane_id: resolved.pane_id,
      kind: kind || null,
      via: resolved.via,
      herdr_target: herdrTarget,
    };

    let body = text;
    try {
      if (file && body == null) {
        const absFile = path.resolve(String(file));
        if (!fs.existsSync(absFile)) {
          throw new herdrMod.HerdrError(`file 不存在：${absFile}`);
        }
        body = fs.readFileSync(absFile, 'utf8');
      }

      let transport = 'paste';
      if (briefFile) {
        const abs = path.resolve(String(briefFile));
        if (!fs.existsSync(abs)) {
          throw new herdrMod.HerdrError(`brief-file 不存在：${abs}`);
        }
        body = buildBriefPointer(abs, {
          cwd: cwd || undefined,
          style: briefStyle || 'dispatch',
        });
        transport = briefStyle === 'answer' ? 'brief-pointer-answer' : 'brief-pointer';
      } else if (body == null) {
        throw new herdrMod.HerdrError(
          'submitPrompt 需要 text / file / briefFile（等同 CLI --text / --file / --brief-file）'
        );
      } else {
        assertPasteSize(body, { forcePaste });
      }
      receipt.transport = transport;
      receipt.promptBytes = Buffer.byteLength(String(body), 'utf8');
      receipt.prompt_digest = receiptMod.promptDigest(body);
    } catch (e) {
      return failNotSent(e);
    }

    let profile;
    try {
      profile = resolveVersionProfile({ forceProfile, versionText });
      assertTransportAllowed(profile);
    } catch (e) {
      return failNotSent(e);
    }
    receipt.herdr = {
      version: profile.versionText,
      profile: profile.id,
      enter_policy: profile.enterPolicy,
      forced: Boolean(profile.forced),
    };

    // Official explicit-enter profile alone decides Enter. Kind submitNeedsEnter is
    // informational (settle defaults / docs) and must never suppress a required Enter.
    const profileWantsEnter = shouldSendEnter(profile);
    const sendEnter = profileWantsEnter;
    receipt.evidence.kind_submit_needs_enter = submitNeedsEnter(kind);

    const settle =
      settleMs !== undefined && settleMs !== null
        ? Number(settleMs)
        : defaultSettleMs(kind);
    receipt.settleMs = settle;

    if (!skipLock) {
      try {
        lockHandle = acquireTargetLock(resolved.pane_id || herdrTarget, {
          lockRoot: lockRoot || undefined,
          owner: {
            submission_id: receipt.submission_id,
            herdr_target: herdrTarget,
          },
        });
        receipt.evidence.lock_path = lockHandle.path;
      } catch (e) {
        return failNotSent(e);
      }
    }

    // Trust 屏还在时不得填充 prompt。按 a 后仍在显示则 fail not_sent（尚未 transport，可重试）。
    const trustClear = await clearWorkspaceTrust(herdrTarget, {
      timeoutMs: confirmStartMs,
    });
    if (trustClear.accepted) {
      receipt.evidence.workspace_trust_accepted = true;
    }
    if (trustClear.showing) {
      return failNotSent(
        new herdrMod.HerdrError(
          `Workspace Trust 对话框仍在，未开始 prompt transport（${confirmStartMs}ms）`
        )
      );
    }

    receipt.baseline = snapshotLifecycle(herdrTarget);
    receipt.observed = { ...receipt.baseline };

    // --- transport begins: once agent prompt is invoked, failures are ambiguous ---
    transportStarted = true;
    try {
      herdrMod.herdr(['agent', 'prompt', herdrTarget, body]);
      receiptMod.setPhase(receipt, 'prompt_filled', {
        observed: snapshotLifecycle(herdrTarget),
      });
    } catch (e) {
      return failAmbiguous(e);
    }

    if (sendEnter) {
      try {
        if (settle > 0) await sleep(settle);
        herdrMod.herdr(['agent', 'send-keys', herdrTarget, 'enter']);
        receiptMod.setPhase(receipt, 'enter_sent', {
          observed: snapshotLifecycle(herdrTarget),
        });
      } catch (e) {
        return failAmbiguous(e);
      }
    } else {
      // core-managed-enter: prompt fill is expected to schedule Enter; mark enter_sent
      // as "delegated" without a second Enter.
      receipt.evidence.enter_delegated_to_core = true;
      receiptMod.setPhase(receipt, 'enter_sent', {
        observed: snapshotLifecycle(herdrTarget),
      });
    }

    if (!skipConfirmStart) {
      try {
        const conf = await confirmLifecycle(herdrTarget, receipt.baseline, {
          timeoutMs: confirmStartMs,
        });
        if (conf.workspace_trust_accepted) {
          receipt.evidence.workspace_trust_accepted = true;
        }
        receiptMod.setPhase(receipt, 'lifecycle_observed', {
          observed: { state: conf.state, state_change_seq: conf.state_change_seq },
        });
      } catch (e) {
        return failAmbiguous(e, e.observed || snapshotLifecycle(herdrTarget));
      }
    } else {
      receipt.observed = snapshotLifecycle(herdrTarget);
      receipt.state = receipt.observed.state;
      receipt.submitted = true;
      receipt.confirmed = false;
      receipt.timestamps.finished_at = new Date().toISOString();
    }

    finalizeReceipt(receipt, { receiptPath, persistReceipt });

    if (waitUntil) {
      const waited = await wait(herdrTarget, { until: waitUntil, timeoutMs });
      receipt.evidence.wait = waited;
      return receipt;
    }
    return receipt;
  } finally {
    if (lockHandle) {
      try {
        lockHandle.release();
      } catch (e) {
        // ignore
      }
    }
  }
}

// prompt：兼容五动词签名；内部一律走 submitPrompt（禁止双份逻辑）。
async function prompt(name, text, opts = {}) {
  return submitPrompt({
    target: name,
    text,
    ...opts,
  });
}

// read：读 agent 终端输出。tail 只取尾部 N 行。
// 用默认 source（完整对话回滚窗口）；实测 --source recent-unwrapped 只回状态栏、几乎空，
// 那个 source 是给 busy 签名检测用的小窗口，不适合读对话。回滚窗口有限，超长输出会滚掉——
// 判官应以外部权威源（如 Bus transcript）为准，不单靠 read。
function read(name, { tail } = {}) {
  const args = ['agent', 'read', name, '--lines', String(tail || 200), '--format', 'text'];
  return herdrMod.herdr(args);
}

// wait：轮询 herdr 实时状态直到命中 until 之一，或超时报错。
// until 可以是单个状态或数组。默认目标 idle/done（agent 干完活的稳定态）。
async function wait(name, { until = ['idle', 'done'], timeoutMs = 300000, pollMs = 1000 } = {}) {
  const targets = (Array.isArray(until) ? until : [until]).map((s) => s.toLowerCase());
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  let workspaceTrustAccepted = false;
  for (;;) {
    last = currentState(name);
    const trust = tryAllowWorkspaceTrust(name, workspaceTrustAccepted);
    if (trust.accepted) workspaceTrustAccepted = true;
    // Trust 屏通常仍是 idle；不得当成「已起来、可投喂」。
    if (targets.includes(last) && !trust.showing) {
      return { name, state: last, reached: true };
    }
    if (Date.now() >= deadline) {
      throw new herdrMod.HerdrError(
        `wait 超时（${timeoutMs}ms）：agent ${name} 未到达 [${targets.join(', ')}]，当前 ${last}` +
          (trust.showing ? '（Workspace Trust 仍在）' : '')
      );
    }
    await sleep(pollMs);
  }
}

// list：列出本工具起过的 live agent 及其 herdr 实时状态。
function list() {
  return ledger.all().map((entry) => {
    let state = 'unknown';
    try {
      state = herdrMod.agentState(herdrMod.agentRecord(entry.name));
    } catch (e) {
      state = 'gone';
    }
    return { ...entry, state };
  });
}

// kill：关一个 agent 的 tab（收资源）并清台账。killAll 关全部。
// 坑：只有确认关闭成功（或 tab/pane 本就不存在）才从台账删条目。关闭失败时保留
// 台账条目，让后续 kill --all 能重试回收——否则条目丢了、tab 却残留，资源永久泄漏
// 且无法二次回收（首版 bug）。
function kill(name, { force = false } = {}) {
  const entry = ledger.get(name);
  if (!entry) throw new herdrMod.HerdrError(`台账里没有 agent：${name}`);
  const errors = [];
  const target = entry.tab_id
    ? { kind: 'tab', id: entry.tab_id }
    : entry.pane_id
      ? { kind: 'pane', id: entry.pane_id }
      : null;
  // 无 target（从未拿到 pane/tab id）视为无可关资源，直接清台账。
  let reclaimed = !target;
  let state = 'unchecked';
  if (!force) {
    try {
      state = herdrMod.agentState(herdrMod.agentRecord(name));
    } catch (e) {
      state = 'gone';
    }
  }
  if (target && !force && !['idle', 'done'].includes(state)) {
    return {
      name,
      closed: false,
      reclaimed: false,
      guarded: true,
      state,
      target,
      errors: [
        `安全保护：agent 状态为 ${state}，可能正在更新、安装、迁移或等待交互；` +
          `请先 read/检查 pane，确认可中断后再用 kill --force。`,
      ],
    };
  }
  if (target) {
    try {
      // 经 herdrMod 调用（而非解构的 herdr）以便自测可注入 stub。
      herdrMod.herdr([target.kind, 'close', target.id]);
      reclaimed = true;
    } catch (e) {
      const msg = String(e.message || e);
      if (/tab_not_found|pane_not_found/.test(msg)) {
        reclaimed = true; // 已经不存在，等价于已回收
      } else {
        errors.push(msg); // 瞬时/未知错误：保留台账条目以便重试
      }
    }
  }
  if (reclaimed) ledger.remove(name);
  return { name, closed: reclaimed && errors.length === 0, reclaimed, guarded: false, state, target, errors };
}

function killAll(opts = {}) {
  return ledger.all().map((entry) => {
    try {
      return kill(entry.name, opts);
    } catch (e) {
      return { name: entry.name, closed: false, errors: [String(e.message || e)] };
    }
  });
}

module.exports = {
  spawn,
  prompt,
  submitPrompt,
  resolveSubmitTarget,
  isPaneId,
  read,
  wait,
  list,
  kill,
  killAll,
  confirmLifecycle,
  detectWorkspaceTrustPrompt,
  assertPasteSize,
  executableInPath,
  snapshotLifecycle,
  DEFAULT_CONFIRM_START_MS,
  // Hardened: legacy callers must pass a real baseline. A fake idle baseline would
  // false-confirm an already-working target when seq is unavailable.
  confirmStart: async (herdrTarget, opts = {}) => {
    if (!opts || opts.baseline == null || typeof opts.baseline !== 'object') {
      throw new herdrMod.HerdrError(
        'confirmStart 需要真实 baseline（{state, state_change_seq}）；' +
          '禁止用假 idle baseline。请改用 confirmLifecycle(target, baseline, opts)。'
      );
    }
    return confirmLifecycle(herdrTarget, opts.baseline, opts);
  },
};
