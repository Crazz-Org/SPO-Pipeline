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

// execFileSync throws on a non-zero exit, and node:test/no-real-spawn.js's repo-wide guard
// (installed as a side effect of requiring it -- see that module's own header) patches
// child_process.spawnSync UNCONDITIONALLY in every test file, including this legitimate
// subprocess-launch use: it does not distinguish "a test reached a real spawnSync in-process"
// (the incident it exists to close) from "test/helpers.js's own sanctioned real-process
// boundary happens to use spawnSync instead of execFileSync". So worker-mode tests, which need
// the exit code from a non-zero run, follow test/lock.test.js's existing precedent (its
// "refuses to start when a live daemon holds the journal root" test) instead of spawnSync:
// catch execFileSync's throw and read `.status`/`.stdout`/`.stderr` off the Error object, which
// Node populates with exactly those fields. Normalized into a {status, stdout, stderr} result
// either way, so a caller never has to branch on whether the run happened to succeed.
//
// `timeout` is not belt-and-braces: every usage-error case below asserts that daemon.js REFUSES
// and exits, and the way that assertion fails is the daemon NOT refusing -- i.e. falling through
// to runForever, which polls forever. Without a timeout, execFileSync then blocks the whole
// `node --test` run indefinitely rather than failing one test, so the regression reports as a
// hung suite with no failing test name. Measured, not hypothetical: mutating `workerMode` from
// `opts.worker !== null` to `!!opts.worker` (2026-09-01) made `--shadow --worker` with no path
// boot a full polling daemon; the suite hung past 600s and had to be killed by hand, and the
// mutant daemon left a lock file in the repo's own journal/ on the way out.
function runDaemonWorkerRun(args) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: isolatedEnv(),
      timeout: 60000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    // A `timeout` kill sets err.signal and leaves err.status null (see timeoutResult above for
    // the same shape spawnSync produces) -- surface it as its own status so the assertion says
    // "expected 2, got 'SIGTERM-timeout'" instead of "expected 2, got null".
    if (err && err.signal && (err.status === null || err.status === undefined)) {
      return { status: `timed-out(${err.signal})`, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// Action 6.1: runs `daemon.js --shadow --worker <taskDir>` against a throwaway queue dir (never
// used by worker mode functionally -- a worker never calls takeNextTask/drainQueueOnce -- but
// still isolated the same way every other spawn in this file is, so a mutation that made worker
// mode fall through to the ordinary --queue default (<repo>/queue) would touch a temp dir, not
// this machine's real one).
function runDaemonWorker(taskDir, journalDir, extraArgs = []) {
  const queueDir = mkTmp('spo-worker-unused-queue-');
  const args = [DAEMON, '--shadow', '--worker', taskDir, '--queue', queueDir, '--journal', journalDir, ...extraArgs];
  return runDaemonWorkerRun(args);
}

// Same isolation as every other runner, but the caller supplies the FULL daemon.js argv -- for
// usage-error tests where runDaemonOnce/runDaemonWorker's fixed shape (queue+journal always
// present) doesn't fit, e.g. `--worker` as the very last token with no path following it.
function runDaemonRaw(args) {
  return runDaemonWorkerRun([DAEMON, ...args]);
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
  isolatedEnv, // exported for the few tests that call child_process.spawn() directly (lock.test.js's
  // signal/concurrency integration tests) -- they need the SAME throwaway product repo, worktrees
  // dir, account pool and bench every execFileSync runner above gets. See isolatedEnv's own header
  // for the incident that isolation closes; a direct spawn() is not exempt from it.
  writeTask,
  writePoolDir,
  runDaemonOnce,
  runDaemonDryRun,
  runDaemonWorker,
  runDaemonRaw,
  runSpo,
  readJournal,
  readState,
  readLedger,
  timeoutResult,
};
