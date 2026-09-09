'use strict';
// Action (2026-09-09 remediation): a minority of real DIAGNOSE results serialize the model's
// WHOLE reply contract into the `root_cause` field itself, e.g.
//   root_cause: '{"root_cause": "flaky mutation timeout", "category": "flaky", "suggested_fix": "retry"}'
// -- a JSON object, stringified, nested one level inside the field diagnose.md declares as a
// plain sentence. See doc/state-machine-spec.md's DIAGNOSE row for the dated corpus measurement.
// state-machine.js's handleDiagnose now unwraps exactly one level of that shape
// (unwrapNestedDiagnoseContract) before the duplicate guard, the null-cause park, the ledger
// line, or the 'result' journal event ever see the value. This file covers both the exported
// helper directly (every shape verdict) and the end-to-end daemon behaviour the issue actually
// names: the duplicate guard firing on the RECOVERED cause (not the raw wrapper bytes -- see the
// R4 test below, which two differently-serialized wrappers around the same inner cause), an
// object-shaped nested cause being deliberately left un-unwrapped (an object can never `===`
// itself across two structurally-identical-but-distinct replies, which would silently re-defeat
// the very guard this fix restores), an embedded newline in the recovered cause collapsing to one
// ledger line, category/suggestedFix reaching IMPLEMENT with the documented top-level-wins
// precedence, the nested-null shape reaching the SAME park as a direct null, and the ledger
// staying prose. Every assertion below is on a RECOVERED VALUE, not merely "not null" --
// reverting the fix must fail these.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal, readLedger } = require('./helpers');
// Must land before the orchestrator require below -- see test/no-real-spawn.js's own header for
// the incident (140 fabricated live GitHub comments) this killswitch closes, and
// test/no-real-spawn-sweep.test.js for the repo-wide sweep that enforces the ordering.
require('./no-real-spawn');
const { unwrapNestedDiagnoseContract } = require('../orchestrator/state-machine');

const fs = require('fs');
const path = require('path');

function readDaemonJournal(journalDir) {
  const p = path.join(journalDir, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---- (h) unit tests of the exported helper, every shape verdict ---------------------------

test('unwrapNestedDiagnoseContract: a non-string value (number) is flat, passed through unchanged', () => {
  const v = unwrapNestedDiagnoseContract(42);
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'flat');
  assert.equal(v.rootCause, 42);
});

// Arrays and plain objects both fail the FIRST rule ("value is not a string") -- a nested
// contract only ever arrives as a STRING (the model's reply is JSON-encoded text, so a nested
// contract is a string that itself parses to an object), so a non-string root_cause VALUE
// (an array, or an object handed through directly rather than as a JSON string) can never be
// the shape this fix targets; both fall out at the same first guard, before JSON.parse is ever
// reached.
test('unwrapNestedDiagnoseContract: a non-string value (array) is flat, passed through unchanged', () => {
  const v = unwrapNestedDiagnoseContract(['a', 'b']);
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'flat');
  assert.deepEqual(v.rootCause, ['a', 'b']);
});

test('unwrapNestedDiagnoseContract: a non-string value (plain object) is flat, passed through unchanged', () => {
  const v = unwrapNestedDiagnoseContract({ already: 'an object' });
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'flat');
  assert.deepEqual(v.rootCause, { already: 'an object' });
});

test('unwrapNestedDiagnoseContract: ordinary prose is flat', () => {
  const v = unwrapNestedDiagnoseContract('the coverage check regressed on src/foo.ts');
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'flat');
  assert.equal(v.rootCause, 'the coverage check regressed on src/foo.ts');
});

test('unwrapNestedDiagnoseContract: prose that merely starts with "{" but is not valid JSON is unparsable-string, passed through unchanged', () => {
  const v = unwrapNestedDiagnoseContract('{the build cannot find module foo (not json)');
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'unparsable-string');
  assert.equal(v.rootCause, '{the build cannot find module foo (not json)');
});

test('unwrapNestedDiagnoseContract: a JSON object with no root_cause/rootCause key is passed through unchanged', () => {
  const raw = JSON.stringify({ foo: 'bar', category: 'lint' });
  const v = unwrapNestedDiagnoseContract(raw);
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'json-string-no-root-cause');
  assert.equal(v.rootCause, raw);
});

test('unwrapNestedDiagnoseContract: snake_case nested contract unwraps -- rootCause/category/suggestedFix/reason all recovered', () => {
  const raw = JSON.stringify({
    root_cause: 'flaky mutation timeout',
    category: 'flaky',
    suggested_fix: 'retry the drive',
    reason: 'should not be read when root_cause is non-null',
  });
  const v = unwrapNestedDiagnoseContract(raw);
  assert.equal(v.nested, true);
  assert.equal(v.shape, 'nested-contract');
  assert.equal(v.rootCause, 'flaky mutation timeout');
  assert.equal(v.category, 'flaky');
  assert.equal(v.suggestedFix, 'retry the drive');
});

test('unwrapNestedDiagnoseContract: camelCase nested contract unwraps identically to the snake_case one', () => {
  const raw = JSON.stringify({
    rootCause: 'flaky mutation timeout',
    category: 'flaky',
    suggestedFix: 'retry the drive',
  });
  const v = unwrapNestedDiagnoseContract(raw);
  assert.equal(v.nested, true);
  assert.equal(v.shape, 'nested-contract');
  assert.equal(v.rootCause, 'flaky mutation timeout');
  assert.equal(v.category, 'flaky');
  assert.equal(v.suggestedFix, 'retry the drive');
});

test('unwrapNestedDiagnoseContract: nested root_cause: null is reported nested, with the nested reason recovered', () => {
  const raw = JSON.stringify({ root_cause: null, reason: 'same failure as the ledger already has' });
  const v = unwrapNestedDiagnoseContract(raw);
  assert.equal(v.nested, true);
  assert.equal(v.shape, 'nested-contract');
  assert.equal(v.rootCause, null);
  assert.equal(v.reason, 'same failure as the ledger already has');
});

// R2 (verifier D2): an object-shaped nested root_cause must NOT be unwrapped -- diagnose.md
// documents root_cause as a string or null, never an object, and unwrapping an object would hand
// the duplicate guard's Set a value that can never `===`-match a later, structurally-identical
// object, permanently defeating the guard (the opposite of what this whole action restores).
test('unwrapNestedDiagnoseContract: an object-shaped nested root_cause is left un-unwrapped (shape nested-contract-nonscalar), passed through unchanged', () => {
  const raw = JSON.stringify({ root_cause: { detail: 'an object, not a string or null' }, category: 'weird' });
  const v = unwrapNestedDiagnoseContract(raw);
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'nested-contract-nonscalar');
  assert.equal(v.rootCause, raw);
});

test('unwrapNestedDiagnoseContract: a number-shaped nested root_cause is also left un-unwrapped', () => {
  const raw = JSON.stringify({ root_cause: 42 });
  const v = unwrapNestedDiagnoseContract(raw);
  assert.equal(v.nested, false);
  assert.equal(v.shape, 'nested-contract-nonscalar');
  assert.equal(v.rootCause, raw);
});

// R3 (verifier D3): JSON.parse decodes the wire's `\n` escape back into a real newline. Since
// diagnose.md documents root_cause as ONE LINE, the recovered cause is collapsed before being
// handed back, so ledger.md's "one line per attempt" invariant holds for a nested reply exactly
// as it already does for a flat one.
test('unwrapNestedDiagnoseContract: an embedded newline (and other whitespace runs) in the nested cause collapses to a single space', () => {
  const raw = JSON.stringify({ root_cause: 'line one\nline two\n\tindented line three', category: 'multi-line' });
  const v = unwrapNestedDiagnoseContract(raw);
  assert.equal(v.nested, true);
  assert.equal(v.rootCause, 'line one line two indented line three');
});

// ---- end-to-end daemon behaviour ------------------------------------------------------------

test('(a) DUPLICATE GUARD FIRES on a repeated nested contract: PARKED diagnose-duplicate-root-cause, 2 ledger lines, each carrying the prose cause', () => {
  const queueDir = mkTmp('spo-queue-diag-nested-dup-');
  const journalDir = mkTmp('spo-journal-diag-nested-dup-');
  const id = 'diag-nested-dup';
  const nested = JSON.stringify({
    root_cause: 'flaky mutation timeout in FIVEMODELSERVER survival log',
    category: 'flaky',
    suggested_fix: 'retry the gate; watch the FIVEMODELSERVER/Survival log line',
  });

  writeTask(queueDir, '001.json', {
    id,
    title: 'DIAGNOSE replies with its whole contract nested in root_cause, repeated',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1],
      // A scalar shadow fixture repeats on every call -- the SAME nested contract both times.
      llm: { DIAGNOSE: { ok: true, rootCause: nested } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-duplicate-root-cause');

  const events = readJournal(journalDir, id);
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.detail.rootCause, 'flaky mutation timeout in FIVEMODELSERVER survival log');

  const ledgerLines = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 2, 'one ledger line per attempt, including the one that trips the duplicate guard');
  for (const line of ledgerLines) {
    assert.match(line, /flaky mutation timeout in FIVEMODELSERVER survival log/);
  }
});

test('(b) LEDGER STAYS PROSE: no "{" and no "root_cause" substring anywhere in ledger.md for a nested-contract run', () => {
  const queueDir = mkTmp('spo-queue-diag-nested-ledgerprose-');
  const journalDir = mkTmp('spo-journal-diag-nested-ledgerprose-');
  const id = 'diag-nested-ledgerprose';
  const nested = JSON.stringify({
    root_cause: 'ssrf on the untrusted webhook url',
    category: 'security',
    suggested_fix: 'validate the URL host allowlist',
  });

  writeTask(queueDir, '001.json', {
    id,
    title: 'Ledger must stay prose even when DIAGNOSE nests its whole contract',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1],
      llm: { DIAGNOSE: { ok: true, rootCause: nested } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const ledgerText = readLedger(journalDir, id);
  assert.doesNotMatch(ledgerText, /\{/, 'ledger.md must never carry a raw JSON blob');
  assert.doesNotMatch(ledgerText, /root_cause/, 'ledger.md must never carry the wire key name');
  assert.match(ledgerText, /ssrf on the untrusted webhook url/);
});

test('(c) NESTED NULL reaches the SAME park as a direct null: PARKED diagnose-no-new-cause, detail.reason is the NESTED reason, ledger says "(no new cause)", no unspecified-cause-N anywhere', () => {
  const queueDir = mkTmp('spo-queue-diag-nested-null-');
  const journalDir = mkTmp('spo-journal-diag-nested-null-');
  const id = 'diag-nested-null';
  const nested = JSON.stringify({ root_cause: null, reason: 'no distinct cause can be named' });

  writeTask(queueDir, '001.json', {
    id,
    title: 'DIAGNOSE nests {"root_cause": null, ...} -- must still park diagnose-no-new-cause',
    kind: 'synthetic',
    shadow: {
      gate: [1],
      llm: { DIAGNOSE: { ok: true, rootCause: nested } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-no-new-cause');

  const events = readJournal(journalDir, id);
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.detail.reason, 'no distinct cause can be named');

  const ledgerLines = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  assert.equal(ledgerLines[0], 'attempt 1 | (no new cause) | parked (no new cause)');

  const journalText = JSON.stringify(events);
  const ledgerText = readLedger(journalDir, id);
  assert.doesNotMatch(journalText, /unspecified-cause-/);
  assert.doesNotMatch(ledgerText, /unspecified-cause-/);
});

test('(d) CATEGORY / SUGGESTED FIX RECOVERED from the nested contract on the result journal event', () => {
  const queueDir = mkTmp('spo-queue-diag-nested-fields-');
  const journalDir = mkTmp('spo-journal-diag-nested-fields-');
  const id = 'diag-nested-fields';
  const nested = JSON.stringify({
    root_cause: 'untrusted write path never validated',
    category: 'security',
    suggested_fix: 'call path.resolve and check the prefix before writing',
  });

  writeTask(queueDir, '001.json', {
    id,
    title: 'DIAGNOSE nested contract must still surface category/suggestedFix to IMPLEMENT',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { ok: true, rootCause: nested },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const events = readJournal(journalDir, id);
  const diagnoseResults = events.filter((e) => e.state === 'DIAGNOSE' && e.event === 'result');
  assert.equal(diagnoseResults.length, 1);
  assert.equal(diagnoseResults[0].payload.rootCause, 'untrusted write path never validated');
  assert.equal(diagnoseResults[0].payload.category, 'security');
  assert.equal(diagnoseResults[0].payload.suggestedFix, 'call path.resolve and check the prefix before writing');

  const state = readState(journalDir, id);
  assert.equal(state.state, 'DONE');
});

test('(e) THE DETECTION IS JOURNALLED: diagnose-nested-contract carries attempt/shape/recoveredCategory/recoveredSuggestedFix/nestedRootCauseNull', () => {
  const queueDir = mkTmp('spo-queue-diag-nested-event-');
  const journalDir = mkTmp('spo-journal-diag-nested-event-');
  const id = 'diag-nested-event';
  const nested = JSON.stringify({
    root_cause: 'coverage regressed on the changed file',
    category: 'coverage',
    suggested_fix: 'add a test for the new branch',
  });

  writeTask(queueDir, '001.json', {
    id,
    title: 'diagnose-nested-contract event must be journalled with the expected detail',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { ok: true, rootCause: nested },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const events = readJournal(journalDir, id);
  const nestedEvent = events.find((e) => e.state === 'DIAGNOSE' && e.event === 'diagnose-nested-contract');
  assert.ok(nestedEvent, 'expected a diagnose-nested-contract event in journal.jsonl');
  assert.equal(nestedEvent.attempt, 1);
  assert.equal(nestedEvent.shape, 'nested-contract');
  assert.equal(nestedEvent.recoveredCategory, true);
  assert.equal(nestedEvent.recoveredSuggestedFix, true);
  assert.equal(nestedEvent.nestedRootCauseNull, false);

  // Same event, daemon-scoped -- one grep on daemon.jsonl shows cross-card incidence.
  const daemonEvents = readDaemonJournal(journalDir);
  const daemonNested = daemonEvents.find((e) => e.event === 'diagnose-nested-contract');
  assert.ok(daemonNested, 'expected a diagnose-nested-contract event in daemon.jsonl');
  assert.equal(daemonNested.id, id);
  assert.equal(daemonNested.attempt, 1);
  assert.equal(daemonNested.shape, 'nested-contract');
});

test('(f) SNAKE-KEY nested variant unwraps identically to the camel-key one, end to end', () => {
  const queueDir = mkTmp('spo-queue-diag-nested-snake-');
  const journalDir = mkTmp('spo-journal-diag-nested-snake-');
  const id = 'diag-nested-snake';
  // camelCase keys this time, the shape a real `withCamelAliases`-bridged reply would carry.
  const nested = JSON.stringify({
    rootCause: 'the same cause, camelCase wire shape',
    category: 'flaky',
    suggestedFix: 'retry',
  });

  writeTask(queueDir, '001.json', {
    id,
    title: 'camelCase nested contract unwraps the same as snake_case',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { ok: true, rootCause: nested },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const events = readJournal(journalDir, id);
  const diagnoseResult = events.find((e) => e.state === 'DIAGNOSE' && e.event === 'result');
  assert.equal(diagnoseResult.payload.rootCause, 'the same cause, camelCase wire shape');
  assert.equal(diagnoseResult.payload.category, 'flaky');
  assert.equal(diagnoseResult.payload.suggestedFix, 'retry');

  const nestedEvent = events.find((e) => e.state === 'DIAGNOSE' && e.event === 'diagnose-nested-contract');
  assert.ok(nestedEvent);
  assert.equal(nestedEvent.shape, 'nested-contract');
});

// ---- (g) pass-through regressions: must be BYTE-IDENTICAL to pre-fix behaviour ---------------

test('(g-i) an ordinary flat prose cause still retries once and reaches DONE, exactly as before this fix', () => {
  const queueDir = mkTmp('spo-queue-diag-flat-regress-');
  const journalDir = mkTmp('spo-journal-diag-flat-regress-');

  writeTask(queueDir, '001.json', {
    id: 'diag-flat-regress',
    title: 'Flat prose cause regression guard',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { rootCause: 'flaky-timeout' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'diag-flat-regress');
  assert.equal(state.state, 'DONE');
  assert.equal(state.diagnoseAttempts, 1);

  const ledgerLines = readLedger(journalDir, 'diag-flat-regress').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  assert.equal(ledgerLines[0], 'attempt 1 | flaky-timeout | retry');

  const events = readJournal(journalDir, 'diag-flat-regress');
  assert.ok(!events.some((e) => e.event === 'diagnose-nested-contract'), 'no nested-contract event for a flat cause');
});

// F3 (verifier N2b): collapseToOneLine must be confined to the nested branch. Measured base
// behaviour first (a flat multi-line cause was NEVER collapsed before this whole action, and
// nothing in this fix's brief asked to change that): a flat cause with embedded newlines reaches
// ledger.md WITH those newlines intact -- 3 raw text lines for 1 attempt, not 1. Pinning that here
// catches a mutation that widens the collapse to the flat path (56 tests stayed green under that
// exact mutation before this test existed).
test('(g-v) a FLAT multi-line prose cause reaches ledger.md UNCOLLAPSED -- collapseToOneLine must not touch the flat path', () => {
  const queueDir = mkTmp('spo-queue-diag-flat-multiline-');
  const journalDir = mkTmp('spo-journal-diag-flat-multiline-');
  const id = 'diag-flat-multiline';

  writeTask(queueDir, '001.json', {
    id,
    title: 'Flat multi-line cause must not be collapsed -- that is the nested branch only',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1],
      // A scalar shadow fixture repeats verbatim -- this is an ordinary FLAT string (does not
      // start with '{'), never routed through unwrapNestedDiagnoseContract's nested branch.
      llm: { DIAGNOSE: { ok: true, rootCause: 'line one\nline two\nline three' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-duplicate-root-cause');

  const events = readJournal(journalDir, id);
  assert.ok(!events.some((e) => e.event === 'diagnose-nested-contract'), 'no nested-contract event for a flat cause');

  const ledgerText = readLedger(journalDir, id);
  // Measured base behaviour (2026-09-09, this action): the embedded newlines are NOT collapsed --
  // each attempt's ledger line still contains two literal '\n' characters, so `appendLedgerLine`'s
  // own "one line per attempt" convention is (as it always was, pre-fix) broken by a flat
  // multi-line cause -- this fix's collapse is scoped to the nested shape only, not a general fix
  // for that pre-existing flat-path behaviour.
  assert.equal(ledgerText, 'attempt 1 | line one\nline two\nline three | retry\nattempt 2 | line one\nline two\nline three | parked (duplicate root cause)\n');
});

test('(g-ii) prose that merely STARTS WITH "{" but is not valid JSON is used verbatim, no nested event', () => {
  const queueDir = mkTmp('spo-queue-diag-bracelike-');
  const journalDir = mkTmp('spo-journal-diag-bracelike-');
  const id = 'diag-bracelike';
  const braceLike = '{the build cannot resolve module "./missing" (not actually json)';

  writeTask(queueDir, '001.json', {
    id,
    title: 'A brace-leading but unparsable cause must be used verbatim',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { rootCause: braceLike },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const events = readJournal(journalDir, id);
  const diagnoseResult = events.find((e) => e.state === 'DIAGNOSE' && e.event === 'result');
  assert.equal(diagnoseResult.payload.rootCause, braceLike);
  assert.ok(!events.some((e) => e.event === 'diagnose-nested-contract'));

  const ledgerText = readLedger(journalDir, id);
  assert.match(ledgerText, /\{the build cannot resolve module/);
});

test('(g-iii) a JSON string parsing to an object WITHOUT a root_cause key is used verbatim, no nested event', () => {
  const queueDir = mkTmp('spo-queue-diag-jsonnorootcause-');
  const journalDir = mkTmp('spo-journal-diag-jsonnorootcause-');
  const id = 'diag-jsonnorootcause';
  const notTheContract = JSON.stringify({ foo: 'bar', detail: 'some other shape entirely' });

  writeTask(queueDir, '001.json', {
    id,
    title: 'A JSON object not shaped like the DIAGNOSE contract must be used verbatim',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { rootCause: notTheContract },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const events = readJournal(journalDir, id);
  const diagnoseResult = events.find((e) => e.state === 'DIAGNOSE' && e.event === 'result');
  assert.equal(diagnoseResult.payload.rootCause, notTheContract);
  assert.ok(!events.some((e) => e.event === 'diagnose-nested-contract'));
});

// Regression guards mirroring test/diagnose-no-new-cause.test.js's own two DIRECT-null tests --
// unchanged by this action, confirmed still passing right alongside the new nested-null path.
test('(g-iv) regression: a direct (non-nested) root_cause: null still parks diagnose-no-new-cause with no nested event', () => {
  const queueDir = mkTmp('spo-queue-diag-directnull-');
  const journalDir = mkTmp('spo-journal-diag-directnull-');
  const id = 'diag-directnull';

  writeTask(queueDir, '001.json', {
    id,
    title: 'Direct null still parks diagnose-no-new-cause',
    kind: 'synthetic',
    shadow: {
      gate: [1],
      llm: { DIAGNOSE: { ok: true, rootCause: null, reason: 'same failure as the ledger already has' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-no-new-cause');

  const events = readJournal(journalDir, id);
  assert.ok(!events.some((e) => e.event === 'diagnose-nested-contract'));
});

// ---- verifier remediation round (2026-09-09) ---------------------------------------------------

test('(R2) an object-shaped nested cause is used verbatim, base-equivalent duplicate-guard behaviour, no nested event, no [object Object] in the ledger', () => {
  const queueDir = mkTmp('spo-queue-diag-objectcause-');
  const journalDir = mkTmp('spo-journal-diag-objectcause-');
  const id = 'diag-objectcause';
  // A scalar shadow fixture repeats the SAME raw string on every call -- exactly the shape that
  // trips the duplicate guard today (base behaviour), and must keep doing so: unwrapping this
  // object would hand the guard's Set an object instead, which a later structurally-identical
  // reply could never `===`-match, silently DEFEATING the guard instead.
  const raw = JSON.stringify({ root_cause: { detail: 'an object cause, not this fix\'s target shape' }, category: 'weird' });

  writeTask(queueDir, '001.json', {
    id,
    title: 'An object-shaped nested root_cause must not be unwrapped',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1],
      llm: { DIAGNOSE: { ok: true, rootCause: raw } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-duplicate-root-cause', 'the raw string still repeats verbatim, so the guard fires exactly as it would pre-fix');

  const events = readJournal(journalDir, id);
  assert.ok(!events.some((e) => e.event === 'diagnose-nested-contract'), 'an object-shaped nested cause must never emit the nested-contract event');

  const ledgerText = readLedger(journalDir, id);
  assert.doesNotMatch(ledgerText, /\[object Object\]/, 'the raw JSON string is used verbatim, never JS-stringified as an object');
});

test('(R3) a nested cause containing an embedded newline still produces exactly ONE ledger line per attempt', () => {
  const queueDir = mkTmp('spo-queue-diag-newline-');
  const journalDir = mkTmp('spo-journal-diag-newline-');
  const id = 'diag-newline';
  const nested = JSON.stringify({
    root_cause: 'first line of the cause\nsecond line of the cause\nthird line',
    category: 'multi-line',
  });

  writeTask(queueDir, '001.json', {
    id,
    title: 'Embedded newline in the nested cause must collapse to one ledger line',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1],
      llm: { DIAGNOSE: { ok: true, rootCause: nested } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-duplicate-root-cause');

  const ledgerLines = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 2, 'one ledger line per attempt -- an embedded newline must not split one attempt across two lines');
  for (const line of ledgerLines) {
    assert.match(line, /^attempt \d+ \| first line of the cause second line of the cause third line \| /);
  }
});

// R4 (verifier D4, load-bearing): the mutation this pins is keying the duplicate guard on the RAW
// wrapper string instead of the unwrapped cause. Two nested contracts below carry the exact SAME
// inner cause but are serialized differently (reordered keys, and B carries an extra field A does
// not) -- their raw strings differ, so a guard keyed on the raw value would NOT dedupe them at
// attempt 2 and the task would run a third DIAGNOSE attempt (where wrapperA repeats verbatim)
// before parking. Manually verified (see this action's report): temporarily keying
// `ctx.counters.seenRootCauses`/the duplicate check on `rootCauseValue` (the raw, pre-unwrap
// string) instead of the resolved `rootCause` makes this exact test fail -- `state.diagnoseAttempts`
// reads 3, not 2 (`state.reason` is unaffected: it still reads `diagnose-duplicate-root-cause`,
// just one attempt later than it should -- the attempt-count assertion below is what this
// mutation actually trips, not the reason).
test('(R4) duplicate guard keys on the UNWRAPPED cause, not the raw wrapper bytes: two differently-serialized nested contracts sharing one inner cause dedupe at attempt 2', () => {
  const queueDir = mkTmp('spo-queue-diag-rewrapped-dup-');
  const journalDir = mkTmp('spo-journal-diag-rewrapped-dup-');
  const id = 'diag-rewrapped-dup';
  const wrapperA = JSON.stringify({
    root_cause: 'flaky mutation timeout in FIVEMODELSERVER survival log',
    category: 'flaky',
    suggested_fix: 'retry the gate',
  });
  const wrapperB = JSON.stringify({
    suggested_fix: 'retry the gate',
    root_cause: 'flaky mutation timeout in FIVEMODELSERVER survival log',
    category: 'flaky',
    reason: 'an extra field making the outer wrapper string different from A',
  });
  assert.notEqual(wrapperA, wrapperB, 'the two raw wrapper strings must actually differ, or this test proves nothing');

  writeTask(queueDir, '001.json', {
    id,
    title: 'Two differently-wrapped nested contracts sharing one inner cause must still dedupe',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1, 1],
      llm: { DIAGNOSE: [{ ok: true, rootCause: wrapperA }, { ok: true, rootCause: wrapperB }, { ok: true, rootCause: wrapperA }] },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.reason, 'diagnose-duplicate-root-cause');
  // Load-bearing: without this, a mutation that keys the guard on the raw wrapper bytes (which
  // DO differ between A and B) would pass by falling through to a THIRD attempt and budget
  // exhaustion instead -- asserting only `reason` would not catch that, since a third attempt with
  // wrapperA repeating verbatim would ALSO eventually park `diagnose-duplicate-root-cause`, just
  // one attempt too late.
  assert.equal(state.diagnoseAttempts, 2, 'must dedupe at the SECOND attempt (B matches A once unwrapped), never a third');
});

test('(R6) top-level category/suggestedFix win over the nested contract\'s own when both are truthy', () => {
  const queueDir = mkTmp('spo-queue-diag-precedence-');
  const journalDir = mkTmp('spo-journal-diag-precedence-');
  const id = 'diag-precedence';
  const nested = JSON.stringify({
    root_cause: 'nested cause text',
    category: 'nested-category',
    suggested_fix: 'nested fix text',
  });

  writeTask(queueDir, '001.json', {
    id,
    title: 'A truthy top-level category/suggestedFix must win over the nested contract\'s own',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: {
          ok: true,
          rootCause: nested,
          category: 'top-level-category',
          suggestedFix: 'top-level fix text',
        },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const events = readJournal(journalDir, id);
  const diagnoseResult = events.find((e) => e.state === 'DIAGNOSE' && e.event === 'result');
  assert.equal(diagnoseResult.payload.category, 'top-level-category');
  assert.equal(diagnoseResult.payload.suggestedFix, 'top-level fix text');
  // The nested cause is still what feeds rootCause -- precedence is per-field, not all-or-nothing.
  assert.equal(diagnoseResult.payload.rootCause, 'nested cause text');
});
