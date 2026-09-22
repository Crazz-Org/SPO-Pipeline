'use strict';
// Action B3.3, round 2 -- replaces round 1's file wholesale (see git history for what it looked
// like; the verifier's own experiment is quoted below).
//
// ---- what round 1 got wrong, precisely -------------------------------------------------------
//
// Round 1's seven tests called `realGate`/`realCiChecks`/`realWorktree`/`realMerge` and
// `HANDLERS.WORKTREE` DIRECTLY -- proving each function, in isolation, produces the right
// ParkSignal for the right input. That is a real fact, but it is not the fact the action asked
// for. The action's own premise is "a leg nobody has seen fire is not a branch, it is a comment"
// -- the question is whether a real card, driven through the real daemon entry point, can still
// REACH that branch at all. A direct call to the function bypasses everything upstream of it,
// including the one thing that actually routes a real task there: state-machine.js's dispatch
// from state to handler. The verifier proved this the cheap way: sever `handleWorktree`'s real-
// mode dispatch (state-machine.js:255, `return callWithDeadline(...)` -> `return 'PLAN'`) and run
// the suite. Eight tests failed. None of them were round 1's seven new ones -- they cannot see
// that cut, because none of them ever go through `handleWorktree` (or any handler) in the first
// place. The eight that DID fail (`runTask (real mode, card)` x1 in test/park-loop.test.js, four
// `recette` scenarios) all drive through `runTask`/`drainQueueOnce`, the real dispatch loop --
// which is exactly the thing this file now insists on for every leg it can reach that way.
//
// This file's property, per leg: drive `runTask` (state-machine.js's own production entry point
// -- the same function `drainQueueOnce`/`daemon.js --worker` call, and the one every other
// `runTask (real mode, card)` test in this suite already uses) with a REAL config
// (`shadowMode: false, dryRun: false`) and injected `deps.spawnSync`/`deps.leaseSleep` etc. --
// never a shadow-mode fixture, never a direct call to the step function that happens to live
// behind the state the leg belongs to. If the leg's own condition is met, `runTask` must return
// `'PARKED'` with exactly that reason in the journal's own `parked` event -- proving a real task,
// walking the real state graph, really lands there.
//
// ---- the one leg that cannot be driven this way, and why that is correct, not a gap -----------
//
// `main-red-refuse-worktree` is checked by `ctx.fixture('nightlyMainRed', false)`
// (state-machine.js:251, `handleWorktree`) BEFORE `isRealMode(ctx)` is even read. The naive
// reading -- "shadow mode gates the read" -- is WRONG, and worth stating precisely because round
// 1's own file came close to that same wrong shape: `orchestrator/fixture.js`'s
// `makeFixtureReader` reads `task.shadow.<key>` UNCONDITIONALLY, off the TASK OBJECT, not off
// `ctx.shadowMode` -- verified directly below by planting `task.shadow.nightlyMainRed: true` on an
// otherwise real-mode task and watching the leg fire anyway, in real mode, exactly because the
// reader does not care what mode it's in. The actual, load-bearing guarantee is entirely on the
// PRODUCER side: `orchestrator/intake.js`'s `makeTask`, the ONLY function that ever builds a real
// card's task object, constructs it as a fixed object literal (`{id, kind, issue, title,
// criterion, size, area, touchesRdoMembers}`) with no `shadow` key anywhere in the function, and
// never assigns `.shadow` on it afterward either -- confirmed by grepping the whole file for the
// literal string `shadow`: the one hit is an unrelated comment about JS variable shadowing, not
// this key. So a real card, as `makeTask` actually produces it, structurally never carries the
// one thing this fixture read would need to see to fire -- not because the reader refuses it in
// real mode (it doesn't), but because nothing upstream of it ever writes that key onto a real
// card in the first place. Both facts are proven below, not asserted in prose: the fixture read
// firing anyway when planted (round 1's and this file's own analysis was too quick on WHY it
// can't happen), and intake.js never planting it. The condition the leg exists FOR ("refuse to
// start a worktree when main is red") is very much alive in real mode, under the sibling reason
// `nightly-main-red` (`realWorktree`, orchestrator/steps/scripted.js:1357) -- tested below, driven through the
// exact same `runTask` -> `handleWorktree` -> `realWorktree` path the severed-dispatch mutation
// cuts.
//
// ---- corpus, re-measured for this action, over the WHOLE of ~/SPO-Pipeline/journal/ -----------
//
// `node -e '...'` walking every `*.jsonl` under `journal/` (24 files -- 23 per-task
// `journal/<id>/journal.jsonl` plus `journal/daemon.jsonl`, which round 1's plain `grep -oE`
// over `journal/*/journal.jsonl` never reached at all, missing it entirely) and parsing every
// line, filtering `event === 'parked'`: **34 `parked` events, 14 distinct `reason` values**.
// (`journal/daemon.jsonl` itself contributes exactly one of those 34: `task-orphaned-daemon-
// restart`, issue-385, 2026-08-30 -- an orphan repark, which is why it lives in the daemon-level
// journal and not any one task's own.) None of the fourteen is any of this file's seven legs --
// that conclusion is unchanged. One further fact worth recording: `abandoned-by-maintainer`
// appears twice in the corpus (`journal/issue-443/`) but NOT as an `event === 'parked'` line at
// all -- it is written by park-loop.js's abandon-reply reconciler directly as its own
// `{"state":"PARKED","event":"abandoned-by-maintainer",...}` journal line and a `state.json`
// `reason` overwrite, reclassifying an ALREADY-counted park (issue-443 first parked
// `pr-closed-unmerged`, then was abandoned) rather than producing a fifteenth reason or a 35th
// `parked` event. Depending on which of the two shapes a future count of "distinct park reasons"
// means, the honest number is 14 (by `event === 'parked'`, what this comment measured) or 15 (by
// final `state.json.reason` across every task that ever parked, counting the reclassification) --
// neither is round 1's 10, and neither is this action's own briefing's 12/33; see this file's own
// commit message / PR description for the discrepancy, not asserted here as a test (a live
// external journal directory is not something a hermetic test suite may read -- see below).
//
// ---- design ------------------------------------------------------------------------------------
//
// One shared, real-mode `spawnSync` fake (`makeSpawnSync`, built on `commonSpawnSync`) drives a
// synthetic `kind: "card"` task through WORKTREE -> PLAN -> IMPLEMENT -> CHECK -> PUSH_PR
// successfully every time (the identical shape test/recette.test.js's own proven
// `makeHappyPathSpawnSync` uses for its "reaches DONE" happy path, independently re-derived here
// rather than imported since recette.test.js does not export it) -- every leg below is reached by
// diverging from that shared happy path at exactly the one call site the leg's own condition
// lives behind (`overrides`, consulted first; anything it does not answer falls through to the
// shared fake). Every spawn is injected; nothing here touches a real git/gh/npm/claude binary.
//
// This file does NOT re-assert the twin behavioural facts round 1 duplicated worse than the
// tests that already owned them (test/real-steps.test.js:3977's exact `waitCalls === 2` re-wait
// count, test/gate-main-moved.test.js:132's exit-2/3/4-never-reaches-verdict-logic guard,
// test/replay-holes.test.js:79's empty-detail/no-spawn assertions, test/nightly-verdict-
// semantics.test.js:369's own "regression guard: the ONE reachable never-fired leg, fired here").
// Those own the BEHAVIOUR; this file owns REACHABILITY, a property none of them can speak to
// because none of them enter through `runTask`.
//
// ---- acceptance test (do this yourself before trusting this file) -----------------------------
//
// Sever state-machine.js:255 the same way the verifier did (`return callWithDeadline(ctx,
// 'WORKTREE', () => realWorktree(ctx, ctx.deps));` -> `return 'PLAN';`) and run
// `node --test --test-timeout=30000 test/gate-legs-reachability.test.js`. Every `runTask`-driven
// test below must fail (ctx.task.worktreePath is never set, so nothing downstream of WORKTREE
// behaves as any of these tests assume) -- restore the line and confirm the file is green again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and why this require must land
// before the orchestrator require(s) below.
require('./no-real-spawn');

const { runTask } = require('../orchestrator/state-machine');
const { mkTmp, writePoolDir } = require('./helpers');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function parkedEvent(taskDir) {
  return readJournal(taskDir).find((e) => e.event === 'parked');
}

function accountsDir() {
  const dir = mkTmp('spo-glr-accts-');
  writePoolDir(dir, [{ name: 'default' }]); // one healthy, credential-free account -- enough for
  // callLlmStep's real-mode account rotation to lease and proceed; no real `claude` credentials
  // ever touched (every claude call is deps.spawnSync-faked, see makeSpawnSync below).
  return dir;
}

function realConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true, // handleIntake's own real-flag-required gate (state-machine.js:211) -- a
    // kind:"card" task in real mode with no explicit opt-in parks immediately, before WORKTREE
    // is ever reached; every test below is driving PAST INTAKE on purpose.
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-glr-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-glr-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    mainMovedRegateBudget: 1,
    claudeAccountsDir: accountsDir(),
    ...overrides,
  };
}

const ORIGIN_MAIN_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
// Card #226. `origin/main` is a LOCAL ref, and `git fetch` is the only thing that advances it.
// This fake used to answer every `rev-parse origin/main` with ORIGIN_MAIN_SHA whether or not a
// fetch had happened -- harmless for as long as realWorktree (which always fetches first) was the
// only caller, and no longer harmless now that handleIntake's nightly pre-gate reads the same ref
// BEFORE any fetch, deliberately (not paying the fetch per card is the entire point of that gate).
// Modelling the staleness is what keeps the two gates distinguishable: INTAKE sees
// STALE_MAIN_SHA, WORKTREE sees ORIGIN_MAIN_SHA, exactly as a real box does in the window between
// a nightly finishing on a new tip and this worker's next fetch. Section 6's test depends on it:
// it is the WORKTREE fallback's own scenario (the pre-gate could not tell, the post-fetch check
// could), and without the staleness the pre-gate would simply front-run it and that test would be
// asserting a leg it no longer reaches.
const STALE_MAIN_SHA = 'c'.repeat(40);

// The minimal payload satisfying step-contracts.js's outputContract for each of the three LLM
// steps a happy-path card actually calls before any of this file's parks (PLAN, IMPLEMENT,
// VALIDATE -- touchesRdoMembers is false, so CITATION_VERIFIER never runs; DIAGNOSE never runs on
// a clean happy path). Byte-for-byte the same shape test/recette.test.js's own STEP_PAYLOADS uses
// (independently re-derived, not imported -- that file does not export it), keyed by the exact
// `required` set step-contracts.js's resolveStepContract puts in `--json-schema` for each step.
const STEP_PAYLOADS = {
  'plan_markdown,invariants_markdown,invariant_ids,check_commands': {
    plan_markdown: '# Plan\n\nSynthetic reachability-test card.\n',
    invariants_markdown: '# Invariants\n\n(none -- synthetic card)\n',
    invariant_ids: [],
    check_commands: ['typecheck', 'lint', 'coverage:changed'],
    files_to_change: ['doc/x.md'],
  },
  'summary,files_changed,invariants,tests_run,all_green': {
    summary: 'Synthetic change.',
    files_changed: ['doc/x.md'],
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
  if (!payload) throw new Error(`fakeClaudeStdout: no canned payload for required=[${key}]`);
  return JSON.stringify({
    result: JSON.stringify(payload),
    session_id: `fake-session-${key.length}`,
    num_turns: 1,
    modelUsage: { 'fake-model': { input_tokens: 100, output_tokens: 50 } },
  });
}

// The shared happy path: WORKTREE -> PLAN -> IMPLEMENT -> CHECK -> PUSH_PR, byte-for-byte the
// same call shapes test/recette.test.js's own proven makeHappyPathSpawnSync uses for those same
// five states (see steps/scripted.js's realWorktree/realCheck/realPushPr, orchestrator/state-
// machine.js's handlePlan/handleImplement for what each one actually spawns). `undefined` here
// means "not handled at this layer" -- makeSpawnSync below falls through to `fail(1, ...)` for
// anything neither an override nor this function recognizes, so an unexpected call shape is a
// loud, named test failure rather than a silent `ok('')`.
function commonSpawnSync(command, args, refState) {
  if (command === 'claude') return ok(fakeClaudeStdout(args));

  if (command === 'git') {
    if (args.includes('fetch')) {
      refState.fetched = true; // see STALE_MAIN_SHA above -- the fetch is what moves the local ref
      return ok('');
    }
    if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no leftovers, ever
    if (args.includes('rev-parse') && args.includes('origin/main')) {
      return ok(`${refState.fetched ? ORIGIN_MAIN_SHA : STALE_MAIN_SHA}\n`);
    }
    if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${HEAD_SHA}\n`);
    // prepareJudgeInputs' committed-vs-not probe (steps/scripted.js). Measured: without this
    // branch the call fell through to the `unhandled fake git call` fail(1) below -- which
    // this fixture's own header promises is a LOUD failure, and which prepareJudgeInputs
    // instead swallows by design (a failed rev-list degrades to the safe not-committed
    // branch). The happy path modelled here has committed by VALIDATE (PUSH_PR runs first,
    // doc/state-machine-spec.md's order), so a truthful fake says so: 1 commit ahead.
    if (args.includes('rev-list') && args.includes('--count')) return ok('1\n');
    if (args.includes('worktree') && args.includes('list')) return ok(''); // nothing registered
    if (args.includes('worktree') && args.includes('add')) return ok('');
    if (args.includes('status') && args.includes('--porcelain')) return ok(' M doc/x.md\n');
    if (args.includes('add') && args.includes('-A')) return ok('');
    if (args.includes('commit')) return ok('');
    if (args.includes('push')) return ok('To github.com\n * [new branch]      HEAD -> claude-pipe/x\n');
    // Order matters: the --name-only shape (PUSH_PR's rdo-catalogue check, CI_CHECKS' main-moved
    // file-list intersection) must be checked before the bare `diff` fallback (prepareJudgeInputs'
    // diff.patch, VALIDATE-bound) below, since a --name-only argv also matches a bare `includes('diff')`.
    if (args.includes('diff') && args.includes('--name-only')) return ok('doc/x.md\n');
    if (args.includes('diff')) return ok('diff --git a/doc/x.md b/doc/x.md\n+one line\n');
    return fail(1, `unhandled fake git call: ${args.join(' ')}`);
  }

  if (command === 'gh') {
    if (args[0] === 'pr' && args[1] === 'list') return ok('[]'); // no existing open PR -> pr create
    if (args[0] === 'pr' && args[1] === 'create') {
      return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/4242\n');
    }
    if (args[0] === 'api' && args.some((a) => String(a).includes('check-runs'))) {
      return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success', status: 'completed' }] }));
    }
    if (args[0] === 'pr' && args[1] === 'merge') return ok('');
    if (args[0] === 'issue' && args[1] === 'comment') {
      return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/1#issuecomment-1\n');
    }
    return fail(1, `unhandled fake gh call: ${args.join(' ')}`);
  }

  if (command === 'npm') {
    if (args[0] === 'ci') return ok('');
    if (args[1] === 'board:take') return ok('claimed\n');
    if (args[1] === 'board:move') return ok('');
    if (['typecheck', 'lint', 'coverage:changed'].includes(args[1])) return ok('');
    if (args[1] === 'gate') return ok(''); // exit 0 -- overridden per GATE-leg test
    if (args[1] === 'pr:wait') return ok(''); // exit 0 -- overridden by the MERGE-leg test
    return fail(1, `unhandled fake npm call: ${args.join(' ')}`);
  }

  return fail(1, `unhandled fake command: ${command} ${args.join(' ')}`);
}

// `overrides(command, args)` is consulted FIRST on every spawn; returning a result diverts from
// the shared happy path (a park-triggering exit, a specific verdict file's worth of behaviour),
// returning `undefined` falls through to commonSpawnSync above.
function makeSpawnSync(overrides, calls) {
  // Per-fake, not module-level: each test gets its own `origin/main` freshness state, so one
  // test's fetch can never make another test's pre-fetch read look fresh.
  const refState = { fetched: false };
  return (command, args, opts) => {
    if (calls) calls.push({ command, args: [...args] });
    if (overrides) {
      const r = overrides(command, args, opts);
      if (r !== undefined) return r;
    }
    return commonSpawnSync(command, args, refState);
  };
}

function cardTask(id, issue) {
  return { id, kind: 'card', issue, title: `Synthetic card ${issue}`, criterion: 'reachability only', size: 'S' };
}

// =================================================================================================
// ---- 1/2. gate-worker-down, gate-timeout -- realGate's own exit-code table, reached via runTask
// =================================================================================================

for (const [exit, reason] of [
  [3, 'gate-worker-down'],
  [4, 'gate-timeout'],
]) {
  test(`runTask (real mode, card): npm run gate exit ${exit} -> PARKED ${reason}, reached from INTAKE through GATE (corpus fire count 0)`, async () => {
    const taskDir = mkTmp(`spo-glr-gate${exit}-taskdir-`);
    const config = realConfig({
      deps: {
        spawnSync: makeSpawnSync((command, args) => {
          if (command === 'npm' && args[1] === 'gate') return fail(exit);
        }),
      },
    });
    const task = cardTask(`glr-gate-${exit}`, 900 + exit);

    const finalState = await runTask(task.id, task, taskDir, config);

    assert.equal(finalState, 'PARKED');
    const parked = parkedEvent(taskDir);
    assert.ok(parked, 'runTask must have journalled a parked event');
    assert.equal(parked.reason, reason);
    assert.equal(parked.state, 'GATE');
    assert.equal(parked.detail.exit, exit);
  });
}

// =================================================================================================
// ---- 3. gate-non-attesting -- realGate, exit 1, no verdict file on disk, reached via runTask ---
// =================================================================================================

test('runTask (real mode, card): npm run gate exit 1 with no verdict file for HEAD -> PARKED gate-non-attesting (corpus fire count 0)', async () => {
  const taskDir = mkTmp('spo-glr-nonattest-taskdir-');
  const config = realConfig({
    deps: {
      spawnSync: makeSpawnSync((command, args) => {
        if (command === 'npm' && args[1] === 'gate') return fail(1);
      }),
    },
  });
  const task = cardTask('glr-nonattest', 903);

  const finalState = await runTask(task.id, task, taskDir, config);

  assert.equal(finalState, 'PARKED');
  const parked = parkedEvent(taskDir);
  assert.equal(parked.reason, 'gate-non-attesting');
  assert.equal(parked.state, 'GATE');
  assert.equal(parked.detail.headSha, HEAD_SHA);
});

// =================================================================================================
// ---- 4. main-red-no-merge -- realCiChecks' main-moved path, reached via runTask through GATE ---
// =================================================================================================

test('runTask (real mode, card): GATE passes, CI_CHECKS finds main moved and nightly FAIL at the exact origin/main sha -> PARKED main-red-no-merge (corpus fire count 0)', async () => {
  const taskDir = mkTmp('spo-glr-mainrednomerge-taskdir-');
  const config = realConfig();
  // GATE's own exit-0 read of verdicts/<HEAD_SHA>.json: a baseMain with no `live` key reads as
  // "nothing on file proves the live stage ran" (action B2.3) -- safe, routes on to CI_CHECKS,
  // exactly as it must for GATE to ever hand off to CI_CHECKS at all.
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${HEAD_SHA}.json`), { baseMain: 'basemainsha' });
  // Deliberately NOT written yet -- WORKTREE reads this SAME file (steps/scripted.js's
  // realWorktree, via classifyNightly) off the SAME origin/main sha this fake always returns, so
  // writing it red up front would park nightly-main-red at WORKTREE, before this test's own leg
  // (CI_CHECKS' own guardNightlyRed, shared with GATE's main-moved path) ever gets a turn --
  // measured: that is exactly what happened on the first draft of this test. Instead it is
  // written the moment WORKTREE's own `npm ci` spawns -- after WORKTREE's own nightly check has
  // already run and found nothing (safe) -- simulating the nightly bench reporting red on
  // origin/main sometime between WORKTREE and CI_CHECKS, so CI_CHECKS is the one that actually
  // parks main-red-no-merge.
  config.deps = {
    spawnSync: makeSpawnSync((command, args) => {
      if (command === 'npm' && args[0] === 'ci') {
        writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: ORIGIN_MAIN_SHA });
      }
    }),
  };

  const task = cardTask('glr-ci-red', 904);

  const finalState = await runTask(task.id, task, taskDir, config);

  assert.equal(finalState, 'PARKED');
  const parked = parkedEvent(taskDir);
  assert.equal(parked.reason, 'main-red-no-merge');
  assert.equal(parked.state, 'CI_CHECKS');
});

// =================================================================================================
// ---- 5. merge-queue-not-landing -- realMerge, reached via runTask through GATE/CI_CHECKS/VALIDATE
// =================================================================================================

test('runTask (real mode, card): GATE/CI_CHECKS/VALIDATE all pass, pr:wait exits 4 twice -> PARKED merge-queue-not-landing, never a third wait (corpus fire count 0)', async () => {
  const taskDir = mkTmp('spo-glr-merge-taskdir-');
  const config = realConfig();
  // No verdict on disk for HEAD_SHA at all -- CI_CHECKS' `const baseMain = verdict && verdict
  // .baseMain` reads undefined and returns 'VALIDATE' directly (nothing recorded to compare
  // against, "treat as not moved" -- steps/scripted.js), the same as GATE's own "absence is safe"
  // rule above skips straight past any main-moved machinery this test is not about.
  let waitCalls = 0;
  config.deps = {
    spawnSync: makeSpawnSync((command, args) => {
      if (command === 'npm' && args[1] === 'pr:wait') {
        waitCalls += 1;
        return fail(4);
      }
    }),
    sleep: () => Promise.resolve(),
  };

  const task = cardTask('glr-merge', 906);

  const finalState = await runTask(task.id, task, taskDir, config);

  assert.equal(finalState, 'PARKED');
  const parked = parkedEvent(taskDir);
  assert.equal(parked.reason, 'merge-queue-not-landing');
  assert.equal(parked.state, 'MERGE');
  assert.equal(waitCalls, 2, 'never a third pr:wait once the one bounded re-wait has also come back non-landing');
});

// =================================================================================================
// ---- 6. nightly-main-red -- realWorktree's own real-signal check, reached via runTask -----------
// =================================================================================================
//
// This is the leg `main-red-refuse-worktree` (next section) defers to in real mode: the exact
// same "is main red, refuse to start" condition, wired to the exact real spawn realWorktree reads
// (<spoBenchDir>/nightly/latest.json), reached the moment `runTask` enters WORKTREE at all --
// which is also why severing state-machine.js:255's real-mode dispatch (this file's own
// acceptance mutation, see header) makes THIS test fail: nothing downstream of that line runs.

test('runTask (real mode, card): WORKTREE finds nightly FAIL at the exact fetched origin/main sha -> PARKED nightly-main-red, before any worktree add (corpus fire count 0)', async () => {
  const taskDir = mkTmp('spo-glr-wtreal-taskdir-');
  const config = realConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: ORIGIN_MAIN_SHA });
  const calls = [];
  config.deps = { spawnSync: makeSpawnSync(undefined, calls) };

  const task = cardTask('glr-wt-real', 905);

  const finalState = await runTask(task.id, task, taskDir, config);

  assert.equal(finalState, 'PARKED');
  const parked = parkedEvent(taskDir);
  assert.equal(parked.reason, 'nightly-main-red');
  assert.equal(parked.state, 'WORKTREE');
  assert.equal(parked.detail.sha, ORIGIN_MAIN_SHA);
  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('add')),
    'the park happens before `git worktree add` is ever attempted'
  );
});

// =================================================================================================
// ---- 7. main-red-refuse-worktree -- structurally unreachable from a REAL card, proven two ways --
// =================================================================================================
//
// See this file's header for the full mechanism. Two separate facts, proven separately, because
// conflating them is exactly the mistake worth not repeating: (a) the FIXTURE READ itself
// (`ctx.fixture('nightlyMainRed', false)`) is not mode-gated at all -- plant `task.shadow
// .nightlyMainRed: true` on an otherwise real-mode task and the leg fires anyway, in real mode,
// through `runTask`, proven first below so nobody re-derives the wrong belief from this file
// later; (b) the actual guarantee is that `orchestrator/intake.js`'s `makeTask` -- the only
// producer of a real card's task object -- never constructs that shape, proven second by reading
// the source, not by asserting it in prose.

test('runTask (real mode, card): a task shaped like NO real card ever is (task.shadow.nightlyMainRed planted) DOES park main-red-refuse-worktree in real mode -- the fixture read is not mode-gated', async () => {
  const taskDir = mkTmp('spo-glr-wtshadowfires-taskdir-');
  const config = realConfig();
  const calls = [];
  config.deps = { spawnSync: makeSpawnSync(undefined, calls) };

  const task = cardTask('glr-wt-shadow-fires', 907);
  task.shadow = { nightlyMainRed: true }; // the one shape intake.js's makeTask never produces

  const finalState = await runTask(task.id, task, taskDir, config);

  assert.equal(finalState, 'PARKED');
  const parked = parkedEvent(taskDir);
  assert.equal(parked.reason, 'main-red-refuse-worktree');
  assert.equal(parked.state, 'WORKTREE');
  assert.ok(
    !calls.some((c) => c.command === 'git'),
    'the park happens before handleWorktree ever calls isRealMode/realWorktree at all -- no spawn of any kind'
  );
});

test("source anchor: orchestrator/intake.js's makeTask -- the only producer of a real card's task object -- never writes a `shadow` key onto it, which is the actual reason main-red-refuse-worktree cannot fire on a real card (not the fixture reader refusing it -- the test above proves it does not)", () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'intake.js'), 'utf8');
  const makeTaskStart = source.indexOf('function makeTask(');
  assert.ok(makeTaskStart >= 0, 'orchestrator/intake.js must still export a makeTask function');
  // makeTask is the last top-level function in the file (verified by hand at the time this test
  // was written) -- slicing to EOF rather than hunting its closing brace is deliberately the
  // wider net: it can only make this assertion STRICTER (catch a `.shadow` write added anywhere
  // after makeTask starts, not just inside its own body) if that ever stops being true, never
  // weaker.
  const makeTaskAndAfter = source.slice(makeTaskStart);
  assert.ok(
    !/\.shadow\s*[=:]/.test(makeTaskAndAfter),
    'intake.js must never write a `shadow` key onto a real card\'s task object -- if it now does, ' +
      'main-red-refuse-worktree just became reachable from a real card and this file\'s whole ' +
      '"structurally unreachable" analysis needs to be redone, not silently left stale'
  );
});

// The leg's own reachable mode -- shadow mode, `HANDLERS.WORKTREE` called directly (there is no
// real-mode PATH into it for `runTask` to drive, only the fixture-reader fact proven above) -- is
// already covered, with tighter assertions than this file would add (an exactly-empty `detail`,
// proof no runScripted call happens first): test/replay-holes.test.js's "HANDLERS.WORKTREE
// (shadow mode): nightlyMainRed fixture -> ParkSignal main-red-refuse-worktree with an empty
// detail, checked before any worktree spawn is even attempted", cited again by
// test/nightly-verdict-semantics.test.js. Not re-asserted here.

// =================================================================================================
// ---- 8. nightly-red-holding-intake -- handleIntake's PRE-GATE, reached via runTask (card #226) --
// =================================================================================================
//
// The newest of the three nightly-red legs, and the only one that fires BEFORE the card starts.
// Sections 6 and 7 are its post-start siblings: section 6 (`nightly-main-red`) asks the same
// question after realWorktree has taken the shared product-repo lock, paid the bench-reinstall
// debt, fetched and rev-parsed; section 7 (`main-red-refuse-worktree`) is the shadow-only fixture
// twin of that. This one asks it at INTAKE, off the LOCALLY-KNOWN `origin/main` -- no fetch, no
// lock -- so that a red nightly costs the queue nothing per card instead of one lock-serialized
// WORKTREE attempt plus one human `retry` each.
//
// The acceptance bar card #226 states literally is the second assertion in the first test: not
// merely "it parks", but "no WORKTREE journal entry is produced AT ALL". A gate that parked with
// the right reason after letting WORKTREE run would satisfy the reason assertion and miss the
// entire point, so the journal-absence assertion is the one that actually pins the design.

test('runTask (real mode, card): nightly FAIL at the LOCALLY-KNOWN origin/main sha -> PARKED nightly-red-holding-intake at INTAKE, with NO WORKTREE journal entry of any kind and no fetch/lock ever paid', async () => {
  const taskDir = mkTmp('spo-glr-intakegate-taskdir-');
  const config = realConfig();
  // Red at STALE_MAIN_SHA -- the sha a rev-parse answers with BEFORE any fetch, i.e. the one the
  // pre-gate actually reads. (Section 6's test writes it at ORIGIN_MAIN_SHA, the POST-fetch sha,
  // which is why that one still belongs to WORKTREE and this one to INTAKE.)
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: STALE_MAIN_SHA });
  const calls = [];
  config.deps = { spawnSync: makeSpawnSync(undefined, calls) };

  const task = cardTask('glr-intake-gate', 908);

  const finalState = await runTask(task.id, task, taskDir, config);

  assert.equal(finalState, 'PARKED');
  const parked = parkedEvent(taskDir);
  assert.equal(parked.reason, 'nightly-red-holding-intake');
  assert.equal(parked.state, 'INTAKE', 'the park belongs to INTAKE -- not WORKTREE, which never ran');
  assert.equal(parked.detail.sha, STALE_MAIN_SHA);

  // THE acceptance bar from the card: not one journal line for WORKTREE, of any event name.
  // `base-main`, `nightly-unknown`, a spawn record -- any of them would mean the card started.
  const worktreeEntries = readJournal(taskDir).filter((e) => e.state === 'WORKTREE');
  assert.deepEqual(
    worktreeEntries,
    [],
    'a card held at INTAKE must produce NO WORKTREE journal entry at all -- ' +
      `found ${worktreeEntries.length}: ${JSON.stringify(worktreeEntries.map((e) => e.event))}`
  );

  // ... and the cost side of the same fact, asserted on the spawns rather than the journal: the
  // gate's ONE subprocess is the lock-free, fetch-free rev-parse. Nothing realWorktree does --
  // the fetch, `npm ci`, `worktree add`, the board claim -- is ever reached.
  const argvs = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
  assert.equal(
    argvs[0],
    `git -C ${config.productRepo} rev-parse origin/main`,
    "the run's FIRST spawn is the pre-gate's own lock-free, fetch-free rev-parse"
  );
  // Everything realWorktree would have done, enumerated rather than summarised -- these are the
  // per-card costs card #226 exists to stop paying while main is red. (The two spawns that DO
  // follow the rev-parse are the ordinary park machinery, `board:move ... Parked` and the park
  // comment; they are the cost of parking, which this card is not trying to avoid.)
  for (const forbidden of ['fetch', 'worktree add', 'npm ci', 'board:take']) {
    assert.ok(
      !argvs.some((a) => a.includes(forbidden)),
      `a card held at INTAKE must never reach \`${forbidden}\` -- spawns were ${JSON.stringify(argvs)}`
    );
  }
});

test('runTask (real mode, card): the INTAKE pre-gate park is TRANSIENT -- it re-enqueues itself with a `transient-retry` event and writes NO `parked` line, so no human `retry` is needed (unlike nightly-main-red)', async () => {
  const taskDir = mkTmp('spo-glr-intakegate-transient-taskdir-');
  const queueDir = mkTmp('spo-glr-intakegate-queue-');
  // finalizePark's bounded-auto-retry branch needs all three: real mode (realConfig), a queue
  // directory to re-enqueue INTO, and budget left. Section 6's config deliberately has neither of
  // the last two, which is part of why `nightly-main-red` parks outright there.
  const config = realConfig({ queueDir, transientRetryBudget: 2, transientRetryDelaysMs: [1000, 5000] });
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: STALE_MAIN_SHA });
  config.deps = { spawnSync: makeSpawnSync() };

  const task = cardTask('glr-intake-transient', 909);

  await runTask(task.id, task, taskDir, config);

  const journal = readJournal(taskDir);
  const retry = journal.find((e) => e.event === 'transient-retry');
  assert.ok(retry, 'the hold must re-enqueue itself, not park -- no `transient-retry` event found');
  assert.equal(retry.reason, 'nightly-red-holding-intake');
  assert.equal(retry.state, 'INTAKE');
  assert.equal(retry.attempt, 1);
  assert.equal(retry.delayMs, 1000, 'attempt 1 takes the first backoff off transientRetryDelaysMs');

  // Card #178's rule, and the half of this that actually proves "no human needed": the re-enqueue
  // branch writes NO `parked` line, because the card is not parked -- it is coming back. A
  // `parked` line here is what `spo parked`, the dashboard and countRepeatedParks all read as "a
  // maintainer must look at this".
  assert.equal(
    journal.find((e) => e.event === 'parked'),
    undefined,
    'a transient hold must not also journal a `parked` line'
  );
  // The re-enqueue is real, not just journalled: the task is back in queue/ carrying its attempt
  // count, which is what brings it round to INTAKE again on its own.
  const queued = fs.readdirSync(queueDir);
  assert.equal(queued.length, 1, `expected exactly one re-enqueued task file, found ${queued.length}`);
  const entry = JSON.parse(fs.readFileSync(path.join(queueDir, queued[0]), 'utf8'));
  assert.equal(entry.id, task.id);
  assert.equal(entry.transientRetries, 1);
  assert.ok(entry.notBefore, 'the backoff rides on the queue entry as a deadline, never as a sleep');
});

test('runTask (real mode, card): the pre-gate FAILS OPEN -- a non-zero `rev-parse origin/main` (no product repo cloned) proceeds to WORKTREE exactly as before, never parks', async () => {
  const taskDir = mkTmp('spo-glr-intakegate-failopen-taskdir-');
  const config = realConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: STALE_MAIN_SHA });
  // Only the PRE-fetch rev-parse fails -- modelling "this box cannot answer the question yet" (no
  // clone, a broken .git). Once WORKTREE's own `git fetch` has run the repo answers normally, so
  // this test isolates the pre-gate's fail-open and nothing else.
  let fetched = false;
  config.deps = {
    spawnSync: makeSpawnSync((command, args) => {
      if (command === 'git' && args.includes('fetch')) {
        fetched = true;
        return undefined; // fall through to the shared happy path
      }
      if (command === 'git' && args.includes('rev-parse') && args.includes('origin/main') && !fetched) {
        return fail(128, 'fatal: not a git repository');
      }
      return undefined;
    }),
  };

  const task = cardTask('glr-intake-failopen', 910);

  await runTask(task.id, task, taskDir, config);

  const journal = readJournal(taskDir);
  assert.equal(
    journal.filter((e) => e.event === 'parked' && e.reason === 'nightly-red-holding-intake').length,
    0,
    'an unanswerable question must never become the thing that holds the queue'
  );
  assert.ok(
    journal.some((e) => e.state === 'WORKTREE'),
    'failing open means the card proceeds into WORKTREE exactly as it did before this gate existed'
  );
});

test('runTask (real mode, card): a nightly FAIL recorded for a DIFFERENT sha classifies `unknown` -> journals `nightly-unknown` AT INTAKE and proceeds to WORKTREE, never parks on an unproven state', async () => {
  const taskDir = mkTmp('spo-glr-intakegate-unknown-taskdir-');
  const config = realConfig();
  // A red nightly, but recorded against a sha this box's local origin/main is not at -- the
  // routine stale case, not evidence about the sha in question. Every precedent in this codebase
  // says an unproven nightly state must not be treated as red.
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: 'd'.repeat(40) });
  config.deps = { spawnSync: makeSpawnSync() };

  const task = cardTask('glr-intake-unknown', 911);

  await runTask(task.id, task, taskDir, config);

  const journal = readJournal(taskDir);
  const unknown = journal.find((e) => e.state === 'INTAKE' && e.event === 'nightly-unknown');
  assert.ok(unknown, 'the unproven state is recorded, under the same event name every other state uses');
  assert.equal(unknown.sha, STALE_MAIN_SHA);
  assert.equal(
    journal.filter((e) => e.event === 'parked' && e.reason === 'nightly-red-holding-intake').length,
    0
  );
  assert.ok(journal.some((e) => e.state === 'WORKTREE'), 'and the card proceeds');
});

test('runTask (real mode, card): with NO nightly file on disk the pre-gate costs ZERO subprocesses -- the free fs read short-circuits before the rev-parse, so the common (green) case adds nothing per card', async () => {
  const taskDir = mkTmp('spo-glr-intakegate-free-taskdir-');
  const config = realConfig(); // spoBenchDir exists but holds no nightly/latest.json
  const calls = [];
  config.deps = { spawnSync: makeSpawnSync(undefined, calls) };

  const task = cardTask('glr-intake-free', 912);

  await runTask(task.id, task, taskDir, config);

  // The first spawn of the whole run is realWorktree's own `git fetch origin`, exactly as it was
  // before this gate existed -- the gate itself spawned nothing. If this ever starts with a
  // rev-parse, the short-circuit has been lost and every card in the queue is paying for a
  // question whose answer could not possibly have been 'red'.
  assert.ok(calls.length > 0, 'the card must still run');
  assert.equal(
    `${calls[0].command} ${calls[0].args.join(' ')}`,
    `git -C ${config.productRepo} fetch origin`,
    'the pre-gate must not spawn when no nightly record could refuse any sha -- first spawn was ' +
      `${calls[0].command} ${calls[0].args.join(' ')}`
  );
});

// ---- card #226 fix-pass regression tests, added after an independent adversarial audit found -
// ---- two real defects in the tests above: neither ever fed the gate a malformed nightly.sha ---
// ---- or a spawnStep THROW (as opposed to a non-zero exit) -------------------------------------

test('runTask (real mode, card): a nightly record with a malformed (non-string) `sha` does NOT crash the pre-gate -- classifies unknown and proceeds to WORKTREE (card #226 fix regression guard)', async () => {
  // Reproduces the actual production defect: handleIntake's short-circuit asks
  // `classifyNightly(nightly, nightly && nightly.sha)`, feeding `nightly.sha` back in as
  // `targetSha`. Before the fix, a truthy non-string `sha` (a number here -- an object or `true`
  // are the same bug, pinned at the unit level in test/nightly-verdict-semantics.test.js) crashed
  // `targetSha.slice(0, 8)` with an uncaught TypeError, at the free `fs`-read short-circuit --
  // before any subprocess, before any ParkSignal, escaping runTask entirely. Since the nightly
  // record is one pipeline-wide file, this took down every card identically.
  const taskDir = mkTmp('spo-glr-intakegate-malformed-sha-taskdir-');
  const config = realConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: 123 });
  const calls = [];
  config.deps = { spawnSync: makeSpawnSync(undefined, calls) };

  const task = cardTask('glr-intake-malformed-sha', 913);

  // The assertion that matters: this must not reject/throw at all. Pre-fix, the TypeError
  // propagated straight out of runTask and this `await` would have rejected the test.
  // The assertion that matters: this must not reject/throw at all. Pre-fix, the TypeError
  // propagated straight out of runTask and this `await` would have rejected the test.
  await runTask(task.id, task, taskDir, config);

  // A non-string sha can never equal a real target sha, so this classifies 'unknown' -- same
  // outcome as the existing "recorded for a DIFFERENT sha" test just above, proceeding to
  // WORKTREE rather than holding on a record that cannot actually be attributed to any sha. This
  // fake spawnSync has no full happy-path implementation past WORKTREE's own leftover sweep, so
  // the card still parks somewhere further downstream (an unrelated, expected park) -- the same
  // shape the "different sha" test above already tolerates; only the ABSENCE of the pre-gate's
  // own reason, and the PRESENCE of a WORKTREE entry, are this test's actual property.
  const journal = readJournal(taskDir);
  assert.equal(
    journal.filter((e) => e.event === 'parked' && e.reason === 'nightly-red-holding-intake').length,
    0,
    'a malformed sha must never be read as red -- the pre-gate must not hold the queue on it'
  );
  assert.ok(journal.some((e) => e.state === 'WORKTREE'), 'the card proceeds into WORKTREE');
  // The pre-gate's own free short-circuit must still have run BEFORE any subprocess -- confirms
  // the crash (pre-fix) happened inside the `fs`-read path itself, not somewhere spawn-adjacent.
  assert.equal(
    `${calls[0].command} ${calls[0].args.join(' ')}`,
    `git -C ${config.productRepo} fetch origin`,
    'no rev-parse is spawned either -- classifyNightly answers unknown from the free read alone'
  );
});

test('runTask (real mode, card): the pre-gate FAILS OPEN when the rev-parse is KILLED BY A SIGNAL (a deploy restart), not just on a non-zero exit -- proceeds to WORKTREE, never parks command-killed-by-signal (card #226 fix regression guard)', async () => {
  // spawnStep does not always RETURN a non-zero exit for "could not answer" -- it THROWS a
  // ParkSignal ('command-killed-by-signal' for a killed child, 'git-timed-out' for a double
  // timeout; steps/scripted.js). Before the fix, only the `revParse.exit === 0` branch was
  // handled below the spawnStep call, so either throw escaped uncaught by the pre-gate and
  // propagated as a REAL park -- on a reason that is NOT in TRANSIENT_RETRY_REASONS, i.e. exactly
  // the "one human retry per card" cost this whole card exists to remove. A deploy SIGTERM
  // landing mid-rev-parse while nightly happens to be red is the textbook trigger.
  const taskDir = mkTmp('spo-glr-intakegate-signalkilled-taskdir-');
  const config = realConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: STALE_MAIN_SHA });
  // spawnStep retries once on a signal kill (same branch as a timeout, scripted.js) before it
  // throws -- so the fake must answer KILLED on both attempts of the PRE-fetch rev-parse to reach
  // that throw. Only the pre-gate's own rev-parse is killed; WORKTREE's post-fetch one (and the
  // fetch itself) answer normally, isolating this test to the pre-gate's own throw handling.
  let fetched = false;
  config.deps = {
    spawnSync: makeSpawnSync((command, args) => {
      if (command === 'git' && args.includes('fetch')) {
        fetched = true;
        return undefined; // fall through to the shared happy path
      }
      if (command === 'git' && args.includes('rev-parse') && args.includes('origin/main') && !fetched) {
        return { status: null, stdout: '', stderr: '', signal: 'SIGTERM' };
      }
      return undefined;
    }),
  };

  const task = cardTask('glr-intake-signalkilled', 914);

  // The assertion that matters: this must not reject/throw at all. Pre-fix, the pre-gate's
  // uncaught spawnStep throw (command-killed-by-signal) propagated straight out of runTask as a
  // REAL park before this state was ever written; this `await` resolving at all is part of the
  // proof. This fake spawnSync has no full happy-path implementation past WORKTREE's own leftover
  // sweep, so the card can still legitimately park somewhere further downstream (an unrelated,
  // expected park, the same shape the "different sha" test above tolerates) -- what this test
  // actually pins is the ABSENCE of the two reasons a throw here could wrongly produce, and the
  // PRESENCE of a WORKTREE entry proving the gate really did fall through rather than hold.
  await runTask(task.id, task, taskDir, config);

  const journal = readJournal(taskDir);
  assert.equal(
    journal.filter((e) => e.event === 'parked' && e.reason === 'command-killed-by-signal').length,
    0,
    'the pre-gate must swallow its own spawnStep throw, never let it surface as a real park'
  );
  assert.equal(
    journal.filter((e) => e.event === 'parked' && e.reason === 'nightly-red-holding-intake').length,
    0,
    'a signal kill answers nothing about nightly -- it must never be misread as a red verdict'
  );
  assert.ok(
    journal.some((e) => e.state === 'WORKTREE'),
    'failing open on a throw means the card proceeds into WORKTREE, exactly as a non-zero exit already did'
  );
});

// =================================================================================================
// ---- source anchor: the seven throw sites this file's tests assume still exist, exactly --------
// =================================================================================================
//
// NOT a completeness sweep -- test/park-reason-doc-sweep.test.js already owns "is every
// ParkSignal reason documented" over all ~94 `new ParkSignal(...)` call sites in orchestrator/**,
// and re-deriving that here would be exactly the restating-what-the-doc-sweep-already-pins this
// action was told not to do. This is narrower and asks a different question: do the throw sites
// THIS FILE's own tests are built around still exist, in the exact real/shadow shape each leg
// actually has today, so a future refactor that renames or removes one breaks THIS FILE loudly
// instead of leaving a reachability test that quietly asserts nothing real. Per-fact, not
// per-file: each reason is pinned to its OWN real count, not a blanket "at least one" -- five of
// the seven legs have a real (steps/scripted.js) throw site AND a shadow-mode twin
// (state-machine.js) that mirrors it for fixture-driven tests; `gate-non-attesting` and
// `nightly-main-red` are real-only (no shadow twin exists for either); `main-red-refuse-worktree`
// is shadow-only (state-machine.js), by design (see this file's header).
const SCAN_FILES = [
  path.join(__dirname, '..', 'orchestrator', 'steps', 'scripted.js'),
  path.join(__dirname, '..', 'orchestrator', 'state-machine.js'),
];

const PINNED_LEG_REASON_COUNTS = {
  'gate-worker-down': 2, // real (scripted.js GATE) + shadow twin (state-machine.js handleGate)
  'gate-timeout': 2, // same split as gate-worker-down
  'gate-non-attesting': 1, // real only -- action B2.3, no shadow equivalent
  'main-red-no-merge': 2, // real (guardNightlyRed, shared GATE/CI_CHECKS) + shadow twin
  'main-red-refuse-worktree': 1, // shadow only -- see this file's header
  'nightly-main-red': 1, // real only -- realWorktree's own check
  'merge-queue-not-landing': 2, // real (realMerge) + shadow twin (handleMerge)
};

test('source anchor: each of the seven forever-zero legs still has exactly the ParkSignal throw site(s) this file drives at', () => {
  const source = SCAN_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const [reason, expected] of Object.entries(PINNED_LEG_REASON_COUNTS)) {
    const re = new RegExp(`new ParkSignal\\('${reason}'`, 'g');
    const found = (source.match(re) || []).length;
    assert.equal(
      found,
      expected,
      `expected exactly ${expected} 'new ParkSignal('${reason}'...)' call site(s) across ` +
        `steps/scripted.js + state-machine.js, found ${found} -- if this legitimately changed, ` +
        `this file's own per-leg test needs to change with it, not silently keep passing`
    );
  }
});
