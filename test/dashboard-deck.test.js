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
const { renderLiveInner, clock, signedClock, pace, trimNarration } = require('../console/render-deck');
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
    { model: by('IMPLEMENT', 2).model, turns: by('IMPLEMENT', 2).numTurns, tokens: by('IMPLEMENT', 2).billableTokens },
    { model: 'sonnet', turns: 40, tokens: 115043 }
  );
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

  const dynamic = (r) => r.startsWith('all-accounts-cooling') || r.startsWith('llm-transport-failed');
  const missing = [...reasons].filter((r) => !dynamic(r) && !PARK_REASONS[r]);
  assert.deepEqual(missing, [], `park reasons with no plain-language sentence: ${missing.join(', ')}`);
});

test("the deck's self-retrying set matches the orchestrator's own, so the deck cannot promise a retry that will never come", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'state-machine.js'), 'utf8');
  const block = src.slice(src.indexOf('const TRANSIENT_RETRY_REASONS = new Set(['));
  const listed = [...block.slice(0, block.indexOf(']);')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const { SELF_RETRYING } = require('../console/plain-language');
  assert.deepEqual([...SELF_RETRYING].sort(), listed.sort());
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
  // that is a number nobody has.
  assert.doesNotMatch(html, /% done|complete/i);
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
