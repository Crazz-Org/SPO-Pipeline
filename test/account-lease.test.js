'use strict';
// Unit + integration coverage for orchestrator/account-lease.js (action 6.2): per-account,
// per-step leases, and leaseHealthyAccount's pick-and-wait loop shared by state-machine.js's
// callLlmStep and intake.js's callIntakeStepWithRotation. See account-lease.js's own header for
// the design this tests: per-step (not per-task) leasing, and the all-leased-waits vs
// all-cooling-never-waits split.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { mkTmp, writePoolDir } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident this closes. Only spawnSync is
// patched; this file's real-process coverage below uses the async child_process.spawn, which is
// deliberately untouched (see test/lock.test.js for the same precedent).
require('./no-real-spawn');

const accounts = require('../orchestrator/accounts');
const accountLease = require('../orchestrator/account-lease');
const { leaseHealthyAccount, leaseFilePath, tryAcquireLease, releaseLease, leasedAccountNames } = accountLease;

const LEASE_HOLD_FIXTURE = path.join(__dirname, 'fixtures', 'lease-hold.js');

async function waitForFile(p, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(p)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${p}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---- item 6: lease files are FILES, never directories -- readRegistry must still see only the
// real accounts, exactly the trap the spec calls out (a `leases/` DIRECTORY would register a
// phantom account whose configDir gets handed to `claude` as CLAUDE_CONFIG_DIR). ---------------

test('lease files in the pool dir do not become accounts in readRegistry', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-registry-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fs.writeFileSync(leaseFilePath(poolDir, 'ghost-account'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const registry = accounts.readRegistry(poolDir);
  assert.deepEqual(
    registry.map((a) => a.name),
    ['acct-a', 'acct-b'],
    'exactly the two real subdirectories -- the lease files, including one named after a nonexistent account, must never surface as accounts'
  );
});

// ---- item 4: stale (dead-pid) lease is swept and re-acquired; a live-pid lease is not ---------

test('tryAcquireLease: a lease held by a DEAD pid is swept and reacquired', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-stale-'), [{ name: 'acct-a' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify({ pid: 999999, startedAt: 'stale' }));

  const isAlive = () => false; // simulates the pid being gone, without needing a real dead pid
  const held = tryAcquireLease(poolDir, 'acct-a', isAlive);

  assert.ok(held, 'a dead-pid holder must be swept and the lease reacquired');
  assert.equal(held.pid, process.pid);
  const onDisk = JSON.parse(fs.readFileSync(leaseFilePath(poolDir, 'acct-a'), 'utf8'));
  assert.equal(onDisk.pid, process.pid, 'the file on disk now reflects the new holder');
});

test('tryAcquireLease: a lease held by a LIVE pid is NOT swept -- returns null', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-live-'), [{ name: 'acct-a' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify({ pid: 424242, startedAt: 'still-running' }));

  const isAlive = () => true; // simulates the pid still being alive
  const held = tryAcquireLease(poolDir, 'acct-a', isAlive);

  assert.equal(held, null, 'a live holder must block acquisition');
  const onDisk = JSON.parse(fs.readFileSync(leaseFilePath(poolDir, 'acct-a'), 'utf8'));
  assert.equal(onDisk.pid, 424242, 'the original holder is untouched');
});

// ---- item 5: release-only-if-ours ---------------------------------------------------------

test('releaseLease: a lease file with a different startedAt but the SAME pid is NOT removed', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-release-guard-'), [{ name: 'acct-a' }]);
  const onDiskPayload = { pid: process.pid, startedAt: 'the-real-holder' };
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify(onDiskPayload));

  // Same pid (plausible: a reused pid, or simply a stale in-memory reference from an earlier
  // acquire this process itself made and already lost), different startedAt -- must not release
  // someone else's (or a later incarnation's) lease.
  releaseLease(poolDir, 'acct-a', { pid: process.pid, startedAt: 'a-different-incarnation' });

  assert.ok(fs.existsSync(leaseFilePath(poolDir, 'acct-a')), 'the lease must survive a release call that does not match startedAt');
  assert.deepEqual(JSON.parse(fs.readFileSync(leaseFilePath(poolDir, 'acct-a'), 'utf8')), onDiskPayload);
});

test('releaseLease: the matching pid AND startedAt does remove the lease', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-release-match-'), [{ name: 'acct-a' }]);
  const held = tryAcquireLease(poolDir, 'acct-a');
  assert.ok(held);
  assert.ok(fs.existsSync(leaseFilePath(poolDir, 'acct-a')));

  releaseLease(poolDir, 'acct-a', held);

  assert.equal(fs.existsSync(leaseFilePath(poolDir, 'acct-a')), false);
});

// ---- item 2: leaseHealthyAccount skips a leased account and returns the next healthy one -------

test('leaseHealthyAccount: skips an account already leased (live pid) and returns the next healthy one', async () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-skip-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify({ pid: 424242, startedAt: 'held-by-a-sibling' }));

  const leased = await leaseHealthyAccount(poolDir, { isAlive: (pid) => pid === 424242, waitMs: 50, pollMs: 5 });

  assert.equal(leased.account.name, 'acct-b', 'acct-a is leased -- must fall through to acct-b');
  leased.release();
});

// ---- item 8: all-leased waits then parks all-accounts-leased; all-cooling parks immediately ----

test('leaseHealthyAccount: every healthy account leased -> waits (injected clock), then throws AllAccountsLeasedError', async () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-wait-'), [{ name: 'acct-a' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify({ pid: 424242, startedAt: 'held-forever' }));

  // Fully injected clock: `now` and `sleep` share one fake counter so this test resolves
  // instantly (no real waiting at all) while still exercising the real wait-then-give-up branch,
  // per the spec's "drive the wait with an injected clock/short bound, never a real multi-second
  // sleep in the suite."
  let fakeNow = 0;
  const now = () => fakeNow;
  const sleepCalls = [];
  const sleep = async (ms) => {
    sleepCalls.push(ms);
    fakeNow += ms;
  };

  let caught = null;
  try {
    await leaseHealthyAccount(poolDir, { isAlive: (pid) => pid === 424242, waitMs: 200, pollMs: 50, now, sleep });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof accounts.AllAccountsLeasedError, `expected AllAccountsLeasedError, got ${caught && caught.constructor.name}`);
  assert.equal(caught.reason, 'all-accounts-leased');
  assert.ok(sleepCalls.length > 0, 'must actually wait (poll) before giving up -- this is the case worth waiting on');
  assert.ok(fakeNow >= 200, 'must not give up before the wait bound elapses');
});

// VERIFIER: `timeout` is load-bearing, not decoration. This test's injected clock never advances
// and its injected sleep is a no-op, so a regression that DOES wait on a cooling pool spins
// forever -- node:test has no default per-test timeout, so without this the whole suite hangs
// instead of going red. Confirmed by mutation: making leaseHealthyAccount retry on
// AllAccountsCoolingError hung `node --test test/*.test.js` past 90s with no output.
test('leaseHealthyAccount: every enabled account cooling -> throws AllAccountsCoolingError immediately, WITHOUT waiting', { timeout: 5000 }, async () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-nowait-cooling-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  const now0 = Date.now();
  accounts.markLimit(poolDir, 'acct-a', 'overloaded', now0);
  accounts.markLimit(poolDir, 'acct-b', 'overloaded', now0);

  // VERIFIER: the injected clock must ADVANCE, and the bound must be finite and small.
  //
  // As first written this test froze `now` at a constant and paired it with a no-op `sleep`, on
  // the reasoning that "if this ever DID wait, the test would hang/timeout instead of quietly
  // passing". It does hang -- but it never times out, so the failure mode is a silent, permanent
  // stall of `node --test test/*.test.js`, not a red test. Measured: making leaseHealthyAccount
  // retry on AllAccountsCoolingError hung the suite past 90s with no output. node:test's own
  // `timeout` option cannot rescue it either -- `timeout` marks the test failed but cannot cancel
  // the caller's promise, and leaseHealthyAccount's `for(;;)` keeps rescheduling itself, so the
  // runner never exits. (Confirmed: still hung past 90s WITH `{ timeout: 5000 }` set.)
  //
  // An advancing clock fixes it properly: a regression that waits now reaches the bound quickly
  // and throws AllAccountsLeasedError, which the assertion below catches as a clean failure --
  // and `sleepCalled` still proves the no-wait contract on the passing path. The `timeout` stays
  // as a cheap backstop for a regression that somehow neither returns nor advances.
  let sleepCalled = false;
  let fakeNow = now0 + 1;
  const now = () => fakeNow;
  const sleep = async (ms) => {
    sleepCalled = true;
    fakeNow += ms;
    await new Promise((r) => setTimeout(r, 1)); // a real tick, so the loop is never a microtask spin
  };

  let caught = null;
  try {
    // A FINITE bound driven by the fake clock above: a regression that waits burns through it in
    // milliseconds of real time and comes back with the wrong error type, which the assertion
    // below reports as a failure. See the clock comment above for why a frozen clock plus an
    // infinite-in-practice bound could only ever hang here.
    await leaseHealthyAccount(poolDir, { now, waitMs: 10 * 60 * 1000, pollMs: 1000, sleep });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof accounts.AllAccountsCoolingError, `expected AllAccountsCoolingError, got ${caught && caught.constructor.name}`);
  assert.equal(sleepCalled, false, 'a cooling pool must never wait -- only a LEASED pool is worth waiting on');
});

test('leaseHealthyAccount: an empty pool throws NoAccountsRegisteredError immediately, without waiting', { timeout: 5000 }, async () => {
  const poolDir = mkTmp('spo-lease-nowait-empty-');
  let sleepCalled = false;
  await assert.rejects(
    // Same reason as the cooling test above: a real tick, so a regression that waits here trips
    // this test's `timeout` instead of hanging the suite.
    () =>
      leaseHealthyAccount(poolDir, {
        waitMs: 10 * 60 * 1000,
        sleep: async () => {
          sleepCalled = true;
          await new Promise((r) => setTimeout(r, 1));
        },
      }),
    accounts.NoAccountsRegisteredError
  );
  assert.equal(sleepCalled, false);
});

// ---- item 1: two REAL processes cannot hold the same account's lease; the second one to try
// gets the other healthy account instead. -------------------------------------------------------

test('two real processes cannot hold the same account lease; the second gets a different healthy account', async () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-two-proc-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  const readyFile = path.join(poolDir, '.ready-marker');

  const holder = spawn(process.execPath, [LEASE_HOLD_FIXTURE, poolDir, 'acct-a', '3000', readyFile], { stdio: 'ignore' });
  try {
    await waitForFile(readyFile);
    assert.notEqual(Number(fs.readFileSync(readyFile, 'utf8')), process.pid, 'the holder must be a DIFFERENT OS process');

    // acct-a's lease is now genuinely held by another live process -- a raw re-acquire attempt
    // from THIS process must fail, and leaseHealthyAccount must route around it to acct-b.
    assert.equal(tryAcquireLease(poolDir, 'acct-a'), null, 'a live different-process holder blocks re-acquiring the same lease');

    const leased = await leaseHealthyAccount(poolDir, { waitMs: 200, pollMs: 10 });
    assert.equal(leased.account.name, 'acct-b', 'the second caller (this process) must get the OTHER healthy account');
    leased.release();
  } finally {
    holder.kill();
  }
});

// ---- leasedAccountNames -------------------------------------------------------------------

test('leasedAccountNames: only names accounts whose lease is held by a LIVE pid', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-names-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify({ pid: 111, startedAt: 'live' }));
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-b'), JSON.stringify({ pid: 222, startedAt: 'dead' }));

  const names = leasedAccountNames(poolDir, (pid) => pid === 111);
  assert.deepEqual(Array.from(names).sort(), ['acct-a']);
});

// ---- VERIFIER (action 6.2): the release guard needs BOTH halves ------------------------------
//
// The release-guard test above varies only `startedAt` (same pid), so it kills a mutant that
// drops the startedAt comparison but NOT one that drops the `pid` comparison -- the coincidental-
// equality shape: for that one fixture both checks give the same answer. `startedAt` is a
// millisecond-resolution ISO string, so two acquires of the same lease path in the same
// millisecond (a holder dies, a racer sweeps and re-acquires immediately) genuinely can share it;
// the pid is what disambiguates them. Pin it with the mirror-image fixture: same startedAt,
// different pid.
test('releaseLease: a lease file with the SAME startedAt but a DIFFERENT pid is NOT removed', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-release-guard-pid-'), [{ name: 'acct-a' }]);
  const sameInstant = new Date().toISOString();
  // On disk: the CURRENT holder -- a different process that acquired at the same millisecond as
  // the (now dead) holder whose payload we are about to release with.
  const onDiskPayload = { pid: process.pid + 1, startedAt: sameInstant };
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify(onDiskPayload));

  releaseLease(poolDir, 'acct-a', { pid: process.pid, startedAt: sameInstant });

  assert.ok(
    fs.existsSync(leaseFilePath(poolDir, 'acct-a')),
    "a release must never tear out a lease held by a DIFFERENT pid, even when the timestamps collide"
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(leaseFilePath(poolDir, 'acct-a'), 'utf8')), onDiskPayload);
});

// ---- VERIFIER (action 6.2): the park detail must fingerprint identically across identical parks
//
// park-loop.js's countRepeatedParks counts a streak by `reason + JSON.stringify(detail)`, byte
// for byte, and stops at the first park that doesn't match -- that is what turns a card looping on
// one park into a loop warning on the maintainer's retry comment (card #385). As first written,
// this park's detail carried the MEASURED elapsed wait (602 / 605 / 603 ms across three runs of
// the identical scenario) and an `excludedAccounts` array in readdirSync order, so two identical
// all-accounts-leased parks never produced the same fingerprint and the streak was permanently
// stuck at 1. Pin the stability directly, the way park-loop itself compares them.
test('leaseHealthyAccount: two identical all-accounts-leased parks produce a byte-identical detail fingerprint', { timeout: 5000 }, async () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-fingerprint-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), JSON.stringify({ pid: 424242, startedAt: 'sibling-a' }));
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-b'), JSON.stringify({ pid: 424243, startedAt: 'sibling-b' }));

  const park = async () => {
    // A REAL clock and a real (tiny) sleep on purpose: an injected clock would advance in exact
    // steps and hide the millisecond-level variation this test exists to rule out.
    try {
      await leaseHealthyAccount(poolDir, { isAlive: (pid) => pid === 424242 || pid === 424243, waitMs: 60, pollMs: 20 });
    } catch (err) {
      return err;
    }
    throw new Error('expected a park');
  };

  const first = await park();
  const second = await park();

  assert.equal(first.reason, 'all-accounts-leased');
  assert.equal(
    JSON.stringify(first.detail),
    JSON.stringify(second.detail),
    `two identical parks must fingerprint identically for countRepeatedParks -- got ${JSON.stringify(first.detail)} vs ${JSON.stringify(second.detail)}`
  );
  assert.equal(first.detail.waitedMs, 60, 'the reported wait is the configured bound, not a jittery measured elapsed');
  assert.deepEqual(first.detail.excludedAccounts, ['acct-a', 'acct-b'], 'and the excluded set is sorted, not readdirSync order');
});

// ---- D3 (action 6.2): MAX_LEASE_AGE_MS -- a lease is presumed dead past a derived bound -------
//
// Without an age bound, a lease whose holder died and whose pid was later recycled by an
// unrelated live process excluded that account forever: pid-liveness answers "held" and nothing
// ever re-examines the file. This knob decides between two failure modes IN BOTH DIRECTIONS, so
// both sides are pinned below: sweeping too early re-creates two `claude` processes on one
// CLAUDE_CONFIG_DIR, sweeping too late (or never) is the permanent exclusion.
//
// Every fixture derives its timestamp from Date.now(). This project has already shipped a
// literal (`notBefore: '2026-09-01T13:00:00Z'`), committed it green, and watched it start failing
// at 13:00:00Z -- a wall-clock literal in a test is a scheduled outage.

const { MAX_LEASE_AGE_MS } = accountLease;
const { LLM_STEP_DEADLINE_MS } = require('../orchestrator/step-contracts');
const AGE_EPSILON_MS = 60 * 1000; // comfortably longer than any test's own runtime

function leaseAged(ageMs, pid = process.pid) {
  return JSON.stringify({ pid, startedAt: new Date(Date.now() - ageMs).toISOString() });
}

test('MAX_LEASE_AGE_MS is DERIVED from LLM_STEP_DEADLINE_MS, not a literal that can drift past it', () => {
  // The exact derivation, restated so the intent is readable...
  assert.equal(
    MAX_LEASE_AGE_MS,
    2 * LLM_STEP_DEADLINE_MS + Math.round(LLM_STEP_DEADLINE_MS / 10),
    'the bound must be computed from LLM_STEP_DEADLINE_MS'
  );
  // ...and the relationship that actually has to survive a future edit to that constant. A
  // hardcoded number fails this the moment LLM_STEP_DEADLINE_MS moves, which is the whole point:
  // one lease can span TWO `claude` calls (intake's same-account timeout retry runs inside the
  // lease), so the bound must stay strictly above 2x, with slack, and never balloon to 3x.
  assert.ok(
    MAX_LEASE_AGE_MS > 2 * LLM_STEP_DEADLINE_MS,
    `the bound must exceed the worst legitimate hold (2 x ${LLM_STEP_DEADLINE_MS}ms), got ${MAX_LEASE_AGE_MS}`
  );
  assert.ok(
    MAX_LEASE_AGE_MS < 3 * LLM_STEP_DEADLINE_MS,
    `the slack must stay a fraction of a step deadline, not another whole one, got ${MAX_LEASE_AGE_MS}`
  );
});

test('tryAcquireLease: a lease JUST INSIDE the age bound with a LIVE pid is NOT swept', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-age-under-'), [{ name: 'acct-a' }]);
  // process.pid is genuinely alive: this is the case where sweeping would hand a second `claude`
  // the same CLAUDE_CONFIG_DIR as the sibling still mid-step -- the D1 failure.
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), leaseAged(MAX_LEASE_AGE_MS - AGE_EPSILON_MS));

  assert.equal(
    tryAcquireLease(poolDir, 'acct-a'),
    null,
    'a live holder inside the age bound must keep its lease -- sweeping early puts two `claude` calls on one account'
  );
  assert.equal(leasedAccountNames(poolDir).has('acct-a'), true, 'and pick() must still treat it as leased');
});

test('tryAcquireLease: a lease JUST PAST the age bound with a LIVE pid IS swept', () => {
  const poolDir = writePoolDir(mkTmp('spo-lease-age-over-'), [{ name: 'acct-a' }]);
  // Same live pid as above -- the ONLY difference is the age. This is the recycled-pid case: the
  // original holder is long gone, the pid now belongs to something unrelated, and pid-liveness
  // alone would exclude this account forever.
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), leaseAged(MAX_LEASE_AGE_MS + AGE_EPSILON_MS));

  const held = tryAcquireLease(poolDir, 'acct-a');
  assert.ok(held, 'a lease older than the bound must be swept even though its pid is alive');
  assert.equal(held.pid, process.pid);
  assert.equal(
    leasedAccountNames(poolDir).has('acct-a'),
    true,
    'and after OUR acquire it is leased again -- by us, with a fresh timestamp'
  );
});

test('leasedAccountNames: applies the SAME age rule as tryAcquireLease -- an over-age lease stops excluding its account', () => {
  // If these two disagreed, the bug would survive the fix: pick() would keep excluding the
  // account, so the acquire that performs the sweep would never be attempted.
  const poolDir = writePoolDir(mkTmp('spo-lease-age-agree-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), leaseAged(MAX_LEASE_AGE_MS + AGE_EPSILON_MS));
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-b'), leaseAged(MAX_LEASE_AGE_MS - AGE_EPSILON_MS));

  assert.deepEqual(
    Array.from(leasedAccountNames(poolDir)).sort(),
    ['acct-b'],
    'the over-age lease must stop excluding acct-a, while the in-bound one still excludes acct-b'
  );
});

test('a DEAD pid is still swept immediately, without waiting out the age bound', () => {
  // The common case, not the exotic one: the post-merge deploy hook SIGTERMs this tree, orphaning
  // any lease mid-step. Making that wait 31 minutes would be a plain regression, so both rules
  // have to stay -- pid OR age, never age alone.
  const poolDir = writePoolDir(mkTmp('spo-lease-age-deadpid-'), [{ name: 'acct-a' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), leaseAged(1000, 999999)); // one second old, pid gone

  const held = tryAcquireLease(poolDir, 'acct-a', () => false);
  assert.ok(held, 'a dead-pid lease must be swept on the spot regardless of how young it is');
});

test('leaseHealthyAccount: an over-age lease on the only healthy account is recovered, not parked', async () => {
  // End to end, and the exact shape D3 measured: one account excluded by a stale lease naming a
  // live-but-unrelated pid, the other cooling. Before the age bound this waited out the full
  // lease bound and parked all-accounts-leased; now it recovers the account.
  const poolDir = writePoolDir(mkTmp('spo-lease-age-recover-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  fs.writeFileSync(leaseFilePath(poolDir, 'acct-a'), leaseAged(MAX_LEASE_AGE_MS + AGE_EPSILON_MS));
  accounts.markLimit(poolDir, 'acct-b', 'usage');

  const leased = await leaseHealthyAccount(poolDir, { waitMs: 200, pollMs: 20 });
  assert.equal(leased.account.name, 'acct-a', 'the account held by an over-age lease must become usable again');
  leased.release();
});
