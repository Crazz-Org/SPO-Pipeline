'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
const accounts = require('../orchestrator/accounts');

function writeRegistry(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(list, null, 2));
}

test('missing registry -> one implicit default account', () => {
  const dir = mkTmp('spo-accounts-missing-');
  const registry = accounts.readRegistry(dir);
  assert.deepEqual(registry, [{ name: 'default', configDir: null, enabled: true }]);
  const picked = accounts.pick(dir);
  assert.equal(picked.name, 'default');
  assert.equal(picked.configDir, null);
});

test('empty registry array -> one implicit default account', () => {
  const dir = mkTmp('spo-accounts-empty-');
  writeRegistry(dir, []);
  const picked = accounts.pick(dir);
  assert.equal(picked.name, 'default');
});

test('pick order: first enabled account in registry order, no cooldowns', () => {
  const dir = mkTmp('spo-accounts-order-');
  writeRegistry(dir, [
    { name: 'acct-a', configDir: '/x/a', enabled: true },
    { name: 'acct-b', configDir: '/x/b', enabled: true },
  ]);
  assert.equal(accounts.pick(dir).name, 'acct-a');
});

test('pick order: a disabled account is skipped even if it is first', () => {
  const dir = mkTmp('spo-accounts-disabled-');
  writeRegistry(dir, [
    { name: 'acct-a', configDir: '/x/a', enabled: false },
    { name: 'acct-b', configDir: '/x/b', enabled: true },
  ]);
  assert.equal(accounts.pick(dir).name, 'acct-b');
});

test('markLimit puts an account in cooldown and pick() skips it for the next healthy one', () => {
  const dir = mkTmp('spo-accounts-cooldown-');
  writeRegistry(dir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);

  const now = 1_000_000;
  const event = accounts.markLimit(dir, 'acct-a', undefined, now);
  assert.equal(event.account, 'acct-a');
  assert.equal(event.defaulted, true);
  assert.equal(event.retryAfterMsUsed, accounts.DEFAULT_COOLDOWN_MS);
  assert.equal(event.cooldownUntil, now + accounts.DEFAULT_COOLDOWN_MS);

  const picked = accounts.pick(dir, now + 1000); // still well inside the cooldown window
  assert.equal(picked.name, 'acct-b');
});

test('markLimit honors an explicit retryAfterMs instead of the 60-minute default', () => {
  const dir = mkTmp('spo-accounts-retryafter-');
  writeRegistry(dir, [{ name: 'acct-a', configDir: null, enabled: true }]);

  const now = 5000;
  const event = accounts.markLimit(dir, 'acct-a', 15000, now);
  assert.equal(event.defaulted, false);
  assert.equal(event.retryAfterMsUsed, 15000);
  assert.equal(event.cooldownUntil, now + 15000);
});

test('a cooling account recovers once its cooldownUntil is past', () => {
  const dir = mkTmp('spo-accounts-recover-');
  writeRegistry(dir, [{ name: 'acct-a', configDir: null, enabled: true }]);

  const now = 10_000;
  accounts.markLimit(dir, 'acct-a', 1000, now); // cooldownUntil = 11000

  assert.throws(() => accounts.pick(dir, 10_500), accounts.AllAccountsCoolingError);
  const recovered = accounts.pick(dir, 11_001);
  assert.equal(recovered.name, 'acct-a');
});

test('all accounts cooling -> AllAccountsCoolingError naming the earliest cooldownUntil', () => {
  const dir = mkTmp('spo-accounts-allcooling-');
  writeRegistry(dir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);

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

test('every account disabled -> AllAccountsCoolingError with no known earliest cooldown', () => {
  const dir = mkTmp('spo-accounts-alldisabled-');
  writeRegistry(dir, [
    { name: 'acct-a', configDir: null, enabled: false },
    { name: 'acct-b', configDir: null, enabled: false },
  ]);

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
