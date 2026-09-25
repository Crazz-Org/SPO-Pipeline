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
// each wake-up, not what a helper returns. Part 5 (card #255, option A) replays a maintainer's
// `continue` the same way, through the real unparkScan.
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

// Card #255, option A (decided 2026-09-25): a maintainer `continue` lineage keeps #212 C4's rule.
// Its descriptor is carried even from IMPLEMENT/DIAGNOSE, pool-wait and transient retry alike, so
// the maintainer's fix and PR are kept (the end-to-end pin is part 5).
for (const lastState of ['IMPLEMENT', 'DIAGNOSE']) {
  test(`finalizePark: a maintainer \`continue\` lineage keeps #212 C4's rule -- its descriptor is carried even from ${lastState} (#255 option A)`, () => {
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
      assert.equal(requeued.resume.counters.validateRejects, 1, `${kind}: a machine re-enqueue carries the run's counters`);
    }
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

// ================================================================================================
// ---- part 3: #888 replayed end to end through drainQueueOnce ------------------------------------
// ================================================================================================

const ID = 'issue-888';
const HEAD_SHA = 'b'.repeat(40);
const ORIGIN_MAIN_SHA = 'a'.repeat(40);
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
};
const VALIDATE_KEY = 'verdict,reasons,findings';
const IMPLEMENT_KEY = 'summary,files_changed,invariants,tests_run,all_green';
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
      if (args.includes('push') && args.some((a) => String(a).includes(':refs/heads/wip/'))) return ok('');
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) return fail(1);
      if (args.includes('rev-parse') && args.some((a) => String(a).startsWith('refs/remotes/origin/'))) {
        return world.remoteBranch ? ok(`${HEAD_SHA}\n`) : fail(1);
      }
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${ORIGIN_MAIN_SHA}\n`);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${HEAD_SHA}\n`);
      if (args.includes('symbolic-ref')) return ok(`${branch}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok(world.treeDirty ? ' M doc/x.md\n' : '');
      if (args.includes('add') && args.includes('-A')) return ok('');
      if (args.includes('commit')) {
        world.treeDirty = false;
        return ok('');
      }
      if (args.includes('push')) {
        world.remoteBranch = true;
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
        return ok(JSON.stringify({ state: world.prOpen ? 'OPEN' : 'CLOSED', headRefName: branch }));
      }
      if (args[0] === 'pr' && args[1] === 'close') {
        world.closedPrs.push(Number(args[2]));
        world.prOpen = null;
        return ok('');
      }
      if (args[0] === 'api' && args.some((a) => String(a).includes('check-runs'))) {
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
      if (key === IMPLEMENT_KEY) world.treeDirty = true; // IMPLEMENT edits the worktree
    }
    world.claudeCalls.push({ key });
    if (!payload) throw new Error(`no canned payload for required=[${key}]`);
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
        result: JSON.stringify(payload),
      },
    ]);
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

function setupReplay() {
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
    size: 'M',
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
// ---- part 5: card #255, option A -- a `continue` lineage back in IMPLEMENT keeps resuming at CHECK
// ================================================================================================
//
// A run resumed by a maintainer's `continue` (#212) that goes back to IMPLEMENT (a VALIDATE REJECT)
// and is re-enqueued there (here a pool-wait) KEEPS its descriptor, so the next wake-up resumes at
// CHECK on the same worktree and PR. That costs one VALIDATE and one unit of reject budget per such
// event; in exchange the maintainer's fix and the PR are always kept. Restarting at INTAKE instead
// (option C, the superseded `fix-255` branch) made WORKTREE's leftover sweep close the PR the
// maintainer had just fixed. The #251 machine lineage is unchanged: it drops its descriptor there.

const CONTINUE_COMMENT_ID = 4242;
const PARK_COMMENT_ID = 100;

// Run 1 is #888's own first run (INTAKE ... VALIDATE REJECT -> IMPLEMENT -> ... -> VALIDATE
// pool-wait), which leaves exactly what a later `continue` resumes: PLAN's artefacts in the
// journal, the worktree on disk, the branch pushed, the PR open, the tree clean. Its machine
// re-enqueue is then replaced by a merge-conflict park (state.json + `parked` + `park-comment`,
// the fixture shape test/unpark-continue.test.js uses), and a collaborator's `continue` reply is
// read by the REAL unparkScan, which writes the queue entry run 2 takes. Returns with the pool
// clear.
async function setupContinueReplay(validateRejectBudget) {
  const replay = setupReplay();
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

test('#255 option A (end to end): a `continue`d run that pool-waits at IMPLEMENT after a VALIDATE REJECT keeps its descriptor -- the wake-up resumes at CHECK on the same worktree and PR, and at the production budget IMPLEMENT then runs there', async () => {
  // The decision's cost statement holds at the production budget, not the replay's 2.
  assert.equal(PRODUCTION_VALIDATE_REJECT_BUDGET, 3, 'config.js validateRejectBudget -- re-read #255 if this moves');
  const { queueDir, journalRoot, poolDir, config, world, taskDir, worktreePath } = await setupContinueReplay(PRODUCTION_VALIDATE_REJECT_BUDGET);
  coolOpusAfterNextValidate(world, poolDir);

  // ---- run 2: the `continue`. CHECK -> PUSH_PR -> GATE -> CI_CHECKS -> VALIDATE (REJECT) ->
  // IMPLEMENT, pool-wait.
  await drainQueueOnce(queueDir, journalRoot, config);
  const run2 = segment(readJournal(taskDir), 2);
  assert.ok(run2.some((e) => e.event === 'resumed-at-check' && e.commentId === CONTINUE_COMMENT_ID), 'run 2 is the `continue` resume');
  assert.deepEqual(run2.filter((e) => e.event === 'llm-call').map((e) => e.state), ['VALIDATE'], 'the `continue` run reached VALIDATE, and IMPLEMENT has not run');
  const wait = run2.find((e) => e.event === 'pool-wait');
  assert.ok(wait, 'run 2 ends in a pool-wait');
  assert.equal(wait.state, 'IMPLEMENT', 'the pool-wait fired in IMPLEMENT, the step the REJECT routed to');

  // The queue entry CARRIES the maintainer's descriptor out of IMPLEMENT.
  const entry = elapseWait(queueDir);
  assert.ok(entry.resume, 'the `continue` descriptor rides the re-enqueue out of IMPLEMENT (#255 option A)');
  assert.equal(entry.resume.startState, 'CHECK');
  assert.equal(entry.resume.commentId, CONTINUE_COMMENT_ID, 'the maintainer descriptor, carried -- not a fresh machine one');
  assert.equal(entry.resume.source, undefined, 'still the human lineage');
  assert.equal(entry.resume.fromReason, 'merge-conflict');
  assert.equal(entry.resume.worktreePath, worktreePath, 'the same worktree');
  assert.equal(entry.resume.prNumber, PR, 'the same PR');
  assert.equal(entry.resume.counters.validateRejects, 1, "a machine re-enqueue carries the run's REJECT count");
  assert.ok(entry.poolWaitAttempts >= 1, 'still an ordinary pool-wait');

  // ---- run 3: Opus 5.5 is back. The wake-up resumes at CHECK on the same worktree and PR, spends
  // one VALIDATE on the unchanged diff (the cost the decision accepts), and with a budget of 3 that
  // REJECT (2 of 3) routes to IMPLEMENT, which runs on the existing worktree.
  accounts.writeState(poolDir, {});
  const callsBefore = world.calls.length;
  const validateBefore = world.validateCalls;
  await drainQueueOnce(queueDir, journalRoot, config);
  const run3 = segment(readJournal(taskDir), 3);
  const run3Calls = world.calls.slice(callsBefore);
  const resumed = run3.find((e) => e.event === 'resumed-at-check');
  assert.ok(resumed && resumed.commentId === CONTINUE_COMMENT_ID, 'the wake-up resumes at CHECK on the `continue` descriptor');
  assert.equal(resumed.prNumber, PR);
  assert.equal(resumed.worktreePath, worktreePath);
  assert.ok(run3.some((e) => e.event === 'resume-prepared'), 'prepareResume accepted the existing worktree');
  assert.deepEqual(run3.filter((e) => /^leftover-/.test(e.event)).map((e) => e.event), [], 'no leftover sweep');
  assert.ok(!run3.some((e) => ['INTAKE', 'WORKTREE', 'PLAN'].includes(e.state) && e.event !== 'taken'), 'no INTAKE restart');
  assert.equal(run3Calls.filter(isWorktreeAdd).length, 0, 'no new worktree');
  assert.ok(fs.existsSync(worktreePath), 'the worktree is still on disk');
  assert.equal(world.calls.filter(isPrClose).length, 0, 'the PR the maintainer fixed is never closed');
  assert.deepEqual(world.closedPrs, []);
  assert.ok(!run3.some((e) => e.event === 'pr-created'), 'no new PR');
  assert.ok(run3.some((e) => e.state === 'PUSH_PR' && e.event === 'pr-reused' && e.prNumber === PR), 'PUSH_PR reuses the same PR');

  const llm = run3.filter((e) => e.event === 'llm-call').map((e) => e.state);
  assert.equal(llm[0], 'VALIDATE', `the wake-up's first model call re-validates the unchanged diff (llm calls: ${llm.join(',')})`);
  assert.equal(llm[1], 'IMPLEMENT', `then the REJECT routes to IMPLEMENT, which runs (llm calls: ${llm.join(',')})`);
  // Every VALIDATE in this replay rejects, so the run ends on the third REJECT: 1 carried + the
  // wasted one + the one after IMPLEMENT. The carried count is enforced, not merely recorded.
  assert.equal(world.validateCalls - validateBefore, 2, 'one wasted VALIDATE, then the one after IMPLEMENT');
  const parked = run3.find((e) => e.event === 'parked');
  assert.ok(parked);
  assert.equal(parked.reason, 'validate-reject-budget-exhausted');
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.validateRejects, 3, "the carried REJECT (1) plus this run's two");
  assert.equal(state.prNumber, PR, 'the park still names the same PR');
});

// For a POOL-WAIT the machine lineage's drop comes from poolWaitResume (a machine prior gets a
// fresh descriptor only in VALIDATE); carriedResume's own machine drop is what a transient retry
// out of IMPLEMENT hits, pinned by 'a machine-RESUMED run takes a transient retry' in part 1.
test('#255 (end to end, unchanged by option A): a #251 MACHINE resume that pool-waits at IMPLEMENT after a VALIDATE REJECT drops its descriptor -- the wake-up restarts at INTAKE', async () => {
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
