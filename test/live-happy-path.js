#!/usr/bin/env node
'use strict';

// 真 agent happy-path 自测（docs/05 §6.2）：起一个 cursor agent → 喂"echo 到文件"prompt
// → wait 到 idle/done → read 结果 → kill 收资源。需真 herdr 环境（HERDR_ENV=1）。
//
// 手动跑：node test/live-happy-path.js
// 可选环境变量：HL_MODEL（默认 cursor-grok-4.5-high）、HL_KIND（默认 cursor）。
// 幂等：每次用固定 agent 名，结束 kill 清理；异常也在 finally 里兜底 kill。

const os = require('os');
const path = require('path');
const fs = require('fs');
const live = require('../src/live');

const KIND = process.env.HL_KIND || 'cursor';
const MODEL = process.env.HL_MODEL || 'cursor-grok-4.5-high';
const NAME = 'hl-selftest';

async function main() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-live-happy-'));
  const marker = path.join(workdir, 'hl-marker.txt');
  const token = 'HERDR_LIVE_OK_' + Buffer.from(workdir).toString('hex').slice(0, 8);

  console.log(`[happy] spawn ${NAME} kind=${KIND} model=${MODEL} cwd=${workdir}`);
  const spawned = live.spawn(NAME, { kind: KIND, model: MODEL, cwd: workdir });
  console.log('[happy] spawned:', JSON.stringify(spawned));

  try {
    // 等 agent 起来到可接 prompt（idle）。
    await live.wait(NAME, { until: ['idle', 'working', 'done'], timeoutMs: 120000 });

    const promptText = `请在当前目录执行 shell：将文本 ${token} 写入文件 hl-marker.txt（命令：echo ${token} > hl-marker.txt）。完成后简短回复 done。`;
    console.log('[happy] prompt + 等待完成…');
    await live.prompt(NAME, promptText, { waitUntil: ['idle', 'done'], timeoutMs: 300000 });

    // 给文件系统一点收敛时间，然后校验产物。
    let ok = false;
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes(token)) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    const tail = live.read(NAME, { tail: 30 });
    console.log('[happy] read tail:\n' + tail.split('\n').slice(-8).join('\n'));

    if (!ok) {
      console.error(`[happy] FAIL：未在 ${marker} 找到 token ${token}`);
      process.exitCode = 1;
    } else {
      console.log(`[happy] PASS：agent 写出了 marker 文件，token 匹配`);
    }
  } finally {
    // Teardown may run while agent is still working/blocked; explicit force is required.
    console.log('[happy] kill 收资源');
    try { console.log(JSON.stringify(live.kill(NAME, { force: true }))); } catch (e) { console.error(e.message); }
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error('[happy] 异常：', e.message); process.exitCode = 1; });
