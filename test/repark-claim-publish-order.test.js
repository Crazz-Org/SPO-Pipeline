'use strict';
// repark-claim-publish-order.test.js -- card #78: the ORDERING half of the claim's closure, pinned
// at RUNTIME rather than by reading dispatcher.js's source.
//
// WHAT IS BEING PINNED. reparkCrashedWorker writes <taskDir>/repark-claim.json SYNCHRONOUSLY, and
// handleExit only then runs `live.delete(id)` + publishLiveWorkerIds(). That order is the entire
// closure: orphan-scan.js (a SEPARATE process) decides "this task is already being reparked" from
// the claim file alone, so a taskDir that has just left live-workers.json without its claim
// already on disk is, for the length of that gap, invisible to both mechanisms at once -- exactly
// the double-repark this lot exists to close. Card #78 retired the old invariant ("handleExit is
// fully synchronous, so the PARK is durable before the id leaves the table") because the park now
// runs in a spawned child; what replaced it is narrower and must be pinned just as tightly: the
// CLAIM is durable before the id leaves the table.
//
// WHY THIS FILE EXISTS SEPARATELY FROM test/repark-race-demo.test.js. Measured, not assumed: with
// `writeReparkClaim` wrapped in `setImmediate` -- a one-tick delay that reopens precisely the
// pre-#78 race -- the whole demo test stays GREEN, and so does dispatcher.test.js's file-level
// claim-order test (it polls live-workers.json from a later tick, by which time a setImmediate
// callback has long since run). The gap was covered only by a test that reads dispatcher.js's
// SOURCE for the statement order -- the same unfalsifiable shape as the invariant this lot just
// retired. This file closes it with a real observation of the real call.
//
// THE OBSERVATION POINT, AND WHY IT IS NOT A KNOB. dispatcher.js DESTRUCTURES writeLiveWorkerIds
// out of journal.js at require time (its own `const { ... } = require('./journal')`), so wrapping
// that export BEFORE this file requires dispatcher.js puts a spy on the exact function
// publishLiveWorkerIds calls -- and the spy runs INSIDE that call, synchronously, which is the
// only vantage point from which a one-tick ordering violation is visible at all. Nothing in
// orchestrator/ is modified, no `deps` entry is added, and no production branch is conditional on
// anything this file sets: the spy OBSERVES the publish and delegates to the real implementation.
// It is not the guard, and revoking it changes no production behaviour -- it only blinds this test.
//
// kind: 'synthetic', no worktreePath, no parkAlertCmd -- same filesystem-only fixture shape as
// test/repark-race-demo.test.js and test/orphan-scan.test.js, so every park this file drives makes
// zero spawnSync calls and passes under test/no-real-spawn.js's killswitch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- must land before the orchestrator requires below, same as every other file here.
require('./no-real-spawn');

// ---- the spy, installed BEFORE dispatcher.js is required (see this file's header) ------------
const journal = require('../orchestrator/journal');
const { reparkClaimPath } = journal;
const realWriteLiveWorkerIds = journal.writeLiveWorkerIds;

// One entry per publishLiveWorkerIds call the dispatcher makes: the id set it was about to write,
// and -- read at that exact instant, inside the call -- whether the watched task's claim file was
// already on disk. `watchedTaskDir` is set per test; null means "record nothing", so this wrapper
// is inert for any other file that happens to share this process.
let watchedTaskDir = null;
let publishes = [];
journal.writeLiveWorkerIds = function spyWriteLiveWorkerIds(journalRoot, ids) {
  // `live.keys()` is an ITERATOR: materialise it once here, or the real implementation below is
  // handed an already-drained iterator and writes an empty table.
  const idArray = Array.from(ids);
  if (watchedTaskDir) {
    publishes.push({ ids: idArray, claimOnDisk: fs.existsSync(reparkClaimPath(watchedTaskDir)) });
  }
  return realWriteLiveWorkerIds(journalRoot, idArray);
};

const defaultConfig = require('../orchestrator/config');
const { createDispatcher } = require('../orchestrator/dispatcher');
const { mkTmp, writeTask, writePoolDir, isolatedEnv, readState } = require('./helpers');

const JOURNAL_PATH = path.join(__dirname, '..', 'orchestrator', 'journal.js');
const CRASH_CODE = 13; // classifyWorkerExit: not 0, not 20 -- 'crashed', by name.

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

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

// A real child that writes a real state.json for its taskDir (own pid as owner.workerPid, so that
// pid is genuinely dead the instant it exits) and then crashes -- the same fixture worker
// test/repark-race-demo.test.js uses, for the same reason: handleExit must be reached by a REAL
// exit, never by a direct call.
function fakeCrashingWorker(cmd, args, opts) {
  const taskDir = argAfter(args, '--worker');
  const script = [
    `const path = require('path');`,
    `const { writeState } = require(${JSON.stringify(JOURNAL_PATH)});`,
    `writeState(${JSON.stringify(taskDir)}, {`,
    `  id: path.basename(${JSON.stringify(taskDir)}),`,
    `  state: 'DIAGNOSE',`,
    `  owner: { host: require('os').hostname(), workerPid: process.pid, workerStartedAt: new Date().toISOString() },`,
    `  updatedAt: new Date().toISOString(),`,
    `  diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, mainMoveUsed: 0,`,
    `  prNumber: null, worktreePath: null,`,
    `});`,
    `process.exit(${CRASH_CODE});`,
  ].join('\n');
  return realSpawn(process.execPath, ['-e', script], { ...opts, env: isolatedEnv(), stdio: 'ignore' });
}

// A repark child that stays alive well past the publish this test observes, so the claim it
// triggered cannot have been cleared again (by reparkCrashedTask's own `finally`, or by the
// dispatcher's exit-watch backstop) before the assertion reads it. It never parks anything: what
// is under test here is the ORDER of two statements in the PARENT, not the child's own work,
// which test/daemon-repark-mode.test.js and test/repark-race-demo.test.js already cover.
function slowRepark(cmd, args, opts) {
  return realSpawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000);'], {
    ...opts,
    env: isolatedEnv(),
    stdio: 'ignore',
  });
}

// The dispatcher spawns exactly one scanner unconditionally; this file has no use for a real one
// (it observes an in-process ordering), so a long-lived stub keeps the scanner-respawn loop and
// its circuit breaker out of the way without simulating anything this test asserts on.
function neverExitsScanner(cmd, args, opts) {
  return realSpawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60000);'], {
    ...opts,
    env: isolatedEnv(),
    stdio: 'ignore',
  });
}

function onePoolDir() {
  const dir = mkTmp('spo-claimorder-accts-');
  writePoolDir(dir, [{ name: 'acct0' }]);
  return dir;
}

test(
  'card #78: at the instant the dispatcher publishes live-workers.json WITHOUT the crashed id, the repark claim is ALREADY on disk -- observed inside the real publish call, not read off dispatcher.js\'s source',
  { timeout: 30000 },
  async () => {
    const queueDir = mkTmp('spo-claimorder-q-');
    const journalDir = mkTmp('spo-claimorder-j-');
    const id = 'claim-publish-order-1';
    const taskDir = path.join(journalDir, id);

    publishes = [];
    watchedTaskDir = taskDir;

    writeTask(queueDir, '0001-cpo.json', { id, kind: 'synthetic' });

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
      productRepo: mkTmp('spo-claimorder-product-'),
      pipelineWorktreesDir: mkTmp('spo-claimorder-worktrees-'),
      spoBenchDir: mkTmp('spo-claimorder-bench-'),
      claudeAccountsDir: onePoolDir(),
      deps: { spawn: fakeCrashingWorker, spawnScanner: neverExitsScanner, spawnRepark: slowRepark },
    };

    // run() publishes an EMPTY table once at startup, before any task is taken, and
    // dispatcher.stop() publishes again on the way out -- so "a publish without the id" on its own
    // is not the interesting one. The publish this test inspects is the first one that drops the
    // id AFTER a publish that carried it: handleExit's own `live.delete(id); publishLiveWorkerIds()`.
    const spawnPublishIndex = () => publishes.findIndex((p) => p.ids.includes(id));
    const dropPublishIndex = () => {
      const w = spawnPublishIndex();
      return w === -1 ? -1 : publishes.findIndex((p, i) => i > w && !p.ids.includes(id));
    };

    const dispatcher = createDispatcher(queueDir, journalDir, config);
    const runPromise = dispatcher.run();
    try {
      // Wait for that exact publish to have happened -- never merely for "some publish without the
      // id", which the startup publish satisfies before the worker has even been spawned (measured:
      // stopping on that predicate killed the worker with SIGTERM, took handleExit's
      // during-shutdown branch, and left this test asserting on a publish no crash ever produced).
      await waitFor(
        () => dropPublishIndex() !== -1,
        10000,
        `the dispatcher never published live-workers.json WITHOUT ${id} after publishing it WITH it -- the crashed worker's handleExit was never reached, so this test observed nothing`
      );
    } finally {
      dispatcher.stop();
      await runPromise;
      watchedTaskDir = null;
    }

    // Fixture sanity, so a vacuous pass is impossible: the spy must have seen the SPAWN publish
    // (id present) before the exit publish (id absent), and no claim may exist while the worker is
    // still live -- a claim written too EARLY would satisfy the main assertion for the wrong reason.
    const firstWith = spawnPublishIndex();
    assert.notEqual(firstWith, -1, 'the spy never saw a publish CONTAINING the id -- fixture bug, not a finding');
    assert.equal(
      publishes[firstWith].claimOnDisk,
      false,
      'a repark claim existed while the worker was still in the live table -- the claim must be written by the crash handler, never before it'
    );

    // THE ASSERTION. The first publish that DROPS the id is handleExit's own
    // `live.delete(id); publishLiveWorkerIds();` -- and reparkCrashedWorker's synchronous
    // writeReparkClaim must already have landed by then.
    const dropIndex = dropPublishIndex();
    assert.notEqual(dropIndex, -1, 'the spy never saw a publish DROPPING the id -- fixture bug, not a finding');
    assert.equal(
      publishes[dropIndex].claimOnDisk,
      true,
      `live-workers.json was published WITHOUT ${id} while <taskDir>/repark-claim.json did not yet exist. For the length of that gap this taskDir is invisible to BOTH closures at once -- not in the live table, not claimed -- and orphan-scan.js (a separate process) would repark it a second time underneath the repark child that is already starting. The claim write must stay a synchronous statement in reparkCrashedWorker, completed before handleExit reaches live.delete(id).`
    );

    // The crash really was classified as a crash (not, say, silently treated as a clean exit, which
    // would never have written a claim at all and would make the assertion above vacuous) -- the
    // task is left non-terminal, exactly as a real in-flight repark leaves it. The claim itself is
    // NOT checked here: `dispatcher.stop(); await runPromise` above waits out the stub repark
    // child, and the dispatcher's own exit-watch backstop clears the claim on that child's exit
    // (pinned by test/dispatcher.test.js's claim-cleared-on-exit test). What this file pins is
    // the ordering at the publish, which the spy already recorded.
  }
);
