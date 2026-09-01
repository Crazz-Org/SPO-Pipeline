'use strict';
// Action 4.6 -- sweepWorktreeLeftovers' rule 3 (remote branch cleanup, orchestrator/steps/
// scripted.js) used to delete `origin/claude-pipe/<id>` on nothing but "the ref exists". Deleting
// a remote branch on GitHub auto-closes any open PR built from it as a side effect -- observed
// live on card #455, where a retry silently closed a green, merge-ready PR and orphaned its
// commits; the work was recovered only because a `rescue/issue-455-run1` tag was made by hand.
//
// Rule 3 now, in order, only when the remote ref exists: (1) vouch for the tip (ancestor of
// origin/main) or preserve it to a durable `wip/<id>-<ts>` ref before anything destructive runs;
// (2) look up and close any open PR on the branch deliberately, so the journal records a decision
// instead of a GitHub side effect; (3) only then `push origin --delete`. A PR *lookup* failure
// (non-zero exit or unparsable JSON) parks rather than guesses "no PR" -- guessing would let the
// delete close a real PR invisibly, which is the exact bug this rule exists to fix. This mirrors
// park-loop.js's abandonCleanup, which closes the PR before ever touching the branch for the same
// reason.
//
// Conventions follow test/real-steps.test.js: every git/gh call is a fake injected via
// deps.spawnSync, every fs path is a fs.mkdtempSync(os.tmpdir()) directory, and assertions read
// the journal + recorded argv, never prose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { realWorktree } = require('../orchestrator/steps/scripted');
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

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-leftover-pr-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-leftover-pr-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    ...overrides,
  };
}

function testCtx({ id, task, config, taskDir } = {}) {
  return buildCtx(id, task, taskDir || mkTmp('spo-leftover-pr-taskdir-'), {
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

// Every test here drives realWorktree end to end (rather than calling sweepWorktreeLeftovers
// directly, which isn't exported) so the "no local branch leftover" precondition and the
// worktree-add-proceeds-after assertion come for free, exactly like test/real-steps.test.js's own
// rule-3 coverage. `worktree list`/no local branch/`origin/main` all return defaults that clear
// rules 1 and 2 harmlessly; each test overrides only what rule 3 itself needs.
function baseHandlers({ branch, remoteSha, remoteExists = true }) {
  return {
    worktreeList: () => ok(''), // no worktree-path leftover
    localBranch: () => fail(1), // no local branch leftover
    originMain: () => ok('originmainsha00000000000000000000000000\n'),
    remoteBranch: () => (remoteExists ? ok(`${remoteSha}\n`) : fail(1)),
    boardTake: () => ok('claimed\n'),
  };
}

function makeDeps({ branch, remoteSha, remoteExists = true, overrides = {} }) {
  const h = { ...baseHandlers({ branch, remoteSha, remoteExists }), ...overrides };
  const calls = [];
  const spawnSync = (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts && opts.cwd });
    if (command === 'git' && args.includes('worktree') && args.includes('list')) return h.worktreeList();
    if (command === 'git' && args.includes('rev-parse') && args.includes(`refs/heads/${branch}`)) return h.localBranch();
    if (command === 'git' && args.includes('rev-parse') && args.includes(`refs/remotes/origin/${branch}`)) return h.remoteBranch();
    if (command === 'git' && args.includes('rev-parse') && args.includes('origin/main')) return h.originMain();
    if (command === 'git' && args.includes('merge-base') && args.includes('--is-ancestor')) {
      return h.ancestorOfMain ? h.ancestorOfMain() : ok(''); // default: contained in main
    }
    if (command === 'gh' && args.includes('pr') && args.includes('list')) {
      return h.prList ? h.prList() : ok('[]');
    }
    if (command === 'gh' && args.includes('pr') && args.includes('close')) {
      return h.prClose ? h.prClose() : ok('');
    }
    if (args.includes('board:take')) return h.boardTake();
    return ok('');
  };
  return { calls, deps: { spawnSync } };
}

// -- 1. contained in origin/main, no open PR: no wip push, no gh pr close, delete proceeds -----

test('remote tip contained in origin/main, no open PR: no wip push, no gh pr close, delete carries preservedRef/closedPr null', async () => {
  const id = 'card-remote-a';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaINMAIN00000000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: { ancestorOfMain: () => ok('') }, // exit 0 -- contained in origin/main
  });

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  assert.ok(!calls.some((c) => c.args.some((a) => a.startsWith && a.startsWith(`${remoteSha}:refs/heads/wip/`))), 'no wip preserve push expected');
  assert.ok(!calls.some((c) => c.command === 'gh' && c.args.includes('close')), 'no gh pr close expected');
  const deleteIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete') && c.args.includes(branch));
  assert.ok(deleteIdx !== -1, 'expected git push origin --delete <branch>');

  const journal = readJournal(ctx.taskDir);
  const cleaned = journal.find((e) => e.event === 'remote-branch-cleaned');
  assert.ok(cleaned);
  assert.equal(cleaned.branch, branch);
  assert.equal(cleaned.sha, remoteSha);
  assert.equal(cleaned.preservedRef, null);
  assert.equal(cleaned.closedPr, null);
});

// -- 2. NOT contained in origin/main, no open PR: wip push issued with the right refspec --------

test('remote tip NOT contained in origin/main, no open PR: wip push issued with correct refspec, leftover-remote-preserved journalled, then the delete', async () => {
  const id = 'card-remote-b';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaNOTINMAIN000000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: { ancestorOfMain: () => fail(1) }, // NOT an ancestor of origin/main
  });

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  // The exact timestamp is not predictable -- match by prefix instead of a literal ref.
  const preserveCall = calls.find(
    (c) => c.command === 'git' && c.args[c.args.length - 1] && c.args[c.args.length - 1].startsWith(`${remoteSha}:refs/heads/wip/${id}-`)
  );
  assert.ok(preserveCall, 'expected a push of the remote tip to a wip/<id>-<ts> ref');
  assert.deepEqual(preserveCall.args.slice(0, 3), ['-C', config.productRepo, 'push']);

  const journal = readJournal(ctx.taskDir);
  const preserved = journal.find((e) => e.event === 'leftover-remote-preserved');
  assert.ok(preserved && preserved.branch === branch && preserved.sha === remoteSha);
  assert.ok(preserved.ref.startsWith(`wip/${id}-`));

  const preserveIdx = calls.indexOf(preserveCall);
  const deleteIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete') && c.args.includes(branch));
  assert.ok(deleteIdx !== -1 && preserveIdx < deleteIdx, 'the preserve push must run before the delete');

  const cleaned = journal.find((e) => e.event === 'remote-branch-cleaned');
  assert.ok(cleaned && cleaned.preservedRef === preserved.ref && cleaned.closedPr === null);
});

// -- 3. Open PR present: argv order is preserve (if needed) -> gh pr close -> push --delete -----

test('open PR present, tip already in origin/main: order is gh pr close THEN push --delete (no preserve needed)', async () => {
  const id = 'card-remote-c';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaWITHPR00000000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: {
      ancestorOfMain: () => ok(''), // contained in main -- no preserve needed
      prList: () => ok(JSON.stringify([{ number: 999 }])),
      prClose: () => ok(''),
    },
  });

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  const closeIdx = calls.findIndex((c) => c.command === 'gh' && c.args.includes('close') && c.args.includes('999'));
  const deleteIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete') && c.args.includes(branch));
  assert.ok(closeIdx !== -1, 'expected gh pr close 999');
  assert.ok(deleteIdx !== -1, 'expected the delete to still run');
  assert.ok(closeIdx < deleteIdx, 'gh pr close must run BEFORE push --delete, never after');

  const journal = readJournal(ctx.taskDir);
  const closed = journal.find((e) => e.event === 'leftover-pr-closed');
  assert.ok(closed && closed.prNumber === 999 && closed.branch === branch);
  const cleaned = journal.find((e) => e.event === 'remote-branch-cleaned');
  assert.ok(cleaned && cleaned.closedPr === 999 && cleaned.preservedRef === null);
});

test('open PR present AND tip not in main: order is preserve -> gh pr close -> push --delete', async () => {
  const id = 'card-remote-c2';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaWITHPRUNMERGED0000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: {
      ancestorOfMain: () => fail(1), // NOT contained in main -- preserve required
      prList: () => ok(JSON.stringify([{ number: 1000 }])),
      prClose: () => ok(''),
    },
  });

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  const preserveIdx = calls.findIndex(
    (c) => c.command === 'git' && c.args[c.args.length - 1] && c.args[c.args.length - 1].startsWith(`${remoteSha}:refs/heads/wip/`)
  );
  const closeIdx = calls.findIndex((c) => c.command === 'gh' && c.args.includes('close') && c.args.includes('1000'));
  const deleteIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete') && c.args.includes(branch));

  assert.ok(preserveIdx !== -1 && closeIdx !== -1 && deleteIdx !== -1, 'expected all three calls');
  assert.ok(preserveIdx < closeIdx, 'preserve must run before gh pr close');
  assert.ok(closeIdx < deleteIdx, 'gh pr close must run before push --delete');

  const journal = readJournal(ctx.taskDir);
  const cleaned = journal.find((e) => e.event === 'remote-branch-cleaned');
  assert.ok(cleaned && cleaned.closedPr === 1000 && cleaned.preservedRef && cleaned.preservedRef.startsWith(`wip/${id}-`));
});

// -- 4. wip push fails: parks worktree-cleanup-failed{step:'remote-preserve'}, no delete at all -

test('wip preserve push fails: parks worktree-cleanup-failed step remote-preserve, no delete argv issued', async () => {
  const id = 'card-remote-d';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaPRESERVEFAILS00000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: {
      ancestorOfMain: () => fail(1), // NOT contained in main -- preserve required
      // The preserve push is the ONLY `git push origin <sha>:refs/heads/wip/...` call -- distinct
      // from the later `push origin --delete`, so failing only the preserve is unambiguous.
    },
  });
  // Override spawnSync directly to fail exactly the preserve push while leaving everything else
  // (including a later push --delete, which must never be reached) on the default success path.
  const originalSpawnSync = deps.spawnSync;
  deps.spawnSync = (command, args, opts) => {
    if (command === 'git' && args.includes('push') && args.some((a) => a.startsWith(`${remoteSha}:refs/heads/wip/`))) {
      const call = { command, args: [...args], cwd: opts && opts.cwd };
      calls.push(call);
      return fail(1, 'no network');
    }
    return originalSpawnSync(command, args, opts);
  };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'worktree-cleanup-failed' && err.detail.step === 'remote-preserve'
  );

  assert.ok(!calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')), 'the delete must never run when the preserve failed');
  assert.ok(!calls.some((c) => c.command === 'gh'), 'gh pr list/close must never run when the preserve failed -- refused before either');
});

// -- 5. gh pr list fails / unparsable: parks worktree-cleanup-failed{step:'remote-pr-lookup'} ---

test('gh pr list exits non-zero: parks worktree-cleanup-failed step remote-pr-lookup, no delete argv', async () => {
  const id = 'card-remote-e';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaLISTFAILS00000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: {
      ancestorOfMain: () => ok(''), // contained in main -- isolate the pr-list failure
      prList: () => fail(1, 'rate limited'),
    },
  });

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'worktree-cleanup-failed' && err.detail.step === 'remote-pr-lookup'
  );

  assert.ok(!calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')), 'no delete when the PR lookup failed');
  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'leftover-pr-lookup-failed' && e.branch === branch));
});

test('gh pr list returns unparsable JSON: parks worktree-cleanup-failed step remote-pr-lookup, no delete argv', async () => {
  const id = 'card-remote-f';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaUNPARSABLE0000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: {
      ancestorOfMain: () => ok(''),
      prList: () => ok('not-json{{{'),
    },
  });

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'worktree-cleanup-failed' && err.detail.step === 'remote-pr-lookup'
  );

  assert.ok(!calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')), 'no delete when the PR lookup output was unparsable');
  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'leftover-pr-lookup-failed' && e.branch === branch));
});

// -- 6. gh pr close fails: parks worktree-cleanup-failed{step:'remote-pr-close'} ----------------

test('gh pr close fails: parks worktree-cleanup-failed step remote-pr-close, no delete argv issued', async () => {
  const id = 'card-remote-g';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaCLOSEFAILS00000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: {
      ancestorOfMain: () => ok(''),
      prList: () => ok(JSON.stringify([{ number: 42 }])),
      prClose: () => fail(1, 'gh: could not close'),
    },
  });

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'worktree-cleanup-failed' &&
      err.detail.step === 'remote-pr-close' &&
      err.detail.prNumber === 42
  );

  assert.ok(!calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')), 'no delete when gh pr close failed');
});

// -- 7. No remote branch at all: none of the new calls are made, argv unchanged from before -----

test('no remote branch leftover at all: none of the new preserve/pr-list/pr-close calls are made', async () => {
  const id = 'card-remote-h';
  const branch = `claude-pipe/${id}`;
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({ branch, remoteSha: null, remoteExists: false });

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  assert.ok(!calls.some((c) => c.command === 'gh'), 'no gh call of any kind expected -- nothing to check a PR for');
  assert.ok(!calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')), 'no delete expected');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'remote-branch-cleaned'));
  assert.ok(!journal.some((e) => e.event === 'leftover-remote-preserved'));
  assert.ok(!journal.some((e) => e.event === 'leftover-pr-closed'));
});

// -- 8. Rules 1/2 regression: an unvouched local tip still parks branch-unmerged-leftover -------

test('regression: rules 1 and 2 are unchanged -- an unvouched local-only tip still parks branch-unmerged-leftover', async () => {
  const id = 'card-remote-i';
  const branch = `claude-pipe/${id}`;
  const localSha = 'localonlyshaSTILLPARKS00000000000000000';
  const remoteSha = 'staleremoteSTILLPARKS000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('worktree') && args.includes('list')) return ok('');
      if (args.includes('rev-parse') && args.includes(`refs/heads/${branch}`)) return ok(`${localSha}\n`);
      if (args.includes('merge-base') && args.includes('--is-ancestor')) return fail(1); // not an ancestor of main
      if (args.includes('rev-parse') && args.includes(`refs/remotes/origin/${branch}`)) return ok(`${remoteSha}\n`);
      if (args.includes('for-each-ref')) return ok(''); // no wip/<id>-* ref covers it
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha00000000000000000000000000\n');
      return ok('');
    },
  };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'branch-unmerged-leftover' &&
      err.detail.localSha === localSha &&
      err.detail.remoteSha === remoteSha
  );

  // Rule 2 parks before rule 3 is ever reached -- none of rule 3's own calls (gh, or a preserve
  // push distinct from the branch -D rule 2 itself never issues here) show up.
  assert.ok(!calls.some((c) => c.command === 'gh'), 'rule 3 must never run once rule 2 has parked');
  assert.ok(!calls.some((c) => c.args.includes('-D')), 'an unmerged local-only branch must never be deleted');
});

// -- 9. The exact argv of every call rule 3 added ----------------------------------------------
//
// Added in verification of action 4.6, because mutation testing proved tests 1-8 above pass for
// the wrong reason on the single most dangerous edit anyone could make to this rule: dropping
// `--head <branch>` from the `gh pr list` lookup. Every assertion above matches the lookup with
// `args.includes('pr') && args.includes('list')`, so an unfiltered `gh pr list --repo X --state
// open --json number` still satisfies all of them -- while in production it would answer with
// SPO-WebClient's OLDEST open PR, whatever branch it belongs to, and rule 3 would then
// `gh pr close` and orphan a PR that has nothing to do with this task. That is card #455's bug
// back, aimed at a stranger's work instead of the task's own, and the suite was blind to it.
// Same class for `--repo`: pointed at the wrong repository, the lookup answers "no PR" for a
// branch that has one and the delete closes it invisibly again.
//
// So this test asserts the four argv arrays rule 3 issues, in full and in order, rather than by
// membership. It is the contract, not a restatement: `gh pr list`'s shape is deliberately
// identical to realPushPr's own lookup a few hundred lines below in steps/scripted.js, and the
// preserve push must run `-C <productRepo>` (the worktree this sweep is clearing does not exist
// yet -- pushing from it could only fail).
test('rule 3 argv contract: preserve push, gh pr list, gh pr close and the delete are issued verbatim, in order', async () => {
  const id = 'card-remote-argv';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaARGVCONTRACT000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const { calls, deps } = makeDeps({
    branch,
    remoteSha,
    overrides: {
      ancestorOfMain: () => fail(1), // preserve required, so all four calls are on this path
      prList: () => ok(JSON.stringify([{ number: 1234 }])),
      prClose: () => ok(''),
    },
  });

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  const journal = readJournal(ctx.taskDir);
  const preservedRef = journal.find((e) => e.event === 'leftover-remote-preserved').ref;

  const idx = (pred) => calls.findIndex(pred);
  const preserveIdx = idx((c) => c.command === 'git' && c.args.includes('push') && c.args.includes(`${remoteSha}:refs/heads/${preservedRef}`));
  const listIdx = idx((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'list');
  const closeIdx = idx((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close');
  const deleteIdx = idx((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete'));

  assert.ok(preserveIdx !== -1 && listIdx !== -1 && closeIdx !== -1 && deleteIdx !== -1, 'all four calls must be issued');
  assert.ok(preserveIdx < listIdx && listIdx < closeIdx && closeIdx < deleteIdx, 'order: preserve -> pr list -> pr close -> delete');

  assert.deepEqual(calls[preserveIdx].args, [
    '-C',
    config.productRepo,
    'push',
    'origin',
    `${remoteSha}:refs/heads/${preservedRef}`,
  ]);
  // Verbatim realPushPr's own `gh pr list` argv -- `--head <branch>` above all, without which the
  // lookup answers about a PR this task does not own.
  assert.deepEqual(calls[listIdx].args, [
    'pr',
    'list',
    '--repo',
    config.ghRepo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  assert.deepEqual(calls[closeIdx].args, ['pr', 'close', '1234', '--repo', config.ghRepo]);
  assert.deepEqual(calls[deleteIdx].args, ['-C', config.productRepo, 'push', 'origin', '--delete', branch]);

  // And exactly one lookup and one close -- not a retry loop, not a second close after the delete.
  assert.equal(calls.filter((c) => c.command === 'gh' && c.args[1] === 'list').length, 1);
  assert.equal(calls.filter((c) => c.command === 'gh' && c.args[1] === 'close').length, 1);
});

// -- 10. The `-<ts>` half of the wip ref name is load-bearing, not decoration -------------------
//
// Added in verification of action 4.6. Test 2 above only asserts the ref starts with
// `wip/<id>-`, so replacing `Date.now()` with any constant survives it -- and that constant is a
// permanent WORKTREE-stage deadlock, the exact shape the spec forbade for this rule:
//
//   pass 1  rule 3 preserves remote tip R1 to wip/<id>-K, deletes origin/claude-pipe/<id>
//   pass 2  PUSH_PR pushes a fresh branch cut from a newer origin/main -- tip R2, no relation
//           to R1 -- then the card parks somewhere past WORKTREE
//   retry   rule 3 preserves R2 to wip/<id>-K again: origin already has K at R1, R2 is not a
//           descendant, the push is rejected non-fast-forward -> ParkSignal
//           worktree-cleanup-failed{step:'remote-preserve'} -- and every later `retry` a
//           maintainer types reproduces it identically, because the ref that blocks the push is
//           the one the pipeline itself wrote and never removes.
//
// A distinct name per preserve is what makes the failure transient instead of terminal, so the
// name is asserted as a contract: `<id>-<epoch-ms>`, digits only, recent. (Two successive sweeps
// are not compared directly -- in-process they can land in the same millisecond, and the
// production gap between two rule-3 passes is a whole pipeline run.)
test('the preserved wip ref carries a real timestamp, not a constant -- a fixed name would deadlock every later retry', async () => {
  const id = 'card-remote-ts';
  const branch = `claude-pipe/${id}`;
  const remoteSha = 'remoteshaTIMESTAMPED0000000000000000000';
  const config = testConfig();
  const ctx = testCtx({ id, task: { id, kind: 'card', issue: 455 }, config });
  const before = Date.now();
  const { deps } = makeDeps({ branch, remoteSha, overrides: { ancestorOfMain: () => fail(1) } });

  await realWorktree(ctx, deps);
  const after = Date.now();

  const ref = readJournal(ctx.taskDir).find((e) => e.event === 'leftover-remote-preserved').ref;
  const m = new RegExp(`^wip/${id}-(\\d+)$`).exec(ref);
  assert.ok(m, `wip ref must be wip/<id>-<epoch-ms>, got ${ref}`);
  const ts = Number(m[1]);
  assert.ok(ts >= before && ts <= after, `wip ref timestamp ${ts} must be this sweep's own clock reading`);
});
