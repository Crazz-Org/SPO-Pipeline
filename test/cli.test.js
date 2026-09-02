'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { execFileSync } = require('child_process');
const { mkTmp, writeTask, runDaemonOnce, runSpo, SPO_BIN } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
// (test/no-real-spawn-sweep.test.js enforces this order textually across every test file.)
require('./no-real-spawn');
const accounts = require('../orchestrator/accounts');

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
  // action 5.4: bench queue depth and account health are now folded into `spo status` (both
  // isolated to throwaway tmp dirs by test/helpers.js's isolatedEnv -- never the maintainer's
  // real ~/.spo-bench / ~/.claude-accounts).
  assert.match(statusOut, /bench: spool=0\s+running=0/);
  // test/helpers.js's isolatedEnv() seeds one credential-free account ("isolated") into every
  // daemon/spo subprocess's account pool -- see that function's own comment for why an empty
  // pool would park real-mode `--dry-run` fixtures elsewhere in this suite.
  assert.match(statusOut, /account isolated\s+enabled=true\s+cooldown=none/);
  // action 4.4/5.4: the summary line grew a `backoff:` counter between `active:` and `parked:`
  // -- this fixture has no card in auto-retry backoff, so it's 0, but the field is always
  // printed. action 4.5's `abandoned:` counter (between `parked:` and `done:`) is likewise
  // always printed.
  assert.match(statusOut, /active: 0\s+backoff: 0\s+parked: 1\s+abandoned: 0\s+done: 1/);
  assert.match(statusOut, /cli-demo\s+DONE\s+done/);
  // action 5.4, item A: a PARKED row's third column is state.json's own `reason`
  // (gate-dirty-tree, from this fixture's shadow.gate: [2]), never the last journal event's
  // name -- and carries the unpark scan's own failure-streak status (item F), "ok" here since
  // this fixture never ran the scan at all.
  assert.match(statusOut, /cli-parked\s+PARKED\s+reason=gate-dirty-tree\s+retry-channel: no failures recorded/);

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
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
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

// ---- action 3.6: `spo account clear-cooldown <name>` -- the live-incident escape hatch --------
//
// Built after the maintainer hand-edited ~/.claude-accounts/state.json twice on 2026-09-02,
// outside markLimit's own lock, to unblock a cooling pool. These exercise the CLI wiring on top
// of accounts.clearCooldown (already covered in depth by test/accounts.test.js) -- the exit code
// on an unknown name, and that the printed report matches what actually happened.

test('spo account clear-cooldown on an unknown account name exits non-zero and writes nothing', () => {
  const accountsDir = mkTmp('spo-accts-cli-clear-unknown-');
  runSpo(['account', 'add', 'pool1', '--accounts-dir', accountsDir]);

  let caught = null;
  try {
    execFileSync(process.execPath, [SPO_BIN, 'account', 'clear-cooldown', 'ghost', '--accounts-dir', accountsDir], {
      encoding: 'utf8',
    });
  } catch (err) {
    caught = err;
  }
  // Verdict by exit code, never by reading text output (CLAUDE.md) -- assert the number, not
  // just that SOMETHING threw.
  assert.ok(caught, 'an unknown account name must fail the process');
  assert.equal(caught.status, 1, `expected exit code 1, got ${caught.status}`);
  assert.match(caught.stderr, /no account "ghost"/);
  assert.equal(fs.existsSync(path.join(accountsDir, 'state.json')), false, 'refusing an unknown name must never write an orphan state.json entry');
});

test('spo account clear-cooldown on an account that was never cooling reports the honest no-op, exits 0', () => {
  const accountsDir = mkTmp('spo-accts-cli-clear-noop-');
  runSpo(['account', 'add', 'pool1', '--accounts-dir', accountsDir]);

  const out = runSpo(['account', 'clear-cooldown', 'pool1', '--accounts-dir', accountsDir]); // throws on non-zero exit
  assert.match(out, /pool1: not cooling -- no cooldown state on record, nothing changed/);
});

test('spo account clear-cooldown on a cooling, escalation-armed account reports both the cooldown and the escalation state cleared, and journals it', () => {
  const accountsDir = mkTmp('spo-accts-cli-clear-cooling-');
  const journalDir = mkTmp('spo-journal-cli-clear-cooling-');
  runSpo(['account', 'add', 'pool1', '--accounts-dir', accountsDir]);

  // Real markLimit (not a hand-built fixture) puts the account in the exact state a live rate
  // limit produces: cooling, and lastUsageLimitAt freshly armed for the escalation window.
  const markEvent = accounts.markLimit(accountsDir, 'pool1', 'usage');
  assert.equal(markEvent.escalated, false, 'test setup: this must be a first-ever probe hit, not already escalated');

  const out = runSpo(['account', 'clear-cooldown', 'pool1', '--accounts-dir', accountsDir, '--journal', journalDir]);
  assert.match(out, /pool1: cleared -- was cooling until/);
  assert.match(out, /escalation state WAS armed \(the next usage limit would have jumped straight to the 5h tier\) -- cleared/);

  // The clear must have actually landed in state.json -- the CLI's own report is not the proof.
  assert.equal(accounts.readState(accountsDir).pool1, undefined);

  // Journalled into daemon.jsonl -- this command has no taskDir, so this is the one place a
  // manual clear leaves a trace at all (a hand state.json edit leaves none).
  const daemonLines = fs
    .readFileSync(path.join(journalDir, 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const event = daemonLines.find((e) => e.event === 'account-cooldown-cleared');
  assert.ok(event, 'expected an account-cooldown-cleared event in daemon.jsonl');
  assert.equal(event.account, 'pool1');
  assert.equal(event.wasCooling, true);
  assert.equal(event.escalationWasArmed, true);
  assert.equal(event.degraded, false);
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
