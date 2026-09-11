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
// It still answers the SAME two questions it always has, in the SAME two ways -- card #78 changed
// NEITHER mechanism; it only added a THIRD question neither of them ever covered (below):
//   1. takeNextTask must never start a queue file whose id matches a task a live worker already
//      owns (state-machine.js's own `liveIds` parameter, threaded through from fillSlots below) --
//      otherwise this module would rename a fresh queue entry straight over the live worker's own
//      taskDir/task.json mid-run. Answered IN-MEMORY, in this same process, no staleness question
//      at all -- fillSlots and takeNextTask both run here, serially. Card #78 widened the SET
//      fillSlots hands this check to the union of `live.keys()` and `reparking.keys()` (see that
//      Map's own comment) -- a different, additional in-memory id this same check must also refuse.
//   2. orphanScan (running in the SEPARATE scanner process) must never repark a task a live worker
//      still owns -- the instant a worker process exits, its pid stops answering `isAlive`, which
//      is EXACTLY the shape orphanScan looks for ("non-terminal state, dead owner"). Answered
//      CROSS-PROCESS, UNCHANGED BY CARD #78: `publishLiveWorkerIds` (below) writes the current
//      `live` id set to <journalRoot>/live-workers.json (journal.js's writeLiveWorkerIds, atomic
//      tmp+rename) every time it changes, and the scanner reads it fresh every cycle (journal.js's
//      readLiveWorkerIds, state-machine.js's runScanCycle) -- see orphan-scan.js's own two
//      `liveWorkerIds.has(id)` checks. `reparking` is deliberately never folded into this file --
//      see publishLiveWorkerIds' own comment for why.
//
// CARD #78 ADDED A THIRD QUESTION, and it is the one this table's OLD text here got wrong once a
// crash repark stopped running in-process: "has THIS taskDir's crash already been claimed by some
// other repark attempt?" The old text said live-workers.json "is published ONLY after any
// crash-repark for a departing id has already fully landed on disk", which was true while a crash
// reparked the task synchronously, IN-PROCESS, before `live.delete(id)` ever ran -- so a scanner
// reading a stale (still-listing-the-id) copy could only ever defer, never race the repark. That
// stopped being true the moment the park moved into a SPAWNED `daemon.js --repark-task` child
// (reparkCrashedWorker, below): the id leaves `live` -- and live-workers.json -- the instant the
// child is spawned, long before that child's own park has landed anything at all.
// `live`/live-workers.json therefore cannot answer question 3; it was never built to track a
// repark child (question 2, above, is unaffected by any of this -- it never asked about reparks in
// the first place). The answer is a PER-TASK FILE instead: <taskDir>/repark-claim.json (journal.js's
// writeReparkClaim/readReparkClaim/clearReparkClaim), written by reparkCrashedWorker (below)
// SYNCHRONOUSLY, before it ever returns to handleExit, and cleared either by that same function's
// own watchChild.then (on the child's exit) or by state-machine.js's reparkCrashedTask, running
// INSIDE the child, as its own last statement -- whichever runs first; both are idempotent unlinks.
// See journal.js's own header on those functions and orphan-scan.js's own header for the read side.
//
// handleExit below is still ENTIRELY SYNCHRONOUS (no `await`), but what that synchronicity closes
// changed with question 3: NOT that a crash repark for a departing id has already landed on disk --
// it has not; the park itself now runs in the spawned child, off this process's own thread, which
// is the entire point of this action -- but that the CLAIM FILE for that repark has already landed
// on disk before `live.delete(id)` (and the matching `publishLiveWorkerIds` call) ever runs. See
// handleExit's own comment for the full ordering.
//
// SHUTDOWN: this module never installs its own signal handlers (daemon.js keeps those, per
// CLAUDE.md's own division of responsibility). `killAllChildren` is exposed so daemon.js's
// existing SIGINT/SIGTERM/`exit` machinery can call it synchronously from the SAME `process.once
// ('exit', ...)` hook that already releases the lock -- see daemon.js's own integration. An
// ORDINARY call -- the one daemon.js's exit hook makes, and the one run()'s own SIGTERM-then-wait
// shutdown makes -- signals every live WORKER and the scanner, if any, and NEVER a repark child in
// `reparking`: letting an in-flight park finish is strictly better than the half-written park a
// killed one would leave (handleExit's own header). The one exception -- `{ includeReparking:
// true }`, reachable only from reapSignalledChildren's own SIGKILL escalation -- is what keeps a
// shutdown genuinely bounded even when a repark child itself hangs; see that function's own
// comment. Every signalled child is spawned `detached: true`, its own process group;
// `process.kill(-pid, signal)` (the negative pid) therefore reaches each group's own `claude`
// child too, not just the immediate `node --worker`/`--scanner`/`--repark-task` process, so a
// killed child can never orphan a still-spending LLM call. Deliberately NOT `unref()`'d anywhere --
// the dispatcher (via `run()`'s own Promise.race) awaits every child's exit for as long as it is
// willing to keep running at all.

const fs = require('fs');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

const accounts = require('./accounts');
// writeReparkClaim/clearReparkClaim: card #78's own claim-file I/O -- see journal.js's header on
// those functions for the full shape and the host/pid stamping. This module writes the claim (the
// dispatcher is the only process that knows the repark child's pid at spawn time) and clears it
// again on that child's exit; reparkCrashedTask (state-machine.js, running INSIDE the spawned
// child) also clears it as its own last statement, on every exit path -- both are idempotent
// unlinks, so whichever of the two runs first wins.
const { appendDaemonEvent, writeLiveWorkerIds, writeReparkClaim, clearReparkClaim } = require('./journal');
const { takeNextTask } = require('./state-machine');
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

// Builds the argv daemon.js's own --repark-task mode expects (see that file's header): the SAME
// mode flag and queue/journal roots this dispatcher's own process was started with -- for the same
// reason buildWorkerArgv forwards them: the repark's own finalizePark (a transient-retry branch is
// unreachable from a park, but the board move / gh comment it DOES perform must land against the
// SAME product repo and journal root this dispatcher's config names, not a throwaway). `--exit-code`
// and `--signal` carry the dead worker's own exit through, into finalizePark's 'worker-crashed'
// detail, exactly as the in-process call this replaces always passed them. Card #78 (this action):
// the dispatcher used to call state-machine.js's reparkCrashedTask directly, in-process, on the
// very thread finalizePark's own blocking spawnSync calls (measured worst case 2220s -- git push,
// `npm run board:move`, `gh issue comment`) could freeze; this argv is what lets it spawn a child
// to do that instead. See reparkCrashedWorker (inside createDispatcher, below) for the spawn/claim
// call site this argv feeds.
//
// `exitCode`/`signal` are omitted rather than forwarded as `null`/`undefined` text, same "omit a
// missing/invalid value rather than forward garbage" convention buildWorkerArgv/buildScannerArgv
// already use for `--workers` -- daemon.js's own parseArgs already defaults `opts.exitCode`/
// `opts.signal` to null when the flag is absent, so omitting here changes nothing a present-but-
// null value wouldn't already mean, it just keeps the argv shorter for the (common) signal-less
// crash case.
function buildReparkArgv(taskDir, queueDir, journalRoot, config, { exitCode, signal } = {}) {
  const modeFlag = config.shadowMode ? '--shadow' : config.dryRun ? '--dry-run' : '--real';
  const argv = [DAEMON_PATH, modeFlag, '--repark-task', taskDir, '--queue', queueDir, '--journal', journalRoot];
  if (Number.isInteger(exitCode)) argv.push('--exit-code', String(exitCode));
  if (signal) argv.push('--signal', String(signal));
  return argv;
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
  // Same injection idiom as spawn/spawnScanner above, for the THIRD child kind card #78 adds: a
  // one-shot `daemon.js --repark-task` (buildReparkArgv). Falls back to `deps.spawn` before
  // `realSpawn`, same fallback CHAIN spawnScannerFn uses and for the same reason: a test that wants
  // every child real (worker, scanner AND repark) only has to inject one function. A test that
  // instead sequences `deps.spawn` for a KNOWN NUMBER of WORKER crash codes, or hands it a fixture
  // that only fakes a worker's own exit (spawnExit-style), must inject `deps.spawnRepark`
  // separately -- exactly the same reason those tests already inject `deps.spawnScanner` rather
  // than let the scanner's own spawn consume an entry meant for a worker.
  const spawnReparkFn = deps.spawnRepark || deps.spawn || realSpawn;
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
  // id -> {pid, taskDir} -- card #78: a task whose crash is being reparked by a SPAWNED
  // `daemon.js --repark-task` child, tracked separately from `live` because it answers a DIFFERENT
  // question. `live` means "a worker owns this taskDir and is running the task machinery";
  // `reparking` means "no worker owns it any more, but a park for it is in flight in a child of
  // THIS process". The two must stay SEPARATE Maps, never merged into one table, because fillSlots'
  // own slot arithmetic (`live.size >= k`) must keep gating on task-OWNING workers ALONE -- a repark
  // child holds no worker slot and must not be charged against K (see fillSlots' own comment; a
  // real repark can run up to ~37 minutes, and letting it occupy a slot for that long would
  // reproduce a milder version of the very freeze this action removes). A single merged table could
  // not answer "how many slots are occupied" and "which ids are off-limits to takeNextTask" with
  // two different counts at once -- so the id-collision check (fillSlots' own comment on
  // takeNextTask's `liveIds` argument) instead combines the two, read-only, into a throwaway Set at
  // the one call site that needs the union, leaving each Map's own `.size` meaning exactly one thing.
  const reparking = new Map();
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
  //
  // `reparking` is ALSO never included here, and this is a card #78 DESIGN CHOICE, not an
  // oversight: the claim file (<taskDir>/repark-claim.json, journal.js's writeReparkClaim) must be
  // the SOLE thing that closes orphan-scan.js's double-repark race, so that revoking the claim
  // write demonstrably REOPENS the race -- test/dispatcher.test.js's own claim-order test pins
  // exactly that. Publishing a `live` UNION `reparking` set here would close the same race a SECOND
  // way, silently, and the claim would then no longer be provably load-bearing. It also happens to
  // be the more correct answer for auto-pull.js's own computeAutoPullBudget, which reads this exact
  // file for worker headroom (`in-flight + queued <= K`): a task mid-repark owns no worker slot
  // (fillSlots' own comment on why `live.size` alone still gates the slot arithmetic), so the slot
  // genuinely IS free, and this file answering "how many WORKER slots are occupied" rather than
  // "how many taskDirs are busy for any reason" is the honest question for that reader too.
  function publishLiveWorkerIds() {
    writeLiveWorkerIds(journalRoot, live.keys());
  }

  // Signals every live WORKER and the scanner (if one is running) -- both are spawned
  // `detached: true`, their own process group, so `process.kill(-pid, signal)` (the negative pid)
  // reaches each group's own `claude` child too. Renamed from an earlier `killAllWorkers` once
  // the scanner existed to supervise as well -- daemon.js's exit hook calls this one name for
  // both kinds of child now.
  //
  // `{ includeReparking }` (card #78, default false): a repark child (reparkCrashedWorker below) is
  // NEVER touched by an ordinary call to this function -- daemon.js's own exit hook and run()'s own
  // SIGTERM-then-wait shutdown both call it with the default, and that is deliberate: letting an
  // in-flight park finish is strictly better than the half-written park (state.json PARKED with no
  // park-comment anchor -- see handleExit's own header) a killed one would leave, unrecoverable by
  // any later `retry`. The ONE caller that passes `includeReparking: true` is
  // reapSignalledChildren's own SIGKILL escalation, below -- see that function's own comment for why
  // a SIGKILL, and only a SIGKILL, is allowed to reach a repark child.
  function killAllChildren(signal = 'SIGTERM', { includeReparking = false } = {}) {
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
    if (includeReparking) {
      for (const { pid } of reparking.values()) {
        if (!pid) continue;
        try {
          process.kill(-pid, signal);
        } catch {
          // Same best-effort posture as the worker loop above.
        }
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
  // see this module's own header for why that synchronicity still matters even though, since card
  // #78, it is no longer what closes the orphanScan double-repark race. Before #78 it was: this
  // function called finalizePark (also synchronous) IN-PROCESS, so a repark this exit warranted had
  // fully landed on disk before `live.delete(id)` (and the `publishLiveWorkerIds` call right after
  // it) ever ran, and no orphanScan pass -- indeed no other code in this process -- could interleave
  // anywhere inside this function's own body. That claim is FALSE of the code below: the actual
  // park now runs in a spawned `daemon.js --repark-task` child (reparkCrashedWorker, below), off
  // this process's own thread, and has not even started -- let alone landed on disk -- by the time
  // this function returns. What closes the race now is the CLAIM FILE reparkCrashedWorker writes
  // (journal.js's writeReparkClaim), which IS still written synchronously, before `live.delete(id)`
  // -- so a taskDir this table stops listing already has its repark-in-flight claim on disk for
  // orphan-scan.js's own concurrent scan (a SEPARATE process) to find. The synchronicity that
  // remains load-bearing is narrower than it used to be: not "the park landed", but "the claim
  // landed" -- see journal.js's own header on writeReparkClaim/readReparkClaim for the other half.
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
        reparkCrashedWorker(id, taskDir, code, signal);
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
  //
  // RECORDED, action 3.3, NOT ACTED ON -- an argument about the HEIGHT of scannerHealthyUptimeMs
  // (60s in production, config.js's Math.max(ORPHAN_SCAN_MS, UNPARK_SCAN_MS)), not about the shape
  // of this counter, and out of scope for this action either way: auto-triage genuinely runs on
  // the scanner's own process (state-machine.js's runForever), createScanTimers() seeds
  // `lastAutoTriageAt: null` so every fresh scanner is immediately due, and runAutoTriage really
  // does spawn a real `claude` child when it finds work -- so a crash landing while that spawn is
  // in flight is unconditionally read as "healthy" at a 60s bar even if the crash came seconds
  // after the spawn started. The bar was never tested against THAT case; it was tested against a
  // near-instant `spawnExit` crash (this file's own mock-clock tests above). But the trigger is
  // conditional, not standing: runAutoTriage only spawns when `findConfirmedAwaitingTriage` returns
  // something, and with nothing pending the cycle returns in milliseconds -- so the argument holds
  // only for crashes AFTER such a call has actually started, not for every crash on this path.
  //
  // AND it holds only where auto-triage runs at all, which is NOT this repo's own default:
  // `shouldAutoTriage` returns false outright whenever `autoTriageMs <= 0`, and config.js's
  // default for it is 0. Production reaches the case above only because an out-of-repo systemd
  // drop-in (`~/.config/systemd/user/spo-pipeline-daemon.service.d/`) sets SPO_AUTO_TRIAGE_MS to a
  // non-zero value; a stock checkout never spawns from this path and the argument is vacuous
  // there. Stated because the argument reads as unconditional without it, and a future reader
  // weighing the bar needs to know its premise lives outside the tree.
  //
  // Neither rejected option (a `totalScannerCrashes` ceiling, a windowed/decaying counter) touched
  // this either -- both operate on the counter's shape, and this is a claim about the constant it
  // is compared against. Left for a future card to weigh, not decided here.
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

  // Card #78: reparks a crashed worker's task by SPAWNING a one-shot `daemon.js --repark-task`
  // child (buildReparkArgv) rather than calling state-machine.js's reparkCrashedTask in-process, as
  // this dispatcher always did before. That in-process call ran finalizePark -- preserveWorktreeWip
  // (a `git` push) plus postParkComment's board move and `gh` comment, each a bounded-but-slow
  // spawnSync -- on the very thread that holds the single-instance lock, refills worker slots, and
  // services SIGTERM; measured worst case 2220s (config.js's own command timeouts), during which
  // this dispatcher could do none of those three things. This function is what gets that off the
  // dispatcher's own thread.
  //
  // Called from handleExit ONLY on a genuine crash (never on shutdown-signalled exits -- see that
  // function's own header), always synchronously and never awaited: everything below either
  // returns having done nothing durable, or has already written the claim file before it returns.
  //
  // ORDERING, on a successful spawn -- read top to bottom, because each step depends on the last
  // having already happened:
  //   1. spawn the child (spawnReparkFn) and confirm it actually has a pid;
  //   2. writeReparkClaim(taskDir, ...) SYNCHRONOUSLY, before this function returns -- this is the
  //      file orphan-scan.js's own concurrent scan (a SEPARATE process) reads to tell "already being
  //      reparked" apart from "orphaned, needs a fresh repark" (see that module's own header). It
  //      must exist on disk before `live.delete(id)` runs -- NOT the next line below (step 3, in
  //      THIS function), but the statement in handleExit, a DIFFERENT function, that runs once this
  //      whole function has returned to it -- or a scan landing in that exact window would see
  //      neither a live worker nor a claim and repark the same task a second time.
  //   3. record {pid, taskDir} in `reparking`, keyed by id -- this is the IN-MEMORY, THIS-PROCESS
  //      answer to the identical question the claim file answers cross-process: fillSlots' own
  //      takeNextTask call (below) must not hand a fresh queue entry for this exact id to a NEW
  //      worker while this repark is still in flight, which the claim file alone cannot prevent
  //      (takeNextTask and orphan-scan.js's claim check are different call sites entirely).
  //   4. journal 'worker-crash-repark-spawned' and register the child's own exit-watch in `pending`
  //      -- order between these two and step 3 does not matter, unlike 1->2->3, which does.
  //
  // A GRACEFUL DRAIN WAITS FOR THIS REPARK because of step 3, not step 4: run()'s own
  // awaitInFlight loops on `live.size > 0 || reparking.size > 0` (see that function's own
  // comment for the measured regression this closes), so the id staying in `reparking` is what
  // makes the drain's own budget -- not the much shorter reap grace -- the thing spent waiting for
  // it. `pending` (step 4) is not what makes the drain wait; it is what lets awaitInFlight's own
  // `Promise.race` WAKE the instant this exact child exits, instead of polling blindly to the
  // drain's full timeout every time -- the same "poll interval vs. exit-driven wake" distinction
  // this module's own header draws for ordinary workers.
  //
  // On the child's own exit (whenever that is -- seconds in the ordinary case, up to the ~37-minute
  // (2220s) worst case cited two paragraphs up, if every one of finalizePark's own spawnSync calls
  // hits its full command timeout): remove `id` from `reparking`, clear the claim (clearReparkClaim -- idempotent;
  // state-machine.js's reparkCrashedTask, running INSIDE that child, already clears it as its own
  // last statement on every exit path, so this is normally a no-op backstop for a child that died
  // before ever reaching that far), and journal 'worker-crash-repark-exit' with the child's own
  // outcome.
  //
  // ON A SPAWN FAILURE (step 1 throws, or returns a child with no pid): journal
  // 'worker-crash-repark-failed' with step: 'spawn' and return, WITHOUT writing a claim. This is
  // deliberate, not merely "the best we can do": with no claim on disk, the task's taskDir is
  // exactly the shape orphan-scan.js's own scan already knows how to recover -- non-terminal state,
  // no live owner, no claim -- so the NEXT orphan scan reparks it as an ordinary orphan. Writing a
  // claim for a child that was never actually spawned would instead hide the task from that scan
  // (a "repark in flight" that is not, in fact, in flight) until the claim's pid happens to collide
  // with a live process or a human notices the taskDir is stuck -- strictly worse than the fallback
  // this already has.
  function reparkCrashedWorker(id, taskDir, code, signal) {
    const argv = buildReparkArgv(taskDir, queueDir, journalRoot, config, { exitCode: code, signal });
    let child;
    try {
      child = spawnReparkFn(process.execPath, argv, { detached: true, stdio: 'ignore' });
      if (!child || !child.pid) throw new Error('spawnRepark did not return a child with a pid');
    } catch (err) {
      appendDaemonEvent(journalRoot, 'worker-crash-repark-failed', {
        id,
        exitCode: code,
        signal: signal || null,
        step: 'spawn',
        error: String((err && err.message) || err),
      });
      return;
    }

    writeReparkClaim(taskDir, { id, pid: child.pid, startedAt: new Date().toISOString() });
    reparking.set(id, { pid: child.pid, taskDir });
    appendDaemonEvent(journalRoot, 'worker-crash-repark-spawned', { id, pid: child.pid, taskDir });

    const p = watchChild(child)
      .then((result) => {
        reparking.delete(id);
        clearReparkClaim(taskDir);
        appendDaemonEvent(journalRoot, 'worker-crash-repark-exit', {
          id,
          pid: child.pid,
          code: result.code === undefined ? null : result.code,
          signal: result.signal || null,
        });
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  // Fills as many slots as K (re-clamped to healthy accounts, THIS instant) currently allows,
  // taking one task at a time via takeNextTask -- which is itself what makes "not the same task to
  // two workers" safe: the queue-file rename it performs is atomic, and this function calls it
  // serially (never concurrently with itself), so there is no race to fix here, only to preserve.
  // takeNextTask's own `liveIds` parameter (state-machine.js) is handed the UNION of the CURRENT
  // `live` table and `reparking` on every call -- not once per fillSlots invocation -- so a slot
  // freed by a worker that just finished (removed from `live` inside handleExit, which always
  // completes before this function is called again) is immediately visible.
  //
  // `reparking` MUST be in that union -- card #78 verification. `live.delete(id)` runs inside
  // handleExit BEFORE this exit's crash repark has landed anywhere but a spawned child's own,
  // not-yet-started process (see reparkCrashedWorker and handleExit's own header). Without
  // `reparking` here, a queue entry for that SAME id that is eligible RIGHT NOW -- reachable through
  // finalizePark's transient-retry branch, which writes a 60s-`notBefore` queue entry and returns
  // before ever writing PARKED, so the id can be both mid-repark and freshly re-queued at once --
  // reads a non-terminal state.json (UNDRAINABLE_STATES is TERMINAL_STATES minus PARKED, so a
  // mid-repark task is never refused on that ground) and takeNextTask would `fs.renameSync` a fresh
  // queue entry straight over task.json UNDER the repark child that is, at that exact moment, still
  // reading it. `live.size` is deliberately left alone below -- the slot arithmetic must keep gating
  // on task-OWNING workers only, so a slot frees at exactly the statement it always has; only the
  // id-collision check takeNextTask performs needs the wider set.
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
      const taken = takeNextTask(queueDir, journalRoot, new Set([...live.keys(), ...reparking.keys()]));
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
    // -- so if the pool goes idle, the daemon is restarted by a deploy (a `git pull` landing commits
    // in the deploy checkout, never a GitHub merge alone), and the pool recovers, the `returned` edge
    // is NEVER written, because the new process's flag started false. daemon.jsonl is then left
    // with a bare `dispatcher-idle-no-healthy-accounts` as its newest dispatcher edge, forever,
    // and any reader that answers "is the dispatcher idle right now" by walking back to the most
    // recent edge (console/dispatcher-status.js's computeDispatcherStatus, renamed by card #164;
    // was computeDispatcherIdleStatus; moved out of bin/spo by card #186 so `spo status` and the
    // dashboard deck share one derivation) reports a permanent false alarm --
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
    //
    // `reparking.keys()` is folded into `inFlight`/`survivors` alongside `live.keys()` -- a crash's
    // repark child is removed from `live` before this ever runs (handleExit's own header), so
    // reading `live` alone would silently drop it from both events. This matters specifically at
    // the TIMEOUT edge: awaitInFlight's own loop (see that function's own comment) now waits on
    // `reparking.size` too, but if the repark ALSO outlives the full drain timeoutMs, `live` can
    // already read empty while `reparking` still holds the id -- omitting it here would report
    // `drained: true` for a park that is, at that exact instant, about to be SIGKILLed by
    // reapSignalledChildren below. `live`/`reparking` never share an id at the same time (a task is
    // either a live worker or a reparking child, never both), so a plain concatenation needs no
    // dedupe.
    let waitedMs = 0;
    let survivors = [];
    if (drainRequest) {
      const inFlight = [...live.keys(), ...reparking.keys()];
      const timeoutMs = resolveDrainTimeoutMs(config);
      // `pid` (card #188): same source as `dispatcher-start`'s own `pid` field above, and for the
      // same reason -- a reader (console/dispatcher-status.js's computeDispatcherStatus) must be
      // able to tell a live drain from a process that died inside the wait without depending on
      // the matching `dispatcher-start` still being inside its own bounded read window. Wrapped
      // for the same reason as the `dispatcher-stopped`/`dispatcher-drain-end` emits below --
      // appendDaemonEvent does its own mkdirSync + appendFileSync, so on the ENOSPC/EPERM/EROFS
      // class of failure this record exists to survive, an unwrapped throw here would reject
      // run() itself and skip the wait entirely, turning a graceful drain into a crash before it
      // ever started. Best-effort; nothing left to record to, so nothing escapes either way.
      //
      // `reason` (card #188, driver decision): `stopReason` is ALREADY set by this point -- either
      // by `requestDrain` (which only ever sets it to `{reason: 'drain-requested', signal}` when
      // nothing else has, `if (!stopReason)` (`requestDrain`, below)) or by an EARLIER `stop()`
      // call that landed before `requestDrain` did (in-process API: recette.js calls stop() but
      // never requestDrain, and daemon.js never calls stop(), so from daemon.js this reads
      // 'drain-requested' in practice); a breaker's own assignment cannot precede a drain this
      // way -- it and the loop's drain gate run in one microtask chain. Reading `stopReason.reason`
      // here (rather than assuming every drain is `'drain-requested'`) records the ACTUAL decision
      // instead of asking a reader to infer it.
      try {
        appendDaemonEvent(journalRoot, 'dispatcher-drain-start', {
          signal: drainRequest.signal || null,
          timeoutMs,
          inFlight,
          pid: process.pid,
          reason: (stopReason && stopReason.reason) || null,
          // Card #188 follow-up: the grace the reap below will actually use once this wait ends
          // (`resolveDrainKillGraceMs(config)`, the SAME resolver `reapSignalledChildren` is
          // handed further down in run()) -- carried on the event itself so a reader
          // (console/dispatcher-status.js's computeDispatcherStatus) can bound an unconcluded
          // drain's own age without having to assume the READER's config matches the WRITER's.
          killGraceMs: resolveDrainKillGraceMs(config),
        });
      } catch {
        // Best-effort, same posture as the other journal writes on this shutdown path.
      }
      waitedMs = await awaitInFlight(timeoutMs);
      survivors = [...live.keys(), ...reparking.keys()];
      stopReason = { ...stopReason, drained: survivors.length === 0, waitedMs, survivors };
    }

    // Action 3.3 (card #162 hoist): the single place every stop path converges -- drain,
    // `stop-requested`, the worker-crash breaker and the scanner-crash breaker all set
    // `stopReason` before control ever reaches here (each assignment site guards itself with its
    // own `!stopReason` check, and the drain merge immediately above -- the last of the four to
    // run -- only ever spreads onto whichever of them got there first), so journalling here still
    // covers all four with one call rather than one at each assignment site. It is no longer
    // run()'s single RETURN -- that stays several statements below, past the kill and the reap --
    // but it is still the single point every stop path passes through, and now the last thing
    // that happens before anything else does. Before this action, the single most important event
    // in this subsystem existed only on stderr (daemon.js's `dispatcher stopped itself -- <JSON>`)
    // and as exit code 1; daemon.jsonl was structurally unable to show it. `appendDaemonEvent`
    // spreads `detail` flat, so `stopReason` itself lands as the event's own fields (`reason`,
    // plus whichever breaker/drain fields that particular stop path added) rather than nested
    // under a `detail` key.
    //
    // DELIBERATELY AHEAD OF `killAllChildren`/`reapSignalledChildren` BELOW, not merely left where
    // it first landed: `reapSignalledChildren` awaits, so it is the first point in this function
    // that genuinely yields the event loop, and a systemd `TimeoutStopSec` SIGKILL
    // (scripts/daemon-install.sh) lands exactly there if a straggler outlives its grace. Margin:
    // `drainTimeoutMs` 2700s + `drainKillGraceMs` 60s (config.js's DRAIN_TIMEOUT_MS /
    // DRAIN_KILL_GRACE_MS) against `TimeoutStopSec=2820` leaves 60s of slack for the reap itself --
    // raise either tunable without raising TimeoutStopSec to match, and that slack is exactly what
    // the reap eats into, which is why this record is written before the reap starts rather than
    // after it finishes: the one shutdown record that explains a SIGKILL cannot itself depend on
    // outliving one.
    //
    // `stopReason` is unreachable as null/undefined here in practice -- the only way out of the
    // `for (;;)` loop above is its own `if (stopReason) break`, so control never reaches this
    // point with `stopReason` still unset -- but guarded anyway rather than assuming that
    // invariant holds forever: a null stop reason has nothing meaningful to journal, so it simply
    // does not.
    if (stopReason) {
      try {
        appendDaemonEvent(journalRoot, 'dispatcher-stopped', stopReason);
      } catch {
        // Best-effort, same shape as the queue-claim guard (state-machine.js's takeNextTask) and
        // the two fs.renameSync sites in 62b3871/ae12962: appendDaemonEvent does mkdirSync +
        // appendFileSync, so on the exact ENOSPC/EPERM/EROFS class of failure this call exists to
        // report, the write itself can throw -- and unwrapped, that would turn a clean shutdown
        // into a crash on the way out, defeating this action on its own worst case. Nothing left
        // to record to; never let this escape either way.
        //
        // WORSE since card #162's hoist than when this guard was first written: `killAllChildren`
        // and `reapSignalledChildren` both run AFTER this emit now, so an escaping throw here
        // would skip both. daemon.js's own `process.once('exit')` hook (daemon.js:626-627) still fires
        // an ordinary `killAllChildren('SIGTERM')`, so live workers and the scanner are at least
        // signalled on the way out -- but nothing REAPS them: no bounded wait, no SIGKILL
        // escalation, so a straggler that ignores SIGTERM is handed straight back to systemd's
        // cgroup kill, the exact outcome `reapSignalledChildren` exists to prevent. A reparking
        // child is signalled by neither (that hook passes no `includeReparking`, daemon.js:607).
        // Measured in-process, where no such exit hook exists: with this guard deleted the test
        // fails its assertion and then never exits. One process survives -- the scanner stand-in,
        // un-signalled because `killAllChildren` was skipped; it never exits on its own and its
        // live handle holds the test process's event loop open.
      }
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
      //
      // Action 3.3, from verification: this write is wrapped for a reason specific to its
      // POSITION, not merely for symmetry with the guarded `dispatcher-stopped` emit above --
      // `appendDaemonEvent` does its own mkdirSync + appendFileSync, so on the ENOSPC/EPERM/EROFS
      // class that emit exists to report, an unwrapped throw HERE still rejects out of `run()` and
      // turns a clean shutdown into a crash on its way out. CORRECTED after card #162's hoist: it
      // no longer costs the `dispatcher-stopped` record the way it used to -- that event is now
      // written BEFORE this one, ahead of the kill and the reap, so it is already on disk by the
      // time this write could fail. What an unwrapped throw here would still cost is this record
      // itself, `drain-end`, the one fact this particular write exists to add.
      try {
        appendDaemonEvent(journalRoot, 'dispatcher-drain-end', {
          drained: survivors.length === 0,
          waitedMs,
          survivors,
          outcomes: postSignalOutcomes.filter((o) => survivors.includes(o.id)),
        });
      } catch {
        // Best-effort, same posture as every other journal write added in this lot: nothing left
        // to record to, and never let it escape.
      }
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
  //
  // CARD #78 CORRECTION: this function's own SIGKILL escalation must reach a repark child too, or
  // its "genuinely bounded" claim below is false for one. `pending` (what `all` awaits) has
  // included a repark child's own watchChild promise since reparkCrashedWorker started adding it,
  // but that alone never made THIS function wait FOR one -- `pending` only lets `all` (and
  // awaitInFlight's own race, a separate mechanism -- see that function's own comment) resolve the
  // instant a promise it already contains settles; it does not, by itself, keep this function from
  // reaching the SIGKILL escalation while a repark is still running. `killAllChildren('SIGKILL')`,
  // called with no arguments, never signals anything in `reparking` (see that function's own
  // header: an ordinary call must never touch a repark child, so a park in progress is allowed to
  // finish rather than being cut off half-written). Measured directly: a repark child with a REAL,
  // signallable pid that ignores SIGTERM (the honest shape -- a pid-less spawn is a spawn FAILURE
  // reparkCrashedWorker's own header already handles, journalled and returned before `reparking` or
  // `pending` are ever touched, so it never reaches this function at all). With no `includeReparking`,
  // `killAllChildren('SIGKILL')` never sends that pid anything -- it is absent from `live`, the only
  // Map this function iterates by default -- so the pid was still alive and `run()` still had not
  // resolved 6+ seconds after a drain was requested (the probe's own measurement bound), even though
  // `dispatcher-kill-escalated` had already fired and correctly named it in `stillReparking`: the
  // escalation ran, diagnosed the problem by name, and then signalled nothing. With
  // `{ includeReparking: true }` (the fix below) the identical fixture's child was SIGKILLed and
  // `run()` resolved in ~600ms. The fix is the one call below that passes `{ includeReparking: true
  // }`: it is the ONLY place in this module a repark child is ever signalled, and SIGKILL is the right (and
  // only) signal for it to receive here -- letting a park run to completion is strictly better than
  // killing it (handleExit's own header), but a shutdown still has to end, and a repark child that
  // has already had its full graceMs and still has not exited is exactly the "ignores everything
  // but SIGKILL" case this function exists to bound. This function is reached in TWO shapes: a
  // circuit-breaker trip (no drain at all -- a repark in flight gets exactly this graceMs, never
  // the longer drain budget), and a GRACEFUL DRAIN whose own timeoutMs has ALSO expired with a
  // repark still running -- awaitInFlight's own `reparking.size` check (a separate, later fix on
  // this same card) is what makes the ordinary case wait out the drain's full budget instead of
  // landing here at all; this escalation is the backstop for the two cases where that is not enough.
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
      stillReparking: [...reparking.keys()],
    });
    killAllChildren('SIGKILL', { includeReparking: true });
    await all; // SIGKILL is not refusable and now reaches every child in `pending`, repark included -- genuinely bounded
  }

  // Waits for `live` AND `reparking` to both empty, up to timeoutMs; returns how long it actually
  // waited. Woken by any child's exit, not merely by the poll -- so a card that finishes one second
  // into a 45-minute bound ends the drain one second in, and a `systemctl restart` on an IDLE
  // daemon costs nothing at all. Measured on the elapsed clock (monotonicNowMsFn, the same seam the
  // scanner breaker uses), never Date.now(): a bound that a clock step could double or erase is not
  // a bound.
  //
  // `reparking` MEASURED FIX (post-#78 verification): this loop used to check `live.size` alone,
  // so a crash's repark child -- already removed from `live` the instant handleExit ran (see that
  // function's own header) -- was invisible to the drain entirely. A graceful drain then returned
  // the moment the last WORKER exited, spending none of its (up to 45-minute) budget on a repark
  // that might still be running, and handed the child straight to reapSignalledChildren, which
  // SIGKILLs it after `drainKillGraceMs` (production default 60s) -- against a repark whose own
  // worst-case spawnSync budget is 2220s. Measured directly: a well-behaved 3s repark child, a
  // 20000ms drain budget, a 500ms grace -- the drain returned in 521ms, `dispatcher-kill-escalated`
  // fired with `stillReparking: [id]`, and the child was SIGKILLed mid-work. That is not a slow
  // shutdown, it is the exact failure handleExit's own header cites as worse than waiting:
  // finalizePark writes state.json PARKED BEFORE postParkComment posts the park-comment anchor, so
  // a SIGKILL between those two leaves a PARKED card unparkScan can never find again. Checking
  // `reparking.size` here is what spends the DRAIN's own budget on an in-flight park instead of the
  // much shorter reap grace -- the SIGKILL escalation below is untouched and stays the final bound,
  // reached only if the repark ALSO outlives the drain's full timeout.
  async function awaitInFlight(timeoutMs) {
    const startedAt = monotonicNowMsFn();
    const elapsed = () => monotonicNowMsFn() - startedAt;
    while (live.size > 0 || reparking.size > 0) {
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
  buildReparkArgv, // exported for the same reason -- card #78's own direct unit test
};
