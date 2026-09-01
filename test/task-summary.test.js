'use strict';
// Tests for orchestrator/task-summary.js -- action 5.2's shared "read one task's own journal,
// reduce it to the numbers a human-facing comment needs" module (summarizeTask), plus its two
// pure render helpers (formatAttemptLines, formatDuration). steps/scripted.js's finalComment (the
// Done comment) and park-loop.js's postParkComment (the park comment) are the two real callers;
// this file tests the reduction directly, on hand-built journal.jsonl fixtures, so the numbers
// are pinned independently of either comment's exact wording.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and why this require has to land
// before the orchestrator require(s) below (test/no-real-spawn-sweep.test.js enforces the order).
require('./no-real-spawn');
const { summarizeTask, readJournalLines, formatAttemptLines, formatDuration } = require('../orchestrator/task-summary');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedJournal(taskDir, lines) {
  fs.writeFileSync(path.join(taskDir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// ---- summarizeTask: billable tokens ------------------------------------------------------------

test('summarizeTask: sums billableTokens across every llm-call event, hasTokenData true', () => {
  const taskDir = mkTmp('spo-tasksummary-tokens-');
  seedJournal(taskDir, [
    { ts: '2026-08-31T00:00:00.000Z', state: 'PLAN', event: 'llm-call', billableTokens: 1000 },
    { ts: '2026-08-31T00:01:00.000Z', state: 'IMPLEMENT', event: 'llm-call', billableTokens: 2500 },
  ]);

  const summary = summarizeTask(taskDir);
  assert.equal(summary.billableTokens, 3500);
  assert.equal(summary.hasTokenData, true);
});

test('summarizeTask: a park stays open across the scan noise it generates -- parkedMs is real waiting time, not four seconds', () => {
  // The measured trap, and the reason parkedMs closes on `state !== "PARKED"` rather than on the
  // next event of any kind. A park is followed immediately by park-alert / board-move /
  // park-comment, and then by one unpark-scan line every 60 seconds for as long as it lasts (238
  // of them on issue-213 alone). Closing on "the next event" therefore reported 0m04s of waiting
  // on a card that waited two days: run over the real corpus that rule gave issue-213 0m04s,
  // where the correct answer is 47h38m03s out of 48h44m49s elapsed.
  const taskDir = mkTmp('spo-tasksummary-parked-span-');
  seedJournal(taskDir, [
    { ts: '2026-08-29T21:00:00.000Z', state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
    { ts: '2026-08-29T21:08:00.000Z', state: 'CHECK', event: 'parked', reason: 'push-pr-failed' },
    { ts: '2026-08-29T21:08:01.000Z', state: 'PARKED', event: 'park-alert', reason: 'push-pr-failed' },
    { ts: '2026-08-29T21:08:02.000Z', state: 'PARKED', event: 'board-move', column: 'Parked' },
    { ts: '2026-08-29T21:08:04.000Z', state: 'PARKED', event: 'park-comment', commentId: 1 },
    { ts: '2026-08-29T22:08:04.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1 },
    { ts: '2026-08-30T21:08:00.000Z', state: 'PARKED', event: 'unparked-by-maintainer', retryCommentId: 2 },
    { ts: '2026-08-30T21:08:00.000Z', state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
  ]);

  const summary = summarizeTask(taskDir);
  assert.equal(summary.parksCount, 1);
  assert.equal(summary.parkedMs, 24 * 60 * 60 * 1000, 'the full day parked, not the 4 seconds to the next line');
  assert.equal(summary.openParkTs, null, 'the park is closed -- the card resumed');
});

test('summarizeTask: a park with nothing after it stays OPEN -- openParkTs is set and parkedMs excludes it', () => {
  // A card parked right now has no closing event, and this module has no clock. It reports where
  // the open park began and leaves closing it to the caller, which knows `now` -- so the two
  // numbers a card renders are always read off one clock instead of two.
  const taskDir = mkTmp('spo-tasksummary-open-park-');
  seedJournal(taskDir, [
    { ts: '2026-08-29T21:00:00.000Z', state: 'CHECK', event: 'parked', reason: 'push-pr-failed' },
    { ts: '2026-08-29T21:00:02.000Z', state: 'PARKED', event: 'park-comment', commentId: 1 },
  ]);
  const summary = summarizeTask(taskDir);
  assert.equal(summary.parkedMs, 0);
  assert.equal(summary.openParkTs, '2026-08-29T21:00:00.000Z');
});

test('summarizeTask: cacheReadTokens is NEVER summed into billableTokens -- that is the metric definition', () => {
  // The one number in this whole action that a plausible "fix" would inflate by an order of
  // magnitude: issue-471 ran 1.5M cache-read against 10.0k fresh input, which is precisely why
  // dollars were retired as the headline unit and why cache-read is reported separately and
  // never summed in (orchestrator/tokens.js's header). A mutant adding it survived the suite
  // before this test existed.
  const taskDir = mkTmp('spo-tasksummary-cacheread-');
  seedJournal(taskDir, [
    {
      ts: '2026-08-31T00:00:00.000Z',
      state: 'PLAN',
      event: 'llm-call',
      tokensSource: 'modelUsage',
      billableTokens: 71505,
      freshInputTokens: 10000,
      cacheReadTokens: 1500000,
      outputTokens: 4000,
    },
  ]);
  assert.equal(summarizeTask(taskDir).billableTokens, 71505);
});

test('summarizeTask: a killed llm-call (tokensSource null, billableTokens 0) is NOT token data', () => {
  // steps/llm.js journals an llm-call for EVERY call including the failed ones, and every failure
  // path returns ...ZERO_TOKENS = {tokensSource: null, billableTokens: 0}. Keying hasTokenData on
  // `typeof billableTokens === 'number'` therefore called a deadline-killed call "token data" and
  // printed `0` on the card -- reading as "this card was free" for a card that burned a whole
  // transport failure, and disagreeing with `spo tokens`, which prints `n/a` for the same journal.
  const taskDir = mkTmp('spo-tasksummary-killed-');
  seedJournal(taskDir, [
    { ts: '2026-08-31T00:00:00.000Z', state: 'PLAN', event: 'llm-call', tokensSource: null, billableTokens: 0, ok: false },
    { ts: '2026-08-31T00:01:00.000Z', state: 'PLAN', event: 'llm-call', tokensSource: null, billableTokens: 0, ok: false },
  ]);
  assert.equal(summarizeTask(taskDir).hasTokenData, false, 'not recorded, never "0"');
});

test('summarizeTask: a genuine zero WITH a tokensSource is still token data -- it renders 0, not "not recorded"', () => {
  const taskDir = mkTmp('spo-tasksummary-genuine-zero-');
  seedJournal(taskDir, [
    { ts: '2026-08-31T00:00:00.000Z', state: 'PLAN', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 0 },
  ]);
  const summary = summarizeTask(taskDir);
  assert.equal(summary.hasTokenData, true);
  assert.equal(summary.billableTokens, 0);
});

test('summarizeTask: no llm-call carries a numeric billableTokens -> hasTokenData false, sum stays 0', () => {
  const taskDir = mkTmp('spo-tasksummary-no-tokens-');
  seedJournal(taskDir, [
    { ts: '2026-08-31T00:00:00.000Z', state: 'PLAN', event: 'llm-call', costUsd: 1.23, numTurns: 4 },
  ]);

  const summary = summarizeTask(taskDir);
  assert.equal(summary.billableTokens, 0);
  assert.equal(summary.hasTokenData, false, 'costUsd-only events must never look like token data');
});

test('summarizeTask: a single llm-call with a genuine billableTokens: 0 -> hasTokenData true, sum 0', () => {
  const taskDir = mkTmp('spo-tasksummary-genuine-zero-');
  seedJournal(taskDir, [{ ts: '2026-08-31T00:00:00.000Z', state: 'PLAN', event: 'llm-call', billableTokens: 0 }]);

  const summary = summarizeTask(taskDir);
  assert.equal(summary.billableTokens, 0);
  assert.equal(summary.hasTokenData, true, 'a recorded zero is still recorded -- distinct from no data at all');
});

// ---- summarizeTask: attempt counts + park count, cumulative -------------------------------------

test('summarizeTask: a VALIDATE `result` event with NO change-validator verdict counts zero rejects -- the dead rule that found nothing in 19 real journals', () => {
  // Regression pin for a bug the hermetic suite could not see. The first implementation counted
  // `state: 'VALIDATE', event: 'result'`, which action 1.6 does append on a REJECT -- so every
  // fixture built that way passed. Run against the real corpus it returned 0 for all 19 tasks,
  // issue-428 included, whose state.json says validateRejects: 1 and whose journal holds only
  // `change-validator {verdict: "REJECT"}` (the card predates 1.6). Counting the verdict is true
  // of the old journals AND the new ones; counting the 'result' event is true of neither in
  // practice.
  const dir = mkTmp('spo-summary-deadrule-');
  seedJournal(dir, [
    { ts: '2026-08-29T20:42:00.000Z', state: 'VALIDATE', event: 'result', attempt: 1, payload: { reasons: ['x'] } },
    { ts: '2026-08-29T20:43:00.000Z', state: 'VALIDATE', event: 'result', attempt: 2, payload: { reasons: ['y'] } },
  ]);
  assert.equal(summarizeTask(dir).validateRejects, 0);
});

test('summarizeTask: counts DIAGNOSE/VALIDATE result events and ci-implement-retry events cumulatively, across a simulated retry', () => {
  const taskDir = mkTmp('spo-tasksummary-attempts-');
  seedJournal(taskDir, [
    { ts: '2026-08-31T00:00:00.000Z', state: 'DIAGNOSE', event: 'result', attempt: 1, payload: { rootCause: 'a' } },
    { ts: '2026-08-31T00:01:00.000Z', state: 'PARKED', event: 'parked', reason: 'diagnose-duplicate-root-cause', detail: {} },
    // A retry reuses the SAME journal file (park-loop.js's reEnqueueTask never creates a new
    // taskDir) -- attempt numbers restart at 1 for the new run, but the TOTAL count must span
    // both runs.
    { ts: '2026-08-31T01:00:00.000Z', state: 'DIAGNOSE', event: 'result', attempt: 1, payload: { rootCause: 'b' } },
    // The REJECT verdict itself is what counts, NOT handleValidate's own 'result' event: keying
    // on the latter counted zero across all 19 real journals, issue-428 -- the one card ever
    // rejected -- included. The bare 'result' line below is deliberately left in as a decoy, and
    // the assertion at the bottom of this test pins that it contributes nothing.
    { ts: '2026-08-31T01:01:00.000Z', state: 'VALIDATE', event: 'change-validator', verdict: 'REJECT' },
    { ts: '2026-08-31T01:01:01.000Z', state: 'VALIDATE', event: 'result', attempt: 1, payload: { reasons: ['x'] } },
    { ts: '2026-08-31T01:02:00.000Z', state: 'CI_CHECKS', event: 'ci-implement-retry', attempt: 1, check: 'lint' },
    { ts: '2026-08-31T01:03:00.000Z', state: 'PARKED', event: 'parked', reason: 'validate-reject-budget-exhausted', detail: {} },
  ]);

  const summary = summarizeTask(taskDir);
  assert.equal(summary.diagnoseAttempts, 2);
  assert.equal(summary.validateRejects, 1);
  assert.equal(summary.ciImplementRetries, 1);
  assert.equal(summary.parksCount, 2, 'both parks count, not just a repeated-identical streak');
});

test('summarizeTask: a journal predating ci-implement-retry events simply counts 0, not distinguished from "genuinely never happened"', () => {
  const taskDir = mkTmp('spo-tasksummary-pre-4.3-');
  seedJournal(taskDir, [{ ts: '2026-08-31T00:00:00.000Z', state: 'DIAGNOSE', event: 'result', attempt: 1, payload: { rootCause: 'a' } }]);

  const summary = summarizeTask(taskDir);
  assert.equal(summary.ciImplementRetries, 0);
});

// ---- summarizeTask: firstEventTs ----------------------------------------------------------------

test('summarizeTask: firstEventTs is the journal\'s first line, not re-sorted', () => {
  const taskDir = mkTmp('spo-tasksummary-firstts-');
  seedJournal(taskDir, [
    { ts: '2026-08-31T06:21:42.000Z', state: 'WORKTREE', event: 'board-move', column: 'Planning' },
    { ts: '2026-08-31T06:36:54.000Z', state: 'FINISH', event: 'finished', issue: 471 },
  ]);

  const summary = summarizeTask(taskDir);
  assert.equal(summary.firstEventTs, '2026-08-31T06:21:42.000Z');
});

test('summarizeTask: no journal at all -> every count 0/false, firstEventTs null, never throws', () => {
  const taskDir = mkTmp('spo-tasksummary-empty-');
  assert.doesNotThrow(() => summarizeTask(taskDir));
  const summary = summarizeTask(taskDir);
  assert.deepEqual(summary, {
    billableTokens: 0,
    hasTokenData: false,
    diagnoseAttempts: 0,
    validateRejects: 0,
    ciImplementRetries: 0,
    parksCount: 0,
    firstEventTs: null,
    lastEventTs: null,
    parkedMs: 0,
    openParkTs: null,
  });
});

test('summarizeTask: a malformed journal.jsonl (torn lines, garbage) is read defensively -- never throws, salvages what parses', () => {
  const taskDir = mkTmp('spo-tasksummary-malformed-');
  const raw = [
    JSON.stringify({ ts: '2026-08-31T00:00:00.000Z', state: 'PLAN', event: 'llm-call', billableTokens: 100 }),
    '{not json at all',
    '{"ts": "2026-08-31T00:01:00.000Z", "state": "IMPLEMENT", incomplete',
  ].join('\n');
  fs.writeFileSync(path.join(taskDir, 'journal.jsonl'), raw);

  assert.doesNotThrow(() => summarizeTask(taskDir));
  const summary = summarizeTask(taskDir);
  assert.equal(summary.billableTokens, 100, 'the one well-formed line must still be counted');
  assert.equal(summary.hasTokenData, true);
});

test('readJournalLines: skips unparseable lines, keeps parseable ones, in order', () => {
  const taskDir = mkTmp('spo-tasksummary-readlines-');
  fs.writeFileSync(
    path.join(taskDir, 'journal.jsonl'),
    ['{"ts":"a","event":"one"}', 'garbage', '{"ts":"b","event":"two"}'].join('\n') + '\n'
  );
  const lines = readJournalLines(taskDir);
  assert.deepEqual(lines.map((l) => l.event), ['one', 'two']);
});

// ---- formatAttemptLines: pure, no fs -------------------------------------------------------------

test('formatAttemptLines: only positive counters get a row; null/undefined/0/negative are all omitted', () => {
  assert.deepEqual(formatAttemptLines({ diagnoseAttempts: 3, validateRejects: 0, ciImplementRetries: null }), [
    '- DIAGNOSE attempts: 3',
  ]);
  assert.deepEqual(formatAttemptLines({ diagnoseAttempts: undefined, validateRejects: 2, ciImplementRetries: -1 }), [
    '- VALIDATE rejects: 2',
  ]);
  assert.deepEqual(formatAttemptLines({}), []);
});

// ---- formatDuration: pure, no fs -------------------------------------------------------------

test('formatDuration: matches the three measured corpus figures exactly', () => {
  assert.equal(formatDuration(15 * 60000 + 12000), '15m12s'); // issue-471
  assert.equal(formatDuration(2 * 3600000 + 0 * 60000 + 48000), '2h00m48s'); // issue-213
  assert.equal(formatDuration(1 * 3600000 + 34 * 60000 + 21000), '1h34m21s'); // issue-452
});

test('formatDuration: non-finite or negative input renders null, never "NaN"', () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration(NaN), null);
  assert.equal(formatDuration(-5), null);
  assert.equal(formatDuration(Infinity), null);
});
