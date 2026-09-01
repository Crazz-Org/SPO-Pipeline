'use strict';
// Tests for orchestrator/daemon.js's `--worker <taskDir>` mode (action 6.1's dispatcher-less
// half -- see the file's own header comment for the exit-code contract and CLAUDE.md's C6
// handoff for why the dispatcher itself, the live-worker table, and the crash-repark/circuit-
// breaker machinery are NOT here: they are action 6.3, built against a dispatcher this action
// deliberately does not create). A worker reads <taskDir>/task.json directly -- the dispatcher's
// job (takeNextTask) is to have already moved it there -- so every fixture here builds that
// layout by hand instead of going through queue/ the way runDaemonOnce's tests do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { lockPath } = require('../orchestrator/lock');
const { DAEMON, mkTmp, runDaemonWorker, runDaemonRaw, readState } = require('./helpers');

// Writes <journalDir>/<id>/task.json directly -- the shape a dispatcher's takeNextTask would
// have left behind, without a queue/ entry ever existing (worker mode never reads the queue).
function seedWorkerTask(journalDir, id, taskObj) {
  const taskDir = path.join(journalDir, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(taskObj, null, 2));
  return taskDir;
}

test('--worker: a task that reaches DONE exits 0 and state.json is DONE', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'worker-done-1', {
    id: 'worker-done-1',
    title: 'a task that just finishes',
    kind: 'synthetic',
    shadow: { forceState: 'DONE' },
  });

  const result = runDaemonWorker(taskDir, journalDir);
  assert.equal(result.status, 0, result.stderr);

  const state = readState(journalDir, 'worker-done-1');
  assert.equal(state.state, 'DONE');
});

test('--worker: a task that parks exits 20 (not 0, not 1) and state.json is PARKED', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'worker-park-1', {
    id: 'worker-park-1',
    title: 'fixture injects a bogus state, same as deadline-and-catchall.test.js',
    kind: 'synthetic',
    shadow: { forceState: 'NONSENSE_STATE' },
  });

  const result = runDaemonWorker(taskDir, journalDir);
  assert.equal(result.status, 20, result.stderr);

  const state = readState(journalDir, 'worker-park-1');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'unrecognized-state');
});

test('--worker with no path following it exits 2', () => {
  // Deliberately raw: runDaemonWorker always supplies a taskDir, so the "flag given but no
  // value" case (--worker as the very last argv token) needs the full-argv escape hatch.
  //
  // --queue/--journal go BEFORE --worker so the flag still ends the argv, and they are NOT
  // decoration: isolatedEnv() only overrides the product repo, worktrees dir, account pool and
  // bench -- the queue and journal roots are argv-only, so a run without them defaults to the
  // REPO's own queue/ and journal/. That is harmless while the guard under test holds (it
  // returns before main() ever mkdirs them), but the whole point of this test is the case where
  // the guard does NOT hold: a mutant that falls through here boots a full polling daemon and
  // takes <repo>/journal/daemon.lock -- which, when the suite runs from the maintainer's own
  // checkout, is the LIVE daemon's lock. Observed exactly that on 2026-09-01 while mutating
  // `workerMode`. Temp dirs cost nothing and make the failing case merely a failing test.
  const result = runDaemonRaw(['--shadow', '--queue', mkTmp('spo-worker-q-'), '--journal', mkTmp('spo-worker-j-'), '--worker']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--worker requires a <taskDir> path/);
});

test('--worker with an EMPTY path exits 2 (the falsy-but-not-null sentinel, not a silent full daemon)', () => {
  // parseArgs defaults `worker` to null and main() reads `opts.worker !== null` for "worker mode
  // was asked for at all", then `!opts.worker` for "...but with no usable path". Collapsing those
  // two into one falsy test (`workerMode = !!opts.worker`) is the mutation that matters here:
  // `--worker ''` and `--worker` <end of argv> would both stop being worker mode at all and fall
  // straight through to runForever, and this process would poll forever instead of refusing.
  // The sibling test above covers the `undefined` half; this one covers the `''` half, which is
  // what a dispatcher shell-interpolating an unset variable actually produces.
  const result = runDaemonRaw(['--shadow', '--queue', mkTmp('spo-worker-q-'), '--journal', mkTmp('spo-worker-j-'), '--worker', '']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--worker requires a <taskDir> path/);
});

test('--worker pointed at a taskDir that does not exist exits 2', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const missingDir = path.join(journalDir, 'does-not-exist');

  const result = runDaemonWorker(missingDir, journalDir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot read/);
});

test('--worker pointed at a taskDir whose task.json is unparsable JSON exits 2', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = path.join(journalDir, 'worker-bad-json');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), '{ not valid json');

  const result = runDaemonWorker(taskDir, journalDir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot parse/);
});

test('--worker and --once together are refused with exit 2', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'worker-once-conflict', {
    id: 'worker-once-conflict',
    kind: 'synthetic',
    shadow: { forceState: 'DONE' },
  });

  const result = runDaemonWorker(taskDir, journalDir, ['--once']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--worker and --once are mutually exclusive/);

  // Refused before anything ran -- task.json is still sitting untouched, no state.json written.
  assert.equal(fs.existsSync(path.join(taskDir, 'state.json')), false);
});

test('--worker: state.json.owner carries {workerPid, workerStartedAt}, never lockStartedAt', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'worker-owner-shape', {
    id: 'worker-owner-shape',
    kind: 'synthetic',
    shadow: { forceState: 'DONE' },
  });

  const before = new Date();
  const result = runDaemonWorker(taskDir, journalDir);
  assert.equal(result.status, 0, result.stderr);
  const after = new Date();

  const state = readState(journalDir, 'worker-owner-shape');
  const owner = state.owner;
  assert.equal(typeof owner.workerPid, 'number');
  // The worker process is a short-lived child of THIS test process -- its pid is never equal to
  // ours, and (barring the pid-reuse race every liveness check in this suite already accepts)
  // never equal to the process.pid this same test run happens to have.
  assert.notEqual(owner.workerPid, process.pid);

  const startedAt = new Date(owner.workerStartedAt);
  assert.ok(!Number.isNaN(startedAt.getTime()), `workerStartedAt not parseable ISO: ${owner.workerStartedAt}`);
  // Sanity window rather than exact equality -- the worker stamps its own clock, not ours.
  assert.ok(startedAt.getTime() >= before.getTime() - 5000);
  assert.ok(startedAt.getTime() <= after.getTime() + 5000);

  assert.equal('lockStartedAt' in owner, false, 'worker-mode owner must not carry the lock-holder field');
  assert.equal('pid' in owner, false, 'worker-mode owner must use workerPid, not the daemon-lock pid field');

  // orphan-scan.js's very first test on an owner is `if (owner.host !== os.hostname()) continue`
  // -- "cannot probe a remote host's pid". A worker that stamped anything other than this
  // machine's hostname would therefore make every task it died mid-run permanently invisible to
  // the scan: not queued, not terminal, and skipped as remote on every future pass. That is the
  // exact "invisible forever" outcome the owner-shape comment in daemon.js warns about, so it is
  // pinned here rather than left to the non-worker shape's coverage (which borrows the host from
  // lock.js's payload and so never exercises this line).
  assert.equal(owner.host, require('os').hostname());
});

// ---- id derivation: task.id when present, basename(taskDir) otherwise -------------------------
// runWorker mirrors takeNextTask's rule. Every other fixture in this file happens to use a
// task.id EQUAL to the directory's basename, which makes both branches return the same string --
// so `const id = path.basename(taskDir)` and `const id = String(task.id)` both survived the whole
// suite unchanged (measured 2026-09-01). These two pin the branches apart by making the two
// values differ.

test('--worker: task.json with an id DIFFERENT from the directory name uses task.id', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'dir-name-is-not-the-id', {
    id: 'issue-4242',
    kind: 'synthetic',
    shadow: { forceState: 'DONE' },
  });

  const result = runDaemonWorker(taskDir, journalDir);
  assert.equal(result.status, 0, result.stderr);

  // state.json lands in taskDir either way (runTask is handed the directory), so the id is
  // observable only through the snapshot's own `id` field -- which is what `spo parked`, the
  // ledger, the park comment and every board move downstream of it read.
  const state = readState(journalDir, 'dir-name-is-not-the-id');
  assert.equal(state.state, 'DONE');
  assert.equal(state.id, 'issue-4242', 'a task.json id must win over the directory basename');
});

test('--worker: task.json with NO id falls back to basename(taskDir)', () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'issue-7  1', {
    kind: 'synthetic', // deliberately no `id`
    shadow: { forceState: 'DONE' },
  });

  const result = runDaemonWorker(taskDir, journalDir);
  assert.equal(result.status, 0, result.stderr);

  const state = readState(journalDir, 'issue-7  1');
  assert.equal(state.state, 'DONE');
  assert.equal(state.id, 'issue-7  1', 'no task.id means the directory basename is the id');
});

test('--worker: a trailing-slash taskDir still derives the directory name, not an empty id', () => {
  // path.basename('/a/b/') is 'b' but path.basename('/a/b/.') is '.', and a dispatcher building
  // its argv by string concatenation produces trailing slashes routinely. This is what
  // path.resolve(taskDirArg) is for -- without it `path.basename` sees whatever the caller typed.
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'trailing-slash-id', {
    kind: 'synthetic', // no `id` -- forces the basename branch
    shadow: { forceState: 'DONE' },
  });

  const result = runDaemonWorker(taskDir + path.sep + '.', journalDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readState(journalDir, 'trailing-slash-id').id, 'trailing-slash-id');
});

// ---- config.queueDir reaches worker mode -----------------------------------------------------
test('daemon.js sets config.queueDir for BOTH modes -- action 4.4 auto-retry is dead in workers without it', () => {
  // Standing source guard, same shape as this suite's signal-ordering guard in lock.test.js and
  // test/gh-api-argv.test.js: the property is real and load-bearing but not observable from a
  // hermetic shadow-mode run, because finalizePark's transient auto-retry is `isRealMode` only.
  //
  // What it protects, measured rather than argued (2026-09-01): instrumenting runWorker to call
  // finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', {exit:4}) with the config main() actually
  // builds, a `--shadow --worker` run printed
  //   PROBE queueDir=<tmp>/q2 exists=true
  //   PROBE queue before=[] after=["0000-retry-1788274127884-probe-task.json"]
  // i.e. the retry entry IS written. Drop `queueDir` from that config literal and finalizePark's
  // own `typeof queueDir === 'string'` guard silently declines the retry and parks instead -- and
  // the worker still exits 20 either way, so nothing downstream can tell the difference. Removing
  // the line survived the entire 1194-test suite unchanged before this guard existed.
  const source = fs.readFileSync(DAEMON, 'utf8');
  const configAt = source.indexOf('const config = {');
  assert.notEqual(configAt, -1, "main()'s config literal is no longer recognisable -- update this guard");
  const configLiteral = source.slice(configAt, source.indexOf('\n  };', configAt));
  assert.match(
    configLiteral,
    /^\s*queueDir,\s*$/m,
    "main()'s config must carry queueDir for BOTH modes: worker mode never goes through drainQueueOnce, which is the only other place it was ever injected, so without it action 4.4's transient auto-retry silently stops re-enqueueing under workers"
  );
});
