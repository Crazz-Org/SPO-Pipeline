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

const { runTask } = require('../orchestrator/state-machine');
const { buildParkComment, RETRY_ABANDON_LINE, unparkScan, findParkAnchor } = require('../orchestrator/park-loop');
const { appendEvent, writeState } = require('../orchestrator/journal');

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

// ---- findParkAnchor: pure helper --------------------------------------------------------------

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
