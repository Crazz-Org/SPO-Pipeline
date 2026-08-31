'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal } = require('./helpers');

test('step deadline expiry: retry once, then PARKED', () => {
  const queueDir = mkTmp('spo-queue-deadline-');
  const journalDir = mkTmp('spo-journal-deadline-');

  writeTask(queueDir, '001.json', {
    id: 'deadline-exceeded',
    title: 'IMPLEMENT is artificially slow',
    kind: 'synthetic',
    shadow: {
      delays: { IMPLEMENT: 80 }, // ms, always slower than the 15ms deadline below
    },
  });

  runDaemonOnce(queueDir, journalDir, ['--deadline-ms', '15']);

  const state = readState(journalDir, 'deadline-exceeded');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'step-deadline-exceeded-twice');

  const events = readJournal(journalDir, 'deadline-exceeded');
  const expired = events.filter((e) => e.state === 'IMPLEMENT' && e.event === 'deadline-exceeded');
  assert.equal(expired.length, 2); // spawn once, retry once, never a third live executor
  assert.equal(expired[0].attempt, 1);
  assert.equal(expired[1].attempt, 2);
});

test('unknown fixture-injected state -> PARKED via the catch-all', () => {
  const queueDir = mkTmp('spo-queue-badstate-');
  const journalDir = mkTmp('spo-journal-badstate-');

  writeTask(queueDir, '001.json', {
    id: 'bad-state',
    title: 'fixture injects a bogus state',
    kind: 'synthetic',
    shadow: { forceState: 'NONSENSE_STATE' },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'bad-state');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'unrecognized-state');
  assert.equal(state.lastState, 'NONSENSE_STATE');
});

// The invariant that binds action 1.7's bounded in-flight wait to the deadline machinery:
// CI_CHECKS sleeps ON PURPOSE inside its own invocation, so its deadline must exceed the poll
// budget it is allowed to spend. When it did not (the generic 120s ceiling against a 30x20s =
// 600s bound), the deadline fired mid-wait, the card parked step-deadline-exceeded-twice instead
// of the ci-checks-still-running the action requires, and -- because withTimeout abandons the
// loser rather than cancelling it -- the overrun invocation kept polling `gh api` and could
// still reach the main-moved `git merge origin/main` in the worktree of an already-parked card.
// config.js derives the CI_CHECKS ceiling from the poll budget so the two cannot drift apart;
// this pins that they never do.
test('CI_CHECKS deadline covers its own bounded in-flight poll budget, so 1.7 parks on its own reason', () => {
  const config = require('../orchestrator/config.js');
  const { deadlineMsFor } = require('../orchestrator/deadline.js');

  const pollBudgetMs = config.ciChecksMaxPolls * config.ciChecksPollIntervalMs;
  const ciDeadline = deadlineMsFor(config, 'CI_CHECKS');

  assert.ok(
    ciDeadline > pollBudgetMs,
    `CI_CHECKS deadline (${ciDeadline}ms) must exceed its poll budget (${pollBudgetMs}ms), ` +
      'else the in-flight wait parks step-deadline-exceeded-twice and leaks a ghost invocation'
  );

  // Every other state keeps the generic ceiling -- the override is deliberately narrow.
  for (const state of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE', 'GATE', 'CHECK', 'PUSH_PR', 'MERGE']) {
    assert.equal(deadlineMsFor(config, state), config.stepDeadlineMs, `${state} must keep stepDeadlineMs`);
  }

  // A config with no per-state map at all (every hand-built test ctx in this suite) still works.
  assert.equal(deadlineMsFor({ stepDeadlineMs: 30000 }, 'CI_CHECKS'), 30000);
});
