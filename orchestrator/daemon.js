#!/usr/bin/env node
'use strict';
// entrypoint: node orchestrator/daemon.js (--shadow | --dry-run | --real) --once [--queue <dir>]
//                                          [--journal <dir>] [--deadline-ms <n>]
//                                          [--interval-ms <n>]
//
// --once   drains the whole queue serially (filename order) and exits.
// (absent) polls the queue directory forever, draining whatever has arrived, sleeping
//          --interval-ms between passes.
//
// One of --shadow, --dry-run or --real is required:
//   --shadow    every scripted/LLM step reads task.shadow fixtures. Never spawns a subprocess,
//               never calls the `claude` CLI, never touches anything outside --queue/--journal.
//   --dry-run   real-mode semantics without spawning: step-contracts.js + prompt-template.js
//               resolve and fill every LLM step's real prompt, account rotation runs for real,
//               but steps/llm.js's runLlm and steps/scripted.js's runScripted/real* functions all
//               stop short of their own spawn point -- an LLM step writes
//               journal/<id>/dryrun-<STATE>.md (the argv + filled prompt) and returns a canned
//               outputContract-satisfying payload; a scripted step returns a fixture-free
//               "assumed success". Also never calls the `claude` CLI. Ignored if --shadow is
//               also given (shadow wins).
//   --real      the only mode that actually spawns real git/npm/gh commands (steps/scripted.js's
//               realWorktree/realCheck/realPushPr/realGate/realCiChecks/realMerge/realFinish)
//               against the product repo (config.productRepo) and calls the real `claude` CLI.
//               Required for any kind: "card" task to leave INTAKE once neither --shadow nor
//               --dry-run applies -- see state-machine.js's handleIntake, which parks a card
//               task with reason "real-flag-required" if this flag is missing, as a second,
//               defense-in-depth check independent of this CLI guard. Mutually exclusive with
//               --shadow (refused below); if --dry-run is also given, --dry-run wins (same
//               precedence as --shadow winning over --dry-run) -- see orchestrator/README.md
//               "Real scripted steps".

const fs = require('fs');
const path = require('path');

const defaultConfig = require('./config');
const { drainQueueOnce, runForever } = require('./state-machine');
const accounts = require('./accounts');

function parseArgs(argv) {
  const opts = {
    shadow: false,
    dryRun: false,
    real: false,
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
    else if (a === '--real') opts.real = true;
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
      'usage: node orchestrator/daemon.js (--shadow | --dry-run | --real) (--once | ) [--queue <dir>]',
      '                                    [--journal <dir>] [--deadline-ms <n>] [--interval-ms <n>]',
      '',
      '  --shadow          shadow mode: every scripted/LLM step reads task.shadow fixtures',
      '  --dry-run         real-mode semantics without spawning: real prompt fill + account',
      '                    rotation, but no `claude` CLI call and no scripted command run --',
      '                    see steps/llm.js / steps/scripted.js. Ignored if --shadow is given.',
      '  --real            actually spawns git/npm/gh commands and the `claude` CLI. Required',
      '                    for any kind: "card" task (refused otherwise -- see handleIntake\'s',
      '                    "real-flag-required" park). Mutually exclusive with --shadow; if',
      '                    --dry-run is also given, --dry-run wins. Refuses to start if the',
      '                    account pool (config.claudeAccountsDir) has no accounts registered',
      '                    -- see doc/setup.md § Accounts / `spo account add <name>`.',
      '  (one of --shadow, --dry-run or --real is required)',
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
  if (!opts.shadow && !opts.dryRun && !opts.real) {
    console.error('orchestrator/daemon.js: pass --shadow, --dry-run or --real (see --help).');
    process.exitCode = 1;
    return;
  }
  if (opts.real && opts.shadow) {
    console.error('orchestrator/daemon.js: --real and --shadow are mutually exclusive (see --help).');
    process.exitCode = 1;
    return;
  }

  // --real is the one mode that actually calls the `claude` CLI (steps/llm.js's account-
  // rotation loop) -- refuse to even start if the pool has nothing registered, rather than let
  // every task park one at a time on the same NoAccountsRegisteredError. See doc/setup.md
  // § Accounts for how to add the first one (`spo account add <name>`).
  if (opts.real) {
    const registry = accounts.readRegistry(defaultConfig.claudeAccountsDir);
    if (registry.length === 0) {
      console.error(
        `orchestrator/daemon.js: --real requires at least one registered account in ${defaultConfig.claudeAccountsDir} (see doc/setup.md § Accounts, or run \`spo account add <name>\`).`
      );
      process.exitCode = 1;
      return;
    }
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
    real: !opts.shadow && !opts.dryRun && !!opts.real,
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
