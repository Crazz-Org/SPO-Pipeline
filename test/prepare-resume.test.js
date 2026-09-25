'use strict';
// prepare-resume.test.js -- card #212, action C2: `prepareResume` (orchestrator/steps/scripted.js)
// is the real-mode-only safety net `runTask`'s resume path (state-machine.js) runs immediately
// before CHECK, on the SAME ctx a `continue` rehydrates. See prepareResume's own header for the
// full contract and doc/state-machine-spec.md's "Resume at CHECK" section for the step list this
// file pins.
//
// Driven through `runTask` -- the actual queue-entry entry point -- in REAL mode, same convention
// as test/push-pr-nothing-staged.test.js and test/merge-regate.test.js: every git/gh spawn is a
// fake injected via `deps.spawnSync`, argv recorded IN ORDER, no real command ever runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- must land before the orchestrator require below (test/no-real-spawn.js's own
// header explains the incident this backstops).
require('./no-real-spawn');
const { runTask } = require('../orchestrator/state-machine');
const { mkTmp, fakeSpawnedChild, fakeExecDeps } = require('./helpers');

const PR_NUMBER = 777;

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function findEvent(taskDir, event) {
  return readJournal(taskDir).find((e) => e.event === event);
}

function readState(taskDir) {
  return JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
}

// F5 (fix pass): the ordered PREFIX of `calls` that belongs to `prepareResume` itself (plus
// whatever ran before it, which is nothing on this file's own entry point), bounded by the first
// journal event named `boundaryEvent` -- `resume-prepared` on a happy path, `parked` on a refusal.
// `finalizePark` journals its OWN `parked` event BEFORE it runs any spawn of its own (the park-time
// `preserveWorktreeWip` housekeeping, when it runs at all -- see finalizePark's own header comment
// in state-machine.js: "THE single `parked` line ... placed after both [re-enqueue] branches
// close" and BEFORE the wip-preserve block that follows it), so counting the journal's own `spawn`
// events strictly before `boundaryEvent` and slicing `calls` to that count yields exactly
// `prepareResume`'s own call sequence, never anything finalizePark's bookkeeping added afterward.
function spawnCallsBeforeEvent(taskDir, calls, boundaryEvent) {
  const journal = readJournal(taskDir);
  const idx = journal.findIndex((e) => e.event === boundaryEvent);
  assert.ok(idx >= 0, `expected a '${boundaryEvent}' event to exist in the journal`);
  const spawnCount = journal.slice(0, idx).filter((e) => e.event === 'spawn').length;
  return calls.slice(0, spawnCount).map((c) => ({ command: c.command, args: c.args }));
}

// Routes every git/gh/npm argv prepareResume + the CHECK/PUSH_PR/GATE spawns that follow it can
// issue on a happy path, to a scripted result -- `calls` records every one, in order, so a
// refusal test can assert exactly which commands never ran. Every option defaults to the shape
// that lets a happy-path run sail all the way past prepareResume into CHECK's own npm spawns.
function resumeSpawnSync(calls, branch, opts = {}) {
  const {
    prState = 'OPEN',
    prViewExit = 0,
    prViewUnparsable = false,
    prHeadRefName = branch, // F6: defaults to the branch the resume descriptor names -- a match
    mergeHeadExit = 1, // non-zero -- no MERGE_HEAD, no merge in progress
    // F3: MERGE_HEAD's own default (mergeHeadExit) is "no merge in progress", so this default is
    // read only by the tests that override mergeHeadExit to 0 -- non-empty (still-unmerged paths)
    // keeps every PRE-F3 test that expects `merge --abort` to run (e.g. 'card-mergehead' below)
    // passing unchanged.
    lsFilesExit = 0,
    lsFilesOut = 'src/conflicted.js\n',
    mergeAbortExit = 0,
    symbolicRefExit = 0,
    symbolicRefBranch = branch,
    statusExit = 0,
    statusOut = '',
    fetchExit = 0,
    remoteRevExit = 0,
    remoteSha = 'remotesha1111111111111111111111111111111',
    localRevExit = 0,
    localSha = remoteSha, // default: HEAD already equals the remote tip -- no fast-forward needed
    ancestorExit = 0,
    aheadExit = null, // card #279 -- see the merge-base branch below
    ffExit = 0,
    checkAliasExit = 0,
    gateExit = 4, // 'gate-timeout' -- a clean, unconditional ParkSignal, no verdict-file parsing
    // PUSH_PR's own `commit` step, reached only once prepareResume + CHECK both succeed -- default
    // 0 (an ordinary commit) so most tests never reach PUSH_PR's own commit-exit-1 diagnostics at
    // all; F4's own resume test overrides this to 1 to reach realPushPr's resume exemption.
    commitExit = 0,
    mainSha = null, // `git rev-parse origin/main` (PUSH_PR's own post-commit-exit-1 diagnostic)
    prListOut = '[]',
    prCreateUrl = `https://github.com/Crazz-Org/SPO-WebClient/pull/${PR_NUMBER}\n`,
    // Card #281: preserveWorktreeWip's push to `wip/`, and the `checkout <branch>` that re-attaches.
    wipPushExit = 0,
    reattachExit = 0,
    reattachTimedOut = false,
    statusTimedOut = false, // card #281 F1: the catch's own tree probe timing out
  } = opts;

  return (command, args, spawnOpts) => {
    // `cwd` recorded too (F1's own regression test needs it -- `npm run board:move` runs with an
    // explicit `cwd` rather than a git `-C` flag) -- every pre-existing assertion in this file
    // only reads `.command`/`.args`, so adding this field changes nothing for them.
    calls.push({ command, args: [...args], cwd: (spawnOpts && spawnOpts.cwd) || null });

    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'view') {
        if (prViewExit !== 0) return fail(prViewExit);
        if (prViewUnparsable) return ok('not-json{{{');
        return ok(JSON.stringify({ state: prState, headRefName: prHeadRefName }));
      }
      if (args[0] === 'pr' && args[1] === 'list') return ok(prListOut);
      if (args[0] === 'pr' && args[1] === 'create') return ok(prCreateUrl);
      return ok('');
    }

    if (command === 'git') {
      if (args.includes('ls-files') && args.includes('-u')) {
        return lsFilesExit === 0 ? ok(lsFilesOut) : fail(lsFilesExit);
      }
      if (args.includes('symbolic-ref')) {
        return symbolicRefExit === 0 ? ok(`${symbolicRefBranch}\n`) : fail(symbolicRefExit);
      }
      if (args.includes('status')) {
        if (statusTimedOut) {
          const error = new Error('spawnSync git ETIMEDOUT');
          error.code = 'ETIMEDOUT';
          return { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error };
        }
        return statusExit === 0 ? ok(statusOut) : fail(statusExit);
      }
      if (args.includes('fetch')) {
        return fetchExit === 0 ? ok('') : fail(fetchExit);
      }
      if (args.includes('merge-base') && args.includes('--is-ancestor')) {
        // Card #279: `--is-ancestor <remote-ref> HEAD` (is HEAD AHEAD of origin?) answers `aheadExit`
        // when a test sets it; every other test only ever issues the HEAD-first direction.
        const first = args[args.indexOf('--is-ancestor') + 1];
        if (aheadExit !== null && typeof first === 'string' && first.startsWith('refs/remotes/origin/')) {
          return { status: aheadExit, stdout: '', stderr: '', signal: null };
        }
        return { status: ancestorExit, stdout: '', stderr: '', signal: null };
      }
      if (args.includes('merge') && args.includes('--abort')) {
        return mergeAbortExit === 0 ? ok('') : fail(mergeAbortExit);
      }
      if (args.includes('merge') && args.includes('--ff-only')) {
        return ffExit === 0 ? ok('') : fail(ffExit);
      }
      if (args.includes('commit')) {
        return commitExit === 0 ? ok('') : fail(commitExit);
      }
      if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) {
        return mergeHeadExit === 0 ? ok('mergeheadsha00000000000000000000000000000\n') : fail(mergeHeadExit);
      }
      if (args.includes('rev-parse') && args.some((a) => typeof a === 'string' && a.startsWith('refs/remotes/origin/'))) {
        return remoteRevExit === 0 ? ok(`${remoteSha}\n`) : fail(remoteRevExit);
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        return localRevExit === 0 ? ok(`${localSha}\n`) : fail(localRevExit);
      }
      // PUSH_PR's own `git rev-parse origin/main` (post-commit-exit-1 diagnostic only) -- `mainSha`
      // null (the default) falls through to the generic `ok('')` below, exactly as before this
      // option existed (an empty string origin/main sha, which differs from every real sha this
      // file uses).
      if (args.includes('rev-parse') && args.includes('origin/main') && mainSha !== null) {
        return ok(`${mainSha}\n`);
      }
      if (args.includes('push') && args.some((a) => typeof a === 'string' && a.includes(':refs/heads/wip/'))) {
        return wipPushExit === 0 ? ok('') : fail(wipPushExit);
      }
      if (args.includes('checkout') && args.includes(branch)) {
        if (reattachTimedOut) {
          // spawnSync's own timeout firing (test/ci-cause-step.test.js's shape): every attempt.
          const error = new Error('spawnSync git ETIMEDOUT');
          error.code = 'ETIMEDOUT';
          return { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error };
        }
        return reattachExit === 0 ? ok('') : fail(reattachExit);
      }
      return ok(''); // add, commit (exit 0), push, diff --name-only, board:move, etc.
    }

    if (command === 'npm') {
      if (args[0] === 'run' && args[1] === 'gate') return { status: gateExit, stdout: '', stderr: '', signal: null };
      return checkAliasExit === 0 ? ok('') : { status: checkAliasExit, stdout: '', stderr: '', signal: null };
    }

    return ok('');
  };
}

function testConfig(pipelineWorktreesDir, overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-pr-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    ...overrides,
  };
}

// Builds a resumed task + its worktree directory (unless `createWorktree` is false), following
// the exact `task.resume` shape C1 validates (state-machine.js's `resumeValidationError`) and the
// `<pipelineWorktreesDir>/<id>` convention `prepareResume`'s own mismatch check enforces.
// `counters` (card #281): present, the descriptor is a machine re-enqueue's (carriedResume or a #251
// poolWaitResume, state-machine.js's isMachineReEnqueueResume); absent, a maintainer's `continue`.
// `source`: 'pool-wait' for a fresh #251 descriptor.
function setupTask(id, { createWorktree = true, worktreePathOverride, startState = 'CHECK', configOverrides = {}, counters, source } = {}) {
  const pipelineWorktreesDir = mkTmp('spo-pr-worktrees-');
  const worktreePath = worktreePathOverride || path.join(pipelineWorktreesDir, id);
  if (createWorktree) fs.mkdirSync(worktreePath, { recursive: true });
  const branch = `claude-pipe/${id}`;
  const taskDir = mkTmp('spo-pr-taskdir-');
  const task = {
    id,
    kind: 'card',
    issue: 900,
    title: 'Resumed card',
    resume: {
      startState,
      prNumber: PR_NUMBER,
      worktreePath,
      commentId: 1,
      fromReason: 'merge-conflict',
      ...(counters !== undefined ? { counters } : {}),
      ...(source !== undefined ? { source } : {}),
    },
  };
  return { pipelineWorktreesDir, worktreePath, branch, taskDir, task, configOverrides };
}

async function runResumed(id, spawnOpts, setupOpts) {
  const { pipelineWorktreesDir, worktreePath, branch, taskDir, task, configOverrides } = setupTask(id, setupOpts);
  const calls = [];
  const config = testConfig(pipelineWorktreesDir, { ...configOverrides, deps: { spawnSync: resumeSpawnSync(calls, branch, spawnOpts) } });
  const finalState = await runTask(task.id, task, taskDir, config);
  return { finalState, calls, taskDir, worktreePath, branch, task };
}

// The `git` subset of a recorded call list -- finalizePark's own bookkeeping (postParkComment's
// `gh issue comment` + its own `moveCard('PARKED')` -> `npm run board:move`, park-alert.js) runs
// unconditionally on EVERY real-mode kind:"card" park, whatever the reason, so a bare "no command
// at all" assertion would fail on every one of them for a reason that has nothing to do with
// prepareResume itself. Filtering to `git` isolates what prepareResume's own sequence (plus
// preserveWorktreeWip's `git status --porcelain` housekeeping, also unconditional -- see below)
// actually issued.
function gitCalls(calls) {
  return calls.filter((c) => c.command === 'git');
}

// Same reasoning, narrowed one step further: when the resumed worktree DOES exist on disk,
// finalizePark's preserveWorktreeWip issues its own `git status --porcelain` unconditionally
// (park-time housekeeping, unrelated to which step parked -- see preserveWorktreeWipUnguarded's
// `!fs.existsSync(worktreePath)` guard). A test whose worktree exists therefore cannot assert
// "zero git commands"; it asserts prepareResume's OWN sequence never issued anything BEYOND that
// one incidental status check.
function gitCallsBeyondWipHousekeeping(calls) {
  return gitCalls(calls).filter((c) => !(c.args.includes('status') && c.args.includes('--porcelain')));
}

function assertParked(taskDir, step, extra = {}) {
  const parked = findEvent(taskDir, 'parked');
  assert.ok(parked, 'expected a parked event');
  assert.equal(parked.reason, 'resume-precondition-failed');
  assert.equal(parked.detail.step, step);
  for (const [k, v] of Object.entries(extra)) {
    assert.equal(parked.detail[k], v, `expected parked.detail.${k} === ${JSON.stringify(v)}, got ${JSON.stringify(parked.detail[k])}`);
  }
  return parked;
}

// ================================================================================================
// ---- happy paths --------------------------------------------------------------------------
// ================================================================================================

test('prepareResume: HEAD already equals the remote tip -- resume-prepared {fastForwardedFrom: null}, no merge --ff-only, the loop reaches CHECK\'s own spawns', async () => {
  const sameSha = 'samesha0000000000000000000000000000000000';
  const { calls, taskDir } = await runResumed('card-happy1', { remoteSha: sameSha, localSha: sameSha });

  const prepared = findEvent(taskDir, 'resume-prepared');
  assert.ok(prepared, 'expected resume-prepared to be journalled');
  assert.equal(prepared.head, sameSha);
  assert.equal(prepared.fastForwardedFrom, null);

  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('--ff-only')),
    undefined,
    'no fast-forward merge may be issued when HEAD already equals the remote tip'
  );

  const checkSpawn = calls.find((c) => c.command === 'npm' && c.args.includes('typecheck'));
  assert.ok(checkSpawn, "expected the loop to reach CHECK's own npm run typecheck spawn");
});

test('prepareResume: remote ahead and HEAD is an ancestor -- fast-forwards, resume-prepared.fastForwardedFrom is the OLD head', async () => {
  const oldHead = 'oldhead11111111111111111111111111111111111';
  const newRemote = 'newremote2222222222222222222222222222222222';
  const { calls, taskDir, branch, worktreePath } = await runResumed('card-happy2', {
    localSha: oldHead,
    remoteSha: newRemote,
    ancestorExit: 0,
    ffExit: 0,
  });

  const prepared = findEvent(taskDir, 'resume-prepared');
  assert.ok(prepared);
  assert.equal(prepared.head, newRemote);
  assert.equal(prepared.fastForwardedFrom, oldHead);

  const ff = calls.find((c) => c.command === 'git' && c.args.includes('--ff-only'));
  assert.ok(ff, 'expected a fast-forward merge to be issued');
  assert.deepEqual(ff.args, ['-C', worktreePath, 'merge', '--ff-only', `refs/remotes/origin/${branch}`]);
});

test('prepareResume: MERGE_HEAD present -- merge --abort issued BEFORE symbolic-ref, resume-merge-aborted journalled, the run continues', async () => {
  const { calls, taskDir } = await runResumed('card-mergehead', { mergeHeadExit: 0, mergeAbortExit: 0 });

  assert.ok(findEvent(taskDir, 'resume-merge-aborted'), 'expected resume-merge-aborted to be journalled');
  assert.ok(findEvent(taskDir, 'resume-prepared'), 'the run must continue past the abort');

  const abortIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('--abort'));
  const symbolicIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('symbolic-ref'));
  assert.ok(abortIdx >= 0 && symbolicIdx >= 0, 'both calls must have happened');
  assert.ok(abortIdx < symbolicIdx, 'merge --abort must be issued BEFORE symbolic-ref');

  // F3: `git ls-files -u` must run BEFORE the abort -- it is what decides whether the abort is
  // safe at all.
  const lsFilesIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('ls-files') && c.args.includes('-u'));
  assert.ok(lsFilesIdx >= 0, 'expected ls-files -u to run');
  assert.ok(lsFilesIdx < abortIdx, 'ls-files -u must be issued BEFORE merge --abort');
});

// F3 (fix pass): `git ls-files -u` came back EMPTY -- every conflict is already resolved and
// staged. `merge --abort` here would discard the maintainer's own resolution; the fix parks
// `merge-in-progress` instead and (via F2) never touches the worktree at all.
test('prepareResume: MERGE_HEAD present, ls-files -u EMPTY (resolved-and-staged) -- parks merge-in-progress, no abort, no detach/commit/push', async () => {
  const { calls, taskDir } = await runResumed('card-merge-resolved', { mergeHeadExit: 0, lsFilesOut: '' });

  assertParked(taskDir, 'merge-in-progress');
  assert.equal(findEvent(taskDir, 'resume-merge-aborted'), undefined, 'a resolved-and-staged merge must never be journalled as aborted');
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('--abort')),
    undefined,
    'merge --abort must never run over a resolved-and-staged merge'
  );
  assert.equal(calls.find((c) => c.command === 'git' && c.args.includes('--detach')), undefined);
  assert.equal(calls.find((c) => c.command === 'git' && c.args.includes('commit')), undefined);
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'), 'F2: the worktree must be left exactly as found');

  const lsFilesIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('ls-files') && c.args.includes('-u'));
  assert.ok(lsFilesIdx >= 0, 'expected ls-files -u to run');
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('symbolic-ref')),
    undefined,
    'no symbolic-ref call may run once merge-in-progress itself parked'
  );
});

test('prepareResume: MERGE_HEAD present, ls-files -u itself fails -- parks ls-files-failed, no abort issued', async () => {
  const { calls, taskDir } = await runResumed('card-lsfiles-fail', { mergeHeadExit: 0, lsFilesExit: 2 });

  assertParked(taskDir, 'ls-files-failed', { exit: 2 });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('--abort')),
    undefined,
    'merge --abort must never run when ls-files -u itself could not answer'
  );
});

// ================================================================================================
// ---- refusals: each parks its own step and issues NO later command ------------------------
// ================================================================================================

test('prepareResume: worktree-path-mismatch -- no git command issued at all', async () => {
  const { pipelineWorktreesDir, taskDir, task } = setupTask('card-mismatch', {
    // `createWorktree: false` -- setupTask would otherwise `mkdirSync` this override path too,
    // which defeats the point: preserveWorktreeWip's own `fs.existsSync` guard (finalizePark's
    // park-time housekeeping, unconditional whenever the worktree exists) must never fire here
    // either, so the path itself must genuinely not exist on disk.
    createWorktree: false,
    worktreePathOverride: path.join(mkTmp('spo-pr-mismatch-elsewhere-'), 'nonexistent-subdir'),
  });
  const calls = [];
  const config = testConfig(pipelineWorktreesDir, { deps: { spawnSync: resumeSpawnSync(calls, 'claude-pipe/card-mismatch') } });

  await runTask(task.id, task, taskDir, config);

  assertParked(taskDir, 'worktree-path-mismatch', {
    expected: path.join(pipelineWorktreesDir, 'card-mismatch'),
    actual: task.resume.worktreePath,
  });
  assert.equal(gitCalls(calls).length, 0, 'no git command may run once the worktree path itself is wrong');
});

// F1 (fix pass): the case the test above deliberately avoided -- the FOREIGN directory the
// resume descriptor names genuinely EXISTS and is dirty. Before F1, `ctx.task.worktreePath` stayed
// set to that foreign path all the way into `finalizePark`, so its own park-time
// `preserveWorktreeWip` housekeeping (`git status --porcelain` finds it dirty) went on to
// `checkout --detach` / `add -A` / `commit` / `push` -- and `postParkComment`'s own `moveCard`
// -- all run with the FOREIGN path, either as a `-C` argv element or as an explicit spawn `cwd`.
test('prepareResume: worktree-path-mismatch, F1 -- the foreign directory EXISTS and is dirty; no command runs against it, state.json never records it', async () => {
  const foreignParent = mkTmp('spo-pr-mismatch-foreign-');
  const foreignWorktreePath = path.join(foreignParent, 'foreign-worktree');
  fs.mkdirSync(foreignWorktreePath, { recursive: true });

  const { pipelineWorktreesDir, taskDir, task } = setupTask('card-mismatch-f1', {
    createWorktree: false, // setupTask must not also create the trusted path -- only the override
    worktreePathOverride: foreignWorktreePath,
  });
  const calls = [];
  const config = testConfig(pipelineWorktreesDir, {
    deps: {
      spawnSync: resumeSpawnSync(calls, 'claude-pipe/card-mismatch-f1', {
        statusOut: ' M some-file.ts\n', // the foreign directory reads dirty on ANY status call
      }),
    },
  });

  await runTask(task.id, task, taskDir, config);

  assertParked(taskDir, 'worktree-path-mismatch', {
    expected: path.join(pipelineWorktreesDir, 'card-mismatch-f1'),
    actual: foreignWorktreePath,
  });

  for (const call of calls) {
    assert.ok(
      !call.args.includes(foreignWorktreePath),
      `no recorded argv may contain the foreign path -- got ${JSON.stringify(call)}`
    );
    assert.notEqual(call.cwd, foreignWorktreePath, `no recorded spawn may use the foreign path as cwd -- got ${JSON.stringify(call)}`);
  }

  const state = readState(taskDir);
  assert.notEqual(state.worktreePath, foreignWorktreePath, 'state.json must never record the foreign path');
  assert.equal(state.worktreePath, null, 'no prior park exists to recover a trusted path from -- null, not a guess');
});

test('prepareResume: worktree-missing -- no git command issued at all', async () => {
  const { calls, taskDir } = await runResumed('card-missing', {}, { createWorktree: false });

  assertParked(taskDir, 'worktree-missing');
  assert.equal(gitCalls(calls).length, 0, 'no git command may run once the worktree does not exist');
});

test('prepareResume: pr-read-failed (gh pr view exits non-zero) -- no git command issued', async () => {
  const { calls, taskDir } = await runResumed('card-prexit', { prViewExit: 1 });

  assertParked(taskDir, 'pr-read-failed', { exit: 1 });
  assert.equal(
    gitCallsBeyondWipHousekeeping(calls).length,
    0,
    'prepareResume must never issue a git command once the PR read itself failed'
  );
  assert.equal(calls[0].command, 'gh');
  assert.equal(calls[0].args[1], 'view');
});

test('prepareResume: pr-read-failed (unparsable gh pr view stdout) -- no git command issued', async () => {
  const { calls, taskDir } = await runResumed('card-prunparse', { prViewUnparsable: true });

  assertParked(taskDir, 'pr-read-failed', { unparsable: true });
  assert.equal(
    gitCallsBeyondWipHousekeeping(calls).length,
    0,
    'prepareResume must never issue a git command once the PR read came back unparsable'
  );
  assert.equal(calls[0].command, 'gh');
  assert.equal(calls[0].args[1], 'view');
});

for (const prState of ['CLOSED', 'MERGED']) {
  test(`prepareResume: pr-not-open (${prState}) -- no git command issued`, async () => {
    const { calls, taskDir } = await runResumed(`card-pr-${prState.toLowerCase()}`, { prState });

    assertParked(taskDir, 'pr-not-open', { prState });
    assert.equal(
      gitCallsBeyondWipHousekeeping(calls).length,
      0,
      'prepareResume must never issue a git command once the PR itself is not open'
    );
    assert.equal(calls[0].command, 'gh');
    assert.equal(calls[0].args[1], 'view');
  });
}

// F6 (fix pass): the PR is OPEN, but built off a different branch entirely -- the resume
// descriptor's `prNumber` is maintainer-supplied and could, by typo or a stale record, name a
// real, open PR that has nothing to do with this task.
test('prepareResume: pr-branch-mismatch -- PR is OPEN but headRefName differs, no git command issued', async () => {
  const { calls, taskDir } = await runResumed('card-pr-branch-mismatch', { prHeadRefName: 'claude-pipe/some-other-card' });

  assertParked(taskDir, 'pr-branch-mismatch', { headRefName: 'claude-pipe/some-other-card' });
  assert.equal(
    gitCallsBeyondWipHousekeeping(calls).length,
    0,
    'prepareResume must never issue a git command once the PR belongs to a different branch'
  );
  assert.equal(calls[0].command, 'gh');
  assert.equal(calls[0].args[1], 'view');
  assert.deepEqual(calls[0].args.slice(-2), ['--json', 'state,headRefName'], 'the PR read must request headRefName too');
});

test('prepareResume: merge-abort-failed -- no symbolic-ref (or anything else) issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-abortfail', { mergeHeadExit: 0, mergeAbortExit: 2 });

  assertParked(taskDir, 'merge-abort-failed', { exit: 2 });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('symbolic-ref')),
    undefined,
    'no symbolic-ref call may run once the abort itself failed'
  );
  assert.equal(findEvent(taskDir, 'resume-merge-aborted'), undefined, 'a failed abort must never journal success');
});

// Checked against `fetch`, not `status`: preserveWorktreeWip's own park-time housekeeping
// (finalizePark, unconditional whenever the worktree exists) issues its own `git status
// --porcelain` regardless of which step parked, so `status` cannot distinguish "prepareResume's
// own dirty-worktree check (step 6) never ran" from "it ran, found a clean tree, and stopped".
// `fetch` (step 7, one step further) is never issued by any of finalizePark's own bookkeeping, so
// its absence is unambiguous proof prepareResume itself stopped at step 5.
test('prepareResume: detached-or-wrong-branch (symbolic-ref itself exits non-zero) -- no fetch issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-detached', { symbolicRefExit: 1 });

  assertParked(taskDir, 'detached-or-wrong-branch', { head: null, exit: 1 });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('fetch')),
    undefined,
    'no fetch may run once the branch check itself failed'
  );
});

test('prepareResume: detached-or-wrong-branch (wrong branch name, exit 0) -- no fetch issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-wrongbranch', { symbolicRefBranch: 'some-other-branch' });

  assertParked(taskDir, 'detached-or-wrong-branch', { head: 'some-other-branch', exit: 0 });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('fetch')),
    undefined,
    'no fetch may run once the branch turned out to be the wrong one'
  );
});

test('prepareResume: status-failed -- no fetch issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-statusfail', { statusExit: 2 });

  assertParked(taskDir, 'status-failed', { exit: 2 });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('fetch')),
    undefined,
    'no fetch may run once `git status` itself failed'
  );
});

test('prepareResume: dirty-worktree -- no fetch issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-dirty', { statusOut: ' M src/some-file.ts\n' });

  assertParked(taskDir, 'dirty-worktree');
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('fetch')),
    undefined,
    'no fetch may run over a dirty worktree'
  );

  // F2 (fix pass): before this fix, finalizePark's OWN park-time preserveWorktreeWip housekeeping
  // ran unconditionally on any dirty, still-existing worktree -- re-detecting the SAME dirty tree
  // prepareResume's own step 6 just found, then detaching HEAD and committing over it. That would
  // strand the maintainer's own edit and leave `claude-pipe/card-dirty` detached, so the NEXT
  // `continue` parks `detached-or-wrong-branch` forever.
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('--detach')),
    undefined,
    'a resume-precondition park must never detach the worktree'
  );
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('commit')),
    undefined,
    'a resume-precondition park must never commit over the worktree'
  );
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('push') && c.args.some((a) => typeof a === 'string' && a.startsWith('HEAD:refs/heads/wip/'))),
    undefined,
    'a resume-precondition park must never push a wip/ ref'
  );
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'), 'expected wip-preserve-skipped to be journalled');
  assert.equal(findEvent(taskDir, 'wip-preserve-skipped').reason, 'resume-precondition');
  assert.equal(findEvent(taskDir, 'wip-preserved'), undefined, 'nothing was preserved -- the worktree was never touched');
});

// F2: a refusal that has NOTHING to do with the worktree being dirty (here, `pr-not-open`) must
// still skip preservation even when the worktree HAPPENS to also be dirty -- proving the guard is
// keyed on "this is a resume-precondition park", not on the specific reason that fired.
test('prepareResume: pr-not-open, worktree also dirty -- still no detach/commit/push (skipWipPreserve is reason-independent)', async () => {
  const { calls, taskDir } = await runResumed('card-pr-not-open-dirty', {
    prState: 'CLOSED',
    statusOut: ' M src/other-file.ts\n',
  });

  assertParked(taskDir, 'pr-not-open', { prState: 'CLOSED' });
  assert.equal(calls.find((c) => c.command === 'git' && c.args.includes('--detach')), undefined);
  assert.equal(calls.find((c) => c.command === 'git' && c.args.includes('commit')), undefined);
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('push')),
    undefined,
    'no push of any kind may run -- prepareResume itself never reaches its own dirty-worktree check either'
  );
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'));
});

test('prepareResume: fetch-failed -- no remote-branch rev-parse issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-fetchfail', { fetchExit: 1 });

  assertParked(taskDir, 'fetch-failed', { exit: 1 });
  assert.equal(
    calls.find(
      (c) => c.command === 'git' && c.args.some((a) => typeof a === 'string' && a.startsWith('refs/remotes/origin/'))
    ),
    undefined,
    'no remote-branch lookup may run once fetch itself failed'
  );
});

test('prepareResume: remote-branch-missing -- no local HEAD rev-parse issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-noremote', { remoteRevExit: 1 });

  assertParked(taskDir, 'remote-branch-missing');
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.length === 3 && c.args[1] === 'rev-parse' && c.args[2] === 'HEAD'),
    undefined,
    'no local HEAD lookup may run once the remote branch itself does not exist'
  );
});

test('prepareResume: rev-parse-failed (local HEAD) -- no merge-base issued afterward', async () => {
  const { calls, taskDir } = await runResumed('card-headfail', { localRevExit: 1 });

  assertParked(taskDir, 'rev-parse-failed', { ref: 'HEAD' });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('merge-base')),
    undefined,
    'no merge-base call may run once local HEAD itself failed to resolve'
  );
});

test('prepareResume: not-fast-forward -- no merge --ff-only issued', async () => {
  const localSha = 'divergedlocal333333333333333333333333333333';
  const remoteSha = 'divergedremote4444444444444444444444444444444';
  const { calls, taskDir } = await runResumed('card-diverged', { localSha, remoteSha, ancestorExit: 1 });

  assertParked(taskDir, 'not-fast-forward', { head: localSha, remote: remoteSha });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('--ff-only')),
    undefined,
    'no fast-forward may be attempted once the tip is confirmed NOT an ancestor'
  );
});

test('prepareResume: merge-base-failed -- no merge --ff-only issued', async () => {
  const { calls, taskDir } = await runResumed('card-mergebasefail', {
    localSha: 'localhead555555555555555555555555555555555',
    remoteSha: 'remotehead666666666666666666666666666666666',
    ancestorExit: 128,
  });

  assertParked(taskDir, 'merge-base-failed', { exit: 128 });
  assert.equal(
    calls.find((c) => c.command === 'git' && c.args.includes('--ff-only')),
    undefined,
    'no fast-forward may be attempted when the ancestry check itself failed to answer'
  );
});

test('prepareResume: fast-forward-failed', async () => {
  const { taskDir } = await runResumed('card-fffail', {
    localSha: 'oldhead777777777777777777777777777777777777',
    remoteSha: 'newhead8888888888888888888888888888888888888',
    ancestorExit: 0,
    ffExit: 1,
  });

  assertParked(taskDir, 'fast-forward-failed', { exit: 1 });
  assert.equal(findEvent(taskDir, 'resume-prepared'), undefined, 'a failed fast-forward must never journal success');
});

// ================================================================================================
// ---- shadow mode: prepareResume never runs -------------------------------------------------
// ================================================================================================

test('runTask (shadow mode): a resumed task issues no prepareResume and no resume-prepared event', async () => {
  const worktreePath = '/tmp/spo-resume-shadow-fixture-worktree';
  const taskDir = mkTmp('spo-pr-shadow-taskdir-');
  const task = {
    id: 'card-shadow-resume',
    kind: 'card',
    issue: 901,
    title: 'Resumed card',
    resume: { startState: 'CHECK', prNumber: PR_NUMBER, worktreePath, commentId: 1, fromReason: 'merge-conflict' },
  };
  const calls = [];
  const config = { shadowMode: true, dryRun: false, deps: { spawnSync: (command, args) => (calls.push({ command, args: [...args] }), ok('')) } };

  await runTask(task.id, task, taskDir, config);

  assert.equal(findEvent(taskDir, 'resume-prepared'), undefined, 'shadow mode must never journal resume-prepared');
  assert.equal(findEvent(taskDir, 'resume-merge-aborted'), undefined);
  assert.equal(calls.length, 0, 'shadow mode never spawns anything -- prepareResume must not have run');
});

// ================================================================================================
// ---- a park from prepareResume keeps the resume's prNumber/worktreePath, never null --------
// ================================================================================================

// A refusal AFTER the PR was verified open on this branch (dirty-worktree). A refusal before that
// point keeps the previous park's PR instead -- see the "re-verification fixes" tests below.
test("prepareResume: a ParkSignal leaves state.json PARKED with the resume's prNumber/worktreePath, not null", async () => {
  const { taskDir, worktreePath } = await runResumed('card-missing-state', { statusOut: ' M x.ts\n' });

  const state = readState(taskDir);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.prNumber, PR_NUMBER);
  assert.equal(state.worktreePath, worktreePath);
});

// ================================================================================================
// ---- F4 (fix pass): end-to-end proof that runTask's resume path sets ctx.resumePushPending -----
// ================================================================================================
//
// Every existing PUSH_PR-one-shot test (test/push-pr-nothing-staged.test.js) calls `realPushPr`
// directly and sets `ctx.resumePushPending = true` BY HAND -- none of them go through `runTask`,
// so none of them can catch a regression in the one line that actually ARMS the flag on a real
// resume (`state-machine.js`'s `runTask`, in the `task.resume` branch). Deleting that line leaves
// the whole suite green and every resumed card would park `nothing-new-to-push` on its very first
// PUSH_PR pass. This test goes through `runTask` end to end: prepareResume succeeds (HEAD already
// equals the remote tip), CHECK's own npm aliases pass, and PUSH_PR's `commit` exits 1 on a clean
// tree with HEAD === `refs/remotes/origin/claude-pipe/<id>` and `origin/main` genuinely different.
test('runTask, resume end-to-end (F4): prepareResume succeeds, CHECK passes, PUSH_PR commit exit 1 -- commit-skipped-resume journalled, a push issued, no nothing-new-to-push park', async () => {
  const sharedSha = 'sharedtip9999999999999999999999999999999999';
  const { calls, taskDir } = await runResumed('card-f4-e2e', {
    localSha: sharedSha,
    remoteSha: sharedSha, // prepareResume: HEAD already equals the remote tip -- no fast-forward
    commitExit: 1, // PUSH_PR: "nothing to commit"
    statusOut: '', // clean tree -- resolves to the resume/#213 diagnostic, not `dirty: true`
    mainSha: 'differentmain8888888888888888888888888888888', // origin/main genuinely differs
  });

  assert.ok(findEvent(taskDir, 'resume-prepared'), 'prepareResume must have succeeded');

  const skippedResume = findEvent(taskDir, 'commit-skipped-resume');
  assert.ok(skippedResume, 'expected commit-skipped-resume to be journalled -- proves the resume exemption fired');
  assert.equal(skippedResume.head, sharedSha);
  assert.equal(skippedResume.remoteBranchSha, sharedSha);

  const push = calls.find((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('-u'));
  assert.ok(push, 'expected the ordinary push -u origin <branch> to be issued');

  const parked = findEvent(taskDir, 'parked');
  assert.ok(
    !parked || parked.reason !== 'push-pr-failed' || parked.detail.reason !== 'nothing-new-to-push',
    'must never park nothing-new-to-push on a resumed task\'s first PUSH_PR pass'
  );
  assert.equal(findEvent(taskDir, 'commit-skipped-nothing-staged'), undefined, 'the resume-specific event must fire instead of the generic one');
});

// ================================================================================================
// ---- F5 (fix pass): prepareResume's own step ORDER, pinned exactly -----------------------------
// ================================================================================================
//
// `deepStrictEqual` on the full ordered argv list, not a set of `.find()` existence checks --
// existence survives a reordering, order does not. Two swaps are known to survive existence-only
// assertions: symbolic-ref <-> status (steps 5/6) and the remote <-> local rev-parse (inside step
// 9's own resolution). Both are pinned below and proven to die under the swap by hand (see this
// action's own report).

test('prepareResume step order (F5), happy path 1: HEAD already equals the remote tip', async () => {
  const sameSha = 'samesha0000000000000000000000000000000000';
  const { calls, taskDir, worktreePath, branch } = await runResumed('card-order-happy1', {
    remoteSha: sameSha,
    localSha: sameSha,
  });

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'resume-prepared');
  assert.deepStrictEqual(prefix, [
    { command: 'gh', args: ['pr', 'view', String(PR_NUMBER), '--repo', 'Crazz-Org/SPO-WebClient', '--json', 'state,headRefName'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'status', '--porcelain'] },
    { command: 'git', args: ['-C', worktreePath, 'fetch', 'origin'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', 'HEAD'] },
  ]);
});

test('prepareResume step order (F5), happy path 2: remote ahead, HEAD is an ancestor -- fast-forwards', async () => {
  const oldHead = 'oldhead11111111111111111111111111111111111';
  const newRemote = 'newremote2222222222222222222222222222222222';
  const { calls, taskDir, worktreePath, branch } = await runResumed('card-order-happy2', {
    localSha: oldHead,
    remoteSha: newRemote,
    ancestorExit: 0,
    ffExit: 0,
  });

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'resume-prepared');
  assert.deepStrictEqual(prefix, [
    { command: 'gh', args: ['pr', 'view', String(PR_NUMBER), '--repo', 'Crazz-Org/SPO-WebClient', '--json', 'state,headRefName'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'status', '--porcelain'] },
    { command: 'git', args: ['-C', worktreePath, 'fetch', 'origin'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', 'HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${branch}`] },
    { command: 'git', args: ['-C', worktreePath, 'merge', '--ff-only', `refs/remotes/origin/${branch}`] },
  ]);
});

test('prepareResume step order (F5), refusal: pr-not-open -- only the PR view runs', async () => {
  const { calls, taskDir } = await runResumed('card-order-pr-not-open', { prState: 'CLOSED' });

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'parked');
  assert.deepStrictEqual(prefix, [
    { command: 'gh', args: ['pr', 'view', String(PR_NUMBER), '--repo', 'Crazz-Org/SPO-WebClient', '--json', 'state,headRefName'] },
  ]);
});

test('prepareResume step order (F5), refusal: detached-or-wrong-branch -- PR view, MERGE_HEAD, symbolic-ref, then parks', async () => {
  const { calls, taskDir, worktreePath } = await runResumed('card-order-detached', { symbolicRefExit: 1 });

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'parked');
  assert.deepStrictEqual(prefix, [
    { command: 'gh', args: ['pr', 'view', String(PR_NUMBER), '--repo', 'Crazz-Org/SPO-WebClient', '--json', 'state,headRefName'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'] },
  ]);
});

test('prepareResume step order (F5), refusal: dirty-worktree -- PR view, MERGE_HEAD, symbolic-ref, status, then parks', async () => {
  const { calls, taskDir, worktreePath } = await runResumed('card-order-dirty', { statusOut: ' M x\n' });

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'parked');
  assert.deepStrictEqual(prefix, [
    { command: 'gh', args: ['pr', 'view', String(PR_NUMBER), '--repo', 'Crazz-Org/SPO-WebClient', '--json', 'state,headRefName'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'status', '--porcelain'] },
  ]);
});

test('prepareResume step order (F5), refusal: not-fast-forward -- the full sequence through both rev-parses and the ancestor check', async () => {
  const localSha = 'divergedlocal333333333333333333333333333333';
  const remoteSha = 'divergedremote4444444444444444444444444444444';
  const { calls, taskDir, worktreePath, branch } = await runResumed('card-order-diverged', {
    localSha,
    remoteSha,
    ancestorExit: 1,
  });

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'parked');
  assert.deepStrictEqual(prefix, [
    { command: 'gh', args: ['pr', 'view', String(PR_NUMBER), '--repo', 'Crazz-Org/SPO-WebClient', '--json', 'state,headRefName'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'status', '--porcelain'] },
    { command: 'git', args: ['-C', worktreePath, 'fetch', 'origin'] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`] },
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', 'HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${branch}`] },
  ]);
});

// ================================================================================================
// ---- re-verification fixes: the park never records an unverified PR number or a foreign path --
// ================================================================================================

async function runResumedOverPriorPark(id, prior, spawnOpts, setupOpts) {
  const { pipelineWorktreesDir, worktreePath, branch, taskDir, task } = setupTask(id, setupOpts);
  const priorState = typeof prior === 'function' ? prior({ pipelineWorktreesDir, worktreePath }) : prior;
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify({ id, state: 'PARKED', reason: 'merge-conflict', ...priorState }));
  const calls = [];
  const config = testConfig(pipelineWorktreesDir, { deps: { spawnSync: resumeSpawnSync(calls, branch, spawnOpts) } });
  await runTask(task.id, task, taskDir, config);
  return { calls, taskDir, worktreePath, pipelineWorktreesDir };
}

test('resume park: pr-branch-mismatch keeps the PREVIOUS park\'s prNumber, never the unverified descriptor\'s (a later abandon closes state.prNumber)', async () => {
  const { taskDir } = await runResumedOverPriorPark('card-prnum-mismatch', { prNumber: 555 }, { prHeadRefName: 'claude-pipe/another-card' });
  assertParked(taskDir, 'pr-branch-mismatch', { headRefName: 'claude-pipe/another-card' });
  assert.equal(readState(taskDir).prNumber, 555);
});

for (const [label, spawnOpts, setupOpts, step] of [
  ['pr-not-open', { prState: 'CLOSED' }, undefined, 'pr-not-open'],
  ['pr-read-failed', { prViewExit: 1 }, undefined, 'pr-read-failed'],
  ['worktree-missing', {}, { createWorktree: false }, 'worktree-missing'],
]) {
  test(`resume park: ${label} keeps the previous park's prNumber`, async () => {
    const { taskDir } = await runResumedOverPriorPark(`card-prnum-${label}`, { prNumber: 555 }, spawnOpts, setupOpts);
    assert.equal(findEvent(taskDir, 'parked').detail.step, step);
    assert.equal(readState(taskDir).prNumber, 555);
  });
}

test('resume park: a refusal AFTER the PR was verified (dirty-worktree) records the verified descriptor prNumber', async () => {
  const { taskDir } = await runResumedOverPriorPark('card-prnum-dirty', { prNumber: 555 }, { statusOut: ' M x.ts\n' });
  assertParked(taskDir, 'dirty-worktree');
  assert.equal(readState(taskDir).prNumber, PR_NUMBER);
});

test('resume park: a PR that is CLOSED and on another branch parks pr-not-open (state is checked before the branch)', async () => {
  const { taskDir } = await runResumedOverPriorPark('card-closed-wrong-branch', {}, { prState: 'CLOSED', prHeadRefName: 'claude-pipe/x' });
  assert.equal(findEvent(taskDir, 'parked').detail.step, 'pr-not-open');
});

test('resume park: worktree-path-mismatch over a prior park with the TRUSTED path keeps that path and its PR, and never journals resumed-at-check or writes the foreign path', async () => {
  const foreign = path.join(mkTmp('spo-pr-foreign-'), 'wt');
  fs.mkdirSync(foreign, { recursive: true });
  const id = 'card-mismatch-trusted-prior';
  const writes = [];
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, ...rest) {
    if (typeof file === 'string' && typeof data === 'string' && data.includes(foreign)) writes.push(file);
    return origWrite.call(fs, file, data, ...rest);
  };
  let result;
  try {
    result = await runResumedOverPriorPark(
      id,
      ({ pipelineWorktreesDir }) => ({ prNumber: 555, worktreePath: path.join(pipelineWorktreesDir, id) }),
      { statusOut: ' M x.ts\n' },
      { createWorktree: false, worktreePathOverride: foreign }
    );
  } finally {
    fs.writeFileSync = origWrite;
  }
  const { taskDir, pipelineWorktreesDir, calls } = result;
  assert.equal(findEvent(taskDir, 'parked').detail.step, 'worktree-path-mismatch');
  const state = readState(taskDir);
  assert.equal(state.worktreePath, path.join(pipelineWorktreesDir, id));
  assert.equal(state.prNumber, 555);
  assert.equal(findEvent(taskDir, 'resumed-at-check'), undefined);
  assert.equal(gitCalls(calls).length, 0);
  assert.deepEqual(
    writes.filter((f) => path.basename(f).startsWith('.state.json')),
    [],
    'no state.json write may ever carry the foreign path'
  );
});

test('resume park: worktree-path-mismatch over a prior park that itself recorded a foreign path records null', async () => {
  const foreign = path.join(mkTmp('spo-pr-foreign2-'), 'wt');
  const { taskDir } = await runResumedOverPriorPark(
    'card-mismatch-foreign-prior',
    { prNumber: 555, worktreePath: foreign },
    {},
    { createWorktree: false, worktreePathOverride: foreign }
  );
  assert.equal(findEvent(taskDir, 'parked').detail.step, 'worktree-path-mismatch');
  assert.equal(readState(taskDir).worktreePath, null);
});

// ================================================================================================
// ---- card #279: a resume at IMPLEMENT keeps the run's own in-flight work ------------------------
// ================================================================================================
//
// A `continue` lineage re-enqueued out of IMPLEMENT (state-machine.js's carriedResume) resumes AT
// IMPLEMENT. prepareResume runs the same checks under IMPLEMENT, except that the run's own
// in-flight work -- a dirty tree (step 6), or commits on top of origin's tip (step 9) -- is kept
// for IMPLEMENT to finish instead of refused. Each run below reaches IMPLEMENT itself, which parks
// on the empty account pool: that park is the proof the resume got past prepareResume.

// A carriedResume copy, which is the only writer of `startState: 'IMPLEMENT'` and always adds the
// run's counters (card #281 keys the keep-the-tree rule on them).
const CARRIED_COUNTERS = { diagnoseAttempts: 1, validateRejects: 0, ciImplementRetries: 0, seenRootCauses: ['x'] };

function implementResume(id, spawnOpts) {
  return runResumed(id, spawnOpts, { startState: 'IMPLEMENT', counters: CARRIED_COUNTERS, configOverrides: { claudeAccountsDir: mkTmp('spo-pr-accts-') } });
}

// Journal index of the first event named `event`, asserted present.
function eventIndex(taskDir, event) {
  const i = readJournal(taskDir).findIndex((e) => e.event === event);
  assert.ok(i >= 0, `expected a '${event}' event`);
  return i;
}

const treeTouchingGit = (c) =>
  c.command === 'git' && ['checkout', 'reset', 'clean', 'stash', 'restore'].some((verb) => c.args.includes(verb));

test('prepareResume at IMPLEMENT (#279): a dirty tree is KEPT -- resume-dirty-tree-kept, resume-prepared, then IMPLEMENT runs; nothing detaches, commits, resets or pushes it', async () => {
  const { calls, taskDir } = await implementResume('card-impl-dirty', { statusOut: ' M src/a.ts\n?? src/b.ts\n' });

  const kept = findEvent(taskDir, 'resume-dirty-tree-kept');
  assert.ok(kept, 'the dirty tree is journalled as kept');
  assert.equal(kept.state, 'IMPLEMENT');
  assert.equal(kept.entries, 2);
  const iKept = eventIndex(taskDir, 'resume-dirty-tree-kept');
  const iPrepared = eventIndex(taskDir, 'resume-prepared');
  assert.ok(iKept < iPrepared, 'kept, then the rest of the safety net ran');
  assert.equal(readJournal(taskDir)[iPrepared].state, 'IMPLEMENT');
  assert.ok(calls.some((c) => c.command === 'git' && c.args.includes('fetch')), 'the checks after step 6 still run');

  const parked = findEvent(taskDir, 'parked');
  assert.ok(parked, 'IMPLEMENT itself parks on the empty pool');
  assert.equal(parked.reason, 'no-accounts-registered', "no dirty-worktree refusal: IMPLEMENT's own lease is what parked");
  assert.equal(parked.state, 'IMPLEMENT');
  assert.ok(iPrepared < eventIndex(taskDir, 'parked'), "the park is IMPLEMENT's own, after the resume was prepared");

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'resume-prepared');
  assert.equal(prefix.filter(treeTouchingGit).length, 0, 'the resume issued no checkout/reset/clean/stash/restore');
  assert.equal(prefix.filter((c) => c.command === 'git' && (c.args.includes('commit') || c.args.includes('--detach') || c.args.includes('push'))).length, 0, 'the resume detached, committed and pushed nothing');
});

test('prepareResume at CHECK (#279 contrast): the same dirty tree still parks dirty-worktree', async () => {
  const { taskDir } = await runResumed('card-check-dirty-contrast', { statusOut: ' M src/a.ts\n?? src/b.ts\n' });
  assertParked(taskDir, 'dirty-worktree');
  assert.equal(findEvent(taskDir, 'resume-dirty-tree-kept'), undefined);
});

test('prepareResume at IMPLEMENT (#279): local commits ON TOP of the remote tip are kept -- resume-unpushed-commits-kept, no fast-forward, IMPLEMENT runs', async () => {
  const localSha = 'aheadlocal77777777777777777777777777777777';
  const remoteSha = 'behindremote888888888888888888888888888888';
  const { calls, taskDir, worktreePath, branch } = await implementResume('card-impl-ahead', {
    localSha,
    remoteSha,
    ancestorExit: 1, // HEAD is not an ancestor of the remote ...
    aheadExit: 0, // ... the remote is an ancestor of HEAD
  });

  const kept = findEvent(taskDir, 'resume-unpushed-commits-kept');
  assert.ok(kept);
  assert.equal(kept.state, 'IMPLEMENT');
  assert.equal(kept.head, localSha);
  assert.equal(kept.remote, remoteSha);
  const prepared = findEvent(taskDir, 'resume-prepared');
  assert.ok(prepared);
  assert.equal(prepared.head, localSha, 'HEAD stays where the run left it');
  assert.equal(prepared.fastForwardedFrom, null);
  assert.ok(eventIndex(taskDir, 'resume-unpushed-commits-kept') < eventIndex(taskDir, 'resume-prepared'));
  assert.equal(calls.find((c) => c.command === 'git' && c.args.includes('--ff-only')), undefined);
  assert.equal(findEvent(taskDir, 'parked').state, 'IMPLEMENT', "the only park is IMPLEMENT's own");
  assert.equal(findEvent(taskDir, 'parked').reason, 'no-accounts-registered', "IMPLEMENT's own lease is what parked");

  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'resume-prepared');
  assert.deepStrictEqual(prefix.slice(-2), [
    { command: 'git', args: ['-C', worktreePath, 'merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${branch}`] },
    { command: 'git', args: ['-C', worktreePath, 'merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, 'HEAD'] },
  ]);
});

test('prepareResume at IMPLEMENT (#279): a DIVERGED branch still parks not-fast-forward, at IMPLEMENT, the tree untouched', async () => {
  const localSha = 'divergedlocal333333333333333333333333333333';
  const remoteSha = 'divergedremote4444444444444444444444444444444';
  const { calls, taskDir } = await implementResume('card-impl-diverged', { localSha, remoteSha, ancestorExit: 1, aheadExit: 1 });

  const parked = assertParked(taskDir, 'not-fast-forward', { head: localSha, remote: remoteSha });
  assert.equal(parked.state, 'IMPLEMENT', 'the park names the state the resume would have started in');
  assert.equal(readState(taskDir).lastState, 'IMPLEMENT');
  assert.equal(findEvent(taskDir, 'resume-unpushed-commits-kept'), undefined);
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'), 'a resume refusal never runs the park-time wip housekeeping');
  assert.equal(calls.filter(treeTouchingGit).length, 0);
});

test('prepareResume at IMPLEMENT (#279): the ahead check itself failing parks merge-base-failed', async () => {
  const { taskDir } = await implementResume('card-impl-aheadfail', {
    localSha: 'localhead555555555555555555555555555555555',
    remoteSha: 'remotehead666666666666666666666666666666666',
    ancestorExit: 1,
    aheadExit: 128,
  });
  assertParked(taskDir, 'merge-base-failed', { exit: 128 });
});

// PUSH_PR's one-shot resume exemption (card #212 F4, realPushPr's `resumePass`) exists because a
// resume at CHECK reaches PUSH_PR with nothing new to commit. A resume at IMPLEMENT reaches it with
// IMPLEMENT's work, so the exemption is not armed: the SAME shape as F4's test above (clean tree,
// commit exit 1, HEAD == origin/<branch>) parks nothing-new-to-push, as any non-resumed pass does.
// IMPLEMENT runs through the legacy `task.llm.IMPLEMENT` override (test/board-move.test.js's shape),
// whose reply carries no files_changed claim, so nothing between IMPLEMENT and PUSH_PR re-routes it.
test('runTask, resume at IMPLEMENT (#279): PUSH_PR\'s resume exemption is NOT armed -- the F4 shape parks nothing-new-to-push', async () => {
  const sharedSha = 'sharedtip9999999999999999999999999999999999';
  const { pipelineWorktreesDir, branch, taskDir, task } = setupTask('card-impl-f4', { startState: 'IMPLEMENT' });
  task.llm = { IMPLEMENT: { model: 'sonnet', effort: 'low', promptText: 'implement it' } };
  const accountsDir = mkTmp('spo-pr-accts-one-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  const calls = [];
  const spawn = () =>
    fakeSpawnedChild([
      { type: 'system', subtype: 'init', session_id: 'sess-impl-f4', apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'sess-impl-f4', modelUsage: { 'claude-x': { costUSD: 0.001 } }, result: 'ok' },
    ]);
  const config = testConfig(pipelineWorktreesDir, {
    claudeAccountsDir: accountsDir,
    deps: {
      spawnSync: resumeSpawnSync(calls, branch, {
        localSha: sharedSha,
        remoteSha: sharedSha,
        commitExit: 1,
        statusOut: '',
        mainSha: 'differentmain8888888888888888888888888888888',
      }),
      ...fakeExecDeps({ spawn }),
    },
  });
  await runTask(task.id, task, taskDir, config);

  const journal = readJournal(taskDir);
  const iImplementResult = journal.findIndex((e) => e.state === 'IMPLEMENT' && e.event === 'result');
  const iPushSpawn = journal.findIndex((e) => e.state === 'PUSH_PR' && e.event === 'spawn');
  assert.ok(iImplementResult >= 0 && iPushSpawn > iImplementResult, 'IMPLEMENT ran, then PUSH_PR');
  assert.equal(findEvent(taskDir, 'commit-skipped-resume'), undefined, 'the resume exemption must not fire after a resumed IMPLEMENT');
  const parked = findEvent(taskDir, 'parked');
  assert.ok(parked);
  assert.equal(parked.reason, 'push-pr-failed');
  assert.equal(parked.detail.reason, 'nothing-new-to-push');
});

test('prepareResume at IMPLEMENT (#279): every refusal before step 6 is unchanged -- pr-not-open still parks, at IMPLEMENT', async () => {
  const { taskDir } = await implementResume('card-impl-prclosed', { prState: 'CLOSED', statusOut: ' M src/a.ts\n' });
  const parked = assertParked(taskDir, 'pr-not-open');
  assert.equal(parked.state, 'IMPLEMENT');
  assert.equal(findEvent(taskDir, 'resume-dirty-tree-kept'), undefined, 'refused before the tree is even looked at');
  assert.equal(findEvent(taskDir, 'resumed-at-implement').state, 'IMPLEMENT');
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'), 'nothing was kept, so the park leaves the tree untouched (#281)');
});

// ================================================================================================
// ---- card #281: the rule is keyed on who wrote the descriptor, not on the start state -----------
// ================================================================================================
//
// A descriptor a MACHINE re-enqueue wrote (it carries `counters`: a carriedResume copy, or a fresh
// #251 poolWaitResume one) keeps the run's own in-flight work at CHECK too; a maintainer's
// `continue` (no `counters`) refuses it, at CHECK and -- were one ever written -- at IMPLEMENT. A
// refusal that parks after a dirty tree was KEPT preserves it to `wip/` and re-attaches the branch.

function machineCheckResume(id, spawnOpts, extra = {}) {
  return runResumed(id, spawnOpts, { counters: CARRIED_COUNTERS, ...extra });
}

test('prepareResume at CHECK after a machine re-enqueue (#281): a dirty tree is KEPT -- resume-dirty-tree-kept under CHECK, then CHECK runs on it', async () => {
  const { calls, taskDir } = await machineCheckResume('card-281-check-dirty', { statusOut: ' M src/a.ts\n' });
  const kept = findEvent(taskDir, 'resume-dirty-tree-kept');
  assert.ok(kept);
  assert.equal(kept.state, 'CHECK');
  assert.equal(kept.entries, 1);
  const iPrepared = eventIndex(taskDir, 'resume-prepared');
  assert.ok(eventIndex(taskDir, 'resume-dirty-tree-kept') < iPrepared);
  const prefix = spawnCallsBeforeEvent(taskDir, calls, 'resume-prepared');
  assert.equal(prefix.filter(treeTouchingGit).length, 0, 'the resume issued no checkout/reset/clean/stash/restore');
  assert.ok(calls.some((c) => c.command === 'npm' && c.args.includes('typecheck')), "CHECK's own spawns ran on the kept tree");
  assert.notEqual(findEvent(taskDir, 'parked').reason, 'resume-precondition-failed');
});

test('prepareResume at CHECK after a machine re-enqueue (#281): commits ON TOP of the remote tip are kept -- resume-unpushed-commits-kept, no fast-forward', async () => {
  const localSha = 'aheadlocal77777777777777777777777777777777';
  const remoteSha = 'behindremote888888888888888888888888888888';
  const { calls, taskDir } = await machineCheckResume('card-281-check-ahead', { localSha, remoteSha, ancestorExit: 1, aheadExit: 0 });
  const kept = findEvent(taskDir, 'resume-unpushed-commits-kept');
  assert.ok(kept);
  assert.equal(kept.state, 'CHECK');
  assert.equal(kept.head, localSha);
  assert.equal(kept.remote, remoteSha);
  assert.equal(findEvent(taskDir, 'resume-prepared').head, localSha);
  assert.equal(calls.find((c) => c.command === 'git' && c.args.includes('--ff-only')), undefined);
});

test('prepareResume at CHECK after a machine re-enqueue (#281): a DIVERGED branch still parks not-fast-forward, and a failing ahead check merge-base-failed', async () => {
  const diverged = await machineCheckResume('card-281-check-diverged', {
    localSha: 'divergedlocal333333333333333333333333333333',
    remoteSha: 'divergedremote4444444444444444444444444444444',
    ancestorExit: 1,
    aheadExit: 1,
  });
  assertParked(diverged.taskDir, 'not-fast-forward');
  assert.equal(findEvent(diverged.taskDir, 'resume-unpushed-commits-kept'), undefined);
  assert.ok(findEvent(diverged.taskDir, 'wip-preserve-skipped'), 'nothing kept: the tree is left for a human');

  const failing = await machineCheckResume('card-281-check-aheadfail', {
    localSha: 'localhead555555555555555555555555555555555',
    remoteSha: 'remotehead666666666666666666666666666666666',
    ancestorExit: 1,
    aheadExit: 128,
  });
  assertParked(failing.taskDir, 'merge-base-failed', { exit: 128 });
});

test("prepareResume after a maintainer's `continue` (#281, unchanged): no counters, so a dirty tree and commits ahead are both refused at CHECK", async () => {
  const dirty = await runResumed('card-281-continue-dirty', { statusOut: ' M src/a.ts\n' });
  assertParked(dirty.taskDir, 'dirty-worktree');
  assert.ok(findEvent(dirty.taskDir, 'wip-preserve-skipped'));
  const ahead = await runResumed('card-281-continue-ahead', {
    localSha: 'aheadlocal77777777777777777777777777777777',
    remoteSha: 'behindremote888888888888888888888888888888',
    ancestorExit: 1,
    aheadExit: 0,
  });
  assertParked(ahead.taskDir, 'not-fast-forward');
  assert.equal(ahead.calls.filter((c) => c.command === 'git' && c.args.includes('merge-base')).length, 1, 'the ahead direction is never even asked');
});

test('prepareResume at IMPLEMENT on a descriptor WITHOUT counters (#281): the key is the writer, not the start state -- the dirty tree is refused', async () => {
  const { taskDir } = await runResumed('card-281-impl-nocounters', { statusOut: ' M src/a.ts\n' }, { startState: 'IMPLEMENT', configOverrides: { claudeAccountsDir: mkTmp('spo-pr-accts-') } });
  const parked = assertParked(taskDir, 'dirty-worktree');
  assert.equal(parked.state, 'IMPLEMENT');
  assert.equal(findEvent(taskDir, 'resume-dirty-tree-kept'), undefined);
});

// #251 decision: a fresh machine pool-wait descriptor (`source: 'pool-wait'`, counters) keeps the
// tree too -- the same safety argument, and its alternative was the INTAKE fallback that closes the
// PR. A refusal after the keep still falls back to INTAKE, never a park, never a re-attach.
test('prepareResume on a #251 machine pool-wait descriptor (#281): a dirty tree is kept at CHECK; a later refusal still falls back to INTAKE, not a park', async () => {
  const kept = await runResumed('card-281-pw-dirty', { statusOut: ' M src/a.ts\n' }, { counters: CARRIED_COUNTERS, source: 'pool-wait' });
  assert.equal(findEvent(kept.taskDir, 'resume-dirty-tree-kept').state, 'CHECK');
  assert.equal(findEvent(kept.taskDir, 'machine-resume-refused'), undefined);

  const refused = await runResumed('card-281-pw-fetchfail', { statusOut: ' M src/a.ts\n', fetchExit: 128 }, { counters: CARRIED_COUNTERS, source: 'pool-wait' });
  const journal = readJournal(refused.taskDir);
  const iKept = journal.findIndex((e) => e.event === 'resume-dirty-tree-kept');
  const iRefused = journal.findIndex((e) => e.event === 'machine-resume-refused');
  assert.ok(iKept >= 0 && iRefused > iKept, 'kept, then refused');
  assert.equal(journal[iRefused].step, 'fetch-failed');
  assert.equal(journal[iRefused].fallback, 'INTAKE');
  assert.ok(!journal.slice(0, iRefused).some((e) => e.event === 'parked'), 'no park before the fallback');
  assert.equal(findEvent(refused.taskDir, 'wip-reattached'), undefined, "the fallback's WORKTREE sweep owns the tree, not the refusal");
});

// Shape 3: prepareResume KEPT the dirty tree, then refused for an unrelated reason.
for (const [label, spawnOpts, step] of [
  ['fetch-failed', { fetchExit: 128 }, 'fetch-failed'],
  ['remote-branch-missing', { remoteRevExit: 1 }, 'remote-branch-missing'],
  ['a real divergence', { localSha: 'l'.repeat(40), remoteSha: 'r'.repeat(40), ancestorExit: 1, aheadExit: 1 }, 'not-fast-forward'],
]) {
  test(`shape 3 (#281): a refusal (${label}) after a dirty tree was KEPT preserves it to wip/, then re-attaches the branch -- in that order`, async () => {
    const { calls, taskDir, worktreePath, branch } = await implementResume(`card-281-shape3-${step}`, { statusOut: ' M src/a.ts\n', ...spawnOpts });
    const parked = assertParked(taskDir, step);
    assert.equal(parked.state, 'IMPLEMENT');
    assert.equal(findEvent(taskDir, 'wip-preserve-skipped'), undefined);
    const iKept = eventIndex(taskDir, 'resume-dirty-tree-kept');
    const iParked = eventIndex(taskDir, 'parked');
    const iPreserved = eventIndex(taskDir, 'wip-preserved');
    const iReattached = eventIndex(taskDir, 'wip-reattached');
    assert.ok(iKept < iParked && iParked < iPreserved && iPreserved < iReattached);
    assert.equal(readJournal(taskDir)[iReattached].branch, branch);
    const git = calls.filter((c) => c.command === 'git').map((c) => c.args);
    const iDetach = git.findIndex((a) => a.includes('checkout') && a.includes('--detach'));
    const iWip = git.findIndex((a) => a.includes('push') && a.some((x) => String(x).includes(':refs/heads/wip/')));
    const iBack = git.findIndex((a) => a.includes('checkout') && a.includes(branch));
    assert.ok(iDetach >= 0 && iDetach < iWip && iWip < iBack, 'detach, commit, push to wip/, THEN check the branch back out');
    assert.deepEqual(git[iBack], ['-C', worktreePath, 'checkout', branch, '--']);
    assert.ok(readState(taskDir).state === 'PARKED');
    assert.match(fs.readFileSync(path.join(taskDir, 'report.md'), 'utf8'), /wip\//);
  });
}

test('shape 3 (#281): a failed push to wip/ leaves HEAD detached on the local wip commit -- never re-attached, since that commit is the only copy', async () => {
  const { calls, taskDir, branch } = await implementResume('card-281-shape3-pushfail', { statusOut: ' M src/a.ts\n', fetchExit: 128, wipPushExit: 1 });
  assertParked(taskDir, 'fetch-failed');
  const failed = findEvent(taskDir, 'wip-preserve-failed');
  assert.ok(failed);
  assert.equal(failed.step, 'push');
  assert.equal(findEvent(taskDir, 'wip-reattached'), undefined);
  assert.equal(calls.filter((c) => c.command === 'git' && c.args.includes('checkout') && c.args.includes(branch)).length, 0);
});

test('shape 3 (#281): a failed re-attach is journalled, and the work is still on wip/', async () => {
  const { taskDir, branch } = await implementResume('card-281-shape3-reattachfail', { statusOut: ' M src/a.ts\n', fetchExit: 128, reattachExit: 1 });
  assertParked(taskDir, 'fetch-failed');
  assert.ok(findEvent(taskDir, 'wip-preserved'));
  const failed = findEvent(taskDir, 'wip-reattach-failed');
  assert.deepEqual({ branch: failed.branch, exit: failed.exit }, { branch, exit: 1 });
});

// F2 (verifier fix pass): the same loop on a machine resume at CHECK -- a `continue` lineage
// re-enqueued inside DIAGNOSE -- so the keep flag is shown to be set whatever the start state.
test('shape 3 (#281) at CHECK: a machine CHECK resume that KEPT a dirty tree and is refused (fetch-failed) preserves it to wip/, then re-attaches', async () => {
  const { taskDir, calls, branch } = await machineCheckResume('card-281-shape3-check', { statusOut: ' M src/a.ts\n', fetchExit: 128 });
  const parked = assertParked(taskDir, 'fetch-failed');
  assert.equal(parked.state, 'CHECK');
  assert.equal(findEvent(taskDir, 'wip-preserve-skipped'), undefined);
  assert.ok(eventIndex(taskDir, 'resume-dirty-tree-kept') < eventIndex(taskDir, 'parked'));
  assert.ok(eventIndex(taskDir, 'wip-preserved') < eventIndex(taskDir, 'wip-reattached'));
  assert.equal(calls.filter((c) => c.command === 'git' && c.args.includes('checkout') && c.args.includes(branch)).length, 1);
});

// F3 (verifier fix pass): reattachWorktreeBranch runs inside finalizePark, itself inside runTask's
// ParkSignal catch. A `git checkout` timing out twice makes spawnStep throw `git-timed-out`; that
// must be journalled, never rethrown, or the park never completes and orphan-scan re-parks it
// through the same throw.
test('shape 3 (#281): a re-attach whose `git checkout` times out twice is journalled wip-reattach-failed {step: timed-out} -- the park still completes', async () => {
  // commandTimeoutsMs arms spawnSync's own timeout -- without it no result is ever read as a timeout.
  const { taskDir, branch, finalState } = await runResumed(
    'card-281-shape3-reattach-timeout',
    { statusOut: ' M src/a.ts\n', fetchExit: 128, reattachTimedOut: true },
    { startState: 'IMPLEMENT', counters: CARRIED_COUNTERS, configOverrides: { claudeAccountsDir: mkTmp('spo-pr-accts-'), commandTimeoutsMs: { git: 60000, gh: 120000 } } }
  );
  assert.equal(finalState, 'PARKED');
  assertParked(taskDir, 'fetch-failed');
  assert.ok(findEvent(taskDir, 'wip-preserved'), 'the work is on wip/ before the checkout is tried');
  const failed = findEvent(taskDir, 'wip-reattach-failed');
  assert.ok(failed);
  assert.equal(failed.branch, branch);
  assert.equal(failed.step, 'timed-out');
  assert.equal(failed.reason, 'git-timed-out');
  const checkouts = readJournal(taskDir).filter((e) => e.event === 'spawn' && e.argv.includes('checkout') && e.argv.includes(branch));
  assert.equal(checkouts.length, 2, 'spawnStep retried the timed-out checkout once, then gave up');
  assert.ok(checkouts.every((e) => e.timedOut === true));
  const state = readState(taskDir);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'resume-precondition-failed');
  assert.match(fs.readFileSync(path.join(taskDir, 'report.md'), 'utf8'), /wip\//);
});

// F1 (verifier fix pass): `pr-read-failed` (step 3, a transient `gh pr view` failure) fires before
// step 6 can keep the tree. On a machine descriptor, runTask's catch probes the tree itself.
test('F1 (#281): pr-read-failed on a machine descriptor with a dirty tree ON the branch -- probed, preserved to wip/, re-attached', async () => {
  const { taskDir, calls, branch, worktreePath } = await implementResume('card-281-f1-dirty', { prViewExit: 1, statusOut: ' M src/a.ts\n' });
  const parked = assertParked(taskDir, 'pr-read-failed', { exit: 1 });
  assert.equal(parked.state, 'IMPLEMENT');
  assert.equal(findEvent(taskDir, 'resume-dirty-tree-kept'), undefined, 'step 6 never ran');
  assert.equal(findEvent(taskDir, 'wip-preserve-skipped'), undefined);
  assert.ok(eventIndex(taskDir, 'parked') < eventIndex(taskDir, 'wip-preserved'));
  assert.ok(eventIndex(taskDir, 'wip-preserved') < eventIndex(taskDir, 'wip-reattached'));
  // The probe runs before the park: MERGE_HEAD, then symbolic-ref, then status, all on the trusted path.
  const probe = spawnCallsBeforeEvent(taskDir, calls, 'parked').filter((c) => c.command === 'git');
  assert.deepStrictEqual(probe, [
    { command: 'git', args: ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'] },
    { command: 'git', args: ['-C', worktreePath, 'status', '--porcelain'] },
  ]);
  assert.equal(calls.filter((c) => c.command === 'git' && c.args.includes('checkout') && c.args.includes(branch)).length, 1);
});

test('F1 (#281): pr-read-failed (unparsable) on a machine CHECK descriptor with a dirty tree is preserved too -- same step', async () => {
  const { taskDir } = await machineCheckResume('card-281-f1-unparsable', { prViewUnparsable: true, statusOut: ' M src/a.ts\n' });
  assertParked(taskDir, 'pr-read-failed', { unparsable: true });
  assert.ok(eventIndex(taskDir, 'wip-preserved') < eventIndex(taskDir, 'wip-reattached'));
});

for (const [label, spawnOpts, setup] of [
  ['a CLEAN tree', { prViewExit: 1 }, {}],
  ['a dirty tree on the WRONG branch', { prViewExit: 1, statusOut: ' M src/a.ts\n', symbolicRefBranch: 'main' }, {}],
  ['a dirty tree with a merge in progress', { prViewExit: 1, statusOut: ' M src/a.ts\n', mergeHeadExit: 0 }, {}],
  ['a failing status probe', { prViewExit: 1, statusExit: 128 }, {}],
  ["a maintainer's `continue` (no counters)", { prViewExit: 1, statusOut: ' M src/a.ts\n' }, { plainContinue: true }],
]) {
  test(`F1 (#281): pr-read-failed with ${label} still skips the wip housekeeping`, async () => {
    const id = `card-281-f1-skip-${label.replace(/[^a-z]+/gi, '-')}`;
    const { taskDir, calls } = setup.plainContinue ? await runResumed(id, spawnOpts) : await implementResume(id, spawnOpts);
    assertParked(taskDir, 'pr-read-failed');
    assert.ok(findEvent(taskDir, 'wip-preserve-skipped'));
    assert.equal(findEvent(taskDir, 'wip-preserved'), undefined);
    assert.equal(calls.filter(treeTouchingGit).length, 0);
    if (setup.plainContinue) {
      assert.equal(gitCalls(calls).length, 0, 'no probe at all after a maintainer `continue`');
    }
  });
}

test('F1 (#281): the tree probe timing out twice never throws -- the park completes and skips the housekeeping', async () => {
  const { taskDir, finalState } = await runResumed(
    'card-281-f1-probe-timeout',
    { prViewExit: 1, statusTimedOut: true },
    { startState: 'IMPLEMENT', counters: CARRIED_COUNTERS, configOverrides: { claudeAccountsDir: mkTmp('spo-pr-accts-'), commandTimeoutsMs: { git: 60000, gh: 120000 } } }
  );
  assert.equal(finalState, 'PARKED');
  assertParked(taskDir, 'pr-read-failed');
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'));
  assert.equal(readState(taskDir).state, 'PARKED');
});

test('F1 (#281, unchanged): pr-not-open with a dirty tree on the branch is NOT probed -- no `continue` can resume onto a closed PR', async () => {
  const { taskDir, calls } = await implementResume('card-281-f1-prclosed', { prState: 'CLOSED', statusOut: ' M src/a.ts\n' });
  assertParked(taskDir, 'pr-not-open');
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'));
  assert.equal(gitCalls(calls).length, 0);
});

test('shape 3 (#281, unchanged): a refusal with NOTHING kept -- a clean tree after a machine re-enqueue -- still skips the wip housekeeping', async () => {
  const { taskDir, calls } = await implementResume('card-281-clean-fetchfail', { fetchExit: 128 });
  assertParked(taskDir, 'fetch-failed');
  assert.ok(findEvent(taskDir, 'wip-preserve-skipped'));
  assert.equal(calls.filter(treeTouchingGit).length, 0);
});
