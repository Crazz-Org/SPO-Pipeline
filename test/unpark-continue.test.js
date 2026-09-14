'use strict';
// unpark-continue.test.js -- card #212, actions C4 (the `continue` verb) and C5 (the park comment
// text that tells a maintainer it exists). Companion to test/park-loop.test.js's own retry/abandon
// suite and test/resume-at-check.test.js's own runTask-side C1 suite -- follows both files'
// conventions (fake `deps.spawnSync`, `require('./no-real-spawn')` before the orchestrator
// requires, `mkTmp` for throwaway queue/journal roots).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const { runTask, TERMINAL_PARK_REASONS } = require('../orchestrator/state-machine');
const {
  unparkScan,
  findParkAnchor,
  reEnqueueTask,
  RESUMABLE_PARK_REASONS,
  continueEligibility,
  buildContinueRefusedAck,
  buildParkComment,
  RETRY_ABANDON_LINE,
} = require('../orchestrator/park-loop');
const { appendEvent, writeState } = require('../orchestrator/journal');
const { mkTmp } = require('./helpers');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function testConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-continue-worktrees-'),
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

// Same shape as park-loop.test.js's own parkedTaskDir, widened with `reason`/`prNumber`/
// `externallyResolved` so a resumable park can be built directly instead of always taking the
// suite's default `worktree-npm-ci-failed`.
function parkedTaskDir(journalRoot, id, { issue, commentId, reason = 'merge-conflict', prNumber, externallyResolved }) {
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue, title: 'x', criterion: 'y', size: 'S' }));
  writeState(taskDir, { id, state: 'PARKED', reason, prNumber, externallyResolved });
  appendEvent(taskDir, 'MERGE', 'parked', { reason });
  appendEvent(taskDir, 'PARKED', 'park-comment', { commentId, reason });
  return taskDir;
}

function collabDeps(comments, { collaborators = ['Crazz-E'], onAck } = {}) {
  return {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify(collaborators.map((login) => ({ login }))));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify(comments));
      }
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        if (onAck) return onAck();
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/1#issuecomment-9001\n');
      }
      return ok('');
    },
  };
}

// ============================================================================================
// ---- RESUMABLE_PARK_REASONS: every member must be a registered TERMINAL_PARK_REASONS entry ---
// ============================================================================================

test('RESUMABLE_PARK_REASONS: every member is registered in state-machine.js TERMINAL_PARK_REASONS', () => {
  for (const reason of RESUMABLE_PARK_REASONS) {
    assert.ok(TERMINAL_PARK_REASONS.has(reason), `${reason} is on RESUMABLE_PARK_REASONS but not TERMINAL_PARK_REASONS`);
  }
  assert.equal(RESUMABLE_PARK_REASONS.size, 6);
});

// ============================================================================================
// ---- eligible `continue`: one per RESUMABLE_PARK_REASONS member --------------------------------
// ============================================================================================

for (const reason of RESUMABLE_PARK_REASONS) {
  test(`unparkScan: an eligible "continue" (reason=${reason}) re-enqueues with task.resume, priority 'h', keyed on the comment id`, async () => {
    const queueDir = mkTmp('spo-continue-queue-');
    const journalRoot = mkTmp('spo-continue-journal-');
    const config = testConfig();
    const id = `card-cont-${reason}`;
    // state.json's own worktreePath is deliberately a DIFFERENT, foreign path -- the resumed
    // worktreePath must always be the pipeline's own <pipelineWorktreesDir>/<id>, never this one.
    const taskDir = parkedTaskDir(journalRoot, id, {
      issue: 601,
      commentId: 100,
      reason,
      prNumber: 555,
    });
    writeState(taskDir, {
      id,
      state: 'PARKED',
      reason,
      prNumber: 555,
      worktreePath: '/somewhere/foreign/not-the-pipeline-worktree',
    });

    const deps = collabDeps([{ id: 105, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }]);

    await unparkScan(queueDir, journalRoot, config, deps);

    const queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
    assert.equal(queued.length, 1);
    assert.equal(queued[0], `0000-retry-h-${String(105).padStart(20, '0')}-${id}.json`, 'priority class h, keyed on the comment id (a crash re-run collides on this name)');
    const written = JSON.parse(fs.readFileSync(path.join(queueDir, queued[0]), 'utf8'));
    assert.deepEqual(written.resume, {
      startState: 'CHECK',
      prNumber: 555,
      worktreePath: path.join(config.pipelineWorktreesDir, id),
      commentId: 105,
      fromReason: reason,
    });

    const journal = readJournal(taskDir);
    const marker = journal.find((e) => e.event === 'unparked-by-maintainer');
    assert.ok(marker);
    assert.equal(marker.verb, 'continue');
    assert.equal(marker.retryCommentId, 105);
  });
}

test('unparkScan: eligible continue -- effect before marker; a throwing queue write withholds the marker and the next cycle redoes it; a second cycle after success is idempotent', async () => {
  const journalRoot = mkTmp('spo-continue-effect-journal-');
  const config = testConfig({ queueDir: mkTmp('spo-continue-effect-queue-nonexistent-parent-XX') });
  const id = 'card-cont-effect';
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 602, commentId: 200, reason: 'merge-conflict', prNumber: 700 });

  const deps = collabDeps([{ id: 210, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }]);

  // Force the queue write to fail: point queueDir at a path whose parent does not exist AND
  // cannot be created (a file sitting where the parent directory should be).
  const blockedParent = path.join(mkTmp('spo-continue-effect-blocked-'), 'not-a-dir');
  fs.writeFileSync(blockedParent, 'x');
  const badQueueDir = path.join(blockedParent, 'queue');

  await unparkScan(badQueueDir, journalRoot, { ...config, queueDir: badQueueDir }, deps);

  let journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'unparked-by-maintainer'), 'marker withheld on a failed write');
  assert.ok(!fs.existsSync(badQueueDir));

  // Redo with a working queue dir -- findParkAnchor must still see no marker and redo the effect.
  const goodQueueDir = mkTmp('spo-continue-effect-good-queue-');
  await unparkScan(goodQueueDir, journalRoot, { ...config, queueDir: goodQueueDir }, deps);

  const queued = fs.readdirSync(goodQueueDir).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1);
  journal = readJournal(taskDir);
  assert.equal(journal.filter((e) => e.event === 'unparked-by-maintainer').length, 1);

  // A THIRD cycle: state.json is still (in this fixture) PARKED, but findParkAnchor now sees the
  // marker after the anchor, so alreadyHandled is true and nothing new happens.
  const beforeCount = journal.length;
  await unparkScan(goodQueueDir, journalRoot, { ...config, queueDir: goodQueueDir }, deps);
  const after = readJournal(taskDir);
  assert.equal(after.length, beforeCount, 'idempotent: a third cycle appends nothing');
});

// ============================================================================================
// ---- ineligible `continue`: refusal ack + unpark-verb-refused, never a fallback to retry ------
// ============================================================================================

test('unparkScan: continue on a non-resumable reason acks a refusal, journals unpark-verb-refused {why: "not-resumable"}, no queue entry, no unparked-by-maintainer', async () => {
  const queueDir = mkTmp('spo-continue-notresumable-queue-');
  const journalRoot = mkTmp('spo-continue-notresumable-journal-');
  const config = testConfig();
  const id = 'card-cont-notresumable';
  assert.ok(!RESUMABLE_PARK_REASONS.has('plan-invalid'));
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 603, commentId: 300, reason: 'plan-invalid', prNumber: 800 });

  let ackBody = null;
  const deps = collabDeps([{ id: 310, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }]);
  const origSpawn = deps.spawnSync;
  deps.spawnSync = (command, args, ...rest) => {
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
      const bodyFile = args[args.indexOf('--body-file') + 1];
      ackBody = fs.readFileSync(bodyFile, 'utf8');
    }
    return origSpawn(command, args, ...rest);
  };

  await unparkScan(queueDir, journalRoot, config, deps);

  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0);
  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'unparked-by-maintainer'));
  const refused = journal.find((e) => e.event === 'unpark-verb-refused');
  assert.ok(refused);
  assert.equal(refused.verb, 'continue');
  assert.equal(refused.reason, 'plan-invalid');
  assert.equal(refused.why, 'not-resumable');
  assert.equal(refused.commentId, 310);
  assert.equal(refused.ackExit, 0);
  assert.ok(ackBody.startsWith('pipeline:'), 'the ack must start with "pipeline:" so it can never itself match a verb');

  // NEXT cycle: findParkAnchor now anchors on the refusal -- no second ack, no second event.
  const before = readJournal(taskDir).length;
  await unparkScan(queueDir, journalRoot, config, deps);
  assert.equal(readJournal(taskDir).length, before, 'no second ack, no second unpark-verb-refused');
});

test('unparkScan: continue with no prNumber recorded refuses {why: "no-pr"}', async () => {
  const queueDir = mkTmp('spo-continue-nopr-queue-');
  const journalRoot = mkTmp('spo-continue-nopr-journal-');
  const config = testConfig();
  const id = 'card-cont-nopr';
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 604, commentId: 400, reason: 'merge-conflict', prNumber: undefined });

  const deps = collabDeps([{ id: 410, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }]);
  await unparkScan(queueDir, journalRoot, config, deps);

  const refused = readJournal(taskDir).find((e) => e.event === 'unpark-verb-refused');
  assert.ok(refused);
  assert.equal(refused.why, 'no-pr');
});

test('unparkScan: continue with prNumber 0 recorded refuses {why: "no-pr"}', async () => {
  const queueDir = mkTmp('spo-continue-pr0-queue-');
  const journalRoot = mkTmp('spo-continue-pr0-journal-');
  const id = 'card-cont-pr0';
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 605, commentId: 400, reason: 'merge-conflict', prNumber: 0 });
  const deps = collabDeps([{ id: 411, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }]);
  await unparkScan(queueDir, journalRoot, testConfig(), deps);
  assert.equal(readJournal(taskDir).find((e) => e.event === 'unpark-verb-refused').why, 'no-pr');
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0);
});

test('unparkScan: continue on an externally-resolved park refuses {why: "externally-resolved"}', async () => {
  const queueDir = mkTmp('spo-continue-extres-queue-');
  const journalRoot = mkTmp('spo-continue-extres-journal-');
  const config = testConfig();
  const id = 'card-cont-extres';
  const taskDir = parkedTaskDir(journalRoot, id, {
    issue: 605,
    commentId: 500,
    reason: 'merge-conflict',
    prNumber: 900,
    externallyResolved: { via: 'issue-closed', closedAt: '2026-09-14T00:00:00Z', prNumber: null, mergedAt: null, at: '2026-09-14T00:00:00Z' },
  });

  const deps = collabDeps([{ id: 510, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }]);
  await unparkScan(queueDir, journalRoot, config, deps);

  const refused = readJournal(taskDir).find((e) => e.event === 'unpark-verb-refused');
  assert.ok(refused);
  assert.equal(refused.why, 'externally-resolved');
});

test('continueEligibility: no config.pipelineWorktreesDir refuses {why: "no-worktrees-dir"}', () => {
  const state = { state: 'PARKED', reason: 'merge-conflict', prNumber: 100 };
  assert.deepEqual(continueEligibility(state, {}), { eligible: false, why: 'no-worktrees-dir' });
  assert.deepEqual(continueEligibility(state, { pipelineWorktreesDir: '' }), { eligible: false, why: 'no-worktrees-dir' });
  assert.equal(continueEligibility(state, { pipelineWorktreesDir: '/x' }).eligible, true);
});

test('unparkScan: the ack gh call failing still journals unpark-verb-refused with ackExit, and still no re-ack next cycle', async () => {
  const queueDir = mkTmp('spo-continue-ackfail-queue-');
  const journalRoot = mkTmp('spo-continue-ackfail-journal-');
  const config = testConfig();
  const id = 'card-cont-ackfail';
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 606, commentId: 600, reason: 'plan-invalid', prNumber: 111 });

  const deps = collabDeps([{ id: 610, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }], {
    onAck: () => ({ status: 1, stdout: '', stderr: 'rate limited', signal: null }),
  });

  await unparkScan(queueDir, journalRoot, config, deps);

  let journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'continue-ack-failed' && e.exit === 1));
  const refused = journal.find((e) => e.event === 'unpark-verb-refused');
  assert.ok(refused);
  assert.equal(refused.ackExit, 1);

  const before = journal.length;
  await unparkScan(queueDir, journalRoot, config, deps);
  assert.equal(readJournal(taskDir).length, before, 'no re-ack attempt next cycle');
});

test('unparkScan: a later "retry" comment after a refused continue still re-enqueues, WITHOUT task.resume', async () => {
  const queueDir = mkTmp('spo-continue-then-retry-queue-');
  const journalRoot = mkTmp('spo-continue-then-retry-journal-');
  const config = testConfig();
  const id = 'card-cont-then-retry';
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 607, commentId: 700, reason: 'plan-invalid', prNumber: 222 });

  const deps = collabDeps([
    { id: 710, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' },
    { id: 711, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:01:00Z', body: 'retry -- fixed it by hand' },
  ]);

  // scanForMatch stops at the FIRST authorized match in ascending id order, so the refused
  // `continue` (710) and the later `retry` (711) are two separate cycles -- exactly the shape a
  // real 60s-cadence unparkScan produces (the maintainer posts one reply, sees the ack, then
  // posts the other). The first cycle refuses and re-anchors on 710; the second then sees 711.
  await unparkScan(queueDir, journalRoot, config, deps);
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0, 'the continue refusal alone never re-enqueues');
  await unparkScan(queueDir, journalRoot, config, deps);
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(queueDir, fs.readdirSync(queueDir)[0]), 'utf8'));
  assert.ok(!('resume' in written), 'a retry after a refused continue must not carry a resume descriptor');

  const journal = readJournal(taskDir);
  const marker = journal.find((e) => e.event === 'unparked-by-maintainer');
  assert.ok(marker);
  assert.equal(marker.retryCommentId, 711);
});

// ============================================================================================
// ---- findParkAnchor: unpark-verb-refused is a new anchor ---------------------------------------
// ============================================================================================

test('findParkAnchor: an unpark-verb-refused event with a numeric commentId becomes the new anchor, like park-comment', () => {
  const lines = [
    { event: 'park-comment', commentId: 100 },
    { event: 'unpark-verb-refused', commentId: 150 },
  ];
  const anchor = findParkAnchor(lines);
  assert.equal(anchor.commentId, 150);
  assert.equal(anchor.alreadyHandled, false);
});

test('findParkAnchor: unpark-verb-refused never sets alreadyHandled by itself -- only unparked/abandoned-by-maintainer do', () => {
  const lines = [
    { event: 'park-comment', commentId: 100 },
    { event: 'unpark-verb-refused', commentId: 150 },
  ];
  assert.equal(findParkAnchor(lines).alreadyHandled, false);
});

// ============================================================================================
// ---- comment matching: "Continue." / "continue please" match; "continued" does not -----------
// ============================================================================================

test('unparkScan: "Continue." and "continue please" both match the continue verb; "continued" does not; "retry" still matches as before', async () => {
  const journalRoot = mkTmp('spo-continue-wording-journal-');
  const config = testConfig();

  async function tryBody(body) {
    const queueDir = mkTmp('spo-continue-wording-queue-');
    const id = `card-wording-${Math.random().toString(36).slice(2)}`;
    const taskDir = parkedTaskDir(journalRoot, id, { issue: 608, commentId: 800, reason: 'merge-conflict', prNumber: 333 });
    const deps = collabDeps([{ id: 810, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body }]);
    await unparkScan(queueDir, journalRoot, config, deps);
    const journal = readJournal(taskDir);
    return journal.some((e) => e.event === 'unparked-by-maintainer');
  }

  assert.equal(await tryBody('Continue.'), true);
  assert.equal(await tryBody('continue please'), true);
  assert.equal(await tryBody('continued'), false, '"continued" must not match -- no word boundary after "continue"');
  assert.equal(await tryBody('retry'), true, 'retry keeps matching exactly as before');
});

// ============================================================================================
// ---- non-collaborator continue is ignored (existing authorization path) -----------------------
// ============================================================================================

test('unparkScan: a "continue" from a non-collaborator is ignored, journalled, and never re-enqueues', async () => {
  const queueDir = mkTmp('spo-continue-noncollab-queue-');
  const journalRoot = mkTmp('spo-continue-noncollab-journal-');
  const config = testConfig();
  const id = 'card-cont-noncollab';
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 609, commentId: 900, reason: 'merge-conflict', prNumber: 444 });

  const deps = collabDeps(
    [{ id: 910, user: { login: 'rando' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }],
    { collaborators: ['Crazz-E'] }
  );

  await unparkScan(queueDir, journalRoot, config, deps);

  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0);
  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'unparked-by-maintainer'));
  assert.ok(!journal.some((e) => e.event === 'unpark-verb-refused'));
  assert.ok(journal.some((e) => e.event === 'unpark-scan-ignored-author'));
});

// ============================================================================================
// ---- reEnqueueTask: a stale task.json `resume` is stripped on every re-enqueue ----------------
// ============================================================================================

test('reEnqueueTask: a task.json carrying a stale `resume` re-enqueues WITHOUT it', () => {
  const queueDir = mkTmp('spo-resume-strip-queue-');
  const taskDir = mkTmp('spo-resume-strip-taskdir-');
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({
      id: 'card-strip',
      kind: 'card',
      issue: 1000,
      resume: { startState: 'CHECK', prNumber: 1, worktreePath: '/x', commentId: 1, fromReason: 'merge-conflict' },
    })
  );

  const file = reEnqueueTask(queueDir, taskDir, 'card-strip', {}, 1234, 'h');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!('resume' in written), 'an ordinary retry must never carry a stale resume forward');
});

test('reEnqueueTask: the continue branch adds `resume` back through `extra`, even though the base strip removes it', () => {
  const queueDir = mkTmp('spo-resume-restore-queue-');
  const taskDir = mkTmp('spo-resume-restore-taskdir-');
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'card-restore', kind: 'card', issue: 1001, resume: { stale: true } })
  );

  const resume = { startState: 'CHECK', prNumber: 2, worktreePath: '/y', commentId: 2, fromReason: 'gate-merge-refused' };
  const file = reEnqueueTask(queueDir, taskDir, 'card-restore', { resume }, 5678, 'h');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.resume, resume);
});

// ============================================================================================
// ---- buildParkComment: the continue line, C5 -----------------------------------------------
// ============================================================================================

test('buildParkComment: a resumable reason renders RETRY_ABANDON_LINE verbatim, immediately followed by the continue line naming claude-pipe/<id>', () => {
  const body = buildParkComment({ reason: 'merge-conflict', detail: {}, lastState: 'MERGE', id: 'card-999', prNumber: 555 });
  const idx = body.indexOf(RETRY_ABANDON_LINE);
  assert.ok(idx >= 0);
  const after = body.slice(idx + RETRY_ABANDON_LINE.length);
  assert.match(after, /^\n(pipeline:.*claude-pipe\/card-999.*"continue".*)\n\n/);
});

test('buildParkComment: resume-precondition-failed gets the "fix what the reason names, reply continue again" phrasing', () => {
  const body = buildParkComment({ reason: 'resume-precondition-failed', detail: {}, lastState: 'CHECK', id: 'card-998', prNumber: 555 });
  assert.match(body, /fix what the reason above names/);
  assert.match(body, /reply "continue" again/);
  assert.match(body, /claude-pipe\/card-998/);
});

test('buildParkComment: a NON-resumable reason renders byte-identical whether or not `id` is passed -- no continue line, ever', () => {
  const withId = buildParkComment({ reason: 'worktree-npm-ci-failed', detail: { exit: 1 }, lastState: 'WORKTREE', id: 'card-997' });
  const withoutId = buildParkComment({ reason: 'worktree-npm-ci-failed', detail: { exit: 1 }, lastState: 'WORKTREE' });
  assert.equal(withId, withoutId);
  assert.ok(!withId.includes('claude-pipe'));
  assert.ok(!withId.includes('"continue"'));
  // Structure unchanged: RETRY_ABANDON_LINE is followed by exactly one blank line, then the
  // tokens line -- the same shape as every pre-C5 park comment.
  const idx = withId.indexOf(RETRY_ABANDON_LINE);
  const after = withId.slice(idx + RETRY_ABANDON_LINE.length);
  assert.match(after, /^\n\n\*\*This card so far:\*\*/);
});

test('buildContinueRefusedAck: every `why` value renders a first line starting "pipeline:" and never suggests continue again', () => {
  for (const why of ['not-resumable', 'no-pr', 'externally-resolved', 'no-worktrees-dir']) {
    const ack = buildContinueRefusedAck('plan-invalid', why);
    assert.ok(ack.startsWith('pipeline:'));
    assert.ok(!/reply "continue"/.test(ack));
    assert.match(ack, /"retry"/);
    assert.match(ack, /"abandon"/);
  }
});

test('buildContinueRefusedAck: each why names its own cause', () => {
  assert.match(buildContinueRefusedAck('merge-conflict', 'no-pr'), /no pull request is recorded/);
  assert.match(buildContinueRefusedAck('plan-invalid', 'not-resumable'), /`plan-invalid` is not a park/);
  assert.match(buildContinueRefusedAck('merge-conflict', 'externally-resolved'), /resolved outside the pipeline/);
  assert.match(buildContinueRefusedAck('merge-conflict', 'no-worktrees-dir'), /no worktrees directory/);
});

// ============================================================================================
// ---- end-to-end (shadow mode): park -> continue -> re-enqueued entry enters at CHECK ----------
// ============================================================================================

test('end-to-end: an eligible continue re-enqueues task.resume, and runTask (shadow mode) on that queue entry enters at CHECK', async () => {
  const queueDir = mkTmp('spo-continue-e2e-queue-');
  const journalRoot = mkTmp('spo-continue-e2e-journal-');
  const config = testConfig();
  const id = 'card-e2e-continue';
  const taskDir = parkedTaskDir(journalRoot, id, { issue: 610, commentId: 1100, reason: 'merge-conflict', prNumber: 1234 });

  const deps = collabDeps([{ id: 1110, user: { login: 'Crazz-E' }, created_at: '2026-09-14T00:00:00Z', body: 'continue' }]);
  await unparkScan(queueDir, journalRoot, config, deps);

  const queued = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(queued.length, 1);
  const requeuedTask = JSON.parse(fs.readFileSync(path.join(queueDir, queued[0]), 'utf8'));
  assert.ok(requeuedTask.resume);

  // The daemon would run this through takeNextTask (renaming the queue file over
  // journal/<id>/task.json) and then runTask; calling runTask directly on the parsed task, in
  // shadow mode, is the same convention test/resume-at-check.test.js uses for its own C1 suite --
  // C2's real-mode prepareResume precondition check is out of scope for a shadow run.
  const e2eTaskDir = mkTmp('spo-continue-e2e-run-');
  const finalState = await runTask(id, requeuedTask, e2eTaskDir, { shadowMode: true, dryRun: false });

  const runJournal = fs
    .readFileSync(path.join(e2eTaskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(runJournal.some((e) => e.event === 'resumed-at-check'));
  assert.ok(!runJournal.some((e) => e.event === 'intake' || e.event === 'worktree'));
  assert.notEqual(finalState, undefined);
});

test('buildParkComment: a resumable reason with no recorded PR renders no continue line (the verb would refuse no-pr)', () => {
  for (const prNumber of [null, undefined, 0]) {
    const body = buildParkComment({ reason: 'resume-precondition-failed', detail: {}, lastState: 'CHECK', id: 'card-996', prNumber });
    assert.ok(!body.includes('"continue"'), `prNumber ${prNumber}: no continue line`);
  }
});
