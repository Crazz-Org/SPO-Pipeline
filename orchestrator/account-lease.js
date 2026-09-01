'use strict';
// account-lease.js -- per-account, per-step leases (action 6.2), shared by the two rotation
// loops: state-machine.js's callLlmStep (the daemon worker's real-mode LLM steps) and intake.js's
// callIntakeStepWithRotation (draftCard/reviewCard/triageBugReport, which under C6 run
// dispatcher-side, in runForever's scan timers -- so the dispatcher itself competes with workers
// for the same pool). Both used to call a bare `accounts.pick()`, which is deterministic
// first-fit: two concurrent callers are handed the SAME account every time. That was invisible
// under the pre-C6 single-threaded daemon (the second account was always idle) and is exactly the
// bug this file exists to close now that more than one caller can be in-flight at once.
//
// GRANULARITY -- per-step lease, not per-task, released the instant the one LLM call it wraps
// finishes (success, limit, or throw). This is a deliberate erratum to the remediation plan's own
// wording ("the worker leases the next healthy unleased account, parks all-accounts-cooling only
// when none exists") -- see doc/remediation-progress.md's C6 decision record. The measurement
// that overrides the plan: the real pool is 2 accounts, a card's models run
// fable -> sonnet -> fable (no cross-step prompt cache for a longer lease to protect), and 15% of
// cards already rotate mid-run in ~6 seconds with zero cost. A per-TASK lease on a 2-account pool
// would turn that routine, sub-10-second rotation into a park class (`all-accounts-cooling`, or
// its per-task equivalent) that has NEVER fired in this project's history.
//
// TWO WAYS TO FIND NOTHING TO LEASE, and they are handled differently on purpose:
//   - every enabled account is COOLING (accounts.AllAccountsCoolingError) -- never worth
//     waiting on; a cooldown is measured in minutes-to-hours, propagates immediately, and the
//     caller parks `all-accounts-*-cooling*` exactly as it always has.
//   - every HEALTHY account is currently LEASED by another live process
//     (accounts.AllAccountsLeasedError) -- worth a BOUNDED wait (config.accountLeaseWaitMs,
//     default 5 min): the sibling holding it is mid-step, and a step is measured at 90-265s, so
//     the lease is very likely to free up inside the bound. leaseHealthyAccount below is the one
//     place that turns "nothing right now" into "wait, then try again" for this case only --
//     accounts.pick() itself never waits, it only ever answers "yes" or "no" for one instant.
//
// LEASE FILES ARE FILES, NEVER DIRECTORIES. accounts.js's readRegistry() treats every
// SUBDIRECTORY of the pool dir as an account, with no dot-prefix exclusion -- a `leases/`
// directory would register a phantom account named `leases` that pick() could return and whose
// path would be handed to `claude` as CLAUDE_CONFIG_DIR. So: one file per account, directly under
// the pool dir, alongside state.json/labels.json/.state.lock:
// `<poolDir>/.lease-<name>.json`, content `{pid, startedAt}` (same shape, and the same
// disambiguates-a-reused-pid role, as state.json.owner's `workerStartedAt` -- action 6.1).
//
// Acquire/release reuse lock.js's acquireShortLock/releaseShortLock (wx-create,
// pid-liveness stale-sweep via lock.js's own processAlive, release-only-if-both-pid-and-startedAt
// -match) rather than re-implementing that idiom a third time -- see lock.js's own header for why
// it's deliberately simpler than daemon.lock's tmp+link dance, and accounts.js's markLimit for the
// SECOND caller of the same primitive (its own .state.lock).

const fs = require('fs');
const path = require('path');

const lock = require('./lock');
const accountsModule = require('./accounts');
const config = require('./config');
const { LLM_STEP_DEADLINE_MS } = require('./step-contracts');

const LEASE_PREFIX = '.lease-';
const LEASE_SUFFIX = '.json';

// MAX_LEASE_AGE_MS -- the age past which a lease is presumed dead and swept REGARDLESS of whether
// its pid is alive. Without it, a lease whose holder died and whose pid was later recycled by an
// unrelated process of the same user excludes that account forever: pid-liveness says "held", and
// nothing else ever looks at the file again. Measured before this existed: a lease dated
// 1970-01-01 naming a live unrelated pid kept `leasedAccountNames` reporting that account as
// leased indefinitely; on the real two-account pool, one such lease plus one cooling account made
// every card wait the full lease bound and park `all-accounts-leased`. Rare (this machine's
// /proc/sys/kernel/pid_max is 4194304, not the historical 32768, so recycling is ~128x rarer than
// the number most pid-reuse folklore assumes) but unbounded and self-perpetuating when it happens.
//
// DERIVED from step-contracts.js's LLM_STEP_DEADLINE_MS, never restated as its own literal, so a
// future edit to that constant moves this bound with it instead of silently drifting past it --
// the same anti-drift rule config.js already applies to CI_CHECKS' deadline.
//
// Why 2x and not 1x: one lease can span TWO `claude` calls, not one. Measured, not assumed --
// intake.js's callIntakeStepWithRotation runs its same-account timeout retry INSIDE the lease's
// own try/finally, and instrumenting it showed 2 spawns carrying one identical lease payload.
// state-machine.js's callLlmStep is bounded the same way by construction (callWithDeadline's two
// attempts both sit inside the lease's try/finally); it happens to measure 1 today only because a
// blocking spawnSync's resolution microtask always drains before callWithDeadline's timer can
// fire, which is an implementation detail no bound should lean on. Each individual call is capped
// by spawnSync's own `timeout`, armed with LLM_STEP_DEADLINE_MS at steps/llm.js's spawnOpts.
//
// The +10% slack covers the non-spawn work the lease also spans -- prompt assembly, the JSON parse
// of up to 64 MiB of stdout, and the journal writes around it -- and is expressed as a fraction so
// it scales with the deadline rather than becoming a second number that can drift from it.
//
// Residual risk, recorded rather than papered over: spawnSync's `timeout` sends killSignal
// (SIGTERM) and does NOT escalate to SIGKILL, so "spawnSync always returns by its timeout" is not
// an unconditional guarantee -- measured, a SIGTERM-ignoring child ran 27.6s against a 400ms
// timeout. A `claude` that ignored SIGTERM could therefore hold a lease past this bound and have
// it swept while still running, which is the D1 failure (two `claude` processes on one account)
// rather than the D3 one this closes. That is why the bound is generous rather than tight: 31.5
// minutes is roughly 7x the longest full two-attempt step the C6 funnel actually measured
// (90-265s per call).
const MAX_LEASE_AGE_MS = 2 * LLM_STEP_DEADLINE_MS + Math.round(LLM_STEP_DEADLINE_MS / 10);

function leaseFilePath(poolDir, name) {
  return path.join(poolDir, `${LEASE_PREFIX}${name}${LEASE_SUFFIX}`);
}

// Every `.lease-*.json` file directly under poolDir, decoded back to the account name it names --
// index-slicing the fixed prefix/suffix rather than splitting on `-`, so an account name that
// itself contains a dash round-trips correctly. A missing poolDir is "no leases", same posture as
// accounts.js's readRegistry/readState for a missing pool.
function listLeaseFiles(poolDir) {
  if (!fs.existsSync(poolDir)) return [];
  return fs
    .readdirSync(poolDir)
    .filter((f) => f.startsWith(LEASE_PREFIX) && f.endsWith(LEASE_SUFFIX))
    .map((f) => ({
      name: f.slice(LEASE_PREFIX.length, f.length - LEASE_SUFFIX.length),
      file: path.join(poolDir, f),
    }));
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null; // missing, unreadable, or torn -- treated as "nobody holds this" by every caller
  }
}

// The set of account names whose lease is held by a process that is CURRENTLY ALIVE. A lease
// whose pid is dead is deliberately NOT included -- it is not "free" in the sense of having no
// file on disk, but it is free in the sense that pick()'s exclusion should ignore it: the next
// acquire attempt against that specific lease file is what performs the actual stale sweep (see
// tryAcquireLease below), lazily, only when someone actually wants that account. Computing this
// set eagerly here and also sweeping it here would be a second, redundant place doing the same
// pid-liveness check with two different lifecycles to keep in sync.
// `now` (default Date.now) is only ever consulted for the MAX_LEASE_AGE_MS rule, and must agree
// with the rule tryAcquireLease applies below: if this function still excluded an over-age lease
// that acquire would happily sweep, pick() would never hand that account back and the sweep could
// never run -- the account would stay excluded exactly as it did before the age rule existed.
function leasedAccountNames(poolDir, isAlive = lock.processAlive, now = Date.now) {
  const names = new Set();
  for (const { name, file } of listLeaseFiles(poolDir)) {
    const holder = readJsonFile(file);
    const held =
      holder &&
      typeof holder.pid === 'number' &&
      isAlive(holder.pid) &&
      !lock.holderExpired(holder, MAX_LEASE_AGE_MS, now);
    if (held) names.add(name);
  }
  return names;
}

// One exclusive-acquire attempt for `name`'s lease, including lock.js's own one-shot stale sweep
// (a dead-pid holder is unlinked and retried once). Returns the {pid, startedAt} payload on
// success, or null if a LIVE process already holds it.
function tryAcquireLease(poolDir, name, isAlive = lock.processAlive, now = Date.now) {
  return lock.acquireShortLock(leaseFilePath(poolDir, name), { isAlive, maxAgeMs: MAX_LEASE_AGE_MS, now });
}

// Release-only-if-ours: `held` must be the exact payload tryAcquireLease returned (both pid AND
// startedAt have to match what's on disk) -- see lock.js's releaseShortLock for the reused-pid
// race this guards against.
function releaseLease(poolDir, name, held) {
  lock.releaseShortLock(leaseFilePath(poolDir, name), held);
}

// leaseHealthyAccount(poolDir, opts) -> Promise<{account, release()}>
//
// The one function both rotation loops call in place of a bare `accounts.pick()`. Picks a
// healthy, currently-unleased account and leases it; if every healthy account is leased right
// now, waits (polling) up to opts.waitMs (default config.accountLeaseWaitMs) for one to free up,
// re-picking on every iteration since the pool's cooldown/lease state can change while waiting.
// Never waits for a COOLING pool -- accounts.AllAccountsCoolingError and
// accounts.NoAccountsRegisteredError propagate on the very first attempt, exactly like a bare
// pick() would have.
//
// opts:
//   waitMs, pollMs  -- override config.js's defaults (tests shrink these to keep the suite fast).
//   now()           -- clock function, defaults to Date.now. Used for BOTH pick()'s cooldown
//                       comparison and this function's own wait-bound elapsed-time check, so a
//                       test can inject a fake clock (paired with a `sleep` that advances it) and
//                       drive the whole wait/park decision with zero real waiting -- see
//                       test/account-lease.test.js.
//   sleep(ms)       -- defaults to a real `setTimeout`-backed Promise. Injectable for the same
//                       reason as `now` above.
//   isAlive(pid)    -- defaults to lock.js's processAlive. Lets a test simulate a lease held by a
//                       pid that is/isn't "alive" without spawning a real process for every case.
//
// Throws accounts.AllAccountsCoolingError / accounts.NoAccountsRegisteredError immediately (no
// wait), or accounts.AllAccountsLeasedError once opts.waitMs has elapsed with nothing acquired.
async function leaseHealthyAccount(poolDir, opts = {}) {
  const waitMs = opts.waitMs !== undefined ? opts.waitMs : config.accountLeaseWaitMs;
  const pollMs = opts.pollMs !== undefined ? opts.pollMs : config.accountLeasePollMs;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isAlive = opts.isAlive || lock.processAlive;

  const start = now();
  for (;;) {
    const excludeAccounts = leasedAccountNames(poolDir, isAlive, now);
    let account = null;
    let pickErr = null;
    try {
      account = accountsModule.pick(poolDir, now(), { excludeAccounts });
    } catch (err) {
      // Cooling / no-accounts-at-all: never worth waiting on -- propagate straight through,
      // exactly as a bare accounts.pick() call would have. Only AllAccountsLeasedError is ours
      // to retry.
      if (!(err instanceof accountsModule.AllAccountsLeasedError)) throw err;
      pickErr = err;
    }

    if (account) {
      const held = tryAcquireLease(poolDir, account.name, isAlive, now);
      if (held) {
        return { account, release: () => releaseLease(poolDir, account.name, held) };
      }
      // Lost the race: a sibling leased this exact account between our pick() and our acquire
      // attempt (or won a simultaneous stale-sweep). Fall through to the same wait/retry the
      // AllAccountsLeasedError branch takes -- from this function's point of view the two cases
      // ("pick found nothing" and "pick found something, but it was gone by the time we grabbed
      // for it") are the same event: nothing was actually available at this instant.
    }

    const elapsed = now() - start;
    if (elapsed >= waitMs) {
      // VERIFIER (action 6.2): `waitedMs` is the configured BOUND, not the measured elapsed time,
      // and `excludedAccounts` is sorted. Both for the same reason: park-loop.js's
      // countRepeatedParks fingerprints a park as `reason + JSON.stringify(detail)` and stops
      // counting at the first park that doesn't match byte-for-byte. Measured elapsed varies by a
      // few milliseconds between otherwise identical parks (602 / 605 / 603 ms across three runs
      // of the same scenario), and `excludedAccounts` inherited readdirSync's unspecified order --
      // either one alone makes every `all-accounts-leased` park look like a first-time park, so
      // the repeat-park loop warning that exists for exactly this shape (a card that parks the
      // same way over and over, card #385) could never fire for this new park class. Nothing is
      // lost by reporting the bound: this throw is only reachable once elapsed >= waitMs, so "it
      // waited its full bound" is precisely what happened, and the bound is the number an operator
      // would act on (raise SPO_ACCOUNT_LEASE_WAIT_MS) anyway.
      const detail = pickErr
        ? { ...pickErr.detail, excludedAccounts: [...(pickErr.detail.excludedAccounts || [])].sort(), waitedMs: waitMs }
        : { checkedAccounts: account ? [account.name] : [], waitedMs: waitMs };
      throw new accountsModule.AllAccountsLeasedError('all-accounts-leased', detail);
    }
    await sleep(Math.min(pollMs, waitMs - elapsed));
  }
}

module.exports = {
  MAX_LEASE_AGE_MS,
  leaseHealthyAccount,
  leaseFilePath,
  leasedAccountNames,
  tryAcquireLease,
  releaseLease,
};
