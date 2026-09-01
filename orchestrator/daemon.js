#!/usr/bin/env node
'use strict';
// entrypoint: node orchestrator/daemon.js (--shadow | --dry-run | --real) --once [--queue <dir>]
//                                          [--journal <dir>] [--deadline-ms <n>]
//                                          [--interval-ms <n>]
//             node orchestrator/daemon.js (--shadow | --dry-run | --real) --worker <taskDir>
//                                          [--journal <dir>] [--deadline-ms <n>]
//
// --once   drains the whole queue serially (filename order) and exits.
// (absent) polls the queue directory forever, draining whatever has arrived, sleeping
//          --interval-ms between passes.
// --worker <taskDir>  action 6.1: runs the ONE task already sitting in <taskDir>/task.json
//          (runTask) to its terminal state and exits -- never takeNextTask, drainQueueOnce,
//          runForever, or orphanScan. This is the half of the K-worker design that can exist
//          before there is a dispatcher (action 6.3 adds that half: the process-group spawn,
//          the live-worker table, the crash repark, the circuit breaker). A worker does not
//          take the single-instance lock (lock.js's acquireLock) -- the dispatcher holds that,
//          once, for the whole journal root; K workers contending for it would defeat the
//          point of running K of them. Mutually exclusive with --once (both are "how do I not
//          poll forever", answered two different ways). Exit code is the dispatcher's ONLY
//          signal (it never re-reads state.json to tell a crash from a park):
//            0  the task reached DONE
//            20 the task reached PARKED -- an ordinary outcome, not a crash
//            2  usage error (no path, unreadable taskDir/task.json)
//            75 LockLostError propagated (kept for symmetry with the non-worker catch-all
//               below; unreachable in practice since a worker never wires config.lockLost)
//            130/143 killed by SIGINT/SIGTERM -- NOT a code runWorker returns, but reachable and
//               routine, so 6.3 must handle it rather than be surprised by it. The SIGINT/SIGTERM
//               handlers registered below apply to a worker exactly as they do to a daemon, and
//               the post-merge deploy hook SIGTERMs this tree on every merge. Measured, not
//               inferred: SIGTERM to a `--worker` mid-IMPLEMENT exits 143 and leaves state.json
//               at IMPLEMENT with this worker's own owner stamped on it -- which is precisely
//               what orphanScan recovers on the next --real start, so the card is not lost.
//            1  anything else -- an uncaught error; this is what 6.3 reads as "crashed, repark".
//               6.3's classifier must therefore be "0/20/2/75 by name, EVERYTHING else = crashed"
//               and not "1 = crashed", or a deploy-time SIGTERM (143) falls through it unhandled.
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
const os = require('os');
const path = require('path');

const defaultConfig = require('./config');
const { drainQueueOnce, runForever, runTask } = require('./state-machine');
const accounts = require('./accounts');
const { acquireLock, lockPath, LockHeldError, LockLostError, watchLock } = require('./lock');
const { appendDaemonEvent } = require('./journal');
const { orphanScan } = require('./orphan-scan');

function parseArgs(argv) {
  const opts = {
    shadow: false,
    dryRun: false,
    real: false,
    once: false,
    // null = --worker not given at all; '' / undefined (falsy, but not null) = given with no
    // path following it -- main() tells the two apart to print the right usage error.
    worker: null,
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
    else if (a === '--worker') opts.worker = argv[++i];
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
      '  --worker <dir>    run the ONE task in <dir>/task.json and exit (see file header for the',
      '                    exit-code contract). Mutually exclusive with --once. Takes no lock.',
      '  --queue <dir>     task queue directory (default: <repo>/queue)',
      '  --journal <dir>   per-task runtime/journal root (default: <repo>/journal)',
      '  --deadline-ms <n> per-step wall-clock deadline in ms (default: 120000)',
      '  --interval-ms <n> poll interval in ms, only used without --once (default: 5000)',
    ].join('\n')
  );
}

// Action 6.1: reads <taskDir>/task.json and runs it through state-machine.js's runTask exactly
// once, returning the exit code main() should use -- see this file's header comment for the
// full table. Deliberately the ONLY thing a worker does: no takeNextTask (the dispatcher already
// moved the task into taskDir before spawning this process), no drainQueueOnce/runForever, no
// orphanScan, no periodic scans (unpark/auto-pull/report-intake/auto-triage) -- all of those stay
// dispatcher-side (action 6.3). A missing/unreadable/unparsable task.json is a usage error (2),
// not a crash (1): the dispatcher handed this process a bad path, which is its own bug to fix,
// not this task's to be reparked over.
async function runWorker(taskDirArg, config) {
  const taskDir = path.resolve(taskDirArg);
  const taskPath = path.join(taskDir, 'task.json');
  let raw;
  try {
    raw = fs.readFileSync(taskPath, 'utf8');
  } catch (err) {
    console.error(`orchestrator/daemon.js: --worker cannot read ${taskPath}: ${err.message}`);
    return 2;
  }
  let task;
  try {
    task = JSON.parse(raw);
  } catch (err) {
    console.error(`orchestrator/daemon.js: --worker cannot parse ${taskPath}: ${err.message}`);
    return 2;
  }
  // Same id-derivation rule as takeNextTask (state-machine.js): task.id when the payload carries
  // one, else the directory's own basename. A worker never sees a raw queue FILENAME (the
  // dispatcher already renamed it into taskDir/task.json), so basename(taskDir) is the right
  // fallback, not basename(some .json file).
  const id = task && task.id ? String(task.id) : path.basename(taskDir);
  const finalState = await runTask(id, task, taskDir, config);
  // runTask's own while-loop only ever exits on 'DONE' or 'PARKED' (see its header comment) --
  // anything else here would mean that contract broke, which is itself a bug worth surfacing
  // loudly (exit 1, via the thrown Error below and main()'s catch-all) rather than silently
  // mapped to one of the two codes below and mistaken for a normal outcome.
  if (finalState === 'DONE') return 0;
  if (finalState === 'PARKED') return 20; // an expected outcome, never conflated with a crash
  throw new Error(`orchestrator/daemon.js: --worker: runTask returned unexpected state ${finalState}`);
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

  // Action 6.1: --worker is a different answer to "how do I not poll forever" than --once (one
  // task vs. the whole queue), so the two together are a usage error, not a precedence rule to
  // resolve silently -- exit 2, not 1, per this file's own header table: 6.3's dispatcher must
  // be able to tell "I built a bad argv" (2) apart from "the daemon refused to start" (1) apart
  // from "the task crashed" (1, but from runWorker, not here).
  const workerMode = opts.worker !== null;
  if (workerMode && opts.once) {
    console.error('orchestrator/daemon.js: --worker and --once are mutually exclusive (see --help).');
    process.exitCode = 2;
    return;
  }
  if (workerMode && !opts.worker) {
    console.error('orchestrator/daemon.js: --worker requires a <taskDir> path (see --help).');
    process.exitCode = 2;
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

    // Every account directory is its own CLAUDE_CONFIG_DIR, so it is also its own user-settings
    // tier -- an unsynced account runs steps with no permission rules of its own. Re-apply the
    // repo's reviewed policy on every --real start so an account added or restored between runs
    // cannot silently run under a different one. Best-effort: a failure here is a warning, not a
    // reason to refuse to start, since project-tier rules still cover today's step cwds.
    try {
      const source = path.join(__dirname, '..', '.claude', 'settings.json');
      const settingsText = accounts.stampManagedSettings(
        fs.readFileSync(source, 'utf8'),
        '<repo>/.claude/settings.json'
      );
      const synced = accounts.syncSettings(defaultConfig.claudeAccountsDir, settingsText);
      const changed = synced.filter((r) => r.action !== 'unchanged');
      if (changed.length > 0) {
        console.log(
          `orchestrator/daemon.js: account permission policy synced -- ${changed
            .map((r) => `${r.name} (${r.action})`)
            .join(', ')}`
        );
      }
    } catch (err) {
      console.error(`orchestrator/daemon.js: warning -- account permission sync failed: ${err.message}`);
    }
  }

  const repoRoot = path.join(__dirname, '..');
  const queueDir = opts.queue || path.join(repoRoot, 'queue');
  const journalRoot = opts.journal || path.join(repoRoot, 'journal');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.mkdirSync(journalRoot, { recursive: true });

  // Single-instance lock, scoped to this journal root (orchestrator/lock.js) -- the same
  // refuse-to-start posture as the account-pool guard above: two daemons on one queue is a
  // startup config error to surface here, not a per-task ENOENT crash to debug later. The
  // suite's temp-dir daemons each lock their own journal root, so they never contend.
  // Release on every exit path. SIGINT/SIGTERM need explicit handlers because the default
  // signal death skips 'exit' handlers entirely -- process.exit() here makes them run.
  //
  // Registered BEFORE acquireLock, not after, and that ordering is the whole point. Until a JS
  // handler for a signal exists, Node applies the OS DEFAULT disposition: SIGTERM terminates the
  // process immediately, mid-statement, running no 'exit' hooks at all. Registering one changes
  // the rule to "queue the signal, run the handler at the next event-loop turn" -- which makes
  // every synchronous statement below, acquireLock's own link() included, uninterruptible.
  //
  // Before this, a SIGTERM landing between link()ing the lock file into place and installing
  // these handlers killed the daemon and left its lock file behind for the next start to
  // stale-sweep. The post-merge hook SIGTERMs this daemon on every deploy, so that window is a
  // real production race, not a theoretical one; it is microseconds wide on an idle box and was
  // measured firing ~2 runs in 44 under a 4x-parallel suite. That is what test/lock.test.js's
  // SIGTERM case had been catching intermittently all along -- project 2's #480 filed it as a
  // timing-budget flake in the test, and it was not: it was this.
  //
  // `lock` is captured by the exit hook rather than passed to it, so the hook is registered
  // before there is anything to release and still releases whatever acquireLock assigns.
  let lock = null;
  process.once('exit', () => {
    if (lock) lock.release();
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => process.exit(sig === 'SIGINT' ? 130 : 143));
  }

  // Action 6.1: a worker never takes the single-instance lock. The dispatcher (action 6.3) holds
  // it once, for the whole journal root, for as long as it runs; K workers each trying to
  // acquire it too would either serialize them (defeating the entire point of running K) or
  // have K-1 of them refuse to start with LockHeldError. Skipping acquireLock means skipping
  // everything that exists only to service it: watchLock (nothing to watch), config.lockLost /
  // config.lockLostHolder (runTask's cooperative check below is simply a no-op without them --
  // see state-machine.js's own `if (config.lockLost && config.lockLost())`), and the
  // 'lock-stale-taken' daemon event (nothing was taken over). `lock` stays null, so the
  // process.once('exit', ...) release hook registered above is already correctly a no-op.
  if (!workerMode) {
    try {
      lock = acquireLock(journalRoot, opts.shadow ? 'shadow' : opts.dryRun ? 'dry-run' : 'real');
    } catch (err) {
      if (err instanceof LockHeldError) {
        console.error(`orchestrator/daemon.js: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    if (lock.stale) {
      appendDaemonEvent(journalRoot, 'lock-stale-taken', { stale: lock.stale });
    }
  }

  const config = {
    ...defaultConfig,
    shadowMode: !!opts.shadow,
    dryRun: !opts.shadow && !!opts.dryRun,
    real: !opts.shadow && !opts.dryRun && !!opts.real,
    stepDeadlineMs: opts.deadlineMs || defaultConfig.stepDeadlineMs,
    pollIntervalMs: opts.intervalMs || defaultConfig.pollIntervalMs,
    queueDir,
    // Every state.json snapshot this run writes carries this back (state-machine.js's
    // buildCtx/snapshot) -- orphan-scan.js's only way, after a restart, to tell "the process
    // that wrote this is still alive" from "it died mid-task".
    //
    // Two shapes, by mode. Non-worker (today's): {host, pid, lockStartedAt} -- pid/startedAt are
    // the lock holder's own (lock.js's payload), because the lock-holding daemon process IS the
    // owner. Worker mode (action 6.1): {host, workerPid, workerStartedAt} -- there is no lock
    // holder to borrow identity from, so the worker stamps its own pid and its own boot time.
    // workerStartedAt plays the exact role lockStartedAt already plays: disambiguating a REUSED
    // pid across successive worker processes (a dispatcher spawns many, back to back, against
    // the same journal root). orphan-scan.js reads BOTH shapes (`owner.workerPid ?? owner.pid`)
    // -- this is measured, not theoretical: `jq -c '.owner' journal/*/state.json` against the
    // live journal root (2026-09-01) shows 7 distinct owners still in the old shape, and the
    // post-merge hook SIGTERMs the daemon on every deploy, which leaves whichever shape was
    // current at the moment of death sitting in state.json until the next restart's orphanScan
    // recovers it. If that scan stopped recognising the old shape, every one of those tasks
    // would be invisible forever.
    owner: workerMode
      ? { host: os.hostname(), workerPid: process.pid, workerStartedAt: new Date().toISOString() }
      : { host: lock.holder.host, pid: lock.holder.pid, lockStartedAt: lock.holder.startedAt },
  };

  if (workerMode) {
    process.exitCode = await runWorker(opts.worker, config);
    return;
  }

  // Periodic lock re-verification (lock.js's watchLock) -- acquireLock only ever checks liveness
  // once, at startup; this is the ongoing check for a live daemon that had its lock taken over
  // (another process started against the same journal root, or won a stale-sweep race against
  // this one). config.lockLost/lockLostHolder are the flags runTask's cooperative check
  // (state-machine.js) polls between states; onLost fires at most once and stops the timer, so
  // there is exactly one exit attempt, never a storm of them.
  let lockLost = false;
  let lockLostHolder = null;
  config.lockLost = () => lockLost;
  config.lockLostHolder = () => lockLostHolder;
  const lockWatch = watchLock(lock, {
    intervalMs: config.lockWatchMs,
    onLost: (reason, holder) => {
      lockLost = true;
      lockLostHolder = holder;
      appendDaemonEvent(journalRoot, 'lock-lost', { reason, holder, ours: lock.holder });
      console.error(
        `orchestrator/daemon.js: lock ${lockPath(journalRoot)} was taken over by another process (${reason}) -- stopping.`
      );
      // 75 = EX_TEMPFAIL: a transient condition, not a program error -- systemd's Restart=always
      // brings this unit back, and the new start either resolves cleanly (the takeover was
      // itself a legitimate restart racing this one) or refuses normally against the winner's
      // live lock (LockHeldError above). Never disguised as a park (see LockLostError's own
      // doctrine comment) -- this process may no longer be the legitimate writer of PARKED
      // state.json/report.md/board-move/gh-comment.
      process.exitCode = 75;
      process.exit(75);
    },
  });
  process.once('exit', lockWatch.stop);

  // Unconditional, every start, every mode: a task this journal root's PREVIOUS daemon left
  // mid-run when it died is otherwise invisible forever (not in queue/, not PARKED) -- this is
  // the case that actually matters (crash -> systemd restart); runForever's own periodic scan
  // below is the belt-and-suspenders for a daemon that keeps running but loses track of a task
  // some other way. Cheap even when nothing is orphaned: one readdir + a few small JSON reads.
  //
  // The call is unconditional, but what it DOES is mode-gated inside orphan-scan.js itself
  // (isRealMode(ctx), the same test every other real side effect in this codebase gates on):
  // --real reparks for real, exactly as before this fix. --shadow/--dry-run only ever detect the
  // orphan and journal an 'orphan-scan-would-repark' daemon.jsonl line -- never a state.json/
  // report.md write, gh comment, or board move. Before this, a --shadow/--dry-run start against
  // the LIVE journal root silently turned a real, recoverable orphan into a terminal park with no
  // board move, no gh comment and no unpark anchor: invisible to the maintainer and to
  // unparkScan.js forever. See orphan-scan.js's own header for the read-only path's rationale.
  const recoveredOrphans = await orphanScan(queueDir, journalRoot, config);
  for (const r of recoveredOrphans) {
    if (r.wouldRepark) {
      console.error(
        `orchestrator/daemon.js: ${opts.shadow ? 'shadow' : 'dry-run'} mode -- would have recovered orphaned task ${r.id} (${r.reason}); no park written (see daemon.jsonl: orphan-scan-would-repark)`
      );
    } else {
      console.error(`orchestrator/daemon.js: recovered orphaned task ${r.id} (${r.reason})`);
    }
  }

  if (opts.once) {
    const results = await drainQueueOnce(queueDir, journalRoot, config);
    for (const r of results) console.log(`${r.id}  ${r.finalState}`);
  } else {
    await runForever(queueDir, journalRoot, config); // never resolves
  }
}

main().catch((err) => {
  if (err instanceof LockLostError) {
    // Already logged (and exited 75) by watchLock's onLost handler above -- this only catches
    // the case where the LockLostError propagated up through runTask/runForever/drainQueueOnce
    // before that handler's own process.exit(75) landed. One line, no stack: this is an expected
    // shutdown path, not a crash.
    console.error(`orchestrator/daemon.js: ${err.message}`);
    process.exitCode = 75;
    return;
  }
  console.error(err);
  process.exitCode = 1;
});
