'use strict';
// The flight deck: console/collect.js's buildRun/collectDeck, console/par-times.js,
// console/plain-language.js and console/render-deck.js's renderLiveInner.
//
// Same discipline as the rest of the suite: every fixture lives under fs.mkdtempSync(os.tmpdir())
// -- never the repo's own journal/, queue/ or the real account pool at ~/.claude-accounts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mkTmp } = require('./helpers');
require('./no-real-spawn');

const { collectAll, collectJournalTasks, buildRun, collectDeck, normalizeRootCause } = require('../console/collect');

// collectAll() reads the real clock, which a terminal-card fixture cannot be pinned against (its
// linger window is ten minutes wide). So terminal cases assemble the same object collectAll
// would, from the same collectors, with `now` fixed -- hermetic, and it exercises exactly the
// code path the server does.
function collectDeckAt(journalRoot, now) {
  const journalTasks = collectJournalTasks(journalRoot, { now });
  return {
    generatedAt: new Date(now).toISOString(),
    journalTasks,
    deck: collectDeck(journalRoot, journalTasks, now),
    parTimes: null,
    queue: { depth: 0 },
    services: {},
    daemonStats: {},
  };
}
const { computeParTimes, shouldRecompute, percentile, orderIndex, TRACK_ORDER } = require('../console/par-times');
const { STATES, PARK_REASONS, reasonText, stateInfo } = require('../console/plain-language');
const { renderLiveInner, clock, signedClock, pace, trimNarration, summarizeSpend, renderSpendChip, splitNote } = require('../console/render-deck');
const { renderDashboard } = require('../console/render');

// ---- fixture helpers ------------------------------------------------------------------------

function writeTask(journalRoot, id, { state, lines, ...rest }) {
  const dir = path.join(journalRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, kind: 'card', state, ...rest }));
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, kind: 'card', title: rest.title || id }));
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

const T = (s) => new Date(Date.UTC(2026, 8, 5, 0, 0, s)).toISOString();

// A run that is sent back twice -- once by a VALIDATE reject, once through DIAGNOSE -- and is
// still running on its third IMPLEMENT. This is the shape 22 of 39 real journals actually take
// (only 17 walk the track cleanly), so it is the shape the deck has to get right.
function loopingRun() {
  return [
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(20), state: 'WORKTREE', event: 'transition', to: 'PLAN' },
    { ts: T(200), state: 'PLAN', event: 'llm-call', model: 'fable', effort: 'medium', account: 'pool1', numTurns: 43, billableTokens: 155407, duration_s: 180, ok: true },
    { ts: T(200), state: 'PLAN', event: 'transition', to: 'IMPLEMENT' },
    { ts: T(400), state: 'IMPLEMENT', event: 'llm-call', model: 'sonnet', effort: 'medium', account: 'pool1', numTurns: 29, billableTokens: 90112, duration_s: 200, ok: true },
    { ts: T(400), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
    { ts: T(401), state: 'CHECK', event: 'invariants-checked', checkedIds: ['INV-1', 'INV-2'], broken: [] },
    { ts: T(500), state: 'CHECK', event: 'transition', to: 'PUSH_PR' },
    { ts: T(504), state: 'PUSH_PR', event: 'pr-created', prNumber: 674 },
    { ts: T(504), state: 'PUSH_PR', event: 'transition', to: 'GATE' },
    { ts: T(660), state: 'GATE', event: 'transition', to: 'CI_CHECKS' },
    { ts: T(661), state: 'CI_CHECKS', event: 'checks-green', checks: [1, 2, 3, 4, 5] },
    { ts: T(661), state: 'CI_CHECKS', event: 'transition', to: 'VALIDATE' },
    { ts: T(729), state: 'VALIDATE', event: 'llm-call', model: 'fable', effort: 'high', account: 'pool1', numTurns: 14, billableTokens: 59874, duration_s: 66, ok: true },
    { ts: T(729), state: 'VALIDATE', event: 'change-validator', verdict: 'REJECT' },
    { ts: T(729), state: 'VALIDATE', event: 'transition', to: 'IMPLEMENT' }, // send-back #1
    { ts: T(1085), state: 'IMPLEMENT', event: 'llm-call', model: 'sonnet', effort: 'medium', account: 'pool1', numTurns: 40, billableTokens: 115043, duration_s: 353, ok: true },
    { ts: T(1085), state: 'IMPLEMENT', event: 'transition', to: 'DIAGNOSE' }, // send-back #2
    { ts: T(1219), state: 'DIAGNOSE', event: 'llm-call', model: 'opus', effort: 'high', account: 'pool1', numTurns: 21, billableTokens: 50641, duration_s: 133, ok: true },
    { ts: T(1219), state: 'DIAGNOSE', event: 'result', payload: { rootCause: 'The retry budget was never wired to the fetch.' } },
    { ts: T(1219), state: 'DIAGNOSE', event: 'transition', to: 'IMPLEMENT' },
  ];
}

// ---- buildRun -------------------------------------------------------------------------------

test('buildRun splits one run into per-visit legs, numbers repeat visits, and leaves the current one open', () => {
  const run = buildRun(loopingRun());

  assert.equal(run.runIndex, 1);
  assert.equal(run.startedAt, T(0));
  assert.equal(run.outcome, null);

  // The card is on its THIRD IMPLEMENT and that leg is still open -- the single most useful fact
  // about a struggling card, and the one no existing surface shows.
  assert.deepEqual(
    { state: run.current.state, attempt: run.current.attempt },
    { state: 'IMPLEMENT', attempt: 3 }
  );

  const implements_ = run.splits.filter((s) => s.state === 'IMPLEMENT');
  assert.deepEqual(implements_.map((s) => s.attempt), [1, 2]);
  assert.equal(run.splits.find((s) => s.state === 'PLAN').ms, 180000);
});

test('buildRun derives sentBack from track POSITION, so a reject, a diagnose and a restart all register without a per-state rule', () => {
  const run = buildRun(loopingRun());
  const back = run.splits.filter((s) => s.sentBack).map((s) => s.state);

  // VALIDATE -> IMPLEMENT moves backwards along TRACK_ORDER; IMPLEMENT -> DIAGNOSE leaves the
  // track entirely. Both are losses of progress and both are flagged.
  assert.deepEqual(back, ['VALIDATE', 'IMPLEMENT']);

  // DIAGNOSE itself is NOT flagged: the split that LOST the progress is the one before it, and
  // flagging both would double-count one send-back.
  assert.equal(run.splits.find((s) => s.state === 'DIAGNOSE').sentBack, false);
  assert.equal(run.splits.find((s) => s.state === 'DIAGNOSE').offTrack, true);
});

test('buildRun attaches each event to the leg that was open, never to a neighbour', () => {
  const run = buildRun(loopingRun());
  const by = (state, attempt) => run.splits.find((s) => s.state === state && s.attempt === attempt).detail;

  assert.equal(by('PUSH_PR', 1).prNumber, 674);
  assert.equal(by('CHECK', 1).invariantsChecked, 2);
  assert.equal(by('CHECK', 1).invariantsBroken, 0);
  assert.equal(by('CI_CHECKS', 1).checksGreen, 5);
  assert.equal(by('VALIDATE', 1).verdict, 'REJECT');
  assert.equal(by('DIAGNOSE', 1).rootCause, 'The retry budget was never wired to the fetch.');
  assert.deepEqual(
    { model: by('IMPLEMENT', 2).model, tokens: by('IMPLEMENT', 2).billableTokens },
    { model: 'sonnet', tokens: 115043 }
  );
  // Card #214: numTurns is no longer collected onto the split's detail at all (the fixture
  // above still carries it on the raw event, matching a real journal that predates this card --
  // buildRun must ignore it, not merely leave it unsummed).
  assert.equal(by('IMPLEMENT', 2).numTurns, undefined);
});

test('buildRun keeps only the CURRENT run: a retried card starts over rather than accumulating every past attempt', () => {
  const lines = [
    ...loopingRun(),
    { ts: T(1300), state: 'IMPLEMENT', event: 'parked', reason: 'diagnose-budget-exhausted', detail: { attempt: 3 } },
    // ...the maintainer comments `retry`, and the whole thing runs again.
    { ts: T(2000), state: 'INTAKE', event: 'taken' },
    { ts: T(2000), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(2030), state: 'WORKTREE', event: 'transition', to: 'PLAN' },
  ];
  const run = buildRun(lines);

  assert.equal(run.runIndex, 2);
  assert.equal(run.startedAt, T(2000));
  assert.equal(run.current.state, 'PLAN');
  // Run 1's twenty-odd legs are gone, not appended.
  assert.ok(run.splits.length <= 3, `run 2 should carry only its own legs, got ${run.splits.length}`);
  assert.equal(run.splits.filter((s) => s.state === 'VALIDATE').length, 0);
});

test('buildRun records the outcome and closes the open leg when a run ends', () => {
  const parked = buildRun([
    ...loopingRun(),
    { ts: T(1300), state: 'IMPLEMENT', event: 'parked', reason: 'diagnose-budget-exhausted', detail: { attempt: 3 } },
  ]);
  assert.equal(parked.current, null);
  assert.deepEqual({ kind: parked.outcome.kind, reason: parked.outcome.reason }, { kind: 'parked', reason: 'diagnose-budget-exhausted' });
  assert.equal(parked.splits[parked.splits.length - 1].state, 'IMPLEMENT');
});

test('buildRun marks a reused step, so a skipped PLAN is never credited with the minutes it did not spend', () => {
  const run = buildRun([
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(24), state: 'WORKTREE', event: 'transition', to: 'PLAN' },
    { ts: T(24), state: 'PLAN', event: 'plan-reused' },
    { ts: T(24), state: 'PLAN', event: 'transition', to: 'IMPLEMENT' },
  ]);
  const plan = run.splits.find((s) => s.state === 'PLAN');
  assert.equal(plan.detail.reused, true);
  assert.equal(plan.ms, 0);
});

// ---- token ledger (action 4.4: buildRun sums a split's calls, and counts what each reported) --

test('buildRun SUMS every llm-call in a split rather than keeping only the last one -- the core defect this action fixes', () => {
  // Three calls in the same IMPLEMENT visit (no transition between them, exactly what a step
  // that retries its own CLI invocation internally produces). Chosen so sum (1000+2000+5000
  // = 8000) and last-wins (5000) are unmistakably different numbers.
  const run = buildRun([
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(1), state: 'WORKTREE', event: 'transition', to: 'IMPLEMENT' },
    { ts: T(2), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 1000, ok: true },
    { ts: T(3), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 2000, ok: true },
    { ts: T(4), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 5000, ok: true },
    { ts: T(5), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
  ]);
  const impl = run.splits.find((s) => s.state === 'IMPLEMENT');
  assert.equal(impl.detail.billableTokens, 8000, 'summed, not the last call\'s 5000');
  assert.equal(impl.detail.measuredCalls, 3);
});

test('a FAILED call that carries recovered tokens is counted -- dropping it was defect 3 this action fixes -- and failedCalls still increments', () => {
  const run = buildRun([
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(1), state: 'WORKTREE', event: 'transition', to: 'IMPLEMENT' },
    // A deadline kill: the CLI never returned a modelUsage block (ok: false) but
    // maybeRecoverTokens found real spend in the session transcript.
    { ts: T(2), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'transcript', billableTokens: 4000, ok: false },
    { ts: T(3), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 1000, ok: true },
    { ts: T(4), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
  ]);
  const impl = run.splits.find((s) => s.state === 'IMPLEMENT');
  assert.equal(impl.detail.billableTokens, 5000, 'the failed call\'s recovered 4000 is counted alongside the successful 1000');
  assert.equal(impl.detail.failedCalls, 1, 'attempts are still counted exactly as before');
  assert.equal(impl.detail.recoveredCalls, 1);
  assert.equal(impl.detail.measuredCalls, 1);
});

test('a split that never carried a numeric billableTokens stays exactly null, distinguishable from a split that genuinely summed to exactly 0', () => {
  const run = buildRun([
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(1), state: 'WORKTREE', event: 'transition', to: 'PLAN' },
    // A legacy-shaped event: no tokensSource field, no billableTokens field at all.
    { ts: T(2), state: 'PLAN', event: 'llm-call', model: 'fable', ok: true },
    { ts: T(3), state: 'PLAN', event: 'transition', to: 'IMPLEMENT' },
    // A real call that genuinely reported a zero-cost result.
    { ts: T(4), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 0, ok: true },
    { ts: T(5), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
  ]);
  const plan = run.splits.find((s) => s.state === 'PLAN');
  const impl = run.splits.find((s) => s.state === 'IMPLEMENT');
  assert.equal(plan.detail.billableTokens, null, 'no numeric figure was ever seen -- absence, not a lie');
  assert.equal(impl.detail.billableTokens, 0, 'a genuine zero must survive as 0, not be confused with "never measured"');
  assert.notEqual(plan.detail.billableTokens, impl.detail.billableTokens);
  // The legacy event (no tokensSource field at all) counts as not-measured, per this action's spec.
  assert.equal(plan.detail.notMeasuredCalls, 1);
  assert.equal(impl.detail.measuredCalls, 1);
});

// Fix 12 (this lot's own remediation): billableTokens sums across calls in a split; durationS
// must sum the same way, or the two figures on one split row silently mean different spans (one
// call's seconds next to two calls' tokens). No consumer (par-times.js, render.js,
// render-deck.js) depends on last-wins semantics for either field -- both are read only by
// splitNote's own display line, which now reports the same total the tokens figure does.
//
// Card #214 removed `numTurns` from this test (it used to assert the same sum for that field
// too): the field is no longer collected onto the split's detail at all -- see the test below,
// and collect.js's own comment at the removal site, for why a per-call figure that does not
// reliably count anything should not be summed across calls even when it is present on old
// events.
test('buildRun sums durationS across every call in a split, exactly like billableTokens', () => {
  const run = buildRun([
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(1), state: 'WORKTREE', event: 'transition', to: 'IMPLEMENT' },
    { ts: T(2), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 1000, duration_s: 90, ok: true },
    { ts: T(3), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 2000, duration_s: 89, ok: true },
    { ts: T(4), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
  ]);
  const impl = run.splits.find((s) => s.state === 'IMPLEMENT');
  assert.equal(impl.detail.billableTokens, 3000);
  assert.equal(impl.detail.durationS, 179, 'summed, not the last call\'s 89');
});

test('buildRun (card #214): a split whose calls carry numTurns (a historical event shape) never surfaces it on the detail -- the field is dropped entirely, not summed', () => {
  const run = buildRun([
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(1), state: 'WORKTREE', event: 'transition', to: 'IMPLEMENT' },
    { ts: T(2), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 1000, numTurns: 12, ok: true },
    { ts: T(3), state: 'IMPLEMENT', event: 'llm-call', tokensSource: 'modelUsage', billableTokens: 2000, numTurns: 11, ok: true },
    { ts: T(4), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
  ]);
  const impl = run.splits.find((s) => s.state === 'IMPLEMENT');
  assert.equal(impl.detail.numTurns, undefined);
});

test('normalizeRootCause keeps a sentence, drops "null", and unwraps the JSON-object shape the model sometimes answers with', () => {
  assert.equal(normalizeRootCause('The fetch is unauthenticated.'), 'The fetch is unauthenticated.');
  assert.equal(normalizeRootCause('null'), null);
  assert.equal(normalizeRootCause(''), null);
  assert.equal(normalizeRootCause(null), null);
  // Measured in the real corpus: the whole payload re-serialised into the string field.
  assert.equal(normalizeRootCause('{"root_cause": "It never retried.", "category": null}'), 'It never retried.');
  assert.equal(normalizeRootCause('{"root_cause": null, "reason": "no new cause"}'), null);
  assert.equal(normalizeRootCause('{ not json at all'), null);
});

// ---- the deck gate --------------------------------------------------------------------------

test('the deck carries live cards and anything finished within the linger window, and nothing else', () => {
  const journalRoot = mkTmp('spo-deck-gate-');
  const now = Date.parse('2026-09-05T12:00:00.000Z');
  const ago = (min) => new Date(now - min * 60000).toISOString();

  writeTask(journalRoot, 'issue-running', { state: 'IMPLEMENT', updatedAt: ago(2), lines: loopingRun() });
  writeTask(journalRoot, 'issue-just-parked', { state: 'PARKED', reason: 'plan-invalid', updatedAt: ago(4), lines: loopingRun() });
  writeTask(journalRoot, 'issue-old-done', { state: 'DONE', updatedAt: ago(90), lines: loopingRun() });
  writeTask(journalRoot, 'issue-old-parked', { state: 'PARKED', reason: 'plan-invalid', updatedAt: ago(600), lines: loopingRun() });

  const tasks = collectJournalTasks(journalRoot, { now });
  const onDeck = tasks.filter((t) => t.onDeck).map((t) => t.id).sort();
  assert.deepEqual(onDeck, ['issue-just-parked', 'issue-running']);

  // The gate is also what bounds the cost: `run` is built for deck cards only.
  assert.ok(tasks.find((t) => t.id === 'issue-running').run);
  assert.equal(tasks.find((t) => t.id === 'issue-old-done').run, null);
});

test('collectDeck reports a non-terminal card with no live worker as stale, never as running', () => {
  const journalRoot = mkTmp('spo-deck-stale-');
  const now = Date.parse('2026-09-05T12:00:00.000Z');
  writeTask(journalRoot, 'issue-orphan', {
    state: 'IMPLEMENT',
    updatedAt: new Date(now - 60000).toISOString(),
    owner: { host: os.hostname(), workerPid: 999999, workerStartedAt: new Date(now - 60000).toISOString() },
    lines: loopingRun(),
  });
  // No live-workers.json at all: the dispatcher never published here, so nothing holds this card.
  const tasks = collectJournalTasks(journalRoot, { now });
  const deck = collectDeck(journalRoot, tasks, now);

  assert.equal(deck.length, 1);
  assert.equal(deck[0].deckState, 'stale');
  assert.equal(deck[0].liveness, null);
});

test('collectDeck surfaces the retry budgets straight off state.json -- the deck renders these as lives', () => {
  const journalRoot = mkTmp('spo-deck-counters-');
  const now = Date.parse('2026-09-05T12:00:00.000Z');
  writeTask(journalRoot, 'issue-lives', {
    state: 'DIAGNOSE',
    updatedAt: new Date(now - 60000).toISOString(),
    diagnoseAttempts: 2,
    validateRejects: 1,
    ciImplementRetries: 0,
    mainMoveUsed: 0,
    prNumber: 674,
    lines: loopingRun(),
  });
  const deck = collectDeck(journalRoot, collectJournalTasks(journalRoot, { now }), now);
  assert.deepEqual(deck[0].counters, { diagnoseAttempts: 2, validateRejects: 1, ciImplementRetries: 0, mainMoveUsed: 0 });
  assert.equal(deck[0].prNumber, 674);
});

// ---- par times ------------------------------------------------------------------------------

test('computeParTimes measures one leg per VISIT, excludes INTAKE, and never counts the leg still open', () => {
  const journalRoot = mkTmp('spo-par-');
  // Twelve identical finished runs, so every state clears MIN_SAMPLES (8).
  for (let i = 0; i < 12; i++) {
    writeTask(journalRoot, `issue-${i}`, {
      state: 'DONE',
      updatedAt: T(1300),
      lines: [...loopingRun(), { ts: T(1300), state: 'IMPLEMENT', event: 'done' }],
    });
  }
  const par = computeParTimes(journalRoot);

  // IMPLEMENT is visited three times per run, but the third is the leg still OPEN when `done`
  // lands -- and an unfinished leg has no duration to contribute (par-times.js's header). So two
  // legs per run, not three. This is the rule that stops a card being measured against a par it
  // is itself still pulling down.
  assert.equal(par.byState.IMPLEMENT.n, 24);
  assert.equal(par.byState.PLAN.n, 12);
  assert.equal(par.byState.PLAN.p50Ms, 180000);

  // INTAKE's "duration" is queue wait, not work -- see par-times.js's header.
  assert.equal(par.byState.INTAKE, undefined);
  assert.equal(par.wholeRun.done.n, 12);
  assert.equal(par.wholeRun.parked, null); // fewer than MIN_SAMPLES -- reported as absent, not as 0
});

test('computeParTimes reports nothing for a state with too few samples, rather than a percentile over three runs', () => {
  const journalRoot = mkTmp('spo-par-thin-');
  writeTask(journalRoot, 'issue-1', { state: 'DONE', updatedAt: T(1300), lines: [...loopingRun(), { ts: T(1300), state: 'IMPLEMENT', event: 'done' }] });
  const par = computeParTimes(journalRoot);
  assert.deepEqual(par.byState, {});
  assert.equal(par.wholeRun.done, null);
});

test('percentile returns null for no samples -- "unmeasured" and "zero seconds" are different claims', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([4000], 0.5), 4000); // PUSH_PR really does measure 4s
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

test('shouldRecompute recomputes on a missing cache, a grown corpus, or an aged one -- and otherwise leaves it alone', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');
  const fresh = { byState: {}, taskCount: 40, computedAt: new Date(now - 60000).toISOString() };
  assert.equal(shouldRecompute(null, 40, now), true);
  assert.equal(shouldRecompute(fresh, 40, now), false);
  assert.equal(shouldRecompute(fresh, 45, now), true); // TASK_COUNT_DRIFT
  assert.equal(shouldRecompute({ ...fresh, computedAt: new Date(now - 7 * 3600e3).toISOString() }, 40, now), true);
});

test('orderIndex places DIAGNOSE off the track, which is what makes sentBack derivable', () => {
  assert.equal(orderIndex('INTAKE'), 0);
  assert.equal(orderIndex('DONE'), TRACK_ORDER.length - 1);
  assert.ok(orderIndex('VALIDATE') > orderIndex('IMPLEMENT'));
  assert.equal(orderIndex('DIAGNOSE'), null);
  assert.equal(orderIndex('NOT_A_STATE'), null);
});

// ---- the dictionary --------------------------------------------------------------------------

test('every state the engine can dispatch has a plain-language entry, so a new state cannot ship without its sentence', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'state-machine.js'), 'utf8');
  const table = src.slice(src.indexOf('const HANDLERS = {'), src.indexOf('};', src.indexOf('const HANDLERS = {')));
  const handled = [...table.matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]);
  assert.ok(handled.length >= 12, `expected the full lifecycle table, found ${handled.length}`);

  for (const state of [...handled, 'DONE', 'PARKED', 'ABANDONED']) {
    assert.ok(STATES[state], `no plain-language entry for state ${state}`);
    assert.ok(STATES[state].label && STATES[state].sentence && STATES[state].icon, `incomplete entry for ${state}`);
  }
});

test('every literal ParkSignal reason in the orchestrator has a plain-language sentence', () => {
  const files = [
    ...fs.readdirSync(path.join(__dirname, '..', 'orchestrator')).filter((f) => f.endsWith('.js')).map((f) => path.join('orchestrator', f)),
    path.join('orchestrator', 'steps', 'scripted.js'),
    path.join('orchestrator', 'steps', 'llm.js'),
  ];
  const reasons = new Set();
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const line of src.split('\n')) {
      if (line.trimStart().startsWith('//')) continue; // a wrapped comment is not a call site
      for (const m of line.matchAll(/ParkSignal\('([a-z0-9:-]+)'/g)) reasons.add(m[1]);
    }
  }
  assert.ok(reasons.size >= 60, `expected the full park-reason set, found ${reasons.size}`);

  // Only `all-accounts-cooling-until-<ISO>` is genuinely unenumerable (accounts.js's pick()
  // appends a timestamp, so the reason can never repeat exactly). `all-accounts-cooling-unknown`,
  // `all-accounts-cooling-after-retry` and `all-accounts-cooling-wait-cap-exceeded` are ordinary
  // literals with their own PARK_REASONS entries -- a blanket `all-accounts-cooling` prefix here
  // excused all three from ever being required to have one, which is exactly how
  // `all-accounts-cooling-unknown` went missing a sentence unnoticed (card #119 action 1.4).
  const dynamic = (r) => r.startsWith('all-accounts-cooling-until-') || r.startsWith('llm-transport-failed');
  const missing = [...reasons].filter((r) => !dynamic(r) && !PARK_REASONS[r]);
  assert.deepEqual(missing, [], `park reasons with no plain-language sentence: ${missing.join(', ')}`);
});

test("the deck's self-retrying set matches the orchestrator's own, so the deck cannot promise a retry that will never come", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'state-machine.js'), 'utf8');
  const block = src.slice(src.indexOf('const TRANSIENT_RETRY_REASONS = new Set(['));
  const listed = [...block.slice(0, block.indexOf(']);')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const { SELF_RETRYING } = require('../console/plain-language');
  assert.deepEqual([...SELF_RETRYING].sort(), listed.sort());

  // The mirror above only constrains the LITERAL set -- it says nothing about the reasons
  // reasonText() handles by prefix rather than by table lookup. That is exactly the hole that let
  // the cooling branch hardcode `selfRetrying: true` and still pass a test named to forbid
  // precisely that: the branch never went near SELF_RETRYING, so nothing here noticed. Close it by
  // checking EVERY reason the orchestrator can actually produce -- not a second hand-typed table,
  // but the orchestrator's own exported functions, the same ones production code calls.
  const {
    TRANSIENT_RETRY_REASONS,
    ACCOUNT_POOL_PARK_REASON_FAMILY,
    poolCooldownDeadlineMs,
  } = require('../orchestrator/state-machine');
  const { reasonText } = require('../console/plain-language');

  // TRANSIENT_RETRY_REASONS already contains every `llm-transport-failed:<STEP>` literal
  // (state-machine.js builds it that way), so this one loop covers both the plain transient
  // reasons and that second dynamic family in one pass.
  for (const r of TRANSIENT_RETRY_REASONS) {
    assert.equal(reasonText(r).selfRetrying, true, `${r} is in TRANSIENT_RETRY_REASONS but reasonText says it is not self-retrying`);
  }

  // The account-pool family: a representative instance per member (the prefix member gets a real
  // ISO suffix), checked against poolCooldownDeadlineMs -- the orchestrator's OWN answer to "does
  // this reason carry a recoverable wait deadline", which is exactly the fact that determines
  // whether action 1.2's pool-wait branch re-enqueues it instead of parking it. A detail object
  // carrying both shapes poolCooldownDeadlineMs reads is supplied for every member; its own
  // structural gate (checked first, by reason name, before either detail key is read -- see that
  // function's header) is what makes the other three resolve to null regardless of this detail.
  //
  // The oracle is pinned at ONE point in the input space, deliberately, and saying so is the
  // honest version of this comment: reasonText's answer is a function of the reason alone, while
  // poolCooldownDeadlineMs's is a function of (reason, detail). The two provably disagree at
  // ('all-accounts-cooling-after-retry', {}) -- no detail, so no deadline, so no wait -- which the
  // detail chosen here hides. That input is not live-producible today (callLlmStep's throw site
  // always writes cooldownUntilIso), so this is a BOUNDED oracle rather than a wrong one; a change
  // that let that throw omit the key would need this test rethought, not merely re-run.
  const detail = {
    earliestCooldownUntil: Date.parse('2026-09-05T19:32:33.350Z'),
    cooldownUntilIso: '2026-09-05T19:32:33.350Z',
  };
  for (const member of ACCOUNT_POOL_PARK_REASON_FAMILY) {
    const instance = member.kind === 'prefix' ? `${member.match}2026-09-05T19:32:33.350Z` : member.match;
    const expected = poolCooldownDeadlineMs(instance, detail) !== null;
    assert.equal(
      reasonText(instance).selfRetrying,
      expected,
      `${instance}: reasonText says selfRetrying=${reasonText(instance).selfRetrying}, but the orchestrator's own poolCooldownDeadlineMs says ${expected}`
    );
  }
});

test('reasonText handles the two dynamic reason families by prefix, and degrades honestly on an unknown one', () => {
  const cooling = reasonText('all-accounts-cooling-until-2026-09-05T19:32:33.350Z');
  assert.equal(cooling.selfRetrying, true);
  assert.match(cooling.text, /out of quota/);

  const transport = reasonText('llm-transport-failed:PLAN');
  assert.equal(transport.selfRetrying, true);
  assert.match(transport.text, /plan/);

  const unknown = reasonText('some-brand-new-reason');
  assert.equal(unknown.known, false);
  assert.equal(unknown.selfRetrying, false);
  assert.equal(unknown.text, 'some brand new reason');

  assert.equal(reasonText('diagnose-budget-exhausted').selfRetrying, false);

  // The account-pool family's other three members: no deadline exists (cooling-unknown), a lease
  // rather than a cooldown (leased), or this IS the give-up (cap-exceeded) -- none of the three
  // comes back on its own, and each now has its own sentence (card #119 action 1.4).
  assert.equal(reasonText('all-accounts-cooling-unknown').selfRetrying, false);
  assert.equal(reasonText('all-accounts-leased').selfRetrying, false);
  assert.equal(reasonText('all-accounts-cooling-wait-cap-exceeded').selfRetrying, false);
  // ...while the family's OTHER deadline-carrying member matches `-until-`'s own verdict -- fixing
  // the false statement in the direction that was previously wrong: today this reason falls
  // through to the table and reports `selfRetrying: false`, which told the maintainer to intervene
  // on a card already scheduled to return on its own.
  assert.equal(reasonText('all-accounts-cooling-after-retry').selfRetrying, true);
});

// Repairs from action 1.4's adversarial verification (36 mutations, 22 killed, 14 survived). The
// BEHAVIOUR above is well pinned -- every drift that would make the deck promise a retry that will
// never come is caught. What survived is everything else about the mirror: its membership, its
// matching convention, its sentences, and the deadline text.
test("the deck's account-pool mirror has exactly the orchestrator's own members, matched the same way", () => {
  const { ACCOUNT_POOL_PARK_REASON_FAMILY } = require('../orchestrator/state-machine');
  const { ACCOUNT_POOL_SELF_RETRYING } = require('../console/plain-language');

  // MEMBERSHIP, pinned by deepEqual -- the way SELF_RETRYING is pinned against
  // TRANSIENT_RETRY_REASONS. Before this, deleting four of the five mirror members left the suite
  // green: the deck's fallback also answers `selfRetrying: false`, so the PROMISE stayed correct
  // while the member silently lost its sentence and its declared `kind`. A behavioural pin alone
  // cannot see that, because both sides of the drift give the same answer.
  const shape = (list) => list.map(({ match, kind }) => `${kind}:${match}`).sort();
  assert.deepEqual(
    shape(ACCOUNT_POOL_SELF_RETRYING),
    shape(ACCOUNT_POOL_PARK_REASON_FAMILY),
    'console/plain-language.js mirrors orchestrator/state-machine.js here -- a member added, removed or ' +
      'given a different `kind` there must be mirrored, or the deck silently stops describing it'
  );
});

test('the deck matches a literal family member by exact equality and a prefix member by startsWith -- never a substring', () => {
  // The same gap that survived on the ORCHESTRATOR side earlier in this lot, reproduced verbatim
  // in the deck's own copy: accountPoolMember's comment states the convention ("never a substring
  // test") and nothing enforced it. Matching literals with startsWith, or prefixes with includes,
  // both survived the whole suite.
  // Asserted against accountPoolMember directly. Through reasonText the literal case is
  // unreachable -- the table branch is gated on an exact `PARK_REASONS[reason]` lookup, so a
  // literal matched with startsWith would change no observable answer, and the mutation is an
  // equivalent one there. The convention is still a real contract this file states, so it is
  // pinned where it can actually be observed.
  const { accountPoolMember } = require('../console/plain-language');

  assert.equal(accountPoolMember('all-accounts-leased').match, 'all-accounts-leased', 'sanity: the exact literal matches');
  assert.equal(accountPoolMember('all-accounts-leased-extra'), undefined, "a literal member's name plus a suffix is NOT that member");
  assert.equal(accountPoolMember('all-accounts-cooling-unknown-and-more'), undefined);
  assert.equal(accountPoolMember('all-accounts-cooling-after-retry-v2'), undefined);

  assert.equal(
    accountPoolMember('all-accounts-cooling-until-2026-09-05T19:32:33.350Z').kind,
    'prefix',
    'sanity: the prefix member matches an instance carrying a timestamp'
  );
  assert.equal(
    accountPoolMember('nope-all-accounts-cooling-until-2026-09-05T19:32:33.350Z'),
    undefined,
    'a string merely CONTAINING the prefix must not match it -- startsWith, never includes'
  );
  // ...and the same string must not be described as a known reason by the deck either, which is
  // the reachable consequence of the prefix half of the convention.
  assert.equal(reasonText('nope-all-accounts-cooling-until-2026-09-05T19:32:33.350Z').known, false);
});

test("the deck's llm-transport-failed answer is derived from the orchestrator's step list, not hardcoded true", () => {
  // The second dynamic family had the SAME defect as the cooling branch and it outlived action
  // 1.4: `selfRetrying: true` returned unconditionally, never consulting TRANSIENT_RETRY_REASONS.
  // Verification demonstrated it concretely -- narrow TRANSIENT_RETRY_LLM_STEPS by one step, add
  // that reason to TERMINAL_PARK_REASONS so the narrowing is deliberate, and the deck goes on
  // promising a retry for a now-terminal reason with nothing failing. The guard above could not
  // see it: it only iterates reasons that ARE in the set, so it checks one direction.
  const { TRANSIENT_RETRY_REASONS } = require('../orchestrator/state-machine');
  const { SELF_RETRYING_LLM_STEPS } = require('../console/plain-language');
  const PREFIX = 'llm-transport-failed:';

  // The orchestrator's own list, read back out of the set it builds rather than re-typed here.
  const orchestratorSteps = [...TRANSIENT_RETRY_REASONS]
    .filter((r) => r.startsWith(PREFIX))
    .map((r) => r.slice(PREFIX.length));
  assert.deepEqual(
    [...SELF_RETRYING_LLM_STEPS].sort(),
    orchestratorSteps.sort(),
    "console/plain-language.js mirrors state-machine.js's TRANSIENT_RETRY_LLM_STEPS -- narrowing that " +
      'list without narrowing this one leaves the deck promising a retry for a step that is now terminal'
  );

  // Both directions, against the orchestrator's own membership -- including a step deliberately
  // NOT in the set, which is the direction that was unpinned.
  for (const step of [...orchestratorSteps, 'CITATION_VERIFIER', 'BRAND_NEW_STEP']) {
    const reason = `${PREFIX}${step}`;
    assert.equal(
      reasonText(reason).selfRetrying,
      TRANSIENT_RETRY_REASONS.has(reason),
      `${reason}: the deck says selfRetrying=${reasonText(reason).selfRetrying}, the orchestrator says ${TRANSIENT_RETRY_REASONS.has(reason)}`
    );
  }

  // A step with no retry must not be told it will try again on its own.
  assert.ok(!/try again on its own/.test(reasonText(`${PREFIX}CITATION_VERIFIER`).text));
  assert.match(reasonText(`${PREFIX}PLAN`).text, /try again on its own/);
});

test('every account-pool family member has its own plain-language sentence', () => {
  // Three of the five are never discovered by the literal-`ParkSignal(...)` sweep above (they are
  // thrown as typed Errors, or built as a template, or reassigned), so deleting any of their
  // sentences survived. `all-accounts-cooling-unknown` had no sentence at all until action 1.4 --
  // exactly the gap this pins shut.
  const { ACCOUNT_POOL_PARK_REASON_FAMILY } = require('../orchestrator/state-machine');
  for (const member of ACCOUNT_POOL_PARK_REASON_FAMILY) {
    const instance = member.kind === 'prefix' ? `${member.match}2026-09-05T19:32:33.350Z` : member.match;
    const { text, known } = reasonText(instance);
    assert.equal(known, true, `${instance} has no plain-language sentence`);
    assert.ok(text.length > 20 && /[.!]$/.test(text), `${instance}'s sentence is not a written sentence: ${JSON.stringify(text)}`);
    // reasonText's last-resort fallback is the slug with its punctuation opened out. Compare
    // against that exact string rather than guessing at its shape -- a real sentence CAN contain a
    // hyphen (the `-until-` member's own sentence quotes an ISO date).
    assert.notEqual(text, instance.replace(/[-:]/g, ' '), `${instance} fell through to the slug fallback rather than a written sentence`);
  }
});

test('the cooling deadline is read out of the reason string, and a bad one degrades instead of lying', () => {
  // formatCooldownDeadline was entirely untested: returning null always, or a time a full day
  // wrong, both survived -- the only text assertion was /out of quota/, which matches either
  // branch. A deadline shown to a maintainer is exactly the kind of claim that must not drift.
  const withDeadline = reasonText('all-accounts-cooling-until-2026-09-05T19:32:33.350Z');
  assert.match(withDeadline.text, /2026-09-05 19:32:33 UTC/, 'the deadline in the reason string is shown to the maintainer');
  assert.equal(withDeadline.selfRetrying, true);

  const unparseable = reasonText('all-accounts-cooling-until-not-a-timestamp');
  assert.equal(unparseable.known, true, 'still a recognised family member');
  assert.equal(unparseable.selfRetrying, true, 'and still self-retrying');
  assert.ok(!/UTC/.test(unparseable.text), 'but no invented time -- it falls back to the generic sentence');
});

// ---- rendering -------------------------------------------------------------------------------

function deckData(over = {}) {
  const journalRoot = mkTmp('spo-deck-render-');
  const now = Date.parse('2026-09-05T00:25:00.000Z'); // 1500s after T(0)
  writeTask(journalRoot, 'issue-654', {
    state: 'IMPLEMENT',
    title: 'Bench git fetch has no retry',
    updatedAt: T(1219),
    diagnoseAttempts: 1,
    validateRejects: 1,
    prNumber: 674,
    owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: T(0) },
    lines: loopingRun(),
  });
  fs.writeFileSync(path.join(journalRoot, 'live-workers.json'), JSON.stringify({ ids: ['issue-654'], updatedAt: T(1219) }));
  const data = collectAll({ journalRoot });
  data.generatedAt = new Date(now).toISOString();
  return { ...data, ...over };
}

// ---- the "spent this run" chip (action 4.4 -- A4 is the falsification test below) -----------
//
// summarizeSpend/renderSpendChip are exercised directly against hand-built split shapes rather
// than through a full journal fixture: the point under test is the RENDERING rule (never a bare
// figure over an incomplete ledger), not buildRun's own bookkeeping (covered above).
function split(detail) {
  return { detail };
}

test('a run mixing measured and recovered calls renders a lower-bound marker, and the total is the sum of both', () => {
  const run = { splits: [split({ billableTokens: 1000, measuredCalls: 1 }), split({ billableTokens: 2000, recoveredCalls: 1 })] };
  const spend = summarizeSpend(run);
  assert.equal(spend.tokens, 3000);

  const html = renderSpendChip(spend, false);
  assert.match(html, /at least/i, 'a recovered figure is marked as a floor, not presented as exact');
  assert.match(html, /recovered from the transcript/);
  assert.match(html, /3\.0k|3000/); // the SUM of 1000 + 2000, not either call alone
});

test("A4 falsification test -- a run with a not-measured call never renders a bare number; it states what is unaccounted for", () => {
  // Fix 5 (F4): measuredCalls and notMeasuredCalls are deliberately DIFFERENT numbers (3 vs 1),
  // not the coincidentally-equal 1-and-1 this test used to use -- a display bug that read the
  // wrong counter (e.g. printed measuredCalls where notMeasuredCalls belongs) would still pass
  // "1 call not measured" if both counters happened to be 1.
  const run = {
    splits: [
      split({ billableTokens: 1000, measuredCalls: 3 }),
      split({ billableTokens: null, notMeasuredCalls: 1 }),
    ],
  };
  const spend = summarizeSpend(run);
  assert.equal(spend.notMeasuredCalls, 1);
  assert.equal(spend.measuredCalls, 3);

  const html = renderSpendChip(spend, false);
  // The falsifying shape: a bare "spent this run <b>1000</b>" with nothing qualifying it. Assert
  // the actual chip is never that shape, and that it names the gap in the ledger instead.
  assert.doesNotMatch(html, /^<span class="chip[^"]*"[^>]*>spent this run <b>[\d.,kM]+<\/b>\s*<\/span>$/);
  assert.match(html, /1 call not measured/);
  assert.doesNotMatch(html, /3 calls not measured/, 'the missing-calls count must come from notMeasuredCalls, not measuredCalls');
  assert.match(html, /at least/i, 'the partial figure it does show is marked as a floor');
});

test('a run where nothing was measured renders no figure at all -- specifically not "0"', () => {
  const run = { splits: [split({ billableTokens: null, notMeasuredCalls: 2 })] };
  const spend = summarizeSpend(run);
  assert.equal(spend.tokens, null);

  const html = renderSpendChip(spend, false);
  assert.match(html, /spend not recorded/);
  assert.doesNotMatch(html, /<b>/, 'no figure is bolded -- there is nothing to show as a number');
  assert.doesNotMatch(html, />\s*0\s*<|<b>0/, 'and specifically never the false claim "0"');
});

test('a run with no llm-call event yet renders no chip at all', () => {
  assert.equal(renderSpendChip(summarizeSpend(null), false), '');
  assert.equal(renderSpendChip(summarizeSpend({ splits: [] }), false), '');
});

// Fix 3: a call with tokensSource: null and billableTokens: 0 (19 such events measured in the
// real corpus, e.g. issue-515) must not drive the partial variant to "at least 0" -- a numeric
// zero dressed up as a measured lower bound is exactly the 0-vs-not-recorded confusion this whole
// card exists to remove, reappearing on a new surface.
//
// The fix lives in collect.js's buildRun, not here: a not-measured call's billableTokens is never
// trusted into a split's sum (see that function's own comment), so this exact real-corpus shape
// reaches summarizeSpend/renderSpendChip with `tokens: null`, never `0` -- and those two functions
// are deliberately UNCHANGED for this case (see renderSpendChip's own comment on why a
// magnitude-keyed branch here would itself be the threshold-shaped bug the mechanism-invariance
// test below exists to catch). Exercised through buildRun, not the hand-built `split()` helper,
// because the fix is upstream of it.
test('a not-measured call carrying a stale billableTokens: 0 never drives the chip to "at least 0"', () => {
  const run = buildRun([
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(1), state: 'WORKTREE', event: 'transition', to: 'PLAN' },
    // The real-corpus anomaly: tokensSource null (not measured) but billableTokens: 0 present.
    { ts: T(2), state: 'PLAN', event: 'llm-call', tokensSource: null, billableTokens: 0, ok: true },
    { ts: T(3), state: 'PLAN', event: 'transition', to: 'CHECK' },
  ]);
  const plan = run.splits.find((s) => s.state === 'PLAN');
  assert.equal(plan.detail.billableTokens, null, "a not-measured call's own billableTokens is never trusted into the sum");
  assert.equal(plan.detail.notMeasuredCalls, 1);

  const spend = summarizeSpend({ splits: [plan] });
  assert.equal(spend.tokens, null);

  const html = renderSpendChip(spend, false);
  assert.doesNotMatch(html, /at least/i, 'a floor of exactly 0 says nothing -- it must not be presented as one');
  assert.doesNotMatch(html, />\s*0\s*<|<b>0/, 'and specifically never the bare claim "0"');
  assert.match(html, /spend not recorded this run/);
  assert.match(html, /1 call not measured/);
});

// Fix 6 (F7): summarizeSpend's own `tokens` must not silently drop a genuinely-measured 0 -- a
// truthiness check in place of `typeof ... === 'number'` would survive every other test here
// (they all use non-zero figures) while quietly turning a real 0 into `null`.
test('summarizeSpend pins a genuinely-measured 0 as 0, not null', () => {
  const spend = summarizeSpend({ splits: [split({ billableTokens: 0, measuredCalls: 1 })] });
  assert.equal(spend.tokens, 0);
});

// Fix 7 (F9): totalCalls === 0 is an early-return guard in its own right, not merely a consequence
// of `tokens` also being non-numeric in every other test above -- so it needs a shape where the
// two are pulled apart: a hand-built spend with a real numeric `tokens` but no call counters at
// all (unreachable through summarizeSpend from real splits, which never produces that combination,
// but exactly what the guard itself must be proof against regardless of how a caller got there).
test('renderSpendChip renders nothing when totalCalls is 0, even if a numeric tokens value is present', () => {
  const html = renderSpendChip({ tokens: 5000, measuredCalls: 0, recoveredCalls: 0, notMeasuredCalls: 0, totalCalls: 0 }, false);
  assert.equal(html, '', 'the totalCalls===0 guard must fire on its own, not merely ride along with the tokens check below it');
});

// Fix 8 (F10): the "+ live call unreported" note had no assertion anywhere.
test('a pending live call is noted on the chip as unreported', () => {
  const spend = summarizeSpend({ splits: [split({ billableTokens: 1000, measuredCalls: 1 })] });
  const html = renderSpendChip(spend, true);
  assert.match(html, /live call unreported/);
  assert.doesNotMatch(renderSpendChip(spend, false), /live call unreported/, 'and absent when nothing is pending');
});

test('the spend chip never carries a threshold, an alert, or a "bad" colour -- there is deliberately no limit in this card', () => {
  const scenarios = [
    summarizeSpend({ splits: [split({ billableTokens: 5000, measuredCalls: 1 })] }),
    summarizeSpend({ splits: [split({ billableTokens: 5000, recoveredCalls: 1 })] }),
    summarizeSpend({ splits: [split({ billableTokens: 5000, measuredCalls: 1 }), split({ billableTokens: null, notMeasuredCalls: 1 })] }),
    summarizeSpend({ splits: [split({ billableTokens: null, notMeasuredCalls: 1 })] }),
  ];
  for (const spend of scenarios) {
    const html = renderSpendChip(spend, false);
    assert.doesNotMatch(html, /chip-warn/, 'no colour that means "bad"');
    assert.doesNotMatch(html, /threshold|too (much|many)|exceed|over budget|limit reached|alert/i, 'no comparison against a limit');
  }
  // Every non-empty variant carries the same tooltip -- said once, where a reader will find it.
  for (const spend of scenarios) {
    assert.match(renderSpendChip(spend, false), /title="[^"]*not a health signal[^"]*"/);
  }
});

// Fix 2: the test above checks today's OUTPUT (no "chip-warn" string, no keyword). That is a
// cheap first net but it only catches a threshold someone happens to phrase the same way this
// test already knows about -- adding `tokens > 100000 ? 'chip-warn' : ''` to the chip passes every
// other assertion in this file, because every fixture above uses billableTokens: 5000. This test
// checks the MECHANISM instead: render every variant across nine orders of magnitude and assert
// the markup is byte-identical once the formatted figure itself is masked out. Any rule keyed on
// the SIZE of the number, at any value, in any variant -- a colour, a word, an extra element --
// makes one of these renderings differ from the others.
test('the spend chip has no threshold MECHANISM: its markup is invariant in magnitude', () => {
  // A threshold of any kind -- a colour, a word, an extra element -- is a function of the VALUE.
  // So render each variant across nine orders of magnitude and assert every rendering is
  // byte-identical once the formatted figure is masked out. Any rule keyed on how big the number
  // is, at any value, in any variant, makes one of these differ from the others.
  const MAGNITUDES = [0, 1, 999, 5000, 99999, 100000, 100001, 1000000, 50000000, Number.MAX_SAFE_INTEGER];
  const variants = {
    measured:  (t) => ({ tokens: t, measuredCalls: 1, recoveredCalls: 0, notMeasuredCalls: 0, totalCalls: 1 }),
    recovered: (t) => ({ tokens: t, measuredCalls: 0, recoveredCalls: 1, notMeasuredCalls: 0, totalCalls: 1 }),
    partial:   (t) => ({ tokens: t, measuredCalls: 1, recoveredCalls: 0, notMeasuredCalls: 1, totalCalls: 2 }),
  };
  for (const [name, mk] of Object.entries(variants)) {
    const skeletons = new Set(
      MAGNITUDES.map((t) => renderSpendChip(mk(t), false).replace(/<b>[^<]*<\/b>/g, '<b>#</b>'))
    );
    assert.equal(skeletons.size, 1, `${name}: markup changed with the SIZE of the number -- something is keyed on the value`);
  }
});

// Fix 9 (F8 + verdict d): both AUC figures must be cited, not just the outcome one -- the omitted
// prefix figure (0.3706) is FURTHER from chance than the outcome one (0.4706), so it is the
// figure a sceptic would seize on; citing only the friendlier-looking number was mildly
// self-serving. Pinned as literals: neither number appears anywhere else in the repo, and
// mutating 0.4706 -> 0.9706 was measured to pass the whole suite before this test existed.
test('the tooltip cites both measured AUC figures, pinned against silent drift', () => {
  const spend = summarizeSpend({ splits: [split({ billableTokens: 5000, measuredCalls: 1 })] });
  const html = renderSpendChip(spend, false);
  assert.match(html, /0\.4706/, 'the outcome AUC');
  assert.match(html, /0\.3706/, 'the prefix AUC -- the more-informative-looking figure, must not be the one left out');
});

// Fix 10 (verdict c): the chip (current run, closed splits only) and `spo tokens` (every call,
// every run the card has ever had) can disagree by up to 3x on a retried real card -- stated in
// the tooltip so the mismatch reads as documented behaviour, not an unexplained bug.
test('the tooltip states the chip is this-run-only, distinct from spo tokens\' all-runs total', () => {
  const spend = summarizeSpend({ splits: [split({ billableTokens: 5000, measuredCalls: 1 })] });
  const html = renderSpendChip(spend, false);
  assert.match(html, /this run only/i);
  assert.match(html, /spo tokens/);
});

// Fix 4: summarizeSpend accumulates measuredCalls/recoveredCalls/notMeasuredCalls with `+=` across
// every split in the run. No fixture anywhere else in this file has calls in more than one split,
// so mutating each `+=` to `=` (keeping only the LAST split's counters) survived the whole suite --
// measured against the real journal, that mutant changes 52 of 62 cards and, on several, drops the
// chip entirely (issue-385, issue-247, issue-671 all lose it; issue-201 shows "1 call not
// measured" instead of 6). A run with calls spread across two splits -- a PLAN split and an
// IMPLEMENT split -- is the NORMAL shape, not an edge case.
test('summarizeSpend sums call counters ACROSS splits, not just within the last one', () => {
  const run = {
    splits: [
      split({ billableTokens: 1000, measuredCalls: 1, notMeasuredCalls: 1 }),
      split({ billableTokens: 2000, measuredCalls: 1, notMeasuredCalls: 1 }),
    ],
  };
  const spend = summarizeSpend(run);
  assert.equal(spend.notMeasuredCalls, 2, 'a `=` mutant would keep only the last split\'s 1');
  assert.equal(spend.measuredCalls, 2);
  assert.equal(spend.totalCalls, 4);
});

// Fix 1: A4 is falsified as shipped on splitNote -- the per-split <small> note on a track row --
// which kept rendering a bare per-split figure even after renderSpendChip itself was fixed.
// Verified on the real journal: card issue-671's Plan row is the split HOLDING the not-measured
// call, and it showed "204.8k" unqualified while the chip above it said the ledger was short. The
// row a reader consults next to find WHERE the ledger is short is the one that must not lie.
test('splitNote marks its own figure as a floor when the split it belongs to has an incomplete ledger', () => {
  const complete = splitNote({ state: 'IMPLEMENT', detail: { billableTokens: 5000, measuredCalls: 1 } }, false);
  assert.doesNotMatch(complete, /at least/i, 'a fully-measured split states its figure plainly');

  const partial = splitNote({ state: 'PLAN', detail: { billableTokens: 5000, measuredCalls: 1, notMeasuredCalls: 1 } }, false);
  assert.match(partial, /at least/i, 'a split holding a not-measured call must qualify its own figure as a floor');

  const recovered = splitNote({ state: 'DIAGNOSE', detail: { billableTokens: 5000, recoveredCalls: 1 } }, false);
  assert.match(recovered, /at least/i, 'a recovered-only split is also a floor, not an exact figure');

  // The existing `> 0` guard (unchanged by this fix) already keeps a genuine 0 off this line
  // entirely -- confirmed here so Fix 1 and Fix 3 are not accidentally in tension.
  const zero = splitNote({ state: 'PLAN', detail: { billableTokens: 0, notMeasuredCalls: 1 } }, false);
  assert.doesNotMatch(zero, /at least 0|\b0\b/, 'a zero figure alongside a not-measured call still shows nothing numeric');
});

test('renderLiveInner draws the running card: its track, its lives, what is happening now, and its splits', () => {
  const html = renderLiveInner(deckData());

  assert.match(html, /issue-654/);
  assert.match(html, /Bench git fetch has no retry/);
  assert.match(html, /Happening right now/);
  // Plain language, not the state name.
  assert.match(html, /Write the code/);
  assert.match(html, /Claude is editing files in the private copy/);
  // The send-backs are visible as such.
  assert.match(html, /rejected it/);
  assert.match(html, /sent back|Diagnose/);
  // The third attempt is named, and why.
  assert.match(html, /attempt <b>3<\/b>/);
  // And the icon sprite travels with the fragment, since the client replaces it wholesale.
  assert.match(html, /<symbol id="ic-code"/);
});

test('renderLiveInner never claims a completion percentage, and labels its meter with the three real numbers', () => {
  const html = renderLiveInner(deckData());
  // The bar is elapsed against par -- see render-deck.js. If it ever gains a "% done" label,
  // that is a number nobody has. `\bcomplet` (not a bare `complete`) so this still catches
  // "complete"/"completed"/"completion"/"80% complete" but stops rejecting "incomplete" -- the
  // most accurate word for a short ledger, and one this lot's own spend chip has reason to use.
  assert.doesNotMatch(html, /% done|\bcomplet/i);
  assert.match(html, /usual |no par yet/);
  assert.match(html, /gives up |no deadline/);
});

test('renderLiveInner renders a parked run as its outcome, in plain words, with the raw slug still greppable', () => {
  const journalRoot = mkTmp('spo-deck-parked-');
  const now = Date.parse('2026-09-05T00:25:00.000Z');
  writeTask(journalRoot, 'issue-654', {
    state: 'PARKED',
    reason: 'diagnose-budget-exhausted',
    title: 'Bench git fetch has no retry',
    updatedAt: new Date(now - 60000).toISOString(),
    diagnoseAttempts: 3,
    lines: [...loopingRun(), { ts: T(1300), state: 'DIAGNOSE', event: 'parked', reason: 'diagnose-budget-exhausted' }],
  });
  const html = renderLiveInner(collectDeckAt(journalRoot, now));

  assert.match(html, /OUT OF LIVES/);
  assert.match(html, /tried to fix the same failure three times/);
  assert.match(html, /diagnose-budget-exhausted/); // the slug is what you grep for
  assert.match(html, /comment <b>retry<\/b>/);
});

test('a self-retrying park says it will resume, and never tells the maintainer to do something the daemon already does', () => {
  const journalRoot = mkTmp('spo-deck-transient-');
  const now = Date.parse('2026-09-05T00:25:00.000Z');
  writeTask(journalRoot, 'issue-640', {
    state: 'PARKED',
    reason: 'gate-environment',
    title: 'A transient gate failure',
    updatedAt: new Date(now - 60000).toISOString(),
    lines: [...loopingRun(), { ts: T(1300), state: 'GATE', event: 'parked', reason: 'gate-environment' }],
  });
  const html = renderLiveInner(collectDeckAt(journalRoot, now));

  assert.match(html, /start again on its own/);
  assert.doesNotMatch(html, /comment <b>retry<\/b>/);
});

test('renderLiveInner renders the standing-by panel when nothing is running -- the state the deck is in 88% of the time', () => {
  const html = renderLiveInner({ generatedAt: '2026-09-05T00:25:00.000Z', deck: [], queue: { depth: 0 }, services: {}, daemonStats: {} });
  assert.match(html, /Standing by/);
  assert.match(html, /Nothing is running/);
  assert.doesNotMatch(html, /Happening right now/);
});

test('the standing-by panel names the queue depth, so a wedged daemon does not look like an idle one', () => {
  const busy = renderLiveInner({ generatedAt: '2026-09-05T00:25:00.000Z', deck: [], queue: { depth: 3 }, services: {}, daemonStats: {} });
  assert.match(busy, /3 cards are waiting to start/);
  assert.match(busy, /the daemon is stuck/);

  const idle = renderLiveInner({ generatedAt: '2026-09-05T00:25:00.000Z', deck: [], queue: { depth: 0 }, services: {}, daemonStats: {} });
  assert.match(idle, /nothing on the queue/);
});

test('the live-step narration and a diagnosis are escaped, never rendered as markup', () => {
  const data = deckData({
    liveSteps: {
      'issue-654': {
        account: 'pool1',
        turns: 4,
        toolCounts: { Bash: 3 },
        lastText: 'Running <script>alert(1)</script> & checking "quotes"',
        lastTurnAt: T(1490),
      },
    },
  });
  const html = renderLiveInner(data);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&amp;/);
});

test('renderDashboard puts the deck on the root page and the health sections behind view:health', () => {
  const data = deckData();
  const deck = renderDashboard(data);
  assert.match(deck, /id="frag-live"/);
  assert.doesNotMatch(deck, /id="frag-services"/);
  assert.match(deck, /href="\/health"/);

  const health = renderDashboard(data, { view: 'health' });
  assert.match(health, /id="frag-services"/);
  assert.doesNotMatch(health, /id="frag-live"/);
});

test('the health link names what is wrong, so the deck does not send you looking for it', () => {
  const { healthSummary } = require('../console/render');
  assert.deepEqual(healthSummary({ services: { daemon: { status: 'up' } }, accounts: { rows: [] } }), {
    degraded: false,
    text: 'health',
  });
  const bad = healthSummary({ services: { daemon: { status: 'down' } }, accounts: { rows: [{ name: 'pool2', cooling: true }] } });
  assert.equal(bad.degraded, true);
  assert.match(bad.text, /daemon/);
  assert.match(bad.text, /1 account cooling/);
});

// ---- formatting ------------------------------------------------------------------------------

test('clock and signedClock read as a run tracker, not as a rounded age', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(66000), '1:06');
  assert.equal(clock(3671000), '1:01:11');
  assert.equal(clock(null), '—');
  assert.equal(signedClock(42000), '+0:42');
  assert.equal(signedClock(-42000), '−0:42');
  assert.equal(signedClock(500), '±0:00');
});

test('pace bands a split against its measured par, and says "unknown" rather than guessing when there is none', () => {
  const par = { p50Ms: 200000, p90Ms: 700000 };
  assert.equal(pace(100000, par).band, 'under');
  assert.equal(pace(300000, par).band, 'over');
  assert.equal(pace(800000, par).band, 'well-over');
  assert.equal(pace(300000, null).band, 'unknown');
  assert.equal(pace(300000, null).deltaMs, null);
});

test('trimNarration keeps the END of a long narration -- the last thing the model said it was doing', () => {
  const long = 'First I read the file. ' + 'x'.repeat(300) + '. Now running the tests.';
  const out = trimNarration(long);
  assert.ok(out.length <= 200);
  assert.match(out, /Now running the tests\.$/);
  assert.equal(trimNarration('short one'), 'short one');
});

test('stateInfo falls back to UNKNOWN rather than throwing on a state it has never heard of', () => {
  assert.equal(stateInfo('NOT_A_STATE').label, 'Unknown');
  assert.equal(stateInfo('IMPLEMENT').label, 'Write the code');
  assert.equal(stateInfo('GATE').judge, true);
  assert.equal(stateInfo('VALIDATE').judge, true);
  assert.equal(stateInfo('CHECK').judge, undefined);
});

// ---- a failed step and its Diagnose box -------------------------------------------------------
//
// issue-518's run 4 as journalled on 2026-09-11: CHECK failed coverage:changed, DIAGNOSE called it
// flaky, and the card went back to IMPLEMENT. Measured over the live corpus the step that fails
// into DIAGNOSE is IMPLEMENT itself 33 times, CHECK 9, CI_CHECKS 7 and GATE 6, and DIAGNOSE hands
// back to IMPLEMENT 43 times out of 43 -- so the box must handle a zero-width span as well as a
// long one, and must never be anchored under IMPLEMENT whatever failed (the defect it replaces).
const { renderTrack, renderSplits } = require('../console/render-deck');

function failedCheckRun() {
  return [
    { ts: T(0), state: 'INTAKE', event: 'taken' },
    { ts: T(0), state: 'INTAKE', event: 'transition', to: 'WORKTREE' },
    { ts: T(20), state: 'WORKTREE', event: 'transition', to: 'PLAN' },
    { ts: T(200), state: 'PLAN', event: 'transition', to: 'IMPLEMENT' },
    { ts: T(400), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
    { ts: T(401), state: 'CHECK', event: 'invariants-checked', checkedIds: ['INV-1', 'INV-2'], broken: [] },
    { ts: T(650), state: 'CHECK', event: 'check-failed', alias: 'coverage:changed', exit: 1 },
    { ts: T(650), state: 'CHECK', event: 'transition', to: 'DIAGNOSE' },
    { ts: T(1100), state: 'DIAGNOSE', event: 'result', payload: { rootCause: 'One load-sensitive suite the diff never touches.', category: 'flaky' } },
    { ts: T(1100), state: 'DIAGNOSE', event: 'transition', to: 'IMPLEMENT' },
  ];
}

// The class of the tile whose label is `label` ("tile-failed", "tile-done tile-judge", ...).
function tileClass(html, label) {
  const group = html.split('<g class="tile ').slice(1).find((g) => g.includes(`>${label}</text>`));
  assert.ok(group, `no tile labelled ${label}`);
  return group.slice(0, group.indexOf('"'));
}
function labelX(html, label) {
  const m = new RegExp(`class="tile-label" x="([\\d.]+)"[^>]*>${label}</text>`).exec(html);
  assert.ok(m, `no label ${label}`);
  return Number(m[1]);
}
function detourGeometry(html) {
  const box = /class="tile tile-detour[^"]*">[\s\S]*?<rect class="tile-face" x="([\d.-]+)" y="[\d.]+" width="([\d.]+)"/.exec(html);
  const drop = /class="fail-arc" d="M([\d.]+),/.exec(html);
  const rise = /class="detour-arc" d="M([\d.]+),/.exec(html);
  assert.ok(box && drop && rise, 'the Diagnose box and both of its arrows are drawn');
  return { left: Number(box[1]), right: Number(box[1]) + Number(box[2]), dropX: Number(drop[1]), riseX: Number(rise[1]) };
}
const trackOf = (lines) => renderTrack({ id: 'issue-518', run: buildRun(lines) }, Date.parse(T(5000)));
const HALF_STEP = 95 / 2;

test('buildRun marks only a split that failed into DIAGNOSE as failed, and keeps what failed and what DIAGNOSE concluded', () => {
  const run = buildRun(failedCheckRun());
  const check = run.splits.find((s) => s.state === 'CHECK');
  assert.equal(check.failed, true);
  assert.deepEqual(check.detail.failedCheck, { name: 'coverage:changed', exit: 1, broken: null });
  assert.equal(run.splits.find((s) => s.state === 'DIAGNOSE').detail.category, 'flaky');

  // A VALIDATE reject moves the card backwards but failed nothing; the IMPLEMENT that went to
  // DIAGNOSE did.
  const looping = buildRun(loopingRun());
  const validate = looping.splits.find((s) => s.state === 'VALIDATE');
  assert.equal(validate.sentBack, true);
  assert.equal(validate.failed, false);
  assert.equal(looping.splits.filter((s) => s.state === 'IMPLEMENT')[1].failed, true);
});

test("buildRun reads each failing step's own event, and drops a category the model left as \"null\"", () => {
  const failInto = (state, ev) =>
    buildRun([
      { ts: T(0), state, event: 'taken' },
      { ts: T(1), state, ...ev },
      { ts: T(2), state, event: 'transition', to: 'DIAGNOSE' },
      { ts: T(3), state: 'DIAGNOSE', event: 'result', payload: { rootCause: 'x', category: 'null' } },
    ]);
  assert.equal(failInto('CI_CHECKS', { event: 'check-failed', check: 'CodeQL', step: null }).splits[0].detail.failedCheck.name, 'CodeQL');
  assert.deepEqual(failInto('CHECK', { event: 'check-failed', alias: 'invariants', broken: ['INV-2', 'INV-5'] }).splits[0].detail.failedCheck, { name: 'invariants', exit: null, broken: 2 });
  assert.equal(failInto('IMPLEMENT', { event: 'empty-implement', filesChanged: '[]' }).splits[0].detail.noChange, true);
  const gate = failInto('GATE', { event: 'gate-verdict', headSha: 'abc', verdict: { verdict: 'FAIL', head: 'abc' } });
  assert.equal(gate.splits[0].detail.gateResult, 'FAIL');
  assert.equal(gate.current.detail.category, undefined);
});

test('a failed step is red and names its failing check, and the Diagnose box runs from it back to Write the code', () => {
  const html = trackOf(failedCheckRun());
  assert.equal(tileClass(html, 'Test'), 'tile-failed');
  assert.match(html, /class="fail-caption"[^>]*>coverage:changed<\/text>/);
  assert.equal(tileClass(html, 'Write the code'), 'tile-current');

  const w = labelX(html, 'Write the code');
  const t = labelX(html, 'Test');
  const g = detourGeometry(html);
  assert.equal(g.dropX, t, 'the red arrow leaves the step that failed');
  assert.equal(g.riseX, w, 'the orange arrow returns to the step the card went back to');
  assert.ok(g.left < w && g.left > w - HALF_STEP, 'the box starts under Write the code');
  assert.ok(g.right > t && g.right < t + HALF_STEP, 'and ends under Test, not beyond');
  assert.match(html, /class="detour-box-label"[^>]*>Diagnose<\/text>/);
  assert.match(html, /class="detour-box-sub"[^>]*>flaky<\/text>/);
});

test('a GATE failure draws its box out to Full test run, and the steps it passed on the way are only stale', () => {
  const html = trackOf([
    ...failedCheckRun().slice(0, 5),
    { ts: T(500), state: 'CHECK', event: 'transition', to: 'PUSH_PR' },
    { ts: T(510), state: 'PUSH_PR', event: 'transition', to: 'GATE' },
    { ts: T(700), state: 'GATE', event: 'gate-verdict', headSha: 'abc', verdict: { verdict: 'FAIL', head: 'abc' } },
    { ts: T(700), state: 'GATE', event: 'transition', to: 'DIAGNOSE' },
    { ts: T(900), state: 'DIAGNOSE', event: 'transition', to: 'IMPLEMENT' },
  ]);
  assert.ok(tileClass(html, 'Full test run').startsWith('tile-failed'));
  assert.match(html, /class="fail-caption"[^>]*>verdict FAIL<\/text>/);
  assert.equal(tileClass(html, 'Test'), 'tile-stale');
  assert.equal(tileClass(html, 'Open PR'), 'tile-stale');

  const gx = labelX(html, 'Full test run');
  const g = detourGeometry(html);
  assert.equal(g.dropX, gx);
  assert.equal(g.riseX, labelX(html, 'Write the code'));
  assert.ok(g.right > gx && g.right < gx + HALF_STEP);
});

test('once the redo gets past the failed step it is an ordinary tile again, and the box stays as the record', () => {
  const html = trackOf([
    ...failedCheckRun(),
    { ts: T(1300), state: 'IMPLEMENT', event: 'transition', to: 'CHECK' },
    { ts: T(1400), state: 'CHECK', event: 'transition', to: 'PUSH_PR' },
  ]);
  assert.equal(tileClass(html, 'Test'), 'tile-done');
  assert.doesNotMatch(html, /tile-failed|fail-caption/);
  assert.match(html, /tile-detour/);
});

test('while Diagnose is running, the failed step is red and the box says it is running', () => {
  const html = trackOf(failedCheckRun().slice(0, 8));
  assert.equal(tileClass(html, 'Test'), 'tile-failed');
  assert.match(html, /class="tile tile-detour detour-live"/);
  assert.match(html, /class="detour-box-sub"[^>]*>running now<\/text>/);
});

test('an IMPLEMENT that fails into DIAGNOSE and comes straight back gets two arrows side by side under its own tile', () => {
  const html = trackOf(loopingRun());
  const w = labelX(html, 'Write the code');
  const g = detourGeometry(html);
  assert.ok(g.dropX > w && g.riseX < w, 'side by side, never drawn on top of each other');
  assert.ok(g.left < w - 24 && g.right > w + 24, 'the box is wide enough for its label even on a zero-width span');
  // The VALIDATE reject in the same run failed nothing, and IMPLEMENT is running again.
  assert.doesNotMatch(html, /tile-failed/);
});

test('a run that never went to DIAGNOSE draws no box and keeps the short track', () => {
  const html = trackOf(failedCheckRun().slice(0, 5));
  assert.doesNotMatch(html, /tile-detour|fail-arc|tile-failed/);
  assert.match(html, /viewBox="0 0 [\d.]+ 190"/);
});

test('the split that failed is a red row leading with what failed; a reject stays an orange send-back', () => {
  const failed = renderSplits({ run: buildRun(failedCheckRun()) }, null, Date.parse(T(1200)));
  const rows = (html) => html.split('<div class="split ').slice(1);
  const testRow = rows(failed).find((r) => r.includes('split-name">Test'));
  assert.ok(testRow.startsWith('split-failed'));
  assert.match(testRow, /<b>failed: coverage:changed \(exit 1\)<\/b>/);
  assert.match(rows(failed).find((r) => r.includes('split-name">Diagnose')), /flaky/);

  const looping = renderSplits({ run: buildRun(loopingRun()) }, null, Date.parse(T(1300)));
  assert.ok(rows(looping).find((r) => r.includes('split-name">Review')).startsWith('split-back'));
});

test('the box rises to wherever the journal says DIAGNOSE sent the card, not to a hardcoded Write the code', () => {
  // Every measured DIAGNOSE returned to IMPLEMENT; the box still reads the transition rather than
  // assuming it, so a future route back to PLAN is drawn as what it is.
  const lines = failedCheckRun();
  lines[lines.length - 1] = { ...lines[lines.length - 1], to: 'PLAN' };
  const html = trackOf(lines);
  assert.equal(detourGeometry(html).riseX, labelX(html, 'Plan'));
  assert.equal(tileClass(html, 'Test'), 'tile-failed');
});
