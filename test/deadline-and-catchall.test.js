'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below (this
// file's own orchestrator requires are inline, inside a single test body further down).
require('./no-real-spawn');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal } = require('./helpers');

test('step deadline expiry: retry once, then PARKED', () => {
  const queueDir = mkTmp('spo-queue-deadline-');
  const journalDir = mkTmp('spo-journal-deadline-');

  writeTask(queueDir, '001.json', {
    id: 'deadline-exceeded',
    title: 'CHECK is artificially slow',
    kind: 'synthetic',
    shadow: {
      // CHECK, not IMPLEMENT (action A2, card #239, 2026-09-17): IMPLEMENT (and the other four LLM
      // steps) now carry their own stepDeadlineMsByState entry, derived at config.js's module-load
      // time from step-contracts.js's deadlineMsForStep -- NOT from daemon.js's --deadline-ms flag
      // below, which only ever patched the GENERIC config.stepDeadlineMs (the same pre-existing gap
      // WORKTREE/FINISH/GATE/CI_CHECKS's own per-state overrides already had -- see daemon.js's own
      // `stepDeadlineMs: opts.deadlineMs || defaultConfig.stepDeadlineMs,`). So the fixed 80ms delay
      // below no longer exceeds IMPLEMENT's own ~1,920,000ms deadline, and this test's whole premise
      // ("80ms > the deadline") silently stopped holding for that state. CHECK is a scripted step
      // with no stepDeadlineMsByState entry of its own, so it is still governed by the generic
      // stepDeadlineMs --deadline-ms actually reaches, the same property IMPLEMENT offered before A2.
      // forceState skips straight to CHECK so this test does not also depend on WORKTREE/PLAN/
      // IMPLEMENT's own shadow defaults succeeding first (same convention the sibling
      // "unknown fixture-injected state" test right below already uses).
      forceState: 'CHECK',
      // ms, always slower than the 15ms deadline below. Lowercase 'check': CHECK's own shadow
      // fixtureKey (state-machine.js's handleCheck -> runScripted(ctx, 'check', {...})).
      delays: { check: 80 },
    },
  });

  runDaemonOnce(queueDir, journalDir, ['--deadline-ms', '15']);

  const state = readState(journalDir, 'deadline-exceeded');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'step-deadline-exceeded-twice');

  const events = readJournal(journalDir, 'deadline-exceeded');
  const expired = events.filter((e) => e.state === 'CHECK' && e.event === 'deadline-exceeded');
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

  // Every other state keeps the generic ceiling -- the override is deliberately narrow. GATE is
  // no longer in this list (card #211): it now carries its own derived entry, asserted separately
  // below, for the identical reason CI_CHECKS has one -- its exit-3/WORKER-DIED recovery wait
  // (`recoverFromGateWorkerDied`) sleeps ON PURPOSE inside its own invocation, the first genuine
  // `await` realGate ever places there. See doc/state-machine-spec.md's GATE row for the account.
  // PLAN/IMPLEMENT/DIAGNOSE/CITATION_VERIFIER/VALIDATE are ALSO no longer in this list, for the
  // same reason (action A2, card #239, 2026-09-17) -- see test/llm-step-deadlines.test.js for
  // their own dedicated deadlines.
  for (const state of ['CHECK', 'PUSH_PR', 'MERGE']) {
    assert.equal(deadlineMsFor(config, state), config.stepDeadlineMs, `${state} must keep stepDeadlineMs`);
  }

  // GATE's own bound must exceed a full npm-gate spawn PLUS the whole recovery wait, the same
  // "poll budget plus margin" shape CI_CHECKS' own assertion above checks.
  const gateBoundMs = config.commandTimeoutsMs['npm-gate'] + config.gateDiedRecoveryMaxMs;
  const gateDeadline = deadlineMsFor(config, 'GATE');
  assert.ok(
    gateDeadline > gateBoundMs,
    `GATE deadline (${gateDeadline}ms) must exceed npm-gate's own timeout plus the recovery wait (${gateBoundMs}ms), ` +
      'else a real recovery yield parks step-deadline-exceeded-twice and re-runs npm run gate from scratch'
  );

  // A config with no per-state map at all (every hand-built test ctx in this suite) still works.
  assert.equal(deadlineMsFor({ stepDeadlineMs: 30000 }, 'CI_CHECKS'), 30000);
});
