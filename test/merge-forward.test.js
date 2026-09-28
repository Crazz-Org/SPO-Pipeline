'use strict';
// merge-forward.test.js -- SPO-Pipeline#235, option A: a conflicting `git merge origin/main` at
// GATE or CI_CHECKS gets ONE IMPLEMENT attempt (a `MERGE-FORWARD` diagnosis source) before the card
// parks; MERGE's own conflict path is unchanged. See orchestrator/merge-forward.js's header.
//
// Every case runs real-mode handlers against a small stateful fake of the worktree's git (below):
// the same `deps.spawnSync` seam test/gate-main-moved.test.js and test/real-steps.test.js use, and
// the `deps.spawn` + fakeSpawnedChild seam test/implement-empty-result.test.js uses for the
// `claude` session. No real git, gh, npm or LLM call is ever made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const { HANDLERS, buildCtx, finalizePark } = require('../orchestrator/state-machine');
const { realMerge, prepareResume } = require('../orchestrator/steps/scripted');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');
const { buildPromptValues } = require('../orchestrator/task-values');
const { fillPromptTemplate } = require('../orchestrator/prompt-template');
const { buildParkComment, continueEligibility } = require('../orchestrator/park-loop');
const mf = require('../orchestrator/merge-forward');
const { mkTmp, fakeSpawnedChild, fakeExecDeps } = require('./helpers');

const HEAD = '1111111111111111111111111111111111111111'; // the pushed head, what a fallback restores
const MAIN = '2222222222222222222222222222222222222222'; // origin/main, the sha the session merges
const RESOLVED = '3333333333333333333333333333333333333333'; // the merge commit the pipeline makes
const BASE_MAIN = '4444444444444444444444444444444444444444'; // CI_CHECKS' verdict baseMain
const CONFLICTED = ['src/server/login-handler.ts', 'src/server/login-handler.test.ts'];

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
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
function events(taskDir, name) {
  return readJournal(taskDir).filter((e) => e.event === name);
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ---- the fake world: one worktree's git state, the bench, CI and the session ------------------

function makeWorld(overrides = {}) {
  return {
    head: HEAD,
    branch: 'claude-pipe/mf-card',
    detached: false,
    mergeHead: null,
    unmerged: [],
    dirty: '',
    markers: [],
    ancestors: new Set([HEAD]),
    gateExits: [1, 0], // first gate: the bench refusal; second: the re-gate on the new sha
    checkExit: 0,
    commitNoEditExit: 0,
    abortExit: 0,
    mainRevParseExit: 0,
    conflicted: [...CONFLICTED],
    replies: [], // one {effect(world), reply} per `claude` call, consumed in order
    calls: [],
    llmCalls: 0,
    ...overrides,
  };
}

const GATE_JOB_ID = 'job-mf-gate';

function has(a, ...words) {
  return words.every((w) => a.includes(w));
}

function spawnSyncFor(w) {
  return (command, args) => {
    const a = args[0] === '-C' ? args.slice(2) : [...args];
    w.calls.push({ command, args: a });
    if (command === 'npm') {
      if (has(a, 'run', 'gate')) {
        const exit = w.gateExits.length ? w.gateExits.shift() : 0;
        // Card #307: a failing gate names its job, and the FAIL verdict seeded for HEAD below
        // carries that same id -- otherwise the exit-1 path reads it as an earlier job's verdict.
        const stdout = exit === 0 ? '' : `job ${GATE_JOB_ID} queued (ref, position 1)\n`;
        return { status: exit, stdout, stderr: '', signal: null };
      }
      if (a[0] === 'run') return w.checkExit === 0 ? ok('') : fail(w.checkExit, 'red');
      return ok('');
    }
    if (command === 'gh') {
      if (a[0] === 'api' && String(a[1]).includes('check-runs')) {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (has(a, 'pr', 'list')) return ok('[{"number":777}]');
      if (has(a, 'pr', 'view')) return ok(JSON.stringify({ state: 'OPEN', headRefName: w.branch }));
      return ok('');
    }
    if (command !== 'git') return ok('');

    if (a[0] === 'rev-parse') {
      if (a.includes('MERGE_HEAD')) return w.mergeHead ? ok(`${w.mergeHead}\n`) : fail(1);
      if (a.some((x) => String(x).startsWith('refs/remotes/origin/'))) return ok(`${HEAD}\n`);
      // A failing rev-parse still printing a sha: an unrelated failure (spawnOnce maps an external
      // kill to exit 1) after the answer was written -- a failed command's stdout is never trusted.
      if (a.includes('origin/main')) return w.mainRevParseExit === 0 ? ok(`${MAIN}\n`) : { status: w.mainRevParseExit, stdout: `${MAIN}\n`, stderr: '', signal: null };
      if (a.includes('HEAD')) return ok(`${w.head}\n`);
      return ok('');
    }
    if (a[0] === 'merge') {
      if (a.includes('--abort')) {
        if (w.abortExit !== 0) return fail(w.abortExit);
        w.mergeHead = null;
        w.unmerged = [];
        return ok('');
      }
      if (a.includes('origin/main')) {
        w.mergeHead = MAIN;
        w.unmerged = [...w.conflicted];
        return fail(1, 'CONFLICT (content): Merge conflict');
      }
      return ok('');
    }
    if (a[0] === 'merge-base' && a.includes('--is-ancestor')) return w.ancestors.has(a[2]) ? ok('') : fail(1);
    if (a[0] === 'diff') {
      if (a.includes('--diff-filter=U')) return ok(w.unmerged.map((f) => `${f}\n`).join(''));
      if (a.includes(`${BASE_MAIN}..origin/main`) || a.includes('origin/main...HEAD')) return ok(`${CONFLICTED[0]}\n`);
      return ok('');
    }
    if (has(a, 'status', '--porcelain')) return ok(w.dirty);
    if (has(a, 'ls-files', '-u')) return ok(w.unmerged.map((f) => `100644 ${HEAD} 2\t${f}\n`).join(''));
    if (a[0] === 'grep') return w.markers.length ? ok(w.markers.map((m) => `${m}\n`).join('')) : fail(1);
    if (a[0] === 'commit') {
      if (a.includes('--no-edit')) {
        if (!w.mergeHead) return fail(1, 'nothing to commit');
        if (w.commitNoEditExit !== 0) return fail(w.commitNoEditExit, 'hook refused');
        w.head = RESOLVED;
        w.ancestors.add(w.mergeHead);
        w.ancestors.add(RESOLVED);
        w.mergeHead = null;
        w.dirty = '';
        return ok('');
      }
      return fail(1, 'nothing to commit'); // PUSH_PR's own `commit -F`: the merge is already committed
    }
    if (has(a, 'symbolic-ref')) return w.detached ? fail(128, 'not a symbolic ref') : ok(`${w.branch}\n`);
    if (a[0] === 'checkout' && a.includes('-f')) {
      w.detached = false;
      w.mergeHead = null;
      w.unmerged = [];
      w.markers = [];
      return ok('');
    }
    if (a[0] === 'reset' && a.includes('--hard')) {
      w.head = a[a.length - 1];
      w.ancestors = new Set([w.head]);
      w.dirty = '';
      return ok('');
    }
    return ok('');
  };
}

function initMessage() {
  return { type: 'system', subtype: 'init', session_id: 'sess-mf', apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}
function claudeStream(resultObj) {
  return [
    initMessage(),
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      session_id: 'sess-mf',
      modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 5 } },
      result: JSON.stringify(resultObj),
      terminal_reason: 'success',
      api_error_status: null,
    },
  ];
}

function spawnFor(w) {
  return () => {
    w.llmCalls += 1;
    const next = w.replies.shift();
    if (!next) throw new Error('merge-forward.test.js: an unexpected claude call');
    if (next.effect) next.effect(w);
    return fakeSpawnedChild(claudeStream(next.reply));
  };
}

// The four session behaviours the measurement saw, as world effects + replies.
const RESOLVED_REPLY = {
  summary: 'merged origin/main, kept both sides',
  files_changed: CONFLICTED,
  invariants: [],
  tests_run: ['npm run typecheck', 'npx jest src/server/login-handler.test.ts'],
  all_green: true,
};
function sessionResolves() {
  return {
    effect: (w) => {
      w.mergeHead = MAIN;
      w.unmerged = [];
      w.dirty = CONFLICTED.map((f) => `M  ${f}\n`).join('');
    },
    reply: RESOLVED_REPLY,
  };
}
function sessionDeclines() {
  return {
    effect: () => {},
    reply: {
      summary: 'the two designs clash',
      files_changed: [],
      invariants: [],
      tests_run: [],
      all_green: false,
      stop_reason: 'src/server/login-handler.ts: the card replaces the fetch main built its outcome on',
    },
  };
}
function sessionLeavesMarkers() {
  return {
    effect: (w) => {
      w.mergeHead = MAIN;
      w.unmerged = [];
      w.markers = [`${CONFLICTED[0]}:12:<<<<<<< HEAD`];
    },
    reply: RESOLVED_REPLY, // claims green anyway -- never read
  };
}
function sessionEffect(effect) {
  return { effect, reply: RESOLVED_REPLY };
}
function diagnoseReply(n) {
  return { effect: () => {}, reply: { root_cause: `main's fixture changed shape (${n})`, category: 'test', suggested_fix: 'update the fixture' } };
}

function makeCtx(w, { taskDir, config: overrides = {}, site = 'GATE' } = {}) {
  const worktreesDir = mkTmp('spo-mf-worktrees-');
  const id = 'mf-card';
  const worktreePath = path.join(worktreesDir, id);
  fs.mkdirSync(worktreePath, { recursive: true });
  const accountsDir = mkTmp('spo-mf-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  const dir = taskDir || mkTmp('spo-mf-taskdir-');
  if (!readJournal(dir).some((e) => e.state === 'PLAN' && e.event === 'result')) {
    appendEvent(dir, 'PLAN', 'result', {
      payload: {
        plan_path: path.join(dir, 'scratch', 'plan.md'),
        invariants_path: path.join(dir, 'scratch', 'invariants.md'),
        invariant_ids: ['INV-1'],
        check_commands: ['npm test'],
      },
    });
  }
  const spoBenchDir = mkTmp('spo-mf-bench-');
  if (site === 'GATE') writeJson(path.join(spoBenchDir, 'verdicts', `${HEAD}.json`), { jobId: GATE_JOB_ID, verdict: 'FAIL' });
  if (site === 'CI_CHECKS') writeJson(path.join(spoBenchDir, 'verdicts', `${HEAD}.json`), { verdict: 'PASS', baseMain: BASE_MAIN });
  const config = {
    shadowMode: false,
    dryRun: false,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: worktreesDir,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir,
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 2,
    ciChecksPollIntervalMs: 1,
    mainMovedRegateBudget: 1,
    diagnoseBudget: 3,
    ciRetryBudget: 2,
    deps: fakeExecDeps({ spawn: spawnFor(w), spawnSync: spawnSyncFor(w), sleep: async () => {} }),
    ...overrides,
  };
  const task = {
    id,
    kind: 'card',
    issue: 235,
    title: 'Merge-forward card',
    criterion: 'the login outcome is shown',
    worktreePath,
    size: 'S',
    touchesRdoMembers: false,
    baseMainSha: BASE_MAIN,
  };
  const ctx = buildCtx(id, task, dir, config);
  ctx.prNumber = 777;
  return ctx;
}

// Runs handlers from `start`, the way runStateMachineLoop does (cameFrom included), until one parks
// or `stopAt` is reached. Returns the states visited and the park, if any.
async function drive(ctx, start, stopAt) {
  const visited = [];
  let state = start;
  for (let hop = 0; hop < 40; hop++) {
    visited.push(state);
    if (stopAt.includes(state) && hop > 0) return { visited, park: null, state };
    try {
      const next = await HANDLERS[state](ctx);
      ctx.cameFrom = state;
      state = next;
    } catch (err) {
      if (err instanceof ParkSignal) return { visited, park: err, state };
      throw err;
    }
  }
  throw new Error(`drive: runaway from ${start}: ${visited.join(' -> ')}`);
}

async function ciChecksToConflict(w, ctx) {
  // CI_CHECKS reads HEAD, polls check-runs (green), sees main moved in an intersecting file, merges.
  return HANDLERS.CI_CHECKS(ctx);
}

const SITES = [
  { site: 'GATE', reason: 'gate-merge-refused' },
  { site: 'CI_CHECKS', reason: 'main-moved-merge-failed' },
];

// ================================================================================================
// 1. conflict -> MERGE-FORWARD IMPLEMENT -> CHECK -> PUSH_PR -> a new GATE on the new sha
// ================================================================================================

for (const { site } of SITES) {
  test(`${site}: a conflicting merge-forward routes to IMPLEMENT, the session's merge is checked and committed by the pipeline, CHECK runs, and a new gate judges the new sha`, async () => {
    const w = makeWorld({ replies: [sessionResolves()], gateExits: site === 'GATE' ? [1, 0] : [0] });
    const ctx = makeCtx(w, { site });

    const { visited, park } = await drive(ctx, site, ['CI_CHECKS', 'VALIDATE']);
    assert.equal(park, null, park && `${park.reason} ${JSON.stringify(park.detail)}`);
    assert.deepEqual(visited, [site, 'IMPLEMENT', 'CHECK', 'PUSH_PR', 'GATE', 'CI_CHECKS']);

    const attempt = events(ctx.taskDir, 'merge-forward-attempt');
    assert.equal(attempt.length, 1);
    assert.equal(attempt[0].site, site);
    assert.equal(attempt[0].issue, 235);
    assert.equal(attempt[0].mainSha, MAIN);
    assert.equal(attempt[0].headSha, HEAD);
    assert.deepEqual(attempt[0].conflictedFiles, CONFLICTED);

    // The site aborted its own conflict before IMPLEMENT: the session merges the pinned sha itself.
    const abortIdx = w.calls.findIndex((c) => c.command === 'git' && has(c.args, 'merge', '--abort'));
    assert.ok(abortIdx >= 0, 'the conflicted merge is aborted before the attempt');

    // The pipeline, not the session, committed the merge -- with git's own message.
    assert.ok(w.calls.some((c) => c.command === 'git' && has(c.args, 'commit', '--no-edit')));
    const resolved = events(ctx.taskDir, 'merge-forward-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].resolvedHead, RESOLVED);

    // CHECK really ran (the session's all_green is never trusted).
    assert.ok(w.calls.some((c) => c.command === 'npm' && has(c.args, 'run', 'typecheck')));
    // The re-gate ran and judged the NEW sha.
    assert.equal(w.calls.filter((c) => c.command === 'npm' && has(c.args, 'run', 'gate')).length, site === 'GATE' ? 2 : 1);
    const judged = events(ctx.taskDir, 'gate-live-unknown').map((e) => e.headSha);
    assert.equal(judged[judged.length - 1], RESOLVED);

    // Its reply is not IMPLEMENT's `result` -- the card's commit subject and PR body are untouched.
    assert.equal(events(ctx.taskDir, 'merge-forward-result').length, 1);
    assert.equal(readJournal(ctx.taskDir).filter((e) => e.state === 'IMPLEMENT' && e.event === 'result').length, 0);
    // A merge-forward is not a CI retry.
    assert.equal(ctx.counters.ciImplementRetries, 0);
    assert.equal(events(ctx.taskDir, 'ci-implement-retry').length, 0);
    assert.equal(ctx.mergeForward, null);
    assert.equal(w.llmCalls, 1);
  });
}

// ================================================================================================
// 2. fallbacks: today's park, resumable, with the note -- and the tree back at the pushed head
// ================================================================================================

function assertFallbackPark(park, { site, reason, outcome }) {
  assert.ok(park instanceof ParkSignal, 'expected a park');
  assert.equal(park.reason, reason);
  assert.equal(park.detail.mergeForward.tried, true);
  assert.equal(park.detail.mergeForward.site, site);
  assert.equal(park.detail.mergeForward.outcome, outcome);
  assert.equal(park.detail.mergeForward.headSha, HEAD);
  assert.equal(park.detail.mergeForward.mainSha, MAIN);
  if (site === 'GATE') {
    // today's gate-merge-refused detail is kept whole
    assert.equal(park.detail.headSha, HEAD);
    assert.equal(park.detail.testsRan, false);
    assert.equal(park.detail.gatePassedOnSha, false);
  } else {
    assert.equal(park.detail.exit, 1);
  }
}

function assertRestored(w) {
  assert.equal(w.head, HEAD, 'the branch is back at the pushed head');
  assert.equal(w.mergeHead, null, 'no merge left in progress');
  assert.equal(w.dirty, '', 'a clean tree');
  const restore = w.calls.filter((c) => c.command === 'git' && (has(c.args, 'checkout', '-f') || has(c.args, 'reset', '--hard') || has(c.args, 'clean', '-fd')));
  assert.equal(restore.length, 3);
  assert.deepEqual(restore[1].args, ['reset', '--hard', HEAD]);
}

for (const { site, reason } of SITES) {
  test(`${site}: the session declines with a stop_reason -> today's park (${reason}), tree restored, note says declined`, async () => {
    const w = makeWorld({ replies: [sessionDeclines()] });
    const ctx = makeCtx(w, { site });
    const { visited, park } = await drive(ctx, site, ['CI_CHECKS']);
    assert.deepEqual(visited, [site, 'IMPLEMENT']);
    assertFallbackPark(park, { site, reason, outcome: 'declined' });
    assert.match(park.detail.mergeForward.stopReason, /login-handler\.ts/);
    assertRestored(w);
    assert.equal(events(ctx.taskDir, 'merge-forward-fallback').length, 1);
  });

  test(`${site}: conflict markers left (and all_green claimed) -> today's park, never CHECK`, async () => {
    const w = makeWorld({ replies: [sessionLeavesMarkers()] });
    const ctx = makeCtx(w, { site });
    const { visited, park } = await drive(ctx, site, ['CI_CHECKS']);
    assert.deepEqual(visited, [site, 'IMPLEMENT']);
    assertFallbackPark(park, { site, reason, outcome: 'markers-left' });
    assert.deepEqual(park.detail.mergeForward.files, [CONFLICTED[0]]);
    assert.ok(!w.calls.some((c) => has(c.args, 'commit', '--no-edit')), 'a tree with markers is never committed');
    assertRestored(w);
  });

  test(`${site}: nothing merged (the session never ran the merge) -> today's park, not-merged`, async () => {
    const w = makeWorld({ replies: [sessionEffect(() => {})] });
    const ctx = makeCtx(w, { site });
    const { park } = await drive(ctx, site, ['CI_CHECKS']);
    assertFallbackPark(park, { site, reason, outcome: 'not-merged' });
    assert.equal(park.detail.mergeForward.mainMerged, false);
    assertRestored(w);
  });

  test(`${site}: budget spent -- a second conflict on the same card parks at once, even after a simulated restart`, async () => {
    // First run: the attempt is offered and declined.
    const w1 = makeWorld({ replies: [sessionDeclines()] });
    const ctx1 = makeCtx(w1, { site });
    await drive(ctx1, site, ['CI_CHECKS']);
    assert.equal(events(ctx1.taskDir, 'merge-forward-attempt').length, 1);

    // A new process on the same journal (a restart, a `continue`, a resume): fresh ctx, fresh
    // counters, a DIFFERENT main sha would not matter either -- the journal says the attempt is spent.
    const w2 = makeWorld({ replies: [] });
    const ctx2 = makeCtx(w2, { site, taskDir: ctx1.taskDir });
    const { visited, park } = await drive(ctx2, site, ['CI_CHECKS']);
    assert.deepEqual(visited, [site]);
    assert.equal(park.reason, reason);
    assert.equal(park.detail.mergeForward.outcome, 'budget-spent');
    assert.equal(park.detail.mergeForward.priorAttempt.headSha, HEAD);
    assert.equal(w2.llmCalls, 0, 'no second session');
    assert.equal(events(ctx1.taskDir, 'merge-forward-attempt').length, 1, 'no second attempt journalled');
    const skipped = events(ctx1.taskDir, 'merge-forward-skipped');
    assert.equal(skipped[skipped.length - 1].why, 'budget-spent');
  });
}

test('budget is per site: a card whose GATE attempt is spent still gets its one CI_CHECKS attempt', async () => {
  const taskDir = mkTmp('spo-mf-persite-');
  appendEvent(taskDir, 'GATE', 'merge-forward-attempt', { site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED });
  const w = makeWorld({ replies: [sessionResolves()], gateExits: [0] });
  const ctx = makeCtx(w, { site: 'CI_CHECKS', taskDir });
  assert.equal(await HANDLERS.CI_CHECKS(ctx), 'IMPLEMENT');
});

// ================================================================================================
// 3. CHECK red after the resolution: the ordinary diagnose budget, bounded, then today's park
// ================================================================================================

for (const { site, reason } of SITES) {
  test(`${site}: CHECK red after the resolution -> DIAGNOSE/IMPLEMENT under the ordinary budget, no second merge-forward, then today's park on the restored head`, async () => {
    const w = makeWorld({
      checkExit: 1, // red on every CHECK
      replies: [
        sessionResolves(),
        diagnoseReply(1),
        { effect: (x) => (x.dirty = ' M src/server/login-handler.test.ts\n'), reply: { ...RESOLVED_REPLY, summary: 'fixed the fixture' } },
        diagnoseReply(2),
      ],
    });
    const ctx = makeCtx(w, { site, config: { diagnoseBudget: 2 } });
    const { visited, park } = await drive(ctx, site, ['CI_CHECKS']);

    assert.deepEqual(visited, [site, 'IMPLEMENT', 'CHECK', 'DIAGNOSE', 'IMPLEMENT', 'CHECK', 'DIAGNOSE']);
    assertFallbackPark(park, { site, reason, outcome: 'check-red' });
    assert.equal(park.detail.mergeForward.underlying.reason, 'diagnose-budget-exhausted');
    assert.equal(park.detail.mergeForward.resolvedHead, RESOLVED);
    assert.equal(events(ctx.taskDir, 'merge-forward-attempt').length, 1, 'exactly one merge-forward, never a second');
    // The second IMPLEMENT was an ordinary one: its reply is IMPLEMENT's own `result`.
    assert.equal(readJournal(ctx.taskDir).filter((e) => e.state === 'IMPLEMENT' && e.event === 'result').length, 1);
    assert.equal(w.llmCalls, 4);
    assertRestored(w);
  });
}

test('CHECK passing after the resolution ends the special case: a later DIAGNOSE budget park is left as it is', async () => {
  const w = makeWorld({ replies: [sessionResolves()], gateExits: [1] });
  const ctx = makeCtx(w);
  const { visited } = await drive(ctx, 'GATE', ['PUSH_PR']);
  assert.deepEqual(visited, ['GATE', 'IMPLEMENT', 'CHECK', 'PUSH_PR']);
  assert.equal(ctx.mergeForwardAwaitingCheck, null);

  ctx.counters.diagnoseAttempts = ctx.config.diagnoseBudget;
  await assert.rejects(
    () => HANDLERS.DIAGNOSE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'diagnose-budget-exhausted' && !err.detail.mergeForward
  );
});

test('mergeForwardCheckRedFallback: only the three diagnose-budget ends and diagnose-out-of-scope (#305) are rerouted; any other park passes through untouched', () => {
  const w = makeWorld();
  const ctx = makeCtx(w);
  ctx.mergeForwardAwaitingCheck = {
    site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED, fallbackDetail: { headSha: HEAD }, resolvedHead: RESOLVED,
  };
  const other = new ParkSignal('llm-transport-failed:DIAGNOSE', {});
  assert.equal(mf.mergeForwardCheckRedFallback(ctx, ctx.deps, other), other);
  assert.equal(w.calls.length, 0, 'no restore for a park it does not reroute');
  for (const r of ['diagnose-budget-exhausted', 'diagnose-no-new-cause', 'diagnose-duplicate-root-cause', 'diagnose-out-of-scope']) {
    ctx.mergeForwardAwaitingCheck = { site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED, fallbackDetail: {}, resolvedHead: RESOLVED };
    const out = mf.mergeForwardCheckRedFallback(ctx, ctx.deps, new ParkSignal(r, { attempt: 3 }));
    assert.equal(out.reason, 'gate-merge-refused');
    assert.equal(out.detail.mergeForward.underlying.reason, r);
    assert.equal(ctx.mergeForwardAwaitingCheck, null);
  }
  const none = new ParkSignal('diagnose-budget-exhausted', {});
  assert.equal(mf.mergeForwardCheckRedFallback(ctx, ctx.deps, none), none, 'no pending resolution -> untouched');
});

// ================================================================================================
// 4. `continue` still resumes from the fallback park
// ================================================================================================

test('continue: a fallback park is resumable -- continueEligibility accepts it, the comment offers `continue` and says a merge-forward was tried, and prepareResume passes on the restored tree', async () => {
  const w = makeWorld({ replies: [sessionDeclines()] });
  const ctx = makeCtx(w);
  const { park } = await drive(ctx, 'GATE', ['CI_CHECKS']);
  assert.equal(park.reason, 'gate-merge-refused');

  finalizePark(ctx, 'IMPLEMENT', park.reason, park.detail);
  const state = JSON.parse(fs.readFileSync(path.join(ctx.taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'gate-merge-refused');
  assert.deepEqual(continueEligibility(state, ctx.config), { eligible: true, why: null });

  const comment = buildParkComment({ reason: state.reason, detail: park.detail, lastState: 'IMPLEMENT', id: ctx.id, prNumber: 777 });
  assert.match(comment, /reply\s+"continue"/);
  assert.match(comment, /A merge-forward was tried/);
  assert.match(comment, /the session declined/);
  assert.match(comment, /back at `1111111111`/);

  // What a `continue` then runs first: every precondition holds on the restored tree.
  const resumeCtx = makeCtx(w, { taskDir: ctx.taskDir });
  resumeCtx.task.worktreePath = ctx.task.worktreePath;
  resumeCtx.config.pipelineWorktreesDir = ctx.config.pipelineWorktreesDir;
  await prepareResume(resumeCtx, resumeCtx.deps);
});

test('continue: a CI_CHECKS budget-spent park keeps today\'s shape (no abort) and stays resumable', async () => {
  const taskDir = mkTmp('spo-mf-ci-spent-');
  appendEvent(taskDir, 'CI_CHECKS', 'merge-forward-attempt', { site: 'CI_CHECKS', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED });
  const w = makeWorld({ gateExits: [] });
  const ctx = makeCtx(w, { site: 'CI_CHECKS', taskDir });
  await assert.rejects(
    () => HANDLERS.CI_CHECKS(ctx),
    (err) => err.reason === 'main-moved-merge-failed' && err.detail.exit === 1 && err.detail.mergeForward.outcome === 'budget-spent'
  );
  assert.ok(!w.calls.some((c) => has(c.args, 'merge', '--abort')), 'no abort without an attempt -- today\'s conflicted tree');
  assert.deepEqual(continueEligibility({ state: 'PARKED', reason: 'main-moved-merge-failed', prNumber: 777 }, ctx.config), { eligible: true, why: null });
});

// ================================================================================================
// 5. MERGE is unchanged: `merge-conflict`, no merge-forward
// ================================================================================================

test('MERGE: a conflicting re-gate merge still parks merge-conflict, with no merge-forward attempt, event or note', async () => {
  const w = makeWorld({ gateExits: [] });
  const ctx = makeCtx(w, { site: 'CI_CHECKS' });
  const base = spawnSyncFor(w);
  ctx.deps.spawnSync = (command, args) => {
    const a = args[0] === '-C' ? args.slice(2) : args;
    if (command === 'gh' && has(a, 'pr', 'merge')) return ok('');
    if (command === 'npm' && has(a, 'pr:wait')) return fail(1);
    if (command === 'gh' && has(a, 'pr', 'view')) return ok(JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
    if (command === 'git' && has(a, 'fetch')) return ok('');
    return base(command, args);
  };
  await assert.rejects(
    () => realMerge(ctx, ctx.deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict' && !('mergeForward' in err.detail)
  );
  assert.ok(w.calls.some((c) => c.command === 'git' && has(c.args, 'merge', 'origin/main')), 'the MERGE re-gate did try its merge');
  assert.equal(events(ctx.taskDir, 'merge-forward-attempt').length, 0);
  assert.equal(events(ctx.taskDir, 'merge-forward-skipped').length, 0);
  assert.equal(ctx.mergeForward, null);
  assert.equal(w.llmCalls, 0);
});

// ================================================================================================
// 6. each settle / offer condition on its own (the mutation check's targets)
// ================================================================================================

function settleCtx(w) {
  const ctx = makeCtx(w);
  const mfState = { site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED, conflictedCount: 2, fallbackDetail: { headSha: HEAD } };
  return { ctx, mfState };
}
function settleOutcome(w, payload = { ok: true }, stopReason = null) {
  const { ctx, mfState } = settleCtx(w);
  try {
    return { head: mf.settleMergeForward(ctx, ctx.deps, mfState, payload, stopReason), ctx };
  } catch (err) {
    if (!(err instanceof ParkSignal)) throw err;
    return { park: err, ctx };
  }
}
function mergedWorld(extra = {}) {
  return makeWorld({ mergeHead: MAIN, dirty: 'M  a\n', ...extra });
}

test('settleMergeForward: a staged merge is committed and accepted', () => {
  const w = mergedWorld();
  const { head, ctx } = settleOutcome(w);
  assert.equal(head, RESOLVED);
  assert.equal(events(ctx.taskDir, 'merge-forward-resolved').length, 1);
});

test('settleMergeForward: a merge the session already committed is accepted without a second commit', () => {
  const w = makeWorld({ head: RESOLVED, ancestors: new Set([HEAD, MAIN, RESOLVED]) });
  const { head } = settleOutcome(w);
  assert.equal(head, RESOLVED);
  assert.ok(!w.calls.some((c) => has(c.args, 'commit')));
});

test('settleMergeForward: a transport failure payload -> session-failed', () => {
  const { park } = settleOutcome(mergedWorld(), { ok: false, kind: 'error' });
  assert.equal(park.detail.mergeForward.outcome, 'session-failed');
});

test('settleMergeForward: unmerged paths -> unmerged-paths, listing them', () => {
  const { park } = settleOutcome(mergedWorld({ unmerged: [CONFLICTED[1]] }));
  assert.equal(park.detail.mergeForward.outcome, 'unmerged-paths');
  assert.deepEqual(park.detail.mergeForward.files, [CONFLICTED[1]]);
});

test('settleMergeForward: an `ls-files -u` that cannot run is not "nothing unmerged"', () => {
  const w = mergedWorld();
  const base = spawnSyncFor(w);
  const { ctx, mfState } = settleCtx(w);
  ctx.deps.spawnSync = (command, args) => (args.includes('ls-files') ? fail(128, 'fatal') : base(command, args));
  assert.throws(() => mf.settleMergeForward(ctx, ctx.deps, mfState, { ok: true }, null), (err) => err.detail.mergeForward.outcome === 'unmerged-paths' && err.detail.mergeForward.exit === 128);
});

test('settleMergeForward: a marker scan that cannot run (exit 128) is not a pass', () => {
  const w = mergedWorld();
  const base = spawnSyncFor(w);
  const { ctx, mfState } = settleCtx(w);
  ctx.deps.spawnSync = (command, args) => (args.includes('grep') ? fail(128, 'fatal') : base(command, args));
  assert.throws(() => mf.settleMergeForward(ctx, ctx.deps, mfState, { ok: true }, null), (err) => err.detail.mergeForward.outcome === 'markers-left' && err.detail.mergeForward.exit === 128);
});

test('settleMergeForward: the pipeline\'s own commit failing -> commit-failed', () => {
  const { park } = settleOutcome(mergedWorld({ commitNoEditExit: 1 }));
  assert.equal(park.detail.mergeForward.outcome, 'commit-failed');
});

test('settleMergeForward: HEAD left detached -> not-merged (onBranch false)', () => {
  const { park } = settleOutcome(mergedWorld({ detached: true }));
  assert.equal(park.detail.mergeForward.outcome, 'not-merged');
  assert.equal(park.detail.mergeForward.onBranch, false);
});

test('settleMergeForward: the card\'s own head dropped from history -> not-merged (headKept false)', () => {
  const w = makeWorld({ head: RESOLVED, ancestors: new Set([MAIN, RESOLVED]) });
  const { park } = settleOutcome(w);
  assert.equal(park.detail.mergeForward.outcome, 'not-merged');
  assert.equal(park.detail.mergeForward.headKept, false);
  assert.equal(park.detail.mergeForward.mainMerged, true);
});

test('settleMergeForward: an unreadable resolved HEAD -> not-merged', () => {
  const w = mergedWorld();
  const base = spawnSyncFor(w);
  const { ctx, mfState } = settleCtx(w);
  ctx.deps.spawnSync = (command, args) => {
    const a = args.slice(2);
    if (a[0] === 'rev-parse' && a.length === 2 && a[1] === 'HEAD') return { status: 128, stdout: 'HEAD\n', stderr: '', signal: null };
    return base(command, args);
  };
  assert.throws(() => mf.settleMergeForward(ctx, ctx.deps, mfState, { ok: true }, null), (err) => err.detail.mergeForward.outcome === 'not-merged');
});

test('handleMergeForwardImplement: a park thrown during the session call (no account can run it) -> session-failed fallback, tree restored', async () => {
  const w = makeWorld({ replies: [] });
  const ctx = makeCtx(w, { config: { claudeAccountsDir: mkTmp('spo-mf-noaccts-') } });
  ctx.mergeForward = { site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED, conflictedCount: 2, fallbackDetail: { headSha: HEAD } };
  await assert.rejects(
    () => HANDLERS.IMPLEMENT(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'gate-merge-refused' && err.detail.mergeForward.outcome === 'session-failed' && typeof err.detail.mergeForward.reason === 'string'
  );
  assert.equal(ctx.mergeForward, null, 'consumed whatever happened');
  assertRestored(w);
});

test('offerMergeForward: a merge that failed without conflicted files is not an attempt -- today\'s detail, byte for byte', () => {
  const w = makeWorld();
  const ctx = makeCtx(w);
  const detail = { headSha: HEAD, mergeExit: 128, jobId: null, refusalConfirmed: false, testsRan: false, gatePassedOnSha: false };
  const offer = mf.offerMergeForward(ctx, ctx.deps, { site: 'GATE', worktreePath: ctx.task.worktreePath, headSha: HEAD, mainSha: MAIN, conflictedFiles: [], mergeAborted: true, fallbackDetail: detail });
  assert.deepEqual(offer, { parkDetail: detail });
  assert.equal(events(ctx.taskDir, 'merge-forward-skipped')[0].why, 'no-conflicted-files');
});

test('offerMergeForward: GATE\'s origin/main rev-parse failed (even with a sha on stdout) -> main-sha-unknown, no attempt', async () => {
  const w = makeWorld({ mainRevParseExit: 128 });
  const ctx = makeCtx(w);
  await assert.rejects(() => HANDLERS.GATE(ctx), (err) => err.reason === 'gate-merge-refused' && !err.detail.mergeForward);
  assert.equal(events(ctx.taskDir, 'merge-forward-skipped')[0].why, 'main-sha-unknown');
  assert.equal(events(ctx.taskDir, 'merge-forward-attempt').length, 0);
});

for (const [label, patch] of [
  ['the abort failed (MERGE_HEAD still set)', { abortExit: 1 }],
  ['the tree is dirty after the abort', { dirty: ' M stray.txt\n' }],
]) {
  test(`offerMergeForward: ${label} -> tree-not-clean, today's park, no attempt`, async () => {
    const w = makeWorld(patch);
    const ctx = makeCtx(w);
    await assert.rejects(() => HANDLERS.GATE(ctx), (err) => err.reason === 'gate-merge-refused' && !err.detail.mergeForward);
    assert.equal(events(ctx.taskDir, 'merge-forward-skipped')[0].why, 'tree-not-clean');
    assert.equal(events(ctx.taskDir, 'merge-forward-attempt').length, 0);
  });
}

test('offerMergeForward: an unreadable git status after the abort is not "known clean"', () => {
  const w = makeWorld();
  const base = spawnSyncFor(w);
  const ctx = makeCtx(w);
  ctx.deps.spawnSync = (command, args) => (args.includes('status') ? fail(128) : base(command, args));
  const offer = mf.offerMergeForward(ctx, ctx.deps, { site: 'GATE', worktreePath: ctx.task.worktreePath, headSha: HEAD, mainSha: MAIN, conflictedFiles: CONFLICTED, mergeAborted: true, fallbackDetail: {} });
  assert.ok(offer.parkDetail);
});

test('offerMergeForward at CI_CHECKS aborts the conflicted merge itself before offering', () => {
  const w = makeWorld({ mergeHead: MAIN, unmerged: [...CONFLICTED] });
  const ctx = makeCtx(w, { site: 'CI_CHECKS' });
  const offer = mf.offerMergeForward(ctx, ctx.deps, { site: 'CI_CHECKS', worktreePath: ctx.task.worktreePath, headSha: HEAD, mainSha: MAIN, conflictedFiles: CONFLICTED, mergeAborted: false, fallbackDetail: { exit: 1 } });
  assert.deepEqual(offer, { next: 'IMPLEMENT' });
  assert.equal(w.mergeHead, null);
  assert.equal(ctx.mergeForward.site, 'CI_CHECKS');
});

// ================================================================================================
// 7. the prompt, the diagnosis source, the effort, and the park comment
// ================================================================================================

test('IMPLEMENT\'s {{diagnosis}} is the MERGE-FORWARD source while an attempt is pending, and the filled prompt carries the § MERGE-FORWARD instructions', () => {
  const w = makeWorld();
  const ctx = makeCtx(w);
  assert.match(buildPromptValues(ctx, 'IMPLEMENT').diagnosis, /^\(none yet/);
  ctx.mergeForward = { site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED, conflictedCount: 2, fallbackDetail: {} };
  const values = buildPromptValues(ctx, 'IMPLEMENT');
  assert.match(values.diagnosis, /^MERGE-FORWARD /);
  assert.ok(values.diagnosis.includes(`git merge --no-ff --no-commit ${MAIN}`));
  assert.ok(values.diagnosis.includes(CONFLICTED.join(', ')));
  const prompt = fillPromptTemplate(path.join(__dirname, '..', 'prompts', 'implement.md'), values);
  for (const needle of ['## MERGE-FORWARD', "keeps both sides' intent", 'Change only what the merge requires', 'npm run typecheck', 'stop_reason']) {
    assert.ok(prompt.includes(needle), `prompt lacks ${needle}`);
  }
});

test('mergeForwardDiagnosis: more conflicted files than the cap are counted, not dropped silently', () => {
  const text = mf.mergeForwardDiagnosis({ site: 'CI_CHECKS', mainSha: MAIN, headSha: HEAD, conflictedFiles: ['a', 'b'], conflictedCount: 5 });
  assert.match(text, /a, b \(and 3 more\)/);
  assert.match(text, /found at CI_CHECKS/);
});

test('the merge-forward session runs on IMPLEMENT\'s model at its re-entry effort (trigger 4, medium on an S card); the next ordinary IMPLEMENT is back at low', async () => {
  const w = makeWorld({
    replies: [sessionResolves(), { effect: (x) => (x.dirty = ' M src/x.ts\n'), reply: RESOLVED_REPLY }],
  });
  const ctx = makeCtx(w);
  ctx.mergeForward = { site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED, conflictedCount: 2, fallbackDetail: {} };
  assert.equal(await HANDLERS.IMPLEMENT(ctx), 'CHECK');
  assert.equal(await HANDLERS.IMPLEMENT(ctx), 'CHECK'); // an ordinary pass now: ctx.mergeForward was consumed
  const calls = events(ctx.taskDir, 'llm-call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, calls[1].model, 'same model as an ordinary IMPLEMENT');
  assert.equal(calls[0].effort, 'medium');
  assert.equal(calls[1].effort, 'low');
});

test('buildParkComment: the merge-forward line appears only with a tried note; budget-spent has its own wording; a park without the note is unchanged', () => {
  const base = { reason: 'gate-merge-refused', lastState: 'GATE', id: 'mf-card', prNumber: 777 };
  const plainDetail = { headSha: HEAD, testsRan: false, gatePassedOnSha: false };
  const plain = buildParkComment({ ...base, detail: plainDetail });
  assert.ok(!/merge-forward/i.test(plain));

  const spent = buildParkComment({ ...base, detail: { ...plainDetail, mergeForward: { tried: true, site: 'GATE', outcome: 'budget-spent' } } });
  assert.match(spent, /A merge-forward was already tried/);

  const red = buildParkComment({ ...base, detail: { ...plainDetail, mergeForward: { tried: true, site: 'GATE', outcome: 'check-red', mainSha: MAIN, headSha: HEAD, restored: false } } });
  assert.match(red, /CHECK stayed red/);
  assert.match(red, /Restoring the branch afterwards failed/);

  const odd = buildParkComment({ ...base, detail: { ...plainDetail, mergeForward: { tried: true, outcome: 'something-new', mainSha: MAIN, headSha: HEAD } } });
  assert.match(odd, /outcome `something-new`/);
});

test('restoreBeforeMergeForward: a failing step is journalled, stops the restore, and the park still says so', () => {
  const w = makeWorld({ mergeHead: MAIN });
  const base = spawnSyncFor(w);
  const ctx = makeCtx(w);
  ctx.deps.spawnSync = (command, args) => (args.includes('reset') ? fail(1, 'locked') : base(command, args));
  const mfState = { site: 'GATE', mainSha: MAIN, headSha: HEAD, conflictedFiles: CONFLICTED, fallbackDetail: {} };
  const park = mf.mergeForwardFallback(ctx, ctx.deps, mfState, 'IMPLEMENT', 'declined', {});
  assert.equal(park.detail.mergeForward.restored, false);
  const failed = events(ctx.taskDir, 'merge-forward-restore-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].step, 'reset');
  assert.ok(!w.calls.some((c) => has(c.args, 'clean')), 'the restore stops at the failed step');
});
