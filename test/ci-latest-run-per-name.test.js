'use strict';
// SPO-Pipeline#304 -- CI_CHECKS reads one check-run per name (steps/scripted.js's
// latestRunPerName, called by pollCheckRunsUntilConcluded on every fetch). `.../check-runs` drops
// older attempts only inside one check suite, and a PR re-push leaves an older, cancelled run of
// the same check in another suite (5 of the 65 most recent pipeline PRs, measured 2026-09-28), so
// the head sha lists a `cancelled` and a newer `success` `typecheck + tests` from two suites.
// Classifying the cancelled one parked SPO-WebClient#1038, #1044 and #1073 on a green PR. Every
// `gh`/`git` call here is a stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js; must land before the orchestrator requires below.
require('./no-real-spawn');
const { realCiChecks, latestRunPerName } = require('../orchestrator/steps/scripted');
const { buildCtx } = require('../orchestrator/state-machine');
const { mkTmp } = require('./helpers');

const HEAD = 'f1cc8ef000000000000000000000000000000000';
// SPO-WebClient#1038's head sha, measured: the `opened` run's job, cancelled after one second,
// and the `edited` run's job, green -- two check suites.
const CANCELLED_JOB = 108738742005;
const GREEN_JOB = 108738746737;

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-latestrun-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-latestrun-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    diagnoseBudget: 3,
    validateRejectBudget: 3,
    ciRetryBudget: 3,
    mainMovedRegateBudget: 1,
    ...overrides,
  };
}

function ciCtx() {
  const task = { id: 'card-latestrun', kind: 'card', issue: 1038, worktreePath: mkTmp('spo-latestrun-wt-') };
  return buildCtx('card-latestrun', task, mkTmp('spo-latestrun-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    ...testConfig(),
  });
}

function readJournal(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A raw `check_runs[]` element, as `gh api .../check-runs` returns it.
function apiRun(name, conclusion, id, startedAt, { status = 'completed', suite } = {}) {
  return { name, conclusion, status, id, started_at: startedAt, check_suite: { id: suite }, app: { slug: 'github-actions' } };
}

// `checkRuns` is the sequence of `.../check-runs` answers (the last one repeats); a job lookup is
// answered with `steps`. Records every call and every sleep.
function fakeWorld({ checkRuns, steps = [] }) {
  const calls = [];
  const sleeps = [];
  let fetches = 0;
  const ok = (stdout) => ({ status: 0, stdout, stderr: '', signal: null });
  const spawnSync = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'git' && args.includes('rev-parse')) return ok(`${HEAD}\n`);
    if (command === 'gh' && args[0] === 'api' && args[1].endsWith('/check-runs')) {
      const answer = checkRuns[Math.min(fetches, checkRuns.length - 1)];
      fetches += 1;
      return ok(JSON.stringify({ check_runs: answer }));
    }
    if (command === 'gh' && args[0] === 'api' && /\/actions\/jobs\/\d+$/.test(args[1])) {
      return ok(JSON.stringify({ steps }));
    }
    return ok('');
  };
  const jobLookups = () => calls.filter((c) => c.command === 'gh' && c.args[1].includes('/actions/jobs/'));
  return { deps: { spawnSync, sleep: async (ms) => sleeps.push(ms) }, calls, sleeps, jobLookups };
}

// ---- latestRunPerName (pure) ----------------------------------------------------------------

const r = (name, conclusion, id, startedAt) => ({ name, conclusion, status: 'completed', id, startedAt });

test('latestRunPerName: an older cancelled and a newer success of one name -> only the success, wherever each sits in the list', () => {
  const cancelled = r('typecheck + tests', 'cancelled', CANCELLED_JOB, '2026-09-28T00:11:09Z');
  const green = r('typecheck + tests', 'success', GREEN_JOB, '2026-09-28T00:11:14Z');
  assert.deepEqual(latestRunPerName([cancelled, green]), [green]);
  assert.deepEqual(latestRunPerName([green, cancelled]), [green]);
});

test('latestRunPerName: an older success and a newer failure (or cancelled) -> the newer failing run, never the success', () => {
  const green = r('typecheck + tests', 'success', 900, '2026-09-28T01:00:00Z');
  const failure = r('typecheck + tests', 'failure', 800, '2026-09-28T02:00:00Z');
  const cancelled = r('typecheck + tests', 'cancelled', 700, '2026-09-28T02:00:00Z');
  // The ids run AGAINST the times here, so only `startedAt` can pick the failing run.
  assert.deepEqual(latestRunPerName([green, failure]), [failure]);
  assert.deepEqual(latestRunPerName([failure, green]), [failure]);
  assert.deepEqual(latestRunPerName([green, cancelled]), [cancelled]);
});

test('latestRunPerName: equal startedAt -> the higher id, in either order', () => {
  const low = r('typecheck + tests', 'cancelled', 10, '2026-09-28T01:00:22Z');
  const high = r('typecheck + tests', 'success', 11, '2026-09-28T01:00:22Z');
  assert.deepEqual(latestRunPerName([low, high]), [high]);
  assert.deepEqual(latestRunPerName([high, low]), [high]);
});

test('latestRunPerName: a missing startedAt on either side -> the id decides', () => {
  const noTimeHigh = r('typecheck + tests', 'success', 20, undefined);
  const timedLow = r('typecheck + tests', 'cancelled', 19, '2026-09-28T05:20:56Z');
  assert.deepEqual(latestRunPerName([timedLow, noTimeHigh]), [noTimeHigh]);
  assert.deepEqual(latestRunPerName([noTimeHigh, timedLow]), [noTimeHigh]);
  const bothMissingLow = r('typecheck + tests', 'failure', 5, null);
  const bothMissingHigh = r('typecheck + tests', 'success', 6, null);
  assert.deepEqual(latestRunPerName([bothMissingHigh, bothMissingLow]), [bothMissingHigh]);
  // A later time on the LOWER id still loses when the other side has no time at all.
  const timedLater = r('typecheck + tests', 'cancelled', 5, '2099-01-01T00:00:00Z');
  assert.deepEqual(latestRunPerName([timedLater, noTimeHigh]), [noTimeHigh]);
});

test('latestRunPerName: timed and untimed runs mixed under one name -> the highest id, whatever the input order (a pairwise time-else-id comparison is not transitive here)', () => {
  const a = r('typecheck + tests', 'failure', 1, '2026-09-28T00:00:10Z');
  const b = r('typecheck + tests', 'cancelled', 2, null);
  const c = r('typecheck + tests', 'success', 3, '2026-09-28T00:00:05Z');
  const orders = [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];
  for (const order of orders) {
    assert.deepEqual(latestRunPerName(order), [c], order.map((x) => x.id).join(','));
  }
});

test('latestRunPerName: different names are all kept, in the order of each name\'s first run; the input is not mutated', () => {
  const analyze = r('analyze', 'success', 1, '2026-09-28T00:11:00Z');
  const oldTests = r('typecheck + tests', 'cancelled', 2, '2026-09-28T00:11:09Z');
  const review = r('claude review', 'success', 3, '2026-09-28T00:11:10Z');
  const newTests = r('typecheck + tests', 'success', 4, '2026-09-28T00:11:14Z');
  const input = [analyze, oldTests, review, newTests];
  const copy = [...input];
  assert.deepEqual(latestRunPerName(input), [analyze, newTests, review]);
  assert.deepEqual(input, copy);
  assert.deepEqual(latestRunPerName([]), []);
});

// ---- realCiChecks on the grouped list ------------------------------------------------------

test('realCiChecks: the measured shape (cancelled then success on `typecheck + tests`, two suites) -> checks-green, no check-failed, no job lookup, VALIDATE', async () => {
  const ctx = ciCtx();
  // The cancelled run is listed FIRST, so without the grouping `checks.find` lands on it.
  const w = fakeWorld({
    checkRuns: [
      [
        apiRun('typecheck + tests', 'cancelled', CANCELLED_JOB, '2026-09-28T00:11:09Z', { suite: 1 }),
        apiRun('analyze', 'success', 108738742001, '2026-09-28T00:11:08Z', { suite: 1 }),
        apiRun('typecheck + tests', 'success', GREEN_JOB, '2026-09-28T00:11:14Z', { suite: 2 }),
      ],
    ],
    steps: [{ name: 'Set up job', conclusion: 'success' }],
  });

  assert.equal(await realCiChecks(ctx, w.deps), 'VALIDATE');

  const journal = readJournal(ctx.taskDir);
  const green = journal.filter((e) => e.event === 'checks-green');
  assert.equal(green.length, 1);
  assert.deepEqual(
    green[0].checks.map((c) => [c.name, c.id, c.conclusion]),
    [
      ['typecheck + tests', GREEN_JOB, 'success'],
      ['analyze', 108738742001, 'success'],
    ]
  );
  assert.equal(journal.filter((e) => e.event === 'check-failed').length, 0);
  assert.equal(w.jobLookups().length, 0, 'no job lookup on a green sha');
});

// Every other realCiChecks case here has its ids in time order, so dropping `started_at` from
// fetchCheckRuns' mapping left them all green: here only the API's `started_at` can pick the run.
test('realCiChecks: the API\'s started_at decides even when the ids run against it -> checks-green on the later success, VALIDATE', async () => {
  const ctx = ciCtx();
  const w = fakeWorld({
    checkRuns: [
      [
        apiRun('typecheck + tests', 'success', 100, '2026-09-28T00:11:14Z', { suite: 2 }),
        apiRun('typecheck + tests', 'cancelled', 200, '2026-09-28T00:11:09Z', { suite: 1 }),
      ],
    ],
  });

  assert.equal(await realCiChecks(ctx, w.deps), 'VALIDATE');

  const journal = readJournal(ctx.taskDir);
  const green = journal.find((e) => e.event === 'checks-green');
  assert.deepEqual(
    green.checks.map((c) => [c.id, c.startedAt]),
    [[100, '2026-09-28T00:11:14Z']]
  );
  assert.equal(journal.filter((e) => e.event === 'check-failed').length, 0);
  assert.equal(w.jobLookups().length, 0);
});

test('realCiChecks: success (older) then failure (newer) on one name still routes on the failing job', async () => {
  const ctx = ciCtx();
  const FAILING_JOB = 108747522681;
  const w = fakeWorld({
    checkRuns: [
      [
        apiRun('typecheck + tests', 'success', 108747518815, '2026-09-28T01:00:22Z', { suite: 1 }),
        apiRun('typecheck + tests', 'failure', FAILING_JOB, '2026-09-28T01:00:24Z', { suite: 2 }),
      ],
    ],
    steps: [
      { name: 'Checkout', conclusion: 'success' },
      { name: 'Lint', conclusion: 'failure' },
    ],
  });

  assert.equal(await realCiChecks(ctx, w.deps), 'IMPLEMENT');

  const lookups = w.jobLookups();
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].args, ['api', `repos/${ctx.config.ghRepo}/actions/jobs/${FAILING_JOB}`]);
  const failed = readJournal(ctx.taskDir).filter((e) => e.event === 'check-failed');
  assert.deepEqual(
    failed.map((e) => [e.check, e.step, e.jobId]),
    [['typecheck + tests', 'Lint', FAILING_JOB]]
  );
});

test('realCiChecks: cancelled (older, completed) then the same name newer and in_progress -> checks-in-flight, then green on the next poll -> VALIDATE', async () => {
  const ctx = ciCtx();
  const cancelled = apiRun('typecheck + tests', 'cancelled', CANCELLED_JOB, '2026-09-28T00:11:09Z', { suite: 1 });
  const w = fakeWorld({
    checkRuns: [
      [
        cancelled,
        apiRun('typecheck + tests', null, GREEN_JOB, '2026-09-28T00:11:14Z', { status: 'in_progress', suite: 2 }),
      ],
      [cancelled, apiRun('typecheck + tests', 'success', GREEN_JOB, '2026-09-28T00:11:14Z', { suite: 2 })],
    ],
  });

  assert.equal(await realCiChecks(ctx, w.deps), 'VALIDATE');

  const journal = readJournal(ctx.taskDir);
  const inFlight = journal.filter((e) => e.event === 'checks-in-flight');
  assert.deepEqual(
    inFlight.map((e) => [e.attempt, e.totalRuns, e.pendingRuns]),
    [[1, 1, 1]]
  );
  assert.equal(w.sleeps.length, 1);
  assert.equal(journal.filter((e) => e.event === 'checks-green').length, 1);
  assert.equal(journal.filter((e) => e.event === 'check-failed').length, 0);
  assert.equal(w.jobLookups().length, 0);
});

test('realCiChecks: a lone cancelled run, no newer run of its name -> today\'s failing route (job lookup, check-failed, DIAGNOSE)', async () => {
  const ctx = ciCtx();
  const w = fakeWorld({
    checkRuns: [
      [
        apiRun('analyze', 'success', 108738742001, '2026-09-28T00:11:08Z', { suite: 1 }),
        apiRun('typecheck + tests', 'cancelled', CANCELLED_JOB, '2026-09-28T00:11:09Z', { suite: 1 }),
      ],
    ],
    steps: [{ name: 'Set up job', conclusion: 'success' }],
  });

  assert.equal(await realCiChecks(ctx, w.deps), 'DIAGNOSE');

  assert.equal(w.jobLookups().length, 1);
  const journal = readJournal(ctx.taskDir);
  assert.deepEqual(
    journal.filter((e) => e.event === 'check-failed').map((e) => [e.check, e.step, e.jobId]),
    [['typecheck + tests', null, CANCELLED_JOB]]
  );
  assert.equal(journal.filter((e) => e.event === 'checks-green').length, 0);
});
