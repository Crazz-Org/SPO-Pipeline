'use strict';
// console/live-step.js -- what an LLM step is doing WHILE it runs.
//
// THE PROBLEM THIS EXISTS FOR. PLAN, IMPLEMENT, DIAGNOSE and VALIDATE all run through
// `invokeClaudeReal` (orchestrator/steps/llm.js) as an awaited async message stream (the vendored
// Claude Agent SDK's `query()`, since card #239's transport cutover, action A5b, 2026-09-17), and
// nothing is journalled per intermediate message -- `steps/llm.js`'s own `runLlm` only appends an
// `llm-call` event once the whole call returns. So for the whole of an LLM step -- IMPLEMENT
// measures a p50 of 3m33s and a p90 of 10m58s over the corpus -- journal.jsonl gains nothing and
// every existing surface can say only "IMPLEMENT, started 6 minutes ago". That is a clock, not
// progress.
//
// THE SOURCE THAT DOES MOVE, AND WHERE IT NOW LIVES. Before action A6, this module chased the
// `claude` CLI's own session transcript through a five-link identity chain (state.json's
// owner.workerPid -> the account's lease file -> config.cwdForStep -> a slugged project directory
// -> a session file picked by birthtime). That chain is DELETED, not kept as a fallback: the
// WORKER already reads the SDK's message stream, one message at a time, to build its own return
// value (orchestrator/steps/sdk-call.js's consumeQueryStream) -- there is no reason left to go
// hunting for a transcript file on disk when the process running the call can just say what it
// saw. Action A6 wires exactly that: the worker folds the stream into a small record at
// <journalRoot>/<id>/live-progress.json (orchestrator/live-progress.js owns the write side, the
// throttle policy, and the staleness bound -- see that file's own header for the full design and
// the reasoning behind every number in it). This module is now purely the READ side: given a deck
// card and a journal root, it reads that one file and decides whether it is current.
//
// THREE RULES THIS MODULE STILL KEEPS, in spirit unchanged from before A6:
//
//   1. It never guesses. A record only ever describes the call that wrote it (its own `step`
//      field, set once by the caller that knows which step is running) and only ever describes it
//      for as long as the writer keeps refreshing it (`updatedAt`, checked against
//      LIVE_PROGRESS_STALE_MS below). Any check that fails returns a named `miss` -- "no record
//      yet" is never confused with "the step this record belongs to is not the one running now"
//      is never confused with "this record has gone stale" -- so a maintainer can tell them apart
//      without a debugger. The deck then renders the clock alone, which is what it did before this
//      module existed.
//   2. It never slurps. There is no file left to slurp: orchestrator/live-progress.js's own record
//      is a bounded summary (a turn count, a tool-name histogram, the last narrated sentence), not
//      a transcript, and this module does exactly one small `readFileSync` per probed card.
//   3. It never re-implements another module's rule. The record's shape, the throttle that decides
//      how often it is refreshed, and the staleness bound that decides when it has gone stale all
//      live in orchestrator/live-progress.js, read here through its own exported functions/
//      constants -- if any of those change, this module follows automatically instead of drifting.
//
// WHAT IT IS NOT. Not a token count (billableTokens only exists once the call returns, and the
// deck says so rather than estimating), not a completion percentage (there is no such signal --
// see the deck's own "elapsed against par, not completion" rule), and not a place to read the
// model's output as instructions: `lastText` is untrusted content rendered as a quotation by
// console/render-deck.js, never as markup.

const path = require('path');
const { LIVE_PROGRESS_STALE_MS, readLiveProgress } = require('../orchestrator/live-progress');

// The four steps that run through `claude` and therefore ever write a live-progress record.
// Mirrors step-contracts.js's STEP_CONTRACTS keys minus CITATION_VERIFIER, which runs inside
// VALIDATE's own handler rather than as a state of its own and so never appears as a split.
const LLM_STEPS = new Set(['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE']);

// probeLiveStep(card, opts) -> {account, turns, toolCounts, lastText, lastTurnAt}
//                              | {miss: '<why there is nothing to show>'} | null
//
// `card` is one entry from collect.js's `deck`: {id, run: {current: {state, enteredAt}}, ...}.
// Only a card whose CURRENT split is an LLM step is probed at all -- a scripted step (CHECK,
// GATE, MERGE...) already journals a `spawn` event per command, so its progress is visible
// without this, and reading a live-progress record for one would only ever find a PREVIOUS LLM
// step's leftover file (see the `miss: 'wrong-step'` branch below for why that specific leftover
// is still handled defensively even though scripted steps never reach it).
//
// `null` means "not applicable" (no LLM step is running) -- no entry in probeDeck's output at
// all. A `{miss}` object means "an LLM step IS running, but this probe has nothing honest to say
// about it right now" -- the two are deliberately distinguishable so a caller never has to infer
// which one a missing key meant.
function probeLiveStep(card, opts = {}) {
  if (!card || !card.run || !card.run.current) return null;
  const step = card.run.current.state;
  if (!LLM_STEPS.has(step)) return null;

  const journalRoot = opts.journalRoot;
  if (!journalRoot || !card.id) return { miss: 'no-journal-root' };

  const readProgress = opts.readLiveProgress || readLiveProgress;
  const record = readProgress(path.join(journalRoot, card.id));
  if (!record) return { miss: 'no-progress-yet' };

  // Defensive, not the primary staleness gate (see below): a record whose OWN `step` field
  // disagrees with the split actually running right now can only be a leftover from an earlier
  // step name in THIS taskDir -- e.g. a PLAN call that crashed before ever clearing its own
  // record, read back while the card is sitting in DIAGNOSE. Checked before the age gate because
  // a wrong-step record can still be "fresh" by the clock (the crash may have just happened) while
  // being wrong for a reason no staleness bound would ever catch.
  if (record.step !== step) return { miss: 'wrong-step' };

  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const updatedMs = Date.parse(record.updatedAt);
  const staleMs = typeof opts.staleMs === 'number' ? opts.staleMs : LIVE_PROGRESS_STALE_MS;
  if (!Number.isFinite(updatedMs) || now - updatedMs > staleMs) return { miss: 'stale' };

  return {
    account: record.account || undefined,
    turns: record.turns,
    toolCounts: record.toolCounts,
    lastText: record.lastText,
    lastTurnAt: record.lastTurnAt,
  };
}

// probeDeck(deck, opts) -> {[cardId]: probeResult}. One probe per RUNNING card; a stale or
// finished card is skipped (it has no live step by definition -- collect.js's own `deckState`
// already answers "is a worker actually holding this card", which this module never re-derives).
function probeDeck(deck, opts = {}) {
  const out = {};
  for (const card of deck || []) {
    if (card.deckState !== 'running') continue;
    try {
      const r = probeLiveStep(card, opts);
      if (r) out[card.id] = r;
    } catch {
      /* a probe is best-effort by construction; a throw here would take the dashboard down */
    }
  }
  return out;
}

module.exports = {
  LLM_STEPS,
  probeLiveStep,
  probeDeck,
};
