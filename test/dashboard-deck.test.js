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
