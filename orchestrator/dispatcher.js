'use strict';
// dispatcher.js -- action 6.3: the K-worker main loop.
//
// Takes up to K tasks off the queue, spawns one `node orchestrator/daemon.js --worker <taskDir>
// (--shadow|--dry-run|--real)` child process PER task (plain async child_process.spawn, no
// generalized wrapper -- the plan's own words), awaits their exits, and reacts: 0 (DONE) and 20
// (PARKED) are ordinary outcomes -- see daemon.js's own --worker header for the full exit-code
// table -- that free the slot and reset the crash-circuit-breaker; anything else is a crash this
// module reparks itself, through the SAME buildCtx/finalizePark machinery orphan-scan.js already
// uses for the analogous "a process died mid-task" recovery (see that module's own header).
//
// K DEFAULTS TO 1 (config.workers / SPO_WORKERS -- see config.js's own comment). At K=1 this
// module still spawns a worker process for every task: one code path, not a serial in-process
// fast path plus a parallel one that has to be kept in sync with it -- see
// doc/remediation-progress.md's C6 decision record for why the plan itself calls this out.
//
// THE SINGLE-INSTANCE LOCK STAYS WITH THE CALLER (daemon.js), not this module -- a worker
// (`--worker` mode, action 6.1) never calls acquireLock at all, and neither does this file; K
// workers each trying to take it would either serialize them (defeating the entire point of
// running K) or leave K-1 refusing to start with LockHeldError. daemon.js acquires the lock,
// builds `config`, and only then calls createDispatcher(...).run() -- see that file's own
// integration.
//
// K IS RE-CLAMPED TO accounts.countHealthyAccounts(...) IMMEDIATELY BEFORE EVERY SPAWN, not once
// per loop iteration and not once at startup -- an account can cool down mid-cycle (one of THIS
// dispatcher's own workers just hit a limit) and the very next spawn decision must see the
// smaller number, not a value cached from before that cooldown landed.
//
// SCANS DO NOT RUN IN THIS PROCESS AT ALL (post-verification correction to this action's own
// original design). The first cut ran state-machine.js's runScanCycle straight from this file's
// own loop, reasoning that bounding each iteration by `Promise.race(nextWorkerExit,
// sleep(pollIntervalMs))` -- instead of runForever's `await drainQueueOnce` -- was enough to stop
// the scans starving worker-slot refills and SIGTERM handling. Verification found that reasoning
// wrong: one of those scans (auto-triage, via intake.js's callIntakeStepWithRotation) makes a
// BLOCKING `spawnSync('claude', ...)` call -- measured at 3m24.9s and 3m11.5s on the live
// daemon's own journal (issues #471/#473) -- and `Promise.race` cannot rescue a single-threaded
// process from a call that blocks the thread itself for that long: this loop simply would not
// get to iterate again, at all, for the duration of that ONE call, no matter what it races. A/B
// against a real blocking child measured the consequence directly: reaping lag 2608ms vs 7ms, a
// 100ms timer firing once in 9 seconds. Three minutes of that means no worker slot refills, no
// SIGTERM response, and -- since systemd's TimeoutStopUSec is 90s -- a deploy SIGKILLs the whole
// process before `killAllChildren` below ever runs.
//
// The obvious-looking alternative fix (spawn a fresh child per scan CYCLE instead of a long-lived
// one) is ALSO wrong, and is recorded here as a trap: comment-scan.js's own header says its
// `createScanState()` (the collaborator-login cache and the per-issue backoff table) has to
// survive ACROSS cycles to do anything -- "a cache that resets every cycle is not a cache; a
// backoff that resets every cycle never backs off". A fresh process per cycle would zero both,
// every single cycle, defeating the entire reason action 2.7 built them.
//
// So: the scans run in their own SEPARATE, LONG-LIVED process -- `daemon.js --scanner`,
// state-machine.js's runForever (now just "timers + runScanCycle", queue-draining removed -- see
// that function's own header) -- spawned and supervised by this module exactly like a worker:
// same `detached: true` process-group spawn, same watchChild exit-Promise plumbing, tracked in
// `pending` so this loop's own Promise.race wakes on its exit too. Unlike a worker, a scanner that
// exits is NEVER an ordinary outcome (runForever's `for(;;)` never returns on its own) -- so any
// exit not caused by this dispatcher's own shutdown is a crash, and gets RESPAWNED, immediately,
// up to its own crash-loop breaker (see `scannerCrashLimit` below). A scanner that dies and stays
// dead silently kills the maintainer's whole retry/abandon channel -- measured once already, for
// 33 hours, 238 consecutive scan failures nobody noticed, before action 2.7 existed at all.
//
// THE LIVE-WORKER TABLE (`live`, below) is the "not owned by a live worker" half of the taskDir
// single-writer invariant journal.js's own header states in full (including its one pre-existing
// exception, the C5 reconciler, and the cross-process staleness reasoning this correction added).
// It now answers two separate questions in two separate ways:
//   1. takeNextTask must never start a queue file whose id matches a task a live worker already
//      owns (state-machine.js's own `liveIds` parameter, threaded through from fillSlots below) --
//      otherwise this module would rename a fresh queue entry straight over the live worker's own
//      taskDir/task.json mid-run. Answered IN-MEMORY, in this same process, no staleness question
//      at all -- fillSlots and takeNextTask both run here, serially.
//   2. orphanScan (running in the SEPARATE scanner process) must never repark a task this table
//      still lists -- the instant a worker process exits, its pid stops answering `isAlive`,
//      which is EXACTLY the shape orphanScan looks for ("non-terminal state, dead owner").
//      Answered CROSS-PROCESS: `publishLiveWorkerIds` (below) writes the current `live` id set to
//      <journalRoot>/live-workers.json (journal.js's writeLiveWorkerIds, atomic tmp+rename) every
//      time it changes, and the scanner reads it fresh every cycle (journal.js's
//      readLiveWorkerIds, state-machine.js's runScanCycle). See journal.js's own header for the
//      full staleness-direction reasoning; the short version is that the file is published ONLY
//      after any crash-repark for a departing id has already fully landed on disk, so a scanner
//      that reads a stale (still-listing-the-id) copy only ever defers, never races the repark.
// handleExit below is ENTIRELY SYNCHRONOUS (no `await`, and finalizePark is itself synchronous),
// so `live.delete(id)` and the matching `publishLiveWorkerIds` call are always the LAST things
// that happen for a given exit, strictly after any repark it warranted -- see handleExit's own
// comment.
//
// SHUTDOWN: this module never installs its own signal handlers (daemon.js keeps those, per
// CLAUDE.md's own division of responsibility). `killAllChildren` is exposed so daemon.js's
// existing SIGINT/SIGTERM/`exit` machinery can call it synchronously from the SAME `process.once
// ('exit', ...)` hook that already releases the lock -- see daemon.js's own integration. It
// signals every live WORKER and the scanner, if any -- both are spawned `detached: true`, their
// own process group; `process.kill(-pid, signal)` (the negative pid) therefore reaches each
// group's own `claude` child too, not just the immediate `node --worker`/`--scanner` process, so
// a killed child can never orphan a still-spending LLM call. Deliberately NOT `unref()`'d
// anywhere -- the dispatcher (via `run()`'s own Promise.race) awaits every child's exit for as
// long as it is willing to keep running at all.

const fs = require('fs');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

const accounts = require('./accounts');
const { appendDaemonEvent, writeLiveWorkerIds } = require('./journal');
const { readJsonSafe } = require('./park-loop');
const { takeNextTask, buildCtx, finalizePark } = require('./state-machine');
const { sleep } = require('./steps/scripted');

const DAEMON_PATH = path.join(__dirname, 'daemon.js');
const DEFAULT_WORKERS = 1;
const DEFAULT_CRASH_LIMIT = 3;

function resolveWorkerCount(config) {
  const raw = config && config.workers;
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_WORKERS;
}

function resolveCrashLimit(config) {
  const raw = config && config.workerCrashLimit;
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CRASH_LIMIT;
}

// Deliberately a SEPARATE limit from resolveCrashLimit above, not a shared counter -- see
// createDispatcher's own comment on handleScannerExit for the full justification. Same numeric
// default (3) for the same reason resolveCrashLimit's default is 3: no journal evidence exists
// for EITHER number yet (there has never been a scanner before this action, exactly as there had
// never been a worker before 6.1), so there is no basis to pick a different tunable for one over
// the other -- only evidence, once it exists, would justify diverging them.
function resolveScannerCrashLimit(config) {
  const raw = config && config.scannerCrashLimit;
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CRASH_LIMIT;
}

// Collapses daemon.js's own --worker exit-code table (see that file's header) to the two buckets
// this module actually branches on. "By name, never by testing for 1" (this action's own
// instruction): 0 and 20 are the only two codes an ordinary run can legitimately produce, checked
// by exact value -- everything else (1, the documented uncaught-error code; 130/143, a SIGINT/
// SIGTERM kill; 2, a usage error; 75, a LockLostError; null from a signal kill with no exit code
// at all; or any other value) is CRASHED. 2 and 75 are both named/documented codes in daemon.js's
// own table, but neither should ever legitimately reach a dispatcher-spawned worker: 2 (usage
// error) requires an unreadable taskDir/task.json, and this module always hands `--worker` a path
// takeNextTask itself just created; 75 (LockLostError) requires config.lockLost to be wired,
// which a worker never does (daemon.js's own comment: "unreachable in practice"). If either is
// ever observed anyway, that means something upstream of this module is already broken, and the
// honest response is the same as for any other unexpected code: repark and let the exit code
// itself -- carried into the park detail below -- be the evidence a human needs, rather than
// silently special-casing it as "fine, nothing to see" and burying the bug this classifier exists
// to surface.
function classifyWorkerExit(code) {
  if (code === 0) return 'done';
  if (code === 20) return 'parked';
  return 'crashed';
}

// Builds the argv daemon.js's own --worker mode expects (see that file's header): the SAME mode
// flag and queue/journal roots this dispatcher's own process was started with, so a worker's own
// finalizePark (action 4.4's transient-retry path, should this task hit one) re-enqueues into the
// queue THIS dispatcher is watching, not a throwaway that nobody ever drains. `--deadline-ms` is
// forwarded only when this run's config actually carries a stepDeadlineMs -- daemon.js's own
// `--worker` parsing already falls back to config.js's default when the flag is absent, so
// omitting it here when there is nothing non-default to say is not a behaviour change, just less
// argv.
//
// `--workers` IS FORWARDED, and this is a 6.3 defect that only 6.4 could surface. A worker resolves
// its OWN config from config.js (env) plus this argv -- nothing else crosses the process boundary
// except inherited process.env. So a `--workers 2` dispatcher used to spawn children that each
// resolved `config.workers === 1`, and nothing noticed until action 6.4 derived a value from it:
// product-repo-lock.js's waitBoundMs is (K-1) x WORST_HOLD_MS, which at K=1 is ZERO, so the second
// concurrent card did not WAIT for the product-repo mutex -- it parked `product-repo-lock-timeout`
// on its first failed acquire. Measured during 6.4's verification with two real processes at the
// config a dispatcher-spawned worker actually resolves: one reached PLAN, the other parked
// instantly. The mutex's entire reason to exist (K > 1) was the exact case it broke.
//
// Only SPO_WORKERS in the environment happened to work; the documented CLI flag did not. The
// clamp to healthy accounts stays dispatcher-side deliberately -- a worker uses K only to size the
// wait it must be willing to perform, and the honest answer to "how many workers could be ahead of
// me" is the configured K, not whatever the pool happened to allow at spawn time.
//
// See test/dispatcher.test.js's flag-coverage test for the standing rule this is now held to:
// every flag daemon.js accepts must be explicitly classified as forwarded or deliberately not.
function buildWorkerArgv(taskDir, queueDir, journalRoot, config) {
  const modeFlag = config.shadowMode ? '--shadow' : config.dryRun ? '--dry-run' : '--real';
  const argv = [DAEMON_PATH, modeFlag, '--worker', taskDir, '--queue', queueDir, '--journal', journalRoot];
  if (config.stepDeadlineMs) argv.push('--deadline-ms', String(config.stepDeadlineMs));
  if (Number.isInteger(config.workers) && config.workers > 0) argv.push('--workers', String(config.workers));
  return argv;
}

// Builds the argv daemon.js's own --scanner mode expects (see that file's header): the SAME mode
// flag and queue/journal roots this dispatcher's own process was started with -- a scanner
// re-enqueueing a retry (unparkScan) or auto-pulling a fresh card must land in the queue THIS
// dispatcher's workers actually drain, not a throwaway. No taskDir (a scanner has none) and no
// --deadline-ms (that flag governs a single step's own deadline -- steps run inside a WORKER, a
// scanner never runs one).
function buildScannerArgv(queueDir, journalRoot, config) {
  const modeFlag = config.shadowMode ? '--shadow' : config.dryRun ? '--dry-run' : '--real';
  return [DAEMON_PATH, modeFlag, '--scanner', '--queue', queueDir, '--journal', journalRoot];
}

// Reparks a crashed worker's task through the exact same buildCtx/finalizePark round trip
// orphan-scan.js already uses (board move, park comment, report.md, daemon.jsonl 'parked' line --
// see finalizePark's own header in state-machine.js) -- 'worker-crashed', with the exit code (and
// signal, when this was a signal kill) in the detail, per this action's own requirement: "the
// dispatcher's exit handler is authoritative and reparks".
//
// `lastState` is read from state.json when one exists (the worker got far enough into runTask to
// write at least the INTAKE snapshot -- see state-machine.js's runTask, which writes it as its
// very first statement) -- the same runtime-field restoration orphan-scan.js performs for the
// identical reason (worktreePath/prNumber/the four counters are not on task.json, only on the
// snapshot). A missing state.json (the worker died before runTask ever ran -- e.g. a usage error
// this classifier deliberately still treats as "crashed", see classifyWorkerExit's own comment)
// falls back to 'INTAKE': the earliest state a task can be parked FROM, and the honest answer when
// nothing more specific was ever recorded.
//
// A task already showing a TERMINAL state (DONE/PARKED/ABANDONED) is left alone and merely
// journalled -- this covers the (believed unreachable, but not asserted so) case of a worker
// process producing more exit-path activity after its own outcome was already durable on disk;
// reparking an already-terminal task would be a second, spurious writer racing whatever legitimate
// state that terminal write represents, exactly what the single-writer invariant this module's own
// header cites exists to prevent.
function reparkCrashedWorker(id, taskDir, code, signal, queueDir, journalRoot, config) {
  let task;
  try {
    task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  } catch (err) {
    appendDaemonEvent(journalRoot, 'worker-crash-repark-failed', {
      id,
      exitCode: code,
      signal: signal || null,
      step: 'task.json',
      error: String((err && err.message) || err),
    });
    return;
  }

  const state = readJsonSafe(path.join(taskDir, 'state.json'));
  const lastState = (state && state.state) || 'INTAKE';
  if (lastState === 'DONE' || lastState === 'PARKED' || lastState === 'ABANDONED') {
    appendDaemonEvent(journalRoot, 'worker-exit-after-terminal', {
      id,
      exitCode: code,
      signal: signal || null,
      lastState,
    });
    return;
  }

  const ctx = buildCtx(id, task, taskDir, { ...config, queueDir, deps: (config && config.deps) || {} });
  // Same runtime-only field restoration orphan-scan.js performs, for the same reason -- see that
  // module's own comment on worktreePath/prNumber/the four counters.
  ctx.task.worktreePath = (state && state.worktreePath) || null;
  ctx.prNumber = (state && state.prNumber) || null;
  ctx.counters.diagnoseAttempts = (state && state.diagnoseAttempts) || 0;
  ctx.counters.validateRejects = (state && state.validateRejects) || 0;
  ctx.counters.ciImplementRetries = (state && state.ciImplementRetries) || 0;
  // Action 6.5: a COUNT, not a boolean -- same `Number(...) || 0` restore orphan-scan.js
  // uses, and for the reason stated there (a pre-6.5 boolean still upgrades in place).
  ctx.counters.mainMoveUsed = Number(state && state.mainMoveUsed) || 0;

  finalizePark(ctx, lastState, 'worker-crashed', { exitCode: code, signal: signal || null });
}

// createDispatcher(queueDir, journalRoot, config) -> {run, killAllChildren, stop}
//
// `config.deps.spawn` is the test-only injection point (same convention as every other
// `deps.spawnSync`/`deps.spawn` in this codebase) for swapping out what child process actually
// gets started -- production never passes it, and the default is child_process.spawn itself, so a
// production run always spawns a REAL `node orchestrator/daemon.js --worker/--scanner ...` child.
// Tests that need a deterministic, fast, but still-a-real-process crash exercise this hook to
// spawn a tiny throwaway script instead of the full daemon.js -- see test/dispatcher.test.js.
//
// `config.deps.spawnScanner`, separately, is the SAME kind of hook for the ONE scanner spawn --
// falling back to `config.deps.spawn` (so a test that wants everything real, worker AND scanner,
// only has to inject one function), and only THEN to the real spawn. This split matters for tests
// that sequence `deps.spawn` to hand back specific crash codes for a KNOWN NUMBER of WORKER
// spawns (the crash-classifier/circuit-breaker tests): spawnScanner's own call would otherwise be
// call #0 in that sequence, consuming an entry meant for the first worker and, if the scanner
// itself then "crashes" and gets respawned, desynchronizing every worker spawn after it -- and
// since the SCANNER breaker can trip independently, it could stop the dispatcher before any of
// the worker spawns a test is asserting on ever happen. A test asserting on WORKER behaviour only
// therefore hands `deps.spawnScanner` an inert, long-lived stand-in (see test/dispatcher.test.js's
// own `neverExitsSpawn`) so the scanner is real enough to exist and be supervised, but never
// enters the worker-spawn sequence at all.
function createDispatcher(queueDir, journalRoot, config) {
  const deps = (config && config.deps) || {};
  const spawnFn = deps.spawn || realSpawn;
  const spawnScannerFn = deps.spawnScanner || deps.spawn || realSpawn;
  const accountsDir = config.claudeAccountsDir;
  const crashLimit = resolveCrashLimit(config);
  const scannerCrashLimit = resolveScannerCrashLimit(config);

  const live = new Map(); // id -> {pid, taskDir} -- TASK-owning workers only, never the scanner
  const pending = new Set(); // Set<Promise<void>>, one per in-flight child's own exit-watch chain
  let consecutiveCrashes = 0;
  let consecutiveScannerCrashes = 0;
  let stopReason = null;
  let scanner = null; // {pid} of the one live scanner child, or null while none is running

  // Publishes the CURRENT set of task-owning worker ids to <journalRoot>/live-workers.json
  // (journal.js's writeLiveWorkerIds, atomic tmp+rename) -- called every time `live` changes
  // (spawnOne, handleExit), never on a timer, so the file is never staler than "since the last
  // spawn or exit this process handled". The scanner is NEVER included: it does not own a
  // taskDir, so it has no business in a table whose whole purpose is taskDir ownership. See this
  // module's own header and journal.js's header for the full cross-process design and the
  // staleness-direction reasoning.
  function publishLiveWorkerIds() {
    writeLiveWorkerIds(journalRoot, live.keys());
  }

  // Signals every live WORKER and the scanner (if one is running) -- both are spawned
  // `detached: true`, their own process group, so `process.kill(-pid, signal)` (the negative pid)
  // reaches each group's own `claude` child too. Renamed from an earlier `killAllWorkers` once
  // the scanner existed to supervise as well -- daemon.js's exit hook calls this one name for
  // both kinds of child now.
  function killAllChildren(signal = 'SIGTERM') {
    for (const { pid } of live.values()) {
      if (!pid) continue;
      try {
        process.kill(-pid, signal);
      } catch {
        // Already dead, or (a spawn that raced this call) never actually got its own group yet --
        // best-effort, same posture as lock.js's own release-on-exit.
      }
    }
    if (scanner && scanner.pid) {
      try {
        process.kill(-scanner.pid, signal);
      } catch {
        // Same best-effort posture as the worker loop above.
      }
    }
  }

  // One live child's own exit as a Promise, resolved (never rejected -- an 'error' event, e.g.
  // ENOENT on the daemon.js path or the spawned command itself, folds into the SAME resolution
  // shape as a normal exit) so run()'s own Promise.race never needs a .catch. Node guarantees at
  // most one of 'error'/'exit' fires in the way this code cares about for a failed-to-spawn child
  // (an 'error' with no matching 'exit'), so the `settled` guard exists only to be defensive
  // against a future Node behaviour change, not because both are expected together today. Shared
  // by both workers and the scanner -- the DIFFERENCE between them is entirely in what each
  // caller's own `.then` handler (handleExit vs handleScannerExit) does with the result.
  function watchChild(child) {
    return new Promise((resolve) => {
      let settled = false;
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ code: null, signal: null, spawnError: err });
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal, spawnError: null });
      });
    });
  }

  // Handles ONE worker's exit, entirely synchronously (no `await` anywhere in this function) --
  // see this module's own header for why that synchronicity is what makes the live-worker-table
  // skip in orphanScan race-free rather than merely probabilistic: `live.delete(id)` (and the
  // `publishLiveWorkerIds` call right after it) is the LAST thing this function does, run only
  // after any crash repark this exit warrants has already fully landed on disk.
  function handleExit(id, taskDir, { code, signal, spawnError }) {
    const outcome = spawnError ? 'crashed' : classifyWorkerExit(code);
    appendDaemonEvent(journalRoot, 'worker-exit', {
      id,
      code: code === undefined ? null : code,
      signal: signal || null,
      outcome,
      ...(spawnError ? { spawnError: String((spawnError && spawnError.message) || spawnError) } : {}),
    });

    if (outcome === 'done' || outcome === 'parked') {
      // A park is a SUCCESSFUL run of the state machine (the plan's own words) -- it resets the
      // breaker exactly like a DONE does, so an ordinary run of parked cards can never trip a
      // breaker meant to catch a broken state machine, not a busy one.
      consecutiveCrashes = 0;
    } else {
      consecutiveCrashes += 1;
      try {
        reparkCrashedWorker(id, taskDir, code, signal, queueDir, journalRoot, config);
      } catch (err) {
        appendDaemonEvent(journalRoot, 'worker-crash-repark-failed', {
          id,
          exitCode: code,
          signal: signal || null,
          step: 'unexpected',
          error: String((err && err.message) || err),
        });
      }
      if (consecutiveCrashes >= crashLimit) {
        stopReason = { reason: 'worker-crash-circuit-breaker', consecutiveCrashes, crashLimit, lastId: id };
      }
    }

    live.delete(id); // last -- see the function's own header comment above.
    publishLiveWorkerIds();
  }

  // Handles the scanner's own exit. UNLIKE a worker, there is no "ordinary" exit code for the
  // scanner to produce -- state-machine.js's runForever is `for (;;) { ... }` and never returns
  // on its own, so ANY exit (any code, any signal, even 0) that this dispatcher did not itself
  // just cause by shutting down IS a crash, full stop, and gets a fresh scanner spawned
  // immediately -- "the dispatcher spawns exactly ONE scanner ... and respawns it if it dies" is
  // this action's own instruction, not a policy this function is choosing on its own.
  //
  // `stopReason` already being set means this dispatcher is shutting down (the circuit breaker
  // tripped, or something called `stop()`) -- killAllChildren already signalled this exact
  // scanner, so its exit is expected, not a crash to count or respawn over. Checked FIRST, before
  // any counting, so a shutdown-time scanner exit can never itself trip the scanner breaker on
  // its way out.
  //
  // SEPARATE COUNTER FROM THE WORKER BREAKER, ON PURPOSE (this action's own instruction to
  // justify whichever way this goes): a scanner crash and a worker crash are different failure
  // domains -- one is the scan/intake machinery (gh calls, comment parsing, board moves), the
  // other is the state-machine's own execution of a card. Sharing one counter would let two
  // unrelated flukes (one scanner hiccup, one worker hiccup) look like "the same thing happening
  // three times" in the trip detail, which is actively misleading to whoever reads it -- the
  // fingerprint (`consecutiveScannerCrashes` vs `consecutiveCrashes`) is itself diagnostic
  // information the maintainer would lose by merging the two. Both still stop the WHOLE
  // dispatcher on trip (see the `stopReason` assignment) -- a scanner stuck in a crash loop with
  // no way to recover is exactly as loud a signal as a worker stuck in one, even though the two
  // are never confused for each other.
  function handleScannerExit({ code, signal, spawnError }) {
    scanner = null;
    if (stopReason) {
      appendDaemonEvent(journalRoot, 'scanner-exit-during-shutdown', {
        code: code === undefined ? null : code,
        signal: signal || null,
      });
      return;
    }

    consecutiveScannerCrashes += 1;
    appendDaemonEvent(journalRoot, 'scanner-crashed', {
      code: code === undefined ? null : code,
      signal: signal || null,
      consecutiveScannerCrashes,
      scannerCrashLimit,
      ...(spawnError ? { spawnError: String((spawnError && spawnError.message) || spawnError) } : {}),
    });

    if (consecutiveScannerCrashes >= scannerCrashLimit) {
      stopReason = { reason: 'scanner-crash-circuit-breaker', consecutiveScannerCrashes, scannerCrashLimit };
      return; // do not respawn -- the dispatcher itself is stopping.
    }
    spawnScanner(); // immediate respawn -- see this function's own header.
  }

  // Spawns one worker for an already-`takeNextTask`-taken {id, taskDir}, registers it in `live`
  // BEFORE the spawn call returns (so anything reading `live` later in this same synchronous turn
  // never sees a half-registered worker), publishes the updated live-worker-ids file, and returns
  // once handleExit's own promise is tracked in `pending` so run()'s Promise.race can wake on it.
  function spawnOne({ id, taskDir }) {
    const argv = buildWorkerArgv(taskDir, queueDir, journalRoot, config);
    const child = spawnFn(process.execPath, argv, { detached: true, stdio: 'ignore' });
    live.set(id, { pid: child.pid, taskDir });
    appendDaemonEvent(journalRoot, 'worker-spawn', { id, pid: child.pid || null, taskDir });
    publishLiveWorkerIds();

    const p = watchChild(child)
      .then((result) => handleExit(id, taskDir, result))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  // Spawns the one scanner process. Tracked the same way a worker is (watchChild + `pending`),
  // but through `scanner` (a single slot, never a Map -- there is only ever one) rather than
  // `live`, and never published to live-workers.json -- see publishLiveWorkerIds' own comment.
  function spawnScanner() {
    const argv = buildScannerArgv(queueDir, journalRoot, config);
    const child = spawnScannerFn(process.execPath, argv, { detached: true, stdio: 'ignore' });
    scanner = { pid: child.pid };
    appendDaemonEvent(journalRoot, 'scanner-spawn', { pid: child.pid || null });

    const p = watchChild(child)
      .then((result) => handleScannerExit(result))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  // Fills as many slots as K (re-clamped to healthy accounts, THIS instant) currently allows,
  // taking one task at a time via takeNextTask -- which is itself what makes "not the same task to
  // two workers" safe: the queue-file rename it performs is atomic, and this function calls it
  // serially (never concurrently with itself), so there is no race to fix here, only to preserve.
  // takeNextTask's own `liveIds` parameter (state-machine.js) is handed the CURRENT `live` table on
  // every call -- not once per fillSlots invocation -- so a slot freed by a worker that just
  // finished (removed from `live` inside handleExit, which always completes before this function
  // is called again) is immediately visible.
  function fillSlots() {
    if (stopReason) return;
    for (;;) {
      const healthy = accounts.countHealthyAccounts(accountsDir);
      const k = Math.min(resolveWorkerCount(config), Math.max(healthy, 0));
      if (live.size >= k) return;
      const taken = takeNextTask(queueDir, journalRoot, new Set(live.keys()));
      if (!taken) return;
      spawnOne(taken);
    }
  }

  // Post-verification correction: this loop no longer runs any scan at all -- see this module's
  // own header for the measured reason (a blocking `claude` call inside auto-triage, 3+ minutes,
  // would otherwise freeze this exact loop). Its iterations are bounded ONLY by a worker (or the
  // scanner) exiting, or the ordinary poll interval -- neither depends on how long any scan takes,
  // because no scan ever runs here.
  async function run() {
    spawnScanner(); // exactly one, up front -- see handleScannerExit for the respawn-on-crash loop.

    for (;;) {
      if (stopReason) break;

      fillSlots();

      if (stopReason) break;

      // Wake on whichever comes first: the ordinary poll interval, or ANY child (worker or
      // scanner) exiting. `pending` always has at least the scanner's own watch in it once
      // spawnScanner above has run, so Promise.race([sleep, ...pending]) is never racing an
      // empty second argument in practice -- the `pending.size > 0` guard stays anyway, both for
      // defensiveness and because a test can inject a `spawn` that never actually adds anything.
      const race = [sleep(config.pollIntervalMs)];
      if (pending.size > 0) race.push(Promise.race(pending));
      await Promise.race(race);
    }

    // Circuit breaker tripped -- shut down the same way an external SIGTERM would: signal every
    // live child's process group and let them go, then let run() return so the caller (daemon.js)
    // can release the lock and exit non-zero. Awaited so a caller that logs `stopReason` and exits
    // right after this resolves is not racing this cleanup.
    killAllChildren('SIGTERM');
    await Promise.allSettled(pending);
    return stopReason;
  }

  // Cooperative, non-forceful stop request -- distinct from killAllChildren (which signals
  // PROCESSES) and from the circuit breaker's own internal `stopReason` assignment. Not part of
  // this action's own required surface (daemon.js never calls it: a live daemon only ever stops
  // via a signal, handled entirely outside run()'s own loop, or a circuit breaker), but the test
  // suite needs a clean way to end a `run()` call that would otherwise loop forever, and a second,
  // parallel "please stop" flag alongside `stopReason` would just be the same mechanism twice.
  // Noticed at the top of the NEXT loop iteration (bounded by config.pollIntervalMs, same as the
  // circuit breaker's own latency) -- see run()'s own `if (stopReason) break` checks.
  function stop(reason) {
    if (!stopReason) stopReason = reason || { reason: 'stop-requested' };
  }

  return { run, killAllChildren, stop };
}

module.exports = {
  createDispatcher,
  classifyWorkerExit,
  resolveWorkerCount,
  resolveCrashLimit,
  resolveScannerCrashLimit,
  // Exported for the same reason classifyWorkerExit/resolveWorkerCount above are: a direct unit
  // test. Specifically the mode flag -- a dispatcher that spawned `--shadow` workers from a
  // `--real` daemon would do NOTHING real in production while passing every end-to-end test in
  // this suite, because every one of those tests is itself a shadow-mode run (verification round
  // for 6.3: that exact mutation survived the full 1249-test suite).
  buildWorkerArgv,
  buildScannerArgv,
};
