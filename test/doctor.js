#!/usr/bin/env node
'use strict';

// Deterministic doctor tests — zero real spawn/network when hooks are injected.
// Covers local-only mode, live pass/fail classifications, cleanup fail-closed,
// stale-output proof, guarded cleanup, and secret sanitization.

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-live-doctor-test-'));
process.env.HERDR_LIVE_HOME = tmpHome;

const doctorMod = require('../src/doctor');
const {
  doctor,
  buildProbeMaterial,
  ERROR_CODES,
  reverseToken,
  sanitizeDoctorText,
  extractPostBaselineSuffix,
} = doctorMod;

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

function countingHooks(extra = {}) {
  const counts = { spawn: 0, submitPrompt: 0, read: 0, wait: 0, kill: 0 };
  const material = buildProbeMaterial({ token: 'HLDOC_deadbeef01' });
  let readPhase = 0;
  const killCalls = [];
  const baseline = 'baseline idle banner';
  const hooks = {
    herdrAvailable: () => true,
    executableInPath: (cmd) => cmd === 'herdr' || cmd === 'cursor-agent' || cmd === 'claude' || cmd === 'codex',
    mkdtempSync: (prefix) => fs.mkdtempSync(prefix),
    rmSync: (p, o) => {
      try { fs.rmSync(p, o); } catch (e) { /* ignore */ }
    },
    spawn: (name, opts) => {
      counts.spawn += 1;
      return { name, ...opts, pane_id: 'w9:p1', tab_id: 'w9:t1', state: 'idle' };
    },
    wait: async () => {
      counts.wait += 1;
      return { state: 'idle', reached: true };
    },
    read: () => {
      counts.read += 1;
      readPhase += 1;
      if (readPhase === 1) return baseline;
      // Monotonic extension of the same baseline capture.
      return `${baseline}\nassistant:\n${material.expectedMarker}\n`;
    },
    submitPrompt: async () => {
      counts.submitPrompt += 1;
      return {
        transport_phase: 'lifecycle_observed',
        confirmed: true,
        submitted: true,
        submission_id: 'doc-test',
        prompt_digest: 'sha256:abc',
        baseline: { state: 'idle', state_change_seq: 1 },
        observed: { state: 'working', state_change_seq: 2 },
        target: { name: 'x', pane_id: 'w9:p1', kind: 'cursor', via: 'ledger_name' },
      };
    },
    kill: (name, opts) => {
      counts.kill += 1;
      killCalls.push({ name, opts });
      return { name, closed: true, reclaimed: true, guarded: false, state: 'idle', errors: [] };
    },
    ...extra,
  };
  return { counts, hooks, material, killCalls, baseline };
}

console.log('herdr-live doctor 确定性自测');

check('buildProbeMaterial：marker 为 token 反转，不在 raw prompt 误等价', () => {
  const m = buildProbeMaterial({ token: 'HLDOC_abc' });
  assert.strictEqual(m.expectedMarker, `DOCTOR_REV:${reverseToken('HLDOC_abc')}`);
  assert.ok(m.promptText.includes('HLDOC_abc'));
  assert.ok(!m.promptText.includes(m.expectedMarker), 'prompt 不得直接含派生 marker');
});

check('sanitizeDoctorText：API_KEY / prompt body / 长 stderr / probe token', () => {
  const tok = 'HLDOC_leak';
  const marker = `DOCTOR_REV:${reverseToken(tok)}`;
  // Secrets outside prompt-body path
  const outside = sanitizeDoctorText(
    `spawn failed\nAPI_KEY=sk-test-redaction\nTOKEN=${tok}\n${'z'.repeat(500)}`,
    { probeToken: tok, expectedMarker: marker }
  );
  assert.ok(!outside.includes('sk-test-redaction'), outside);
  assert.ok(!outside.includes('API_KEY=sk-test-redaction'), outside);
  assert.ok(/API_KEY=<redacted>|sk-<redacted>/.test(outside), outside);
  assert.ok(!outside.includes(tok), outside);
  assert.ok(outside.includes('…<truncated>'), outside);

  // Prompt body path (reviewer fake secret inside herdr agent prompt line)
  const raw =
    `herdr 命令失败（1）：herdr agent prompt hl-doc Secret token: ${tok}\n` +
    `API_KEY=sk-test-redaction\n${marker}`;
  const out = sanitizeDoctorText(raw, { probeToken: tok, expectedMarker: marker });
  assert.ok(!out.includes('sk-test-redaction'), out);
  assert.ok(!out.includes(tok), out);
  assert.ok(!out.includes(marker), out);
  assert.ok(out.includes('<prompt-body-redacted>'), out);
});

check('extractPostBaselineSuffix：仅接受单调前缀扩展', () => {
  const ok = extractPostBaselineSuffix('base', 'base\nNEW');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.suffix, '\nNEW');
  const bad = extractPostBaselineSuffix('base', 'stale\nbase');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, ERROR_CODES.STALE_OUTPUT_AMBIGUOUS);
});

(async () => {
  await checkAsync('local-only：零 spawn/submit/远程调用', async () => {
    const { counts, hooks } = countingHooks();
    const res = await doctor({
      live: false,
      kind: 'cursor',
      hooks,
    });
    assert.strictEqual(res.schema_version, 'doctor-v1');
    assert.strictEqual(res.mode, 'local');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.local_preflight.ok, true);
    assert.strictEqual(res.live_probe.status, 'not_requested');
    assert.strictEqual(res.live_probe.requested, false);
    assert.strictEqual(res.live_probe.ok, null);
    assert.strictEqual(counts.spawn, 0);
    assert.strictEqual(counts.submitPrompt, 0);
    assert.strictEqual(counts.wait, 0);
    assert.strictEqual(counts.kill, 0);
  });

  await checkAsync('local-only 无 kind：仍不 spawn；报告各 harness PATH', async () => {
    const { counts, hooks } = countingHooks();
    const res = await doctor({ live: false, hooks });
    assert.ok(res.ok);
    assert.ok(res.local_preflight.executables.cursor);
    assert.strictEqual(counts.spawn, 0);
    assert.strictEqual(counts.submitPrompt, 0);
  });

  await checkAsync('unsupported kind：fail-closed，未 spawn', async () => {
    const { counts, hooks } = countingHooks();
    const res = await doctor({ live: true, kind: 'bogus', hooks });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.UNSUPPORTED_KIND);
    assert.strictEqual(counts.spawn, 0);
  });

  await checkAsync('unsupported model：fail-closed，未 spawn', async () => {
    const { counts, hooks } = countingHooks();
    const res = await doctor({ live: true, kind: 'cursor', model: '-bad', hooks });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.UNSUPPORTED_MODEL);
    assert.strictEqual(counts.spawn, 0);
  });

  await checkAsync('executable unavailable：PATH 假成功不得冒充 live', async () => {
    const { counts, hooks } = countingHooks({
      executableInPath: (cmd) => cmd === 'herdr', // cursor-agent missing
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.local_preflight.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.EXECUTABLE_UNAVAILABLE);
    assert.strictEqual(res.live_probe.status, 'skipped');
    assert.strictEqual(counts.spawn, 0);
    assert.strictEqual(counts.submitPrompt, 0);
  });

  await checkAsync('live pass：lifecycle + 派生 marker（单调后缀）', async () => {
    const { counts, hooks, material, killCalls } = countingHooks();
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      timeoutMs: 5000,
      hooks,
    });
    assert.strictEqual(res.ok, true, JSON.stringify(res, null, 2));
    assert.strictEqual(res.live_probe.status, 'pass');
    assert.strictEqual(res.live_probe.lifecycle_observed, true);
    assert.strictEqual(res.live_probe.token_in_output, true);
    assert.strictEqual(res.live_probe.cleanup.ok, true);
    assert.ok(counts.spawn >= 1);
    assert.ok(counts.submitPrompt >= 1);
    assert.ok(counts.kill >= 1);
    assert.ok(killCalls.every((c) => !c.opts || c.opts.force !== true));
  });

  await checkAsync('reviewer 回归：marker 在 baseline 外、更宽 post 内不得 pass', async () => {
    const m = buildProbeMaterial({ token: 'HLDOC_tailrace' });
    const baseline = Array.from({ length: 80 }, (_, i) => `base${i}`).join('\n');
    const stale = Array.from({ length: 40 }, (_, i) => (i === 3 ? m.expectedMarker : `old${i}`)).join('\n');
    let n = 0;
    let killOpts = null;
    const res = await doctor({
      live: true,
      kind: 'cursor',
      probeToken: m.token,
      captureTail: 80,
      hooks: {
        herdrAvailable: () => true,
        executableInPath: (cmd) => cmd === 'herdr' || cmd === 'cursor-agent',
        spawn: () => ({}),
        wait: async () => ({ state: 'idle' }),
        read: () => {
          n += 1;
          return n === 1 ? baseline : `${stale}\n${baseline}`;
        },
        submitPrompt: async () => ({
          transport_phase: 'lifecycle_observed',
          confirmed: true,
          submitted: true,
        }),
        kill: (name, opts) => {
          killOpts = opts;
          return { name, closed: true, reclaimed: true, guarded: false, errors: [] };
        },
      },
    });
    assert.strictEqual(res.ok, false);
    assert.notStrictEqual(res.live_probe.status, 'pass');
    assert.strictEqual(res.error_code, ERROR_CODES.STALE_OUTPUT_AMBIGUOUS);
    assert.ok(!killOpts || killOpts.force !== true);
  });

  await checkAsync('binary pass + model/API 失败 → overall fail', async () => {
    const { hooks, material, baseline } = countingHooks({
      read: (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 1) return baseline;
          return `${baseline}\nError: unauthorized invalid API key for model`;
        };
      })(),
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.local_preflight.ok, true, 'binary preflight still ok');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.AUTH_OR_API_FAILURE);
    assert.strictEqual(res.live_probe.status, 'fail');
  });

  await checkAsync('ambiguous transport：distinct fail-closed', async () => {
    const { hooks, material } = countingHooks({
      submitPrompt: async () => {
        const err = new Error('transport ambiguous（禁止自动重发）：no lifecycle');
        err.receipt = { transport_phase: 'ambiguous', confirmed: false };
        err.transport_phase = 'ambiguous';
        throw err;
      },
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.AMBIGUOUS_TRANSPORT);
  });

  await checkAsync('timeout：distinct code', async () => {
    const { hooks, material } = countingHooks({
      wait: async () => {
        throw new Error('wait 超时（1000ms）：agent x 未到达');
      },
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.TIMEOUT);
  });

  await checkAsync('stale preexisting marker：fail-closed', async () => {
    const { hooks, material } = countingHooks({
      read: () => `polluted ${material.expectedMarker}`,
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.STALE_PREEXISTING_TOKEN);
  });

  await checkAsync('lifecycle without token：distinct code', async () => {
    const { hooks, material, baseline } = countingHooks({
      read: (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 1) return baseline;
          return `${baseline}\nassistant: done (no marker)`;
        };
      })(),
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.LIFECYCLE_WITHOUT_TOKEN);
  });

  await checkAsync('cleanup failure：不得标 pass', async () => {
    const { hooks, material } = countingHooks({
      kill: (name, opts) => {
        assert.ok(!opts || opts.force !== true, '不得传 force');
        return {
          name,
          closed: false,
          reclaimed: false,
          guarded: false,
          errors: ['close failed'],
        };
      },
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.CLEANUP_FAILED);
    assert.strictEqual(res.live_probe.cleanup.ok, false);
    assert.notStrictEqual(res.live_probe.status, 'pass');
  });

  await checkAsync('guarded cleanup：working/blocked 不 force，fail-closed', async () => {
    for (const st of ['working', 'blocked', 'unknown']) {
      const killArgs = [];
      const { hooks, material } = countingHooks({
        kill: (name, opts) => {
          killArgs.push({ name, opts });
          return {
            name,
            closed: false,
            reclaimed: false,
            guarded: true,
            state: st,
            errors: [`安全保护：agent 状态为 ${st}`],
          };
        },
      });
      const res = await doctor({
        live: true,
        kind: 'cursor',
        model: 'cursor-grok-4.5-high',
        probeToken: material.token,
        hooks,
      });
      assert.strictEqual(res.ok, false, st);
      assert.strictEqual(res.error_code, ERROR_CODES.CLEANUP_GUARDED, st);
      assert.strictEqual(res.live_probe.cleanup.outcome, 'guarded', st);
      assert.strictEqual(res.live_probe.cleanup.details.force, false, st);
      assert.ok(killArgs.length >= 1, st);
      assert.ok(killArgs.every((c) => c.opts === undefined || c.opts.force !== true), st);
    }
  });

  await checkAsync('secret sanitization：API_KEY=sk-test-redaction 不得出现在 JSON', async () => {
    const m = buildProbeMaterial({ token: 'HLDOC_leak' });
    let n = 0;
    const res = await doctor({
      live: true,
      kind: 'cursor',
      probeToken: m.token,
      hooks: {
        herdrAvailable: () => true,
        executableInPath: (cmd) => cmd === 'herdr' || cmd === 'cursor-agent',
        spawn: () => ({}),
        wait: async () => ({ state: 'idle' }),
        read: () => {
          n += 1;
          return 'baseline';
        },
        submitPrompt: async () => {
          const e = new Error(
            'herdr 命令失败（1）：herdr agent prompt hl-doc Secret token: HLDOC_leak\n' +
              'API_KEY=sk-test-redaction\n' +
              `${'stderr-noise-'.repeat(80)}`
          );
          e.transport_phase = 'ambiguous';
          throw e;
        },
        kill: (name) => ({ name, closed: true, reclaimed: true, guarded: false, errors: [] }),
      },
    });
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes('sk-test-redaction'), dumped);
    assert.ok(!dumped.includes('API_KEY=sk-test-redaction'), dumped);
    assert.ok(!dumped.includes('Secret token: HLDOC_leak'), dumped);
    assert.strictEqual(res.error_code, ERROR_CODES.AMBIGUOUS_TRANSPORT);
    assert.ok(res.live_probe.error.includes('<prompt-body-redacted>') ||
      res.live_probe.error.includes('<redacted>') ||
      res.live_probe.error.includes('ambiguous'), res.live_probe.error);
  });

  await checkAsync('probe 命名唯一：两次 makeProbeName 不碰撞', async () => {
    const a = doctorMod.makeProbeName();
    const b = doctorMod.makeProbeName();
    assert.notStrictEqual(a, b);
    assert.ok(/^hl-doc-/.test(a));
  });

  await checkAsync('--live 缺 kind：kind_required_for_live', async () => {
    const { counts, hooks } = countingHooks();
    const res = await doctor({ live: true, hooks });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.KIND_REQUIRED_FOR_LIVE);
    assert.strictEqual(counts.spawn, 0);
  });

  function assertNoRawSecrets(res, token, marker, label) {
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(token), `${label}: raw token leaked`);
    assert.ok(!dumped.includes(marker), `${label}: raw marker leaked`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res.live_probe, 'probe_token'), false, label);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res.live_probe, 'expected_marker'), false, label);
    if (res.live_probe.probe_token_digest != null) {
      assert.ok(String(res.live_probe.probe_token_digest).startsWith('sha256:'), label);
      assert.ok(!String(res.live_probe.probe_token_digest).includes(token), label);
    }
    if (res.live_probe.expected_marker_digest != null) {
      assert.ok(String(res.live_probe.expected_marker_digest).startsWith('sha256:'), label);
      assert.ok(!String(res.live_probe.expected_marker_digest).includes(marker), label);
    }
  }

  await checkAsync('public JSON：live pass 不泄露 raw token/marker', async () => {
    const { hooks, material } = countingHooks();
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.live_probe.token_in_output, true);
    assert.strictEqual(res.live_probe.probe_token_digest, doctorMod.sha256Digest(material.token));
    assert.strictEqual(
      res.live_probe.expected_marker_digest,
      doctorMod.sha256Digest(material.expectedMarker)
    );
    assertNoRawSecrets(res, material.token, material.expectedMarker, 'pass');
  });

  await checkAsync('public JSON：live failure 不泄露 raw token/marker', async () => {
    const { hooks, material, baseline } = countingHooks({
      read: (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 1) return baseline;
          return `${baseline}\nassistant: no marker; Secret token: ${material.token}`;
        };
      })(),
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assertNoRawSecrets(res, material.token, material.expectedMarker, 'fail');
  });

  await checkAsync('public JSON：cleanup failure 不泄露 raw token/marker', async () => {
    const { hooks, material } = countingHooks({
      kill: (name) => ({
        name,
        closed: false,
        reclaimed: false,
        guarded: false,
        errors: [`close failed token=${material.token} marker=${material.expectedMarker}`],
      }),
    });
    const res = await doctor({
      live: true,
      kind: 'cursor',
      model: 'cursor-grok-4.5-high',
      probeToken: material.token,
      hooks,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, ERROR_CODES.CLEANUP_FAILED);
    assertNoRawSecrets(res, material.token, material.expectedMarker, 'cleanup');
  });

  await checkAsync('public JSON：local-only 无 raw token/marker 字段', async () => {
    const token = 'HLDOC_localonly99';
    const marker = `DOCTOR_REV:${reverseToken(token)}`;
    const { hooks } = countingHooks();
    const res = await doctor({ live: false, kind: 'cursor', hooks });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.live_probe.status, 'not_requested');
    assert.strictEqual(res.live_probe.probe_token_digest, null);
    assert.strictEqual(res.live_probe.expected_marker_digest, null);
    assertNoRawSecrets(res, token, marker, 'local');
  });

  await checkAsync('pre-pane failures：cleanup 终端为 not_needed，无 pending/raw secrets', async () => {
    const m = buildProbeMaterial({ token: 'HLDOC_prefinal' });
    const common = {
      herdrAvailable: () => true,
      executableInPath: (cmd) => cmd === 'herdr',
    };
    const cases = [
      ['missing-kind', { live: true, hooks: { ...common } }, ERROR_CODES.KIND_REQUIRED_FOR_LIVE],
      ['unsupported-kind', {
        live: true, kind: 'bogus', probeToken: m.token, hooks: { ...common },
      }, ERROR_CODES.UNSUPPORTED_KIND],
      ['unsupported-model', {
        live: true,
        kind: 'cursor',
        model: '-bad',
        probeToken: m.token,
        hooks: {
          ...common,
          executableInPath: (cmd) => cmd === 'herdr' || cmd === 'cursor-agent',
        },
      }, ERROR_CODES.UNSUPPORTED_MODEL],
      ['missing-executable', {
        live: true, kind: 'cursor', probeToken: m.token, hooks: { ...common },
      }, ERROR_CODES.EXECUTABLE_UNAVAILABLE],
      ['local-preflight-herdr-missing', {
        live: true,
        kind: 'cursor',
        probeToken: m.token,
        hooks: {
          herdrAvailable: () => false,
          executableInPath: () => false,
        },
      }, ERROR_CODES.HERDR_UNAVAILABLE],
    ];

    for (const [label, opts, code] of cases) {
      const res = await doctor(opts);
      const dumped = JSON.stringify(res);
      assert.strictEqual(res.ok, false, label);
      assert.strictEqual(res.error_code, code, label);
      assert.ok(['skipped', 'fail'].includes(res.live_probe.status), `${label} status=${res.live_probe.status}`);
      assert.deepStrictEqual(
        res.live_probe.cleanup,
        { attempted: false, ok: true, outcome: 'not_needed', details: null },
        label
      );
      assert.notStrictEqual(res.live_probe.cleanup.outcome, 'pending', label);
      assert.ok(!/"outcome"\s*:\s*"pending"/.test(dumped), label);
      assert.ok(!dumped.includes(m.token), `${label}: raw token`);
      assert.ok(!dumped.includes(m.expectedMarker), `${label}: raw marker`);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(res.live_probe, 'probe_token'), false, label);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(res.live_probe, 'expected_marker'), false, label);
    }
  });

  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`\n${process.exitCode ? 'SOME FAILED' : 'ALL PASS'} (${pass} checks)`);
})();
