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
  const event = accounts.markLimit(dir, 'acct-a', undefined, now);
  assert.equal(event.account, 'acct-a');
  assert.equal(event.defaulted, true);
  assert.equal(event.retryAfterMsUsed, accounts.DEFAULT_COOLDOWN_MS);
  assert.equal(event.cooldownUntil, now + accounts.DEFAULT_COOLDOWN_MS);

  const picked = accounts.pick(dir, now + 1000); // still well inside the cooldown window
  assert.equal(picked.name, 'acct-b');

  // state.json lives next to the accounts, inside the pool directory.
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
});

test('markLimit honors an explicit retryAfterMs instead of the 60-minute default', () => {
  const dir = mkTmp('spo-accounts-retryafter-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const now = 5000;
  const event = accounts.markLimit(dir, 'acct-a', 15000, now);
  assert.equal(event.defaulted, false);
  assert.equal(event.retryAfterMsUsed, 15000);
  assert.equal(event.cooldownUntil, now + 15000);
});

test('a cooling account recovers once its cooldownUntil is past', () => {
  const dir = mkTmp('spo-accounts-recover-');
  writePoolDir(dir, [{ name: 'acct-a' }]);

  const now = 10_000;
  accounts.markLimit(dir, 'acct-a', 1000, now); // cooldownUntil = 11000

  assert.throws(() => accounts.pick(dir, 10_500), accounts.AllAccountsCoolingError);
  const recovered = accounts.pick(dir, 11_001);
  assert.equal(recovered.name, 'acct-a');
});

test('all accounts cooling -> AllAccountsCoolingError naming the earliest cooldownUntil', () => {
  const dir = mkTmp('spo-accounts-allcooling-');
  writePoolDir(dir, [{ name: 'acct-a' }, { name: 'acct-b' }]);

  const now = 100_000;
  accounts.markLimit(dir, 'acct-a', 50_000, now); // until 150000
  accounts.markLimit(dir, 'acct-b', 20_000, now); // until 120000 -- the earliest of the two

  let caught = null;
  try {
    accounts.pick(dir, now + 1);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof accounts.AllAccountsCoolingError);
  assert.equal(caught.detail.earliestCooldownUntil, 120_000);
  assert.match(caught.reason, /all-accounts-cooling-until-/);
  assert.equal(caught.reason, `all-accounts-cooling-until-${new Date(120_000).toISOString()}`);
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
