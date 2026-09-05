'use strict';
// tokens.js -- what the pipeline is actually spending, in TOKENS, read back out of the
// journals. Replaces orchestrator/cost.js (dollar figures retired, maintainer decision
// 2026-08-31): the pool is Claude Max SUBSCRIPTION accounts with a quota, never the metered
// API, so a dollar figure never meant money spent -- token efficiency is what actually varies
// call to call, and is what this module reports.
//
// Headline metric: BILLABLE-WEIGHTED tokens = fresh input + cache-creation + output. Cache-READ
// tokens are reported SEPARATELY and never folded into that total -- on a quota plan a cache
// read is nearly free while fresh input and a cache write are not, and cache-read tokens
// dominate raw counts by orders of magnitude (see console/usage-scan.js's own header, "cache-
// read tokens dominate raw counts by orders of magnitude"). A single "total tokens" figure would
// just be measuring cache hit rate, not the thing worth watching.
//
// Every real `claude -p` call already records its own token counts in an `llm-call` event
// (steps/llm.js's extractTokens, journaled as freshInputTokens/cacheCreationTokens/
// cacheReadTokens/outputTokens/billableTokens/tokensSource) -- this module only adds them up.
// There is no second ledger to keep in sync.
//
// One caller: `spo tokens` (`spo cost` stays as a deprecated alias -- see bin/spo), the soak's
// read-out (per task, and the aggregate).
//
// A task that parked and was retried keeps every attempt's tokens, because every attempt is in
// its journal -- which is the honest number for "what did this card cost", not the cost of the
// successful pass alone.
//
// ---- Cache-expiry flag (advisory, reporting only) --------------------------------------------
//
// The `claude` CLI's prompt cache has (at least) two ephemeral TTL tiers -- 5 minutes and 1 hour
// (a live session file's `cache_creation.ephemeral_1h_input_tokens` /
// `ephemeral_5m_input_tokens` confirm this pipeline's calls land in the 1-hour bucket). When the
// gap between two calls that share a cached prefix exceeds that TTL, the cache expires and the
// next call re-pays CACHE CREATION on the whole preamble (measured at roughly 40k tokens for a
// PLAN/IMPLEMENT call, config.js's cwdForStep comment) instead of getting a near-free cache read.
//
// `likelyCacheExpiry` (computeLikelyCacheExpiries below) is a DERIVED, ADVISORY signal only: for
// consecutive llm-call events within one task, a call is flagged when the gap since the
// previous call's `ts` exceeds `config.cacheTtlMs` AND that call's own cache-creation tokens
// exceed its cache-read tokens (the fingerprint of a fresh prefix write rather than a hit). This
// is EVIDENCE of an expiry, never PROOF: the cache could have been evicted earlier for an
// unrelated reason, or the two calls might never have shared a prefix at all -- hence the name
// `likelyCacheExpiry`, deliberately not `cacheExpired`. Nothing here reports a "wasted tokens"
// estimate, only the cache-creation tokens the flagged call actually spent, which is a measured
// number. And nothing here changes behavior: this is reporting only (maintainer instruction,
// 2026-08-31, "not saying we should STOP a session, but flag this") -- never a park, never a
// retry, never read by the state machine.

const fs = require('fs');
const path = require('path');
const config = require('./config');

// formatTokenCount(n) -- readable large-number formatting: raw 9-digit integers (cache-read
// counts routinely run into the millions -- see console/usage-scan.js's own header) are
// unreadable in a fixed-width table column or a GitHub comment alike. >=1M -> "12.3M", >=1k ->
// "215.4k", otherwise the plain rounded integer. Formerly a private helper duplicated nowhere but
// living only in bin/spo (cmdTokens/cmdResume) -- action 5.2 needed the exact same formatting for
// the Done/park comments (steps/scripted.js, park-loop.js) and bin/spo is a CLI entry point, not
// somewhere those two want to require from, so this moved to tokens.js instead: the module both
// already read token data FROM, and the natural home for "how a token count is displayed" now
// that more than one caller needs it. bin/spo re-exports/re-uses this one, not a second copy.
function formatTokenCount(n) {
  const v = typeof n === 'number' ? n : 0;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

// computeLikelyCacheExpiries(calls, cacheTtlMs) -- calls: [{ts, cacheCreationTokens,
// cacheReadTokens}], in the order they were journaled (never re-sorted -- a re-sort could paper
// over a genuinely out-of-order write). Returns a same-length boolean array; index 0 is never
// flagged (there is no previous call to have expired against).
function computeLikelyCacheExpiries(calls, cacheTtlMs) {
  const flags = calls.map(() => false);
  for (let i = 1; i < calls.length; i++) {
    const prevTs = Date.parse(calls[i - 1].ts);
    const curTs = Date.parse(calls[i].ts);
    if (!Number.isFinite(prevTs) || !Number.isFinite(curTs)) continue;
    const gapMs = curTs - prevTs;
    const cc = calls[i].cacheCreationTokens || 0;
    const cr = calls[i].cacheReadTokens || 0;
    const substantialCacheCreation = cc > 0 && cc > cr;
    if (gapMs > cacheTtlMs && substantialCacheCreation) flags[i] = true;
  }
  return flags;
}

// One task's journal, reduced. Missing/unreadable lines are skipped rather than thrown on: a
// journal being appended to while we read it must never crash the daemon that is writing it.
function readTaskTokens(journalRoot, id, { cacheTtlMs } = {}) {
  const ttl = typeof cacheTtlMs === 'number' ? cacheTtlMs : config.cacheTtlMs;
  const file = path.join(journalRoot, id, 'journal.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // not a task directory (no journal) -- caller filters it out
  }

  let freshInputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let llmCalls = 0;
  let llmCallsWithTokens = 0;
  let llmCallsWithoutTokens = 0;
  const parkReasons = [];
  const calls = []; // [{ts, step, cacheCreationTokens, cacheReadTokens}] -- in journal order
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a torn final line while the daemon writes -- skip, do not throw
    }
    if (event.event === 'llm-call') {
      llmCalls += 1;
      // `tokensSource` is the ONLY honest "did this call report tokens at all" marker (see
      // steps/llm.js's extractTokens): 'modelUsage' when the CLI carried at least one
      // recognized field, null on a call that died before one existed (deadline kill, E2BIG,
      // non-JSON stdout), and ABSENT ENTIRELY on every journal written before token capture
      // shipped -- those events carry the retired `costUsd` and nothing else. All three of the
      // latter must read as "not reported", never as a genuine zero: without this counter
      // `spo tokens` over a pre-change journal prints a full table of 0s that is
      // indistinguishable from "this run used no tokens", which is the single most misleading
      // thing this report could say. bin/spo's cmdTokens prints "n/a" (not 0) for a task with
      // no reporting calls, plus a footer naming how many calls lacked the fields.
      if (typeof event.tokensSource === 'string' && event.tokensSource) llmCallsWithTokens += 1;
      else llmCallsWithoutTokens += 1;
      const fi = typeof event.freshInputTokens === 'number' ? event.freshInputTokens : 0;
      const cc = typeof event.cacheCreationTokens === 'number' ? event.cacheCreationTokens : 0;
      const cr = typeof event.cacheReadTokens === 'number' ? event.cacheReadTokens : 0;
      const out = typeof event.outputTokens === 'number' ? event.outputTokens : 0;
      freshInputTokens += fi;
      cacheCreationTokens += cc;
      cacheReadTokens += cr;
      outputTokens += out;
      calls.push({ ts: event.ts, step: event.step, cacheCreationTokens: cc, cacheReadTokens: cr });
    } else if (event.event === 'parked') {
      parkReasons.push(event.reason);
    }
  }

  let state = 'UNKNOWN';
  // action 5.5, item A: `kind` read alongside `state` so tokenReport() below can exclude a
  // synthetic/demo task from its done/parked/abandoned counts the SAME way
  // console/collect.js's collectDaemonStats does (that module's own `isCardKind` comment has the
  // full rationale -- not repeated here). '' when the field is absent, same fallback shape
  // collectJournalTasks uses, so "no kind at all" reads as a real card on both sides.
  let kind = '';
  try {
    const stateJson = JSON.parse(fs.readFileSync(path.join(journalRoot, id, 'state.json'), 'utf8'));
    state = stateJson.state || 'UNKNOWN';
    kind = stateJson.kind || '';
    // state.json is the primary, but fall back to task.json exactly as collect.js's
    // collectJournalTasks does (`state.kind || task.kind || ''`). Without the fallback the two
    // sides can disagree on the same task -- a state.json with no `kind` beside a task.json
    // saying `synthetic` would be excluded by the dashboard and counted here -- which is the
    // 5.4 agreement this filter had to preserve, broken by the filter meant to preserve it.
    if (!kind) {
      try {
        kind = JSON.parse(fs.readFileSync(path.join(journalRoot, id, 'task.json'), 'utf8')).kind || '';
      } catch {
        /* no task.json, or unreadable -- '' means "a real card", same as collect.js */
      }
    }
  } catch {
    // a task taken but not yet snapshotted -- UNKNOWN is the honest answer
  }

  const expiryFlags = computeLikelyCacheExpiries(calls, ttl);
  const likelyCacheExpiries = calls
    .map((c, i) => (expiryFlags[i] ? { step: c.step, ts: c.ts, cacheCreationTokens: c.cacheCreationTokens } : null))
    .filter(Boolean);

  return {
    id,
    state,
    kind,
    llmCalls,
    llmCallsWithTokens,
    llmCallsWithoutTokens,
    freshInputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    billableTokens: freshInputTokens + cacheCreationTokens + outputTokens,
    parkReasons,
    likelyCacheExpiries,
  };
}

// ---- the intake half of the ledger (SPO-Pipeline#117) ----------------------------------------
//
// An intake stage (DRAFT_CARD, REVIEW_CARD, TRIAGE_BUG_REPORT) has no task directory -- there is
// no card yet when it runs -- so orchestrator/intake.js journals its `llm-call` events into
// <journalRoot>/daemon.jsonl instead, in the SAME shape steps/llm.js writes into a task journal.
// Two files, one event type, one definition of "billable": `accumulateLlmCall` below is the
// single reduction both sides go through, so a future change to what counts can only be made in
// one place.
//
// Until 2026-09-04 nothing wrote those events and nothing read them, and every figure this
// module produced was short by the whole of intake -- 58 auto-triage cycles' worth in the
// measured corpus, against 110 task-journal calls. `spo status` shipped a caveat line saying so
// out loud because the number could not be made honest any other way; that line is gone, because
// it is no longer true.

// One `llm-call` event folded into a mutable accumulator. `tokensSource` -- never
// `typeof billableTokens === 'number'` -- is the honest "did this call report tokens at all"
// marker: a killed/E2BIG call journals a numeric zero that is NOT the same fact as "reported
// zero". See readTaskTokens's own comment for the full rationale, not repeated here.
function accumulateLlmCall(acc, event) {
  acc.llmCalls += 1;
  if (typeof event.tokensSource === 'string' && event.tokensSource) acc.llmCallsWithTokens += 1;
  else acc.llmCallsWithoutTokens += 1;
  const fi = typeof event.freshInputTokens === 'number' ? event.freshInputTokens : 0;
  const cc = typeof event.cacheCreationTokens === 'number' ? event.cacheCreationTokens : 0;
  const cr = typeof event.cacheReadTokens === 'number' ? event.cacheReadTokens : 0;
  const out = typeof event.outputTokens === 'number' ? event.outputTokens : 0;
  acc.freshInputTokens += fi;
  acc.cacheCreationTokens += cc;
  acc.cacheReadTokens += cr;
  acc.outputTokens += out;
  return { freshInputTokens: fi, cacheCreationTokens: cc, cacheReadTokens: cr, outputTokens: out };
}

function emptyAccumulator() {
  return {
    llmCalls: 0,
    llmCallsWithTokens: 0,
    llmCallsWithoutTokens: 0,
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };
}

// Every `llm-call` line of <journalRoot>/daemon.jsonl, reduced. `onEvent` (optional) is called
// for each one BEFORE it is folded in, and returning false skips it -- todaySpend uses that to
// apply its own day filter without a second copy of the parse loop.
//
// Missing file -> a zeroed row, never null: "no intake calls recorded" and "no daemon journal
// yet" are the same answer for every caller here, and a null would make each of them invent its
// own fallback. Unparsable lines are skipped, same posture as readTaskTokens: daemon.jsonl is
// appended to by the dispatcher and every worker at once (see the multi-process append policy in journal.js's own header),
// so a torn final line while we read must never throw.
function readIntakeTokens(journalRoot, { onEvent } = {}) {
  const acc = emptyAccumulator();
  const calls = [];
  let raw;
  try {
    raw = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  } catch {
    return { ...acc, billableTokens: 0, calls };
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.event !== 'llm-call') continue;
    if (onEvent && onEvent(event) === false) continue;
    accumulateLlmCall(acc, event);
    calls.push({ ts: event.ts, step: event.step });
  }
  return {
    ...acc,
    billableTokens: acc.freshInputTokens + acc.cacheCreationTokens + acc.outputTokens,
    calls,
  };
}

function listTaskIds(journalRoot) {
  try {
    return fs
      .readdirSync(journalRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// tokenReport(journalRoot, {cacheTtlMs}) -> {tasks: [...], freshInputTokens, cacheCreationTokens,
// cacheReadTokens, outputTokens, billableTokens, done, parked, parks, likelyCacheExpiries,
// billableTokensPerDoneCard}
//
// `parks` counts park EVENTS, not parked tasks: a card can park several times and still reach
// DONE (issue-247 parked 6 times), and the two numbers answer different questions -- which is
// exactly the distinction the soak needs to report. `cacheTtlMs` defaults to config.js's
// cacheTtlMs; a caller (a test, mainly) can shorten it instead of fabricating hour-long
// timestamps.
function tokenReport(journalRoot, { cacheTtlMs } = {}) {
  const tasks = [];
  for (const id of listTaskIds(journalRoot)) {
    const row = readTaskTokens(journalRoot, id, { cacheTtlMs });
    if (row) tasks.push(row);
  }

  // The intake stages' own calls, from daemon.jsonl -- they have no task directory to appear as a
  // row (see readIntakeTokens's header). Reported SEPARATELY as `intake` so a caller can still
  // show where the spend went, and folded into every aggregate below, because "what did this run
  // cost" has always meant the whole run. Before SPO-Pipeline#117 this was simply missing: the
  // totals were the task journals alone and said so nowhere.
  const intake = readIntakeTokens(journalRoot);

  const sum = (key) => tasks.reduce((s, t) => s + t[key], 0) + intake[key];
  const freshInputTokens = sum('freshInputTokens');
  const cacheCreationTokens = sum('cacheCreationTokens');
  const cacheReadTokens = sum('cacheReadTokens');
  const outputTokens = sum('outputTokens');
  const billableTokens = sum('billableTokens');
  const llmCalls = sum('llmCalls');
  const llmCallsWithTokens = sum('llmCallsWithTokens');
  const llmCallsWithoutTokens = sum('llmCallsWithoutTokens');
  // action 5.5, item A: exclude a synthetic/demo task the same way console/collect.js's
  // collectDaemonStats does (`isCardKind` there), so this module's done/parked/abandoned
  // denominator keeps agreeing with the dashboard's -- see the constraint in that module's own
  // comment: excluding synthetics on one side without the other reopens exactly the
  // `parking rate` disagreement action 5.4/item G just closed. Not folded into `sum()`'s
  // freshInputTokens/cacheCreationTokens/etc. totals above -- those answer "what did this run
  // cost", which a demo run's own (typically negligible) tokens are honestly part of; only the
  // done/parked/abandoned CLASSIFICATION that feeds the parking-rate ratio needs to match.
  // Denylist, mirroring console/collect.js's isCardKind exactly -- the two must stay identical or
  // 5.4's parking-rate agreement breaks. An allowlist would delete any future real kind from both
  // sides at once, silently.
  const isCardKindTask = (t) => t.kind !== 'synthetic';
  const done = tasks.filter((t) => t.state === 'DONE' && isCardKindTask(t)).length;
  const parked = tasks.filter((t) => t.state === 'PARKED' && isCardKindTask(t)).length;
  // action 5.4, item G: ABANDONED is the third terminal state (state-machine.js/park-loop.js
  // action 4.5) but this module never counted it -- `done`/`parked` were the only two buckets
  // tokenReport ever had. console/collect.js's collectDaemonStats already made ABANDONED
  // terminal for the DASHBOARD'S parking rate (its `stats.total = done + parked + abandoned`),
  // and this half was never updated to match: measured live 2026-09-01, `spo tokens` printed
  // "parking rate: 17% (3/18 terminal)" while the dashboard's own denominator for the identical
  // corpus was 19 -- the dashboard counted an abandoned card as terminal and `spo tokens` didn't.
  // Exposed here so bin/spo's cmdTokens can build the SAME denominator collect.js does (see that
  // module's own comment for why the numerator stays `parked` alone -- an abandon is a terminal
  // outcome the card is closed out on, not a park still awaiting a reply).
  const abandoned = tasks.filter((t) => t.state === 'ABANDONED' && isCardKindTask(t)).length;
  const parks = tasks.reduce((n, t) => n + t.parkReasons.length, 0);
  const likelyCacheExpiries = tasks.reduce((n, t) => n + t.likelyCacheExpiries.length, 0);

  return {
    tasks,
    intake,
    freshInputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    billableTokens,
    llmCalls,
    llmCallsWithTokens,
    llmCallsWithoutTokens,
    done,
    parked,
    abandoned,
    parks,
    likelyCacheExpiries,
    // The billable spend of the WHOLE run (every task, parked attempts included, and since
    // SPO-Pipeline#117 the intake/triage calls that produced the cards in the first place) over
    // the number of cards that reached DONE -- same "honest cost, not just the successful pass"
    // semantics orchestrator/cost.js's cost-per-DONE-card used, carried forward unit-for-unit.
    // null both when no card reached DONE and when NOT ONE call reported tokens: a "0 per DONE
    // card" printed off journals that never recorded a token field is a false measurement, not a
    // small one -- the caller renders null as "n/a", never as 0.
    billableTokensPerDoneCard: done > 0 && llmCallsWithTokens > 0 ? billableTokens / done : null,
  };
}

function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// todaySpend(journalRoot, {now}) -- action 5.4, item D: `spo status`'s "today's spend" line.
// Sums the SAME `llm-call` fields tokenReport does (no second ledger, no second definition of
// "billable"), filtered to events whose `ts` falls on `now`'s local calendar day. Every honesty
// rule tokenReport/cmdTokens already enforce applies here verbatim: `tokensSource` is the marker
// for "did this call report tokens at all", never `typeof billableTokens === 'number'` (a
// killed/E2BIG call journals a numeric `billableTokens: 0` via ZERO_TOKENS, which is not the same
// fact as "reported zero tokens" -- see steps/llm.js's own header). The caller renders "n/a", not
// "0", when `llmCallsWithTokens === 0`.
//
// Erratum CLOSED, 2026-09-04 (SPO-Pipeline#117). This used to scan the per-task journals only,
// and journal/daemon.jsonl -- where the intake stages run -- carried ZERO `llm-call` events of
// any kind, so every figure returned here was short by an unknown amount and bin/spo's cmdStatus
// printed a caveat line saying so. orchestrator/intake.js now journals one `llm-call` per call
// into daemon.jsonl, and this function reads BOTH sides through the same accumulator (see
// readIntakeTokens above). The caveat line is gone with the gap it described.
//
// The day filter is applied identically to both sides: `ts` on `now`'s LOCAL calendar day, one
// rule, one midnight (see console/usage-scan.js's localDateKey for why local and not UTC).
function todaySpend(journalRoot, { now = Date.now() } = {}) {
  const dayStart = startOfDay(now);
  const onToday = (event) => {
    const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    return Number.isFinite(ts) && ts >= dayStart;
  };

  // Intake first, so the same accumulator carries both halves and there is no second place where
  // "billable" is spelled out.
  const acc = emptyAccumulator();
  const intake = readIntakeTokens(journalRoot, { onEvent: onToday });
  for (const key of Object.keys(acc)) acc[key] += intake[key];

  for (const id of listTaskIds(journalRoot)) {
    const file = path.join(journalRoot, id, 'journal.jsonl');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // not a task directory (no journal)
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a torn final line while the daemon writes -- skip, do not throw
      }
      if (event.event !== 'llm-call') continue;
      if (!onToday(event)) continue;
      accumulateLlmCall(acc, event);
    }
  }

  const { freshInputTokens, cacheCreationTokens, cacheReadTokens, outputTokens, llmCalls, llmCallsWithTokens, llmCallsWithoutTokens } = acc;
  const billableTokens = freshInputTokens + cacheCreationTokens + outputTokens;

  return {
    freshInputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    billableTokens,
    intake,
    llmCalls,
    llmCallsWithTokens,
    llmCallsWithoutTokens,
  };
}

module.exports = { tokenReport, readTaskTokens, readIntakeTokens, todaySpend, computeLikelyCacheExpiries, formatTokenCount };
