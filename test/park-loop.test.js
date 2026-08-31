'use strict';
// Tests for orchestrator/park-loop.js: the park comment's content and posting (postParkComment,
// exercised end-to-end via state-machine.js's runTask -- the real code path, PARKED -> comment),
// and the unpark scan's retry/abandon decision (unparkScan, called directly the same way
// test/real-steps.test.js calls realX functions directly -- daemon.js's own polling loop has no
// injection point, same convention documented in orchestrator/README.md "Tests"). Every spawn is
// an injected deps.spawnSync; nothing here touches a real git/npm/gh process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runTask, buildCtx, finalizePark } = require('../orchestrator/state-machine');
const { buildParkComment, RETRY_ABANDON_LINE, unparkScan, findParkAnchor, countRepeatedParks, postParkComment } = require('../orchestrator/park-loop');
const { appendEvent, writeState } = require('../orchestrator/journal');
const { timeoutResult } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function testConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-park-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-park-bench-'),
    stepDeadlineMs: 30000,
    claudeAccountsDir: mkTmp('spo-park-accts-'),
    ...overrides,
  };
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---- buildParkComment: the exact text, verbatim -----------------------------------------------

test('buildParkComment: names the reason, explains what the machine expects, and carries the literal retry/abandon line', () => {
  const body = buildParkComment({ reason: 'worktree-npm-ci-failed', detail: { exit: 1 }, lastState: 'WORKTREE' });

  assert.match(body, /\*\*Reason:\*\* `worktree-npm-ci-failed`/);
  assert.match(body, /\*\*Last state:\*\* `WORKTREE`/);
  assert.match(body, /What the machine expects from you/);
  assert.ok(body.includes(RETRY_ABANDON_LINE));
  assert.equal(RETRY_ABANDON_LINE, 'pipeline: reply "retry" (optionally after fixing) to requeue, or "abandon" to close this attempt.');
  assert.match(body, /"exit": 1/); // detail is carried too, not dropped
});

test('buildParkComment: an empty detail carries no <details> block', () => {
  const body = buildParkComment({ reason: 'nightly-main-red', detail: {}, lastState: 'WORKTREE' });
  assert.ok(!body.includes('<details>'));
});

test('buildParkComment: repeat >= 2 adds the loop-warning block, RETRY_ABANDON_LINE still present verbatim', () => {
  const body = buildParkComment({
    reason: 'branch-unmerged-leftover',
    detail: { branch: 'claude-pipe/card-385' },
    lastState: 'WORKTREE',
    repeat: 3,
  });

  assert.match(body, /This park is identical to the last 3/);
  assert.match(body, /`branch-unmerged-leftover`/);
  assert.ok(body.includes(RETRY_ABANDON_LINE));
  assert.equal(RETRY_ABANDON_LINE, 'pipeline: reply "retry" (optionally after fixing) to requeue, or "abandon" to close this attempt.');
});

test('buildParkComment: repeat omitted (or 1) carries no loop-warning block -- unchanged from before card #385\'s fix', () => {
  const body = buildParkComment({ reason: 'nightly-main-red', detail: {}, lastState: 'WORKTREE' });
  assert.ok(!body.includes('Ce park est identique'));
});

// ---- postParkComment via runTask: the real PARKED -> comment path ------------------------------

test('runTask (real mode, card): a pre-worktree park skips the board move but still posts the comment', async () => {
  const taskDir = mkTmp('spo-park-taskdir-');
  const config = testConfig();
  const originMainSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.mkdirSync(path.join(config.spoBenchDir, 'nightly'), { recursive: true });
  fs.writeFileSync(path.join(config.spoBenchDir, 'nightly', 'latest.json'), JSON.stringify({ verdict: 'FAIL', sha: originMainSha }));

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('rev-parse')) return ok(`${originMainSha}\n`);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/950#issuecomment-555\n');
      }
      return ok('');
    },
  };

  const task = { id: 'card-950', kind: 'card', issue: 950, title: 'x' };
  const finalState = await runTask('card-950', task, taskDir, { ...config, deps });

  assert.equal(finalState, 'PARKED');
  assert.ok(!calls.some((c) => c.command === 'npm'), 'no board:move -- the worktree never existed');

  const commentCall = calls.find((c) => c.command === 'gh');
  assert.deepEqual(commentCall.args.slice(0, 4), ['issue', 'comment', '950', '--repo']);
  const bodyFile = commentCall.args[commentCall.args.indexOf('--body-file') + 1];
  const body = fs.readFileSync(bodyFile, 'utf8');
  assert.match(body, /nightly-main-red/);
  assert.ok(body.includes(RETRY_ABANDON_LINE));

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'board-move-skipped' && e.reason === 'no worktree'));
  assert.ok(journal.some((e) => e.event === 'park-comment' && e.commentId === 555));
});

test('runTask (real mode, card): a park AFTER the worktree exists moves the card to "Parked" too', async () => {
  const taskDir = mkTmp('spo-park-taskdir2-');
  // Empty accounts dir -- PLAN's callLlmStep will find nothing registered and park with
  // 'no-accounts-registered', by which point WORKTREE has already succeeded and set
  // ctx.task.worktreePath.
  const config = testConfig({ claudeAccountsDir: mkTmp('spo-park-accts-empty-') });

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('rev-parse')) return ok('freshsha0000000000000000000000000000000\n');
      if (args.includes('board:take')) return ok('claimed\n');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/951#issuecomment-777\n');
      }
      return ok('');
    },
  };

  const task = { id: 'card-951', kind: 'card', issue: 951, title: 'x' };
  const finalState = await runTask('card-951', task, taskDir, { ...config, deps });

  assert.equal(finalState, 'PARKED');

  const moveCalls = calls.filter((c) => c.command === 'npm' && c.args.includes('board:move'));
  // WORKTREE's own move to "Planning", then finalizePark's move to "Parked".
  assert.deepEqual(
    moveCalls.map((c) => c.args[4]),
    ['Planning', 'Parked']
  );

  const journal = readJournal(taskDir);
  const parkedMove = journal.find((e) => e.event === 'board-move' && e.column === 'Parked');
  assert.ok(parkedMove);
  assert.ok(journal.some((e) => e.event === 'park-comment' && e.commentId === 777));
});

test('finalizePark: a dirty worktree still on disk gets its diff pushed to a wip/ ref, named in the park comment (card #385\'s stranded-IMPLEMENT case)', async () => {
  const taskDir = mkTmp('spo-park-wip-taskdir-');
  const config = testConfig();
  const worktreePath = path.join(config.pipelineWorktreesDir, 'card-385');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, 'uncommitted.ts'), 'stranded IMPLEMENT work');

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M uncommitted.ts\n');
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('wipsha385000000000000000000000000000000\n');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/385#issuecomment-900\n');
      }
      return ok('');
    },
  };

  const task = { id: 'card-385', kind: 'card', issue: 385, title: 'x', worktreePath };
  const ctx = buildCtx('card-385', task, taskDir, { ...config, deps });

  finalizePark(ctx, 'DIAGNOSE', 'task-orphaned-daemon-restart', { owner: { pid: 12345 } });

  const pushCall = calls.find((c) => c.args.includes('push') && c.args.some((a) => a.startsWith('HEAD:refs/heads/wip/')));
  assert.ok(pushCall, 'expected the WIP push to run as part of the park');

  const journal = readJournal(taskDir);
  const preserved = journal.find((e) => e.event === 'wip-preserved');
  assert.ok(preserved && preserved.ref && preserved.ref.startsWith('wip/card-385-'));
  assert.equal(preserved.sha, 'wipsha385000000000000000000000000000000');

  const report = fs.readFileSync(path.join(taskDir, 'report.md'), 'utf8');
  assert.match(report, /"ref": "wip\/card-385-/);

  const commentCall = calls.find((c) => c.command === 'gh');
  const bodyFile = commentCall.args[commentCall.args.indexOf('--body-file') + 1];
  const body = fs.readFileSync(bodyFile, 'utf8');
  assert.match(body, /wip\/card-385-/); // the retry-anchoring comment names the ref -- not just local
});

// ---- action 2.1b: park-loop.js's own spawns are now bounded too ------------------------------
//
// postParkComment's `gh issue comment` and unparkScan's `gh api .../comments` / abandon-ack `gh
// issue comment` used to spawn with no timeout at all. Both run with the task ALREADY TERMINAL
// (postParkComment, called after state.json/report.md are already written) or with no task in
// scope at all (unparkScan, a daemon-loop scan) -- so a timeout here must never throw a
// ParkSignal (there is nothing left to park) and is converted into the failure each call site
// already models: park-comment-failed / unpark-scan-failed / abandon-ack-failed, journalled with
// timedOut: true so a hang is not silently indistinguishable from a normal gh failure.

test('postParkComment: action 2.1b -- arms the gh class timeout from ctx.config.commandTimeoutsMs', () => {
  const taskDir = mkTmp('spo-park-timeout-taskdir-');
  const ctx = { task: { issue: 960 }, taskDir, config: { ghRepo: 'x/y', commandTimeoutsMs: { gh: 120000 } } };
  let seenOpts = null;
  const deps = {
    spawnSync: (command, args, opts) => {
      seenOpts = opts;
      return { status: 0, stdout: 'https://github.com/x/y/issues/960#issuecomment-1\n', stderr: '', signal: null };
    },
  };

  postParkComment(ctx, deps, { reason: 'x', detail: {}, lastState: 'WORKTREE' });

  assert.equal(seenOpts.timeout, 120000);
});

test('postParkComment: a timed-out gh issue comment never throws (the task is already terminal) -- journalled as park-comment-failed with timedOut: true', () => {
  const taskDir = mkTmp('spo-park-timeout-taskdir2-');
  const ctx = { task: { issue: 961 }, taskDir, config: { ghRepo: 'x/y', commandTimeoutsMs: { gh: 120000 } } };
  const deps = { spawnSync: () => timeoutResult() };

  assert.doesNotThrow(() => postParkComment(ctx, deps, { reason: 'x', detail: {}, lastState: 'WORKTREE' }));

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'park-comment-failed');
  assert.ok(failed, 'the timeout must still be reported, not silently swallowed');
  assert.equal(failed.timedOut, true);
  assert.notEqual(failed.exit, 1, 'a timeout must never be journalled as a plain exit 1');
});

// ---- unpark scan: retry / abandon / ignored ---------------------------------------------------

function parkedTaskDir(journalRoot, id, { issue, commentId }) {
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue, title: 'x', criterion: 'y', size: 'S' }));
  writeState(taskDir, { id, state: 'PARKED', reason: 'worktree-npm-ci-failed' });
  appendEvent(taskDir, 'WORKTREE', 'parked', { reason: 'worktree-npm-ci-failed' });
  appendEvent(taskDir, 'PARKED', 'park-comment', { commentId, reason: 'worktree-npm-ci-failed' });
  return taskDir;
}

test('unparkScan: a "retry" comment posted AFTER the park comment re-enqueues the task', async () => {
  const queueDir = mkTmp('spo-unpark-queue-');
  const journalRoot = mkTmp('spo-unpark-journal-');
  const taskDir = parkedTaskDir(journalRoot, 'card-800', { issue: 800, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        return ok(
          JSON.stringify([
            { id: 95, created_at: '2026-08-28T00:00:00Z', body: 'retry -- ignored, posted BEFORE the park comment' },
            { id: 105, created_at: '2026-08-29T00:00:00Z', body: 'retry\nplease requeue, I fixed the lockfile' },
          ])
        );
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(queueDir, queued[0]), 'utf8'));
  assert.equal(written.id, 'card-800');
  assert.equal(written.issue, 800);
  assert.ok(!('worktreePath' in written));

  const journal = readJournal(taskDir);
  const unparked = journal.find((e) => e.event === 'unparked-by-maintainer');
  assert.ok(unparked);
  assert.equal(unparked.retryCommentId, 105);
});

test('unparkScan: idempotent -- a second scan (state.json still PARKED) never re-enqueues', async () => {
  const queueDir = mkTmp('spo-unpark-queue2-');
  const journalRoot = mkTmp('spo-unpark-journal2-');
  parkedTaskDir(journalRoot, 'card-801', { issue: 801, commentId: 200 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 210, created_at: '2026-08-29T00:00:00Z', body: 'retry' }]));
      }
      return ok('');
    },
  };

  const config = { ghRepo: 'Crazz-Org/SPO-WebClient' };
  await unparkScan(queueDir, journalRoot, config, deps);
  await unparkScan(queueDir, journalRoot, config, deps); // state.json was never redrained back out of PARKED

  const queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1, 'only the first scan re-enqueues');
});

test('unparkScan: an "abandon" comment marks the task ABANDONED (terminal) and posts a one-line ack, never re-enqueues', async () => {
  const queueDir = mkTmp('spo-unpark-queue3-');
  const journalRoot = mkTmp('spo-unpark-journal3-');
  const taskDir = parkedTaskDir(journalRoot, 'card-802', { issue: 802, commentId: 300 });

  const ackCalls = [];
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 310, created_at: '2026-08-29T00:00:00Z', body: 'abandon, thanks for trying' }]));
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        ackCalls.push(args);
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/802#issuecomment-311\n');
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
  assert.equal(queued.length, 0, 'never re-enqueued');

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'ABANDONED');

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'abandoned-by-maintainer' && e.abandonCommentId === 310));
  assert.equal(ackCalls.length, 1);
  assert.deepEqual(ackCalls[0].slice(0, 3), ['issue', 'comment', '802']);
});

test('unparkScan: a comment matching neither "retry" nor "abandon" is left alone', async () => {
  const queueDir = mkTmp('spo-unpark-queue4-');
  const journalRoot = mkTmp('spo-unpark-journal4-');
  parkedTaskDir(journalRoot, 'card-803', { issue: 803, commentId: 400 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 410, created_at: '2026-08-29T00:00:00Z', body: 'what does worktree-npm-ci-failed mean?' }]));
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
  assert.equal(queued.length, 0);
});

test('unparkScan: a non-card / non-PARKED / issue-less journal directory is skipped, never spawns', async () => {
  const queueDir = mkTmp('spo-unpark-queue5-');
  const journalRoot = mkTmp('spo-unpark-journal5-');

  const doneDir = path.join(journalRoot, 'card-804');
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, 'task.json'), JSON.stringify({ id: 'card-804', kind: 'card', issue: 804 }));
  writeState(doneDir, { id: 'card-804', state: 'DONE' });

  const syntheticDir = path.join(journalRoot, 'synthetic-1');
  fs.mkdirSync(syntheticDir, { recursive: true });
  fs.writeFileSync(path.join(syntheticDir, 'task.json'), JSON.stringify({ id: 'synthetic-1', kind: 'synthetic' }));
  writeState(syntheticDir, { id: 'synthetic-1', state: 'PARKED' });

  let called = false;
  const deps = { spawnSync: () => { called = true; return ok('[]'); } };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);
  assert.equal(called, false);
});

test('unparkScan: action 2.1b -- arms the gh class timeout for the comments fetch', async () => {
  const queueDir = mkTmp('spo-unpark-queue-arm-');
  const journalRoot = mkTmp('spo-unpark-journal-arm-');
  parkedTaskDir(journalRoot, 'card-901', { issue: 901, commentId: 501 });

  let seenOpts = null;
  const deps = {
    spawnSync: (command, args, opts) => {
      seenOpts = opts;
      return ok('[]');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', commandTimeoutsMs: { gh: 120000 } }, deps);

  assert.equal(seenOpts.timeout, 120000);
});

test('unparkScan: a timed-out gh api comments fetch never throws -- journalled as unpark-scan-failed with timedOut: true, never re-enqueues', async () => {
  const queueDir = mkTmp('spo-unpark-queue-timeout-');
  const journalRoot = mkTmp('spo-unpark-journal-timeout-');
  const taskDir = parkedTaskDir(journalRoot, 'card-900', { issue: 900, commentId: 500 });

  const deps = { spawnSync: () => timeoutResult() };

  await assert.doesNotReject(() =>
    unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', commandTimeoutsMs: { gh: 120000 } }, deps)
  );

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'unpark-scan-failed');
  assert.ok(failed, 'the timeout must still be reported, not silently swallowed');
  assert.equal(failed.timedOut, true);
  assert.notEqual(failed.exit, 1, 'a timeout must never be journalled as a plain exit 1');

  const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
  assert.equal(queued.length, 0, 'never re-enqueued on a scan failure');
});

test('unparkScan: a timed-out abandon-ack gh comment never throws -- the task is still marked ABANDONED, journalled as abandon-ack-failed with timedOut: true', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-timeout-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-timeout-');
  const taskDir = parkedTaskDir(journalRoot, 'card-902', { issue: 902, commentId: 600 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 610, created_at: '2026-08-29T00:00:00Z', body: 'abandon, giving up' }]));
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return timeoutResult();
      }
      return ok('');
    },
  };

  await assert.doesNotReject(() =>
    unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', commandTimeoutsMs: { gh: 120000 } }, deps)
  );

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'ABANDONED', 'the terminal transition is not blocked by a failed ack');

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'abandon-ack-failed');
  assert.ok(failed, 'the timeout must still be reported, not silently swallowed');
  assert.equal(failed.timedOut, true);
  assert.notEqual(failed.exit, 1, 'a timeout must never be journalled as a plain exit 1');
});

// ---- findParkAnchor: pure helper --------------------------------------------------------------

// ---- countRepeatedParks: the loop-breaker's own counting rule ---------------------------------

test('countRepeatedParks: counts consecutive identical parks (most recent first), stops at the first that differs', () => {
  const targetDetail = { branch: 'claude-pipe/card-385', localSha: 'sha1' };
  const lines = [
    { event: 'parked', reason: 'worktree-npm-ci-failed', detail: { exit: 1 } }, // oldest -- different reason, breaks any streak reaching this far
    { event: 'transition', to: 'WORKTREE' },
    { event: 'parked', reason: 'branch-unmerged-leftover', detail: targetDetail }, // 1st of the streak
    { event: 'transition', to: 'WORKTREE' },
    { event: 'parked', reason: 'branch-unmerged-leftover', detail: targetDetail }, // 2nd
    { event: 'transition', to: 'WORKTREE' },
    { event: 'parked', reason: 'branch-unmerged-leftover', detail: targetDetail }, // 3rd, most recent
  ];

  const count = countRepeatedParks(lines, 'branch-unmerged-leftover', targetDetail);
  assert.equal(count, 3);
});

test('countRepeatedParks: a differing detail breaks the streak even with a matching reason', () => {
  const lines = [
    { event: 'parked', reason: 'branch-unmerged-leftover', detail: { branch: 'x', localSha: 'OLD' } },
    { event: 'parked', reason: 'branch-unmerged-leftover', detail: { branch: 'x', localSha: 'NEW' } },
  ];

  const count = countRepeatedParks(lines, 'branch-unmerged-leftover', { branch: 'x', localSha: 'NEW' });
  assert.equal(count, 1);
});

test('countRepeatedParks: no parked events at all -> 0', () => {
  assert.equal(countRepeatedParks([], 'anything', {}), 0);
});

test('findParkAnchor: null with no park-comment event; the LAST one wins across multiple park cycles', () => {
  assert.equal(findParkAnchor([]), null);
  const lines = [
    { event: 'park-comment', commentId: 10 },
    { event: 'unparked-by-maintainer' },
    { event: 'park-comment', commentId: 20 },
  ];
  const anchor = findParkAnchor(lines);
  assert.equal(anchor.commentId, 20);
  assert.equal(anchor.alreadyHandled, false);
});
