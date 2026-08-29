#!/usr/bin/env node
'use strict';
// entrypoint: node orchestrator/daemon.js (--shadow | --dry-run) --once [--queue <dir>]
//                                          [--journal <dir>] [--deadline-ms <n>]
//                                          [--interval-ms <n>]
//
// --once   drains the whole queue serially (filename order) and exits.
// (absent) polls the queue directory forever, draining whatever has arrived, sleeping
//          --interval-ms between passes.
//
// One of --shadow or --dry-run is required:
//   --shadow    the only mode with scripted-step coverage today (see orchestrator/
//               steps/scripted.js -- real command execution is a documented stub). Never spawns
//               a subprocess, never calls the `claude` CLI, never touches anything outside
//               --queue/--journal.
//   --dry-run   real-mode semantics without spawning: step-contracts.js + prompt-template.js
//               resolve and fill every LLM step's real prompt, account rotation runs for real,
//               but steps/llm.js's runLlm and steps/scripted.js's runScripted both stop short of
//               their own spawn point -- an LLM step writes journal/<id>/dryrun-<STATE>.md
//               (the argv + filled prompt) and returns a canned outputContract-satisfying
//               payload; a scripted step returns a fixture-free "assumed success". Also never
//               calls the `claude` CLI. Ignored if --shadow is also given (shadow wins).

const fs = require('fs');
const path = require('path');

const defaultConfig = require('./config');
const { drainQueueOnce, runForever } = require('./state-machine');

function parseArgs(argv) {
  const opts = {
    shadow: false,
    dryRun: false,
    once: false,
    queue: null,
    journal: null,
    deadlineMs: null,
    intervalMs: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shadow') opts.shadow = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--queue') opts.queue = argv[++i];
    else if (a === '--journal') opts.journal = argv[++i];
    else if (a === '--deadline-ms') opts.deadlineMs = parseInt(argv[++i], 10);
    else if (a === '--interval-ms') opts.intervalMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printUsage() {
  console.log(
    [
      'usage: node orchestrator/daemon.js (--shadow | --dry-run) (--once | ) [--queue <dir>]',
      '                                    [--journal <dir>] [--deadline-ms <n>] [--interval-ms <n>]',
      '',
      '  --shadow          shadow mode: every scripted/LLM step reads task.shadow fixtures',
      '  --dry-run         real-mode semantics without spawning: real prompt fill + account',
      '                    rotation, but no `claude` CLI call and no scripted command run --',
      '                    see steps/llm.js / steps/scripted.js. Ignored if --shadow is given.',
      '  (one of --shadow or --dry-run is required)',
      '  --once            drain the queue serially and exit (default: poll forever)',
      '  --queue <dir>     task queue directory (default: <repo>/queue)',
      '  --journal <dir>   per-task runtime/journal root (default: <repo>/journal)',
      '  --deadline-ms <n> per-step wall-clock deadline in ms (default: 120000)',
      '  --interval-ms <n> poll interval in ms, only used without --once (default: 5000)',
    ].join('\n')
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }
  if (!opts.shadow && !opts.dryRun) {
    console.error('orchestrator/daemon.js: pass --shadow or --dry-run (see --help).');
    process.exitCode = 1;
    return;
  }

  const repoRoot = path.join(__dirname, '..');
  const queueDir = opts.queue || path.join(repoRoot, 'queue');
  const journalRoot = opts.journal || path.join(repoRoot, 'journal');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.mkdirSync(journalRoot, { recursive: true });

  const config = {
    ...defaultConfig,
    shadowMode: !!opts.shadow,
    dryRun: !opts.shadow && !!opts.dryRun,
    stepDeadlineMs: opts.deadlineMs || defaultConfig.stepDeadlineMs,
    pollIntervalMs: opts.intervalMs || defaultConfig.pollIntervalMs,
  };

  if (opts.once) {
    const results = await drainQueueOnce(queueDir, journalRoot, config);
    for (const r of results) console.log(`${r.id}  ${r.finalState}`);
  } else {
    await runForever(queueDir, journalRoot, config); // never resolves
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
