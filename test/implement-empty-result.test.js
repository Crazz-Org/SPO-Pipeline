'use strict';
// Unit tests for HANDLERS.IMPLEMENT (state-machine.js's handleImplement) validating the
// filesChanged payload before routing to CHECK. Evidence: a real run of card issue-247 saw
// IMPLEMENT return {ok: true, filesChanged: "[]", allGreen: "false", summary: "Cannot proceed:
// ..."}; the old code took payload.ok !== false at face value and sent it to CHECK, which
// passed on the untouched worktree, and PUSH_PR only then parked (push-pr-failed) two states and
// one misleading reason later. This handler now also validates files_changed in real mode, only
// when the payload actually carries that field -- see state-machine.js's handleImplement for why
// (--dry-run's canned payload and the legacy ctx.task.llm.IMPLEMENT override both need to keep
// working unmodified; test/board-move.test.js and test/dry-run-demo.test.js cover those).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');
const { mkTmp, fakeSpawnedChild, fakeExecDeps } = require('./helpers');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Real-mode ctx driving IMPLEMENT through the full `kind: "card"` path (step-contracts.js +
// prompt-template.js + task-values.js) -- no ctx.task.llm.IMPLEMENT override, so the payload
// actually carries files_changed the way a real reply does. Mirrors
// test/board-move.test.js's realCtxWithOneAccount/appendEvent-PLAN-result setup.
//
// Card #239 chantier, action A5b-2 (Job 3): `deps` now carries BOTH the `claude` fake (`spawn` --
// test/helpers.js's `fakeSpawnedChild` seam, plus `resolveClaudeCodeExecutable`/
// `isNoRealSpawnEnabled` -- `fakeExecDeps`) and the git/gh/npm fake (`spawnSync`, unchanged: only
// the `claude` call moved off spawnSync onto the SDK's `query()`) in ONE object, since
// `ctx.deps` is a single injection point every real-mode call site (runLlm AND steps/scripted.js's
// real git/gh calls) reads from.
function realCardCtx(task, taskDir, deps) {
  const accountsDir = mkTmp('spo-implement-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      plan_path: path.join(taskDir, 'scratch', `plan-${task.issue}.md`),
      invariants_path: path.join(taskDir, 'scratch', `invariants-${task.issue}.md`),
      invariant_ids: ['INV-1'],
      check_commands: ['npm test'],
    },
  });
  return buildCtx(task.id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    deps,
  });
}

function initMessage(sessionId = 'sess-implement-1') {
  return { type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}

// claudeStream(resultObj) -- this file's equivalent of the old flat `claudeReply()`: a
// `system`/`init` stream-json message, then a `result` message carrying `resultObj` as the
// JSON-encoded `result` string (consumeQueryStream's own contract for a json-schema reply), fed to
// `fakeSpawnedChild` so a `deps.spawn` fake can return it directly.
function claudeStream(resultObj) {
  return [
    initMessage(),
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      session_id: 'sess-implement-1',
      modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 5 } },
      result: JSON.stringify(resultObj),
      terminal_reason: 'success',
      api_error_status: null,
    },
  ];
}

function baseTask(issue) {
  const worktreePath = mkTmp(`spo-implement-wt-${issue}-`);
  return {
    id: `card-${issue}`,
    kind: 'card',
    issue,
    criterion: 'the widget renders',
    worktreePath,
    size: 'S',
    touchesRdoMembers: false,
  };
}

test('handleImplement (real mode): filesChanged as a JSON-encoded empty-array string routes to DIAGNOSE, not CHECK (today\'s issue-247 shape)', async () => {
  const task = baseTask(247);
  const taskDir = mkTmp('spo-implement-emptystr-');
  const spawn = () =>
    fakeSpawnedChild(
      claudeStream({
        summary: 'Cannot proceed: the required plan file ... does not exist',
        files_changed: '[]',
        invariants: [],
        tests_run: [],
        all_green: 'false',
      })
    );
  const ctx = realCardCtx(task, taskDir, fakeExecDeps({ spawn, spawnSync: () => ok('') }));

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'empty-implement'), 'expected an empty-implement journal event');
});

test('handleImplement (real mode): a real empty array (not a string) also routes to DIAGNOSE', async () => {
  const task = baseTask(248);
  const taskDir = mkTmp('spo-implement-emptyarr-');
  const spawn = () => fakeSpawnedChild(claudeStream({ summary: 'nothing to do', files_changed: [], invariants: [], tests_run: [], all_green: false }));
  const ctx = realCardCtx(task, taskDir, fakeExecDeps({ spawn, spawnSync: () => ok('') }));

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'DIAGNOSE');
});

test('handleImplement (real mode): an unparsable filesChanged string routes to DIAGNOSE (missing/unparsable treated as empty)', async () => {
  const task = baseTask(249);
  const taskDir = mkTmp('spo-implement-badjson-');
  const spawn = () => fakeSpawnedChild(claudeStream({ summary: 'x', files_changed: 'not json', invariants: [], tests_run: [], all_green: false }));
  const ctx = realCardCtx(task, taskDir, fakeExecDeps({ spawn, spawnSync: () => ok('') }));

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'DIAGNOSE');
});

// action 7.1: state-machine.js's parseFilesChanged has two ways to produce null for a string --
// JSON.parse itself throwing (the 'not json' case just above, already covered) and JSON.parse
// SUCCEEDING but landing on something that isn't an array at all. Both must be treated identically
// by handleImplement (route to DIAGNOSE, journal empty-implement), but they are genuinely
// different lines in parseFilesChanged's body, and a mutant that only broke the second one (e.g.
// `Array.isArray(parsed) ? parsed : null` -> `parsed` unconditionally) would sail through the
// 'not json' test above unnoticed, since that test never reaches this line at all.
test('handleImplement (real mode): filesChanged that parses as valid JSON but is NOT an array (an object) routes to DIAGNOSE the same as unparsable JSON', async () => {
  const task = baseTask(251);
  const taskDir = mkTmp('spo-implement-jsonnotarray-');
  const spawn = () =>
    fakeSpawnedChild(
      claudeStream({
        summary: 'x',
        files_changed: '{"src/widget.ts":"modified"}', // valid JSON, but an object, not an array
        invariants: [],
        tests_run: [],
        all_green: false,
      })
    );
  const ctx = realCardCtx(task, taskDir, fakeExecDeps({ spawn, spawnSync: () => ok('') }));

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(taskDir);
  const event = journal.find((e) => e.event === 'empty-implement');
  assert.ok(event, 'expected an empty-implement journal event');
  assert.equal(event.filesChanged, '{"src/widget.ts":"modified"}', 'the raw claimed value is journalled as-is, not the parsed-then-discarded object');
});

// action 7.1: parseFilesChanged's OWN final fallback (`return null` after the Array.isArray check
// and the typeof === 'string' check both fail) -- reached only when files_changed is present but
// is neither an array nor a string at all, e.g. a bare `null`. Genuinely distinct from both tests
// above: those exercise the two branches INSIDE the `typeof raw === 'string'` block; this exercises
// what happens when execution never enters that block in the first place.
test('handleImplement (real mode): filesChanged present as a bare null (neither array nor string) routes to DIAGNOSE via parseFilesChanged\'s own final fallback', async () => {
  const task = baseTask(252);
  const taskDir = mkTmp('spo-implement-filesnull-');
  const spawn = () =>
    fakeSpawnedChild(
      claudeStream({
        summary: 'x',
        files_changed: null,
        invariants: [],
        tests_run: [],
        all_green: false,
      })
    );
  const ctx = realCardCtx(task, taskDir, fakeExecDeps({ spawn, spawnSync: () => ok('') }));

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(taskDir);
  const event = journal.find((e) => e.event === 'empty-implement');
  assert.ok(event, 'expected an empty-implement journal event');
  assert.equal(event.filesChanged, null);
});

test('handleImplement (real mode): a legitimate implement with red tests (non-empty filesChanged, all_green false) still goes to CHECK', async () => {
  const task = baseTask(250);
  const taskDir = mkTmp('spo-implement-redtests-');
  const spawn = () =>
    fakeSpawnedChild(
      claudeStream({
        summary: 'added the widget, one test still failing',
        files_changed: ['src/widget.ts'],
        invariants: [{ id: 'INV-1', status: 'HELD' }],
        tests_run: ['npm run typecheck'],
        all_green: false,
      })
    );
  const spawnSync = (command, args) => {
    // The worktree cross-check (state-machine.js's handleImplement, card #385) reads
    // `git status --porcelain` before trusting a non-empty files_changed claim -- report the
    // worktree as genuinely dirty so this legitimate implement still reaches CHECK.
    if (args && args.includes('status') && args.includes('--porcelain')) return ok(' M src/widget.ts\n');
    return ok('');
  };
  const ctx = realCardCtx(task, taskDir, fakeExecDeps({ spawn, spawnSync }));

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'CHECK');
});

// card #385: IMPLEMENT declared 30 files_changed while the worktree had not actually moved --
// CHECK then passed on the untouched tree, and PUSH_PR only parked (push-pr-failed, "nothing to
// commit") two states later, on a misleading reason. A non-empty, well-shaped files_changed
// claim is no longer enough on its own -- the worktree itself must show the change.
test('handleImplement (real mode): non-empty filesChanged but a CLEAN worktree routes to DIAGNOSE, journals no-worktree-change', async () => {
  const task = baseTask(385);
  const taskDir = mkTmp('spo-implement-noworktreechange-');
  const spawn = () =>
    fakeSpawnedChild(
      claudeStream({
        summary: 'implemented the widget',
        files_changed: ['src/widget.ts', 'src/widget.test.ts'],
        invariants: [{ id: 'INV-1', status: 'HELD' }],
        tests_run: ['npm run typecheck'],
        all_green: true,
      })
    );
  const spawnSync = (command, args) => {
    if (args && args.includes('status') && args.includes('--porcelain')) return ok(''); // clean -- nothing actually changed
    return ok('');
  };
  const ctx = realCardCtx(task, taskDir, fakeExecDeps({ spawn, spawnSync }));

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(taskDir);
  const event = journal.find((e) => e.event === 'no-worktree-change');
  assert.ok(event && event.claimedFilesChanged === 2);
});

// A fake worktree whose HEAD is `before` until the claude call returns, `after` from then on --
// the shape of an IMPLEMENT that committed (or did not commit) inside its own session. Returns
// `{spawn, spawnSync}` (Job 3: split off the old single dispatching `spawnSync`, `command ===
// 'claude'` branch onto `spawn`) -- both share the `implemented` closure flag, so `spawnSync`'s
// `git rev-parse HEAD` still reads correctly whether it runs before or after the claude call.
function headMovingSpawn({ before, after, porcelain, beforeExit = 0 }) {
  let implemented = false;
  const spawn = () => {
    implemented = true;
    return fakeSpawnedChild(
      claudeStream({
        summary: 'fixed the flaky wall-clock test and committed it',
        files_changed: ['src/e2e/bench/worker.test.ts'],
        invariants: [{ id: 'INV-1', status: 'HELD' }],
        tests_run: ['npm test'],
        all_green: true,
      })
    );
  };
  const spawnSync = (command, args) => {
    if (args && args.includes('rev-parse') && args.includes('HEAD')) {
      if (implemented) return ok(`${after}\n`);
      return { ...ok(`${before}\n`), status: beforeExit };
    }
    if (args && args.includes('status') && args.includes('--porcelain')) return ok(porcelain);
    return ok('');
  };
  return { spawn, spawnSync };
}

// issue-593 / issue-598: IMPLEMENT committed its fix itself, so the tree was clean and the
// porcelain-only guard sent a finished IMPLEMENT to DIAGNOSE until the card parked. Both runs were
// post-gate retries -- HEAD was already past the base sha before IMPLEMENT started.
test('handleImplement (real mode): a COMMITTED fix on a clean worktree (HEAD moved during the attempt) goes to CHECK', async () => {
  const task = baseTask(593);
  const taskDir = mkTmp('spo-implement-committed-');
  const before = 'ac1d4ebe7feabd13790922e47c311a1115cdd6f1';
  const after = '9e87f89e00000000000000000000000000000000';
  const ctx = realCardCtx(task, taskDir, fakeExecDeps(headMovingSpawn({ before, after, porcelain: '' })));

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'CHECK');
  const journal = readJournal(taskDir);
  assert.equal(journal.find((e) => e.event === 'no-worktree-change'), undefined);
  const moved = journal.find((e) => e.event === 'worktree-moved-by-commit');
  assert.ok(moved, 'expected a worktree-moved-by-commit journal event');
  assert.equal(moved.headBefore, before);
  assert.equal(moved.headAfter, after);
});

// Card #385's protection with HEAD readable on both sides: a claim of files_changed, a clean tree,
// and the same HEAD before and after -- nothing was modified and nothing was committed.
test('handleImplement (real mode): clean worktree AND an unchanged HEAD still routes to DIAGNOSE', async () => {
  const task = baseTask(386);
  const taskDir = mkTmp('spo-implement-headunchanged-');
  const sha = 'ac1d4ebe7feabd13790922e47c311a1115cdd6f1';
  const ctx = realCardCtx(task, taskDir, fakeExecDeps(headMovingSpawn({ before: sha, after: sha, porcelain: '' })));

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(taskDir);
  const event = journal.find((e) => e.event === 'no-worktree-change');
  assert.ok(event, 'expected a no-worktree-change journal event');
  assert.equal(event.headBefore, sha);
  assert.equal(event.headAfter, sha);
  assert.equal(journal.find((e) => e.event === 'worktree-moved-by-commit'), undefined);
});

// A failing `git rev-parse HEAD` prints the literal `HEAD` on stdout. If that were read as a sha, an
// unreadable-before / readable-after pair would compare unequal and wave an untouched tree through.
test('handleImplement (real mode): an unreadable pre-attempt HEAD falls back to porcelain alone -- clean tree routes to DIAGNOSE', async () => {
  const task = baseTask(387);
  const taskDir = mkTmp('spo-implement-headunreadable-');
  const ctx = realCardCtx(
    task,
    taskDir,
    fakeExecDeps(headMovingSpawn({ before: 'HEAD', after: '9e87f89e00000000000000000000000000000000', porcelain: '' }))
  );

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'DIAGNOSE');
  const event = readJournal(taskDir).find((e) => e.event === 'no-worktree-change');
  assert.ok(event);
  assert.equal(event.headBefore, null);
});

test('handleImplement (real mode): a pre-attempt rev-parse that EXITS non-zero is unreadable even when stdout looks like a sha', async () => {
  const task = baseTask(388);
  const taskDir = mkTmp('spo-implement-headexit-');
  const ctx = realCardCtx(
    task,
    taskDir,
    fakeExecDeps(
      headMovingSpawn({
        before: 'ac1d4ebe7feabd13790922e47c311a1115cdd6f1',
        beforeExit: 128,
        after: '9e87f89e00000000000000000000000000000000',
        porcelain: '',
      })
    )
  );

  assert.equal(await HANDLERS.IMPLEMENT(ctx), 'DIAGNOSE');
});

test('handleImplement (shadow mode): an explicit empty-filesChanged fixture is exempt -- shadow mode is not validated, still reaches CHECK', async () => {
  const taskDir = mkTmp('spo-implement-shadow-empty-');
  const task = {
    id: 'synth-1',
    kind: 'synthetic',
    shadow: { llm: { IMPLEMENT: { ok: true, filesChanged: '[]', allGreen: false } } },
  };
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'CHECK');
});

test('handleImplement (shadow mode): no llm.IMPLEMENT fixture wired (null default) still reaches CHECK, unchanged pre-existing behaviour', async () => {
  const taskDir = mkTmp('spo-implement-shadow-nofixture-');
  const task = { id: 'synth-2', kind: 'synthetic' };
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'CHECK');
});
