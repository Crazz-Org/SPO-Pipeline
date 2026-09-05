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
const { mkTmp, writeTask, writePoolDir, isolatedEnv, readState, runDaemonWorker, readJournal, DAEMON } = require('./helpers');

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
  const ignoresSigterm = (cmd, args, opts) =>
    realSpawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 60000);"],
      { ...opts, stdio: 'ignore' }
    );

  const dispatcher = createDispatcher(
    queueDir,
    journalDir,
    baseConfig({ drainTimeoutMs: 200, drainKillGraceMs: 300, deps: { spawn: ignoresSigterm, spawnScanner: neverExitsSpawn } })
  );
  const runPromise = dispatcher.run();
  await waitFor(() => readDaemonEvents(journalDir).some((e) => e.event === 'worker-spawn'), 10000, 'worker-spawn');

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
  const env = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0', ...envOverrides };
  const daemon = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir, '--workers', '1', ...args],
    { env, stdio: ['ignore', 'ignore', 'pipe'] }
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
  const env = { ...isolatedEnv(), SPO_AUTO_PULL_MS: '0', SPO_AUTO_TRIAGE_MS: '0' };
  const worker = realSpawn(
    process.execPath,
    [DAEMON, '--shadow', '--worker', taskDir, '--queue', queueDir, '--journal', journalDir],
    { env, stdio: ['ignore', 'ignore', 'pipe'] }
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
