#!/usr/bin/env node
'use strict';
// entrypoint: node orchestrator/daemon.js (--shadow | --dry-run | --real) --once [--queue <dir>]
//                                          [--journal <dir>] [--deadline-ms <n>]
//                                          [--interval-ms <n>]
//             node orchestrator/daemon.js (--shadow | --dry-run | --real) --worker <taskDir>
//                                          [--queue <dir>] [--journal <dir>]
//                                          [--deadline-ms <n>] [--workers <n>]
//             node orchestrator/daemon.js (--shadow | --dry-run | --real) --scanner
//                                          [--queue <dir>] [--journal <dir>]
//
// --once   drains the whole queue serially (filename order) and exits.
// (absent) continuous mode: acquires the single-instance lock and runs the K-worker dispatcher
//          (orchestrator/dispatcher.js) forever -- spawning `--worker` children off the queue,
//          and ALSO spawning and supervising exactly one `--scanner` child (below). Never itself
//          runs a scan or a task in-process.
// --scanner  action 6.3 (post-verification correction): runs the periodic real-mode scans
//          (orphan/unpark/auto-pull/report-intake -- state-machine.js's runForever) forever, in
//          THIS process, never the dispatcher's. Spawned and supervised by the dispatcher exactly
//          like a worker (detached process group, respawned on crash, its own crash-loop
//          breaker) -- see dispatcher.js's own header for the measurement that forced this split:
//          one of these scans (auto-triage, via intake.js's callIntakeStepWithRotation) makes a
//          BLOCKING `claude` spawnSync call measured at 3-3.5 minutes on the live daemon's own
//          journal, which would freeze worker-slot refills, timer service, and SIGTERM handling
//          for that whole window if it ran inside the dispatcher's own loop. Takes no lock (same
//          posture as --worker, and for the same reason: the dispatcher already holds it for the
//          whole journal root). Mutually exclusive with --once and --worker.
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
const productRepoHold = require('./product-repo-hold');
const { drainQueueOnce, runTask, runForever } = require('./state-machine');
const accounts = require('./accounts');
const { acquireLock, lockPath, LockHeldError, LockLostError, watchLock } = require('./lock');
const { appendDaemonEvent } = require('./journal');
const { orphanScan } = require('./orphan-scan');
const { createDispatcher } = require('./dispatcher');

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
    // Action 6.3: null means "not given" (config.js's own default -- SPO_WORKERS or 1 -- wins);
    // same convention parseInt already gives every other numeric flag here (a garbage or missing
    // value parses to NaN, which main()'s `Number.isInteger(...) && ... > 0` guard below rejects
    // in favour of the default, exactly like a bad SPO_WORKERS env var already does in config.js).
    workers: null,
    // Action 6.3 (post-verification): --scanner runs the scan half of continuous mode, in its
    // own process -- see this file's header. A plain boolean (no path argument, unlike --worker):
    // a scanner needs no per-invocation target, it always scans whatever --queue/--journal name.
    scanner: false,
    // Action 6.6 verification (Task 2): the dispatcher pid this scanner must not outlive. null
    // means "not given" -- a hand-run scanner never self-exits. See dispatcher.js's
    // buildScannerArgv and state-machine.js's runForever for the full reasoning.
    parentPid: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shadow') opts.shadow = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--real') opts.real = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--worker') opts.worker = argv[++i];
    else if (a === '--scanner') opts.scanner = true;
    else if (a === '--queue') opts.queue = argv[++i];
    else if (a === '--journal') opts.journal = argv[++i];
    else if (a === '--deadline-ms') opts.deadlineMs = parseInt(argv[++i], 10);
    else if (a === '--interval-ms') opts.intervalMs = parseInt(argv[++i], 10);
    else if (a === '--workers') opts.workers = parseInt(argv[++i], 10);
    else if (a === '--parent-pid') opts.parentPid = parseInt(argv[++i], 10);
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
      '                    Also honours --queue (action 4.4\'s transient re-enqueue writes there)',
      '                    and --workers (see that flag: it sets this worker\'s own',
      '                    WORKTREE/FINISH deadlines).',
      '  --parent-pid <n>  (with --scanner) the dispatcher pid this scanner must not outlive:',
      '                    the loop exits as soon as it is reparented away from it. Set by',
      '                    dispatcher.js; omit it to run a scanner by hand that never self-exits.',
      '  --scanner         run the periodic real-mode scans forever, in this process, never the',
      '                    dispatcher\'s (see file header). Spawned/supervised by the dispatcher.',
      '                    Mutually exclusive with --once and --worker. Takes no lock.',
      '  --queue <dir>     task queue directory (default: <repo>/queue)',
      '  --journal <dir>   per-task runtime/journal root (default: <repo>/journal)',
      '  --deadline-ms <n> per-step wall-clock deadline in ms (default: 120000)',
      '  --interval-ms <n> poll interval in ms, only used without --once (default: 5000)',
      '  --workers <n>     action 6.3: how many workers the dispatcher runs concurrently in',
      '                    continuous mode. Default 1 (config.js\'s workers / SPO_WORKERS),',
      '                    re-clamped to the number of healthy accounts before every spawn --',
      '                    see orchestrator/dispatcher.js. Ignored by --once, but NOT by',
      '                    --worker or --scanner: action 6.4 derives the WORKTREE/FINISH step',
      '                    deadlines from K (a worker must not time out on a legitimate',
      '                    product-repo lock wait) and 6.6 derives the auto-pull watermark from',
      '                    it (the scanner). Both are forwarded by dispatcher.js.',
    ].join('\n')
  );
}

// Action 6.1: reads <taskDir>/task.json and runs it through state-machine.js's runTask exactly
// once, returning the exit code main() should use -- see this file's header comment for the
// full table. Deliberately the ONLY thing a worker does: no takeNextTask (the dispatcher already
// moved the task into taskDir before spawning this process), no drainQueueOnce/runForever, no
// orphanScan, no periodic scans (unpark/auto-pull/report-intake/auto-triage) -- all of those run
// in the SCANNER process (`--scanner`, see this file's own header), never here and never in the
// dispatcher either: 6.3's post-verification correction moved them out of the dispatcher's own
// loop because auto-triage makes a BLOCKING 3-minute spawnSync that would freeze worker-slot
// refills and SIGTERM handling. A missing/unreadable/unparsable task.json is a usage error (2),
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

// ---- action 6.3 cross-action defect: a worker's crash used to leave NO record anywhere --------
//
// dispatcher.js spawns both children with `stdio: 'ignore'` (its spawnOne/spawnScanner), so
// anything this process writes to stderr is discarded by the kernel, not merely unread. runTask
// rethrows every non-ParkSignal error, main().catch below prints it with console.error and exits
// 1 -- and the dispatcher records only `{code: 1}`. MEASURED: a worker whose runTask threw a real
// TypeError exited 1 and left daemon.jsonl completely EMPTY, with only the 'taken' line in the
// task's own journal.jsonl. Nothing, anywhere, said what threw. Pre-6.3 that stack reached
// journald through the daemon's own stderr, so the crash-circuit-breaker could trip and stop the
// daemon with no record of the bug that caused it -- which makes C6's "a state-machine bug stays
// loud" only "loud that something happened".
//
// FIXED HERE, IN THE CHILD, rather than by capturing the child's stderr in the dispatcher. The
// child is the only process that has the error object at all: it can write ONE structured,
// bounded journal line, where a `stdio: 'pipe'` parent would have to spool an unbounded stderr
// stream (and a pipe nobody drains fast enough can block the child that writes it -- a worse
// failure than the one being fixed). The journal is this project's single source of truth
// anyway (Principle 5), so a crash belongs there, not only in an OS log.
//
// BOUNDED ON PURPOSE. An error message here is NOT small by nature: steps/llm.js JSON.parses up
// to 64 MiB of `claude` stdout, and a SyntaxError from that parse embeds a slice of the input in
// its own message. Writing that verbatim would put megabytes into daemon.jsonl on every crash --
// exactly the unbounded spool this fix exists to avoid. Both fields are hard-capped and marked
// `truncated: true` when they are cut, so a reader is never silently shown a partial message as
// if it were whole.
const CRASH_MESSAGE_CAP = 2000;
const CRASH_STACK_CAP = 4000;

// Set by main() as soon as the journal root and mode are known, read by main().catch below. A
// crash BEFORE this point (argv parsing, an unreadable pool) has no journal root to write to and
// still falls back to console.error alone, which is correct: those are hand-run/startup errors a
// dispatcher never sees, because a dispatcher-spawned child that fails this early exits 1 or 2
// before any journal exists to write into.
let crashContext = null;

function capped(text, cap) {
  const s = String(text === undefined || text === null ? '' : text);
  return s.length <= cap ? { text: s, truncated: false } : { text: s.slice(0, cap), truncated: true };
}

function journalUncaught(err) {
  if (!crashContext) return;
  const message = capped((err && err.message) || err, CRASH_MESSAGE_CAP);
  const stack = capped((err && err.stack) || '', CRASH_STACK_CAP);
  try {
    appendDaemonEvent(crashContext.journalRoot, 'uncaught-error', {
      mode: crashContext.mode,
      id: crashContext.id || null,
      taskDir: crashContext.taskDir || null,
      name: (err && err.name) || null,
      message: message.text,
      messageTruncated: message.truncated,
      stack: stack.text,
      stackTruncated: stack.truncated,
    });
  } catch {
    // A journal write that itself fails must never replace the original error with its own --
    // console.error below still runs and is the last resort.
  }
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

  // Action 6.3: --scanner is a third answer to "how do I not poll forever", alongside --once and
  // --worker -- mutually exclusive with both, same exit-2 usage-error posture as the --worker/
  // --once pair above (a bad argv combination the dispatcher itself should never produce, but a
  // human or a future caller building one by hand should be told plainly, not silently
  // reinterpreted).
  const scannerMode = opts.scanner === true;
  if (scannerMode && opts.once) {
    console.error('orchestrator/daemon.js: --scanner and --once are mutually exclusive (see --help).');
    process.exitCode = 2;
    return;
  }
  if (scannerMode && workerMode) {
    console.error('orchestrator/daemon.js: --scanner and --worker are mutually exclusive (see --help).');
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

  // Armed as early as the journal root exists, so ANY throw from here down lands in daemon.jsonl
  // -- see journalUncaught's own comment above for why the child, not the dispatcher, is the one
  // that has to record this.
  crashContext = {
    mode: workerMode ? 'worker' : scannerMode ? 'scanner' : 'dispatcher',
    journalRoot,
    taskDir: workerMode ? path.resolve(opts.worker) : null,
    id: workerMode ? path.basename(path.resolve(opts.worker)) : null,
  };

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
  //
  // Action 6.3: `dispatcherHandle` is the same deferred-capture pattern as `lock` above --
  // declared null here, assigned later (only in the non-once, non-worker, non-scanner branch,
  // once createDispatcher(...) actually exists), and read by this SAME exit hook via closure. On
  // any exit -- SIGINT/SIGTERM below, or the circuit-breaker return path further down this
  // function -- every live worker's AND the scanner's process group is signalled (killAllChildren)
  // BEFORE the lock is released, so a fresh daemon starting right after this one exits never races
  // a still-shutting-down predecessor's children for taskDir ownership or a second live scanner.
  // Killing is fire-and-forget here (an 'exit' handler must be synchronous, so this cannot wait
  // for the children to actually die) -- a worker that does not die before its own taskDir is next
  // examined is recovered exactly like any other crash: orphanScan on the next daemon start
  // (state.json non-terminal, owner pid dead). A scanner that does not die before the next start
  // simply becomes a second live one until it does -- harmless (it takes no lock, owns no taskDir)
  // but not free, so the signal is still sent rather than left to whichever exit path is slower.
  let lock = null;
  let dispatcherHandle = null;
  process.once('exit', () => {
    if (dispatcherHandle) dispatcherHandle.killAllChildren('SIGTERM');
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
  //
  // Action 6.3: --scanner joins --worker in never taking the lock, same reasoning -- the
  // dispatcher that spawns and supervises it already holds one for the whole journal root, and a
  // second lock-holder (the scanner itself) would be exactly the two-daemons-on-one-queue
  // collision this lock exists to prevent, not a legitimate second instance.
  if (!workerMode && !scannerMode) {
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

  // Action 6.3's own "bad override falls back to the default" posture, resolved ONCE here because
  // action 6.4's stepDeadlineMsByState entries below are derived from it too -- see there.
  const effectiveWorkers =
    Number.isInteger(opts.workers) && opts.workers > 0 ? opts.workers : defaultConfig.workers;

  const config = {
    ...defaultConfig,
    shadowMode: !!opts.shadow,
    dryRun: !opts.shadow && !!opts.dryRun,
    real: !opts.shadow && !opts.dryRun && !!opts.real,
    stepDeadlineMs: opts.deadlineMs || defaultConfig.stepDeadlineMs,
    pollIntervalMs: opts.intervalMs || defaultConfig.pollIntervalMs,
    // Action 6.3: same "bad override falls back to the default, never to something silently
    // wrong" posture config.js's own positiveIntFromEnv already applies to SPO_WORKERS -- a
    // missing/non-integer/non-positive --workers leaves defaultConfig.workers (env-resolved)
    // untouched rather than coercing to 0 or NaN.
    workers: effectiveWorkers,
    // Action 6.4: config.js derived these two from the ENV-time K (SPO_WORKERS, or 1). A
    // `--workers` flag changes K for THIS process, and both entries are functions of K -- so they
    // have to be recomputed here or they silently keep a ceiling sized for a smaller K. That is
    // not cosmetic: at K=2 the WORKTREE entry derived at K=1 (118 min) is SHORTER than the wait
    // plus work a worker can legitimately perform (232 min), which re-opens exactly the
    // abandon-the-loser clone-corruption path config.js's own stepDeadlineMsByState comment
    // documents. Recomputed from the SAME product-repo-hold.js formula, never a second literal.
    stepDeadlineMsByState: {
      ...defaultConfig.stepDeadlineMsByState,
      WORKTREE: productRepoHold.lockedStepDeadlineMs(
        defaultConfig.commandTimeoutsMs,
        effectiveWorkers,
        defaultConfig.stepDeadlineMs,
        productRepoHold.worstHoldMs(defaultConfig.commandTimeoutsMs)
      ),
      FINISH: productRepoHold.lockedStepDeadlineMs(
        defaultConfig.commandTimeoutsMs,
        effectiveWorkers,
        defaultConfig.stepDeadlineMs,
        productRepoHold.finishHoldMs(defaultConfig.commandTimeoutsMs)
      ),
    },
    queueDir,
    // Action 6.6 verification (Task 2): the dispatcher pid a `--scanner` child must not outlive.
    // Only ever set for a scanner (the dispatcher's own buildScannerArgv is the only caller that
    // passes --parent-pid); null everywhere else, which state-machine.js's runForever reads as
    // "no parent to watch, never self-exit". A non-integer or non-positive value falls back to
    // null for the same reason --workers does: a bad override must never become a different,
    // silently wrong pid to compare against.
    parentPid: Number.isInteger(opts.parentPid) && opts.parentPid > 0 ? opts.parentPid : null,
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
    // Action 6.3: a THIRD shape for --scanner -- `null`. A scanner never calls buildCtx to run a
    // task of its own (orphanScan's own per-orphan buildCtx call restores that CRASHED task's
    // owner from ITS OWN state.json, never from this config), so there is no identity this field
    // needs to carry -- and, unlike the non-worker branch below, there is no `lock.holder` to read
    // it from in the first place (the scanner never acquires one). buildCtx's own
    // `(config && config.owner) || null` fallback already treats a missing owner as "unknown,
    // never orphaned" for any ctx built off this config, which is exactly correct here.
    owner: workerMode
      ? { host: os.hostname(), workerPid: process.pid, workerStartedAt: new Date().toISOString() }
      : scannerMode
        ? null
        : { host: lock.holder.host, pid: lock.holder.pid, lockStartedAt: lock.holder.startedAt },
  };

  if (workerMode) {
    process.exitCode = await runWorker(opts.worker, config);
    return;
  }

  // Action 6.3: --scanner runs state-machine.js's runForever -- now JUST the scan loop (timers +
  // runScanCycle, no queue draining -- see that function's own header) -- forever, in this
  // process. Never resolves under normal operation; the dispatcher that spawned this process
  // stops it with a signal (see dispatcher.js's killAllChildren), at which point the SIGINT/
  // SIGTERM handlers registered above turn that into a clean process.exit(130/143) -- the
  // process.once('exit', ...) hook runs too, but both `lock` and `dispatcherHandle` are still
  // null here, so it is correctly a no-op. `return` below is therefore unreachable in practice,
  // kept only so this function has an honest final statement rather than an implicit
  // fall-through into the lock-watch/orphanScan/dispatcher code below, none of which a scanner
  // may touch (no lock to watch, and the dispatcher -- not the scanner -- is the one process that
  // does the startup orphanScan pass and drives continuous mode).
  if (scannerMode) {
    await runForever(queueDir, journalRoot, config);
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
    // Action 6.3: continuous mode is driven by the dispatcher (K-worker spawning + the scan
    // cycle serviced on its own schedule -- see dispatcher.js's own header), not
    // state-machine.js's runForever/drainQueueOnce. --once above and recette.js both still go
    // straight through drainQueueOnce, unaffected -- see CLAUDE.md's own instruction not to
    // touch either without checking every caller.
    const dispatcher = createDispatcher(queueDir, journalRoot, config);
    dispatcherHandle = dispatcher; // read by the exit hook registered above, via closure
    const stopReason = await dispatcher.run(); // resolves ONLY if the crash circuit breaker trips
    console.error(
      `orchestrator/daemon.js: dispatcher stopped itself -- ${JSON.stringify(stopReason)} -- ` +
        'exiting non-zero rather than repark-looping (see dispatcher.js\'s workerCrashLimit/scannerCrashLimit).'
    );
    process.exitCode = 1;
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
  // Journal FIRST, then print: the print goes to a stderr the dispatcher discards
  // (`stdio: 'ignore'`), so it is the journal line that actually survives -- see
  // journalUncaught's own comment. console.error is kept for a hand-run daemon, where stderr is
  // a terminal and is the fastest thing a maintainer reads.
  journalUncaught(err);
  console.error(err);
  process.exitCode = 1;
});
