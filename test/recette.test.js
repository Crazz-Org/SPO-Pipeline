'use strict';
// Unit + integration tests for orchestrator/recette.js (ACTION 2.9, `spo recette`). Every real
// `git`/`gh`/`npm`/`claude` call is a fake injected via `deps.spawnSync` (same convention as
// test/real-steps.test.js) -- this file never touches a real binary, a real GitHub repo, or the
// real ~/SPO-WebClient/journal/queue. `deps.isAlive` is the equivalent injection point for the
// daemon-lock safety check (orchestrator/lock.js's own convention).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn: realSpawn } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const recette = require('../orchestrator/recette');
const { lockPath } = require('../orchestrator/lock');
const { createDispatcher } = require('../orchestrator/dispatcher');
const { writePoolDir, mkTmp, writeTask, isolatedEnv, readState, readJournal } = require('./helpers');

// ---------------------------------------------------------------------------------------------
// ACTION 7.2 -- driver: 'dispatcher' (parallel-doc-log, K=2) test helpers.
//
// no-real-spawn.js patches ONLY the synchronous child_process.spawnSync (see that module's own
// "scope: spawnSync only" header) -- the async spawn() dispatcher.js itself uses to launch real
// worker/scanner child processes is UNTOUCHED. THIS IS NOT A THEORETICAL GAP: during this
// action's own verification, mutating trivial-doc-log's own driver to 'dispatcher' (routing its
// pre-existing tests through real worker children) with productRepo/pipelineWorktreesDir left at
// their real defaults created an ACTUAL worktree and branch in the maintainer's live
// ~/SPO-WebClient and ran a real `npm ci` -- while a `--real` daemon was running against that same
// repo. It was cleaned up and nothing was pushed, but no killswitch in this suite would have
// stopped a worse outcome. ASSUME NO KILLSWITCH PROTECTS ANY DISPATCHER-DRIVER TEST: every single
// one below MUST isolate `productRepo`/`pipelineWorktreesDir` to a fresh mkTmp() explicitly (via
// dispatcherBaseConfig or opts.configOverrides -- never the config.js default), same as every
// other daemon subprocess this suite spawns already does (test/helpers.js's own isolatedEnv). That
// isolation is LOAD-BEARING, not tidy.
//
// `shadowMode: true` is this project's own established, sanctioned SEPARATE pattern for testing
// real dispatcher concurrency hermetically on top of that isolation: spawn REAL node processes,
// but hand them `shadowMode: true` so nothing inside them ever reaches a real git/gh/npm/claude
// binary in the first place (steps/scripted.js's and steps/llm.js's shadow branches are both
// gated on ctx.shadowMode alone -- config-level, NOT task.kind, so this applies equally to the
// `kind: "card"` tasks recette.js's own enqueueTask builds). It protects the WORKER's own steps;
// it does nothing for a scanner stand-in that ignores its argv/config entirely (see the dedicated
// scan-timer-env-forwarding proof test further below, which uses exactly that shape) -- the
// productRepo/pipelineWorktreesDir isolation above is what actually matters there. See
// test/dispatcher.test.js's own header for the identical shadowMode reasoning this file borrows
// rather than re-derives.
// ---------------------------------------------------------------------------------------------

// Same isolation every daemon subprocess in this suite gets (test/helpers.js's isolatedEnv) --
// a dispatcher spawning workers in-process (as these tests do, calling createDispatcher directly)
// would otherwise hand a worker child THIS test process's bare, unisolated environment.
function spawnIsolated(cmd, args, opts) {
  return realSpawn(cmd, args, { ...opts, env: isolatedEnv() });
}

// A real, but inert, scanner stand-in -- see test/dispatcher.test.js's own neverExitsSpawn for
// the full self-orphan-detection reasoning (identical here, not re-derived). Every test below
// that hands `deps.spawn` a real worker process must also hand this to `deps.spawnScanner`,
// since createDispatcher's run() spawns exactly one scanner unconditionally.
function neverExitsSpawn(cmd, args, opts) {
  return realSpawn(
    process.execPath,
    ['-e', 'const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(0); }, 50);'],
    { ...opts, stdio: 'ignore' }
  );
}

async function waitFor(predicate, timeoutMs = 10000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (predicate()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function dispatcherBaseConfig(overrides = {}) {
  return {
    shadowMode: true,
    dryRun: false,
    real: false,
    stepDeadlineMs: 30000,
    pollIntervalMs: 30,
    productRepo: mkTmp('spo-recette-disp-product-'),
    pipelineWorktreesDir: mkTmp('spo-recette-disp-worktrees-'),
    spoBenchDir: mkTmp('spo-recette-disp-bench-'),
    workers: 1,
    workerCrashLimit: 3,
    orphanScanMs: 0,
    unparkScanMs: 0,
    autoPullMs: 0,
    autoIntakeMs: 0,
    reportConfirmScanMs: 0,
    autoTriageMs: 0,
    ...overrides,
  };
}

function poolDir(n) {
  const dir = mkTmp('spo-recette-disp-accts-');
  writePoolDir(
    dir,
    Array.from({ length: n }, (_, i) => ({ name: `acct${i}` }))
  );
  return dir;
}

// Same fixture shape test/dispatcher.test.js's own slowDoneTask establishes -- kind: 'card' here
// (not 'synthetic') deliberately, to prove the SAME shadow mechanism recette.js's enqueueTask
// relies on (opts.taskOverrides -> extra fields merged onto a kind:"card" task) really does reach
// DONE with a configurable delay, exactly the way a real recette dispatcher run's own tasks would.
function slowCardTask(id, implementDelayMs) {
  return { id, kind: 'card', shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: implementDelayMs } } };
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

// The minimal payload satisfying step-contracts.js's outputContract for each of the three LLM
// steps a happy-path docs-only card actually calls (PLAN, IMPLEMENT, VALIDATE -- touchesRdoMembers
// is false, so CITATION_VERIFIER never runs; DIAGNOSE never runs on a clean happy path).
// Distinguished by the exact `required` key set step-contracts.js's resolveStepContract puts in
// `--json-schema`, since the step name itself never appears in argv (only the prompt TEXT, on
// stdin, differs -- see steps/llm.js's buildArgv).
const STEP_PAYLOADS = {
  'plan_markdown,invariants_markdown,invariant_ids,check_commands': {
    plan_markdown: '# Plan\n\nAppend one line to doc/recette-log.md.\n',
    invariants_markdown: '# Invariants\n\n(none -- docs-only change)\n',
    invariant_ids: [],
    check_commands: ['typecheck', 'lint', 'coverage:changed'],
    // Action 3.2/D2: files_to_change is optional, so it never appears in the schema's `required`
    // key set this fixture is looked up by -- but handlePlan still reads it off the payload. A
    // clean declaration here keeps this recette run's journal free of a spurious
    // plan-files-undeclared event, the same evidence-poisoning D2 fixed for --dry-run.
    files_to_change: ['doc/recette-log.md'],
  },
  'summary,files_changed,invariants,tests_run,all_green': {
    summary: 'Appended one line to doc/recette-log.md.',
    files_changed: ['doc/recette-log.md'],
    invariants: [],
    tests_run: ['coverage:changed'],
    all_green: true,
  },
  'verdict,reasons,findings': {
    verdict: 'PASS',
    reasons: [],
    findings: [],
  },
};

function fakeClaudeStdout(args) {
  const schemaFlagIndex = args.indexOf('--json-schema');
  const schema = schemaFlagIndex >= 0 ? JSON.parse(args[schemaFlagIndex + 1]) : { required: [] };
  const key = (schema.required || []).join(',');
  const payload = STEP_PAYLOADS[key];
  if (!payload) {
    throw new Error(`fakeClaudeStdout: no canned payload for required=[${key}]`);
  }
  return JSON.stringify({
    result: JSON.stringify(payload),
    session_id: `fake-session-${key.length}`,
    num_turns: 1,
    modelUsage: { 'fake-model': { input_tokens: 100, output_tokens: 50 } },
  });
}

// A full, real-mode, happy-path fake spawnSync: every git/gh/npm/claude call a docs-only
// `trivial-doc-log` card makes on a clean run to DONE, INCLUDING recette's own `gh issue create`
// and (after --keep is false) its cleanup calls. Pattern-matched on argv, not on call order --
// order-independent so the exact sequence real-steps.js's handlers issue calls in is never
// re-asserted here (test/real-steps.test.js already owns that).
function makeHappyPathSpawnSync({ calls } = {}) {
  const originMainSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);

  return (command, args, opts) => {
    if (calls) calls.push({ command, args: [...args] });

    if (command === 'claude') return ok(fakeClaudeStdout(args));

    if (command === 'git') {
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no leftovers, ever
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${originMainSha}\n`);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('worktree') && args.includes('list')) return ok(''); // nothing registered
      if (args.includes('worktree') && args.includes('add')) return ok('');
      if (args.includes('worktree') && args.includes('remove')) return ok('');
      if (args.includes('worktree') && args.includes('prune')) return ok('');
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M doc/recette-log.md\n');
      if (args.includes('add') && args.includes('-A')) return ok('');
      if (args.includes('commit')) return ok('');
      if (args.includes('push') && args.includes('--delete')) return ok(''); // cleanup: remote branch
      if (args.includes('push')) return ok('To github.com\n * [new branch]      HEAD -> claude-pipe/x\n');
      if (args.includes('branch') && args.includes('-D')) return ok(''); // cleanup: local branch
      if (args.includes('diff') && args.includes('--name-only')) return ok('doc/recette-log.md\n');
      if (args.includes('diff')) return ok('diff --git a/doc/recette-log.md b/doc/recette-log.md\n+one line\n');
      return fail(1, `unhandled fake git call: ${args.join(' ')}`);
    }

    if (command === 'gh') {
      if (args[0] === 'issue' && args[1] === 'create') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/9001\n');
      }
      if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
      if (args[0] === 'pr' && args[1] === 'create') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/4242\n');
      }
      if (args[0] === 'api' && args.some((a) => String(a).includes('check-runs'))) {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success', status: 'completed' }] }));
      }
      if (args[0] === 'pr' && args[1] === 'merge') return ok('');
      if (args[0] === 'issue' && args[1] === 'comment') return ok('');
      if (args[0] === 'pr' && args[1] === 'close') return ok('');
      if (args[0] === 'issue' && args[1] === 'close') return ok('');
      return fail(1, `unhandled fake gh call: ${args.join(' ')}`);
    }

    if (command === 'npm') {
      if (args[0] === 'ci') return ok('');
      if (args[1] === 'board:take') return ok('claimed\n');
      if (args[1] === 'board:move') return ok('');
      if (['typecheck', 'lint', 'coverage:changed'].includes(args[1])) return ok('');
      if (args[1] === 'gate') return ok('');
      if (args[1] === 'pr:wait') return ok('');
      return fail(1, `unhandled fake npm call: ${args.join(' ')}`);
    }

    return fail(1, `unhandled fake command: ${command} ${args.join(' ')}`);
  };
}

function setupAccountsDir() {
  const dir = mkTmp('spo-recette-accounts-');
  writePoolDir(dir, [{ name: 'default', oauthToken: 'fake-token' }]);
  return dir;
}

function baseOpts(overrides = {}) {
  return {
    recetteDir: mkTmp('spo-recette-run-'),
    productJournalRoot: mkTmp('spo-recette-product-journal-'), // no live daemon there
    accountsDir: setupAccountsDir(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// --dry: no side effects at all
// ---------------------------------------------------------------------------------------------

test('recette --dry prints the plan and performs zero side effects (spawnSync never called)', async () => {
  let spawnCalled = false;
  const opts = { ...baseOpts(), dry: true };
  const result = await recette.runRecette(opts, { spawnSync: () => { spawnCalled = true; return ok(''); } });

  assert.equal(result.ok, true);
  assert.equal(result.dry, true);
  assert.equal(spawnCalled, false);
  assert.ok(!fs.existsSync(opts.recetteDir) || fs.readdirSync(opts.recetteDir).length === 0);
  assert.equal(result.plan.scenario, 'trivial-doc-log');
});

// ---------------------------------------------------------------------------------------------
// Safety: refuse while a live daemon holds its own lock, --force overrides
// ---------------------------------------------------------------------------------------------

test('recette refuses to run while a live daemon holds journal/daemon.lock', async () => {
  const opts = baseOpts();
  fs.mkdirSync(opts.productJournalRoot, { recursive: true });
  fs.writeFileSync(lockPath(opts.productJournalRoot), JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() }));

  let spawnCalled = false;
  const result = await recette.runRecette(opts, {
    isAlive: (pid) => pid === 999999, // simulate that pid as alive
    spawnSync: () => { spawnCalled = true; return ok(''); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'daemon-lock-held');
  assert.equal(result.detail.holder.pid, 999999);
  assert.equal(spawnCalled, false, 'refusal must happen before any spawn');
});

test('recette --force overrides the daemon-lock refusal', async () => {
  const opts = baseOpts({ force: true });
  fs.mkdirSync(opts.productJournalRoot, { recursive: true });
  fs.writeFileSync(lockPath(opts.productJournalRoot), JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() }));

  const calls = [];
  const result = await recette.runRecette(opts, {
    isAlive: () => true,
    spawnSync: makeHappyPathSpawnSync({ calls }),
  });

  assert.notEqual(result.refused, true);
  assert.ok(calls.length > 0, '--force must let the run actually spawn');
});

test('a lock file whose pid is dead is not a refusal (liveDaemonHolder returns null)', async () => {
  const opts = baseOpts();
  fs.mkdirSync(opts.productJournalRoot, { recursive: true });
  fs.writeFileSync(lockPath(opts.productJournalRoot), JSON.stringify({ host: os.hostname(), pid: 123456, mode: 'real', startedAt: new Date().toISOString() }));

  const result = await recette.runRecette(opts, {
    isAlive: () => false,
    spawnSync: makeHappyPathSpawnSync(),
  });

  assert.notEqual(result.refused, true);
});

// ---------------------------------------------------------------------------------------------
// Happy path: one trivial card, end to end, real mode, fake spawnSync -- DONE, every assertion
// passes, cleanup runs and reports clean.
// ---------------------------------------------------------------------------------------------

test('recette: trivial-doc-log happy path reaches DONE, all assertions pass, cleanup runs clean', async () => {
  const opts = baseOpts();
  const calls = [];

  const result = await recette.runRecette(opts, { spawnSync: makeHappyPathSpawnSync({ calls }) });

  assert.equal(result.finalState, 'DONE', JSON.stringify(result.assertions));
  assert.equal(result.capTripped, null);
  assert.equal(result.error, null);
  assert.ok(result.assertions, 'assertions must have been evaluated');
  for (const a of result.assertions.results) {
    assert.equal(a.ok, true, `assertion "${a.id}" failed: ${a.detail}`);
  }
  assert.equal(result.assertions.ok, true);
  assert.equal(result.ok, true);

  // cleanup ran (opts.keep is falsy) and reported every step clean
  assert.ok(result.cleanupReport);
  assert.equal(result.cleanupReport.anyFailed, false, JSON.stringify(result.cleanupReport.steps));
  const names = result.cleanupReport.steps.map((s) => s.name);
  assert.deepEqual(names, ['worktree-remove', 'worktree-prune', 'branch-delete-local', 'branch-delete-remote', 'pr-close', 'issue-close', 'journal-dir-remove']);

  // the isolated run dir is gone after cleanup
  assert.equal(fs.existsSync(result.plan.runDir), false);

  // recette's own gh issue create + a handful of real spawns actually happened
  assert.ok(calls.some((c) => c.command === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create'));
  assert.ok(calls.some((c) => c.command === 'claude'));
});

test('recette --keep skips cleanup and leaves the run dir behind', async () => {
  const opts = baseOpts({ keep: true });
  const result = await recette.runRecette(opts, { spawnSync: makeHappyPathSpawnSync() });

  assert.equal(result.finalState, 'DONE');
  assert.equal(result.cleanupReport, null);
  assert.equal(result.kept, true);
  assert.equal(fs.existsSync(result.plan.runDir), true);
  assert.equal(fs.existsSync(path.join(result.plan.journalRoot, result.taskId, 'journal.jsonl')), true);
});

// ---------------------------------------------------------------------------------------------
// Cap: wall-clock and LLM-step-count, both trip, both abort AND clean up
// ---------------------------------------------------------------------------------------------

test('recette: LLM-step cap trips before the 2nd claude call -- aborts and still cleans up', async () => {
  const opts = baseOpts({ capLlmSteps: 1 }); // PLAN is allowed; IMPLEMENT's claude call must not be
  const result = await recette.runRecette(opts, { spawnSync: makeHappyPathSpawnSync() });

  assert.equal(result.ok, false);
  assert.ok(result.capTripped, 'cap must have tripped');
  assert.equal(result.capTripped.reason, 'llm-step-cap-exceeded');
  assert.equal(result.llmSteps, 1);
  assert.notEqual(result.finalState, 'DONE');

  // cleanup still ran despite the abort, and never threw (we got a normal result object back)
  assert.ok(result.cleanupReport);
  // A FAILED gate keeps its own journal: journal.jsonl, state.json, report.md, gate.log, logs/
  // and diff.patch are the only material anyone has to diagnose why it went red, and --keep is a
  // decision made before the run, when you do not yet know you will need it.
  // The contract is that cleanup does not DELETE a failed run's journal -- not that the journal
  // exists, since this cap trips so early the run dir was never created in the first place.
  assert.ok(
    result.cleanupReport.steps.some((st) => st.name === 'journal-dir-kept'),
    'a failed run must never have its own evidence removed'
  );
  assert.ok(
    !result.cleanupReport.steps.some((st) => st.name === 'journal-dir-remove'),
    'and must not report removing it'
  );
});

// makeCap unit test, with a fully controlled fake clock: call 1 is inside the cap, call 2 (after
// the fake clock advances past it) is refused BEFORE the underlying spawnSync ever runs.
test('makeCap: wall-clock cap trips on the call that crosses it, never on the one before', () => {
  let fakeNow = 1_000_000;
  let underlyingCalls = 0;
  const config = recette.resolveConfig(baseOpts({ capMs: 1000 }));
  const cap = recette.makeCap(config, { now: () => fakeNow });
  const wrappedSpawn = cap.wrapSpawnSync(() => {
    underlyingCalls += 1;
    return ok('');
  });

  wrappedSpawn('git', ['-C', '/x', 'fetch', 'origin'], {}); // elapsed 0ms -- fine
  assert.equal(underlyingCalls, 1);
  assert.equal(cap.tripped(), null);

  fakeNow += 2000; // now 2000ms elapsed, over the 1000ms cap
  assert.throws(() => wrappedSpawn('git', ['-C', '/x', 'fetch', 'origin'], {}), recette.RecetteCapExceededError);
  assert.equal(underlyingCalls, 1, 'the over-cap call must never reach the real spawnSync');
  assert.equal(cap.tripped().reason, 'wall-clock-cap-exceeded');
});

// Full integration: a real (not fake-clocked) but effectively-zero capMs against the real happy
// path fake -- by the second or third real spawnSync call, actual wall-clock ms have already
// elapsed, so the run reliably trips well before WORKTREE finishes, aborts, and still cleans up.
test('recette: wall-clock cap trips in a full run -- aborts before completion and still cleans up', async () => {
  const opts = baseOpts({ capMs: 1 });
  const result = await recette.runRecette(opts, { spawnSync: makeHappyPathSpawnSync() });

  assert.equal(result.ok, false);
  assert.ok(result.capTripped, 'cap must have tripped');
  assert.equal(result.capTripped.reason, 'wall-clock-cap-exceeded');
  assert.notEqual(result.finalState, 'DONE');

  assert.ok(result.cleanupReport);
  // A FAILED gate keeps its own journal -- journal.jsonl, state.json, report.md, gate.log, logs/
  // and diff.patch are the only material anyone has to diagnose why it went red, and --keep is a
  // decision made before the run, when you do not yet know you will need it. The contract is
  // that cleanup does not DELETE it; the dir itself may never have been created, since this cap
  // trips before WORKTREE.
  assert.ok(
    result.cleanupReport.steps.some((st) => st.name === 'journal-dir-kept'),
    'a failed run must never have its own evidence removed'
  );
  assert.ok(
    !result.cleanupReport.steps.some((st) => st.name === 'journal-dir-remove'),
    'and must not report removing it'
  );
});

// ---------------------------------------------------------------------------------------------
// Cleanup: runs on the failure path, is idempotent, never throws
// ---------------------------------------------------------------------------------------------

test('cleanup runs even when the pipeline run throws (a non-ParkSignal error mid-run)', async () => {
  const opts = baseOpts();
  const calls = [];
  const happy = makeHappyPathSpawnSync({ calls });
  // Break the very first gh issue create call so the whole run throws before any task exists.
  const spawnSync = (command, args, o) => {
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return fail(1, 'boom');
    return happy(command, args, o);
  };

  const result = await recette.runRecette(opts, { spawnSync });

  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'RecetteError');
  assert.ok(result.cleanupReport, 'cleanup must still have run');
  // No issue number was ever obtained, so only the run-dir step applies -- and because the run
  // failed, the dir is KEPT rather than removed.
  assert.deepEqual(result.cleanupReport.steps.map((s) => s.name), ['journal-dir-kept']);
  assert.equal(result.cleanupReport.anyFailed, false);
});

test('cleanup is idempotent and never throws when everything is already gone', () => {
  const config = recette.resolveConfig(baseOpts());
  fs.mkdirSync(config.runDir, { recursive: true }); // journal-dir-remove has something to remove once

  // Every git/gh call answers the way the real tools do when the artifact is already gone --
  // which is exactly the SUCCESS path, where FINISH removed the worktree, MERGE merged the PR
  // and the merge deleted the remote branch. Those must read as CLEAN, not as failures: the
  // first green live run (2026-08-31, issue #469) printed "3 not-clean" having left nothing
  // behind, which trains a maintainer to ignore the one line that would report a real leak.
  const deps = { spawnSync: () => fail(1, "fatal: 'x' is not a working tree") };

  const report = recette.cleanup({ scenario: recette.SCENARIOS['trivial-doc-log'], config, deps, issueNumber: 9001, prNumber: 4242 });

  assert.equal(report.anyFailed, false, 'already-gone is clean, not a failure');
  assert.ok(report.steps.every((s) => s.ok === true), 'a non-zero exit is recorded via {exit}, never a thrown/caught error');
  assert.ok(report.steps.some((s) => s.gone === true), 'and is marked `gone` so the reason is visible');
  assert.equal(fs.existsSync(config.runDir), false);

  // Calling it again (everything already gone, including the run dir) must still never throw.
  assert.doesNotThrow(() => recette.cleanup({ scenario: recette.SCENARIOS['trivial-doc-log'], config, deps, issueNumber: 9001, prNumber: 4242 }));
});

test('cleanup never throws even when the injected spawnSync itself throws', () => {
  const config = recette.resolveConfig(baseOpts());
  fs.mkdirSync(config.runDir, { recursive: true });
  const deps = {
    spawnSync: () => {
      throw new Error('ENOENT: no such file or directory');
    },
  };

  let report;
  assert.doesNotThrow(() => {
    report = recette.cleanup({ scenario: recette.SCENARIOS['trivial-doc-log'], config, deps, issueNumber: 9002, prNumber: null });
  });
  assert.equal(report.anyFailed, true);
  assert.ok(report.steps.filter((s) => s.name !== 'journal-dir-remove').every((s) => s.ok === false));
  // pr-close is skipped outright (no prNumber), never attempted, never reported
  assert.ok(!report.steps.some((s) => s.name === 'pr-close'));
});

// ---------------------------------------------------------------------------------------------
// Assertions: pure, and prove the harness actually detects a broken pipeline
// ---------------------------------------------------------------------------------------------

test('evaluateAssertions: a full, correct journal passes every assertion', () => {
  const events = [
    { state: 'PLAN', event: 'files-written', planPath: '/x/plan-1.md' },
    { state: 'IMPLEMENT', event: 'result', payload: { files_changed: ['doc/recette-log.md'] } },
    { state: 'VALIDATE', event: 'judge-inputs-prepared', produced: ['diff.patch'], missing: [] },
    { state: 'VALIDATE', event: 'change-validator', verdict: 'PASS' },
    { state: 'MERGE', event: 'pr-merge-enqueue', exit: 0 },
    { state: 'FINISH', event: 'finished', prNumber: 4242 },
  ];
  const result = recette.evaluateAssertions(recette.SCENARIOS['trivial-doc-log'], { events, finalState: 'DONE', capTripped: null });
  assert.equal(result.ok, true);
  assert.ok(result.results.every((r) => r.ok));
});

// THE test the brief calls out: a journal reaching DONE that is missing ONE of the required
// events must be caught, not rubber-stamped. Here: VALIDATE never actually prepared its judge
// inputs (as if prepareJudgeInputs silently no-op'd) -- everything else about the run looks
// normal, including a DONE finalState and a PASS verdict.
test('evaluateAssertions: DONE with a missing judge-inputs-prepared event fails that one assertion (detects a broken pipeline)', () => {
  const events = [
    { state: 'PLAN', event: 'files-written', planPath: '/x/plan-1.md' },
    { state: 'IMPLEMENT', event: 'result', payload: { files_changed: ['doc/recette-log.md'] } },
    // no VALIDATE judge-inputs-prepared event at all
    { state: 'VALIDATE', event: 'change-validator', verdict: 'PASS' },
    { state: 'MERGE', event: 'pr-merge-enqueue', exit: 0 },
    { state: 'FINISH', event: 'finished', prNumber: 4242 },
  ];
  const result = recette.evaluateAssertions(recette.SCENARIOS['trivial-doc-log'], { events, finalState: 'DONE', capTripped: null });

  assert.equal(result.ok, false);
  const failed = result.results.find((r) => r.id === 'validate-got-real-diff');
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /no judge-inputs-prepared event/);
  // every OTHER assertion still ran and still reports its own true verdict -- one broken event
  // does not mask the rest of the report
  assert.ok(result.results.filter((r) => r.id !== 'validate-got-real-diff').every((r) => r.ok));
});

test('evaluateAssertions: a park is caught by no-park and reached-done both', () => {
  const events = [{ state: 'GATE', event: 'parked', reason: 'gate-dirty-tree' }];
  const result = recette.evaluateAssertions(recette.SCENARIOS['trivial-doc-log'], { events, finalState: 'PARKED', capTripped: null });
  assert.equal(result.ok, false);
  assert.equal(result.results.find((r) => r.id === 'no-park').ok, false);
  assert.equal(result.results.find((r) => r.id === 'reached-done').ok, false);
});

// ---------------------------------------------------------------------------------------------
// Scenarios are data: a second scenario can be added without touching the runner
// ---------------------------------------------------------------------------------------------

test('a second scenario can be registered and run without any change to the runner', async () => {
  const customName = `custom-${Date.now()}`;
  recette.SCENARIOS[customName] = {
    name: customName,
    label: 'spo-recette',
    description: 'a minimal custom scenario for this test only',
    buildCard: ({ runId }) => ({ title: `[spo-recette] custom ${runId}`, body: '## Done means\n\nnothing.\n' }),
    assertions: [{ id: 'reached-done', description: 'reached DONE', check: ({ finalState }) => ({ ok: finalState === 'DONE', detail: finalState }) }],
  };

  try {
    const opts = baseOpts({ scenario: customName });
    const result = await recette.runRecette(opts, { spawnSync: makeHappyPathSpawnSync() });
    assert.equal(result.scenario, customName);
    assert.equal(result.finalState, 'DONE');
    assert.equal(result.ok, true);
  } finally {
    delete recette.SCENARIOS[customName];
  }
});

test('resolveScenario throws a clear error for an unknown scenario name', () => {
  assert.throws(() => recette.resolveScenario('does-not-exist'), (err) => err instanceof recette.RecetteError && err.reason === 'unknown-scenario');
});

// ---------------------------------------------------------------------------------------------
// Leak: the `wip/` refs a PARK pushes to origin (adversarial verification, action 2.9)
// ---------------------------------------------------------------------------------------------

// steps/scripted.js's preserveWorktreeWip pushes a dirty parked worktree to a durable
// `wip/<taskId>-<ts>` branch ON ORIGIN -- a remote branch in the product repo, in a namespace
// cleanup's `claude-pipe/<taskId>` delete does not cover. A park is the most likely first-live-run
// outcome, so this is the leak path that matters most.
test('wipRefsFrom: reads every wip/ ref this run pushed off the journal, deduped', () => {
  const events = [
    { state: 'WORKTREE', event: 'leftover-wip-preserved', ref: 'wip/recette-9001-111', sha: 'a' },
    { state: 'VALIDATE', event: 'transition', to: 'PARKED' },
    { state: 'PARKED', event: 'wip-preserved', ref: 'wip/recette-9001-222', sha: 'b' },
    { state: 'PARKED', event: 'wip-preserved', ref: 'wip/recette-9001-222', sha: 'b' }, // dedup
    { state: 'PARKED', event: 'wip-preserve-failed', step: 'push', exit: 1 }, // never pushed
  ];
  assert.deepEqual(recette.wipRefsFrom(events), ['wip/recette-9001-111', 'wip/recette-9001-222']);
  assert.deepEqual(recette.wipRefsFrom([]), []);
  assert.deepEqual(recette.wipRefsFrom(undefined), []);
});

test('cleanup deletes the remote wip/ refs the run pushed, not just claude-pipe/<id>', () => {
  const config = recette.resolveConfig(baseOpts());
  const calls = [];
  const deps = { spawnSync: (command, args) => { calls.push([command, ...args].join(' ')); return ok(''); } };

  recette.cleanup({
    scenario: recette.SCENARIOS['trivial-doc-log'],
    config,
    deps,
    issueNumber: 9001,
    prNumber: null,
    wipRefs: ['wip/recette-9001-111', 'wip/recette-9001-222'],
  });

  for (const ref of ['wip/recette-9001-111', 'wip/recette-9001-222']) {
    assert.ok(
      calls.some((c) => c === `git -C ${config.productRepo} push origin --delete ${ref}`),
      `cleanup must delete the remote ref ${ref}; calls were ${JSON.stringify(calls, null, 1)}`
    );
  }
});

// Full integration: a real-mode run that PARKS with a dirty worktree really does push a wip/ ref,
// and cleanup really does delete that exact ref. Drives the whole pipeline through the fake, so
// the ref name is the one preserveWorktreeWip actually chose -- never a hand-written string.
test('a parked run pushes a wip/ ref and cleanup deletes that exact ref (leak regression)', async () => {
  const worktreesDir = mkTmp('spo-recette-wt-');
  fs.mkdirSync(path.join(worktreesDir, 'recette-9001'), { recursive: true }); // preserveWorktreeWip needs it to exist

  const calls = [];
  const happy = makeHappyPathSpawnSync({ calls });
  const spawnSync = (command, args, o) => {
    // VALIDATE rejects every time -> validateRejectBudget exhausted -> PARKED, dirty worktree.
    if (command === 'claude') {
      const i = args.indexOf('--json-schema');
      const required = ((i >= 0 ? JSON.parse(args[i + 1]) : {}).required || []).join(',');
      if (required === 'verdict,reasons,findings') {
        return ok(JSON.stringify({
          result: JSON.stringify({ verdict: 'REJECT', reasons: ['synthetic reject'], findings: [] }),
          session_id: 'fake', num_turns: 1, modelUsage: { 'fake-model': { input_tokens: 1, output_tokens: 1 } },
        }));
      }
    }
    // a dirty tree at park time is what makes preserveWorktreeWip push at all
    if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok(' M doc/recette-log.md\n');
    if (command === 'git' && args.includes('checkout') && args.includes('--detach')) return ok('');
    return happy(command, args, o);
  };

  const result = await recette.runRecette(
    baseOpts({ configOverrides: { pipelineWorktreesDir: worktreesDir } }),
    { spawnSync }
  );

  assert.equal(result.finalState, 'PARKED');
  const pushed = calls
    .filter((c) => c.command === 'git' && c.args.some((a) => String(a).startsWith('HEAD:refs/heads/wip/')))
    .map((c) => String(c.args.find((a) => String(a).startsWith('HEAD:refs/heads/wip/'))).replace('HEAD:refs/heads/', ''));
  assert.ok(pushed.length > 0, 'the parked run must have pushed at least one wip/ ref to origin');

  for (const ref of pushed) {
    assert.ok(
      calls.some((c) => c.command === 'git' && c.args.includes('--delete') && c.args.includes(ref)),
      `cleanup must have deleted the leaked remote ref ${ref}`
    );
  }
});

// D4: the module header devotes a paragraph to RecetteCapExceededError deliberately NOT being a
// ParkSignal -- it must propagate through runTask's "a real bug, surface it" rethrow rather than
// be swallowed as a park. Nothing guarded that: making it extend ParkSignal left all 17 recette
// tests green, because the cap tests assert only capTripped (set before the throw) and
// finalState !== 'DONE', both of which a park also satisfies. It matters concretely: swallowed as
// a park, finalizePark would fire preserveWorktreeWip and push a wip/ ref on every cap trip.
test('RecetteCapExceededError is NOT a ParkSignal -- a cap must propagate, never be swallowed as a park', async () => {
  const { ParkSignal } = require('../orchestrator/park-signal');

  const err = new recette.RecetteCapExceededError('wall-clock-cap-exceeded', {});
  assert.ok(err instanceof Error);
  assert.ok(!(err instanceof ParkSignal), 'a cap trip is not a park -- runTask must rethrow it');

  // And end to end: a capped run must not come back PARKED.
  const result = await recette.runRecette(baseOpts({ capMs: 1 }), { spawnSync: makeHappyPathSpawnSync() });
  assert.ok(result.capTripped);
  assert.notEqual(result.finalState, 'PARKED', 'a cap trip must abort the run, not park the task');
});

// The first live run (2026-08-31, issue #467) failed on this. enqueueTask derived the card's
// criterion with intake.extractCriterion(issue.body), which stops at the first blank line after
// "## Done means" -- so the task reached IMPLEMENT truncated at "The new line should read
// exactly:", carrying neither the required text nor "touch nothing under src/". IMPLEMENT
// invented a line, VALIDATE rejected it, and the run burned a REJECT, an empty IMPLEMENT and a
// DIAGNOSE before converging. extractCriterion is correct for a human-written card, where the
// body IS the source of truth; here the harness wrote the card, so re-parsing its own rendered
// markdown to recover its own intent can only lose information.
test('the scenario card carries its criterion explicitly -- never re-parsed out of its own rendered body', () => {
  const runId = 'RUNID-1234';
  const card = recette.SCENARIOS['trivial-doc-log'].buildCard({ runId });

  assert.ok(card.criterion, 'buildCard must supply a criterion of its own');
  assert.match(card.criterion, /doc\/recette-log\.md/);
  assert.ok(
    card.criterion.includes(`- ${runId} -- synthetic recette card, no product behaviour changed`),
    'the criterion must carry the EXACT required line -- this is what was lost'
  );
  assert.match(card.criterion, /touch nothing under src\//i, 'and the scope instruction');

  // The regression itself: what extractCriterion would have produced from the same body.
  const intake = require('../orchestrator/intake');
  const truncated = intake.extractCriterion(card.body);
  assert.ok(
    !truncated.includes(`- ${runId} -- synthetic recette card`),
    'extractCriterion truncates at the blank line -- proving why the explicit criterion is needed'
  );
});

// The other half of the same contract: the already-gone classifier must never launder a REAL
// failure into silence. Only messages the tools actually emit for "there was nothing to do"
// count as clean; anything unrecognised stays a failure, so a non-zero anyFailed is worth
// reading rather than habitual noise.
test('cleanup: an UNRECOGNISED failure is still a failure -- the already-gone classifier cannot launder a real error', () => {
  const config = recette.resolveConfig(baseOpts());
  fs.mkdirSync(config.runDir, { recursive: true });

  // A genuine problem: no network, permission denied, a hung remote. Nothing about this says
  // "the artifact is already gone".
  const deps = { spawnSync: () => fail(1, 'fatal: unable to access https://github.com/: Could not resolve host') };

  const report = recette.cleanup({ scenario: recette.SCENARIOS['trivial-doc-log'], config, deps, issueNumber: 9001, prNumber: 4242 });

  assert.equal(report.anyFailed, true, 'an unrecognised non-zero exit must still be reported');
  assert.ok(
    report.steps.some((s) => s.ok === false && s.gone === false),
    'and named, so the maintainer knows which artifact may have been left behind'
  );
});

// =================================================================================================
// ACTION 7.2 -- driver: 'dispatcher', the out-of-process cap, and the two new scenarios.
// =================================================================================================

// ---------------------------------------------------------------------------------------------
// Scenario metadata / --dry (driver + k)
// ---------------------------------------------------------------------------------------------

test('trivial-doc-log stays driver:"inline", k:1 -- no behavioural change for the scenario that already worked', () => {
  assert.equal(recette.SCENARIOS['trivial-doc-log'].driver, 'inline');
  assert.equal(recette.SCENARIOS['trivial-doc-log'].k, 1);
});

test('parallel-doc-log is registered as driver:"dispatcher", k:2, with its own crossTaskAssertions', () => {
  const s = recette.SCENARIOS['parallel-doc-log'];
  assert.equal(s.driver, 'dispatcher');
  assert.equal(s.k, 2);
  assert.ok(Array.isArray(s.crossTaskAssertions) && s.crossTaskAssertions.length >= 4);
  // Same per-task assertions as trivial-doc-log, reused, not copied -- each of the two cards is
  // itself shaped exactly like a trivial-doc-log card.
  assert.equal(s.assertions, recette.SCENARIOS['trivial-doc-log'].assertions);
});

test('buildPlan reports driver and k for both scenarios', () => {
  const inlinePlan = recette.buildPlan(recette.SCENARIOS['trivial-doc-log'], recette.resolveConfig(baseOpts()));
  assert.equal(inlinePlan.driver, 'inline');
  assert.equal(inlinePlan.k, 1);

  const dispPlan = recette.buildPlan(recette.SCENARIOS['parallel-doc-log'], recette.resolveConfig(baseOpts()));
  assert.equal(dispPlan.driver, 'dispatcher');
  assert.equal(dispPlan.k, 2);
  assert.ok(dispPlan.steps.some((s) => s.includes('K=2')), JSON.stringify(dispPlan.steps));
});

// ---------------------------------------------------------------------------------------------
// resolveConfig(opts, scenario) -- a scenario's own capMs/capLlmSteps (post-verification
// correction: DEFAULT_CAP_LLM_STEPS is sized for ONE card; a k=2 scenario summing llm-call
// events across both would trip a healthy run partway through the second card on the k=1
// default). Priority order: opts.capMs/capLlmSteps > env > scenario's own default > the global
// DEFAULT_CAP_MS/DEFAULT_CAP_LLM_STEPS.
// ---------------------------------------------------------------------------------------------

test("resolveConfig: a scenario's own capLlmSteps/capMs is used when opts/env do not override it, opts still wins over it, and omitting the scenario keeps the pre-7.2 global default byte-identical", () => {
  const scenario = { capLlmSteps: 24, capMs: 999000 };

  const withScenario = recette.resolveConfig(baseOpts(), scenario);
  assert.equal(withScenario.capLlmSteps, 24);
  assert.equal(withScenario.capMs, 999000);

  const optsWins = recette.resolveConfig(baseOpts({ capMs: 111, capLlmSteps: 3 }), scenario);
  assert.equal(optsWins.capLlmSteps, 3, 'an explicit opts.capLlmSteps must still win over the scenario\'s own default');
  assert.equal(optsWins.capMs, 111);

  // No scenario argument at all (every call site that predates this parameter, including every
  // existing inline-driver test) resolves EXACTLY the global defaults it always did.
  const noScenario = recette.resolveConfig(baseOpts());
  assert.equal(noScenario.capLlmSteps, 12);
  assert.equal(noScenario.capMs, 45 * 60 * 1000);
});

test('parallel-doc-log resolves capLlmSteps to double the global default (one card\'s worth of budget per card) via runRecette\'s own resolveConfig(opts, scenario) call', async () => {
  const result = await recette.runRecette({ ...baseOpts(), dry: true, scenario: 'parallel-doc-log' }, {});
  assert.equal(result.plan.capLlmSteps, 24);
  // capMs is left at the global default -- a WALL-CLOCK ceiling shared by K CONCURRENT cards, not
  // summed the way LLM steps are.
  assert.equal(result.plan.capMs, 45 * 60 * 1000);
});

test('recette --dry --scenario parallel-doc-log performs zero side effects and reports driver/k', async () => {
  let spawnCalled = false;
  const opts = { ...baseOpts(), dry: true, scenario: 'parallel-doc-log' };
  const result = await recette.runRecette(opts, {
    spawnSync: () => {
      spawnCalled = true;
      return ok('');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry, true);
  assert.equal(spawnCalled, false);
  assert.equal(result.plan.driver, 'dispatcher');
  assert.equal(result.plan.k, 2);
  assert.ok(!fs.existsSync(opts.recetteDir) || fs.readdirSync(opts.recetteDir).length === 0);
});

// ---------------------------------------------------------------------------------------------
// bin/spo: --dry prints driver + k; an unknown scenario lists the known ones instead of a bare
// stack trace. `--help` is DELIBERATELY not exercised here -- see this action's own report: it is
// not actually wired as a help flag (falls through to a REAL run, same footgun CLAUDE.md already
// documents for `spo pull --help`), so running it would violate "never run spo recette for real".
// ---------------------------------------------------------------------------------------------

const binSpo = require('../bin/spo');

// Every cmdRecette call below mutates process.exitCode as a side effect (that IS the verdict
// contract -- CLAUDE.md: "Verdict by exit code"). Restored in `finally` so one CLI-level test
// asserting exitCode=1 can never leak into node:test's own overall process exit code.
function withSavedExitCode(fn) {
  const saved = process.exitCode;
  return fn().finally(() => {
    process.exitCode = saved;
  });
}

function captureConsole(streamName, fn) {
  const lines = [];
  const orig = console[streamName];
  console[streamName] = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console[streamName] = orig;
    })
    .then(() => lines);
}

test('spo recette --dry --scenario parallel-doc-log prints "driver: dispatcher  k: 2"', async () => {
  const lines = await captureConsole('log', () =>
    withSavedExitCode(() =>
      binSpo.cmdRecette({
        scenario: 'parallel-doc-log',
        dry: true,
        keep: false,
        force: false,
        recetteDir: mkTmp('spo-recette-cli-'),
        accountsDir: setupAccountsDir(),
        capMs: null,
        capLlmSteps: null,
      })
    )
  );
  assert.ok(lines.some((l) => l.includes('driver: dispatcher') && l.includes('k: 2')), JSON.stringify(lines));
});

test('spo recette --dry (default scenario) prints "driver: inline  k: 1"', async () => {
  const lines = await captureConsole('log', () =>
    withSavedExitCode(() =>
      binSpo.cmdRecette({
        scenario: null,
        dry: true,
        keep: false,
        force: false,
        recetteDir: mkTmp('spo-recette-cli-'),
        accountsDir: setupAccountsDir(),
        capMs: null,
        capLlmSteps: null,
      })
    )
  );
  assert.ok(lines.some((l) => l.includes('driver: inline') && l.includes('k: 1')), JSON.stringify(lines));
});

test('spo recette --scenario <unknown> lists the known scenarios (never a bare stack trace) and exits 1', async () => {
  const errLines = await captureConsole('error', () =>
    withSavedExitCode(async () => {
      await binSpo.cmdRecette({
        scenario: 'does-not-exist',
        dry: false,
        keep: false,
        force: false,
        recetteDir: mkTmp('spo-recette-cli-'),
        accountsDir: setupAccountsDir(),
        capMs: null,
        capLlmSteps: null,
      });
      assert.equal(process.exitCode, 1);
    })
  );
  assert.ok(
    errLines.some((l) => l.includes('unknown scenario "does-not-exist"') && l.includes('trivial-doc-log') && l.includes('parallel-doc-log')),
    JSON.stringify(errLines)
  );
});

// ---------------------------------------------------------------------------------------------
// spo recette --help -- action 7.2, post-verification correction. Before this fix, `--help` was
// not recognized by parseArgs at all and cmdRecette fell straight through to a REAL run (the same
// footgun CLAUDE.md already documents for `spo pull --help`) -- for `--scenario parallel-doc-log`
// specifically, that would have meant two real GitHub issues and a real K=2 dispatcher run.
// `deps.recette` is injected as a spy that throws if `runRecette` is ever called, so this test
// FAILS LOUDLY if `--help` regresses back to falling through, rather than merely trusting the
// printed output.
// ---------------------------------------------------------------------------------------------

test('spo recette --help prints usage and exits WITHOUT calling runRecette at all -- zero side effects, same contract as --dry', async () => {
  let runRecetteCalled = false;
  const deps = { recette: { runRecette: () => { runRecetteCalled = true; throw new Error('runRecette must never be called when --help is set'); } } };

  const lines = await captureConsole('log', () =>
    withSavedExitCode(() => binSpo.cmdRecette({ scenario: null, dry: false, keep: false, force: false, help: true, recetteDir: null, accountsDir: null, capMs: null, capLlmSteps: null }, deps))
  );

  assert.equal(runRecetteCalled, false, '--help must never reach runRecette');
  assert.ok(lines.some((l) => l.includes('usage: spo recette')), JSON.stringify(lines));
});

test('spo recette --scenario parallel-doc-log --help ALSO never runs -- the K=2 dispatcher case this action made materially more expensive to get wrong', async () => {
  let runRecetteCalled = false;
  const deps = { recette: { runRecette: () => { runRecetteCalled = true; throw new Error('runRecette must never be called when --help is set'); } } };

  await withSavedExitCode(() =>
    captureConsole('log', () =>
      binSpo.cmdRecette({ scenario: 'parallel-doc-log', dry: false, keep: false, force: false, help: true, recetteDir: null, accountsDir: null, capMs: null, capLlmSteps: null }, deps)
    )
  );

  assert.equal(runRecetteCalled, false, '--help combined with --scenario parallel-doc-log must still never reach runRecette');
});

test('bin/spo parseArgs recognizes both --help and -h as opts.help', () => {
  const { parseArgs } = binSpo;
  assert.equal(parseArgs(['recette', '--help']).help, true);
  assert.equal(parseArgs(['recette', '-h']).help, true);
  assert.equal(parseArgs(['recette', '--scenario', 'parallel-doc-log', '--help']).help, true);
  assert.equal(parseArgs(['recette']).help, false);
});

// ---------------------------------------------------------------------------------------------
// createIssue/enqueueTask: index-aware (k>1), and byte-identical for k=1 (index defaults to 0)
// ---------------------------------------------------------------------------------------------

test('createIssue threads {runId, index} to buildCard; enqueueTask files each card under its own zero-padded queue entry', () => {
  const config = recette.resolveConfig(baseOpts());
  const seenIndexes = [];
  const scenario = {
    name: 'x',
    label: 'spo-recette',
    buildCard: (ctx) => {
      seenIndexes.push(ctx.index);
      return { title: `t${ctx.index}`, body: `b${ctx.index}`, criterion: `c${ctx.index}` };
    },
  };
  let nextIssue = 9100;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return ok(`https://github.com/${config.ghRepo}/issues/${nextIssue++}\n`);
      return fail(1, 'unexpected');
    },
  };

  const issue0 = recette.createIssue(scenario, config, deps, 0);
  const issue1 = recette.createIssue(scenario, config, deps, 1);
  assert.deepEqual(seenIndexes, [0, 1]);

  const task0 = recette.enqueueTask(config, issue0, 0);
  const task1 = recette.enqueueTask(config, issue1, 1);
  assert.ok(fs.existsSync(path.join(config.queueDir, '0001-recette.json')));
  assert.ok(fs.existsSync(path.join(config.queueDir, '0002-recette.json')));
  assert.notEqual(task0.id, task1.id);
});

test('enqueueTask default index (0) is byte-identical to the pre-7.2 shape -- same filename, same fields', () => {
  const config = recette.resolveConfig(baseOpts());
  const issue = { issueNumber: 9200, title: 't', criterion: 'c', body: 'b' };
  const task = recette.enqueueTask(config, issue);
  assert.equal(task.id, 'recette-9200');
  assert.equal(task.kind, 'card');
  assert.ok(fs.existsSync(path.join(config.queueDir, '0001-recette.json')));
  const onDisk = JSON.parse(fs.readFileSync(path.join(config.queueDir, '0001-recette.json'), 'utf8'));
  assert.deepEqual(onDisk, task);
});

test('enqueueTask taskOverrides (TEST-ONLY escape hatch) merges extra fields onto the task, e.g. a shadow fixture', () => {
  const config = recette.resolveConfig(baseOpts());
  const issue = { issueNumber: 9300, title: 't', criterion: 'c', body: 'b' };
  const task = recette.enqueueTask(config, issue, 0, { shadow: { delays: { IMPLEMENT: 200 } } });
  assert.deepEqual(task.shadow, { delays: { IMPLEMENT: 200 } });
});

// ---------------------------------------------------------------------------------------------
// main-moved-doc-log: deliberately NOT built -- see the refusal recorded at the bottom of
// SCENARIOS in orchestrator/recette.js. This is a documentation test: it exists so a future edit
// that silently adds an unsafe main-moved scenario (or removes the refusal comment without
// replacing it with a considered decision) fails a test, rather than nobody noticing.
// ---------------------------------------------------------------------------------------------

test('main-moved-doc-log was NOT built -- SCENARIOS has exactly the two scenarios this action shipped', () => {
  assert.deepEqual(Object.keys(recette.SCENARIOS).sort(), ['parallel-doc-log', 'trivial-doc-log']);
});

// ---------------------------------------------------------------------------------------------
// evaluateCrossTaskAssertions -- pure, never throws, mirrors evaluateAssertions' own contract
// but with its own {tasks, daemonEvents, dispatcherConfig, capTripped} info shape.
// ---------------------------------------------------------------------------------------------

test('evaluateCrossTaskAssertions: never throws, one broken check does not hide the rest', () => {
  const scenario = {
    crossTaskAssertions: [
      { id: 'ok-one', description: 'd', check: () => ({ ok: true }) },
      { id: 'throws', description: 'd', check: () => { throw new Error('boom'); } },
      { id: 'fails', description: 'd', check: () => ({ ok: false, detail: 'nope' }) },
    ],
  };
  const result = recette.evaluateCrossTaskAssertions(scenario, {});
  assert.equal(result.ok, false);
  assert.equal(result.results.find((r) => r.id === 'ok-one').ok, true);
  assert.match(result.results.find((r) => r.id === 'throws').detail, /assertion threw: boom/);
  assert.equal(result.results.find((r) => r.id === 'fails').detail, 'nope');
});

test('evaluateCrossTaskAssertions: a scenario with no crossTaskAssertions evaluates ok:true, empty results (k=1 scenarios)', () => {
  const result = recette.evaluateCrossTaskAssertions(recette.SCENARIOS['trivial-doc-log'], {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
});

// ---------------------------------------------------------------------------------------------
// parallel-doc-log's own crossTaskAssertions, exercised directly against hand-built info objects
// -- same testing philosophy this file's own evaluateAssertions tests already use ("detects a
// broken pipeline" against a hand-built journal, never a live run) for exactly the same reason:
// these are cheap, deterministic, and prove the CHECK LOGIC itself, before ever trusting it
// against a real dispatcher run (see the integration test further below for that half).
// ---------------------------------------------------------------------------------------------

function zeroedDispatcherConfig() {
  return { orphanScanMs: 0, unparkScanMs: 0, autoPullMs: 0, autoIntakeMs: 0, reportConfirmScanMs: 0, autoTriageMs: 0 };
}

// The REAL mechanism 'scan-timers-disabled' checks (post-verification correction -- see
// orchestrator/recette.js's own "Scanner timer forwarding" section header for why
// `dispatcherConfig` above is NOT it: the scanner is a separate OS process that never reads that
// object). All seven keys as the literal string "0" -- exactly the shape
// runDispatcherScenario actually records into `scannerEnvOverrides`.
function zeroedScannerEnvOverrides() {
  const out = {};
  for (const key of recette.SCANNER_TIMER_ENV_VARS) out[key] = '0';
  return out;
}

function twoTerminalTasks() {
  return [
    { taskId: 'recette-t1', events: [], finalState: 'DONE' },
    { taskId: 'recette-t2', events: [], finalState: 'DONE' },
  ];
}

function checkFrom(result, id) {
  const found = result.results.find((r) => r.id === id);
  assert.ok(found, `no such crossTaskAssertion id: ${id}`);
  return found;
}

test('parallel-doc-log "zero-auto-pull": fails on a single auto-pull event, passes on none', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const withPull = recette.evaluateCrossTaskAssertions(scenario, {
    tasks: twoTerminalTasks(),
    daemonEvents: [{ event: 'auto-pull', enqueued: 1, issues: [12345] }],
    dispatcherConfig: zeroedDispatcherConfig(),
  });
  assert.equal(checkFrom(withPull, 'zero-auto-pull').ok, false);

  const clean = recette.evaluateCrossTaskAssertions(scenario, {
    tasks: twoTerminalTasks(),
    daemonEvents: [{ event: 'worker-spawn', id: 'recette-t1' }],
    dispatcherConfig: zeroedDispatcherConfig(),
  });
  assert.equal(checkFrom(clean, 'zero-auto-pull').ok, true);
});

test('parallel-doc-log "scan-timers-disabled": fails if scannerEnvOverrides is missing entirely', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const result = recette.evaluateCrossTaskAssertions(scenario, { tasks: twoTerminalTasks(), daemonEvents: [], dispatcherConfig: zeroedDispatcherConfig() });
  const check = checkFrom(result, 'scan-timers-disabled');
  assert.equal(check.ok, false);
  assert.match(check.detail, /no scannerEnvOverrides/);
});

test('parallel-doc-log "scan-timers-disabled": fails if ANY of the seven env vars was not forwarded as the literal string "0"', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const base = zeroedScannerEnvOverrides();

  for (const field of recette.SCANNER_TIMER_ENV_VARS) {
    for (const badValue of ['300000', '0.0', 0, undefined, 'NaN']) {
      const overrides = { ...base, [field]: badValue };
      const result = recette.evaluateCrossTaskAssertions(scenario, {
        tasks: twoTerminalTasks(),
        daemonEvents: [],
        scannerEnvOverrides: overrides,
      });
      const check = checkFrom(result, 'scan-timers-disabled');
      assert.equal(check.ok, false, `${field}="${badValue}" must fail this check`);
      assert.match(check.detail, new RegExp(field), `detail must NAME the offending field: ${check.detail}`);
    }
  }

  const okResult = recette.evaluateCrossTaskAssertions(scenario, { tasks: twoTerminalTasks(), daemonEvents: [], scannerEnvOverrides: base });
  assert.equal(checkFrom(okResult, 'scan-timers-disabled').ok, true, JSON.stringify(okResult.results));
});

// resolveScannerTimersUnderEnv -- proved DIRECTLY, against config.js's own REAL, unmodified
// resolution, not a re-implementation of its parsing this test could drift from. Two directions,
// both load-bearing:
//   1. under the "0" overrides this file actually forwards, every one of the seven fields really
//      is the NUMBER 0 (not the string "0", not left at whatever config.js's own default is).
//   2. the function is not hardcoded to always report zero regardless of input -- fed a REAL,
//      plausible non-zero baseline (what a maintainer's own live systemd drop-in might set), it
//      reports THAT value back, proving it genuinely re-reads config.js's resolution each call
//      rather than returning a canned {..all zero} object.
test('resolveScannerTimersUnderEnv: reflects config.js\'s own real resolution -- all-zero under "0" overrides, and NOT hardcoded to always report zero', () => {
  const zeroed = recette.resolveScannerTimersUnderEnv(zeroedScannerEnvOverrides());
  for (const field of ['orphanScanMs', 'unparkScanMs', 'autoPullMs', 'autoIntakeMs', 'reportConfirmScanMs', 'autoTriageMs', 'remoteReportPullMs']) {
    assert.equal(zeroed[field], 0, `${field} must resolve to the NUMBER 0 under a "0" env override, got ${JSON.stringify(zeroed[field])}`);
  }

  const nonZero = recette.resolveScannerTimersUnderEnv({
    SPO_ORPHAN_SCAN_MS: '77000',
    SPO_UNPARK_SCAN_MS: '0',
    SPO_AUTO_PULL_MS: '0',
    SPO_AUTO_INTAKE_MS: '0',
    SPO_REPORT_CONFIRM_SCAN_MS: '0',
    SPO_AUTO_TRIAGE_MS: '0',
    SPO_REMOTE_REPORT_PULL_MS: '0',
  });
  assert.equal(nonZero.orphanScanMs, 77000, 'must faithfully reflect a REAL non-zero override, not a canned all-zero answer');
  assert.equal(nonZero.unparkScanMs, 0);

  // And this process's own env is genuinely restored afterward -- resolveScannerTimersUnderEnv's
  // own save/restore around the require.cache swap must not leak into anything else.
  assert.equal(process.env.SPO_ORPHAN_SCAN_MS, undefined);
});

// Wires the two layers together: even with a scannerEnvOverrides object that HAS all seven keys
// set to the string "0" (passing layer 1), the check must still be reading config.js's own
// resolution (layer 2), not merely echoing layer 1's own string comparison back -- proven by
// checking the passing detail actually NAMES the resolved values (not a bare "ok").
test('parallel-doc-log "scan-timers-disabled": the passing detail names config.js\'s own resolved values, proving layer 2 (not just the string check) actually ran', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const okResult = recette.evaluateCrossTaskAssertions(scenario, { tasks: twoTerminalTasks(), daemonEvents: [], scannerEnvOverrides: zeroedScannerEnvOverrides() });
  const check = checkFrom(okResult, 'scan-timers-disabled');
  assert.equal(check.ok, true);
  assert.match(check.detail, /orphanScanMs/);
  assert.match(check.detail, /remoteReportPullMs/);
});

test('parallel-doc-log "zero-cross-task-writes": fails if one task\'s own journal mentions the sibling\'s taskId anywhere', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const clean = recette.evaluateCrossTaskAssertions(scenario, {
    tasks: [
      { taskId: 'recette-9401', events: [{ state: 'FINISH', event: 'finished', prNumber: 1 }], finalState: 'DONE' },
      { taskId: 'recette-9402', events: [{ state: 'FINISH', event: 'finished', prNumber: 2 }], finalState: 'DONE' },
    ],
    daemonEvents: [],
    dispatcherConfig: zeroedDispatcherConfig(),
  });
  assert.equal(checkFrom(clean, 'zero-cross-task-writes').ok, true);

  const dirty = recette.evaluateCrossTaskAssertions(scenario, {
    tasks: [
      { taskId: 'recette-9401', events: [{ state: 'IMPLEMENT', event: 'result', payload: { note: 'accidentally references recette-9402' } }], finalState: 'DONE' },
      { taskId: 'recette-9402', events: [{ state: 'FINISH', event: 'finished', prNumber: 2 }], finalState: 'DONE' },
    ],
    daemonEvents: [],
    dispatcherConfig: zeroedDispatcherConfig(),
  });
  const dirtyCheck = checkFrom(dirty, 'zero-cross-task-writes');
  assert.equal(dirtyCheck.ok, false);
  assert.match(dirtyCheck.detail, /recette-9401 mentions recette-9402/);
});

test('parallel-doc-log "real-overlap" (clock-free, record-order based): passes for genuinely overlapping worker-spawn/worker-exit RECORD ORDER, and REJECTS a hand-built SERIAL fixture', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const tasks = twoTerminalTasks().map((t, i) => ({ ...t, taskId: i === 0 ? 'recette-t1' : 'recette-t2' }));

  // `ts` fields are present (realism -- production events always carry one) but UNUSED by this
  // check now; only ARRAY POSITION matters. Deliberately left as plausible ISO strings, not
  // sorted to "help" the check, to make that point concrete.
  const overlapping = [
    { event: 'worker-spawn', id: 'recette-t1', ts: '2026-09-02T00:00:00.000Z' },
    { event: 'worker-spawn', id: 'recette-t2', ts: '2026-09-02T00:00:00.050Z' },
    { event: 'worker-exit', id: 'recette-t1', ts: '2026-09-02T00:00:00.300Z' },
    { event: 'worker-exit', id: 'recette-t2', ts: '2026-09-02T00:00:00.350Z' },
  ];
  const overlapResult = recette.evaluateCrossTaskAssertions(scenario, { tasks, daemonEvents: overlapping, dispatcherConfig: zeroedDispatcherConfig() });
  assert.equal(checkFrom(overlapResult, 'real-overlap').ok, true, JSON.stringify(overlapResult.results));

  // THE proof this assertion is not a rubber stamp: a SERIAL fixture -- task 2 is only spawned
  // (in RECORD ORDER) after task 1 has already exited. Two runs that merely both finished, never
  // actually concurrent. If this assertion cannot tell the two apart, it proves nothing.
  const serial = [
    { event: 'worker-spawn', id: 'recette-t1', ts: '2026-09-02T00:00:00.000Z' },
    { event: 'worker-exit', id: 'recette-t1', ts: '2026-09-02T00:00:00.100Z' },
    { event: 'worker-spawn', id: 'recette-t2', ts: '2026-09-02T00:00:00.200Z' },
    { event: 'worker-exit', id: 'recette-t2', ts: '2026-09-02T00:00:00.300Z' },
  ];
  const serialResult = recette.evaluateCrossTaskAssertions(scenario, { tasks, daemonEvents: serial, dispatcherConfig: zeroedDispatcherConfig() });
  assert.equal(checkFrom(serialResult, 'real-overlap').ok, false, 'a serial fixture must be REJECTED, not rubber-stamped');

  // Edge: touching (task 2's own spawn RECORD is the very next one after task 1's own exit
  // record, adjacent, no overlap possible) is still serial, not overlapping.
  const touching = [
    { event: 'worker-spawn', id: 'recette-t1', ts: '2026-09-02T00:00:00.000Z' },
    { event: 'worker-exit', id: 'recette-t1', ts: '2026-09-02T00:00:00.100Z' },
    { event: 'worker-spawn', id: 'recette-t2', ts: '2026-09-02T00:00:00.100Z' },
    { event: 'worker-exit', id: 'recette-t2', ts: '2026-09-02T00:00:00.200Z' },
  ];
  const touchingResult = recette.evaluateCrossTaskAssertions(scenario, { tasks, daemonEvents: touching, dispatcherConfig: zeroedDispatcherConfig() });
  assert.equal(checkFrom(touchingResult, 'real-overlap').ok, false);
});

// Post-verification correction: the FIRST cut of this check compared Date.parse(ts) values and
// flaked once (out of ~25 runs) when this box's Date.now() -- documented in
// orchestrator/monotonic-clock.js as jumping backward, measured -2515ms across a single 10ms
// interval -- landed a jump between two events for the SAME task, inverting their apparent
// order. This fixture reproduces exactly that shape: the record order is genuinely overlapping
// (task B's own spawn record precedes task A's own exit record), but the `ts` FIELDS, if you
// were to naively Date.parse and diff them the old way, would show task A's exit BEFORE its own
// spawn -- a clock jump a timestamp-based check cannot distinguish from "not concurrent". The
// clock-free, record-order check must still correctly report overlap=true, proving it is immune
// to the exact defect that made the old version flake.
test('parallel-doc-log "real-overlap": correctly reports overlap even when the ts FIELDS carry a clock-jump-corrupted (backward) order -- the fixture that flaked the old timestamp-based check', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const tasks = twoTerminalTasks().map((t, i) => ({ ...t, taskId: i === 0 ? 'recette-t1' : 'recette-t2' }));

  const clockJumpButGenuinelyOverlapping = [
    { event: 'worker-spawn', id: 'recette-t1', ts: '2026-09-02T00:00:00.500Z' }, // record 0
    { event: 'worker-spawn', id: 'recette-t2', ts: '2026-09-02T00:00:00.550Z' }, // record 1 -- before t1's own exit record (record 2): real overlap
    { event: 'worker-exit', id: 'recette-t1', ts: '2026-09-02T00:00:00.100Z' }, // record 2 -- ts is BEFORE t1's own spawn ts (a -2400ms class jump)
    { event: 'worker-exit', id: 'recette-t2', ts: '2026-09-02T00:00:00.800Z' }, // record 3
  ];
  const result = recette.evaluateCrossTaskAssertions(scenario, {
    tasks,
    daemonEvents: clockJumpButGenuinelyOverlapping,
    dispatcherConfig: zeroedDispatcherConfig(),
  });
  assert.equal(
    checkFrom(result, 'real-overlap').ok,
    true,
    'record order says genuine overlap; a clock-free check must report that regardless of what the corrupted ts fields say'
  );
});

// The DANGEROUS direction, named explicitly in this action's own verification: a genuinely SERIAL
// pair of tasks whose `ts` fields, corrupted by a backward clock jump, would make the OLD
// Date.parse-and-diff check report "overlap" -- worked example from that review:
//   truly serial:  A spawn 0, A exit 10,  [clock jumps back 5],  B spawn 6, B exit 16
//   old check:     a.spawn(0) < b.exit(16) true;  b.spawn(6) < a.exit(10) true  ->  "overlap" (WRONG)
// Translated into RECORD ORDER (the only thing the new check reads): A-spawn, A-exit, B-spawn,
// B-exit -- genuinely serial, B spawned only after A had already exited -- with `ts` fields set
// to reproduce exactly the numbers above. A clock-free, order-based check MUST still report
// non-overlap; if it read `ts` at all, this is precisely the input that would fool it.
test('parallel-doc-log "real-overlap": REJECTS a genuinely serial pair even when the ts fields are corrupted to look like overlap under the OLD (timestamp-based) check -- the exact false-positive shape this action\'s own verification named', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const tasks = twoTerminalTasks().map((t, i) => ({ ...t, taskId: i === 0 ? 'recette-t1' : 'recette-t2' }));

  const serialButTsLooksLikeOverlap = [
    { event: 'worker-spawn', id: 'recette-t1', ts: '2026-09-02T00:00:00.000Z' }, // record 0, ts=0
    { event: 'worker-exit', id: 'recette-t1', ts: '2026-09-02T00:00:00.010Z' }, // record 1, ts=10 -- A genuinely exits before B is ever spawned (record order)
    { event: 'worker-spawn', id: 'recette-t2', ts: '2026-09-02T00:00:00.006Z' }, // record 2, ts=6 (a -5ms class backward jump vs record 1's ts=10)
    { event: 'worker-exit', id: 'recette-t2', ts: '2026-09-02T00:00:00.016Z' }, // record 3, ts=16
  ];
  // Sanity: this IS the exact false-positive shape -- confirm the naive Date.parse-and-diff
  // arithmetic the old check used really would have said "overlap" for these ts values, so this
  // test is provably exercising the danger it claims to.
  const aSpawnTs = Date.parse(serialButTsLooksLikeOverlap[0].ts);
  const aExitTs = Date.parse(serialButTsLooksLikeOverlap[1].ts);
  const bSpawnTs = Date.parse(serialButTsLooksLikeOverlap[2].ts);
  const bExitTs = Date.parse(serialButTsLooksLikeOverlap[3].ts);
  assert.ok(aSpawnTs < bExitTs && bSpawnTs < aExitTs, 'fixture sanity: the OLD timestamp-diff arithmetic must read this as "overlap" for this test to prove anything');

  const result = recette.evaluateCrossTaskAssertions(scenario, {
    tasks,
    daemonEvents: serialButTsLooksLikeOverlap,
    dispatcherConfig: zeroedDispatcherConfig(),
  });
  assert.equal(
    checkFrom(result, 'real-overlap').ok,
    false,
    'record order says genuinely serial; the clock-free check must reject this regardless of what the corrupted ts fields would have implied'
  );
});

test('parallel-doc-log "real-overlap": fails cleanly (not a thrown error) when worker-spawn/worker-exit records are missing entirely', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const tasks = twoTerminalTasks().map((t, i) => ({ ...t, taskId: i === 0 ? 'recette-t1' : 'recette-t2' }));
  const result = recette.evaluateCrossTaskAssertions(scenario, { tasks, daemonEvents: [], dispatcherConfig: zeroedDispatcherConfig() });
  const check = checkFrom(result, 'real-overlap');
  assert.equal(check.ok, false);
  assert.match(check.detail, /missing worker-spawn\/worker-exit record/);
});

// The "corrupt event order" branch -- a task's own worker-exit record appearing at or before its
// own worker-spawn record. Impossible by construction from a real dispatcher (handleExit always
// runs strictly after spawnOne for the same id), so this only models a fixture bug or genuine
// file corruption -- but the branch exists and must report its own distinct, honest verdict
// rather than silently reading as "not overlapping" (which would send a reader hunting a
// concurrency bug that was never there).
test('parallel-doc-log "real-overlap": a task\'s own worker-exit record before its own worker-spawn record is reported as corrupt order, not as "not overlapping"', () => {
  const scenario = recette.SCENARIOS['parallel-doc-log'];
  const tasks = twoTerminalTasks().map((t, i) => ({ ...t, taskId: i === 0 ? 'recette-t1' : 'recette-t2' }));
  const corrupt = [
    { event: 'worker-exit', id: 'recette-t1' }, // record 0 -- exit BEFORE this task's own spawn record
    { event: 'worker-spawn', id: 'recette-t1' }, // record 1
    { event: 'worker-spawn', id: 'recette-t2' }, // record 2
    { event: 'worker-exit', id: 'recette-t2' }, // record 3
  ];
  const result = recette.evaluateCrossTaskAssertions(scenario, { tasks, daemonEvents: corrupt, dispatcherConfig: zeroedDispatcherConfig() });
  const check = checkFrom(result, 'real-overlap');
  assert.equal(check.ok, false);
  assert.match(check.detail, /corrupt event order/);
});

// ---------------------------------------------------------------------------------------------
// cleanupMultiTask -- per-task GitHub artifact steps, ONE shared run-dir step (not one per task)
// ---------------------------------------------------------------------------------------------

test('cleanupMultiTask: one githubArtifactSteps pass per task, but exactly ONE journal-dir-remove step for the shared runDir', () => {
  const config = recette.resolveConfig(baseOpts());
  fs.mkdirSync(config.runDir, { recursive: true });
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push([command, ...args].join(' '));
      return ok('');
    },
  };

  const report = recette.cleanupMultiTask({
    scenario: recette.SCENARIOS['parallel-doc-log'],
    config,
    deps,
    tasks: [
      { issueNumber: 9401, prNumber: 4401, wipRefs: [] },
      { issueNumber: 9402, prNumber: 4402, wipRefs: [] },
    ],
  });

  assert.equal(report.perTask.length, 2);
  assert.deepEqual(
    report.perTask[0].steps.map((s) => s.name),
    ['worktree-remove', 'worktree-prune', 'branch-delete-local', 'branch-delete-remote', 'pr-close', 'issue-close']
  );
  assert.deepEqual(
    report.perTask[1].steps.map((s) => s.name),
    ['worktree-remove', 'worktree-prune', 'branch-delete-local', 'branch-delete-remote', 'pr-close', 'issue-close']
  );
  assert.equal(report.runDirStep.name, 'journal-dir-remove');
  assert.equal(report.anyFailed, false);
  assert.equal(fs.existsSync(config.runDir), false);

  // exactly one issue-close call per task, addressed to the right issue number -- proves the
  // per-task loop is not accidentally sharing state between iterations.
  assert.ok(calls.some((c) => c.includes('issue close 9401')));
  assert.ok(calls.some((c) => c.includes('issue close 9402')));
});

test('cleanupMultiTask: keepRunDir keeps the shared dir once, not once per task', () => {
  const config = recette.resolveConfig(baseOpts());
  fs.mkdirSync(config.runDir, { recursive: true });
  const deps = { spawnSync: () => ok('') };

  const report = recette.cleanupMultiTask({
    scenario: recette.SCENARIOS['parallel-doc-log'],
    config,
    deps,
    tasks: [{ issueNumber: 9401, prNumber: null, wipRefs: [] }],
    keepRunDir: true,
  });

  assert.equal(report.runDirStep.name, 'journal-dir-kept');
  assert.equal(fs.existsSync(config.runDir), true);
});

// ---------------------------------------------------------------------------------------------
// sumLlmSteps / allTasksTerminal -- the disk reads the out-of-process cap watchdog is built on
// ---------------------------------------------------------------------------------------------

test('sumLlmSteps: counts llm-call events across every taskDir, ignores everything else (dry-run included)', () => {
  const journalRoot = mkTmp('spo-recette-sum-');
  fs.mkdirSync(path.join(journalRoot, 'recette-a'), { recursive: true });
  fs.mkdirSync(path.join(journalRoot, 'recette-b'), { recursive: true });
  fs.writeFileSync(
    path.join(journalRoot, 'recette-a', 'journal.jsonl'),
    [{ state: 'PLAN', event: 'llm-call' }, { state: 'IMPLEMENT', event: 'llm-call' }, { state: 'PLAN', event: 'dry-run' }]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n'
  );
  fs.writeFileSync(path.join(journalRoot, 'recette-b', 'journal.jsonl'), [{ state: 'PLAN', event: 'llm-call' }].map((e) => JSON.stringify(e)).join('\n') + '\n');

  assert.equal(recette.sumLlmSteps(journalRoot, ['recette-a', 'recette-b']), 3);
  assert.equal(recette.sumLlmSteps(journalRoot, ['recette-a']), 2);
  assert.equal(recette.sumLlmSteps(journalRoot, ['does-not-exist']), 0);
});

test('allTasksTerminal: true only once every task is DONE/PARKED/ABANDONED', () => {
  const journalRoot = mkTmp('spo-recette-terminal-');
  fs.mkdirSync(path.join(journalRoot, 'recette-a'), { recursive: true });
  fs.mkdirSync(path.join(journalRoot, 'recette-b'), { recursive: true });
  fs.writeFileSync(path.join(journalRoot, 'recette-a', 'state.json'), JSON.stringify({ state: 'DONE' }));
  fs.writeFileSync(path.join(journalRoot, 'recette-b', 'state.json'), JSON.stringify({ state: 'IMPLEMENT' }));

  assert.equal(recette.allTasksTerminal(journalRoot, ['recette-a', 'recette-b']), false);

  fs.writeFileSync(path.join(journalRoot, 'recette-b', 'state.json'), JSON.stringify({ state: 'PARKED' }));
  assert.equal(recette.allTasksTerminal(journalRoot, ['recette-a', 'recette-b']), true);

  assert.equal(recette.allTasksTerminal(journalRoot, ['does-not-exist']), false);
});

// ---------------------------------------------------------------------------------------------
// runDispatcherCapWatchdog -- the out-of-process cap. Unit tests first (a fake dispatcher stub,
// hand-built journal/state fixtures -- same "hand-built journal" philosophy this file's own
// evaluateAssertions tests already use), then two integration tests against a REAL createDispatcher
// with real spawned children (shadow mode) proving the wall-clock trip actually kills a live
// worker before it can finish, and that the natural-completion path really lets a real dispatcher
// stop on its own.
// ---------------------------------------------------------------------------------------------

function fakeDispatcher() {
  const stopCalls = [];
  const killCalls = [];
  return {
    stop: (r) => stopCalls.push(r),
    killAllChildren: (sig) => killCalls.push(sig),
    stopCalls,
    killCalls,
  };
}

test('runDispatcherCapWatchdog: the full capLlmSteps budget is PERMITTED (never trips at exactly the cap); trips only once a (capLlmSteps+1)th call lands -- matches makeCap\'s own permitted-call count', async () => {
  const journalRoot = mkTmp('spo-recette-wd-llm-');
  const taskId = 'recette-9500';
  fs.mkdirSync(path.join(journalRoot, taskId), { recursive: true });
  // Both of the PERMITTED 2 calls (capLlmSteps: 2) already on disk before the watchdog even
  // starts -- post-verification correction: this used to trip the INSTANT the journal showed
  // exactly capLlmSteps calls, which would kill a run that had used its full, legitimate budget
  // and needed no further call at all. makeCap's own wrapSpawnSync permits exactly capLlmSteps
  // calls (refuses only the (capLlmSteps+1)th); this watchdog must agree.
  fs.writeFileSync(
    path.join(journalRoot, taskId, 'journal.jsonl'),
    [{ state: 'PLAN', event: 'llm-call' }, { state: 'IMPLEMENT', event: 'llm-call' }].map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  fs.writeFileSync(path.join(journalRoot, taskId, 'state.json'), JSON.stringify({ state: 'IMPLEMENT' })); // not terminal

  const dispatcher = fakeDispatcher();
  let settled = null;
  const watchdogPromise = recette
    .runDispatcherCapWatchdog({ dispatcher, journalRoot, taskIds: [taskId], capMs: 60000, capLlmSteps: 2, mono: () => Date.now(), pollMs: 10 })
    .then((r) => {
      settled = r;
    });

  // Several poll ticks with exactly the PERMITTED 2 calls already on disk -- proves the watchdog
  // does not trip on a run that has used its whole legitimate budget and might still finish on
  // its own with no further call.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dispatcher.stopCalls.length, 0, 'must not trip on exactly capLlmSteps calls');
  assert.equal(settled, null);

  // The (capLlmSteps+1)th event -- an OVER-cap call -- written from a side channel exactly the
  // way a REAL worker process (a separate OS process) would append it. This is what the watchdog
  // can only ever observe AFTER the fact (see runDispatcherCapWatchdog's own header for why that
  // is honestly weaker than makeCap's in-process refusal).
  fs.appendFileSync(path.join(journalRoot, taskId, 'journal.jsonl'), JSON.stringify({ state: 'IMPLEMENT', event: 'llm-call' }) + '\n');

  await watchdogPromise;
  assert.ok(settled.tripped, 'must have tripped once the 3rd (over-cap) llm-call event landed on disk');
  assert.equal(settled.tripped.reason, 'llm-step-cap-exceeded');
  assert.equal(settled.llmSteps, 3);
  assert.equal(dispatcher.stopCalls.length, 1);
  assert.equal(dispatcher.stopCalls[0].reason, 'llm-step-cap-exceeded');
  assert.deepEqual(dispatcher.killCalls, ['SIGTERM']);
});

test('runDispatcherCapWatchdog: wall-clock cap trips on the poll that crosses it, never on the one before (fake mono clock, same boundary proof as makeCap\'s own test)', async () => {
  const journalRoot = mkTmp('spo-recette-wd-wc-');
  const taskId = 'recette-9600';
  fs.mkdirSync(path.join(journalRoot, taskId), { recursive: true });
  fs.writeFileSync(path.join(journalRoot, taskId, 'state.json'), JSON.stringify({ state: 'IMPLEMENT' }));

  const dispatcher = fakeDispatcher();
  const start = 1_000_000;
  // First poll: 0ms elapsed (fine). Second poll: 0ms elapsed (fine, and not yet terminal so it
  // loops again). Third poll: 2000ms elapsed -- over the 1000ms cap.
  const sequence = [start, start, start + 2000];
  let i = 0;
  const mono = () => sequence[Math.min(i++, sequence.length - 1)];

  const result = await recette.runDispatcherCapWatchdog({ dispatcher, journalRoot, taskIds: [taskId], capMs: 1000, capLlmSteps: 999, mono, pollMs: 1 });

  assert.equal(result.tripped.reason, 'wall-clock-cap-exceeded');
  assert.equal(result.tripped.elapsedMs, 2000);
  assert.equal(dispatcher.stopCalls.length, 1);
  assert.equal(dispatcher.stopCalls[0].reason, 'wall-clock-cap-exceeded');
  assert.deepEqual(dispatcher.killCalls, ['SIGTERM']);
});

test('runDispatcherCapWatchdog: resolves UNTRIPPED, no kill, the moment every task is terminal', async () => {
  const journalRoot = mkTmp('spo-recette-wd-done-');
  fs.mkdirSync(path.join(journalRoot, 'recette-a'), { recursive: true });
  fs.mkdirSync(path.join(journalRoot, 'recette-b'), { recursive: true });
  fs.writeFileSync(path.join(journalRoot, 'recette-a', 'state.json'), JSON.stringify({ state: 'DONE' }));
  fs.writeFileSync(path.join(journalRoot, 'recette-b', 'state.json'), JSON.stringify({ state: 'PARKED' }));

  const dispatcher = fakeDispatcher();
  const result = await recette.runDispatcherCapWatchdog({
    dispatcher,
    journalRoot,
    taskIds: ['recette-a', 'recette-b'],
    capMs: 60000,
    capLlmSteps: 999,
    mono: () => Date.now(),
    pollMs: 5,
  });

  assert.equal(result.tripped, null);
  assert.equal(dispatcher.stopCalls.length, 1);
  assert.deepEqual(dispatcher.stopCalls[0], { reason: 'recette-scenario-complete' });
  assert.equal(dispatcher.killCalls.length, 0, 'a clean finish must never call killAllChildren');
});

// ---------------------------------------------------------------------------------------------
// The dangling-promise fix (post-verification correction): `runDispatcherScenario` used to race
// `dispatcher.run()` against the watchdog with a bare `Promise.all`. If `run()` rejected (a bug,
// never an expected outcome), the watchdog kept polling for up to `capMs` with nothing left to
// coordinate with, and `dispatcher.stop()` was never called. Proven here with a FAKE dispatcher
// whose own `run()` rejects immediately and a deliberately HUGE capMs (1 hour) -- if the fix
// regressed, this test would hang for that long (or time out) instead of failing promptly and
// legibly.
// ---------------------------------------------------------------------------------------------

test(
  "runDispatcherScenario: if dispatcher.run() rejects, the run resolves PROMPTLY (not by waiting out capMs) and still tears the dispatcher down",
  { timeout: 10000 },
  async () => {
    const stopCalls = [];
    const killCalls = [];
    const fakeDispatcher = {
      run: () => Promise.reject(new Error('boom -- simulated dispatcher.run() failure')),
      stop: (r) => stopCalls.push(r),
      killAllChildren: (sig) => killCalls.push(sig),
    };
    const createDispatcherFn = () => fakeDispatcher;

    let nextIssue = 9950;
    const spawnSync = (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return ok(`https://github.com/Crazz-Org/SPO-WebClient/issues/${nextIssue++}\n`);
      return fail(1, 'unexpected');
    };

    const customScenario = {
      name: 'dangling-proof',
      label: 'spo-recette',
      driver: 'dispatcher',
      k: 1,
      capMs: 60 * 60 * 1000, // 1 hour -- deliberately huge; a regression would make this test hang/time out instead of failing cleanly
      capLlmSteps: 999,
      buildCard: () => ({ title: '[test] dangling-proof', body: '## Done means\n\nnothing.\n' }),
      assertions: [],
    };

    const config = recette.resolveConfig(
      { recetteDir: mkTmp('spo-recette-dangling-run-'), productJournalRoot: mkTmp('spo-recette-dangling-pj-'), accountsDir: poolDir(1) },
      customScenario
    );
    const plan = recette.buildPlan(customScenario, config);

    const startedAt = Date.now();
    const result = await recette.runDispatcherScenario(customScenario, config, plan, { keep: true }, { spawnSync, createDispatcher: createDispatcherFn });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 5000, `must resolve promptly, not wait out the 1-hour capMs -- took ${elapsedMs}ms`);
    assert.ok(result.error && result.error.message.includes('boom'), JSON.stringify(result.error));
    assert.ok(stopCalls.length > 0, 'the finally teardown must have called dispatcher.stop() even though run() rejected');
    assert.ok(killCalls.length > 0, 'the finally teardown must have called dispatcher.killAllChildren() even though run() rejected');
  }
);

// ---- integration: a REAL createDispatcher, real spawned children (shadow mode) ----------------

test(
  'runDispatcherCapWatchdog against a REAL dispatcher: the wall-clock cap really kills a live worker before its (long) delay elapses',
  { timeout: 20000 },
  async () => {
    const queueDir = mkTmp('spo-recette-realwd-q-');
    const journalDir = mkTmp('spo-recette-realwd-j-');
    writeTask(queueDir, '0001-a.json', slowCardTask('recette-cap-a', 5000)); // 5s -- must never finish inside the tiny cap below

    const config = { ...dispatcherBaseConfig({ claudeAccountsDir: poolDir(1) }), deps: { spawn: spawnIsolated, spawnScanner: neverExitsSpawn } };
    const dispatcher = createDispatcher(queueDir, journalDir, config);

    const runPromise = dispatcher.run();
    const watchdogResult = await recette.runDispatcherCapWatchdog({
      dispatcher,
      journalRoot: journalDir,
      taskIds: ['recette-cap-a'],
      capMs: 150,
      capLlmSteps: 999,
      pollMs: 20,
    });
    await runPromise;

    assert.equal(watchdogResult.tripped.reason, 'wall-clock-cap-exceeded');
    // THE proof this is real, not merely reported: the task never reached DONE. Its worker really
    // got SIGTERM'd mid-flight (5000ms IMPLEMENT delay, ~150ms cap) -- this is the dispatcher
    // driver's own version of "the (capLlmSteps+1)th spawn never happens": the task never got to
    // finish. recette.readStateSafe (never test/helpers.js's own readState, which throws ENOENT)
    // -- a real, boot-time-variable process can plausibly get killed by a ~150ms cap before it
    // has written state.json at all; "no state.json yet" is exactly as much "not DONE" as a
    // state.json that says something else, and must not read as a test failure (measured: this
    // exact spot threw ENOENT under contention before this fix).
    const state = recette.readStateSafe(journalDir, 'recette-cap-a');
    assert.notEqual(state && state.state, 'DONE', 'a real wall-clock trip must kill the worker before its own delay elapses');
  }
);

test(
  'runDispatcherCapWatchdog against a REAL dispatcher: a generous cap lets two real workers finish naturally, untripped',
  { timeout: 20000 },
  async () => {
    const queueDir = mkTmp('spo-recette-realwd2-q-');
    const journalDir = mkTmp('spo-recette-realwd2-j-');
    writeTask(queueDir, '0001-a.json', slowCardTask('recette-nat-a', 100));
    writeTask(queueDir, '0002-b.json', slowCardTask('recette-nat-b', 100));

    const config = { ...dispatcherBaseConfig({ workers: 2, claudeAccountsDir: poolDir(2) }), deps: { spawn: spawnIsolated, spawnScanner: neverExitsSpawn } };
    const dispatcher = createDispatcher(queueDir, journalDir, config);

    const runPromise = dispatcher.run();
    const watchdogResult = await recette.runDispatcherCapWatchdog({
      dispatcher,
      journalRoot: journalDir,
      taskIds: ['recette-nat-a', 'recette-nat-b'],
      capMs: 15000,
      capLlmSteps: 999,
      pollMs: 20,
    });
    await runPromise;

    assert.equal(watchdogResult.tripped, null);
    assert.equal(readState(journalDir, 'recette-nat-a').state, 'DONE');
    assert.equal(readState(journalDir, 'recette-nat-b').state, 'DONE');
  }
);

// ---------------------------------------------------------------------------------------------
// computeDispatcherOk -- the dispatcher driver's overall-`ok` decision, pulled out as a pure
// function (post-verification correction) specifically so each of its four terms is pinned by
// its OWN direct test, independent of how hard (or impossible) it is to isolate that term inside
// a full end-to-end run: capTripped and "every task reached DONE" are close to mutually exclusive
// by construction (a trip kills children before they finish), so an end-to-end run can almost
// never isolate capTripped alone the way it can isolate a failing crossTaskAssertion alone (see
// the dedicated end-to-end test further below for that half). A baseline of all-true/no-error
// inputs is `true`; each test below flips exactly ONE term off it.
// ---------------------------------------------------------------------------------------------

function passingDispatcherOkInputs() {
  return {
    runError: null,
    capTripped: null,
    perTaskOk: true,
    crossTaskAssertions: { ok: true, results: [] },
  };
}

test('computeDispatcherOk: all four terms passing -> true', () => {
  assert.equal(recette.computeDispatcherOk(passingDispatcherOkInputs()), true);
});

test('computeDispatcherOk: runError alone -> false', () => {
  assert.equal(recette.computeDispatcherOk({ ...passingDispatcherOkInputs(), runError: new Error('boom') }), false);
});

test('computeDispatcherOk: capTripped alone -> false', () => {
  assert.equal(recette.computeDispatcherOk({ ...passingDispatcherOkInputs(), capTripped: { reason: 'wall-clock-cap-exceeded' } }), false);
});

test('computeDispatcherOk: perTaskOk=false alone -> false', () => {
  assert.equal(recette.computeDispatcherOk({ ...passingDispatcherOkInputs(), perTaskOk: false }), false);
});

test('computeDispatcherOk: a failing crossTaskAssertions.ok alone -> false', () => {
  assert.equal(recette.computeDispatcherOk({ ...passingDispatcherOkInputs(), crossTaskAssertions: { ok: false, results: [] } }), false);
});

test('computeDispatcherOk: crossTaskAssertions=null (a k=1 scenario with none declared) does not itself force false', () => {
  assert.equal(recette.computeDispatcherOk({ ...passingDispatcherOkInputs(), crossTaskAssertions: null }), true);
});

// ---------------------------------------------------------------------------------------------
// A failing crossTaskAssertion as the SOLE cause of a non-zero exit, proven end to end through
// the real runRecette entry point -- not just the pure computeDispatcherOk unit above. Both
// tasks reach DONE and their own (trivial, shadow-compatible) per-task assertion passes; only
// the deliberately-forced-failing crossTaskAssertion makes result.ok false. This is the scenario
// the review found NO test exercised: the only prior test asserting result.ok on the dispatcher
// path used a fixture where perTaskOk was already false for an unrelated (shadow-incompatibility)
// reason, making capTripped/crossTaskAssertions.ok invisible to it.
// ---------------------------------------------------------------------------------------------

test("runRecette (dispatcher driver): a failing crossTaskAssertion is the SOLE cause of result.ok=false -- both cards reach DONE and their own per-task assertion passes", { timeout: 20000 }, async () => {
  const customName = `cross-fail-proof-${Date.now()}`;
  recette.SCENARIOS[customName] = {
    name: customName,
    label: 'spo-recette',
    driver: 'dispatcher',
    k: 2,
    capMs: 15000,
    capLlmSteps: 999,
    // Deliberately trivial and shadow-compatible (unlike TRIVIAL_DOC_LOG_ASSERTIONS' own
    // 'validate-got-real-diff'/'finished', which are structurally real-mode-only -- see the full
    // end-to-end parallel-doc-log test's own header) -- this scenario exists ONLY to isolate the
    // cross-task term, so its own per-task assertion must be trivially satisfiable under shadow.
    buildCard: ({ runId, index }) => ({ title: `[test] ${customName} ${index}`, body: '## Done means\n\nnothing.\n' }),
    assertions: [{ id: 'reached-done', description: 'reached DONE', check: ({ finalState }) => ({ ok: finalState === 'DONE', detail: finalState }) }],
    crossTaskAssertions: [{ id: 'always-fails', description: 'forced failure to isolate the cross-task term', check: () => ({ ok: false, detail: 'forced' }) }],
  };

  try {
    let nextIssue = 9800;
    const spawnSync = (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return ok(`https://github.com/Crazz-Org/SPO-WebClient/issues/${nextIssue++}\n`);
      if (command === 'git') return fail(1, "fatal: 'x' is not a working tree");
      if (command === 'gh') return fail(1, 'Could not resolve to a PullRequest');
      throw new Error(`unhandled fake call: ${command} ${JSON.stringify(args)}`);
    };

    const opts = {
      ...baseOpts(),
      scenario: customName,
      configOverrides: {
        shadowMode: true,
        real: false,
        pollIntervalMs: 30,
        claudeAccountsDir: poolDir(2),
        pipelineWorktreesDir: mkTmp('spo-recette-crossfail-wt-'),
        productRepo: mkTmp('spo-recette-crossfail-product-'),
      },
      // Full shadow LLM fixtures required -- see the full parallel-doc-log end-to-end test's own
      // header: without a `shadow.llm.PLAN`/`IMPLEMENT` fixture, handlePlan/handleImplement take
      // state-machine.js's own "no fixture -> {ok:true}" shortcut, which for IMPLEMENT means an
      // absent/unparsable files_changed -- routed to DIAGNOSE, which (also fixture-less) never
      // reaches a verdict either, and the run PARKS instead of reaching DONE. Measured directly:
      // this test parked every time without these fixtures, which the assertion above would have
      // caught (t.finalState !== 'DONE') but for the wrong reason -- not proving this test's own
      // point at all.
      taskOverrides: {
        shadow: {
          gate: [0],
          prWait: [0],
          llm: {
            PLAN: STEP_PAYLOADS['plan_markdown,invariants_markdown,invariant_ids,check_commands'],
            IMPLEMENT: STEP_PAYLOADS['summary,files_changed,invariants,tests_run,all_green'],
            VALIDATE: STEP_PAYLOADS['verdict,reasons,findings'],
          },
          delays: { IMPLEMENT: 50 },
        },
      },
    };

    const result = await recette.runRecette(opts, { spawnSync });

    assert.equal(result.tasks.length, 2);
    for (const t of result.tasks) {
      assert.equal(t.finalState, 'DONE', JSON.stringify(t));
      assert.equal(t.assertions.ok, true, JSON.stringify(t.assertions));
    }
    assert.equal(result.crossTaskAssertions.ok, false);
    assert.equal(result.capTripped, null);
    assert.equal(result.error, null);
    assert.equal(result.ok, false, 'result.ok must be false -- SOLELY because of the forced-failing crossTaskAssertion');
  } finally {
    delete recette.SCENARIOS[customName];
  }
});

// ---- integration: real-overlap, end to end against a REAL dispatcher --------------------------

test(
  'parallel-doc-log "real-overlap" + "zero-auto-pull" + "scan-timers-disabled" + "zero-cross-task-writes", proven against a REAL dispatcher run (two genuinely concurrent workers)',
  { timeout: 20000 },
  async () => {
    const queueDir = mkTmp('spo-recette-realov-q-');
    const journalDir = mkTmp('spo-recette-realov-j-');
    writeTask(queueDir, '0001-a.json', slowCardTask('recette-ov-a', 200));
    writeTask(queueDir, '0002-b.json', slowCardTask('recette-ov-b', 200));

    const dispatcherConfig = {
      ...dispatcherBaseConfig({ workers: 2, claudeAccountsDir: poolDir(2) }),
      deps: { spawn: spawnIsolated, spawnScanner: neverExitsSpawn },
    };
    const dispatcher = createDispatcher(queueDir, journalDir, dispatcherConfig);

    const runPromise = dispatcher.run();
    const watchdogResult = await recette.runDispatcherCapWatchdog({
      dispatcher,
      journalRoot: journalDir,
      taskIds: ['recette-ov-a', 'recette-ov-b'],
      capMs: 15000,
      capLlmSteps: 999,
      pollMs: 20,
    });
    await runPromise;

    assert.equal(watchdogResult.tripped, null, 'must finish naturally, not by cap');
    assert.equal(readState(journalDir, 'recette-ov-a').state, 'DONE');
    assert.equal(readState(journalDir, 'recette-ov-b').state, 'DONE');

    const daemonEvents = recette.readDaemonEvents(journalDir);
    // scannerEnvOverrides is hand-supplied here (this test drives createDispatcher directly, not
    // through runDispatcherScenario, so no real env forwarding happened) -- it exercises the
    // CHECK's own wiring against real daemon-event data, not the forwarding mechanism itself; see
    // the dedicated "really forwards the seven scan-timer env vars to a REAL spawned scanner
    // process" test below for that proof, and this section's own unit tests above for the check
    // logic in isolation.
    const result = recette.evaluateCrossTaskAssertions(recette.SCENARIOS['parallel-doc-log'], {
      tasks: [
        { taskId: 'recette-ov-a', events: recette.readJournalEvents(journalDir, 'recette-ov-a'), finalState: 'DONE' },
        { taskId: 'recette-ov-b', events: recette.readJournalEvents(journalDir, 'recette-ov-b'), finalState: 'DONE' },
      ],
      daemonEvents,
      dispatcherConfig: zeroedDispatcherConfig(),
      scannerEnvOverrides: zeroedScannerEnvOverrides(),
    });

    assert.equal(checkFrom(result, 'real-overlap').ok, true, JSON.stringify(result.results));
    assert.equal(checkFrom(result, 'zero-cross-task-writes').ok, true, JSON.stringify(result.results));
    assert.equal(checkFrom(result, 'zero-auto-pull').ok, true, JSON.stringify(result.results));
    assert.equal(checkFrom(result, 'scan-timers-disabled').ok, true, JSON.stringify(result.results));
    assert.equal(result.ok, true, JSON.stringify(result.results));
  }
);

// ---------------------------------------------------------------------------------------------
// SHIP-BLOCKER PROOF (post-verification correction): runDispatcherScenario really forwards the
// seven scan-timer env vars to a REAL, separately spawned OS process -- not merely to the JS
// config object createDispatcher reads in THIS process. This is the behavioral half the earlier
// 'scan-timers-disabled' assertion (checked only against `dispatcherConfig`) could never prove,
// because the scanner never read that object at all -- see this file's own "Scanner timer
// forwarding" header in orchestrator/recette.js for the full mechanism.
//
// Drives runDispatcherScenario directly (the REAL, unmodified function `spo recette` itself
// calls) with a real spawned "scanner" -- via dispatcher.js's own `deps.spawnScanner` seam, the
// SAME test-only injection point test/dispatcher.test.js's own neverExitsSpawn uses -- that does
// nothing except dump its own inherited process.env to a file. PROVES THE OVERRIDE, not merely
// its absence: this process's own env is first set to REALISTIC, PLAUSIBLE NON-ZERO values (the
// shape a maintainer's own live systemd drop-in might carry) before the call, so a passing
// assertion means "these seven vars were actively forced to 0", not "they merely happened to be
// unset already".
//
// ISOLATION IS LOAD-BEARING, NOT TIDY (context from this action's own verification): mutating
// trivial-doc-log's driver to 'dispatcher' during that pass -- with productRepo/
// pipelineWorktreesDir left at their real defaults -- created an ACTUAL worktree and branch in
// the maintainer's live ~/SPO-WebClient and ran a real `npm ci`, because test/no-real-spawn.js's
// guard patches ONLY the synchronous, IN-PROCESS child_process.spawnSync (see that module's own
// "scope: spawnSync only" header) -- it cannot and does not reach a spawned CHILD process, which
// is exactly what every dispatcher-driver test spawns. Every dispatcher-driver test in this file,
// this one included, therefore sets productRepo/pipelineWorktreesDir to a fresh mkTmp() (via
// dispatcherBaseConfig/configOverrides) -- never the real default -- as the thing that actually
// keeps it hermetic, with shadowMode as a second, independent line of defense for the WORKER
// specifically (irrelevant to the scanner stand-in used here, which never reads config at all).
// ---------------------------------------------------------------------------------------------

test(
  'runDispatcherScenario really forwards the seven scan-timer env vars to a REAL spawned scanner process (not just to the JS config object) -- the SHIP-BLOCKER this action\'s own verification found',
  { timeout: 20000 },
  async () => {
    const outDir = mkTmp('spo-recette-envproof-out-');
    const outFile = path.join(outDir, 'env-dump.json');

    // A real, tiny node process standing in for the scanner (dispatcher.js's own
    // `deps.spawnScanner` seam) that does nothing except dump the seven env vars it actually
    // inherited to a file, then self-terminate once orphaned -- same technique as
    // test/dispatcher.test.js's own neverExitsSpawn, so it never leaks past this test.
    const envDumpScript = [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
      ...recette.SCANNER_TIMER_ENV_VARS.map((k) => `  ${JSON.stringify(k)}: process.env[${JSON.stringify(k)}],`),
      '}));',
      'const p = process.ppid;',
      'setInterval(() => { if (process.ppid !== p) process.exit(0); }, 50);',
    ].join('\n');
    const spawnScannerDump = (cmd, args, opts) => realSpawn(process.execPath, ['-e', envDumpScript], { ...opts, stdio: 'ignore' });

    // A REALISTIC, PLAUSIBLE nonzero baseline -- what a maintainer's own live daemon's systemd
    // drop-in might already have set in the shell `spo recette` gets run from -- set on THIS
    // process's own env BEFORE calling runDispatcherScenario, so a passing assertion below proves
    // an active override, not a coincidental absence.
    const probeEnv = {
      SPO_ORPHAN_SCAN_MS: '60000',
      SPO_UNPARK_SCAN_MS: '60000',
      SPO_AUTO_PULL_MS: '300000',
      SPO_AUTO_INTAKE_MS: '900000',
      SPO_REPORT_CONFIRM_SCAN_MS: '300000',
      SPO_AUTO_TRIAGE_MS: '900000',
      SPO_REMOTE_REPORT_PULL_MS: '300000',
    };
    const savedProbeEnv = {};
    for (const [k, v] of Object.entries(probeEnv)) {
      savedProbeEnv[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      let nextIssue = 9900;
      const spawnSync = (command, args) => {
        if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return ok(`https://github.com/Crazz-Org/SPO-WebClient/issues/${nextIssue++}\n`);
        if (command === 'git') return fail(1, "fatal: 'x' is not a working tree");
        if (command === 'gh') return fail(1, 'Could not resolve to a PullRequest');
        throw new Error(`unhandled fake call: ${command} ${JSON.stringify(args)}`);
      };

      // k=1, a tiny cap, shadow mode for the worker (irrelevant to the scanner stand-in, but keeps
      // the WORKER side hermetic too) -- this test's only job is proving the env forward, not
      // driving a card to DONE.
      const customScenario = {
        name: 'env-proof',
        label: 'spo-recette',
        driver: 'dispatcher',
        k: 1,
        capMs: 3000,
        capLlmSteps: 1,
        buildCard: () => ({ title: '[test] env-proof', body: '## Done means\n\nnothing.\n' }),
        assertions: [],
      };
      const config = recette.resolveConfig(
        {
          recetteDir: mkTmp('spo-recette-envproof-run-'),
          productJournalRoot: mkTmp('spo-recette-envproof-pj-'),
          accountsDir: poolDir(1),
          configOverrides: {
            shadowMode: true,
            real: false,
            pollIntervalMs: 30,
            pipelineWorktreesDir: mkTmp('spo-recette-envproof-wt-'),
            productRepo: mkTmp('spo-recette-envproof-product-'),
          },
        },
        customScenario
      );
      const plan = recette.buildPlan(customScenario, config);

      await recette.runDispatcherScenario(customScenario, config, plan, { keep: true }, { spawnSync, spawn: spawnIsolated, spawnScanner: spawnScannerDump });

      await waitFor(() => fs.existsSync(outFile), 8000);
      const dumped = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      for (const key of recette.SCANNER_TIMER_ENV_VARS) {
        assert.equal(dumped[key], '0', `${key} must have been forwarded as "0" to the REAL spawned scanner process (was ${JSON.stringify(dumped[key])}, this test's own probe baseline was ${JSON.stringify(probeEnv[key])})`);
      }

      // And this process's OWN env is genuinely restored afterward -- the forwarding must not
      // leak past the span it is supposed to cover.
      for (const key of recette.SCANNER_TIMER_ENV_VARS) {
        assert.equal(process.env[key], probeEnv[key], `${key} must be restored to this test's own probe baseline after runDispatcherScenario returns`);
      }
    } finally {
      for (const [k, v] of Object.entries(savedProbeEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
);

// ---------------------------------------------------------------------------------------------
// runRecette('parallel-doc-log') end to end -- shadow-mode workers via opts.configOverrides
// (TEST-ONLY -- see resolveConfig's own header for the identical posture; bin/spo never sets
// this), driven through the exact same runRecette entry point `spo recette` itself calls. Proves
// the whole driver:'dispatcher' path -- createIssue x2, enqueueTask x2, the real dispatcher, the
// out-of-process watchdog, per-task assertions, cross-task assertions, and cleanupMultiTask --
// wired together correctly, not just each piece in isolation.
//
// A KNOWN, DOCUMENTED BOUNDARY, not a bug: TRIVIAL_DOC_LOG_ASSERTIONS' own 'validate-got-real-diff'
// and 'finished' checks read journal events (VALIDATE's 'judge-inputs-prepared', FINISH's
// 'finished') that only steps/scripted.js's REAL-mode implementations ever journal --
// prepareJudgeInputs and realFinish's own appendEvent calls. Shadow mode's scripted steps are a
// deliberately simplified `{exit, stdoutTail}` stand-in for EVERY scripted step (see
// steps/scripted.js's own top-of-file header: "never spawns anything"), and never journal either
// event -- proven directly below by reading the real journal these workers produced. That is a
// property of THIS TEST's own choice to run hermetically in shadow mode, not of the dispatcher
// driver or of parallel-doc-log's assertions: state-machine.js's handlers (handlePlan/
// handleImplement/handleValidate/...) are the IDENTICAL code whether reached via drainQueueOnce
// (inline) or via a dispatcher-spawned `daemon.js --worker` (dispatcher) -- dispatcher.js does not
// reimplement the state machine, so a REAL-mode run through either driver journals the identical
// event shapes, and this file's own (unchanged) trivial-doc-log happy-path test already proves
// TRIVIAL_DOC_LOG_ASSERTIONS passes in full against a real-mode journal. This test's own job is
// the NEW logic parallel-doc-log adds -- the cross-task assertions -- which read only
// worker-spawn/worker-exit/auto-pull/the dispatcher config, none of which are shadow/real-gated,
// and DOES assert those pass in full, end to end, through the real runRecette entry point.
// ---------------------------------------------------------------------------------------------

test(
  "runRecette('parallel-doc-log') end to end: both cards reach DONE, cross-task assertions pass in full, per-task assertions pass except the two structurally real-mode-only ones, cleanup runs clean",
  { timeout: 20000 },
  async () => {
    let nextIssue = 9700;
    const calls = [];
    const spawnSync = (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
        return ok(`https://github.com/Crazz-Org/SPO-WebClient/issues/${nextIssue++}\n`);
      }
      // cleanup's own calls (worktree remove/prune, branch delete, pr close, issue close) -- none
      // of these artifacts were ever really created (shadow-mode workers never spawn a real
      // git/gh call), so every one of these answers "already gone", the exact classifyStep shape
      // this file's own cleanup tests already established above.
      if (command === 'git') return fail(1, "fatal: 'x' is not a working tree");
      if (command === 'gh') return fail(1, 'Could not resolve to a PullRequest');
      throw new Error(`unhandled fake call in this test: ${command} ${JSON.stringify(args)}`);
    };

    const opts = {
      ...baseOpts(),
      scenario: 'parallel-doc-log',
      configOverrides: {
        shadowMode: true,
        real: false,
        dryRun: false,
        pollIntervalMs: 30,
        claudeAccountsDir: poolDir(2), // K=2 needs 2 healthy accounts, or the dispatcher clamps K down to 1
        pipelineWorktreesDir: mkTmp('spo-recette-e2e-wt-'),
        productRepo: mkTmp('spo-recette-e2e-product-'),
      },
      // Full, realistic shadow LLM payloads -- the SAME shapes STEP_PAYLOADS uses for the
      // real-mode happy path above -- are required here, not optional: without a
      // `shadow.llm.PLAN` fixture, handlePlan's own "no fixture -> {ok:true}" shortcut
      // (state-machine.js) fires and PLAN never writes real plan/invariants files, which is
      // EXACTLY the shortcut trivial-doc-log's own 'plan-wrote-files' assertion exists to catch.
      // Reusing TRIVIAL_DOC_LOG_ASSERTIONS for parallel-doc-log (deliberately, see this file's own
      // scenario-metadata test above) means that catch applies here too.
      taskOverrides: {
        shadow: {
          gate: [0],
          prWait: [0],
          llm: {
            PLAN: STEP_PAYLOADS['plan_markdown,invariants_markdown,invariant_ids,check_commands'],
            IMPLEMENT: STEP_PAYLOADS['summary,files_changed,invariants,tests_run,all_green'],
            VALIDATE: STEP_PAYLOADS['verdict,reasons,findings'],
          },
          delays: { IMPLEMENT: 50 },
        },
      },
    };

    const result = await recette.runRecette(opts, { spawnSync });

    assert.equal(result.driver, 'dispatcher');
    assert.equal(result.k, 2);
    assert.equal(result.tasks.length, 2);

    // The two structurally shadow-incompatible assertion ids -- see this test's own header.
    const SHADOW_INCOMPATIBLE = new Set(['validate-got-real-diff', 'finished']);
    for (const t of result.tasks) {
      assert.equal(t.finalState, 'DONE', JSON.stringify(t.assertions));
      assert.ok(t.assertions, 'per-task assertions must have been evaluated');
      for (const a of t.assertions.results) {
        if (SHADOW_INCOMPATIBLE.has(a.id)) {
          assert.equal(a.ok, false, `task ${t.taskId}: "${a.id}" was expected to fail under shadow mode (see this test's header) but passed -- the boundary this test documents may have shifted`);
        } else {
          assert.equal(a.ok, true, `task ${t.taskId}: assertion "${a.id}" failed: ${a.detail}`);
        }
      }
    }

    // THE new logic this scenario adds over trivial-doc-log -- proven in full, end to end,
    // through the real runRecette entry point (not just the isolated unit/integration tests
    // above): real concurrency, zero cross-task writes, zero auto-pull, every scan timer off.
    assert.ok(result.crossTaskAssertions, 'crossTaskAssertions must have been evaluated');
    for (const a of result.crossTaskAssertions.results) {
      assert.equal(a.ok, true, `cross-task assertion "${a.id}" failed: ${a.detail}`);
    }
    assert.equal(result.crossTaskAssertions.ok, true);

    assert.equal(result.capTripped, null);
    assert.equal(result.error, null);
    // Overall `ok` is false SOLELY because of the two known shadow-incompatible per-task
    // assertions above -- not because anything this action actually built is broken.
    assert.equal(result.ok, false);

    // A "failed" run keeps its own evidence (cleanupMultiTask's own keepRunDir=!ok, same
    // contract cleanup() already has -- see this file's own cap-trip tests above).
    assert.ok(result.cleanupReport);
    assert.equal(result.cleanupReport.perTask.length, 2);
    assert.equal(result.cleanupReport.runDirStep.name, 'journal-dir-kept');
    assert.equal(fs.existsSync(result.plan.runDir), true);

    // recette's own two `gh issue create` calls actually happened, and no real spawnSync was
    // ever reached in-process for the WORKERS themselves (they are separate, shadow-mode
    // processes -- see this test's own configOverrides).
    assert.equal(calls.filter((c) => c.includes('issue create')).length, 2);
  }
);
