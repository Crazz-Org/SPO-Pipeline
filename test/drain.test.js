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
const { mkTmp, writeTask, writePoolDir, isolatedEnv, readState, DAEMON } = require('./helpers');

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
  assert.ok(end, 'no dispatcher-drain-end');
  assert.equal(end.drained, true, 'the drain did not wait for the card');
  assert.deepEqual(end.survivors, []);
  assert.equal(stopReason.drained, true);

  // The card exited 0 on its own. Killed, it would have been (code null, signal SIGTERM) -- which
  // is exactly what this test was red with before the drain existed.
  const exitEvt = events.find((e) => e.event === 'worker-exit' && e.id === 'drain-a');
  assert.ok(exitEvt, 'no worker-exit');
  assert.equal(exitEvt.code, 0, `card was killed, not drained: ${JSON.stringify(exitEvt)}`);
  assert.equal(exitEvt.signal, null);
  assert.equal(exitEvt.outcome, 'done');
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
    baseConfig({ drainTimeoutMs: 15000, deps: { spawn: crashLate, spawnScanner: neverExitsSpawn } })
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

  const env = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', SPO_DRAIN_TIMEOUT_MS: '30000' };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] }
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

  const env = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', SPO_DRAIN_TIMEOUT_MS: '120000' };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] }
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
