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
const { writeState: writeTaskState, readLiveWorkerIds, liveWorkersPath } = require('../orchestrator/journal');
const { createDispatcher } = require('../orchestrator/dispatcher');
const { takeNextTask } = require('../orchestrator/state-machine');
const { mkTmp, writeTask, writePoolDir, isolatedEnv, readState, readJournal } = require('./helpers');

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
  return realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { ...opts, stdio: 'ignore' });
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

test('K=1: a task runs to DONE through a real spawned worker; worker-spawn/worker-exit are journalled', { timeout: 20000 }, async () => {
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

test('K=2: two tasks run concurrently -- real overlap, not two runs that merely both finished', { timeout: 20000 }, async () => {
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

// ---- 7. K is clamped to healthy accounts before each spawn

test('K is clamped to the number of healthy accounts before each spawn, even when configured higher', { timeout: 20000 }, async () => {
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
    await sleep(60); // well inside the 150ms IMPLEMENT delay -- the second task must still be untouched
    const spawns = readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn');
    assert.equal(spawns.length, 1, 'a second worker spawned despite only one healthy account');

    await waitFor(() => readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn').length === 2, 8000);
    await waitFor(() => {
      const a = readState(journalDir, 'clamp-a');
      const b = readState(journalDir, 'clamp-b');
      return a && a.state === 'DONE' && b && b.state === 'DONE';
    });
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

  const LIVE_MS = 300;
  const fakeLiveWorker = () =>
    realSpawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${LIVE_MS})`], { stdio: 'ignore' });

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
    assert.equal(alive(spawnEvt.pid), true, 'the live worker already exited -- raise LIVE_MS, this did not prove concurrency');

    const orphanState = readState(journalDir, orphanId);
    assert.equal(orphanState.reason, 'task-orphaned-daemon-restart');

    await waitFor(() => !alive(spawnEvt.pid)); // let the fake live worker finish on its own
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
  assert.equal(stopReason.scannerCrashLimit, 2);

  const events = readDaemonEvents(journalDir);
  assert.equal(events.filter((e) => e.event === 'scanner-spawn').length, 2, 'expected exactly 2 spawns -- the initial one plus one respawn, then the breaker stops a third');
  assert.equal(events.filter((e) => e.event === 'scanner-crashed').length, 2);
  // Never counted against, or confused with, the WORKER breaker's own fields.
  assert.equal(events.some((e) => e.event === 'worker-crashed' || e.reason === 'worker-crash-circuit-breaker'), false);
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
  // for a crash-and-respawn.
  const blockingScanner = (cmd, args, opts) =>
    realSpawn(
      process.execPath,
      ['-e', `require('child_process').execFileSync('sleep', ['${BLOCK_MS / 1000}']); setInterval(() => {}, 1e6);`],
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
  const startedAt = Date.now();
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
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < BLOCK_MS,
      `the freed slot was only refilled after the scan's ${BLOCK_MS}ms block finished (${elapsed}ms) -- the dispatcher's thread was not free`
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

test('daemon.js --scanner never acquires the single-instance lock', { timeout: 20000 }, async () => {
  const { lockPath } = require('../orchestrator/lock');
  const { DAEMON } = require('./helpers');
  const queueDir = mkTmp('spo-disp-scanlock-q-');
  const journalDir = mkTmp('spo-disp-scanlock-j-');

  const scanner = realSpawn(process.execPath, [DAEMON, '--shadow', '--scanner', '--queue', queueDir, '--journal', journalDir], {
    stdio: 'ignore',
    env: isolatedEnv(),
  });
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
  // action 6.4: forwarded to the worker because product-repo-lock.js derives its wait bound from K
  '--workers': { worker: 'forward', scanner: 'n/a: a scanner never takes the product-repo lock' },
  // NOT forwarded, deliberately: these select what the child IS, and the builders set them
  '--worker': { worker: 'self', scanner: 'n/a' },
  '--scanner': { worker: 'n/a', scanner: 'self' },
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
