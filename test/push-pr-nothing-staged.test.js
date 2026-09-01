'use strict';
// Action 4.1 -- realPushPr's `git commit` exit-1 handling (orchestrator/steps/scripted.js,
// realPushPr, just after the `commit` spawnStep). `git commit` exits 1 on "nothing to commit",
// which is reached from two structurally different places: the main-moved merge commit
// (realCiChecks already committed it, so `git add -A; git commit` here has nothing left to
// stage) and a genuinely empty pass (nothing implemented, or a tip origin already has -- card
// #213, run 1: journal/issue-213/journal.jsonl, PR created 19:23:03, commit exit 1 at 19:38:02
// with the tip already pushed). The fix distinguishes them by whether origin already has this
// tip, not by HEAD vs origin/main -- see the comment above the `if (commit.exit !== 0)` block in
// scripted.js for the full argument and the #213 measurement.
//
// Same convention as test/real-steps.test.js: every spawn is a fake injected via deps.spawnSync,
// no real git/gh ever runs, and every path used is an fs.mkdtempSync(os.tmpdir()) directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { realPushPr } = require('../orchestrator/steps/scripted');
const { buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

// `git rev-parse <ref>` when <ref> does not resolve -- stdout carries the ref name, not nothing.
function revParseFatal(status, ref) {
  return {
    status,
    stdout: `${ref}\n`,
    stderr: `fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.\n`,
    signal: null,
  };
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-pps-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-pps-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    ...overrides,
  };
}

function testCtx({ id = 'card-1', task, config, taskDir } = {}) {
  return buildCtx(id, task, taskDir || mkTmp('spo-pps-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Shared dispatcher for the `commit.exit !== 0` diagnostics: `git status --porcelain`, then
// `git rev-parse HEAD`, `git rev-parse --verify --quiet refs/remotes/origin/<branch>`, and
// `git rev-parse origin/main`. `commitExit: 0` skips all of this (test 7 relies on that).
function pushPrSpawnSync(calls, opts = {}) {
  const {
    commitExit = 1,
    statusOut = '',
    statusExit = 0,
    head = 'headsha1111111111111111111111111111111111',
    headRevParseExit = 0,
    remoteBranchSha = null, // null -> `rev-parse --verify --quiet` exits non-zero (no remote tip)
    mainSha = 'mainsha2222222222222222222222222222222222',
    mainRevParseExit = 0,
    prUrl = 'https://github.com/Crazz-Org/SPO-WebClient/pull/999\n',
  } = opts;

  return (command, args) => {
    calls.push({ command, args: [...args] });

    if (command === 'git') {
      if (args.includes('commit')) return commitExit === 0 ? ok('') : fail(commitExit);
      if (args.includes('status')) return statusExit === 0 ? ok(statusOut) : fail(statusExit);
      if (args.includes('--verify')) return remoteBranchSha === null ? fail(1) : ok(`${remoteBranchSha}\n`);
      // A FAILING `git rev-parse <ref>` does NOT come back empty: it exits 128, writes
      // "fatal: ambiguous argument '<ref>'" to stderr, and writes THE REF NAME ITSELF to
      // stdout (measured against real git on an orphan/unborn HEAD). Both failure fixtures
      // below model that faithfully -- an empty-stdout fake would hide the exact reason an
      // unchecked exit here is dangerous rather than merely lossy.
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        if (headRevParseExit !== 0) return revParseFatal(headRevParseExit, 'HEAD');
        return ok(`${head}\n`);
      }
      if (args.includes('rev-parse') && args.includes('origin/main')) {
        if (mainRevParseExit !== 0) return revParseFatal(mainRevParseExit, 'origin/main');
        return ok(`${mainSha}\n`);
      }
      return ok(''); // add, push, diff --name-only, diff -U0 (no rdo touch in any of these fixtures)
    }
    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') return ok('[]'); // no PR to reuse
      if (args[0] === 'pr' && args[1] === 'create') return ok(prUrl);
      return ok('');
    }
    return ok('');
  };
}

function findPush(calls) {
  return calls.find((c) => c.command === 'git' && c.args.includes('push'));
}

function findEvent(taskDir, event) {
  return readJournal(taskDir).find((e) => e.event === event);
}

test('realPushPr: main-moved merge commit (clean tree, remote branch never pushed) -> commit skipped, push attempted, no park', async () => {
  const worktreePath = mkTmp('spo-pps-mm1-wt-');
  const branch = 'claude-pipe/card-pps-mm1';
  const task = { id: 'card-pps-mm1', kind: 'card', issue: 601, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-mm1', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '', // clean -- the merge commit already absorbed everything
      head: 'mergecommitM00000000000000000000000000000',
      remoteBranchSha: null, // branch never pushed before
      mainSha: 'originmainX0000000000000000000000000000000',
    }),
  };

  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE'); // reached the PR create/reuse path -- no park

  const push = findPush(calls);
  assert.ok(push, 'push must be attempted');
  assert.deepEqual(push.args, ['-C', worktreePath, 'push', '-u', 'origin', branch]);

  const skipped = findEvent(ctx.taskDir, 'commit-skipped-nothing-staged');
  assert.ok(skipped, 'commit-skipped-nothing-staged must be journalled');
  assert.equal(skipped.head, 'mergecommitM00000000000000000000000000000');
  assert.equal(skipped.remoteBranchSha, null);
  assert.equal(skipped.branch, branch);
});

test('realPushPr: main-moved merge commit, remote branch exists at a DIFFERENT sha -> commit skipped, push attempted, no park', async () => {
  const worktreePath = mkTmp('spo-pps-mm2-wt-');
  const branch = 'claude-pipe/card-pps-mm2';
  const task = { id: 'card-pps-mm2', kind: 'card', issue: 602, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-mm2', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '',
      head: 'mergecommitM11111111111111111111111111111',
      remoteBranchSha: 'oldpushR22222222222222222222222222222222', // a stale, different remote tip
      mainSha: 'originmainX1111111111111111111111111111111',
    }),
  };

  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE');

  const push = findPush(calls);
  assert.ok(push, 'push must be attempted');
  assert.deepEqual(push.args, ['-C', worktreePath, 'push', '-u', 'origin', branch]);

  const skipped = findEvent(ctx.taskDir, 'commit-skipped-nothing-staged');
  assert.ok(skipped);
  assert.equal(skipped.head, 'mergecommitM11111111111111111111111111111');
  assert.equal(skipped.remoteBranchSha, 'oldpushR22222222222222222222222222222222');
  assert.equal(skipped.branch, branch);
});

test("realPushPr: #213's shape -- remote branch tip already equals HEAD -> PARKED push-pr-failed, reason nothing-new-to-push, no push attempted", async () => {
  const worktreePath = mkTmp('spo-pps-213-wt-');
  const branch = 'claude-pipe/card-pps-213';
  const task = { id: 'card-pps-213', kind: 'card', issue: 213, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-213', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '',
      head: 'alreadypushedS3333333333333333333333333333',
      remoteBranchSha: 'alreadypushedS3333333333333333333333333333', // == head
      mainSha: 'originmainX2222222222222222222222222222222',
    }),
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'push-pr-failed' &&
      err.detail.step === 'commit' &&
      err.detail.reason === 'nothing-new-to-push' &&
      err.detail.head === 'alreadypushedS3333333333333333333333333333'
  );

  assert.equal(findPush(calls), undefined, 'no push may be attempted once the tip is already on origin');
});

test('realPushPr: nothing implemented -- HEAD equals origin/main -> PARKED push-pr-failed, reason nothing-implemented, no push attempted', async () => {
  const worktreePath = mkTmp('spo-pps-ni-wt-');
  const branch = 'claude-pipe/card-pps-ni';
  const task = { id: 'card-pps-ni', kind: 'card', issue: 603, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-ni', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '',
      head: 'samesha4444444444444444444444444444444444',
      mainSha: 'samesha4444444444444444444444444444444444', // HEAD === origin/main
      remoteBranchSha: null,
    }),
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'push-pr-failed' &&
      err.detail.step === 'commit' &&
      err.detail.reason === 'nothing-implemented'
  );

  assert.equal(findPush(calls), undefined, 'no push may be attempted when nothing was ever implemented');
});

test('realPushPr: dirty tree after commit exit 1 -> PARKED push-pr-failed, dirty: true, no push attempted', async () => {
  const worktreePath = mkTmp('spo-pps-dirty-wt-');
  const task = { id: 'card-pps-dirty', kind: 'card', issue: 604, title: 't', worktreePath };
  const ctx = testCtx({ id: 'card-pps-dirty', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: ' M src/some-file.ts\n', // non-empty -- a real commit failure, not "nothing to commit"
    }),
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'push-pr-failed' &&
      err.detail.step === 'commit' &&
      err.detail.dirty === true
  );

  assert.equal(findPush(calls), undefined, 'no push may be attempted over a dirty tree');
});

test('realPushPr: `git status --porcelain` itself exits non-zero -> PARKED push-pr-failed carrying statusExit, no push attempted', async () => {
  const worktreePath = mkTmp('spo-pps-statuserr-wt-');
  const task = { id: 'card-pps-statuserr', kind: 'card', issue: 605, title: 't', worktreePath };
  const ctx = testCtx({ id: 'card-pps-statuserr', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusExit: 2, // `git status --porcelain` itself failing (e.g. corrupt worktree)
    }),
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'push-pr-failed' &&
      err.detail.step === 'commit' &&
      err.detail.statusExit === 2
  );

  assert.equal(findPush(calls), undefined, 'the diagnostic failure must never be swallowed into a push attempt');
});

test('realPushPr: `git rev-parse HEAD` itself exits non-zero -> PARKED push-pr-failed carrying revParseFailed HEAD, no push attempted', async () => {
  const worktreePath = mkTmp('spo-pps-headerr-wt-');
  const branch = 'claude-pipe/card-pps-headerr';
  const task = { id: 'card-pps-headerr', kind: 'card', issue: 607, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-headerr', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '', // clean, so the HEAD lookup is reached
      headRevParseExit: 128, // orphan/unborn HEAD: exit 128 and the literal string `HEAD` on stdout
      remoteBranchSha: null,
      mainSha: 'originmainX3333333333333333333333333333333',
    }),
  };

  // Trusting rev-parse's stdout regardless of its exit does not fail closed: `head` would be the
  // literal `"HEAD"`, which matches neither origin/main nor origin/<branch>, so the step would
  // skip BOTH parks, journal `commit-skipped-nothing-staged` with head "HEAD", and fall through
  // to a push that can only fail -- reporting `{step:'push'}` and burying the real cause.
  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'push-pr-failed' &&
      err.detail.step === 'commit' &&
      err.detail.exit === 1 &&
      err.detail.revParseFailed === 'HEAD'
  );

  assert.equal(findPush(calls), undefined, 'an unresolvable HEAD must never be pushed over');
  assert.equal(
    findEvent(ctx.taskDir, 'commit-skipped-nothing-staged'),
    undefined,
    'no skip may be journalled on a HEAD that never resolved'
  );
});

test('realPushPr: `git rev-parse origin/main` itself exits non-zero -> PARKED push-pr-failed carrying revParseFailed origin/main, no push attempted', async () => {
  const worktreePath = mkTmp('spo-pps-mainerr-wt-');
  const branch = 'claude-pipe/card-pps-mainerr';
  const task = { id: 'card-pps-mainerr', kind: 'card', issue: 608, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-mainerr', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '',
      head: 'somehead5555555555555555555555555555555555',
      remoteBranchSha: null,
      mainRevParseExit: 128, // no origin/main remote-tracking ref at all
    }),
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'push-pr-failed' &&
      err.detail.step === 'commit' &&
      err.detail.exit === 1 &&
      err.detail.revParseFailed === 'origin/main'
  );

  assert.equal(findPush(calls), undefined, 'no push may be attempted when origin/main never resolved');
  assert.equal(findEvent(ctx.taskDir, 'commit-skipped-nothing-staged'), undefined);
});

test('realPushPr: whitespace-only `status --porcelain` output counts as CLEAN, not dirty', async () => {
  const worktreePath = mkTmp('spo-pps-ws-wt-');
  const branch = 'claude-pipe/card-pps-ws';
  const task = { id: 'card-pps-ws', kind: 'card', issue: 609, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-ws', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '\n', // the `.trim()` in the emptiness test is what makes this clean
      head: 'mergecommitM66666666666666666666666666666',
      remoteBranchSha: null,
      mainSha: 'originmainX6666666666666666666666666666666',
    }),
  };

  // Pins the `.trim()`: a bare `status.stdout !== ''` reads this as a dirty tree and parks
  // `dirty: true`, stranding the very merge commit this action exists to push.
  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE');
  assert.ok(findPush(calls), 'push must be attempted -- a whitespace-only status is a clean tree');
  assert.ok(findEvent(ctx.taskDir, 'commit-skipped-nothing-staged'));
});

test('realPushPr: sha comparisons are exact equality -- a remote tip that is a PREFIX of HEAD is not a match', async () => {
  const worktreePath = mkTmp('spo-pps-prefix-wt-');
  const branch = 'claude-pipe/card-pps-prefix';
  const task = { id: 'card-pps-prefix', kind: 'card', issue: 610, title: 't', worktreePath, branch };
  const ctx = testCtx({ id: 'card-pps-prefix', task, config: testConfig() });

  const calls = [];
  const deps = {
    spawnSync: pushPrSpawnSync(calls, {
      commitExit: 1,
      statusOut: '',
      head: 'abcdef7777777777777777777777777777777777',
      remoteBranchSha: 'abcdef', // a PREFIX of HEAD -- distinct commits, not the same tip
      mainSha: 'abcdef', // ...and of origin/main too
    }),
  };

  // Guards both comparisons against being weakened to `startsWith`/`includes`: only a full sha
  // match means "origin already has this tip", and anything less would park a card that has
  // real unpushed work as `nothing-new-to-push` / `nothing-implemented`.
  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE');
  assert.ok(findPush(calls), 'a prefix match must not be treated as "origin already has this tip"');
  const skipped = findEvent(ctx.taskDir, 'commit-skipped-nothing-staged');
  assert.ok(skipped);
  assert.equal(skipped.head, 'abcdef7777777777777777777777777777777777');
});

test('realPushPr: commit exit 0 (ordinary path) -> no status/rev-parse diagnostics run at all', async () => {
  const worktreePath = mkTmp('spo-pps-happy-wt-');
  const task = { id: 'card-pps-happy', kind: 'card', issue: 606, title: 't', worktreePath };
  const ctx = testCtx({ id: 'card-pps-happy', task, config: testConfig() });

  const calls = [];
  const deps = { spawnSync: pushPrSpawnSync(calls, { commitExit: 0 }) };

  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE');

  // The new diagnostics (status --porcelain, rev-parse HEAD / --verify / origin/main) live
  // strictly inside `if (commit.exit !== 0)` -- on the ordinary path they must never run at all,
  // not even once. A regression that hoists them out of the guard would still pass every other
  // test in this file (their results would just be discarded) but would fail this one.
  const diagnostic = calls.find(
    (c) => c.command === 'git' && (c.args.includes('status') || c.args.includes('rev-parse'))
  );
  assert.equal(diagnostic, undefined, 'no status/rev-parse call may run when commit succeeded');

  assert.ok(findPush(calls), 'the ordinary push must still happen');
  assert.equal(findEvent(ctx.taskDir, 'commit-skipped-nothing-staged'), undefined);
});
