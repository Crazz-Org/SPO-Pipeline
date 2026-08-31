'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, writePoolDir } = require('./helpers');
const accounts = require('../orchestrator/accounts');

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
