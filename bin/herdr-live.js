#!/usr/bin/env node
'use strict';

// herdr-live CLI：通用多 agent live 编排。
// 动词：spawn / prompt / read / wait / list / kill [--all] / scene <file>
// 设计定位见 ~/charlie/agent2agent/docs/05-herdr-live-toolkit.md（工具属 ~/charlie/herdr-live）。

const fs = require('fs');
const live = require('../src/live');
const { runScene } = require('../src/scene');

// 极简 flag 解析：--k v / --k=v / --flag（布尔）。位置参数进 _[]。
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[a.slice(2)] = true;
        } else {
          out[a.slice(2)] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(msg, code = 1) {
  process.stderr.write(`[herdr-live] ${msg}\n`);
  process.exit(code);
}

const USAGE = `herdr-live — 通用多 agent live 编排

用法:
  herdr-live spawn <name> --kind <cursor|claude|codex> [--model <m>] [--cwd <dir>] [--label <l>]
    # --model 可省略：用 kinds.js 与 herdr-orchestrator 对齐的 defaultModel
  herdr-live prompt <name> --text <t> | --file <path> | --brief-file <path>
      [--wait-until <state>] [--timeout-ms <n>] [--settle-ms <n>]
      [--confirm-start-ms <n>] [--force-paste]
    # --brief-file：短指针投喂（agent 自己 Read 文件）；大内容首选
    # --file/--text：整段 paste，软上限 ~2KB；超限请改 --brief-file 或 --force-paste
    # 成功返回前确认进入 working|done|blocked（禁止假 submitted + idle）
  herdr-live read <name> [--tail <N>]
  herdr-live wait <name> [--until <state>[,<state>]] [--timeout-ms <n>] [--poll-ms <n>]
  herdr-live list
  herdr-live kill <name> | --all
  herdr-live scene <scene.json>

状态透传 herdr：idle / working / done / blocked。`;

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }

  switch (verb) {
    case 'spawn': {
      const name = args._[0];
      if (!name) fail('spawn 需要 <name>');
      print(live.spawn(name, {
        kind: args.kind,
        model: args.model,
        cwd: args.cwd,
        label: args.label,
      }));
      break;
    }
    case 'prompt': {
      const name = args._[0];
      if (!name) fail('prompt 需要 <name>');
      let text = args.text;
      if (args.file) text = fs.readFileSync(args.file, 'utf8');
      if (text == null && !args['brief-file']) fail('prompt 需要 --text、--file 或 --brief-file');
      const res = await live.prompt(name, text, {
        briefFile: args['brief-file'] || undefined,
        waitUntil: args['wait-until'] ? String(args['wait-until']).split(',') : undefined,
        timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined,
        settleMs: args['settle-ms'] !== undefined ? Number(args['settle-ms']) : undefined,
        confirmStartMs: args['confirm-start-ms'] !== undefined
          ? Number(args['confirm-start-ms'])
          : undefined,
        forcePaste: Boolean(args['force-paste']),
        skipConfirmStart: Boolean(args['skip-confirm-start']),
      });
      print(res);
      break;
    }
    case 'read': {
      const name = args._[0];
      if (!name) fail('read 需要 <name>');
      const out = live.read(name, { tail: args.tail ? Number(args.tail) : undefined });
      process.stdout.write(out + '\n');
      break;
    }
    case 'wait': {
      const name = args._[0];
      if (!name) fail('wait 需要 <name>');
      const res = await live.wait(name, {
        until: args.until ? String(args.until).split(',') : undefined,
        timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined,
        pollMs: args['poll-ms'] ? Number(args['poll-ms']) : undefined,
      });
      print(res);
      break;
    }
    case 'list': {
      print(live.list());
      break;
    }
    case 'kill': {
      if (args.all) {
        print(live.killAll());
      } else {
        const name = args._[0];
        if (!name) fail('kill 需要 <name> 或 --all');
        print(live.kill(name));
      }
      break;
    }
    case 'scene': {
      const file = args._[0];
      if (!file) fail('scene 需要 <scene.json>');
      const res = await runScene(file);
      print(res);
      break;
    }
    default:
      fail(`未知动词：${verb}\n\n${USAGE}`);
  }
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
