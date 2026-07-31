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
const { adapterFlags, submitNeedsEnter, validateModel } = require('../src/kinds');
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
  assert.deepStrictEqual(f, ['-m', 'gpt-5-codex', '-s', 'workspace-write', '-a', 'on-request', '--add-dir', '/tmp/z']);
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

check('kill 关闭失败时保留台账条目（可重试回收）', () => {
  ledger.put('killFail', { pane_id: 'w1:p9', tab_id: 'w1:t9', kind: 'cursor', model: 'm', cwd: '/c' });
  herdrMod.herdr = () => { throw new herdrMod.HerdrError('transient: server busy'); };
  try {
    const res = live.kill('killFail');
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
    const res = live.kill('killOk');
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
    const res = live.kill('killGone');
    assert.strictEqual(res.reclaimed, true, 'not_found 等价已回收');
    assert.strictEqual(ledger.get('killGone'), null);
  } finally {
    herdrMod.herdr = realHerdr;
  }
});

// 清理临时台账
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log(`\n${process.exitCode ? 'SOME FAILED' : 'ALL PASS'} (${pass} checks)`);
