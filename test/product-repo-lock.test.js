'use strict';
// Unit + real-process coverage for orchestrator/product-repo-lock.js (action 6.4): the mutex
// serializing WORKTREE's setup phase and FINISH's teardown against config.productRepo's shared
// `.git`. See that module's own header for the design this tests: ONE lock (not two), reusing
// lock.js's acquireShortLock/releaseShortLock idiom (write-tmp-then-link, pid-liveness +
// MAX_LOCK_AGE_MS staleness), and the WORST_HOLD_MS/MAX_LOCK_AGE_MS/waitBoundMs derivation from
// config.js's commandTimeoutsMs. Wiring-level coverage (realWorktree/realFinish actually acquiring
// and releasing this lock, and the ParkSignal a timeout produces) lives in test/real-steps.test.js
// instead, alongside every other realWorktree/realFinish test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { mkTmp } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude -- see
// test/no-real-spawn.js. Only spawnSync is patched; this file's real-process coverage below uses
// the async child_process.spawn, deliberately untouched (same precedent as test/lock.test.js and
// test/account-lease.test.js).
require('./no-real-spawn');

const {
  acquireProductRepoLock,
  releaseProductRepoLock,
  lockFilePath,
  waitBoundMs,
  WORST_HOLD_MS,
  MAX_LOCK_AGE_MS,
  ProductRepoLockTimeoutError,
} = require('../orchestrator/product-repo-lock');

const HOLD_FIXTURE = path.join(__dirname, 'fixtures', 'product-repo-lock-hold.js');
const CONSTANTS_FIXTURE = path.join(__dirname, 'fixtures', 'print-product-repo-lock-constants.js');

function newLockDir(prefix) {
  const dir = mkTmp(prefix);
  return { dir, filePath: path.join(dir, '.product-repo.lock') };
}

// Deliberately takes the worktrees DIR, never a lock file path: the fixture derives the path with
// production's own lockFilePath(cfg). See the fixture's own header for the mutation this closes.
function spawnHold(worktreesDir, holdMs, insideMarker, violationFlag, { waitMs, pollMs } = {}) {
  const args = [HOLD_FIXTURE, worktreesDir, String(holdMs), insideMarker, violationFlag];
  if (waitMs !== undefined) args.push(String(waitMs));
  if (pollMs !== undefined) args.push(String(pollMs));
  return spawn(process.execPath, args);
}

function waitExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

// ---- item 6: the wait bound and max age are DERIVED, not literals that can drift past
// commandTimeoutsMs -----------------------------------------------------------------------------

test('WORST_HOLD_MS/MAX_LOCK_AGE_MS are DERIVED from config.js\'s commandTimeoutsMs -- moving SPO_TIMEOUT_GIT_MS/SPO_TIMEOUT_NPM_CI_MS moves both', () => {
  const runWith = (envOverrides) =>
    JSON.parse(execFileSync(process.execPath, [CONSTANTS_FIXTURE], { encoding: 'utf8', env: { ...process.env, ...envOverrides } }));

  const base = runWith({});
  // Both terms of the sum (git-classified calls AND the single npm-ci call) get moved, so a
  // literal that happened to match ONE of them by coincidence still fails this.
  const changed = runWith({
    SPO_TIMEOUT_GIT_MS: String(base.git * 3),
    SPO_TIMEOUT_GH_MS: String(base.gh * 3),
    SPO_TIMEOUT_NPM_CI_MS: String(base.npmCi * 2),
  });

  // The formula, restated so intent is readable, checked against BOTH runs' own reported inputs --
  // a hardcoded WORST_HOLD_MS/MAX_LOCK_AGE_MS literal fails this unless it happens to equal every
  // one of these by coincidence, which the `changed` run makes vanishingly unlikely.
  for (const run of [base, changed]) {
    const worst = run.SETUP_GIT_CALLS * 2 * run.git + run.SETUP_GH_CALLS * 2 * run.gh + 1 * 2 * run.npmCi;
    assert.equal(run.WORST_HOLD_MS, worst, 'WORST_HOLD_MS must equal the documented sum-of-bounded-spawns formula');
    assert.equal(run.MAX_LOCK_AGE_MS, worst + Math.round(worst / 10), 'MAX_LOCK_AGE_MS must be WORST_HOLD_MS + 10% slack');
  }

  // And the actual point of this test: the derived numbers must actually MOVE when the underlying
  // constants do, not merely still satisfy the formula (which a stale literal would also do, once,
  // until commandTimeoutsMs next changes).
  assert.ok(changed.WORST_HOLD_MS > base.WORST_HOLD_MS, 'raising git/gh/npm-ci timeouts must raise the derived worst-hold');
  assert.ok(changed.MAX_LOCK_AGE_MS > base.MAX_LOCK_AGE_MS, 'and therefore the derived max age');
});

// ---- action 6.4 (post-verification): WORKTREE's and FINISH's step deadlines are derived from the
// same wait bound, and MUST stay larger than any legitimate wait+work ------------------------------
//
// The defect this pins was measured, not reasoned about. Before this, WORKTREE had no
// stepDeadlineMsByState entry at all, so deadline.js used the generic 120s -- and 6.4's own poll
// loop (`await sleep(pollMs)`) was the first `await` ever placed in that step, arming a timer that
// blocking spawnSync had always kept inert (config.js's own commandTimeoutsMs comment says so).
// The result: a worker blocked on the mutex parked `step-deadline-exceeded-twice` at 240s, never
// reaching the 116-minute wait bound, AND -- because deadline.js's withTimeout abandons the loser
// rather than cancelling it -- TWO realWorktree invocations then entered the critical section for
// a task that had already parked, running `git worktree add` against the shared clone.
test('WORKTREE/FINISH step deadlines are DERIVED from the product-repo wait bound -- never a literal, and never shorter than a legitimate wait plus work', () => {
  const runWith = (envOverrides) =>
    JSON.parse(execFileSync(process.execPath, [CONSTANTS_FIXTURE], { encoding: 'utf8', env: { ...process.env, ...envOverrides } }));

  const base = runWith({});
  // Move BOTH inputs the deadlines depend on: the command timeouts (which move WORST_HOLD_MS) and
  // K (which moves the wait bound). A literal cannot survive both.
  const changed = runWith({ SPO_TIMEOUT_GIT_MS: String(base.git * 3), SPO_WORKERS: '3' });

  for (const run of [base, changed]) {
    const worst = run.SETUP_GIT_CALLS * 2 * run.git + run.SETUP_GH_CALLS * 2 * run.gh + 1 * 2 * run.npmCi;
    const waitBound = Math.max(0, run.workers - 1) * worst;
    assert.equal(run.waitBoundMs, waitBound, 'the wait bound must follow K and the command timeouts');
    assert.equal(
      run.WORKTREE_DEADLINE_MS,
      waitBound + worst + run.stepDeadlineMs,
      'WORKTREE = longest legitimate wait + its own worst hold + one step deadline of margin'
    );
    assert.equal(
      run.FINISH_DEADLINE_MS,
      waitBound + 2 * run.git + run.stepDeadlineMs,
      'FINISH = the same wait, but only its own single `git worktree remove` of work'
    );
    // The property that actually matters, stated directly rather than left implicit in the
    // formula: the deadline must never be able to fire on a legitimate wait.
    assert.ok(run.WORKTREE_DEADLINE_MS > waitBound + worst, 'WORKTREE deadline must exceed any legitimate wait+work');
    assert.ok(run.FINISH_DEADLINE_MS > waitBound + 2 * run.git, 'FINISH deadline must exceed any legitimate wait+work');
  }

  assert.ok(changed.WORKTREE_DEADLINE_MS > base.WORKTREE_DEADLINE_MS, 'raising the timeouts and K must raise the WORKTREE ceiling');
  assert.ok(changed.FINISH_DEADLINE_MS > base.FINISH_DEADLINE_MS, 'and the FINISH ceiling');
});

test('waitBoundMs(cfg): (K-1) x WORST_HOLD_MS, zero at K=1, derived from config.workers -- not a picked literal', () => {
  assert.equal(waitBoundMs({ workers: 1 }), 0, 'K=1: nothing else can legitimately hold this lock, so nothing to wait out');
  assert.equal(waitBoundMs({ workers: 2 }), WORST_HOLD_MS);
  assert.equal(waitBoundMs({ workers: 3 }), 2 * WORST_HOLD_MS);
  // A non-positive-integer override must not go negative or NaN -- falls back to config.js's own
  // default (1 worker), the same tolerance classTimeoutMs already extends to a malformed value.
  assert.equal(waitBoundMs({ workers: 0 }), waitBoundMs({}));
  assert.equal(waitBoundMs({ workers: -1 }), waitBoundMs({}));
});

// ---- D2 (verification of 6.4): the ELAPSED-TIME role must never silently fall back to an
// injected WALL clock ---------------------------------------------------------------------------
//
// acquireProductRepoLock splits its two clocks on purpose: `now` (wall) for the holder-age
// comparison written to and read from disk, `monotonicNowMs` for "how long have I personally been
// waiting". A `|| opts.now` fallback in the elapsed-time slot silently undoes that whenever a
// caller injects only `now` -- and this box's Date.now() has MEASURED backward jumps
// (monotonic-clock.js's header), which turn a bounded wait into an unbounded one exactly when the
// clock steps back. Driven here with a wall clock that jumps BACKWARD on every read.
test('acquireProductRepoLock: a backward-jumping injected `now` cannot extend the wait -- elapsed time is monotonic, never the wall clock', async () => {
  const { dir, filePath } = newLockDir('spo-plock-backward-clock-');
  fs.writeFileSync(filePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  // A wall clock that runs BACKWARDS. Injected as `now` only -- `monotonicNowMs` is deliberately
  // NOT passed, because passing it would let a buggy fallback chain look correct.
  let wall = Date.now();
  const backwardNow = () => {
    wall -= 60000; // one minute into the past on every read
    return wall;
  };

  // Bounds the test rather than letting a regression hang for the 30s test timeout: if the wait
  // does not terminate on its own within far more polls than the 60ms/10ms budget can justify,
  // fail with a distinguishable error instead of a timeout.
  let polls = 0;
  const countingSleep = async (ms) => {
    polls += 1;
    if (polls > 50) throw new Error('WAIT DID NOT TERMINATE: elapsed time is being measured with the injected wall clock');
    await new Promise((resolve) => setTimeout(resolve, ms)); // real time must actually pass, or the real monotonic clock never advances either
  };

  await assert.rejects(
    () => acquireProductRepoLock({ pipelineWorktreesDir: dir, workers: 2 }, { filePath, waitMs: 60, pollMs: 10, now: backwardNow, sleep: countingSleep }),
    ProductRepoLockTimeoutError,
    'the bounded wait must end on monotonic elapsed time, regardless of what the injected wall clock does'
  );
  assert.ok(polls <= 50, `the wait must terminate within its own bound; polled ${polls} times`);
});

// ---- the call ENUMERATION itself, held to the actual source ------------------------------------
//
// The derivation tests above recompute their expectations from SETUP_GIT_CALLS/SETUP_GH_CALLS, so
// they cannot see the constants themselves going wrong: mutating SETUP_GIT_CALLS from 22 to the
// happy path's 3 passed the entire 1303-test suite. It is not cosmetic -- it drops MAX_LOCK_AGE_MS
// from ~127.6 min to ~24 min, and the max-age rule sweeps a holder REGARDLESS of pid liveness, so a
// legitimate holder still inside `npm ci` gets its lock torn away and a second worker's
// `git worktree add` runs concurrently with it. That is the clone corruption the mutex exists to
// prevent, caused by the mutex.
//
// So: count the real call sites. A standing source guard, same shape as test/worker-mode.test.js's
// guard on daemon.js's config literal -- the property is real and load-bearing but not observable
// from a hermetic run, because these are timeouts nothing in a test ever waits out.
test('the call enumeration matches the ACTUAL spawnStep call sites in the locked spans -- SETUP_GIT_CALLS/SETUP_GH_CALLS cannot drift from the code they count', () => {
  const hold = require('../orchestrator/product-repo-hold');
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'steps', 'scripted.js'), 'utf8');

  const bodyOf = (header) => {
    const a = src.indexOf(header);
    assert.notEqual(a, -1, `${header} not found -- the guard needs updating, not deleting`);
    return src.slice(a, src.indexOf('\n}\n', a));
  };
  const spanOf = (body, opener, closer) => {
    const a = body.indexOf(opener);
    assert.notEqual(a, -1, `${opener} not found -- the locked span is no longer recognisable`);
    const b = body.indexOf(closer, a);
    assert.notEqual(b, -1, `could not find the end of the span opened by ${opener}`);
    return body.slice(a, b);
  };

  const tally = (text) => {
    const counts = { git: 0, gh: 0, npm: 0 };
    for (const m of text.matchAll(/spawnStep\(ctx, deps, [^,]+, '(git|gh|npm)'/g)) counts[m[1]] += 1;
    return counts;
  };
  const add = (a, b) => ({ git: a.git + b.git, gh: a.gh + b.gh, npm: a.npm + b.npm });

  // WORKTREE's setup: the span the mutex actually holds, plus everything it calls into.
  const setup = [
    spanOf(bodyOf('async function realWorktree('), "withProductRepoLock(ctx, deps, 'worktree'", '\n  });'),
    bodyOf('function sweepWorktreeLeftovers('),
    bodyOf('function preserveWorktreeWipUnguarded('),
  ].map(tally).reduce(add);

  assert.equal(
    setup.git,
    hold.SETUP_GIT_CALLS + hold.UNBOUNDED_LOOP_GIT_CALLS,
    `the locked setup span has ${setup.git} git spawnStep sites; SETUP_GIT_CALLS (${hold.SETUP_GIT_CALLS}) plus the ` +
      `documented unbounded loop call (${hold.UNBOUNDED_LOOP_GIT_CALLS}) must account for exactly that many. ` +
      'Adding or removing a git command inside WORKTREE\'s critical section means re-deriving the bound -- see product-repo-hold.js.'
  );
  assert.equal(setup.gh, hold.SETUP_GH_CALLS, 'SETUP_GH_CALLS must match the gh call sites in the locked span');
  assert.equal(setup.npm, hold.SETUP_NPM_CI_CALLS, 'the locked span runs exactly one npm command (`npm ci`) -- `board:take` is outside it');

  // FINISH's teardown: a single `git worktree remove`.
  const finish = tally(spanOf(bodyOf('async function realFinish('), "withProductRepoLock(ctx, deps, 'finish'", '\n  );'));
  assert.equal(finish.git, hold.FINISH_GIT_CALLS, 'FINISH_GIT_CALLS must match the git call sites in the teardown span');
  assert.equal(finish.gh + finish.npm, 0, 'the teardown span must hold the mutex across git only -- board:move and the issue comment stay outside');
});

// ---- items 3 and 4: pid-liveness sweeps a dead holder immediately; MAX_LOCK_AGE_MS is the
// SEPARATE fallback for a live-but-over-age holder; a live, in-bound holder is untouched ---------

test('acquireProductRepoLock: a DEAD-pid holder is swept immediately, without waiting out the bound', async () => {
  const { dir, filePath } = newLockDir('spo-plock-deadpid-');
  fs.writeFileSync(filePath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));

  const acquired = await acquireProductRepoLock(
    { pipelineWorktreesDir: dir, workers: 2 },
    { filePath, isAlive: () => false, waitMs: 50, pollMs: 10 }
  );
  assert.ok(acquired, 'a dead-pid holder must not be waited out');
  releaseProductRepoLock(acquired);
  assert.equal(fs.existsSync(filePath), false);
});

test('acquireProductRepoLock: a LIVE holder within MAX_LOCK_AGE_MS is NOT swept -- a blocked acquire times out', async () => {
  const { dir, filePath } = newLockDir('spo-plock-livewithin-');
  // process.pid is genuinely alive (this test's own process) -- the case where sweeping would let
  // a second worker's `git worktree add` run concurrently with the real holder's, corrupting the
  // clone. Default isAlive (lock.js's real processAlive) sees it as alive with no override needed.
  fs.writeFileSync(filePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  await assert.rejects(
    () => acquireProductRepoLock({ pipelineWorktreesDir: dir, workers: 2 }, { filePath, waitMs: 60, pollMs: 15 }),
    ProductRepoLockTimeoutError,
    'a live, in-bound holder must not be swept -- the wait must time out instead'
  );
  assert.equal(fs.readFileSync(filePath, 'utf8').includes(String(process.pid)), true, 'the real holder must still be there, untouched');
});

test('acquireProductRepoLock: a holder older than MAX_LOCK_AGE_MS is swept even with a LIVE pid', async () => {
  const { dir, filePath } = newLockDir('spo-plock-overage-');
  const AGE_EPSILON_MS = 5000;
  fs.writeFileSync(
    filePath,
    JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - (MAX_LOCK_AGE_MS + AGE_EPSILON_MS)).toISOString() })
  );

  const acquired = await acquireProductRepoLock(
    { pipelineWorktreesDir: dir, workers: 2 },
    { filePath, waitMs: 50, pollMs: 10 }
  );
  assert.ok(acquired, 'an over-age holder must be swept regardless of pid liveness');
  releaseProductRepoLock(acquired);
});

// ---- item 5: the wait bound exceeded throws a distinct, typed error (steps/scripted.js turns
// this into ParkSignal('product-repo-lock-timeout', ...) -- see test/real-steps.test.js) --------

test('acquireProductRepoLock: exceeding waitMs throws ProductRepoLockTimeoutError naming the waited bound and worker count', async () => {
  const { dir, filePath } = newLockDir('spo-plock-timeout-');
  fs.writeFileSync(filePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  let caught = null;
  try {
    await acquireProductRepoLock({ pipelineWorktreesDir: dir, workers: 3 }, { filePath, waitMs: 40, pollMs: 10 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ProductRepoLockTimeoutError);
  assert.equal(caught.waitedMs, 40);
  assert.equal(caught.workers, 3);
});

// ---- item 1: two REAL processes racing for the same lock file are never inside the critical
// section at once -- proved by observing from INSIDE the section (a marker file another holder
// would find still there), not by checking the lock is gone after the fact. 6.2's own central
// claim passed 1223 tests on exactly that weaker check. ------------------------------------------

test('real processes: two concurrent acquires of the SAME lock file never overlap inside the critical section', async () => {
  const { dir, filePath } = newLockDir('spo-plock-overlap-');
  const insideMarker = path.join(dir, 'inside.marker');
  const violationFlag = path.join(dir, 'violation.flag');

  const holdMs = 250; // comfortably longer than one process's own acquire+marker-write latency
  const p1 = spawnHold(dir, holdMs, insideMarker, violationFlag);
  const p2 = spawnHold(dir, holdMs, insideMarker, violationFlag, { waitMs: 5000, pollMs: 20 });

  const [code1, code2] = await Promise.all([waitExit(p1), waitExit(p2)]);
  assert.equal(code1, 0, 'both real holders must complete cleanly');
  assert.equal(code2, 0);
  assert.equal(
    fs.existsSync(violationFlag),
    false,
    `mutual exclusion broken: ${fs.existsSync(violationFlag) ? fs.readFileSync(violationFlag, 'utf8') : ''}`
  );
  assert.equal(fs.existsSync(insideMarker), false, 'the marker must be cleaned up by whichever holder went last');
  assert.equal(fs.existsSync(filePath), false, 'the lock file itself must not survive both releases');
});

// ---- item 7: setup and teardown are the SAME lock -- a "teardown" holder and a "setup" holder
// racing for product-repo-lock.js's own lockFilePath(cfg) (the exact function steps/scripted.js's
// withProductRepoLock calls for BOTH realWorktree and realFinish) exclude each other exactly like
// two setup holders do above. The wiring-level half of this claim (realWorktree and realFinish
// both actually calling THIS function with the SAME ctx.config) is covered in
// test/real-steps.test.js, next to the rest of realWorktree/realFinish's own tests. -------------

test('real processes: a "setup"-role and a "finish"-role holder contend on the SAME derived lock file', async () => {
  const dir = mkTmp('spo-plock-setup-finish-');
  // Both fixture processes below are given only this DIR and derive the path themselves with
  // production's lockFilePath(cfg) -- so a lockFilePath that varied per process (per pid, per
  // phase, per task) would hand them different files and the exclusion below would break.
  const filePath = lockFilePath({ pipelineWorktreesDir: dir });
  const insideMarker = path.join(dir, 'inside.marker');
  const violationFlag = path.join(dir, 'violation.flag');

  const holdMs = 250;
  const setupHolder = spawnHold(dir, holdMs, insideMarker, violationFlag);
  const finishHolder = spawnHold(dir, holdMs, insideMarker, violationFlag, { waitMs: 5000, pollMs: 20 });

  const [setupCode, finishCode] = await Promise.all([waitExit(setupHolder), waitExit(finishHolder)]);
  assert.equal(setupCode, 0);
  assert.equal(finishCode, 0);
  assert.equal(fs.existsSync(violationFlag), false, 'a "finish" holder must never be inside while a "setup" holder still is, and vice versa');
});
