'use strict';

// herdr-live 的五个核心动词：spawn / prompt / read / wait / kill。
// 每个动词把一段易错的 herdr 底层序列变成语义明确的调用，把踩过的坑固化进来：
//  - spawn：tab create 拿 pane_id/tab_id + agent start 按 kind 拼对 flags；缺 --model 时用 kind 默认；
//  - prompt / submitPrompt：agent prompt 后自动补 enter；短窗确认进入 working/done/blocked
//    （禁止假 submitted）；大内容用 briefFile→短指针，不整段塞输入框；
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 投喂后必须在此时间内离开「未开工」态，否则视为 prompt 未发出。 */
const DEFAULT_CONFIRM_START_MS = 10000;

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

  const createArgs = ['tab', 'create', '--cwd', workdir, '--no-focus', '--label', label || `live-${name}`];
  const payload = result(herdrMod.herdr(createArgs, { parseJson: true }));
  const paneId = deepId(payload, ['pane_id', 'id']);
  const tabId = deepId(payload, ['tab_id']);
  if (!paneId) throw new herdrMod.HerdrError('无法从 tab create 结果识别 pane_id');

  const flags = adapterFlags(kind, { model: resolvedModel, cwd: workdir });
  herdrMod.herdr(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--', ...flags]);

  let state = 'unknown';
  try {
    state = herdrMod.agentState(herdrMod.agentRecord(name));
  } catch (e) {
    // agent 刚起，list 可能还没收敛——状态留 unknown，不阻断 spawn。
  }

  const entry = ledger.put(name, {
    pane_id: paneId,
    tab_id: tabId,
    kind,
    model: resolvedModel,
    cwd: workdir,
  });
  return { ...entry, state };
}

/**
 * 投喂后确认 agent 已真正开工（离开「填充失败仍 idle」的假成功）。
 * herdrTarget 可以是台账名或 pane_id（herdr agent get/prompt 均接受）。
 * 命中 working|done|blocked 即视为发出；超时抛错——绝不返回 submitted:true。
 */
async function confirmStart(herdrTarget, { timeoutMs = DEFAULT_CONFIRM_START_MS, pollMs = 250 } = {}) {
  const ok = new Set(['working', 'done', 'blocked']);
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    last = currentState(herdrTarget);
    if (ok.has(last)) return { name: herdrTarget, state: last, confirmed: true };
    await sleep(pollMs);
  }
  throw new herdrMod.HerdrError(
    `prompt 未确认开工（${timeoutMs}ms 内未进入 working/done/blocked，当前 ${last}）。` +
      `常见原因：只调 herdr agent prompt 未 enter、或填充→enter 竞态（加大 --settle-ms / settleMs 或改用 --brief-file）；` +
      `不要把「仍 idle」当成已投喂成功。`
  );
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

/**
 * 库级完整投喂：prompt → settle → send-keys enter → 短窗确认 working|done|blocked。
 * **禁止**只填框不 enter；确认失败抛错（绝不返回假 submitted）。
 *
 * @param {object} opts
 * @param {string} opts.target  pane_id（如 w3:p16）或 herdr-live/herdr agent 名
 * @param {string} [opts.text]  整段 paste 正文
 * @param {string} [opts.file]  读文件再整段 paste（≠ briefFile）
 * @param {string} [opts.briefFile] 短指针投喂
 * @param {string} [opts.briefStyle] dispatch|answer
 * @param {number} [opts.settleMs]
 * @param {number} [opts.confirmStartMs]
 * @param {boolean} [opts.skipConfirmStart]
 * @param {boolean} [opts.forcePaste]
 * @param {string|string[]} [opts.waitUntil]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.kind]  pane_id 路径可显式给 kind（影响默认 settle）
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.asPaneId] 强制按 pane_id 解析
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
  } = opts;

  const resolved = resolveSubmitTarget(target, {
    kind: kindOpt,
    cwd: cwdOpt,
    asPaneId,
  });
  const { herdrTarget, kind, cwd } = resolved;

  let body = text;
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

  const settle =
    settleMs !== undefined && settleMs !== null
      ? Number(settleMs)
      : defaultSettleMs(kind);

  // 完整提交序列——与 CLI `herdr-live prompt` 同一实现；pane_id 亦走此路径。
  herdrMod.herdr(['agent', 'prompt', herdrTarget, body]);
  if (submitNeedsEnter(kind)) {
    if (settle > 0) await sleep(settle);
    herdrMod.herdr(['agent', 'send-keys', herdrTarget, 'enter']);
  }

  let state;
  if (!skipConfirmStart) {
    const conf = await confirmStart(herdrTarget, { timeoutMs: confirmStartMs });
    state = conf.state;
  } else {
    state = currentState(herdrTarget);
  }

  if (waitUntil) {
    return wait(herdrTarget, { until: waitUntil, timeoutMs });
  }
  return {
    name: resolved.name || herdrTarget,
    target: herdrTarget,
    pane_id: resolved.pane_id || null,
    via: resolved.via,
    submitted: true,
    confirmed: !skipConfirmStart,
    state,
    transport,
    settleMs: settle,
    promptBytes: Buffer.byteLength(String(body), 'utf8'),
  };
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
  for (;;) {
    last = currentState(name);
    if (targets.includes(last)) return { name, state: last, reached: true };
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
  confirmStart,
  assertPasteSize,
  DEFAULT_CONFIRM_START_MS,
};
