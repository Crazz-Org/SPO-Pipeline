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
      mainMoveUsed: true,
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
  assert.equal(state.mainMoveUsed, true);
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
