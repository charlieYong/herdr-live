'use strict';

// Per-target cooperative lock: serialize wrapper-managed input by
// Herdr socket/session + pane ID. Protects herdr-live/orchestrator callers,
// not raw/manual Herdr input.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LOCK_ROOT =
  process.env.HERDR_LIVE_LOCK_DIR ||
  path.join(process.env.HERDR_LIVE_HOME || path.join(os.homedir(), '.herdr-live'), 'locks');

const DEFAULT_STALE_MS = Number(process.env.HERDR_LIVE_LOCK_STALE_MS || 30 * 60 * 1000);

function lockScope() {
  return (
    process.env.HERDR_SOCKET_PATH ||
    process.env.HERDR_SESSION ||
    'default-session'
  );
}

function lockKey(paneId) {
  const scope = lockScope();
  const pane = String(paneId || '').trim() || 'unknown-pane';
  const digest = crypto.createHash('sha256').update(`${scope}\0${pane}`).digest('hex').slice(0, 24);
  return { scope, pane, digest, fileName: `${digest}.lock` };
}

function lockPath(paneId, lockRoot = DEFAULT_LOCK_ROOT) {
  const key = lockKey(paneId);
  return {
    ...key,
    path: path.join(lockRoot, key.fileName),
    root: lockRoot,
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // exists but not owned by us
  }
}

function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (e) {
    return null;
  }
}

/**
 * Atomic acquire via O_EXCL. Stale recovery only when owner PID is proven gone
 * (and optionally lock age exceeds staleMs).
 *
 * @param {string} paneId
 * @param {{ lockRoot?: string, staleMs?: number, owner?: object }} [opts]
 * @returns {{ path: string, meta: object, release: () => void }}
 */
function acquireTargetLock(paneId, opts = {}) {
  const info = lockPath(paneId, opts.lockRoot || DEFAULT_LOCK_ROOT);
  fs.mkdirSync(info.root, { recursive: true });
  const staleMs = opts.staleMs != null ? Number(opts.staleMs) : DEFAULT_STALE_MS;
  const meta = {
    schema_version: 1,
    pid: process.pid,
    created_at: new Date().toISOString(),
    created_ms: Date.now(),
    scope: info.scope,
    pane_id: info.pane,
    owner: opts.owner || null,
  };
  const payload = `${JSON.stringify(meta, null, 2)}\n`;

  const tryCreate = () => {
    const fd = fs.openSync(info.path, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    tryCreate();
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    const existing = readLock(info.path);
    const ownerPid = existing && Number(existing.pid);
    const age =
      existing && typeof existing.created_ms === 'number'
        ? Date.now() - existing.created_ms
        : Infinity;
    const gone = !pidAlive(ownerPid);
    // Bounded stale recovery: owner must be proven gone; age must meet staleMs.
    if (gone && age >= staleMs) {
      // Re-check once more after unlink race window.
      try {
        fs.unlinkSync(info.path);
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
      try {
        tryCreate();
      } catch (retryErr) {
        if (retryErr && retryErr.code === 'EEXIST') {
          throw new Error(
            `target lock busy after stale reclaim：pane=${info.pane} scope=${info.scope}`
          );
        }
        throw retryErr;
      }
    } else {
      const why = gone
        ? `owner pid ${ownerPid} gone but lock age ${age}ms < stale bound`
        : `owner pid ${ownerPid} still alive`;
      throw new Error(
        `target lock held：pane=${info.pane} scope=${info.scope} (${why})`
      );
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = readLock(info.path);
      if (cur && Number(cur.pid) === process.pid) {
        fs.unlinkSync(info.path);
      }
    } catch (e) {
      // best-effort
    }
  };

  return { path: info.path, meta, release, key: info };
}

module.exports = {
  DEFAULT_LOCK_ROOT,
  lockScope,
  lockKey,
  lockPath,
  pidAlive,
  readLock,
  acquireTargetLock,
};
