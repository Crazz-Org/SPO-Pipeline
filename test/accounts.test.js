'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, writePoolDir } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const accounts = require('../orchestrator/accounts');
const lock = require('../orchestrator/lock');

// action 6.2's markLimit concurrency test spawns real OS processes via the ASYNC
// child_process.spawn -- no-real-spawn.js only patches spawnSync (see its own header), so this
// is deliberately untouched, same precedent as test/lock.test.js's own real-process coverage.
const { spawn } = require('child_process');
const MARK_LIMIT_ONCE_FIXTURE = path.join(__dirname, 'fixtures', 'mark-limit-once.js');

test('missing pool directory -> empty registry, pick() throws NoAccountsRegisteredError', () => {
  const dir = mkTmp('spo-accounts-missing-');
  assert.deepEqual(accounts.readRegistry(dir), []);

  let caught = null;
  try {
    accounts.pick(dir);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof accounts.NoAccountsRegisteredError);
  assert.equal(caught.reason, 'no-accounts-registered');
});

test('pool directory exists but is empty (no subdirectories) -> same as missing', () => {
  const dir = mkTmp('spo-accounts-empty-');
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(accounts.readRegistry(dir), []);
  assert.throws(() => accounts.pick(dir), accounts.NoAccountsRegisteredError);
});

test('a file in the pool directory (not a subdirectory) is not discovered as an account', () => {
  const dir = mkTmp('spo-accounts-stray-file-');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'not an account');
  assert.deepEqual(accounts.readRegistry(dir), []);
});

test('every subdirectory of the pool becomes one account, sorted by name', () => {
  const dir = mkTmp('spo-accounts-discover-');
  writePoolDir(dir, [{ name: 'acct-b' }, { name: 'acct-a' }]);

  const registry = accounts.readRegistry(dir);
  assert.deepEqual(
    registry.map((a) => a.name),
    ['acct-a', 'acct-b']
  );
  for (const a of registry) {
    assert.equal(a.configDir, path.join(dir, a.name));
    assert.equal(a.oauthTokenFile, null);
    assert.equal(a.enabled, true);
  }
});

test('an oauth-token file is discovered as oauthTokenFile; its absence is null, not an error', () => {
  const dir = mkTmp('spo-accounts-token-');
  writePoolDir(dir, [{ name: 'acct-with-token', oauthToken: 'sk-fake-token\n' }, { name: 'acct-without-token' }]);

  const registry = accounts.readRegistry(dir);
  const withToken = registry.find((a) => a.name === 'acct-with-token');
  const withoutToken = registry.find((a) => a.name === 'acct-without-token');

  assert.equal(withToken.oauthTokenFile, path.join(dir, 'acct-with-token', 'oauth-token'));
  assert.equal(fs.readFileSync(withToken.oauthTokenFile, 'utf8'), 'sk-fake-token\n');
  assert.equal(withoutToken.oauthTokenFile, null);
});

test('a `disabled` marker file makes enabled false; its absence means enabled true', () => {
  const dir = mkTmp('spo-accounts-disabled-marker-');
  writePoolDir(dir, [{ name: 'acct-a', disabled: true }, { name: 'acct-b' }]);

  const registry = accounts.readRegistry(dir);
  assert.equal(registry.find((a) => a.name === 'acct-a').enabled, false);
  assert.equal(registry.find((a) => a.name === 'acct-b').enabled, true);
});

test('pick order: first enabled account in registry (name-sorted) order, no cooldowns', () => {
  const dir = mkTmp('spo-accounts-order-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);
  assert.equal(accounts.pick(dir).name, 'acct-a');
});

test('pick order: a disabled account is skipped even if it sorts first', () => {
  const dir = mkTmp('spo-accounts-disabled-skip-');
  writePoolDir(dir, [{ name: 'acct-a', disabled: true }, { name: 'acct-b' }]);
  assert.equal(accounts.pick(dir).name, 'acct-b');
});

test('markLimit puts an account in cooldown and pick() skips it for the next healthy one', () => {
  const dir = mkTmp('spo-accounts-cooldown-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);

  const now = 1_000_000;
  // No limitKind supplied -- R2's fail-safe: treated as a usage hit (defaulted: true), and since
  // there is no prior lastUsageLimitAt on record, it's a first-ever probe (1h), not the
  // escalated tier.
  const event = accounts.markLimit(dir, 'acct-a', undefined, now);
  assert.equal(event.account, 'acct-a');
  assert.equal(event.limitKind, null);
  assert.equal(event.defaulted, true);
  assert.equal(event.escalated, false);
  assert.equal(event.cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);
  assert.equal(event.cooldownUntil, now + accounts.USAGE_PROBE_COOLDOWN_MS);

  const picked = accounts.pick(dir, now + 1000); // still well inside the cooldown window
  assert.equal(picked.name, 'acct-b');

  // state.json lives next to the accounts, inside the pool directory.
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
});

// ---- R1: escalating usage probe (action 3.5's redesign, replacing a flat 5h tier) ----------

test("markLimit: first usage limit for an account -> the 1h probe, not the 5h escalated tier", () => {
  const dir = mkTmp('spo-accounts-probe-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const now = 5000;
  const event = accounts.markLimit(dir, 'acct-a', 'usage', now);
  assert.equal(event.limitKind, 'usage');
  assert.equal(event.defaulted, false);
  assert.equal(event.escalated, false);
  assert.equal(event.cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);
  assert.equal(event.cooldownUntil, now + accounts.USAGE_PROBE_COOLDOWN_MS);

  const state = accounts.readState(dir);
  assert.equal(state['acct-a'].lastUsageLimitAt, now);
  assert.equal(state['acct-a'].usageLimitStreak, 1);
});

test('markLimit: a second usage limit within the escalation window of the first -> the 5h escalated tier', () => {
  const dir = mkTmp('spo-accounts-escalate-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const first = 0;
  accounts.markLimit(dir, 'acct-a', 'usage', first);

  const second = first + accounts.ESCALATION_WINDOW_MS; // right at the edge, still "within"
  const event = accounts.markLimit(dir, 'acct-a', 'usage', second);
  assert.equal(event.escalated, true);
  assert.equal(event.cooldownMs, accounts.USAGE_ESCALATED_COOLDOWN_MS);
  assert.equal(event.cooldownUntil, second + accounts.USAGE_ESCALATED_COOLDOWN_MS);

  const state = accounts.readState(dir);
  assert.equal(state['acct-a'].usageLimitStreak, 2);
});

test('markLimit: a second usage limit AFTER the escalation window has elapsed -> back to the 1h probe, not escalated', () => {
  const dir = mkTmp('spo-accounts-window-elapsed-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const first = 0;
  accounts.markLimit(dir, 'acct-a', 'usage', first);

  const second = first + accounts.ESCALATION_WINDOW_MS + 1; // one ms outside the window
  const event = accounts.markLimit(dir, 'acct-a', 'usage', second);
  assert.equal(event.escalated, false);
  assert.equal(event.cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);

  const state = accounts.readState(dir);
  assert.equal(state['acct-a'].usageLimitStreak, 1, 'streak resets once the window has elapsed');
});

test('markLimit: overloaded is always the flat 5-minute tier and never escalates, even on repeated hits', () => {
  const dir = mkTmp('spo-accounts-overloaded-flat-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const now = 1000;
  const first = accounts.markLimit(dir, 'acct-a', 'overloaded', now);
  assert.equal(first.limitKind, 'overloaded');
  assert.equal(first.escalated, false);
  assert.equal(first.cooldownMs, accounts.OVERLOADED_COOLDOWN_MS);

  // Immediately again (well inside any window) -- still flat, never escalated.
  const second = accounts.markLimit(dir, 'acct-a', 'overloaded', now + 1);
  assert.equal(second.escalated, false);
  assert.equal(second.cooldownMs, accounts.OVERLOADED_COOLDOWN_MS);
});

test('markLimit: an overloaded hit does not touch usage-escalation history, so the usage streak survives it', () => {
  const dir = mkTmp('spo-accounts-overloaded-noop-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const t0 = 0;
  accounts.markLimit(dir, 'acct-a', 'usage', t0);

  // An overloaded hit lands in between -- must not reset or advance the usage streak/timestamp.
  accounts.markLimit(dir, 'acct-a', 'overloaded', t0 + 10);
  let state = accounts.readState(dir);
  assert.equal(state['acct-a'].lastUsageLimitAt, t0);
  assert.equal(state['acct-a'].usageLimitStreak, 1);

  // A usage hit shortly after, still within the escalation window measured from t0, escalates.
  const t1 = t0 + accounts.ESCALATION_WINDOW_MS - 1;
  const event = accounts.markLimit(dir, 'acct-a', 'usage', t1);
  assert.equal(event.escalated, true);
  assert.equal(event.cooldownMs, accounts.USAGE_ESCALATED_COOLDOWN_MS);
});

test('markLimit: an unrecognised limitKind is the R2 fail-safe -- defaulted: true, treated as a usage hit', () => {
  const dir = mkTmp('spo-accounts-unrecognised-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const now = 42;
  const event = accounts.markLimit(dir, 'acct-a', 'some-new-limit-shape', now);
  assert.equal(event.limitKind, 'some-new-limit-shape', 'the supplied value is carried through, not swallowed to null');
  assert.equal(event.defaulted, true);
  assert.equal(event.cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);
});

test('markLimit: an entry written by pre-3.5 code (bare {cooldownUntil}) reads back fine -- probes fresh, never throws', () => {
  const dir = mkTmp('spo-accounts-legacy-entry-');
  writePoolDir(dir, [{ name: 'acct-a' }]);
  accounts.writeState(dir, { 'acct-a': { cooldownUntil: 500 } }); // old shape, no lastUsageLimitAt/usageLimitStreak

  const event = accounts.markLimit(dir, 'acct-a', 'usage', 1000);
  assert.equal(event.escalated, false, 'no usable history -- reads as a first-ever hit, not a continuation');
  assert.equal(event.cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);
});

test('a cooling account recovers once its cooldownUntil is past', () => {
  const dir = mkTmp('spo-accounts-recover-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const now = 10_000;
  accounts.markLimit(dir, 'acct-a', 'overloaded', now); // cooldownUntil = now + OVERLOADED_COOLDOWN_MS

  assert.throws(() => accounts.pick(dir, now + accounts.OVERLOADED_COOLDOWN_MS - 1), accounts.AllAccountsCoolingError);
  const recovered = accounts.pick(dir, now + accounts.OVERLOADED_COOLDOWN_MS + 1);
  assert.equal(recovered.name, 'acct-a');
});

test('all accounts cooling -> AllAccountsCoolingError naming the earliest cooldownUntil', () => {
  const dir = mkTmp('spo-accounts-allcooling-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);

  const now = 100_000;
  // 'usage' -> the 1h probe (until 100000 + 3600000); 'overloaded' -> the flat 5min tier (until
  // 100000 + 300000) -- the earliest of the two.
  accounts.markLimit(dir, 'acct-a', 'usage', now);
  accounts.markLimit(dir, 'acct-b', 'overloaded', now);
  const earliest = now + accounts.OVERLOADED_COOLDOWN_MS;

  let caught = null;
  try {
    accounts.pick(dir, now + 1);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof accounts.AllAccountsCoolingError);
  assert.equal(caught.detail.earliestCooldownUntil, earliest);
  assert.match(caught.reason, /all-accounts-cooling-until-/);
  assert.equal(caught.reason, `all-accounts-cooling-until-${new Date(earliest).toISOString()}`);
});

test('every account disabled -> AllAccountsCoolingError with no known earliest cooldown (not NoAccountsRegisteredError)', () => {
  const dir = mkTmp('spo-accounts-alldisabled-');
  writePoolDir(dir, [{ name: 'acct-a', disabled: true }, { name: 'acct-b', disabled: true }]);

  let caught = null;
  try {
    accounts.pick(dir);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof accounts.AllAccountsCoolingError);
  assert.equal(caught.detail.earliestCooldownUntil, null);
  assert.equal(caught.reason, 'all-accounts-cooling-unknown');
});

// ---- hasCredentials ------------------------------------------------------------------------

test('hasCredentials: false for a nonexistent directory', () => {
  const dir = mkTmp('spo-accounts-creds-missing-');
  assert.equal(accounts.hasCredentials(path.join(dir, 'nope')), false);
  assert.equal(accounts.hasCredentials(null), false);
});

test('hasCredentials: false when the account dir holds only oauth-token and/or disabled', () => {
  const dir = mkTmp('spo-accounts-creds-onlymanaged-');
  writePoolDir(dir, [{ name: 'acct-a', oauthToken: 'tok', disabled: true }]);
  assert.equal(accounts.hasCredentials(path.join(dir, 'acct-a')), false);
});

test('hasCredentials: true when the account dir holds any other file (real claude credentials)', () => {
  const dir = mkTmp('spo-accounts-creds-present-');
  writePoolDir(dir, [{ name: 'acct-a', extraFile: '.credentials.json' }]);
  assert.equal(accounts.hasCredentials(path.join(dir, 'acct-a')), true);
});

// The pool's state.json holds every cooldown. readState treats an unparsable file as "nobody has
// ever hit a limit yet" and returns {}, so a torn write does NOT fail loudly -- it silently wipes
// the cooldowns, handing work straight back to a rate-limited account. That is the loop action
// 3.6 exists to end, and it would resurface as an unexplained rate-limit park. So the write has
// to be atomic: a reader sees the whole old state or the whole new one, never a truncation.
test('markLimit: state.json is published by rename, from a tmp inside the pool dir -- never a partial write', () => {
  const poolDir = mkTmp('spo-accounts-atomic-');
  writePoolDir(poolDir, [{ name: 'pool1', oauthToken: 'tok' }, { name: 'pool2', oauthToken: 'tok' }]);

  const realRename = fs.renameSync;
  const seen = [];
  fs.renameSync = (from, to) => {
    // At the instant the real state.json appears, the source must already be complete JSON --
    // that is what makes a concurrent reader safe.
    seen.push({ from, to, source: fs.readFileSync(from, 'utf8'), targetExisted: fs.existsSync(to) });
    return realRename(from, to);
  };
  try {
    accounts.markLimit(poolDir, 'pool1');
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(seen.length, 1, 'exactly one rename publishes the state');
  const [pub] = seen;
  assert.equal(path.dirname(pub.from), poolDir, 'tmp must sit in the pool dir -- rename is only atomic within a filesystem');
  assert.equal(pub.to, path.join(poolDir, 'state.json'));
  assert.doesNotThrow(() => JSON.parse(pub.source), 'the tmp is already complete JSON before the rename');
  assert.ok(JSON.parse(pub.source).pool1.cooldownUntil > 0);

  // No litter, and the cooldown survives a re-read.
  const litter = fs.readdirSync(poolDir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(litter, [], 'no tmp file left behind');
  assert.equal(accounts.pick(poolDir).name, 'pool2', 'pool1 is cooled, so pick falls through');
});

// ---- action 6.2: pick() lease-awareness (opts.excludeAccounts) -----------------------------

test('pick() with no options is byte-for-byte unchanged: first enabled, non-cooling account, no exclusion machinery involved', () => {
  const dir = mkTmp('spo-accounts-pick-default-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);
  // Same assertion as the pre-6.2 "pick order" test above, restated explicitly here so a
  // regression in the new opts-handling branch (e.g. an opts default that isn't `{}`, or an
  // excludeAccounts check that fires even when unset) has its own dedicated failure, not just a
  // shared one at the top of the file.
  assert.equal(accounts.pick(dir).name, 'acct-a');
  assert.equal(accounts.pick(dir, Date.now(), {}).name, 'acct-a', 'an explicit empty opts object must behave identically to no opts at all');
});

test('pick() with excludeAccounts skips a leased (excluded) account and returns the next healthy one', () => {
  const dir = mkTmp('spo-accounts-pick-exclude-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);

  const picked = accounts.pick(dir, Date.now(), { excludeAccounts: new Set(['acct-a']) });
  assert.equal(picked.name, 'acct-b');
});

test('pick() with excludeAccounts covering every HEALTHY account throws AllAccountsLeasedError, distinct from AllAccountsCoolingError', () => {
  const dir = mkTmp('spo-accounts-pick-allleased-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);

  let caught = null;
  try {
    accounts.pick(dir, Date.now(), { excludeAccounts: new Set(['acct-a', 'acct-b']) });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof accounts.AllAccountsLeasedError);
  assert.equal(caught.name, 'AllAccountsLeasedError');
  assert.equal(caught.reason, 'all-accounts-leased');
  assert.deepEqual(caught.detail.checkedAccounts.sort(), ['acct-a', 'acct-b']);
  assert.ok(!(caught instanceof accounts.AllAccountsCoolingError), 'the two error types must stay distinct -- callers branch on which one they got');
});

test('pick(): one account cooling, the other excluded (leased) -> AllAccountsLeasedError, not AllAccountsCoolingError', () => {
  // The case the two error types exist to keep apart: SOME healthy candidate exists (acct-b),
  // it's just not AVAILABLE right now (leased) -- worth a bounded wait, per
  // orchestrator/account-lease.js. A pool where every enabled account is cooling would instead
  // mean nothing is healthy at all, which is never worth waiting on.
  const dir = mkTmp('spo-accounts-pick-mixed-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);
  accounts.markLimit(dir, 'acct-a', 'overloaded');

  let caught = null;
  try {
    accounts.pick(dir, Date.now(), { excludeAccounts: new Set(['acct-b']) });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof accounts.AllAccountsLeasedError, `expected AllAccountsLeasedError, got ${caught && caught.constructor.name}`);
});

test('pick(): excludeAccounts naming a DISABLED account is a no-op -- a disabled account was never pick()-able anyway', () => {
  const dir = mkTmp('spo-accounts-pick-exclude-disabled-');
  writePoolDir(dir, [{ name: 'acct-a', disabled: true }, { name: 'acct-b' }]);
  assert.equal(accounts.pick(dir, Date.now(), { excludeAccounts: new Set(['acct-a']) }).name, 'acct-b');
});

// ---- action 6.2: markLimit's .state.lock -- degrade-never-fail, and the flag it stamps --------

test('markLimit: when the state lock cannot be acquired within its bound, it degrades to the unlocked path -- the update still lands, and `degraded: true` is stamped on the returned event', () => {
  const dir = mkTmp('spo-accounts-marklimit-degrade-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  // Pre-hold the lock ourselves, as a LIVE pid (this test process's own), with a 0ms wait bound
  // so markLimit gives up on its very first attempt rather than actually blocking the test.
  const held = lock.acquireShortLock(accounts.stateLockPath(dir));
  assert.ok(held, 'test setup: must actually hold the lock for this to prove anything');

  try {
    const event = accounts.markLimit(dir, 'acct-a', 'usage', 1000, { lockWaitMs: 0 });
    assert.equal(event.degraded, true, 'the lock was held by a live process the whole time -- this call must report it degraded');
    assert.equal(event.account, 'acct-a');

    // The update itself must still have landed -- "degrade, never fail" means the bookkeeping
    // still happens, just without the exclusivity guarantee.
    const state = accounts.readState(dir);
    assert.equal(state['acct-a'].cooldownUntil, 1000 + accounts.USAGE_PROBE_COOLDOWN_MS);
  } finally {
    lock.releaseShortLock(accounts.stateLockPath(dir), held);
  }
});

test('markLimit: an ordinary call (no contention) is NOT degraded', () => {
  const dir = mkTmp('spo-accounts-marklimit-nodegrade-');
  writePoolDir(dir, [{ name: 'acct-a' }]);
  const event = accounts.markLimit(dir, 'acct-a', 'usage', 1000);
  assert.equal(event.degraded, false);
});

test('markLimit: a stale (dead-pid) .state.lock is swept, not treated as contention', () => {
  const dir = mkTmp('spo-accounts-marklimit-stalelock-');
  writePoolDir(dir, [{ name: 'acct-a' }]);
  fs.writeFileSync(accounts.stateLockPath(dir), JSON.stringify({ pid: 999999, startedAt: 'long-dead' }));

  const event = accounts.markLimit(dir, 'acct-a', 'usage', 1000, { lockWaitMs: 0, isAlive: () => false });
  assert.equal(event.degraded, false, 'a dead-pid lock must be swept and reacquired, not degraded past');
  assert.equal(fs.existsSync(accounts.stateLockPath(dir)), false, 'the lock is released again once markLimit is done with it');
});

// The concurrency test the spec explicitly asks NOT to fake: real child processes, real
// filesystem contention. Before action 6.2, markLimit's read-modify-write was a bare
// read-state/mutate-one-entry/write-WHOLE-state with no exclusion at all -- two processes
// updating two DIFFERENT accounts' entries at close to the same instant would each read the
// SAME stale snapshot of state.json and each write back a full replacement missing the other's
// update, so whichever process's write lands second silently erases the first one's cooldown.
// This is exactly what the live pool's `pool1: {usageLimitStreak: 2}` escalation history (cited
// in this action's own spec) is at risk of losing.
test('markLimit under real concurrency: 4 processes marking 4 different accounts all survive in state.json', async () => {
  const dir = mkTmp('spo-accounts-marklimit-concurrency-');
  const names = ['acct-1', 'acct-2', 'acct-3', 'acct-4'];
  writePoolDir(dir, names.map((name) => ({ name })));

  // VERIFIER: the four children block on this barrier until all four are up, so they enter
  // markLimit together. Without it they are serialised by node's own boot time and the race this
  // test exists to detect is only sampled by luck -- see the fixture's own header for the
  // measured detection rates.
  const barrier = path.join(dir, '.barrier');
  const children = names.map(
    (name) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [MARK_LIMIT_ONCE_FIXTURE, dir, name, 'usage', barrier], { stdio: 'ignore' });
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name}: exited ${code}`))));
        child.once('error', reject);
      })
  );
  await new Promise((r) => setTimeout(r, 300)); // let all four reach the barrier
  fs.writeFileSync(barrier, 'go');
  await Promise.all(children);

  const state = accounts.readState(dir);
  for (const name of names) {
    assert.ok(state[name], `${name}'s cooldown entry must survive concurrent markLimit calls from other processes -- got ${JSON.stringify(Object.keys(state))}`);
    assert.ok(state[name].cooldownUntil > 0);
  }
});

// ---- VERIFIER (action 6.2): the state-lock wait must actually SLEEP, not busy-spin -----------
//
// markLimit's lock wait uses a synchronous sleep (Atomics.wait) between retries. Making that
// sleep a no-op leaves every observable OUTCOME identical -- same degraded flag, same state.json,
// same wall time -- so no assertion in the suite notices, while the 2s default bound turns into
// 2 seconds of hammering the filesystem with create+read attempts, per contended call, per
// worker. Wall time can't tell the two apart; the number of ACQUIRE ATTEMPTS can, and `isAlive`
// is called exactly once per attempt that finds the file present.
test('markLimit: the state-lock wait sleeps between retries -- it does not busy-spin the filesystem', () => {
  const dir = mkTmp('spo-accounts-marklimit-spin-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const held = lock.acquireShortLock(accounts.stateLockPath(dir));
  assert.ok(held, 'test setup: the lock must really be held');

  let attempts = 0;
  try {
    const event = accounts.markLimit(dir, 'acct-a', 'usage', 1000, {
      lockWaitMs: 100,
      lockPollMs: 10,
      isAlive: () => {
        attempts += 1;
        return true;
      },
    });
    assert.equal(event.degraded, true, 'the lock was held throughout -- this must degrade');
  } finally {
    lock.releaseShortLock(accounts.stateLockPath(dir), held);
  }

  // ~10 attempts at a 10ms cadence over a 100ms bound. A generous ceiling: the point is to
  // separate "paced by a real sleep" from "spinning as fast as the fs allows" (thousands),
  // not to pin the exact count against scheduler jitter.
  assert.ok(attempts >= 2, `expected the wait to retry at all, got ${attempts} attempts`);
  assert.ok(
    attempts <= 60,
    `the lock wait must be paced by a real sleep -- ${attempts} acquire attempts in 100ms is a busy spin, not a poll`
  );
});

// ---- action 6.3: markLimit's wait-bound must survive a BACKWARD wall-clock jump ---------------
//
// Measured independently (this action's own verification): on this WSL2 box, Date.now() jumps
// BACKWARD -- -2515ms across a single 10ms monotonic interval, once in 2331 samples over 25s.
// Before this action, markLimit's wait loop computed `remaining = deadline - Date.now()`, and a
// backward jump there can only ever ENLARGE `remaining`, silently extending the bound. This test
// reproduces the exact mechanism deterministically -- monkey-patching the REAL global Date.now
// (restored in `finally`, never left patched for another test) rather than waiting for the real
// bug to fire, which is what "inject the clock" means here: the fix under test is that
// markLimit's own DEFAULT elapsed-time clock is monotonic-clock.js's real hrtime-based function,
// which this patched Date.now can never reach.
test('markLimit: a backward Date.now() jump mid-wait does not extend the bound -- the loop uses a monotonic clock, not Date.now()', () => {
  const dir = mkTmp('spo-accounts-marklimit-clockjump-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const held = lock.acquireShortLock(accounts.stateLockPath(dir));
  assert.ok(held, 'test setup: the lock must really be held throughout, so the wait runs its full bound');

  const realDateNow = Date.now;
  let calls = 0;
  // Ticks forward normally for the first few reads (so acquireShortLock's own internal timestamps,
  // if it ever reads Date.now for something other than this loop, still look sane), then jumps
  // backward hard -- reproducing the measured -2515ms/10ms shape -- and keeps jumping backward on
  // every subsequent call, which is the worst case: a wall clock that NEVER catches back up within
  // this wait. If markLimit's loop were still keyed on Date.now(), this would make it wait far
  // longer than lockWaitMs; with the fix, it must not notice at all.
  const start = realDateNow();
  Date.now = () => {
    calls += 1;
    if (calls <= 2) return start + calls;
    return start - 2515 * (calls - 2); // keeps receding -- never lets a Date.now()-keyed loop catch up
  };

  const before = process.hrtime.bigint();
  let event;
  try {
    event = accounts.markLimit(dir, 'acct-a', 'usage', 1000, { lockWaitMs: 150, lockPollMs: 20 });
  } finally {
    Date.now = realDateNow;
    lock.releaseShortLock(accounts.stateLockPath(dir), held);
  }
  const realElapsedMs = Number((process.hrtime.bigint() - before) / 1000000n);

  assert.equal(event.degraded, true, 'the lock was held throughout -- this must degrade');
  // Generous ceiling (well above the 150ms bound, well below what a Date.now()-keyed loop facing
  // a receding clock would do -- that shape never terminates on its own budget at all, since
  // `remaining` only ever grows). This is the assertion a regression back to Date.now() fails:
  // it would blow straight through this ceiling, or time this test out entirely.
  assert.ok(
    realElapsedMs < 2000,
    `markLimit waited ${realElapsedMs}ms against a 150ms bound while Date.now() receded -- the loop is keyed on Date.now(), not a monotonic clock`
  );
});

test('markLimit: opts.monotonicNowMs/opts.sleepSyncMs are honoured -- a fake clock can drive the wait with zero real waiting', () => {
  const dir = mkTmp('spo-accounts-marklimit-fakeclock-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const held = lock.acquireShortLock(accounts.stateLockPath(dir));
  assert.ok(held, 'test setup');

  let fakeMs = 0;
  const monotonicNowMs = () => fakeMs;
  const sleepCalls = [];
  const sleepSyncMs = (ms) => {
    sleepCalls.push(ms);
    fakeMs += ms;
  };

  let event;
  try {
    event = accounts.markLimit(dir, 'acct-a', 'usage', 1000, {
      lockWaitMs: 500,
      lockPollMs: 50,
      monotonicNowMs,
      sleepSyncMs,
    });
  } finally {
    lock.releaseShortLock(accounts.stateLockPath(dir), held);
  }

  assert.equal(event.degraded, true);
  assert.ok(sleepCalls.length > 0, 'must have retried at least once');
  assert.ok(fakeMs >= 500, 'must not give up before the injected clock reaches the configured bound');
});

// ---- action 3.6: clearCooldown, the `spo account clear-cooldown <name>` escape hatch ----------
//
// Built after a live incident: the maintainer hand-edited ~/.claude-accounts/state.json twice on
// 2026-09-02 to unblock pool1, outside markLimit's own lock, and (it is believed) left
// lastUsageLimitAt armed both times -- clearing cooldownUntil alone is not enough, see
// clearCooldown's own header in accounts.js. The tests below are written from that incident:
// each one proves the CONSEQUENCE the maintainer actually cares about, not just a field's value.

test('clearCooldown: an unknown account name is refused (UnknownAccountError), and writes nothing into state.json', () => {
  const dir = mkTmp('spo-accounts-clear-unknown-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  let caught = null;
  try {
    accounts.clearCooldown(dir, 'acct-ghost', 1000);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof accounts.UnknownAccountError, `expected UnknownAccountError, got ${caught && caught.constructor.name}`);

  // The whole point of the guard: a typo'd name must never create an orphan entry that nothing
  // will ever clean up.
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'refusing an unknown name must not write state.json at all');
});

test('clearCooldown: an account that was never cooling is an honest no-op -- it does not fabricate a state.json entry', () => {
  const dir = mkTmp('spo-accounts-clear-noop-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const result = accounts.clearCooldown(dir, 'acct-a', 1000);
  assert.equal(result.hadEntry, false);
  assert.equal(result.wasCooling, false);
  assert.equal(result.cooldownUntil, null);
  assert.equal(result.cooldownUntilIso, null);
  assert.equal(result.escalationWasArmed, false);
  assert.equal(result.cleared, false, 'nothing was on record -- clearCooldown must not report a write it did not make');

  // Never even created state.json, exactly like a markLimit that never ran.
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

// THE important test (per this action's own spec): clearing a cooldown must remove the
// escalation state too, proven from INSIDE the behaviour -- clear an account whose
// lastUsageLimitAt is recent, then call the REAL markLimit again and assert the resulting
// cooldown lands on the 1h PROBE tier, not the 5h ESCALATED tier. A test that only checks
// `lastUsageLimitAt === undefined` after clearing would survive a bug that clears cooldownUntil
// and lastUsageLimitAt but forgets usageLimitStreak (computeLimitUpdate's `escalated` check does
// not read usageLimitStreak, so that alone wouldn't be caught either -- but a future refactor
// that keys escalation off streak instead would be, and this test does not care WHICH field a
// regression forgets, only the observable tier it produces).
test('clearCooldown really clears the escalation window: a fresh markLimit call right after a clear lands on the 1h probe tier, not the 5h escalated tier', () => {
  const dir = mkTmp('spo-accounts-clear-escalation-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const t0 = 1_000_000;
  // First usage hit: no prior history, so this is itself a probe (1h) -- but it arms
  // lastUsageLimitAt for whatever comes next, which is exactly the state clearCooldown must undo.
  const first = accounts.markLimit(dir, 'acct-a', 'usage', t0);
  assert.equal(first.escalated, false);

  const t1 = t0 + 1000; // shortly after -- well inside ESCALATION_WINDOW_MS (2h), i.e. still armed
  const before = accounts.clearCooldown(dir, 'acct-a', t1);
  assert.equal(before.hadEntry, true);
  assert.equal(before.wasCooling, true, 'the probe cooldown from t0 has not expired yet at t1');
  assert.equal(before.escalationWasArmed, true, 'lastUsageLimitAt (t0) is 1000ms old at t1 -- well inside the 2h escalation window');
  assert.equal(before.cleared, true);

  // state.json must have nothing left for this account -- readState/markLimit both read a
  // missing entry as "nothing on record", the same as an account that never hit a limit.
  assert.equal(accounts.readState(dir)['acct-a'], undefined);

  // The account re-limits shortly after being cleared -- the realistic shape of the incident
  // this command exists for (maintainer clears, account gets picked again, hits a limit again
  // before the OLD 2h escalation window would have expired on its own).
  const t2 = t1 + 1000;
  const after = accounts.markLimit(dir, 'acct-a', 'usage', t2);
  assert.equal(after.escalated, false, 'clearCooldown must have removed lastUsageLimitAt -- this hit has no history to escalate against');
  // Literal milliseconds, not accounts.USAGE_PROBE_COOLDOWN_MS -- the anti-cheat rule this repo
  // learned the hard way (C6: cutting a safety constant from 22 to 3 passed 1303 tests because
  // every assertion recomputed its expectation from the same constant). 1 hour is
  // USAGE_PROBE_COOLDOWN_MS's literal value, orchestrator/accounts.js line ~93.
  assert.equal(after.cooldownMs, 60 * 60 * 1000, 'a real regression: escalation state left armed would have produced the 5h tier (18000000ms) instead');
});

test('clearCooldown on a STALE entry (cooldownUntil already past) still reports wasCooling=false but still clears the escalation state', () => {
  const dir = mkTmp('spo-accounts-clear-stale-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const t0 = 1_000_000;
  accounts.markLimit(dir, 'acct-a', 'usage', t0); // cooldownUntil = t0 + 1h

  // Long after the probe cooldown expired, but still inside the 2h escalation window.
  const t1 = t0 + 90 * 60 * 1000; // +90min: cooldown (60min) has passed, escalation window (120min) has not
  const result = accounts.clearCooldown(dir, 'acct-a', t1);
  assert.equal(result.hadEntry, true);
  assert.equal(result.wasCooling, false, 'cooldownUntil was 30 minutes in the past at t1 -- not currently cooling');
  assert.equal(result.escalationWasArmed, true, 'lastUsageLimitAt is 90 minutes old at t1 -- still inside the 2h window even though the cooldown itself expired');
  assert.equal(result.cleared, true, 'a stale entry still carries the escalation fields and must still be cleared');
});

// ---- clearCooldown's own .state.lock -- same idiom as markLimit's, proven the same way --------

test('clearCooldown: when the state lock cannot be acquired within its bound, it degrades to the unlocked path -- the clear still lands, and `degraded: true` is stamped on the result', () => {
  const dir = mkTmp('spo-accounts-clear-degrade-');
  writePoolDir(dir, [{ name: 'acct-a' }]);
  accounts.markLimit(dir, 'acct-a', 'usage', 1000);

  const held = lock.acquireShortLock(accounts.stateLockPath(dir));
  assert.ok(held, 'test setup: must actually hold the lock for this to prove anything');

  try {
    const result = accounts.clearCooldown(dir, 'acct-a', 2000, { lockWaitMs: 0 });
    assert.equal(result.degraded, true, 'the lock was held by a live process the whole time -- this call must report it degraded');
    assert.equal(result.cleared, true, 'degrade-never-fail: the clear itself must still land, just without the exclusivity guarantee');
  } finally {
    lock.releaseShortLock(accounts.stateLockPath(dir), held);
  }

  // The unlocked fallback still did the real write -- proven independently of the returned flag.
  assert.equal(accounts.readState(dir)['acct-a'], undefined);
});

test('clearCooldown: the state-lock wait genuinely retries (proves the lock was actually taken, not silently skipped) -- same isAlive-counting technique as markLimit\'s own spin test', () => {
  const dir = mkTmp('spo-accounts-clear-lockwait-');
  writePoolDir(dir, [{ name: 'acct-a' }]);
  accounts.markLimit(dir, 'acct-a', 'usage', 1000);

  const held = lock.acquireShortLock(accounts.stateLockPath(dir));
  assert.ok(held, 'test setup: the lock must really be held');

  let attempts = 0;
  try {
    const result = accounts.clearCooldown(dir, 'acct-a', 2000, {
      lockWaitMs: 100,
      lockPollMs: 10,
      isAlive: () => {
        attempts += 1;
        return true;
      },
    });
    assert.equal(result.degraded, true, 'the lock was held throughout -- this must degrade');
  } finally {
    lock.releaseShortLock(accounts.stateLockPath(dir), held);
  }

  // If clearCooldown did not really attempt to acquire the lock at all, `isAlive` (only called
  // when acquireShortLock finds the file present) would never fire.
  assert.ok(attempts >= 2, `expected the wait to retry against the held lock, got ${attempts} attempts -- the lock was not genuinely taken`);
});

test('clearCooldown: a stale (dead-pid) .state.lock is swept, not treated as contention', () => {
  const dir = mkTmp('spo-accounts-clear-stalelock-');
  writePoolDir(dir, [{ name: 'acct-a' }]);
  accounts.markLimit(dir, 'acct-a', 'usage', 1000);
  fs.writeFileSync(accounts.stateLockPath(dir), JSON.stringify({ pid: 999999, startedAt: 'long-dead' }));

  const result = accounts.clearCooldown(dir, 'acct-a', 2000, { lockWaitMs: 0, isAlive: () => false });
  assert.equal(result.degraded, false, 'a dead-pid lock must be swept and reacquired, not degraded past');
  assert.equal(fs.existsSync(accounts.stateLockPath(dir)), false, 'the lock is released again once clearCooldown is done with it');
});
