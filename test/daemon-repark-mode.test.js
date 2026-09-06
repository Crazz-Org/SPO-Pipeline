'use strict';
// Tests for orchestrator/daemon.js's `--repark-task <taskDir>` mode (card #78 -- see that file's
// own header comment for the exit-code contract, and state-machine.js's reparkCrashedTask for the
// park logic itself, extracted out of dispatcher.js's in-process reparkCrashedWorker so a later
// action could move the call OFF the process holding the single-instance lock without changing
// what a repark actually does).
//
// dispatcher.js NOW SPAWNS THIS EXACT MODE for every crash repark (reparkCrashedWorker,
// buildReparkArgv) -- the "this action only adds the mode, dispatcher.js still calls
// reparkCrashedTask in-process" framing this file's own header used to carry described an earlier
// action on this same card; it stopped being true once the dispatcher-side rewiring landed. These
// tests still exercise the standalone `--repark-task` child DIRECTLY (never through a dispatcher),
// the same way test/worker-mode.test.js exercises `--worker` directly -- see
// test/dispatcher.test.js's own card #78 tests for the integration the dispatcher itself now
// performs (spawning this child, the claim-file handoff, the takeNextTask/shutdown holes it closes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { writeState } = require('../orchestrator/journal');
const { acquireLock } = require('../orchestrator/lock');
const { DAEMON, mkTmp, isolatedEnv, runDaemonRaw, readState, readJournal } = require('./helpers');

// readJournal (test/helpers.js) assumes journal.jsonl already exists -- true for every task that
// has ever had ANY event appended, but not for a seedCrashedTask fixture that goes straight from
// "written to disk" to "found already terminal" without runTask ever touching it. reparkCrashedTask
// journals the terminal-state case to daemon.jsonl only (appendDaemonEvent), never to the per-task
// journal.jsonl (appendEvent) -- so "no journal.jsonl at all" is the correct, expected shape for
// those tests, not a missing-file bug to paper over.
function readJournalSafe(journalDir, id) {
  const p = path.join(journalDir, id, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return readJournal(journalDir, id);
}

// Writes <journalDir>/<id>/task.json + state.json directly -- the shape a dispatcher's own
// worker-crash handler would find on disk, without ever running a real worker to produce it.
// `kind: 'synthetic'` (never 'card') and `worktreePath: null` are load-bearing, not incidental:
// together they keep finalizePark's real-mode side effects filesystem-only for every test below
// that runs `--real` --
//   - state-machine.js's finalizePark only calls postParkComment (a `gh` call) when
//     `ctx.task.kind === 'card'` -- see finalizePark's own header.
//   - steps/scripted.js's preserveWorktreeWipUnguarded returns null immediately when
//     `!worktreePath` -- no `git` call is ever reached.
//   - park-alert.js's alertPark is a no-op unless `config.parkAlertCmd` (SPO_PARK_ALERT_CMD) is
//     set, which isolatedEnv() never sets.
// So a repark of a task built by this helper makes ZERO spawnSync calls, and the no-real-spawn
// killswitch (required above) is the backstop if a future change ever makes that stop being true.
function seedCrashedTask(journalDir, id, { state = 'IMPLEMENT', ...stateOverrides } = {}) {
  const taskDir = path.join(journalDir, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id, kind: 'synthetic', title: 'daemon-repark-mode fixture' }, null, 2)
  );
  writeState(taskDir, {
    id,
    state,
    diagnoseAttempts: 0,
    validateRejects: 0,
    ciImplementRetries: 0,
    mainMoveUsed: 0,
    prNumber: null,
    worktreePath: null,
    updatedAt: new Date().toISOString(),
    ...stateOverrides,
  });
  return taskDir;
}

function readDaemonEvents(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Same execFileSync-catch-and-normalize shape as test/helpers.js's runDaemonWorkerRun, but with
// an env-override hook -- needed by the account-pool-guard test below, which must point
// SPO_ACCOUNTS_DIR at a pool isolatedEnv() itself does not build (an EMPTY one). A `timeout` is
// not belt-and-braces here either: if guard 1 (the lock skip) or guard 3 (the account-pool skip)
// ever regressed, the child would either hang behind a lock it can never take or block on
// syncSettings/readRegistry against a broken pool -- both would otherwise hang this test with no
// failing assertion, not merely fail it. 30s is generous for a repark that makes no real spawn.
function runReparkRaw(args, envOverrides = {}) {
  try {
    const stdout = execFileSync(process.execPath, [DAEMON, ...args], {
      encoding: 'utf8',
      env: { ...isolatedEnv(), ...envOverrides },
      timeout: 30000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (err && err.signal && (err.status === null || err.status === undefined)) {
      return { status: `timed-out(${err.signal})`, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test(
  '--repark-task: a real child parks a crashed task end to end, with the exit code in the detail',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-e2e-j-');
    const queueDir = mkTmp('spo-repark-e2e-q-');
    const taskDir = seedCrashedTask(journalDir, 'repark-e2e-1', { state: 'IMPLEMENT' });

    const result = runReparkRaw([
      '--real',
      '--repark-task',
      taskDir,
      '--exit-code',
      '137',
      '--signal',
      'SIGKILL',
      '--queue',
      queueDir,
      '--journal',
      journalDir,
    ]);
    assert.equal(result.status, 0, `expected the repark child to exit 0, got ${JSON.stringify(result)}`);

    const state = readState(journalDir, 'repark-e2e-1');
    assert.equal(state.state, 'PARKED', 'state.json never reached PARKED');
    assert.equal(state.reason, 'worker-crashed', `expected reason 'worker-crashed', got ${state.reason}`);

    const events = readJournal(journalDir, 'repark-e2e-1');
    const parked = events.find((e) => e.event === 'parked');
    assert.ok(parked, "no 'parked' event was ever journalled for this task");
    assert.equal(parked.reason, 'worker-crashed');
    assert.equal(parked.detail.exitCode, 137, `expected the dead worker's exit code (137) in the park detail, got ${JSON.stringify(parked.detail)}`);
    assert.equal(parked.detail.signal, 'SIGKILL');

    assert.ok(fs.existsSync(path.join(taskDir, 'report.md')), 'finalizePark must have written report.md');
  }
);

// card #78 verification: the test above (and every other test in this file) hand-writes its own
// flags as string literals -- '--repark-task', '--exit-code', '--queue', '--journal' -- so it only
// agrees with dispatcher.js's real buildReparkArgv because two files happen to spell the same
// strings. Nothing joins the two halves: rename a flag inside buildReparkArgv and every test in
// this file keeps passing while production silently stops reparking (dispatcher.js would spawn a
// child that daemon.js's own argv parser no longer recognises as repark mode at all). This test
// closes that gap by taking buildReparkArgv's ACTUAL return value -- never retyped -- and running
// daemon.js with exactly that argv, the same way dispatcher.js's own reparkCrashedWorker does
// (`spawnReparkFn(process.execPath, argv, ...)`, see that function's own body).
test(
  "buildReparkArgv's own output, run through daemon.js verbatim, really parks the task -- pins the argv contract between dispatcher.js and daemon.js",
  { timeout: 40000 },
  () => {
    const { buildReparkArgv } = require('../orchestrator/dispatcher');
    const defaultConfig = require('../orchestrator/config');

    const journalDir = mkTmp('spo-repark-argv-j-');
    const queueDir = mkTmp('spo-repark-argv-q-');
    // Same fixture shape as the e2e test above: kind: 'synthetic', worktreePath: null, so
    // finalizePark's real-mode side effects (postParkComment's `gh` call, preserveWorktreeWip's
    // `git` call, park-alert.js's external command) all stay filesystem-only and this test makes
    // zero spawnSync calls under test/no-real-spawn.js's killswitch.
    const taskDir = seedCrashedTask(journalDir, 'repark-argv-contract-1', { state: 'IMPLEMENT' });

    const config = { ...defaultConfig, shadowMode: false, dryRun: false, real: true };
    const argv = buildReparkArgv(taskDir, queueDir, journalDir, config, { exitCode: 137, signal: 'SIGKILL' });

    // buildReparkArgv's own first element is DAEMON_PATH itself -- dispatcher.js spawns this argv
    // as `spawnReparkFn(process.execPath, argv, ...)`, i.e. argv is node's OWN argument list, not
    // a full command line. Replicated here exactly, with no re-typed flag in between.
    let result;
    try {
      const stdout = execFileSync(process.execPath, argv, {
        encoding: 'utf8',
        env: isolatedEnv(),
        timeout: 30000,
      });
      result = { status: 0, stdout, stderr: '' };
    } catch (err) {
      result = { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
    assert.equal(
      result.status,
      0,
      `expected buildReparkArgv's own argv, run verbatim through daemon.js, to exit 0 -- got ${JSON.stringify(result)}`
    );

    const state = readState(journalDir, 'repark-argv-contract-1');
    assert.equal(state.state, 'PARKED', `state.json never reached PARKED -- daemon.js did not recognise buildReparkArgv's own argv as repark mode, got state ${JSON.stringify(state)}`);
    assert.equal(state.reason, 'worker-crashed', `expected reason 'worker-crashed', got ${state.reason}`);

    const events = readJournal(journalDir, 'repark-argv-contract-1');
    const parked = events.find((e) => e.event === 'parked');
    assert.ok(parked, "no 'parked' event was ever journalled for this task");
    assert.equal(parked.reason, 'worker-crashed');
    assert.equal(parked.detail.exitCode, 137, `expected the dead worker's exit code (137), carried through buildReparkArgv's own --exit-code, in the park detail, got ${JSON.stringify(parked.detail)}`);
    assert.equal(parked.detail.signal, 'SIGKILL');
  }
);

test(
  '--repark-task does not take the single-instance lock -- the crashed task still parks while the real lock is held',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-lock-j-');
    const queueDir = mkTmp('spo-repark-lock-q-');
    const taskDir = seedCrashedTask(journalDir, 'repark-lock-1', { state: 'DIAGNOSE' });

    // The real lock, acquired exactly as the dispatcher would hold it for the whole journal root
    // -- this is the permanent regression test for guard 1 (daemon.js's `if (!workerMode &&
    // !scannerMode)` acquireLock guard): if a future edit dropped `&& !reparkMode` from it, this
    // child would hit LockHeldError against the lock acquired below and exit 1, and the park
    // would silently never happen.
    const lock = acquireLock(journalDir, 'real');
    try {
      const result = runReparkRaw([
        '--real',
        '--repark-task',
        taskDir,
        '--exit-code',
        '1',
        '--queue',
        queueDir,
        '--journal',
        journalDir,
      ]);
      assert.equal(
        result.status,
        0,
        `expected the repark child to exit 0 even with the lock held (guard 1 regressed if not), got ${JSON.stringify(result)}`
      );

      const state = readState(journalDir, 'repark-lock-1');
      assert.equal(state.state, 'PARKED', 'the crashed task did not park while the lock was held');
      assert.equal(state.reason, 'worker-crashed');
    } finally {
      lock.release();
    }
  }
);

for (const terminalState of ['DONE', 'PARKED', 'ABANDONED']) {
  test(
    `--repark-task: a task already ${terminalState} is left alone -- journals worker-exit-after-terminal, never re-parked`,
    { timeout: 40000 },
    () => {
      const journalDir = mkTmp(`spo-repark-terminal-${terminalState.toLowerCase()}-j-`);
      const queueDir = mkTmp('spo-repark-terminal-q-');
      const id = `repark-terminal-${terminalState.toLowerCase()}-1`;
      seedCrashedTask(journalDir, id, { state: terminalState, reason: terminalState === 'PARKED' ? 'pre-existing-reason' : undefined });
      const before = readState(journalDir, id);

      const result = runReparkRaw([
        '--real',
        '--repark-task',
        path.join(journalDir, id),
        '--exit-code',
        '1',
        '--queue',
        queueDir,
        '--journal',
        journalDir,
      ]);
      assert.equal(result.status, 0, `expected the repark child to exit 0, got ${JSON.stringify(result)}`);

      const after = readState(journalDir, id);
      assert.equal(after.state, terminalState, `a ${terminalState} task's state.json must not be rewritten`);
      assert.equal(
        after.updatedAt,
        before.updatedAt,
        `state.json for an already-${terminalState} task was rewritten -- reparkCrashedTask must return before touching it`
      );

      const daemonEvents = readDaemonEvents(journalDir);
      const exitAfterTerminal = daemonEvents.find((e) => e.event === 'worker-exit-after-terminal' && e.id === id);
      assert.ok(
        exitAfterTerminal,
        `expected a 'worker-exit-after-terminal' daemon.jsonl event for ${id}, got events: ${JSON.stringify(daemonEvents)}`
      );
      assert.equal(exitAfterTerminal.lastState, terminalState);

      const perTaskEvents = readJournalSafe(journalDir, id);
      assert.ok(
        !perTaskEvents.some((e) => e.event === 'parked'),
        `an already-${terminalState} task must never get a second 'parked' journal.jsonl event`
      );
    }
  );
}

test('--repark-task conflicts with --worker, exit code 2', () => {
  const queueDir = mkTmp('spo-repark-conflict-q-');
  const journalDir = mkTmp('spo-repark-conflict-j-');
  const taskDir = seedCrashedTask(journalDir, 'repark-conflict-1');
  const result = runDaemonRaw(['--shadow', '--repark-task', taskDir, '--worker', taskDir, '--queue', queueDir, '--journal', journalDir]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--repark-task and --worker are mutually exclusive/);
});

// The third exclusion. daemon.js's own header promises --repark-task is mutually exclusive with
// --once, --worker AND --scanner; only the last two were pinned, and deleting the --once branch
// left the whole file green -- a repark child would then silently ignore a --once it was handed
// rather than refuse an argv that names two different "what this process is".
test('--repark-task conflicts with --once, exit code 2', () => {
  const queueDir = mkTmp('spo-repark-conflict-q-');
  const journalDir = mkTmp('spo-repark-conflict-j-');
  const taskDir = seedCrashedTask(journalDir, 'repark-conflict-3');
  const result = runDaemonRaw(['--shadow', '--repark-task', taskDir, '--once', '--queue', queueDir, '--journal', journalDir]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--repark-task and --once are mutually exclusive/);
});

test('--repark-task conflicts with --scanner, exit code 2', () => {
  const queueDir = mkTmp('spo-repark-conflict-q-');
  const journalDir = mkTmp('spo-repark-conflict-j-');
  const taskDir = seedCrashedTask(journalDir, 'repark-conflict-2');
  const result = runDaemonRaw(['--shadow', '--repark-task', taskDir, '--scanner', '--queue', queueDir, '--journal', journalDir]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--repark-task and --scanner are mutually exclusive/);
});

test('--repark-task with no path following it exits 2', () => {
  const result = runDaemonRaw([
    '--shadow',
    '--queue',
    mkTmp('spo-repark-nopath-q-'),
    '--journal',
    mkTmp('spo-repark-nopath-j-'),
    '--repark-task',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--repark-task requires a <taskDir> path/);
});

test(
  '--repark-task with --real skips the account-pool guard entirely -- an EMPTY registry still parks (guard 3)',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-noaccounts-j-');
    const queueDir = mkTmp('spo-repark-noaccounts-q-');
    const taskDir = seedCrashedTask(journalDir, 'repark-noaccounts-1', { state: 'PLAN' });
    // A genuinely empty pool directory -- accounts.readRegistry returns [] for it. Without the
    // `opts.real && !reparkMode` guard, --real would refuse to start here with exit 1
    // ("--real requires at least one registered account"), the same refusal an ordinary
    // dispatcher/worker start would hit against this same pool.
    const emptyAccountsDir = mkTmp('spo-repark-empty-accounts-');

    const result = runReparkRaw(
      ['--real', '--repark-task', taskDir, '--exit-code', '1', '--queue', queueDir, '--journal', journalDir],
      { SPO_ACCOUNTS_DIR: emptyAccountsDir }
    );
    assert.equal(
      result.status,
      0,
      `expected the repark child to ignore the empty account pool and still exit 0 (guard 3 regressed if not), got ${JSON.stringify(result)}`
    );

    const state = readState(journalDir, 'repark-noaccounts-1');
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, 'worker-crashed');
  }
);

// ---- verification additions: the three paths mutation testing found unpinned -----------------
//
// Everything above pins the MODE (the three guards, the exit codes, the flags). These three pin
// what the mode actually WRITES, and each one was added because deleting the code it covers left
// the whole suite green:
//
//   1. dropping `ctx.task.worktreePath` / `ctx.prNumber` from reparkCrashedTask's restore block
//      (state-machine.js) -- 103/103 still passed. dispatcher.test.js's own counter test seeds
//      `prNumber: 99` but never reads it back, and no test anywhere gave a crashed task a
//      worktreePath at all.
//   2. deleting the `worker-crash-repark-failed` / step: 'task.json' journal line, leaving a bare
//      `return` -- 103/103 still passed. The only existing assertion on that event name is a
//      NEGATIVE one (dispatcher.test.js), which a silent return satisfies perfectly.
//   3. making runRepark (daemon.js) swallow its catch and return 0 -- 9/9 still passed. Nothing
//      drove reparkCrashedTask to a throw it does not itself catch.

test(
  '--repark-task restores EVERY runtime-only field off state.json -- worktreePath and prNumber included, not just the counters',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-restore-j-');
    const queueDir = mkTmp('spo-repark-restore-q-');
    // Deliberately a path that does NOT exist: steps/scripted.js's preserveWorktreeWipUnguarded
    // returns null on `!fs.existsSync(worktreePath)` before its first `git` call, so this test
    // stays real-mode (the production shape) and still makes zero spawns. It is also a real
    // shape, not a contrivance -- a worktree swept away after the crash leaves exactly this.
    const worktreePath = path.join(mkTmp('spo-repark-restore-wt-'), 'issue-999');
    const taskDir = seedCrashedTask(journalDir, 'repark-restore-1', {
      state: 'CI_CHECKS',
      worktreePath,
      prNumber: 4242,
      diagnoseAttempts: 3,
      validateRejects: 2,
      ciImplementRetries: 2,
      mainMoveUsed: 3,
    });

    const result = runReparkRaw([
      '--real', '--repark-task', taskDir, '--exit-code', '137',
      '--queue', queueDir, '--journal', journalDir,
    ]);
    assert.equal(result.status, 0, `expected the repark child to exit 0, got ${JSON.stringify(result)}`);

    const state = readState(journalDir, 'repark-restore-1');
    assert.equal(state.state, 'PARKED');
    // finalizePark rewrites state.json through snapshot(), so a field NOT restored onto the ctx is
    // not merely missing from the park report -- it is overwritten with null/0, and the parked
    // card's record then claims there was no worktree and no PR.
    assert.equal(state.worktreePath, worktreePath, 'the crashed task\'s worktreePath must survive the repark -- it is what preserveWorktreeWip needs to push stranded work to a wip/ ref, and the only pointer a maintainer has left to the tree');
    assert.equal(state.prNumber, 4242, 'the crashed task\'s prNumber must survive the repark');
    assert.equal(state.diagnoseAttempts, 3);
    assert.equal(state.validateRejects, 2);
    assert.equal(state.ciImplementRetries, 2);
    assert.strictEqual(state.mainMoveUsed, 3, 'the COUNT must survive, not collapse to true/1');
  }
);

test(
  '--repark-task: an unreadable task.json is JOURNALLED (worker-crash-repark-failed, step task.json), never a silent return',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-badtask-j-');
    const queueDir = mkTmp('spo-repark-badtask-q-');
    const id = 'repark-badtask-1';
    const taskDir = path.join(journalDir, id);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.json'), '{ this is not json');

    const result = runReparkRaw([
      '--real', '--repark-task', taskDir, '--exit-code', '75', '--signal', 'SIGTERM',
      '--queue', queueDir, '--journal', journalDir,
    ]);
    // Still 0: "the task could not be read" is a KNOWN, journalled outcome of reparkCrashedTask,
    // not a failure of this process -- see runRepark's own header in daemon.js.
    assert.equal(result.status, 0, `expected exit 0 for a journalled task.json failure, got ${JSON.stringify(result)}`);

    const events = readDaemonEvents(journalDir);
    const failed = events.find((e) => e.event === 'worker-crash-repark-failed' && e.id === id);
    assert.ok(
      failed,
      `an unreadable task.json must leave a record: this is the "a worker's crash used to leave NO record anywhere" defect daemon.js's own journalUncaught comment cites. Got: ${JSON.stringify(events)}`
    );
    assert.equal(failed.step, 'task.json', 'the step names WHICH read failed -- \'unexpected\' would be the other branch');
    assert.equal(failed.exitCode, 75, 'the dead worker\'s own exit code must reach the failure record too');
    assert.equal(failed.signal, 'SIGTERM');
    assert.equal(fs.existsSync(path.join(taskDir, 'state.json')), false, 'nothing may be parked off a task.json that never parsed');
  }
);

test(
  '--repark-task: an unexpected throw exits NON-ZERO and is journalled step: unexpected -- never swallowed as success',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-throw-j-');
    const queueDir = mkTmp('spo-repark-throw-q-');
    const id = 'repark-throw-1';
    const taskDir = seedCrashedTask(journalDir, id, { state: 'IMPLEMENT' });
    // A read-only taskDir makes finalizePark's very first statement -- appendEvent's
    // appendFileSync into <taskDir>/journal.jsonl -- throw EACCES. That is a throw
    // reparkCrashedTask does NOT catch (its own try/catch covers only the task.json read), so it
    // escapes into runRepark's catch: exactly the branch this test exists for. journalRoot itself
    // stays writable, which is what lets the failure still be recorded in daemon.jsonl.
    fs.chmodSync(taskDir, 0o555);
    let result;
    try {
      result = runReparkRaw([
        '--real', '--repark-task', taskDir, '--exit-code', '9',
        '--queue', queueDir, '--journal', journalDir,
      ]);
    } finally {
      fs.chmodSync(taskDir, 0o755); // never leave an undeletable tmpdir behind
    }
    assert.notEqual(result.status, 0, `an unexpected throw must NOT report success, got ${JSON.stringify(result)}`);
    assert.match(result.stderr, /--repark-task: unexpected error reparking/);

    const events = readDaemonEvents(journalDir);
    const failed = events.find((e) => e.event === 'worker-crash-repark-failed' && e.id === id);
    assert.ok(failed, `an unexpected throw must be journalled, got: ${JSON.stringify(events)}`);
    assert.equal(failed.step, 'unexpected', 'a bug in this process is \'unexpected\', distinct from the known \'task.json\' shape');
    assert.equal(failed.exitCode, 9);
  }
);

// ---- card #78 (dispatcher-side half): reparkCrashedTask clears its OWN repark claim -----------
//
// The dispatcher (orchestrator/dispatcher.js's reparkCrashedWorker) writes <taskDir>/
// repark-claim.json BEFORE spawning this exact `--repark-task` child, and clears it again when
// that child exits -- but that clear is a BACKSTOP, not the primary mechanism: state-machine.js's
// own reparkCrashedTask function header (not this file's) says reparkCrashedTask itself clears the
// claim as its own last statement, on every exit path, so orphan-scan.js's concurrent scan (a
// THIRD, separate process) never has to wait for the dispatcher's own watchChild.then to run.
// These three tests seed a claim BY HAND (the way the dispatcher would have, before spawning this
// exact child) and prove reparkCrashedTask clears it on each of its three distinct exit paths,
// with no dispatcher involved at all.
const { writeReparkClaim, reparkClaimPath } = require('../orchestrator/journal');

test(
  '--repark-task: reparkCrashedTask clears its own repark claim after an ORDINARY park',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-claimclear-ok-j-');
    const queueDir = mkTmp('spo-repark-claimclear-ok-q-');
    const id = 'repark-claimclear-ok-1';
    const taskDir = seedCrashedTask(journalDir, id, { state: 'IMPLEMENT' });
    writeReparkClaim(taskDir, { id, pid: process.pid, startedAt: new Date().toISOString() });
    assert.equal(fs.existsSync(reparkClaimPath(taskDir)), true, 'test setup: no claim was seeded');

    const result = runReparkRaw(['--real', '--repark-task', taskDir, '--exit-code', '1', '--queue', queueDir, '--journal', journalDir]);
    assert.equal(result.status, 0, `expected the repark child to exit 0, got ${JSON.stringify(result)}`);
    assert.equal(readState(journalDir, id).state, 'PARKED');
    assert.equal(
      fs.existsSync(reparkClaimPath(taskDir)),
      false,
      'the repark claim outlived an ORDINARY park -- a later retry of the same taskDir would read a stale claim'
    );
  }
);

test(
  '--repark-task: reparkCrashedTask clears its own repark claim even when task.json fails to read',
  { timeout: 40000 },
  () => {
    const journalDir = mkTmp('spo-repark-claimclear-badtask-j-');
    const queueDir = mkTmp('spo-repark-claimclear-badtask-q-');
    const id = 'repark-claimclear-badtask-1';
    const taskDir = path.join(journalDir, id);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.json'), '{ this is not json');
    writeReparkClaim(taskDir, { id, pid: process.pid, startedAt: new Date().toISOString() });

    const result = runReparkRaw(['--real', '--repark-task', taskDir, '--exit-code', '1', '--queue', queueDir, '--journal', journalDir]);
    assert.equal(result.status, 0, `expected exit 0 for a journalled task.json failure, got ${JSON.stringify(result)}`);
    assert.equal(
      readDaemonEvents(journalDir).some((e) => e.event === 'worker-crash-repark-failed' && e.id === id),
      true
    );
    assert.equal(
      fs.existsSync(reparkClaimPath(taskDir)),
      false,
      'the repark claim outlived a task.json read failure -- reparkCrashedTask\'s early return did not clear it'
    );
  }
);

for (const terminalState of ['DONE', 'PARKED', 'ABANDONED']) {
  test(
    `--repark-task: reparkCrashedTask clears its own repark claim on the already-${terminalState} short-circuit`,
    { timeout: 40000 },
    () => {
      const journalDir = mkTmp(`spo-repark-claimclear-terminal-${terminalState.toLowerCase()}-j-`);
      const queueDir = mkTmp('spo-repark-claimclear-terminal-q-');
      const id = `repark-claimclear-terminal-${terminalState.toLowerCase()}-1`;
      const taskDir = seedCrashedTask(journalDir, id, { state: terminalState });
      writeReparkClaim(taskDir, { id, pid: process.pid, startedAt: new Date().toISOString() });

      const result = runReparkRaw(['--real', '--repark-task', taskDir, '--exit-code', '1', '--queue', queueDir, '--journal', journalDir]);
      assert.equal(result.status, 0, `expected exit 0, got ${JSON.stringify(result)}`);
      assert.equal(
        readDaemonEvents(journalDir).some((e) => e.event === 'worker-exit-after-terminal' && e.id === id),
        true
      );
      assert.equal(
        fs.existsSync(reparkClaimPath(taskDir)),
        false,
        `the repark claim outlived an already-${terminalState} short-circuit -- a claim left on a terminal task is never cleaned by orphan-scan.js (it skips terminal tasks before ever looking at the claim) and would linger into a later retry of the same taskDir`
      );
    }
  );
}
