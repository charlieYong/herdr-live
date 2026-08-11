#!/usr/bin/env node
'use strict';

// Verifier-oriented real scratch probe.
// Runs doctor --live against an isolated tmp cwd; does not mutate business/repo roots.
//
// Usage:
//   node test/doctor-live-scratch.js --kind cursor [--model cursor-grok-4.5-high]
//   HL_KIND=cursor HL_MODEL=cursor-grok-4.5-high node test/doctor-live-scratch.js
//
// Requires HERDR_ENV=1 and a working harness/model. Exit 0 only when doctor.ok.

const fs = require('fs');
const os = require('os');
const path = require('path');
const doctorMod = require('../src/doctor');

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind = args.kind || process.env.HL_KIND;
  const model = args.model || process.env.HL_MODEL || undefined;
  if (!kind) {
    process.stderr.write(
      'usage: node test/doctor-live-scratch.js --kind <cursor|claude|codex> [--model <m>]\n'
    );
    process.exit(2);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-live-doctor-scratch-'));
  process.stderr.write(`[doctor-scratch] kind=${kind} model=${model || '(default)'} cwd=${scratch}\n`);

  try {
    const report = await doctorMod.doctor({
      live: true,
      kind,
      model,
      cwd: scratch,
      timeoutMs: args['timeout-ms'] != null ? Number(args['timeout-ms']) : 180000,
      confirmStartMs: args['confirm-start-ms'] != null
        ? Number(args['confirm-start-ms'])
        : 20000,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => {
  process.stderr.write(`[doctor-scratch] ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
