'use strict';
// comment-scan.js -- action 2.7: the shared comment-scanning core behind park-loop.js's
// unparkScan (retry/abandon) and report-intake.js's reportConfirmScan (confirm/discard). Both
// used to hand-roll the identical "fetch this issue's comments, keep the ones after an anchor,
// act on the first one matching a hand-off word" idiom, and both carried the same three bugs
// (each caller's own header used to admit the first):
//
//   (a) ONE PAGE. `gh api repos/<repo>/issues/<n>/comments` with no `-f page=` reads GitHub's
//       default page (30 comments). A card with more than 30 comments after the anchor comment
//       silently stopped seeing new replies -- no error, just nothing happening, forever.
//   (b) NO AUTHOR ALLOWLIST. Any commenter at all -- not just a collaborator -- could post
//       "retry"/"abandon"/"confirm"/"discard" and drive the pipeline.
//   (c) NO BACKOFF. A `gh` call failing every cycle was retried every cycle at full rate.
//
// This module owns what both callers share -- "fetch this issue's comments after this anchor,
// from an authorized author, with a page bound and a backoff" (`scanForMatch`, below). What
// still differs between the two -- which words count as a match (retry/abandon vs
// confirm/discard), what anchor a caller already tracks, what happens on a match, and where a
// scan-level fact gets journalled (a task's own journal.jsonl for park-loop.js, daemon.jsonl for
// report-intake.js, which has no task directory for a pending report) -- stays with the caller.
// `scanForMatch`'s own `journal(event, detail)` callback and `events` map are exactly that seam.
//
// ---- (a) pagination -----------------------------------------------------------------------
//
// `fetchCommentsAfterAnchor` pages forward with `?per_page=100&page=N` in the path, collecting every
// comment whose id is greater than the anchor, until a page comes back shorter than 100 (the
// natural end of the list) or `maxPages` is reached. It does NOT stop early on the first match:
// simpler and more predictable than trying to reason about "is there an earlier authorized
// match on a later page" mid-scan, and at 100/page even the DEFAULT_MAX_PAGES bound below is a
// couple of extra `gh api` calls at most for any issue that isn't actively pathological.
//
// DEFAULT_MAX_PAGES = 20 (2000 comments) is the sane bound the plan asked for: no real card in
// this pipeline's own history has come close (card #385, the long-lived-park example the plan
// itself cites, had 9 park events total, not 2000 comments), and 2000 is still cheap -- 20 `gh`
// calls at the `gh` command-class timeout, worst case. Hitting the bound must not look like "no
// reply": `truncated: true` comes back to the caller, which journals it under its OWN event name
// (`unpark-scan-truncated` / `report-confirm-scan-truncated`) so it reads distinguishably from
// the ordinary "scanned everything, nothing matched" case, which journals nothing at all (same
// as before this rewrite -- a human conversation on the issue is allowed).
//
// ---- (b) author allowlist -------------------------------------------------------------------
//
// `getCollaborators` reads `gh api repos/<repo>/collaborators --paginate` once per repo and
// caches the login set in `scanState.collaborators` (a Map owned by the CALLER -- see
// `createScanState` -- so it lives exactly as long as the caller wants it to: a fresh Map for a
// one-off call, or one created outside `runForever`'s loop and threaded through every cycle so
// the whole daemon lifetime only pays for this once per hour per repo). A successful read is
// trusted for `COLLAB_TTL_OK_MS` (1h -- long enough that a 60s-cadence scan never re-fetches it
// every cycle, short enough that adding/removing a collaborator takes effect the same day, not
// indefinitely stuck behind a still-"fresh" cache). A FAILED read is retried sooner
// (`COLLAB_TTL_FAIL_MS`, 5m), not held for the full hour, so a transient `gh` hiccup heals itself
// quickly instead of leaving the repo running in whatever mode the failure produced for an hour.
//
// What a failed read produces is the one genuinely hard call this action makes:
//   - If a PREVIOUS successful read exists (just past its TTL), that stale-but-known-good list
//     is reused, journalled `comment-scan-collaborators-stale` -- a transient failure must not
//     suddenly accept commands from a non-collaborator just because the cache aged out at the
//     wrong moment.
//   - If NO read has ever succeeded for this repo (wrong `gh` scope, a revoked token, a renamed
//     repo -- anything that makes the endpoint permanently unreadable), this fails OPEN:
//     `isAuthorized` treats everyone as authorized, journalled `comment-scan-collaborators-
//     unreadable` on every occurrence, not just the first. Failing CLOSED here would silently
//     and permanently lock the maintainer's own "retry"/"confirm" out with no error a human would
//     ever see -- worse than the authorization gap this action exists to close. This is the
//     ONLY case that fails open, and it is loud every time, by design.
//
// A comment with no identifiable author (`comment.user` missing or without a `.login`) is NOT
// authorized. That is the opposite of the fail-open above, and deliberately so: an unreadable
// COLLABORATOR LIST is an infrastructure failure that must not lock the maintainer out, whereas
// an authorless COMMENT is untrusted input whose shape we cannot vouch for. GitHub does emit a
// null `user` for a deleted (ghost) account, and an allowlist that any payload can bypass by
// omitting a field is decorative. The distinction to hold on to: we fail open on our own
// inability to check, never on the input's failure to identify itself.
//
// ---- (c) backoff ----------------------------------------------------------------------------
//
// Backoff is keyed per (repo, issue) -- `scanState.backoff` -- not globally per scanner: a `gh`
// call that keeps failing for ONE stuck issue (e.g. deleted, permanently 404) should not also
// suppress a scan of every OTHER parked task or pending report sharing the same repo. The first
// failure never backs off (a single blip is exactly what the next ordinary cycle is for);
// `BACKOFF_BASE_MS` * 2^(failures-2), capped at `BACKOFF_MAX_MS` (30m), from the second
// consecutive failure on. A success resets it to zero. `checkBackoff`'s skip is journalled
// through the caller's own `journal` callback (task-scoped for park-loop.js, daemon-scoped for
// report-intake.js) -- backoff IS issue-specific here, so it belongs wherever that issue's other
// scan facts already go.
//
// ---- the dedicated timer (bullet 4 of the plan) ----------------------------------------------
//
// This module does not itself schedule anything -- state-machine.js's runForever creates one
// `createScanState()` per scanner outside its `for (;;)` loop (so the collaborator cache and the
// backoff table survive across cycles) and gates `unparkScan`/`reportConfirmScan` on their own
// timers (`config.unparkScanMs` / `config.reportConfirmScanMs`, both nonzero by default). Per the
// plan: on a single-threaded daemon that blocks inside whatever step is running, a timer only
// guarantees "not more often than N" until chantier 6 gives the daemon real concurrency -- it
// does NOT guarantee cadence. Tests here and in park-loop.test.js/report-intake.test.js assert
// per-cycle behaviour (the gate fires when due, is skipped when not, backs off on failure) and
// never assert real-time cadence.

const { appendDaemonEvent } = require('./journal');
const { armTimeout } = require('./command-timeout');

function runSync(deps, command, args, opts = {}, config) {
  return armTimeout(deps, config, command, args, opts);
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

function firstLine(text) {
  return ((text || '').split('\n')[0] || '').trim();
}

const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 20; // 20 * 100 = 2000 comments -- see header

const COLLAB_TTL_OK_MS = 60 * 60 * 1000; // successful read: trust it for an hour
const COLLAB_TTL_FAIL_MS = 5 * 60 * 1000; // failed read: retry in 5 minutes, not the full hour

const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

// createScanState() -- one of these per SCANNER (not per issue, not per call): a fresh one is
// fine for a one-off/test invocation, but state-machine.js's runForever creates exactly one per
// scanner outside its poll loop so the collaborator cache and backoff table persist across
// cycles the way a real cache/backoff needs to.
function createScanState() {
  return { collaborators: new Map(), backoff: new Map() };
}

// ---- (a) pagination --------------------------------------------------------------------------

// fetchCommentsAfterAnchor({deps, config, ghRepo, issue, anchorId, maxPages}) -- pages forward
// through `gh api repos/<repo>/issues/<n>/comments`, `per_page=100`, collecting every comment
// whose numeric id exceeds `anchorId` (GitHub comment ids are monotonically increasing
// site-wide -- see park-loop.js's own header for why that means "posted after the anchor" needs
// no timestamp). Stops at the first page shorter than 100 (the true end of the list) or at
// `maxPages`, whichever comes first.
//
// The page/per_page parameters go in the PATH as a query string, never through `gh api -f`.
// `gh api` defaults to GET, but ANY `-f`/`-F` field flips it to POST unless `--method GET` is
// also passed -- so the first cut of this function, `['api', '<path>', '-f', 'per_page=100',
// '-f', 'page=1']`, POSTed to the *create an issue comment* endpoint on every single scan and
// got `422 "body" wasn't supplied` back, forever. Reproduced live 2026-08-31 against issue 213:
// the `-f` form exits 1 with that 422; the same call as a query string returns the 4 comments.
//
// Two things that made it costly. It failed CLOSED only by accident -- the POST was rejected
// solely because no `body` field was supplied, so a later edit adding one would have had the
// daemon posting real comments onto live issues instead of reading them. And every
// `unpark-scan-failed` event this produced looked exactly like the transient `gh` flakiness the
// audit had already catalogued as journal spam, which is why 1164 of them read as noise rather
// than as "the retry channel has never once worked".
//
// The hermetic suite cannot catch this class by mocking alone: it stubs `runSync`, so it asserts
// the argv and never learns what `gh` does with it. The standing guard is therefore a source
// sweep -- see test/gh-api-argv.test.js, which fails on any `gh api` call site anywhere in the
// repo that passes `-f`/`-F` without an explicit `--method`/`-X`.
// `anchorId` is the boundary when the park comment landed; `sinceMs` is the boundary when it
// did not (issue #77 -- see park-loop.js's findParkAnchor for why both exist). Exactly one is
// used, id first: a comment id is an exact "after this comment", while a timestamp is only
// "after this moment" and so is very slightly wider. Wider is the correct direction to err --
// the failure being fixed is not seeing the maintainer's `retry` at all.
//
// With NEITHER, nothing is collected. That is deliberate and is the safe end: scanning every
// comment on the issue would let a `retry` from a previous park cycle re-trigger this one.
function fetchCommentsAfterAnchor({ deps = {}, config, ghRepo, issue, anchorId, sinceMs, maxPages }) {
  const hasId = typeof anchorId === 'number' && Number.isFinite(anchorId);
  const hasSince = !hasId && typeof sinceMs === 'number' && Number.isFinite(sinceMs);
  const isAfterAnchor = (c) => {
    if (hasId) return typeof c.id === 'number' && c.id > anchorId;
    if (!hasSince) return false;
    const createdAt = Date.parse(c.created_at);
    // An unparseable or absent `created_at` cannot be placed relative to the boundary. Keep
    // it: a comment the scan cannot date is better matched than silently dropped, and the
    // author allowlist and pattern match still have to accept it.
    return !Number.isFinite(createdAt) || createdAt >= sinceMs;
  };
  const bound = Number.isInteger(maxPages) && maxPages > 0 ? maxPages : DEFAULT_MAX_PAGES;
  const collected = [];

  for (let page = 1; page <= bound; page++) {
    const result = runSync(
      deps,
      'gh',
      ['api', `repos/${ghRepo}/issues/${issue}/comments?per_page=${PER_PAGE}&page=${page}`],
      {},
      config
    );
    if (normalizeExit(result) !== 0) {
      return { ok: false, reason: 'gh-failed', exit: normalizeExit(result), timedOut: result.timedOut === true };
    }

    let batch;
    try {
      batch = JSON.parse(result.stdout);
    } catch {
      return { ok: false, reason: 'unparsable' };
    }
    if (!Array.isArray(batch)) batch = []; // parsed but not a list -- same as "nothing on this page"

    for (const c of batch) {
      if (c && typeof c.id === 'number' && isAfterAnchor(c)) collected.push(c);
    }

    if (batch.length < PER_PAGE) {
      collected.sort((a, b) => a.id - b.id);
      return { ok: true, comments: collected, truncated: false, pagesScanned: page };
    }
  }

  // `maxPages` reached and the last page fetched was still full -- there may be more comments
  // this cycle refuses to keep paying for. Never silently indistinguishable from "no reply": the
  // caller journals `truncated: true` under its own event name.
  collected.sort((a, b) => a.id - b.id);
  return { ok: true, comments: collected, truncated: true, pagesScanned: bound };
}

// ---- (b) author allowlist ----------------------------------------------------------------------

function fetchCollaboratorLogins(deps, config, ghRepo) {
  const result = runSync(deps, 'gh', ['api', `repos/${ghRepo}/collaborators`, '--paginate'], {}, config);
  if (normalizeExit(result) !== 0) return null;
  let list;
  try {
    list = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const logins = new Set();
  for (const c of list) {
    if (c && typeof c.login === 'string') logins.add(c.login.toLowerCase());
  }
  return logins;
}

// getCollaborators(...) -> {logins: Set<string>|null, ok, failOpen, fetchedAt}. See this
// module's header for the stale-vs-fail-open decision. `scannerKey` ('unpark' / 'report-confirm')
// only labels the journal entry -- the cache itself is keyed by ghRepo, shared across scanners
// that happen to point at the same repo (they always do, today, but nothing requires it).
function getCollaborators(deps, config, ghRepo, scanState, journalRoot, scannerKey, nowMs) {
  const cached = scanState.collaborators.get(ghRepo);
  const ttl = cached && cached.ok ? COLLAB_TTL_OK_MS : COLLAB_TTL_FAIL_MS;
  if (cached && nowMs - cached.fetchedAt < ttl) return cached;

  const logins = fetchCollaboratorLogins(deps, config, ghRepo);
  if (logins) {
    const entry = { logins, ok: true, failOpen: false, fetchedAt: nowMs };
    scanState.collaborators.set(ghRepo, entry);
    return entry;
  }

  if (cached) {
    appendDaemonEvent(journalRoot, 'comment-scan-collaborators-stale', {
      scanner: scannerKey,
      ghRepo,
      ageMs: nowMs - cached.fetchedAt,
    });
    return cached; // known-good, just older than COLLAB_TTL_OK_MS -- see header
  }

  appendDaemonEvent(journalRoot, 'comment-scan-collaborators-unreadable', { scanner: scannerKey, ghRepo });
  const entry = { logins: null, ok: false, failOpen: true, fetchedAt: nowMs };
  scanState.collaborators.set(ghRepo, entry);
  return entry;
}

// isAuthorized(collab, comment) -- see the header. Fail-open applies ONLY to our own inability to
// read the collaborator list; a comment that does not identify its author is never authorized.
function isAuthorized(collab, comment) {
  const login =
    comment && comment.user && typeof comment.user.login === 'string' ? comment.user.login.toLowerCase() : null;
  if (!login) return false;
  if (collab.failOpen) return true;
  return collab.logins.has(login);
}

// ---- (c) backoff -------------------------------------------------------------------------------

function backoffKey(ghRepo, issue) {
  return `${ghRepo}#${issue}`;
}

function checkBackoff(scanState, ghRepo, issue, nowMs) {
  const st = scanState.backoff.get(backoffKey(ghRepo, issue));
  if (!st || nowMs >= st.nextAttemptAt) return { skip: false };
  return { skip: true, failures: st.failures, nextAttemptAt: st.nextAttemptAt };
}

// The first failure never backs off -- a single blip is what the next ordinary cycle is for.
// From the second consecutive failure on: BACKOFF_BASE_MS * 2^(failures-2), capped at
// BACKOFF_MAX_MS. A success (recordSuccess) resets this to zero.
function recordFailure(scanState, ghRepo, issue, nowMs) {
  const key = backoffKey(ghRepo, issue);
  const prev = scanState.backoff.get(key) || { failures: 0 };
  const failures = prev.failures + 1;
  const backoffMs = failures < 2 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 2));
  const nextAttemptAt = nowMs + backoffMs;
  scanState.backoff.set(key, { failures, nextAttemptAt });
  return { failures, backoffMs, nextAttemptAt };
}

function recordSuccess(scanState, ghRepo, issue) {
  scanState.backoff.delete(backoffKey(ghRepo, issue));
}

// ---- the scan itself -----------------------------------------------------------------------

// scanForMatch({...}) -- one issue's worth of "fetch after anchor, drop unauthorized authors,
// find the first comment matching one of `patterns`".
//
//   deps, config, ghRepo, issue, anchorId, maxPages -- as fetchCommentsAfterAnchor.
//   patterns    -- [{name, re}], tested against firstLine(comment.body); first REGEX match wins
//                  (ascending id order), then that comment's author is checked.
//   scanState   -- from createScanState(), caller-owned (see its own comment).
//   journalRoot -- for the collaborator-cache facts, which are repo-wide, not issue-specific.
//   journal(event, detail) -- for facts that ARE this issue's own (truncation, an ignored
//                  unauthorized match, a backoff skip) -- the caller decides where these land
//                  (task journal vs daemon journal) and under what event name.
//   events      -- {truncated, ignoredAuthor, backoffSkip} -- the caller's own event names.
//   scannerKey  -- 'unpark' | 'report-confirm', labels the collaborator-cache journal entries.
//   now         -- inject a numeric ms timestamp for tests; defaults to Date.now().
//
// Returns {ok: true, match: {name, comment} | null} or {ok: false, reason, ...}. `reason` is one
// of 'backoff' (skip, already journalled), 'gh-failed' (exit/timedOut carried), or 'unparsable'
// -- the caller maps these onto its own existing failure-event shape (unpark-scan-failed /
// reportConfirmScan's own `errors` entries) so pre-2.7 journal/error text does not change.
async function scanForMatch({
  deps = {},
  config,
  ghRepo,
  issue,
  anchorId,
  sinceMs,
  patterns,
  scanState,
  journalRoot,
  journal,
  events = {},
  scannerKey,
  now,
  maxPages,
}) {
  const nowMs = now !== undefined ? now : Date.now();

  const backoff = checkBackoff(scanState, ghRepo, issue, nowMs);
  if (backoff.skip) {
    journal(events.backoffSkip || 'comment-scan-backoff-skip', {
      failures: backoff.failures,
      retryAt: new Date(backoff.nextAttemptAt).toISOString(),
    });
    return { ok: false, reason: 'backoff' };
  }

  const fetched = fetchCommentsAfterAnchor({ deps, config, ghRepo, issue, anchorId, sinceMs, maxPages });
  if (!fetched.ok) {
    recordFailure(scanState, ghRepo, issue, nowMs);
    return { ok: false, reason: fetched.reason, exit: fetched.exit, timedOut: fetched.timedOut };
  }
  recordSuccess(scanState, ghRepo, issue);

  if (fetched.truncated) {
    journal(events.truncated || 'comment-scan-truncated', {
      pagesScanned: fetched.pagesScanned,
      maxPages: Number.isInteger(maxPages) && maxPages > 0 ? maxPages : DEFAULT_MAX_PAGES,
    });
  }

  const collab = getCollaborators(deps, config, ghRepo, scanState, journalRoot, scannerKey, nowMs);

  let match = null;
  for (const comment of fetched.comments) {
    const hit = patterns.find((p) => p.re.test(firstLine(comment.body)));
    if (!hit) continue;
    if (isAuthorized(collab, comment)) {
      match = { name: hit.name, comment };
      break;
    }
    journal(events.ignoredAuthor || 'comment-scan-ignored-unauthorized', {
      commentId: comment.id,
      author: (comment.user && comment.user.login) || null,
      matched: hit.name,
    });
  }

  return { ok: true, match };
}

module.exports = {
  createScanState,
  scanForMatch,
  fetchCommentsAfterAnchor,
  getCollaborators,
  isAuthorized,
  checkBackoff,
  recordFailure,
  recordSuccess,
  firstLine,
  PER_PAGE,
  DEFAULT_MAX_PAGES,
};
