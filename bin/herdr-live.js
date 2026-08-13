#!/usr/bin/env node
'use strict';

// herdr-live CLI：通用多 agent live 编排。
// 动词：spawn / prompt / read / wait / list / kill [--all] / scene <file>
// 设计定位见 ~/charlie/agent2agent/docs/05-herdr-live-toolkit.md（工具属 ~/charlie/herdr-live）。

const live = require('../src/live');
const { runScene } = require('../src/scene');
const receiptMod = require('../src/receipt');
const doctorMod = require('../src/doctor');

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
      [--confirm-start-ms <n>] [--force-paste] [--submission-id <id>] [--receipt-path <path>]
      [--persist-receipt] [--transport-profile official-0.7.5|core-managed-enter]
      [--kind <kind>]
    # = live.submitPrompt（canonical transport + 结构化 fail-closed receipt）
    # target 可为台账名或 pane_id（如 w3:p16；无台账亦可）
    # 官方 0.7.5：prompt→settle→enter；core-managed-enter 禁止二次 Enter
    # 仅 transport_phase=not_sent 可自动重试；post-transport 不确定 → ambiguous
    # 默认 --confirm-start-ms 15000；Cursor Workspace Trust 在窗内自动按 a
    # 成功/失败均尽量打印 receipt JSON（stdout）；不声称 server 级 queue/write ack
    # 禁止用 raw「herdr agent prompt」当投喂——那只填充输入框、不提交
  herdr-live read <name> [--tail <N>]
  herdr-live wait <name> [--until <state>[,<state>]] [--timeout-ms <n>] [--poll-ms <n>]
    # Workspace Trust 仍在时不把 idle 当到达，窗内自动按一次 a
  herdr-live list
  herdr-live kill <name> | --all [--force]
    # 默认仅关闭 idle/done；working/blocked/unknown/gone 先保护，检查后才能 --force
  herdr-live doctor [--kind <k>] [--model <m>]
  herdr-live doctor --live --kind <cursor|claude|codex> [--model <m>]
      [--timeout-ms <n>] [--cwd <scratch>] [--confirm-start-ms <n>]
    # advisory：local_preflight vs live_probe 分开报告；PATH 成功 ≠ live 成功
    # 无 --live：零 spawn/远程/model 调用；live_probe.status=not_requested
    # 有 --live：精确 kind/model → spawn+submitPrompt 探针；须 lifecycle + 派生 marker
    # 仅清理本探针名（guarded kill，从不 auto-force / kill --all）；cleanup 单独报告
    # 公开 JSON 仅 digest（probe_token_digest/expected_marker_digest），无原始 token/marker
    # 非 promotion 门禁；marker 须为 baseline 同窗口单调后缀证明
  herdr-live scene <scene.json>

状态透传 herdr：idle / working / done / blocked。
Receipt phases：not_sent | prompt_filled | enter_sent | lifecycle_observed | ambiguous。
Doctor error_code（非穷尽）：unsupported_kind|unsupported_model|executable_unavailable|
  herdr_unavailable|spawn_failed|ambiguous_transport|timeout|lifecycle_without_token|
  stale_preexisting_token|stale_output_ambiguous|auth_or_api_failure|cleanup_failed|
  cleanup_guarded|live_probe_failed|kind_required_for_live|…`;

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
      try {
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
          submissionId: args['submission-id'] || undefined,
          receiptPath: args['receipt-path'] || undefined,
          persistReceipt: Boolean(args['persist-receipt']),
          forceProfile: args['transport-profile'] || undefined,
        });
        print(res);
        if (res.transport_phase && res.transport_phase !== 'lifecycle_observed' && !args['skip-confirm-start']) {
          // enter_sent without confirm is only OK with skip-confirm-start
          if (res.transport_phase !== 'enter_sent' || !args['skip-confirm-start']) {
            process.exitCode = res.transport_phase === 'not_sent' ? 3 : 2;
          }
        }
      } catch (e) {
        if (e && e.receipt) {
          print(e.receipt);
          const phase = e.receipt.transport_phase || e.transport_phase;
          process.exitCode = phase === 'not_sent' ? 3 : 2;
          process.stderr.write(`[herdr-live] ${e.message}\n`);
        } else {
          fail(e && e.message ? e.message : String(e));
        }
      }
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
        const res = live.killAll({ force: Boolean(args.force) });
        print(res);
        // guarded / close failure must be visible to shell callers (JSON alone is easy to miss).
        if (res.some((r) => !r.closed)) process.exitCode = 2;
      } else {
        const name = args._[0];
        if (!name) fail('kill 需要 <name> 或 --all');
        const res = live.kill(name, { force: Boolean(args.force) });
        print(res);
        if (!res.closed) process.exitCode = 2;
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
    case 'receipt-cleanup': {
      print(receiptMod.cleanupReceipts({
        maxAgeMs: args['max-age-ms'] != null ? Number(args['max-age-ms']) : undefined,
        maxFiles: args['max-files'] != null ? Number(args['max-files']) : undefined,
      }));
      break;
    }
    case 'doctor': {
      try {
        const res = await doctorMod.doctor({
          live: Boolean(args.live),
          kind: args.kind || undefined,
          model: args.model || undefined,
          timeoutMs: args['timeout-ms'] != null ? Number(args['timeout-ms']) : undefined,
          confirmStartMs: args['confirm-start-ms'] != null
            ? Number(args['confirm-start-ms'])
            : undefined,
          settleMs: args['settle-ms'] != null ? Number(args['settle-ms']) : undefined,
          cwd: args.cwd || undefined,
          forceProfile: args['transport-profile'] || undefined,
        });
        print(res);
        if (!res.ok) process.exitCode = 1;
      } catch (e) {
        fail(e && e.message ? e.message : String(e));
      }
      break;
    }
    default:
      fail(`未知动词：${verb}\n\n${USAGE}`);
  }
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
