'use strict';
// task-summary.js -- action 5.2: reduces ONE task's own journal.jsonl (journal/<id>/) to the
// handful of numbers a human-facing GitHub comment needs -- billable-weighted tokens burned,
// pipeline wall-clock duration, and how many times DIAGNOSE/VALIDATE/the CI-implement-retry
// budget were exercised. Before this, the Done comment (steps/scripted.js's finalComment) was
// three lines telling a maintainer nothing about what a card cost or how hard it was, and the
// park comment (park-loop.js's buildParkComment) said nothing about what a card had already
// burned before landing on this park.
//
// Shared by steps/scripted.js's finalComment (the Done comment) and park-loop.js's
// postParkComment (the park comment) -- both read the SAME taskDir/journal.jsonl for the SAME
// kind of number, so this is one read/parse pass and one counting rule, not two independently
// -maintained ones. steps/scripted.js and park-loop.js have no dependency on each other today and
// this doesn't create one; both simply require this module, the same role orchestrator/tokens.js
// plays for `spo tokens` -- except that module scans EVERY task under a journalRoot for an
// aggregate report, while this one reduces ONE task's own journal for a comment about that one
// card.
//
// Every count here is CUMULATIVE across the task's full history, not just whichever run is
// finishing or parking right now: a retried task reuses the SAME taskDir/journal.jsonl across
// every attempt (park-loop.js's reEnqueueTask never creates a new one -- see that function's own
// header, "a human typing retry ... ALWAYS restores the full auto-retry budget", the same taskDir
// throughout), so scanning the whole file is what makes "3 diagnose attempts" mean "this card
// burned 3 diagnose attempts total", not "3 in whichever attempt happens to be running now" --
// exactly the same "the journal is the only ledger, and a parked-and-retried task keeps every
// attempt's numbers" reasoning orchestrator/tokens.js's own header states for billable tokens,
// applied here to attempt counts too. state-machine.js's ctx.counters is deliberately NOT used
// for this: buildCtx resets it to 0 on every fresh runTask call, including a retry (a retry
// always restarts a task at INTAKE -- see steps/scripted.js's sweepWorktreeLeftovers header), so
// it can only ever answer "how many this run", never "how many has this card burned overall".
// park-loop.js's own postParkComment is called with a bare {task, taskDir, config} ctx in several
// tests (no `.counters` at all) -- reading the journal instead of ctx.counters is also the only
// shape that works there.
//
// Every read here is defensive, matching steps/scripted.js's sumJournalBillableTokens (which now
// delegates to summarizeTask below rather than summing a second time): a missing or malformed
// journal.jsonl must never throw, because this runs on FINISH and PARKED, two paths documented as
// never failing over a journal read.

const fs = require('fs');
const path = require('path');

function readJournalLines(taskDir) {
  const file = path.join(taskDir, 'journal.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // no journal yet, or taskDir gone -- never throw over this
  }
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // a torn final line (daemon mid-append) or genuinely corrupt -- skip, never throw
    }
  }
  return lines;
}

// summarizeTask(taskDir) -> {
//   billableTokens, hasTokenData -- billableTokens is the SUM of every `llm-call` event's own
//     billableTokens field; hasTokenData is keyed off whether ANY such event carried a NUMERIC
//     billableTokens field at all, never off whether the sum happens to be 0. 107 of 110 llm-call
//     events in the measured corpus carry no token fields whatsoever (only the retired costUsd) --
//     rendering "0 tokens" for those would read as "this call was free", which is a lie; it means
//     "not recorded". A journal whose one real call genuinely reports billableTokens: 0 must still
//     render "0", which is exactly what keying off presence-of-the-field (not sum !== 0) gives.
//   diagnoseAttempts, validateRejects, ciImplementRetries -- cumulative counts of the journal
//     events state-machine.js's own handleDiagnose/handleValidate/chargeCiImplementRetry already
//     append for every attempt: 'result' under state DIAGNOSE, a 'change-validator' event whose
//     verdict is REJECT, and 'ci-implement-retry' respectively.
//
//     validateRejects counts the VERDICT, not handleValidate's `result` event, and that
//     distinction was measured rather than reasoned: the first cut keyed on 'result' under state
//     VALIDATE, because action 1.6 appends exactly that on a REJECT. Run against all 19 real
//     journals it counted **zero for every single task**, including issue-428, the one card in
//     the corpus that actually was rejected (its state.json says validateRejects: 1 and its
//     journal holds `change-validator {verdict: "REJECT"}` and no VALIDATE 'result' line at all
//     -- the card predates 1.6). The whole rule was dead, and the hermetic suite could not see it
//     because every fixture constructed the event the code writes today. `change-validator` has
//     been written since the beginning and carries the verdict itself, so it is the signal that
//     is true of the corpus AND of new cards. The same check on diagnoseAttempts came back
//     clean: 'result' under DIAGNOSE and the DIAGNOSE `llm-call` agree on every task
//     (1/1, 5/5, 3/3, 3/3, 3/3, 3/3).
//
//     A journal that
//     predates action 4.3 (when the CI-implement-retry budget shipped) simply has zero
//     'ci-implement-retry' events, which counts as 0 here -- and the caller's own render rule
//     ("a missing counter is absent, never 0") already treats a genuine 0 and an untracked
//     counter identically: neither one gets a row. There is nothing to disambiguate downstream of
//     this function.
//   parksCount -- total `parked` events in the journal, ANY reason, not park-loop.js's own
//     countRepeatedParks streak (which stops at the first park that doesn't match the current
//     reason+detail -- "identical parks in a row"). This answers a different question: how many
//     times has this card parked, period.
//   firstEventTs -- the `ts` of the journal's first line, or null for an empty/unreadable
//     journal. This is PIPELINE time, not the "42 minutes" figure recorded elsewhere for a card:
//     report pull, intake, confirm and triage all happen before this taskDir's journal.jsonl
//     exists at all (measured on issue-471: the journal spans 15m12s while 42 minutes is the
//     figure recorded everywhere else for that same card). Callers must label it as such, never
//     as unqualified "duration".
// }
function summarizeTask(taskDir) {
  // A null/undefined taskDir returns the zero summary rather than throwing out of `path.join`.
  // Unreachable from either caller today (both write into the same taskDir first), but this
  // module's own header promises "never throws" and a promise with a hole in it is worse than no
  // promise -- both callers sit on paths documented as not failing over a journal read.
  const lines = taskDir ? readJournalLines(taskDir) : [];

  let billableTokens = 0;
  let hasTokenData = false;
  let diagnoseAttempts = 0;
  let validateRejects = 0;
  let ciImplementRetries = 0;
  let parksCount = 0;
  let firstEventTs = null;
  let lastEventTs = null;
  let parkedMs = 0;
  let openParkTs = null;

  for (const event of lines) {
    if (!event || typeof event !== 'object') continue;
    if (firstEventTs === null && typeof event.ts === 'string') firstEventTs = event.ts;
    if (typeof event.ts === 'string') lastEventTs = event.ts;

    // Exact time this card spent parked, closed by the first event that is NOT itself part of
    // the park. Not a heuristic ("gaps longer than N minutes"): the journal records precisely
    // when the machine stopped and when it started again. The close condition is `state !==
    // 'PARKED'` rather than "the next event of any kind", and that was measured, not guessed --
    // a park is followed immediately by park-alert / board-move / park-comment, and then by an
    // `unpark-scan-failed` or `unpark-scan-backoff-skip` line every 60 seconds for as long as it
    // lasts (238 of them on issue-213 alone). "Next event" therefore closed every park in the
    // corpus within four seconds and reported 0m04s of waiting on a card that waited two days.
    // Everything written while a card is parked carries `state: "PARKED"`; the resumed run's
    // first event does not.
    if (openParkTs !== null && event.state !== 'PARKED' && typeof event.ts === 'string') {
      const span = Date.parse(event.ts) - Date.parse(openParkTs);
      if (Number.isFinite(span) && span > 0) parkedMs += span;
      openParkTs = null;
    }

    if (event.event === 'llm-call') {
      // `tokensSource` is the marker, NOT `typeof billableTokens === 'number'` -- and the
      // difference is the whole erratum, re-measured. steps/llm.js journals an `llm-call` for
      // EVERY call including the failed ones (unconditionally, before its own `if (!raw.ok)
      // return`), and every failure path returns ...ZERO_TOKENS = `{tokensSource: null,
      // billableTokens: 0, ...}`. So a deadline-killed, E2BIG or spawn-failed call writes a
      // numeric `billableTokens: 0`, and keying on the number would call that "token data" and
      // print `0` on the card -- reading as "this card was free" for a card that burned a whole
      // transport failure. orchestrator/tokens.js's own header calls `tokensSource` "the ONLY
      // honest 'did this call report tokens at all' marker" and bin/spo already prints `n/a`,
      // not `0`, for exactly these events. This module printing `0` where the CLI prints `n/a`
      // for the same journal is the disagreement 5.4 exists to end, not to create.
      //
      // The `tokensSource === undefined` arm keeps the 107 legacy events (costUsd/numTurns, no
      // tokensSource field at all) behaving as they did: if such an event ever carried a numeric
      // billableTokens it still counts. A genuine `billableTokens: 0` WITH a tokensSource still
      // renders `0`, which is the property erratum 1 asked for.
      const reported =
        (typeof event.tokensSource === 'string' && event.tokensSource) ||
        (event.tokensSource === undefined && typeof event.billableTokens === 'number');
      if (reported) hasTokenData = true;
      if (typeof event.billableTokens === 'number') billableTokens += event.billableTokens;
    } else if (event.state === 'DIAGNOSE' && event.event === 'result') {
      diagnoseAttempts += 1;
    } else if (event.event === 'change-validator' && event.verdict === 'REJECT') {
      validateRejects += 1;
    } else if (event.event === 'ci-implement-retry') {
      ciImplementRetries += 1;
    } else if (event.event === 'parked') {
      parksCount += 1;
      if (typeof event.ts === 'string') openParkTs = event.ts;
    }
  }

  return {
    billableTokens,
    hasTokenData,
    diagnoseAttempts,
    validateRejects,
    ciImplementRetries,
    parksCount,
    firstEventTs,
    lastEventTs,
    // Total ms this card sat parked waiting for a maintainer, summed exactly from the journal
    // (each `parked` event to the next event of any kind). An OPEN park -- one with no event
    // after it, i.e. the card is parked right now -- is NOT counted here: the caller knows `now`
    // and this module does not, and inventing a clock in a pure summariser is how a rendered
    // number starts disagreeing with the one beside it. `openParkTs` says where that open park
    // began so a caller that wants the running total can close it itself.
    parkedMs,
    openParkTs,
  };
}

// formatAttemptLines({diagnoseAttempts, validateRejects, ciImplementRetries}) -> string[], one
// per counter that is a genuine POSITIVE number -- null, undefined, 0 and negative all render as
// "omit the row" identically (errata 4: "render a missing counter as absent, never as 0" -- a
// clean card that went straight through must not be padded with a row of zeroes, and a counter
// this codebase never tracked for an old journal must read the same as one that tracked a
// genuine 0, since neither is a fact worth a maintainer's attention). Pure -- no fs, so both
// finalComment (steps/scripted.js) and buildParkComment (park-loop.js, which must stay pure --
// see its own header) can call it on numbers computed elsewhere.
function formatAttemptLines({ diagnoseAttempts, validateRejects, ciImplementRetries } = {}) {
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const lines = [];
  if (positive(diagnoseAttempts)) lines.push(`- DIAGNOSE attempts: ${diagnoseAttempts}`);
  if (positive(validateRejects)) lines.push(`- VALIDATE rejects: ${validateRejects}`);
  if (positive(ciImplementRetries)) lines.push(`- CI-triggered IMPLEMENT retries: ${ciImplementRetries}`);
  return lines;
}

// formatDuration(ms) -> "15m12s" / "2h00m48s", or null for anything not a finite non-negative
// number (an unreadable/empty journal's firstEventTs is null -- the caller must render no
// duration line rather than "NaNm NaNs"). Hours are shown only when present, in which case
// minutes and seconds are zero-padded to 2 digits ("2h00m48s", not "2h0m48s"); minutes are never
// padded when hours are absent ("15m12s", matching issue-471's measured figure), only seconds
// are.
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h${pad2(m)}m${pad2(s)}s`;
  return `${m}m${pad2(s)}s`;
}

module.exports = { readJournalLines, summarizeTask, formatAttemptLines, formatDuration };
