'use strict';

// scene：核心 API 之上的薄批量编排帮手（docs/05 §4）。
// scene.json 声明起哪些 agent、各自初始 prompt、以及编排者要观察的信号。
// 工具负责 spawn→prompt→按声明收集；是否中继、如何基于输出决策由 scene 声明或调用者决定——
// herdr-live 不预设"中继/不中继"这类领域约束（那是消费者如 agent2agent 的选择）。
//
// scene.json 形态：
// {
//   "agents": [
//     { "name": "a", "kind": "cursor", "cwd": "/path",
//       "prompt": "短指令", "promptFile": "可选：整段 paste（小）",
//       "briefFile": "可选：长说明书落盘→短指针（首选大内容）",
//       "waitUntil": ["idle","done"], "timeoutMs": 300000 }
//   ],
//   "collect": [ { "agent": "a", "tail": 40 } ]   // 收集哪些 agent 的尾部输出
// }

const fs = require('fs');
const live = require('./live');

async function runScene(file) {
  const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
  const agents = Array.isArray(scene.agents) ? scene.agents : [];
  const spawned = [];
  const prompted = [];

  // 1. spawn 全部
  for (const a of agents) {
    spawned.push(live.spawn(a.name, { kind: a.kind, model: a.model, cwd: a.cwd, label: a.label }));
  }

  // 2. 派发初始 prompt（有声明的才发）
  for (const a of agents) {
    let text = a.prompt;
    if (a.promptFile) text = fs.readFileSync(a.promptFile, 'utf8');
    if (text == null && !a.briefFile) continue;
    const res = await live.prompt(a.name, text, {
      briefFile: a.briefFile,
      waitUntil: a.waitUntil,
      timeoutMs: a.timeoutMs,
      settleMs: a.settleMs,
      confirmStartMs: a.confirmStartMs,
      forcePaste: a.forcePaste,
    });
    prompted.push(res);
  }

  // 3. 按 collect 声明收集输出
  const collected = [];
  for (const c of scene.collect || []) {
    let output = null;
    let error = null;
    try {
      output = live.read(c.agent, { tail: c.tail });
    } catch (e) {
      error = String(e.message || e);
    }
    collected.push({ agent: c.agent, output, error });
  }

  return { spawned, prompted, collected };
}

module.exports = { runScene };
