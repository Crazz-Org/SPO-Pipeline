'use strict';
// Tests for orchestrator/orphan-scan.js: the daemon-restart recovery path for a task whose
// owning process died mid-run -- see the module's own header and doc/state-machine-spec.md's
// note on card #385 for the incident this replaces a manual fix for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { shouldScanOrphans, orphanScan } = require('../orchestrator/orphan-scan');
const { unparkScan } = require('../orchestrator/park-loop');
const { appendEvent, writeState, writeLiveWorkerIds } = require('../orchestrator/journal');
const { runScanCycle, createScanTimers } = require('../orchestrator/state-machine');
const { createScanState } = require('../orchestrator/comment-scan');
const { runDaemonOnce, runDaemonDryRun } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function testConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-orphan-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-orphan-bench-'),
    stepDeadlineMs: 30000,
    claudeAccountsDir: mkTmp('spo-orphan-accts-'),
    orphanGraceMs: 1000,
    owner: { host: os.hostname(), pid: process.pid, lockStartedAt: '2026-08-30T00:00:00.000Z' },
    ...overrides,
  };
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readDaemonEvents(journalRoot) {
  return fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// A pid that is guaranteed dead: fork nothing, just pick a very large, implausible pid. Some
// platforms recycle pids fast, so this is best-effort, same caveat lock.test.js's own
// dead-pid tests accept.
const DEAD_PID = 999999;

function seedTask(journalRoot, id, { state = 'DIAGNOSE', owner, updatedAt, task = {}, extra = {} } = {}) {
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue: 385, ...task }, null, 2));
  writeState(taskDir, {
    id,
    state,
    diagnoseAttempts: 1,
    validateRejects: 0,
    mainMoveUsed: false,
    prNumber: null,
    worktreePath: null,
    owner: owner === undefined ? { host: os.hostname(), pid: DEAD_PID, lockStartedAt: 'old' } : owner,
    updatedAt: updatedAt || new Date(Date.now() - 10_000).toISOString(),
    ...extra,
  });
  return taskDir;
}

test('shouldScanOrphans: disabled at <= 0, fires on first call, then respects the interval', () => {
  assert.equal(shouldScanOrphans(null, 1000, 0), false);
  assert.equal(shouldScanOrphans(null, 1000, 60000), true);
  assert.equal(shouldScanOrphans(1000, 1000 + 59999, 60000), false);
  assert.equal(shouldScanOrphans(1000, 1000 + 60000, 60000), true);
});

test('orphanScan: dead owner + stale updatedAt + no queue entry -> reparked task-orphaned-daemon-restart', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-385', { state: 'DIAGNOSE' });

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps);
  assert.deepEqual(recovered, [{ id: 'issue-385', reason: 'task-orphaned-daemon-restart' }]);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'task-orphaned-daemon-restart');
  assert.equal(state.lastState, 'DIAGNOSE');
  assert.ok(fs.existsSync(path.join(taskDir, 'report.md')));

  const events = readJournal(taskDir);
  assert.ok(events.some((e) => e.event === 'parked' && e.reason === 'task-orphaned-daemon-restart'));

  // The retry loop closes: this reparked task now has a park-comment anchor unparkScan can act on.
  assert.ok(events.some((e) => e.event === 'park-comment'));
});

// ---- action 6.3: the dispatcher's live-worker table -------------------------------------------
test('orphanScan: skips a task whose id is in liveWorkerIds, even though it looks orphaned by every other check, and still reparks one that is not', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  // Both tasks are byte-for-byte identical shapes -- non-terminal state, dead owner pid, stale
  // updatedAt, no queue entry -- so the ONLY thing that can explain one being reparked and the
  // other not is the liveWorkerIds set itself, not some other difference the fixture snuck in.
  const liveDir = seedTask(journalRoot, 'issue-live', { state: 'IMPLEMENT' });
  const deadDir = seedTask(journalRoot, 'issue-dead', { state: 'IMPLEMENT' });

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/1#issuecomment-1') };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps, new Set(['issue-live']));

  // The live one: untouched. state.json still says IMPLEMENT, no journal.jsonl 'parked' line, and
  // orphanScan's own return value never names it.
  assert.deepEqual(recovered, [{ id: 'issue-dead', reason: 'task-orphaned-daemon-restart' }]);
  const liveState = JSON.parse(fs.readFileSync(path.join(liveDir, 'state.json'), 'utf8'));
  assert.equal(liveState.state, 'IMPLEMENT');
  // orphanScan never even touches a skipped task's journal.jsonl -- seedTask itself never wrote
  // one (only task.json/state.json), so the file simply not existing IS the proof nothing was
  // journaled against it.
  assert.equal(fs.existsSync(path.join(liveDir, 'journal.jsonl')), false);

  // The dead one: reparked exactly as the plain dead-owner test above expects.
  const deadState = JSON.parse(fs.readFileSync(path.join(deadDir, 'state.json'), 'utf8'));
  assert.equal(deadState.state, 'PARKED');
  assert.equal(deadState.reason, 'task-orphaned-daemon-restart');
});

test('orphanScan: an omitted liveWorkerIds (null, the pre-6.3 default) reparks a dead-owner task exactly as before -- no behaviour change for callers that never pass one', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-no-table', { state: 'CHECK' });

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/1#issuecomment-1') };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps);
  assert.deepEqual(recovered, [{ id: 'issue-no-table', reason: 'task-orphaned-daemon-restart' }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8')).state, 'PARKED');
});

// action 6.3 (post-verification correction): runScanCycle -- the SCANNER's own loop body -- must
// actually READ <journalRoot>/live-workers.json before every orphanScan call, not just accept a
// liveWorkerIds parameter someone else remembered to pass. This is the cross-process half of the
// design (journal.js's writeLiveWorkerIds/readLiveWorkerIds, dispatcher.js's publish side); the
// tests above already pin orphanScan's OWN handling of a liveWorkerIds Set it is handed directly,
// which does not exercise the READ at all -- a mutation that replaced runScanCycle's
// `readLiveWorkerIds(journalRoot)` with `new Set()` passed the entire suite until this test
// existed (verification round, 2026-09-01: confirmed by mutation, 1266/1266 green with the read
// disabled). Driven through runScanCycle directly, not the full dispatcher+scanner process pair,
// so it is fast and deterministic rather than racing real subprocess timing.
test('runScanCycle reads live-workers.json fresh and protects a listed id from orphanScan, even though it looks orphaned by every other check', async () => {
  const journalRoot = mkTmp('spo-scancycle-journal-');
  const queueDir = mkTmp('spo-scancycle-queue-');
  const taskDir = seedTask(journalRoot, 'scancycle-protected', { state: 'IMPLEMENT' });

  // deps.isAlive: () => false -- the recorded owner pid is "dead" by every other measure, exactly
  // like every other orphanScan test in this file. runScanCycle reads its deps off config.deps
  // (the same convention buildCtx/HANDLERS use), not a separate parameter. deps.spawnSync is the
  // same fake `gh issue comment` success every other real-mode repark test in this file uses --
  // seedTask's default task is `kind: 'card'`, so the eventual repark's postParkComment really
  // would reach a live `gh` call without it.
  const config = testConfig({
    orphanScanMs: 1000,
    deps: { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') },
  });
  const timers = createScanTimers();
  const scanStates = { unpark: createScanState(), reportConfirm: createScanState() };

  writeLiveWorkerIds(journalRoot, ['scancycle-protected']);
  await runScanCycle(timers, queueDir, journalRoot, config, scanStates);

  const protectedState = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(protectedState.state, 'IMPLEMENT', 'runScanCycle reparked a task live-workers.json explicitly protects');

  // Once the file no longer lists it (the dispatcher's own publish, simulated here), the VERY
  // NEXT scan reparks it normally -- proving the protection is read FRESH, not cached from the
  // first call, and that the underlying orphan detection was otherwise working correctly all along.
  writeLiveWorkerIds(journalRoot, []);
  timers.lastOrphanScanAt = null; // force this second call to be due again, same as a fresh timers object
  await runScanCycle(timers, queueDir, journalRoot, config, scanStates);

  const reparkedState = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(reparkedState.state, 'PARKED');
  assert.equal(reparkedState.reason, 'task-orphaned-daemon-restart');
});

test('orphanScan -> unparkScan: a maintainer retry on the reparked issue re-enqueues it (the full loop #385 needed by hand)', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  seedTask(journalRoot, 'issue-385', { state: 'DIAGNOSE' });

  const config = testConfig();
  const deps = {
    isAlive: () => false,
    spawnSync: (cmd, args) => {
      if (args.includes('comment')) return ok('https://github.com/x/y/issues/385#issuecomment-100');
      if (args[0] === 'api' && String(args[1]).endsWith('/collaborators'))
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      if (args[0] === 'api') return ok(JSON.stringify([{ id: 101, user: { login: 'Crazz-E' }, body: 'retry' }]));
      return ok();
    },
  };

  await orphanScan(queueDir, journalRoot, config, deps);
  await unparkScan(queueDir, journalRoot, config, deps);

  const queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.id, 'issue-385');
});

test('orphanScan: owner still alive -> left alone (slow, not orphaned)', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-1', { owner: { host: os.hostname(), pid: process.pid, lockStartedAt: 'x' } });

  const recovered = await orphanScan(queueDir, journalRoot, testConfig(), {});
  assert.deepEqual(recovered, []);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'DIAGNOSE');
});

// ---- action 6.1: orphan-scan must recognise BOTH owner shapes -------------------------------
// A worker-mode run (daemon.js --worker) writes {host, workerPid, workerStartedAt} instead of
// the non-worker daemon's {host, pid, lockStartedAt} -- there is no lock holder to borrow
// pid/startedAt from, since a worker never takes the lock. Every other test in this file already
// exercises the OLD shape via seedTask's own default owner (line ~79 above); these three pin the
// NEW shape explicitly, plus one explicit old-shape case side by side so the pairing in the plan
// spec is visible in one place rather than scattered across the file.

test('orphanScan: OLD owner shape {host, pid, lockStartedAt}, built explicitly, with a dead pid -> reparked', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-900', {
    owner: { host: os.hostname(), pid: DEAD_PID, lockStartedAt: '2026-08-30T00:00:00.000Z' },
  });

  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };
  const recovered = await orphanScan(queueDir, journalRoot, testConfig(), deps);
  assert.deepEqual(recovered, [{ id: 'issue-900', reason: 'task-orphaned-daemon-restart' }]);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');
});

test('orphanScan: NEW owner shape {host, workerPid, workerStartedAt} with a dead pid -> reparked the same way', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-901', {
    owner: { host: os.hostname(), workerPid: DEAD_PID, workerStartedAt: '2026-09-01T00:00:00.000Z' },
  });

  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };
  const recovered = await orphanScan(queueDir, journalRoot, testConfig(), deps);
  assert.deepEqual(recovered, [{ id: 'issue-901', reason: 'task-orphaned-daemon-restart' }]);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');
});

test('orphanScan: NEW owner shape with an ALIVE workerPid -> left alone (slow, not orphaned)', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-902', {
    owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: 'x' },
  });

  const recovered = await orphanScan(queueDir, journalRoot, testConfig(), {});
  assert.deepEqual(recovered, []);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'DIAGNOSE');
});

test('orphanScan: dead owner but recent updatedAt -> left alone (startup-race grace window)', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-2', { updatedAt: new Date().toISOString() });

  const recovered = await orphanScan(queueDir, journalRoot, testConfig({ orphanGraceMs: 4 * 60 * 1000 }), { isAlive: () => false });
  assert.deepEqual(recovered, []);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'DIAGNOSE');
});

test('orphanScan: no owner recorded -> left alone, logged as unknown-owner', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  seedTask(journalRoot, 'issue-3', { owner: null });

  const recovered = await orphanScan(queueDir, journalRoot, testConfig(), { isAlive: () => false });
  assert.deepEqual(recovered, []);

  assert.ok(readDaemonEvents(journalRoot).some((e) => e.event === 'orphan-scan-unknown-owner' && e.id === 'issue-3'));
});

test('orphanScan: id already re-enqueued in queue/ -> left alone (waiting its turn, not orphaned)', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-4');
  fs.writeFileSync(path.join(queueDir, 'retry-1-issue-4.json'), JSON.stringify({ id: 'issue-4' }));

  const recovered = await orphanScan(queueDir, journalRoot, testConfig(), { isAlive: () => false });
  assert.deepEqual(recovered, []);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'DIAGNOSE');
});

for (const terminal of ['PARKED', 'DONE', 'ABANDONED']) {
  test(`orphanScan: already-terminal state (${terminal}) -> left alone`, async () => {
    const journalRoot = mkTmp('spo-orphan-journal-');
    const queueDir = mkTmp('spo-orphan-queue-');
    seedTask(journalRoot, `issue-${terminal}`, { state: terminal });

    const recovered = await orphanScan(queueDir, journalRoot, testConfig(), { isAlive: () => false });
    assert.deepEqual(recovered, []);
  });
}

test('orphanScan: two passes in a row -> only one park (second pass sees PARKED, a terminal state)', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  seedTask(journalRoot, 'issue-5', {});

  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };
  const config = testConfig();

  const first = await orphanScan(queueDir, journalRoot, config, deps);
  const second = await orphanScan(queueDir, journalRoot, config, deps);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

// ---- action 2.3: orphan repark must restore worktreePath -----------------------------------

test('orphanScan: restores worktreePath from state.json onto ctx.task -- preserveWorktreeWip actually pushes a wip ref instead of a silent no-op', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const worktreePath = mkTmp('spo-orphan-worktree-');
  fs.writeFileSync(path.join(worktreePath, 'stray.ts'), 'uncommitted work');
  const taskDir = seedTask(journalRoot, 'issue-600', { state: 'IMPLEMENT', extra: { worktreePath } });

  const config = testConfig();
  const deps = {
    isAlive: () => false,
    spawnSync: (command, args) => {
      if (command === 'git') {
        if (args.includes('status') && args.includes('--porcelain')) return ok(' M stray.ts\n');
        if (args.includes('rev-parse') && args.includes('HEAD')) return ok('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
        return ok('');
      }
      return ok('https://github.com/x/y/issues/385#issuecomment-1'); // gh comment/moveCard calls
    },
  };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps);
  assert.deepEqual(recovered, [{ id: 'issue-600', reason: 'task-orphaned-daemon-restart' }]);

  const events = readJournal(taskDir);
  const preserved = events.find((e) => e.event === 'wip-preserved');
  assert.ok(preserved, 'expected preserveWorktreeWip to actually run and journal wip-preserved (worktreePath was restored)');
  assert.ok(preserved.ref.startsWith('wip/issue-600-'));

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');

  // finalizePark's mergedDetail (the wip ref/sha) lands in report.md's detail block.
  const report = fs.readFileSync(path.join(taskDir, 'report.md'), 'utf8');
  assert.match(report, /"wip"/);
});

test('orphanScan: state.json with no worktreePath (a task that died before WORKTREE ever ran) still reparks cleanly, no wip-preserve attempted', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-601', { state: 'INTAKE' }); // seedTask's default state.json carries worktreePath: null

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps);
  assert.deepEqual(recovered, [{ id: 'issue-601', reason: 'task-orphaned-daemon-restart' }]);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');

  const events = readJournal(taskDir);
  assert.ok(
    !events.some((e) => e.event === 'wip-preserved' || e.event === 'wip-preserve-failed'),
    'no worktree ever existed for this task -- preserveWorktreeWip must be a silent no-op, not an attempt'
  );
});

// Not "carried over" but RESTORED: the repark rewrites state.json through snapshot(), so a
// counter buildCtx zeroes and this scan does not restore is not merely missing from the park
// report -- it is overwritten with 0, and the parked card's record then denies attempts that
// really happened. Action 4.3's ciImplementRetries joined the list for exactly that reason.
test('orphanScan: prNumber and ALL FOUR counters are still restored from state.json onto the reparked snapshot', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-602', {
    state: 'VALIDATE',
    extra: {
      prNumber: 42,
      diagnoseAttempts: 3,
      validateRejects: 2,
      ciImplementRetries: 2,
      mainMoveUsed: 3,
    },
  });

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };

  await orphanScan(queueDir, journalRoot, config, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.prNumber, 42);
  assert.equal(state.diagnoseAttempts, 3);
  assert.equal(state.validateRejects, 2);
  assert.equal(state.ciImplementRetries, 2);
  // Action 6.5 made this a COUNT. It must round-trip like the three counters above and NOT be
  // flattened back to a boolean -- a `!!` restore here would rewrite this card's record to claim
  // one main move where it had spent three, which is precisely the understatement this test
  // exists to forbid for the others.
  assert.equal(state.mainMoveUsed, 3);
});

// Action 6.5, the upgrade case: every state.json written before 6.5 holds a BOOLEAN here (all 21
// real files under journal/*/ did at the time of the change), and the post-merge hook SIGTERMs
// the daemon on every deploy -- so a card mid-flight across the upgrade is the ordinary case, not
// an exotic one. A legacy `true` must restore as the 1 the new code would have written, and a
// legacy `false` as 0, so the field's type in state.json converges on a number instead of
// alternating with whatever the last writer happened to be.
test('orphanScan: a PRE-6.5 boolean mainMoveUsed upgrades in place -- true -> 1, never back out as a boolean', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-603', {
    state: 'VALIDATE',
    extra: { prNumber: 7, mainMoveUsed: true },
  });

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };

  await orphanScan(queueDir, journalRoot, config, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.strictEqual(state.mainMoveUsed, 1, 'a legacy boolean true is the 1 the counter now means');
});

test('orphanScan: a PRE-6.5 boolean false mainMoveUsed upgrades to 0, not false', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-604', {
    state: 'VALIDATE',
    extra: { prNumber: 8, mainMoveUsed: false },
  });

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };

  await orphanScan(queueDir, journalRoot, config, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.strictEqual(state.mainMoveUsed, 0);
});

// ---- action 2.4: orphanScan must not repark outside --real ----------------------------------

test('orphanScan: shadowMode config -> no park written, orphan-scan-would-repark journaled instead', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-700', { state: 'DIAGNOSE' });

  const config = testConfig({ shadowMode: true, real: false });
  const recovered = await orphanScan(queueDir, journalRoot, config, { isAlive: () => false });

  assert.deepEqual(recovered, [{ id: 'issue-700', reason: 'task-orphaned-daemon-restart', wouldRepark: true }]);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'DIAGNOSE', 'shadow mode must never write PARKED');
  assert.ok(!fs.existsSync(path.join(taskDir, 'report.md')));
  assert.ok(!fs.existsSync(path.join(taskDir, 'journal.jsonl')), 'nothing under the task dir itself may be touched');

  assert.ok(
    readDaemonEvents(journalRoot).some((e) => e.event === 'orphan-scan-would-repark' && e.id === 'issue-700')
  );
});

test('orphanScan: dryRun config -> no park written, orphan-scan-would-repark journaled instead', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTask(journalRoot, 'issue-701', { state: 'IMPLEMENT' });

  const config = testConfig({ dryRun: true, real: false });
  const recovered = await orphanScan(queueDir, journalRoot, config, { isAlive: () => false });

  assert.deepEqual(recovered, [{ id: 'issue-701', reason: 'task-orphaned-daemon-restart', wouldRepark: true }]);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'IMPLEMENT', 'dry-run mode must never write PARKED');
  assert.ok(!fs.existsSync(path.join(taskDir, 'report.md')));
  assert.ok(!fs.existsSync(path.join(taskDir, 'journal.jsonl')));

  assert.ok(
    readDaemonEvents(journalRoot).some((e) => e.event === 'orphan-scan-would-repark' && e.id === 'issue-701')
  );
});

test('daemon --shadow --once against a journal root with a real orphan: no park written, would-repark journaled, daemon still starts and drains normally', () => {
  const queueDir = mkTmp('spo-orphan-daemon-queue-');
  const journalRoot = mkTmp('spo-orphan-daemon-journal-');
  const taskDir = seedTask(journalRoot, 'issue-800', {
    state: 'DIAGNOSE',
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // well past the default 4-minute grace
  });

  assert.doesNotThrow(() => runDaemonOnce(queueDir, journalRoot));

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'DIAGNOSE');
  assert.ok(readDaemonEvents(journalRoot).some((e) => e.event === 'orphan-scan-would-repark' && e.id === 'issue-800'));
});

test('daemon --dry-run --once against a journal root with a real orphan: no park written, would-repark journaled, daemon still starts and drains normally', () => {
  const queueDir = mkTmp('spo-orphan-daemon-queue-');
  const journalRoot = mkTmp('spo-orphan-daemon-journal-');
  const taskDir = seedTask(journalRoot, 'issue-801', {
    state: 'DIAGNOSE',
    updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });

  assert.doesNotThrow(() => runDaemonDryRun(queueDir, journalRoot));

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'DIAGNOSE');
  assert.ok(readDaemonEvents(journalRoot).some((e) => e.event === 'orphan-scan-would-repark' && e.id === 'issue-801'));
});

// Isolation guard. No test should reach realWorktree -- but a mutation that makes shadow mode
// take a real path can, and then fixture task ids become real git worktrees and branches in the
// maintainer's live ~/SPO-WebClient. A mutation-testing round on 2026-08-31 left 44 worktrees and
// 61 branches there; `worktrees/` is gitignored, so `git status` stayed clean while bare
// `node --test` walked into them and reported ~13k foreign failures. This pins the seam that
// makes it structurally impossible.
test('config: SPO_PRODUCT_REPO and SPO_WORKTREES_DIR redirect the real product paths, so a test subprocess can never touch the live checkout', () => {
  const configPath = require.resolve('../orchestrator/config.js');
  const load = (env) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[configPath];
    try {
      const c = require('../orchestrator/config.js');
      return { productRepo: c.productRepo, pipelineWorktreesDir: c.pipelineWorktreesDir };
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[configPath];
    }
  };

  const redirected = load({ SPO_PRODUCT_REPO: '/tmp/not-the-real-repo', SPO_WORKTREES_DIR: '/tmp/not-the-real-worktrees' });
  assert.equal(redirected.productRepo, '/tmp/not-the-real-repo');
  assert.equal(redirected.pipelineWorktreesDir, '/tmp/not-the-real-worktrees');

  // Absent -> the real defaults, unchanged for production.
  const defaults = load({ SPO_PRODUCT_REPO: undefined, SPO_WORKTREES_DIR: undefined });
  assert.ok(defaults.productRepo.endsWith('SPO-WebClient'));
  assert.ok(defaults.pipelineWorktreesDir.endsWith('worktrees'));
});

// The helper every daemon subprocess goes through must actually set both, or the seam above is
// decorative.
test('helpers: every daemon subprocess is pointed at a throwaway product repo and worktrees dir', () => {
  const helpersSrc = fs.readFileSync(path.join(__dirname, 'helpers.js'), 'utf8');
  assert.match(helpersSrc, /SPO_PRODUCT_REPO:/, 'isolatedEnv must set SPO_PRODUCT_REPO');
  assert.match(helpersSrc, /SPO_WORKTREES_DIR:/, 'isolatedEnv must set SPO_WORKTREES_DIR');
  for (const runner of ['runDaemonOnce', 'runDaemonDryRun', 'runSpo']) {
    const body = helpersSrc.slice(helpersSrc.indexOf(`function ${runner}(`));
    assert.match(body.slice(0, 400), /env: isolatedEnv\(\)/, `${runner} must spawn with isolatedEnv()`);
  }
});

// ---- CROSS-ACTION defect: the rename -> first-writeState window action 6.3 opened -------------
//
// takeNextTask renames queue/<file>.json to <taskDir>/task.json and journals 'taken'; runTask
// writes the first state.json. Pre-6.3 those were consecutive statements in ONE process. 6.3 put
// a PROCESS SPAWN between them: measured on this box with 8 real workers at 71-77 ms, median
// 74 ms. Die inside that window (deploy SIGKILL at TimeoutStopUSec=1min30s, OOM, power) and the
// task had no state.json -- which made it invisible to orphanScan (`if (!state) continue`),
// invisible to unparkScan (not PARKED), and un-re-pullable by auto-pull (intake.js's
// taskAlreadyExists returns true on the taskDir's mere existence). Lost forever, silently.

// Seeds exactly the on-disk shape takeNextTask leaves behind and nothing more: task.json and a
// journal.jsonl holding only the 'taken' event. No state.json -- that is the whole point.
function seedTakenButNeverStarted(journalRoot, id, { ageMs = 10_000, task = {} } = {}) {
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue: 385, ...task }, null, 2));
  fs.writeFileSync(
    path.join(taskDir, 'journal.jsonl'),
    JSON.stringify({ ts: new Date(Date.now() - ageMs).toISOString(), state: 'INTAKE', event: 'taken', fromFile: '0001-a.json' }) + '\n'
  );
  return taskDir;
}

test('orphanScan: a task taken off the queue whose worker died before writing state.json is recovered, not lost forever', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTakenButNeverStarted(journalRoot, 'issue-385');
  assert.equal(fs.existsSync(path.join(taskDir, 'state.json')), false, 'the fixture must have NO state.json -- that is the defect');

  const config = testConfig();
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/385#issuecomment-1') };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps);
  assert.deepEqual(recovered, [{ id: 'issue-385', reason: 'task-orphaned-before-start' }]);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'task-orphaned-before-start');
  assert.equal(state.lastState, 'INTAKE', 'the task never reached a handler -- INTAKE is where it really stopped');

  // The retry channel is what makes this a RECOVERY and not just a louder loss: unparkScan needs
  // a park-comment anchor (park-loop.js's findParkAnchor) or it skips the card on every cycle.
  const events = readJournal(taskDir);
  assert.ok(events.some((e) => e.event === 'parked' && e.reason === 'task-orphaned-before-start'));
  assert.ok(events.some((e) => e.event === 'park-comment'), 'no anchor -> unparkScan skips this card forever');
});

test('orphanScan: the never-started shape is guarded as tightly as the ordinary one -- live worker, queue entry, grace window, and a bare directory are all left alone', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');

  // 1. Owned by a live worker RIGHT NOW -- this IS the 74 ms window; reparking here would be the
  //    two-writers race the module's header forbids.
  const liveDir = seedTakenButNeverStarted(journalRoot, 'issue-live');
  // 2. Still has a queue entry (a re-enqueued retry with a taskDir from a previous run).
  const queuedDir = seedTakenButNeverStarted(journalRoot, 'issue-queued');
  fs.writeFileSync(path.join(queueDir, '0009-q.json'), JSON.stringify({ id: 'issue-queued', kind: 'card', issue: 9 }));
  // 3. Inside the grace window: a worker merely slow to boot (74 ms against a 1000 ms grace).
  const freshDir = seedTakenButNeverStarted(journalRoot, 'issue-fresh', { ageMs: 74 });
  // 4. A directory with no task.json at all -- not a claimed task, nothing to recover.
  const bareDir = path.join(journalRoot, 'issue-bare');
  fs.mkdirSync(bareDir, { recursive: true });
  // 5. The genuine control, so a scan that recovered NOTHING cannot pass this test.
  seedTakenButNeverStarted(journalRoot, 'issue-real');

  const config = testConfig(); // orphanGraceMs: 1000
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/1#issuecomment-1') };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps, new Set(['issue-live']));
  assert.deepEqual(recovered, [{ id: 'issue-real', reason: 'task-orphaned-before-start' }]);

  for (const [label, dir] of [['live', liveDir], ['queued', queuedDir], ['fresh', freshDir], ['bare', bareDir]]) {
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, `${label}: orphanScan wrote a state.json it had no business writing`);
  }
});

test('orphanScan: a shadow/dry-run start only journals the never-started orphan, never parks it', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  const taskDir = seedTakenButNeverStarted(journalRoot, 'issue-385');

  const config = testConfig({ shadowMode: true, dryRun: false, real: false });
  const recovered = await orphanScan(queueDir, journalRoot, config, { isAlive: () => false });
  assert.deepEqual(recovered, [{ id: 'issue-385', reason: 'task-orphaned-before-start', wouldRepark: true }]);

  // Nothing under taskDir touched -- a shadow park has no board move and no gh anchor, so it would
  // bury a real card under a developer's local experiment.
  assert.equal(fs.existsSync(path.join(taskDir, 'state.json')), false);
  assert.ok(readDaemonEvents(journalRoot).some((e) => e.event === 'orphan-scan-would-repark' && e.reason === 'task-orphaned-before-start'));
});

test('orphanScan: orphanGraceMs of 0 means ZERO, not the four-minute default -- SPO_ORPHAN_GRACE_MS is a live env knob', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  // Two milliseconds old: stale under a grace of 0, fresh under the 4-minute default the `||`
  // coercion used to substitute for it.
  seedTakenButNeverStarted(journalRoot, 'issue-zero', { ageMs: 2 });
  seedTask(journalRoot, 'issue-ordinary', { state: 'DIAGNOSE', updatedAt: new Date(Date.now() - 2).toISOString() });

  const config = testConfig({ orphanGraceMs: 0 });
  assert.equal(config.orphanGraceMs, 0, 'the fixture itself must carry a real 0');
  const deps = { isAlive: () => false, spawnSync: () => ok('https://github.com/x/y/issues/1#issuecomment-1') };

  const recovered = await orphanScan(queueDir, journalRoot, config, deps);
  const ids = recovered.map((r) => r.id).sort();
  assert.deepEqual(ids, ['issue-ordinary', 'issue-zero'], 'a grace of 0 was coerced back to the 4-minute default');
});
