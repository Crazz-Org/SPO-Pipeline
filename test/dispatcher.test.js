'use strict';
// Tests for orchestrator/dispatcher.js -- action 6.3's K-worker main loop. See that module's own
// header for the full design (K defaults to 1, one code path for every K; K re-clamped to healthy
// accounts before every spawn; scans serviced on their own schedule while workers run; the
// live-worker table; the crash classifier and circuit breaker).
//
// "Where a real behaviour can be tested with real processes, do that" (this action's own
// instruction): every test below spawns REAL child processes -- either the real
// `orchestrator/daemon.js --worker` (via config.deps.spawn's default, isolated the same way
// every other daemon subprocess in this suite is) for tests proving genuine end-to-end worker
// behaviour, or a tiny real `node -e` script (via an injected config.deps.spawn) for tests that
// only need a REAL process producing a deterministic, fast, specific exit code to exercise the
// dispatcher's OWN bookkeeping (crash classification, the circuit breaker) without paying for a
// full daemon.js boot every time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident this closes, and why this require
// has to land before the orchestrator require(s) below.
require('./no-real-spawn');

const defaultConfig = require('../orchestrator/config');
const accounts = require('../orchestrator/accounts');
const { writeState: writeTaskState, readLiveWorkerIds, writeLiveWorkerIds, liveWorkersPath } = require('../orchestrator/journal');
const { createDispatcher } = require('../orchestrator/dispatcher');
const { takeNextTask } = require('../orchestrator/state-machine');
const { mkTmp, writeTask, writePoolDir, isolatedEnv, readState, readJournal, DAEMON } = require('./helpers');

function readDaemonEvents(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Real `child_process.spawn`, but every child gets the SAME throwaway product-repo/worktrees/
// accounts/bench isolation every other daemon subprocess in this suite gets (test/helpers.js's
// isolatedEnv) -- a dispatcher spawning workers in-process (as these tests do, calling
// createDispatcher directly rather than going through daemon.js's own CLI/execFileSync) would
// otherwise hand a worker child THIS test process's bare, unisolated environment.
function spawnIsolated(cmd, args, opts) {
  return realSpawn(cmd, args, { ...opts, env: isolatedEnv() });
}

// A tiny real process that does nothing but exit with a specific code, for tests that only need
// to drive the dispatcher's OWN crash classifier/circuit-breaker bookkeeping -- see this file's
// own header. Ignores the real daemon.js argv entirely; `cmd`/`args` are what dispatcher.js built,
// discarded on purpose.
function spawnExit(code) {
  return () => realSpawn(process.execPath, ['-e', `process.exit(${code})`], { stdio: 'ignore' });
}

// Same shape as spawnExit above, but the child sleeps `ms` (real wall-clock time, via the child's
// OWN setTimeout -- there is nothing to fake here, the point of the ONE test that still uses this
// is a REAL elapsed interval for dispatcher.js's own monotonicNowMs-based uptime read to measure)
// before exiting with `code`.
//
// `opts` IS FORWARDED, unlike an earlier version of this helper -- without it the child is never
// `detached: true`, so it is never its own process-group leader, and killAllChildren's
// `process.kill(-pid, signal)` (the negative pid targets a GROUP) throws ESRCH into a swallowed
// catch instead of reaching it. That is not cosmetic: this file's own `finally` teardown then
// does `await Promise.allSettled(pending)`, which waits the child's own `ms` out for real instead
// of the signal killing it early -- measured as ~1.2s of dead teardown time per use before this
// forward existed. See neverExitsSpawn's own comment above for the identical reasoning.
function spawnScannerAliveFor(ms, code) {
  return (cmd, args, opts) =>
    realSpawn(process.execPath, ['-e', `setTimeout(() => process.exit(${code}), ${ms})`], { ...opts, stdio: 'ignore' });
}

// A tiny queue-backed fake clock for `deps.monotonicNowMs` (the injection seam createDispatcher
// exposes for exactly this): each call returns the next value from `sequence`, in order, and
// throws if called more times than the sequence provides -- an over-call is a sign the test's own
// call-count model of spawnScanner/handleScannerExit (one read at spawn, one read at exit, per
// scanner lifecycle) has drifted from the real code, which is a bug in the TEST, not something to
// silently tolerate by returning `undefined` or looping the sequence.
//
// This is what lets the scannerHealthyUptimeMs tests below assert on a PRECISE, deterministic
// uptime (e.g. "this crash is exactly 50ms, that one is exactly 1300ms") using ordinary
// near-instant real child processes (spawnExit), instead of an actual `setTimeout`-driven child
// whose real wall-clock survival time the test would otherwise have to wait out. Production always
// gets the real monotonicNowMs (deps.monotonicNowMs is only ever set here, in a test) -- see
// createDispatcher's own comment on the seam, and the one test below that deliberately leaves it
// un-injected to prove the production wiring still works end to end with a real clock.
function mockClock(sequence) {
  let i = 0;
  return () => {
    if (i >= sequence.length) {
      throw new Error(`mockClock: called ${i + 1} times but only ${sequence.length} values were queued`);
    }
    return sequence[i++];
  };
}

// A real, but inert, stand-in for the scanner -- lives far longer than any test's own timeout and
// exits on nothing this file does except the dispatcher's own killAllChildren (SIGTERM) in
// cleanup. Every test below that hands `deps.spawn` a crash-code SEQUENCE for a KNOWN NUMBER of
// WORKER spawns must also hand this to `deps.spawnScanner` -- see dispatcher.js's own header on
// why createDispatcher's `spawnScannerFn` exists as a separate hook: without it, the scanner's own
// spawn call (made once, up front, inside run()) would consume the FIRST entry of that sequence,
// and a "crashing" scanner respawning itself would keep consuming more, desynchronizing every
// worker spawn that follows and potentially tripping the SCANNER's own breaker before the test's
// worker assertions are ever reached.
// Forwards `opts` (in particular `detached: true`) exactly as dispatcher.js's own spawnScanner
// call site passes it -- without that, this process is never its own process-group leader, and
// killAllChildren's `process.kill(-pid, signal)` (the negative pid targets a GROUP) silently fails
// to reach it. That is not a cosmetic bug: run()'s own cleanup `await
// Promise.allSettled(pending)` then waits forever on this scanner-stand-in's exit-watch promise,
// hanging every test that uses this helper. Measured directly during this file's own rewrite.
function neverExitsSpawn(cmd, args, opts) {
  // Self-terminating if ORPHANED, using the exact `--parent-pid` technique action 6.6 gave the
  // real scanner (state-machine.js's runForever): remember the pid that spawned us and exit as
  // soon as the kernel reparents us away from it. Without this the stand-in is an actual process
  // leak, not a theoretical one -- it is spawned `detached: true` (its own process group, which
  // it must be, or killAllChildren's `process.kill(-pid, ...)` cannot reach it), so a SIGKILL to
  // the TEST RUNNER's process group never reaches this child, and `setInterval(..., 1e6)` then
  // runs forever with no parent. MEASURED: 5 leaked stand-ins across 6 SIGKILLs timed between
  // 1.5s and 4.0s into this file, versus 0 with this check. A killed suite must not leave
  // processes on the box, and the fix is the one the production code already uses.
  return realSpawn(
    process.execPath,
    ['-e', 'const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(0); }, 50);'],
    { ...opts, stdio: 'ignore' }
  );
}

function baseConfig(overrides = {}) {
  return {
    ...defaultConfig,
    shadowMode: true,
    dryRun: false,
    real: false,
    stepDeadlineMs: 30000,
    pollIntervalMs: 30, // short bound, not a real-world value -- keeps every test's own polling fast
    productRepo: mkTmp('spo-disp-product-'),
    pipelineWorktreesDir: mkTmp('spo-disp-worktrees-'),
    spoBenchDir: mkTmp('spo-disp-bench-'),
    workers: 1,
    workerCrashLimit: 3,
    orphanScanMs: 0,
    unparkScanMs: 0,
    autoPullMs: 0,
    autoIntakeMs: 0,
    reportConfirmScanMs: 0,
    autoTriageMs: 0,
    remoteReportPullMs: 0,
    ...overrides,
  };
}

function onePoolDir(n = 1) {
  const dir = mkTmp('spo-disp-accts-');
  writePoolDir(
    dir,
    Array.from({ length: n }, (_, i) => ({ name: `acct${i}` }))
  );
  return dir;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `predicate` is called repeatedly until it returns truthy or `timeoutMs` elapses. Every call is
// wrapped in try/catch: most predicates here read a file (state.json, daemon.jsonl) that does not
// exist YET -- readState/readJournal throw ENOENT rather than returning falsy -- and "the file
// isn't there yet" must mean "keep waiting", not "fail the whole poll on the very first tick".
async function waitFor(predicate, timeoutMs = 10000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (predicate()) return;
    } catch {
      // not ready yet -- see the header comment above.
    }
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await sleep(intervalMs);
  }
}

// Fixture shape proven to reach DONE end-to-end in shadow mode with a configurable IMPLEMENT
// delay -- copied verbatim from test/lock.test.js's own "two workers run CONCURRENTLY" test
// (which established it), so its behaviour is not being re-derived here, just reused.
function slowDoneTask(id, implementDelayMs) {
  return {
    id,
    kind: 'synthetic',
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: implementDelayMs } },
  };
}

// ---- 1. K=1: a task runs to DONE through a real spawned worker; worker-spawn/worker-exit journalled

test('K=1: a task runs to DONE through a real spawned worker; worker-spawn/worker-exit are journalled', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-t1.json', { id: 't1', kind: 'synthetic', shadow: { forceState: 'DONE' } });

  const config = baseConfig({ claudeAccountsDir: onePoolDir(1), deps: { spawn: spawnIsolated } });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => {
      const s = readState(journalDir, 't1');
      return s && s.state === 'DONE';
    });
    // Wait for the worker-EXIT event itself before calling stop(), not just the DONE state.
    // state.json DONE is written by the worker (state-machine.js) BEFORE it exits; if stop()
    // races ahead of the real exit, run()'s own killAllChildren('SIGTERM') on its way out can
    // catch the worker still inside its exit path, and watchChild's 'exit' handler then observes
    // (code: null, signal: 'SIGTERM') instead of the real (0, null) -- a real race, measured at
    // ~10% (36/40 clean, 4/40 SIGTERM'd, all still finishing DONE regardless). Waiting on the
    // event that actually means "the worker is gone" -- not the state write that merely precedes
    // it -- is what test 3 below (the PARK case) already does, and why it never flakes.
    // Explicit timeout, shorter than the DONE wait above it: this test's own {timeout: 30000}
    // must cover BOTH sequential waitFor calls, and waitFor's own 10000ms default on each would
    // let a loaded box exhaust the test's whole budget as an opaque node:test timeout instead of
    // a readable assertion failure -- in practice this event is already true (or true within
    // milliseconds) by the time the DONE wait above resolves, since the worker's own exit follows
    // its state.json write immediately.
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-exit' && e.id === 't1'), 8000);
  } finally {
    dispatcher.stop();
    await runPromise;
  }

  const events = readDaemonEvents(journalDir);
  const spawnEvt = events.find((e) => e.event === 'worker-spawn' && e.id === 't1');
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 't1');
  assert.ok(spawnEvt, 'no worker-spawn event for t1');
  assert.equal(typeof spawnEvt.pid, 'number');
  assert.ok(exitEvt, 'no worker-exit event for t1');
  assert.equal(exitEvt.code, 0);
  assert.equal(exitEvt.outcome, 'done');
});

// ---- 2. K=2: two tasks run concurrently; prove real overlap (not just both finishing)

test('K=2: two tasks run concurrently -- real overlap, not two runs that merely both finished', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-a.json', slowDoneTask('disp-a', 200));
  writeTask(queueDir, '0002-b.json', slowDoneTask('disp-b', 200));

  const config = baseConfig({ workers: 2, claudeAccountsDir: onePoolDir(2), deps: { spawn: spawnIsolated } });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn').length >= 2);

    // Both spawned, and per K=2 they should have been spawned close enough together in wall time
    // that BOTH pids are still alive right now -- process.kill(pid, 0) is the exact liveness probe
    // lock.js's own processAlive uses.
    const spawns = readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn');
    assert.equal(spawns.length, 2);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(alive(spawns[0].pid), true, 'worker A already exited -- not a real overlap window');
    assert.equal(alive(spawns[1].pid), true, 'worker B already exited -- not a real overlap window');

    await waitFor(() => {
      const a = readState(journalDir, 'disp-a');
      const b = readState(journalDir, 'disp-b');
      return a && a.state === 'DONE' && b && b.state === 'DONE';
    });
    // Wait for BOTH worker-exit events, not just the DONE states, before stop() -- see the K=1
    // test's comment above for the exact race (state.json DONE precedes the real process exit;
    // stop()'s killAllChildren('SIGTERM') can otherwise land on a worker still inside its own exit
    // path and turn a clean (0, null) into a (null, 'SIGTERM')). Nothing here asserts an exit code
    // yet, but the next person to add one (as :161 eventually did) must not inherit this flake.
    // Explicit, shorter-than-default timeout -- same reasoning as the K=1 test's own comment
    // above: this test's {timeout: 30000} has to cover every waitFor call in the try block, and
    // a 10000ms default here would risk the whole thing surfacing as an opaque node:test timeout
    // rather than a readable failure on a loaded box.
    await waitFor(() => {
      const ev = readDaemonEvents(journalDir).filter((e) => e.event === 'worker-exit');
      return ev.some((e) => e.id === 'disp-a') && ev.some((e) => e.id === 'disp-b');
    }, 8000);
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// ---- 3. A worker exiting 20 (PARKED) is NOT reparked and does NOT trip the breaker

test('a worker that legitimately PARKs (exit 20) is not reparked by the dispatcher and does not trip the breaker', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  // NONSENSE_STATE is the same fixture worker-mode.test.js uses to force a real PARKED (via the
  // catch-all's 'unrecognized-state' ParkSignal) -- exit 20, not a crash.
  writeTask(queueDir, '0001-p.json', { id: 'disp-park', kind: 'synthetic', shadow: { forceState: 'NONSENSE_STATE' } });

  const config = baseConfig({ claudeAccountsDir: onePoolDir(1), deps: { spawn: spawnIsolated } });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => {
      const s = readState(journalDir, 'disp-park');
      return s && s.state === 'PARKED';
    });
    // Give the dispatcher's own handleExit a moment to have run (state.json PARKED is written by
    // the worker itself, inside runTask, BEFORE the process exits and the dispatcher observes it).
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-exit' && e.id === 'disp-park'));
  } finally {
    dispatcher.stop();
    await runPromise;
  }

  const events = readDaemonEvents(journalDir);
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'disp-park');
  assert.equal(exitEvt.code, 20);
  assert.equal(exitEvt.outcome, 'parked');
  // The dispatcher must never have written its own second park on top of the worker's genuine one
  // -- 'worker-crashed' is the reason it would use if it (wrongly) treated this as a crash.
  assert.equal(events.some((e) => e.event === 'worker-crash-repark-failed'), false);
  const taskJournal = readJournal(journalDir, 'disp-park');
  assert.equal(taskJournal.filter((e) => e.event === 'parked').length, 1, 'exactly one park -- the worker\'s own, never a second dispatcher-side one');
  assert.equal(taskJournal.some((e) => e.reason === 'worker-crashed'), false);
});

// ---- 4. A worker exiting a crash code IS reparked worker-crashed, exit code in the detail

test('a worker exiting an unrecognized code IS reparked worker-crashed, with the exit code in the detail', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-c.json', { id: 'disp-crash', kind: 'synthetic' });

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(7), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => {
      const s = readState(journalDir, 'disp-crash');
      return s && s.state === 'PARKED';
    });
  } finally {
    dispatcher.stop();
    await runPromise;
  }

  const state = readState(journalDir, 'disp-crash');
  assert.equal(state.reason, 'worker-crashed');
  const events = readDaemonEvents(journalDir);
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'disp-crash');
  assert.equal(exitEvt.code, 7);
  assert.equal(exitEvt.outcome, 'crashed');
  const taskJournal = readJournal(journalDir, 'disp-crash');
  const parkEvt = taskJournal.find((e) => e.event === 'parked');
  assert.equal(parkEvt.reason, 'worker-crashed');
  assert.equal(parkEvt.detail.exitCode, 7);
});

// ---- action 7.3: a worker exiting AFTER its taskDir is already terminal must NOT be reparked ----
//
// reparkCrashedWorker (dispatcher.js) checks state.json's state BEFORE ever calling finalizePark:
// DONE/PARKED/ABANDONED short-circuit straight to a bare `worker-exit-after-terminal` daemon
// event and nothing else -- dispatcher.js's own header calls this the "believed unreachable, but
// not asserted so" case of a worker producing more exit-path activity after its own outcome is
// already durable on disk. It matters because finalizePark is NOT idempotent against a taskDir
// that already has an outcome: calling it here would make the crash-repark path a SECOND writer
// racing the terminal write that already legitimately happened -- overwriting a genuine DONE with
// a spurious PARKED worker-crashed, and (worse, in the DONE case) posting a park comment on an
// issue whose PR the pipeline may already have opened. Nothing upstream of this function prevents
// that from being reachable: a stray SIGKILL to a grandchild, a delayed OS signal after runTask's
// own process.exit(0) call raced its own cleanup -- this check is the only thing standing between
// that and a corrupted terminal task.
test('a worker exiting non-zero AFTER its taskDir already reads DONE is journalled worker-exit-after-terminal, never reparked', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-t.json', { id: 'disp-post-terminal', kind: 'synthetic' });

  // Pre-seeds the taskDir with a state.json that already reads DONE, as if a prior (unmodelled)
  // worker process had already run this task to completion durably on disk -- takeNextTask's own
  // fs.mkdirSync(taskDir, {recursive: true}) tolerates the directory already existing, so this
  // does not interfere with the dispatcher's ordinary claim of the queue entry below.
  const taskDir = path.join(journalDir, 'disp-post-terminal');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({ id: 'disp-post-terminal', state: 'DONE' }));

  // spawnExit(7): a real process that does nothing but exit 7 -- classifyWorkerExit(7) is
  // 'crashed', which is exactly the outcome that would ordinarily call reparkCrashedWorker.
  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(7), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() =>
      readDaemonEvents(journalDir).some((e) => e.event === 'worker-exit-after-terminal' && e.id === 'disp-post-terminal')
    );
  } finally {
    dispatcher.stop();
    await runPromise;
  }

  const events = readDaemonEvents(journalDir);
  const afterTerminal = events.find((e) => e.event === 'worker-exit-after-terminal' && e.id === 'disp-post-terminal');
  assert.equal(afterTerminal.exitCode, 7);
  assert.equal(afterTerminal.signal, null);
  assert.equal(afterTerminal.lastState, 'DONE');

  // state.json must read EXACTLY what it did before this exit -- the short-circuit returned
  // before finalizePark's own writeState(ctx.taskDir, snap) ever ran.
  const state = readState(journalDir, 'disp-post-terminal');
  assert.equal(state.state, 'DONE');

  // The negatives that carry the actual meaning: no daemon-level `parked` event, no task-level
  // `parked` event, and no report.md -- all three are things ONLY finalizePark writes, and this
  // path never reaches it.
  assert.equal(events.some((e) => e.event === 'parked' && e.id === 'disp-post-terminal'), false);
  const taskJournal = readJournal(journalDir, 'disp-post-terminal');
  assert.equal(taskJournal.some((e) => e.event === 'parked'), false);
  assert.equal(fs.existsSync(path.join(taskDir, 'report.md')), false, 'finalizePark must never have run -- it writes report.md unconditionally on every park');
});

// Action 6.5: reparkCrashedWorker restores the same four counters orphan-scan.js does, and for
// the same reason -- finalizePark rewrites state.json through snapshot(), so a counter not
// restored here is not merely missing from the park report, it is OVERWRITTEN with 0 and the
// card's record then denies attempts that really happened. mainMoveUsed is the one that changed
// shape in 6.5 (boolean -> count), and this path had no test of its own at all: restoring it
// with `!!` instead of a numeric coercion passed the entire suite. A legacy pre-6.5 boolean is
// covered here too -- the post-merge hook SIGTERMs this daemon on every deploy, so a card
// mid-flight across the upgrade is the ordinary case.
test('a crashed worker\'s repark preserves the COUNT in mainMoveUsed, and upgrades a pre-6.5 boolean instead of flattening it', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-c.json', { id: 'disp-counters', kind: 'synthetic' });
  writeTask(queueDir, '0002-c.json', { id: 'disp-legacy', kind: 'synthetic' });

  // The state each worker had already written before it died.
  for (const [id, extra] of [
    ['disp-counters', { diagnoseAttempts: 3, validateRejects: 2, ciImplementRetries: 2, mainMoveUsed: 3 }],
    ['disp-legacy', { mainMoveUsed: true }], // written by a pre-6.5 daemon
  ]) {
    const dir = path.join(journalDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ id, state: 'CI_CHECKS', prNumber: 99, ...extra })
    );
  }

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(7), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => {
      const a = readState(journalDir, 'disp-counters');
      const b = readState(journalDir, 'disp-legacy');
      return a && a.state === 'PARKED' && b && b.state === 'PARKED';
    });
  } finally {
    dispatcher.stop();
    await runPromise;
  }

  const counted = readState(journalDir, 'disp-counters');
  assert.equal(counted.diagnoseAttempts, 3);
  assert.equal(counted.validateRejects, 2);
  assert.equal(counted.ciImplementRetries, 2);
  assert.strictEqual(counted.mainMoveUsed, 3, 'the count must survive the repark, not collapse to true/1');

  const legacy = readState(journalDir, 'disp-legacy');
  assert.strictEqual(legacy.mainMoveUsed, 1, 'a pre-6.5 boolean true is the 1 the counter now means');
});

// ---- 5. N consecutive crashes trip the breaker and the dispatcher exits non-zero; a 0/20 in between resets it

test('N consecutive crashes trip the circuit breaker; a PARK in between resets the count', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  for (let i = 1; i <= 5; i++) {
    writeTask(queueDir, `000${i}-x.json`, { id: `disp-x${i}`, kind: 'synthetic' });
  }

  let call = 0;
  // crash, crash, PARK (resets), crash, crash -- with a limit of 3, this sequence must NOT trip
  // until AFTER the fifth task's crash: 2 crashes, a reset, then 2 more (never reaching 3 in a
  // row). Proven by running only these 5 and asserting the breaker is still untripped.
  const spawnSequenceA = [() => spawnExit(1)(), () => spawnExit(1)(), () => spawnExit(20)(), () => spawnExit(1)(), () => spawnExit(1)()];
  const spawnA = (cmd, args, opts) => {
    const fn = spawnSequenceA[Math.min(call, spawnSequenceA.length - 1)];
    call += 1;
    return fn();
  };

  const configA = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    workerCrashLimit: 3,
    deps: { spawn: spawnA, spawnScanner: neverExitsSpawn },
  });
  const dispatcherA = createDispatcher(queueDir, journalDir, configA);
  const runA = dispatcherA.run();
  let stoppedReasonA;
  try {
    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'worker-exit').length >= 5);
    await sleep(80); // give the loop a couple more idle iterations to (not) trip
  } finally {
    dispatcherA.stop();
    stoppedReasonA = await runA;
  }
  assert.equal(stoppedReasonA.reason, 'stop-requested', 'the breaker tripped when it should have been reset by the PARK in the middle');

  // Second dispatcher, fresh queue, three crashes in a row with no reset: MUST trip.
  const queueDirB = mkTmp('spo-disp-q-');
  const journalDirB = mkTmp('spo-disp-j-');
  for (let i = 1; i <= 3; i++) {
    writeTask(queueDirB, `000${i}-y.json`, { id: `disp-y${i}`, kind: 'synthetic' });
  }
  const configB = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    workerCrashLimit: 3,
    deps: { spawn: spawnExit(1), spawnScanner: neverExitsSpawn },
  });
  const dispatcherB = createDispatcher(queueDirB, journalDirB, configB);
  const stopReasonB = await dispatcherB.run(); // resolves on its own once the breaker trips
  assert.equal(stopReasonB.reason, 'worker-crash-circuit-breaker');
  assert.equal(stopReasonB.consecutiveCrashes, 3);
  assert.equal(stopReasonB.crashLimit, 3);
});

// ---- 6b. A worker killed BY THIS DISPATCHER'S OWN SHUTDOWN is not a crash (cross-action defect)

// handleExit used to ignore `stopReason` entirely, while handleScannerExit checked it first --
// an asymmetry that made every shutdown park whatever card happened to be in flight. run()'s
// shutdown path is `killAllChildren('SIGTERM'); await Promise.allSettled(pending)`, so it
// deliberately WAITS for these exits: 143 is not 0 and not 20, classifyWorkerExit says 'crashed',
// and a healthy card got `reason: 'worker-crashed'` written over it. Deterministic, not a race.
//
// The park is worse than merely wrong. finalizePark writes state.json PARKED BEFORE
// postParkComment posts the anchor comment, and this all runs inside a process systemd SIGKILLs
// at TimeoutStopUSec=1min30s -- a kill between those two writes leaves PARKED with no
// `park-comment` line, park-loop.js's findParkAnchor returns null, and unparkScan skips the card
// on every cycle FOREVER (orphanScan skips it too: PARKED is terminal). The card leaves the
// retry channel permanently. Not reparking defers to orphan-scan.js instead, which is the path a
// deploy-time group SIGTERM has always used anyway.
test('a worker killed by the dispatcher\'s OWN shutdown is never reparked worker-crashed', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-s.json', { id: 'disp-shutdown', kind: 'synthetic' });

  // A live, healthy, long-running worker: it exits ONLY when killAllChildren signals it.
  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: neverExitsSpawn, spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn' && e.id === 'disp-shutdown'));
  dispatcher.stop({ reason: 'simulated-deploy-shutdown' });
  const stopped = await runPromise;

  assert.equal(stopped.reason, 'simulated-deploy-shutdown', 'the stop reason must survive -- a counted shutdown exit could rewrite it as a breaker trip');

  // The dispatcher observed the 143/SIGTERM exit it caused...
  const events = readDaemonEvents(journalDir);
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'disp-shutdown');
  assert.ok(exitEvt, 'the worker exit was never observed -- this test proves nothing');
  assert.equal(exitEvt.duringShutdown, true, 'the exit must be recorded as a shutdown exit, not an anonymous crash');
  assert.ok(
    events.some((e) => e.event === 'worker-exit-during-shutdown' && e.id === 'disp-shutdown'),
    'a shutdown-time worker exit must be journalled as such'
  );

  // ...and must NOT have parked the card. state.json is whatever the worker last wrote (here:
  // nothing at all, since the stand-in never runs runTask) -- never a dispatcher-written PARKED.
  let state = null;
  try {
    state = readState(journalDir, 'disp-shutdown');
  } catch {
    state = null; // no state.json at all is the correct outcome for this stand-in
  }
  if (state) {
    assert.notEqual(state.state, 'PARKED', 'a healthy in-flight card was parked by its own dispatcher shutting down');
    assert.notEqual(state.reason, 'worker-crashed');
  }
  const taskJournal = (() => {
    try {
      return readJournal(journalDir, 'disp-shutdown');
    } catch {
      return [];
    }
  })();
  assert.equal(
    taskJournal.some((e) => e.event === 'parked' && e.reason === 'worker-crashed'),
    false,
    'the dispatcher parked worker-crashed on a card it killed itself'
  );
});

// A circuit-breaker trip must stop the daemon WITHOUT taking the other, healthy worker's card
// with it. K=2: one slot crashes repeatedly until the breaker trips, the other holds a live
// healthy worker the whole time. Before the stopReason check in handleExit, that second card was
// parked `worker-crashed` on every single trip.
test('a circuit-breaker trip does not park the OTHER, healthy worker\'s card', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  // 0001 is taken first and gets the never-exiting (healthy) worker; the rest crash.
  writeTask(queueDir, '0001-healthy.json', { id: 'brk-healthy', kind: 'synthetic' });
  for (let i = 2; i <= 5; i++) writeTask(queueDir, `000${i}-c.json`, { id: `brk-c${i}`, kind: 'synthetic' });

  let call = 0;
  const spawnFn = (cmd, args, opts) => {
    call += 1;
    return call === 1 ? neverExitsSpawn(cmd, args, opts) : spawnExit(7)();
  };

  const config = baseConfig({
    workers: 2,
    workerCrashLimit: 3,
    claudeAccountsDir: onePoolDir(2),
    deps: { spawn: spawnFn, spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const stopped = await dispatcher.run(); // returns on its own once the breaker trips

  assert.equal(stopped.reason, 'worker-crash-circuit-breaker');
  assert.equal(stopped.consecutiveCrashes, 3);

  // Proves this test has teeth: the healthy worker must actually have been ALIVE when the breaker
  // tripped and been killed by the shutdown. Without this, a healthy worker that had already
  // exited before the trip would make every assertion below pass for the wrong reason.
  const brkEvents = readDaemonEvents(journalDir);
  assert.ok(
    brkEvents.some((e) => e.event === 'worker-exit-during-shutdown' && e.id === 'brk-healthy'),
    'the healthy worker was not live at the moment of the trip -- this test proves nothing'
  );

  // The healthy card was killed by killAllChildren -- and must NOT have been parked for it.
  let healthy = null;
  try {
    healthy = readState(journalDir, 'brk-healthy');
  } catch {
    healthy = null;
  }
  if (healthy) assert.notEqual(healthy.reason, 'worker-crashed', 'the breaker parked the innocent card too');
  const healthyJournal = (() => {
    try {
      return readJournal(journalDir, 'brk-healthy');
    } catch {
      return [];
    }
  })();
  assert.equal(
    healthyJournal.some((e) => e.event === 'parked'),
    false,
    'the healthy worker\'s card was parked by a breaker trip caused entirely by OTHER cards'
  );
});

// ---- CROSS-ACTION defect: a clamp to ZERO healthy accounts must not be silent

// K clamped to 0 is the dispatcher deciding to do NO work at all. It used to return silently on
// every poll and journal nothing -- the queue simply sat there. Pre-C6 the same pool state parked
// a card naming a cooldownUntilIso a maintainer could read; C6 replaced a loud outcome with an
// invisible one, in a project that has already had a 33-hour silent outage nobody noticed.
test('a clamp to ZERO healthy accounts is journalled once, with the cooldown expiry, and again when it lifts', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-i.json', { id: 'idle-a', kind: 'synthetic' });

  // One enabled account, cooling until a known instant -> countHealthyAccounts returns 0.
  const poolDir = mkTmp('spo-disp-accts-');
  writePoolDir(poolDir, [{ name: 'acct0' }]);
  const coolUntil = Date.now() + 60_000;
  fs.writeFileSync(path.join(poolDir, 'state.json'), JSON.stringify({ acct0: { cooldownUntil: coolUntil } }));

  const config = baseConfig({
    claudeAccountsDir: poolDir,
    deps: { spawn: neverExitsSpawn, spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-idle-no-healthy-accounts'));

    const idle = readDaemonEvents(journalDir).find((e) => e.event === 'dispatcher-idle-no-healthy-accounts');
    assert.equal(idle.healthy, 0);
    assert.equal(idle.queued, 1, 'the signal must say whether anything is actually being starved');
    assert.equal(
      idle.earliestCooldownUntil,
      new Date(coolUntil).toISOString(),
      'a maintainer needs to know WHEN this resolves by itself -- the pre-C6 park said so and this must too'
    );
    assert.deepEqual(idle.enabledAccounts, ['acct0']);

    // EDGE-triggered: several more poll cycles must not add a second line. A line per poll is
    // ~2/second for the whole cooldown, which is what stops a maintainer reading daemon.jsonl.
    await sleep(config.pollIntervalMs * 5);
    assert.equal(
      readDaemonEvents(journalDir).filter((e) => e.event === 'dispatcher-idle-no-healthy-accounts').length,
      1,
      'the idle signal is level-triggered -- it will flood daemon.jsonl for the length of the cooldown'
    );
    // ...and the task must genuinely still be waiting, or this test is asserting about nothing.
    assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 1);

    // The cooldown expires: the recovery edge fires, and the task finally starts.
    fs.writeFileSync(path.join(poolDir, 'state.json'), JSON.stringify({ acct0: { cooldownUntil: Date.now() - 1000 } }));
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-healthy-accounts-returned'));
    const back = readDaemonEvents(journalDir).find((e) => e.event === 'dispatcher-healthy-accounts-returned');
    assert.equal(back.healthy, 1);
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn' && e.id === 'idle-a'));
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// An EMPTY pool is a config error a restart will not clear, not a cooldown that expires on its
// own -- earliestCooldownUntil null with healthy 0 is exactly that distinction, and it is the
// first thing a maintainer needs to tell the two apart.
test('a clamp to zero caused by an empty/disabled pool reports a null cooldown expiry, not a fake one', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-i.json', { id: 'idle-b', kind: 'synthetic' });

  const poolDir = mkTmp('spo-disp-accts-');
  writePoolDir(poolDir, [{ name: 'acct0', disabled: true }]);

  const config = baseConfig({
    claudeAccountsDir: poolDir,
    deps: { spawn: neverExitsSpawn, spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-idle-no-healthy-accounts'));
    const idle = readDaemonEvents(journalDir).find((e) => e.event === 'dispatcher-idle-no-healthy-accounts');
    assert.equal(idle.healthy, 0);
    assert.equal(idle.earliestCooldownUntil, null, 'nothing is cooling -- reporting an expiry would invent one');
    assert.deepEqual(idle.enabledAccounts, [], 'every account disabled: a config error, not a cooldown');
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// ---- 7. K is clamped to healthy accounts before each spawn

test('K is clamped to the number of healthy accounts before each spawn, even when configured higher', { timeout: 40000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');
  writeTask(queueDir, '0001-a.json', slowDoneTask('clamp-a', 150));
  writeTask(queueDir, '0002-b.json', slowDoneTask('clamp-b', 150));

  const poolDir = onePoolDir(2); // acct0, acct1
  // acct1 is cooling for a long time -- only acct0 is healthy, so K=2 configured must behave as K=1.
  accounts.writeState(poolDir, { acct1: { cooldownUntil: Date.now() + 60 * 60 * 1000 } });

  const config = baseConfig({ workers: 2, claudeAccountsDir: poolDir, deps: { spawn: spawnIsolated } });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'));
    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn').length === 2, 8000);
    await waitFor(() => {
      const a = readState(journalDir, 'clamp-a');
      const b = readState(journalDir, 'clamp-b');
      return a && a.state === 'DONE' && b && b.state === 'DONE';
    });
    // Wait for BOTH worker-exit events before stop() -- same race as the K=1 test above: DONE in
    // state.json precedes the real process exit, and stop()'s SIGTERM can otherwise catch a
    // worker still unwinding its own exit path. Latent here (nothing below asserts an exit code
    // yet), but left un-waited this test would flake the moment someone adds one.
    // Explicit, shorter-than-default timeout. This test alone now runs FOUR sequential waitFor
    // calls (worker-spawn, the ===2 wait already carrying its own explicit 8000, the both-DONE
    // wait, and this one) inside one {timeout: 40000} test -- at waitFor's own 10000ms default
    // for every call, a loaded box could exhaust the whole test budget and surface an opaque
    // node:test timeout instead of a readable assertion failure.
    await waitFor(() => {
      const ev = readDaemonEvents(journalDir).filter((e) => e.event === 'worker-exit');
      return ev.some((e) => e.id === 'clamp-a') && ev.some((e) => e.id === 'clamp-b');
    }, 8000);

    // THE CLAMP, ASSERTED AS THE INVARIANT dispatcher.js ACTUALLY ENFORCES -- fillSlots's own
    // `if (live.size >= k) return;`. k is a bound on workers CONCURRENTLY LIVE, not on how many
    // spawns a stretch of wall-clock may contain, so that is what this replays: walk the journal's
    // spawn/exit events in order and track the live count. Both tasks still run (2 spawns), but
    // never at the same time.
    //
    // This replaced a `sleep(60)` + `spawns.length === 1` probe, which measured the clamp at ONE
    // INSTANT chosen to fall "well inside the 150ms IMPLEMENT delay". That budget was a race, not
    // a guard: the sleep is the TEST's own event loop, while the 150ms delay and the worker's
    // ~75ms node boot are wall-clock in a CHILD. Under full-suite load the parent's 60ms sleep
    // overshoots the child's whole lifetime, worker a legitimately reaches DONE and exits, the
    // dispatcher CORRECTLY refills the freed slot with task b, and the probe read `2 !== 1` for a
    // dispatcher that never broke the clamp for an instant. Measured on this box at 3/40 and
    // 1/40 full-suite runs under 8x parallel load (issue #111).
    //
    // The ordering this reads cannot be distorted by load: both events are appended by the SAME
    // (dispatcher) process, so their order in daemon.jsonl is their real order. Starvation moves
    // every timestamp and moves no event past another. And this is strictly STRONGER than the
    // probe it replaces -- it holds over the whole run rather than at one sampled instant, so an
    // unclamped dispatcher cannot slip through by being slow at the moment the old probe looked.
    const lifecycle = readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn' || e.event === 'worker-exit');
    let liveNow = 0;
    let peakLive = 0;
    for (const e of lifecycle) {
      liveNow += e.event === 'worker-spawn' ? 1 : -1;
      peakLive = Math.max(peakLive, liveNow);
    }
    assert.equal(peakLive, 1, 'two workers were alive at once despite only one healthy account -- K was not clamped');
    assert.equal(lifecycle.filter((e) => e.event === 'worker-spawn').length, 2, 'both tasks must still have run, one after the other');
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// ---- 8. A periodic scan runs while a worker is still alive (post-verification correction: the
// scan now runs in the SEPARATE, supervised SCANNER process -- see dispatcher.js's own header for
// why. This test proves the scanner does real work concurrently with a live worker, not that the
// dispatcher's own now-scan-free loop does.)
//
// GETTING A REAL SCANNER (config.real === true inside the SPAWNED process) requires the
// DISPATCHER's own config to resolve to `--real` -- buildScannerArgv/buildWorkerArgv both derive
// their mode flag from the SAME config.shadowMode/dryRun fields, so there is no way to ask for a
// shadow worker and a real scanner out of one dispatcher config. This test works around that
// safely rather than actually running a real card end to end:
//   - The "live" task's worker spawn is faked (deps.spawn, ignoring the argv dispatcher.js built
//     for it entirely) into a tiny real process that just sleeps then exits 0 -- a liveness
//     witness (`process.kill(pid, 0)`), not a real runTask. This is what makes it SAFE to set
//     shadowMode:false/dryRun:false/real:true at the dispatcher level without a real worker ever
//     touching git/gh/claude.
//   - The scanner IS spawned for real (deps.spawnScanner: spawnIsolated) -- a genuine
//     `node orchestrator/daemon.js --real --scanner`, isolated the same way every other daemon
//     subprocess in this suite is.
//   - The planted orphan task is `kind: 'synthetic'`, not `'card'` -- finalizePark's own
//     `ctx.task.kind === 'card'` gate is what keeps a REAL repark from calling postParkComment
//     (a real `gh issue comment`); 'synthetic' skips it, so the repark this test drives is
//     filesystem-only (writeState/writeReport/appendDaemonEvent), never a network call. No
//     worktreePath and no config.parkAlertCmd keep preserveWorktreeWip/alertPark no-ops too --
//     see orphan-scan.test.js's own equivalent fixture for the same shape.
test('a periodic scan (orphan scan) runs in the scanner process while a worker is still alive -- not starved by the in-flight task', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-q-');
  const journalDir = mkTmp('spo-disp-j-');

  // A genuinely orphaned task, planted directly (same shape as test/orphan-scan.test.js's own
  // seedTask): non-terminal state, a dead owner pid, updatedAt already past the grace window.
  const DEAD_PID = 999999;
  const orphanId = 'scan-while-alive-orphan';
  const orphanDir = path.join(journalDir, orphanId);
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, 'task.json'), JSON.stringify({ id: orphanId, kind: 'synthetic' }));
  writeTaskState(orphanDir, {
    id: orphanId,
    state: 'DIAGNOSE',
    owner: { host: require('os').hostname(), pid: DEAD_PID, lockStartedAt: 'old' },
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });

  // The "live" task -- its queue entry only needs to exist for takeNextTask/fillSlots to take it;
  // the fake worker spawn below ignores its content entirely.
  writeTask(queueDir, '0001-live.json', { id: 'scan-while-alive-live', kind: 'synthetic' });

  // The live worker stays alive until THIS TEST RELEASES IT, by creating `releaseFile`. It is not
  // on a timer at all.
  //
  // It used to be `setTimeout(() => process.exit(0), 300)`, and that 300ms was the flake: the
  // proof below needs the worker to still be alive when the orphan's repark lands, but the repark
  // has to get there through a REAL spawned scanner's node boot (~75ms idle) plus a scan cycle,
  // while the 300ms ran as wall-clock in a child that load does not slow down. Under full-suite
  // load the boot dilates past the worker's fixed lifetime, the worker exits first, and the test
  // reports `the live worker already exited -- raise LIVE_MS` about a scanner that never once
  // waited on it. Measured on this box at 5/40 and 10/40 full-suite runs under 8x parallel load,
  // the most frequent of the three in issue #111. Raising LIVE_MS is what its own message asks
  // for and is the wrong fix -- it buys a bigger number to lose against, not a guarantee.
  //
  // With the release file there is no budget left to lose: the worker CANNOT exit before the
  // assertion runs, so `alive(pid) === true` stops being a race the test has to win and becomes a
  // fact it establishes. That makes the concurrency proof STRONGER than the timer version, which
  // could only ever observe "the worker happened to still be running".
  const releaseFile = path.join(journalDir, 'release-live-worker');
  const fakeLiveWorker = (cmd, args, opts) =>
    realSpawn(
      process.execPath,
      // Same orphan self-exit guard every long-lived stand-in in this file carries (see
      // neverExitsSpawn's own comment): if the kernel reparents us away from the runner, exit,
      // so a SIGKILLed suite leaves nothing behind.
      [
        '-e',
        `const p = process.ppid; const fs = require('fs');` +
          `setInterval(() => { if (process.ppid !== p || fs.existsSync(${JSON.stringify(releaseFile)})) process.exit(0); }, 20);`,
      ],
      { ...opts, stdio: 'ignore' }
    );

  const config = baseConfig({
    shadowMode: false,
    dryRun: false,
    real: true,
    orphanScanMs: 15,
    orphanGraceMs: 1000,
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: fakeLiveWorker, spawnScanner: spawnIsolated },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    const spawnEvt = await (async () => {
      await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn' && e.id === 'scan-while-alive-live'));
      return readDaemonEvents(journalDir).find((e) => e.event === 'worker-spawn' && e.id === 'scan-while-alive-live');
    })();
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    // The proof of concurrency: a real repark of the orphan lands WHILE the live (fake) worker's
    // process is still alive -- the scanner never waited on it.
    await waitFor(() => {
      const s = readState(journalDir, orphanId);
      return s && s.state === 'PARKED';
    });
    assert.equal(alive(spawnEvt.pid), true, 'the live worker exited before the repark landed -- the scanner did not run concurrently with it');

    const orphanState = readState(journalDir, orphanId);
    assert.equal(orphanState.reason, 'task-orphaned-daemon-restart');

    fs.writeFileSync(releaseFile, ''); // only now may the live worker finish
    await waitFor(() => !alive(spawnEvt.pid));
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// ---- 9. The dispatcher, not the worker, holds the lock; a second dispatcher is refused

test('daemon.js continuous mode (the dispatcher) holds the single-instance lock -- a second instance against the same journal root is refused', { timeout: 20000 }, async () => {
  const { lockPath } = require('../orchestrator/lock');
  const { DAEMON, runDaemonRaw } = require('./helpers');
  const queueDir = mkTmp('spo-disp-lock-q-');
  const journalDir = mkTmp('spo-disp-lock-j-');

  const child = realSpawn(process.execPath, [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir], {
    stdio: 'ignore',
    env: isolatedEnv(),
  });
  try {
    await waitFor(() => fs.existsSync(lockPath(journalDir)), 15000);

    const second = runDaemonRaw(['--shadow', '--queue', queueDir, '--journal', journalDir]);
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /already holds/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

// ---- takeNextTask's own live-id skip (dispatcher's requirement on the queue primitive itself)

test('takeNextTask: a queue entry whose id matches a liveIds entry is skipped, not taken -- stays in queue/ for later', () => {
  const queueDir = mkTmp('spo-disp-take-q-');
  const journalDir = mkTmp('spo-disp-take-j-');
  writeTask(queueDir, '0001-live.json', { id: 'take-live' });
  writeTask(queueDir, '0002-fresh.json', { id: 'take-fresh' });

  const taken = takeNextTask(queueDir, journalDir, new Set(['take-live']));
  assert.equal(taken.id, 'take-fresh');
  // The live one's file is still sitting in queue/, untouched.
  assert.ok(fs.existsSync(path.join(queueDir, '0001-live.json')));
  assert.equal(fs.existsSync(path.join(journalDir, 'take-live')), false);
});

test('takeNextTask: with ONLY a live-owned entry in queue/, returns null (does not touch it, does not treat the queue as empty forever)', () => {
  const queueDir = mkTmp('spo-disp-take-q-');
  const journalDir = mkTmp('spo-disp-take-j-');
  writeTask(queueDir, '0001-live.json', { id: 'take-only-live' });

  assert.equal(takeNextTask(queueDir, journalDir, new Set(['take-only-live'])), null);
  assert.ok(fs.existsSync(path.join(queueDir, '0001-live.json')));

  // Once no longer live, the exact same call now takes it.
  const taken = takeNextTask(queueDir, journalDir, new Set());
  assert.equal(taken.id, 'take-only-live');
});

// ---- action 6.3 VERIFICATION ROUND: tests added for mutation survivors -----------------------
//
// Every test below exists because a mutation of production source survived the full suite during
// this action's verification round. Each names the mutation it kills.

// SURVIVOR: `const modeFlag = config.shadowMode ? '--shadow' : config.dryRun ? '--dry-run' :
// '--real'` replaced with a flat `'--shadow'` passed all 1249 tests. That is the worst possible
// silent failure this module can have: the live `--real` daemon would spawn shadow workers, every
// card would run the synthetic state machine instead of touching git/gh/claude, and every one of
// them would report DONE. It survived because EVERY end-to-end test in this file is itself a
// shadow-mode run, so the mutated value equals the expected one in all of them -- the "a value
// coincidentally equal under both branches" shape. Asserted here against buildWorkerArgv directly
// (all three modes, only one of which any other test can reach) rather than end-to-end.
test('buildWorkerArgv: the worker inherits THIS dispatcher\'s own mode -- --real stays --real, never --shadow', () => {
  const { buildWorkerArgv } = require('../orchestrator/dispatcher');
  const modeOf = (config) => buildWorkerArgv('/t/dir', '/q', '/j', config)[1];
  assert.equal(modeOf({ shadowMode: true, dryRun: false }), '--shadow');
  assert.equal(modeOf({ shadowMode: false, dryRun: true }), '--dry-run');
  assert.equal(modeOf({ shadowMode: false, dryRun: false }), '--real');
  // shadowMode wins over dryRun, matching every other mode resolution in the codebase.
  assert.equal(modeOf({ shadowMode: true, dryRun: true }), '--shadow');
});

// SURVIVOR: dropping `'--queue', queueDir, '--journal', journalRoot` from the argv passed the
// whole suite. A worker spawned without --journal falls back to config.js's DEFAULT journal root
// -- in production that is the LIVE daemon's own <repo>/journal, the single directory this repo
// has already been bitten for writing into by accident. Without --queue, action 4.4's transient
// re-enqueue lands in a queue nobody drains. No test asserted the argv at all.
test('buildWorkerArgv: --queue and --journal are always forwarded, so a worker never falls back to the repo default journal root', () => {
  const { buildWorkerArgv } = require('../orchestrator/dispatcher');
  const argv = buildWorkerArgv('/task/dir', '/my/queue', '/my/journal', { shadowMode: true, stepDeadlineMs: 4242 });
  assert.equal(argv[2], '--worker');
  assert.equal(argv[3], '/task/dir');
  assert.equal(argv[argv.indexOf('--queue') + 1], '/my/queue');
  assert.equal(argv[argv.indexOf('--journal') + 1], '/my/journal');
  assert.equal(argv[argv.indexOf('--deadline-ms') + 1], '4242');
  // Absent stepDeadlineMs means "say nothing and let daemon.js's own default apply", not "pass
  // undefined" -- an argv carrying the string "undefined" would parseInt to NaN in the worker.
  assert.equal(buildWorkerArgv('/t', '/q', '/j', { shadowMode: true }).includes('--deadline-ms'), false);
});

// ---- VERIFIER (action 6.3 REWORK): the SCANNER's argv, pinned in every dimension -------------
//
// SURVIVOR, found in the rework's own verification round: dropping `'--queue', queueDir` from
// buildScannerArgv passed the ENTIRE suite (1273 tests). The two tests directly above pin the
// WORKER's argv in every dimension; the scanner -- added by the rework, and the process that now
// owns unparkScan and auto-pull -- had no equivalent, so only the mode flag and --journal were
// pinned at all, and those only INDIRECTLY, by one 19-second end-to-end scan test.
//
// A scanner spawned without --queue falls back to config.js's DEFAULT queue directory. That is
// not a cosmetic argv difference: unparkScan's retry re-enqueue and runAutoPull's freshly pulled
// cards would both land in a queue THIS dispatcher's workers never drain, so a maintainer's
// `retry` comment would be accepted, journalled, and then silently do nothing -- the exact
// failure class dispatcher.js's own header cites (33 hours, 238 consecutive scan failures nobody
// noticed) restated one layer up. Asserted directly against buildScannerArgv, so it fails in
// milliseconds instead of depending on an end-to-end test that happens to exercise one mode.
test('buildScannerArgv: the scanner inherits THIS dispatcher\'s own mode -- --real stays --real, never --shadow', () => {
  const { buildScannerArgv } = require('../orchestrator/dispatcher');
  const modeOf = (config) => buildScannerArgv('/q', '/j', config)[1];
  assert.equal(modeOf({ shadowMode: true, dryRun: false }), '--shadow');
  assert.equal(modeOf({ shadowMode: false, dryRun: true }), '--dry-run');
  assert.equal(modeOf({ shadowMode: false, dryRun: false }), '--real');
  assert.equal(modeOf({ shadowMode: true, dryRun: true }), '--shadow');
});

test('buildScannerArgv: --workers is forwarded -- 6.6 made the scanner a consumer of K', () => {
  const { buildScannerArgv } = require('../orchestrator/dispatcher');
  // auto-pull.js's watermark is `in-flight + queued <= K`, computed by computeAutoPullBudget,
  // which runs IN THE SCANNER. Before this, only SPO_WORKERS in the inherited env reached it: a
  // `--workers 3` dispatcher paired with a K=1 watermark scanner would hold the queue at one card
  // with two slots idle. Same shape as 6.4's own `--workers` defect on the worker side.
  const argv = buildScannerArgv('/q', '/j', { shadowMode: true, workers: 3 });
  const i = argv.indexOf('--workers');
  assert.ok(i > 0, `--workers missing from scanner argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], '3');
  // A missing or invalid K omits the flag rather than forwarding NaN -- the child then resolves
  // its own config.js default, exactly as buildWorkerArgv does.
  assert.equal(buildScannerArgv('/q', '/j', { shadowMode: true }).includes('--workers'), false);
  assert.equal(buildScannerArgv('/q', '/j', { shadowMode: true, workers: 0 }).includes('--workers'), false);
});

test('buildScannerArgv: --parent-pid carries THIS dispatcher pid -- the scanner must not outlive it', () => {
  const { buildScannerArgv } = require('../orchestrator/dispatcher');
  const argv = buildScannerArgv('/q', '/j', { shadowMode: true });
  const i = argv.indexOf('--parent-pid');
  assert.ok(i > 0, `--parent-pid missing from scanner argv: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], String(process.pid));
});

test('buildScannerArgv: --scanner, --queue and --journal are ALL forwarded -- a scanner never falls back to the repo defaults', () => {
  const { buildScannerArgv } = require('../orchestrator/dispatcher');
  const argv = buildScannerArgv('/my/queue', '/my/journal', { shadowMode: true, stepDeadlineMs: 4242 });

  assert.equal(argv[0], require('path').join(__dirname, '..', 'orchestrator', 'daemon.js'));
  assert.equal(argv[2], '--scanner', 'the scanner must be started in --scanner mode, not --worker or continuous mode');
  assert.ok(argv.includes('--queue'), 'the scanner must be told which queue to re-enqueue retries and auto-pulled cards into');
  assert.equal(argv[argv.indexOf('--queue') + 1], '/my/queue');
  assert.ok(argv.includes('--journal'), 'the scanner must be told which journal root to scan');
  assert.equal(argv[argv.indexOf('--journal') + 1], '/my/journal');

  // The two roots must not be transposable -- a swap type-checks and keeps both flags present.
  assert.notEqual(argv[argv.indexOf('--queue') + 1], '/my/journal');
  assert.notEqual(argv[argv.indexOf('--journal') + 1], '/my/queue');

  // A scanner runs no STEP, so a per-step deadline is meaningless to it and must not be forwarded
  // even when this dispatcher's own config carries one (the worker argv does forward it).
  assert.equal(argv.includes('--deadline-ms'), false, '--deadline-ms governs a step, and steps run in workers, never in the scanner');
  assert.equal(argv.includes('--worker'), false);
  assert.equal(argv.includes('--once'), false);
});

// SURVIVOR: `const DEFAULT_WORKERS = 1` changed to 99 passed the whole suite -- every test in this
// file sets `workers` explicitly, so the documented default ("K DEFAULTS TO 1", this module's own
// header, config.js's own comment, and the plan's "parallelism is opt-in") was pinned nowhere.
test('resolveWorkerCount: K defaults to 1, and a non-positive-integer config falls back to 1 rather than to 0', () => {
  const { resolveWorkerCount } = require('../orchestrator/dispatcher');
  assert.equal(resolveWorkerCount({}), 1);
  assert.equal(resolveWorkerCount({ workers: undefined }), 1);
  assert.equal(resolveWorkerCount(null), 1);
  assert.equal(resolveWorkerCount({ workers: 0 }), 1, 'a 0 would make the daemon look alive while spawning nothing, forever');
  assert.equal(resolveWorkerCount({ workers: -2 }), 1);
  assert.equal(resolveWorkerCount({ workers: 1.5 }), 1);
  assert.equal(resolveWorkerCount({ workers: 4 }), 4);
});

// Same shape as resolveWorkerCount's own table above, for resolveScannerHealthyUptimeMs -- a
// direct unit test of the exported function, not routed through a real dispatcher, because the
// whole point is pinning every boundary of the fallback logic by hand, including ones a real
// scanner-crash scenario would never exercise on its own.
//
// The stake, stated in resolveScannerHealthyUptimeMs's own comment: "0 would mean 'every crash is
// healthy' ... the breaker this action exists to keep honest would never trip at all." Two
// mutations of exactly that shape were verified to survive the whole suite before this test
// existed: `raw === undefined ? DEFAULT : raw` (lets 0 through unguarded) and `raw || DEFAULT`
// (lets -1 through, since `-1 || x` is `-1`, truthy). Both are covered explicitly below, alongside
// the same NaN/Infinity/string/object shapes resolveWorkerCount's own table does not need to
// cover (workers is validated with Number.isInteger; this field is a duration, validated with
// Number.isFinite, so its hostile-input surface is a superset).
test('resolveScannerHealthyUptimeMs: falls back to the 60s default for any non-finite or non-positive override', () => {
  const { resolveScannerHealthyUptimeMs } = require('../orchestrator/dispatcher');
  const DEFAULT_MS = 60 * 1000; // dispatcher.js's own DEFAULT_SCANNER_HEALTHY_UPTIME_MS -- pinned by this literal, not re-derived
  assert.equal(resolveScannerHealthyUptimeMs({}), DEFAULT_MS);
  assert.equal(resolveScannerHealthyUptimeMs(null), DEFAULT_MS);
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: undefined }), DEFAULT_MS);
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: 0 }), DEFAULT_MS, 'the M9a-shaped mutation: 0 must NOT pass through, or every crash reads as healthy');
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: -1 }), DEFAULT_MS, 'the M9b-shaped mutation: a bare `||` fallback would let -1 (truthy) through');
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: NaN }), DEFAULT_MS);
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: Infinity }), DEFAULT_MS, 'an unbounded bar would make the breaker unable to EVER see a healthy reset');
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: -Infinity }), DEFAULT_MS);
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: '400' }), DEFAULT_MS, 'a string is not finite by Number.isFinite -- no implicit coercion');
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: 'abc' }), DEFAULT_MS);
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: {} }), DEFAULT_MS);
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: 1.5 }), 1.5, 'unlike a worker COUNT, a fractional duration is legitimate -- no integer requirement here');
  assert.equal(resolveScannerHealthyUptimeMs({ scannerHealthyUptimeMs: 400 }), 400);
});

// SURVIVOR: BOTH `detached: true` (removed from the spawn options) and `process.kill(-pid)`
// (changed to the non-group `process.kill(pid)`) survived the whole suite. Together they are the
// plan's entire stated reason for spawning detached -- "a killed worker never orphans a
// still-spending LLM call" -- and nothing tested either half, which made that guarantee
// decorative. Tested here with REAL processes and a REAL grandchild standing in for `claude`: the
// grandchild must stop writing its heartbeat once killAllChildren signals the worker's GROUP.
test('killAllChildren signals the worker\'s whole process GROUP -- a worker\'s grandchild (its `claude`) dies with it, never orphaned', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-pg-q-');
  const journalDir = mkTmp('spo-disp-pg-j-');
  writeTask(queueDir, '0001-pg.json', { id: 'pg', kind: 'synthetic' });

  const alive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  let grandchildPid = null;
  let workerPid = null;
  // A real "worker" that spawns a real grandchild, exactly as a worker spawns `claude`, and
  // announces the grandchild's pid on stdout. `opts` is passed straight through, so this spawn is
  // detached iff production says it is -- which is what makes the `detached: true` mutation
  // observable here. Both live 10s at most, so nothing here can outlive the test by long even if
  // every assertion fails.
  const spawnWithGrandchild = (cmd, args, opts) => {
    const child = realSpawn(
      process.execPath,
      [
        '-e',
        "const g=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});" +
          "process.stdout.write('G'+g.pid+'\\n');setTimeout(()=>{},10000);",
      ],
      { ...opts, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    workerPid = child.pid;
    child.stdout.on('data', (d) => {
      const m = /G(\d+)/.exec(String(d));
      if (m) grandchildPid = Number(m[1]);
    });
    return child;
  };

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    // spawnScanner deliberately NOT spawnWithGrandchild -- that function overwrites the outer
    // workerPid/grandchildPid via a shared closure, so a second caller (the scanner's own spawn)
    // would race the real worker task for those variables. neverExitsSpawn keeps the scanner real
    // (still supervised, still killed by killAllChildren below) without touching either variable.
    deps: { spawn: spawnWithGrandchild, spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => grandchildPid !== null, 15000);
    assert.equal(alive(workerPid), true, 'test setup: the worker must be alive before the kill');
    assert.equal(alive(grandchildPid), true, 'test setup: the grandchild must be alive before the kill');

    dispatcher.killAllChildren('SIGTERM');

    // The grandchild is NOT signalled directly by anything here -- the only way it can die is by
    // being in the worker's process group. Poll rather than sleep a fixed time: signal delivery
    // and reaping are not instantaneous.
    await waitFor(() => !alive(grandchildPid), 5000).catch(() => {});
    assert.equal(
      alive(grandchildPid),
      false,
      'the grandchild survived killAllChildren -- the process GROUP was not signalled, so a real worker would have orphaned a still-spending `claude`'
    );
  } finally {
    // Never leak either process, however the assertions above went.
    for (const pid of [grandchildPid, workerPid]) {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    dispatcher.stop();
    await runPromise;
  }
});

// SURVIVOR: deleting `if (pending.size > 0) race.push(Promise.race(pending));` -- the half of
// run()'s Promise.race that wakes the loop on a worker EXIT rather than on the poll timer --
// passed the whole suite, because every test here sets pollIntervalMs to 30ms, so "woke on the
// exit" and "woke on the next poll" are indistinguishable. In production pollIntervalMs is 5000,
// so the mutation would leave every freed slot idle for up to 5 seconds per task. Pinned with a
// poll interval long enough that only the exit-wake can explain the second spawn.
test('a freed slot is refilled on the worker EXIT, not on the next poll tick -- run() really races the exit against the timer', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-wake-q-');
  const journalDir = mkTmp('spo-disp-wake-j-');
  writeTask(queueDir, '0001-a.json', { id: 'wake-a', kind: 'synthetic' });
  writeTask(queueDir, '0002-b.json', { id: 'wake-b', kind: 'synthetic' });

  const POLL_MS = 4000; // >> the time a spawnExit(0) worker needs to start and exit
  const config = baseConfig({
    pollIntervalMs: POLL_MS,
    workers: 1, // K=1 on purpose: the second task can ONLY start once the first slot frees
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(0), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const startedAt = Date.now();
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn').length >= 2, 3500);
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < POLL_MS,
      `the second worker only started after a full ${POLL_MS}ms poll interval (${elapsed}ms) -- the loop is not waking on the first worker's exit`
    );
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// SURVIVOR (deliberately NOT pinned as an ordering, pinned as the real invariant instead):
// moving `live.delete(id)` to BEFORE the crash repark inside handleExit survived the whole suite.
// It survived because it is an EQUIVALENT MUTATION, and dispatcher.js's own header currently
// misattributes why: it says `live` entries being removed last is "what makes the skip [in
// orphanScan] sufficient rather than merely probabilistic". It is not. handleExit is a fully
// SYNCHRONOUS function and state-machine.js's finalizePark is a synchronous function, so no
// orphanScan pass -- indeed no other code in this process at all -- can interleave anywhere inside
// handleExit, whatever order its statements are in. The statement order is defensive, not
// load-bearing; the SYNCHRONICITY is load-bearing, and nothing tested it. A future maintainer who
// adds a single `await` inside handleExit (or makes finalizePark async) would keep the documented
// ordering, believe the race is still closed, and be wrong. That is the invariant pinned here.
test('handleExit is synchronous end to end -- the invariant that actually closes the orphanScan double-repark race, not the statement order', () => {
  const { finalizePark } = require('../orchestrator/state-machine');
  // 1. finalizePark must not be async: dispatcher.js calls it WITHOUT await, so an async
  //    finalizePark would return a pending promise and let an orphanScan pass run before the park
  //    ever landed on disk.
  assert.notEqual(
    finalizePark.constructor.name,
    'AsyncFunction',
    'finalizePark became async -- dispatcher.js calls it un-awaited inside handleExit, so the crash repark would no longer complete before the live-worker entry is dropped'
  );

  // 2. handleExit's own body must contain no suspension point. Read from source, the same way
  //    test/gh-api-argv.test.js pins a call-site shape it cannot reach by mocking -- there is no
  //    runtime probe for "this function never yields".
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'dispatcher.js'), 'utf8');
  const start = src.indexOf('  function handleExit(');
  assert.notEqual(start, -1, 'handleExit not found -- this test needs updating with the refactor');
  const end = src.indexOf('\n  }\n', start);
  assert.notEqual(end, -1, 'could not find the end of handleExit');
  const body = src.slice(start, end);
  assert.equal(/\bawait\b/.test(body), false, 'handleExit gained an `await` -- an orphanScan pass can now interleave between the worker exit and its repark');
  assert.equal(/\basync\b/.test(body), false, 'handleExit became async');
});

// SURVIVOR: emptying daemon.js's `process.once('exit', ...)` hook so it no longer calls
// dispatcherHandle.killAllChildren('SIGTERM') passed the whole suite -- nothing tested the
// shutdown path end to end, only that killAllChildren exists. Without it, stopping the daemon
// leaves its workers (and their `claude` grandchildren) running against a journal root whose lock
// has just been released, which is exactly the "a fresh daemon races a still-shutting-down
// predecessor's workers for taskDir ownership" case that hook's own comment says it prevents.
test('SIGTERM to the real daemon takes its live workers down with it -- the exit hook really reaches them', { timeout: 20000 }, async () => {
  const { DAEMON } = require('./helpers');
  const queueDir = mkTmp('spo-disp-term-q-');
  const journalDir = mkTmp('spo-disp-term-j-');
  // Long enough that the worker is unambiguously still mid-task when the daemon is signalled, so
  // "the worker is gone" can only be explained by the shutdown, never by it having finished.
  writeTask(queueDir, '0001-term.json', slowDoneTask('term-task', 10000));

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const daemon = realSpawn(process.execPath, [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir], {
    stdio: 'ignore',
    env: isolatedEnv(),
  });
  let workerPid = null;
  try {
    await waitFor(() => {
      const evt = readDaemonEvents(journalDir).find((e) => e.event === 'worker-spawn');
      if (evt && evt.pid) workerPid = evt.pid;
      return workerPid !== null;
    }, 20000);
    assert.equal(alive(workerPid), true, 'test setup: the worker must still be running when the daemon is signalled');

    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('exit', resolve));

    await waitFor(() => !alive(workerPid), 5000).catch(() => {});
    assert.equal(
      alive(workerPid),
      false,
      'the worker outlived the daemon that spawned it -- daemon.js\'s exit hook did not reach it, so a restart would race it for the same taskDir'
    );
  } finally {
    try {
      if (workerPid) process.kill(-workerPid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    if (!daemon.killed) daemon.kill('SIGKILL');
  }
});

// ---- action 6.3 POST-VERIFICATION CORRECTION: the scanner sibling process --------------------
// See dispatcher.js's own header for the full design (measured reason for the split, the
// respawn/breaker discipline, why the breaker is a separate counter from the worker one).

test('the dispatcher spawns exactly ONE scanner at startup -- never a second one while the first is still alive', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scan1-q-');
  const journalDir = mkTmp('spo-disp-scan1-j-');

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(0), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'scanner-spawn'));
    // Several idle loop iterations at pollIntervalMs=30ms -- a bug that re-spawned a scanner on
    // every iteration (rather than once, up front) would show up as more than one 'scanner-spawn'
    // event well before this window closes.
    await sleep(200);
    const spawns = readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-spawn');
    assert.equal(spawns.length, 1, `expected exactly one scanner-spawn, got ${spawns.length}`);
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// ---- live-workers.json is initialised at startup (action 6.6 verification) --------------------
//
// auto-pull.js's watermark reads <journalRoot>/live-workers.json for `inFlight`, and reads a
// MISSING file as `inFlight = K` -- "no dispatcher has ever published here, assume the worst".
// That posture is right, and it was fatal, because publishLiveWorkerIds was only ever called from
// spawnOne/handleExit: on a cold start with an EMPTY QUEUE the file was never written at all, and
// auto-pull is the only thing that puts a card in the queue. No file -> budget 0 -> no queue entry
// -> no spawn -> no file. A closed loop, with no self-correction and nothing in the suite that
// could see it, because every budget test wrote the file by hand.
//
// Measured before the fix, with a real `--real` dispatcher on an empty queue and
// SPO_AUTO_PULL_MS=3000: ZERO `npm run board:claim` calls in 20s (~6 due cycles). Writing an
// empty live-workers.json into the same journal root by hand produced 3 in the next 20s.
test('the dispatcher publishes an EMPTY live-workers.json at startup, before the first scan can read it', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-lwinit-q-');
  const journalDir = mkTmp('spo-disp-lwinit-j-');
  const livePath = path.join(journalDir, 'live-workers.json');
  assert.equal(fs.existsSync(livePath), false, 'precondition: no file yet');

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    // Empty queue on purpose: no worker is ever spawned, so spawnOne/handleExit never run and the
    // startup publish is the ONLY thing that can create this file.
    deps: { spawn: spawnExit(0), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => fs.existsSync(livePath));
    assert.deepEqual([...readLiveWorkerIds(journalDir)], [], 'an idle dispatcher has zero workers in flight');

    // The consequence, asserted where it actually bites rather than only on the file: at the
    // SHIPPED config this is the difference between "pull one card" and "pull nothing, forever".
    const { computeAutoPullBudget } = require('../orchestrator/auto-pull');
    const budget = computeAutoPullBudget(queueDir, journalDir, defaultConfig);
    assert.equal(budget.inFlight, 0, 'a published empty table means zero in flight, not K');
    assert.equal(budget.limit, defaultConfig.autoPullLimit, 'an idle daemon on an empty queue must be able to pull');
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

test('startup CLEARS a stale live-workers.json left by a killed predecessor -- otherwise the watermark never recovers', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-lwstale-q-');
  const journalDir = mkTmp('spo-disp-lwstale-j-');
  const livePath = path.join(journalDir, 'live-workers.json');
  // Exactly what a SIGTERM'd daemon leaves behind: the post-merge hook kills the whole cgroup
  // mid-card, so whatever was in flight at death stays listed. Nothing ever cleared it, and the
  // ids name processes that no longer exist.
  writeLiveWorkerIds(journalDir, ['issue-901', 'issue-902']);
  assert.equal(readLiveWorkerIds(journalDir).size, 2);

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(0), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readLiveWorkerIds(journalDir).size === 0);
    // Two dead ids against the shipped K=1 would have meant headroom = 1 - 0 - 2, i.e. permanently
    // at (past) the watermark: no pull, so no queue entry, so no spawn, so no correction.
    const { computeAutoPullBudget } = require('../orchestrator/auto-pull');
    assert.equal(computeAutoPullBudget(queueDir, journalDir, defaultConfig).limit, defaultConfig.autoPullLimit);
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// ---- the scanner must not outlive its dispatcher (action 6.6 verification, Task 2) ------------
//
// Both children are spawned `detached: true` -- required for a WORKER, so `kill(-pid)` reaches
// that worker's own `claude` grandchild. The scanner's `for(;;)` never returns on its own, so the
// same flag lets it survive a dispatcher that dies without killing its group. Measured: SIGKILL a
// real dispatcher alone and its scanner keeps running, reparented to ppid 1 (four such orphans
// were found alive 1h22m after the run that spawned them). With `Restart=always`, systemd then
// starts a new dispatcher that spawns a SECOND scanner against the same journal root.
//
// These two spawn the REAL daemon.js --scanner, because the behaviour under test belongs to the
// scanner process itself, not to any dispatcher stand-in.
test('a scanner whose --parent-pid is not its parent exits immediately instead of looping forever', { timeout: 20000 }, async (t) => {
  const queueDir = mkTmp('spo-scanner-orphan-q-');
  const journalDir = mkTmp('spo-scanner-orphan-j-');
  // A pid that is emphatically not this process: the scanner's real parent IS this test runner,
  // so `process.ppid !== parentPid` holds from its very first loop iteration -- the same state an
  // orphan reaches the instant the kernel reparents it away from a dead dispatcher.
  const notOurPid = process.pid === 2 ? 3 : 2;
  const child = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--scanner', '--queue', queueDir, '--journal', journalDir, '--parent-pid', String(notOurPid)],
    { stdio: 'ignore', env: isolatedEnv() }
  );
  // Teardown registered BEFORE the first await, so this child is reaped on every exit path --
  // an assertion failure, a node:test timeout, or an interrupted run -- not only the happy one.
  // The suite must never require manual reaping; a leaked scanner from a failed run is the exact
  // shape of the defect these two tests exist to pin.
  t.after(() => child.kill('SIGKILL'));
  // Bounded, so the way this fails is a NAMED assertion in ~5s rather than the whole file
  // stalling until node:test's own timeout: an unchecked scanner never exits at all, and "the
  // suite hung" is a much worse signal than "the scanner did not exit".
  const TIMEOUT_SENTINEL = Symbol('never-exited');
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5000).then(() => TIMEOUT_SENTINEL),
  ]);
  if (code === TIMEOUT_SENTINEL) {
    child.kill('SIGKILL');
    assert.fail('the scanner never exited: an orphan whose parent is gone runs forever (the defect this pins)');
  }
  assert.equal(code, 0, 'an orphaned scanner exits cleanly rather than being killed or hanging');
  const events = readDaemonEvents(journalDir);
  const exitEvent = events.find((e) => e.event === 'scanner-orphan-exit');
  assert.ok(exitEvent, `expected a scanner-orphan-exit event, got: ${JSON.stringify(events)}`);
  assert.equal(exitEvent.parentPid, notOurPid);
});

test('a scanner whose --parent-pid IS its parent keeps running -- the check must not kill a healthy scanner', { timeout: 20000 }, async (t) => {
  const queueDir = mkTmp('spo-scanner-live-q-');
  const journalDir = mkTmp('spo-scanner-live-j-');
  const child = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--scanner', '--queue', queueDir, '--journal', journalDir, '--parent-pid', String(process.pid)],
    { stdio: 'ignore', env: isolatedEnv() }
  );
  t.after(() => child.kill('SIGKILL')); // see the sibling test above
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });
  // Many loop iterations at the shadow poll interval -- an inverted or over-eager check shows up
  // as an exit here, and this is the assertion that stops the fix from being "always exit".
  await sleep(1500);
  const stillAlive = exited === null;
  child.kill('SIGKILL');
  assert.ok(stillAlive, `a scanner with a live parent must keep scanning, but it exited ${exited}`);
  assert.equal(
    readDaemonEvents(journalDir).some((e) => e.event === 'scanner-orphan-exit'),
    false
  );
});

// This is also the safety-property regression test for the healthy-uptime fix below: spawnExit(1)
// crashes in single-digit-to-low-double-digit ms, nowhere near baseConfig/defaultConfig's
// scannerHealthyUptimeMs (60s, untouched by this test's own overrides) -- so every one of these
// crashes must still be classified UNHEALTHY and the streak must still extend, not reset. If a
// future change to the healthy-uptime logic ever made a near-instant crash count as "healthy" by
// mistake, this test traps it: the breaker would never trip and dispatcher.run() would hang past
// its own 20s timeout instead of resolving with a tripped stopReason.
test('a crashed scanner is respawned immediately, up to its own scannerCrashLimit, then trips a SEPARATE breaker from the worker one', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scancrash-q-');
  const journalDir = mkTmp('spo-disp-scancrash-j-');

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    scannerCrashLimit: 2, // small and explicit -- keeps this test fast without relying on the default
    // No worker tasks queued at all -- this test is entirely about scanner supervision, and a
    // constant-crashing deps.spawn would otherwise also drive worker crashes into the picture.
    deps: { spawn: spawnExit(0), spawnScanner: spawnExit(1) },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const stopReason = await dispatcher.run(); // resolves on its own once the scanner breaker trips

  assert.equal(stopReason.reason, 'scanner-crash-circuit-breaker');
  assert.equal(stopReason.consecutiveScannerCrashes, 2);
  assert.equal(stopReason.totalScannerCrashes, 2, 'no healthy uptime ever occurred, so the cumulative total matches the consecutive count here');
  assert.equal(stopReason.scannerCrashLimit, 2);

  const events = readDaemonEvents(journalDir);
  assert.equal(events.filter((e) => e.event === 'scanner-spawn').length, 2, 'expected exactly 2 spawns -- the initial one plus one respawn, then the breaker stops a third');
  assert.equal(events.filter((e) => e.event === 'scanner-crashed').length, 2);
  // Never counted against, or confused with, the WORKER breaker's own fields.
  assert.equal(events.some((e) => e.event === 'worker-crashed' || e.reason === 'worker-crash-circuit-breaker'), false);
});

// ---- consecutiveScannerCrashes must mean CONSECUTIVE (this action's own fix) ------------------
//
// Before this fix, consecutiveScannerCrashes was incremented on every scanner-crashed event and
// reset nowhere -- a cumulative total wearing a name that promised "in a row". Proved on a real
// dispatcher (this action's own verification): three crashes with 700ms of healthy scanning
// between each one tripped the breaker exactly as fast as three crashes with none, because
// nothing ever brought the counter back down.
//
// Every test below except the LAST one drives that fix through a REAL createDispatcher with
// `deps.monotonicNowMs` injected (mockClock, above) -- never by poking the counter directly, and
// never by waiting out a real `setTimeout`-driven child. Injecting the clock is what lets these
// assert on an EXACT, deterministic uptime (down to the millisecond) while every child is an
// ordinary near-instant `spawnExit` process: the dispatcher's own arithmetic reads whatever the
// mock clock says, regardless of how long the real child actually took to spawn and exit. This
// removed ~7s of real `setTimeout` waiting from this file (three tests that used to sleep 1200ms
// per scanner lifecycle) without weakening any assertion -- if anything the assertions got
// tighter, since "uptime >= 400" became "uptime === exactly 1300".
//
// The LAST test in this group deliberately leaves `deps.monotonicNowMs` un-injected, so it is the
// one thing here still paying for a real `setTimeout` -- see its own comment for why that trade is
// worth keeping.

test('a scanner that survives past scannerHealthyUptimeMs before crashing leaves the streak at 1, not extended to 2', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scanheal-q-');
  const journalDir = mkTmp('spo-disp-scanheal-j-');

  // Three scanner lifecycles, each a (start, end) pair consumed in order by mockClock:
  //   scanner 1: 0    -> 50    => uptime   50ms (< 400 -- unhealthy)
  //   scanner 2: 100  -> 1400  => uptime 1300ms (>= 400 -- healthy)
  //   scanner 3: 1500 -> 1550  => uptime   50ms (< 400 -- unhealthy)
  // Under the pre-fix cumulative counter, scanner 2's crash would read 2 (extending scanner 1's
  // streak); under the fix, surviving the bar means it starts a FRESH streak, so it must read 1.
  // Scanner 3's crash then extends THAT fresh streak to 2 -- proving the reset is a one-shot event
  // tied to the healthy exit, not a permanent "the breaker is now disarmed" side effect. Every
  // child is `spawnExit(1)` (real, near-instant) -- the 1300ms is entirely the mock clock's doing.
  // Padding beyond the 3 crashes this test actually asserts on. `spawnScanner`'s own respawn
  // after crash 3 is synchronous and unconditional (handleScannerExit calls it whenever the
  // breaker has not just tripped -- and it has not, scannerCrashLimit is 10 here), so a 4th
  // scanner's `startedAtMonotonicMs` read WILL happen before this test's own `dispatcher.stop()`
  // can land -- and because that 4th scanner is a REAL, near-instant `spawnExit(1)` child, it may
  // itself crash and trigger a 5th, 6th... before stop() wins that race. None of that is asserted
  // on below (only crashes[0..2] are), so this padding only needs to be long enough that mockClock
  // is never exhausted by that unavoidable extra respawn-or-two -- kept "healthy" (>=400ms gaps)
  // so it can never accidentally trip the scannerCrashLimit=10 breaker either.
  const sequence = [0, 50, 100, 1400, 1500, 1550];
  for (let i = 0; i < 20; i++) sequence.push(2000 + i * 10000, 2000 + i * 10000 + 500);

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    scannerCrashLimit: 10, // high enough that nothing here trips the breaker -- not what this test is about
    scannerHealthyUptimeMs: 400,
    deps: { spawn: spawnExit(0), spawnScanner: spawnExit(1), monotonicNowMs: mockClock(sequence) },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-crashed').length >= 3, 10000);
  } finally {
    dispatcher.stop();
    await runPromise;
  }

  const crashes = readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-crashed');
  assert.ok(crashes.length >= 3, `expected at least 3 scanner-crashed events, got ${crashes.length}`);
  assert.equal(crashes[0].uptimeMs, 50);
  assert.equal(crashes[0].consecutiveScannerCrashes, 1, 'first-ever crash always starts a streak at 1');
  assert.equal(crashes[1].uptimeMs, 1300);
  assert.equal(crashes[1].consecutiveScannerCrashes, 1, 'a crash after healthy uptime must reset the streak, not extend it to 2');
  assert.equal(crashes[2].uptimeMs, 50);
  assert.equal(crashes[2].consecutiveScannerCrashes, 2, 'the NEXT near-instant crash extends the freshly-reset streak, proving the reset is not a permanent disarm');
  // Cumulative total keeps counting regardless -- this is the field that actually answers "how
  // many total crashes has this scanner had", now under its own honest name.
  assert.equal(crashes[2].totalScannerCrashes, 3);
  assert.ok(
    crashes.every((e) => e.scannerHealthyUptimeMs === 400),
    'the resolved threshold itself must be visible on every event, not just derivable from config'
  );
});

test('the breaker does NOT trip when crashes are separated by healthy uptime, even though total crashes exceed scannerCrashLimit -- the bug this action fixes', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scannotrip-q-');
  const journalDir = mkTmp('spo-disp-scannotrip-j-');

  // Six scanner lifecycles, EVERY ONE surviving exactly 500ms (>= the 400ms healthy bar) by the
  // mock clock -- so every crash resets the streak to 1, and consecutiveScannerCrashes should
  // never reach scannerCrashLimit=3 no matter how many total crashes accumulate.
  //
  // The liveness proof is STRUCTURAL, not timing-based: waiting for a 6th crash (double the
  // limit) can only succeed if the dispatcher kept respawning past crash 3 -- spawnScanner is only
  // ever called again from INSIDE handleScannerExit, after the breaker check does not trip. If a
  // regression made the breaker trip at 3 (the pre-fix cumulative behaviour, or any of the mutants
  // the verifier found), respawning stops there, no crash 4-6 ever gets journalled, and this
  // `waitFor` times out with a named error -- a hard failure, not a race that can pass by luck the
  // way a `Promise.race` against a fixed sleep could.
  // 40 lifecycles, not 6 -- the same unavoidable "one guaranteed extra respawn, possibly more if
  // it races and crashes before stop() lands" reasoning as the sibling test above applies here
  // too, and this test's own liveness proof (waiting for a 6th crash, then calling stop()) needs
  // headroom past that. All are "healthy" (500ms >= the 400ms bar), so however many of these
  // actually get consumed before stop() wins, none of them can trip the limit-3 breaker.
  const sequence = [];
  for (let i = 0; i < 40; i++) sequence.push(i * 1000, i * 1000 + 500); // (start, end) => uptime 500ms each

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    scannerCrashLimit: 3,
    scannerHealthyUptimeMs: 400,
    deps: { spawn: spawnExit(0), spawnScanner: spawnExit(1), monotonicNowMs: mockClock(sequence) },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-crashed').length >= 6, 10000);

    const crashes = readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-crashed');
    assert.ok(crashes.length >= 6, `expected at least 6 scanner-crashed events, got ${crashes.length}`);
    assert.ok(
      crashes.every((e) => e.consecutiveScannerCrashes === 1),
      `every crash here follows healthy uptime, so consecutiveScannerCrashes must read 1 on all of them, got ${JSON.stringify(crashes.map((e) => e.consecutiveScannerCrashes))}`
    );
    assert.equal(
      readDaemonEvents(journalDir).some((e) => e.reason === 'scanner-crash-circuit-breaker'),
      false,
      'the breaker must never have tripped'
    );

    // Positive confirmation that run() is genuinely still active, not merely "hasn't resolved
    // yet": stop() only sets stopReason if nothing has already set it (dispatcher.js's own `if
    // (!stopReason)` guard), so if the breaker HAD already tripped, this would still read
    // 'scanner-crash-circuit-breaker' here, not 'stop-requested' -- there is no timing window in
    // which this assertion can pass by luck.
    dispatcher.stop();
    const stopReason = await runPromise;
    assert.equal(stopReason.reason, 'stop-requested', 'the dispatcher must have still been running when stop() was called');
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

// F1 (verifier finding, this action's own rework): the two tests above only ever exercise the
// case where consecutiveScannerCrashes and totalScannerCrashes happen to be EQUAL (no healthy
// reset occurred before the trip, or the breaker never trips at all) -- which means a straight
// SWAP of the two field values on the stopReason/event object would ship green through the whole
// suite, twice over. That is byte-for-byte the defect this action exists to close, in the one
// artifact a human reads once the daemon has stopped: `{"consecutiveScannerCrashes":9,
// "totalScannerCrashes":3}` transposed would read as "9 crashes in a row" for a scanner that
// actually crashed 3 in a row out of 9 total. This test is the one case where the two numbers
// MUST differ: a breaker trip that happens AFTER a healthy reset.
test('the breaker trips with consecutiveScannerCrashes and totalScannerCrashes at DIFFERENT values -- pins the two fields against a swap', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scandiverge-q-');
  const journalDir = mkTmp('spo-disp-scandiverge-j-');

  // Four scanner lifecycles: unhealthy, healthy (resets the streak), unhealthy, unhealthy.
  //   c1: 0-50      (uptime 50,   unhealthy) -> consecutive 1, total 1
  //   c2: 100-1400  (uptime 1300, healthy)   -> consecutive 1 (RESET), total 2
  //   c3: 1500-1550 (uptime 50,   unhealthy) -> consecutive 2, total 3
  //   c4: 1600-1650 (uptime 50,   unhealthy) -> consecutive 3 == scannerCrashLimit -> TRIPS, total 4
  // consecutiveScannerCrashes (3) and totalScannerCrashes (4) are DIFFERENT at the trip -- the one
  // scenario a same-value assertion could never catch a field swap on.
  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    scannerCrashLimit: 3,
    scannerHealthyUptimeMs: 400,
    deps: {
      spawn: spawnExit(0),
      spawnScanner: spawnExit(1),
      monotonicNowMs: mockClock([0, 50, 100, 1400, 1500, 1550, 1600, 1650]),
    },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const stopReason = await dispatcher.run(); // resolves on its own once the breaker trips

  // Literals named here, not recomputed from config, per this file's own standing rule on that
  // mistake (CLAUDE.md; this suite shipped it twice already cutting a safety constant). 3 is
  // scannerCrashLimit above; 4 is the 4th crash in the sequence commented above.
  assert.deepEqual(stopReason, {
    reason: 'scanner-crash-circuit-breaker',
    consecutiveScannerCrashes: 3,
    totalScannerCrashes: 4,
    scannerCrashLimit: 3,
  });

  const crashes = readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-crashed');
  assert.equal(crashes.length, 4);
  assert.deepEqual(
    crashes.map((e) => [e.consecutiveScannerCrashes, e.totalScannerCrashes]),
    [
      [1, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]
  );
  assert.equal(readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-spawn').length, 4, 'initial spawn + 3 respawns, then the breaker stops the 5th');
});

// The ONE test in this group that leaves `deps.monotonicNowMs` un-injected -- everything above
// proves the DECISION LOGIC is correct given a clock reading; this proves the PRODUCTION WIRING
// (spawnScanner's read at spawn, handleScannerExit's read at exit, both through the real
// `monotonicNowMs` from orchestrator/monotonic-clock.js) actually measures real elapsed wall-clock
// time end to end. Kept deliberately small -- 2 crashes, ~1.2s of real sleep total, not the ~7s
// the mock-clock rewrite above removed -- because this is the one place a mock CAN'T stand in for
// reality without begging the question.
test('with the REAL monotonic clock (no injected deps), a scanner that genuinely survives past the bar is measured and classified healthy', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scanrealclock-q-');
  const journalDir = mkTmp('spo-disp-scanrealclock-j-');

  // Spawn 1 crashes near-instantly (real, unhealthy). Spawn 2 genuinely sleeps HEALTHY_SLEEP_MS
  // (real `setTimeout` inside the child) before crashing.
  //
  // THE BAR AND THE SLEEP ARE DERIVED FROM A MEASUREMENT OF THE THING THAT ACTUALLY MOVES: the
  // cost of "near-instant" spawn 1, which is not zero but a whole node process boot, and which is
  // what the bar has to stay clear of. This test previously ran a 400ms bar against a claimed
  // "33-108ms near-instant spawn cost measured on this box under contention" -- a real
  // measurement, but taken on an IDLE box, where it still reproduces (28-42ms over 40 samples,
  // re-measured 2026-09-04). Under real full-suite load it does not hold:
  //
  //   spawn -> 'exit' handler, the exact interval dispatcher.js records as uptimeMs
  //     idle                    28ms min / 33ms p50 / 42ms max   (40 samples)
  //     under 8x full suite     44ms min / 93ms p50 / 206ms max  (40 samples)
  //     observed in the flake   402, 432, 460, 477ms             (real failures, 12x full suite)
  //
  // So the claimed 10x margin was ~1x: the 400ms bar sat INSIDE node's own spawn-cost tail, and
  // the test failed with `expected the near-instant crash to read well under 400ms, got 460` --
  // reporting a dispatcher that had measured a genuinely 460ms-long scanner entirely correctly.
  // Measured at 5 occurrences over 96 full-suite runs (issue #111).
  //
  // 2000ms is >4x the worst value ever observed for spawn 1 (477ms) and ~10x the 8x-load p90; the
  // sleep is 1.5x the bar, and load can only make a real sleep LONGER, never shorter, so that side
  // needs no tail margin at all. Only spawn 1's side was ever the race.
  //
  // NOT A PRODUCTION CONCERN, checked rather than assumed: 400 was only ever this FIXTURE's
  // scaled-down bar. config.js resolves the real scannerHealthyUptimeMs to
  // max(ORPHAN_SCAN_MS, UNPARK_SCAN_MS) = 60_000ms, ~125x the worst spawn cost above, so a
  // genuinely crash-looping production scanner is still classified unhealthy and still trips the
  // breaker. The flake lived in the fixture's constants, not in the code they exercise.
  const HEALTHY_BAR_MS = 2000;
  const HEALTHY_SLEEP_MS = 3000;
  let call = 0;
  const spawnScannerFn = (cmd, args, opts) => {
    call += 1;
    return call === 2 ? spawnScannerAliveFor(HEALTHY_SLEEP_MS, 1)(cmd, args, opts) : spawnExit(1)();
  };

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    scannerCrashLimit: 10,
    scannerHealthyUptimeMs: HEALTHY_BAR_MS,
    deps: { spawn: spawnExit(0), spawnScanner: spawnScannerFn }, // no monotonicNowMs override -- the real clock
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-crashed').length >= 2, 15000);
  } finally {
    dispatcher.stop();
    await runPromise;
  }

  const crashes = readDaemonEvents(journalDir).filter((e) => e.event === 'scanner-crashed');
  assert.equal(crashes.length, 2);
  assert.ok(
    crashes[0].uptimeMs < HEALTHY_BAR_MS,
    `expected the near-instant crash to read well under ${HEALTHY_BAR_MS}ms, got ${crashes[0].uptimeMs}`
  );
  assert.equal(crashes[0].consecutiveScannerCrashes, 1);
  assert.ok(
    crashes[1].uptimeMs >= HEALTHY_BAR_MS,
    `expected the real ${HEALTHY_SLEEP_MS}ms sleep to be measured as >= ${HEALTHY_BAR_MS}ms, got ${crashes[1].uptimeMs}`
  );
  assert.equal(crashes[1].consecutiveScannerCrashes, 1, 'the real elapsed time genuinely crossed the bar, so this must read as a reset, not an extension to 2');
});

// ---- the journalled event must name what it reports (this action's own requirement) -----------
//
// A maintainer diagnosing a stopped daemon reads daemon.jsonl, not this file -- so the exact field
// names and the exact numbers on both the per-crash event and the circuit-breaker stopReason are
// asserted literally here, not derived from the constant under test (this suite has shipped that
// mistake twice already -- see this file's own header / CLAUDE.md for the standing rule).
test('the scanner-crashed event and the circuit-breaker stopReason report consecutiveScannerCrashes and totalScannerCrashes under their own honest names', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scanfield-q-');
  const journalDir = mkTmp('spo-disp-scanfield-j-');

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    scannerCrashLimit: 1, // trips on the very first crash -- keeps this test to exactly one event of each kind
    scannerHealthyUptimeMs: 5000,
    deps: { spawn: spawnExit(0), spawnScanner: spawnExit(1), monotonicNowMs: mockClock([1000, 1042]) }, // uptime exactly 42ms
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const stopReason = await dispatcher.run();

  // The literals are 1 because scannerCrashLimit above is the literal 1 -- named here, not
  // recomputed from config, per this file's own standing rule on that mistake.
  assert.deepEqual(stopReason, {
    reason: 'scanner-crash-circuit-breaker',
    consecutiveScannerCrashes: 1,
    totalScannerCrashes: 1,
    scannerCrashLimit: 1,
  });

  const crashEvent = readDaemonEvents(journalDir).find((e) => e.event === 'scanner-crashed');
  assert.ok(crashEvent, 'expected a scanner-crashed event');
  assert.equal(crashEvent.consecutiveScannerCrashes, 1);
  assert.equal(crashEvent.totalScannerCrashes, 1);
  assert.equal(crashEvent.scannerCrashLimit, 1);
  // Exact values, driven by the mock clock above -- not merely `typeof === 'number'`, which a
  // hardcoded 0 would also satisfy. The uptime that drove the healthy/unhealthy decision, and the
  // threshold it was judged against, must both be visible to a reader with no other file open.
  assert.equal(crashEvent.uptimeMs, 42);
  assert.equal(crashEvent.scannerHealthyUptimeMs, 5000);
});

test('a scanner exit caused by the dispatcher\'s own shutdown is never counted as a crash or respawned', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-scanstop-q-');
  const journalDir = mkTmp('spo-disp-scanstop-j-');

  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(0), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'scanner-spawn'));

  dispatcher.stop();
  const stopReason = await runPromise; // killAllChildren fires inside run()'s own cleanup, below

  assert.equal(stopReason.reason, 'stop-requested');
  const events = readDaemonEvents(journalDir);
  assert.equal(events.filter((e) => e.event === 'scanner-spawn').length, 1, 'a shutdown-time exit must never trigger a respawn');
  assert.equal(events.some((e) => e.event === 'scanner-crashed'), false, 'a shutdown-time exit must never be counted as a crash');
  assert.ok(events.some((e) => e.event === 'scanner-exit-during-shutdown'), 'the shutdown-time exit should still be journalled, just not as a crash');
});

// ---- VERIFIER (action 6.3 REWORK): shutdown must leave NO child process behind ----------------
//
// Two rework mutations were killed ONLY BY HANGING, never by an assertion: removing
// handleScannerExit's `if (stopReason)` shutdown guard (so a shutdown-time scanner exit is
// miscounted as a crash and RESPAWNED, leaving a fresh detached scanner alive after run() has
// returned), and removing killAllChildren's scanner branch (so the scanner is never signalled at
// all). A hang is a weak kill: this suite has no per-test timeout, so it costs 150s and is easily
// mistaken for a slow run -- and here the hang IS the production symptom, not a test artifact.
// Children are spawned `detached: true`, so a leaked scanner survives its dispatcher, keeps
// holding whatever it was doing, and is NOT reached by `systemctl restart` (systemd kills the
// unit's cgroup, but a detached process group started by a test harness -- or orphaned by a
// dispatcher that exited without signalling it -- outlives the restart and then runs concurrently
// with the freshly started daemon's own scanner).
//
// So assert it directly and quickly: after run() resolves, every pid the dispatcher journalled as
// a child must be gone.
test('after run() returns, NO dispatcher-spawned child is still alive -- not the workers, and not the scanner', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-noleak-q-');
  const journalDir = mkTmp('spo-disp-noleak-j-');
  writeTask(queueDir, '0001-a.json', { id: 'noleak-a', kind: 'synthetic' });

  const config = baseConfig({
    workers: 1,
    claudeAccountsDir: onePoolDir(1),
    // BOTH children long-lived and real, so "still alive at the end" is the mutation's signature
    // rather than something that would have exited on its own anyway.
    deps: { spawn: neverExitsSpawn, spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();

  await waitFor(() => {
    const evts = readDaemonEvents(journalDir);
    return evts.some((e) => e.event === 'scanner-spawn') && evts.some((e) => e.event === 'worker-spawn');
  });

  dispatcher.stop();
  await runPromise;

  const events = readDaemonEvents(journalDir);
  const pids = events
    .filter((e) => e.event === 'scanner-spawn' || e.event === 'worker-spawn')
    .map((e) => e.pid)
    .filter((pid) => typeof pid === 'number');
  assert.ok(pids.length >= 2, `expected a scanner pid and a worker pid in the journal, got ${JSON.stringify(pids)}`);

  // killAllChildren is fire-and-forget (it is called from a synchronous exit hook in production),
  // so give the signal a bounded moment to land before judging -- but only a moment: a child still
  // alive after this is leaked, not slow.
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await waitFor(() => pids.every((pid) => !alive(pid)), 5000).catch(() => {});

  const survivors = pids.filter(alive);
  assert.deepEqual(
    survivors,
    [],
    `run() returned with ${survivors.length} child process(es) still alive (pids ${survivors.join(', ')}) -- ` +
      'a detached child that outlives its dispatcher is not reached by a systemd restart and will run ' +
      'concurrently with the next daemon'
  );

  // And exactly one scanner was ever started: a shutdown-time exit must not be respawned over.
  assert.equal(
    events.filter((e) => e.event === 'scanner-spawn').length,
    1,
    'the dispatcher respawned a scanner while shutting down'
  );
});

// ---- VERIFIER (action 6.3 REWORK): THE ACCEPTANCE CRITERION ITSELF ---------------------------
//
// This is the one thing the whole rework exists to buy, and until now it was demonstrated only by
// a one-off probe, never pinned: WHILE A SCAN IS BLOCKING, THE DISPATCHER'S OWN THREAD STAYS FREE.
//
// The first cut ran runScanCycle from run()'s own loop. That reaches intake.js's
// callIntakeStepWithRotation -> a BLOCKING spawnSync('claude', ...), measured at 3m11s-3m25s on
// the live daemon's own journal. Measured consequence on the dispatcher's thread, A/B against a
// real blocking child: worker reaping lag 9.2-11.8s vs 6ms, SIGTERM-to-handler 8.7-11.3s vs 0-1ms,
// a 100ms timer firing 3 times in 9s vs 87, slot refill 9.2-11.8s vs 11ms. The fix moved the scans
// into a sibling process (daemon.js --scanner).
//
// Every OTHER test in this file would stay green if a future edit put a blocking call back into
// run()'s loop -- they all use short-lived children and a 30ms poll interval, so "the loop is
// free" and "the loop is frozen for 2 seconds" are indistinguishable. This test makes them
// distinguishable: the scanner child BLOCKS ITS OWN THREAD for BLOCK_MS (a real execFileSync
// sleep, the same shape as the real spawnSync('claude')), and the dispatcher must still reap the
// worker and refill its slot LONG before that block ends. If the blocking work is ever back on the
// dispatcher's thread, the refill cannot happen until the block finishes, and this fails.
test('a BLOCKING scan in the scanner process does not stall the dispatcher: a worker is still reaped and its slot refilled mid-block', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-freethread-q-');
  const journalDir = mkTmp('spo-disp-freethread-j-');
  writeTask(queueDir, '0001-a.json', { id: 'freethread-a', kind: 'synthetic' });
  writeTask(queueDir, '0002-b.json', { id: 'freethread-b', kind: 'synthetic' });

  const BLOCK_MS = 2000; // the scanner's own thread, hard-blocked, like a real spawnSync('claude')
  const WORKER_MS = 300; // worker 1 exits well INSIDE that block
  const BUDGET_MS = 1200; // refill must beat the block by a wide margin -- measured at ~310ms

  // A REAL process that really blocks its own thread, then stays alive so it is never mistaken
  // for a crash-and-respawn. It marks `blockDoneFile` the instant its block ends -- that file, not
  // a clock reading, is how the assertion below knows whether the refill beat the block.
  const blockDoneFile = path.join(journalDir, 'scanner-block-finished');
  const blockingScanner = (cmd, args, opts) =>
    realSpawn(
      process.execPath,
      // Same orphan self-exit as neverExitsSpawn above, for the same measured reason.
      [
        '-e',
        `require('child_process').execFileSync('sleep', ['${BLOCK_MS / 1000}']); ` +
          `require('fs').writeFileSync(${JSON.stringify(blockDoneFile)}, '');` +
          'const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(0); }, 50);',
      ],
      { ...opts, stdio: 'ignore' }
    );
  const shortWorker = (cmd, args, opts) =>
    realSpawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${WORKER_MS});`], { ...opts, stdio: 'ignore' });

  const config = baseConfig({
    workers: 1, // K=1: task b can ONLY start once a's slot is freed and refilled
    pollIntervalMs: 8000, // >> BUDGET_MS, so a refill inside the budget can only be the exit-wake
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: shortWorker, spawnScanner: blockingScanner },
  });

  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    await waitFor(
      () => readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn').length >= 2,
      BUDGET_MS
    ).catch(() => {
      throw new Error(
        `the second worker was not spawned within ${BUDGET_MS}ms while the scanner was blocking for ${BLOCK_MS}ms -- ` +
          "the blocking work is on the DISPATCHER's own thread, which is exactly what moving the scans into a " +
          'sibling process was supposed to prevent'
      );
    });
    // THE REFILL BEAT THE BLOCK -- read off the scanner's OWN state, not off a clock.
    //
    // This was `elapsed < BLOCK_MS`, with `elapsed` measured from before run(). Both halves of
    // that comparison look like milliseconds and only one of them is: BLOCK_MS is a real `sleep 2`
    // in a child, which full-suite load does not slow down at all, while `elapsed` accumulates
    // this process's node boot, two child spawns and every scheduling delay the box inflicts on a
    // starved event loop. Under load `elapsed` crosses 2000ms while the dispatcher is still doing
    // exactly what this test exists to prove -- measured failing at `refilled after the scan's
    // 2000ms block finished (2147ms)`, 1/40 and 4/96 full-suite runs (issue #111, found by this
    // campaign rather than filed in it).
    //
    // `blockDoneFile` appears the instant the scanner's block ends, so its ABSENCE at the moment
    // the second worker spawned is the same claim without the clock: the slot was refilled while
    // the scan was still blocking. Starvation delays the refill and the file's creation by the
    // same event-loop backlog, so the ordering this reads is load-invariant where the subtraction
    // was not.
    assert.equal(
      fs.existsSync(blockDoneFile),
      false,
      `the freed slot was only refilled after the scan's ${BLOCK_MS}ms block finished -- the dispatcher's thread was not free`
    );
  } finally {
    // stop() is only noticed at the TOP of the next loop iteration, and this test deliberately
    // runs an 8s poll interval with a scanner that never exits on its own -- so without waking the
    // race explicitly, teardown would sit out the whole interval (measured: +4.9s on this file
    // alone). killAllChildren makes the scanner exit, which resolves the pending exit-watch this
    // loop is racing, so the stop is noticed immediately. Deliberately AFTER stop(), so
    // handleScannerExit sees stopReason already set and treats the exit as a shutdown rather than
    // a crash to respawn -- the same ordering daemon.js's own exit hook relies on.
    dispatcher.stop();
    dispatcher.killAllChildren('SIGTERM');
    await runPromise;
  }
});

test('daemon.js --scanner never acquires the single-instance lock', { timeout: 20000 }, async (t) => {
  const { lockPath } = require('../orchestrator/lock');
  const queueDir = mkTmp('spo-disp-scanlock-q-');
  const journalDir = mkTmp('spo-disp-scanlock-j-');

  // `--parent-pid` names THIS test runner (action 6.6 verification, Task 2). It does not change
  // what this test asserts -- a scanner still must not write daemon.lock -- but it is what stops
  // this long-lived real child outliving an interrupted run: measured, a SIGKILL of the runner at
  // the wrong instant left exactly this scanner alive with ppid 1, and the `finally` below cannot
  // help, because a killed runner never reaches it. With the flag, the scanner's own liveness
  // check reaps it within one loop iteration, no matter how the runner died.
  const scanner = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--scanner', '--queue', queueDir, '--journal', journalDir, '--parent-pid', String(process.pid)],
    { stdio: 'ignore', env: isolatedEnv() }
  );
  t.after(() => scanner.kill('SIGKILL'));
  try {
    // Give it a real window to have started up and, if it wrongly acquired a lock, to have
    // written one -- polled rather than a single check, since "never appears" can't be proven by
    // one instantaneous read.
    await sleep(300);
    assert.equal(fs.existsSync(lockPath(journalDir)), false, '--scanner must never write daemon.lock');

    // And, as the flip side of the same guarantee: a REAL dispatcher CAN start against this same
    // journal root right now, proving the scanner was never holding it.
    const second = realSpawn(process.execPath, [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir], {
      stdio: 'ignore',
      env: isolatedEnv(),
    });
    // A real dispatcher spawns a real scanner of its own; that one already carries the
    // --parent-pid this dispatcher passes it, so it follows its parent down either way.
    t.after(() => second.kill('SIGKILL'));
    try {
      await waitFor(() => fs.existsSync(lockPath(journalDir)), 15000);
    } finally {
      second.kill('SIGTERM');
      await new Promise((resolve) => second.once('exit', resolve));
    }
  } finally {
    scanner.kill('SIGTERM');
    await new Promise((resolve) => scanner.once('exit', resolve));
  }
});

// ---- live-workers.json: the cross-process publish/read round trip -----------------------------

test('live-workers.json is published on every worker spawn and exit, and always reflects the CURRENT live set', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-liveids-q-');
  const journalDir = mkTmp('spo-disp-liveids-j-');
  writeTask(queueDir, '0001-a.json', slowDoneTask('liveids-a', 150));
  writeTask(queueDir, '0002-b.json', slowDoneTask('liveids-b', 150));

  const config = baseConfig({
    workers: 2,
    claudeAccountsDir: onePoolDir(2),
    deps: { spawn: spawnIsolated, spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    // While both are running: the file names BOTH ids, and never the scanner (it has no taskDir
    // to own, so publishLiveWorkerIds must never include it -- see dispatcher.js's own comment).
    await waitFor(() => {
      const ids = readLiveWorkerIds(journalDir);
      return ids.has('liveids-a') && ids.has('liveids-b');
    });
    const midRun = readLiveWorkerIds(journalDir);
    assert.deepEqual([...midRun].sort(), ['liveids-a', 'liveids-b']);

    // The write is genuinely atomic (tmp+rename) -- the file on disk is always complete JSON,
    // never half-written, even read directly rather than through the tolerant helper.
    const raw = JSON.parse(fs.readFileSync(liveWorkersPath(journalDir), 'utf8'));
    assert.ok(Array.isArray(raw.ids));
    assert.ok(typeof raw.updatedAt === 'string');

    // Once both finish: the file catches up to empty -- not stale forever, not left naming a
    // task that is now terminal.
    await waitFor(() => {
      const a = readState(journalDir, 'liveids-a');
      const b = readState(journalDir, 'liveids-b');
      return a && a.state === 'DONE' && b && b.state === 'DONE';
    });
    await waitFor(() => readLiveWorkerIds(journalDir).size === 0);
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});

test('readLiveWorkerIds tolerates a missing file (no dispatcher has ever run here) -- an empty Set, never a throw', () => {
  const journalDir = mkTmp('spo-disp-liveids-missing-j-');
  assert.deepEqual(readLiveWorkerIds(journalDir), new Set());
});

// ---- action 6.4 (post-verification): WHAT DOES THE CHILD ACTUALLY RESOLVE? -------------------
//
// A worker and a scanner resolve their own config from config.js (env) plus the argv this module
// builds. Nothing else crosses the process boundary except inherited process.env -- so any config
// key whose value comes from a daemon.js CLI FLAG is silently lost unless it is forwarded here.
//
// This has now bitten twice. 6.3's own verification found `--queue` missing from buildScannerArgv
// (1273 tests passed). 6.4's found `--workers` missing from buildWorkerArgv: a `--workers 2`
// dispatcher spawned children resolving `config.workers === 1`, which made
// product-repo-lock.js's waitBoundMs ((K-1) x WORST_HOLD_MS) exactly ZERO -- so the second
// concurrent card parked `product-repo-lock-timeout` on its first failed acquire instead of
// waiting. Both were one missing string in an argv array, and both passed the whole suite.
//
// So the standing rule is not "forward this one flag", it is: EVERY flag daemon.js accepts is
// explicitly classified below, for BOTH child kinds. Adding a flag to daemon.js without deciding
// what a child should do with it fails this test.
const DAEMON_FLAG_POLICY = {
  // mode selectors -- forwarded as the single mode flag both builders derive from this config
  '--shadow': { worker: 'mode', scanner: 'mode' },
  '--dry-run': { worker: 'mode', scanner: 'mode' },
  '--real': { worker: 'mode', scanner: 'mode' },
  // forwarded verbatim: a child that fell back to the repo default queue/journal would drain a
  // queue nobody fills and journal where nobody reads
  '--queue': { worker: 'forward', scanner: 'forward' },
  '--journal': { worker: 'forward', scanner: 'forward' },
  // forwarded to the worker only: it governs ONE step's deadline, and only a worker runs steps
  '--deadline-ms': { worker: 'forward', scanner: 'n/a: a scanner never runs a state handler' },
  // action 6.4: forwarded to the worker because product-repo-lock.js derives its wait bound from K.
  // action 6.6 verification: forwarded to the SCANNER too. The row used to read
  // "n/a: a scanner never takes the product-repo lock", which was a true statement about the only
  // consumer of K that existed when 6.4 wrote it -- and became a stale certification the moment
  // 6.6 made auto-pull.js's watermark (`in-flight + queued <= K`) a second consumer, running in
  // the scanner. This is the failure mode the table itself exists to catch, arriving from the
  // other direction: not a new flag nobody classified, but an old classification whose reason
  // quietly expired. A row's justification is part of the assertion, not a comment.
  '--workers': { worker: 'forward', scanner: 'forward' },
  // NOT forwarded, deliberately: these select what the child IS, and the builders set them
  '--worker': { worker: 'self', scanner: 'n/a' },
  '--scanner': { worker: 'n/a', scanner: 'self' },
  // action 6.6 verification (Task 2): the scanner alone is told the dispatcher pid it must not
  // outlive. A worker needs no such flag -- it runs one task and exits, and the dispatcher awaits
  // that exit; the scanner's for(;;) is the only child loop that can outlive its parent.
  '--parent-pid': { worker: 'n/a: a worker exits on its own, and is awaited', scanner: 'forward' },
  // NOT forwarded, deliberately: pollIntervalMs is read ONLY by dispatcher.js's own supervision
  // loop. A worker runs one task and exits; a scanner has its own scan cadences.
  '--interval-ms': { worker: "n/a: dispatcher's own loop cadence", scanner: "n/a: dispatcher's own loop cadence" },
  // NOT forwarded: --once drains a queue serially in-process, which is the mode the dispatcher
  // REPLACES; a child is never spawned in it.
  '--once': { worker: 'n/a: a worker runs exactly one task by construction', scanner: 'n/a' },
  '--help': { worker: 'n/a', scanner: 'n/a' },
  '-h': { worker: 'n/a', scanner: 'n/a' },
};

test('every daemon.js CLI flag is explicitly classified for BOTH child kinds -- a new flag cannot be added without deciding what a child resolves', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'daemon.js'), 'utf8');
  const parsed = new Set();
  for (const m of src.matchAll(/a === '(--?[a-z-]+)'/g)) parsed.add(m[1]);

  assert.ok(parsed.size >= 12, `expected daemon.js to parse a dozen-odd flags, found ${parsed.size}`);
  for (const flag of parsed) {
    assert.ok(
      DAEMON_FLAG_POLICY[flag],
      `daemon.js accepts ${flag} but DAEMON_FLAG_POLICY does not say what a worker/scanner child should resolve for it. ` +
        `Decide, then add a row -- this is the check that would have caught 6.3's missing --queue and 6.4's missing --workers.`
    );
  }
  for (const flag of Object.keys(DAEMON_FLAG_POLICY)) {
    assert.ok(parsed.has(flag), `DAEMON_FLAG_POLICY lists ${flag}, which daemon.js no longer accepts -- drop the row`);
  }
});

test('buildWorkerArgv: --workers is forwarded, so a worker resolves the SAME K its dispatcher did (product-repo-lock.js derives its wait bound from it)', () => {
  const { buildWorkerArgv } = require('../orchestrator/dispatcher');
  const argv = buildWorkerArgv('/t', '/q', '/j', { real: true, workers: 3 });
  const i = argv.indexOf('--workers');
  assert.ok(i > 0, 'the worker argv must carry --workers -- without it the child resolves K=1 and waitBoundMs becomes 0');
  assert.equal(argv[i + 1], '3');

  // And the value must be THIS dispatcher's K, not a constant that happens to look right at K=2.
  assert.equal(buildWorkerArgv('/t', '/q', '/j', { real: true, workers: 7 })[i + 1], '7');

  // A missing/invalid K omits the flag rather than forwarding NaN -- the child then falls back to
  // config.js's own default, the same posture daemon.js applies to a bad --workers.
  assert.equal(buildWorkerArgv('/t', '/q', '/j', { real: true }).includes('--workers'), false);
  assert.equal(buildWorkerArgv('/t', '/q', '/j', { real: true, workers: 0 }).includes('--workers'), false);
});

test('a worker child spawned by a --workers K dispatcher resolves K, and therefore a NON-ZERO product-repo lock wait bound', () => {
  const { buildWorkerArgv } = require('../orchestrator/dispatcher');
  const argv = buildWorkerArgv('/t', '/q', '/j', { real: true, workers: 2 });
  // Resolve the child's own config the way daemon.js does: config.js's defaults, then the argv
  // override. Asserted through product-repo-lock.js's real waitBoundMs, because "K reached the
  // child" only matters for what the child then DERIVES from it.
  const { waitBoundMs, WORST_HOLD_MS } = require('../orchestrator/product-repo-lock');
  const k = Number(argv[argv.indexOf('--workers') + 1]);
  assert.equal(waitBoundMs({ workers: k }), WORST_HOLD_MS, 'at K=2 a worker must be willing to wait out ONE other worst-case holder');
  assert.notEqual(waitBoundMs({ workers: k }), 0, 'a zero wait bound is the defect: the card parks instead of waiting');
});

// ---- action 6.7 verification: the dispatcher stamps its own startup into daemon.jsonl ---------
//
// `idleNoHealthyAccounts` (fillSlots) is IN-MEMORY, and the dispatcher-idle/-returned pair it
// drives is EDGE-triggered. A restart destroys that memory, so if the pool goes idle, the daemon
// restarts (this project's post-merge hook SIGTERMs it on every merge), and the pool then
// recovers, the `returned` edge is never written -- leaving a bare idle edge as daemon.jsonl's
// newest dispatcher event forever. bin/spo's computeDispatcherIdleStatus answers "is the
// dispatcher idle right now" by walking back to the newest edge, so without a startup boundary it
// reported a permanent false alarm (measured: "IDLE since 191h06m ago" on a busy fixture).
test('the dispatcher writes a dispatcher-start event at startup -- the boundary `spo status` stops its idle walk at', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-disp-start-q-');
  const journalDir = mkTmp('spo-disp-start-j-');
  const config = baseConfig({
    claudeAccountsDir: onePoolDir(1),
    deps: { spawn: spawnExit(0), spawnScanner: neverExitsSpawn },
  });
  const dispatcher = createDispatcher(queueDir, journalDir, config);
  const runPromise = dispatcher.run();
  try {
    const daemonLog = path.join(journalDir, 'daemon.jsonl');
    await waitFor(() => fs.existsSync(daemonLog) && fs.readFileSync(daemonLog, 'utf8').includes('dispatcher-start'));
    const events = fs
      .readFileSync(daemonLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const start = events.find((e) => e.event === 'dispatcher-start');
    assert.ok(start, 'a dispatcher must stamp its own start');
    assert.equal(start.pid, process.pid, 'the dispatcher runs in-process here -- the pid is this one');
    assert.equal(typeof start.workers, 'number', 'K is recorded, so the line says what this process was configured for');

    // It must come BEFORE the scanner spawn, for the same reason publishLiveWorkerIds does: the
    // boundary has to already be on disk before anything the dispatcher starts can journal.
    const startIdx = events.findIndex((e) => e.event === 'dispatcher-start');
    const scannerIdx = events.findIndex((e) => e.event === 'scanner-spawn');
    if (scannerIdx !== -1) assert.ok(startIdx < scannerIdx, 'dispatcher-start must precede scanner-spawn');
  } finally {
    dispatcher.stop();
    await runPromise;
  }
});
