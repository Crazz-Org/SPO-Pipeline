'use strict';
// Tests for the SIGTERM drain -- dispatcher.js's requestDrain/awaitInFlight and daemon.js's
// signal handlers.
//
// THE INCIDENT. `git pull` in the pipeline checkout fires scripts/git-hooks/post-merge, which
// restarts the unit. Until the drain, every signal was `process.exit(143)` on the spot and
// daemon.js's exit hook then SIGTERMed every worker's process group. So the deploy path WAS the
// kill path. Measured on 2026-09-05 at 04:23:43, one pull, two cards: #517 parked
// `npm-run-timed-out` at MERGE and #515 `llm-transport-failed:PLAN` at PLAN.
//
// WHAT A DRAIN HAS TO GET RIGHT, and each of these is a test below rather than a claim:
//   - stop CLAIMING at once (the scanner is the only producer of new queue entries, so it dies
//     first, before the loop has even noticed);
//   - stop KILLING, and wait instead -- bounded, because a card's p95 is 45.7 minutes;
//   - stay honest when the bound expires (survivors named, signalled, exit code says so);
//   - leave the pre-drain behaviour reachable, on the second signal and on
//     SPO_DRAIN_TIMEOUT_MS=0;
//   - not swallow a GENUINE crash that lands inside the drain window.
//
// THE LAST TEST IS THE LOAD-BEARING ONE. Everything above it calls requestDrain directly, which
// proves the function works and says nothing about whether a real SIGTERM to a real daemon
// reaches it -- this repo has paid for that distinction before. So the final test starts an
// actual `node orchestrator/daemon.js` process, sends it an actual SIGTERM, and reads the exit
// code and the journal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

require('./no-real-spawn');

const defaultConfig = require('../orchestrator/config');
const { createDispatcher } = require('../orchestrator/dispatcher');
const { mkTmp, writeTask, writePoolDir, isolatedEnv, readState, runDaemonWorker, readJournal, DAEMON, runSpo } = require('./helpers');
// Card #188: section 17 below reads the SAME liveness derivation `spo status` and the deck use --
// console/dispatcher-status.js's computeDispatcherStatus injected with orchestrator/lock.js's
// `pidExists`, the same function bin/spo and console/collect.js inject, never a second liveness
// probe of its own.
const { computeDispatcherStatus } = require('../console/dispatcher-status');
const { processAlive, pidExists } = require('../orchestrator/lock');
const { collectAll } = require('../console/collect');
const { renderServicesInner, renderDataFragments, renderHealthPage } = require('../console/render');

function readDaemonEvents(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function waitFor(predicate, timeoutMs = 10000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// See test/dispatcher.test.js's own copy for the orphan-exit reasoning this repeats: a `detached`
// stand-in must self-terminate when the test runner's group is SIGKILLed, or it leaks.
function neverExitsSpawn(cmd, args, opts) {
  return realSpawn(
    process.execPath,
    ['-e', 'const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(0); }, 50);'],
    { ...opts, stdio: 'ignore' }
  );
}

// Real `child_process.spawn`, isolated the same way every other daemon subprocess in this suite is
// (test/helpers.js's isolatedEnv) -- see test/dispatcher.test.js's own copy of this helper. Card
// #78: needed here as `deps.spawnRepark` wherever a test asserts on a repark ACTUALLY completing
// (state.json reaching PARKED, reason 'worker-crashed') -- the park now runs in a spawned
// `daemon.js --repark-task` child, and a fake `deps.spawn` fallback (one that ignores its own argv)
// would never run it for real.
function spawnIsolated(cmd, args, opts) {
  return realSpawn(cmd, args, { ...opts, env: isolatedEnv() });
}

function baseConfig(overrides = {}) {
  const poolDir = mkTmp('spo-drain-pool-');
  writePoolDir(poolDir, [{ name: 'pool1' }]);
  return {
    ...defaultConfig,
    shadowMode: true,
    dryRun: false,
    workers: 1,
    pollIntervalMs: 25,
    claudeAccountsDir: poolDir,
    deps: { spawnScanner: neverExitsSpawn },
    ...overrides,
  };
}

// A REAL worker stand-in that runs for `ms` and then exits 0 -- "a card in flight". Real process,
// own group, exactly like the daemon.js --worker it stands in for; the dispatcher cannot tell the
// difference and neither can a SIGTERM.
function slowWorkerSpawn(ms) {
  return (cmd, args, opts) =>
    realSpawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${ms});`], { ...opts, stdio: 'ignore' });
}

// ---- 1. an in-flight card finishes, and the drain says so -------------------------------------

test('drain: an in-flight card runs to completion instead of being killed', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-q-');
  const journalDir = mkTmp('spo-drain-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-a', kind: 'synthetic' });

  const dispatcher = createDispatcher(queueDir, journalDir, baseConfig({ deps: { spawn: slowWorkerSpawn(1500), spawnScanner: neverExitsSpawn } }));
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');

  assert.equal(dispatcher.requestDrain({ signal: 'SIGTERM' }), true);
  const stopReason = await runPromise;

  const events = readDaemonEvents(journalDir);
  const start = events.find((e) => e.event === 'dispatcher-drain-start');
  const end = events.find((e) => e.event === 'dispatcher-drain-end');
  assert.ok(start, 'no dispatcher-drain-start');
  assert.equal(start.signal, 'SIGTERM');
  assert.deepEqual(start.inFlight, ['drain-a']);
  // Card #188: `run()` above executes in THIS process (createDispatcher/.run() called directly,
  // no child spawned for the dispatcher itself), so `process.pid` here is exactly the pid that
  // wrote the event -- the most direct proof the new field reaches production code, independent
  // of section 17's own end-to-end real-daemon coverage.
  assert.equal(start.pid, process.pid, 'dispatcher-drain-start must carry the writing process\'s own pid');
  // REASON (driver decision, card #188): read off the in-memory `stopReason` at drain time
  // (`(stopReason && stopReason.reason) || null`) rather than assumed -- here `requestDrain` is
  // the only thing that ever set `stopReason` (no prior `stop()` call), so it must read exactly
  // what `requestDrain` itself set it to.
  assert.equal(start.reason, 'drain-requested', 'dispatcher-drain-start must carry the real in-memory stopReason at drain time');
  assert.ok(end, 'no dispatcher-drain-end');
  assert.equal(end.drained, true, 'the drain did not wait for the card');
  assert.deepEqual(end.survivors, []);
  assert.equal(stopReason.drained, true);

  // Action 3.3: `dispatcher-stopped` is journalled with `stopReason` spread flat, hoisted (card
  // #162) to land right after the drain merge and before the kill+reap rather than at run()'s own
  // return -- on the DRAIN path specifically, proving the journal record matches what the
  // caller's own `await runPromise` eventually got back (`stopReason` above): nothing mutates
  // `stopReason` between this earlier emit and that later return.
  const stopped = events.find((e) => e.event === 'dispatcher-stopped');
  assert.ok(stopped, 'no dispatcher-stopped');
  assert.equal(stopped.reason, 'drain-requested');
  assert.equal(stopped.drained, true);
  assert.deepEqual(stopped.survivors, []);

  // The card exited 0 on its own. Killed, it would have been (code null, signal SIGTERM) -- which
  // is exactly what this test was red with before the drain existed.
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'drain-a');
  assert.ok(exitEvt, 'no worker-exit');
  assert.equal(exitEvt.code, 0, `card was killed, not drained: ${JSON.stringify(exitEvt)}`);
  assert.equal(exitEvt.signal, null);
  assert.equal(exitEvt.outcome, 'done');
});

// ---- 1b. the drain-start append itself throwing must not skip the wait (card #188) -------------

// `dispatcher-drain-start`'s own appendDaemonEvent is wrapped in try/catch specifically so an
// ENOSPC/EPERM/EROFS-class failure cannot reject run() and skip the drain entirely (see the
// comment at its call site). Reproduced here with test/journal.test.js's EISDIR technique: replace
// daemon.jsonl with a DIRECTORY right after dispatcher-start is written, so every further
// appendDaemonEvent call gets EISDIR. No task is queued (no worker to spawn), which keeps this
// test isolated to exactly the write this card's try/catch covers -- `worker-spawn`/`worker-exit`
// never fire, so their own (unrelated, unwrapped) appendDaemonEvent calls are not exercised by
// this test at all.
test('drain: dispatcher-drain-start append throwing (EISDIR) does not stop the drain from resolving (card #188)', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-drain-eisdir-q-');
  const journalDir = mkTmp('spo-drain-eisdir-j-');
  const dispatcher = createDispatcher(queueDir, journalDir, baseConfig({ deps: { spawnScanner: neverExitsSpawn } }));
  const runPromise = dispatcher.run();

  const daemonJsonl = path.join(journalDir, 'daemon.jsonl');
  await waitFor(
    () => fs.existsSync(daemonJsonl) && fs.readFileSync(daemonJsonl, 'utf8').includes('dispatcher-start'),
    10000,
    'dispatcher-start written'
  );

  // Corrupt the journal file into a directory -- every appendDaemonEvent call after this point
  // (including the drain-start write below) throws EISDIR out of its appendFileSync (the recursive
  // mkdirSync on journalDir itself, the directory ONE LEVEL UP from daemon.jsonl, still succeeds --
  // journalDir is untouched by this corruption and already exists).
  fs.unlinkSync(daemonJsonl);
  fs.mkdirSync(daemonJsonl);

  assert.equal(dispatcher.requestDrain({ signal: 'SIGTERM' }), true);
  const stopReason = await runPromise;

  // THE DISCRIMINATING ASSERTION: run() resolved at all, with the drain's own outcome, rather than
  // rejecting or hanging -- the exact failure the missing try/catch would have caused (an
  // unwrapped throw here rejects run() and skips the wait, turning a graceful shutdown into a
  // crash on the way out; see this call site's own comment).
  assert.equal(stopReason.reason, 'drain-requested');
  assert.equal(stopReason.drained, true, 'no cards were in flight -- the drain should still read as clean');
});

// ---- 1c. drain-start's `reason` is the ACTUAL stopReason, not a hardcoded 'drain-requested' (card #188) --

// A `stop({reason})` call landing before `requestDrain` does is the in-process API shape that
// actually reaches this (recette.js's watchdog calls `dispatcher.stop({...tripped})` on a wall-
// clock/LLM-step cap, never `requestDrain` -- see dispatcher.js's own comment on this call site,
// grepped against orchestrator/recette.js and orchestrator/daemon.js). Both calls here are plain,
// synchronous function calls with no `await` between them, so by the time run()'s own loop next
// gets to run, BOTH `stopReason` (from stop()) and `drainRequest` (from requestDrain()) are
// already set -- requestDrain's own `if (!stopReason) stopReason = {...}` guard is then a no-op,
// leaving stop()'s reason in place.
test("drain: stop({reason}) landing before requestDrain leaves THAT reason on drain-start, not a hardcoded 'drain-requested' (card #188)", { timeout: 15000 }, async () => {
  const queueDir = mkTmp('spo-drain-reason-q-');
  const journalDir = mkTmp('spo-drain-reason-j-');
  const dispatcher = createDispatcher(queueDir, journalDir, baseConfig({ deps: { spawnScanner: neverExitsSpawn } }));
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-start'), 10000, 'dispatcher-start');

  dispatcher.stop({ reason: 'wall-clock-cap-exceeded' });
  assert.equal(dispatcher.requestDrain({ signal: 'SIGTERM' }), true, 'requestDrain must still accept the drain even though stopReason is already set');
  const stopReason = await runPromise;

  const events = readDaemonEvents(journalDir);
  const start = events.find((e) => e.event === 'dispatcher-drain-start');
  assert.ok(start, 'no dispatcher-drain-start');
  // THE DISCRIMINATING ASSERTION: a hardcoded `'drain-requested'` at the write site would
  // pass every OTHER test in this file (every other drain here really was requested) but fail
  // only this one, where an earlier stop() decided the reason first.
  assert.equal(
    start.reason,
    'wall-clock-cap-exceeded',
    'dispatcher-drain-start must carry the ACTUAL stopReason set before requestDrain, not a hardcoded drain-requested'
  );
  assert.equal(stopReason.reason, 'wall-clock-cap-exceeded');
});

// ---- 2. claiming stops at once ----------------------------------------------------------------

test('drain: no further card is claimed once the drain starts', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-q-');
  const journalDir = mkTmp('spo-drain-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-a', kind: 'synthetic' });
  writeTask(queueDir, '0002-b.json', { id: 'drain-b', kind: 'synthetic' });

  const dispatcher = createDispatcher(queueDir, journalDir, baseConfig({ deps: { spawn: slowWorkerSpawn(900), spawnScanner: neverExitsSpawn } }));
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');

  dispatcher.requestDrain({ signal: 'SIGTERM' });
  await runPromise;

  const spawned = readDaemonEvents(journalDir).filter((e) => e.event === 'worker-spawn').map((e) => e.id);
  // K=1, so drain-b could only ever have been claimed by a fillSlots pass that ran AFTER drain-a
  // finished -- i.e. by the drain waiting with the claiming half still live.
  assert.deepEqual(spawned, ['drain-a'], 'the drain kept claiming while it waited');
  assert.equal(fs.existsSync(path.join(queueDir, '0002-b.json')), true, 'drain-b left the queue');
});

// ---- 3. the scanner dies immediately, not after the wait ---------------------------------------

test('drain: the scanner is signalled before the wait, not after it', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-q-');
  const journalDir = mkTmp('spo-drain-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-a', kind: 'synthetic' });

  let scannerPid = null;
  const trackedScannerSpawn = (cmd, args, opts) => {
    const child = neverExitsSpawn(cmd, args, opts);
    scannerPid = child.pid;
    return child;
  };
  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({ deps: { spawn: slowWorkerSpawn(4000), spawnScanner: trackedScannerSpawn } })
  );
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');
  assert.ok(scannerPid, 'no scanner was spawned');

  dispatcher.requestDrain({ signal: 'SIGTERM' });
  // The worker still has ~4s to run, so anything observed here is observed DURING the drain wait.
  await waitFor(
    () => {
      try {
        process.kill(scannerPid, 0);
        return false;
      } catch {
        return true; // ESRCH -- gone
      }
    },
    3000,
    'the scanner to die during the drain wait'
  );
  const stillRunning = readDaemonEvents(journalDir).filter((e) => e.event === 'worker-exit');
  assert.deepEqual(stillRunning, [], 'the worker was already gone -- this proved nothing about ordering');

  await runPromise;
});

// ---- 4. the bound is real, and expiring it is reported honestly ---------------------------------

test('drain: when the bound expires, survivors are named and signalled', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-q-');
  const journalDir = mkTmp('spo-drain-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-a', kind: 'synthetic' });

  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({ drainTimeoutMs: 300, deps: { spawn: neverExitsSpawn, spawnScanner: neverExitsSpawn } })
  );
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');

  dispatcher.requestDrain({ signal: 'SIGTERM' });
  const stopReason = await runPromise;

  const end = readDaemonEvents(journalDir).find((e) => e.event === 'dispatcher-drain-end');
  assert.equal(end.drained, false);
  assert.deepEqual(end.survivors, ['drain-a']);
  // drain-end is written AFTER the reap, so `outcomes` says what actually became of the card the
  // deploy interrupted -- "we stopped waiting" and "a card was lost" are different facts.
  assert.deepEqual(end.outcomes, [{ id: 'drain-a', outcome: 'crashed' }]);
  assert.ok(end.waitedMs >= 300, `waited ${end.waitedMs}ms, expected at least the 300ms bound`);
  assert.equal(stopReason.drained, false);
  // And it did NOT wait forever: without the bound this test would hang until node:test's own
  // timeout, which is what the {timeout: 30000} above would report.
  assert.ok(end.waitedMs < 20000, `waited ${end.waitedMs}ms -- the bound did not apply`);
});

// ---- 5/6. the escape hatches -------------------------------------------------------------------

test('drain: a second request is refused (the operator escape hatch daemon.js turns into an exit)', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-q-');
  const journalDir = mkTmp('spo-drain-j-');
  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({ drainTimeoutMs: 200, deps: { spawn: neverExitsSpawn, spawnScanner: neverExitsSpawn } })
  );
  const runPromise = dispatcher.run();
  assert.equal(dispatcher.requestDrain({ signal: 'SIGTERM' }), true);
  assert.equal(dispatcher.requestDrain({ signal: 'SIGTERM' }), false, 'a second drain request was accepted');
  await runPromise;
});

test('drain: drainTimeoutMs=0 refuses the drain entirely (pre-drain behaviour restored)', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-q-');
  const journalDir = mkTmp('spo-drain-j-');
  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({ drainTimeoutMs: 0, deps: { spawn: neverExitsSpawn, spawnScanner: neverExitsSpawn } })
  );
  const runPromise = dispatcher.run();
  assert.equal(dispatcher.requestDrain({ signal: 'SIGTERM' }), false);
  assert.equal(readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-drain-start'), false);
  dispatcher.stop({ reason: 'test-done' });
  await runPromise;
});

// ---- 7. a genuine crash inside the drain window is still a crash --------------------------------

test('drain: a worker that crashes DURING the drain is reparked, not written off as shutdown noise', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-q-');
  const journalDir = mkTmp('spo-drain-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-crash', kind: 'synthetic' });

  // Exits 7 (an unclassifiable code -> 'crashed') 600ms in: long enough that the drain is
  // already waiting when it happens.
  const crashLate = (cmd, args, opts) =>
    realSpawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 600);'], { ...opts, stdio: 'ignore' });

  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({
      drainTimeoutMs: 15000,
      // Card #78: `spawnRepark: spawnIsolated` -- the repark now runs in a spawned
      // `daemon.js --repark-task` child, not in this process; without this override it would fall
      // back to `deps.spawn` (crashLate, which ignores its own argv), and state.json would never
      // actually reach PARKED for this assertion to observe.
      deps: { spawn: crashLate, spawnScanner: neverExitsSpawn, spawnRepark: spawnIsolated },
    })
  );
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');
  dispatcher.requestDrain({ signal: 'SIGTERM' });
  await runPromise;

  const events = readDaemonEvents(journalDir);
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'drain-crash');
  assert.equal(exitEvt.outcome, 'crashed');
  // The distinction that matters: `duringShutdown` defers recovery to the next start's orphanScan
  // (`task-orphaned-daemon-restart` -- terminal, needs a human `retry`). Nothing signalled this
  // worker, so calling it shutdown noise would silently downgrade a real crash.
  assert.equal(exitEvt.duringShutdown, undefined, 'a real crash was written off as shutdown noise');
  assert.equal(
    events.some((e) => e.event === 'worker-exit-during-shutdown' && e.id === 'drain-crash'),
    false
  );
  assert.equal(readState(journalDir, 'drain-crash').reason, 'worker-crashed');
});

// ---- 8. the real thing: a real SIGTERM to a real daemon ------------------------------------------

test('drain: a real SIGTERM to a real daemon process drains and exits 0', { timeout: 60000 }, async () => {
  const queueDir = mkTmp('spo-drain-real-q-');
  const journalDir = mkTmp('spo-drain-real-j-');
  // A shadow task with a deliberate delay in IMPLEMENT: long enough that the SIGTERM lands with
  // the card genuinely mid-run, short enough that the drain finishes inside this test's budget.
  writeTask(queueDir, '0001-real.json', {
    id: 'drain-real',
    kind: 'card',
    issue: 4242,
    title: 'drain',
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: 2500 } },
  });

  // Named uniquely per env-building site in this file (envDrainReal/envDrainEsc/envSpawnHelper/
  // envDrainWorker) rather than a repeated local `env` -- test/spawn-isolation-sweep.test.js's
  // identifier resolution refuses to resolve a name with more than one declaration ANYWHERE in
  // the file (fail-closed against shadowing, not scope-aware), so four functions each declaring
  // their own `const env` would otherwise make every one of these sites read as unresolvable.
  const envDrainReal = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', SPO_DRAIN_TIMEOUT_MS: '30000' };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1'],
    { env: envDrainReal, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  daemon.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const exited = new Promise((resolve) => daemon.on('exit', (code, signal) => resolve({ code, signal })));

  try {
    await waitFor(
      () => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn' && e.id === 'drain-real'),
      20000,
      'the real daemon to spawn a worker'
    );
    // The card must still be running when the signal lands, or this test proves nothing.
    assert.equal(
      readDaemonEvents(journalDir).some((e) => e.event === 'worker-exit'),
      false,
      'the card finished before the SIGTERM -- this run proved nothing'
    );
    daemon.kill('SIGTERM');
  } catch (err) {
    daemon.kill('SIGKILL');
    throw err;
  }

  const { code, signal } = await exited;
  const events = readDaemonEvents(journalDir);
  assert.equal(signal, null, `the daemon died from a signal instead of draining: ${stderr}`);
  assert.equal(code, 0, `expected a clean drain (exit 0), got ${code}: ${stderr}`);
  assert.ok(
    events.some((e) => e.event === 'dispatcher-drain-start' && e.signal === 'SIGTERM'),
    'the real SIGTERM never reached requestDrain'
  );
  const end = events.find((e) => e.event === 'dispatcher-drain-end');
  assert.equal(end.drained, true, `the real drain did not complete: ${JSON.stringify(end)}`);
  // The card itself: finished, not killed.
  assert.equal(readState(journalDir, 'drain-real').state, 'DONE');
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'drain-real');
  assert.equal(exitEvt.code, 0);
  assert.equal(exitEvt.signal, null);
});

// ---- 9. the operator escape hatch, end to end ---------------------------------------------------

test('drain: a SECOND real SIGTERM stops immediately instead of waiting out the bound', { timeout: 60000 }, async () => {
  const queueDir = mkTmp('spo-drain-esc-q-');
  const journalDir = mkTmp('spo-drain-esc-j-');
  // 60s of IMPLEMENT against a 120s bound: if the second signal is not honoured, this test can
  // only end by timing out.
  writeTask(queueDir, '0001-esc.json', {
    id: 'drain-esc',
    kind: 'card',
    issue: 4243,
    title: 'escape',
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: 60000 } },
  });

  const envDrainEsc = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', SPO_DRAIN_TIMEOUT_MS: '120000' };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1'],
    { env: envDrainEsc, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  daemon.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const exited = new Promise((resolve) => daemon.on('exit', (code, signal) => resolve({ code, signal })));

  try {
    await waitFor(
      () => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn' && e.id === 'drain-esc'),
      20000,
      'the real daemon to spawn a worker'
    );
    daemon.kill('SIGTERM'); // the first one -- starts the drain
    await waitFor(
      () => readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-drain-start'),
      20000,
      'the first SIGTERM to start a drain'
    );
  } catch (err) {
    daemon.kill('SIGKILL');
    throw err;
  }
  const startedAt = Date.now();
  daemon.kill('SIGTERM'); // the second one

  const { code } = await exited;
  const waited = Date.now() - startedAt;
  assert.equal(code, 143, `expected the pre-drain exit code on the second signal, got ${code}: ${stderr}`);
  // The bound was 120s and the card had 60s left: anything under a few seconds proves the second
  // signal was HANDLED (process.on, not process.once) rather than waited out.
  assert.ok(waited < 15000, `the second SIGTERM took ${waited}ms -- it was not honoured`);
  assert.equal(
    readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-drain-end'),
    false,
    'the drain ran to completion despite the second signal'
  );
});

// ---- 10. the reap is bounded, and a straggler that survives SIGTERM is escalated ---------------

test('drain: a straggler that ignores SIGTERM is SIGKILLed, not waited on forever', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-esc2-q-');
  const journalDir = mkTmp('spo-drain-esc2-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-stubborn', kind: 'synthetic' });

  // Exactly production's shape: a worker whose SIGTERM handler cannot run (here because it is
  // ignored outright; in production because the event loop is blocked in spawnSync). Before the
  // reap was bounded, run() sat in `await Promise.allSettled(pending)` until this process chose to
  // exit -- 60s here -- with systemd's cgroup SIGKILL as the only backstop, which skips
  // daemon.js's exit hook and leaks the lock file.
  //
  // READY FILE, written immediately AFTER the handler is installed (card #183; the same shape as
  // section 16's) -- `worker-spawn` fires synchronously inside `spawnOne`, the instant the child's
  // handle is created, which says nothing about whether the freshly spawned OS process has
  // actually finished booting node and reached this script's own `process.on('SIGTERM', ...)` line
  // yet. Waiting on `worker-spawn` alone raced the drain's SIGTERM against that installation: when
  // the SIGTERM won, the child died on the default disposition, no escalation happened, and this
  // test failed on its own precondition (`no dispatcher-kill-escalated -- the reap waited on an
  // unkillable child`). Waiting for this file instead makes the handler's existence a fact on disk.
  const readyDir = mkTmp('spo-drain-esc2-ready-');
  const readyFile = path.join(readyDir, 'sigterm-handler-installed');
  const ignoresSigterm = (cmd, args, opts) =>
    realSpawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(readyFile)}, ''); setTimeout(() => process.exit(0), 60000);`,
      ],
      { ...opts, stdio: 'ignore' }
    );

  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({ drainTimeoutMs: 200, drainKillGraceMs: 300, deps: { spawn: ignoresSigterm, spawnScanner: neverExitsSpawn } })
  );
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');
  await waitFor(() => fs.existsSync(readyFile), 10000, "straggler's SIGTERM handler installed");

  dispatcher.requestDrain({ signal: 'SIGTERM' });
  const startedAt = Date.now();
  await runPromise;
  const elapsed = Date.now() - startedAt;

  const events = readDaemonEvents(journalDir);
  const esc = events.find((e) => e.event === 'dispatcher-kill-escalated');
  assert.ok(esc, 'no dispatcher-kill-escalated -- the reap waited on an unkillable child');
  assert.equal(esc.graceMs, 300);
  assert.deepEqual(esc.stillLive, ['drain-stubborn']);
  // The child would have run for 60s. Anything close to the bound + grace proves the escalation.
  assert.ok(elapsed < 10000, `run() took ${elapsed}ms -- the reap was not bounded`);
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'drain-stubborn');
  assert.equal(exitEvt.signal, 'SIGKILL');
  // Verification follow-up: a straggler killed by the ESCALATION must still reach drain-end's
  // `outcomes`. It does, because reapSignalledChildren awaits `all` after the SIGKILL rather than
  // returning as soon as it sends it -- so every exit is observed before drain-end is written.
  // Measured rather than assumed, and pinned here so the ordering cannot quietly invert: writing
  // drain-end before the reap is exactly the defect that pass already found once.
  const end = events.find((e) => e.event === 'dispatcher-drain-end');
  assert.deepEqual(end.survivors, ['drain-stubborn']);
  assert.deepEqual(
    end.outcomes,
    [{ id: 'drain-stubborn', outcome: 'crashed' }],
    'a SIGKILLed straggler vanished from drain-end -- its exit was not observed before the record was written'
  );
});

test('drain: a signalled straggler that finishes cleanly is recorded as such, not as a loss', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-late-q-');
  const journalDir = mkTmp('spo-drain-late-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-late', kind: 'synthetic' });

  // Ignores SIGTERM and then exits 0 shortly after -- the production shape from
  // doc/deployment.md 2.2, where a worker blocked in spawnSync completes an entire park after
  // being signalled. `drained:false` is right (we stopped waiting); "the card was lost" is not.
  const finishesAfterSignal = (cmd, args, opts) =>
    realSpawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 500);"],
      { ...opts, stdio: 'ignore' }
    );

  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({ drainTimeoutMs: 150, drainKillGraceMs: 5000, deps: { spawn: finishesAfterSignal, spawnScanner: neverExitsSpawn } })
  );
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');
  dispatcher.requestDrain({ signal: 'SIGTERM' });
  await runPromise;

  const events = readDaemonEvents(journalDir);
  const end = events.find((e) => e.event === 'dispatcher-drain-end');
  assert.equal(end.drained, false, 'the bound did expire -- that part is honest');
  assert.deepEqual(end.survivors, ['drain-late']);
  assert.deepEqual(end.outcomes, [{ id: 'drain-late', outcome: 'done' }], 'the card finished, and drain-end must say so');
  assert.equal(events.some((e) => e.event === 'dispatcher-kill-escalated'), false, 'escalated despite the card exiting inside the grace');
});

// ---- 11. the two guards the verifier found unpinned ---------------------------------------------

test('drain: a crash inside the drain window does not rewrite the drain as a breaker trip', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-brk-q-');
  const journalDir = mkTmp('spo-drain-brk-j-');
  for (let i = 1; i <= 3; i++) writeTask(queueDir, `000${i}-c${i}.json`, { id: `drain-brk-${i}`, kind: 'synthetic' });

  // K=3 with a crashLimit of 1: the single crash below is enough to trip the breaker. If the
  // breaker is allowed to overwrite `stopReason`, `reason` stops being 'drain-requested',
  // daemon.js falls through to its generic branch and exits 1 -- which is NOT in the unit's
  // SuccessExitStatus, so the deploy leaves the unit `failed` and the NEXT pull skips it. That is
  // exactly the 2.1 failure mode this whole change set exists to remove.
  const crashLate = (cmd, args, opts) =>
    realSpawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 400);'], { ...opts, stdio: 'ignore' });

  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({
      workers: 3,
      workerCrashLimit: 1,
      drainTimeoutMs: 15000,
      deps: { spawn: crashLate, spawnScanner: neverExitsSpawn },
    })
  );
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');
  dispatcher.requestDrain({ signal: 'SIGTERM' });
  const stopReason = await runPromise;

  assert.equal(stopReason.reason, 'drain-requested', `the breaker overwrote the drain's reason: ${JSON.stringify(stopReason)}`);
  assert.equal(stopReason.signal, 'SIGTERM');
});

test('drain: a CLEAN drain still signals the scanner on the way out', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-drain-clean-q-');
  const journalDir = mkTmp('spo-drain-clean-j-');
  // No task at all: the drain is clean and instant, and `live` is empty the whole time. The
  // scanner is still a live child, and skipping killAllChildren on a clean drain would leave it
  // running -- it takes no lock and owns no taskDir, so nothing else would ever notice.
  let scannerPid = null;
  const trackedScannerSpawn = (cmd, args, opts) => {
    const child = neverExitsSpawn(cmd, args, opts);
    scannerPid = child.pid;
    return child;
  };
  const dispatcher = createDispatcher(queueDir, journalDir, baseConfig({ deps: { spawn: neverExitsSpawn, spawnScanner: trackedScannerSpawn } }));
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'scanner-spawn'), 10000, 'scanner-spawn');
  dispatcher.requestDrain({ signal: 'SIGTERM' });
  const stopReason = await runPromise;

  assert.equal(stopReason.drained, true);
  await waitFor(
    () => {
      try {
        process.kill(scannerPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    5000,
    'the scanner to be gone after a clean drain'
  );
});

// ---- 12. the daemon-level branches, each proved SEPARATELY -------------------------------------
//
// Verification found the three arms of daemon.js's handler condition mutually redundant: the
// second-signal test alone was satisfied by EITHER `signalCount > 1` OR requestDrain's own
// refusal, `!dispatcherHandle` had no test at all, and the exit code for a bound-expiry drain was
// never exercised (test 9's 143 comes from the handler's immediate exit, not from the drain
// branch). Each arm gets its own real process here.

function spawnRealDaemon(queueDir, journalDir, envOverrides = {}, args = []) {
  const envSpawnHelper = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', ...envOverrides };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1', ...args],
    { env: envSpawnHelper, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  daemon.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const exited = new Promise((resolve) => daemon.on('exit', (code, signal) => resolve({ code, signal })));
  return { daemon, exited, stderr: () => stderr };
}

function slowCard(id, issue, implementMs) {
  return {
    id,
    kind: 'card',
    issue,
    title: id,
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: implementMs } },
  };
}

test('drain: SPO_DRAIN_TIMEOUT_MS=0 makes a real SIGTERM exit 143 at once, drain-free', { timeout: 60000 }, async () => {
  const queueDir = mkTmp('spo-drain-off-q-');
  const journalDir = mkTmp('spo-drain-off-j-');
  writeTask(queueDir, '0001-off.json', slowCard('drain-off', 4244, 60000));

  const { daemon, exited, stderr } = spawnRealDaemon(queueDir, journalDir, { SPO_DRAIN_TIMEOUT_MS: '0' });
  try {
    await waitFor(
      () => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn' && e.id === 'drain-off'),
      20000,
      'a worker'
    );
    daemon.kill('SIGTERM');
  } catch (err) {
    daemon.kill('SIGKILL');
    throw err;
  }
  const { code } = await exited;
  assert.equal(code, 143, `expected the pre-drain exit path, got ${code}: ${stderr()}`);
  assert.equal(
    readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-drain-start'),
    false,
    'a drain started despite SPO_DRAIN_TIMEOUT_MS=0'
  );
});

test('drain: a bound-expiry drain exits 143 through the drain branch, not through the handler', { timeout: 60000 }, async () => {
  const queueDir = mkTmp('spo-drain-exp-q-');
  const journalDir = mkTmp('spo-drain-exp-j-');
  writeTask(queueDir, '0001-exp.json', slowCard('drain-exp', 4245, 20000));

  // ONE signal only. The 143 here can therefore only come from daemon.js's
  // `stopReason.drained ? 0 : code` -- which nothing else in this file exercises, and which is the
  // entire reason the unit declares SuccessExitStatus=143.
  const { daemon, exited, stderr } = spawnRealDaemon(queueDir, journalDir, {
    SPO_DRAIN_TIMEOUT_MS: '1500',
    SPO_DRAIN_KILL_GRACE_MS: '2000',
  });
  try {
    await waitFor(
      () => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn' && e.id === 'drain-exp'),
      20000,
      'a worker'
    );
    daemon.kill('SIGTERM');
  } catch (err) {
    daemon.kill('SIGKILL');
    throw err;
  }
  const { code, signal } = await exited;
  assert.equal(signal, null, `the daemon died from a signal: ${stderr()}`);
  assert.equal(code, 143, `expected 143 from the drain branch, got ${code}: ${stderr()}`);
  const end = readDaemonEvents(journalDir).find((e) => e.event === 'dispatcher-drain-end');
  assert.ok(end, 'no dispatcher-drain-end');
  assert.equal(end.drained, false);
  assert.deepEqual(end.survivors, ['drain-exp']);
});

test('drain: a SIGTERM to a real --worker exits 143 -- a worker has no dispatcher to drain', { timeout: 60000 }, async () => {
  const journalDir = mkTmp('spo-drain-wk-j-');
  const queueDir = mkTmp('spo-drain-wk-q-');
  const taskDir = path.join(journalDir, 'drain-wk');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(slowCard('drain-wk', 4246, 60000)));

  // `dispatcherHandle` is null in worker mode, so the handler must take the immediate-exit path.
  // Without that arm the handler calls requestDrain on null and throws a TypeError INSIDE a signal
  // handler -- the worker then dies uncaught rather than cleanly, on every single deploy.
  const envDrainWorker = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0' };
  const worker = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--worker', taskDir, '--queue', queueDir, '--journal', journalDir],
    { env: envDrainWorker, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  worker.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const exited = new Promise((resolve) => worker.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => fs.existsSync(path.join(taskDir, 'journal.jsonl')), 20000, 'the worker to start');
    daemonKillAfter(worker, 300);
  } catch (err) {
    worker.kill('SIGKILL');
    throw err;
  }
  const { code, signal } = await exited;
  assert.equal(signal, null, `the worker died from a signal instead of handling it: ${stderr}`);
  assert.equal(code, 143, `expected 143 from a worker's own handler, got ${code}: ${stderr}`);
  assert.match(stderr, /^(?!.*TypeError)[\s\S]*$/, `the worker threw inside its signal handler: ${stderr}`);
});

function daemonKillAfter(child, ms) {
  return new Promise((resolve) => setTimeout(() => { child.kill('SIGTERM'); resolve(); }, ms));
}

// ---- 13. the per-card provenance line carries the RESUMING state, not a constant ----------------

test('pipeline-version: a resuming card records the state it resumed from, not INTAKE', { timeout: 60000 }, () => {
  const journalDir = mkTmp('spo-drain-rs-j-');
  const taskDir = path.join(journalDir, 'resume-card');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'resume-card', kind: 'synthetic', shadow: { forceState: 'DONE' } })
  );
  // A card the worker is picking up again, not one fresh out of the queue.
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({ state: 'GATE', id: 'resume-card' }));

  const res = runDaemonWorker(taskDir, journalDir);
  assert.equal(res.status, 0, `worker did not finish DONE: ${res.stderr}`);
  const first = readJournal(journalDir, 'resume-card')[0];
  assert.equal(first.event, 'pipeline-version');
  assert.equal(first.state, 'GATE', 'the provenance line reported a constant instead of the resuming state');
});

// ---- 14. the two remaining branches the mutants reached ------------------------------------------

test('drain: a circuit-breaker stop still exits 1 -- the drain branch must not swallow it', { timeout: 60000 }, async () => {
  const queueDir = mkTmp('spo-drain-brk2-q-');
  const journalDir = mkTmp('spo-drain-brk2-j-');
  // A REAL crash through the real path, not a simulated one: takeNextTask renames an unparsable
  // queue entry into taskDir/task.json unchanged (state-machine.js's `__invalid` branch), so
  // runWorker's own parse fails and it exits 2 -- which classifyWorkerExit calls 'crashed',
  // because 2 is neither 0 nor 20. With SPO_WORKER_CRASH_LIMIT=1 the breaker trips on the first.
  fs.writeFileSync(path.join(queueDir, '0001-drain-brk2.json'), '{ not json');

  // NO signal is sent. The exit code can therefore only come from daemon.js's generic
  // "dispatcher stopped itself" branch -- and if the drain branch is widened from
  // `reason === 'drain-requested'` to a bare `stopReason`, a breaker trip exits 143 or 0 instead
  // of 1. 1 is deliberately NOT in the unit's SuccessExitStatus: a broken state machine has to
  // leave the unit `failed`, or nothing distinguishes it from an ordinary stop.
  const { daemon, exited, stderr } = spawnRealDaemon(queueDir, journalDir, { SPO_WORKER_CRASH_LIMIT: '1' });
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 45000);
  const { code } = await exited;
  clearTimeout(timer);
  assert.equal(code, 1, `a circuit-breaker stop must exit 1, got ${code}: ${stderr()}`);
  assert.match(stderr(), /dispatcher stopped itself/);
  assert.equal(
    readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-drain-start'),
    false,
    'a breaker trip went through the drain path'
  );
});

test('pipeline-version: a state.json with no state field falls back to INTAKE, not undefined', { timeout: 60000 }, () => {
  const journalDir = mkTmp('spo-drain-nostate-j-');
  const taskDir = path.join(journalDir, 'nostate-card');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'nostate-card', kind: 'synthetic', shadow: { forceState: 'DONE' } })
  );
  // Parses, but carries no `state` -- the shape a truncated or half-written state.json leaves,
  // which is exactly the case journal.js's atomic tmp+rename exists to make rare and not
  // impossible. Without the fallback the provenance line's own `state` field is `undefined`,
  // which appendEvent writes as a missing key.
  fs.writeFileSync(path.join(taskDir, 'state.json'), '{}');

  const res = runDaemonWorker(taskDir, journalDir);
  assert.equal(res.status, 0, `worker did not finish DONE: ${res.stderr}`);
  const first = readJournal(journalDir, 'nostate-card')[0];
  assert.equal(first.event, 'pipeline-version');
  assert.equal(first.state, 'INTAKE');
});

// ---- 15. the escalation applies to the BREAKER path too, and that is deliberate ------------------

test('breaker: a straggler that ignores SIGTERM is escalated on the circuit-breaker path as well', { timeout: 30000 }, async () => {
  const queueDir = mkTmp('spo-brk-esc-q-');
  const journalDir = mkTmp('spo-brk-esc-j-');
  writeTask(queueDir, '0001-a.json', { id: 'brk-crash', kind: 'synthetic' });
  writeTask(queueDir, '0002-b.json', { id: 'brk-stubborn', kind: 'synthetic' });

  // NO DRAIN HERE -- no signal is sent. reapSignalledChildren replaced the bare
  // `await Promise.allSettled(pending)` on EVERY shutdown path, not just the drain's, and this
  // pins the consequence on the path that inherited it. It is an improvement rather than a
  // borrowed trade: before, a breaker trip with an unkillable worker waited forever and systemd's
  // cgroup SIGKILL at TimeoutStopSec was the only way out -- which skips daemon.js's exit hook, so
  // the single-instance lock file leaked for the next start to stale-sweep. Now the dispatcher
  // ends it itself, well inside that ceiling, and the lock is released properly.
  let call = 0;
  const spawnFn = (cmd, args, opts) => {
    call += 1;
    return call === 1
      ? realSpawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 300);'], { ...opts, stdio: 'ignore' })
      : realSpawn(
          process.execPath,
          ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 60000);"],
          { ...opts, stdio: 'ignore' }
        );
  };

  // TWO accounts, not one: fillSlots re-clamps K to the number of HEALTHY accounts before every
  // spawn, so a K=2 config against baseConfig's single-account pool silently runs one worker --
  // and this test needs a second, stubborn worker alive when the breaker trips.
  const poolDir = mkTmp('spo-brk-pool-');
  writePoolDir(poolDir, [{ name: 'pool1' }, { name: 'pool2' }]);
  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({
      workers: 2,
      claudeAccountsDir: poolDir,
      workerCrashLimit: 1, // the first crash trips it
      drainKillGraceMs: 300,
      deps: { spawn: spawnFn, spawnScanner: neverExitsSpawn },
    })
  );
  const startedAt = Date.now();
  const stopReason = await dispatcher.run();
  const elapsed = Date.now() - startedAt;

  assert.equal(stopReason.reason, 'worker-crash-circuit-breaker');
  const events = readDaemonEvents(journalDir);
  assert.equal(
    events.filter((e) => e.event === 'worker-spawn').length,
    2,
    'only one worker ran -- there was no straggler alive when the breaker tripped, so this proved nothing'
  );
  assert.ok(
    events.some((e) => e.event === 'dispatcher-kill-escalated'),
    'the breaker path waited unbounded on a worker that ignores SIGTERM'
  );
  assert.equal(
    events.some((e) => e.event === 'dispatcher-drain-end'),
    false,
    'a breaker trip is not a drain and must not journal one'
  );
  assert.ok(elapsed < 15000, `run() took ${elapsed}ms -- the breaker path is not bounded`);
});

// ---- 16. `dispatcher-stopped` is hoisted ahead of the kill+reap (card #162) -----------------------

// REDESIGNED (this action's own verification finding): the first cut of this test discriminated
// on a wall-clock margin (a `waitFor` budget comfortably shorter than the reap's own grace), which
// reads as deterministic in isolation but is not -- measured over a real full-suite run (8 cores,
// no `taskset`; `taskset` was itself the wrong regime and suppresses exactly this class of flake),
// base 6fc0c23 was 0/10 and the branch was 3/10, with this test failing 1/10 on the assertion "run()
// had already resolved by the time dispatcher-stopped appeared" -- scheduler starvation under
// full-suite I/O closed the margin the test needed. CAUSAL, NOT TEMPORAL, this time: the property
// card #162 actually adds is an ORDER in the journal, and `dispatcher-kill-escalated` is emitted
// FROM INSIDE `reapSignalledChildren`, at the exact instant the grace expires -- the same blocking
// step a systemd `TimeoutStopSec` SIGKILL would land inside. In the fixed world `dispatcher-stopped`
// is written before that call ever starts; in the reverted (pre-#162) world it is written only
// after `reapSignalledChildren` has already returned, which is strictly after that escalation
// event fired. Comparing the two events' INDEXES in daemon.jsonl, once run() has fully resolved,
// encodes exactly that -- with zero dependence on the scheduler, since nothing is racing a clock.
test('drain: dispatcher-stopped precedes dispatcher-kill-escalated and dispatcher-drain-end in the journal (card #162)', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-drain-hoist-q-');
  const journalDir = mkTmp('spo-drain-hoist-j-');
  writeTask(queueDir, '0001-a.json', { id: 'drain-hoist', kind: 'synthetic' });

  // MUST genuinely ignore SIGTERM (installs a no-op handler) -- `neverExitsSpawn` is NOT a
  // substitute here. It installs no signal handler at all, so a bare SIGTERM kills it via the
  // default action (measured this session: `process.kill(-pid,'SIGTERM')` against it exits within
  // 1s), which would never force the escalation this test needs `dispatcher-kill-escalated` for.
  //
  // READY FILE, written immediately AFTER the handler is installed -- removes the last timing
  // dependency from this test, which had migrated from the discriminating ASSERTION (fixed
  // already) into its PRECONDITION. `worker-spawn` (dispatcher.js:817-818's own event) fires
  // SYNCHRONOUSLY inside `spawnOne`, the instant the child's handle is created -- which says
  // nothing about whether the freshly spawned OS process has actually finished booting node and
  // reached this script's own `process.on('SIGTERM', ...)` line yet. Waiting on `worker-spawn`
  // alone left a race between the drain's SIGTERM and that handler's installation: an EARLIER cut
  // of this test relied on `drainTimeoutMs: 200` alone as headroom for that boot and measured
  // 2/10 failures under a loaded full-suite run, `no dispatcher-kill-escalated -- the straggler
  // was never actually escalated` -- the SIGTERM occasionally won the race and killed the child on
  // the default disposition before the handler existed, starving this test's own precondition
  // rather than exercising the code under test. Waiting for this file instead makes the handler's
  // existence a fact on disk, not a margin, so the precondition cannot starve at any load. (The
  // same exposure existed in this file's section 10 test, which relied on the same
  // `drainTimeoutMs: 200` margin without a ready file -- fixed in card #183 with the identical
  // ready-file shape.)
  const readyDir = mkTmp('spo-drain-hoist-ready-');
  const readyFile = path.join(readyDir, 'sigterm-handler-installed');
  const ignoresSigterm = (cmd, args, opts) =>
    realSpawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(readyFile)}, ''); setTimeout(() => process.exit(0), 60000);`,
      ],
      { ...opts, stdio: 'ignore' }
    );

  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    // Matched to this file's own idiom for this straggler shape (section 10's `drainTimeoutMs:
    // 200, drainKillGraceMs: 300`). The ready file above removes the boot-race these numbers used
    // to paper over, but they are left unchanged rather than tightened further -- this test's
    // speed was never the point, and there is no reason to invent a new pair of numbers with no
    // measurement behind them.
    baseConfig({ drainTimeoutMs: 200, drainKillGraceMs: 300, deps: { spawn: ignoresSigterm, spawnScanner: neverExitsSpawn } })
  );

  const runPromise = dispatcher.run();
  // Readiness waits only -- NEITHER is the discriminator (see the index comparison below).
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');
  await waitFor(() => fs.existsSync(readyFile), 10000, "straggler's SIGTERM handler installed");
  dispatcher.requestDrain({ signal: 'SIGTERM' });

  // Let the whole shutdown run to completion -- drain bound, kill, reap, escalation, drain-end,
  // stopped -- before reading anything back. Every spawned child (the straggler, SIGKILLed by the
  // escalation; the scanner, killed by `requestDrain`'s own `killScanner`) is dead by this point.
  const stopReason = await runPromise;
  assert.equal(stopReason.reason, 'drain-requested');

  const events = readDaemonEvents(journalDir);
  const stoppedIdx = events.findIndex((e) => e.event === 'dispatcher-stopped');
  const escalatedIdx = events.findIndex((e) => e.event === 'dispatcher-kill-escalated');
  const drainEndIdx = events.findIndex((e) => e.event === 'dispatcher-drain-end');

  assert.notEqual(stoppedIdx, -1, 'no dispatcher-stopped');
  assert.notEqual(
    escalatedIdx,
    -1,
    'no dispatcher-kill-escalated -- the straggler was never actually escalated, so this run proves nothing about ordering'
  );
  assert.notEqual(drainEndIdx, -1, 'no dispatcher-drain-end');

  // THE DISCRIMINATING ASSERTION: an ORDER in the journal, not a wall-clock margin. See this
  // test's own header comment for why these two comparisons distinguish the fixed world from the
  // reverted one regardless of how the scheduler treated this run.
  assert.ok(
    stoppedIdx < escalatedIdx,
    `dispatcher-stopped (index ${stoppedIdx}) must precede dispatcher-kill-escalated (index ${escalatedIdx}) -- it did not`
  );
  assert.ok(
    stoppedIdx < drainEndIdx,
    `dispatcher-stopped (index ${stoppedIdx}) must precede dispatcher-drain-end (index ${drainEndIdx}) -- it did not`
  );
});

// ---- 17. a drain that dies inside the wait must not read as a region nothing can read (card #188) --

// THE JOURNAL OBSERVATION THIS CARD STARTS FROM (2026-09-10): `dispatcher-drain-start` with
// inFlight [issue-523, issue-522], then `scanner-exit-during-shutdown`, then no further dispatcher
// event -- the process died inside the drain wait. Before this card, `computeDispatcherStatus`
// fell through every branch on that unconcluded drain-start and read null, so `spo status` printed
// no dispatcher line at all and the deck's Workers tile fell back to its live-workers.json reading
// (present/count alone, the same reading an ordinarily running dispatcher gets) while its
// drain-history line still said "in progress" (console/render.js's `renderReportsInner`, which
// never depended on `computeDispatcherStatus` at all -- measured at base 118fdfa against the real
// 2026-09-10 journal: computeDispatcherStatus returned null). This test reproduces that shape with
// a REAL daemon.js process (not requestDrain called directly, which would only prove the function works,
// not that a real SIGTERM reaches it -- this file's own section 8 makes the same argument) and
// checks BOTH halves: while the process is genuinely still alive mid-wait, every reader must say
// DRAINING, never STOPPED (card #164's inversion, applied to this fourth state); once it is
// SIGKILLed inside that same wait, every reader must say STOPPED with `diedDraining`, not silently
// drop back to the pre-card behaviour above.
function extractWorkersTile(html) {
  const m = html.match(/<div class="svc-tile ([^"]+)">\s*<span class="svc-name">Workers<\/span>[\s\S]*?<\/div>/);
  assert.ok(m, 'expected an svc-tile named "Workers" in the rendered HTML');
  return m[0];
}

test('drain: a real daemon SIGKILLed inside the drain wait reads DRAINING while alive, then STOPPED/diedDraining once dead, on every reader (card #188)', { timeout: 60000 }, async () => {
  const queueDir = mkTmp('spo-drain-died-q-');
  const journalDir = mkTmp('spo-drain-died-j-');
  // PRECONDITION AS FACT, NOT MARGIN: `delays.IMPLEMENT` is a plain millisecond `setTimeout`
  // (orchestrator/fixture.js's own header, orchestrator/steps/scripted.js:65) -- the shadow
  // fixture mechanism has no wait-for-file / release-file primitive to hook into (grepped; the
  // only per-step TIMING control it offers is this fixed delay), so "the worker cannot finish on its own
  // before this test acts" cannot be built as a ready-file precondition the way section 16's
  // straggler is. Instead it is made STRUCTURALLY true rather than a timing margin: 90s, longer
  // than this test's OWN `{ timeout: 60000 }` -- if the worker ever got far enough to finish on
  // its own, node:test would already have failed this test on ITS OWN timeout first, so "the test
  // is still running" is itself proof the worker has not concluded. The facts this replaces a
  // ready-file check with, asserted explicitly below at the moment they matter: the worker's own
  // pid (read off its `worker-spawn` event) is alive, and no `worker-exit`/`worker-exit-during-
  // shutdown` event for it exists in the journal.
  writeTask(queueDir, '0001-died.json', {
    id: 'drain-died',
    kind: 'card',
    issue: 4244,
    title: 'died inside the drain',
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: 90000 } },
  });

  // drainTimeoutMs far longer than this test's own budget, so the wait can only end by the SIGKILL
  // below -- never by its own bound expiring, which would write a DIFFERENT (bound-expiry) shape.
  const envDrainDied = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', SPO_DRAIN_TIMEOUT_MS: '120000' };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1'],
    { env: envDrainDied, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  daemon.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const exited = new Promise((resolve) => daemon.on('exit', (code, signal) => resolve({ code, signal })));

  let workerPid = null;
  try {
    await waitFor(() => {
      const spawnEvt = readDaemonEvents(journalDir).find((e) => e.event === 'worker-spawn' && e.id === 'drain-died');
      if (spawnEvt) workerPid = spawnEvt.pid;
      return !!spawnEvt;
    }, 20000, 'the real daemon to spawn a worker');
    // The card must still be running when the signal lands, or this run proves nothing.
    assert.equal(
      readDaemonEvents(journalDir).some((e) => e.event === 'worker-exit'),
      false,
      'the card finished before the SIGTERM -- this run proved nothing'
    );

    daemon.kill('SIGTERM'); // starts the drain -- requestDrain wakes the loop at once (no poll wait)
    await waitFor(
      () => readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-drain-start'),
      20000,
      'dispatcher-drain-start'
    );

    // PRECONDITION FACTS, checked before reading anything derived from them: the dispatcher
    // process is genuinely alive, no stop has concluded yet, and the STRAGGLER WORKER itself
    // (`workerPid`, read off its own `worker-spawn` event above) is alive and has not exited --
    // the two facts that stand in for a ready-file check the shadow fixture mechanism cannot
    // offer (see the fixture-shape comment above this task's own `writeTask`).
    assert.equal(processAlive(daemon.pid), true, `the daemon must still be alive right after its own drain-start: ${stderr}`);
    assert.ok(workerPid, 'no worker pid captured off worker-spawn -- this run proves nothing');
    assert.equal(processAlive(workerPid), true, 'the straggler worker must still be alive right after the drain started');
    const liveEvents = readDaemonEvents(journalDir);
    assert.equal(liveEvents.some((e) => e.event === 'dispatcher-stopped'), false, 'precondition: no dispatcher-stopped yet');
    assert.equal(
      liveEvents.some((e) => (e.event === 'worker-exit' || e.event === 'worker-exit-during-shutdown') && e.id === 'drain-died'),
      false,
      'precondition: the straggler worker must not have exited yet'
    );

    // LIVE-DRAIN assertions -- the same three readers `spo status`/the deck actually use.
    const liveStatus = computeDispatcherStatus(liveEvents, { isAlive: pidExists });
    assert.equal(liveStatus.status, 'draining', `expected 'draining' while the process is alive, got ${JSON.stringify(liveStatus)}`);
    assert.notEqual(liveStatus.status, 'stopped');

    const liveSpoOut = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
    assert.match(liveSpoOut, /dispatcher: DRAINING/, `expected a DRAINING line: ${liveSpoOut}`);
    assert.doesNotMatch(liveSpoOut, /dispatcher: STOPPED/, `must not print STOPPED for a live drain: ${liveSpoOut}`);

    // spoReportsDir: mkTmp(...) -- without it collectAll falls back to the REAL configured
    // orchestrator/config.js spoReportsDir, reading outside this test's own isolated fixtures.
    const liveDeck = collectAll({ journalRoot: journalDir, queueDir, spoReportsDir: mkTmp('spo-drain-died-reports-') });
    assert.equal(liveDeck.services.workers.status, 'draining');
    const liveTile = extractWorkersTile(renderServicesInner(liveDeck.services, liveDeck.accounts, liveDeck.prod));
    assert.doesNotMatch(liveTile, /STOPPED/);
    // Asserts against the tile itself, not just services.workers.status -- catches a mutant that
    // flips the STATUS_WORD/tileClass/render branch without touching applyWorkerStats at all.
    assert.match(liveTile, /DRAINING/, `expected the tile's own status word: ${liveTile}`);
    assert.match(liveTile, /tile-orange/, `expected the tile painted tile-orange, not tile-red: ${liveTile}`);
    assert.match(
      liveTile,
      /draining since .* in flight at drain start/,
      `expected the tile's own draining caption: ${liveTile}`
    );
    // The SAME liveDeck fed through the actual production assembly (renderDataFragments), not a
    // hand-picked renderServicesInner call -- catches a mutant where a caller of renderReportsInner
    // stops passing the dispatcher arg (it would then fall back to the "no wd" default and print
    // "in progress" honestly here too, so this assertion alone would not catch that mutant; the
    // DEAD half below is what catches it, by requiring the OPPOSITE wording once the process is
    // provably dead).
    const liveFragments = renderDataFragments(liveDeck);
    assert.match(
      liveFragments.reports,
      /in progress \(/,
      `expected the Bug Reports drain-history line to still say "in progress" while genuinely draining: ${liveFragments.reports}`
    );

    // SIGKILL the child WHILE it is still inside the wait -- the process dies without ever
    // concluding its own drain (no dispatcher-stopped, no dispatcher-drain-end).
    daemon.kill('SIGKILL');
    await exited;
    // No further wait needed here: `await exited` just resolved from the child's own 'exit' event,
    // which Node fires only once the OS has reaped the process (waitpid has already collected its
    // exit status) -- so `processAlive(daemon.pid)` is already deterministically false by this
    // line, not a fact that needs polling for.
    assert.equal(processAlive(daemon.pid), false, 'the daemon must be reaped by the time its own exit event has fired');

    const finalEvents = readDaemonEvents(journalDir);
    const startIdx = finalEvents.findIndex((e) => e.event === 'dispatcher-start');
    const drainStartIdx = finalEvents.findIndex((e) => e.event === 'dispatcher-drain-start');
    assert.notEqual(drainStartIdx, -1, 'no dispatcher-drain-start');
    assert.ok(drainStartIdx > startIdx, 'dispatcher-drain-start must come after dispatcher-start');
    const drainStartEvt = finalEvents[drainStartIdx];
    assert.equal(drainStartEvt.pid, daemon.pid, 'dispatcher-drain-start must carry the real dying process pid');
    assert.ok(
      Array.isArray(drainStartEvt.inFlight) && drainStartEvt.inFlight.length > 0,
      'dispatcher-drain-start must carry a non-empty inFlight'
    );
    assert.equal(
      finalEvents.some((e) => e.event === 'dispatcher-stopped'),
      false,
      'no dispatcher-stopped should have been written -- the process was SIGKILLed inside the wait'
    );
    assert.equal(
      finalEvents.some((e) => e.event === 'dispatcher-drain-end'),
      false,
      'no dispatcher-drain-end should have been written'
    );

    const deadStatus = computeDispatcherStatus(finalEvents, { isAlive: pidExists });
    assert.equal(deadStatus.status, 'stopped');
    assert.equal(deadStatus.diedDraining, true);

    const deadSpoOut = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
    assert.match(deadSpoOut, /dispatcher: STOPPED/, `expected a STOPPED line once the process is dead: ${deadSpoOut}`);
    assert.match(deadSpoOut, /died inside the drain wait/, `expected the died-inside-the-drain wording: ${deadSpoOut}`);

    const deadDeck = collectAll({ journalRoot: journalDir, queueDir, spoReportsDir: mkTmp('spo-drain-died-reports2-') });
    assert.equal(deadDeck.services.workers.status, 'stopped');
    assert.equal(deadDeck.services.workers.dispatcher.diedDraining, true);
    const deadTile = extractWorkersTile(renderServicesInner(deadDeck.services, deadDeck.accounts, deadDeck.prod));
    assert.match(deadTile, /STOPPED/);
    // Asserts against the diedDraining caption itself, not a generic "STOPPED somewhere in the tile" match --
    // catches a mutant that removes the diedDraining branch (console/render.js's own `if
    // (workers.status === 'stopped' && workersDispatcher.diedDraining)`) and falls through to the
    // ordinary stopped caption instead, which also contains the word STOPPED and would otherwise
    // slip past a bare /STOPPED/ check.
    assert.match(
      deadTile,
      /died inside the drain wait \(drain started .* ago\), no dispatcher-stopped recorded/,
      `expected the tile's own diedDraining caption: ${deadTile}`
    );
    // The SAME deadDeck through the real production assembly -- catches a mutant where a
    // renderReportsInner caller (renderDataFragments/renderHealthPage) stops passing the dispatcher
    // arg: without it, `wd.diedDraining` reads undefined and this line falls back to the WRONG "in
    // progress" wording this whole card exists to fix.
    const deadFragments = renderDataFragments(deadDeck);
    assert.match(
      deadFragments.reports,
      /process died inside the drain wait \(no dispatcher-stopped recorded\)/,
      `expected the Bug Reports drain-history line to say the process died: ${deadFragments.reports}`
    );
    assert.doesNotMatch(
      deadFragments.reports,
      /in progress/,
      `must not still say "in progress" once the process is known dead: ${deadFragments.reports}`
    );
    // renderDataFragments and renderHealthPage are TWO SEPARATE
    // renderReportsInner call sites (console/render.js) -- renderDataFragments above catches a
    // mutant on its own call site only. This exercises renderHealthPage's own renderReportsInner
    // call independently, so a mutant reverting JUST that caller back to
    // `renderReportsInner(d.reports)` (dropping the dispatcher arg) is caught too.
    const healthPageHtml = renderHealthPage(deadDeck);
    assert.match(
      healthPageHtml,
      /process died inside the drain wait \(no dispatcher-stopped recorded\)/,
      `expected renderHealthPage's own Bug Reports fragment to say the process died: ${healthPageHtml.slice(0, 2000)}`
    );
  } finally {
    // Always attempted, regardless of where a failure happened above -- a live-assertion failure
    // (e.g. before the SIGKILL further up ever ran) must not leak either the 90s-delay straggler
    // worker or the daemon itself. Both kills are idempotent: signalling an already-dead pid just
    // throws ESRCH, caught and ignored, same posture as this file's own neverExitsSpawn/
    // slowWorkerSpawn stand-ins.
    if (daemon.exitCode === null && daemon.signalCode === null) {
      try {
        daemon.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    if (workerPid) {
      try {
        process.kill(workerPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

// Same shape, the OTHER way a real process can leave a drain unconcluded: not a SIGKILL from
// outside, but daemon.js's own escape hatch -- a SECOND SIGTERM takes the `process.exit(143)`
// path (daemon.js's signal handler, `requestDrain` refusing is what detects it) INSTEAD of
// running the rest of run()'s drain block, so `dispatcher-stopped`/`dispatcher-drain-end` are
// just as absent as in the SIGKILL case above, by a completely different mechanism. This file's
// own section 9 already proves the second signal is honoured immediately; this variant adds what
// section 9 does not check -- that the journal/status readers land on the same died-inside-the-
// drain STOPPED reading this card exists for, not a silent null.
test('drain: a SECOND real SIGTERM (the process.exit(143) escape hatch) leaves the same died-inside-the-drain STOPPED reading (card #188)', { timeout: 60000 }, async () => {
  const queueDir = mkTmp('spo-drain-died2-q-');
  const journalDir = mkTmp('spo-drain-died2-j-');
  writeTask(queueDir, '0001-died2.json', {
    id: 'drain-died2',
    kind: 'card',
    issue: 4245,
    title: 'died via the second SIGTERM',
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: 5000 } },
  });

  const envDrainDied2 = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', SPO_DRAIN_TIMEOUT_MS: '120000' };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1'],
    { env: envDrainDied2, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  daemon.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const exited = new Promise((resolve) => daemon.on('exit', (code, signal) => resolve({ code, signal })));

  let workerPid = null;
  try {
    await waitFor(() => {
      const spawnEvt = readDaemonEvents(journalDir).find((e) => e.event === 'worker-spawn' && e.id === 'drain-died2');
      if (spawnEvt) workerPid = spawnEvt.pid;
      return !!spawnEvt;
    }, 20000, 'the real daemon to spawn a worker');

    daemon.kill('SIGTERM'); // first -- starts the drain
    await waitFor(
      () => readDaemonEvents(journalDir).some((e) => e.event === 'dispatcher-drain-start'),
      20000,
      'dispatcher-drain-start'
    );
    daemon.kill('SIGTERM'); // second -- requestDrain refuses, daemon.js takes process.exit(143)
  } catch (err) {
    daemon.kill('SIGKILL');
    throw err;
  }

  // Belt and braces: if the second signal somehow did not end the process (it always has in this
  // file's own section 9), do not leave it running past this test -- but only if it is genuinely
  // still alive, or this SIGKILL would overwrite the real `signal: null` exit(143) makes with a
  // false `signal: 'SIGKILL'` on a process that had already exited cleanly on its own.
  const raced = await Promise.race([
    exited.then((r) => ({ ...r, timedOut: false })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 15000)),
  ]);
  if (raced.timedOut) daemon.kill('SIGKILL');

  const { code, signal } = await exited;
  if (workerPid) {
    try {
      process.kill(workerPid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  assert.equal(signal, null, `expected the process.exit(143) path, not a raw signal death: ${stderr}`);
  assert.equal(code, 143, `expected the pre-drain exit code on the second signal, got ${code}: ${stderr}`);
  // No wait needed: `await exited` above already resolved from the child's own 'exit' event, which
  // Node fires only once the OS has reaped the process.
  assert.equal(processAlive(daemon.pid), false, 'the daemon must be reaped by the time its own exit event has fired');

  const finalEvents = readDaemonEvents(journalDir);
  assert.ok(finalEvents.some((e) => e.event === 'dispatcher-drain-start'), 'no dispatcher-drain-start');
  assert.equal(
    finalEvents.some((e) => e.event === 'dispatcher-stopped'),
    false,
    'the process.exit(143) escape hatch must not have run the rest of the drain block'
  );
  assert.equal(finalEvents.some((e) => e.event === 'dispatcher-drain-end'), false);

  const deadStatus = computeDispatcherStatus(finalEvents, { isAlive: pidExists });
  assert.equal(deadStatus.status, 'stopped');
  assert.equal(deadStatus.diedDraining, true);

  const deadSpoOut = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(deadSpoOut, /dispatcher: STOPPED/, `expected a STOPPED line: ${deadSpoOut}`);
  assert.match(deadSpoOut, /died inside the drain wait/, `expected the died-inside-the-drain wording: ${deadSpoOut}`);
});
