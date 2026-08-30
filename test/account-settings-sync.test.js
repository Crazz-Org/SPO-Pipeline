'use strict';
// Covers the pool's user-tier permission policy: accounts.syncSettings /
// accounts.stampManagedSettings, and the `spo account sync-settings` command that drives them.
//
// WHY the pool needs a policy at all: steps/llm.js spawns `claude -p` with CLAUDE_CONFIG_DIR set
// to the account's own directory, so the machine's ~/.claude/settings.json is never read by a
// pipeline step -- an account directory IS its own user-settings tier. See
// orchestrator/accounts.js's syncSettings header and doc/permissions.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, writePoolDir, runSpo } = require('./helpers');
const accounts = require('../orchestrator/accounts');

const POLICY = `${JSON.stringify({ permissions: { allow: ['Bash(git status*)'], deny: [] } }, null, 2)}\n`;

test('syncSettings writes settings.json into every account directory', () => {
  const pool = mkTmp('spo-sync-write-');
  writePoolDir(pool, [{ name: 'pool1' }, { name: 'pool2' }]);

  const results = accounts.syncSettings(pool, POLICY);

  assert.deepEqual(
    results.map((r) => [r.name, r.action]),
    [
      ['pool1', 'created'],
      ['pool2', 'created'],
    ]
  );
  for (const name of ['pool1', 'pool2']) {
    const written = fs.readFileSync(path.join(pool, name, 'settings.json'), 'utf8');
    assert.equal(written, POLICY);
  }
});

test('syncSettings is idempotent -- an account already carrying the policy reports unchanged', () => {
  const pool = mkTmp('spo-sync-idempotent-');
  writePoolDir(pool, [{ name: 'pool1' }]);

  accounts.syncSettings(pool, POLICY);
  const second = accounts.syncSettings(pool, POLICY);

  assert.deepEqual(second.map((r) => r.action), ['unchanged']);
});

test('syncSettings overwrites a stale policy and reports it as updated', () => {
  const pool = mkTmp('spo-sync-update-');
  writePoolDir(pool, [{ name: 'pool1' }]);
  fs.writeFileSync(path.join(pool, 'pool1', 'settings.json'), '{"permissions":{"allow":[]}}');

  const results = accounts.syncSettings(pool, POLICY);

  assert.deepEqual(results.map((r) => r.action), ['updated']);
  assert.equal(fs.readFileSync(path.join(pool, 'pool1', 'settings.json'), 'utf8'), POLICY);
});

test('syncSettings dryRun reports the same actions but writes nothing', () => {
  const pool = mkTmp('spo-sync-dry-');
  writePoolDir(pool, [{ name: 'pool1' }]);

  const results = accounts.syncSettings(pool, POLICY, { dryRun: true });

  assert.deepEqual(results.map((r) => r.action), ['created']);
  assert.equal(fs.existsSync(path.join(pool, 'pool1', 'settings.json')), false);
});

test('syncSettings covers disabled accounts too -- a re-enabled account must not lag behind', () => {
  const pool = mkTmp('spo-sync-disabled-');
  writePoolDir(pool, [{ name: 'pool1', disabled: true }]);

  const results = accounts.syncSettings(pool, POLICY);

  assert.deepEqual(results.map((r) => [r.name, r.action]), [['pool1', 'created']]);
});

test('syncSettings leaves oauth-token and the disabled marker untouched', () => {
  const pool = mkTmp('spo-sync-preserve-');
  writePoolDir(pool, [{ name: 'pool1', disabled: true, oauthToken: 'sk-secret' }]);

  accounts.syncSettings(pool, POLICY);

  assert.equal(fs.readFileSync(path.join(pool, 'pool1', 'oauth-token'), 'utf8'), 'sk-secret');
  assert.equal(fs.existsSync(path.join(pool, 'pool1', 'disabled')), true);
});

test('a missing pool directory syncs nothing and does not throw', () => {
  const pool = path.join(mkTmp('spo-sync-missing-'), 'never-created');
  assert.deepEqual(accounts.syncSettings(pool, POLICY), []);
});

// Regression: hasCredentials() reports "does this account hold real credentials". It works by
// exclusion, so the file syncSettings writes has to be excluded too -- otherwise syncing the
// pool would make every account report credentials it does not have, and `spo accounts` would
// say an unauthenticated account is ready to run.
test('a synced settings.json is not mistaken for credentials', () => {
  const pool = mkTmp('spo-sync-credentials-');
  writePoolDir(pool, [{ name: 'pool1', oauthToken: 'sk-secret' }]);
  assert.equal(accounts.hasCredentials(path.join(pool, 'pool1')), false);

  accounts.syncSettings(pool, POLICY);
  assert.equal(accounts.hasCredentials(path.join(pool, 'pool1')), false);

  fs.writeFileSync(path.join(pool, 'pool1', '.credentials.json'), '{}');
  assert.equal(accounts.hasCredentials(path.join(pool, 'pool1')), true);
});

test('stampManagedSettings prepends a machine-owned marker and preserves the policy', () => {
  const stamped = accounts.stampManagedSettings(POLICY, '<repo>/.claude/settings.json');
  const parsed = JSON.parse(stamped);

  assert.match(parsed['//'], /sync-settings/);
  assert.match(parsed['//'], /overwritten/);
  assert.deepEqual(parsed.permissions, JSON.parse(POLICY).permissions);
});

test('spo account sync-settings applies the repo policy to every account', () => {
  const pool = mkTmp('spo-sync-cli-');
  writePoolDir(pool, [{ name: 'pool1' }, { name: 'pool2' }]);

  const out = runSpo(['account', 'sync-settings', '--accounts-dir', pool]);

  assert.match(out, /created\s+pool1/);
  assert.match(out, /created\s+pool2/);

  // What lands is the repo's own reviewed policy, stamped -- not a second copy living in the CLI.
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8'));
  const landed = JSON.parse(fs.readFileSync(path.join(pool, 'pool1', 'settings.json'), 'utf8'));
  assert.deepEqual(landed.permissions, source.permissions);
  assert.match(landed['//'], /machine-owned/);
});

test('spo account sync-settings --dry writes nothing', () => {
  const pool = mkTmp('spo-sync-cli-dry-');
  writePoolDir(pool, [{ name: 'pool1' }]);

  const out = runSpo(['account', 'sync-settings', '--dry', '--accounts-dir', pool]);

  assert.match(out, /nothing written/);
  assert.equal(fs.existsSync(path.join(pool, 'pool1', 'settings.json')), false);
});

test('spo account sync-settings on an empty pool says so instead of failing', () => {
  const pool = mkTmp('spo-sync-cli-empty-');
  fs.mkdirSync(pool, { recursive: true });

  const out = runSpo(['account', 'sync-settings', '--accounts-dir', pool]);

  assert.match(out, /no accounts registered/);
});

test('spo account add syncs the new account immediately', () => {
  const pool = mkTmp('spo-sync-cli-add-');
  fs.mkdirSync(pool, { recursive: true });

  const out = runSpo(['account', 'add', 'pool9', '--accounts-dir', pool]);

  assert.match(out, /Permission policy created/);
  const landed = JSON.parse(fs.readFileSync(path.join(pool, 'pool9', 'settings.json'), 'utf8'));
  assert.ok(Array.isArray(landed.permissions.allow));
});
