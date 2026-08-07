'use strict';

// Structured fail-closed transport receipt for herdr-live submitPrompt.
// Only transport_phase === 'not_sent' is retryable.
// Does not claim server-level queue/write acknowledgement.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const RECEIPT_PHASES = Object.freeze([
  'not_sent',
  'prompt_filled',
  'enter_sent',
  'lifecycle_observed',
  'ambiguous',
]);

const RETRYABLE_PHASES = Object.freeze(new Set(['not_sent']));

const DEFAULT_RECEIPT_ROOT =
  process.env.HERDR_LIVE_RECEIPT_DIR ||
  path.join(process.env.HERDR_LIVE_HOME || path.join(os.homedir(), '.herdr-live'), 'receipts');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function promptDigest(text) {
  return `sha256:${sha256Hex(text)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function newSubmissionId(prefix) {
  const rand = crypto.randomBytes(8).toString('hex');
  const base = prefix ? String(prefix).trim() : 'hl';
  return `${base}:${Date.now().toString(36)}:${rand}`;
}

function createReceipt(seed = {}) {
  const started = nowIso();
  return {
    schema_version: SCHEMA_VERSION,
    submission_id: seed.submission_id || newSubmissionId(seed.submissionPrefix),
    target: {
      name: seed.name || null,
      pane_id: seed.pane_id || null,
      kind: seed.kind || null,
      via: seed.via || null,
      herdr_target: seed.herdr_target || null,
    },
    prompt_digest: seed.prompt_digest || null,
    baseline: seed.baseline || { state: null, state_change_seq: null },
    observed: seed.observed || { state: null, state_change_seq: null },
    herdr: seed.herdr || { version: null, profile: null, enter_policy: null },
    transport_phase: 'not_sent',
    timestamps: {
      started_at: started,
      filled_at: null,
      enter_at: null,
      observed_at: null,
      finished_at: null,
    },
    evidence: seed.evidence || {},
    error: null,
    // Backward-compat live fields (derived; not acceptance claims).
    submitted: false,
    confirmed: false,
    state: null,
    transport: seed.transport || null,
    settleMs: seed.settleMs != null ? seed.settleMs : null,
    promptBytes: seed.promptBytes != null ? seed.promptBytes : null,
  };
}

function setPhase(receipt, phase, extra = {}) {
  if (!RECEIPT_PHASES.includes(phase)) {
    throw new Error(`非法 transport_phase：${phase}`);
  }
  receipt.transport_phase = phase;
  if (extra.observed) receipt.observed = extra.observed;
  if (extra.error != null) receipt.error = String(extra.error);
  if (extra.evidence && typeof extra.evidence === 'object') {
    receipt.evidence = { ...receipt.evidence, ...extra.evidence };
  }
  const ts = receipt.timestamps;
  if (phase === 'prompt_filled' && !ts.filled_at) ts.filled_at = nowIso();
  if (phase === 'enter_sent' && !ts.enter_at) ts.enter_at = nowIso();
  if (phase === 'lifecycle_observed' && !ts.observed_at) ts.observed_at = nowIso();
  if (phase === 'ambiguous' || phase === 'lifecycle_observed' || phase === 'not_sent') {
    ts.finished_at = nowIso();
  }
  // Derive compatibility flags — never claim submitted for not_sent/ambiguous.
  if (phase === 'lifecycle_observed') {
    receipt.submitted = true;
    receipt.confirmed = true;
    receipt.state = (receipt.observed && receipt.observed.state) || receipt.state;
  } else if (phase === 'enter_sent' || phase === 'prompt_filled') {
    receipt.submitted = true;
    receipt.confirmed = false;
    receipt.state = (receipt.observed && receipt.observed.state) || receipt.state;
  } else if (phase === 'ambiguous') {
    receipt.submitted = true; // input may have reached target
    receipt.confirmed = false;
    receipt.state = (receipt.observed && receipt.observed.state) || receipt.state;
  } else {
    receipt.submitted = false;
    receipt.confirmed = false;
  }
  return receipt;
}

function mayRetry(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  return RETRYABLE_PHASES.has(String(receipt.transport_phase || ''));
}

function persistReceipt(receipt, receiptPath) {
  if (!receiptPath) return null;
  const abs = path.resolve(String(receiptPath));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, abs);
  return abs;
}

function defaultReceiptPath(submissionId, root = DEFAULT_RECEIPT_ROOT) {
  const safe = String(submissionId || 'unknown').replace(/[^a-zA-Z0-9:_.-]+/g, '_');
  return path.join(root, `${safe}.json`);
}

/**
 * Bounded cleanup of old receipt files under root.
 * @param {{ root?: string, maxAgeMs?: number, maxFiles?: number }} [opts]
 */
function cleanupReceipts(opts = {}) {
  const root = opts.root || DEFAULT_RECEIPT_ROOT;
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : 7 * 24 * 3600 * 1000;
  const maxFiles = opts.maxFiles != null ? opts.maxFiles : 200;
  if (!fs.existsSync(root)) return { removed: 0, kept: 0 };
  const entries = fs
    .readdirSync(root)
    .filter((n) => n.endsWith('.json'))
    .map((name) => {
      const full = path.join(root, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch (e) {
        mtime = 0;
      }
      return { name, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  let removed = 0;
  entries.forEach((entry, idx) => {
    const tooOld = maxAgeMs >= 0 && now - entry.mtime > maxAgeMs;
    const overCap = idx >= maxFiles;
    if (tooOld || overCap) {
      try {
        fs.unlinkSync(entry.full);
        removed += 1;
      } catch (e) {
        // ignore
      }
    }
  });
  return { removed, kept: entries.length - removed };
}

module.exports = {
  SCHEMA_VERSION,
  RECEIPT_PHASES,
  RETRYABLE_PHASES,
  DEFAULT_RECEIPT_ROOT,
  sha256Hex,
  promptDigest,
  newSubmissionId,
  createReceipt,
  setPhase,
  mayRetry,
  persistReceipt,
  defaultReceiptPath,
  cleanupReceipts,
};
