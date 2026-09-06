'use strict';
// Tests for SPO-Pipeline#84: MERGE's own re-gate of the non-landing pr:wait path, conditioned on
// GitHub's own reported cause (#141's probeMergeability). See orchestrator/steps/scripted.js's
// regateAfterNonLanding for the full design rationale.
//
// Conventions copied from test/merge-cause.test.js (same makeDeps/testConfig/ok/fail shapes and
// tmpdir handling), extended with `git` overrides for the regate's own rev-parse/fetch/diff/merge
// calls.

require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { realMerge } = require('../orchestrator/steps/scripted');
const { buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-regate-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-regate-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    mainMovedRegateBudget: 1,
    benchIdleWaitMaxPolls: 3,
    benchIdleWaitPollIntervalMs: 10,
    ...overrides,
  };
}

function testCtx({ id = 'card-1', task, config, taskDir } = {}) {
  const dir = taskDir || path.join(mkTmp('spo-regate-journalroot-'), id);
  fs.mkdirSync(dir, { recursive: true });
  return buildCtx(id, task, dir, {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const HEAD_SHA = 'b'.repeat(40);
const ORIGIN_MAIN_SHA = 'a'.repeat(40);
const BASE_MAIN_SHA = 'basemainsha';

function writeVerdict(spoBenchDir, sha, verdict) {
  const dir = path.join(spoBenchDir, 'verdicts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha}.json`), JSON.stringify(verdict));
}

function writeNightly(spoBenchDir, nightly) {
  const dir = path.join(spoBenchDir, 'nightly');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(nightly));
}

// makeDeps -- the shared spawnSync stub for every test below. `git` overrides one leg of the
// regate's own spawns; anything not overridden gets a "happy" default so a test only has to name
// what it cares about.
function makeDeps({ waitExits, probe, git = {} }) {
  let waitCalls = 0;
  const calls = [];
  const sleeps = [];
  const spawnSync = (command, args) => {
    calls.push({ command, args: [...args] });

    if (command === 'gh' && args.includes('view')) {
      return typeof probe === 'function' ? probe() : probe;
    }
    if (command === 'npm' && args.includes('pr:wait')) {
      const exit = waitExits[Math.min(waitCalls, waitExits.length - 1)];
      waitCalls += 1;
      return exit === 0 ? ok('') : fail(exit);
    }
    if (command === 'git') {
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        return git.headRevParse !== undefined ? git.headRevParse : ok(`${HEAD_SHA}\n`);
      }
      if (args.includes('fetch')) {
        return git.fetch !== undefined ? git.fetch : ok('');
      }
      if (args.includes('diff') && args.includes(`${BASE_MAIN_SHA}..origin/main`)) {
        return git.diffMain !== undefined ? git.diffMain : ok('shared.txt\n');
      }
      if (args.includes('diff') && args.includes('origin/main...HEAD')) {
        return git.diffBranch !== undefined ? git.diffBranch : ok('shared.txt\n');
      }
      if (args.includes('rev-parse') && args.includes('origin/main')) {
        return git.originMainRevParse !== undefined ? git.originMainRevParse : ok(`${ORIGIN_MAIN_SHA}\n`);
      }
      if (args.includes('merge') && args.includes('--abort')) {
        return git.mergeAbort !== undefined ? git.mergeAbort : ok('');
      }
      if (args.includes('merge') && args.includes('origin/main')) {
        return git.merge !== undefined ? git.merge : ok('');
      }
      return ok('');
    }
    return ok('');
  };
  const sleepFn = (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { deps: { spawnSync, sleep: sleepFn }, calls, sleeps, waitCallsRef: () => waitCalls };
}

function conflictProbe() {
  return ok(JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
}
function behindProbe() {
  return ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }));
}

function makeTask(id, worktreePath) {
  return { id, kind: 'card', issue: 900, worktreePath };
}

// ---- 1. the happy route: CONFLICTING -> routed ---------------------------------------------

test('regate: probe CONFLICTING + verdict baseMain on disk + diffs intersect + budget free -> realMerge resolves to CHECK, journals main-moved-merge + merge-regate routed, git merge spawned, mainMoveUsed 0 -> 1', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt1-');
  const ctx = testCtx({ id: 'regate-1', task: makeTask('regate-1', worktreePath), config });
  ctx.prNumber = 901;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  assert.equal(ctx.counters.mainMoveUsed, 0);

  const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: conflictProbe });

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'CHECK');
  assert.equal(ctx.counters.mainMoveUsed, 1);

  const mergeCalls = calls.filter((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('origin/main'));
  assert.equal(mergeCalls.length, 1, 'git merge origin/main must actually be spawned');

  const events = readJournal(ctx.taskDir);
  const mainMoved = events.filter((e) => e.state === 'MERGE' && e.event === 'main-moved-merge');
  assert.equal(mainMoved.length, 1);
  assert.equal(mainMoved[0].from, 'MERGE');

  const regateEvents = events.filter((e) => e.state === 'MERGE' && e.event === 'merge-regate');
  assert.equal(regateEvents.length, 1);
  assert.equal(regateEvents[0].decision, 'routed');
});

// ---- 2. merge-behind-base also routes -------------------------------------------------------

test('regate: probe reports mergeStateStatus BEHIND (merge-behind-base) -> also routes to CHECK', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt2-');
  const ctx = testCtx({ id: 'regate-2', task: makeTask('regate-2', worktreePath), config });
  ctx.prNumber = 902;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  const { deps } = makeDeps({ waitExits: [4, 4], probe: behindProbe });

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'CHECK');
  assert.equal(ctx.counters.mainMoveUsed, 1);
});

// ---- 3. every non-base-moved probe answer is untouched --------------------------------------

for (const [label, probeFn] of [
  ['BLOCKED', () => ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }))],
  ['UNSTABLE', () => ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' }))],
  ['DRAFT', () => ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' }))],
  ['all-UNKNOWN', () => ok(JSON.stringify({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))],
]) {
  test(`regate: probe ${label} -> original park fires unchanged, and NO git fetch is spawned at all`, async () => {
    const config = testConfig();
    const worktreePath = mkTmp(`spo-regate-wt3-${label}-`);
    const ctx = testCtx({ id: `regate-3-${label}`, task: makeTask(`regate-3-${label}`, worktreePath), config });
    ctx.prNumber = 903;
    writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

    const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: probeFn });

    const expectedReason =
      label === 'BLOCKED' ? 'merge-blocked' : label === 'UNSTABLE' ? 'merge-checks-failing' : label === 'DRAFT' ? 'merge-pr-draft' : 'merge-queue-not-landing';

    await assert.rejects(
      () => realMerge(ctx, deps),
      (err) => err instanceof ParkSignal && err.reason === expectedReason
    );

    const fetchCalls = calls.filter((c) => c.command === 'git' && c.args.includes('fetch'));
    assert.equal(fetchCalls.length, 0, 'the conditional gate must never even reach the fetch for a non-base-moved cause');
    assert.equal(ctx.counters.mainMoveUsed, 0);
  });
}

// ---- 4. no intersection -> original park survives --------------------------------------------

test('regate: verdict present but diffs share nothing -> original park (merge-conflict) survives, decision: no-intersection', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt4-');
  const ctx = testCtx({ id: 'regate-4', task: makeTask('regate-4', worktreePath), config });
  ctx.prNumber = 904;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: conflictProbe,
    git: { diffMain: ok('other-file.txt\n'), diffBranch: ok('unrelated.txt\n') },
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict'
  );

  const regateEvents = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'merge-regate');
  assert.equal(regateEvents.length, 1);
  assert.equal(regateEvents[0].decision, 'no-intersection');
  assert.equal(ctx.counters.mainMoveUsed, 0);
});

// ---- 5. no verdict / no baseMain -> original park survives ------------------------------------

test('regate: no verdict on disk for HEAD -> original park survives, decision: no-base-main', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt5-');
  const ctx = testCtx({ id: 'regate-5', task: makeTask('regate-5', worktreePath), config });
  ctx.prNumber = 905;
  // deliberately no writeVerdict call

  const { deps } = makeDeps({ waitExits: [4, 4], probe: conflictProbe });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict'
  );

  const regateEvents = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'merge-regate');
  assert.equal(regateEvents.length, 1);
  assert.equal(regateEvents[0].decision, 'no-base-main');
});

// ---- 6. fetch failure -> original park survives ------------------------------------------------

test('regate: git fetch origin main fails -> original park survives, decision: fetch-failed, no git diff ran afterwards', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt6-');
  const ctx = testCtx({ id: 'regate-6', task: makeTask('regate-6', worktreePath), config });
  ctx.prNumber = 906;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: conflictProbe, git: { fetch: fail(1) } });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict'
  );

  const diffCalls = calls.filter((c) => c.command === 'git' && c.args.includes('diff'));
  assert.equal(diffCalls.length, 0, 'no git diff must run after a failed fetch');

  const regateEvents = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'merge-regate');
  assert.equal(regateEvents.length, 1);
  assert.equal(regateEvents[0].decision, 'fetch-failed');
});

// ---- 7. budget exhausted -------------------------------------------------------------------

test('regate: budget already spent (mainMoveUsed preloaded at budget) -> original park survives as merge-conflict, NOT main-moved-twice, decision: budget-exhausted, no git merge spawned', async () => {
  const config = testConfig({ mainMovedRegateBudget: 1 });
  const worktreePath = mkTmp('spo-regate-wt7-');
  const ctx = testCtx({ id: 'regate-7', task: makeTask('regate-7', worktreePath), config });
  ctx.prNumber = 907;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });
  ctx.counters.mainMoveUsed = 1; // budget already spent (e.g. by an earlier CI_CHECKS/GATE re-gate)

  const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: conflictProbe });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict'
  );

  const mergeCalls = calls.filter((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('origin/main'));
  assert.equal(mergeCalls.length, 0, 'no git merge must be spawned once the budget is exhausted');
  assert.equal(ctx.counters.mainMoveUsed, 1, 'the counter must not be bumped past the budget');

  const regateEvents = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'merge-regate');
  assert.equal(regateEvents.length, 1);
  assert.equal(regateEvents[0].decision, 'budget-exhausted');
});

// ---- 8. merge conflict during the re-gate itself ---------------------------------------------

test('regate: git merge origin/main itself conflicts -> merge --abort IS spawned, original park (merge-conflict) survives, decision: merge-failed', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt8-');
  const ctx = testCtx({ id: 'regate-8', task: makeTask('regate-8', worktreePath), config });
  ctx.prNumber = 908;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: conflictProbe, git: { merge: fail(1) } });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict'
  );

  const abortCalls = calls.filter((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('--abort'));
  assert.equal(abortCalls.length, 1, 'a failed regate merge must be aborted, leaving the worktree clean');

  const regateEvents = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'merge-regate');
  assert.equal(regateEvents.length, 1);
  assert.equal(regateEvents[0].decision, 'merge-failed');
});

// ---- 9. the w1.exit === 1 leg re-gates too (shared helper) -------------------------------------

test('regate: the w1.exit === 1 leg also re-gates on a CONFLICTING probe answer -> resolves to CHECK, proving the helper is shared', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt9-');
  const ctx = testCtx({ id: 'regate-9', task: makeTask('regate-9', worktreePath), config });
  ctx.prNumber = 909;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  const { deps } = makeDeps({ waitExits: [1], probe: conflictProbe });

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'CHECK');
  assert.equal(ctx.counters.mainMoveUsed, 1);
});

// ---- 10. nightly-red -----------------------------------------------------------------------

test('regate: origin/main is nightly-red at its new tip -> PARKED main-red-no-merge, git merge never spawned', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt10-');
  const ctx = testCtx({ id: 'regate-10', task: makeTask('regate-10', worktreePath), config });
  ctx.prNumber = 910;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });
  writeNightly(config.spoBenchDir, { verdict: 'FAIL', sha: ORIGIN_MAIN_SHA });

  const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: conflictProbe });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-red-no-merge'
  );

  const mergeCalls = calls.filter((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('origin/main'));
  assert.equal(mergeCalls.length, 0, 'a red nightly must refuse the merge before it is ever spawned');
});

// ---- 11. the probe is not called twice -------------------------------------------------------

test('regate: the re-gate adds zero GitHub reads -- exactly one gh pr view spawn when the first probe read is already definite', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt11-');
  const ctx = testCtx({ id: 'regate-11', task: makeTask('regate-11', worktreePath), config });
  ctx.prNumber = 911;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: conflictProbe });

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'CHECK');

  const viewCalls = calls.filter((c) => c.command === 'gh' && c.args.includes('view'));
  assert.equal(viewCalls.length, 1, 'the re-gate must reuse the probe already run by #141, never call gh pr view a second time');
});

// =================================================================================================
// ---- 10b. a spawn the re-gate makes that is KILLED must not replace the original park --------
//
// Principle 2 of this action's design: every failure inside the re-gate falls through and lets
// the caller's original park fire unchanged. `spawnStep` does not only return exit codes -- it
// THROWS (`<class>-timed-out` after its retry, `command-killed-by-signal` when something outside
// the process kills the child, which is the entire recorded population of this class: three
// deploy restarts, see command-timeout.js). Every one of the re-gate's six spawns sits AFTER the
// caller has already obtained GitHub's attested cause, so an escaping throw there does not
// degrade a routing decision -- it destroys one that was already made, and both reasons are
// TERMINAL (state-machine.js's TERMINAL_PARK_REASONS), so the card stops with a reason naming
// the re-gate's plumbing instead of the conflict a maintainer has to fix.
for (const killed of ['headRevParse', 'fetch', 'diffMain', 'merge']) {
  test(`regate: a re-gate spawn (${killed}) killed from outside the process must NOT replace the original park -- merge-conflict still fires, decision: spawn-park-suppressed`, async () => {
    const config = testConfig();
    const worktreePath = mkTmp(`spo-regate-wt10b-${killed}-`);
    const ctx = testCtx({ id: `regate-10b-${killed}`, task: makeTask(`regate-10b-${killed}`, worktreePath), config });
    ctx.prNumber = 913;
    writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

    // spawnOnce's own classification of "something outside killed the child": a signal with no
    // ETIMEDOUT error (command-timeout.js's isSpawnKilled). spawnStep retries once, then throws.
    const killedResult = { status: null, stdout: '', stderr: '', signal: 'SIGTERM' };
    const { deps } = makeDeps({ waitExits: [4, 4], probe: conflictProbe, git: { [killed]: killedResult } });

    await assert.rejects(
      () => realMerge(ctx, deps),
      (err) =>
        err instanceof ParkSignal &&
        err.reason === 'merge-conflict' &&
        err.detail &&
        err.detail.mergeStateStatus === 'DIRTY',
      'the park must stay the one GitHub actually attested, not the re-gate\'s own spawn failure'
    );

    const suppressed = readJournal(ctx.taskDir).filter(
      (e) => e.event === 'merge-regate' && e.decision === 'spawn-park-suppressed'
    );
    assert.equal(suppressed.length, 1, 'the suppression must be journalled, never silent');
    assert.equal(suppressed[0].suppressedReason, 'command-killed-by-signal');
    assert.equal(suppressed[0].reason, 'merge-conflict');
  });
}

// ---- 11b. the exact argv, and the journal state they are recorded under (verifier addition) ---
//
// Mutation testing found four surviving mutants that every test above stayed green through:
// dropping `main` from the fetch argv, adding `--no-ff` to the merge argv, swapping the two
// `git diff` ranges, and recording one of the regate's spawns under state 'CI_CHECKS' instead of
// 'MERGE'. The first two are silent behaviour changes (`git fetch origin` refreshes every ref,
// not the one being compared against; `--no-ff` changes what the branch tip becomes); the third
// is invisible to an intersection test, which is commutative, but the refs themselves are NOT
// interchangeable and a future edit to either range has to break something; the fourth writes a
// MERGE-state command into logs/CI_CHECKS.log, where a maintainer reading the park will never
// find it. Pinned here as one ordered sequence rather than four separate greps.
test('regate: pins the exact git argv the re-gate spawns, in order, and the journal state every one of them is recorded under', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-regate-wt11b-');
  const ctx = testCtx({ id: 'regate-11b', task: makeTask('regate-11b', worktreePath), config });
  ctx.prNumber = 912;
  writeVerdict(config.spoBenchDir, HEAD_SHA, { baseMain: BASE_MAIN_SHA });

  const { deps, calls } = makeDeps({ waitExits: [4, 4], probe: conflictProbe });

  assert.equal(await realMerge(ctx, deps), 'CHECK');

  assert.deepEqual(
    calls.filter((c) => c.command === 'git').map((c) => c.args),
    [
      ['-C', worktreePath, 'rev-parse', 'HEAD'],
      ['-C', worktreePath, 'fetch', 'origin', 'main'],
      ['-C', worktreePath, 'diff', '--name-only', `${BASE_MAIN_SHA}..origin/main`],
      ['-C', worktreePath, 'diff', '--name-only', 'origin/main...HEAD'],
      ['-C', worktreePath, 'rev-parse', 'origin/main'],
      ['-C', worktreePath, 'merge', 'origin/main'],
    ],
    'the re-gate spawns exactly these six git commands, in this order -- `..` for what main moved ' +
      'since the bench base, `...` for what the branch changed since the merge base, and a fetch ' +
      'of `main` specifically, not of every ref'
  );

  // Every spawn the re-gate makes is a MERGE-state command and has to be journalled (and logged,
  // via logs/<STATE>.log) as one -- a spawn recorded under another state is invisible to anyone
  // reading the park it produced.
  const gitSpawns = readJournal(ctx.taskDir).filter((e) => e.event === 'spawn' && e.argv && e.argv[0] === 'git');
  assert.equal(gitSpawns.length, 6);
  for (const e of gitSpawns) {
    assert.equal(e.state, 'MERGE', `git spawn ${JSON.stringify(e.argv)} must be journalled under MERGE`);
  }
});

// ---- 12. the LAP, driven through runTask (verifier addition) -----------------------------------
// =================================================================================================
//
// Everything above calls `realMerge` directly. That proves the helper, not the ROUTE: nothing
// there shows a real card walking the real state graph from a MERGE re-gate back through
// CHECK -> PUSH_PR -> GATE -> CI_CHECKS -> VALIDATE -> MERGE. That gap mattered already
// (`realPushPr`'s PR reuse is proven only by a direct unit call, test/real-steps.test.js:1827,
// and every real-mode `gh pr list` stub in this suite returns `[]`); this action adds a SECOND
// producer of that lap, so it is proven here instead of assumed.
//
// Harness shape is deliberately the one test/gate-legs-reachability.test.js already proves works
// for `runTask` in real mode (same STEP_PAYLOADS/commonSpawnSync/overrides split, re-derived
// rather than imported since that file exports nothing) -- see its header for why reachability
// has to be driven through `runTask` and cannot be established by calling the step function.

const { runTask } = require('../orchestrator/state-machine');
const { mkTmp: helperMkTmp, writePoolDir } = require('./helpers');

const LAP_ORIGIN_MAIN_SHA = 'a'.repeat(40);
const LAP_HEAD_SHA = 'b'.repeat(40);

const LAP_STEP_PAYLOADS = {
  'plan_markdown,invariants_markdown,invariant_ids,check_commands': {
    plan_markdown: '# Plan\n\nSynthetic re-gate-lap card.\n',
    invariants_markdown: '# Invariants\n\n(none -- synthetic card)\n',
    invariant_ids: [],
    check_commands: ['typecheck', 'lint', 'coverage:changed'],
    files_to_change: ['doc/x.md'],
  },
  'summary,files_changed,invariants,tests_run,all_green': {
    summary: 'Synthetic change.',
    files_changed: ['doc/x.md'],
    invariants: [],
    tests_run: ['coverage:changed'],
    all_green: true,
  },
  'verdict,reasons,findings': { verdict: 'PASS', reasons: [], findings: [] },
};

function lapFakeClaudeStdout(args) {
  const i = args.indexOf('--json-schema');
  const schema = i >= 0 ? JSON.parse(args[i + 1]) : { required: [] };
  const key = (schema.required || []).join(',');
  const payload = LAP_STEP_PAYLOADS[key];
  if (!payload) throw new Error(`lapFakeClaudeStdout: no canned payload for required=[${key}]`);
  return JSON.stringify({
    result: JSON.stringify(payload),
    session_id: `fake-session-${key.length}`,
    num_turns: 1,
    modelUsage: { 'fake-model': { input_tokens: 100, output_tokens: 50 } },
  });
}

// `mainMovedFiles()` is the ONE thing the lap tests vary between laps: `git diff --name-only
// <baseMain>..origin/main`. Lap 1 returns the branch's own file, so MERGE's re-gate intersects;
// after the re-gate's own `git merge origin/main` the caller flips it to a disjoint file, which
// is what a real second lap sees (a fresh bench verdict whose baseMain IS the main just merged),
// so lap 2's CI_CHECKS finds "not moved" and hands straight on to VALIDATE.
function lapCommonSpawnSync(command, args, mainMovedFiles) {
  if (command === 'claude') return ok(lapFakeClaudeStdout(args));
  if (command === 'git') {
    if (args.includes('fetch')) return ok('');
    if (args.includes('rev-parse') && args.includes('--verify')) return fail(1);
    if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${LAP_ORIGIN_MAIN_SHA}\n`);
    if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${LAP_HEAD_SHA}\n`);
    if (args.includes('worktree') && args.includes('list')) return ok('');
    if (args.includes('worktree') && args.includes('add')) return ok('');
    if (args.includes('status') && args.includes('--porcelain')) return ok(' M doc/x.md\n');
    if (args.includes('add') && args.includes('-A')) return ok('');
    if (args.includes('commit')) return ok('');
    if (args.includes('push')) return ok('To github.com\n * [new branch]      HEAD -> claude-pipe/x\n');
    if (args.includes('merge') && args.includes('--abort')) return ok('');
    if (args.includes('merge') && args.includes('origin/main')) return ok('');
    if (args.includes('diff') && args.includes('--name-only')) {
      if (args.includes(`${BASE_MAIN_SHA}..origin/main`)) return ok(mainMovedFiles());
      return ok('doc/x.md\n');
    }
    if (args.includes('diff')) return ok('diff --git a/doc/x.md b/doc/x.md\n+one line\n');
    return fail(1, `unhandled fake git call: ${args.join(' ')}`);
  }
  if (command === 'gh') {
    if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify([{ number: 4242 }]));
    if (args[0] === 'pr' && args[1] === 'create') return fail(1, 'gh pr create must never run on a re-lapped card');
    if (args[0] === 'api' && args.some((a) => String(a).includes('check-runs'))) {
      return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success', status: 'completed' }] }));
    }
    if (args[0] === 'api') return ok('{}');
    if (args[0] === 'pr' && args[1] === 'merge') return ok('');
    if (args[0] === 'pr' && args[1] === 'view') return conflictProbe();
    if (args[0] === 'issue' && args[1] === 'comment') return ok('https://github.com/o/r/issues/1#issuecomment-1\n');
    return fail(1, `unhandled fake gh call: ${args.join(' ')}`);
  }
  if (command === 'npm') {
    if (args[0] === 'ci') return ok('');
    if (args[1] === 'board:take') return ok('claimed\n');
    if (args[1] === 'board:move') return ok('');
    if (['typecheck', 'lint', 'coverage:changed'].includes(args[1])) return ok('');
    if (args[1] === 'gate') return ok('');
    if (args[1] === 'pr:wait') return fail(4);
    return fail(1, `unhandled fake npm call: ${args.join(' ')}`);
  }
  return fail(1, `unhandled fake command: ${command} ${args.join(' ')}`);
}

function lapConfig(overrides = {}) {
  const accts = helperMkTmp('spo-regate-lap-accts-');
  writePoolDir(accts, [{ name: 'default' }]);
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: helperMkTmp('spo-regate-lap-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: helperMkTmp('spo-regate-lap-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1,
    mainMovedRegateBudget: 1,
    claudeAccountsDir: accts,
    ...overrides,
  };
}

test('runTask (real mode, card): MERGE re-gates on a CONFLICTING probe and the card really walks CHECK -> PUSH_PR (PR REUSED, gh pr create never called) -> GATE -> CI_CHECKS -> VALIDATE -> MERGE a second time, where the spent budget makes it park on the ORIGINAL merge-conflict rather than loop', async () => {
  const taskDir = helperMkTmp('spo-regate-lap-taskdir-');
  const config = lapConfig();

  // The bench verdict for HEAD is deliberately NOT on disk while lap 1's CI_CHECKS runs -- its
  // own main-moved test would otherwise fire first and spend the shared budget before MERGE ever
  // got a turn (measured: that is exactly what the first draft of this test did). It is written
  // the moment MERGE enqueues, simulating a sibling landing in the GATE -> merge-queue window --
  // the precise gap #84 exists to close.
  //
  // Before the re-gate's merge, `main` has moved into the branch's own file; after it, it has
  // not (see lapCommonSpawnSync).
  //
  // `movedFiles` walks the window this card actually lives in, one flip per real event:
  //   1. MERGE enqueues            -> a sibling has landed, `main` now touches doc/x.md
  //   2. the re-gate merges it     -> `main` no longer moves the branch's file, so lap 2's
  //                                   CI_CHECKS finds "not moved" and hands on to VALIDATE
  //   3. MERGE enqueues AGAIN      -> a SECOND sibling lands in the same window, so MERGE's own
  //                                   re-gate would fire again if the budget allowed it
  // Step 3 is what makes the budget check the thing under test rather than the intersection.
  let movedFiles = 'doc/x.md\n';
  let enqueues = 0;
  const calls = [];
  config.deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
        enqueues += 1;
        writeVerdict(config.spoBenchDir, LAP_HEAD_SHA, { baseMain: BASE_MAIN_SHA });
        if (enqueues >= 2) movedFiles = 'doc/x.md\n';
      }
      const r = lapCommonSpawnSync(command, args, () => movedFiles);
      if (command === 'git' && args.includes('merge') && args.includes('origin/main')) {
        movedFiles = 'wholly-unrelated.txt\n';
      }
      return r;
    },
    sleep: () => Promise.resolve(),
  };

  const task = { id: 'regate-lap', kind: 'card', issue: 984, title: 'Synthetic re-gate lap', criterion: 'lap only', size: 'S' };
  const finalState = await runTask(task.id, task, taskDir, config);

  const events = readJournal(taskDir);
  const parked = events.find((e) => e.event === 'parked');

  assert.equal(finalState, 'PARKED');
  assert.ok(parked, 'runTask must have journalled a parked event');
  assert.equal(parked.state, 'MERGE');
  assert.equal(
    parked.reason,
    'merge-conflict',
    'the SECOND MERGE visit must fall through to the pre-existing park, never to main-moved-twice and never into a loop'
  );

  // The re-gate fired exactly once, and routed.
  const regateDecisions = events.filter((e) => e.event === 'merge-regate').map((e) => e.decision);
  assert.deepEqual(regateDecisions, ['routed', 'budget-exhausted']);
  assert.equal(events.filter((e) => e.event === 'main-moved-merge').length, 1);

  // The lap really happened: MERGE was entered twice, and CHECK ran again in between.
  assert.equal(events.filter((e) => e.event === 'pr-merge-enqueue').length, 2, 'MERGE must have been entered twice');
  const transitions = events.filter((e) => e.event === 'transition');
  const mergeToCheck = transitions.find((e) => e.state === 'MERGE' && e.to === 'CHECK');
  assert.ok(mergeToCheck, 'the state machine itself must have journalled the MERGE -> CHECK transition');

  // PUSH_PR's second pass reused the open PR instead of creating one -- the leg this suite had
  // never driven through runTask before.
  assert.ok(
    events.some((e) => e.state === 'PUSH_PR' && e.event === 'pr-reused' && e.prNumber === 4242),
    'the re-lapped PUSH_PR must reuse the already-open PR'
  );
  assert.ok(
    !calls.some((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'),
    'gh pr create must never run on the re-lapped card'
  );

  // And the runaway guard was never anywhere near being needed.
  assert.ok(transitions.length < 30, `expected a bounded lap, saw ${transitions.length} transitions`);
});
