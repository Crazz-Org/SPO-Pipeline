'use strict';
// repark-race-demo.test.js -- action 4 of card #78's lot 12: DEMONSTRATE, with a real dispatcher,
// a real crashed worker, a real repark-claim file and a real SCANNER PROCESS, that the
// orphanScan/reparkCrashedWorker double-repark race dispatcher.js's own header describes (see
// "CARD #78 ADDED A THIRD QUESTION" there) is genuinely closed -- and that it is the repark-claim
// file, and nothing else, that closes it.
//
// "Calling a step function directly proves the function works, not that production reaches it" --
// this repo's own most expensive lesson (a KillMode setting once defeated a drain past twenty
// green tests that never spawned a real child). So every link in the chain below is REAL:
//   - a real createDispatcher(...).run(), never a bare call into dispatcher.js's own internals;
//   - a real spawned "worker" process that actually exits with a crash code (handleExit and
//     reparkCrashedWorker are dispatcher.js's own real code, exercised through a real child exit,
//     not a direct call);
//   - the real claim write (journal.js's writeReparkClaim, called from inside reparkCrashedWorker,
//     synchronously, before live.delete(id) -- see dispatcher.js's own header) landing as a real
//     file on disk;
//   - a real, separate SCANNER PROCESS (`node orchestrator/daemon.js --real --scanner ...`,
//     dispatcher's own spawnScanner, never simulated) running the real orphanScan.
//
// The ONE test double in the whole chain is the LAUNCHER dispatcher.js hands the crashed task's
// repark to: `deps.spawnRepark` below still spawns a REAL node child (so the claim it triggers is
// real, and so is the pid the claim carries), but that child WAITS on a release file before it
// calls the exact same exported `reparkCrashedTask` (orchestrator/state-machine.js) the real
// `daemon.js --repark-task` binary calls -- see test/daemon-repark-mode.test.js, which already
// covers that real binary end to end, unheld. Holding it here is what turns "the scan happened to
// run before the repark landed" from a race this test might merely WIN into a fact the test
// ESTABLISHES: we wait for the daemon.jsonl event that only fires if the scanner actually read
// this exact task's claim (`orphan-scan-repark-in-flight`) BEFORE ever releasing the repark child.
// Without that wait, a scan that never got a chance to run at all would look identical, on disk, to
// a scan that ran and correctly deferred -- see orphan-scan.js's own claim-check comment.
//
// kind: 'synthetic' (never 'card'), no worktreePath, no parkAlertCmd: finalizePark's real-mode
// side effects (postParkComment's `gh` call, preserveWorktreeWip's `git` call, park-alert.js's
// external command) are all conditioned on fields this fixture never sets, so every park this file
// drives is filesystem-only -- zero spawnSync -- and passes under test/no-real-spawn.js and
// orchestrator/no-real-spawn-guard.js's killswitch (which deliberately leaves `spawn` itself
// unpatched, so the real children this file spawns are unaffected and inherit the armed killswitch
// through their environment via isolatedEnv()). See test/orphan-scan.test.js's own equivalent
// fixture for the same shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn: realSpawn } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident this closes, and why this require has
// to land before the orchestrator require(s) below.
require('./no-real-spawn');

const defaultConfig = require('../orchestrator/config');
const { createDispatcher } = require('../orchestrator/dispatcher');
const { writeState: writeTaskState, reparkClaimPath } = require('../orchestrator/journal');
const { mkTmp, writeTask, writePoolDir, isolatedEnv, readState, readJournal } = require('./helpers');

const REPO_ROOT = path.join(__dirname, '..');
const STATE_MACHINE_PATH = path.join(REPO_ROOT, 'orchestrator', 'state-machine.js');
const CONFIG_PATH = path.join(REPO_ROOT, 'orchestrator', 'config.js');
const JOURNAL_PATH = path.join(REPO_ROOT, 'orchestrator', 'journal.js');

function readDaemonEvents(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// `predicate` is polled until truthy or `timeoutMs` elapses -- on timeout this throws `message`
// verbatim, so a failure names WHAT never happened rather than reporting an opaque node:test
// timeout. Every predicate call is wrapped in try/catch: several read a file that legitimately
// does not exist yet, and "not there yet" must mean "keep waiting", not "fail on the first tick".
async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (predicate()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

// Real `child_process.spawn`, isolated the same way every other daemon subprocess in this suite is
// (test/helpers.js's isolatedEnv) -- used for the ONE genuinely production-shaped child this file
// spawns, the real scanner. `SPO_ORPHAN_SCAN_MS`/`SPO_ORPHAN_GRACE_MS` are set here, in the CHILD's
// own env (never a global `process.env` mutation, which would leak into every other test in this
// file) -- config.js re-resolves both from the environment at THIS fresh process's own require
// time, and daemon.js/dispatcher.js forward neither as CLI flags (buildScannerArgv's own argv has
// no such flag), so the child's env is the only lever this test has on either value. A fast
// orphanScanMs (15ms) buys many scan passes inside this test's own timeout instead of one; a zero
// orphanGraceMs removes any dependency on this fixture's own state.json being "old enough" -- see
// the fixture below, which still backdates `updatedAt` ten minutes anyway, matching what a real
// crashed worker's last write would look like, so the demonstration does not secretly depend on an
// environment override that a differently-invoked scanner might not carry.
//
// Every OTHER scan runScanCycle also runs (auto-pull, auto-intake, unpark, report-confirm,
// remote-report-pull) is disabled here (`0` = off, same convention config.js documents for each)
// -- not to hide anything, but because this test's own account pool/queue/journal are throwaway
// fixtures with no real GitHub behind them: an unrelated scan racing in in the same real scanner
// process would reach `orchestrator/no-real-spawn-guard.js`'s killswitch (SPO_NO_REAL_SPAWN, set by
// isolatedEnv()) the instant it tried a real `gh`/`npm` call, crashing the scanner process for a
// reason that has nothing to do with the repark-claim race this file exists to demonstrate. Measured
// directly: left enabled, auto-pull's `npm run board:claim` trips that killswitch ~90ms after the
// scanner's own boot, three times inside one second (this scanner's default `scannerCrashLimit`),
// tripping the dispatcher's OWN scanner-crash circuit breaker and stopping it entirely -- harmless
// to this file's assertions only because they already resolve within that same ~100ms window, which
// is exactly the kind of "green for an accidental reason" this repo's own doctrine warns against.
function spawnRealScannerFast(cmd, args, opts) {
  return realSpawn(cmd, args, {
    ...opts,
    env: {
      ...isolatedEnv(),
      SPO_ORPHAN_SCAN_MS: '15',
      SPO_ORPHAN_GRACE_MS: '0',
      SPO_AUTO_PULL_MS: '0',
      SPO_UNPARK_SCAN_MS: '0',
      SPO_AUTO_INTAKE_MS: '0',
      SPO_AUTO_TRIAGE_MS: '0',
      SPO_REPORT_CONFIRM_SCAN_MS: '0',
      SPO_REMOTE_REPORT_PULL_MS: '0',
    },
  });
}

// deps.spawn -- the crashed "worker". A real, short-lived node child (not the real daemon.js
// `--worker` binary: that binary's own behaviour under a crash is not what this file is proving,
// dispatcher.js's real handleExit/reparkCrashedWorker reacting to a real exit code is). It writes a
// REAL state.json for the taskDir dispatcher.js's own takeNextTask already created (own pid as
// owner.workerPid, so that pid is genuinely dead the instant this process exits -- no fabricated
// dead pid), then exits with `crashCode`, a value classifyWorkerExit(dispatcher.js) recognises as
// neither 0 (done) nor 20 (parked) -- i.e. 'crashed'.
function fakeCrashingWorker(crashCode) {
  return (cmd, args, opts) => {
    const taskDir = argAfter(args, '--worker');
    const script = [
      `const fs = require(${JSON.stringify('fs')});`,
      `const path = require(${JSON.stringify('path')});`,
      `const { writeState } = require(${JSON.stringify(JOURNAL_PATH)});`,
      `const taskDir = ${JSON.stringify(taskDir)};`,
      `writeState(taskDir, {`,
      `  id: path.basename(taskDir),`,
      `  state: 'DIAGNOSE',`,
      `  owner: { host: require('os').hostname(), workerPid: process.pid, workerStartedAt: new Date().toISOString() },`,
      `  updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),`,
      `  diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, mainMoveUsed: 0,`,
      `  prNumber: null, worktreePath: null,`,
      `});`,
      `process.exit(${crashCode});`,
    ].join('\n');
    return realSpawn(process.execPath, ['-e', script], { ...opts, env: isolatedEnv(), stdio: 'ignore' });
  };
}

// deps.spawnRepark -- see this file's own header for what is and is not a test double here. Parses
// the REAL argv dispatcher.js's own buildReparkArgv built (never reinvents it), spawns a REAL node
// child that waits on `releaseFile`, then requires and calls the exact exported `reparkCrashedTask`
// (state-machine.js) with the same shape daemon.js's own `--repark-task` runRepark uses: `id` is
// the taskDir's own basename (never read off task.json -- see runRepark's own comment on why), and
// `config` is `{...defaultConfig, shadowMode:false, dryRun:false, real:true, queueDir, owner:null}`,
// matching daemon.js's main() assembly for the repark/scanner branch (`owner: reparkMode ? null :
// ...`).
function spawnHeldRepark(releaseFile) {
  return (cmd, args, opts) => {
    const taskDir = argAfter(args, '--repark-task');
    const queueDir = argAfter(args, '--queue');
    const journalRoot = argAfter(args, '--journal');
    const exitCodeRaw = argAfter(args, '--exit-code');
    const signal = argAfter(args, '--signal');
    const script = [
      `const fs = require(${JSON.stringify('fs')});`,
      `const path = require(${JSON.stringify('path')});`,
      `const releaseFile = ${JSON.stringify(releaseFile)};`,
      // Synchronous busy-wait with a real (if short) sleep between polls, via Atomics.wait on a
      // throwaway SharedArrayBuffer -- the standard synchronous-sleep idiom, needed here because
      // this one-shot child has no event loop worth yielding to and must not return control to
      // Node's own callback machinery while "waiting": there is nothing else this process is ever
      // going to do.
      `const ia = new Int32Array(new SharedArrayBuffer(4));`,
      `while (!fs.existsSync(releaseFile)) { Atomics.wait(ia, 0, 0, 5); }`,
      `const { reparkCrashedTask } = require(${JSON.stringify(STATE_MACHINE_PATH)});`,
      `const defaultConfig = require(${JSON.stringify(CONFIG_PATH)});`,
      `reparkCrashedTask({`,
      `  id: path.basename(${JSON.stringify(taskDir)}),`,
      `  taskDir: ${JSON.stringify(taskDir)},`,
      `  queueDir: ${JSON.stringify(queueDir)},`,
      `  journalRoot: ${JSON.stringify(journalRoot)},`,
      `  config: { ...defaultConfig, shadowMode: false, dryRun: false, real: true, queueDir: ${JSON.stringify(queueDir)}, owner: null },`,
      `  exitCode: ${exitCodeRaw === null ? 'null' : JSON.stringify(Number(exitCodeRaw))},`,
      `  signal: ${signal === null ? 'null' : JSON.stringify(signal)},`,
      `});`,
    ].join('\n');
    return realSpawn(process.execPath, ['-e', script], { ...opts, env: isolatedEnv(), stdio: 'ignore' });
  };
}

function onePoolDir(n = 1) {
  const dir = mkTmp('spo-repark-race-accts-');
  writePoolDir(
    dir,
    Array.from({ length: n }, (_, i) => ({ name: `acct${i}` }))
  );
  return dir;
}

const CRASH_CODE = 13; // classifyWorkerExit(dispatcher.js): not 0, not 20 -- 'crashed', by name.

test(
  'the repark-claim file closes the orphanScan/reparkCrashedWorker double-repark race -- exactly one park, and the real scanner really deferred',
  { timeout: 20000 },
  async () => {
    const queueDir = mkTmp('spo-repark-race-q-');
    const journalDir = mkTmp('spo-repark-race-j-');
    const id = 'repark-race-demo-1';
    const taskDir = path.join(journalDir, id);
    const releaseFile = path.join(journalDir, 'release-repark');

    writeTask(queueDir, '0001-race.json', { id, kind: 'synthetic' });

    const config = {
      ...defaultConfig,
      shadowMode: false,
      dryRun: false,
      real: true,
      workers: 1,
      workerCrashLimit: 3,
      pollIntervalMs: 20,
      orphanScanMs: 0,
      unparkScanMs: 0,
      autoPullMs: 0,
      autoIntakeMs: 0,
      reportConfirmScanMs: 0,
      autoTriageMs: 0,
      remoteReportPullMs: 0,
      productRepo: mkTmp('spo-repark-race-product-'),
      pipelineWorktreesDir: mkTmp('spo-repark-race-worktrees-'),
      spoBenchDir: mkTmp('spo-repark-race-bench-'),
      claudeAccountsDir: onePoolDir(1),
      deps: {
        spawn: fakeCrashingWorker(CRASH_CODE),
        spawnScanner: spawnRealScannerFast,
        spawnRepark: spawnHeldRepark(releaseFile),
      },
    };

    const dispatcher = createDispatcher(queueDir, journalDir, config);
    const runPromise = dispatcher.run();
    try {
      // 1. The real crash landed and the real, synchronous claim write ran (dispatcher.js's
      // reparkCrashedWorker, BEFORE handleExit's live.delete(id)/publishLiveWorkerIds).
      await waitFor(
        () => fs.existsSync(reparkClaimPath(taskDir)),
        8000,
        `the repark-claim file never appeared at ${reparkClaimPath(taskDir)} -- the crashed worker never reached reparkCrashedWorker's synchronous writeReparkClaim`
      );

      // 2. The real, SEPARATE scanner process really scanned this exact task WHILE the claim was
      // live, and really deferred because of it -- not because it never got a turn. This is the
      // assertion the test's own header calls out: without it, "the scan never ran" and "the scan
      // ran and correctly deferred" are indistinguishable from the outside.
      await waitFor(
        () => readDaemonEvents(journalDir).some((e) => e.event === 'orphan-scan-repark-in-flight' && e.id === id),
        8000,
        `orphan-scan-repark-in-flight for ${id} was never journalled -- the real scanner process never observed the live claim before this test released the held repark child, so 'exactly one park' below would be an accident, not a fact this test established`
      );

      // The task must still be non-terminal at this instant -- the claim deferred the scan, it did
      // not (and must not) let it write anything.
      assert.equal(readState(journalDir, id).state, 'DIAGNOSE', 'the scan must have been DEFERRED by the claim, not have parked the task itself');

      // 3. Only now release the held repark child -- it is the ONLY writer left standing.
      fs.writeFileSync(releaseFile, '');

      await waitFor(
        () => {
          const s = readState(journalDir, id);
          return s && s.state === 'PARKED';
        },
        8000,
        `state.json for ${id} never reached PARKED after releasing the held repark child`
      );

      // 4. The claim must not outlive the park it protected -- reparkCrashedTask clears its own
      // claim as its own last statement (state-machine.js's own header on that function).
      await waitFor(
        () => !fs.existsSync(reparkClaimPath(taskDir)),
        8000,
        `the repark-claim file at ${reparkClaimPath(taskDir)} outlived the park it protected -- a later retry of this taskDir would read a stale claim`
      );
    } finally {
      // A held repark child is NEVER signalled by an ordinary dispatcher.stop() (dispatcher.js's
      // own killAllChildren, default `includeReparking: false` -- see that file's header on why:
      // letting an in-flight park finish beats killing it mid-write). So on any failure path above
      // that returns before this test itself releases the child, release it here unconditionally
      // -- otherwise a failed assertion (or a revoked guard reopening the race differently than
      // expected) would leave this test HANGING on `await runPromise` instead of failing by name.
      if (!fs.existsSync(releaseFile)) {
        try {
          fs.writeFileSync(releaseFile, '');
        } catch {
          // best-effort -- if the dir itself is gone there is nothing left to release into.
        }
      }
      dispatcher.stop();
      await runPromise;
    }

    const state = readState(journalDir, id);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, 'worker-crashed', `expected the real worker-crash repark to win with reason 'worker-crashed', got ${state.reason}`);

    const events = readJournal(journalDir, id);
    const parkedEvents = events.filter((e) => e.event === 'parked');
    assert.equal(
      parkedEvents.length,
      1,
      `expected exactly ONE 'parked' record for ${id}, found ${parkedEvents.length}: ${JSON.stringify(parkedEvents)}`
    );
    assert.equal(parkedEvents[0].reason, 'worker-crashed');
    assert.notEqual(
      parkedEvents[0].reason,
      'task-orphaned-daemon-restart',
      "the task parked with the SCANNER's own crash-recovery reason, not the dispatcher's -- the claim did not close the race"
    );

    const daemonEvents = readDaemonEvents(journalDir);
    const daemonParked = daemonEvents.filter((e) => e.event === 'parked' && e.id === id);
    assert.equal(daemonParked.length, 1, `expected exactly ONE daemon.jsonl 'parked' line for ${id}, found ${daemonParked.length}`);
  }
);

module.exports = { onePoolDir, fakeCrashingWorker, spawnHeldRepark, spawnRealScannerFast, waitFor, argAfter, CRASH_CODE };
