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

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const recette = require('../orchestrator/recette');
const { lockPath } = require('../orchestrator/lock');
const { writePoolDir, mkTmp } = require('./helpers');

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
