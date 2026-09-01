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
  try {
    state = JSON.parse(fs.readFileSync(path.join(journalRoot, id, 'state.json'), 'utf8')).state || 'UNKNOWN';
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

  const sum = (key) => tasks.reduce((s, t) => s + t[key], 0);
  const freshInputTokens = sum('freshInputTokens');
  const cacheCreationTokens = sum('cacheCreationTokens');
  const cacheReadTokens = sum('cacheReadTokens');
  const outputTokens = sum('outputTokens');
  const billableTokens = sum('billableTokens');
  const llmCalls = sum('llmCalls');
  const llmCallsWithTokens = sum('llmCallsWithTokens');
  const llmCallsWithoutTokens = sum('llmCallsWithoutTokens');
  const done = tasks.filter((t) => t.state === 'DONE').length;
  const parked = tasks.filter((t) => t.state === 'PARKED').length;
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
  const abandoned = tasks.filter((t) => t.state === 'ABANDONED').length;
  const parks = tasks.reduce((n, t) => n + t.parkReasons.length, 0);
  const likelyCacheExpiries = tasks.reduce((n, t) => n + t.likelyCacheExpiries.length, 0);

  return {
    tasks,
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
    // The billable spend of the WHOLE run (every task, parked attempts included) over the
    // number of cards that reached DONE -- same "honest cost, not just the successful pass"
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
// Measured erratum, worse than the C4 handoff stated (re-measured 2026-09-01, kept here rather
// than re-derived by a caller): journal/daemon.jsonl -- where intake/triage steps
// (report-triaged, auto-triage, report-confirmed) journal their own events -- contains ZERO
// `llm-call` events of ANY kind, and none of those event types carry a cost or token field at
// all. So intake/triage spend is not merely invisible to THIS function (it has no taskDir-shaped
// journal for todaySpend to scan) -- it is not journalled anywhere, by any module, today. Any
// "today's spend" figure this function returns is short by an unknown amount for that reason.
// Fixing the journalling gap is out of scope for this action; the caller (bin/spo's cmdStatus)
// prints this as a caveat alongside the number rather than trying to close the gap here.
function todaySpend(journalRoot, { now = Date.now() } = {}) {
  const dayStart = startOfDay(now);

  let freshInputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let billableTokens = 0;
  let llmCalls = 0;
  let llmCallsWithTokens = 0;
  let llmCallsWithoutTokens = 0;

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
      const ts = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
      if (!Number.isFinite(ts) || ts < dayStart) continue;

      llmCalls += 1;
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
      billableTokens += fi + cc + out;
    }
  }

  return {
    freshInputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    billableTokens,
    llmCalls,
    llmCallsWithTokens,
    llmCallsWithoutTokens,
  };
}

module.exports = { tokenReport, readTaskTokens, todaySpend, computeLikelyCacheExpiries, formatTokenCount };
