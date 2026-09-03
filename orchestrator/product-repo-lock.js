'use strict';
// product-repo-lock.js -- action 6.4: one exclusive lock around the two phases of
// steps/scripted.js that mutate the SHARED product-repo clone (config.productRepo) rather than a
// task's own disposable worktree: WORKTREE's setup (fetch, the leftover sweep's worktree
// remove/prune and branch delete, `git worktree add`, `npm ci`) and FINISH's teardown
// (`git worktree remove`). Under chantier 6's K concurrent workers, both phases run `git`
// commands whose locking is scoped to ONE `.git` directory -- `fetch` writes FETCH_HEAD,
// `worktree add`/`remove`/`prune` mutate `.git/worktrees/`'s administrative files -- so two
// workers' setup/teardown phases overlapping is exactly the shape that corrupts those files or
// makes one worker read the other's half-written state, which steps/scripted.js's own
// spawnStep/ParkSignal machinery cannot tell apart from a genuine git failure: it would spuriously
// park as `worktree-fetch-failed` / `worktree-add-failed` / `worktree-cleanup-failed`. `npm ci`
// carries no such git-lock risk but is included in the SAME critical section anyway (K concurrent
// `npm ci` runs spike disk/CPU on top of it) -- see doc/remediation-progress.md's C6 row for this
// action.
//
// ONE mutex, not two: setup and teardown both mutate the same clone's `.git`, so they contend on
// the same resource and take the same lock, named for what it protects (the clone) rather than
// which phase is holding it -- see realWorktree/realFinish in steps/scripted.js for the two call
// sites.
//
// SCOPE, DELIBERATELY: this does NOT cover CHECK (typecheck/lint/coverage:changed) -- CHECK runs
// entirely inside the task's own worktree (`cwd: worktreePath`), never touches config.productRepo,
// so it is a different resource and not this lock's business. Whether K concurrent CHECKs plus
// this box's co-resident bench worker need their own admission control is unmeasured and is not
// answered here -- see doc/remediation-progress.md's C6 row for that call.
//
// SHAPE: reuses lock.js's second idiom (acquireShortLock/releaseShortLock -- write-tmp-then-link,
// pid-liveness sweep, release-only-if-both-pid-and-startedAt-match), the same primitive
// account-lease.js already wraps for the per-account leases. NOT lock.js's tmp+link `acquireLock`
// (daemon.lock) -- that one exists for a file re-read on a timer for the DAEMON'S WHOLE LIFETIME;
// this lock is held for, at most, the handful of spawns inside one WORKTREE or FINISH call, same
// short-lived shape account-lease.js's own header already argues for its own leases.
//
// THE LOCK FILE LIVES IN pipelineWorktreesDir, NOT INSIDE config.productRepo. Two reasons, not
// one: (1) config.productRepo is a real developer checkout (`~/SPO-WebClient`) this pipeline does
// not own the tracked contents of -- dropping a pipeline-private lock file inside its `.git/`
// would work but ties this module to assuming that directory exists and is writable, which is
// exactly the assumption every real-steps.test.js fixture deliberately does NOT make (they pass
// `productRepo: '/fake/home/SPO-WebClient'`, a path that is never created on disk -- only
// deps.spawnSync is faked, real fs calls against a fake productRepo would throw ENOENT and break
// every existing WORKTREE/FINISH unit test). pipelineWorktreesDir, by contrast, is ALREADY a real,
// pipeline-owned directory in every one of those fixtures (`mkTmp('spo-real-worktrees-')`) and is
// mkdir'd unconditionally before this lock is ever touched (see steps/scripted.js's realWorktree),
// so acquiring it there is transparent to every existing single-worker test: nothing else holds
// it, so the acquire succeeds immediately and the release leaves no trace.
//
// WORST LEGITIMATE HOLD, MAX AGE AND WAIT BOUND: all three are DERIVED from config.js's
// commandTimeoutsMs, never restated as their own literals (the same anti-drift rule
// account-lease.js's MAX_LEASE_AGE_MS follows for step-contracts.js's LLM_STEP_DEADLINE_MS). The
// arithmetic itself -- the call enumeration, the retry-once doubling, and the documented
// for-each-ref gap -- lives in product-repo-hold.js, a dependency-free leaf module, because
// config.js ALSO needs it (to derive WORKTREE's and FINISH's stepDeadlineMsByState entries from
// this same wait bound) and config.js cannot require this file without a cycle. See that module's
// header for every term.

const fs = require('fs');
const path = require('path');

const lock = require('./lock');
const config = require('./config');
const hold = require('./product-repo-hold');
const { monotonicNowMs } = require('./monotonic-clock');

const { SETUP_GIT_CALLS, SETUP_GH_CALLS } = hold;

// WORST_HOLD_MS -- product-repo-hold.js's own arithmetic, resolved against THIS process's
// config.js. The number a queued worker must be willing to wait out (see waitBoundMs below), the
// floor MAX_LOCK_AGE_MS is built from, and the term config.js reuses for WORKTREE's own step
// deadline.
const WORST_HOLD_MS = hold.worstHoldMs(config.commandTimeoutsMs);

// MAX_LOCK_AGE_MS -- the age past which a holder is swept REGARDLESS of pid liveness, same
// two-rule shape (pid-liveness first, age as the secondary net for a recycled pid) as
// account-lease.js's MAX_LEASE_AGE_MS, reusing lock.js's own holderExpired. +10% slack, expressed
// as a fraction of WORST_HOLD_MS rather than a second literal so it moves with commandTimeoutsMs
// instead of drifting from it -- the identical technique account-lease.js's own MAX_LEASE_AGE_MS
// comment argues for.
const MAX_LOCK_AGE_MS = WORST_HOLD_MS + Math.round(WORST_HOLD_MS / 10);

const LOCK_FILE_NAME = '.product-repo.lock';

function lockFilePath(cfg) {
  return path.join(cfg.pipelineWorktreesDir, LOCK_FILE_NAME);
}

// waitBoundMs(cfg) -- (K-1) x WORST_HOLD_MS, K = cfg.workers (falls back to config.js's own
// default when the caller's ctx.config predates this field, same tolerance classTimeoutMs already
// extends to an older config object). K-1, not K: at most K-1 OTHER workers can each legitimately
// hold this lock ahead of a blocked worker before its own turn comes, so a queue of K-1 worst-case
// holders is the longest a LEGITIMATE wait can ever take -- waiting that long must never time out
// (the asymmetry the spec calls out: waiting too long only delays a card, sweeping too early
// corrupts the clone). At K=1 this is 0 -- correct: nothing else in this pipeline can legitimately
// hold the lock while a lone worker wants it, so there is nothing to wait out.
function waitBoundMs(cfg) {
  const workers = (cfg && Number.isInteger(cfg.workers) && cfg.workers > 0) ? cfg.workers : config.workers;
  return hold.waitBoundMs(config.commandTimeoutsMs, workers);
}

// Thrown when the wait bound above is exceeded with the lock never acquired. steps/scripted.js
// catches this and turns it into ParkSignal('product-repo-lock-timeout', ...) -- a name that
// greps distinctly from a genuine git failure (worktree-fetch-failed, worktree-add-failed, ...),
// per the spec's own requirement that a maintainer reading `spo parked` can tell mutex starvation
// from a real git problem.
class ProductRepoLockTimeoutError extends Error {
  constructor(waitedMs, workers) {
    super(`product-repo lock: waited ${waitedMs}ms (K=${workers}) without acquiring`);
    this.name = 'ProductRepoLockTimeoutError';
    this.waitedMs = waitedMs;
    this.workers = workers;
  }
}

// acquireProductRepoLock(cfg, opts) -> Promise<{pid, startedAt}>
//
// Polls lock.js's acquireShortLock (pid-liveness + MAX_LOCK_AGE_MS staleness, write-tmp-then-link
// create -- see that module's own header for why this idiom and not a bare `wx`) until it
// succeeds or opts.waitMs (default waitBoundMs(cfg)) elapses, then throws
// ProductRepoLockTimeoutError. Mirrors account-lease.js's leaseHealthyAccount shape: `now`
// (wall-clock, Date.now default) for the holder-age comparison written to/read from disk,
// `elapsedNowMs` (monotonic, defaults to monotonic-clock.js's real hrtime-based function) for
// "how long have I personally been waiting" -- see that module's own header for why this box's
// backward-jumping Date.now() makes that split load-bearing, not stylistic. `sleep`/`isAlive` are
// the same test-injection points every other lock caller in this codebase already uses.
async function acquireProductRepoLock(cfg, opts = {}) {
  const filePath = opts.filePath || lockFilePath(cfg);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const waitMs = opts.waitMs !== undefined ? opts.waitMs : waitBoundMs(cfg);
  const pollMs = opts.pollMs !== undefined ? opts.pollMs : (cfg && cfg.productRepoLockPollMs) || config.productRepoLockPollMs;
  const now = opts.now || Date.now;
  // NO `|| opts.now` FALLBACK HERE -- that is the whole point of the split the paragraph above
  // argues for, and a fallback silently undoes it. A caller that injects only `now` (a WALL clock,
  // as several tests do) would otherwise get that wall clock for the "how long have I personally
  // been waiting" role too, on a box whose Date.now() has MEASURED backward jumps (see
  // monotonic-clock.js's own header) -- which turns a bounded wait into an unbounded one exactly
  // when the clock steps back. `monotonicNowMs` is its own injection point; a test that wants to
  // drive elapsed time passes it explicitly.
  const elapsedNowMs = opts.monotonicNowMs || monotonicNowMs;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isAlive = opts.isAlive || lock.processAlive;

  const start = elapsedNowMs();
  for (;;) {
    const held = lock.acquireShortLock(filePath, { isAlive, maxAgeMs: MAX_LOCK_AGE_MS, now });
    if (held) return { filePath, held };

    const elapsed = elapsedNowMs() - start;
    if (elapsed >= waitMs) {
      throw new ProductRepoLockTimeoutError(waitMs, (cfg && cfg.workers) || config.workers);
    }
    await sleep(Math.min(pollMs, waitMs - elapsed));
  }
}

// releaseProductRepoLock({filePath, held}) -- release-only-if-ours (lock.js's releaseShortLock:
// both pid AND startedAt must match), same reused-pid guard every other short lock in this
// codebase already relies on. Never throws -- a release must never turn a clean (or already-
// parked) exit into a crash, same posture as lock.js's own releaseLock/releaseShortLock.
function releaseProductRepoLock(acquired) {
  if (!acquired) return;
  lock.releaseShortLock(acquired.filePath, acquired.held);
}

module.exports = {
  acquireProductRepoLock,
  releaseProductRepoLock,
  lockFilePath,
  waitBoundMs,
  WORST_HOLD_MS,
  MAX_LOCK_AGE_MS,
  ProductRepoLockTimeoutError,
  // Exported for test/product-repo-lock.test.js's derivation check (action 6.4's own item 6):
  // recomputing WORST_HOLD_MS/MAX_LOCK_AGE_MS from these plus a freshly-required config.js is how
  // that test proves the bound MOVES when commandTimeoutsMs does, rather than merely restating a
  // formula a hardcoded literal could also satisfy by coincidence.
  SETUP_GIT_CALLS,
  SETUP_GH_CALLS,
};
