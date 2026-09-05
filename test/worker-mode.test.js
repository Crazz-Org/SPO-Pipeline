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
  // builds, a `--shadow --worker` run printed (filename shown pre-#43 and pre the maintainer-
  // priority fix found in review of #43, no card number of its own; a re-run against today's code
  // prints '0000-retry-t-00000000000000000001-probe-task.json' instead -- the `attempt`-keyed,
  // zero-padded, priority-classed name, not a `Date.now()` timestamp -- verified by running the
  // same finalizePark call through buildCtx directly, not re-derived by eye):
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

test("daemon.js re-derives WORKTREE/FINISH step deadlines from the EFFECTIVE K -- a --workers override must move them, or the deadline can fire on a legitimate lock wait", () => {
  // Standing source guard, same shape and for the same reason as the queueDir guard directly
  // above: the property is real and load-bearing but not observable from a hermetic run, because
  // daemon.js runs main() unconditionally (no require.main guard) and so cannot be required.
  //
  // What it protects, measured during 6.4's verification: config.js derives
  // stepDeadlineMsByState.WORKTREE/FINISH from the ENV-time K (SPO_WORKERS, default 1). `--workers`
  // changes K for THIS process only, and both entries are functions of K. Leave them at the K=1
  // value and, at K=2, WORKTREE's ceiling (118 min) is SHORTER than the wait plus work a worker can
  // legitimately perform (232 min) -- so the deadline fires mid-wait, and because deadline.js's
  // withTimeout ABANDONS the loser rather than cancelling it, TWO realWorktree invocations then run
  // fetch / the leftover sweep / `git worktree add` against the SHARED product-repo clone for a task
  // that has already parked. Removing this recompute passed the entire 1301-test suite.
  const source = fs.readFileSync(DAEMON, 'utf8');
  const configAt = source.indexOf('const config = {');
  assert.notEqual(configAt, -1, "main()'s config literal is no longer recognisable -- update this guard");
  const configLiteral = source.slice(configAt, source.indexOf('\n  };', configAt));

  assert.match(
    configLiteral,
    /stepDeadlineMsByState:\s*\{/,
    "main()'s config must re-derive stepDeadlineMsByState: config.js built it from the env-time K, and --workers changes K for this process"
  );
  // WORKTREE acquires the product-repo lock once (setup phase), so lockedStepDeadlineMs's
  // single-wait-plus-single-hold shape still fits it.
  assert.match(
    configLiteral,
    /WORKTREE: productRepoHold\.lockedStepDeadlineMs\(/,
    "WORKTREE's deadline must be recomputed through product-repo-hold.js's own lockedStepDeadlineMs, never restated as a literal here"
  );
  // Action B1.4: FINISH now acquires the lock TWICE (finish-sync, then finish), so it needs
  // product-repo-hold.js's own finishStepDeadlineMs -- the SAME formula config.js itself calls
  // (config.js:352) -- not lockedStepDeadlineMs, which only accounts for one acquisition.
  assert.match(
    configLiteral,
    /FINISH: productRepoHold\.finishStepDeadlineMs\(/,
    "FINISH's deadline must be recomputed through product-repo-hold.js's own finishStepDeadlineMs (it acquires the product-repo lock twice), never lockedStepDeadlineMs and never restated as a literal here"
  );
  // And from the EFFECTIVE K (the --workers-aware value), not defaultConfig.workers.
  const byState = configLiteral.slice(configLiteral.indexOf('stepDeadlineMsByState:'));
  assert.match(byState, /effectiveWorkers/, 'the recompute must use the --workers-aware K, not config.js\'s env-time default');
});

test("daemon.js's re-derived stepDeadlineMsByState entries produce THE SAME NUMBERS config.js derives at the default worker count -- a source-shape guard alone cannot tell a real derivation from a literal that happens to look like one", () => {
  // Defect class this closes: B1.4's D1 -- config.js grew a new, correctly-derived FINISH
  // deadline (finishStepDeadlineMs, accounting for FINISH's second lock acquisition), but
  // daemon.js's main() unconditionally overwrites config.defaultConfig.stepDeadlineMsByState
  // with its OWN literal, which had not been updated to match and kept calling the pre-B1.4
  // formula -- silently discarding config.js's derivation on every real daemon run. The regex
  // guard above catches "calls the wrong function BY NAME", which is necessary but not
  // sufficient: it would not catch daemon.js calling the right-looking function with stale
  // constants, a swapped argument order, or any other value-level drift. This test actually
  // EVALUATES daemon.js's stepDeadlineMsByState object literal (via vm, with the real
  // product-repo-hold.js and config.js bound in, at effectiveWorkers === defaultConfig.workers
  // -- the case where daemon.js's recompute and config.js's own values MUST agree exactly) and
  // diffs every entry against config.js's own defaultConfig.stepDeadlineMsByState. Any state
  // whose daemon.js recompute is ever again replaced by a stale/literal/mis-derived value fails
  // here even if it still happens to call *some* productRepoHold function.
  const vm = require('vm');
  const productRepoHold = require('../orchestrator/product-repo-hold');
  const defaultConfig = require('../orchestrator/config');

  const source = fs.readFileSync(DAEMON, 'utf8');
  const configAt = source.indexOf('const config = {');
  assert.notEqual(configAt, -1, "main()'s config literal is no longer recognisable -- update this guard");
  const configLiteral = source.slice(configAt, source.indexOf('\n  };', configAt));

  const byStateKey = 'stepDeadlineMsByState: {';
  const byStateStart = configLiteral.indexOf(byStateKey);
  assert.notEqual(byStateStart, -1, "main()'s config no longer has a stepDeadlineMsByState block -- update this guard");
  // Depth-count braces from the opening one to find the matching close -- the block's own
  // entries contain only parens, no nested braces, so a plain counter is sufficient.
  const openAt = byStateStart + byStateKey.length - 1;
  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < configLiteral.length; i++) {
    if (configLiteral[i] === '{') depth++;
    else if (configLiteral[i] === '}') {
      depth--;
      if (depth === 0) {
        closeAt = i;
        break;
      }
    }
  }
  assert.notEqual(closeAt, -1, 'could not find the closing brace of stepDeadlineMsByState -- update this guard');
  const byStateLiteral = configLiteral.slice(openAt, closeAt + 1);

  // effectiveWorkers === defaultConfig.workers here on purpose: that is the no-'--workers'-flag
  // case, where daemon.js's recompute and config.js's own derivation MUST land on the same
  // number. (A '--workers' override deliberately moves them apart -- that is action 6.4's whole
  // point, and not what this test is checking.)
  const sandbox = { productRepoHold, defaultConfig, effectiveWorkers: defaultConfig.workers };
  vm.createContext(sandbox);
  let actual;
  try {
    actual = vm.runInContext(`(${byStateLiteral})`, sandbox);
  } catch (err) {
    assert.fail(`could not evaluate daemon.js's stepDeadlineMsByState literal -- update this guard: ${err.message}`);
  }

  for (const state of Object.keys(defaultConfig.stepDeadlineMsByState)) {
    assert.equal(
      actual[state],
      defaultConfig.stepDeadlineMsByState[state],
      `daemon.js's recomputed ${state} deadline (${actual[state]}) must equal config.js's own derivation ` +
        `(${defaultConfig.stepDeadlineMsByState[state]}) at the default worker count -- a mismatch means ` +
        `daemon.js's recompute silently drifted from (or was overwritten by a literal in place of) config.js's derivation`
    );
  }
});

// ---- CROSS-ACTION defect: a worker's crash left NO record anywhere ---------------------------
//
// dispatcher.js spawns workers with `stdio: 'ignore'`, so a worker's stderr is DISCARDED by the
// kernel, not merely unread. runTask rethrows non-ParkSignal errors, daemon.js's main().catch
// printed them with console.error and exited 1, and the dispatcher recorded only `{code: 1}`.
// Measured before the fix: a worker whose runTask threw a real TypeError exited 1 and left
// daemon.jsonl completely EMPTY. The crash-circuit-breaker could therefore trip and stop the
// daemon with nothing, anywhere, saying what threw.
//
// Forces a genuine uncaught throw through daemon.js's REAL path (runWorker -> main -> the
// catch-all) with a --require preload, rather than asserting on a hand-called helper: the whole
// defect was about which process writes where, so nothing short of a real child proves it.
function runCrashingWorker(journalDir, taskDir, throwSource) {
  const { execFileSync } = require('child_process');
  const preload = path.join(mkTmp('spo-worker-preload-'), 'boom.js');
  const smPath = path.join(__dirname, '..', 'orchestrator', 'state-machine.js');
  fs.writeFileSync(
    preload,
    `const sm = require(${JSON.stringify(smPath)});\nsm.runTask = async () => { throw ${throwSource}; };\n`
  );
  const queueDir = mkTmp('spo-worker-unused-queue-');
  const args = [DAEMON, '--shadow', '--worker', taskDir, '--queue', queueDir, '--journal', journalDir];
  try {
    execFileSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 60000,
      // stdio 'ignore' for stderr reproduces EXACTLY what the dispatcher does to a worker: if the
      // fix only worked because execFileSync happened to capture stderr, this test would be
      // proving the opposite of what it claims.
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, SPO_ACCOUNTS_DIR: mkTmp('spo-worker-accts-'), NODE_OPTIONS: `--require ${preload}` },
    });
    return 0;
  } catch (err) {
    return err.status;
  }
}

function readDaemonJsonl(journalDir) {
  return fs
    .readFileSync(path.join(journalDir, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('--worker: an uncaught state-machine error is journalled with its stack, not lost to a discarded stderr', { timeout: 60000 }, () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'worker-crash-1', { id: 'worker-crash-1', kind: 'synthetic' });

  const status = runCrashingWorker(journalDir, taskDir, `new TypeError("boom reading 'prNumber'")`);
  assert.equal(status, 1, 'an uncaught error is still exit 1 -- the contract must not change');

  const evt = readDaemonJsonl(journalDir).find((e) => e.event === 'uncaught-error');
  assert.ok(evt, 'the crash left no record at all -- the circuit breaker can trip with nothing saying why');
  assert.equal(evt.mode, 'worker');
  assert.equal(evt.id, 'worker-crash-1');
  assert.equal(evt.name, 'TypeError');
  assert.match(evt.message, /boom reading 'prNumber'/);
  assert.match(evt.stack, /TypeError: boom reading 'prNumber'/);
  assert.match(evt.stack, /daemon\.js/, 'a stack with no frames is not a stack');
  assert.equal(evt.messageTruncated, false);
});

// An error message here is NOT small by nature: steps/llm.js JSON.parses up to 64 MiB of `claude`
// stdout, and a SyntaxError from that parse embeds a slice of the input in its own message.
// Writing it verbatim would put megabytes into daemon.jsonl on every crash -- the unbounded
// spool this fix exists to avoid.
test('--worker: a huge crash message is capped and marked truncated, never spooled whole into daemon.jsonl', { timeout: 60000 }, () => {
  const journalDir = mkTmp('spo-worker-journal-');
  const taskDir = seedWorkerTask(journalDir, 'worker-crash-2', { id: 'worker-crash-2', kind: 'synthetic' });

  // 5 MiB, the shape a JSON.parse failure over a large `claude` stdout really produces.
  const status = runCrashingWorker(journalDir, taskDir, `new SyntaxError("x".repeat(5 * 1024 * 1024))`);
  assert.equal(status, 1);

  const evt = readDaemonJsonl(journalDir).find((e) => e.event === 'uncaught-error');
  assert.ok(evt);
  assert.equal(evt.messageTruncated, true, 'a truncated message must SAY it was truncated, not read as if it were whole');
  assert.ok(evt.message.length <= 2000, `message not capped: ${evt.message.length} chars`);
  assert.ok(evt.stack.length <= 4000, `stack not capped: ${evt.stack.length} chars`);

  // The whole point of the cap: the journal line stays readable rather than becoming the 5 MiB
  // blob it is reporting on.
  const bytes = fs.statSync(path.join(journalDir, 'daemon.jsonl')).size;
  assert.ok(bytes < 32 * 1024, `daemon.jsonl grew to ${bytes} bytes -- the cap is not holding`);
});
