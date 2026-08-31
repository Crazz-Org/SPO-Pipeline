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

function runDaemonOnce(queueDir, journalDir, extraArgs = []) {
  const args = [DAEMON, '--shadow', '--once', '--queue', queueDir, '--journal', journalDir, ...extraArgs];
  return execFileSync(process.execPath, args, { encoding: 'utf8' });
}

// Same as runDaemonOnce but real-mode semantics without spawning (--dry-run instead of
// --shadow) -- see orchestrator/README.md "Real mode" / "--dry-run". Still never touches the
// real `claude` CLI or any scripted command.
function runDaemonDryRun(queueDir, journalDir, extraArgs = []) {
  const args = [DAEMON, '--dry-run', '--once', '--queue', queueDir, '--journal', journalDir, ...extraArgs];
  return execFileSync(process.execPath, args, { encoding: 'utf8' });
}

function runSpo(args) {
  return execFileSync(process.execPath, [SPO_BIN, ...args], { encoding: 'utf8' });
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
