#!/usr/bin/env node
'use strict';

// herdr-live CLI：通用多 agent live 编排。
// 动词：spawn / prompt / read / wait / list / kill [--all] / scene <file>
// 设计定位见 ~/charlie/agent2agent/docs/05-herdr-live-toolkit.md（工具属 ~/charlie/herdr-live）。

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
  herdr-live prompt <name|pane_id> --text <t> | --file <path> | --brief-file <path>
      [--brief-style dispatch|answer] [--wait-until <state>] [--timeout-ms <n>] [--settle-ms <n>]
      [--confirm-start-ms <n>] [--force-paste]
    # = live.submitPrompt（完整提交：prompt→settle→enter→确认开工）
    # target 可为台账名或 pane_id（如 w3:p16；无台账亦可）
    # --brief-file：短指针投喂（agent 自己 Read 文件）；大内容首选
    # --brief-style answer：决策答复/续跑指针（禁止「请完整阅读并严格执行」腔）
    # --file/--text：整段 paste，软上限 ~2KB；超限请改 --brief-file 或 --force-paste
    # 成功返回前确认进入 working|done|blocked（禁止假 submitted + idle）
    # 禁止用 raw「herdr agent prompt」当投喂——那只填充输入框、不提交
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
      const target = args._[0];
      if (!target) fail('prompt 需要 <name|pane_id>');
      let text = args.text;
      // --file 交 submitPrompt 读盘，避免 CLI/库双份逻辑
      if (text == null && !args.file && !args['brief-file']) {
        fail('prompt 需要 --text、--file 或 --brief-file');
      }
      const res = await live.submitPrompt({
        target,
        text,
        file: args.file || undefined,
        briefFile: args['brief-file'] || undefined,
        briefStyle: args['brief-style'] || undefined,
        waitUntil: args['wait-until'] ? String(args['wait-until']).split(',') : undefined,
        timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined,
        settleMs: args['settle-ms'] !== undefined ? Number(args['settle-ms']) : undefined,
        confirmStartMs: args['confirm-start-ms'] !== undefined
          ? Number(args['confirm-start-ms'])
          : undefined,
        forcePaste: Boolean(args['force-paste']),
        skipConfirmStart: Boolean(args['skip-confirm-start']),
        kind: args.kind || undefined,
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
