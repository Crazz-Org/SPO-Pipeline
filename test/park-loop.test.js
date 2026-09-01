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

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { runTask, buildCtx, finalizePark, listQueueFiles } = require('../orchestrator/state-machine');
const {
  buildParkComment,
  RETRY_ABANDON_LINE,
  unparkScan,
  shouldScanUnpark,
  findParkAnchor,
  countRepeatedParks,
  postParkComment,
  reEnqueueTask,
} = require('../orchestrator/park-loop');
const { createScanState } = require('../orchestrator/comment-scan');
const { appendEvent, writeState } = require('../orchestrator/journal');
const { timeoutResult } = require('./helpers');

// `gh api` pagination rides in the path's query string, not in `-f page=N` argv elements -- a `-f`
// field would flip the call from GET to POST against the create-comment endpoint (see
// orchestrator/comment-scan.js's header and test/gh-api-argv.test.js). These fakes therefore read
// the page number out of the URL, the same place the real `gh` would.
function pageParamOf(args) {
  for (const a of args) {
    if (typeof a !== 'string') continue;
    const m = a.match(/[?&]page=(\d+)/);
    if (m) return m[1];
  }
  return undefined;
}


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

test('runTask (real mode, card): a pre-worktree park still moves the card, via config.productRepo (action 5.1b), and posts the comment', async () => {
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
  // action 5.1b: no worktree ever existed, but config.productRepo did -- moveCard falls back to
  // it instead of giving up, so `board:move` DOES spawn here now, cwd = productRepo.
  const moveCall = calls.find((c) => c.command === 'npm');
  assert.ok(moveCall, 'board:move must spawn via the product-repo fallback, not be skipped');
  assert.deepEqual(moveCall.args, ['run', 'board:move', '--', '950', 'Parked']);
  assert.equal(moveCall.cwd, config.productRepo);

  const commentCall = calls.find((c) => c.command === 'gh');
  assert.deepEqual(commentCall.args.slice(0, 4), ['issue', 'comment', '950', '--repo']);
  const bodyFile = commentCall.args[commentCall.args.indexOf('--body-file') + 1];
  const body = fs.readFileSync(bodyFile, 'utf8');
  assert.match(body, /nightly-main-red/);
  assert.ok(body.includes(RETRY_ABANDON_LINE));

  const journal = readJournal(taskDir);
  const moved = journal.find((e) => e.event === 'board-move' && e.column === 'Parked');
  assert.ok(moved, 'board-move must be journalled, distinguishable via the `via` marker');
  assert.equal(moved.via, 'product-repo');
  assert.ok(!journal.some((e) => e.event === 'board-move-skipped'));
  assert.ok(journal.some((e) => e.event === 'park-comment' && e.commentId === 555));
});

test('runTask (real mode, card): a pre-worktree park with NO config.productRepo either still skips the board move (unchanged)', async () => {
  const taskDir = mkTmp('spo-park-taskdir-noproductrepo-');
  const config = testConfig({ productRepo: undefined });
  const originMainSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.mkdirSync(path.join(config.spoBenchDir, 'nightly'), { recursive: true });
  fs.writeFileSync(path.join(config.spoBenchDir, 'nightly', 'latest.json'), JSON.stringify({ verdict: 'FAIL', sha: originMainSha }));

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('rev-parse')) return ok(`${originMainSha}\n`);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/951#issuecomment-556\n');
      }
      return ok('');
    },
  };

  const task = { id: 'card-951', kind: 'card', issue: 951, title: 'x' };
  const finalState = await runTask('card-951', task, taskDir, { ...config, deps });

  assert.equal(finalState, 'PARKED');
  assert.ok(!calls.some((c) => c.command === 'npm'), 'no board:move -- neither a worktree nor a productRepo exists');

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'board-move-skipped' && e.reason === 'no worktree'));
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
      // Action 4.6: rule 3's remote-branch leftover check now also looks up any open PR on the
      // branch before deleting it (see steps/scripted.js's sweepWorktreeLeftovers). This
      // fixture's blanket rev-parse stub above makes the remote-branch-leftover check exit 0 same
      // as before -- an empty PR list here keeps that lookup answering "no PR" instead of
      // unparsable, so this test still exercises what it's actually about: a park that happens
      // AFTER the worktree exists, not rule 3's own PR safety logic (covered separately in
      // test/leftover-remote-pr.test.js).
      if (command === 'gh' && args.includes('pr') && args.includes('list')) return ok('[]\n');
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

// `worktreePath`/`prNumber` are optional -- undefined for every pre-4.5 caller (retry/ignored/
// timeout tests never touch abandonCleanup's inputs at all), and only set by the abandon-cleanup
// tests below, which need state.json to carry exactly what unparkScan's abandon branch reads:
// state.worktreePath and state.prNumber, verified present on the real leaked card (issue #443's
// journal/issue-443/state.json, quoted in the spec this action implements).
// `externallyResolved` (action 5.1b): lets a caller pre-seed a task as already reconciled, so
// unparkScan's own reconcileExternalClosure guard (`if (state.externallyResolved) return`) short-
// circuits with no `gh api` call at all -- used by tests that are about the retry/abandon comment
// scan's OWN behaviour (e.g. its per-issue backoff) and would otherwise conflate their own gh-call
// counts with reconciliation's separate, unrelated issue read.
function parkedTaskDir(journalRoot, id, { issue, commentId, worktreePath, prNumber, externallyResolved }) {
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue, title: 'x', criterion: 'y', size: 'S' }));
  writeState(taskDir, { id, state: 'PARKED', reason: 'worktree-npm-ci-failed', worktreePath, prNumber, externallyResolved });
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
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(
          JSON.stringify([
            { id: 95, user: { login: 'Crazz-E' }, created_at: '2026-08-28T00:00:00Z', body: 'retry -- ignored, posted BEFORE the park comment' },
            { id: 105, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'retry\nplease requeue, I fixed the lockfile' },
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
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 210, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'retry' }]));
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
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 310, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon, thanks for trying' }]));
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
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 410, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'what does worktree-npm-ci-failed mean?' }]));
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
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 610, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon, giving up' }]));
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

// ---- action 5.1b: reconcile a parked/abandoned task against the issue it owns -----------------
//
// C5's own re-measurement (2026-09-01, from scratch) found the journal is the stale side on 3 of
// 18 tasks, and in all three the board was already right (GitHub's own "Item closed" workflow
// moves the card on issue close -- no pipeline mutation involved):
//
//   issue-213, issue-428 -- PARKED (`diagnose-duplicate-root-cause`), closed by a human hours
//     later, nothing ever told the pipeline.
//   issue-443 -- ABANDONED (`abandoned-by-maintainer`). `pr:wait` read `closed false` at
//     13:17:57 and parked `pr-closed-unmerged`; PR #447 actually MERGED 30 seconds later, at
//     13:18:27, before the maintainer's own `abandon` reply at 13:53.
//
// These fixtures exercise `unparkScan`'s own `gh api repos/<repo>/issues/<n>` (and, once that
// comes back closed with a `prNumber` on the task, `gh api repos/<repo>/pulls/<n>`) reads through
// the SAME `deps.spawnSync` injection every other test in this file uses -- see this file's own
// header and test/no-real-spawn.js for why a real spawnSync must never be reachable here.

test('unparkScan: action 5.1b -- a PARKED task whose issue is closed writes externallyResolved (via: issue-closed), journals reconciled-externally, and never touches state.state', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-213-');
  const journalRoot = mkTmp('spo-reconcile-journal-213-');
  const taskDir = parkedTaskDir(journalRoot, 'issue-213', { issue: 213, commentId: 100 });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/213$/.test(args[1])) {
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T01:50:00Z' }));
      }
      return ok('[]');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  // Verdict by exit code / argv shape, never gh's text output -- and the path form, no `-f`/`-F`
  // (test/gh-api-argv.test.js's own sweep guards this class repo-wide; this pins the one call
  // site this action adds).
  const issueCall = calls.find((c) => c.command === 'gh' && c.args[0] === 'api' && /\/issues\/213$/.test(c.args[1]));
  assert.ok(issueCall, 'must read the issue, by path');
  assert.deepEqual(issueCall.args, ['api', 'repos/Crazz-Org/SPO-WebClient/issues/213']);
  assert.ok(!issueCall.args.includes('-f') && !issueCall.args.includes('-F'));

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED', 'record, never overwrite -- the pipeline really did park this task');
  assert.ok(state.externallyResolved);
  assert.equal(state.externallyResolved.via, 'issue-closed');
  assert.equal(state.externallyResolved.closedAt, '2026-08-30T01:50:00Z');
  assert.equal(state.externallyResolved.prNumber, null);
  assert.equal(state.externallyResolved.mergedAt, null);
  assert.ok(state.externallyResolved.at);

  const journal = readJournal(taskDir);
  const reconciled = journal.find((e) => e.event === 'reconciled-externally');
  assert.ok(reconciled);
  assert.equal(reconciled.via, 'issue-closed');
  assert.equal(reconciled.closedAt, '2026-08-30T01:50:00Z');
});

test('unparkScan: action 5.1b -- idempotent: once reconciled, the next cycle makes no second issue read at all', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-idem-');
  const journalRoot = mkTmp('spo-reconcile-journal-idem-');
  parkedTaskDir(journalRoot, 'issue-214', { issue: 214, commentId: 100 });

  let issueReads = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/214$/.test(args[1])) {
        issueReads++;
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T01:50:00Z' }));
      }
      return ok('[]');
    },
  };

  const config = { ghRepo: 'Crazz-Org/SPO-WebClient' };
  await unparkScan(queueDir, journalRoot, config, deps);
  assert.equal(issueReads, 1);
  await unparkScan(queueDir, journalRoot, config, deps);
  assert.equal(issueReads, 1, 'state.externallyResolved is itself the guard -- once written, never re-read, ever');
});

test('unparkScan: action 5.1b -- a still-open issue writes nothing, and IS re-read next cycle (that is how a close ever gets noticed)', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-open-');
  const journalRoot = mkTmp('spo-reconcile-journal-open-');
  const taskDir = parkedTaskDir(journalRoot, 'issue-385', { issue: 385, commentId: 100 });

  let issueReads = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/385$/.test(args[1])) {
        issueReads++;
        return ok(JSON.stringify({ state: 'open' }));
      }
      return ok('[]');
    },
  };

  const config = { ghRepo: 'Crazz-Org/SPO-WebClient' };
  await unparkScan(queueDir, journalRoot, config, deps);
  await unparkScan(queueDir, journalRoot, config, deps);

  assert.equal(issueReads, 2, 'a still-open parked issue is re-checked every cycle unparkScan runs');
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.ok(!state.externallyResolved);
  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'reconciled-externally'));
});

test('unparkScan: action 5.1b -- an ABANDONED task reconciles the same way (state.state stays ABANDONED, never re-enqueued)', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-443-abandon-');
  const journalRoot = mkTmp('spo-reconcile-journal-443-abandon-');
  const taskDir = path.join(journalRoot, 'issue-443');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: 'issue-443', kind: 'card', issue: 443, title: 'x' }));
  writeState(taskDir, { id: 'issue-443', state: 'ABANDONED', reason: 'abandoned-by-maintainer' });
  appendEvent(taskDir, 'PARKED', 'abandoned-by-maintainer', { abandonCommentId: 1 });

  let issueReads = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/443$/.test(args[1])) {
        issueReads += 1;
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T13:18:27Z' }));
      }
      return ok('[]');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'ABANDONED');
  assert.ok(state.externallyResolved);
  assert.equal(state.externallyResolved.via, 'issue-closed');

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'reconciled-externally'));

  const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
  assert.equal(queued.length, 0, 'ABANDONED never re-enters the retry/abandon comment scan, reconciled or not');

  // Idempotence for ABANDONED specifically, and not as a formality: verification found that
  // narrowing the guard to `state.externallyResolved && state.state !== 'ABANDONED'` survived the
  // ENTIRE suite, because the ABANDONED case only ever ran one cycle. That regression re-reads
  // issue-443 every 60 seconds forever and appends one more `reconciled-externally` line to an
  // append-only journal each time -- the exact opposite of the "at most 2 reads per task, ever"
  // bound this feature is budgeted on.
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);
  assert.equal(issueReads, 1, 'a reconciled ABANDONED task must never be read again');
  assert.equal(
    readJournal(taskDir).filter((e) => e.event === 'reconciled-externally').length,
    1,
    'exactly one reconciled-externally line, ever'
  );
});

test('unparkScan: action 5.1b -- an `abandon` reply in the SAME cycle as a reconcile keeps externallyResolved (the abandon write must not spread a stale state.json)', async () => {
  // The 213/428 shape taken one step further, and it is not hypothetical: a maintainer who fixes
  // a card by hand and closes its issue may well also reply `abandon` on it. reconcileExternalClosure
  // runs earlier in the same loop iteration and writes to disk; the abandon branch used to spread
  // the in-memory snapshot captured before that write, silently dropping the field -- costing a
  // second issue read and a DUPLICATE journal line on the following cycle.
  const queueDir = mkTmp('spo-reconcile-queue-abandon-race-');
  const journalRoot = mkTmp('spo-reconcile-journal-abandon-race-');
  const taskDir = parkedTaskDir(journalRoot, 'card-race', { issue: 900, commentId: 100 });

  let issueReads = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api' && /\/issues\/900$/.test(args[1])) {
        issueReads += 1;
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T01:50:23Z' }));
      }
      if (command === 'gh' && args[0] === 'api' && /\/issues\/900\/comments/.test(args[1])) {
        return ok(JSON.stringify([{ id: 101, body: 'abandon', user: { login: 'Crazz-E' } }]));
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'ABANDONED', 'the abandon still lands');
  assert.ok(state.externallyResolved, 'and the reconcile written earlier in the same cycle survives it');
  assert.equal(state.externallyResolved.via, 'issue-closed');

  // The whole point: no second read, no duplicate line, on any later cycle.
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);
  assert.equal(issueReads, 1, 'a task reconciled and abandoned in one cycle is never re-read');
  assert.equal(
    readJournal(taskDir).filter((e) => e.event === 'reconciled-externally').length,
    1,
    'exactly one reconciled-externally line, ever'
  );
});

test('unparkScan: action 5.1b -- the 443 shape: PARKED with a prNumber, issue closed, PR merged -> via "pr-merged" carrying the PR\'s own merged_at', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-443pr-');
  const journalRoot = mkTmp('spo-reconcile-journal-443pr-');
  const taskDir = parkedTaskDir(journalRoot, 'card-443pr', { issue: 443, commentId: 100, prNumber: 447 });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/443$/.test(args[1])) {
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T13:17:59Z' }));
      }
      if (command === 'gh' && args[0] === 'api' && /\/pulls\/447$/.test(args[1])) {
        return ok(JSON.stringify({ merged_at: '2026-08-30T13:18:27Z' }));
      }
      return ok('[]');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const prCall = calls.find((c) => c.command === 'gh' && c.args[0] === 'api' && /\/pulls\/447$/.test(c.args[1]));
  assert.ok(prCall, 'the PR is read only once the issue already came back closed');
  assert.deepEqual(prCall.args, ['api', 'repos/Crazz-Org/SPO-WebClient/pulls/447']);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.externallyResolved.via, 'pr-merged');
  assert.equal(state.externallyResolved.mergedAt, '2026-08-30T13:18:27Z');
  assert.equal(state.externallyResolved.closedAt, '2026-08-30T13:17:59Z');
  assert.equal(state.externallyResolved.prNumber, 447);
  // The 30-second gap between the (stale) park read and the real merge is legible from these two
  // fields alone, with no cross-referencing GitHub by hand -- exactly the point of carrying both.
});

test('unparkScan: action 5.1b -- the 213 shape with a PR attached: issue closed, PR present but NOT merged -> via stays "issue-closed"', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-213pr-');
  const journalRoot = mkTmp('spo-reconcile-journal-213pr-');
  const taskDir = parkedTaskDir(journalRoot, 'card-213pr', { issue: 998, commentId: 100, prNumber: 222 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/998$/.test(args[1])) {
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T01:50:00Z' }));
      }
      if (command === 'gh' && args[0] === 'api' && /\/pulls\/222$/.test(args[1])) {
        return ok(JSON.stringify({ merged_at: null }));
      }
      return ok('[]');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.externallyResolved.via, 'issue-closed');
  assert.equal(state.externallyResolved.mergedAt, null);
  assert.equal(state.externallyResolved.prNumber, 222);
});

test('unparkScan: action 5.1b -- a non-zero exit on the issue read never throws, journals reconcile-scan-failed {step: "issue"}, and reconciles fine next cycle', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-fail-');
  const journalRoot = mkTmp('spo-reconcile-journal-fail-');
  const taskDir = parkedTaskDir(journalRoot, 'issue-777', { issue: 777, commentId: 100 });

  let shouldFail = true;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/777$/.test(args[1])) {
        if (shouldFail) return { status: 1, stdout: '', stderr: 'boom', signal: null };
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T00:00:00Z' }));
      }
      return ok('[]');
    },
  };
  const config = { ghRepo: 'Crazz-Org/SPO-WebClient' };

  await assert.doesNotReject(() => unparkScan(queueDir, journalRoot, config, deps));

  let journal = readJournal(taskDir);
  let failed = journal.find((e) => e.event === 'reconcile-scan-failed');
  assert.ok(failed);
  assert.equal(failed.step, 'issue');
  assert.equal(failed.exit, 1);
  let state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.ok(!state.externallyResolved);

  shouldFail = false;
  await unparkScan(queueDir, journalRoot, config, deps);
  state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.ok(state.externallyResolved, 'a scan failure does not brick reconciliation -- the next cycle tries again and succeeds');
});

test('unparkScan: action 5.1b -- a timed-out issue read never throws, journals reconcile-scan-failed with timedOut: true, never a plain exit 1', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-to-');
  const journalRoot = mkTmp('spo-reconcile-journal-to-');
  const taskDir = parkedTaskDir(journalRoot, 'issue-778', { issue: 778, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/778$/.test(args[1])) return timeoutResult();
      return ok('[]');
    },
  };

  await assert.doesNotReject(() =>
    unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', commandTimeoutsMs: { gh: 120000 } }, deps)
  );

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'reconcile-scan-failed');
  assert.ok(failed, 'a hung issue read must still be reported, not silently swallowed');
  assert.equal(failed.timedOut, true);
  assert.notEqual(failed.exit, 1, 'a timeout must never be journalled as a plain exit 1');
});

test('unparkScan: action 5.1b -- unparsable JSON on the issue read never throws, journals reconcile-scan-failed {reason: "unparsable"}', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-badjson-');
  const journalRoot = mkTmp('spo-reconcile-journal-badjson-');
  const taskDir = parkedTaskDir(journalRoot, 'issue-779', { issue: 779, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/779$/.test(args[1])) return ok('not json{{{');
      return ok('[]');
    },
  };

  await assert.doesNotReject(() => unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps));

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'reconcile-scan-failed');
  assert.ok(failed);
  assert.equal(failed.reason, 'unparsable');
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.ok(!state.externallyResolved);
});

test('unparkScan: action 5.1b -- a failed PR read (issue already closed) writes nothing, journals reconcile-scan-failed {step: "pr"}, and reconciles fine next cycle', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-prfail-');
  const journalRoot = mkTmp('spo-reconcile-journal-prfail-');
  const taskDir = parkedTaskDir(journalRoot, 'issue-780', { issue: 780, commentId: 100, prNumber: 448 });

  let prShouldFail = true;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      if (command === 'gh' && args[0] === 'api' && /\/issues\/780$/.test(args[1])) {
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T00:00:00Z' }));
      }
      if (command === 'gh' && args[0] === 'api' && /\/pulls\/448$/.test(args[1])) {
        if (prShouldFail) return { status: 1, stdout: '', stderr: 'boom', signal: null };
        return ok(JSON.stringify({ merged_at: '2026-08-30T00:00:30Z' }));
      }
      return ok('[]');
    },
  };
  const config = { ghRepo: 'Crazz-Org/SPO-WebClient' };

  await unparkScan(queueDir, journalRoot, config, deps);

  let journal = readJournal(taskDir);
  let failed = journal.find((e) => e.event === 'reconcile-scan-failed' && e.step === 'pr');
  assert.ok(failed, 'the issue read succeeded, but the PR read did not -- the whole reconciliation retries next cycle');
  let state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.ok(!state.externallyResolved);

  prShouldFail = false;
  await unparkScan(queueDir, journalRoot, config, deps);
  state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.externallyResolved.via, 'pr-merged');
});

test('unparkScan: action 5.1b -- a reconciled PARKED task still gets its retry/abandon comment scan in the SAME cycle (a human can still ask for another attempt)', async () => {
  const queueDir = mkTmp('spo-reconcile-queue-retry-');
  const journalRoot = mkTmp('spo-reconcile-journal-retry-');
  const taskDir = parkedTaskDir(journalRoot, 'issue-781', { issue: 781, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api' && /\/issues\/781$/.test(args[1])) {
        return ok(JSON.stringify({ state: 'closed', closed_at: '2026-08-30T00:00:00Z' }));
      }
      if (command === 'gh' && args[0] === 'api' && /\/issues\/781\/comments/.test(args[1])) {
        return ok(JSON.stringify([{ id: 200, user: { login: 'Crazz-E' }, body: 'retry -- have another go even though I closed the issue' }]));
      }
      return ok('[]');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.ok(state.externallyResolved, 'reconciliation must have happened');

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'reconciled-externally'));
  assert.ok(
    journal.some((e) => e.event === 'unparked-by-maintainer'),
    'reconciliation must not skip the retry/abandon comment scan for this same task in this same cycle'
  );

  const queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1, 'the retry still re-enqueues the task, reconciled or not');
});

// ---- action 4.5: abandon cleanup (issue #443 -- ABANDONED used to leak the worktree, its local
// AND remote claude-pipe/<id> branch, and the open PR forever) --------------------------------

// Action 4.6's verification found `abandon` and `retry` disagreeing about the same commits.
// `localBranchKept === false` is not proof that nothing is lost: step 3 also deletes a local tip
// vouched for ONLY by `localSha === remoteSha` -- pushed work origin/main does not contain -- and
// step 4 then deleted the remote copy of exactly that. Card #455's loss, reached through
// `abandon` instead of a retry, and against this function's own "the maintainer abandoned the
// CARD, not the commits" rule. Both these tests pin the fix.
function abandonUnmergedDeps(calls, { branch, sha, preserveFails = false }) {
  return {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 720, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') return ok('#issuecomment-721\n');
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('');
      if (command === 'git' && args.includes('worktree') && args.includes('remove')) return ok('');
      // The whole point of the fixture: neither tip is contained in origin/main, and the local
      // tip equals the remote one -- so step 3 deletes the local branch as "vouched" and step 4
      // is reached with localBranchKept === false over unmerged, pushed commits.
      if (command === 'git' && args.includes('merge-base') && args.includes('--is-ancestor')) {
        return { status: 1, stdout: '', stderr: '', signal: null };
      }
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/heads/${branch}`) return ok(`${sha}\n`);
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/remotes/origin/${branch}`) return ok(`${sha}\n`);
      if (command === 'git' && args.includes('branch') && args.includes('-D')) return ok('');
      if (command === 'git' && args.includes('push') && args.some((a) => String(a).includes('refs/heads/wip/'))) {
        return preserveFails ? { status: 1, stdout: '', stderr: 'rejected', signal: null } : ok('');
      }
      if (command === 'git' && args.includes('push') && args.includes('--delete')) return ok('');
      return ok('');
    },
  };
}

test('unparkScan: abandon cleanup -- an unmerged remote tip is preserved to wip/<id>-<ts> BEFORE the remote branch is deleted', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-preserve-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-preserve-');
  const worktreePath = mkTmp('spo-abandon-preserve-wt-');
  const taskDir = parkedTaskDir(journalRoot, 'card-941', { issue: 941, commentId: 700, worktreePath });
  const branch = 'claude-pipe/card-941';
  const sha = 'abc1230000000000000000000000000000000000';

  const calls = [];
  const before = Date.now();
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, abandonUnmergedDeps(calls, { branch, sha }));
  const after = Date.now();

  const journal = readJournal(taskDir);
  const preserved = journal.find((e) => e.event === 'abandon-remote-preserved');
  assert.ok(preserved, 'the unmerged remote tip must be preserved before it is deleted');
  assert.equal(preserved.sha, sha);
  // The timestamp is load-bearing, exactly as in steps/scripted.js's rule 3: a constant ref name
  // would be rejected non-fast-forward on the second use and no later pass could clear it.
  const stamp = /^wip\/card-941-(\d+)$/.exec(preserved.ref);
  assert.ok(stamp, `ref must be wip/<id>-<ts>, got ${preserved.ref}`);
  assert.ok(Number(stamp[1]) >= before && Number(stamp[1]) <= after);

  const deleted = journal.find((e) => e.event === 'abandon-remote-branch-deleted');
  assert.ok(deleted && deleted.preservedRef === preserved.ref, 'the delete records what saved the commits');

  const pushIdx = calls.findIndex((c) => c.command === 'git' && c.args.some((a) => String(a).includes('refs/heads/wip/')));
  const delIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete'));
  assert.ok(pushIdx >= 0 && delIdx >= 0 && pushIdx < delIdx, 'preserve must precede the delete');
  assert.deepEqual(calls[pushIdx].args, ['-C', '/fake/product', 'push', 'origin', `${sha}:refs/heads/${preserved.ref}`]);
});

test('unparkScan: abandon cleanup -- a failed preservation SKIPS the remote delete and never throws', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-preserve-fail-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-preserve-fail-');
  const worktreePath = mkTmp('spo-abandon-preserve-fail-wt-');
  const taskDir = parkedTaskDir(journalRoot, 'card-942', { issue: 942, commentId: 700, worktreePath });
  const branch = 'claude-pipe/card-942';
  const sha = 'def4560000000000000000000000000000000000';

  const calls = [];
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, abandonUnmergedDeps(calls, { branch, sha, preserveFails: true }));

  // The card is still terminal -- a cleanup failure may never leave it un-ABANDONED.
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'ABANDONED');

  const journal = readJournal(taskDir);
  const skipped = journal.find((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'remote-branch');
  assert.ok(skipped && skipped.reason === 'preserve-failed');
  assert.ok(!journal.some((e) => e.event === 'abandon-remote-branch-deleted'));
  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')),
    'nothing may be deleted once the attempt to save it failed'
  );
});

test('unparkScan: abandon cleanup -- prNumber + clean worktree + branch merged into origin/main closes the PR BEFORE deleting the remote branch, journals all four cleanup events', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-cleanup-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-cleanup-');
  const worktreePath = mkTmp('spo-abandon-worktree-');
  const taskDir = parkedTaskDir(journalRoot, 'card-940', { issue: 940, commentId: 700, worktreePath, prNumber: 447 });
  const branch = 'claude-pipe/card-940';

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 710, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon, closing it' }]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'close') return ok('');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/940#issuecomment-711\n');
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('');
      if (command === 'git' && args.includes('worktree') && args.includes('remove')) return ok('');
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/heads/${branch}`) {
        return ok('localsha0000000000000000000000000000000\n');
      }
      if (command === 'git' && args.includes('merge-base') && args.includes('--is-ancestor')) return ok(''); // exit 0 -> ancestor of origin/main
      if (command === 'git' && args.includes('branch') && args.includes('-D')) return ok('');
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/remotes/origin/${branch}`) {
        return ok('remotesha000000000000000000000000000000\n');
      }
      if (command === 'git' && args.includes('push') && args.includes('--delete')) return ok('');
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'ABANDONED');

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'abandon-pr-closed' && e.prNumber === 447));
  assert.ok(journal.some((e) => e.event === 'abandon-worktree-removed' && e.worktreePath === worktreePath));
  assert.ok(journal.some((e) => e.event === 'abandon-branch-deleted' && e.branch === branch));
  assert.ok(journal.some((e) => e.event === 'abandon-remote-branch-deleted' && e.branch === branch));

  const prCloseIdx = calls.findIndex((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close');
  const remoteDeleteIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete'));
  assert.ok(prCloseIdx >= 0 && remoteDeleteIdx >= 0);
  assert.ok(prCloseIdx < remoteDeleteIdx, 'gh pr close must run before the remote branch delete (deleting the branch first would auto-close the PR as an unlogged side effect -- issue #455)');

  // The terminal transition is journalled BEFORE any cleanup step -- the observable proxy for
  // "state.json already says ABANDONED by the time the first git/gh cleanup call runs", which is
  // what makes a crash mid-cleanup safe. `abandoned-by-maintainer` is appended on the very next
  // line after writeState, so an implementation that ran the cleanup first would emit the four
  // abandon-* events ahead of it here.
  const terminalIdx = journal.findIndex((e) => e.event === 'abandoned-by-maintainer');
  assert.ok(terminalIdx >= 0);
  for (const e of journal) {
    if (!String(e.event).startsWith('abandon-')) continue;
    assert.ok(
      journal.indexOf(e) > terminalIdx,
      `cleanup event ${e.event} must be journalled AFTER abandoned-by-maintainer, never before the terminal state write`
    );
  }
});

test('unparkScan: abandon cleanup -- a `git status --porcelain` that FAILS is treated exactly like dirty, never like clean', async () => {
  // The mutation this test exists to kill: dropping the `statusExit !== 0` guard so an
  // inconclusive status falls through to the emptiness check. spawnSync's own timeout kill
  // returns `{status: null, stdout: '', ...}` (test/helpers.js's timeoutResult, the real shape) --
  // an empty stdout that would read as "clean" and hand `worktree remove --force` a worktree
  // nobody ever confirmed was safe to destroy. Both non-zero-exit and timed-out shapes are
  // covered here for that reason.
  for (const [label, statusResult] of [
    ['non-zero exit', { status: 1, stdout: '', stderr: 'fatal: not a git repository', signal: null }],
    ['timed out', timeoutResult()],
  ]) {
    const queueDir = mkTmp('spo-unpark-queue-abandon-statusfail-');
    const journalRoot = mkTmp('spo-unpark-journal-abandon-statusfail-');
    const worktreePath = mkTmp('spo-abandon-statusfail-worktree-');
    const taskDir = parkedTaskDir(journalRoot, 'card-946', { issue: 946, commentId: 1300, worktreePath });

    const calls = [];
    const deps = {
      spawnSync: (command, args) => {
        calls.push({ command, args: [...args] });
        if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
          return ok(JSON.stringify([{ login: 'Crazz-E' }]));
        }
        if (command === 'gh' && args[0] === 'api') {
          return ok(JSON.stringify([{ id: 1310, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
        }
        if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return statusResult;
        return ok('');
      },
    };

    await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

    const journal = readJournal(taskDir);
    const skipped = journal.find((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'worktree');
    assert.ok(skipped, `${label}: the worktree step must be journalled as skipped`);
    assert.equal(skipped.reason, 'status-failed', `${label}: reason must distinguish an inconclusive status from a dirty one`);
    assert.ok(
      !calls.some((c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('remove')),
      `${label}: no \`git worktree remove --force\` argv -- an inconclusive answer is never "clean"`
    );
    assert.ok(
      !calls.some((c) => c.command === 'git' && c.args.includes('branch') && c.args.includes('-D')),
      `${label}: no \`git branch -D\` argv -- the worktree still holds the branch`
    );
  }
});

test('unparkScan: abandon cleanup -- a `git status --porcelain` output of pure whitespace is clean, not dirty', async () => {
  // Guards the `.trim()` on the emptiness check (the same one sweepWorktreeLeftovers rule 1
  // applies). Without it, a status whose only output is a trailing newline reads as dirty and the
  // leaked worktree this action exists to reclaim would be left behind forever.
  const queueDir = mkTmp('spo-unpark-queue-abandon-ws-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-ws-');
  const worktreePath = mkTmp('spo-abandon-ws-worktree-');
  const taskDir = parkedTaskDir(journalRoot, 'card-947', { issue: 947, commentId: 1400, worktreePath });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 1410, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('\n');
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'abandon-worktree-removed' && e.worktreePath === worktreePath));
  assert.ok(!journal.some((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'worktree'));
  assert.ok(calls.some((c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('remove')));
});

test('unparkScan: abandon cleanup -- a local branch NOT in origin/main but equal to its remote tip IS vouched for and deleted', async () => {
  // sweepWorktreeLeftovers rule 2's second vouching clause ("fully pushed, nothing local-only"),
  // which the first mainline test never reaches: there `merge-base --is-ancestor` already exits 0,
  // so the whole `if (!safe)` remote-tip comparison is dead code under that fixture. Deleting the
  // clause outright left the suite green before this test existed.
  const queueDir = mkTmp('spo-unpark-queue-abandon-pushed-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-pushed-');
  const worktreePath = mkTmp('spo-abandon-pushed-worktree-');
  const taskDir = parkedTaskDir(journalRoot, 'card-948', { issue: 948, commentId: 1500, worktreePath });
  const branch = 'claude-pipe/card-948';
  const sha = 'aaaabbbbccccddddeeeeffff0000111122223333';

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 1510, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('');
      if (command === 'git' && args.includes('worktree') && args.includes('remove')) return ok('');
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/heads/${branch}`) return ok(`${sha}\n`);
      // NOT contained in origin/main -- the PR was never merged. The only thing vouching for this
      // tip is that origin/<branch> points at the very same commit.
      if (command === 'git' && args.includes('merge-base')) return { status: 1, stdout: '', stderr: '', signal: null };
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/remotes/origin/${branch}`) return ok(`${sha}\n`);
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const journal = readJournal(taskDir);
  const deleted = journal.find((e) => e.event === 'abandon-branch-deleted');
  assert.ok(deleted, 'a fully-pushed tip is vouched for by its remote counterpart, exactly as sweepWorktreeLeftovers rule 2 has it');
  assert.equal(deleted.branch, branch);
  assert.equal(deleted.sha, sha);
  assert.ok(calls.some((c) => c.command === 'git' && c.args.includes('branch') && c.args.includes('-D')));
  assert.ok(!journal.some((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'local-branch'));
});

test('unparkScan: abandon cleanup -- the remote-tip vouching is full sha EQUALITY, not a prefix match', async () => {
  // Two shas sharing a prefix are two different commits. A `startsWith`-shaped comparison would
  // force-delete a local tip whose remote counterpart is a DIFFERENT commit -- the exact "the fix
  // destroys the commits the maintainer only meant to stop working on" failure this rule exists
  // to prevent.
  const queueDir = mkTmp('spo-unpark-queue-abandon-prefix-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-prefix-');
  const worktreePath = mkTmp('spo-abandon-prefix-worktree-');
  const taskDir = parkedTaskDir(journalRoot, 'card-949', { issue: 949, commentId: 1600, worktreePath });
  const branch = 'claude-pipe/card-949';
  const localSha = 'aaaabbbbccccddddeeeeffff0000111122223333';
  const remoteSha = 'aaaabbbbccccddddeeeeffff0000111122229999';

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 1610, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('');
      if (command === 'git' && args.includes('worktree') && args.includes('remove')) return ok('');
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/heads/${branch}`) return ok(`${localSha}\n`);
      if (command === 'git' && args.includes('merge-base')) return { status: 1, stdout: '', stderr: '', signal: null };
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/remotes/origin/${branch}`) return ok(`${remoteSha}\n`);
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const journal = readJournal(taskDir);
  const skipped = journal.find((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'local-branch');
  assert.ok(skipped);
  assert.equal(skipped.reason, 'unmerged');
  assert.ok(!calls.some((c) => c.command === 'git' && c.args.includes('branch') && c.args.includes('-D')));
});

test('unparkScan: abandon cleanup -- no origin/<branch> means no `push origin --delete` argv at all', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-noremote-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-noremote-');
  const worktreePath = mkTmp('spo-abandon-noremote-worktree-');
  const taskDir = parkedTaskDir(journalRoot, 'card-950', { issue: 950, commentId: 1700, worktreePath });
  const branch = 'claude-pipe/card-950';

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 1710, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('');
      if (command === 'git' && args.includes('worktree') && args.includes('remove')) return ok('');
      // Neither the local nor the remote ref resolves -- the branch simply does not exist here.
      if (command === 'git' && args.includes('rev-parse') && String(args[args.length - 1]).includes(branch)) {
        return { status: 1, stdout: '', stderr: '', signal: null };
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')),
    'a `push origin --delete` of a branch that does not exist would fail and journal a cleanup failure for nothing'
  );
  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'abandon-remote-branch-deleted'));
  assert.ok(!journal.some((e) => e.event === 'abandon-cleanup-failed' && e.step === 'remote-branch'));
});

test('unparkScan: abandon cleanup -- a cleanup step that THROWS is caught, journalled, and never aborts the scan for the next parked task', async () => {
  // Distinct from the "every cleanup command exits non-zero" test above: this is the case that
  // test never reaches, an exception rather than an exit code (a bad path handed to spawnSync, an
  // ERR_INVALID_ARG_TYPE from an undefined argv element, an EMFILE...). Without the try/catch
  // around abandonCleanup, unparkScan's own `for` loop unwinds and card-952 -- parked in the SAME
  // pass, with a perfectly good `retry` waiting -- is never looked at, this cycle or any other
  // until the throwing card stops throwing.
  const queueDir = mkTmp('spo-unpark-queue-abandon-throw-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-throw-');
  const taskDirA = parkedTaskDir(journalRoot, 'card-951', { issue: 951, commentId: 1800, prNumber: 601 });
  const taskDirB = parkedTaskDir(journalRoot, 'card-952', { issue: 952, commentId: 1900 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).includes('issues/951/comments')) {
        return ok(JSON.stringify([{ id: 1810, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).includes('issues/952/comments')) {
        return ok(JSON.stringify([{ id: 1910, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'retry' }]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'close') {
        throw new TypeError('The "args[1]" argument must be of type string');
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/951#issuecomment-1820\n');
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const stateA = JSON.parse(fs.readFileSync(path.join(taskDirA, 'state.json'), 'utf8'));
  assert.equal(stateA.state, 'ABANDONED', 'the terminal transition already happened before the cleanup could throw');
  const journalA = readJournal(taskDirA);
  const unexpected = journalA.find((e) => e.event === 'abandon-cleanup-failed' && e.step === 'unexpected');
  assert.ok(unexpected, 'the throw is journalled, not swallowed silently');
  assert.match(unexpected.error, /must be of type string/);

  const journalB = readJournal(taskDirB);
  assert.ok(journalB.some((e) => e.event === 'unparked-by-maintainer'), 'the next parked task in the same pass is still processed');
  const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
  assert.equal(queued.length, 1);
});

test('unparkScan: abandon cleanup -- a DIRTY worktree is never destroyed, and the local branch it holds is never force-deleted either', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-dirty-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-dirty-');
  const worktreePath = mkTmp('spo-abandon-dirty-worktree-');
  fs.writeFileSync(path.join(worktreePath, 'uncommitted.ts'), 'still here -- never destroyed by a cleanup path');
  const taskDir = parkedTaskDir(journalRoot, 'card-941', { issue: 941, commentId: 800, worktreePath });
  const branch = 'claude-pipe/card-941';

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 810, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok(' M uncommitted.ts\n');
      if (command === 'git' && args.includes('rev-parse') && String(args[args.length - 1]).includes(branch)) {
        return ok('localsha4444444444444444444444444444444\n'); // both refs/heads/<b> and origin/<b> resolve
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const journal = readJournal(taskDir);
  const skipped = journal.find((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'worktree');
  assert.ok(skipped);
  assert.equal(skipped.reason, 'dirty');
  assert.equal(skipped.worktreePath, worktreePath);

  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('remove')),
    'no `git worktree remove` argv for a dirty worktree'
  );
  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('branch') && c.args.includes('-D')),
    'no `git branch -D` argv -- step 3 never runs when step 2 left the worktree in place'
  );

  // ...and the remote copy of that same kept branch is not destroyed either. steps/scripted.js
  // gets this for free (its rule 2 throws, so its rule 3 is unreachable once a tip is kept);
  // here nothing throws, so without an explicit veto the cleanup would preserve the local tip on
  // the grounds that the maintainer abandoned the card and not the commits, and then delete the
  // only pushed copy of those very commits two blocks later.
  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')),
    'no `git push origin --delete` argv -- a kept local branch vetoes the remote delete'
  );
  const remoteSkipped = journal.find((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'remote-branch');
  assert.ok(remoteSkipped, 'the skipped remote delete is journalled, not silently omitted');
  assert.equal(remoteSkipped.reason, 'local-branch-kept');
  assert.equal(remoteSkipped.branch, branch);
});

test('unparkScan: abandon cleanup -- a local branch that is neither merged into origin/main nor equal to its remote tip is left alone', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-unmerged-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-unmerged-');
  const worktreePath = mkTmp('spo-abandon-unmerged-worktree-');
  const taskDir = parkedTaskDir(journalRoot, 'card-942', { issue: 942, commentId: 900, worktreePath });
  const branch = 'claude-pipe/card-942';

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 910, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('');
      if (command === 'git' && args.includes('worktree') && args.includes('remove')) return ok('');
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/heads/${branch}`) {
        return ok('localsha1111111111111111111111111111111\n');
      }
      if (command === 'git' && args.includes('merge-base') && args.includes('--is-ancestor')) {
        return { status: 1, stdout: '', stderr: '', signal: null }; // not an ancestor of origin/main
      }
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/remotes/origin/${branch}`) {
        return ok('differentsha22222222222222222222222222\n'); // remote tip differs from local -- unvouched
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const journal = readJournal(taskDir);
  const skipped = journal.find((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'local-branch');
  assert.ok(skipped);
  assert.equal(skipped.reason, 'unmerged');
  assert.equal(skipped.localSha, 'localsha1111111111111111111111111111111');
  assert.equal(skipped.remoteSha, 'differentsha22222222222222222222222222');

  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('branch') && c.args.includes('-D')),
    'the maintainer abandoned the card, not the commits -- an unvouched local-only tip is never force-deleted'
  );
  // Same reasoning one step further: origin/<branch> here is a DIFFERENT commit from the local
  // tip, i.e. it carries commits nothing else references. Deleting it while deliberately keeping
  // the local branch would destroy exactly what the skip above just refused to destroy.
  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('push') && c.args.includes('--delete')),
    'a kept local branch vetoes the remote delete too'
  );
  const remoteSkipped = journal.find((e) => e.event === 'abandon-cleanup-skipped' && e.step === 'remote-branch');
  assert.ok(remoteSkipped);
  assert.equal(remoteSkipped.reason, 'local-branch-kept');
});

test('unparkScan: abandon cleanup -- every cleanup command failing leaves the card ABANDONED, journals abandon-cleanup-failed per failing step, and the scan still processes the NEXT parked task', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-allfail-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-allfail-');
  const worktreePath = mkTmp('spo-abandon-allfail-worktree-');
  const taskDirA = parkedTaskDir(journalRoot, 'card-943', { issue: 943, commentId: 1000, worktreePath, prNumber: 500 });
  const branchA = 'claude-pipe/card-943';
  const taskDirB = parkedTaskDir(journalRoot, 'card-944', { issue: 944, commentId: 1100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).includes('issues/943/comments')) {
        return ok(JSON.stringify([{ id: 1010, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).includes('issues/944/comments')) {
        return ok(JSON.stringify([{ id: 1110, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'retry' }]));
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'close') return { status: 1, stdout: '', stderr: '', signal: null };
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/943#issuecomment-1020\n');
      }
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return ok('');
      if (command === 'git' && args.includes('worktree') && args.includes('remove')) {
        return { status: 1, stdout: '', stderr: '', signal: null };
      }
      // No local claude-pipe/card-943 tip at all -- so nothing this cleanup kept is standing
      // between the remote-branch step and its (also failing) `push origin --delete`. See the
      // dirty-worktree test below for the opposite case, where a kept local tip vetoes it.
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/heads/${branchA}`) {
        return { status: 1, stdout: '', stderr: '', signal: null };
      }
      if (command === 'git' && args.includes('rev-parse') && args[args.length - 1] === `refs/remotes/origin/${branchA}`) {
        return ok('remotesha333333333333333333333333333333\n');
      }
      if (command === 'git' && args.includes('push') && args.includes('--delete')) {
        return { status: 1, stdout: '', stderr: '', signal: null };
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  const stateA = JSON.parse(fs.readFileSync(path.join(taskDirA, 'state.json'), 'utf8'));
  assert.equal(stateA.state, 'ABANDONED', 'the terminal transition is not blocked by any cleanup failure');
  const journalA = readJournal(taskDirA);
  assert.ok(journalA.some((e) => e.event === 'abandoned-by-maintainer'));
  const failedSteps = journalA.filter((e) => e.event === 'abandon-cleanup-failed').map((e) => e.step).sort();
  assert.deepEqual(failedSteps, ['pr-close', 'remote-branch', 'worktree']);
  // step 3 (local-branch) never even runs -- step 2 (worktree) failed, so worktreeRemoved is
  // false and the local-branch block is never entered, let alone journalled as failed.
  assert.ok(!journalA.some((e) => e.event === 'abandon-cleanup-failed' && e.step === 'local-branch'));

  // Task B, parked in the SAME pass, is still processed -- one card's cleanup failing must never
  // abort the scan for the others.
  const journalB = readJournal(taskDirB);
  assert.ok(journalB.some((e) => e.event === 'unparked-by-maintainer'));
  const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
  assert.equal(queued.length, 1, 'task B\'s retry still re-enqueues normally');
});

test('unparkScan: abandon cleanup -- no prNumber in state.json means no `gh pr close` argv at all', async () => {
  const queueDir = mkTmp('spo-unpark-queue-abandon-nopr-');
  const journalRoot = mkTmp('spo-unpark-journal-abandon-nopr-');
  const taskDir = parkedTaskDir(journalRoot, 'card-945', { issue: 945, commentId: 1200 });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 1210, user: { login: 'Crazz-E' }, created_at: '2026-08-29T00:00:00Z', body: 'abandon' }]));
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', productRepo: '/fake/product' }, deps);

  assert.ok(!calls.some((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'close'));
  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'abandon-pr-closed'));
  assert.ok(!journal.some((e) => e.event === 'abandon-cleanup-failed' && e.step === 'pr-close'));
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

// ---- action 2.8: retry priority ----------------------------------------------------------------

test('reEnqueueTask: names the file 0000-retry-<ts>-<id>.json -- sorts before any fresh NNNN-issue-... card', () => {
  const queueDir = mkTmp('spo-retry-priority-queue-');
  const journalRoot = mkTmp('spo-retry-priority-journal-');
  const taskDir = path.join(journalRoot, 'card-500');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: 'card-500', kind: 'card', issue: 500 }));

  // A fresh auto-pulled card, exactly the shape intake.js's makeTask writes -- the lowest
  // sequence nextQueueSeq ever hands out is 1, never 0.
  fs.writeFileSync(path.join(queueDir, '0001-issue-777.json'), JSON.stringify({ id: 'issue-777' }));

  const file = reEnqueueTask(queueDir, taskDir, 'card-500');

  assert.match(path.basename(file), /^0000-retry-\d+-card-500\.json$/);

  const sorted = listQueueFiles(queueDir);
  assert.deepEqual(sorted, [path.basename(file), '0001-issue-777.json'], 'the retry must sort first');
});

test('reEnqueueTask: the id stays recoverable both from the written task.json and (as a fallback) the filename', () => {
  const queueDir = mkTmp('spo-retry-id-queue-');
  const journalRoot = mkTmp('spo-retry-id-journal-');
  const taskDir = path.join(journalRoot, 'card-501');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: 'card-501', kind: 'card', issue: 501 }));

  const file = reEnqueueTask(queueDir, taskDir, 'card-501');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.id, 'card-501', "takeNextTask's primary path: task.json's own id field");

  // Defense in depth: even ignoring task.json entirely, takeNextTask's basename fallback
  // (`path.basename(file, '.json')`) still ends in the id, unambiguously.
  assert.ok(path.basename(file, '.json').endsWith('-card-501'));
});

test('reEnqueueTask: multiple retries queued at once still sort relative to each other by timestamp', () => {
  const queueDir = mkTmp('spo-retry-multi-queue-');
  const journalRoot = mkTmp('spo-retry-multi-journal-');
  const dirA = path.join(journalRoot, 'card-600');
  const dirB = path.join(journalRoot, 'card-601');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'task.json'), JSON.stringify({ id: 'card-600' }));
  fs.writeFileSync(path.join(dirB, 'task.json'), JSON.stringify({ id: 'card-601' }));

  const fileA = reEnqueueTask(queueDir, dirA, 'card-600');
  const fileB = reEnqueueTask(queueDir, dirB, 'card-601');

  const sorted = listQueueFiles(queueDir);
  assert.deepEqual(sorted.sort(), [path.basename(fileA), path.basename(fileB)].sort());
  assert.ok(sorted.every((f) => f.startsWith('0000-retry-')));
});

// action 3.1: baseMainSha is a run's own record of where origin/main sat when IT ran, same
// category of runtime fact as worktreePath/branch -- a retry must not carry it forward, or
// handlePlan's reuse guard (state-machine.js's decidePlanReuse) could find a stale sha already
// sitting on ctx.task and mistake "nobody re-measured it" for "origin/main hasn't moved".
test('reEnqueueTask: drops baseMainSha (alongside worktreePath/branch), preserving everything else including id', () => {
  const queueDir = mkTmp('spo-retry-basesha-queue-');
  const journalRoot = mkTmp('spo-retry-basesha-journal-');
  const taskDir = path.join(journalRoot, 'card-700');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({
      id: 'card-700',
      kind: 'card',
      issue: 700,
      title: 'Some card',
      worktreePath: '/tmp/some-worktree',
      branch: 'claude-pipe/card-700',
      baseMainSha: 'deadbeef',
    })
  );

  const file = reEnqueueTask(queueDir, taskDir, 'card-700');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(written.id, 'card-700');
  assert.equal(written.kind, 'card');
  assert.equal(written.issue, 700);
  assert.equal(written.title, 'Some card');
  assert.equal('worktreePath' in written, false);
  assert.equal('branch' in written, false);
  assert.equal('baseMainSha' in written, false, 'a stale sha must not survive into the retried task.json');
});

test('shouldScanUnpark: disabled at <= 0, fires on first call, then respects the interval -- same shape as shouldScanOrphans', () => {
  assert.equal(shouldScanUnpark(null, 1000, 0), false);
  assert.equal(shouldScanUnpark(null, 1000, 60000), true);
  assert.equal(shouldScanUnpark(1000, 1000 + 59999, 60000), false);
  assert.equal(shouldScanUnpark(1000, 1000 + 60000, 60000), true);
});

// ---- action 2.7: unified comment-scan rewrite (pagination, allowlist, backoff) -----------------

test('unparkScan: a "retry" reply from a COLLABORATOR works exactly as before', async () => {
  const queueDir = mkTmp('spo-unpark27-queue-collab-');
  const journalRoot = mkTmp('spo-unpark27-journal-collab-');
  const taskDir = parkedTaskDir(journalRoot, 'card-910', { issue: 910, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 105, body: 'retry -- fixed it', user: { login: 'maintainer' } }]));
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1);
  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'unparked-by-maintainer' && e.retryCommentId === 105));
});

test('unparkScan: a "retry" reply from a NON-collaborator is ignored, journalled, and never re-enqueues', async () => {
  const queueDir = mkTmp('spo-unpark27-queue-noncollab-');
  const journalRoot = mkTmp('spo-unpark27-journal-noncollab-');
  const taskDir = parkedTaskDir(journalRoot, 'card-911', { issue: 911, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 106, body: 'retry -- I am not on the repo', user: { login: 'rando' } }]));
      }
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const queued = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
  assert.equal(queued.length, 0, 'a non-collaborator must never trigger a retry');
  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'unparked-by-maintainer'));
  const ignored = journal.find((e) => e.event === 'unpark-scan-ignored-author');
  assert.ok(ignored, 'the ignored attempt must still be journalled, not silently dropped');
  assert.equal(ignored.author, 'rando');
  assert.equal(ignored.matched, 'retry');
});

test('unparkScan: a reply on page 2 of 3 is found -- the one-page bug this action fixes', async () => {
  const queueDir = mkTmp('spo-unpark27-queue-page2-');
  const journalRoot = mkTmp('spo-unpark27-journal-page2-');
  const taskDir = parkedTaskDir(journalRoot, 'card-912', { issue: 912, commentId: 500 });

  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'old chatter' })); // all <= anchor
  const page2 = Array.from({ length: 100 }, (_, i) => ({ id: 501 + i, body: 'old-ish chatter' }));
  page2[49] = { id: 550, body: 'retry -- see fix above', user: { login: 'maintainer' } };
  const page3 = Array.from({ length: 20 }, (_, i) => ({ id: 601 + i, body: 'more chatter' }));

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      const pageArg = pageParamOf(args);
      const page = pageArg ? Number(pageArg) : 1;
      if (page === 1) return ok(JSON.stringify(page1));
      if (page === 2) return ok(JSON.stringify(page2));
      return ok(JSON.stringify(page3));
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  const journal = readJournal(taskDir);
  const unparked = journal.find((e) => e.event === 'unparked-by-maintainer');
  assert.ok(unparked, 'a reply on page 2 must be found, not silently missed the way it used to be');
  assert.equal(unparked.retryCommentId, 550);
});

test('unparkScan: the collaborator list is fetched once per repo and reused across multiple parked tasks in the same pass', async () => {
  const queueDir = mkTmp('spo-unpark27-queue-cache-');
  const journalRoot = mkTmp('spo-unpark27-journal-cache-');
  parkedTaskDir(journalRoot, 'card-920', { issue: 920, commentId: 100 });
  parkedTaskDir(journalRoot, 'card-921', { issue: 921, commentId: 100 });

  let collabCalls = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        collabCalls++;
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      return ok(JSON.stringify([]));
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, deps);

  assert.equal(collabCalls, 1, 'two parked tasks sharing a repo must not each pay for their own collaborators fetch');
});

test('unparkScan: consecutive gh failures on the SAME issue back off, and a subsequent success resets it', async () => {
  const queueDir = mkTmp('spo-unpark27-queue-backoff-');
  const journalRoot = mkTmp('spo-unpark27-journal-backoff-');
  // action 5.1b: pre-seeded as already reconciled so reconcileExternalClosure's own issue read
  // (an unrelated `gh api repos/.../issues/930` call, no backoff of its own) never fires and
  // never pollutes this test's own ghApiCalls count -- this test is about the comment-scan's
  // per-issue backoff, not reconciliation.
  const taskDir = parkedTaskDir(journalRoot, 'card-930', {
    issue: 930,
    commentId: 100,
    externallyResolved: { via: 'issue-closed', closedAt: '2026-08-01T00:00:00Z', prNumber: null, mergedAt: null, at: '2026-08-01T00:00:00Z' },
  });

  let ghApiCalls = 0;
  let shouldFail = true;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && !String(args[1]).endsWith('/collaborators')) {
        ghApiCalls++;
        if (shouldFail) return { status: 1, stdout: '', stderr: 'boom', signal: null };
      }
      return ok('[]');
    },
  };

  const scanState = createScanState();
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, { ...deps, now: 1000 }, scanState); // failure 1
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, { ...deps, now: 2000 }, scanState); // failure 2 -- now backs off

  const callsBeforeBackoffCheck = ghApiCalls;
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, { ...deps, now: 2500 }, scanState); // still backed off
  assert.equal(ghApiCalls, callsBeforeBackoffCheck, 'a backed-off cycle must not call gh again');
  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'unpark-scan-backoff-skip'));

  shouldFail = false;
  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient' }, { ...deps, now: 2400000 }, scanState); // well past the backoff window -- succeeds
  assert.ok(ghApiCalls > callsBeforeBackoffCheck, 'once the backoff window elapses, the scan tries gh again');
});

test('unparkScan: the page bound being hit is journalled distinguishably from "no reply"', async () => {
  const queueDir = mkTmp('spo-unpark27-queue-truncated-');
  const journalRoot = mkTmp('spo-unpark27-journal-truncated-');
  const taskDir = parkedTaskDir(journalRoot, 'card-940', { issue: 940, commentId: 0 });

  const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'chatter' }));
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      return ok(JSON.stringify(fullPage)); // always full -- never a natural end
    },
  };

  await unparkScan(queueDir, journalRoot, { ghRepo: 'Crazz-Org/SPO-WebClient', commentScanMaxPages: 1 }, deps);

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'unpark-scan-truncated'), 'must be distinguishable from the silent "nothing matched" case');
  assert.ok(!journal.some((e) => e.event === 'unparked-by-maintainer'));
});
