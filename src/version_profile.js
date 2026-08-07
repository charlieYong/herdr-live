'use strict';

// Herdr version → transport profile. Fail-closed on unknown profiles:
// never guess and double-Enter a core-managed-Enter transport.

const { spawnSync } = require('child_process');

/** Known profiles and Enter policy. */
const PROFILES = Object.freeze({
  'official-0.7.5': {
    id: 'official-0.7.5',
    enterPolicy: 'explicit-enter',
    description:
      'Official Herdr 0.7.5: agent prompt fills the box; wrapper must settle then send Enter.',
  },
  'core-managed-enter': {
    id: 'core-managed-enter',
    enterPolicy: 'no-second-enter',
    description:
      'Core schedules Enter with prompt fill; wrapper must not send a second Enter.',
  },
  unknown: {
    id: 'unknown',
    enterPolicy: 'fail-closed',
    description: 'Unrecognized Herdr version; refuse transport unless profile is forced.',
  },
});

const ALLOWED_FORCE = new Set(Object.keys(PROFILES).filter((k) => k !== 'unknown'));

/**
 * Parse `herdr --version` stdout into a profile id.
 * @param {string} versionText
 * @returns {string} profile id
 */
function classifyVersionText(versionText) {
  const text = String(versionText || '').trim();
  const lower = text.toLowerCase();
  // Explicit opt-in marker for forks that already schedule Enter with prompt.
  if (
    /core-managed-enter|managed.enter|enter.managed|prompt.schedules.enter/i.test(text) ||
    process.env.HERDR_LIVE_CORE_MANAGED_ENTER === '1'
  ) {
    return 'core-managed-enter';
  }
  // Official PATH builds report "herdr 0.7.5" (or similar).
  const m = lower.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3]);
    if (major === 0 && minor === 7 && patch === 5) {
      return 'official-0.7.5';
    }
  }
  return 'unknown';
}

/**
 * Resolve active profile.
 * @param {{ forceProfile?: string, versionText?: string }} [opts]
 */
function resolveVersionProfile(opts = {}) {
  const forced = opts.forceProfile || process.env.HERDR_LIVE_TRANSPORT_PROFILE || null;
  if (forced) {
    const id = String(forced).trim();
    if (!ALLOWED_FORCE.has(id)) {
      throw new Error(
        `未知/不可强制的 transport profile：${id}（允许：${[...ALLOWED_FORCE].join(', ')}）`
      );
    }
    const profile = PROFILES[id];
    return {
      ...profile,
      versionText: opts.versionText || null,
      forced: true,
    };
  }

  let versionText = opts.versionText;
  if (versionText == null) {
    const proc = spawnSync('herdr', ['--version'], { encoding: 'utf8' });
    if (proc.error) {
      throw new Error(`无法执行 herdr --version：${proc.error.message}`);
    }
    versionText = (proc.stdout || proc.stderr || '').trim();
  }
  const id = classifyVersionText(versionText);
  const profile = PROFILES[id] || PROFILES.unknown;
  return {
    ...profile,
    versionText,
    forced: false,
  };
}

function shouldSendEnter(profile) {
  if (!profile || profile.enterPolicy === 'fail-closed') {
    return false;
  }
  return profile.enterPolicy === 'explicit-enter';
}

function assertTransportAllowed(profile) {
  if (!profile || profile.enterPolicy === 'fail-closed') {
    throw new Error(
      `Herdr transport profile 未识别（version=${profile && profile.versionText}）。` +
        `请设置 HERDR_LIVE_TRANSPORT_PROFILE=official-0.7.5|core-managed-enter，禁止猜测双 Enter。`
    );
  }
}

module.exports = {
  PROFILES,
  classifyVersionText,
  resolveVersionProfile,
  shouldSendEnter,
  assertTransportAllowed,
};
