'use strict';
// console/live-step.js -- the READ side of what an LLM step is doing WHILE it runs. Card #239
// chantier, action A6 deleted the old five-link transcript-identity chain (pid -> lease ->
// account -> cwd -> session file) this file used to test and replaced it with a single read of
// orchestrator/live-progress.js's own per-task record, written by the worker itself as it
// consumes the SDK's message stream. This file now tests exactly that: a live record renders, a
// finished step's cleared record renders nothing, a crashed worker's stale record is caught, a
// leftover record from a different step name is caught, and one bad card never takes the rest of
// the deck down.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
require('./no-real-spawn');

const { probeLiveStep, probeDeck, LLM_STEPS } = require('../console/live-step');
const { writeLiveProgress, clearLiveProgress, LIVE_PROGRESS_STALE_MS } = require('../orchestrator/live-progress');

function card(over = {}) {
  return {
    id: 'issue-654',
    deckState: 'running',
    state: 'IMPLEMENT',
    run: { current: { state: 'IMPLEMENT', enteredAt: '2026-09-05T00:00:00.000Z', attempt: 1, detail: {} } },
    ...over,
  };
}

// The taskDir a real worker always has (journal/<id>/ is created at intake, well before any LLM
// step runs) -- writeLiveProgress itself does not create it, same as journal.js's own writeState,
// so this fixture creates it explicitly rather than relying on the function under test to do so.
function writeProgress(journalRoot, id, record) {
  const dir = path.join(journalRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  writeLiveProgress(dir, record);
}

// ---- the record, live -------------------------------------------------------------------------

test('probeLiveStep reports what the step is doing when the worker has written a fresh record', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  writeProgress(journalRoot, 'issue-654', {
    step: 'IMPLEMENT',
    account: 'pool1',
    turns: 3,
    toolCounts: { Edit: 2, Bash: 1 },
    lastText: 'Editing mail-html-utils.ts.',
    lastTurnAt: '2026-09-05T00:00:40.000Z',
    updatedAt: '2026-09-05T00:00:41.000Z',
  });

  const r = probeLiveStep(card(), { journalRoot, now: Date.parse('2026-09-05T00:00:42.000Z') });
  assert.equal(r.miss, undefined);
  assert.equal(r.account, 'pool1');
  assert.equal(r.turns, 3);
  assert.deepEqual(r.toolCounts, { Edit: 2, Bash: 1 });
  assert.equal(r.lastText, 'Editing mail-html-utils.ts.');
  assert.equal(r.lastTurnAt, '2026-09-05T00:00:40.000Z');
});

test('probeLiveStep passes account through as undefined, never null, when the record carries none -- render-deck.js falls back to the journal detail on a falsy value', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  writeProgress(journalRoot, 'issue-654', {
    step: 'IMPLEMENT',
    account: null,
    turns: 1,
    toolCounts: {},
    lastText: null,
    lastTurnAt: null,
    updatedAt: '2026-09-05T00:00:41.000Z',
  });
  const r = probeLiveStep(card(), { journalRoot, now: Date.parse('2026-09-05T00:00:42.000Z') });
  assert.equal(r.account, undefined);
});

// ---- the named misses ---------------------------------------------------------------------------

test('probeLiveStep names which check failed, so a blind deck is diagnosable without a debugger', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  const now = Date.parse('2026-09-05T00:01:00.000Z');

  // no record has ever been written for this taskDir yet
  assert.equal(probeLiveStep(card(), { journalRoot, now }).miss, 'no-progress-yet');

  // a record exists but belongs to a DIFFERENT step name than the one currently running (a
  // leftover from a crashed PLAN, read back while the card sits in IMPLEMENT)
  writeProgress(journalRoot, 'issue-654', {
    step: 'PLAN',
    account: null,
    turns: 1,
    toolCounts: {},
    lastText: 'planning',
    lastTurnAt: null,
    updatedAt: new Date(now).toISOString(),
  });
  assert.equal(probeLiveStep(card(), { journalRoot, now }).miss, 'wrong-step');

  // a record for the RIGHT step, but stamped long enough ago to be stale -- the worker that wrote
  // it is presumed dead or hung, not still narrating
  writeProgress(journalRoot, 'issue-654', {
    step: 'IMPLEMENT',
    account: null,
    turns: 5,
    toolCounts: {},
    lastText: 'old news',
    lastTurnAt: null,
    updatedAt: new Date(now - LIVE_PROGRESS_STALE_MS - 1000).toISOString(),
  });
  assert.equal(probeLiveStep(card(), { journalRoot, now }).miss, 'stale');

  // no journalRoot at all -- defensive, should never happen in production (every caller supplies
  // one) but must not throw
  writeProgress(journalRoot, 'issue-654', {
    step: 'IMPLEMENT',
    account: null,
    turns: 1,
    toolCounts: {},
    lastText: 'x',
    lastTurnAt: null,
    updatedAt: new Date(now).toISOString(),
  });
  assert.equal(probeLiveStep(card(), { journalRoot: null, now }).miss, 'no-journal-root');
});

test('probeLiveStep treats a record exactly AT the staleness boundary as still live, and one past it as stale', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  const now = Date.parse('2026-09-05T00:10:00.000Z');
  writeProgress(journalRoot, 'issue-654', {
    step: 'IMPLEMENT',
    account: null,
    turns: 1,
    toolCounts: {},
    lastText: 'right on the edge',
    lastTurnAt: null,
    updatedAt: new Date(now - LIVE_PROGRESS_STALE_MS).toISOString(),
  });
  assert.equal(probeLiveStep(card(), { journalRoot, now }).miss, undefined);
  assert.equal(probeLiveStep(card(), { journalRoot, now: now + 1 }).miss, 'stale');
});

test('probeLiveStep reads a record as live at the corpus\'s own measured CURRENT-LAYOUT worst-case gap (278.4s, PLAN\'s own figure -- issue-558, the highest observed under the `~/.spo-worktrees` layout every live worker actually uses today, LIVE_PROGRESS_STALE_MS\'s own header comment) -- F1/F2 fix pass, Opus verifier', () => {
  // Encodes the measurement, not a guess: 278_400ms is the real max PLAN/IMPLEMENT inter-message
  // gap across 397 real transcripts under the CURRENT worktree layout (orchestrator/live-
  // progress.js's own header comment) -- not the historical layout's 686.3s outlier (a different,
  // no-longer-current population; see that same header for why it is cited but not chased into
  // this test), and not a percentile guess. A worker that is genuinely still running, mid-
  // ordinary-tail, must not read as stale -- that was exactly the failure the rejected 2-minute
  // bound produced on 24.2% of real transcripts.
  const CURRENT_LAYOUT_WORST_CASE_GAP_MS = 278_400;
  const journalRoot = mkTmp('spo-live-journal-');
  const writtenAtMs = Date.parse('2026-09-05T00:10:00.000Z');
  writeProgress(journalRoot, 'issue-654', {
    step: 'PLAN',
    account: null,
    turns: 3,
    toolCounts: { Bash: 2 },
    lastText: 'still working',
    lastTurnAt: null,
    updatedAt: new Date(writtenAtMs).toISOString(),
  });
  const now = writtenAtMs + CURRENT_LAYOUT_WORST_CASE_GAP_MS;
  const c = card({ run: { current: { state: 'PLAN', enteredAt: '2026-09-05T00:00:00.000Z', attempt: 1, detail: {} } } });
  const r = probeLiveStep(c, { journalRoot, now });
  assert.equal(r.miss, undefined, `expected the corpus's own worst-case gap to still read as live, got miss: ${r.miss}`);
  assert.equal(r.lastText, 'still working');
  // MUTATION CHECK: reverting LIVE_PROGRESS_STALE_MS (orchestrator/live-progress.js) to the
  // rejected 2-minute value turns this red (`miss: 'stale'`) -- verified directly, this fix pass.
});

// ---- what is never probed at all (returns null, not a miss) ------------------------------------

test('probeLiveStep declines to probe a scripted step -- those journal a spawn per command already', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  for (const state of ['CHECK', 'GATE', 'MERGE', 'PUSH_PR', 'CI_CHECKS', 'FINISH', 'WORKTREE']) {
    const c = card({ state, run: { current: { state, enteredAt: '2026-09-05T00:00:00.000Z', attempt: 1, detail: {} } } });
    assert.equal(probeLiveStep(c, { journalRoot }), null, `${state} should not be probed`);
    assert.equal(LLM_STEPS.has(state), false);
  }
  for (const state of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE']) assert.equal(LLM_STEPS.has(state), true);
});

test('probeLiveStep returns null for a card with no open split at all', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  assert.equal(probeLiveStep(card({ run: { current: null, splits: [] } }), { journalRoot }), null);
  assert.equal(probeLiveStep(card({ run: null }), { journalRoot }), null);
  assert.equal(probeLiveStep(null, { journalRoot }), null);
});

// ---- the finished-step property: a cleared record renders nothing, never a stale-looking clock -

test('probeLiveStep reports no-progress-yet once the record has been cleared -- a finished call does not linger as live', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  const now = Date.parse('2026-09-05T00:01:00.000Z');
  const taskDir = path.join(journalRoot, 'issue-654');
  writeProgress(journalRoot, 'issue-654', { step: 'IMPLEMENT', account: null, turns: 2, toolCounts: {}, lastText: 'almost done', lastTurnAt: null, updatedAt: new Date(now).toISOString() });
  assert.equal(probeLiveStep(card(), { journalRoot, now }).miss, undefined);

  clearLiveProgress(taskDir);
  assert.equal(probeLiveStep(card(), { journalRoot, now }).miss, 'no-progress-yet');
});

// ---- probeDeck ------------------------------------------------------------------------------

test('probeDeck probes running cards only, and one card throwing never takes the others (or the page) down', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  const now = Date.parse('2026-09-05T00:01:00.000Z');
  writeProgress(journalRoot, 'issue-654', {
    step: 'IMPLEMENT',
    account: null,
    turns: 1,
    toolCounts: {},
    lastText: 'working',
    lastTurnAt: null,
    updatedAt: new Date(now).toISOString(),
  });

  const out = probeDeck(
    [
      card(),
      card({ id: 'issue-finished', deckState: 'finished' }),
      card({ id: 'issue-stale', deckState: 'stale' }),
      // A card whose own shape is broken: `run` is a getter that throws.
      Object.defineProperty({ id: 'issue-bad', deckState: 'running' }, 'run', {
        get() {
          throw new Error('boom');
        },
      }),
    ],
    { journalRoot, now }
  );

  assert.deepEqual(Object.keys(out), ['issue-654']);
  assert.equal(out['issue-654'].lastText, 'working');
});

test('probeDeck never probes a card whose deckState is not "running", even if a fresh record exists', () => {
  const journalRoot = mkTmp('spo-live-journal-');
  const now = Date.parse('2026-09-05T00:01:00.000Z');
  writeProgress(journalRoot, 'issue-stale', {
    step: 'IMPLEMENT',
    account: null,
    turns: 1,
    toolCounts: {},
    lastText: 'leftover from before the worker died',
    lastTurnAt: null,
    updatedAt: new Date(now).toISOString(),
  });
  const out = probeDeck([card({ id: 'issue-stale', deckState: 'stale' })], { journalRoot, now });
  assert.deepEqual(out, {});
});
