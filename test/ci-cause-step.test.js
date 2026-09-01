'use strict';
// Action 4.3 -- classifyCiFailure(checkName, stepName) unit tests (the exact-match table), plus
// realCiChecks' new job-step lookup (steps/scripted.js) and the CI_CHECKS -> IMPLEMENT retry
// budget (state-machine.js's handleCiChecks). See ci-cause-table.js's own header for the
// measurement this whole action is built on: `checkName` alone was never enough to classify a CI
// failure -- `gh api .../check-runs` only ever reports JOB names, and the three rows this table
// has always had were written against STEP names, which live one level down at
// `gh api .../actions/jobs/<id>`'s `steps[]`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { classifyCiFailure } = require('../orchestrator/ci-cause-table');
const { realCiChecks } = require('../orchestrator/steps/scripted');
const { HANDLERS, buildCtx, snapshot } = require('../orchestrator/state-machine');
const { writeState } = require('../orchestrator/journal');
const { ParkSignal } = require('../orchestrator/park-signal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-cistep-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-cistep-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    diagnoseBudget: 3,
    validateRejectBudget: 3,
    ciRetryBudget: 3,
    ...overrides,
  };
}

function ciCtx({ config } = {}) {
  const worktreePath = mkTmp('spo-cistep-wt-');
  const task = { id: 'card-cistep', kind: 'card', issue: 900, worktreePath };
  return buildCtx('card-cistep', task, mkTmp('spo-cistep-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function readJournal(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Fakes the two-call `gh api` shape realCiChecks now makes: one fetch of
// `.../commits/<sha>/check-runs` (always returns one green decoy plus the one failing run
// described by `failingName`/`failingId`/`app`), and -- only when the failing run's
// `app.slug === 'github-actions'` and `id` is a number -- a second fetch of
// `.../actions/jobs/<id>`, answered from `jobSteps` (success shape) or `jobExit`/`jobStdout`
// (failure shape, when supplied).
function checkRunsSpawnSync({
  failingName = 'typecheck + tests',
  failingId,
  app,
  jobSteps,
  jobExit = 0,
  jobStdout,
} = {}) {
  return (command, args) => {
    if (args.includes('rev-parse')) return ok('headsha1111111111111111111111111111111\n');
    if (command === 'gh' && args[0] === 'api' && args[1].includes('check-runs')) {
      const failing = { name: failingName, conclusion: 'failure' };
      if (failingId !== undefined) failing.id = failingId;
      if (app !== undefined) failing.app = { slug: app };
      return ok(JSON.stringify({ check_runs: [{ name: 'analyze', conclusion: 'success' }, failing] }));
    }
    if (command === 'gh' && args[0] === 'api' && args[1].includes('/actions/jobs/')) {
      if (jobStdout !== undefined) return { status: jobExit, stdout: jobStdout, stderr: '', signal: null };
      return { status: jobExit, stdout: JSON.stringify({ steps: jobSteps }), stderr: '', signal: null };
    }
    return ok('');
  };
}

// ---- Part 1: classifyCiFailure(checkName, stepName) -- exact match on the STEP name ----------

test('classifyCiFailure: routes by STEP name, not check name -- Lint/Coverage of changed lines -> IMPLEMENT, PR rules (coverage ratchet, RDO citation) -> PARK, Tests -> DIAGNOSE', () => {
  assert.deepEqual(classifyCiFailure('typecheck + tests', 'Lint'), { kind: 'retry', nextState: 'IMPLEMENT' });
  assert.deepEqual(classifyCiFailure('typecheck + tests', 'Coverage of changed lines'), {
    kind: 'retry',
    nextState: 'IMPLEMENT',
  });
  assert.deepEqual(classifyCiFailure('typecheck + tests', 'PR rules (coverage ratchet, RDO citation)'), {
    kind: 'park',
    reason: 'pr-rules-needs-approval',
  });
  assert.deepEqual(classifyCiFailure('typecheck + tests', 'Tests'), { kind: 'retry', nextState: 'DIAGNOSE' });
});

// Every one of these has to be here, and each covers a DIFFERENT loose-match a maintainer might
// reach for: prefix (`startsWith`), suffix, substring (`includes`), and case folding -- against
// EACH of the three rows, not just against `Lint`. Mutation testing on 2026-08-31 proved that:
// with only the four `Lint`/`PR rules` cases this list started with, rewriting the coverage row
// to `startsWith`, `includes` or `toLowerCase()`, and the PR-rules row to `includes`, all
// survived the whole 940-test suite. C3 shipped a loose-match bug behind exactly this gap.
test('classifyCiFailure: exact match is load-bearing -- prefix, suffix, substring and case variants of ALL THREE rows fall through to DIAGNOSE (a test that only asserts the positive cases, or only varies one row, is worthless here)', () => {
  for (const stepName of [
    // Lint
    'Lint check',
    'lint',
    ' Lint',
    'Run Lint',
    'LINT',
    // Coverage of changed lines -- ci.yml step names really do get parenthesised suffixes
    // (`Typecheck (server + client)`), so a `startsWith`/`includes` row is a live risk here.
    'Coverage of changed lines (client)',
    'coverage of changed lines',
    'Check Coverage of changed lines',
    ' Coverage of changed lines',
    'Coverage of changed',
    // PR rules (coverage ratchet, RDO citation)
    'PR rules',
    'PR rules (coverage ratchet, RDO citation) [rerun]',
    'Run PR rules (coverage ratchet, RDO citation)',
    'pr rules (coverage ratchet, rdo citation)',
  ]) {
    assert.deepEqual(
      classifyCiFailure('typecheck + tests', stepName),
      { kind: 'retry', nextState: 'DIAGNOSE' },
      `expected "${stepName}" to fall through to DIAGNOSE`
    );
  }
});

test('classifyCiFailure: no step info (absent, empty, or the single-argument call shape the shadow-fixture path uses) -> DIAGNOSE for every check name', () => {
  assert.deepEqual(classifyCiFailure('Coverage of changed lines'), { kind: 'retry', nextState: 'DIAGNOSE' });
  assert.deepEqual(classifyCiFailure('Lint'), { kind: 'retry', nextState: 'DIAGNOSE' });
  assert.deepEqual(classifyCiFailure('PR rules'), { kind: 'retry', nextState: 'DIAGNOSE' });
  assert.deepEqual(classifyCiFailure('anything', ''), { kind: 'retry', nextState: 'DIAGNOSE' });
  assert.deepEqual(classifyCiFailure('anything', null), { kind: 'retry', nextState: 'DIAGNOSE' });
});

// ---- Part 2: realCiChecks' job-step lookup ----------------------------------------------------

test('realCiChecks: the job-lookup gh api call is made only when a check is failing -- a green run makes no such call', async () => {
  const ctx = ciCtx();
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('rev-parse')) return ok('headsha\n');
      if (command === 'gh' && args[0] === 'api' && args[1].includes('check-runs')) {
        // The green run carries a numeric `id` and `app.slug: github-actions`, i.e. everything
        // the lookup's own guard asks for -- so the ONLY thing that can stop the lookup here is
        // the check being green. Without those two fields this test passed for the wrong reason:
        // hoisting the lookup above the `if (failing)` branch survived the whole suite.
        return ok(
          JSON.stringify({
            check_runs: [
              { name: 'typecheck + tests', conclusion: 'success', id: 33373038192, app: { slug: 'github-actions' } },
            ],
          })
        );
      }
      return ok('');
    },
  };
  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'VALIDATE');
  assert.ok(
    !calls.some((c) => c.command === 'gh' && c.args[1] && c.args[1].includes('/actions/jobs/')),
    'no job lookup on a green run'
  );
});

test('realCiChecks: on a failing github-actions check with a numeric id, fetches the job and routes on its failing step, exact argv', async () => {
  const ctx = ciCtx();
  const jobId = 33373038192;
  const calls = [];
  const spawn = checkRunsSpawnSync({
    failingId: jobId,
    app: 'github-actions',
    jobSteps: [
      { name: 'Checkout', conclusion: 'success' },
      { name: 'Lint', conclusion: 'failure' },
      { name: 'Typecheck (server + client)', conclusion: 'skipped' },
    ],
  });
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      return spawn(command, args);
    },
  };

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'IMPLEMENT');

  const jobCall = calls.find((c) => c.command === 'gh' && c.args[1].includes('/actions/jobs/'));
  assert.deepEqual(jobCall.args, ['api', `repos/${ctx.config.ghRepo}/actions/jobs/${jobId}`]);
});

test('realCiChecks: failing.app is not "github-actions" -> no job lookup at all, routes to DIAGNOSE', async () => {
  const ctx = ciCtx();
  const calls = [];
  const spawn = checkRunsSpawnSync({ failingId: 555, app: 'some-other-bot' });
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      return spawn(command, args);
    },
  };
  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
  assert.ok(!calls.some((c) => c.command === 'gh' && c.args[1] && c.args[1].includes('/actions/jobs/')));
});

test('realCiChecks: failing.id is not a number -> no job lookup, routes to DIAGNOSE', async () => {
  const ctx = ciCtx();
  const calls = [];
  const spawn = checkRunsSpawnSync({ app: 'github-actions' }); // failingId left undefined
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      return spawn(command, args);
    },
  };
  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
  assert.ok(!calls.some((c) => c.command === 'gh' && c.args[1] && c.args[1].includes('/actions/jobs/')));
});

test('realCiChecks: job lookup non-zero exit -> journals ci-step-lookup-failed, routes to DIAGNOSE, never parks or throws', async () => {
  const ctx = ciCtx();
  const spawn = checkRunsSpawnSync({ failingId: 42, app: 'github-actions', jobExit: 1, jobStdout: '' });
  const next = await realCiChecks(ctx, { spawnSync: spawn });
  assert.equal(next, 'DIAGNOSE');
  const failedLookup = readJournal(ctx.taskDir).find((e) => e.event === 'ci-step-lookup-failed');
  assert.ok(failedLookup, 'expected ci-step-lookup-failed to be journalled');
  assert.equal(failedLookup.check, 'typecheck + tests');
  assert.equal(failedLookup.exit, 1);
});

test('realCiChecks: job lookup returns unparsable JSON -> journals ci-step-lookup-failed, routes to DIAGNOSE, never parks or throws', async () => {
  const ctx = ciCtx();
  const spawn = checkRunsSpawnSync({ failingId: 42, app: 'github-actions', jobExit: 0, jobStdout: 'not json{{{' });
  const next = await realCiChecks(ctx, { spawnSync: spawn });
  assert.equal(next, 'DIAGNOSE');
  assert.ok(readJournal(ctx.taskDir).some((e) => e.event === 'ci-step-lookup-failed'));
});

test('realCiChecks: job lookup returns JSON with no `steps` array -> journals ci-step-lookup-failed, routes to DIAGNOSE, never parks or throws', async () => {
  const ctx = ciCtx();
  const spawn = checkRunsSpawnSync({
    failingId: 42,
    app: 'github-actions',
    jobExit: 0,
    jobStdout: JSON.stringify({ ok: true }),
  });
  const next = await realCiChecks(ctx, { spawnSync: spawn });
  assert.equal(next, 'DIAGNOSE');
  assert.ok(readJournal(ctx.taskDir).some((e) => e.event === 'ci-step-lookup-failed'));
});

test('realCiChecks: job lookup succeeds but no step actually failed (every step success/skipped) -> step: null, routes to DIAGNOSE, nothing parks and no ci-step-lookup-failed (the lookup itself worked)', async () => {
  const ctx = ciCtx();
  const spawn = checkRunsSpawnSync({
    failingId: 42,
    app: 'github-actions',
    jobSteps: [
      { name: 'Checkout', conclusion: 'success' },
      { name: 'Skills manifest is current', conclusion: 'skipped' },
    ],
  });
  const next = await realCiChecks(ctx, { spawnSync: spawn });
  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(ctx.taskDir);
  const checkFailed = journal.find((e) => e.event === 'check-failed');
  assert.equal(checkFailed.step, null);
  assert.ok(!journal.some((e) => e.event === 'ci-step-lookup-failed'));
});

// CLAUDE.md: "Verdict by exit code, never by reading `gh`'s text output". A non-zero `gh api`
// still prints a body, and nothing stops that body from being well-formed -- a cached/partial
// response, a proxy's own JSON, a `gh` that wrote the job then failed on the way out. Dropping
// the `jobRes.exit !== 0` clause survived the whole suite before this test existed, because
// every other lookup-failure case here also had an unparsable body doing the work.
test('realCiChecks: job lookup exits non-zero but prints a WELL-FORMED steps body -> the exit code still wins: ci-step-lookup-failed, DIAGNOSE, the body is not trusted', async () => {
  const ctx = ciCtx();
  const spawn = checkRunsSpawnSync({
    failingId: 42,
    app: 'github-actions',
    jobExit: 1,
    jobStdout: JSON.stringify({ steps: [{ name: 'Lint', conclusion: 'failure' }] }),
  });
  const next = await realCiChecks(ctx, { spawnSync: spawn });
  assert.equal(next, 'DIAGNOSE', 'a body read behind a non-zero exit must never route the card');
  const journal = readJournal(ctx.taskDir);
  const failedLookup = journal.find((e) => e.event === 'ci-step-lookup-failed');
  assert.ok(failedLookup);
  assert.equal(failedLookup.exit, 1);
  assert.equal(journal.find((e) => e.event === 'check-failed').step, null);
});

// spawnStep is NOT a plain "return a result" call: on a spawnSync timeout it retries once and
// then THROWS ParkSignal('gh-timed-out'). A lookup whose entire purpose is to ENRICH the routing
// must never be able to park the card -- and must never be able to swallow the `check-failed`
// event, which `spo`, the dashboard and the judges all read. Before the try/catch this test
// pins, a slow GitHub API on a perfectly routable lint failure parked the card as
// `gh-timed-out` with no record of the CI failure at all.
test('realCiChecks: the job-lookup spawn TIMING OUT (spawnStep throws ParkSignal) still degrades to DIAGNOSE -- never parks, and check-failed is still journalled', async () => {
  // A config with commandTimeoutsMs is what arms spawnSync's timeout at all, and therefore the
  // only way spawnStep's retry-once-then-park branch is reachable.
  const ctx = ciCtx({ config: testConfig({ commandTimeoutsMs: { gh: 120000, git: 60000 } }) });
  let jobCalls = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse')) return ok('headsha\n');
      if (command === 'gh' && args[0] === 'api' && args[1].includes('check-runs')) {
        return ok(
          JSON.stringify({
            check_runs: [
              {
                name: 'typecheck + tests',
                conclusion: 'failure',
                status: 'completed',
                id: 33373038192,
                app: { slug: 'github-actions' },
              },
            ],
          })
        );
      }
      if (command === 'gh' && args[0] === 'api' && args[1].includes('/actions/jobs/')) {
        jobCalls += 1;
        const error = new Error('spawnSync SIGTERM ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        return { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error };
      }
      return ok('');
    },
  };

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
  assert.equal(jobCalls, 2, 'spawnStep retries a timed-out command once before it would park');

  const journal = readJournal(ctx.taskDir);
  const failedLookup = journal.find((e) => e.event === 'ci-step-lookup-failed');
  assert.ok(failedLookup, 'the degradation is journalled, not silent');
  assert.equal(failedLookup.check, 'typecheck + tests');
  assert.equal(failedLookup.exit, null);
  assert.equal(failedLookup.error, 'gh-timed-out');
  const checkFailed = journal.find((e) => e.event === 'check-failed');
  assert.ok(checkFailed, 'check-failed must survive a lookup that blew up -- everything reads it');
  assert.equal(checkFailed.step, null);
  assert.ok(!journal.some((e) => e.event === 'parked'));
});

// The FIRST failing step is the cause; every step after it is a consequence (and GitHub marks
// the rest `skipped`). Picking the last one instead routes a lint failure that also left `Tests`
// red to DIAGNOSE rather than to the IMPLEMENT retry that can actually fix it -- and that
// mutation survived the whole suite until this test, because every other fixture had exactly one
// failing step.
test('realCiChecks: with two failing steps, the FIRST is the one classified (Lint before Tests -> IMPLEMENT, not DIAGNOSE)', async () => {
  const ctx = ciCtx();
  const spawn = checkRunsSpawnSync({
    failingId: 33286934385,
    app: 'github-actions',
    jobSteps: [
      { name: 'Checkout', conclusion: 'success' },
      { name: 'Lint', conclusion: 'failure' },
      { name: 'Tests', conclusion: 'failure' },
      { name: 'Coverage of changed lines', conclusion: 'skipped' },
    ],
  });
  const next = await realCiChecks(ctx, { spawnSync: spawn });
  assert.equal(next, 'IMPLEMENT');
  assert.equal(readJournal(ctx.taskDir).find((e) => e.event === 'check-failed').step, 'Lint');
});

test('realCiChecks: check-failed carries check, step and jobId', async () => {
  const ctx = ciCtx();
  const jobId = 33278461271;
  const spawn = checkRunsSpawnSync({
    failingId: jobId,
    app: 'github-actions',
    jobSteps: [{ name: 'Coverage of changed lines', conclusion: 'failure' }],
  });
  const next = await realCiChecks(ctx, { spawnSync: spawn });
  assert.equal(next, 'IMPLEMENT');
  const checkFailed = readJournal(ctx.taskDir).find((e) => e.event === 'check-failed');
  assert.equal(checkFailed.check, 'typecheck + tests');
  assert.equal(checkFailed.step, 'Coverage of changed lines');
  assert.equal(checkFailed.jobId, jobId);
});

// ---- Part 3: the CI_CHECKS -> IMPLEMENT retry budget (state-machine.js's handleCiChecks) ------

test('handleCiChecks: three consecutive CI-driven IMPLEMENT routings journal ci-implement-retry with attempt 1..3 and return IMPLEMENT; the fourth parks ci-retry-budget-exhausted AND still journals its ledger line', async () => {
  const jobId = 33248044255;
  const ctx = ciCtx({ config: testConfig({ ciRetryBudget: 3 }) });
  ctx.deps = {
    spawnSync: checkRunsSpawnSync({
      failingId: jobId,
      app: 'github-actions',
      jobSteps: [{ name: 'Lint', conclusion: 'failure' }],
    }),
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const next = await HANDLERS.CI_CHECKS(ctx);
    assert.equal(next, 'IMPLEMENT');
    assert.equal(ctx.counters.ciImplementRetries, attempt);
  }

  await assert.rejects(
    () => HANDLERS.CI_CHECKS(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'ci-retry-budget-exhausted'
  );
  assert.equal(ctx.counters.ciImplementRetries, 4);

  const retryEvents = readJournal(ctx.taskDir).filter((e) => e.event === 'ci-implement-retry');
  assert.equal(retryEvents.length, 4, 'expected a ledger line for every attempt, including the one that trips the budget');
  assert.deepEqual(retryEvents.map((e) => e.attempt), [1, 2, 3, 4]);
  for (const e of retryEvents) {
    assert.equal(e.check, 'typecheck + tests');
    assert.equal(e.step, 'Lint');
  }

  // The counter must reach snapshot()/state.json, same as diagnoseAttempts/validateRejects.
  writeState(ctx.taskDir, snapshot(ctx, 'PARKED'));
  const state = JSON.parse(fs.readFileSync(path.join(ctx.taskDir, 'state.json'), 'utf8'));
  assert.equal(state.ciImplementRetries, 4);
});

// A different budget than the suite's default 3, so the comparison is provably read from
// ctx.config and not hardcoded: replacing `attempt > ctx.config.ciRetryBudget` with `attempt > 3`
// survived the whole suite before this test existed.
test('handleCiChecks: the budget comes from ctx.config.ciRetryBudget -- with 1, the first retry is allowed and the SECOND parks', async () => {
  const ctx = ciCtx({ config: testConfig({ ciRetryBudget: 1 }) });
  ctx.deps = {
    spawnSync: checkRunsSpawnSync({
      failingId: 33216988010,
      app: 'github-actions',
      jobSteps: [{ name: 'Coverage of changed lines', conclusion: 'failure' }],
    }),
  };

  assert.equal(await HANDLERS.CI_CHECKS(ctx), 'IMPLEMENT');
  await assert.rejects(
    () => HANDLERS.CI_CHECKS(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'ci-retry-budget-exhausted' && err.detail.attempts === 2
  );
  assert.equal(readJournal(ctx.taskDir).filter((e) => e.event === 'ci-implement-retry').length, 2);
});

// chargeCiImplementRetry reads `check`/`step` back out of the journal rather than receiving them
// as values -- so the one thing that can go wrong is reading a STALE `check-failed` from an
// EARLIER visit to CI_CHECKS (the state is re-entered after every IMPLEMENT -> CHECK -> PUSH_PR
// -> GATE loop, so the journal holds several). Two visits with DIFFERENT failing steps is the
// only shape that can tell "last" from "first": with identical steps on every visit, reading the
// first survived the whole suite.
test('handleCiChecks: each ci-implement-retry line carries ITS OWN visit\'s check/step, never a stale earlier one', async () => {
  const ctx = ciCtx();
  const steps = [
    [{ name: 'Lint', conclusion: 'failure' }],
    [{ name: 'Coverage of changed lines', conclusion: 'failure' }],
  ];
  let visit = 0;
  ctx.deps = {
    spawnSync: (command, args) => {
      const spawn = checkRunsSpawnSync({
        failingId: 33253561998,
        app: 'github-actions',
        jobSteps: steps[Math.min(visit, steps.length - 1)],
      });
      return spawn(command, args);
    },
  };

  assert.equal(await HANDLERS.CI_CHECKS(ctx), 'IMPLEMENT');
  visit = 1;
  assert.equal(await HANDLERS.CI_CHECKS(ctx), 'IMPLEMENT');

  const retries = readJournal(ctx.taskDir).filter((e) => e.event === 'ci-implement-retry');
  assert.deepEqual(
    retries.map((e) => [e.attempt, e.step]),
    [
      [1, 'Lint'],
      [2, 'Coverage of changed lines'],
    ]
  );
});

// The main-moved re-merge path (CI_CHECKS -> CHECK) is the one non-IMPLEMENT outcome the spec
// singles out as "must keep working exactly as it does now". Driven through the shadow fixture
// because the real path's CHECK route needs a bench verdict file and overlapping git diffs;
// chargeCiImplementRetry is the same shared code either way. Charging CHECK as if it were a CI
// retry survived the whole suite before this assertion existed.
test('handleCiChecks: the main-moved merge path (-> CHECK) is not a CI retry and never charges the budget', async () => {
  const taskDir = mkTmp('spo-cistep-mainmoved-');
  const task = { id: 'card-mainmoved', kind: 'synthetic', shadow: { mainMoved: true } };
  const ctx = buildCtx('card-mainmoved', task, taskDir, { shadowMode: true, dryRun: false, ...testConfig() });

  assert.equal(await HANDLERS.CI_CHECKS(ctx), 'CHECK');
  assert.equal(ctx.counters.mainMoveUsed, true);
  assert.equal(ctx.counters.ciImplementRetries, 0);
  assert.ok(!readJournal(taskDir).some((e) => e.event === 'ci-implement-retry'));
});

// CHECK has its own test above (it needs the shadow path to reach the main-moved branch) -- this
// one is the other two. The title used to claim all three while only exercising two.
test('handleCiChecks: a VALIDATE or DIAGNOSE outcome never touches ciImplementRetries', async () => {
  const ctx = ciCtx();

  // Green run -> VALIDATE.
  ctx.deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse')) return ok('headsha\n');
      if (command === 'gh' && args[0] === 'api' && args[1].includes('check-runs')) {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      return ok('');
    },
  };
  assert.equal(await HANDLERS.CI_CHECKS(ctx), 'VALIDATE');
  assert.equal(ctx.counters.ciImplementRetries, 0);

  // Unrecognized step -> DIAGNOSE.
  ctx.deps = {
    spawnSync: checkRunsSpawnSync({
      failingId: 33216988010,
      app: 'github-actions',
      jobSteps: [{ name: 'Tests', conclusion: 'failure' }],
    }),
  };
  assert.equal(await HANDLERS.CI_CHECKS(ctx), 'DIAGNOSE');
  assert.equal(ctx.counters.ciImplementRetries, 0);
});
