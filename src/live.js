'use strict';

// herdr-live 的五个核心动词：spawn / prompt / read / wait / kill。
// 每个动词把一段易错的 herdr 底层序列变成语义明确的调用，把踩过的坑固化进来：
//  - spawn：tab create 拿 pane_id + agent start 按 kind 拼对 flags；
//  - prompt：agent prompt 后自动补 enter 提交（修掉"填充但没提交"的坑）；
//  - wait：轮询 herdr 实时状态到目标态，超时报错；
//  - read：agent read 取终端，可选只取尾部；
//  - kill：关 tab 收资源，清台账。

const herdrMod = require('./herdr');
const { herdr, result, deepId, agentRecord, agentState } = herdrMod;
const { adapterFlags, submitNeedsEnter } = require('./kinds');
const ledger = require('./ledger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// spawn：起一个 live agent。= tab create（拿 pane_id/tab_id）+ agent start（按 kind 拼 flags）。
// 返回 { name, pane_id, tab_id, kind, model, cwd, state }。
function spawn(name, { kind, model, cwd, label } = {}) {
  if (!name) throw new herdrMod.HerdrError('spawn 需要 name');
  if (!kind) throw new herdrMod.HerdrError('spawn 需要 --kind');
  if (!model) throw new herdrMod.HerdrError('spawn 需要 --model');
  const workdir = cwd || process.cwd();

  const createArgs = ['tab', 'create', '--cwd', workdir, '--no-focus', '--label', label || `live-${name}`];
  const payload = result(herdr(createArgs, { parseJson: true }));
  const paneId = deepId(payload, ['pane_id', 'id']);
  const tabId = deepId(payload, ['tab_id']);
  if (!paneId) throw new herdrMod.HerdrError('无法从 tab create 结果识别 pane_id');

  const flags = adapterFlags(kind, { model, cwd: workdir });
  herdr(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--', ...flags]);

  let state = 'unknown';
  try {
    state = agentState(agentRecord(name));
  } catch (e) {
    // agent 刚起，list 可能还没收敛——状态留 unknown，不阻断 spawn。
  }

  const entry = ledger.put(name, { pane_id: paneId, tab_id: tabId, kind, model, cwd: workdir });
  return { ...entry, state };
}

// prompt：给 agent 发一条 prompt 并自动提交。
// 关键（本轮实测固化的两个坑）：
//  1. herdr agent prompt 只填充输入框、不提交；需随后 send-keys enter 才执行；
//  2. 填充与 enter 之间存在竞态——enter 太快会在填充落定前触发，导致 prompt 滞留输入框
//     不发出（agent 停在 idle）。故在两者之间插入一个 settle 延时（默认 1000ms），
//     实测 <1s 会偶发滞留、≥1s 稳定提交。
async function prompt(name, text, { waitUntil, timeoutMs = 120000, settleMs = 1000 } = {}) {
  if (text == null) throw new herdrMod.HerdrError('prompt 需要 text（--text 或 --file）');
  const entry = ledger.get(name);
  const kind = entry && entry.kind;

  herdr(['agent', 'prompt', name, text]);
  if (submitNeedsEnter(kind)) {
    if (settleMs > 0) await sleep(settleMs);
    herdr(['agent', 'send-keys', name, 'enter']);
  }

  if (waitUntil) {
    return wait(name, { until: waitUntil, timeoutMs });
  }
  let state = 'unknown';
  try {
    state = agentState(agentRecord(name));
  } catch (e) { /* ignore */ }
  return { name, submitted: true, state };
}

// read：读 agent 终端输出。tail 只取尾部 N 行。
// 用默认 source（完整对话回滚窗口）；实测 --source recent-unwrapped 只回状态栏、几乎空，
// 那个 source 是给 busy 签名检测用的小窗口，不适合读对话。回滚窗口有限，超长输出会滚掉——
// 判官应以外部权威源（如 Bus transcript）为准，不单靠 read（docs/05 §7）。
function read(name, { tail } = {}) {
  const args = ['agent', 'read', name, '--lines', String(tail || 200), '--format', 'text'];
  return herdr(args);
}

// wait：轮询 herdr 实时状态直到命中 until 之一，或超时报错。
// until 可以是单个状态或数组。默认目标 idle/done（agent 干完活的稳定态）。
async function wait(name, { until = ['idle', 'done'], timeoutMs = 300000, pollMs = 1000 } = {}) {
  const targets = (Array.isArray(until) ? until : [until]).map((s) => s.toLowerCase());
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  for (;;) {
    let state;
    try {
      state = agentState(agentRecord(name));
    } catch (e) {
      state = 'unknown';
    }
    last = state;
    if (targets.includes(state)) return { name, state, reached: true };
    if (Date.now() >= deadline) {
      throw new herdrMod.HerdrError(
        `wait 超时（${timeoutMs}ms）：agent ${name} 未到达 [${targets.join(', ')}]，当前 ${last}`
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
      state = agentState(agentRecord(entry.name));
    } catch (e) {
      state = 'gone';
    }
    return { ...entry, state };
  });
}

// kill：关一个 agent 的 tab（收资源）并清台账。killAll 关全部。
// 关键：只有确认关闭成功（或 tab/pane 本就不存在）才从台账删条目。关闭失败时保留
// 台账条目，让后续 kill --all 能重试回收——否则条目丢了、tab 却残留，资源永久泄漏
// 且无法二次回收（首版 bug）。
function kill(name) {
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
  return { name, closed: reclaimed && errors.length === 0, reclaimed, target, errors };
}

function killAll() {
  return ledger.all().map((entry) => {
    try {
      return kill(entry.name);
    } catch (e) {
      return { name: entry.name, closed: false, errors: [String(e.message || e)] };
    }
  });
}

module.exports = { spawn, prompt, read, wait, list, kill, killAll };
