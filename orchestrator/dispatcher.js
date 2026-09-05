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
// SIGTERM response, and -- since the unit's TimeoutStopSec bounds the stop (90s when this was
// measured; 2760s since the drain landed, scripts/daemon-install.sh) -- a deploy SIGKILLs the
// whole process before `killAllChildren` below ever runs. The larger bound makes that far less
// likely; it does not make a scan that blocks this loop for minutes any less wrong.
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
// Elapsed-duration measurement for exactly one thing below: how long a spawned scanner stayed
// alive before it crashed, inside THIS process only -- see that module's own header, and
// resolveScannerHealthyUptimeMs's comment, for why this is the right clock for that and the wrong
// one for anything written to disk or compared across processes.
const { monotonicNowMs } = require('./monotonic-clock');
// The pipeline's own commit, read from .git by hand (never a `git` subprocess -- see that
// module's header). Resolved ONCE, at require time: the files this process executes were loaded
// at its start, so re-reading HEAD later would report a sha this process is not running.
const { readPipelineVersion } = require('./pipeline-version');

const PIPELINE_VERSION = readPipelineVersion();

const DAEMON_PATH = path.join(__dirname, 'daemon.js');
const DEFAULT_WORKERS = 1;
const DEFAULT_CRASH_LIMIT = 3;
// Matches config.js's own scannerHealthyUptimeMs default (max(orphanScanMs, unparkScanMs), both
// 60s) -- see that field's comment for the full derivation. Only reached if a caller hands
// createDispatcher a config object that omits the field entirely (config.js's own shipped default
// never does); same fallback posture as DEFAULT_CRASH_LIMIT above.
const DEFAULT_SCANNER_HEALTHY_UPTIME_MS = 60 * 1000;
// Mirrors config.js's own drainTimeoutMs default -- see that field's comment for the measurement
// (56 real card runs out of journal/daemon.jsonl) behind the number. Only reached if a caller
// hands createDispatcher a config that omits the field entirely; same fallback posture as
// DEFAULT_CRASH_LIMIT above.
const DEFAULT_DRAIN_TIMEOUT_MS = 45 * 60 * 1000;
// Mirrors config.js's drainKillGraceMs default -- see that field for the derivation.
const DEFAULT_DRAIN_KILL_GRACE_MS = 60 * 1000;

// `sleep(ms)` (steps/scripted.js) is a plain, non-unref'd setTimeout, so the LOSER of a
// `Promise.race` keeps the event loop alive for its full duration after the race has resolved.
// Harmless while the only consumer was a `for(;;)` loop that was about to sleep again -- and
// measurably wrong the moment the loop can EXIT: a SIGTERM to an idle daemon resolved run() in 5ms
// and then sat in the event loop for another 4497ms waiting out an abandoned poll timer. That is
// what `systemctl stop` actually waits for, so the drain's "an idle restart costs 0ms" was true of
// awaitInFlight and false of the process. Cancelling the loser makes the two agree.
function cancellableSleep(ms) {
  let cancel = () => {};
  const promise = new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

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

// Same shape as resolveScannerCrashLimit above, for config.scannerHealthyUptimeMs -- see that
// field's own comment in config.js for the full derivation (orphanScanMs/unparkScanMs, why a
// scanner's first loop pass is never evidence of health, why uptime rather than a terminal outcome
// is the only signal a `for (;;)` scanner can offer). A non-finite or non-positive override (a
// config assembled by a test, or a malformed env var that already fell back to config.js's own
// default before reaching here) falls back to DEFAULT_SCANNER_HEALTHY_UPTIME_MS rather than 0 --
// 0 would mean "every crash is healthy", i.e. consecutiveScannerCrashes could never exceed 1 and
// the breaker this action exists to keep honest would never trip at all.
// How long run()'s drain is willing to wait for the cards already in flight. Same override
// posture as the resolvers above with ONE deliberate difference: 0 is a MEANINGFUL value here, not
// a malformed one. `SPO_DRAIN_TIMEOUT_MS=0` turns the drain off and restores the pre-drain
// behaviour exactly (requestDrain refuses, daemon.js's handler exits 143 on the spot), which is
// the setting a box wants if a drain ever misbehaves -- so only a NON-FINITE or NEGATIVE value
// falls back to config.js's default.
function resolveDrainTimeoutMs(config) {
  const raw = config && config.drainTimeoutMs;
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DRAIN_TIMEOUT_MS;
}

// How long the drain waits for a SIGNALLED straggler to finish and exit before escalating to
// SIGKILL. Same 0-is-meaningful posture as resolveDrainTimeoutMs above (0 = escalate at once).
function resolveDrainKillGraceMs(config) {
  const raw = config && config.drainKillGraceMs;
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DRAIN_KILL_GRACE_MS;
}

function resolveScannerHealthyUptimeMs(config) {
  const raw = config && config.scannerHealthyUptimeMs;
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SCANNER_HEALTHY_UPTIME_MS;
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
//
// `--parent-pid` IS FORWARDED, and it is what stops an orphaned scanner running forever (action
// 6.6 verification, Task 2). Both children are spawned `detached: true` -- correct and still
// required for a WORKER, so `process.kill(-pid, ...)` reaches that worker's own `claude`
// grandchild and a killed card can never leave an LLM call still spending. But a worker is
// short-lived and awaited; the scanner's `for(;;)` never returns on its own, so `detached` also
// means it OUTLIVES A DISPATCHER THAT DIES WITHOUT KILLING IT. Measured: SIGKILL the dispatcher
// alone (not its group) and the scanner keeps running, reparented to ppid 1. systemd's
// `KillMode=control-group` covers `systemctl stop`, but not a dispatcher CRASH -- and
// `Restart=always` then starts a NEW dispatcher, which spawns a SECOND scanner, so two scanners
// run the same timers against the same journal root: duplicate unpark scans, duplicate report
// intake, and two independent auto-pull watermark computations against one queue.
//
// The scanner therefore learns the pid it must not outlive, and state-machine.js's runForever
// checks `process.ppid !== parentPid` once per loop iteration -- an EXACT test, not a heuristic:
// the kernel reparents an orphan the instant its parent dies, so a changed ppid means the parent
// is gone, and an unchanged one means it is not. Immune to pid reuse (the value is compared, not
// probed with kill(pid, 0)) and correct in a container where the dispatcher is itself pid 1.
// Absent (a maintainer running `daemon.js --scanner` by hand) the check is skipped entirely.
function buildScannerArgv(queueDir, journalRoot, config) {
  const modeFlag = config.shadowMode ? '--shadow' : config.dryRun ? '--dry-run' : '--real';
  const argv = [
    DAEMON_PATH,
    modeFlag,
    '--scanner',
    '--queue',
    queueDir,
    '--journal',
    journalRoot,
    '--parent-pid',
    String(process.pid),
  ];
  // `--workers` IS FORWARDED TO THE SCANNER TOO -- action 6.6 verification. It was deliberately
  // withheld until 6.6, and the reason recorded in test/dispatcher.test.js's own flag-policy
  // table ("a scanner never takes the product-repo lock") was true at the time: K reached a
  // child only through product-repo-lock.js's waitBoundMs, which only a worker ever computes.
  // Action 6.6 gave the scanner a SECOND reason to need K, and nothing updated the table: the
  // auto-pull watermark is `in-flight + queued <= K`, computed by auto-pull.js's
  // computeAutoPullBudget, which runs in THIS child. A `--workers 3` dispatcher paired with a
  // scanner resolving K=1 would hold the queue at one card no matter how many slots were idle --
  // the daemon would look like it simply refused to parallelise. Only `SPO_WORKERS` in the
  // inherited env happened to work, which is bug-for-bug the shape 6.4 already found and fixed
  // on the worker side. Same guard as buildWorkerArgv: a missing or invalid K omits the flag
  // rather than forwarding NaN, so the child falls back to its own config.js resolution.
  if (Number.isInteger(config.workers) && config.workers > 0) argv.push('--workers', String(config.workers));
  return argv;
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
  // Same injection idiom as spawn/spawnScanner above, for the ONE other real-world input the
  // scanner-crash-breaker fix reads: production always gets the real monotonicNowMs (an elapsed
  // wall-clock read -- see that module's own header for why it's the right measurement here and
  // the wrong one for anything written to disk). A test that wants a DETERMINISTIC uptime --
  // "this crash happened after exactly 50ms", "this one after exactly 1300ms" -- without an
  // actual `setTimeout`-driven child process can inject a fake clock here instead; a test that
  // wants to prove the PRODUCTION PATH really measures real elapsed time leaves this un-injected
  // and uses a real, slow child (see test/dispatcher.test.js's own split between the two).
  const monotonicNowMsFn = deps.monotonicNowMs || monotonicNowMs;
  const accountsDir = config.claudeAccountsDir;
  const crashLimit = resolveCrashLimit(config);
  const scannerCrashLimit = resolveScannerCrashLimit(config);
  const scannerHealthyUptimeMs = resolveScannerHealthyUptimeMs(config);

  const live = new Map(); // id -> {pid, taskDir} -- TASK-owning workers only, never the scanner
  const pending = new Set(); // Set<Promise<void>>, one per in-flight child's own exit-watch chain
  let consecutiveCrashes = 0;
  let consecutiveScannerCrashes = 0;
  // Cumulative, unlike consecutiveScannerCrashes above -- every scanner crash this dispatcher has
  // ever seen, never reset. Genuinely useful for diagnosis (see handleScannerExit's own comment on
  // why the codebase still wants a "how many total" figure even once "how many IN A ROW" is fixed
  // to mean what it says) -- but it earns its OWN honestly-named field in the journal rather than
  // being smuggled back in under consecutiveScannerCrashes' name, which is the exact defect this
  // action closes.
  let totalScannerCrashes = 0;
  let stopReason = null;
  // Set by killAllChildren, read by handleExit/handleScannerExit. It used to be `stopReason` that
  // answered "did WE kill this child?", and once a DRAIN exists the two stop being the same
  // question: a drain sets stopReason and then waits, minutes, WITHOUT signalling any worker. A
  // genuine crash inside that window must still be reparked and still count toward the breaker --
  // keying on stopReason would silently defer every one of them to the next start's orphanScan
  // (`task-orphaned-daemon-restart`, terminal, needs a human `retry`) instead of the ordinary
  // crash repark. `killAllChildren` sets this before it signals anything -- though the position
  // inside that function is not what makes the invariant hold, and mutation testing said so:
  // moving the assignment to the END of killAllChildren leaves the suite green, because
  // `process.kill` never yields and the whole body is one synchronous run. What actually holds is
  // that no exit handler can run until killAllChildren returns.
  let childrenSignalled = false;
  // Non-null once a drain has been requested: {signal, at}. Distinct from stopReason (which a
  // circuit breaker also sets) because only a drain makes run() WAIT instead of killing.
  let drainRequest = null;
  // Outcomes of workers that exited AFTER killAllChildren signalled them: [{id, outcome}]. The
  // drain reports these, because "we stopped waiting" and "a card was lost" are different facts
  // and the first was being printed as if it were the second. Measured: a worker blocked in
  // spawnSync survives its own SIGTERM long enough to finish an entire park (doc/deployment.md
  // 2.2), so a signalled straggler routinely still ends `done` or `parked`.
  const postSignalOutcomes = [];
  // Resolves the current loop iteration's wake promise -- see run()'s own race. Without it a drain
  // request waits out the full pollIntervalMs before the loop even notices, which is harmless for
  // a 5s poll and needless when the answer is already known.
  let wakeLoop = null;
  let scanner = null; // {pid, startedAtMonotonicMs} of the one live scanner child, or null while none is running

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
    childrenSignalled = true;
    for (const { pid } of live.values()) {
      if (!pid) continue;
      try {
        process.kill(-pid, signal);
      } catch {
        // Already dead, or (a spawn that raced this call) never actually got its own group yet --
        // best-effort, same posture as lock.js's own release-on-exit.
      }
    }
    killScanner(signal);
  }

  // The scanner ALONE. A drain kills it immediately and then waits for the workers, and the
  // asymmetry is the whole point: the scanner is the only thing that puts NEW cards into the
  // queue (auto-pull.js) and the only thing that re-enqueues parked ones (unparkScan). Leaving it
  // alive through a drain would mean the daemon kept claiming work for a version of itself that
  // is on its way out -- exactly the mixed-version window the drain exists to close. It owns no
  // taskDir and holds no lock, so killing it costs a scan cycle and nothing else.
  function killScanner(signal = 'SIGTERM') {
    if (!scanner || !scanner.pid) return;
    try {
      process.kill(-scanner.pid, signal);
    } catch {
      // Same best-effort posture as the worker loop above.
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
  //
  // `stopReason` IS CHECKED FIRST, exactly as handleScannerExit already checked it, and the
  // asymmetry between the two was a defect, not a design. Once `stopReason` is set this
  // dispatcher is shutting down and run() has ALREADY called `killAllChildren('SIGTERM')` on
  // every live worker -- so those workers exit 143, classifyWorkerExit calls 143 'crashed'
  // (correctly: it is not 0 and not 20), and the old code then reparked a PERFECTLY HEALTHY
  // in-flight card as `worker-crashed`. Measured before this check existed: a K=1 dispatcher with
  // one live worker mid-INTAKE, stopped with `stop({reason:'simulated-shutdown'})`, left
  // state.json `{"state":"PARKED","reason":"worker-crashed"}` with `detail:{"exitCode":null,
  // "signal":"SIGTERM"}` -- the dispatcher parking a card for the crime of being killed by that
  // same dispatcher. This is NOT a race: run()'s shutdown path is `killAllChildren('SIGTERM');
  // await Promise.allSettled(pending)`, so it deliberately WAITS for every one of these exits to
  // be handled. Every circuit-breaker trip therefore parked the other, healthy worker's card, and
  // at K=2 a breaker meant to stop the daemon on ONE broken card took a second, innocent one with
  // it, every single time.
  //
  // NOT reparking here is strictly safer than reparking, not merely quieter. A park is not a
  // cheap write: finalizePark runs preserveWorktreeWip (a `git` push) plus postParkComment's
  // board move and `gh` comment, each a bounded-but-slow spawnSync, inside a process systemd has
  // already SIGTERMed and will SIGKILL when the unit's TimeoutStopSec expires (1min30s when this
  // was measured; 2760s since the drain landed, so the window is wider now, not gone). And finalizePark writes
  // state.json PARKED BEFORE postParkComment posts the anchor comment, so a SIGKILL landing
  // between those two leaves a PARKED card with no `park-comment` line in its journal --
  // park-loop.js's findParkAnchor returns null, unparkScan's `if (!anchor ...) continue` skips it
  // on every cycle forever, and orphanScan skips it too (PARKED is terminal). A `retry` comment
  // from the maintainer would never be seen again. Deferring instead costs nothing: a worker
  // killed at shutdown leaves a NON-TERMINAL state.json with a dead owner, which is precisely the
  // shape orphan-scan.js exists to find on the next daemon start. Measured: SIGTERM to the whole
  // process group (systemd's KillMode=control-group) already leaves the card in IMPLEMENT in
  // 10 runs out of 10 -- the deploy path has always relied on orphanScan, and this makes the
  // breaker path rely on the same proven recovery instead of a second, worse one.
  function handleExit(id, taskDir, { code, signal, spawnError }) {
    const outcome = spawnError ? 'crashed' : classifyWorkerExit(code);
    appendDaemonEvent(journalRoot, 'worker-exit', {
      id,
      code: code === undefined ? null : code,
      signal: signal || null,
      outcome,
      ...(spawnError ? { spawnError: String((spawnError && spawnError.message) || spawnError) } : {}),
      ...(childrenSignalled && outcome === 'crashed' ? { duringShutdown: true } : {}),
    });

    if (childrenSignalled && outcome === 'crashed') {
      // Expected, not a crash to count or repark over -- see the header comment above. Counting
      // it would also let a shutdown's own killAllChildren inflate `consecutiveCrashes` past the
      // limit and rewrite an already-decided `stopReason` (e.g. a maintainer's `stop()`
      // reappearing in the logs as a circuit-breaker trip that never happened).
      appendDaemonEvent(journalRoot, 'worker-exit-during-shutdown', {
        id,
        code: code === undefined ? null : code,
        signal: signal || null,
      });
      postSignalOutcomes.push({ id, outcome });
      live.delete(id);
      publishLiveWorkerIds();
      return;
    }

    if (childrenSignalled) postSignalOutcomes.push({ id, outcome });

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
      if (consecutiveCrashes >= crashLimit && !stopReason) {
        // `!stopReason`: a crash landing inside a drain window must not rewrite the drain's own
        // reason as a breaker trip that never decided anything. The dispatcher is already
        // stopping; the only effect would be to lie in the journal about why.
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
  //
  // CONSECUTIVE MEANS CONSECUTIVE (post-verification correction to THIS action's own original
  // shape). consecutiveScannerCrashes used to be incremented here and reset nowhere -- a plain
  // cumulative total wearing a name that promised otherwise. Proved with a real dispatcher: three
  // scanner crashes with 700ms of healthy scanning between each one tripped the breaker exactly
  // as fast as three crashes with none, because nothing ever brought the counter back down. A
  // WORKER gets to reset consecutiveCrashes on a terminal outcome (handleExit above, `outcome ===
  // 'done' || 'parked'`) because a worker's job has a defined end. THE SCANNER'S NEVER DOES --
  // state-machine.js's runForever is `for (;;)` and returns only by crashing or by this
  // dispatcher's own shutdown -- so there is no terminal-outcome signal to reset on here, and
  // uptime is the only substitute available: a scanner that stayed up long enough to complete a
  // second pass of its own orphanScanMs/unparkScanMs cycle (config.scannerHealthyUptimeMs -- see
  // that field's own comment in config.js for exactly why THAT derivation and not, say,
  // pollIntervalMs) demonstrably did real work before it died, and its death should start a fresh
  // streak, not extend whatever streak came before it.
  //
  // Measured with `monotonicNowMs()` (orchestrator/monotonic-clock.js), an elapsed-duration read
  // taken at spawn and again at exit, both inside THIS process -- never written to disk, never
  // compared against another process's own clock (that module's header names this the one thing
  // never to do to it). `startedAtMonotonicMs` is captured from the CURRENT `scanner` before it is
  // nulled out below, so a respawn's own fresh timestamp can never leak into this crash's uptime
  // calculation.
  //
  // The cumulative total is NOT thrown away -- it stays genuinely useful for diagnosis ("how many
  // times has this scanner died today, however far apart") -- it just gets its OWN honestly-named
  // field (`totalScannerCrashes`) instead of hiding under a name that says "in a row" and means
  // "ever". A maintainer reading daemon.jsonl now gets both numbers, correctly labelled, rather
  // than one number under two different implied meanings depending on which event they happen to
  // be looking at.
  function handleScannerExit({ code, signal, spawnError }) {
    const startedAtMonotonicMs = scanner ? scanner.startedAtMonotonicMs : null;
    scanner = null;
    if (stopReason) {
      appendDaemonEvent(journalRoot, 'scanner-exit-during-shutdown', {
        code: code === undefined ? null : code,
        signal: signal || null,
      });
      return;
    }

    // `startedAtMonotonicMs` should always be set (spawnScanner records it synchronously, before
    // this exit can possibly be observed) -- the `=== null` branch only guards a spawn that failed
    // so early `scanner` was never assigned at all, and treats that the same as "no uptime",
    // i.e. definitely not healthy, which is the honest, conservative reading of "we don't actually
    // know how long it ran."
    const uptimeMs = startedAtMonotonicMs === null ? 0 : monotonicNowMsFn() - startedAtMonotonicMs;
    const healthyUptime = uptimeMs >= scannerHealthyUptimeMs;
    consecutiveScannerCrashes = healthyUptime ? 1 : consecutiveScannerCrashes + 1;
    totalScannerCrashes += 1;

    // scannerHealthyUptimeMs is journalled alongside uptimeMs -- without it, `{"uptimeMs":45000,
    // "consecutiveScannerCrashes":3}` is uninterpretable to a reader who has not also opened
    // config.js AND checked the operator's env for a SPO_SCANNER_HEALTHY_UPTIME_MS override. Both
    // numbers together let daemon.jsonl answer "was this crash judged healthy, and against what
    // bar" on its own, the same way scannerCrashLimit sits next to consecutiveScannerCrashes so a
    // reader never has to go compute "how close was this to tripping" by hand.
    appendDaemonEvent(journalRoot, 'scanner-crashed', {
      code: code === undefined ? null : code,
      signal: signal || null,
      consecutiveScannerCrashes,
      totalScannerCrashes,
      scannerCrashLimit,
      uptimeMs,
      scannerHealthyUptimeMs,
      ...(spawnError ? { spawnError: String((spawnError && spawnError.message) || spawnError) } : {}),
    });

    if (consecutiveScannerCrashes >= scannerCrashLimit) {
      stopReason = {
        reason: 'scanner-crash-circuit-breaker',
        consecutiveScannerCrashes,
        totalScannerCrashes,
        scannerCrashLimit,
      };
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
    // startedAtMonotonicMs recorded HERE, synchronously, before this call returns -- so
    // handleScannerExit can never observe a `scanner` whose start time is missing or stale (see
    // that function's own comment on why the uptime measurement it makes is only trustworthy
    // because of this ordering).
    scanner = { pid: child.pid, startedAtMonotonicMs: monotonicNowMsFn() };
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
  // A pool with ZERO healthy accounts clamps K to 0, and a clamp to 0 is not a smaller degree of
  // the same thing -- it is the dispatcher deciding to do no work at all, for as long as the
  // condition lasts. Before this, that decision was made silently on every poll and journalled
  // nowhere: `if (live.size >= k) return` with k=0 and live.size=0 is simply true, so the queue
  // just sat there. Pre-C6 the same pool state produced a park naming a `cooldownUntilIso` a
  // maintainer could read (accounts.js's AllAccountsCoolingError); C6 replaced a loud outcome
  // with an invisible one. This project has already had a 33-hour silent outage of the retry
  // channel that nobody noticed, which is the whole argument for not shipping a second failure
  // mode with no owner and no signal.
  //
  // EDGE-TRIGGERED, not level-triggered: one line when the clamp starts biting and one when it
  // lifts. A line per poll would put ~2 entries a second into daemon.jsonl for the entire length
  // of a cooldown -- which is not a signal, it is what makes a maintainer stop reading the file.
  // The detail carries what the pre-C6 park carried (the earliest cooldown expiry, so the reader
  // knows WHEN this resolves by itself) plus the queue depth, which is what says whether anything
  // is actually being starved right now.
  let idleNoHealthyAccounts = false;

  function poolIdleDetail(healthy) {
    let queued = null;
    try {
      queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length;
    } catch {
      // queue dir not readable -- report null rather than fail a journal write over it.
    }
    let earliestCooldownUntil = null;
    let enabledAccounts = null;
    try {
      const registry = accounts.readRegistry(accountsDir);
      const state = accounts.readState(accountsDir);
      enabledAccounts = registry.filter((a) => a.enabled).map((a) => a.name);
      for (const name of enabledAccounts) {
        const until = state[name] && state[name].cooldownUntil;
        if (until && (earliestCooldownUntil === null || until < earliestCooldownUntil)) earliestCooldownUntil = until;
      }
    } catch {
      // an unreadable/absent pool is itself the condition being reported -- see below.
    }
    return {
      healthy,
      configuredWorkers: resolveWorkerCount(config),
      queued,
      enabledAccounts,
      // null here with zero healthy accounts means "none are COOLING" -- i.e. every account is
      // disabled, or the pool is empty/unreadable. That is a config error a restart will not
      // clear, not a cooldown that expires on its own, and the distinction is the first thing a
      // maintainer needs.
      earliestCooldownUntil: earliestCooldownUntil === null ? null : new Date(earliestCooldownUntil).toISOString(),
    };
  }

  function fillSlots() {
    if (stopReason) return;
    for (;;) {
      const healthy = accounts.countHealthyAccounts(accountsDir);
      const k = Math.min(resolveWorkerCount(config), Math.max(healthy, 0));

      if (k === 0 && !idleNoHealthyAccounts) {
        idleNoHealthyAccounts = true;
        appendDaemonEvent(journalRoot, 'dispatcher-idle-no-healthy-accounts', poolIdleDetail(healthy));
      } else if (k > 0 && idleNoHealthyAccounts) {
        idleNoHealthyAccounts = false;
        appendDaemonEvent(journalRoot, 'dispatcher-healthy-accounts-returned', poolIdleDetail(healthy));
      }

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
    // PUBLISH THE (EMPTY) LIVE-WORKER TABLE FIRST, BEFORE THE SCANNER EXISTS -- action 6.6
    // verification defect. auto-pull.js's computeAutoPullBudget reads a MISSING live-workers.json
    // as `inFlight = K` ("no dispatcher has ever published here, assume the worst"), which is the
    // right posture for a scanner with no dispatcher -- but publishLiveWorkerIds was only ever
    // called from spawnOne/handleExit, so on a cold start with an EMPTY QUEUE the file was never
    // written at all. That is a deadlock, not a delay: auto-pull is the only thing that puts a
    // card in the queue, no queue file means no spawnOne, no spawnOne means no file, and no file
    // means auto-pull's budget is permanently 0. Measured before this line existed: a `--real`
    // dispatcher on an empty queue with SPO_AUTO_PULL_MS=3000 made ZERO `npm run board:claim`
    // calls in 20s (~6 due cycles); writing an empty live-workers.json by hand into the same
    // journal root produced 3 in the next 20s. The daemon would simply never pull a card again.
    //
    // Publishing an empty set here is what makes the absent-file rule mean what its own comment
    // says it means: "absent" now genuinely distinguishes "no dispatcher owns this journal root"
    // from "a dispatcher owns it and is idle", instead of conflating the two. It must run BEFORE
    // spawnScanner so the scanner's very first scan cycle -- which is due immediately, every
    // timer starting at null -- already sees a truthful file rather than racing this write.
    publishLiveWorkerIds();

    // Action 6.7 verification fix. `idleNoHealthyAccounts` below is IN-MEMORY state, and the
    // dispatcher-idle/-returned pair it drives is EDGE-triggered: exactly one line when the pool
    // first has no healthy account, exactly one when it recovers. A restart destroys that memory
    // -- so if the pool goes idle, the daemon is then restarted (which this project does on every
    // single merge: the post-merge hook SIGTERMs it), and the pool recovers, the `returned` edge
    // is NEVER written, because the new process's flag started false. daemon.jsonl is then left
    // with a bare `dispatcher-idle-no-healthy-accounts` as its newest dispatcher edge, forever,
    // and any reader that answers "is the dispatcher idle right now" by walking back to the most
    // recent edge (bin/spo's computeDispatcherIdleStatus) reports a permanent false alarm --
    // measured at "IDLE since 191h06m ago" against a fixture whose daemon was demonstrably busy.
    // This event is the boundary that reader stops at: an idle edge older than the newest
    // dispatcher start says nothing about the CURRENT process. It is self-healing rather than
    // merely suppressive -- if the pool really is still idle, this same process's very next
    // fillSlots pass re-emits the idle edge from its own freshly-false flag.
    // `pipelineSha`/`pipelineRef`: which version of THIS repo the long-lived processes are
    // running. Until this line, `dispatcher-start` carried pid and workers only, and "which
    // version produced that park?" had no answer anywhere in the journal -- while every card's
    // PRODUCT provenance (WORKTREE's `base-main`) was recorded meticulously. It belongs here
    // specifically because a worker records its OWN sha independently (daemon.js's runWorker):
    // buildWorkerArgv spawns `node <DAEMON_PATH>` off a live path, so a `git pull` with no
    // restart leaves this dispatcher on the old sha while its next worker loads the new one, and
    // the two lines disagreeing is that gap made visible instead of inferred.
    appendDaemonEvent(journalRoot, 'dispatcher-start', {
      pid: process.pid,
      workers: resolveWorkerCount(config),
      pipelineSha: PIPELINE_VERSION.sha,
      pipelineRef: PIPELINE_VERSION.ref,
    });

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
      const poll = cancellableSleep(config.pollIntervalMs);
      const race = [poll.promise, new Promise((resolve) => { wakeLoop = resolve; })];
      if (pending.size > 0) race.push(Promise.race(pending));
      await Promise.race(race);
      poll.cancel(); // or the abandoned timer holds the event loop open after run() returns
      wakeLoop = null;
    }

    // THE DRAIN. Reached only when a signal asked for one (requestDrain); a circuit-breaker trip
    // falls straight past it into the kill below, unchanged. By the time control gets here
    // requestDrain has already stopped the claiming half -- stopReason broke the loop above, so
    // fillSlots runs no more, and the scanner (the only producer of new queue entries) is dead --
    // so every worker still in `live` is one that was already mid-card when the signal landed.
    // Waiting for them is what converts "the deploy killed a card" into "the deploy took a few
    // more minutes", with no new infrastructure and no change to what a card does.
    let waitedMs = 0;
    let survivors = [];
    if (drainRequest) {
      const inFlight = [...live.keys()];
      const timeoutMs = resolveDrainTimeoutMs(config);
      appendDaemonEvent(journalRoot, 'dispatcher-drain-start', {
        signal: drainRequest.signal || null,
        timeoutMs,
        inFlight,
      });
      waitedMs = await awaitInFlight(timeoutMs);
      survivors = [...live.keys()];
    }

    // Circuit breaker tripped, or the drain's bound expired -- shut down the same way an external
    // SIGTERM would: signal every live child's process group and let them go, then let run()
    // return so the caller (daemon.js) can release the lock and exit. Unconditional even after a
    // clean drain: `live` being empty does not prove the SCANNER is gone (a drain kills it but
    // never waits for it, and it takes no taskDir with it), and signalling an already-dead group
    // is a no-op this function has always tolerated. Awaited so a caller that logs `stopReason`
    // and exits right after this resolves is not racing this cleanup.
    killAllChildren('SIGTERM');
    await reapSignalledChildren(resolveDrainKillGraceMs(config));

    if (drainRequest) {
      // WRITTEN AFTER THE REAP, NOT AT THE BOUND. The first cut of this emitted drain-end the
      // instant awaitInFlight returned, which recorded the DECISION ("we stopped waiting") in the
      // vocabulary of an OUTCOME ("a card was lost"). Measured with a straggler that ignores
      // SIGTERM: drain-end said `drained:false, survivors:[straggler]` at +1001ms and the card
      // then exited 0 at +8035ms, with nothing correcting the record. That is the COMMON case, not
      // the exotic one -- doc/deployment.md 2.2 measured a signalled worker running a full park to
      // completion. `signalled` is what the deploy interrupted; `outcomes` is what actually became
      // of them, which is the fact a maintainer is really asking for.
      appendDaemonEvent(journalRoot, 'dispatcher-drain-end', {
        drained: survivors.length === 0,
        waitedMs,
        survivors,
        outcomes: postSignalOutcomes.filter((o) => survivors.includes(o.id)),
      });
      stopReason = { ...stopReason, drained: survivors.length === 0, waitedMs, survivors };
    }
    return stopReason;
  }

  // Waits for every signalled child to actually die, then ESCALATES rather than waiting forever.
  //
  // ON EVERY SHUTDOWN PATH, NOT ONLY THE DRAIN'S -- it replaced the bare
  // `await Promise.allSettled(pending)` that used to end run(), so a CIRCUIT-BREAKER trip inherits
  // it too. Named here because inheriting a trade in silence is how it gets reverted by someone
  // who only reads the drain's argument for it. On the breaker path it is a straight improvement,
  // not a borrowed cost: before, a breaker trip with a worker that ignores SIGTERM waited forever
  // and systemd's cgroup SIGKILL at TimeoutStopSec was the only way out -- which kills this
  // process without running daemon.js's exit hook, so the single-instance lock file leaks for the
  // next start to stale-sweep. Ending it here keeps the process's own exit path intact. Pinned by
  // test/drain.test.js's breaker-escalation test, which sends no signal at all.
  // `await Promise.allSettled(pending)` alone is unbounded, and a straggler that ignores SIGTERM is
  // exactly what production has: a worker blocked in spawnSync does not run its signal handler
  // until the loop turns. The only backstop was systemd's own SIGKILL at TimeoutStopSec -- which
  // kills the whole cgroup, so daemon.js's exit hook never runs, the single-instance lock file
  // leaks, and the next start has to stale-sweep it. Escalating HERE keeps the process's own exit
  // path intact, which is the whole difference between a bounded stop and a killed one.
  async function reapSignalledChildren(graceMs) {
    if (pending.size === 0) return;
    const all = Promise.allSettled(pending);
    if (graceMs > 0) {
      const grace = cancellableSleep(graceMs);
      const raced = await Promise.race([all.then(() => 'reaped'), grace.promise.then(() => 'grace-expired')]);
      grace.cancel();
      if (raced === 'reaped') return;
    }
    appendDaemonEvent(journalRoot, 'dispatcher-kill-escalated', {
      graceMs,
      stillLive: [...live.keys()],
    });
    killAllChildren('SIGKILL');
    await all; // SIGKILL is not refusable, so this is genuinely bounded
  }

  // Waits for `live` to empty, up to timeoutMs; returns how long it actually waited. Woken by any
  // child's exit, not merely by the poll -- so a card that finishes one second into a 45-minute
  // bound ends the drain one second in, and a `systemctl restart` on an IDLE daemon costs nothing
  // at all. Measured on the elapsed clock (monotonicNowMsFn, the same seam the scanner breaker
  // uses), never Date.now(): a bound that a clock step could double or erase is not a bound.
  async function awaitInFlight(timeoutMs) {
    const startedAt = monotonicNowMsFn();
    const elapsed = () => monotonicNowMsFn() - startedAt;
    while (live.size > 0) {
      const remaining = timeoutMs - elapsed();
      if (remaining <= 0) break;
      const poll = cancellableSleep(Math.min(remaining, config.pollIntervalMs));
      const race = [poll.promise];
      if (pending.size > 0) race.push(Promise.race(pending));
      await Promise.race(race);
      poll.cancel(); // same abandoned-timer trap as run()'s own poll -- see cancellableSleep
    }
    return elapsed();
  }

  // Asks for a drain instead of the immediate kill daemon.js's signal handler used to perform.
  // Returns false if one is already under way, and that return value is the operator's escape
  // hatch, not an error case: daemon.js turns a SECOND signal into the old immediate exit, so a
  // maintainer who does not want to wait out the bound sends SIGTERM twice (`systemctl kill -s
  // TERM ...` after the `stop`) and gets today's behaviour exactly.
  //
  // Kills the scanner HERE rather than in run()'s drain block, and the ordering matters: between
  // the signal landing and the loop noticing stopReason there is one poll interval in which
  // auto-pull could otherwise claim a fresh card off the board and hand it to a worker this
  // process is about to abandon.
  function requestDrain(detail = {}) {
    if (drainRequest) return false;
    // Drain disabled -- refuse, and let daemon.js's handler do what it did before this existed.
    if (resolveDrainTimeoutMs(config) <= 0) return false;
    drainRequest = { signal: detail.signal || null, at: monotonicNowMsFn() };
    if (!stopReason) stopReason = { reason: 'drain-requested', signal: drainRequest.signal };
    killScanner('SIGTERM');
    if (wakeLoop) {
      wakeLoop();
      wakeLoop = null;
    }
    return true;
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

  return { run, killAllChildren, stop, requestDrain };
}

module.exports = {
  createDispatcher,
  classifyWorkerExit,
  resolveWorkerCount,
  resolveCrashLimit,
  resolveScannerCrashLimit,
  resolveScannerHealthyUptimeMs,
  // Exported for the same reason classifyWorkerExit/resolveWorkerCount above are: a direct unit
  // test. Specifically the mode flag -- a dispatcher that spawned `--shadow` workers from a
  // `--real` daemon would do NOTHING real in production while passing every end-to-end test in
  // this suite, because every one of those tests is itself a shadow-mode run (verification round
  // for 6.3: that exact mutation survived the full 1249-test suite).
  buildWorkerArgv,
  buildScannerArgv,
};
