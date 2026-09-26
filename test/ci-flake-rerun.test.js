'use strict';
// SPO-Pipeline#290 -- the CI_CHECKS flake re-run (steps/scripted.js's rerunCiFlakeIfEligible,
// pollCheckRunsUntilConcluded and parseJestFailingFiles). On a pull request SPO-WebClient's ci.yml
// runs the whole Jest suite inside `Coverage of changed lines`, so one flaky test anywhere fails
// that step and ci-cause-table.js sends a gate-green card to IMPLEMENT, then DIAGNOSE, then a
// plan-invalidating park. The rule under test re-runs the failed job ONCE when every failing test
// file is outside the branch diff and the bench verdict for the sha is PASS; anything else is
// today's route. Every `gh`/`git` call here is a stub -- no real `gh api .../rerun` is ever made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js; must land before the orchestrator requires below.
require('./no-real-spawn');
const { realCiChecks, parseJestFailingFiles } = require('../orchestrator/steps/scripted');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');
const { ParkSignal } = require('../orchestrator/park-signal');
const { mkTmp } = require('./helpers');

const HEAD = 'a11ce0000000000000000000000000000000beef';
const OLD_JOB = 108310011696; // attempt 1's `typecheck + tests` on SPO-WebClient run 36208496064
const NEW_JOB = 108351782638; // attempt 2's, after the re-run -- a NEW id, measured
const REPO = 'Crazz-Org/SPO-WebClient';

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-flake-worktrees-'),
    ghRepo: REPO,
    spoBenchDir: mkTmp('spo-flake-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 5,
    ciChecksPollIntervalMs: 1000,
    diagnoseBudget: 3,
    validateRejectBudget: 3,
    ciRetryBudget: 3,
    mainMovedRegateBudget: 1,
    ...overrides,
  };
}

function flakeCtx({ config, taskDir, worktreePath } = {}) {
  const cfg = config || testConfig();
  const task = { id: 'card-flake', kind: 'card', issue: 934, worktreePath: worktreePath || mkTmp('spo-flake-wt-') };
  return buildCtx('card-flake', task, taskDir || mkTmp('spo-flake-taskdir-'), { shadowMode: false, dryRun: false, ...cfg });
}

function writeVerdict(config, sha, verdict) {
  const dir = path.join(config.spoBenchDir, 'verdicts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha}.json`), JSON.stringify({ head: sha, verdict }));
}

function readJournal(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Trimmed from job 108310011696's real log (SPO-WebClient#934): timestamps, the ANSI-coloured
// code frame, the per-suite PASS lines, and the summary block the rule reads.
function jestLog(failingFiles) {
  const ts = '2026-09-26T01:30:24.2980224Z ';
  const lines = [
    'PASS unit src/client/minister-account.test.ts',
    '  isMinisterAccount',
    '',
    'Summary of all failing tests',
  ];
  for (const f of failingFiles) {
    lines.push(`FAIL ${f} (5.912 s)`);
    lines.push('  ● stage 1 — static › exits 1 and stops at the first failing stage (typecheck)');
    lines.push('');
    lines.push("    ENOENT, No such file or directory '/tmp/spo-gate-repo-1yjNos/.git/objects'");
    lines.push('    \u001b[31m\u001b[1m>\u001b[22m\u001b[39m\u001b[90m 127 |\u001b[39m   fs.cpSync(template, dir, { recursive: true });');
    lines.push('');
  }
  lines.push(`Test Suites: ${failingFiles.length} failed, 2 skipped, 589 passed, 590 of 592 total`);
  lines.push('Tests:       1 failed, 145 skipped, 11634 passed, 11780 total');
  lines.push('jest exited with 1; the suite is not green.');
  return lines.map((l) => ts + l).join('\n') + '\n';
}

function run(name, conclusion, id, status = 'completed') {
  return { name, conclusion, status, id, app: { slug: 'github-actions' } };
}

const RED = (id = OLD_JOB) => [run('analyze', 'success', 1), run('typecheck + tests', 'failure', id)];
const GREEN = (id = NEW_JOB) => [run('analyze', 'success', 1), run('typecheck + tests', 'success', id)];
const QUEUED = (id = NEW_JOB) => [run('analyze', 'success', 1), run('typecheck + tests', null, id, 'queued')];

// One scripted GitHub + git. `checkRuns` is the sequence of `.../check-runs` answers (the last one
// repeats); every other answer is configurable per test. Records every call and every sleep.
function fakeWorld({
  checkRuns,
  steps = [{ name: 'Checkout', conclusion: 'success' }, { name: 'Coverage of changed lines', conclusion: 'failure' }],
  log = { status: 0, stdout: jestLog(['src/e2e/verify-gate.test.ts']) },
  diff = { status: 0, stdout: 'src/e2e/bench/worker.test.ts\n' },
  rerun = { status: 0, stdout: '' },
} = {}) {
  const calls = [];
  const sleeps = [];
  let fetches = 0;
  const reply = (r) => {
    if (r instanceof Error) throw r;
    return { status: r.status, stdout: r.stdout || '', stderr: '', signal: null };
  };
  const spawnSync = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'git' && args.includes('rev-parse')) return reply({ status: 0, stdout: `${HEAD}\n` });
    if (command === 'git' && args.includes('diff') && args.includes('origin/main...HEAD')) return reply(diff);
    if (command === 'gh' && args[0] === 'api') {
      const p = args[1];
      if (p.endsWith('/check-runs')) {
        const answer = checkRuns[Math.min(fetches, checkRuns.length - 1)];
        fetches += 1;
        return reply({ status: 0, stdout: JSON.stringify({ check_runs: answer }) });
      }
      if (/\/actions\/jobs\/\d+\/logs$/.test(p)) return reply(log);
      if (/\/actions\/jobs\/\d+\/rerun$/.test(p)) return reply(rerun);
      if (/\/actions\/jobs\/\d+$/.test(p)) return reply({ status: 0, stdout: JSON.stringify({ steps }) });
    }
    return reply({ status: 0, stdout: '' });
  };
  const deps = { spawnSync, sleep: async (ms) => sleeps.push(ms) };
  const ghCalls = (suffix) => calls.filter((c) => c.command === 'gh' && c.args[1].endsWith(suffix));
  return { deps, calls, sleeps, ghCalls };
}

// ---- parseJestFailingFiles ------------------------------------------------------------------

test('parseJestFailingFiles: reads the FAIL paths under the summary of a real-shaped log -- timestamps, durations and ANSI stripped', () => {
  assert.deepEqual(parseJestFailingFiles(jestLog(['src/e2e/verify-gate.test.ts'])), ['src/e2e/verify-gate.test.ts']);
  assert.deepEqual(
    parseJestFailingFiles(jestLog(['src/e2e/bench/worker.test.ts', 'src/shared/a.test.ts'])),
    ['src/e2e/bench/worker.test.ts', 'src/shared/a.test.ts']
  );
});

test('parseJestFailingFiles: a project display name before the path is skipped; duplicates collapse; bare FAIL with no duration still parses', () => {
  const log = [
    'Summary of all failing tests',
    'FAIL unit src/a.test.ts (1.2 s)',
    'FAIL \u001b[1msrc/b.test.ts\u001b[22m',
    'FAIL unit src/a.test.ts (1.2 s)',
    'Test Suites: 2 failed, 3 total',
  ].join('\n');
  assert.deepEqual(parseJestFailingFiles(log), ['src/a.test.ts', 'src/b.test.ts']);
});

test('parseJestFailingFiles: FAIL lines outside the summary (the per-suite progress output, or after "Test Suites:") are not read', () => {
  const log = [
    'FAIL src/progress-only.test.ts (2 s)',
    'Summary of all failing tests',
    'FAIL src/real.test.ts (2 s)',
    'Test Suites: 1 failed, 3 total',
    'FAIL src/after-summary.test.ts',
  ].join('\n');
  assert.deepEqual(parseJestFailingFiles(log), ['src/real.test.ts']);
});

test('parseJestFailingFiles: no summary, an empty log, or a non-string -> no files', () => {
  assert.deepEqual(parseJestFailingFiles('FAIL src/x.test.ts\nTests: 1 failed'), []);
  assert.deepEqual(parseJestFailingFiles(''), []);
  assert.deepEqual(parseJestFailingFiles(undefined), []);
  assert.deepEqual(parseJestFailingFiles('Summary of all failing tests\nTest Suites: 0 failed'), []);
});

// ---- the rule fires -------------------------------------------------------------------------

test('flake outside the diff on a bench-PASS sha: re-runs the job once (exact argv), journals ci-flake-rerun, polls again on the SAME budget, and a green re-run goes on to VALIDATE', async () => {
  const ctx = flakeCtx();
  writeVerdict(ctx.config, HEAD, 'PASS');
  // First pass: red at poll 1. Second pass: GitHub has not registered attempt 2 yet (the old,
  // failed job id is still listed) -> in flight, then the new attempt queued, then green.
  const w = fakeWorld({ checkRuns: [RED(), RED(), QUEUED(), GREEN()] });

  assert.equal(await realCiChecks(ctx, w.deps), 'VALIDATE');

  assert.deepEqual(w.ghCalls('/logs').map((c) => c.args), [['api', `repos/${REPO}/actions/jobs/${OLD_JOB}/logs`]]);
  assert.deepEqual(w.ghCalls('/rerun').map((c) => c.args), [['api', `repos/${REPO}/actions/jobs/${OLD_JOB}/rerun`, '-X', 'POST']]);

  const journal = readJournal(ctx.taskDir);
  const reruns = journal.filter((e) => e.event === 'ci-flake-rerun');
  assert.equal(reruns.length, 1);
  assert.equal(reruns[0].state, 'CI_CHECKS');
  assert.equal(reruns[0].headSha, HEAD);
  assert.equal(reruns[0].jobId, OLD_JOB);
  assert.equal(reruns[0].check, 'typecheck + tests');
  assert.equal(reruns[0].step, 'Coverage of changed lines');
  assert.deepEqual(reruns[0].failingFiles, ['src/e2e/verify-gate.test.ts']);
  assert.ok(!journal.some((e) => e.event === 'ci-flake-rerun-skipped'));

  // The re-run's wait continues the first pass's attempt count (1 used, then 2, 3 in flight, 4
  // green) rather than starting a fresh budget -- the CI_CHECKS deadline is sized for one.
  assert.deepEqual(journal.filter((e) => e.event === 'checks-in-flight').map((e) => e.attempt), [2, 3]);
  assert.equal(w.sleeps.length, 2);
  assert.ok(journal.some((e) => e.event === 'checks-green'));
});

test('the rerun decision is made after check-failed is journalled, and the rerun POST comes after the log and the diff', async () => {
  const ctx = flakeCtx();
  writeVerdict(ctx.config, HEAD, 'PASS');
  const w = fakeWorld({ checkRuns: [RED(), GREEN()] });
  assert.equal(await realCiChecks(ctx, w.deps), 'VALIDATE');
  const order = w.calls
    .map((c) => (c.command === 'git' && c.args.includes('origin/main...HEAD') ? 'diff' : c.args[1] && c.args[1].split('/').pop()))
    .filter((x) => ['logs', 'diff', 'rerun'].includes(x));
  assert.deepEqual(order, ['logs', 'diff', 'rerun']);
  const events = readJournal(ctx.taskDir).map((e) => e.event);
  assert.ok(events.indexOf('check-failed') < events.indexOf('ci-flake-rerun'));
});

test('a red re-run takes today\'s route: IMPLEMENT, only ONE rerun POST, the second failure journalled as check-failed + ci-flake-rerun-skipped(already-rerun)', async () => {
  const ctx = flakeCtx();
  writeVerdict(ctx.config, HEAD, 'PASS');
  const w = fakeWorld({ checkRuns: [RED(OLD_JOB), RED(NEW_JOB)] });

  assert.equal(await realCiChecks(ctx, w.deps), 'IMPLEMENT');

  assert.equal(w.ghCalls('/rerun').length, 1);
  const journal = readJournal(ctx.taskDir);
  const failed = journal.filter((e) => e.event === 'check-failed');
  assert.deepEqual(failed.map((e) => e.jobId), [OLD_JOB, NEW_JOB]);
  const skipped = journal.filter((e) => e.event === 'ci-flake-rerun-skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'already-rerun');
  assert.equal(skipped[0].jobId, NEW_JOB);
  // Only the first failure's log was downloaded: the one-per-sha check runs before any fetch.
  assert.equal(w.ghCalls('/logs').length, 1);
});

test('through handleCiChecks: a green re-run never charges the CI->IMPLEMENT retry budget; a red one charges exactly one, on the second failure\'s step', async () => {
  const green = flakeCtx();
  writeVerdict(green.config, HEAD, 'PASS');
  green.deps = fakeWorld({ checkRuns: [RED(), GREEN()] }).deps;
  assert.equal(await HANDLERS.CI_CHECKS(green), 'VALIDATE');
  assert.equal(green.counters.ciImplementRetries, 0);

  const red = flakeCtx();
  writeVerdict(red.config, HEAD, 'PASS');
  red.deps = fakeWorld({ checkRuns: [RED(OLD_JOB), RED(NEW_JOB)] }).deps;
  assert.equal(await HANDLERS.CI_CHECKS(red), 'IMPLEMENT');
  assert.equal(red.counters.ciImplementRetries, 1);
  const retry = readJournal(red.taskDir).filter((e) => e.event === 'ci-implement-retry');
  assert.equal(retry.length, 1);
  assert.equal(retry[0].step, 'Coverage of changed lines');
});

// ---- one per sha, across a restart ----------------------------------------------------------

test('daemon restart: a fresh process on the same taskDir and sha finds the journalled ci-flake-rerun and does NOT re-run a second time', async () => {
  const config = testConfig();
  const taskDir = mkTmp('spo-flake-restart-');
  const worktreePath = mkTmp('spo-flake-wt-');
  writeVerdict(config, HEAD, 'PASS');

  // Process 1: fires, then "dies" while the re-run is still queued (the poll budget ends there).
  const first = flakeCtx({ config: { ...config, ciChecksMaxPolls: 2 }, taskDir, worktreePath });
  const w1 = fakeWorld({ checkRuns: [RED(OLD_JOB), QUEUED()] });
  await assert.rejects(
    () => realCiChecks(first, w1.deps),
    (err) => err instanceof ParkSignal && err.reason === 'ci-checks-still-running'
  );
  assert.equal(w1.ghCalls('/rerun').length, 1);

  // Process 2: new ctx, same journal. The re-run came back red.
  const second = flakeCtx({ config, taskDir, worktreePath });
  const w2 = fakeWorld({ checkRuns: [RED(NEW_JOB)] });
  assert.equal(await realCiChecks(second, w2.deps), 'IMPLEMENT');
  assert.equal(w2.ghCalls('/rerun').length, 0, 'no second re-run after a restart');
  assert.equal(w2.ghCalls('/logs').length, 0);
  const skipped = readJournal(taskDir).filter((e) => e.event === 'ci-flake-rerun-skipped');
  assert.deepEqual(skipped.map((e) => e.reason), ['already-rerun']);
});

test('daemon restart before GitHub registered the re-run: the old failed job id, read back from the journal, still counts as in flight', async () => {
  const ctx = flakeCtx();
  writeVerdict(ctx.config, HEAD, 'PASS');
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'ci-flake-rerun', {
    headSha: HEAD,
    jobId: OLD_JOB,
    check: 'typecheck + tests',
    step: 'Coverage of changed lines',
    failingFiles: ['src/e2e/verify-gate.test.ts'],
  });
  const w = fakeWorld({ checkRuns: [RED(OLD_JOB), GREEN()] });
  assert.equal(await realCiChecks(ctx, w.deps), 'VALIDATE');
  assert.equal(w.ghCalls('/rerun').length, 0);
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'check-failed'), 'the superseded red run was never read as a failure');
});

test('a ci-flake-rerun for a DIFFERENT sha does not block this one', async () => {
  const ctx = flakeCtx();
  writeVerdict(ctx.config, HEAD, 'PASS');
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'ci-flake-rerun', { headSha: 'otherSha', jobId: 1, failingFiles: ['x'] });
  const w = fakeWorld({ checkRuns: [RED(), GREEN()] });
  assert.equal(await realCiChecks(ctx, w.deps), 'VALIDATE');
  assert.equal(w.ghCalls('/rerun').length, 1);
});

test('shared poll budget: a first wait that spent every poll still gets exactly one fetch after the re-run, and parks ci-checks-still-running without sleeping', async () => {
  const ctx = flakeCtx({ config: testConfig({ ciChecksMaxPolls: 3 }) });
  writeVerdict(ctx.config, HEAD, 'PASS');
  const w = fakeWorld({ checkRuns: [QUEUED(OLD_JOB), QUEUED(OLD_JOB), RED(OLD_JOB), RED(OLD_JOB)] });
  await assert.rejects(
    () => realCiChecks(ctx, w.deps),
    (err) => err instanceof ParkSignal && err.reason === 'ci-checks-still-running' && err.detail.attempts === 4
  );
  assert.equal(w.ghCalls('/rerun').length, 1);
  assert.equal(w.sleeps.length, 2, 'only the first wait slept; the post-rerun fetch parks without a sleep');
});

// ---- today's route, unchanged ----------------------------------------------------------------

async function expectTodaysRoute({ reason, world, verdict = 'PASS', posted = 0, extra }) {
  const ctx = flakeCtx();
  if (verdict) writeVerdict(ctx.config, HEAD, verdict);
  const w = fakeWorld({ checkRuns: [RED()], ...world });
  assert.equal(await realCiChecks(ctx, w.deps), 'IMPLEMENT');
  assert.equal(w.ghCalls('/rerun').length, posted, 'rerun POSTs attempted');
  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'ci-flake-rerun'));
  const skipped = journal.filter((e) => e.event === 'ci-flake-rerun-skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, reason);
  assert.equal(skipped[0].headSha, HEAD);
  assert.equal(skipped[0].jobId, OLD_JOB);
  if (extra) extra(skipped[0], w);
  return { ctx, w, skipped: skipped[0] };
}

test('no bench verdict for the sha -> today\'s route (no-pass-verdict), and the log is never downloaded', async () => {
  await expectTodaysRoute({
    reason: 'no-pass-verdict',
    verdict: null,
    extra: (s, w) => {
      assert.equal(s.verdict, null);
      assert.equal(w.ghCalls('/logs').length, 0);
    },
  });
});

test('a bench verdict that is not PASS (FAIL) -> today\'s route (no-pass-verdict)', async () => {
  await expectTodaysRoute({
    reason: 'no-pass-verdict',
    verdict: 'FAIL',
    extra: (s, w) => {
      assert.equal(s.verdict, 'FAIL');
      assert.equal(w.ghCalls('/logs').length, 0);
    },
  });
});

test('job log unreadable (non-zero exit) -> today\'s route (log-unreadable)', async () => {
  await expectTodaysRoute({
    reason: 'log-unreadable',
    world: { log: { status: 1, stdout: jestLog(['src/e2e/verify-gate.test.ts']) } },
    extra: (s) => assert.equal(s.exit, 1),
  });
});

test('job log download throws (e.g. spawnStep\'s gh-timed-out) -> today\'s route (log-unreadable), never a park', async () => {
  await expectTodaysRoute({
    reason: 'log-unreadable',
    world: { log: new Error('spawnSync gh ETIMEDOUT') },
    extra: (s) => assert.match(s.error, /ETIMEDOUT/),
  });
});

test('no FAIL line parses from the log -> today\'s route (no-failing-file) -- e.g. the coverage ratchet itself failed', async () => {
  await expectTodaysRoute({
    reason: 'no-failing-file',
    world: { log: { status: 0, stdout: 'Coverage of changed lines: 71.2% < 93%\n##[error]Process completed with exit code 1.\n' } },
  });
});

test('a failing file IS in the branch diff -> today\'s route (failing-file-in-diff)', async () => {
  await expectTodaysRoute({
    reason: 'failing-file-in-diff',
    world: { diff: { status: 0, stdout: 'src/e2e/verify-gate.test.ts\nsrc/other.ts\n' } },
    extra: (s) => assert.deepEqual(s.inDiff, ['src/e2e/verify-gate.test.ts']),
  });
});

test('one of two failing files in the diff is enough to refuse -> today\'s route (failing-file-in-diff)', async () => {
  await expectTodaysRoute({
    reason: 'failing-file-in-diff',
    world: {
      log: { status: 0, stdout: jestLog(['src/flaky.test.ts', 'src/mine.test.ts']) },
      diff: { status: 0, stdout: 'src/mine.test.ts\n' },
    },
    extra: (s) => {
      assert.deepEqual(s.failingFiles, ['src/flaky.test.ts', 'src/mine.test.ts']);
      assert.deepEqual(s.inDiff, ['src/mine.test.ts']);
    },
  });
});

test('the branch diff cannot be computed -> today\'s route (diff-unreadable)', async () => {
  await expectTodaysRoute({ reason: 'diff-unreadable', world: { diff: { status: 128, stdout: '' } } });
});

test('GitHub refuses the rerun POST -> today\'s route (rerun-refused), and no ci-flake-rerun is journalled', async () => {
  await expectTodaysRoute({
    reason: 'rerun-refused',
    posted: 1,
    world: { rerun: { status: 1, stdout: '{"message":"Forbidden"}' } },
    extra: (s) => assert.equal(s.exit, 1),
  });
});

test('the rerun POST throws -> today\'s route (rerun-refused), never a park', async () => {
  await expectTodaysRoute({
    reason: 'rerun-refused',
    posted: 1,
    world: { rerun: new Error('spawnSync gh ETIMEDOUT') },
    extra: (s) => assert.match(s.error, /ETIMEDOUT/),
  });
});

test('the rule is scoped to `Coverage of changed lines`: a Lint or Tests failure makes no log download and journals no skip', async () => {
  for (const [step, next] of [
    ['Lint', 'IMPLEMENT'],
    ['Tests', 'DIAGNOSE'],
    ['Coverage of changed lines (client)', 'DIAGNOSE'],
  ]) {
    const ctx = flakeCtx();
    writeVerdict(ctx.config, HEAD, 'PASS');
    const w = fakeWorld({ checkRuns: [RED()], steps: [{ name: step, conclusion: 'failure' }] });
    assert.equal(await realCiChecks(ctx, w.deps), next, step);
    assert.equal(w.ghCalls('/logs').length, 0, step);
    assert.equal(w.ghCalls('/rerun').length, 0, step);
    const journal = readJournal(ctx.taskDir);
    assert.ok(!journal.some((e) => e.event === 'ci-flake-rerun-skipped' || e.event === 'ci-flake-rerun'), step);
  }
});
