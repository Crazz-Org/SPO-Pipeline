'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { execFileSync } = require('child_process');
const { mkTmp, writeTask, runDaemonOnce, runSpo, SPO_BIN } = require('./helpers');

test('spo status and spo task exit 0 and render the produced journals', () => {
  const queueDir = mkTmp('spo-queue-cli-');
  const journalDir = mkTmp('spo-journal-cli-');

  writeTask(queueDir, '001.json', {
    id: 'cli-demo',
    title: 'CLI demo task',
    kind: 'synthetic',
    shadow: {
      gate: [0],
      prWait: [0],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });
  writeTask(queueDir, '002.json', {
    id: 'cli-parked',
    title: 'CLI parked task',
    kind: 'synthetic',
    shadow: { gate: [2] },
  });

  runDaemonOnce(queueDir, journalDir);

  // execFileSync throws on non-zero exit -- reaching these assertions IS the exit-0 proof.
  const statusOut = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(statusOut, /queue depth: 0/);
  assert.match(statusOut, /active: 0\s+parked: 1\s+done: 1/);
  assert.match(statusOut, /cli-demo\s+DONE/);
  assert.match(statusOut, /cli-parked\s+PARKED/);

  const taskOut = runSpo(['task', 'cli-demo', '--journal', journalDir]);
  assert.match(taskOut, /INTAKE/);
  assert.match(taskOut, /DONE/);

  const parkedOut = runSpo(['parked', '--journal', journalDir]);
  assert.match(parkedOut, /cli-parked\s+reason=gate-dirty-tree/);
});

test('spo resume <task-id> lists recorded LLM steps as claude --resume commands, never executes', () => {
  const journalDir = mkTmp('spo-journal-resume-');
  const fs = require('fs');
  const path = require('path');
  const taskDir = path.join(journalDir, 'resume-demo');
  fs.mkdirSync(taskDir, { recursive: true });
  const { appendEvent } = require('../orchestrator/journal');
  appendEvent(taskDir, 'PLAN', 'llm-call', {
    step: 'PLAN',
    model: 'fable',
    effort: 'medium',
    account: 'default',
    sessionId: 'sess-plan-1',
    billableTokens: 1234,
    numTurns: 3,
    ok: true,
  });
  appendEvent(taskDir, 'IMPLEMENT', 'llm-call', {
    step: 'IMPLEMENT',
    model: 'sonnet',
    effort: 'medium',
    account: 'default',
    sessionId: 'sess-impl-1',
    billableTokens: 50000,
    numTurns: 12,
    ok: true,
  });

  const out = runSpo(['resume', 'resume-demo', '--journal', journalDir]);
  assert.match(out, /PLAN.*claude --resume sess-plan-1/);
  assert.match(out, /IMPLEMENT.*claude --resume sess-impl-1/);
  assert.doesNotMatch(out, /\$\d/);
});

test('spo resume <bare-session-id> just prints the command for an unknown task id', () => {
  const journalDir = mkTmp('spo-journal-resume-bare-');
  const out = runSpo(['resume', 'not-a-real-task-id', '--journal', journalDir]);
  assert.equal(out.trim(), 'claude --resume not-a-real-task-id');
});

// ---- spo accounts / spo account add|enable|disable -----------------------------------------
// Every one of these points --accounts-dir at a temp pool directory -- never the real,
// machine-level pool (default ~/.claude-accounts) that a session's own credentials might live
// in.

test('spo accounts on an empty pool reports no accounts registered, exit 0', () => {
  const accountsDir = mkTmp('spo-accts-cli-empty-');
  const out = runSpo(['accounts', '--accounts-dir', accountsDir]);
  assert.match(out, /no accounts registered in/);
  assert.match(out, new RegExp(accountsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('spo account add <name> creates the directory and prints the exact guided next steps', () => {
  const accountsDir = mkTmp('spo-accts-cli-add-');
  const out = runSpo(['account', 'add', 'pool1', '--accounts-dir', accountsDir]);

  const dir = path.join(accountsDir, 'pool1');
  const tokenFile = path.join(dir, 'oauth-token');
  assert.equal(
    out,
    [
      `Created ${dir}`,
      '',
      'Next steps:',
      `  1. CLAUDE_CONFIG_DIR=${dir} claude setup-token`,
      `  2. paste the printed token into ${tokenFile}`,
      `  3. chmod 600 ${tokenFile}`,
      // Complete, copy-pasteable command (maintainer rule: never a bare subcommand).
      `  4. ${SPO_BIN} accounts   # verify it shows up, enabled, token=yes`,
      '',
      // The new account's user-tier permission policy, installed on the spot -- an account
      // directory IS a CLAUDE_CONFIG_DIR, so without this it would run its first steps with no
      // rules of its own. See test/account-settings-sync.test.js and doc/permissions.md.
      `Permission policy created: ${path.join(dir, 'settings.json')}`,
      '',
    ].join('\n')
  );
  assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory());

  // `spo account add` still never runs `claude` itself -- the only file it creates is the
  // permission policy it just reported; no credentials, no token.
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('spo accounts reflects a pasted oauth-token as token=yes, enabled=true', () => {
  const accountsDir = mkTmp('spo-accts-cli-token-');
  runSpo(['account', 'add', 'pool1', '--accounts-dir', accountsDir]);
  fs.writeFileSync(path.join(accountsDir, 'pool1', 'oauth-token'), 'sk-fake-token\n');

  const out = runSpo(['accounts', '--accounts-dir', accountsDir]);
  assert.match(out, /pool1\s+enabled=true\s+cooldownUntil=-\s+token=yes\s+credentials=no/);
});

test('spo account disable then enable toggles the `disabled` marker and spo accounts reflects it', () => {
  const accountsDir = mkTmp('spo-accts-cli-toggle-');
  runSpo(['account', 'add', 'pool1', '--accounts-dir', accountsDir]);

  const disableOut = runSpo(['account', 'disable', 'pool1', '--accounts-dir', accountsDir]);
  assert.equal(disableOut.trim(), 'pool1: disabled');
  assert.ok(fs.existsSync(path.join(accountsDir, 'pool1', 'disabled')));
  assert.match(runSpo(['accounts', '--accounts-dir', accountsDir]), /pool1\s+enabled=false/);

  const enableOut = runSpo(['account', 'enable', 'pool1', '--accounts-dir', accountsDir]);
  assert.equal(enableOut.trim(), 'pool1: enabled');
  assert.ok(!fs.existsSync(path.join(accountsDir, 'pool1', 'disabled')));
  assert.match(runSpo(['accounts', '--accounts-dir', accountsDir]), /pool1\s+enabled=true/);
});

test('spo account enable/disable on an unknown account name fails loudly instead of creating one', () => {
  const accountsDir = mkTmp('spo-accts-cli-unknown-');
  assert.throws(() => runSpo(['account', 'disable', 'ghost', '--accounts-dir', accountsDir]));
  assert.equal(fs.existsSync(path.join(accountsDir, 'ghost')), false);
});

test('SPO_ACCOUNTS_DIR env var picks the pool directory when --accounts-dir is not given', () => {
  const accountsDir = mkTmp('spo-accts-cli-envvar-');
  const out = execFileSync(process.execPath, [SPO_BIN, 'account', 'add', 'pool1'], {
    encoding: 'utf8',
    env: { ...process.env, SPO_ACCOUNTS_DIR: accountsDir },
  });
  assert.match(out, /Created/);
  assert.ok(fs.existsSync(path.join(accountsDir, 'pool1')));

  const accountsOut = execFileSync(process.execPath, [SPO_BIN, 'accounts'], {
    encoding: 'utf8',
    env: { ...process.env, SPO_ACCOUNTS_DIR: accountsDir },
  });
  assert.match(accountsOut, /pool1\s+enabled=true/);
});
