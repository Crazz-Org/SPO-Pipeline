'use strict';
// Reachability test for the 2026-09-13 incident fix: `daemon.js --dry-run`/`--shadow`, run bare
// (no --queue/--journal, no SPO_STATE_DIR), used to resolve the SAME live queue/journal the real
// daemon owns -- see orchestrator/state-root.js's own header on isLiveStateRoot for the full
// incident writeup (30 real queue entries drained into a fake DONE in ~150ms on the production
// box). test/state-root.test.js already pins isLiveStateRoot as a pure function; THIS file proves
// the wiring in orchestrator/daemon.js's main() actually reaches it -- a real child process,
// `HOME` pointed at a throwaway directory that LOOKS like a live machine (a seeded
// `.spo-state/queue/<entry>.json`), the same shape `os.homedir()` resolves to in production.
//
// SAFETY: every env this file builds derives from test/helpers.js's isolatedEnv() (spawn-
// isolation-sweep.test.js requires every real-spawn call site in test/ to) and then explicitly
// overrides HOME and deletes the SPO_STATE_DIR isolatedEnv() itself sets -- never inherits this
// session's own HOME/state root. If this ever ran without that, it would resolve this machine's
// REAL ~/.spo-state. Never run orchestrator/daemon.js by hand outside a test without SPO_STATE_DIR
// (or HOME) pointed at a throwaway directory -- the live daemon is running on this box.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident this backstops and why this require
// has to land before the orchestrator require(s) below.
require('./no-real-spawn');

const { DAEMON, mkTmp, isolatedEnv } = require('./helpers');
const { stateQueueDir, stateJournalRoot } = require('../orchestrator/state-root');

// Spread FROM isolatedEnv() (test/helpers.js) -- every real-spawn call site in test/ must
// (spawn-isolation-sweep.test.js), and it is what keeps every other isolation var (product repo,
// worktrees dir, account pool, bench, reports) pointed at throwaway directories here too. Then
// override HOME (and therefore os.homedir(), and therefore state-root.js's DEFAULT_STATE_ROOT)
// to the caller's own throwaway directory -- never this session's real one -- and delete the
// SPO_STATE_DIR isolatedEnv() itself set, which would otherwise make it structurally impossible
// to ever exercise the "no override at all, falls back to HOME" path this guard exists for.
// `stateDir`, when passed, becomes SPO_STATE_DIR (the positive case: an explicit override still
// works).
function buildEnv(home, { stateDir } = {}) {
  const env = { ...isolatedEnv(), HOME: home };
  delete env.SPO_STATE_DIR;
  if (stateDir) env.SPO_STATE_DIR = stateDir;
  return env;
}

function runDaemonRawIn(env, args) {
  try {
    const stdout = execFileSync(process.execPath, [DAEMON, ...args], { encoding: 'utf8', env, timeout: 30000 });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (err && err.signal && (err.status === null || err.status === undefined)) {
      return { status: `timed-out(${err.signal})`, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// A queue entry that LOOKS like a real, in-flight card -- shaped close enough to what intake.js
// would have written that a mutant guard draining it would be indistinguishable from the real
// 2026-09-13 incident, not merely "an empty directory nothing could have touched".
function seedLiveShapedQueue(home) {
  const queueDir = stateQueueDir(path.join(home, '.spo-state'));
  fs.mkdirSync(queueDir, { recursive: true });
  const entryPath = path.join(queueDir, '0001-issue-999.json');
  fs.writeFileSync(
    entryPath,
    JSON.stringify({ id: 'issue-999', kind: 'card', issue: 999, title: 'a real, in-flight card' }, null, 2)
  );
  return entryPath;
}

// A task directory that LOOKS like a real, in-flight card sitting INSIDE the live journal root
// -- shaped close enough to what a real worker would find (task.json + state.json) that a
// mutant guard draining it would be indistinguishable from the verifier's own repro: `--dry-run
// --worker $HOME/.spo-state/journal/issue-5 --queue /tmp/q --journal /tmp/j` rewrote that
// state.json to a fake terminal state even though --queue/--journal THEMSELVES were safe temp
// dirs -- the bypass this file's --worker/--repark-task tests below close.
function seedLiveShapedTaskDir(home, id) {
  const taskDir = path.join(stateJournalRoot(path.join(home, '.spo-state')), id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue: 5 }, null, 2));
  const statePath = path.join(taskDir, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      { state: 'IMPLEMENT', owner: { workerPid: 999999, workerStartedAt: '2020-01-01T00:00:00.000Z' } },
      null,
      2
    )
  );
  return { taskDir, statePath };
}

function md5File(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

for (const mode of ['--dry-run', '--shadow']) {
  test(`daemon.js ${mode} --worker <liveTaskDir> refuses even when --queue/--journal are safe temp dirs (the taskDir itself is live-shaped)`, () => {
    const home = mkTmp('spo-live-guard-worker-home-');
    const { taskDir, statePath } = seedLiveShapedTaskDir(home, 'issue-5');
    const beforeMd5 = md5File(statePath);
    const safeQueue = mkTmp('spo-live-guard-safe-queue-');
    const safeJournal = mkTmp('spo-live-guard-safe-journal-');

    const result = runDaemonRawIn(buildEnv(home), [mode, '--worker', taskDir, '--queue', safeQueue, '--journal', safeJournal]);

    assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}\nstderr: ${result.stderr}`);
    assert.match(
      result.stderr,
      /refusing to run .* against the live state root/,
      `expected the refusal message on stderr, got: ${result.stderr}`
    );
    assert.equal(
      md5File(statePath),
      beforeMd5,
      "the live taskDir's state.json must be byte-identical -- never rewritten to a fake terminal state"
    );
  });

  test(`daemon.js ${mode} --repark-task <liveTaskDir> refuses even when --queue/--journal are safe temp dirs`, () => {
    const home = mkTmp('spo-live-guard-repark-home-');
    const { taskDir, statePath } = seedLiveShapedTaskDir(home, 'issue-6');
    const beforeMd5 = md5File(statePath);
    const safeQueue = mkTmp('spo-live-guard-safe-queue2-');
    const safeJournal = mkTmp('spo-live-guard-safe-journal2-');

    const result = runDaemonRawIn(buildEnv(home), [mode, '--repark-task', taskDir, '--queue', safeQueue, '--journal', safeJournal]);

    assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}\nstderr: ${result.stderr}`);
    assert.match(
      result.stderr,
      /refusing to run .* against the live state root/,
      `expected the refusal message on stderr, got: ${result.stderr}`
    );
    assert.equal(
      md5File(statePath),
      beforeMd5,
      "the live taskDir's state.json must be byte-identical -- never rewritten to PARKED"
    );
  });
}

for (const mode of ['--dry-run', '--shadow']) {
  test(`daemon.js ${mode} --once refuses before touching anything when HOME resolves to the live default (no --queue/--journal/SPO_STATE_DIR)`, () => {
    const home = mkTmp('spo-live-guard-home-');
    const entryPath = seedLiveShapedQueue(home);
    const journalDir = stateJournalRoot(path.join(home, '.spo-state'));

    const result = runDaemonRawIn(buildEnv(home), [mode, '--once']);

    assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}\nstderr: ${result.stderr}`);
    assert.match(
      result.stderr,
      /refusing to run .* against the live state root/,
      `expected the refusal message on stderr, got: ${result.stderr}`
    );
    assert.match(result.stderr, /SPO_STATE_DIR="\$\(mktemp -d\)"/, 'expected the safe-command example on stderr');

    // The whole point: nothing was touched. The seeded queue entry is exactly as written, and the
    // journal root -- which a real drain would have mkdirSync'd and then populated -- was never
    // even created.
    assert.equal(fs.existsSync(entryPath), true, 'the seeded queue entry must survive untouched');
    assert.equal(
      JSON.parse(fs.readFileSync(entryPath, 'utf8')).id,
      'issue-999',
      'the seeded queue entry must be byte-identical, not merely present'
    );
    assert.equal(fs.existsSync(journalDir), false, 'the journal root must never be created by a refused run');
  });
}

test('daemon.js --dry-run --once with an EXPLICIT SPO_STATE_DIR override still works (the positive case: the guard only fires on the LIVE default)', () => {
  const home = mkTmp('spo-live-guard-home-safe-');
  // Deliberately do NOT seed HOME's own .spo-state -- proves the run below resolved SPO_STATE_DIR,
  // not the (absent) live default, by construction: there is nothing at the live default to find.
  const stateDir = mkTmp('spo-live-guard-explicit-state-');

  const result = runDaemonRawIn(buildEnv(home, { stateDir }), ['--dry-run', '--once']);

  assert.equal(result.status, 0, `expected a clean exit (empty queue, nothing to drain), got ${result.status}\nstderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /refusing to run/, `must not refuse when SPO_STATE_DIR is explicit: ${result.stderr}`);
  // The run used the override, not the (unseeded, and in this case nonexistent) live default --
  // both directories now exist under the explicit root.
  assert.equal(fs.existsSync(stateQueueDir(stateDir)), true);
  assert.equal(fs.existsSync(stateJournalRoot(stateDir)), true);
});
