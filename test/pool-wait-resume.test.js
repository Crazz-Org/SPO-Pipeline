'use strict';
// pool-wait-resume.test.js -- card SPO-Pipeline#251: a pool-wait in VALIDATE (CITATION_VERIFIER
// runs inside it) with a PR open re-enqueues with a machine `resume` descriptor, so the wake-up
// goes through card #212's resume-at-CHECK path instead of the INTAKE restart. The INTAKE restart
// closed the green PR and re-ran IMPLEMENT on every cooldown probe (#887/#888/#894). A pool-wait
// anywhere else (PLAN, IMPLEMENT before or after a PR, DIAGNOSE) keeps the INTAKE restart. A
// machine resume carries ctx.counters. poolWaitMs/poolWaitAttempts keep accumulating across
// resumed wake-ups. A machine resume that prepareResume refuses falls back to the INTAKE restart,
// journalled, instead of parking.
//
// Part 1 is finalizePark-level, same conventions as test/pool-exhaustion-wait.test.js. Part 2
// drives runTask's restore. Part 3 severs the dispatch: it replays #888's own shape (a VALIDATE
// REJECT, then a Fable-cooling VALIDATE with the PR open) end to end through drainQueueOnce ->
// takeNextTask -> runTask -> finalizePark -> the queue entry -> the next drainQueueOnce, with
// every git/gh/npm spawn and the claude call faked. It asserts what production actually does on
// each wake-up, not what a helper returns. Part 5 (cards #255/#279) replays a maintainer's
// `continue` the same way, through the real unparkScan: re-enqueued out of IMPLEMENT, it wakes up
// AT IMPLEMENT (#279, option B). Part 6 (card #281): a machine re-enqueue keeps the run's own tree
// at CHECK too, a refusal after a kept tree preserves it and re-attaches the branch, and the
// descriptor discriminator is pinned writer by writer.
require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildCtx,
  finalizePark,
  runTask,
  drainQueueOnce,
  POOL_WAIT_RESUME_STATES,
  RESUME_COUNTER_MAX,
  resumeValidationError,
  isMachineReEnqueueResume,
} = require('../orchestrator/state-machine');
const accounts = require('../orchestrator/accounts');
const { unparkScan } = require('../orchestrator/park-loop');
const { appendEvent, writeState } = require('../orchestrator/journal');
const { validateRejectBudget: PRODUCTION_VALIDATE_REJECT_BUDGET } = require('../orchestrator/config');
const { mkTmp, writePoolDir, fakeSpawnedChild } = require('./helpers');

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

function queuedFiles(queueDir) {
  return fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).sort() : [];
}

function readOnlyQueued(queueDir) {
  const files = queuedFiles(queueDir);
  assert.equal(files.length, 1, `expected exactly one queue entry, found ${JSON.stringify(files)}`);
  return JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8'));
}

// ================================================================================================
// ---- part 1: finalizePark decides which pool-waits resume -------------------------------------
// ================================================================================================

function parkConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-pwr-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-pwr-bench-'),
    stepDeadlineMs: 30000,
    claudeAccountsDir: mkTmp('spo-pwr-accts-'),
    transientRetryBudget: 2,
    transientRetryDelaysMs: [60000, 300000],
    poolExhaustionWaitCapMs: 12 * 60 * 60 * 1000,
    queueDir: mkTmp('spo-pwr-queue-'),
    ...overrides,
  };
}

// A ctx as it stands when a pool ParkSignal reaches finalizePark mid-run: worktree created by
// WORKTREE, PR number set by PUSH_PR (when `prNumber` is given).
function midRunCtx({ id = 'issue-888', config, prNumber = null, task = {} } = {}) {
  const journalRoot = mkTmp('spo-pwr-journal-');
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  const ctx = buildCtx(id, { id, kind: 'card', issue: 888, title: 'x', ...task }, taskDir, {
    ...config,
    deps: { spawnSync: () => ok('') },
  });
  ctx.task.worktreePath = ctx.task.worktreePath || path.join(config.pipelineWorktreesDir, id);
  ctx.prNumber = prNumber;
  return ctx;
}

// #888's own first pool-wait (journal line 102, 2026-09-16T12:35:10.676Z), moved into the future
// so it still has a deadline to wait for: `all-accounts-cooling-until-<ISO>`, detail
// {earliestCooldownUntil, checkedAccounts}, deadlineSource earliestCooldownUntil.
function coolingPark(minutes = 51) {
  const deadlineMs = Date.now() + minutes * 60 * 1000;
  return {
    reason: `all-accounts-cooling-until-${new Date(deadlineMs).toISOString()}`,
    detail: { earliestCooldownUntil: deadlineMs, checkedAccounts: ['pool1', 'pool2'] },
  };
}

test('POOL_WAIT_RESUME_STATES is exactly {VALIDATE} -- PLAN/IMPLEMENT/DIAGNOSE never resume', () => {
  assert.deepEqual([...POOL_WAIT_RESUME_STATES], ['VALIDATE']);
});

test('finalizePark: a VALIDATE pool-wait with a PR open re-enqueues a machine resume at CHECK, carrying the live prNumber, the worktree, and every counter but mainMoveUsed', () => {
  const config = parkConfig();
  const ctx = midRunCtx({ config, prNumber: 891 });
  // #888's first cycle: one change-validator REJECT before the cooling VALIDATE.
  ctx.counters.validateRejects = 1;
  ctx.counters.diagnoseAttempts = 2;
  ctx.counters.ciImplementRetries = 1;
  ctx.counters.mainMoveUsed = 1; // per wake-up, never carried -- see the main-move tests below
  ctx.counters.seenRootCauses.add('cause-a');
  const { reason, detail } = coolingPark();

  finalizePark(ctx, 'VALIDATE', reason, detail);

  const requeued = readOnlyQueued(config.queueDir);
  assert.deepEqual(requeued.resume, {
    startState: 'CHECK',
    prNumber: 891,
    worktreePath: path.join(config.pipelineWorktreesDir, 'issue-888'),
    fromReason: reason,
    source: 'pool-wait',
    counters: { diagnoseAttempts: 2, validateRejects: 1, ciImplementRetries: 1, seenRootCauses: ['cause-a'] },
  });
  assert.equal(requeued.poolWaitAttempts, 1);
  assert.ok(requeued.poolWaitMs > 0);
  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'pool-wait');
  assert.ok(evt, 'the ordinary pool-wait event is still journalled');
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'parked'), 'a resume is still a re-enqueue, never a park');
});

// The INTAKE restart stays for every other state, PR or not -- the work those steps produce is
// still pending, and resuming at CHECK would skip it.
for (const [lastState, prNumber, label] of [
  ['PLAN', null, 'PLAN (no PR yet)'],
  ['IMPLEMENT', null, 'IMPLEMENT before a PR exists'],
  ['IMPLEMENT', 891, 'IMPLEMENT after a PR exists (a VALIDATE-reject or CI retry)'],
  ['DIAGNOSE', 891, 'DIAGNOSE with a PR open'],
  ['VALIDATE', null, 'VALIDATE with no PR on record (defensive)'],
]) {
  test(`finalizePark: a pool-wait at ${label} carries NO resume -- the wake-up restarts at INTAKE`, () => {
    const config = parkConfig();
    const ctx = midRunCtx({ config, prNumber });
    ctx.counters.validateRejects = 1;
    const { reason, detail } = coolingPark();

    finalizePark(ctx, lastState, reason, detail);

    const requeued = readOnlyQueued(config.queueDir);
    assert.equal(requeued.resume, undefined, `a ${lastState} pool-wait must not resume`);
    assert.equal(requeued.poolWaitAttempts, 1, 'it is still a pool-wait');
  });
}

// A run that is ITSELF a machine resume can reach IMPLEMENT/DIAGNOSE again (a VALIDATE REJECT, a
// CI failure). A pool-wait or transient retry there must restart at INTAKE like any other run.
// Carrying the machine descriptor forward (#212 C4's carriedResume rule) would wake the card at
// CHECK and skip the IMPLEMENT it is waiting to run.
function machineResumedCtx(config, lastPrNumber = 891) {
  const resume = {
    startState: 'CHECK',
    prNumber: lastPrNumber,
    worktreePath: path.join(config.pipelineWorktreesDir, 'issue-888'),
    fromReason: 'all-accounts-cooling-until-2026-09-16T13:26:13.792Z',
    source: 'pool-wait',
    counters: { diagnoseAttempts: 0, validateRejects: 1, ciImplementRetries: 0, seenRootCauses: [] },
  };
  const ctx = midRunCtx({ config, prNumber: lastPrNumber, task: { resume, poolWaitMs: 3063116, poolWaitAttempts: 1 } });
  ctx.counters.validateRejects = 2;
  return ctx;
}

for (const lastState of ['IMPLEMENT', 'DIAGNOSE']) {
  test(`finalizePark: a machine-RESUMED run that pool-waits at ${lastState} drops the resume -- INTAKE restart, never CHECK`, () => {
    const config = parkConfig();
    const ctx = machineResumedCtx(config);
    const { reason, detail } = coolingPark();

    finalizePark(ctx, lastState, reason, detail);

    const requeued = readOnlyQueued(config.queueDir);
    assert.equal(requeued.resume, undefined);
    assert.equal(requeued.poolWaitAttempts, 2, 'still the same accumulating pool-wait');
  });
}

test('finalizePark: a machine-RESUMED run that pool-waits at VALIDATE again gets a FRESH machine descriptor -- current reason, counters and PR', () => {
  const config = parkConfig();
  const ctx = machineResumedCtx(config);
  ctx.prNumber = 893; // PUSH_PR journalled pr-number-changed
  const { reason, detail } = coolingPark();

  finalizePark(ctx, 'VALIDATE', reason, detail);

  const requeued = readOnlyQueued(config.queueDir);
  assert.equal(requeued.resume.source, 'pool-wait');
  assert.equal(requeued.resume.fromReason, reason, 'the reason of THIS wait, not the first one');
  assert.equal(requeued.resume.prNumber, 893);
  assert.equal(requeued.resume.counters.validateRejects, 2);
});

test('finalizePark: a machine-RESUMED run takes a transient retry -- at IMPLEMENT the resume is dropped; at GATE it is carried with the counters', () => {
  for (const [lastState, reason, expectResume] of [
    ['IMPLEMENT', 'llm-transport-failed:IMPLEMENT', false],
    ['GATE', 'gate-non-attesting', true],
  ]) {
    const config = parkConfig();
    const ctx = machineResumedCtx(config);
    finalizePark(ctx, lastState, reason, {});
    const requeued = readOnlyQueued(config.queueDir);
    assert.equal(requeued.transientRetries, 1, `${lastState}: a transient retry`);
    if (expectResume) {
      assert.equal(requeued.resume.source, 'pool-wait', `${lastState}: the machine descriptor is carried`);
      assert.equal(requeued.resume.counters.validateRejects, 2, `${lastState}: with the run's current counters`);
    } else {
      assert.equal(requeued.resume, undefined, `${lastState}: resuming at CHECK would skip IMPLEMENT`);
    }
    assert.equal(requeued.poolWaitMs, 3063116, `${lastState}: the transient retry carries the pool-wait accumulator`);
  }
});

// Card #255: a maintainer `continue` lineage keeps #212 C4's rule. Its descriptor is carried even
// from IMPLEMENT/DIAGNOSE, pool-wait and transient retry alike, so the maintainer's fix and PR are
// kept. Card #279 (option B): out of IMPLEMENT it is carried with `startState: 'IMPLEMENT'`, so the
// wake-up re-runs the pending IMPLEMENT on that worktree; out of DIAGNOSE it stays at CHECK (the
// end-to-end pins are part 5).
for (const [lastState, expectedStart] of [
  ['IMPLEMENT', 'IMPLEMENT'],
  ['DIAGNOSE', 'CHECK'],
]) {
  test(`finalizePark: a maintainer \`continue\` lineage keeps #212 C4's rule -- its descriptor is carried even from ${lastState}, to start at ${expectedStart} (#255, #279)`, () => {
    for (const kind of ['pool-wait', 'transient']) {
      const config = parkConfig();
      const resume = { startState: 'CHECK', prNumber: 55, worktreePath: '/x', commentId: 7, fromReason: 'merge-conflict' };
      const ctx = midRunCtx({ config, prNumber: 56, task: { resume } });
      ctx.counters.validateRejects = 1;
      if (kind === 'pool-wait') {
        const { reason, detail } = coolingPark();
        finalizePark(ctx, lastState, reason, detail);
      } else {
        finalizePark(ctx, lastState, `llm-transport-failed:${lastState}`, {});
      }

      const requeued = readOnlyQueued(config.queueDir);
      assert.equal(kind === 'pool-wait' ? requeued.poolWaitAttempts : requeued.transientRetries, 1, `${kind}: re-enqueued`);
      assert.equal(requeued.resume.commentId, 7, `${kind}: the maintainer's descriptor rides the re-enqueue`);
      assert.equal(requeued.resume.source, undefined, `${kind}: still the human lineage`);
      assert.equal(requeued.resume.prNumber, 56, `${kind}: prNumber refreshed from the run`);
      assert.equal(requeued.resume.startState, expectedStart, `${kind}: where the wake-up starts`);
      assert.equal(requeued.resume.worktreePath, '/x', `${kind}: the same worktree`);
      assert.equal(requeued.resume.fromReason, 'merge-conflict', `${kind}: the maintainer's descriptor, not a fresh one`);
      assert.equal(requeued.resume.counters.validateRejects, 1, `${kind}: a machine re-enqueue carries the run's counters`);
    }
  });
}

// Card #279: which counters a resume at IMPLEMENT carries -- the same set #251 carries to CHECK
// (diagnoseAttempts, validateRejects, ciImplementRetries, seenRootCauses), never `mainMoveUsed`
// (per wake-up) and never `diagnoseSurfaced` (per run).
test('finalizePark: a `continue` lineage carried out of IMPLEMENT carries every counter but mainMoveUsed and diagnoseSurfaced (#279)', () => {
  const config = parkConfig();
  const resume = { startState: 'CHECK', prNumber: 55, worktreePath: '/x', commentId: 7, fromReason: 'merge-conflict' };
  const ctx = midRunCtx({ config, prNumber: 55, task: { resume } });
  ctx.counters.diagnoseAttempts = 2;
  ctx.counters.validateRejects = 1;
  ctx.counters.ciImplementRetries = 1;
  ctx.counters.mainMoveUsed = 1;
  ctx.counters.diagnoseSurfaced = true;
  ctx.counters.seenRootCauses.add('cause-a');
  finalizePark(ctx, 'IMPLEMENT', 'llm-transport-failed:IMPLEMENT', {});

  const requeued = readOnlyQueued(config.queueDir);
  assert.equal(requeued.resume.startState, 'IMPLEMENT');
  assert.deepEqual(requeued.resume.counters, { diagnoseAttempts: 2, validateRejects: 1, ciImplementRetries: 1, seenRootCauses: ['cause-a'] });
});

// Card #279: IMPLEMENT is only where the wake-up starts while IMPLEMENT is still pending. Once the
// resumed IMPLEMENT has run, a later re-enqueue of the same lineage goes back to CHECK.
for (const [lastState, kind] of [
  ['GATE', 'transient'],
  ['VALIDATE', 'pool-wait'],
  ['DIAGNOSE', 'pool-wait'],
]) {
  test(`finalizePark: a \`continue\` lineage resumed at IMPLEMENT and re-enqueued from ${lastState} (${kind}) goes back to CHECK (#279)`, () => {
    const config = parkConfig();
    const resume = {
      startState: 'IMPLEMENT',
      prNumber: 55,
      worktreePath: '/x',
      commentId: 7,
      fromReason: 'merge-conflict',
      counters: { diagnoseAttempts: 0, validateRejects: 1, ciImplementRetries: 0, seenRootCauses: [] },
    };
    const ctx = midRunCtx({ config, prNumber: 55, task: { resume } });
    ctx.counters.validateRejects = 2;
    if (kind === 'pool-wait') {
      const { reason, detail } = coolingPark();
      finalizePark(ctx, lastState, reason, detail);
    } else {
      finalizePark(ctx, lastState, 'gate-non-attesting', {});
    }
    const requeued = readOnlyQueued(config.queueDir);
    assert.equal(requeued.resume.startState, 'CHECK');
    assert.equal(requeued.resume.commentId, 7);
    assert.equal(requeued.resume.source, undefined, 'never turned into a machine descriptor');
    assert.equal(requeued.resume.counters.validateRejects, 2);
  });
}

test('finalizePark: the pool-wait cap still accumulates across a RESUMED wake-up, which stays a machine resume at CHECK', () => {
  const config = parkConfig();
  const worktreePath = path.join(config.pipelineWorktreesDir, 'issue-888');
  const priorResume = {
    startState: 'CHECK',
    prNumber: 891,
    worktreePath,
    fromReason: 'all-accounts-cooling-until-2026-09-16T13:26:13.792Z',
    source: 'pool-wait',
    counters: { diagnoseAttempts: 0, validateRejects: 1, ciImplementRetries: 0, seenRootCauses: [] },
  };
  // The second wake-up of #888: poolWaitMs 3063116 (51 min) already spent, attempt 1 behind it.
  const ctx = midRunCtx({ config, prNumber: 891, task: { resume: priorResume, poolWaitMs: 3063116, poolWaitAttempts: 1 } });
  ctx.counters.validateRejects = 1; // what runTask restored from priorResume.counters
  const { reason, detail } = coolingPark(290);

  finalizePark(ctx, 'VALIDATE', reason, detail);

  const requeued = readOnlyQueued(config.queueDir);
  assert.equal(requeued.poolWaitAttempts, 2, 'the attempt count continues, never resets to 1');
  assert.ok(Math.abs(requeued.poolWaitMs - (3063116 + 290 * 60 * 1000)) < 5000, 'the wait is added on top of the carried one');
  assert.equal(requeued.resume.source, 'pool-wait');
  assert.equal(requeued.resume.startState, 'CHECK');
  assert.equal(requeued.resume.prNumber, 891);
  assert.equal(requeued.resume.counters.validateRejects, 1);
});

test('finalizePark: a resumed wake-up that would exceed the cap parks cap-exceeded -- a resume never buys a fresh allowance', () => {
  const config = parkConfig();
  const worktreePath = path.join(config.pipelineWorktreesDir, 'issue-888');
  const resume = { startState: 'CHECK', prNumber: 900, worktreePath, source: 'pool-wait', counters: {} };
  // #888's cap park: 42106159 ms accumulated over 4 waits, then a 54-minute cooldown.
  const ctx = midRunCtx({ config, prNumber: 900, task: { resume, poolWaitMs: 42106159, poolWaitAttempts: 4 } });
  const { reason, detail } = coolingPark(54);

  finalizePark(ctx, 'VALIDATE', reason, detail);

  assert.equal(queuedFiles(config.queueDir).length, 0, 'over the cap: nothing re-enqueued');
  const parked = readJournal(ctx.taskDir).find((e) => e.event === 'parked');
  assert.equal(parked.reason, 'all-accounts-cooling-wait-cap-exceeded');
});

// ================================================================================================
// ---- part 2: runTask restores a machine resume's counters; a `continue` keeps zeros ------------
// ================================================================================================

async function firstStateWrite(taskDir, fn) {
  const writes = [];
  const orig = fs.writeFileSync;
  const prefix = path.join(taskDir, '.state.json.');
  fs.writeFileSync = function patched(filePath, data, ...rest) {
    if (typeof filePath === 'string' && filePath.startsWith(prefix)) writes.push(JSON.parse(data));
    return orig.call(fs, filePath, data, ...rest);
  };
  try {
    await fn();
  } finally {
    fs.writeFileSync = orig;
  }
  return writes[0];
}

test('runTask (shadow mode): a machine resume enters at CHECK with its CARRIED counters, and journals source: pool-wait', async () => {
  const taskDir = mkTmp('spo-pwr-restore-');
  const task = {
    id: 'pwr-1',
    kind: 'card',
    issue: 888,
    title: 'x',
    resume: {
      startState: 'CHECK',
      prNumber: 891,
      worktreePath: '/tmp/spo-pwr-fixture-worktree',
      fromReason: 'all-accounts-cooling-until-2026-09-16T13:26:13.792Z',
      source: 'pool-wait',
      // mainMoveUsed as a hand-edited or pre-fix queue file might hold it -- ignored on restore.
      counters: { diagnoseAttempts: 2, validateRejects: 1, ciImplementRetries: 1, mainMoveUsed: 1, seenRootCauses: ['c'] },
    },
  };
  const first = await firstStateWrite(taskDir, () => runTask('pwr-1', task, taskDir, { shadowMode: true, dryRun: false }));
  assert.equal(first.state, 'CHECK');
  assert.equal(first.diagnoseAttempts, 2);
  assert.equal(first.validateRejects, 1);
  assert.equal(first.ciImplementRetries, 1);
  assert.equal(first.mainMoveUsed, 0, 'mainMoveUsed is per wake-up: never restored, even when the descriptor holds one');
  const resumed = readJournal(taskDir).find((e) => e.event === 'resumed-at-check');
  assert.equal(resumed.source, 'pool-wait');
  assert.equal(resumed.prNumber, 891);
});

test('runTask (shadow mode): a maintainer `continue` descriptor (no counters) still starts every counter at 0', async () => {
  const taskDir = mkTmp('spo-pwr-continue-');
  const task = {
    id: 'pwr-2',
    kind: 'card',
    issue: 888,
    title: 'x',
    resume: { startState: 'CHECK', prNumber: 891, worktreePath: '/tmp/spo-pwr-fixture-worktree', commentId: 5, fromReason: 'merge-conflict' },
  };
  const first = await firstStateWrite(taskDir, () => runTask('pwr-2', task, taskDir, { shadowMode: true, dryRun: false }));
  assert.equal(first.validateRejects, 0);
  assert.equal(first.diagnoseAttempts, 0);
  const resumed = readJournal(taskDir).find((e) => e.event === 'resumed-at-check');
  assert.equal(resumed.source, undefined);
});

// Card #279: a `continue` descriptor carriedResume wrote out of IMPLEMENT enters at IMPLEMENT --
// before CHECK, with the counters it carried (mainMoveUsed still per wake-up).
test('runTask (shadow mode): a `continue` descriptor carried out of IMPLEMENT enters at IMPLEMENT with its carried counters -- resumed-at-implement, then IMPLEMENT is the first handler (#279)', async () => {
  const taskDir = mkTmp('spo-pwr-impl-');
  const task = {
    id: 'pwr-3',
    kind: 'card',
    issue: 888,
    title: 'x',
    resume: {
      startState: 'IMPLEMENT',
      prNumber: 891,
      worktreePath: '/tmp/spo-pwr-fixture-worktree',
      commentId: 5,
      fromReason: 'merge-conflict',
      counters: { diagnoseAttempts: 1, validateRejects: 2, ciImplementRetries: 1, mainMoveUsed: 1, seenRootCauses: ['c'] },
    },
  };
  const first = await firstStateWrite(taskDir, () => runTask('pwr-3', task, taskDir, { shadowMode: true, dryRun: false }));
  assert.equal(first.state, 'IMPLEMENT', "the run's first state.json is already IMPLEMENT");
  assert.equal(first.prNumber, 891);
  assert.equal(first.worktreePath, '/tmp/spo-pwr-fixture-worktree');
  assert.equal(first.diagnoseAttempts, 1);
  assert.equal(first.validateRejects, 2);
  assert.equal(first.ciImplementRetries, 1);
  assert.equal(first.mainMoveUsed, 0, 'mainMoveUsed is per wake-up at IMPLEMENT too');

  const journal = readJournal(taskDir);
  const iResumed = journal.findIndex((e) => e.event === 'resumed-at-implement');
  assert.ok(iResumed >= 0, 'journals resumed-at-implement');
  assert.equal(journal[iResumed].state, 'IMPLEMENT');
  assert.equal(journal[iResumed].commentId, 5);
  assert.equal(journal[iResumed].prNumber, 891);
  assert.ok(!journal.some((e) => e.event === 'resumed-at-check'), 'not a CHECK resume');
  assert.ok(!journal.some((e) => ['INTAKE', 'WORKTREE', 'PLAN'].includes(e.state)), 'no INTAKE restart, no re-plan');
  const transitions = journal.map((e, i) => ({ e, i })).filter(({ e }) => e.event === 'transition');
  assert.deepEqual([transitions[0].e.state, transitions[0].e.to], ['IMPLEMENT', 'CHECK'], 'IMPLEMENT ran first, then CHECK');
  assert.ok(iResumed < transitions[0].i);
});

// Card #279: a MACHINE (`source: 'pool-wait'`) descriptor never resumes at IMPLEMENT -- #251
// drops it there -- so one that claims to is malformed: the INTAKE fallback, never an IMPLEMENT
// resume. A `continue` claiming any other start state still parks, unchanged.
test('runTask (shadow mode): startState IMPLEMENT on a machine descriptor is refused -- machine-resume-refused, INTAKE fallback (#279)', async () => {
  const taskDir = mkTmp('spo-pwr-impl-machine-');
  const task = {
    id: 'pwr-4',
    kind: 'card',
    issue: 888,
    title: 'x',
    resume: { startState: 'IMPLEMENT', prNumber: 891, worktreePath: '/tmp/spo-pwr-fixture-worktree', source: 'pool-wait', counters: {} },
  };
  await runTask('pwr-4', task, taskDir, { shadowMode: true, dryRun: false });
  const journal = readJournal(taskDir);
  const refused = journal.find((e) => e.event === 'machine-resume-refused');
  assert.ok(refused, 'refused');
  assert.equal(refused.step, 'invalid-resume');
  assert.equal(refused.field, 'startState');
  assert.ok(!journal.some((e) => e.event === 'resumed-at-implement'));
  assert.equal(journal.find((e) => e.event === 'transition').state, 'INTAKE');
});

test('resumeValidationError: CHECK and IMPLEMENT are the only start states, and IMPLEMENT only off the machine lineage (#279)', () => {
  const base = { prNumber: 1, worktreePath: '/w' };
  assert.equal(resumeValidationError({ ...base, startState: 'CHECK' }), null);
  assert.equal(resumeValidationError({ ...base, startState: 'CHECK', source: 'pool-wait' }), null);
  assert.equal(resumeValidationError({ ...base, startState: 'IMPLEMENT' }), null);
  assert.equal(resumeValidationError({ ...base, startState: 'IMPLEMENT', source: 'pool-wait' }), 'startState');
  for (const startState of ['PLAN', 'DIAGNOSE', 'VALIDATE', 'INTAKE', 'implement', undefined]) {
    assert.equal(resumeValidationError({ ...base, startState }), 'startState', String(startState));
  }
});

// ================================================================================================
// ---- part 3: #888 replayed end to end through drainQueueOnce ------------------------------------
// ================================================================================================

const ID = 'issue-888';
const HEAD_SHA = 'b'.repeat(40);
const ORIGIN_MAIN_SHA = 'a'.repeat(40);
const MERGED_SHA = 'c'.repeat(40); // card #281: HEAD_SHA with origin/main merged on top
const PR = 891; // #888's first PR (891 -> 893 -> 896 -> 898 -> 900 before this card)

const STEP_PAYLOADS = {
  'plan_markdown,invariants_markdown,invariant_ids,check_commands': {
    plan_markdown: '# Plan\n\nReplay of #888.\n',
    invariants_markdown: '# Invariants\n\n(none)\n',
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
  // Card #279: DIAGNOSE names the same cause every time it is asked about the same failure, so a
  // second DIAGNOSE on an unchanged diff is exactly #255's `diagnose-duplicate-root-cause` shape.
  root_cause: {
    root_cause: 'doc/x.md references an undefined symbol',
    category: 'typecheck',
    suggested_fix: 'define the symbol',
  },
};
const VALIDATE_KEY = 'verdict,reasons,findings';
const IMPLEMENT_KEY = 'summary,files_changed,invariants,tests_run,all_green';
const DIAGNOSE_KEY = 'root_cause';
const REJECT = { verdict: 'REJECT', reasons: ['the block is not above the tab bar'], findings: [] };

// The world the fakes model, mutated only by the fakes themselves (a push creates the remote
// branch, `pr create` opens the PR, `worktree add` creates the directory) and by the test between
// wake-ups (the cooldown, the clock).
function makeWorld(config) {
  const world = {
    remoteBranch: false,
    prOpen: null,
    nextPr: PR,
    closedPrs: [],
    treeDirty: true, // IMPLEMENT's edits, before PUSH_PR commits them
    // Card #281: the branch's local and remote tips (null reads as HEAD_SHA), and whether HEAD is
    // detached -- a CI_CHECKS main-moved merge moves only the local tip, a push makes the remote
    // tip catch up, and preserveWorktreeWip's `checkout --detach` / a `checkout <branch>` toggle it.
    localHead: null,
    remoteHead: null,
    detached: false,
    fetchFailures: 0, // the next N `git fetch`es fail (exit 128)
    validateCalls: 0,
    claudeCalls: [], // [{validateKey?}] -- every claude call, in order
    calls: [],
  };
  const branch = `claude-pipe/${ID}`;
  world.spawnSync = (command, args, spawnOpts) => {
    world.calls.push({ command, args: [...args], cwd: (spawnOpts && spawnOpts.cwd) || null });
    if (command === 'git') {
      if (args.includes('worktree') && args.includes('add')) {
        fs.mkdirSync(path.join(config.pipelineWorktreesDir, ID), { recursive: true });
        return ok('');
      }
      if (args.includes('worktree') && args.includes('list')) return ok('');
      // WORKTREE's leftover sweep, reached only by an INTAKE restart.
      if (args.includes('worktree') && args.includes('remove')) {
        fs.rmSync(path.join(config.pipelineWorktreesDir, ID), { recursive: true, force: true });
        return ok('');
      }
      if (args.includes('worktree') && args.includes('prune')) return ok('');
      if (args.includes('merge-base') && args.includes('origin/main')) return fail(1); // the branch is not on main
      if (args.includes('push') && args.includes('--delete')) {
        world.remoteBranch = false;
        return ok('');
      }
      if (args.includes('push') && args.some((a) => String(a).includes(':refs/heads/wip/'))) {
        return world.wipPushExit ? fail(world.wipPushExit) : ok('');
      }
      if (args.includes('fetch')) {
        if (world.fetchFailures > 0) {
          world.fetchFailures -= 1;
          return fail(128, 'fatal: unable to access');
        }
        return ok('');
      }
      if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) return fail(1);
      if (args.includes('rev-parse') && args.some((a) => String(a).startsWith('refs/remotes/origin/'))) {
        return world.remoteBranch ? ok(`${world.remoteHead || HEAD_SHA}\n`) : fail(1);
      }
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${ORIGIN_MAIN_SHA}\n`);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${world.localHead || HEAD_SHA}\n`);
      if (args.includes('symbolic-ref')) return world.detached ? fail(128, 'fatal: ref HEAD is not a symbolic ref') : ok(`${branch}\n`);
      // Card #281: `merge-base --is-ancestor <a> <b>` over the two tips the world models. The only
      // history it knows: HEAD_SHA is an ancestor of MERGED_SHA (a main-moved merge on top of it).
      if (args.includes('merge-base') && args.includes('--is-ancestor')) {
        const i = args.indexOf('--is-ancestor');
        const tip = (ref) => (ref === 'HEAD' ? world.localHead || HEAD_SHA : world.remoteHead || HEAD_SHA);
        const [a, b] = [tip(args[i + 1]), tip(args[i + 2])];
        return a === b || (a === HEAD_SHA && b === MERGED_SHA) ? ok('') : fail(1);
      }
      // CI_CHECKS' main-moved merge: a local merge commit origin has not seen yet.
      if (args.includes('merge') && args.includes('origin/main')) {
        world.localHead = MERGED_SHA;
        if (world.onMainMovedMerge) world.onMainMovedMerge();
        return ok('');
      }
      if (args.includes('checkout') && args.includes('--detach')) {
        world.detached = true;
        return ok('');
      }
      if (args.includes('checkout') && args.includes(branch)) {
        world.detached = false;
        return ok('');
      }
      if (args.includes('status') && args.includes('--porcelain')) return ok(world.treeDirty ? ' M doc/x.md\n' : '');
      if (args.includes('add') && args.includes('-A')) return ok('');
      if (args.includes('commit')) {
        world.treeDirty = false;
        return ok('');
      }
      if (args.includes('push')) {
        world.remoteBranch = true;
        world.remoteHead = world.localHead;
        return ok(`To github.com\n * [new branch]      HEAD -> ${branch}\n`);
      }
      if (args.includes('diff') && args.includes('--name-only')) return ok('doc/x.md\n');
      if (args.includes('diff')) return ok('diff --git a/doc/x.md b/doc/x.md\n+one line\n');
      return fail(1, `unhandled fake git call: ${args.join(' ')}`);
    }
    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(world.prOpen ? [{ number: world.prOpen }] : []));
      if (args[0] === 'pr' && args[1] === 'create') {
        world.prOpen = world.nextPr;
        world.nextPr += 1;
        return ok(`https://github.com/Crazz-Org/SPO-WebClient/pull/${world.prOpen}\n`);
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('state,headRefName')) {
        if (world.prViewFailures > 0) {
          world.prViewFailures -= 1; // card #281 F1: a transient `gh pr view` failure
          return fail(1, 'HTTP 502');
        }
        return ok(JSON.stringify({ state: world.prOpen ? 'OPEN' : 'CLOSED', headRefName: branch }));
      }
      if (args[0] === 'pr' && args[1] === 'close') {
        world.closedPrs.push(Number(args[2]));
        world.prOpen = null;
        return ok('');
      }
      if (args[0] === 'api' && args.some((a) => String(a).includes('check-runs'))) {
        if (world.onCiChecks) world.onCiChecks(); // the last thing before VALIDATE leases -- see setupReplay
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success', status: 'completed' }] }));
      }
      if (args[0] === 'api') return ok('{}');
      if (args[0] === 'issue' && args[1] === 'comment') return ok('https://github.com/o/r/issues/888#issuecomment-1\n');
      return fail(1, `unhandled fake gh call: ${args.join(' ')}`);
    }
    if (command === 'npm') {
      if (args[0] === 'ci') return ok('');
      if (args[1] === 'board:take') return world.boardTakeExit ? fail(world.boardTakeExit) : ok('claimed\n');
      if (args[1] === 'board:move') return ok('');
      // Card #279: `checkBroken` is a failure on the diff itself -- CHECK keeps failing until an
      // IMPLEMENT call fixes it (world.spawn clears it), so re-checking the unchanged diff fails again.
      if (args[1] === 'typecheck' && world.checkBroken) return fail(2, 'error TS2304');
      if (args[1] === 'lint' && world.lintBroken) return fail(1, 'error no-unused-vars'); // card #281
      if (['typecheck', 'lint', 'coverage:changed'].includes(args[1])) return ok('');
      if (args[1] === 'gate') return ok('');
      return fail(1, `unhandled fake npm call: ${args.join(' ')}`);
    }
    return fail(1, `unhandled fake command: ${command} ${args.join(' ')}`);
  };
  world.spawn = (command, args) => {
    const i = args.indexOf('--json-schema');
    const schema = i >= 0 ? JSON.parse(args[i + 1]) : { required: [] };
    const key = (schema.required || []).join(',');
    let payload;
    if (key === VALIDATE_KEY) {
      world.validateCalls += 1;
      payload = REJECT; // every VALIDATE that reaches the model rejects -- see the budget below
    } else {
      payload = STEP_PAYLOADS[key];
      if (key === IMPLEMENT_KEY) {
        world.treeDirty = true; // IMPLEMENT edits the worktree
        world.checkBroken = false; // ... and fixes what CHECK was failing on (card #279)
        // Card #281: a fix that does not hold -- it clears the typecheck and breaks lint instead.
        world.lintBroken = world.implementBreaksLint > 0;
        if (world.implementBreaksLint > 0) world.implementBreaksLint -= 1;
      }
      // Card #281: DIAGNOSE names each queued cause in turn (a new failure gets a new cause).
      if (key === DIAGNOSE_KEY && world.diagnoseCauses && world.diagnoseCauses.length > 0) {
        payload = { ...payload, root_cause: world.diagnoseCauses.shift() };
      }
    }
    // Card #279: the prompt each call was sent, read off the fake child's stdin.
    const call = { key, prompt: '' };
    world.claudeCalls.push(call);
    if (!payload) throw new Error(`no canned payload for required=[${key}]`);
    // Card #279: an IMPLEMENT cut short -- it has already edited the tree (above), then its reply
    // is unusable, which runLlm classifies `kind: 'error'` (llm-transport-failed:IMPLEMENT).
    const cutShort = key === IMPLEMENT_KEY && world.implementCutShort > 0;
    if (cutShort) world.implementCutShort -= 1;
    const sessionId = `aaaaaaaa-bbbb-4ccc-8ddd-${String(key.length).padStart(12, '0')}`;
    return fakeSpawnedChild([
      { type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        session_id: sessionId,
        modelUsage: { 'fake-model': { input_tokens: 100, output_tokens: 50 } },
        result: cutShort ? 'the session ended before a reply' : JSON.stringify(payload),
      },
    ], { onStdinWrite: (chunk) => (call.prompt += chunk) });
  };
  return world;
}

function coolFable(poolDir, untilMs) {
  accounts.writeState(poolDir, { pool1: { byModel: { fable: { cooldownUntil: untilMs } } } });
}

// The clock, the only thing a test moves between wake-ups: the queue entry's notBefore is set in
// the past, exactly as if the wait had elapsed. Everything else about the entry is production's.
function elapseWait(queueDir) {
  const files = queuedFiles(queueDir);
  assert.equal(files.length, 1);
  const p = path.join(queueDir, files[0]);
  const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
  entry.notBefore = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(p, JSON.stringify(entry, null, 2) + '\n');
  return entry;
}

// Journal events of the Nth `taken` segment (1-based) -- one segment per wake-up.
function segment(events, n) {
  const starts = events.map((e, i) => (e.event === 'taken' ? i : -1)).filter((i) => i >= 0);
  return events.slice(starts[n - 1], starts[n] === undefined ? events.length : starts[n]);
}

function setupReplay({ size = 'M' } = {}) {
  const root = mkTmp('spo-pwr-replay-');
  const queueDir = path.join(root, 'queue');
  const journalRoot = path.join(root, 'journal');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.mkdirSync(journalRoot, { recursive: true });
  const poolDir = writePoolDir(path.join(root, 'accts'), [{ name: 'pool1' }]);
  const config = {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: path.join(root, 'worktrees'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: path.join(root, 'bench'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1,
    claudeAccountsDir: poolDir,
    poolExhaustionWaitCapMs: 12 * 60 * 60 * 1000,
    transientRetryBudget: 2,
    transientRetryDelaysMs: [60000, 300000],
    // Two, so the carried counter is load-bearing: #888's first REJECT is 1, the resumed run's
    // REJECT is 2 and exhausts the budget. With counters reset by the resume it would read 1 and
    // route back to IMPLEMENT instead.
    validateRejectBudget: 2,
  };
  const world = makeWorld(config);
  // SPO-Pipeline#277 (verifier finding F1): a judge with no Fable anywhere now falls back to
  // claude-opus-5-5 whenever some account has it, so #888's shape -- VALIDATE pool-waiting on a
  // Fable-exhausted pool -- needs the fallback model out too BY THE TIME VALIDATE LEASES. It cannot
  // be out from the start: the INTAKE-restart runs below must still run PLAN and IMPLEMENT on it.
  // CI_CHECKS is the last step before VALIDATE on every path here (resume at CHECK or INTAKE
  // restart), so whenever Fable is cooling at that point, Opus 5.5 is cooled until the same instant.
  // coolFable's own writeState replaces the whole pool state, so a wake-up that clears Fable clears
  // this too.
  world.onCiChecks = () => {
    const state = accounts.readState(poolDir);
    const fable = state.pool1 && state.pool1.byModel && state.pool1.byModel.fable;
    if (!fable || !(fable.cooldownUntil > Date.now())) return;
    state.pool1.byModel['claude-opus-5-5'] = { cooldownUntil: fable.cooldownUntil };
    accounts.writeState(poolDir, state);
  };
  config.deps = {
    spawnSync: world.spawnSync,
    sleep: () => Promise.resolve(),
    spawn: (command, args) => world.spawn(command, args), // late-bound: a test may wrap world.spawn
    resolveClaudeCodeExecutable: () => '/fake/bin/claude',
    isNoRealSpawnEnabled: () => false,
  };
  const task = {
    id: ID,
    kind: 'card',
    issue: 888,
    title: 'Dedicated "Ongoing Research" block above the category tabs',
    criterion: 'replay only',
    size,
  };
  fs.writeFileSync(path.join(queueDir, `0001-${ID}.json`), JSON.stringify(task));
  return { queueDir, journalRoot, poolDir, config, world, taskDir: path.join(journalRoot, ID) };
}

// The first VALIDATE rejects (as #888's did at 12:21:40); the REJECT itself cools Fable, so the
// second VALIDATE, after IMPLEMENT, finds the pool cooling and pool-waits.
function coolFableOnFirstReject(world, poolDir, untilMs) {
  const spawn = world.spawn;
  world.spawn = (command, args) => {
    const child = spawn(command, args);
    if (world.validateCalls === 1 && !world.cooledOnce) {
      world.cooledOnce = true;
      coolFable(poolDir, untilMs);
    }
    return child;
  };
}

test('replay #888 (end to end): a VALIDATE pool-wait with the PR open wakes up at CHECK -- no INTAKE/WORKTREE/PLAN/IMPLEMENT/DIAGNOSE, no leftover sweep, the PR kept, counters and the cap carried', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir } = setupReplay();
  const expectedWorktree = path.join(config.pipelineWorktreesDir, ID);
  coolFableOnFirstReject(world, poolDir, Date.now() + 51 * 60 * 1000);

  // ---- wake-up 0: the fresh card. INTAKE ... VALIDATE (REJECT) -> IMPLEMENT -> ... -> VALIDATE,
  // where Fable is now cooling -> pool-wait.
  await drainQueueOnce(queueDir, journalRoot, config);
  let events = readJournal(taskDir);
  const run1 = segment(events, 1);
  assert.equal(run1.filter((e) => e.event === 'pool-wait').length, 1, 'the first run must end in a pool-wait');
  assert.equal(run1.find((e) => e.event === 'pool-wait').state, 'VALIDATE');
  assert.equal(world.validateCalls, 1);
  assert.equal(world.prOpen, PR);

  const entry1 = elapseWait(queueDir);
  assert.equal(entry1.resume.startState, 'CHECK', 'a VALIDATE pool-wait with a PR must re-enqueue a resume at CHECK');
  assert.equal(entry1.resume.prNumber, PR, 'the live prNumber from the run');
  assert.equal(entry1.resume.worktreePath, expectedWorktree);
  assert.equal(entry1.resume.source, 'pool-wait');
  assert.match(entry1.resume.fromReason, /^all-accounts-cooling-until-/);
  assert.equal(entry1.resume.counters.validateRejects, 1, "the REJECT before the wait rides in the descriptor");
  assert.equal(entry1.poolWaitAttempts, 1);
  const firstAccumulated = entry1.poolWaitMs;

  // ---- wake-up 1: Fable still cooling (#888's 1h probe found it still limited).
  coolFable(poolDir, Date.now() + 290 * 60 * 1000);
  await drainQueueOnce(queueDir, journalRoot, config);
  events = readJournal(taskDir);
  const run2 = segment(events, 2);

  const transitions = run2.filter((e) => e.event === 'transition').map((e) => `${e.state}->${e.to}`);
  assert.deepEqual(transitions, ['CHECK->PUSH_PR', 'PUSH_PR->GATE', 'GATE->CI_CHECKS', 'CI_CHECKS->VALIDATE']);
  const resumed = run2.find((e) => e.event === 'resumed-at-check');
  assert.ok(resumed, 'the wake-up must journal resumed-at-check');
  assert.equal(resumed.prNumber, PR);
  assert.equal(resumed.source, 'pool-wait');
  assert.ok(run2.some((e) => e.event === 'resume-prepared'), "prepareResume's safety net ran and accepted the worktree");
  assert.deepEqual(
    run2.filter((e) => /^leftover-/.test(e.event)).map((e) => e.event),
    [],
    'no leftover sweep on a resume'
  );
  const early = run2.filter((e) => ['INTAKE', 'WORKTREE', 'PLAN', 'IMPLEMENT', 'DIAGNOSE'].includes(e.state) && e.event !== 'taken');
  assert.deepEqual(early, [], 'no INTAKE/WORKTREE/PLAN/IMPLEMENT/DIAGNOSE event on the wake-up');
  assert.equal(run2.filter((e) => e.event === 'llm-call').length, 0, 'no llm-call at all before VALIDATE, and VALIDATE found Fable cooling');
  assert.ok(!run2.some((e) => e.event === 'pr-created'), 'no new PR');
  assert.ok(
    run2.some((e) => e.state === 'PUSH_PR' && e.event === 'pr-reused' && e.prNumber === PR),
    'PUSH_PR reuses the PR the card already had'
  );
  assert.ok(!world.calls.some((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close'), 'the green PR is never closed');
  const wait2 = run2.find((e) => e.event === 'pool-wait');
  assert.ok(wait2, 'the resumed run pool-waits again at VALIDATE');
  assert.equal(wait2.attempt, 2);
  const state2 = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state2.validateRejects, 1, 'the resumed run carried the REJECT count');

  const entry2 = elapseWait(queueDir);
  assert.equal(entry2.resume.startState, 'CHECK');
  assert.equal(entry2.resume.prNumber, PR);
  assert.equal(entry2.resume.counters.validateRejects, 1);
  assert.equal(entry2.poolWaitAttempts, 2, 'the cap accumulator continues across the resumed wake-up');
  assert.ok(entry2.poolWaitMs > firstAccumulated + 280 * 60 * 1000, 'the second wait is added to the first, never a fresh allowance');

  // ---- wake-up 2: Fable is back. VALIDATE rejects again; the carried count makes it the second
  // REJECT, which exhausts validateRejectBudget (2). A reset counter would read 1 and route to
  // IMPLEMENT instead.
  coolFable(poolDir, Date.now() - 1000);
  await drainQueueOnce(queueDir, journalRoot, config);
  events = readJournal(taskDir);
  const run3 = segment(events, 3);
  assert.equal(world.validateCalls, 2);
  const firstLlm = run3.find((e) => e.event === 'llm-call');
  assert.equal(firstLlm && firstLlm.state, 'VALIDATE', 'the first model call after the wake-up is VALIDATE itself');
  const parked = run3.find((e) => e.event === 'parked');
  assert.ok(parked, 'the third run parks');
  assert.equal(parked.reason, 'validate-reject-budget-exhausted', 'the carried REJECT count is enforced, not merely recorded');
  assert.ok(!run3.some((e) => e.state === 'IMPLEMENT'), 'never back to IMPLEMENT');
});

test('replay #888 (end to end): a PLAN pool-wait still restarts at INTAKE -- WORKTREE and the sweep run again', async () => {
  const { queueDir, journalRoot, poolDir, config, taskDir } = setupReplay();
  // Opus 5.5 cooling from the start: PLAN is the first model call and pool-waits.
  accounts.writeState(poolDir, { pool1: { byModel: { 'claude-opus-5-5': { cooldownUntil: Date.now() + 60 * 60 * 1000 } } } });

  await drainQueueOnce(queueDir, journalRoot, config);
  const run1 = segment(readJournal(taskDir), 1);
  const wait = run1.find((e) => e.event === 'pool-wait');
  assert.ok(wait);
  assert.equal(wait.state, 'PLAN');

  const entry = elapseWait(queueDir);
  assert.equal(entry.resume, undefined, 'a PLAN pool-wait never resumes');

  accounts.writeState(poolDir, {});
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  assert.ok(!run2.some((e) => e.event === 'resumed-at-check'));
  const firstTransition = run2.find((e) => e.event === 'transition');
  assert.equal(firstTransition.state, 'INTAKE', 'the wake-up starts at INTAKE');
  assert.ok(run2.some((e) => e.state === 'WORKTREE'), 'WORKTREE runs again');
});

test('replay #888 (end to end): a machine resume that prepareResume refuses falls back to the INTAKE restart, journalled -- never parked, never lost', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir } = setupReplay();
  coolFableOnFirstReject(world, poolDir, Date.now() + 51 * 60 * 1000);

  await drainQueueOnce(queueDir, journalRoot, config);
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume.startState, 'CHECK');

  // During the wait, someone closed the PR: prepareResume refuses `pr-not-open`.
  world.closedPrs.push(world.prOpen);
  world.prOpen = null;
  coolFable(poolDir, Date.now() + 290 * 60 * 1000); // still cooling: the fallback run pool-waits again
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);

  const refused = run2.find((e) => e.event === 'machine-resume-refused');
  assert.ok(refused, 'the refusal is journalled');
  assert.equal(refused.step, 'pr-not-open');
  assert.equal(refused.fallback, 'INTAKE');
  assert.ok(!run2.some((e) => e.event === 'parked'), 'a refused MACHINE resume never parks resume-precondition-failed');
  const afterRefusal = run2.slice(run2.indexOf(refused) + 1);
  const firstTransition = afterRefusal.find((e) => e.event === 'transition');
  assert.equal(firstTransition.state, 'INTAKE', 'the fallback is the pre-#251 INTAKE restart, in the same run');
  assert.ok(afterRefusal.some((e) => e.state === 'WORKTREE'), 'WORKTREE (and its leftover sweep) runs on the fallback');
  assert.ok(afterRefusal.some((e) => e.state === 'WORKTREE' && e.event === 'leftover-worktree-removed'), 'the sweep clears the refused worktree');
  assert.ok(afterRefusal.some((e) => e.state === 'IMPLEMENT' && e.event === 'llm-call'), 'IMPLEMENT runs again, as before #251');
  assert.ok(afterRefusal.some((e) => e.event === 'pr-created' && e.prNumber === PR + 1), 'PUSH_PR opens a new PR');
  const wait = afterRefusal.find((e) => e.event === 'pool-wait');
  assert.ok(wait, 'the fallback run reaches VALIDATE and pool-waits');
  assert.equal(wait.attempt, 2, 'the cap accumulator survives the fallback too');

  const next = readOnlyQueued(queueDir);
  assert.equal(next.resume.startState, 'CHECK', "the fallback run's own VALIDATE pool-wait resumes again, on the new PR");
  assert.equal(next.resume.prNumber, PR + 1, 'the live PR of the fallback run, not the refused one');
  assert.equal(next.resume.counters.validateRejects, 1, 'the counters carried into the fallback are carried out of it');
});

// runTask's own checks, which run before prepareResume, fall back the same way on a machine
// resume: a descriptor that fails validation, and one naming a worktree outside the pipeline's
// namespace. The queue entry is edited by hand here, standing in for a corrupted or foreign
// descriptor.
for (const [label, mutate, step] of [
  ['an invalid descriptor (prNumber 0)', (r) => ({ ...r, prNumber: 0 }), 'invalid-resume'],
  ['a foreign worktreePath', (r) => ({ ...r, worktreePath: '/tmp/somewhere-else' }), 'worktree-path-mismatch'],
]) {
  test(`replay #888 (end to end): a machine resume with ${label} falls back to INTAKE, journalled ${step}`, async () => {
    const { queueDir, journalRoot, poolDir, world, config, taskDir } = setupReplay();
    coolFableOnFirstReject(world, poolDir, Date.now() + 51 * 60 * 1000);
    await drainQueueOnce(queueDir, journalRoot, config);
    const entry = elapseWait(queueDir);
    const file = path.join(queueDir, queuedFiles(queueDir)[0]);
    fs.writeFileSync(file, JSON.stringify({ ...entry, resume: mutate(entry.resume) }));

    coolFable(poolDir, Date.now() + 290 * 60 * 1000);
    await drainQueueOnce(queueDir, journalRoot, config);
    const run2 = segment(readJournal(taskDir), 2);
    const refused = run2.find((e) => e.event === 'machine-resume-refused');
    assert.ok(refused);
    assert.equal(refused.step, step);
    assert.ok(!run2.some((e) => e.event === 'parked'), 'never parked');
    assert.ok(!run2.some((e) => e.event === 'resumed-at-check'), 'refused before resumed-at-check');
    assert.equal(run2.find((e) => e.event === 'transition').state, 'INTAKE');
    assert.ok(run2.some((e) => e.event === 'pool-wait'), 'the fallback run reaches VALIDATE again');
  });
}

// ================================================================================================
// ---- part 4: what the carried counters mean on the resumed run (verifier fix pass) -------------
// ================================================================================================

function shadowResumeTask(id, resume, shadow) {
  return { id, title: 'x', kind: 'synthetic', resume, shadow };
}
function machineDescriptor(counters, overrides = {}) {
  return {
    startState: 'CHECK',
    prNumber: 891,
    worktreePath: '/tmp/spo-pwr-fixture-worktree',
    fromReason: 'all-accounts-cooling-until-2026-09-16T13:26:13.792Z',
    source: 'pool-wait',
    counters,
    ...overrides,
  };
}

// F1: mainMoveUsed is a per-pass contention budget, and the wait (up to 12h) is when main moves.
// The descriptor comes from production: finalizePark writes it from a run that already spent its
// main-move merge. The wake-up then sees ONE legitimate file-intersecting main move (fixture
// mainMoved [true, false]) and must merge forward and finish, exactly as the pre-#251 INTAKE
// restart and a maintainer's `continue` do -- never park main-moved-twice.
test('F1: a machine resume never carries mainMoveUsed -- one main move during the wait merges forward and the card reaches DONE', async () => {
  const config = parkConfig();
  const ctx = midRunCtx({ config, prNumber: 891 });
  ctx.counters.mainMoveUsed = 1; // the run before the wait already merged main forward once
  ctx.counters.validateRejects = 1;
  const { reason, detail } = coolingPark();
  finalizePark(ctx, 'VALIDATE', reason, detail);
  const resume = readOnlyQueued(config.queueDir).resume;
  assert.equal(resume.source, 'pool-wait');
  assert.equal('mainMoveUsed' in resume.counters, false, 'the descriptor never holds mainMoveUsed');

  const taskDir = mkTmp('spo-pwr-mainmove-');
  const shadow = { gate: [0, 0], mainMoved: [true, false], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } } };
  const out = await runTask('mm', shadowResumeTask('mm', resume, shadow), taskDir, { shadowMode: true, dryRun: false });
  const events = readJournal(taskDir);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(out, 'DONE', `expected DONE, got ${out} (${state.reason || '-'})`);
  assert.equal(events.filter((e) => e.event === 'main-moved-merge').length, 1, 'merged main forward exactly once');
  assert.equal(state.mainMoveUsed, 1, "this wake-up's own single move, not the previous run's plus it");
  assert.equal(state.validateRejects, 1, 'the quality counters are still carried');
});

// The same hand-edited descriptor, carrying mainMoveUsed, and the refusal fallback: the fallback
// builds a fresh worktree from current main, so its budget is fresh too.
test('F1: the refusal fallback never carries mainMoveUsed either -- even from a descriptor that holds one', async () => {
  const taskDir = mkTmp('spo-pwr-mainmove-fallback-');
  const resume = machineDescriptor(
    { diagnoseAttempts: 0, validateRejects: 1, ciImplementRetries: 0, mainMoveUsed: 1, seenRootCauses: [] },
    { prNumber: 0 } // invalid -> machine-resume-refused -> INTAKE fallback, in shadow mode too
  );
  const shadow = { gate: [0, 0], mainMoved: [true, false], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } } };
  const out = await runTask('mmf', shadowResumeTask('mmf', resume, shadow), taskDir, { shadowMode: true, dryRun: false });
  const events = readJournal(taskDir);
  assert.ok(events.some((e) => e.event === 'machine-resume-refused' && e.step === 'invalid-resume'));
  assert.equal(out, 'DONE');
  assert.equal(events.filter((e) => e.event === 'main-moved-merge').length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.validateRejects, 1, 'the fallback still carries the quality counters');
});

// V8: the carried seenRootCauses is not only written, it is enforced -- DIAGNOSE's duplicate-root-
// cause guard on the resumed run sees the cause diagnosed before the wait.
test('V8: a carried seenRootCauses makes DIAGNOSE on the resumed run park diagnose-duplicate-root-cause; a `continue` does not', async () => {
  const shadow = { check: [1, 0], llm: { DIAGNOSE: { rootCause: 'cause-x' } } };
  const machineDir = mkTmp('spo-pwr-seen-');
  const counters = { diagnoseAttempts: 1, validateRejects: 0, ciImplementRetries: 0, seenRootCauses: ['cause-x'] };
  await runTask('seen', shadowResumeTask('seen', machineDescriptor(counters), shadow), machineDir, { shadowMode: true, dryRun: false });
  const parked = readJournal(machineDir).find((e) => e.event === 'parked');
  assert.ok(parked);
  assert.equal(parked.reason, 'diagnose-duplicate-root-cause');

  const humanDir = mkTmp('spo-pwr-seen-human-');
  const human = { startState: 'CHECK', prNumber: 891, worktreePath: '/tmp/x', commentId: 5, fromReason: 'merge-conflict' };
  await runTask('seen-h', shadowResumeTask('seen-h', human, shadow), humanDir, { shadowMode: true, dryRun: false });
  const humanEvents = readJournal(humanDir);
  assert.ok(!humanEvents.some((e) => e.event === 'parked' && e.reason === 'diagnose-duplicate-root-cause'));
  assert.ok(humanEvents.some((e) => e.state === 'DIAGNOSE' && e.event === 'transition' && e.to === 'IMPLEMENT'), 'a fresh set: DIAGNOSE hands on to IMPLEMENT');
});

// V19: a queue file is data, not trusted state. Out-of-range values are ignored (buildCtx's 0) or
// clamped; seenRootCauses keeps strings only, at most 100.
test('V19: restored counters are bounded -- non-integers/negatives ignored, huge values clamped, seenRootCauses filtered and capped', async () => {
  const taskDir = mkTmp('spo-pwr-bounds-');
  const counters = { diagnoseAttempts: 1.5, validateRejects: -1, ciImplementRetries: '2', seenRootCauses: [] };
  const first = await firstStateWrite(taskDir, () =>
    runTask('b1', shadowResumeTask('b1', machineDescriptor(counters), {}), taskDir, { shadowMode: true, dryRun: false })
  );
  assert.equal(first.diagnoseAttempts, 0);
  assert.equal(first.validateRejects, 0);
  assert.equal(first.ciImplementRetries, 0);

  const bigDir = mkTmp('spo-pwr-bounds-big-');
  const big = { diagnoseAttempts: 1e9, validateRejects: Number.MAX_SAFE_INTEGER + 2, ciImplementRetries: 3, seenRootCauses: [] };
  const firstBig = await firstStateWrite(bigDir, () =>
    runTask('b2', shadowResumeTask('b2', machineDescriptor(big), {}), bigDir, { shadowMode: true, dryRun: false })
  );
  assert.equal(firstBig.diagnoseAttempts, RESUME_COUNTER_MAX, 'clamped, still past every budget');
  assert.equal(firstBig.validateRejects, 0, 'not a safe integer: ignored');
  assert.equal(firstBig.ciImplementRetries, 3);

  // seenRootCauses: non-strings dropped, at most 100 kept -- observed through DIAGNOSE's guard.
  const causes = [7, null, ...Array.from({ length: 150 }, (_, i) => `c${i}`)];
  for (const [cause, duplicate] of [['c0', true], ['c99', true], ['c120', false]]) {
    const dir = mkTmp('spo-pwr-bounds-seen-');
    const c = { diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, seenRootCauses: causes };
    await runTask('b3', shadowResumeTask('b3', machineDescriptor(c), { check: [1, 0], llm: { DIAGNOSE: { rootCause: cause } } }), dir, {
      shadowMode: true,
      dryRun: false,
    });
    const dup = readJournal(dir).some((e) => e.event === 'parked' && e.reason === 'diagnose-duplicate-root-cause');
    assert.equal(dup, duplicate, `${cause}: duplicate=${duplicate}`);
  }
});

// V14: the fallback strips the refused descriptor from the task, so a transient retry the fallback
// run takes before VALIDATE (here `claim-rate-limited` at WORKTREE) restarts at INTAKE again,
// instead of carrying the stale machine descriptor back to CHECK.
test('V14: a transient retry during the refusal fallback run carries NO resume', async () => {
  const { queueDir, journalRoot, poolDir, world, config, taskDir } = setupReplay();
  coolFableOnFirstReject(world, poolDir, Date.now() + 51 * 60 * 1000);
  await drainQueueOnce(queueDir, journalRoot, config);
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume.source, 'pool-wait');

  world.closedPrs.push(world.prOpen);
  world.prOpen = null; // prepareResume refuses pr-not-open -> INTAKE fallback
  world.boardTakeExit = 4; // WORKTREE's claim hits a GitHub rate limit -> claim-rate-limited transient retry
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  assert.ok(run2.some((e) => e.event === 'machine-resume-refused'));
  const retry = run2.find((e) => e.event === 'transient-retry');
  assert.ok(retry, 'the fallback run took a transient retry');
  assert.equal(retry.reason, 'claim-rate-limited');
  assert.equal(retry.state, 'WORKTREE');

  const next = readOnlyQueued(queueDir);
  assert.equal(next.resume, undefined, 'the refused machine descriptor must not ride the transient retry');
  assert.equal(next.transientRetries, 1);
  assert.equal(next.poolWaitAttempts, 1, 'the pool-wait accumulator still rides it');
});

// ================================================================================================
// ---- part 5: cards #255/#279 -- a `continue` lineage back in IMPLEMENT resumes at IMPLEMENT
// ================================================================================================
//
// A run resumed by a maintainer's `continue` (#212) that goes back to IMPLEMENT (a VALIDATE REJECT,
// or a failure DIAGNOSE routed there) and is re-enqueued there (a pool-wait, or a transient retry)
// KEEPS its descriptor, so the maintainer's fix and the PR are always kept (#255). Restarting at
// INTAKE instead (option C, the superseded `fix-255` branch) made WORKTREE's leftover sweep close
// the PR the maintainer had just fixed. Card #279 (option B): the descriptor is carried with
// `startState: 'IMPLEMENT'`, so the wake-up re-runs the pending IMPLEMENT on the same worktree --
// no VALIDATE of the unfixed diff first (#255's option A spent one there), and no second DIAGNOSE
// of a failure it has already named (which parked option A's DIAGNOSE path
// `diagnose-duplicate-root-cause`). The #251 machine lineage is unchanged: it drops its descriptor
// there. Every order below is read off journal event indexes, never the clock.

const CONTINUE_COMMENT_ID = 4242;
const PARK_COMMENT_ID = 100;

// Run 1 is #888's own first run (INTAKE ... VALIDATE REJECT -> IMPLEMENT -> ... -> VALIDATE
// pool-wait), which leaves exactly what a later `continue` resumes: PLAN's artefacts in the
// journal, the worktree on disk, the branch pushed, the PR open, the tree clean. Its machine
// re-enqueue is then replaced by a merge-conflict park (state.json + `parked` + `park-comment`,
// the fixture shape test/unpark-continue.test.js uses), and a collaborator's `continue` reply is
// read by the REAL unparkScan, which writes the queue entry run 2 takes. Returns with the pool
// clear.
async function setupContinueReplay(validateRejectBudget, replayOpts = {}) {
  const replay = setupReplay(replayOpts);
  const { queueDir, journalRoot, poolDir, config, world, taskDir } = replay;
  config.validateRejectBudget = validateRejectBudget;
  coolFableOnFirstReject(world, poolDir, Date.now() + 51 * 60 * 1000);
  await drainQueueOnce(queueDir, journalRoot, config);
  const wait = segment(readJournal(taskDir), 1).find((e) => e.event === 'pool-wait');
  assert.ok(wait && wait.state === 'VALIDATE', 'run 1 reaches VALIDATE with the PR open');
  for (const f of queuedFiles(queueDir)) fs.rmSync(path.join(queueDir, f));

  const worktreePath = path.join(config.pipelineWorktreesDir, ID);
  writeState(taskDir, { id: ID, state: 'PARKED', reason: 'merge-conflict', prNumber: PR, worktreePath });
  appendEvent(taskDir, 'MERGE', 'parked', { reason: 'merge-conflict' });
  appendEvent(taskDir, 'PARKED', 'park-comment', { commentId: PARK_COMMENT_ID, reason: 'merge-conflict' });
  accounts.writeState(poolDir, {});

  const comments = [{ id: CONTINUE_COMMENT_ID, user: { login: 'Crazz-E' }, created_at: '2026-09-25T00:00:00Z', body: 'continue' }];
  await unparkScan(queueDir, journalRoot, { ...config, queueDir }, {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      if (command === 'gh' && args[0] === 'api') return ok(JSON.stringify(comments));
      return ok('');
    },
  });
  const entry = readOnlyQueued(queueDir);
  assert.deepEqual(
    entry.resume,
    { startState: 'CHECK', prNumber: PR, worktreePath, commentId: CONTINUE_COMMENT_ID, fromReason: 'merge-conflict' },
    'unparkScan wrote the `continue` queue entry'
  );
  return { ...replay, worktreePath };
}

// Runs `fn` once, right after the NEXT VALIDATE model call (a REJECT) has been spawned.
function afterNextValidate(world, fn) {
  const spawn = world.spawn;
  const target = world.validateCalls + 1;
  let fired = false;
  world.spawn = (command, args) => {
    const child = spawn(command, args);
    if (!fired && world.validateCalls === target) {
      fired = true;
      fn();
    }
    return child;
  };
}

// The REJECT cools Opus 5.5, so the IMPLEMENT it routes to finds the pool cooling and pool-waits.
function coolOpusAfterNextValidate(world, poolDir) {
  afterNextValidate(world, () =>
    accounts.writeState(poolDir, { pool1: { byModel: { 'claude-opus-5-5': { cooldownUntil: Date.now() + 51 * 60 * 1000 } } } })
  );
}

const isPrClose = (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close';
const isWorktreeAdd = (c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('add');

// Runs `fn` once, right after the NEXT DIAGNOSE model call has been spawned.
function afterNextDiagnose(world, fn) {
  const spawn = world.spawn;
  const target = world.claudeCalls.filter((c) => c.key === DIAGNOSE_KEY).length + 1;
  let fired = false;
  world.spawn = (command, args) => {
    const child = spawn(command, args);
    if (!fired && world.claudeCalls.filter((c) => c.key === DIAGNOSE_KEY).length === target) {
      fired = true;
      fn();
    }
    return child;
  };
}

function coolOpus(poolDir) {
  accounts.writeState(poolDir, { pool1: { byModel: { 'claude-opus-5-5': { cooldownUntil: Date.now() + 51 * 60 * 1000 } } } });
}

// Journal index of the first event matching `pred` in `events`, asserted present.
function indexOf(events, pred, label) {
  const i = events.findIndex(pred);
  assert.ok(i >= 0, `expected ${label} in the run's journal`);
  return i;
}

const isLlm = (state) => (e) => e.event === 'llm-call' && e.state === state;
const isWipPush = (c) => c.command === 'git' && c.args.includes('push') && c.args.some((a) => String(a).includes(':refs/heads/wip/'));

// What every #279 wake-up must keep: the worktree, the branch, the PR, and no INTAKE restart.
function assertSameWorktreeAndPr(run, runCalls, world, worktreePath) {
  assert.deepEqual(run.filter((e) => /^leftover-/.test(e.event)).map((e) => e.event), [], 'no leftover sweep');
  assert.ok(!run.some((e) => ['INTAKE', 'WORKTREE', 'PLAN'].includes(e.state) && e.event !== 'taken'), 'no INTAKE restart, no re-plan');
  assert.equal(runCalls.filter(isWorktreeAdd).length, 0, 'no new worktree');
  assert.ok(fs.existsSync(worktreePath), 'the worktree is still on disk');
  assert.equal(world.calls.filter(isPrClose).length, 0, 'the PR the maintainer fixed is never closed');
  assert.deepEqual(world.closedPrs, []);
  assert.ok(!run.some((e) => e.event === 'pr-created'), 'no new PR');
  assert.ok(run.some((e) => e.state === 'PUSH_PR' && e.event === 'pr-reused' && e.prNumber === PR), 'PUSH_PR reuses the same PR');
}

test('#279 option B (end to end, REJECT path): a `continue`d run that pool-waits at IMPLEMENT after a VALIDATE REJECT wakes up AT IMPLEMENT on the same worktree and PR -- no VALIDATE of the unfixed diff first, the counters carried', async () => {
  assert.equal(PRODUCTION_VALIDATE_REJECT_BUDGET, 3, 'config.js validateRejectBudget -- re-read #255/#279 if this moves');
  // Size S: IMPLEMENT's effort is `low` unless a carried counter escalates it (diagnoseOrValidateRetry).
  const { queueDir, journalRoot, poolDir, config, world, taskDir, worktreePath } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET, { size: 'S' });
  coolOpusAfterNextValidate(world, poolDir);

  // ---- run 2: the `continue`. CHECK -> PUSH_PR -> GATE -> CI_CHECKS -> VALIDATE (REJECT, 1 of 3)
  // -> IMPLEMENT, pool-wait.
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  assert.ok(run2.some((e) => e.event === 'resumed-at-check' && e.commentId === CONTINUE_COMMENT_ID), 'run 2 is the `continue` resume');
  assert.deepEqual(run2.filter((e) => e.event === 'llm-call').map((e) => e.state), ['VALIDATE'], 'the `continue` run reached VALIDATE, and IMPLEMENT has not run');
  const wait = run2.find((e) => e.event === 'pool-wait');
  assert.ok(wait, 'run 2 ends in a pool-wait');
  assert.equal(wait.state, 'IMPLEMENT', 'the pool-wait fired in IMPLEMENT, the step the REJECT routed to');

  // The queue entry carries the maintainer's descriptor out of IMPLEMENT, to start there.
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume.startState, 'IMPLEMENT', 'carried out of IMPLEMENT with startState IMPLEMENT (#279)');
  assert.equal(entry.resume.commentId, CONTINUE_COMMENT_ID, 'the maintainer descriptor, carried -- not a fresh machine one');
  assert.equal(entry.resume.source, undefined, 'still the human lineage');
  assert.equal(entry.resume.fromReason, 'merge-conflict');
  assert.equal(entry.resume.worktreePath, worktreePath, 'the same worktree');
  assert.equal(entry.resume.prNumber, PR, 'the same PR');
  assert.deepEqual(entry.resume.counters, { diagnoseAttempts: 0, validateRejects: 1, ciImplementRetries: 0, seenRootCauses: [] }, "the run's counters, mainMoveUsed excluded");
  assert.ok(entry.poolWaitAttempts >= 1, 'still an ordinary pool-wait');

  // ---- run 3: Opus 5.5 is back. The wake-up resumes AT IMPLEMENT, which is its first model call.
  accounts.writeState(poolDir, {});
  const callsBefore = world.calls.length;
  const claudeBefore = world.claudeCalls.length;
  const validateBefore = world.validateCalls;
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  const run3Calls = world.calls.slice(callsBefore);

  const iResumed = indexOf(run3, (e) => e.event === 'resumed-at-implement', 'resumed-at-implement');
  assert.equal(run3[iResumed].commentId, CONTINUE_COMMENT_ID);
  assert.equal(run3[iResumed].prNumber, PR);
  assert.equal(run3[iResumed].worktreePath, worktreePath);
  assert.ok(!run3.some((e) => e.event === 'resumed-at-check'), 'not a CHECK resume');
  const iPrepared = indexOf(run3, (e) => e.event === 'resume-prepared', 'resume-prepared');
  const iImplement = indexOf(run3, isLlm('IMPLEMENT'), 'an IMPLEMENT llm-call');
  const iValidate = indexOf(run3, isLlm('VALIDATE'), 'a VALIDATE llm-call');
  assert.ok(iResumed < iPrepared && iPrepared < iImplement, 'prepareResume ran and accepted the worktree before IMPLEMENT');
  assert.ok(iImplement < iValidate, 'IMPLEMENT runs before any VALIDATE: the unfixed diff is never re-validated');
  assert.equal(run3.findIndex((e) => e.event === 'llm-call'), iImplement, "IMPLEMENT is the wake-up's first model call");
  assertSameWorktreeAndPr(run3, run3Calls, world, worktreePath);

  // The counters were restored and are live: the carried REJECT escalates IMPLEMENT's effort ...
  assert.equal(run3[iImplement].effort, 'medium', 'the carried validateRejects (1) escalates a size-S IMPLEMENT from low');
  // ... IMPLEMENT reads the REJECT back from the journal ...
  const firstImplementCall = world.claudeCalls.slice(claudeBefore).find((c) => c.key === IMPLEMENT_KEY);
  assert.ok(firstImplementCall.prompt.includes(REJECT.reasons[0]), "IMPLEMENT's prompt carries the REJECT it has to address");
  // ... and the budget counts it: IMPLEMENT -> VALIDATE (REJECT 2 of 3) -> IMPLEMENT -> VALIDATE
  // (REJECT 3 of 3) parks. Both VALIDATEs follow an IMPLEMENT; none is spent on the old diff.
  assert.deepEqual(run3.filter((e) => e.event === 'llm-call').map((e) => e.state), ['IMPLEMENT', 'VALIDATE', 'IMPLEMENT', 'VALIDATE']);
  assert.equal(world.validateCalls - validateBefore, 2);
  const parked = run3.find((e) => e.event === 'parked');
  assert.ok(parked);
  assert.equal(parked.reason, 'validate-reject-budget-exhausted');
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.validateRejects, 3, "the carried REJECT (1) plus this run's two");
  assert.equal(state.prNumber, PR, 'the park still names the same PR');
});

test('#279 option B (end to end, DIAGNOSE path): a `continue`d run whose CHECK failure DIAGNOSE routed to IMPLEMENT, and that pool-waits there, wakes up AT IMPLEMENT -- no second DIAGNOSE of the unchanged diff, no diagnose-duplicate-root-cause park', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir, worktreePath } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET, { size: 'S' });
  // The maintainer's resolved branch fails typecheck, and keeps failing until IMPLEMENT fixes it.
  world.checkBroken = true;
  // DIAGNOSE (Opus 5.5) runs, then Opus 5.5 cools: the IMPLEMENT it routes to pool-waits.
  afterNextDiagnose(world, () => coolOpus(poolDir));

  // ---- run 2: the `continue`. CHECK (fails) -> DIAGNOSE -> IMPLEMENT, pool-wait.
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  assert.ok(run2.some((e) => e.event === 'resumed-at-check' && e.commentId === CONTINUE_COMMENT_ID), 'run 2 is the `continue` resume');
  assert.ok(run2.some((e) => e.event === 'check-failed'), 'CHECK failed');
  assert.deepEqual(run2.filter((e) => e.event === 'llm-call').map((e) => e.state), ['DIAGNOSE'], 'DIAGNOSE ran, IMPLEMENT has not');
  const wait = run2.find((e) => e.event === 'pool-wait');
  assert.ok(wait);
  assert.equal(wait.state, 'IMPLEMENT', 'the pool-wait fired in the IMPLEMENT that follows DIAGNOSE');
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume.startState, 'IMPLEMENT');
  assert.equal(entry.resume.commentId, CONTINUE_COMMENT_ID);
  assert.deepEqual(entry.resume.counters, {
    diagnoseAttempts: 1,
    validateRejects: 0,
    ciImplementRetries: 0,
    seenRootCauses: [STEP_PAYLOADS[DIAGNOSE_KEY].root_cause],
  }, 'the DIAGNOSE attempt and the cause it named ride the re-enqueue');

  // ---- run 3: the wake-up resumes at IMPLEMENT. IMPLEMENT fixes the check, and the run reaches
  // VALIDATE without meeting DIAGNOSE again.
  accounts.writeState(poolDir, {});
  const callsBefore = world.calls.length;
  const claudeBefore = world.claudeCalls.length;
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  const iResumed = indexOf(run3, (e) => e.event === 'resumed-at-implement', 'resumed-at-implement');
  const iImplement = indexOf(run3, isLlm('IMPLEMENT'), 'an IMPLEMENT llm-call');
  const iCheckTransition = indexOf(run3, (e) => e.event === 'transition' && e.state === 'CHECK', 'a transition out of CHECK');
  assert.ok(iResumed < iImplement && iImplement < iCheckTransition, 'IMPLEMENT runs before CHECK re-checks anything');
  assert.equal(run3.findIndex((e) => e.event === 'llm-call'), iImplement, "IMPLEMENT is the wake-up's first model call");
  assert.ok(!run3.some(isLlm('DIAGNOSE')), 'DIAGNOSE never re-meets the failure it already named');
  assert.ok(!run3.some((e) => e.event === 'check-failed'), 'CHECK now passes: IMPLEMENT fixed the diff first');
  assert.ok(!run3.some((e) => e.event === 'parked' && /^diagnose-/.test(e.reason)), 'no diagnose-no-new-cause / diagnose-duplicate-root-cause park');
  assert.ok(run3.some(isLlm('VALIDATE')), 'the run goes on to VALIDATE');
  assertSameWorktreeAndPr(run3, world.calls.slice(callsBefore), world, worktreePath);
  assert.equal(run3[iImplement].effort, 'medium', 'the carried diagnoseAttempts (1) escalates a size-S IMPLEMENT');
  const firstImplementCall = world.claudeCalls.slice(claudeBefore).find((c) => c.key === IMPLEMENT_KEY);
  assert.ok(firstImplementCall.prompt.includes(STEP_PAYLOADS[DIAGNOSE_KEY].root_cause), "IMPLEMENT's prompt carries DIAGNOSE's finding, read back from the journal");
});

test('#279 dirty-tree rule (end to end): an IMPLEMENT cut short after editing the tree (llm-transport-failed:IMPLEMENT, a transient retry) wakes up at IMPLEMENT and KEEPS the tree -- no dirty-worktree park, no wip/ push, IMPLEMENT re-runs on it', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir, worktreePath } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET);
  // The first IMPLEMENT after the REJECT edits the tree, then its reply is unusable.
  afterNextValidate(world, () => {
    world.implementCutShort = 1;
  });

  // ---- run 2: the `continue`. ... VALIDATE (REJECT) -> IMPLEMENT (cut short) -> transient retry.
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  const retry = run2.find((e) => e.event === 'transient-retry');
  assert.ok(retry, 'run 2 ends in a transient retry');
  assert.equal(retry.state, 'IMPLEMENT');
  assert.equal(retry.reason, 'llm-transport-failed:IMPLEMENT');
  assert.equal(world.treeDirty, true, 'the cut-short IMPLEMENT left the tree dirty');
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume.startState, 'IMPLEMENT');
  assert.equal(entry.transientRetries, 1);

  // ---- run 3: prepareResume finds the dirty tree and keeps it; IMPLEMENT runs on it.
  const callsBefore = world.calls.length;
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  const run3Calls = world.calls.slice(callsBefore);
  const iResumed = indexOf(run3, (e) => e.event === 'resumed-at-implement', 'resumed-at-implement');
  const iKept = indexOf(run3, (e) => e.event === 'resume-dirty-tree-kept', 'resume-dirty-tree-kept');
  const iPrepared = indexOf(run3, (e) => e.event === 'resume-prepared', 'resume-prepared');
  const iImplement = indexOf(run3, isLlm('IMPLEMENT'), 'an IMPLEMENT llm-call');
  assert.ok(iResumed < iKept && iKept < iPrepared && iPrepared < iImplement, 'kept, prepared, then IMPLEMENT');
  assert.equal(run3[iKept].state, 'IMPLEMENT');
  assert.equal(run3[iKept].entries, 1, "the fake tree's one modified file");
  assert.ok(!run3.some((e) => e.event === 'parked' && e.reason === 'resume-precondition-failed'), 'no dirty-worktree refusal');
  assert.ok(!run3.some((e) => /wip-preserve/.test(e.event)), 'no wip preservation: the tree is kept, not moved');
  assert.equal(run3Calls.filter(isWipPush).length, 0, 'nothing pushed to wip/');
  const iCheckout = run3Calls.findIndex((c) => c.command === 'git' && (c.args.includes('checkout') || c.args.includes('reset') || c.args.includes('clean')));
  assert.equal(iCheckout, -1, 'no checkout/reset/clean touches the tree');
  assert.ok(run3.some((e) => e.state === 'PUSH_PR' && e.event === 'spawn'), 'the run reaches PUSH_PR, which commits the work');
  assertSameWorktreeAndPr(run3, run3Calls, world, worktreePath);
});

test('#279 (end to end, unchanged): a run with NO `continue` that pool-waits at IMPLEMENT after a VALIDATE REJECT carries no resume -- the wake-up restarts at INTAKE', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir } = setupReplay();
  config.validateRejectBudget = PRODUCTION_VALIDATE_REJECT_BUDGET;
  coolOpusAfterNextValidate(world, poolDir);

  // ---- run 1: the fresh card. INTAKE ... VALIDATE (REJECT) -> IMPLEMENT, pool-wait.
  await drainQueueOnce(queueDir, journalRoot, config);
  const run1 = segment(readJournal(taskDir), 1);
  const wait = run1.find((e) => e.event === 'pool-wait');
  assert.ok(wait);
  assert.equal(wait.state, 'IMPLEMENT');
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume, undefined, 'no descriptor: this run was never resumed');

  accounts.writeState(poolDir, {});
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  assert.ok(!run2.some((e) => /^resumed-at-/.test(e.event)));
  assert.equal(run2.find((e) => e.event === 'transition').state, 'INTAKE', 'the wake-up restarts at INTAKE, as before #279');
});

// For a POOL-WAIT the machine lineage's drop comes from poolWaitResume (a machine prior gets a
// fresh descriptor only in VALIDATE); carriedResume's own machine drop is what a transient retry
// out of IMPLEMENT hits, pinned by 'a machine-RESUMED run takes a transient retry' in part 1.
test('#255 (end to end, unchanged by options A and B): a #251 MACHINE resume that pool-waits at IMPLEMENT after a VALIDATE REJECT drops its descriptor -- the wake-up restarts at INTAKE', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir } = setupReplay();
  config.validateRejectBudget = PRODUCTION_VALIDATE_REJECT_BUDGET;
  coolFableOnFirstReject(world, poolDir, Date.now() + 51 * 60 * 1000);
  await drainQueueOnce(queueDir, journalRoot, config);
  const entry1 = elapseWait(queueDir);
  assert.equal(entry1.resume.source, 'pool-wait', 'run 1 re-enqueued a machine resume');

  // ---- run 2: the machine resume. CHECK ... VALIDATE (REJECT, 2 of 3) -> IMPLEMENT, pool-wait.
  accounts.writeState(poolDir, {});
  coolOpusAfterNextValidate(world, poolDir);
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  const resumed = run2.find((e) => e.event === 'resumed-at-check');
  assert.ok(resumed && resumed.source === 'pool-wait', 'run 2 is the machine resume');
  const wait = run2.find((e) => e.event === 'pool-wait');
  assert.ok(wait);
  assert.equal(wait.state, 'IMPLEMENT');

  const entry2 = elapseWait(queueDir);
  assert.equal(entry2.resume, undefined, 'a machine descriptor never rides a re-enqueue out of IMPLEMENT (#251)');

  accounts.writeState(poolDir, {});
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  assert.ok(!run3.some((e) => e.event === 'resumed-at-check'));
  assert.equal(run3.find((e) => e.event === 'transition').state, 'INTAKE', 'the wake-up restarts at INTAKE');
});

// ================================================================================================
// ---- part 6: card #281 -- a MACHINE re-enqueue keeps the run's own tree, at CHECK too ----------
// ================================================================================================
//
// #279 kept the run's own in-flight work (a dirty tree, commits on top of origin's tip) only for a
// resume at IMPLEMENT. A `continue` lineage re-enqueued anywhere else -- inside DIAGNOSE above all --
// is carried with `startState: 'CHECK'`, and its wake-up met the same tree and refused it
// (`dirty-worktree`, `not-fast-forward`); every later `continue` then refused it again. #281 keys
// the rule on who wrote the descriptor instead: a machine re-enqueue (it carries `counters`) keeps
// the tree whatever the start state; a maintainer's `continue` after a park refuses it, unchanged.
// And a refusal that parks a run whose dirty tree was kept preserves it to `wip/` and re-attaches
// the branch, so the maintainer's next `continue` starts clean.

// A collaborator's `continue` reply, read by the REAL unparkScan (setupContinueReplay's shape).
async function maintainerContinue(queueDir, journalRoot, config, commentId) {
  const comments = [{ id: commentId, user: { login: 'Crazz-E' }, created_at: '2026-09-25T01:00:00Z', body: 'continue' }];
  await unparkScan(queueDir, journalRoot, { ...config, queueDir }, {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      if (command === 'gh' && args[0] === 'api') return ok(JSON.stringify(comments));
      return ok('');
    },
  });
  return readOnlyQueued(queueDir);
}

// Runs `fn` once, right after the NEXT IMPLEMENT model call has been spawned.
function afterNextImplement(world, fn) {
  const spawn = world.spawn;
  const target = world.claudeCalls.filter((c) => c.key === IMPLEMENT_KEY).length + 1;
  let fired = false;
  world.spawn = (command, args) => {
    const child = spawn(command, args);
    if (!fired && world.claudeCalls.filter((c) => c.key === IMPLEMENT_KEY).length === target) {
      fired = true;
      fn();
    }
    return child;
  };
}

const isResumeRefusal = (e) => e.event === 'parked' && e.reason === 'resume-precondition-failed';
const CAUSE_TYPECHECK = 'doc/x.md references an undefined symbol';
const CAUSE_LINT = 'doc/x.md leaves an unused variable behind';

test('#281 shape 1 (end to end, DIAGNOSE path): a `continue`d run whose fix does not hold, re-enqueued INSIDE DIAGNOSE, wakes up at CHECK and KEEPS the dirty tree -- no dirty-worktree park, CHECK runs on the tree and the run proceeds', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir, worktreePath } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET, { size: 'S' });
  world.checkBroken = true; // the maintainer's resolved branch fails typecheck
  world.implementBreaksLint = 1; // IMPLEMENT's first fix clears it and breaks lint instead
  world.diagnoseCauses = [CAUSE_TYPECHECK, CAUSE_LINT];
  afterNextImplement(world, () => coolOpus(poolDir)); // the SECOND DIAGNOSE finds Opus 5.5 cooling

  // ---- run 2: the `continue`. CHECK (typecheck) -> DIAGNOSE -> IMPLEMENT -> CHECK (lint) ->
  // DIAGNOSE, pool-wait at its lease.
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  assert.ok(run2.some((e) => e.event === 'resumed-at-check' && e.commentId === CONTINUE_COMMENT_ID), 'run 2 is the `continue` resume');
  assert.deepEqual(run2.filter((e) => e.event === 'llm-call').map((e) => e.state), ['DIAGNOSE', 'IMPLEMENT'], 'one DIAGNOSE, one IMPLEMENT');
  assert.deepEqual(run2.filter((e) => e.event === 'check-failed').map((e) => e.alias), ['typecheck', 'lint'], 'the fix did not hold');
  const wait = run2.find((e) => e.event === 'pool-wait');
  assert.ok(wait);
  assert.equal(wait.state, 'DIAGNOSE', 'the re-enqueue fired inside DIAGNOSE');
  assert.equal(world.treeDirty, true, "IMPLEMENT's edits are still uncommitted: CHECK failed before PUSH_PR");
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume.startState, 'CHECK', 'carried out of DIAGNOSE at CHECK (#279)');
  assert.equal(entry.resume.commentId, CONTINUE_COMMENT_ID);
  assert.ok(isMachineReEnqueueResume(entry.resume), 'a machine re-enqueue wrote it: it carries counters');

  // ---- run 3: the wake-up. prepareResume keeps the tree; CHECK re-meets lint; the run proceeds.
  accounts.writeState(poolDir, {});
  const callsBefore = world.calls.length;
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  const run3Calls = world.calls.slice(callsBefore);
  assert.deepEqual(run3.filter(isResumeRefusal).map((e) => e.detail.step), [], 'no dirty-worktree park');
  const iResumed = indexOf(run3, (e) => e.event === 'resumed-at-check', 'resumed-at-check');
  const iKept = indexOf(run3, (e) => e.event === 'resume-dirty-tree-kept', 'resume-dirty-tree-kept');
  const iPrepared = indexOf(run3, (e) => e.event === 'resume-prepared', 'resume-prepared');
  const iLint = indexOf(run3, (e) => e.event === 'check-failed' && e.alias === 'lint', 'CHECK re-meeting lint');
  const iDiagnose = indexOf(run3, isLlm('DIAGNOSE'), 'a DIAGNOSE llm-call');
  const iImplement = indexOf(run3, isLlm('IMPLEMENT'), 'an IMPLEMENT llm-call');
  const iCheckOk = indexOf(run3, (e) => e.event === 'transition' && e.state === 'CHECK' && e.to === 'PUSH_PR', 'CHECK passing');
  assert.ok(iResumed < iKept && iKept < iPrepared && iPrepared < iLint, 'kept, prepared, then CHECK ran on the kept tree');
  assert.ok(iLint < iDiagnose && iDiagnose < iImplement && iImplement < iCheckOk, 'DIAGNOSE names the new cause, IMPLEMENT fixes it, CHECK passes');
  assert.equal(run3[iKept].state, 'CHECK');
  assert.equal(run3[iKept].entries, 1);
  assert.ok(!run3.some((e) => e.event === 'parked' && /^diagnose-/.test(e.reason)), 'a new cause, not a duplicate');
  assert.ok(run3Calls.some((c) => c.command === 'git' && c.args.includes('commit')), "PUSH_PR commits the kept tree's work");
  assert.equal(run3Calls.filter(isWipPush).length, 0, 'nothing moved to wip/');
  assert.ok(!run3.some((e) => /wip-preserve/.test(e.event)));
  assertSameWorktreeAndPr(run3, run3Calls, world, worktreePath);
});

test('#281 shape 2 (end to end): a CI_CHECKS main-moved merge whose CHECK then fails, re-enqueued inside DIAGNOSE, wakes up at CHECK and KEEPS the unpushed merge commit -- no not-fast-forward park; PUSH_PR pushes it', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir, worktreePath } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET);
  // Run 2's CI_CHECKS finds origin/main moved under a file the branch touches (the bench verdict's
  // baseMain), merges it locally, and the merge breaks typecheck. Opus 5.5 cools at that moment, so
  // the DIAGNOSE after CHECK pool-waits.
  const onCiChecks = world.onCiChecks;
  world.onCiChecks = () => {
    onCiChecks();
    const verdicts = path.join(config.spoBenchDir, 'verdicts');
    fs.mkdirSync(verdicts, { recursive: true });
    fs.writeFileSync(path.join(verdicts, `${HEAD_SHA}.json`), JSON.stringify({ verdict: 'PASS', baseMain: 'd'.repeat(40) }));
  };
  world.onMainMovedMerge = () => {
    world.onMainMovedMerge = null;
    world.checkBroken = true;
    coolOpus(poolDir);
  };

  // ---- run 2: the `continue`. CHECK -> PUSH_PR -> GATE -> CI_CHECKS (main moved: merge) -> CHECK
  // (fails) -> DIAGNOSE, pool-wait.
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  const iMerge = indexOf(run2, (e) => e.event === 'main-moved-merge' && e.state === 'CI_CHECKS', 'the main-moved merge');
  const iFailed = indexOf(run2, (e) => e.event === 'check-failed', 'CHECK failing after it');
  const iWait = indexOf(run2, (e) => e.event === 'pool-wait', 'the pool-wait');
  assert.ok(iMerge < iFailed && iFailed < iWait);
  assert.equal(run2[iWait].state, 'DIAGNOSE');
  assert.equal(world.localHead, MERGED_SHA, 'the merge commit is local only ...');
  assert.notEqual(world.remoteHead, MERGED_SHA, '... origin has never seen it');
  const entry = elapseWait(queueDir);
  assert.equal(entry.resume.startState, 'CHECK');
  assert.ok(isMachineReEnqueueResume(entry.resume));

  // ---- run 3: the wake-up keeps the commit, and PUSH_PR later pushes it.
  accounts.writeState(poolDir, {});
  const callsBefore = world.calls.length;
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  const run3Calls = world.calls.slice(callsBefore);
  assert.deepEqual(run3.filter(isResumeRefusal).map((e) => e.detail.step), [], 'no not-fast-forward park');
  const iKept = indexOf(run3, (e) => e.event === 'resume-unpushed-commits-kept', 'resume-unpushed-commits-kept');
  const iPrepared = indexOf(run3, (e) => e.event === 'resume-prepared', 'resume-prepared');
  const iCheck = indexOf(run3, (e) => e.event === 'transition' && e.state === 'CHECK', 'a transition out of CHECK');
  assert.ok(iKept < iPrepared && iPrepared < iCheck);
  assert.equal(run3[iKept].state, 'CHECK');
  assert.equal(run3[iKept].head, MERGED_SHA);
  assert.equal(run3[iKept].remote, HEAD_SHA);
  assert.equal(run3[iPrepared].head, MERGED_SHA, 'HEAD stays on the merge commit');
  assert.equal(run3[iPrepared].fastForwardedFrom, null);
  assert.equal(run3Calls.filter((c) => c.command === 'git' && (c.args.includes('--ff-only') || c.args.includes('reset'))).length, 0, 'never a fast-forward or a reset');
  assert.equal(world.remoteHead, MERGED_SHA, 'PUSH_PR pushed the merge commit to origin');
  assertSameWorktreeAndPr(run3, run3Calls, world, worktreePath);
});

// Two refusals: `fetch-failed` after step 6 kept the tree, and (F1, verifier fix pass)
// `pr-read-failed` at step 3, before step 6 looked -- runTask's catch probes the tree for that one.
for (const [step, fail, keptByStep6] of [
  ['fetch-failed', (world) => (world.fetchFailures = 1), true],
  ['pr-read-failed', (world) => (world.prViewFailures = 1), false],
]) {
  test(`#281 shape 3 (end to end): an IMPLEMENT resume on the run's own dirty tree, refused (${step}), parks with the tree preserved to wip/ and the branch re-attached -- the maintainer's next \`continue\` succeeds, no second park`, async () => {
    const { queueDir, journalRoot, config, world, taskDir, worktreePath } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET);
    afterNextValidate(world, () => {
      world.implementCutShort = 1; // the IMPLEMENT after the REJECT edits the tree, then its reply is unusable
    });

    // ---- run 2: the `continue`. ... VALIDATE (REJECT) -> IMPLEMENT (cut short) -> transient retry.
    await drainQueueOnce(queueDir, journalRoot, config);
    assert.equal(world.treeDirty, true);
    const entry = elapseWait(queueDir);
    assert.equal(entry.resume.startState, 'IMPLEMENT');

    // ---- run 3: the refusal park (after step 6 kept the tree, or at step 3 before it looked).
    fail(world);
    const callsBefore = world.calls.length;
    await drainQueueOnce(queueDir, journalRoot, config);
    const run3 = segment(readJournal(taskDir), 3);
    const run3Calls = world.calls.slice(callsBefore);
    const iParked = indexOf(run3, isResumeRefusal, 'the refusal park');
    const iPreserved = indexOf(run3, (e) => e.event === 'wip-preserved', 'wip-preserved');
    const iReattached = indexOf(run3, (e) => e.event === 'wip-reattached', 'wip-reattached');
    assert.ok(iParked < iPreserved && iPreserved < iReattached, 'refused, preserved, re-attached');
    if (keptByStep6) {
      assert.ok(indexOf(run3, (e) => e.event === 'resume-dirty-tree-kept', 'resume-dirty-tree-kept') < iParked);
    } else {
      assert.ok(!run3.some((e) => e.event === 'resume-dirty-tree-kept'), 'step 6 never ran: the catch probed the tree');
    }
    assert.equal(run3[iParked].detail.step, step);
    assert.equal(run3[iParked].state, 'IMPLEMENT');
    assert.ok(!run3.some((e) => e.event === 'wip-preserve-skipped'), 'a kept tree is not skipped');
    assert.equal(run3[iReattached].branch, `claude-pipe/${ID}`);
    // No work lost: the wip push lands BEFORE the checkout that re-attaches the branch.
    const iWipPush = run3Calls.findIndex(isWipPush);
    const iCheckoutBranch = run3Calls.findIndex((c) => c.command === 'git' && c.args.includes('checkout') && c.args.includes(`claude-pipe/${ID}`));
    assert.ok(iWipPush >= 0 && iCheckoutBranch > iWipPush, 'pushed to wip/, then re-attached');
    const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
    assert.equal(state.state, 'PARKED');
    assert.match(fs.readFileSync(path.join(taskDir, 'report.md'), 'utf8'), /wip\//, 'the park names the wip/ ref the work went to');
    assert.equal(world.treeDirty, false, 'the tree is clean');
    assert.equal(world.detached, false, 'and back on its branch');

    // ---- the maintainer replies `continue` once. Run 4 resumes at CHECK and gets past prepareResume.
    const entry4 = await maintainerContinue(queueDir, journalRoot, config, 9001);
    assert.equal(isMachineReEnqueueResume(entry4.resume), false, "a maintainer's descriptor");
    await drainQueueOnce(queueDir, journalRoot, config);
    const run4 = segment(readJournal(taskDir), 4);
    indexOf(run4, (e) => e.event === 'resumed-at-check' && e.commentId === 9001, 'the `continue` resume');
    indexOf(run4, (e) => e.event === 'resume-prepared', 'resume-prepared');
    assert.deepEqual(run4.filter(isResumeRefusal).map((e) => e.detail.step), [], 'no second park: one round trip');
    assert.ok(run4.some(isLlm('VALIDATE')), 'the run goes on to VALIDATE');
    assert.equal(fs.existsSync(worktreePath), true);
  });
}

test('#281 (end to end, pinned unchanged): a maintainer `continue` onto a DIRTY tree after an ordinary park refuses dirty-worktree and leaves the tree alone -- and so does the next one', async () => {
  const { queueDir, journalRoot, config, world, taskDir } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET);
  world.treeDirty = true; // someone's edits, after the park handed the tree to a human
  const callsBefore = world.calls.length;
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  const parked = run2.find(isResumeRefusal);
  assert.ok(parked);
  assert.equal(parked.detail.step, 'dirty-worktree');
  assert.ok(run2.some((e) => e.event === 'wip-preserve-skipped'), 'a human-handed tree is never preserved over');
  assert.ok(!run2.some((e) => e.event === 'resume-dirty-tree-kept'));
  assert.equal(world.calls.slice(callsBefore).filter(isWipPush).length, 0);
  assert.equal(world.treeDirty, true, 'the tree is left exactly as found');

  const entry = await maintainerContinue(queueDir, journalRoot, config, 9002);
  assert.equal(entry.resume.counters, undefined, 'a `continue` descriptor never carries counters');
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  assert.equal(run3.find(isResumeRefusal).detail.step, 'dirty-worktree', 'the next `continue` refuses it too');
});

test('#281 (end to end, pinned unchanged): an ordinary park preserves a dirty tree to wip/ and leaves HEAD detached, so a `continue` parks detached-or-wrong-branch', async () => {
  const { queueDir, journalRoot, config, world, taskDir } = setupReplay();
  // A real-mode ordinary park on a dirty tree, the way CI_CHECKS parks main-moved-twice.
  const worktreePath = path.join(config.pipelineWorktreesDir, ID);
  fs.mkdirSync(worktreePath, { recursive: true });
  const task = { id: ID, kind: 'card', issue: 888, title: 't' };
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(task));
  for (const f of queuedFiles(queueDir)) fs.rmSync(path.join(queueDir, f));
  const ctx = buildCtx(ID, { ...task, worktreePath }, taskDir, { ...config, queueDir });
  ctx.prNumber = PR;
  world.remoteBranch = true;
  world.prOpen = PR;
  world.treeDirty = true;
  finalizePark(ctx, 'CI_CHECKS', 'main-moved-twice', { mainMoveUsed: 1, mainMovedRegateBudget: 1 });
  const events = readJournal(taskDir);
  assert.ok(events.some((e) => e.event === 'wip-preserved'), 'the ordinary park preserved the tree');
  assert.ok(!events.some((e) => e.event === 'wip-reattached'), 'and did not re-attach the branch (#281 is scoped to a kept tree)');
  assert.equal(world.detached, true);

  await maintainerContinue(queueDir, journalRoot, config, 9003);
  await drainQueueOnce(queueDir, journalRoot, config);
  const parked = readJournal(taskDir).filter(isResumeRefusal).pop();
  assert.equal(parked.detail.step, 'detached-or-wrong-branch');
});

// ---- #281: the discriminator, writer by writer -------------------------------------------------
//
// Every `resume` a queue entry can carry comes from reEnqueueTask's `extra`, and there are three
// writers of one: carriedResume, poolWaitResume (both finalizePark) and unparkScan's `continue`.
// `retry` writes none, and reEnqueueTask strips whatever task.json still holds. Each is pinned here
// against isMachineReEnqueueResume, so a writer that starts or stops carrying `counters` goes red.

test('isMachineReEnqueueResume: true only for a plain-object `counters` (#281)', () => {
  assert.equal(isMachineReEnqueueResume({ startState: 'CHECK', counters: {} }), true);
  assert.equal(isMachineReEnqueueResume({ startState: 'CHECK', counters: { validateRejects: 1 } }), true);
  for (const bad of [undefined, null, [], 'x', 1, {}, { counters: null }, { counters: [] }, { counters: 'x' }, { counters: 0 }, { source: 'pool-wait' }]) {
    assert.equal(isMachineReEnqueueResume(bad), false, JSON.stringify(bad));
  }
});

// carriedResume, for a `continue` lineage: every state a resumed run can re-enqueue from, through
// both machine branches of finalizePark.
for (const [lastState, transientReason] of [
  ['CHECK', null],
  ['PUSH_PR', null],
  ['GATE', 'gate-non-attesting'],
  ['CI_CHECKS', null],
  ['DIAGNOSE', 'llm-transport-failed:DIAGNOSE'],
  ['IMPLEMENT', 'llm-transport-failed:IMPLEMENT'],
  ['VALIDATE', 'llm-transport-failed:VALIDATE'],
]) {
  test(`discriminator (#281): carriedResume of a \`continue\` lineage out of ${lastState} is a machine descriptor`, () => {
    for (const kind of transientReason ? ['pool-wait', 'transient'] : ['pool-wait']) {
      const config = parkConfig();
      const resume = { startState: 'CHECK', prNumber: 55, worktreePath: '/x', commentId: 7, fromReason: 'merge-conflict' };
      assert.equal(isMachineReEnqueueResume(resume), false, "the maintainer's own descriptor is not");
      const ctx = midRunCtx({ config, prNumber: 55, task: { resume } });
      if (kind === 'pool-wait') {
        const { reason, detail } = coolingPark();
        finalizePark(ctx, lastState, reason, detail);
      } else {
        finalizePark(ctx, lastState, transientReason, {});
      }
      const requeued = readOnlyQueued(config.queueDir);
      assert.equal(requeued.resume.commentId, 7, `${kind}: carried`);
      assert.equal(isMachineReEnqueueResume(requeued.resume), true, `${kind}: carries counters`);
    }
  });
}

test('discriminator (#281): poolWaitResume (a fresh #251 descriptor) and a carried #251 descriptor are machine descriptors', () => {
  const fresh = parkConfig();
  const { reason, detail } = coolingPark();
  finalizePark(midRunCtx({ config: fresh, prNumber: 891 }), 'VALIDATE', reason, detail);
  const freshEntry = readOnlyQueued(fresh.queueDir);
  assert.equal(freshEntry.resume.source, 'pool-wait');
  assert.equal(isMachineReEnqueueResume(freshEntry.resume), true);

  const carried = parkConfig();
  finalizePark(machineResumedCtx(carried), 'GATE', 'gate-non-attesting', {});
  const carriedEntry = readOnlyQueued(carried.queueDir);
  assert.equal(carriedEntry.resume.source, 'pool-wait');
  assert.equal(isMachineReEnqueueResume(carriedEntry.resume), true);
});

// A parked task whose task.json still holds a MACHINE descriptor (the run that parked was one), so
// the unparkScan writers are shown to write a fresh object, never to inherit `counters`.
async function unparkReply(body) {
  const config = parkConfig();
  const journalRoot = mkTmp('spo-pwr-unpark-journal-');
  const taskDir = path.join(journalRoot, ID);
  fs.mkdirSync(taskDir, { recursive: true });
  const worktreePath = path.join(config.pipelineWorktreesDir, ID);
  const stale = { startState: 'CHECK', prNumber: PR, worktreePath, source: 'pool-wait', counters: { diagnoseAttempts: 1, validateRejects: 2, ciImplementRetries: 0, seenRootCauses: [] } };
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: ID, kind: 'card', issue: 888, title: 't', resume: stale }));
  writeState(taskDir, { id: ID, state: 'PARKED', reason: 'resume-precondition-failed', prNumber: PR, worktreePath });
  appendEvent(taskDir, 'CHECK', 'parked', { reason: 'resume-precondition-failed' });
  appendEvent(taskDir, 'PARKED', 'park-comment', { commentId: PARK_COMMENT_ID, reason: 'resume-precondition-failed' });
  const comments = [{ id: 9100, user: { login: 'Crazz-E' }, created_at: '2026-09-25T02:00:00Z', body }];
  await unparkScan(config.queueDir, journalRoot, config, {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      if (command === 'gh' && args[0] === 'api') return ok(JSON.stringify(comments));
      return ok('');
    },
  });
  return readOnlyQueued(config.queueDir);
}

test("discriminator (#281): unparkScan's `continue` writes a fresh descriptor with NO counters -- even over a task.json holding a machine one", async () => {
  const entry = await unparkReply('continue');
  assert.equal(entry.resume.commentId, 9100, 'the `continue` descriptor');
  assert.equal(entry.resume.startState, 'CHECK');
  assert.equal('counters' in entry.resume, false);
  assert.equal('source' in entry.resume, false);
  assert.equal(isMachineReEnqueueResume(entry.resume), false);
});

test("discriminator (#281): unparkScan's `retry` writes no resume at all -- the stale machine one in task.json is stripped", async () => {
  const entry = await unparkReply('retry');
  assert.equal(entry.resume, undefined);
  assert.equal(isMachineReEnqueueResume(entry.resume), false);
});

test('discriminator (#281): an ordinary park writes no queue entry, so no descriptor at all', () => {
  const config = parkConfig();
  const resume = { startState: 'CHECK', prNumber: 55, worktreePath: '/x', counters: { diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, seenRootCauses: [] } };
  finalizePark(midRunCtx({ config, prNumber: 55, task: { resume } }), 'CI_CHECKS', 'main-moved-twice', {});
  assert.deepEqual(queuedFiles(config.queueDir), []);
});
