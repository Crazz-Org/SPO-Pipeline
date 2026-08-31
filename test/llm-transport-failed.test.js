'use strict';
// Action 1.4 -- route transport failures to a park, never to DIAGNOSE (or another handler's own
// generic "the model answered badly" park). A step result shaped {ok: false, kind: 'error'} or
// {ok: false, timedOut: true} means the call never produced a verdict at all -- the transport
// failed (spawn error, non-JSON output, missing required key, E2BIG, or a deadline kill). Before
// this fix, handlePlan/handleImplement/handleValidate/handleDiagnose all blamed the model for an
// answer it never gave: IMPLEMENT sent a transport failure to DIAGNOSE (issue-452: three Fable
// diagnoses, $1.75, to diagnose a $0 E2BIG spawn failure), PLAN parked plan-invalid, VALIDATE's
// change-validator fell through to validate-unrecognized-verdict, and DIAGNOSE fabricated a
// root cause (see test/diagnose-no-new-cause.test.js for that half, action 1.5).
//
// Regression guards at the bottom confirm every genuinely-model-produced-a-bad-answer path this
// change must NOT touch still behaves exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal, readLedger } = require('./helpers');

for (const [label, failureShape] of [
  ['transport error', { ok: false, kind: 'error', error: 'llm.js: failed to spawn claude: ENOENT' }],
  ['deadline timeout', { ok: false, timedOut: true, error: 'llm.js: claude ran but exceeded the deadline and was killed' }],
]) {
  test(`PLAN ${label} -> PARKED llm-transport-failed:PLAN (not plan-invalid)`, () => {
    const queueDir = mkTmp('spo-queue-plan-transport-');
    const journalDir = mkTmp('spo-journal-plan-transport-');

    writeTask(queueDir, '001.json', {
      id: `plan-transport-${label.replace(/\s+/g, '-')}`,
      title: `PLAN ${label}`,
      kind: 'synthetic',
      shadow: { llm: { PLAN: failureShape } },
    });

    runDaemonOnce(queueDir, journalDir);

    const id = `plan-transport-${label.replace(/\s+/g, '-')}`;
    const state = readState(journalDir, id);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, 'llm-transport-failed:PLAN');

    const events = readJournal(journalDir, id);
    const parked = events.find((e) => e.event === 'parked');
    assert.equal(parked.detail.kind, failureShape.kind);
    assert.equal(parked.detail.timedOut, failureShape.timedOut);
    assert.equal(parked.detail.error, failureShape.error);
  });
}

for (const [label, failureShape] of [
  ['transport error', { ok: false, kind: 'error', error: 'llm.js: failed to spawn claude: ENOENT' }],
  ['deadline timeout', { ok: false, timedOut: true, error: 'llm.js: claude ran but exceeded the deadline and was killed' }],
]) {
  test(`IMPLEMENT ${label} -> PARKED llm-transport-failed:IMPLEMENT, DIAGNOSE never runs (the $1.75 regression)`, () => {
    const queueDir = mkTmp('spo-queue-implement-transport-');
    const journalDir = mkTmp('spo-journal-implement-transport-');
    const id = `implement-transport-${label.replace(/\s+/g, '-')}`;

    writeTask(queueDir, '001.json', {
      id,
      title: `IMPLEMENT ${label}`,
      kind: 'synthetic',
      shadow: { llm: { IMPLEMENT: failureShape } },
    });

    runDaemonOnce(queueDir, journalDir);

    const state = readState(journalDir, id);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, 'llm-transport-failed:IMPLEMENT');

    const events = readJournal(journalDir, id);
    assert.ok(
      !events.some((e) => e.state === 'DIAGNOSE'),
      'DIAGNOSE must never run for an IMPLEMENT transport failure -- this is the $1.75 regression'
    );
    assert.equal(state.diagnoseAttempts, 0);
  });
}

test('VALIDATE change-validator transport error ({ok:false, kind:"error"}) -> PARKED llm-transport-failed:VALIDATE (not validate-unrecognized-verdict)', () => {
  const queueDir = mkTmp('spo-queue-validate-transport-');
  const journalDir = mkTmp('spo-journal-validate-transport-');
  const id = 'validate-transport-error';

  writeTask(queueDir, '001.json', {
    id,
    title: 'VALIDATE change-validator transport error',
    kind: 'synthetic',
    touchesRdoMembers: false,
    shadow: {
      gate: [0],
      llm: { VALIDATE: { ok: false, kind: 'error', error: 'llm.js: VALIDATE reply was not valid JSON' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'llm-transport-failed:VALIDATE');
  assert.notEqual(state.reason, 'validate-unrecognized-verdict');
});

test('DIAGNOSE transport error ({ok:false, kind:"error"}) -> PARKED llm-transport-failed:DIAGNOSE, no fabricated unspecified-cause-N ledger line', () => {
  const queueDir = mkTmp('spo-queue-diagnose-transport-');
  const journalDir = mkTmp('spo-journal-diagnose-transport-');
  const id = 'diagnose-transport-error';

  writeTask(queueDir, '001.json', {
    id,
    title: 'DIAGNOSE transport error',
    kind: 'synthetic',
    shadow: {
      gate: [1],
      llm: { DIAGNOSE: { ok: false, kind: 'error', error: 'llm.js: failed to spawn claude: ENOENT' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'llm-transport-failed:DIAGNOSE');
  assert.equal(state.diagnoseAttempts, 0, 'a transport failure must not be counted as an attempt');

  const ledger = readLedger(journalDir, id);
  assert.doesNotMatch(ledger, /unspecified-cause-/);

  const events = readJournal(journalDir, id);
  assert.ok(!events.some((e) => e.event === 'result' && e.state === 'DIAGNOSE'), 'no DIAGNOSE result event either');
  const journalText = JSON.stringify(events);
  assert.doesNotMatch(journalText, /unspecified-cause-/);
});

// ---- regression guards: paths this change must NOT touch ----------------------------------

test('regression: a genuinely invalid plan (ok:true, empty fields) still parks plan-invalid', () => {
  const queueDir = mkTmp('spo-queue-plan-stillinvalid-');
  const journalDir = mkTmp('spo-journal-plan-stillinvalid-');
  const id = 'plan-still-invalid';

  writeTask(queueDir, '001.json', {
    id,
    title: 'Plan invalid, not a transport failure',
    kind: 'synthetic',
    issue: 999,
    shadow: { llm: { PLAN: { ok: true, plan_markdown: '', invariants_markdown: '' } } },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'plan-invalid');
});

test('regression: an unrecognized VALIDATE verdict still parks validate-unrecognized-verdict', () => {
  const queueDir = mkTmp('spo-queue-validate-stillunrec-');
  const journalDir = mkTmp('spo-journal-validate-stillunrec-');
  const id = 'validate-still-unrecognized';

  writeTask(queueDir, '001.json', {
    id,
    title: 'VALIDATE unrecognized verdict, not a transport failure',
    kind: 'synthetic',
    touchesRdoMembers: false,
    shadow: {
      gate: [0],
      llm: { VALIDATE: { ok: true, verdict: 'SOMETHING_ELSE' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'validate-unrecognized-verdict');
});

// kind:'limit' is the account-rotation path, NOT a transport failure: callLlmStep retries across
// accounts and only throws all-accounts-cooling-after-retry when they are exhausted, so in real
// mode a limit result never reaches a handler at all. The guards above exclude it by construction
// -- they test `kind === 'error'`, never `kind !== 'limit'` -- but nothing pinned that, and
// widening any of the four to a bare `ok === false` would silently turn a rate limit into a
// terminal park instead of a rotation. Shadow mode skips the rotation loop, which is what lets
// this test hand a limit shape straight to the handler.
test('regression: a kind:"limit" result is NOT a transport failure -- IMPLEMENT still routes it to DIAGNOSE, never llm-transport-failed', () => {
  const queueDir = mkTmp('spo-queue-implement-limit-');
  const journalDir = mkTmp('spo-journal-implement-limit-');
  const id = 'implement-limit-not-transport';

  writeTask(queueDir, '001.json', {
    id,
    title: 'Rate limit is not a transport failure',
    kind: 'synthetic',
    issue: 998,
    shadow: {
      llm: {
        IMPLEMENT: { ok: false, kind: 'limit' },
        DIAGNOSE: { ok: true, rootCause: 'rate limited, retrying' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const events = readJournal(journalDir, id);
  assert.ok(
    events.some((e) => e.state === 'DIAGNOSE'),
    'a limit result must still reach DIAGNOSE, the pre-existing behaviour'
  );

  const state = readState(journalDir, id);
  assert.notEqual(state.reason, 'llm-transport-failed:IMPLEMENT');
});
