'use strict';
// Tests for card #178 (phantom park): finalizePark's two re-enqueue branches (transient-retry,
// pool-wait) used to journal a `parked` line immediately before their own retry/wait event, on a
// card that was never actually parked -- it was re-enqueued and comes back around through
// takeNextTask. The fix (orchestrator/state-machine.js's finalizePark) deletes both emits; the
// `transient-retry`/`pool-wait` events that already followed them name the re-enqueue with its own
// attempt, delay and `notBefore` and are the correct, sufficient record of the re-enqueue.
//
// This file exercises the two readers the phantom line actually corrupted, each measured to have
// been WRONG under the old code:
//   - countRepeatedParks (park-loop.js), called from finalizePark itself right after the one real
//     `parked` line -- a phantom line inflated the streak, firing `park-repeat` on a card's
//     first-ever real park (T-A).
//   - decidePlanReuse (state-machine.js), which reads the MOST RECENT `parked` event to decide
//     whether a plan on disk is still safe to reuse -- a phantom line from an unrelated re-enqueue
//     could shadow an earlier, genuinely plan-invalidating park and flip that verdict from refuse
//     (null) to reuse (T-B).
// Plus a direct per-path check (T-C) and a regression guard for the unrelated #119 cap-sink branch
// that must be completely unaffected by this fix (T-D).
//
// Same conventions as test/transient-retry.test.js and test/pool-exhaustion-wait.test.js: tmp
// queue/journal dirs, an injected deps.spawnSync, nothing here touches a real git/npm/gh/claude
// process.
require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildCtx, finalizePark, takeNextTask, HANDLERS } = require('../orchestrator/state-machine');
const { countRepeatedParks } = require('../orchestrator/park-loop');
const { appendEvent } = require('../orchestrator/journal');
const { mkTmp, writePoolDir } = require('./helpers');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

// Hardcoded rather than read from orchestrator/config.js -- same reasoning
// test/transient-retry.test.js's own testConfig() gives: a test pinned to the ACTION'S OWN stated
// numbers catches a regression in config.js's defaults instead of silently tracking drift.
function testConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-phantom-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-phantom-bench-'),
    stepDeadlineMs: 30000,
    claudeAccountsDir: mkTmp('spo-phantom-accts-'),
    transientRetryBudget: 2,
    transientRetryDelaysMs: [60000, 300000],
    queueDir: mkTmp('spo-phantom-queue-'),
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

function queuedFiles(queueDir) {
  return fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
}

function readState(taskDir) {
  const p = path.join(taskDir, 'state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// ==== T-A: the count -- two transient re-enqueues then one genuine park must count as ONE =======
//
// Drives the REAL production round trip: finalizePark's own reEnqueueTask write, taken back by
// the REAL takeNextTask (the value it writes and reads back, not a hand-built ctx.task field), for
// two attempts, then a third call where the budget (config.transientRetryBudget = 2) is exhausted
// and finalizePark falls through to the ordinary park -- same reason, byte-identical detail, all
// the way through.
test('T-A: two transient re-enqueues then one genuine park (budget exhausted, production round trip) -> countRepeatedParks is 1, no park-repeat', () => {
  // delaysMs: [0, 0] -- zero backoff, not the production 60s/300s -- so each re-enqueued entry's
  // `notBefore` is immediately eligible for the very next takeNextTask call in this same test tick
  // (isQueueEntryEligibleNow: `!(notBeforeMs > nowMs)`). The BUDGET (transientRetryBudget: 2,
  // ctx.task.transientRetries 0 -> 1 -> 2) is what this test drives for real and pins; the delay
  // table is orthogonal to it and only ever gets in the way of taking the entry back out here.
  const config = testConfig({ transientRetryDelaysMs: [0, 0] });
  const journalRoot = mkTmp('spo-phantom-ta-journal-');
  const id = 'card-1';
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  const reason = 'claim-rate-limited';
  const detail = { exit: 4 };

  function ctxFor(task) {
    return buildCtx(id, { id, kind: 'card', issue: 1, title: 'x', ...task }, taskDir, {
      ...config,
      deps: { spawnSync: () => ok('') },
    });
  }

  // Attempt 1: transientRetries absent (0) -> re-enqueued, queue entry carries transientRetries:1.
  finalizePark(ctxFor({}), 'WORKTREE', reason, detail);
  let taken = takeNextTask(config.queueDir, journalRoot);
  assert.ok(taken, 'attempt 1 must have produced a takeable re-enqueued entry');
  assert.equal(taken.task.transientRetries, 1, 'the value reEnqueueTask writes and takeNextTask reads back');

  // Attempt 2: transientRetries:1 (read back from the queue, not hand-built) -> re-enqueued again,
  // queue entry now carries transientRetries:2.
  finalizePark(ctxFor(taken.task), 'WORKTREE', reason, detail);
  taken = takeNextTask(config.queueDir, journalRoot);
  assert.ok(taken, 'attempt 2 must have produced a takeable re-enqueued entry');
  assert.equal(taken.task.transientRetries, 2);

  // Attempt 3: transientRetries:2 === transientRetryBudget -> budget exhausted (`priorRetries <
  // budget` is false) -> falls through to the ordinary park. This is the ONE real park.
  finalizePark(ctxFor(taken.task), 'WORKTREE', reason, detail);

  const journal = readJournal(taskDir);
  const parkedEvents = journal.filter((e) => e.event === 'parked');
  assert.equal(parkedEvents.length, 1, 'exactly one parked line across the whole sequence -- the two re-enqueues journalled none');
  assert.equal(parkedEvents[0].reason, reason);
  assert.deepEqual(parkedEvents[0].detail, detail);

  assert.ok(!journal.some((e) => e.event === 'park-repeat'), 'a card\'s first-ever real park must never fire park-repeat');

  // The tautology trap: do NOT derive the expected count from the journal's own `parked` lines
  // (self-consistent under both the fixed and the broken code -- under the mutation there would
  // be 3 `parked` lines and a query built from THEM would also return 3). Pin the literal `1`
  // independently, with a query built from this test's own `reason`/`detail`, exactly as
  // finalizePark's own countRepeatedParks call is made.
  const count = countRepeatedParks(journal, reason, detail);
  assert.equal(count, 1, 'countRepeatedParks must not be inflated by phantom parked lines from the two re-enqueues');
});

// ==== T-B: decidePlanReuse must reach the SAME verdict whether or not a re-enqueue intervened ===
//
// decidePlanReuse is not exported -- reached the same way test/plan-resume.test.js's own
// INVALIDATING_REASONS loop reaches it: through HANDLERS.PLAN, counting whether callLlmStep's
// injected spawnSync was invoked (reuse skips it entirely; a normal run calls it exactly once).

function planReplyEnvelope(planPayload) {
  return {
    status: 0,
    stdout: JSON.stringify({
      result: JSON.stringify(planPayload),
      is_error: false,
      num_turns: 1,
      session_id: 'sess-phantom-park',
      modelUsage: { 'claude-fable-5': { costUSD: 0.001 } },
      terminal_reason: 'success',
      api_error_status: null,
    }),
    stderr: '',
    signal: null,
  };
}

function validPlanPayload() {
  return {
    ok: true,
    plan_markdown: '# Plan\n\nDo the thing.\n',
    invariants_markdown: '# Invariants\n\nINV-9: ...\n',
    invariant_ids: ['INV-9'],
    check_commands: ['npm run typecheck'],
  };
}

function countingSpawn(reply) {
  function spy() {
    spy.callCount += 1;
    return reply;
  }
  spy.callCount = 0;
  return spy;
}

// Journals a PLAN 'files-written' + 'result' pair, and writes non-empty plan/invariants files to
// disk -- the on-disk half of decidePlanReuse's conditions 2-5, matching
// test/plan-resume.test.js's own priorPlanRun. Then journals a REAL, genuinely plan-invalidating
// park (condition 6) on top -- the fixture every scenario below starts from.
function setupInvalidatingParkFixture(baseMainSha) {
  const taskDir = mkTmp('spo-phantom-tb-taskdir-');
  const dir = path.join(taskDir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan.md');
  const invariantsPath = path.join(dir, 'invariants.md');
  fs.writeFileSync(planPath, '# Plan\n\nDo the thing.\n');
  fs.writeFileSync(invariantsPath, '# Invariants\n\nINV-1: ...\n');

  const payload = {
    ok: true,
    plan_path: planPath,
    invariants_path: invariantsPath,
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
  };
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha });
  appendEvent(taskDir, 'PLAN', 'result', { payload });
  // The real park (condition 6): 'diagnose-budget-exhausted' is on PLAN_INVALIDATING_PARK_REASONS
  // (state-machine.js, action 3.1/F3) -- reusing the plan that produced it would spend a whole
  // remediation cycle to arrive at the identical park.
  appendEvent(taskDir, 'DIAGNOSE', 'parked', { reason: 'diagnose-budget-exhausted', detail: {} });
  return taskDir;
}

async function decidePlanReuseVerdict(taskDir, baseMainSha, accountsDir) {
  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const worktreePath = mkTmp('spo-phantom-tb-wt-');
  const task = { id: 'card-900', kind: 'card', issue: 900, title: 'x', criterion: 'x', size: 'S', baseMainSha, worktreePath };
  const ctx = buildCtx(task.id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
    deps: { spawnSync },
  });
  const next = await HANDLERS.PLAN(ctx);
  return { next, llmCallCount: spawnSync.callCount };
}

test('T-B: decidePlanReuse reaches the SAME verdict (refuse) before and after a transient re-enqueue that does not park', async () => {
  const baseMainSha = 'sha-X';
  const accountsDir = mkTmp('spo-phantom-tb-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);

  // "Before": the invalidating park is the only park on record. decidePlanReuse's condition 6
  // must refuse reuse -> handlePlan runs PLAN normally -> the LLM step is invoked exactly once.
  const taskDirBefore = setupInvalidatingParkFixture(baseMainSha);
  const before = await decidePlanReuseVerdict(taskDirBefore, baseMainSha, accountsDir);
  assert.equal(before.next, 'IMPLEMENT');
  assert.equal(before.llmCallCount, 1, 'reuse must be refused -- PLAN runs normally, LLM invoked once');

  // "After": an otherwise-identical fixture, but with a transient re-enqueue (finalizePark on an
  // ALLOWLISTED, non-invalidating reason) driven through the REAL finalizePark on top of the same
  // invalidating park. Under the card #178 defect, finalizePark's transient-retry branch would
  // journal a phantom `parked { reason: 'claim-rate-limited' }` line AFTER the invalidating park --
  // 'claim-rate-limited' is NOT on PLAN_INVALIDATING_PARK_REASONS, so decidePlanReuse's condition 6
  // (which reads only the MOST RECENT `parked` event) would then see a non-invalidating park last
  // and flip the verdict to reuse. The fix removes that phantom line, so the most recent `parked`
  // event stays the real, invalidating one from the fixture, and the verdict must not move.
  const taskDirAfter = setupInvalidatingParkFixture(baseMainSha);
  const reEnqueueConfig = testConfig();
  const reEnqueueCtx = buildCtx('card-900', { id: 'card-900', kind: 'card', issue: 900, title: 'x' }, taskDirAfter, {
    ...reEnqueueConfig,
    deps: { spawnSync: () => ok('') },
  });
  finalizePark(reEnqueueCtx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });
  assert.ok(
    readJournal(taskDirAfter).some((e) => e.event === 'transient-retry'),
    'sanity: the re-enqueue must actually have succeeded, or this test proves nothing'
  );

  const after = await decidePlanReuseVerdict(taskDirAfter, baseMainSha, accountsDir);
  assert.equal(after.next, 'IMPLEMENT');
  assert.equal(
    after.llmCallCount,
    1,
    'reuse must STILL be refused after the re-enqueue -- the same verdict as before it, not flipped by a phantom parked line'
  );
});

// ==== T-C: both re-enqueue paths journal no `parked` line, driving the real finalizePark ========

test('T-C: the transient-retry re-enqueue path journals no `parked` line', () => {
  const config = testConfig();
  const journalRoot = mkTmp('spo-phantom-tc-trans-journal-');
  const taskDir = path.join(journalRoot, 'card-1');
  fs.mkdirSync(taskDir, { recursive: true });
  const ctx = buildCtx('card-1', { id: 'card-1', kind: 'card', issue: 1, title: 'x' }, taskDir, {
    ...config,
    deps: { spawnSync: () => ok('') },
  });

  finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'transient-retry'), 'sanity: this really is the transient-retry re-enqueue path');
  assert.ok(!journal.some((e) => e.event === 'parked'), 'no parked line -- the card was re-enqueued, not parked');
  assert.equal(readState(taskDir), null, 'and no state.json either');
});

test('T-C: the pool-wait re-enqueue path journals no `parked` line', () => {
  const config = testConfig({ poolExhaustionWaitCapMs: 12 * 60 * 60 * 1000 });
  const journalRoot = mkTmp('spo-phantom-tc-pool-journal-');
  const taskDir = path.join(journalRoot, 'card-1');
  fs.mkdirSync(taskDir, { recursive: true });
  const ctx = buildCtx('card-1', { id: 'card-1', kind: 'card', issue: 1, title: 'x' }, taskDir, {
    ...config,
    deps: { spawnSync: () => ok('') },
  });

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() });

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'pool-wait'), 'sanity: this really is the pool-wait re-enqueue path');
  assert.ok(!journal.some((e) => e.event === 'parked'), 'no parked line -- the card was re-enqueued, not parked');
  assert.equal(readState(taskDir), null, 'and no state.json either');
});

// ==== T-D: the #119 cap-sink guard is unaffected -- still a real park, still exactly one line ====
//
// poolCooldownDeadlineMs returns null for 'all-accounts-cooling-wait-cap-exceeded' by NAME, before
// either detail key is read (its own header comment), and the pool branch is gated on that at
// state-machine.js:2494-2497 (`if (isRealMode(ctx) && isAccountPoolParkReason(reason))`, the
// `poolCooldownDeadlineMs(reason, detail)` call, and `if (deadlineMs !== null && ...)` -- the
// three checks this sentence names. Re-pinned from :2333-2335, which cited the block's own
// header COMMENT above the gate, not the gate itself -- card #174 added lines to handleValidate's
// REJECT branch above this point, unrelated to the mis-citation) -- strictly BEFORE the
// deleted :2420 emit. So a finalizePark call with
// this reason must never reach the pool branch's re-enqueue at all, regardless of whether the
// detail carries a live, future deadline -- it must fall straight through to the ordinary park,
// exactly as before this fix. The cap is set explicitly: without it `cap` resolves to 0, the
// cap-exceeded `else` catches this call regardless, and the test would pass even with the by-name
// guard removed.
test('T-D: all-accounts-cooling-wait-cap-exceeded with a live future deadline in detail still writes no queue entry and parks for real -- exactly one `parked` line', () => {
  const config = testConfig({ poolExhaustionWaitCapMs: 12 * 60 * 60 * 1000 });
  const journalRoot = mkTmp('spo-phantom-td-journal-');
  const taskDir = path.join(journalRoot, 'card-1');
  fs.mkdirSync(taskDir, { recursive: true });
  const ctx = buildCtx('card-1', { id: 'card-1', kind: 'card', issue: 1, title: 'x' }, taskDir, {
    ...config,
    deps: { spawnSync: () => ok('') },
  });
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-wait-cap-exceeded', {
    cooldownUntilIso: futureIso,
    accumulatedWaitMs: 13 * 60 * 60 * 1000,
    poolWaitAttempts: 3,
    capMs: config.poolExhaustionWaitCapMs || 0,
    originalReason: 'all-accounts-cooling-after-retry',
  });

  assert.equal(queuedFiles(config.queueDir).length, 0, 'no queue entry must ever be written for this reason');
  const state = readState(taskDir);
  assert.equal(state && state.state, 'PARKED', 'must be a real park -- state.json written');
  assert.equal(state.reason, 'all-accounts-cooling-wait-cap-exceeded');

  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'pool-wait'), 'the wait branch must never fire for this reason');
  assert.equal(journal.filter((e) => e.event === 'parked').length, 1, 'exactly one parked line, unaffected by the re-enqueue emit removal');
});
