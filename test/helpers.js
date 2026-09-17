'use strict';
// Shared helpers for the orchestrator test suite. Every test runs the real daemon.js / bin/spo
// as child processes against fs.mkdtempSync(os.tmpdir()) queue/journal directories -- never
// against the repo's own queue/ or journal/, and never touching the product repo or the bench.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

const REPO_ROOT = path.join(__dirname, '..');
const DAEMON = path.join(REPO_ROOT, 'orchestrator', 'daemon.js');
const SPO_BIN = path.join(REPO_ROOT, 'bin', 'spo');

// gitEnv() -- process.env with every GIT_* variable REMOVED, for any test that spawns a real
// `git`. Not hygiene: without it a test that runs git in a temp directory corrupts THIS repository,
// and it did.
//
// Git exports GIT_DIR (and GIT_INDEX_FILE, GIT_WORK_TREE, ...) to the hooks it runs. This repo
// installs a pre-push hook that runs scripts/gate.sh, i.e. the whole suite. So inside a `git push`,
// `execFileSync('git', ['init', ...], {cwd: someTmpDir})` does NOT initialise someTmpDir -- it acts
// on the INHERITED GIT_DIR. Measured, on 2026-09-05, from test/pipeline-version.test.js's own
// throwaway repos: three empty `one` commits were written onto the branch being pushed (and reached
// main through a PR), `git checkout --detach` detached two live worktrees, `git symbolic-ref
// refs/heads/main refs/heads/other` left the real `refs/heads/main` a DANGLING SYMREF, and a stray
// `side` branch, `v1` tag and worktree were created in the real repository.
//
// The tell is that the suite is green under `node --test` and red under `git push`, because only
// the second one has GIT_* in the environment. test/no-git-env-sweep.test.js is the standing guard
// that every call site uses this.
function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

function mkTmp(prefix) {
  return registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); // swept at exit -- see registerTempDir
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

// fakeSpawnedChild(lines, opts) -- card #239 chantier, action A5b. This suite's migration seam
// for the transport cutover: a duck-typed, in-memory stand-in for the real ChildProcess
// orchestrator/steps/sdk-call.js's spawnClaudeCodeProcess hook returns, injected via `deps.spawn`
// (makeSpawnClaudeCodeProcess reads it, same injection convention this file's own timeoutResult()
// already documents -- "share, don't duplicate"). Plays the same role `deps.spawnSync`'s fake
// result object played for the old transport, one layer lower: a test using this never touches a
// real `claude` process OR even a real spawned `node` subprocess -- the SDK's own real `query()`
// call runs for real and parses real stream-json off this object's `.stdout`, but the "process" it
// is reading from is pure JS, so every test using this is as fast as a unit test, not a subprocess
// integration test. MEASURED (this action, throwaway probe against the real vendored SDK, deleted
// after use, not committed): a real `query()` call consumes messages off this shape identically to
// a real spawned process -- init/result messages round-trip, and `.kill()`/`.exitCode`/
// `.signalCode` drive the SAME escalation path a real child would (see sdk-call.js's own header on
// SDK_ABORT_KILL_DELAY_MS/SDK_ABORT_SIGKILL_ESCALATION_MS for what that escalation actually does).
//
// `lines` -- plain JS objects, written as one stream-json line each to `.stdout` the moment
// anything is written to `.stdin` (mirrors a real `claude` reading the whole prompt, then
// replying) -- pass `[]` for a child that never replies (deadline/hang tests).
// `opts.exitCode`/`opts.exitSignal` -- what `.exitCode`/`.signalCode` settle to once `lines` have
// been written (default: exit 0, no signal). Pass `opts.hang: true` to suppress this entirely --
// the child never exits on its own no matter what it was told to say.
// `opts.ignoreSignal` -- true makes `.kill()` a no-op that does NOT schedule an exit -- the
// fake "traps and ignores" every signal, the exact shape llm.js's own header measures the SDK's
// kill escalation against (a SIGTERM-ignoring child). The test itself decides when/whether the
// fake ever exits by calling `.forceExit(code, signal)` directly (exposed on the returned object)
// -- e.g. to simulate an EXTERNAL kill succeeding where the first SIGTERM/SIGKILL from the SDK's
// own escalation would not, or to simulate a child that exits on its own after some delay despite
// having ignored an earlier signal.
function fakeSpawnedChild(lines, opts = {}) {
  const emitter = new EventEmitter();
  let respondedOnce = false;
  let exited = false;
  let killedFlag = false;
  let exitCodeVal = null;
  let signalCodeVal = null;

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  stderr.push(null);

  // Keepalive, REF'd on purpose (never `.unref()`d) -- MEASURED (this action): the vendored SDK's
  // own internal kill-escalation timer (ProcessTransport.close(), see sdk-call.js's own header on
  // SDK_ABORT_KILL_DELAY_MS/SDK_ABORT_SIGKILL_ESCALATION_MS) is ITSELF unref'd in the vendored
  // source -- fine in production, where the real child's own OS-level stdio pipes are ref'd handles
  // that keep the event loop alive regardless, but this fake has no such handle (a plain
  // stream.Readable/Writable is pure JS, backed by no libuv handle at all). Without something
  // else ref'd, Node considers the event loop "resolved" and the process idle the instant this
  // fake's OWN synchronous work is done -- reproduced as a genuine hang (not a slow test) in this
  // file's own migrated test suite before this fix: `invokeClaudeReal`'s deadline path would call
  // `abort()`, and the vendored SDK's own unref'd escalation timer would simply never get a chance
  // to fire. This interval does nothing but keep the loop alive for as long as this fake child
  // hasn't exited -- cleared the moment it does, in forceExit below, so it can never outlive the
  // fake or leak into a later, unrelated test.
  // `opts.signal` (an AbortSignal) -- MEASURED (this action, against a REAL child_process.spawn):
  // Node's own `{signal}` spawn option does TWO things when that signal aborts, not one: it calls
  // `child.kill()` (default SIGTERM) AND emits an `'error'` event on the child with an
  // `AbortError` -- observed firing near-instantly, well before the process itself has actually
  // exited. This is what made this repo's OWN live probe (a real, SIGTERM-ignoring `claude`
  // fixture) see the async iterator throw at ~800ms rather than waiting for the SDK's own
  // 2000ms-later escalation -- the transport's `process.on('error', ...)` handler checks
  // `abortController.signal.aborted` and short-circuits to "aborted by user" the moment that fires.
  // A fake with no real OS process behind it has no such native integration -- reproduced as a
  // genuine hang (the async iterator never threw, even 14s past a SIGTERM-ignoring fake's own
  // `.kill()`) before this fix. `sdk-call.js`'s spawnClaudeCodeProcess passes `spawnArgs.signal`
  // straight through to a real `child_process.spawn(...,{signal})` in production, so this fake
  // reproduces exactly that option, not a new one this file invents.
  if (opts.signal) {
    const onAbort = () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      emitter.emit('error', err);
      // Real Node also calls .kill() -- routed through THIS fake's own kill() so
      // opts.ignoreSignal still governs whether the process ITSELF ever actually dies from it,
      // matching a real SIGTERM-ignoring child (which also receives the signal, and also does not
      // exit from it).
      emitter.kill();
    };
    // Always async (never a synchronous call from inside this constructor) -- matching a real
    // event listener's own timing, and sidestepping the construction-order hazard of calling
    // `emitter.kill()` before Object.defineProperties (below) has defined it.
    if (opts.signal.aborted) process.nextTick(onAbort);
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const keepalive = setInterval(() => {}, 1000);
  // Safety net, not itself load-bearing for correctness: if NOTHING ever calls forceExit (a test
  // deliberately simulating a child that ignores every signal and is never confirmed dead, e.g.
  // this file's "grace window expires" test), `keepalive` would otherwise run forever and hang
  // the whole test FILE process after that one test finishes. 20s is comfortably past
  // sdk-call.js's own ABORT_CONFIRM_GRACE_MS (~8.5s, the longest any real wait in this suite
  // should take), so it never fires before a legitimately-finishing test's own assertions have
  // already run -- it only guards against a fake nobody ever tears down. Unref'd: it does not
  // itself need to keep anything alive, only to eventually clear what does.
  const safetyNet = setTimeout(() => clearInterval(keepalive), 20000);
  if (typeof safetyNet.unref === 'function') safetyNet.unref();

  function forceExit(code, signal) {
    if (exited) return;
    exited = true;
    exitCodeVal = code === undefined ? null : code;
    signalCodeVal = signal === undefined ? null : signal;
    clearInterval(keepalive);
    stdout.push(null);
    process.nextTick(() => emitter.emit('exit', exitCodeVal, signalCodeVal));
  }

  const stdin = new Writable({
    write(chunk, encoding, callback) {
      callback();
      // Every chunk is forwarded to onStdinWrite, not only the first -- MEASURED (this action): a
      // large prompt (the 200KB-over-MAX_ARG_STRLEN regression test) arrives across MULTIPLE
      // separate `.write()` calls, not one, so capturing only the first chunk silently truncated
      // it. The "respond after the prompt arrives" logic below still fires only once
      // (respondedOnce), matching a real `claude` reading the whole prompt before replying.
      if (typeof opts.onStdinWrite === 'function') opts.onStdinWrite(chunk.toString('utf8'));
      if (respondedOnce) return;
      respondedOnce = true;
      process.nextTick(() => {
        for (const line of lines) {
          stdout.push((typeof line === 'string' ? line : JSON.stringify(line)) + '\n');
        }
        if (!opts.hang) {
          forceExit(opts.exitCode === undefined ? 0 : opts.exitCode, opts.exitSignal === undefined ? null : opts.exitSignal);
        }
      });
    },
  });

  // Object.assign, NOT used here: it would invoke each `get killed()`/`get exitCode()`/
  // `get signalCode()` accessor exactly ONCE, at this construction moment (before anything has
  // happened), and copy the resulting SNAPSHOT VALUE onto `emitter` as a plain, frozen data
  // property -- a real bug this helper shipped with and caught the hard way: `.exitCode` read
  // back `null` forever even after `forceExit` had already set the real value, because
  // Object.assign does not preserve accessor descriptors, only their current value. The vendored
  // SDK reads `.exitCode`/`.signalCode`/`.killed` AFTER the 'exit' event fires (its own close()/
  // getProcessExitError logic), so a frozen snapshot silently broke every consumer of this fake
  // that isn't the very first (never-changing) read. Object.defineProperties keeps these as LIVE
  // accessors on the returned object instead.
  Object.defineProperties(emitter, {
    stdin: { value: stdin, enumerable: true },
    stdout: { value: stdout, enumerable: true },
    stderr: { value: stderr, enumerable: true },
    forceExit: { value: forceExit, enumerable: true },
    killed: {
      enumerable: true,
      get() {
        return killedFlag;
      },
    },
    exitCode: {
      enumerable: true,
      get() {
        return exitCodeVal;
      },
    },
    signalCode: {
      enumerable: true,
      get() {
        return signalCodeVal;
      },
    },
    kill: {
      enumerable: true,
      value(signal) {
        killedFlag = true;
        if (!opts.ignoreSignal) forceExit(null, signal);
        return true;
      },
    },
  });
  return emitter;
}

// fakeSpawnDeps(lines, opts) -- the `deps.spawn` function makeSpawnClaudeCodeProcess reads,
// wrapping fakeSpawnedChild above and recording the (command, args, spawnOpts) it was called with
// so a test can assert on cwd/env/signal the same way the old transport's tests asserted on
// spawnSync's own (command, argv, opts). Returns `{ spawn, calls }` -- `calls` accumulates one
// entry per invocation (there is exactly one per real invokeClaudeReal call in every test in this
// suite, but kept as an array rather than a single object so a test can assert "never called" by
// checking `calls.length === 0`, mirroring this file's own spawnCalls-counter convention).
function fakeSpawnDeps(lines, opts = {}) {
  const calls = [];
  function spawn(command, args, spawnOpts) {
    calls.push({ command, args, cwd: spawnOpts.cwd, env: spawnOpts.env, signal: spawnOpts.signal });
    // spawnOpts.signal -- threaded through to fakeSpawnedChild so it can reproduce Node's own
    // `{signal}` spawn-option behaviour (see that function's own header on `opts.signal`).
    return fakeSpawnedChild(lines, { ...opts, signal: spawnOpts.signal });
  }
  return { spawn, calls };
}

// fakeExecDeps(extra) -- card #239 chantier, action A5b fix pass F9. The `deps.resolveClaude
// CodeExecutable`/`deps.isNoRealSpawnEnabled` pair every `invokeClaudeReal`-level test needs
// alongside `fakeSpawnDeps`'s own `spawn`: a fixed, never-resolved-for-real fake `claude` path, and
// an explicit opt-out of the SPO_NO_REAL_SPAWN killswitch this suite's own top-of-file
// `require('./no-real-spawn')` arms process-wide (see that require's own comment). The opt-out is
// deps-scoped, never an env mutation, so it can never leak into a sibling test.
//
// Was hand-rolled identically in test/llm-real.test.js and test/llm-real-card.test.js (both named
// `fakeExecDeps`, both resolving to the same literal `/fake/bin/claude`) before this fix pass --
// exported here once so the 18+ files migrating onto this seam next (A5b-2) do not have to hand-roll
// it a third, fourth, ... time. `extra` overrides/extends the two defaults (e.g. a test that wants
// `isNoRealSpawnEnabled: () => true` to exercise the killswitch itself).
function fakeExecDeps(extra = {}) {
  return { resolveClaudeCodeExecutable: () => '/fake/bin/claude', isNoRealSpawnEnabled: () => false, ...extra };
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

  // orchestrator/no-real-spawn-guard.js's own env var, set EXPLICITLY here (not left to the
  // `...process.env` spread above to carry it) -- a call site that builds its own `env:` object
  // from scratch instead of starting from this helper's return value must not silently drop it.
  // Required lazily, here rather than at file scope, because this file's own top (lines 65-80) is
  // line-pinned by test/doc-constant-sweep.test.js's EXPECTED_CITATIONS and must not shift.
  const { SPO_NO_REAL_SPAWN } = require('../orchestrator/no-real-spawn-guard');

  return {
    ...process.env,
    SPO_PRODUCT_REPO: mkTmp('spo-isolated-product-'),
    SPO_WORKTREES_DIR: mkTmp('spo-isolated-worktrees-'),
    SPO_ACCOUNTS_DIR: accountsDir,
    SPO_BENCH_DIR: mkTmp('spo-isolated-bench-'),
    // orchestrator/config.js's spoReportsDir falls back to `~/.spo-reports` when this is unset --
    // every daemon/spo subprocess this suite spawns would otherwise write real report files into
    // the maintainer's shared, real reports directory. Same fresh-mkdtempSync treatment as the
    // other isolated paths above.
    SPO_REPORTS_DIR: mkTmp('spo-isolated-reports-'),
    // orchestrator/state-root.js's resolveStateRoot() falls back to `~/.spo-state` when this is
    // unset -- every daemon/spo subprocess this suite spawns would otherwise resolve its
    // queue/journal DEFAULT (when a call site passes no explicit --queue/--journal) to the
    // maintainer's real, live state root. Verified before adding this: no test in this suite
    // spawns a REAL child that relies on SPO_STATE_DIR resolving to the genuine machine default
    // to exercise bin/spo's live-daemon-lock refusal (refuseIfDaemonLockHeld) -- every test that
    // exercises that guard (test/intake.test.js, test/spo-triage.test.js, test/recette.test.js)
    // calls the relevant command function IN-PROCESS and sets process.env.SPO_STATE_DIR itself
    // (see each file's own withIsolatedStateDir), never going through a spawned child's `env:`
    // option at all -- so this addition cannot silently neuter any of them. If a future test
    // spawns a real `spo pull`/`spo intake` child to exercise that same refusal, it must pin the
    // RESOLVED lock path explicitly (the same way withIsolatedStateDir does for the in-process
    // tests) rather than rely on this default, and must show the assertion falls when the guard
    // is revoked -- see bin/spo's "ACCEPTED RESIDUAL" comment (refuseIfDaemonLockHeld's header) for why the state-root
    // env (SPO_STATE_DIR, or HOME when unset) can walk a REAL spawned child past that guard without --force.
    SPO_STATE_DIR: mkTmp('spo-isolated-state-'),
    [SPO_NO_REAL_SPAWN]: '1',
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

// ---- the temp-dir registry, and the one exit hook that sweeps it -----------------------------
//
// Every mkTmp() above hands out an fs.mkdtempSync(os.tmpdir()) directory that nothing ever
// removed. Measured on 2026-09-07, before this registry existed: one `scripts/gate.sh` run (76
// files, 2239 tests, green) left 5617 NEW entries under /tmp -- 1428 of them the six
// isolatedEnv() paths alone, at 238 daemon spawns per run. They accumulate across every gate
// run, every pre-push, every CI job, forever. /tmp on this box was already carrying 1471 entries
// when the measurement started.
//
// The cheap fix is available because of how the suite is RUN. `scripts/gate.sh` ends in
// `node --test "${files[@]}"`, and node:test's default isolation is 'process': it forks one child
// per test FILE (verified on node v22.23.2 -- three files, three distinct pids, helpers.js
// require'd once in each). So a module-scope registry here is per-file by construction, and one
// `process.on('exit')` registered at require time fires exactly once per test file, after that
// file's last test, with no per-test bookkeeping and no `after()` hook for 76 files to remember.
//
// The removal is fs.rmSync, not fs.rm: 'exit' handlers may not queue async work -- a promise or a
// callback scheduled there never runs, and the sweep would silently do nothing.
//
// WHAT THIS DOES NOT COVER, deliberately, so nobody reads it as a guarantee:
//   - A process killed by SIGKILL, or one that never reaches a normal exit, runs no handler.
//     A timed-out `runDaemonWorkerRun` child is killed that way; its own registry dies with it.
//     This reduces the leak, it does not make os.tmpdir() self-cleaning.
//   - Temp paths built by PRODUCTION code rather than by this helper (intake.js's
//     `spo-card-comment-*`/`spo-card-body-*`/`spo-amend-body-*` files, report-intake.js's
//     `spo-raw-report-*`) are outside it -- they are files the product writes, and a test that
//     wants them swept must pass an explicit `tmpDir` that came from mkTmp.
//   - A directory registered here is removed EVEN IF the test already removed it (force: true) or
//     moved it. Registration is one-way; there is no unregister, because nothing in this suite
//     hands a mkTmp() path to anything that outlives the test file's own process.
//
// test/temp-dir-registry.test.js proves the sweep actually happens -- including on a test file
// that FAILS -- by running a real `node --test` child and checking the directory is gone, with an
// unregistered fs.mkdtempSync directory in the same fixture as the control that survives.
// test/temp-dir-sweep.test.js is the standing guard that no test file re-derives its own
// mkdtempSync helper and slips back out of the registry.
const TEMP_DIRS = new Set();

// Not exported: mkTmp() is the only caller, and an exported way to register an arbitrary path
// would be an invitation to keep creating directories the other way and remember to register
// them -- which is the habit this whole block exists to remove.
function registerTempDir(dir) {
  TEMP_DIRS.add(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of TEMP_DIRS) {
    // Never throw from an exit handler: a directory left un-removable (a fixture that chmod'd
    // itself, a mount, a race with a child still exiting) must cost a leaked directory, not turn
    // a green test file into a non-zero exit with no failing test name to point at.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* leaked, not fatal -- see above */
    }
  }
});

module.exports = {
  gitEnv,
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
  fakeSpawnedChild,
  fakeSpawnDeps,
  fakeExecDeps,
};
