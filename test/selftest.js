#!/usr/bin/env node
'use strict';

// herdr-live 确定性自测：不需要真 agent，验证纯逻辑（kind→flags、deep_id、台账往返）。
// 真 agent 的 happy-path（起 cursor → echo prompt → read → kill）见 test/live-happy-path.js，
// 需真 herdr 环境，单独手动跑。

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

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

// 用临时 HERDR_LIVE_HOME，避免污染真实台账。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-live-test-'));
process.env.HERDR_LIVE_HOME = tmpHome;

const { deepId, unwrap } = require('../src/herdr');
const {
  adapterFlags,
  submitNeedsEnter,
  validateModel,
  resolveModel,
  defaultSettleMs,
  buildBriefPointer,
  PASTE_SOFT_LIMIT_BYTES,
  KINDS,
} = require('../src/kinds');
const ledger = require('../src/ledger');

console.log('herdr-live 确定性自测');

// --- deep_id：从嵌套 tab create 响应里抠 pane_id/tab_id ---
check('deepId 抠嵌套 pane_id/tab_id', () => {
  const payload = { result: { root_pane: { pane_id: 'w1:p2', tab_id: 'w1:t3' } } };
  assert.strictEqual(deepId(payload, ['pane_id', 'id']), 'w1:p2');
  assert.strictEqual(deepId(payload, ['tab_id']), 'w1:t3');
});

check('deepId 处理 {value} 包裹', () => {
  const payload = { a: { pane_id: { value: 'w9:p9' } } };
  assert.strictEqual(deepId(payload, ['pane_id']), 'w9:p9');
});

check('deepId 找不到返回 null', () => {
  assert.strictEqual(deepId({ a: 1 }, ['pane_id']), null);
});

check('unwrap 解 {value} 单键对象', () => {
  assert.strictEqual(unwrap({ value: 'x' }), 'x');
  assert.deepStrictEqual(unwrap({ a: 1, b: 2 }), { a: 1, b: 2 });
});

// --- kind→flags：三种 kind 的 flags 拼接 + model 校验 ---
check('cursor flags 正确填充 model/cwd', () => {
  const f = adapterFlags('cursor', { model: 'cursor-grok-4.5-high', cwd: '/tmp/x' });
  assert.deepStrictEqual(f, ['--model', 'cursor-grok-4.5-high', '--force', '--trust', '--add-dir', '/tmp/x']);
});

check('claude flags 含 permission-mode auto', () => {
  const f = adapterFlags('claude', { model: 'claude-opus-5', cwd: '/tmp/y' });
  assert.deepStrictEqual(f, ['--model', 'claude-opus-5', '--permission-mode', 'auto', '--add-dir', '/tmp/y']);
});

check('codex flags 用 -m 与 workspace-write', () => {
  const f = adapterFlags('codex', { model: 'gpt-5-codex', cwd: '/tmp/z' });
  assert.deepStrictEqual(f, [
    '--disable', 'in_app_updates',
    '-m', 'gpt-5-codex',
    '-s', 'workspace-write',
    '-a', 'on-request',
    '--add-dir', '/tmp/z',
  ]);
});

check('未知 kind 报错', () => {
  assert.throws(() => adapterFlags('bogus', { model: 'm', cwd: '/x' }), /未配置的 agent kind/);
});

check('非法 model 被拒（空/以-开头/带空白）', () => {
  assert.throws(() => validateModel(''), /model 必须是/);
  assert.throws(() => validateModel('-x'), /model 必须是/);
  assert.throws(() => validateModel('a b'), /model 必须是/);
  assert.doesNotThrow(() => validateModel('cursor-grok-4.5-high'));
});

check('submitNeedsEnter 默认 true', () => {
  assert.strictEqual(submitNeedsEnter('cursor'), true);
  assert.strictEqual(submitNeedsEnter('claude'), true);
  assert.strictEqual(submitNeedsEnter(undefined), true);
});

check('resolveModel：显式覆盖默认', () => {
  assert.strictEqual(resolveModel('claude', 'my-claude'), 'my-claude');
  assert.strictEqual(resolveModel('claude', undefined), KINDS.claude.defaultModel);
  assert.strictEqual(resolveModel('codex', null), KINDS.codex.defaultModel);
  assert.strictEqual(resolveModel('cursor', ''), KINDS.cursor.defaultModel);
});

check('defaultSettleMs：codex 默认更长', () => {
  assert.strictEqual(defaultSettleMs('codex'), 2000);
  assert.strictEqual(defaultSettleMs('cursor'), 1000);
});

check('buildBriefPointer：短指针含绝对路径', () => {
  const p = buildBriefPointer('/tmp/brief.md', { cwd: '/work' });
  assert.ok(p.includes('/tmp/brief.md'));
  assert.ok(p.includes('工作目录：/work'));
  assert.ok(Buffer.byteLength(p, 'utf8') < PASTE_SOFT_LIMIT_BYTES);
});

// --- 台账往返：put / get / all / remove ---
check('台账 put→get 往返一致', () => {
  ledger.put('agentA', { pane_id: 'w1:p1', tab_id: 'w1:t1', kind: 'cursor', model: 'm', cwd: '/c' });
  const got = ledger.get('agentA');
  assert.strictEqual(got.name, 'agentA');
  assert.strictEqual(got.pane_id, 'w1:p1');
  assert.strictEqual(got.tab_id, 'w1:t1');
  assert.strictEqual(got.kind, 'cursor');
});

check('台账 all 列出全部', () => {
  ledger.put('agentB', { pane_id: 'w1:p2', kind: 'claude', model: 'm', cwd: '/c' });
  const names = ledger.all().map((e) => e.name).sort();
  assert.deepStrictEqual(names, ['agentA', 'agentB']);
});

check('台账 remove 删除条目', () => {
  ledger.remove('agentA');
  assert.strictEqual(ledger.get('agentA'), null);
  assert.strictEqual(ledger.all().length, 1);
});

check('台账 get 不存在返回 null', () => {
  assert.strictEqual(ledger.get('nope'), null);
});

// --- kill 语义：关闭失败保留台账条目（首版泄漏 bug 的回归） ---
const herdrMod = require('../src/herdr');
const live = require('../src/live');
const realHerdr = herdrMod.herdr;
const realAgentRecord = herdrMod.agentRecord;
const realAgentState = herdrMod.agentState;

check('kill 关闭失败时保留台账条目（可重试回收）', () => {
  ledger.put('killFail', { pane_id: 'w1:p9', tab_id: 'w1:t9', kind: 'cursor', model: 'm', cwd: '/c' });
  herdrMod.herdr = () => { throw new herdrMod.HerdrError('transient: server busy'); };
  try {
    const res = live.kill('killFail', { force: true });
    assert.strictEqual(res.reclaimed, false, 'reclaimed 应为 false');
    assert.strictEqual(res.closed, false, 'closed 应为 false');
    assert.ok(res.errors.length > 0, '应记录错误');
    assert.ok(ledger.get('killFail'), '台账条目必须保留以便重试');
  } finally {
    herdrMod.herdr = realHerdr;
  }
});

check('kill 关闭成功时删除台账条目', () => {
  ledger.put('killOk', { pane_id: 'w1:p8', tab_id: 'w1:t8', kind: 'cursor', model: 'm', cwd: '/c' });
  herdrMod.herdr = () => 'ok';
  try {
    const res = live.kill('killOk', { force: true });
    assert.strictEqual(res.reclaimed, true);
    assert.strictEqual(res.closed, true);
    assert.strictEqual(ledger.get('killOk'), null, '成功后台账条目应删除');
  } finally {
    herdrMod.herdr = realHerdr;
  }
});

check('kill tab 已不存在视为已回收并清台账', () => {
  ledger.put('killGone', { pane_id: 'w1:p7', tab_id: 'w1:t7', kind: 'cursor', model: 'm', cwd: '/c' });
  herdrMod.herdr = () => { throw new herdrMod.HerdrError('tab_not_found: w1:t7'); };
  try {
    const res = live.kill('killGone', { force: true });
    assert.strictEqual(res.reclaimed, true, 'not_found 等价已回收');
    assert.strictEqual(ledger.get('killGone'), null);
  } finally {
    herdrMod.herdr = realHerdr;
  }
});

check('kill 默认保护 working/unknown，显式 force 才关闭', () => {
  ledger.put('killGuard', { pane_id: 'w1:p6', tab_id: 'w1:t6', kind: 'codex', model: 'm', cwd: '/c' });
  let closeCalls = 0;
  herdrMod.agentRecord = () => ({ agent_status: 'working' });
  herdrMod.agentState = (rec) => rec.agent_status;
  herdrMod.herdr = () => { closeCalls += 1; return 'ok'; };
  try {
    const guarded = live.kill('killGuard');
    assert.strictEqual(guarded.guarded, true);
    assert.strictEqual(guarded.closed, false);
    assert.strictEqual(closeCalls, 0, '保护态不能关闭 tab');
    assert.ok(ledger.get('killGuard'), '保护态必须保留台账');
    const forced = live.kill('killGuard', { force: true });
    assert.strictEqual(forced.closed, true);
    assert.strictEqual(closeCalls, 1);
    assert.strictEqual(ledger.get('killGuard'), null);
  } finally {
    herdrMod.herdr = realHerdr;
    herdrMod.agentRecord = realAgentRecord;
    herdrMod.agentState = realAgentState;
  }
});

check('kill 默认允许 idle/done，无需 force', () => {
  for (const st of ['idle', 'done']) {
    ledger.put('killAllow', { pane_id: 'w1:p5', tab_id: 'w1:t5', kind: 'cursor', model: 'm', cwd: '/c' });
    let closeCalls = 0;
    herdrMod.agentRecord = () => ({ agent_status: st });
    herdrMod.agentState = (rec) => rec.agent_status;
    herdrMod.herdr = () => { closeCalls += 1; return 'ok'; };
    try {
      const res = live.kill('killAllow');
      assert.strictEqual(res.guarded, false, `${st} 不应触发保护`);
      assert.strictEqual(res.closed, true);
      assert.strictEqual(res.state, st);
      assert.strictEqual(closeCalls, 1);
      assert.strictEqual(ledger.get('killAllow'), null);
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
      try { ledger.remove('killAllow'); } catch (e) { /* ignore */ }
    }
  }
});

check('kill 默认保护 blocked/gone', () => {
  for (const st of ['blocked', 'gone']) {
    ledger.put('killBlock', { pane_id: 'w1:p4', tab_id: 'w1:t4', kind: 'claude', model: 'm', cwd: '/c' });
    let closeCalls = 0;
    if (st === 'gone') {
      herdrMod.agentRecord = () => { throw new herdrMod.HerdrError('missing'); };
    } else {
      herdrMod.agentRecord = () => ({ agent_status: st });
      herdrMod.agentState = (rec) => rec.agent_status;
    }
    herdrMod.herdr = () => { closeCalls += 1; return 'ok'; };
    try {
      const res = live.kill('killBlock');
      assert.strictEqual(res.guarded, true);
      assert.strictEqual(res.closed, false);
      assert.strictEqual(res.state, st);
      assert.strictEqual(closeCalls, 0);
      assert.ok(ledger.get('killBlock'));
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
      try { ledger.remove('killBlock'); } catch (e) { /* ignore */ }
    }
  }
});

check('spawn 可执行文件预检 helper', () => {
  assert.strictEqual(live.executableInPath('node'), true);
  assert.strictEqual(live.executableInPath('definitely-not-a-real-herdr-live-binary'), false);
});

check('spawn 预检失败不创建 tab', () => {
  const oldPath = process.env.PATH;
  let calls = 0;
  herdrMod.herdr = () => { calls += 1; return {}; };
  process.env.PATH = '';
  try {
    assert.throws(
      () => live.spawn('spawnPrecheck', { kind: 'cursor', model: 'cursor-grok-4.5-high' }),
      /启动前检查失败/
    );
    assert.strictEqual(calls, 0, '预检失败不得调用 herdr');
    assert.strictEqual(ledger.get('spawnPrecheck'), null);
  } finally {
    process.env.PATH = oldPath;
    herdrMod.herdr = realHerdr;
  }
});

check('spawn agent start 失败时台账已登记', () => {
  herdrMod.herdr = (args) => {
    if (args[0] === 'tab' && args[1] === 'create') {
      return { pane_id: 'w9:p1', tab_id: 'w9:t1' };
    }
    if (args[0] === 'agent' && args[1] === 'start') {
      throw new herdrMod.HerdrError('agent start timeout');
    }
    throw new Error(`unexpected herdr args: ${args.join(' ')}`);
  };
  try {
    assert.throws(
      () => live.spawn('spawnReg', { kind: 'cursor', model: 'cursor-grok-4.5-high' }),
      /已创建并登记 spawnReg/
    );
    const entry = ledger.get('spawnReg');
    assert.ok(entry, 'start 失败后台账必须可查');
    assert.strictEqual(entry.pane_id, 'w9:p1');
    assert.strictEqual(entry.tab_id, 'w9:t1');
    assert.strictEqual(entry.kind, 'cursor');
  } finally {
    try { ledger.remove('spawnReg'); } catch (e) { /* ignore */ }
    herdrMod.herdr = realHerdr;
  }
});

const WORKSPACE_TRUST_FIXTURE = `
Workspace Trust Required

This workspace has not been trusted yet.

  [a] Allow
  [q] Quit
`;

const CURSOR_PERMISSION_FIXTURE = `
Permission required to continue
❯ a. Allow once
  A. Always allow
  d. Deny
`;

check('detectWorkspaceTrustPrompt 识别 Trust 屏、拒绝权限 UI', () => {
  assert.strictEqual(live.detectWorkspaceTrustPrompt(WORKSPACE_TRUST_FIXTURE).recognized, true);
  assert.strictEqual(live.detectWorkspaceTrustPrompt(CURSOR_PERMISSION_FIXTURE).recognized, false);
  assert.strictEqual(live.detectWorkspaceTrustPrompt('').recognized, false);
});

check('DEFAULT_CONFIRM_START_MS 为 15000', () => {
  assert.strictEqual(live.DEFAULT_CONFIRM_START_MS, 15000);
});

check('spawn 见 Workspace Trust 时按一次 a', () => {
  const calls = [];
  herdrMod.herdr = (args) => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'create') {
      return { pane_id: 'w9:p2', tab_id: 'w9:t2' };
    }
    if (args[0] === 'agent' && args[1] === 'start') return 'ok';
    if (args[0] === 'agent' && args[1] === 'read') return WORKSPACE_TRUST_FIXTURE;
    if (args[0] === 'agent' && args[1] === 'send-keys') return 'ok';
    throw new Error(`unexpected herdr args: ${args.join(' ')}`);
  };
  herdrMod.agentRecord = () => ({ name: 'spawnTrust', agent_status: 'idle', state_change_seq: 1 });
  herdrMod.agentState = () => 'idle';
  try {
    const res = live.spawn('spawnTrust', { kind: 'cursor', model: 'cursor-grok-4.5-high' });
    assert.strictEqual(res.workspace_trust_accepted, true);
    assert.ok(calls.some((a) => a[0] === 'agent' && a[1] === 'send-keys' && a[3] === 'a'));
    assert.ok(!calls.some((a) => a[1] === 'send-keys' && a[3] === 'enter'));
  } finally {
    try { ledger.remove('spawnTrust'); } catch (e) { /* ignore */ }
    herdrMod.herdr = realHerdr;
    herdrMod.agentRecord = realAgentRecord;
    herdrMod.agentState = realAgentState;
  }
});

check('spawn 权限 UI 不按 a', () => {
  const calls = [];
  herdrMod.herdr = (args) => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'create') {
      return { pane_id: 'w9:p3', tab_id: 'w9:t3' };
    }
    if (args[0] === 'agent' && args[1] === 'start') return 'ok';
    if (args[0] === 'agent' && args[1] === 'read') return CURSOR_PERMISSION_FIXTURE;
    if (args[0] === 'agent' && args[1] === 'send-keys') return 'ok';
    throw new Error(`unexpected herdr args: ${args.join(' ')}`);
  };
  herdrMod.agentRecord = () => ({ name: 'spawnPerm', agent_status: 'idle' });
  herdrMod.agentState = () => 'idle';
  try {
    const res = live.spawn('spawnPerm', { kind: 'cursor', model: 'cursor-grok-4.5-high' });
    assert.strictEqual(res.workspace_trust_accepted, false);
    assert.ok(!calls.some((a) => a[1] === 'send-keys'));
  } finally {
    try { ledger.remove('spawnPerm'); } catch (e) { /* ignore */ }
    herdrMod.herdr = realHerdr;
    herdrMod.agentRecord = realAgentRecord;
    herdrMod.agentState = realAgentState;
  }
});

check('assertPasteSize：超软上限拒绝', () => {
  const big = 'x'.repeat(PASTE_SOFT_LIMIT_BYTES + 1);
  assert.throws(() => live.assertPasteSize(big), /超过输入框软上限/);
  assert.doesNotThrow(() => live.assertPasteSize(big, { forcePaste: true }));
  assert.doesNotThrow(() => live.assertPasteSize('ok'));
});

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

(async () => {
  await checkAsync('prompt：假 idle 落 ambiguous（非假 submitted+confirmed）', async () => {
    ledger.put('promptIdle', {
      pane_id: 'w1:p1', tab_id: 'w1:t1', kind: 'cursor', model: 'm', cwd: '/c',
    });
    const calls = [];
    herdrMod.herdr = (args) => {
      calls.push(args);
      return 'ok';
    };
    herdrMod.agentRecord = () => ({ name: 'promptIdle', agent_status: 'idle', state_change_seq: 1 });
    herdrMod.agentState = () => 'idle';
    try {
      let threw = false;
      let receipt = null;
      try {
        await live.prompt('promptIdle', 'hi', {
          confirmStartMs: 400,
          settleMs: 0,
          skipLock: true,
          forceProfile: 'official-0.7.5',
        });
      } catch (e) {
        threw = true;
        receipt = e.receipt;
        assert.ok(/ambiguous/.test(e.message), e.message);
      }
      assert.ok(threw, '应抛错，不得返回 confirmed');
      assert.ok(receipt, '必须保留 receipt');
      assert.strictEqual(receipt.transport_phase, 'ambiguous');
      assert.strictEqual(receipt.confirmed, false);
      assert.ok(calls.some((a) => a[0] === 'agent' && a[1] === 'prompt'));
      assert.ok(calls.some((a) => a[0] === 'agent' && a[1] === 'send-keys'));
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('prompt：见 working 则 lifecycle_observed', async () => {
    ledger.put('promptOk', {
      pane_id: 'w1:p2', tab_id: 'w1:t2', kind: 'claude', model: 'm', cwd: '/work',
    });
    herdrMod.herdr = () => 'ok';
    let seq = 1;
    herdrMod.agentRecord = () => {
      const status = seq === 1 ? 'idle' : 'working';
      const rec = { name: 'promptOk', agent_status: status, state_change_seq: seq };
      if (seq === 1) seq = 2;
      return rec;
    };
    herdrMod.agentState = (rec) => (rec && rec.agent_status) || 'working';
    try {
      const res = await live.prompt('promptOk', 'hi', {
        confirmStartMs: 2000,
        settleMs: 0,
        skipLock: true,
        forceProfile: 'official-0.7.5',
      });
      assert.strictEqual(res.transport_phase, 'lifecycle_observed');
      assert.strictEqual(res.submitted, true);
      assert.strictEqual(res.confirmed, true);
      assert.strictEqual(res.observed.state, 'working');
      assert.strictEqual(res.transport, 'paste');
      assert.ok(res.prompt_digest.startsWith('sha256:'));
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('prompt：--brief-file 发短指针而非整文件', async () => {
    const briefPath = path.join(tmpHome, 'big-brief.md');
    fs.writeFileSync(briefPath, 'x'.repeat(5000));
    ledger.put('promptBrief', {
      pane_id: 'w1:p3', tab_id: 'w1:t3', kind: 'codex', model: 'm', cwd: '/work',
    });
    let promptedBody = null;
    herdrMod.herdr = (args) => {
      if (args[0] === 'agent' && args[1] === 'prompt') promptedBody = args[3];
      return 'ok';
    };
    let n = 0;
    herdrMod.agentRecord = () => {
      n += 1;
      return {
        name: 'promptBrief',
        agent_status: n === 1 ? 'idle' : 'working',
        state_change_seq: n,
      };
    };
    herdrMod.agentState = (rec) => (rec && rec.agent_status) || 'working';
    try {
      const res = await live.prompt('promptBrief', null, {
        briefFile: briefPath,
        confirmStartMs: 2000,
        settleMs: 0,
        skipLock: true,
        forceProfile: 'official-0.7.5',
      });
      assert.strictEqual(res.transport, 'brief-pointer');
      assert.strictEqual(res.transport_phase, 'lifecycle_observed');
      assert.ok(promptedBody.includes(briefPath));
      assert.ok(promptedBody.includes('请完整阅读并严格按此文件执行'));
      assert.ok(!promptedBody.includes('xxxxx'), '不应整段 paste 大文件');
      assert.ok(res.promptBytes < PASTE_SOFT_LIMIT_BYTES);
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('prompt：--brief-style answer 不用派工腔', async () => {
    const briefPath = path.join(tmpHome, 'resume-prompt.md');
    fs.writeFileSync(briefPath, '人已选定：B\n从挂起点继续\n');
    ledger.put('promptAnswer', {
      pane_id: 'w1:p4', tab_id: 'w1:t4', kind: 'cursor', model: 'm', cwd: '/work',
    });
    let promptedBody = null;
    herdrMod.herdr = (args) => {
      if (args[0] === 'agent' && args[1] === 'prompt') promptedBody = args[3];
      return 'ok';
    };
    let n = 0;
    herdrMod.agentRecord = () => {
      n += 1;
      return {
        name: 'promptAnswer',
        agent_status: n === 1 ? 'idle' : 'working',
        state_change_seq: n,
      };
    };
    herdrMod.agentState = (rec) => (rec && rec.agent_status) || 'working';
    try {
      const res = await live.prompt('promptAnswer', null, {
        briefFile: briefPath,
        briefStyle: 'answer',
        confirmStartMs: 2000,
        settleMs: 0,
        skipLock: true,
        forceProfile: 'official-0.7.5',
      });
      assert.strictEqual(res.transport, 'brief-pointer-answer');
      assert.ok(promptedBody.includes('人已答复'));
      assert.ok(promptedBody.includes(briefPath));
      assert.ok(!/请完整阅读并严格/.test(promptedBody));
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  check('isPaneId / resolveSubmitTarget：pane_id 与台账名', () => {
    assert.strictEqual(live.isPaneId('w3:p16'), true);
    assert.strictEqual(live.isPaneId('w3:p3G'), true);
    assert.strictEqual(live.isPaneId('va-hl-submit'), false);
    ledger.put('namedAgent', {
      pane_id: 'w1:p5', tab_id: 'w1:t5', kind: 'cursor', model: 'm', cwd: '/c',
    });
    const byName = live.resolveSubmitTarget('namedAgent');
    assert.strictEqual(byName.via, 'ledger_name');
    assert.strictEqual(byName.herdrTarget, 'namedAgent');
    herdrMod.agentRecord = () => {
      throw new herdrMod.HerdrError('stub: no probe');
    };
    try {
      const byPane = live.resolveSubmitTarget('w9:p99', { kind: 'cursor' });
      assert.strictEqual(byPane.via, 'pane_id');
      assert.strictEqual(byPane.herdrTarget, 'w9:p99');
      assert.strictEqual(byPane.kind, 'cursor');
    } finally {
      herdrMod.agentRecord = realAgentRecord;
    }
  });

  await checkAsync('submitPrompt：pane_id 路径仍调用 enter（无台账）', async () => {
    const calls = [];
    herdrMod.herdr = (args) => {
      calls.push(args);
      return 'ok';
    };
    let n = 0;
    herdrMod.agentRecord = (t) => {
      n += 1;
      return {
        name: t,
        pane_id: 'w9:p42',
        agent: 'cursor',
        agent_status: n === 1 ? 'idle' : 'working',
        state_change_seq: n,
        cwd: '/wake',
      };
    };
    herdrMod.agentState = (rec) => (rec && rec.agent_status) || 'working';
    try {
      // 刻意不写 ledger——叫醒场景常见
      assert.strictEqual(ledger.get('w9:p42'), null);
      const res = await live.submitPrompt({
        target: 'w9:p42',
        text: 'wake brief',
        confirmStartMs: 2000,
        settleMs: 0,
        skipLock: true,
        forceProfile: 'official-0.7.5',
      });
      assert.strictEqual(res.submitted, true);
      assert.strictEqual(res.confirmed, true);
      assert.strictEqual(res.transport_phase, 'lifecycle_observed');
      assert.strictEqual(res.target.via, 'pane_id');
      assert.strictEqual(res.target.herdr_target, 'w9:p42');
      assert.ok(calls.some((a) => a[0] === 'agent' && a[1] === 'prompt' && a[2] === 'w9:p42'));
      assert.ok(
        calls.some((a) => a[0] === 'agent' && a[1] === 'send-keys' && a[2] === 'w9:p42' && a[3] === 'enter'),
        'pane_id 路径必须 send-keys enter'
      );
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('submitPrompt：确认失败 → ambiguous receipt（禁止假 submitted confirmed）', async () => {
    const calls = [];
    herdrMod.herdr = (args) => {
      calls.push(args);
      return 'ok';
    };
    herdrMod.agentRecord = () => ({
      pane_id: 'w9:p43', agent: 'cursor', agent_status: 'idle', state_change_seq: 1,
    });
    herdrMod.agentState = () => 'idle';
    try {
      let threw = false;
      let receipt = null;
      try {
        await live.submitPrompt({
          target: 'w9:p43',
          text: 'hi',
          confirmStartMs: 400,
          settleMs: 0,
          skipLock: true,
          forceProfile: 'official-0.7.5',
        });
      } catch (e) {
        threw = true;
        receipt = e.receipt;
        assert.ok(/ambiguous/.test(e.message), e.message);
      }
      assert.ok(threw, '应抛错，不得返回 confirmed');
      assert.strictEqual(receipt.transport_phase, 'ambiguous');
      assert.ok(calls.some((a) => a[1] === 'send-keys' && a[3] === 'enter'));
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  // --- wrapper-only transport receipts / profile / lock ---
  const versionProfile = require('../src/version_profile');
  const targetLock = require('../src/target_lock');
  const receiptMod = require('../src/receipt');

  check('version profile：0.7.5 → explicit-enter', () => {
    assert.strictEqual(versionProfile.classifyVersionText('herdr 0.7.5'), 'official-0.7.5');
    const p = versionProfile.resolveVersionProfile({
      versionText: 'herdr 0.7.5',
    });
    assert.strictEqual(p.enterPolicy, 'explicit-enter');
    assert.ok(versionProfile.shouldSendEnter(p));
  });

  check('version profile：core-managed-enter 禁止二次 Enter', () => {
    const p = versionProfile.resolveVersionProfile({ forceProfile: 'core-managed-enter' });
    assert.strictEqual(p.enterPolicy, 'no-second-enter');
    assert.strictEqual(versionProfile.shouldSendEnter(p), false);
  });

  check('version profile：unknown fail-closed', () => {
    const p = versionProfile.resolveVersionProfile({ versionText: 'herdr 9.9.9-nightly' });
    assert.strictEqual(p.id, 'unknown');
    assert.throws(() => versionProfile.assertTransportAllowed(p), /未识别/);
  });

  await checkAsync('submitPrompt：core-managed-enter 不发第二次 Enter', async () => {
    const calls = [];
    herdrMod.herdr = (args) => {
      calls.push(args);
      return 'ok';
    };
    let n = 0;
    herdrMod.agentRecord = () => {
      n += 1;
      return { pane_id: 'w1:p50', agent_status: n === 1 ? 'idle' : 'working', state_change_seq: n };
    };
    herdrMod.agentState = (rec) => (rec && rec.agent_status) || 'working';
    try {
      const res = await live.submitPrompt({
        target: 'w1:p50',
        text: 'hi',
        kind: 'cursor',
        settleMs: 0,
        confirmStartMs: 2000,
        skipLock: true,
        forceProfile: 'core-managed-enter',
      });
      assert.strictEqual(res.transport_phase, 'lifecycle_observed');
      assert.ok(calls.some((a) => a[1] === 'prompt'));
      assert.ok(!calls.some((a) => a[1] === 'send-keys'), '禁止二次 Enter');
      assert.strictEqual(res.evidence.enter_delegated_to_core, true);
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('submitPrompt：已 working baseline 不能假确认', async () => {
    herdrMod.herdr = () => 'ok';
    herdrMod.agentRecord = () => ({
      pane_id: 'w1:p51', agent_status: 'working', state_change_seq: 9,
    });
    herdrMod.agentState = () => 'working';
    try {
      let receipt = null;
      try {
        await live.submitPrompt({
          target: 'w1:p51',
          text: 'hi',
          kind: 'cursor',
          settleMs: 0,
          confirmStartMs: 400,
          skipLock: true,
          forceProfile: 'official-0.7.5',
        });
      } catch (e) {
        receipt = e.receipt;
      }
      assert.ok(receipt);
      assert.strictEqual(receipt.transport_phase, 'ambiguous');
      assert.strictEqual(receipt.baseline.state, 'working');
      assert.strictEqual(receipt.baseline.state_change_seq, 9);
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('submitPrompt：pre-transport 失败 → not_sent', async () => {
    try {
      let receipt = null;
      try {
        await live.submitPrompt({
          target: 'w1:p52',
          // missing text/file/brief → before transport
          settleMs: 0,
          skipLock: true,
          forceProfile: 'official-0.7.5',
        });
      } catch (e) {
        receipt = e.receipt;
        assert.strictEqual(e.transport_phase, 'not_sent');
      }
      assert.ok(receipt);
      assert.strictEqual(receipt.transport_phase, 'not_sent');
      assert.ok(receiptMod.mayRetry(receipt));
    } finally {
      herdrMod.herdr = realHerdr;
    }
  });

  check('receipt：仅 not_sent 可 retry；persist round-trip', () => {
    const r = receiptMod.createReceipt({ submission_id: 't:a:bootstrap' });
    assert.strictEqual(r.transport_phase, 'not_sent');
    assert.ok(receiptMod.mayRetry(r));
    receiptMod.setPhase(r, 'prompt_filled');
    assert.ok(!receiptMod.mayRetry(r));
    receiptMod.setPhase(r, 'ambiguous');
    assert.ok(!receiptMod.mayRetry(r));
    const p = path.join(tmpHome, 'receipt-roundtrip.json');
    receiptMod.persistReceipt(r, p);
    const loaded = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(loaded.submission_id, 't:a:bootstrap');
    assert.strictEqual(loaded.transport_phase, 'ambiguous');
    const cleaned = receiptMod.cleanupReceipts({
      root: tmpHome,
      maxAgeMs: -1,
      maxFiles: 0,
    });
    assert.ok(cleaned.removed >= 1);
  });

  check('target lock：原子获取 + finally 释放 + 仅 PID gone 可回收', () => {
    const lockDir = path.join(tmpHome, 'locks');
    const first = targetLock.acquireTargetLock('w1:p99', { lockRoot: lockDir, staleMs: 0 });
    assert.ok(fs.existsSync(first.path));
    assert.throws(
      () => targetLock.acquireTargetLock('w1:p99', { lockRoot: lockDir, staleMs: 0 }),
      /lock held/
    );
    first.release();
    assert.ok(!fs.existsSync(first.path));

    // Stale file with dead PID
    const info = targetLock.lockPath('w1:p98', lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      info.path,
      JSON.stringify({ pid: 999999999, created_ms: Date.now() - 1000, pane_id: 'w1:p98' })
    );
    const reclaimed = targetLock.acquireTargetLock('w1:p98', { lockRoot: lockDir, staleMs: 0 });
    assert.ok(fs.existsSync(reclaimed.path));
    reclaimed.release();
  });

  await checkAsync('explicit-enter：kind submitNeedsEnter=false 不能压制 Enter', async () => {
    const kinds = require('../src/kinds');
    const orig = kinds.KINDS.cursor.submitNeedsEnter;
    kinds.KINDS.cursor.submitNeedsEnter = false;
    const calls = [];
    herdrMod.herdr = (args) => { calls.push(args); return 'ok'; };
    let n = 0;
    herdrMod.agentRecord = () => {
      n += 1;
      return { pane_id: 'w1:p60', agent_status: n === 1 ? 'idle' : 'working', state_change_seq: n };
    };
    herdrMod.agentState = (rec) => (rec && rec.agent_status) || 'working';
    try {
      await live.submitPrompt({
        target: 'w1:p60',
        text: 'hi',
        kind: 'cursor',
        settleMs: 0,
        confirmStartMs: 2000,
        skipLock: true,
        forceProfile: 'official-0.7.5',
      });
      assert.ok(
        calls.some((a) => a[1] === 'send-keys' && a[3] === 'enter'),
        '0.7.5 profile 必须 Enter，不受 kind 标志压制'
      );
    } finally {
      kinds.KINDS.cursor.submitNeedsEnter = orig;
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('wait：idle+Trust 不视为到达，按一次 a', async () => {
    herdrMod.agentRecord = () => ({ agent_status: 'idle', state_change_seq: 1 });
    herdrMod.agentState = () => 'idle';
    const calls = [];
    herdrMod.herdr = (args) => {
      calls.push(args);
      if (args[1] === 'read') return WORKSPACE_TRUST_FIXTURE;
      if (args[1] === 'send-keys') return 'ok';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    try {
      await assert.rejects(
        () => live.wait('w1:p70', { until: ['idle'], timeoutMs: 250, pollMs: 50 }),
        /Workspace Trust 仍在/
      );
      const aKeys = calls.filter((a) => a[1] === 'send-keys' && a[3] === 'a');
      assert.strictEqual(aKeys.length, 1);
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('wait：Trust 消失后 idle 才到达', async () => {
    herdrMod.agentRecord = () => ({ agent_status: 'idle', state_change_seq: 1 });
    herdrMod.agentState = () => 'idle';
    let reads = 0;
    herdrMod.herdr = (args) => {
      if (args[1] === 'read') {
        reads += 1;
        return reads === 1 ? WORKSPACE_TRUST_FIXTURE : 'prompt ready';
      }
      if (args[1] === 'send-keys') return 'ok';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    try {
      const res = await live.wait('w1:p71', { until: ['idle'], timeoutMs: 1000, pollMs: 20 });
      assert.strictEqual(res.reached, true);
      assert.strictEqual(res.state, 'idle');
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('prompt：Trust 未清除则 not_sent，不调用 agent prompt', async () => {
    ledger.put('promptTrust', {
      pane_id: 'w1:p80', tab_id: 'w1:t80', kind: 'cursor', model: 'm', cwd: '/c',
    });
    const calls = [];
    herdrMod.herdr = (args) => {
      calls.push(args);
      if (args[1] === 'read') return WORKSPACE_TRUST_FIXTURE;
      if (args[1] === 'send-keys') return 'ok';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    herdrMod.agentRecord = () => ({ name: 'promptTrust', agent_status: 'idle', state_change_seq: 1 });
    herdrMod.agentState = () => 'idle';
    try {
      let receipt = null;
      try {
        await live.prompt('promptTrust', 'hi', {
          confirmStartMs: 250,
          settleMs: 0,
          skipLock: true,
          forceProfile: 'official-0.7.5',
        });
      } catch (e) {
        receipt = e.receipt;
        assert.strictEqual(e.transport_phase, 'not_sent');
      }
      assert.ok(receipt);
      assert.strictEqual(receipt.transport_phase, 'not_sent');
      assert.strictEqual(receipt.evidence.workspace_trust_accepted, true);
      assert.ok(!calls.some((a) => a[1] === 'prompt'));
      assert.ok(calls.some((a) => a[1] === 'send-keys' && a[3] === 'a'));
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('prompt：Trust 按 a 后见 working → lifecycle_observed', async () => {
    ledger.put('promptTrustOk', {
      pane_id: 'w1:p81', tab_id: 'w1:t81', kind: 'cursor', model: 'm', cwd: '/c',
    });
    let reads = 0;
    let seq = 1;
    herdrMod.herdr = (args) => {
      if (args[1] === 'read') {
        reads += 1;
        return reads === 1 ? WORKSPACE_TRUST_FIXTURE : '';
      }
      if (args[1] === 'prompt' || args[1] === 'send-keys') return 'ok';
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    herdrMod.agentRecord = () => {
      const status = seq === 1 ? 'idle' : 'working';
      const rec = { name: 'promptTrustOk', agent_status: status, state_change_seq: seq };
      if (seq === 1) seq = 2;
      return rec;
    };
    herdrMod.agentState = (rec) => (rec && rec.agent_status) || 'idle';
    try {
      const res = await live.prompt('promptTrustOk', 'hi', {
        confirmStartMs: 2000,
        settleMs: 0,
        skipLock: true,
        forceProfile: 'official-0.7.5',
      });
      assert.strictEqual(res.transport_phase, 'lifecycle_observed');
      assert.strictEqual(res.evidence.workspace_trust_accepted, true);
    } finally {
      herdrMod.herdr = realHerdr;
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  await checkAsync('confirmStart：拒绝假 idle baseline（已 working 不可假确认）', async () => {
    herdrMod.agentRecord = () => ({
      pane_id: 'w1:p61', agent_status: 'working', state_change_seq: 9,
    });
    herdrMod.agentState = () => 'working';
    try {
      await assert.rejects(
        () => live.confirmStart('w1:p61', { confirmStartMs: 200 }),
        /需要真实 baseline/
      );
      let threw = false;
      try {
        await live.confirmStart('w1:p61', {
          baseline: { state: 'working', state_change_seq: 9 },
          confirmStartMs: 300,
        });
      } catch (e) {
        threw = true;
      }
      assert.ok(threw, '真实 working baseline 不得假确认');
    } finally {
      herdrMod.agentRecord = realAgentRecord;
      herdrMod.agentState = realAgentState;
    }
  });

  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`\n${process.exitCode ? 'SOME FAILED' : 'ALL PASS'} (${pass} checks)`);
})();

