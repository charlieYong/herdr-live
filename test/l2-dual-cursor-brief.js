#!/usr/bin/env node
'use strict';

// L2 实测验收：双端 cursor，只靠 kind 默认 model + --brief-file。
// 验证：无 --model spawn；大 brief 短指针投喂；开工确认非假 idle；产物落盘；kill 回收。
//
// 用法：node test/l2-dual-cursor-brief.js
// 前置：HERDR_ENV=1

const fs = require('fs');
const os = require('os');
const path = require('path');
const live = require('../src/live');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs', 'l2-dual-cursor-brief');
const A = 'hl-l2-cursor-a';
const B = 'hl-l2-cursor-b';

function padBrief(core, minBytes = 3600) {
  let body = core.trim() + '\n\n';
  let n = 0;
  while (Buffer.byteLength(body, 'utf8') < minBytes) {
    body += `# context-padding-${n}: this line exists only to exceed paste soft-limit and force brief-file transport.\n`;
    n += 1;
  }
  return body;
}

function writeBrief(dir, name, markerPath, token, role) {
  const briefPath = path.join(dir, `${name}-brief.md`);
  const core = `
# L2 dual-cursor brief (${role})

你是 herdr-live L2 验收里的 ${role}。

## 硬任务（必须全部完成）
1. 用 Read 工具完整阅读本文件（不要只看摘要）。
2. 在工作目录执行 shell，写入标记文件：
   \`echo ${token} > ${markerPath}\`
3. 再写一份短报告到同目录 \`report-${role}.json\`，JSON 对象字段：
   - "role": "${role}"
   - "token": "${token}"
   - "briefRead": true
   - "note": 一句说明你确实读了本 brief（可引用 padding 行数概念）
4. 完成后只回复一行：L2_${role.toUpperCase()}_DONE

## 禁止
- 不要向用户提问
- 不要修改本 brief 文件
- 不要依赖对话里粘贴的全文（若你只看到短指针，必须去读文件）
`.trim();
  fs.writeFileSync(briefPath, padBrief(core, 3600));
  return briefPath;
}

async function promptAndWait(name, briefPath) {
  const t0 = Date.now();
  // 先开工确认，再等终态（禁止一提交就把 idle 当 done）
  const prompted = await live.prompt(name, null, {
    briefFile: briefPath,
    confirmStartMs: 20000,
  });
  const confirmMs = Date.now() - t0;
  if (!prompted.confirmed) throw new Error(`${name} 未 confirmed`);
  if (!['working', 'done', 'blocked'].includes(prompted.state)) {
    throw new Error(`${name} 开工态异常：${prompted.state}`);
  }
  if (prompted.transport !== 'brief-pointer') {
    throw new Error(`${name} transport 应为 brief-pointer，got ${prompted.transport}`);
  }
  const finished = await live.wait(name, {
    until: ['idle', 'done'],
    timeoutMs: 300000,
  });
  return { prompted, confirmMs, finished };
}

async function main() {
  if (process.env.HERDR_ENV !== '1') {
    console.error('需要 HERDR_ENV=1（在 Herdr pane 内跑）');
    process.exit(2);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const workA = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-l2-a-'));
  const workB = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-l2-b-'));
  const tokenA = 'L2A_' + Date.now().toString(36);
  const tokenB = 'L2B_' + Date.now().toString(36);
  const markerA = path.join(workA, 'marker.txt');
  const markerB = path.join(workB, 'marker.txt');
  const briefA = writeBrief(workA, A, markerA, tokenA, 'alpha');
  const briefB = writeBrief(workB, B, markerB, tokenB, 'beta');

  const evidence = {
    startedAt: new Date().toISOString(),
    briefABytes: fs.statSync(briefA).size,
    briefBBytes: fs.statSync(briefB).size,
    workA,
    workB,
    tokenA,
    tokenB,
  };

  console.log('[l2] briefs', evidence.briefABytes, evidence.briefBBytes, 'bytes');
  console.log('[l2] spawn dual cursor (no --model)…');

  let pass = false;
  try {
    const spawnedA = live.spawn(A, { kind: 'cursor', cwd: workA, label: `l2-${A}` });
    const spawnedB = live.spawn(B, { kind: 'cursor', cwd: workB, label: `l2-${B}` });
    console.log('[l2] models', spawnedA.model, spawnedB.model);
    if (spawnedA.model !== 'cursor-grok-4.5-high' || spawnedB.model !== 'cursor-grok-4.5-high') {
      throw new Error(`默认 model 未生效：${spawnedA.model} / ${spawnedB.model}`);
    }

    await Promise.all([
      live.wait(A, { until: ['idle', 'working', 'done'], timeoutMs: 120000 }),
      live.wait(B, { until: ['idle', 'working', 'done'], timeoutMs: 120000 }),
    ]);

    console.log('[l2] parallel prompt --brief-file…');
    const [sideA, sideB] = await Promise.all([
      promptAndWait(A, briefA),
      promptAndWait(B, briefB),
    ]);

    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(markerA) && fs.existsSync(markerB)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const gotA = fs.existsSync(markerA) ? fs.readFileSync(markerA, 'utf8').trim() : null;
    const gotB = fs.existsSync(markerB) ? fs.readFileSync(markerB, 'utf8').trim() : null;
    const reportA = path.join(workA, 'report-alpha.json');
    const reportB = path.join(workB, 'report-beta.json');

    evidence.sideA = {
      model: spawnedA.model,
      transport: sideA.prompted.transport,
      startState: sideA.prompted.state,
      confirmMs: sideA.confirmMs,
      finish: sideA.finished.state,
      marker: gotA,
      reportExists: fs.existsSync(reportA),
      readTail: live.read(A, { tail: 20 }).split('\n').slice(-12).join('\n'),
    };
    evidence.sideB = {
      model: spawnedB.model,
      transport: sideB.prompted.transport,
      startState: sideB.prompted.state,
      confirmMs: sideB.confirmMs,
      finish: sideB.finished.state,
      marker: gotB,
      reportExists: fs.existsSync(reportB),
      readTail: live.read(B, { tail: 20 }).split('\n').slice(-12).join('\n'),
    };

    const checks = [
      ['A default model', evidence.sideA.model === 'cursor-grok-4.5-high'],
      ['B default model', evidence.sideB.model === 'cursor-grok-4.5-high'],
      ['A brief-pointer', evidence.sideA.transport === 'brief-pointer'],
      ['B brief-pointer', evidence.sideB.transport === 'brief-pointer'],
      ['A marker', gotA === tokenA],
      ['B marker', gotB === tokenB],
      ['A report', evidence.sideA.reportExists],
      ['B report', evidence.sideB.reportExists],
      ['briefs >2KB', evidence.briefABytes > 2048 && evidence.briefBBytes > 2048],
    ];
    evidence.checks = checks.map(([name, ok]) => ({ name, ok }));
    pass = checks.every(([, ok]) => ok);
    evidence.verdict = pass ? 'PASS' : 'FAIL';
  } catch (e) {
    evidence.verdict = 'FAIL';
    evidence.error = String(e && e.message ? e.message : e);
    console.error('[l2] error:', evidence.error);
  } finally {
    // Teardown must use force: default kill only allows idle/done and would leave orphans.
    const kills = [];
    for (const name of [A, B]) {
      try {
        kills.push(live.kill(name, { force: true }));
      } catch (e) {
        kills.push({ name, error: String(e.message || e) });
      }
    }
    evidence.kills = kills;
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(LOG_DIR, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('[l2] evidence →', path.join(LOG_DIR, 'evidence.json'));
    console.log('[l2]', evidence.verdict);
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
