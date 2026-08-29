#!/usr/bin/env node
'use strict';
// entrypoint: node orchestrator/daemon.js --shadow --once [--queue <dir>] [--journal <dir>]
//                                          [--deadline-ms <n>] [--interval-ms <n>]
//
// --once   drains the whole queue serially (filename order) and exits.
// (absent) polls the queue directory forever, draining whatever has arrived, sleeping
//          --interval-ms between passes.
//
// --shadow is required by this build: it is the only mode implemented (see orchestrator/
// steps/llm.js and orchestrator/steps/scripted.js -- real execution is a documented stub).
// This process never spawns a subprocess, never calls the `claude` CLI, and never touches
// anything outside --queue/--journal in shadow mode.

const fs = require('fs');
const path = require('path');

const defaultConfig = require('./config');
const { drainQueueOnce, runForever } = require('./state-machine');

function parseArgs(argv) {
  const opts = { shadow: false, once: false, queue: null, journal: null, deadlineMs: null, intervalMs: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shadow') opts.shadow = true;
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
      'usage: node orchestrator/daemon.js --shadow (--once | ) [--queue <dir>] [--journal <dir>]',
      '                                    [--deadline-ms <n>] [--interval-ms <n>]',
      '',
      '  --shadow          required: shadow mode is the only mode this build implements',
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
  if (!opts.shadow) {
    console.error('orchestrator/daemon.js: only --shadow mode is implemented in this build. Pass --shadow.');
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
    shadowMode: true,
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
