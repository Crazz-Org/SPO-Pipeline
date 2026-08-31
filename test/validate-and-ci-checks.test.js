'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal, readLedger } = require('./helpers');

test('VALIDATE REJECT x3 -> PARKED on its own budget (separate from DIAGNOSE), still journals reasons to the ledger every attempt (action 1.6)', () => {
  const queueDir = mkTmp('spo-queue-validate-');
  const journalDir = mkTmp('spo-journal-validate-');

  writeTask(queueDir, '001.json', {
    id: 'validate-reject-budget',
    title: 'Validator rejects three times',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0, 0],
      llm: {
        VALIDATE: [
          { verdict: 'REJECT', reasons: ['criterion not met: first pass'] },
          { verdict: 'REJECT', reasons: ['criterion not met: second pass'] },
          { verdict: 'REJECT', reasons: ['criterion not met: third pass'] },
        ],
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'validate-reject-budget');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'validate-reject-budget-exhausted');
  assert.equal(state.validateRejects, 3);
  assert.equal(state.diagnoseAttempts, 0); // REJECT retries straight to IMPLEMENT, no DIAGNOSE

  // action 1.6: the reject budget/park behaviour above is unchanged; this is the new part --
  // one ledger line per REJECT, distinct `validate-reject` kind (never confused with a DIAGNOSE
  // "attempt" line), and the last one shows the park outcome.
  const ledgerLines = readLedger(journalDir, 'validate-reject-budget').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 3);
  assert.equal(ledgerLines[0], 'validate-reject 1 | criterion not met: first pass | retry (validate reject)');
  assert.equal(ledgerLines[1], 'validate-reject 2 | criterion not met: second pass | retry (validate reject)');
  assert.equal(
    ledgerLines[2],
    'validate-reject 3 | criterion not met: third pass | parked (validate-reject-budget-exhausted)'
  );
});

test('VALIDATE REJECT then PASS: exactly one validate-reject ledger line, distinct from any DIAGNOSE line (action 1.6)', () => {
  const queueDir = mkTmp('spo-queue-validate-reject-once-');
  const journalDir = mkTmp('spo-journal-validate-reject-once-');

  writeTask(queueDir, '001.json', {
    id: 'validate-reject-once',
    title: 'Validator rejects once then passes',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      prWait: [0],
      llm: {
        VALIDATE: [
          { verdict: 'REJECT', reasons: ['missing edge-case handling'], findings: [] },
          { verdict: 'PASS' },
        ],
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'validate-reject-once');
  assert.equal(state.state, 'DONE');
  assert.equal(state.validateRejects, 1);

  const ledgerLines = readLedger(journalDir, 'validate-reject-once').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  assert.equal(ledgerLines[0], 'validate-reject 1 | missing edge-case handling | retry (validate reject)');

  const events = readJournal(journalDir, 'validate-reject-once');
  const rejectResult = events.find(
    (e) => e.state === 'VALIDATE' && e.event === 'result' && e.payload && e.payload.reasons
  );
  assert.ok(rejectResult, 'expected a VALIDATE result event carrying the reject payload');
  assert.deepEqual(rejectResult.payload.reasons, ['missing edge-case handling']);
});

// Action 4.3: the fixture is now {check, step} rather than the bare check name 'Coverage of
// changed lines'. Under the bare name this test still reached DONE and still passed -- but by a
// DIAGNOSE detour, so it no longer proved anything at all about the route its own title names.
// Asserting diagnoseAttempts === 0 and ciImplementRetries === 1 is what pins the direct
// CI_CHECKS -> IMPLEMENT retry: nothing else in the assertion set can tell the two routes apart.
test('CI_CHECKS failing step "Coverage of changed lines" -> straight back to IMPLEMENT (no DIAGNOSE), charged one retry, then succeeds', () => {
  const queueDir = mkTmp('spo-queue-cicov-');
  const journalDir = mkTmp('spo-journal-cicov-');

  writeTask(queueDir, '001.json', {
    id: 'ci-coverage',
    title: 'CI coverage check fails once',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      ciChecks: [{ check: 'typecheck + tests', step: 'Coverage of changed lines' }, null],
      prWait: [0],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-coverage');
  assert.equal(state.state, 'DONE');
  assert.equal(state.diagnoseAttempts, 0, 'the coverage retry goes straight to IMPLEMENT, never via DIAGNOSE');
  assert.equal(state.ciImplementRetries, 1);
  const events = readJournal(journalDir, 'ci-coverage');
  assert.ok(
    events.some(
      (e) =>
        e.state === 'CI_CHECKS' &&
        e.event === 'check-failed' &&
        e.check === 'typecheck + tests' &&
        e.step === 'Coverage of changed lines'
    )
  );
  const retries = events.filter((e) => e.event === 'ci-implement-retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].step, 'Coverage of changed lines');
});

// Action 4.3: the park route survives, but the fixture that reaches it changed shape. A failing
// CHECK name never parks (see ci-cause-table.js's header -- 'PR rules' was never a check name);
// what parks is the failing STEP, which the real path recovers via `gh api
// .../actions/jobs/<id>` and which the shadow fixture now supplies directly as {check, step}.
// This is the ONLY end-to-end (daemon, state.json, report) coverage of the
// `pr-rules-needs-approval` route -- the route is real production behaviour, so dropping it to a
// unit-level classifyCiFailure assertion would have been a regression, not a simplification.
test('CI_CHECKS failing step "PR rules (coverage ratchet, RDO citation)" -> PARKED', () => {
  const queueDir = mkTmp('spo-queue-ciprrules-');
  const journalDir = mkTmp('spo-journal-ciprrules-');

  writeTask(queueDir, '001.json', {
    id: 'ci-pr-rules',
    title: 'CI PR rules check fails',
    kind: 'synthetic',
    shadow: {
      gate: [0],
      ciChecks: [{ check: 'typecheck + tests', step: 'PR rules (coverage ratchet, RDO citation)' }],
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-pr-rules');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'pr-rules-needs-approval');
  assert.equal(state.ciImplementRetries, 0); // a park is not a retry -- the budget is untouched
  const events = readJournal(journalDir, 'ci-pr-rules');
  assert.ok(
    events.some(
      (e) =>
        e.state === 'CI_CHECKS' &&
        e.event === 'check-failed' &&
        e.check === 'typecheck + tests' &&
        e.step === 'PR rules (coverage ratchet, RDO citation)'
    )
  );
  // The park detail must be the SAME {check, step} shape the real path emits
  // (steps/scripted.js's realCiChecks): it is what the maintainer's park comment shows, and
  // park-loop.js's countRepeatedParks fingerprints on JSON.stringify(detail), so a shape that
  // drifts between the two paths stops a repeated park being recognised as repeated.
  const parked = events.find((e) => e.event === 'parked');
  assert.deepEqual(parked.detail, {
    check: 'typecheck + tests',
    step: 'PR rules (coverage ratchet, RDO citation)',
  });
});

// The legacy string fixture shape (a bare check name, no step) is what the real path degrades to
// whenever the job lookup cannot resolve a step -- and it must route to DIAGNOSE for EVERY check
// name, including the audit's own truncated 'PR rules', which is not the park-worthy step name.
test('CI_CHECKS "PR rules" as a bare check-name fixture (no step info) -> DIAGNOSE, never PARKED', () => {
  const queueDir = mkTmp('spo-queue-ciprrules-nostep-');
  const journalDir = mkTmp('spo-journal-ciprrules-nostep-');

  writeTask(queueDir, '001.json', {
    id: 'ci-pr-rules-nostep',
    title: 'CI PR rules check fails, no step recovered',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      ciChecks: ['PR rules', null],
      prWait: [0],
      llm: {
        DIAGNOSE: { rootCause: 'pr-rules-check-failed' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-pr-rules-nostep');
  assert.equal(state.state, 'DONE');
  assert.equal(state.diagnoseAttempts, 1);
  assert.equal(state.ciImplementRetries, 0);
  const events = readJournal(journalDir, 'ci-pr-rules-nostep');
  assert.ok(events.some((e) => e.state === 'CI_CHECKS' && e.event === 'check-failed' && e.check === 'PR rules'));
});

// End-to-end coverage of the retry budget against the REAL config.js default (ciRetryBudget: 3),
// not a test-local override: the daemon subprocess reads orchestrator/config.js like production
// does. Nothing else in the suite pins that default, so without this test the shipped value could
// be changed to anything at all and every assertion would still pass.
test('CI_CHECKS -> IMPLEMENT that never clears burns config.js\'s ciRetryBudget and PARKS ci-retry-budget-exhausted, one ledger line per attempt', () => {
  const queueDir = mkTmp('spo-queue-cibudget-');
  const journalDir = mkTmp('spo-journal-cibudget-');

  writeTask(queueDir, '001.json', {
    id: 'ci-retry-budget',
    title: 'CI lint failure IMPLEMENT can never fix',
    kind: 'synthetic',
    // Single-element fixture arrays repeat their last element forever (orchestrator/fixture.js),
    // so this is a lint failure that comes back identical on every CI_CHECKS visit -- exactly the
    // free, unlogged CI_CHECKS <-> IMPLEMENT bounce the budget exists to bound.
    shadow: {
      gate: [0],
      ciChecks: [{ check: 'typecheck + tests', step: 'Lint' }],
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-retry-budget');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'ci-retry-budget-exhausted');
  assert.equal(state.ciImplementRetries, 4); // 3 allowed retries + the one that trips the budget
  assert.equal(state.diagnoseAttempts, 0); // a CI retry is not a DIAGNOSE attempt

  const retries = readJournal(journalDir, 'ci-retry-budget').filter(
    (e) => e.state === 'CI_CHECKS' && e.event === 'ci-implement-retry'
  );
  assert.deepEqual(
    retries.map((e) => e.attempt),
    [1, 2, 3, 4],
    'the attempt that trips the budget still gets its ledger line, exactly as diagnoseAttempts does'
  );
  for (const e of retries) {
    assert.equal(e.check, 'typecheck + tests');
    assert.equal(e.step, 'Lint');
  }
});

test('CI_CHECKS "Something-unknown" -> DIAGNOSE, then retried to DONE', () => {
  const queueDir = mkTmp('spo-queue-ciunknown-');
  const journalDir = mkTmp('spo-journal-ciunknown-');

  writeTask(queueDir, '001.json', {
    id: 'ci-unknown-check',
    title: 'CI unrecognized check fails',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      ciChecks: ['Something-unknown', null],
      prWait: [0],
      llm: {
        DIAGNOSE: { rootCause: 'unknown-ci-check' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-unknown-check');
  assert.equal(state.state, 'DONE');
  const ledgerLines = readLedger(journalDir, 'ci-unknown-check').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
});
