'use strict';
// Shared helpers for the orchestrator test suite. Every test runs the real daemon.js / bin/spo
// as child processes against fs.mkdtempSync(os.tmpdir()) queue/journal directories -- never
// against the repo's own queue/ or journal/, and never touching the product repo or the bench.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const DAEMON = path.join(REPO_ROOT, 'orchestrator', 'daemon.js');
const SPO_BIN = path.join(REPO_ROOT, 'bin', 'spo');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// action 2.1b -- what Node's real spawnSync actually returns when its own `timeout` option kills
// the child: BOTH `signal` (the kill signal) AND `error` (an Error with `.code === 'ETIMEDOUT'`)
// are set, `status` is null. Same shape steps/scripted.js's spawnOnce and steps/llm.js's
// invokeClaudeReal both learned to expect the hard way (card #449) -- test/real-steps.test.js
// keeps its own local copy (predates this helper); every OTHER test file that exercises one of
// the newly-bounded spawns (board.js/park-loop.js/report-intake.js/intake.js's own runSync)
// shares this one instead of growing four more near-identical copies.
function timeoutResult(signal = 'SIGTERM') {
  const error = new Error(`spawnSync ${signal} ETIMEDOUT`);
  error.code = 'ETIMEDOUT';
  return { status: null, stdout: '', stderr: '', signal, error };
}

function writeTask(queueDir, filename, taskObj) {
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, filename), JSON.stringify(taskObj, null, 2));
}

// Builds a discovery-based account pool directory (see orchestrator/accounts.js's header
// comment for the on-disk shape it discovers): one subdirectory per entry in `entries`, each
// {name, disabled?, oauthToken?, extraFile?}. `disabled: true` writes the `disabled` marker
// file; `oauthToken: '<text>'` writes `oauth-token` with that content; `extraFile: '<name>'`
// writes an arbitrary extra file (content irrelevant) to simulate real `claude` credentials
// already present -- used by tests asserting `hasCredentials`. Every pool-directory test
// across the suite should build its fixture through this one helper rather than re-deriving
// the discovery shape by hand.
function writePoolDir(poolDir, entries) {
  fs.mkdirSync(poolDir, { recursive: true });
  for (const entry of entries) {
    const dir = path.join(poolDir, entry.name);
    fs.mkdirSync(dir, { recursive: true });
    if (entry.disabled) fs.writeFileSync(path.join(dir, 'disabled'), '');
    if (entry.oauthToken !== undefined) fs.writeFileSync(path.join(dir, 'oauth-token'), entry.oauthToken);
    if (entry.extraFile) fs.writeFileSync(path.join(dir, entry.extraFile), 'x');
  }
  return poolDir;
}

// Every daemon subprocess this suite starts is pointed at a THROWAWAY product repo and worktrees
// dir. No test should ever reach realWorktree -- but a mutation that makes shadow mode take a
// real path can, and then the fixture task ids become real git worktrees and branches in the
// maintainer's live ~/SPO-WebClient. That is not hypothetical: a mutation-testing round on
// 2026-08-31 left 44 worktrees and 61 branches there, and since `worktrees/` is gitignored it was
// invisible to `git status` while breaking bare `node --test` with ~13k foreign test failures.
// Isolation belongs here, in the one place every daemon subprocess goes through, rather than in
// each test remembering to override two config keys.
function isolatedEnv() {
  // action 5.4: `spo status` reads the account pool and the bench directly (folding `spo
  // accounts`'s own data in, plus ~/.spo-bench/spool + running) whenever a caller doesn't pass
  // --accounts-dir/--bench-dir. Before this, any test that ran `spo status` through this helper
  // without those flags silently read the MAINTAINER'S REAL ~/.claude-accounts and ~/.spo-bench
  // -- caught by test/cli.test.js's own status test suddenly printing this machine's real
  // "pool1"/"pool2" accounts. SPO_BENCH_DIR is a fresh, always-empty mkdtempSync, which is what
  // makes "bench idle" the correct default for every test that doesn't set the bench up on
  // purpose. SPO_ACCOUNTS_DIR is NOT left empty, though: real mode (`--dry-run` included --
  // state-machine.js's callLlmStep calls accounts.pick() before ctx.dryRun ever short-circuits
  // the spawn) parks a task immediately on a pool with zero accounts registered
  // (NoAccountsRegisteredError). Every `runDaemonDryRun` test in this suite was, until this
  // action, unknowingly depending on the real ~/.claude-accounts pool having at least one
  // account in it to reach DONE -- caught by test/dry-run-demo.test.js parking the instant the
  // isolation above was tightened. One harmless, credential-free account (no oauth-token, no
  // extra files) is registered here so dry-run mode has something to pick without ever touching
  // real credentials; a test that wants to exercise cooldowns/rotation for real still builds and
  // passes its own `--accounts-dir` explicitly, which overrides this one (bin/spo's
  // resolveAccountsDir / config.js's claudeAccountsDir both take the flag over the env var).
  const accountsDir = mkTmp('spo-isolated-accounts-');
  writePoolDir(accountsDir, [{ name: 'isolated' }]);

  return {
    ...process.env,
    SPO_PRODUCT_REPO: mkTmp('spo-isolated-product-'),
    SPO_WORKTREES_DIR: mkTmp('spo-isolated-worktrees-'),
    SPO_ACCOUNTS_DIR: accountsDir,
    SPO_BENCH_DIR: mkTmp('spo-isolated-bench-'),
  };
}

function runDaemonOnce(queueDir, journalDir, extraArgs = []) {
  const args = [DAEMON, '--shadow', '--once', '--queue', queueDir, '--journal', journalDir, ...extraArgs];
  return execFileSync(process.execPath, args, { encoding: 'utf8', env: isolatedEnv() });
}

// Same as runDaemonOnce but real-mode semantics without spawning (--dry-run instead of
// --shadow) -- see orchestrator/README.md "Real mode" / "--dry-run". Still never touches the
// real `claude` CLI or any scripted command.
function runDaemonDryRun(queueDir, journalDir, extraArgs = []) {
  const args = [DAEMON, '--dry-run', '--once', '--queue', queueDir, '--journal', journalDir, ...extraArgs];
  return execFileSync(process.execPath, args, { encoding: 'utf8', env: isolatedEnv() });
}

function runSpo(args) {
  return execFileSync(process.execPath, [SPO_BIN, ...args], { encoding: 'utf8', env: isolatedEnv() });
}

function readJournal(journalDir, id) {
  const p = path.join(journalDir, id, 'journal.jsonl');
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readState(journalDir, id) {
  return JSON.parse(fs.readFileSync(path.join(journalDir, id, 'state.json'), 'utf8'));
}

function readLedger(journalDir, id) {
  const p = path.join(journalDir, id, 'ledger.md');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

module.exports = {
  REPO_ROOT,
  DAEMON,
  SPO_BIN,
  mkTmp,
  writeTask,
  writePoolDir,
  runDaemonOnce,
  runDaemonDryRun,
  runSpo,
  readJournal,
  readState,
  readLedger,
  timeoutResult,
};
