'use strict';
// Tests for orchestrator/orphan-scan.js: the daemon-restart recovery path for a task whose
// owning process died mid-run -- see the module's own header and doc/state-machine-spec.md's
// note on card #385 for the incident this replaces a manual fix for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { shouldScanOrphans, orphanScan } = require('../orchestrator/orphan-scan');
const { unparkScan } = require('../orchestrator/park-loop');
const { appendEvent, writeState } = require('../orchestrator/journal');

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

test('orphanScan -> unparkScan: a maintainer retry on the reparked issue re-enqueues it (the full loop #385 needed by hand)', async () => {
  const journalRoot = mkTmp('spo-orphan-journal-');
  const queueDir = mkTmp('spo-orphan-queue-');
  seedTask(journalRoot, 'issue-385', { state: 'DIAGNOSE' });

  const config = testConfig();
  const deps = {
    isAlive: () => false,
    spawnSync: (cmd, args) => {
      if (args.includes('comment')) return ok('https://github.com/x/y/issues/385#issuecomment-100');
      if (args[0] === 'api') return ok(JSON.stringify([{ id: 101, body: 'retry' }]));
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

  const daemonEvents = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(daemonEvents.some((e) => e.event === 'orphan-scan-unknown-owner' && e.id === 'issue-3'));
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
