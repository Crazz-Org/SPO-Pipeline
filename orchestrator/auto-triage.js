'use strict';
// auto-triage.js -- stages 3+ of the human-first bug-report intake pipeline: reproduction,
// routing, dedup and drafting (intake.triageBugReport) then the SAME reviewCard/fileCard-shaped
// gate every other card here goes through, but ONLY for a report a maintainer has already
// replied "confirm" to (orchestrator/report-intake.js's reportConfirmScan -- stages 1-2, which
// mechanically file a RAW card with zero LLM judgement and wait for that reply). Behind `spo
// triage` (on demand, bin/spo) and, when config.autoTriageMs is set, the daemon's own timer
// (state-machine.js's runForever, real mode only).
//
// Design history, 2026-08-30: this file used to scan ~/.spo-reports directly and file a NEW
// issue per report. That single-stage design let an LLM's reproduction verdict alone decide
// whether something autonomous got filed -- superseded by the current two-stage split (see
// orchestrator/report-intake.js's own header and orchestrator/README.md § Report intake for the
// full argument): nothing here ever runs until a human has read the RAW report and asked for it.
//
// What that changes about disposal: a report that reaches this stage was already judged worth
// pursuing by a human, so a negative outcome from triageBugReport/reviewCard is never silently
// archived -- it is commented on the issue and HELD (report-held), never disposed of unseen. Only
// a `duplicate` or a successful `draft` -> FILE/FILE_AMENDED disposes of the report file (moves
// it to archive/). See routeConfirmedReport's outcome table below.
//
// action 2.6: a report is claimed (moved to in-progress/) BEFORE any of that spends an LLM call,
// so the daemon's own timer and a hand-run `spo triage` can never both act on the same confirmed
// report -- see processConfirmedReport, claimReport and reclaimStaleClaims below, and
// orchestrator/README.md's "The claim mutex" for the full incident and design.
//
// Reuses orchestrator/intake.js end to end: triageBugReport for the reasoning `/triage-report`
// asks a human session to do, then reviewCard (unchanged) and intake.amendCard -- EDITS the
// existing raw-intake issue rather than filing a second one (see amendCard's own header for why
// that is load-bearing for anchorKey dedup, not a style choice).
//
// "The one rule": this file never reads report CONTENT -- it only reads daemon.jsonl's own
// journaled events (issue numbers, file paths, outcomes it already judged) to decide what to
// process next. All schema and reproduction knowledge stays inside the `claude -p` session
// triageBugReport spawns, reasoning against the product tree itself.

const fs = require('fs');
const os = require('os');
const path = require('path');

const intake = require('./intake');
const board = require('./board');
const { appendDaemonEvent } = require('./journal');
const { processAlive } = require('./lock');

const DEFAULT_AUTO_TRIAGE_MS = 15 * 60 * 1000; // maintainer's own call -- see config.js
const DEFAULT_AUTO_TRIAGE_LIMIT = 3;

// action 2.6: the in-progress claim mutex -- see claimReport's own header below for the full
// rationale. Mirrors orphan-scan.js's DEFAULT_ORPHAN_GRACE_MS both in value and in purpose: long
// enough that a live, merely-slow claim (a full Opus reproduction, minutes long) is never
// mistaken for a dead one, short enough that a genuine crash does not sit unrecovered for long.
const DEFAULT_TRIAGE_CLAIM_GRACE_MS = 4 * 60 * 1000;

// How many grace windows a claim may sit unprobed before it is reclaimed regardless of pid or
// host. See reclaimStaleClaims: a report a human confirmed must never become permanently
// invisible, and a foreign hostname or a reused pid would otherwise pin one forever.
const TRIAGE_CLAIM_CEILING_MULTIPLE = 15;
const IN_PROGRESS_DIRNAME = 'in-progress';

// Pure decision function, same shape as auto-pull.js's shouldAutoPull -- no Date.now() baked in,
// a test drives it with any (lastTriageAt, nowMs) pair. autoTriageMs <= 0 disables the timer
// entirely regardless of lastTriageAt.
function shouldAutoTriage(lastTriageAt, nowMs, autoTriageMs) {
  if (!(autoTriageMs > 0)) return false;
  if (lastTriageAt === null || lastTriageAt === undefined) return true;
  return nowMs - lastTriageAt >= autoTriageMs;
}

// ---- action 3.3: mechanical-failure backoff -------------------------------------------------
//
// The 12.8-hour stall (issues 449/455/456, 53 cycles, 128 attempts, 2026-08-30/31) that motivated
// this whole action was not just "no cap" -- it was also "no throttle": even bounded at
// MECHANICAL_FAILURE_CAP attempts, hammering a broken account pool or a wide `claude -p` outage
// once every auto-triage cycle for however many cycles it takes to reach the cap is still real
// spend for zero chance of success once the FIRST failure has already shown the cause is
// mechanical, not reproduction-shaped. These two pure functions are the throttle: doubling wait
// per additional mechanical failure since the report's own report-confirmed anchor, capped so it
// never grows unbounded. See config.js's autoTriageBackoffBaseMs/autoTriageBackoffCeilingMs for
// the defaults and the reasoning behind each -- kept there, not duplicated here, since that is
// the one place a maintainer tunes them.
const DEFAULT_TRIAGE_BACKOFF_BASE_MS = DEFAULT_AUTO_TRIAGE_MS; // 15 min -- one ordinary cycle
const DEFAULT_TRIAGE_BACKOFF_CEILING_MS = 2 * 60 * 60 * 1000; // 2h -- see config.js's own comment

// triageBackoffMs(errorCount, config) -- the wait, in ms, before a report with `errorCount`
// mechanical failures since its confirm anchor becomes eligible again: base * 2^(errorCount-1),
// capped at the ceiling. errorCount <= 0 has nothing to back off from, so 0. The DEFAULT_* consts
// above are only a fallback for a caller that hands in a config missing these two fields entirely
// (e.g. a partial config in a test) -- production always goes through config.js's own resolved
// values.
function triageBackoffMs(errorCount, config) {
  if (!(errorCount > 0)) return 0;
  const base =
    config && config.autoTriageBackoffBaseMs !== undefined
      ? config.autoTriageBackoffBaseMs
      : DEFAULT_TRIAGE_BACKOFF_BASE_MS;
  const ceiling =
    config && config.autoTriageBackoffCeilingMs !== undefined
      ? config.autoTriageBackoffCeilingMs
      : DEFAULT_TRIAGE_BACKOFF_CEILING_MS;
  const raw = base * Math.pow(2, errorCount - 1);
  return Math.min(raw, ceiling);
}

// shouldSkipForTriageBackoff(lastErrorAtMs, nowMs, errorCount, config) -- pure decision function,
// same shape as shouldAutoTriage just above: no Date.now() baked in, a test drives it with any
// (lastErrorAtMs, nowMs, errorCount) triple. A report with no recorded failures (errorCount <= 0)
// or no known last-failure time is never skipped -- there is nothing to back off FROM, and
// inventing a "some time" would either wrongly skip a report's very first attempt or wrongly
// never skip one whose history genuinely cannot be read.
//
// #660: `elapsed` is clamped to a floor of 0. Both `lastErrorAtMs` (parsed from a
// report-triage-error event's own `ts`, written by a PRIOR call, possibly a prior process) and
// `nowMs` (the caller's `Date.now()`, taken just now) are wall-clock, and this box's wall clock is
// documented to jump BACKWARD (monotonic-clock.js's own header: -2515ms measured, twice,
// independently) -- monotonic-clock.js's `monotonicNowMs` is NOT the fix here, on purpose: that
// module exists for "how long have I been retrying" loops within a single process, and explicitly
// forbids using it for a value compared across processes, which `lastErrorAtMs` is (a maintainer's
// `spo triage --retry` can re-run this hours or days, and possibly restarts, after the failure it
// reads). Un-clamped, a backward jump lands here as `nowMs - lastErrorAtMs` going NEGATIVE, which
// is nonsensical (elapsed time cannot be negative) and, unlike every other bounded-wait use of
// wall-clock subtraction in this file, does not just silently "wait a few extra milliseconds": a
// caller that has deliberately set `autoTriageBackoffBaseMs: 0` to disable backoff (the CAP tests
// below, which need three real mechanical failures with nothing throttling between them) sees the
// comparison flip from "never skip" (elapsed >= 0) to "skip" (elapsed < 0) on the very next call
// after a report-triage-error write lands in the same instant the clock hiccups -- reproduced
// deterministically by forcing Date.now() a few ms backward between two runAutoTriage calls.
// Clamping costs nothing in the normal (base > 0, forward-moving clock) case and makes the
// decision correct rather than merely "usually right" in every case.
function shouldSkipForTriageBackoff(lastErrorAtMs, nowMs, errorCount, config) {
  if (!(errorCount > 0)) return false;
  if (lastErrorAtMs === null || lastErrorAtMs === undefined) return false;
  const elapsed = Math.max(0, nowMs - lastErrorAtMs);
  return elapsed < triageBackoffMs(errorCount, config);
}

// listQueuedReports(spoReportsDir) -- the queue's own top-level *.json files (never `pending/` or
// `archive/`, which readdirSync's isFile() filter already excludes since they are directory
// entries, not files), oldest first. SPO-WebClient's doc/bug-reporting.md: filenames are
// <createdAtUtc>_<profile>_<anchorKey>.json, so lexical order IS chronological order. A missing
// directory is an empty queue, not an error. Used by report-intake.js's stage 1; re-exported here
// for backward compatibility with anything still importing it from this file.
function listQueuedReports(spoReportsDir) {
  if (!fs.existsSync(spoReportsDir)) return [];
  return fs
    .readdirSync(spoReportsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(spoReportsDir, name));
}

// moveReportTo(reportPath, targetDir, dispositionLine) -- mv into targetDir/ and write the
// one-line disposition sidecar beside it (triage-report.md § 6's convention, `<file>
// .disposition.txt`), so a maintainer reading the target dir later sees the identical shape
// whether a human or this pipeline moved it there. Shared by report-intake.js (-> pending/,
// -> archive/ on discard) and this file (-> archive/ on duplicate/filed).
function moveReportTo(reportPath, targetDir, dispositionLine) {
  fs.mkdirSync(targetDir, { recursive: true });
  const base = path.basename(reportPath);
  const dest = path.join(targetDir, base);
  fs.renameSync(reportPath, dest);
  fs.writeFileSync(path.join(targetDir, `${base}.disposition.txt`), `${dispositionLine}\n`);
  return dest;
}

// ---- action 2.6: claim mutex for a confirmed report -----------------------------------------
//
// THE BUG THIS CLOSES: findConfirmedAwaitingTriage's "report-confirmed with no later
// report-triaged/report-held" scan is only ever updated by the TERMINAL journal events, which
// land after a full triageBugReport/reviewCard LLM call returns -- minutes, for a real
// reproduction. For that entire window the report still looks eligible to anyone else who scans
// (the daemon's own autoTriageMs timer, a hand-run `spo triage --file`, or two overlapping
// daemon cycles), so both pay for and act on the same report. Measured: report #443 was filed
// AND held 20 seconds apart, and the resulting PR #447 had to be closed by hand.
//
// THE FIX: claim the report's file BEFORE spending the LLM call, by moving it into
// spoReportsDir/in-progress/ with the exact same atomic primitive state-machine.js's
// takeNextTask already uses to claim a queue/ entry -- fs.renameSync. rename() is atomic; the
// loser's call throws ENOENT (its source vanished under it) and it skips cleanly, never calling
// triageBugReport/reviewCard at all. findConfirmedAwaitingTriage's journal scan stays exactly as
// it was -- a necessary but no longer sufficient filter -- this rename is the real gate.

function claimSidecarPath(claimedPath) {
  return `${claimedPath}.claim.json`;
}

// The sidecar records who holds the claim so a crash can be told apart from a slow reproduction
// -- see reclaimStaleClaims below. Written right after the rename succeeds; the brief instant
// before it exists is covered by reclaimStaleClaims' own mtime fallback.
function writeClaimSidecar(claimedPath) {
  const payload = { pid: process.pid, host: os.hostname(), claimedAt: new Date().toISOString() };
  fs.writeFileSync(claimSidecarPath(claimedPath), JSON.stringify(payload));
}

function readClaimSidecar(claimedPath) {
  try {
    return JSON.parse(fs.readFileSync(claimSidecarPath(claimedPath), 'utf8'));
  } catch {
    return null; // missing or torn -- reclaimStaleClaims falls back to the report file's mtime
  }
}

function removeClaimSidecar(claimedPath) {
  try {
    fs.unlinkSync(claimSidecarPath(claimedPath));
  } catch {
    // Already gone, or never written (a caller that never got as far as claiming) -- nothing to
    // clean up either way.
  }
}

// claimReport(spoReportsDir, pendingPath) -> {claimed: true, path} | {claimed: false}
//
// One atomic fs.renameSync, same primitive and same race semantics as takeNextTask's queue
// claim: exactly one caller's rename succeeds (its source existed), every other caller racing
// the SAME pendingPath gets ENOENT (their source vanished under them) and is told `claimed:
// false` -- never a throw, never a crash, the loser just has nothing left to do.
function claimReport(spoReportsDir, pendingPath) {
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  const dest = path.join(inProgressDir, path.basename(pendingPath));
  try {
    fs.renameSync(pendingPath, dest);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { claimed: false };
    throw err;
  }
  // Stamp the claim time onto the file itself, BEFORE the sidecar exists. fs.renameSync PRESERVES
  // mtime, and a report file is named for when the player filed it and then sits in pending/
  // awaiting a human confirm -- hours or days. So the sidecar-less fallback in reclaimStaleClaims
  // would read that original mtime, judge every fresh claim instantly stale, and reclaim a LIVE
  // claim out from under its owner during the window between this rename and the sidecar write.
  // That re-opens the exact double-triage this action closes. Stamping here makes the file's own
  // mtime mean "when it was claimed", which is what that fallback needs it to mean.
  try {
    const now = new Date();
    fs.utimesSync(dest, now, now);
  } catch {
    // Best effort: a filesystem that refuses utimes still has the sidecar, written next.
  }
  writeClaimSidecar(dest);
  return { claimed: true, path: dest };
}

// reclaimStaleClaims(journalRoot, config, deps) -- recovers a claim stranded by a process that
// died mid-triage (crashed daemon, killed `spo triage --file`) so that report is never lost
// permanently: without this, a file moved into in-progress/ is invisible to
// findConfirmedAwaitingTriage's own "confirmed, not yet triaged/held" scan (it only reads
// daemon.jsonl, never the filesystem) AND to a human just reading ~/.spo-reports/pending/, so it
// would sit claimed forever.
//
// Reuses the exact precedent orphan-scan.js already established for the identical shape of
// problem (a crashed owner mid-write) rather than inventing a third "is this stuck" pattern:
// dead-owner detection via lock.js's own pid-liveness probe (processAlive), plus a grace window
// (config.triageClaimGraceMs) absorbing the race between a live claim's rename and its own
// sidecar write landing on disk. A claim whose owner is merely SLOW (a real Opus reproduction,
// minutes long) is never touched -- only one whose owner is provably gone AND past the grace
// window. A sidecar that can't be read at all (a crash inside the tiny window between the
// rename and the sidecar write) falls back to the claimed file's own mtime under the identical
// grace window, so that race can't strand a report either.
//
// Called once at the top of every REAL (non-dry) runAutoTriage cycle -- tied to the same timer
// that would otherwise skip a genuinely orphaned report for however long the daemon happens to
// keep running, rather than only at daemon startup (orphan-scan.js's own choice, which fits a
// process that restarts often; this pipeline's daemon can run for days between restarts, so
// waiting for the next one would leave a crashed claim unrecovered far longer than a maintainer
// would accept for a report they explicitly confirmed).
function reclaimStaleClaims(journalRoot, config, deps = {}) {
  const isAlive = deps.isAlive || processAlive;
  const spoReportsDir = config.spoReportsDir;
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  const graceMs =
    config && config.triageClaimGraceMs !== undefined
      ? config.triageClaimGraceMs
      : DEFAULT_TRIAGE_CLAIM_GRACE_MS;
  if (!fs.existsSync(inProgressDir)) return [];

  const reclaimed = [];
  const files = fs
    .readdirSync(inProgressDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.claim.json'));

  for (const file of files) {
    const claimedPath = path.join(inProgressDir, file);
    const sidecar = readClaimSidecar(claimedPath);

    let stale;
    if (sidecar && typeof sidecar.pid === 'number' && sidecar.host) {
      const claimedAt = sidecar.claimedAt ? Date.parse(sidecar.claimedAt) : NaN;
      const ageMs = Number.isNaN(claimedAt) ? Infinity : Date.now() - claimedAt;
      // An absolute ceiling, above the liveness probe. A claim we can never probe -- a foreign
      // hostname after a WSL/container/VM rebuild, or a pid this host has since reused -- would
      // otherwise sit in in-progress/ forever, and NOTHING surfaces that: the eligibility scan
      // reads daemon.jsonl, `spo reports` reads pending/. A report a human explicitly confirmed
      // would be permanently invisible, which is a worse failure than the double-triage this
      // action prevents. Past the ceiling we reclaim regardless of pid or host: the worst case is
      // one duplicated triage after hours of silence, and that is recoverable.
      const sameHost = sidecar.host === os.hostname();
      if (sameHost && isAlive(sidecar.pid)) {
        continue; // owner still working -- slow, not orphaned. Positive evidence always wins,
        // at any age: a real Opus reproduction can run for many minutes and must never be
        // reclaimed out from under itself.
      }
      if (sameHost) {
        stale = ageMs >= graceMs; // owner provably gone -- the ordinary case
      } else {
        // Cannot probe a foreign host's pid, so there is no evidence either way. Wait for the
        // ceiling rather than forever.
        stale = ageMs >= graceMs * TRIAGE_CLAIM_CEILING_MULTIPLE;
      }
    } else {
      // No readable owner -- fall back to the claimed file's own mtime under the same grace
      // window (see this function's header).
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(claimedPath).mtimeMs;
      } catch {
        continue; // raced away since readdirSync -- somebody else is already handling it
      }
      stale = Date.now() - mtimeMs >= graceMs;
    }
    if (!stale) continue;

    const pendingDir = path.join(spoReportsDir, 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const dest = path.join(pendingDir, file);
    try {
      fs.renameSync(claimedPath, dest);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue; // reclaimed by a concurrent sweep already
      throw err;
    }
    removeClaimSidecar(claimedPath);
    appendDaemonEvent(journalRoot, 'report-triage-reclaimed', { file, owner: sidecar || null });
    reclaimed.push(file);
  }
  return reclaimed;
}

function firstNonBlankLine(text) {
  return ((text || '').split('\n').find((l) => l.trim()) || '').trim();
}

function readDaemonEvents(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// findConfirmedAwaitingTriage(journalRoot, limit) -- every `report-confirmed` event in
// daemon.jsonl with no LATER `report-triaged`/`report-held` event for the same issue number (the
// same "anchor + alreadyHandled" idiom park-loop.js's findParkAnchor already uses, transposed
// from a per-task journal.jsonl to this flat daemon-level log, since a confirmed report belongs
// to no single task). Oldest first, capped at `limit`.
function findConfirmedAwaitingTriage(journalRoot, limit) {
  const lines = readDaemonEvents(journalRoot);
  const confirmed = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].event !== 'report-confirmed') continue;
    const issue = lines[i].issue;
    // action 3.3: report-held-mechanical also counts as handled -- without this the mechanical
    // cap does nothing, since the exact same report would just be picked up again next cycle
    // regardless of the hold. It deliberately does NOT gate on the backoff/cap machinery being
    // "correct" -- it is a terminal disposition, same class as report-triaged/report-held, not a
    // retry signal.
    const handledLater = lines
      .slice(i + 1)
      .some(
        (e) =>
          (e.event === 'report-triaged' || e.event === 'report-held' || e.event === 'report-held-mechanical') &&
          e.issue === issue
      );
    if (!handledLater) confirmed.push(lines[i]);
  }
  return confirmed.slice(0, limit);
}

// mechanicalFailureHistory(journalRoot, issue) -- report-triage-error events for `issue` SINCE
// its own most recent report-confirmed anchor (the identical "anchor + events since" idiom
// findConfirmedAwaitingTriage uses just above, transposed from "handled at all" to "how many
// mechanical failures since the last time a human confirmed this"). Deliberately not "since the
// beginning of the journal": that is what lets a maintainer's `spo triage --retry <issue>`
// (action 3.4) reset both the mechanical-failure cap and the backoff budget just by re-confirming
// the report -- a fresh report-confirmed event moves the anchor forward, so every earlier
// report-triage-error stops counting. No anchor found (issue never confirmed, or called directly
// in a context that never journaled one -- see processConfirmedReport's own tests) returns a zero
// history rather than scanning the whole log: better to under-count than to ever cap/back off a
// report this function cannot actually place relative to a confirm.
function mechanicalFailureHistory(journalRoot, issue) {
  const lines = readDaemonEvents(journalRoot);
  let anchorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].event === 'report-confirmed' && lines[i].issue === issue) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx === -1) return { count: 0, lastErrorAtMs: null };

  const errors = lines.slice(anchorIdx + 1).filter((e) => e.event === 'report-triage-error' && e.issue === issue);
  if (errors.length === 0) return { count: 0, lastErrorAtMs: null };
  const lastTs = errors[errors.length - 1].ts;
  const lastErrorAtMs = lastTs ? Date.parse(lastTs) : NaN;
  return { count: errors.length, lastErrorAtMs: Number.isNaN(lastErrorAtMs) ? null : lastErrorAtMs };
}

// The comment posted on a HELD report -- a negative outcome after a human already confirmed it,
// so it must be visible and explained, never silently disposed of. See this file's own header.
function buildHoldComment(outcome, detail) {
  const lines = [
    '### Pipeline: reproduction did not confirm this report',
    '',
    `**Outcome:** \`${outcome}\``,
    '',
    detail,
    '',
    'This report is still confirmed and still in the intake column -- nothing was discarded. If',
    'the reason above is wrong, or you can supply the missing evidence, reply with more detail and',
    'the next `spo triage` cycle will not re-run automatically (this outcome is now held); ask a',
    'maintainer to re-run `spo triage --file` by hand once the report or the reason has been',
    'addressed.',
  ];
  return lines.join('\n');
}

// action 3.3: three strikes. Enough that one flaky cycle (a transient `gh` timeout, one bad
// `claude -p` spawn) never holds a report a maintainer is still waiting to see filed, few enough
// that a genuinely broken account pool or a wide claude-code outage stops spending real
// `claude -p` reproductions -- the 12.8h/128-attempt incident this whole action closes -- within
// three auto-triage cycles' worth of attempts rather than fifty-three.
const MECHANICAL_FAILURE_CAP = 3;

// D2 fix (verifier finding, action 3.3 round 2): handleMechanicalFailure is reached for every
// tagged {ok:false} return in routeConfirmedReport/reviewAndFile -- but not all nine `step` tags
// mean the same thing. Four of them (below, PRE_VERDICT_STEPS) fail BEFORE any verdict is
// reached: TRIAGE_BUG_REPORT/REVIEW_CARD/FETCH_ISSUE/BUILD_SUGGESTION_DRAFT are the calls that
// PRODUCE a verdict, so when one of them fails the pre-verdict wording below ("no verdict was
// ever reached") is still true. The other five -- POST_HOLD_COMMENT/POST_DUPLICATE_COMMENT/
// POST_DUPLICATE_CLOSE_COMMENT/POST_DO_NOT_FILE_COMMENT/AMEND_CARD -- run AFTER a verdict was
// already reached (a duplicate/held/DO_NOT_FILE/FILE outcome from TRIAGE_BUG_REPORT or
// REVIEW_CARD); they fail only on the FOLLOW-UP `gh`/`npm` call that tries to record it. Using
// the pre-verdict text for those would tell the exact lie this comment was written to avoid --
// "No verdict was ever reached" when one plainly was. VERDICT_STEP_FOR maps each post-verdict
// step back to the step that actually produced the verdict, so the comment can name it; any step
// NOT in this map (TRIAGE_BUG_REPORT/REVIEW_CARD/FETCH_ISSUE/BUILD_SUGGESTION_DRAFT, or an
// unrecognized/absent step) falls through to the pre-verdict wording below.
const VERDICT_STEP_FOR = {
  POST_HOLD_COMMENT: 'TRIAGE_BUG_REPORT',
  POST_DUPLICATE_COMMENT: 'TRIAGE_BUG_REPORT',
  POST_DUPLICATE_CLOSE_COMMENT: 'TRIAGE_BUG_REPORT',
  POST_DO_NOT_FILE_COMMENT: 'REVIEW_CARD',
  AMEND_CARD: 'REVIEW_CARD',
};

// The comment posted once a confirmed report's triage has failed MECHANICALLY
// MECHANICAL_FAILURE_CAP times in a row -- deliberately NOT buildHoldComment's text. That comment
// says "Pipeline: reproduction did not confirm this report" and explains a REPRODUCTION VERDICT:
// a human's `/triage-report` reasoning ran to completion and came back negative. Reusing it here
// would be a lie -- nothing reproduced anything; the machinery (a deadline kill, a spawn failure,
// pool exhaustion) never reached a verdict at all. See this file's own header and
// orchestrator/README.md § Report intake for the 12.8h incident this is written against.
//
// `step` (the failing call's own tag, e.g. 'POST_HOLD_COMMENT') selects which of the two
// true stories to tell -- see PRE_VERDICT_STEPS/VERDICT_STEP_FOR just above. Falls back to the
// pre-verdict wording for an unrecognized/absent step: that is the safer default (it never claims
// a verdict was reached when the caller cannot prove one was).
function buildMechanicalHoldComment(issue, attempts, lastError, step) {
  const verdictStep = VERDICT_STEP_FOR[step];
  if (verdictStep) {
    const isPostComment = typeof step === 'string' && step.startsWith('POST_');
    const lines = [
      '### Pipeline: triage reached a verdict but could not record it',
      '',
      `Triage for this report already reached a verdict (in \`${verdictStep}\`), but the follow-up`,
      `step that records it -- \`${step}\` -- has now failed MECHANICALLY ${attempts} times in a`,
      'row: a deadline kill, a spawn failure, account-pool exhaustion, or a `gh`/`npm` call itself',
      'failing, never a problem with the verdict. The verdict was real; the pipeline just could not',
      'act on it.',
      '',
      `**Last error:** \`${lastError}\``,
      '',
      'This report is still confirmed and still in the intake column -- nothing was discarded.',
    ];
    if (isPostComment) {
      lines.push(
        '',
        'Note the irony: this very comment is itself posted through the same `gh` issue-comment call',
        `that just failed three times as \`${step}\` -- so it will often fail too, and the loop would`,
        'go on invisibly if this event depended on the comment landing. It does not: this report is',
        'held (and this cap stops re-attempting it) regardless of whether this comment made it',
        'through.'
      );
    }
    lines.push(
      '',
      `Once the mechanical cause above is fixed, re-run \`spo triage --retry ${issue} --file\` to reset`,
      `the failure count and try again (the bare \`--retry ${issue}\` only previews the recovery, and a`,
      'plain `spo triage --file` will not pick this report back up before then -- see',
      '`spo triage --retry`\'s own usage).'
    );
    return lines.join('\n');
  }

  const lines = [
    '### Pipeline: triage failed mechanically, not on a verdict',
    '',
    `Triage for this report failed for a MECHANICAL reason ${attempts} times in a row -- a deadline`,
    'kill, a spawn failure, or account-pool exhaustion, never a reproduction attempt that actually',
    'ran and came back negative. No verdict was ever reached.',
    '',
    `**Last error:** \`${lastError}\``,
    '',
    'This report is still confirmed and still in the intake column -- nothing was discarded, and no',
    'reproduction was attempted or rejected. Once the mechanical cause above is fixed, re-run',
    `\`spo triage --retry ${issue} --file\` to reset the failure count and try again (the bare`,
    `\`--retry ${issue}\` only previews the recovery); a plain \`spo triage --file\` will not pick this`,
    'report back up before then.',
  ];
  return lines.join('\n');
}

// journalCooldowns(journalRoot, issue, step, cooldowns) -- makes an account-rotation cooldown
// visible in daemon.jsonl. intake.js's draftCard/reviewCard/triageBugReport have no ctx.taskDir
// of their own (see intake.js's callIntakeStepWithRotation header) -- they return any cooldown
// their rotation caused on the result's `cooldowns` array instead, and this file is the ONE
// place that turns it into a journal event, same responsibility split as
// `report-triage-retry` below for the timeout retry. One event per cooled account, since a
// single call can in principle cool more than one before landing on a healthy account.
// Skipped entirely in dry-run mode: a preview run must never journal a terminal-shaped event
// (same "only journal on real output" rule this file already follows for filed/held/duplicate).
function journalCooldowns(journalRoot, issue, step, cooldowns) {
  for (const cooldown of cooldowns || []) {
    appendDaemonEvent(journalRoot, 'report-triage-cooldown', { issue, step, ...cooldown });
  }
}

// reviewAndFile(entry, draft, journalRoot, config, deps, opts, today) -- the tail every draft
// goes through regardless of how it was produced (triageBugReport's reproduction, or
// buildSuggestionDraft's mechanical path below): the same reviewCard gate every other card here
// gets, then amendCard (edits the raw-intake issue in place) and a move to Todo. Shared so the
// two draft sources can never quietly diverge on what "filed" means.
async function reviewAndFile(entry, draft, journalRoot, config, deps, opts, today) {
  const dry = !!opts.dry;
  const spoReportsDir = config.spoReportsDir;
  const archiveDir = path.join(spoReportsDir, 'archive');

  // deps.humanConfirmed: true so review-card.md § 0 does not re-litigate desirability -- a
  // maintainer already confirmed this report before it ever reached here.
  const reviewed = await intake.reviewCard(draft, { ...deps, humanConfirmed: true });
  if (!dry && reviewed.cooldowns) journalCooldowns(journalRoot, entry.issue, 'REVIEW_CARD', reviewed.cooldowns);
  // Every `step`-tagged {ok:false, error} return in this file is a MECHANICAL failure, never a
  // verdict -- processConfirmedReport's handleMechanicalFailure (below) is the one place that
  // turns it into a report-triage-error journal event and counts it toward MECHANICAL_FAILURE_CAP
  // (action 3.3). The tag says which call failed, for a maintainer reading the journal later.
  if (!reviewed.ok) return { ok: false, error: reviewed.error, step: 'REVIEW_CARD' };

  if (reviewed.review.verdict === 'DO_NOT_FILE') {
    const reason = firstNonBlankLine(reviewed.review.first_comment_markdown);
    if (dry) return { ok: true, outcome: 'would-hold', reason };
    const commented = intake.postIssueComment(entry.issue, reviewed.review.first_comment_markdown, deps);
    if (!commented.ok) return { ok: false, error: commented.error, step: 'POST_DO_NOT_FILE_COMMENT' };
    appendDaemonEvent(journalRoot, 'report-held', { issue: entry.issue, outcome: 'do-not-file', reason });
    return { ok: true, outcome: 'do-not-file', reason };
  }

  if (dry) {
    return { ok: true, outcome: 'would-file', draft, review: reviewed.review };
  }

  const amended = intake.amendCard(entry.issue, draft, reviewed.review, deps);
  if (!amended.ok) return { ok: false, error: amended.error, step: 'AMEND_CARD' };

  if (config.autoTriagePromoteToTodo !== false) {
    // action 2.1b: pass config through so board.js's own armTimeout arms this spawn's class
    // timeout too -- this is the SAME moveIssueToColumn board.js/report-intake.js's own moves
    // now bound, and leaving this one caller config-less would silently reopen the exact gap
    // 2.1b closes for the other two.
    const moved = board.moveIssueToColumn(entry.issue, 'Todo', deps, { cwd: config.productRepo, config });
    if (!moved.ok) {
      appendDaemonEvent(journalRoot, 'report-promote-failed', {
        issue: entry.issue,
        exit: moved.exit,
        timedOut: moved.timedOut === true,
      });
    }
  }

  moveReportTo(entry.pendingPath, archiveDir, `filed: #${entry.issue} — ${today}`);
  appendDaemonEvent(journalRoot, 'report-triaged', { issue: entry.issue, outcome: 'filed' });
  return { ok: true, outcome: 'filed', issueNumber: entry.issue, url: amended.url };
}

// The default area a mechanical "suggestion" draft is filed under -- reviewCard's own check 4
// corrects it via FILE_AMENDED like any other card's area, the same safety net every other
// draft already relies on for a wrong guess. 'client' is the most common ground for a UI/UX
// improvement idea, which "could be better" mostly is.
const DEFAULT_SUGGESTION_AREA = 'client';

// buildSuggestionDraft(entry, deps) -- the mechanical path for a `kind: 'suggestion'` report:
// NO reproduction, no drafting LLM call at all (a maintainer's own confirm is the only judgement
// this outcome ever gets before reviewCard) -- just the raw-intake issue's own title/body,
// already fully rendered by report-card.js at stage 1, wrapped into the same draft contract
// every other source produces. Returns {ok: true, draft} or {ok: false, error}.
function buildSuggestionDraft(entry, deps) {
  const fetched = intake.fetchIssue(entry.issue, deps);
  if (!fetched.ok) return { ok: false, error: fetched.error, step: 'FETCH_ISSUE' };

  const title = fetched.title.replace(/^\[suggestion\]\s*/, '');
  const draft = {
    title: title || fetched.title,
    body_markdown: fetched.body,
    category: 'feature',
    size: 'S',
    area: DEFAULT_SUGGESTION_AREA,
    is_bug_report: false,
    confirmed: true,
  };
  return { ok: true, draft };
}

// routeConfirmedReport(entry, journalRoot, config, deps, opts) -- routes ONE confirmed report by
// its kind (threaded through from report-card.js's own header via report-intake.js's
// report-intake/report-confirmed journal events -- see report-intake.js's parseCardOutput):
//   kind === 'suggestion' -> buildSuggestionDraft (mechanical, no LLM) -> reviewAndFile
//   anything else         -> triageBugReport (reproduction) -> reviewAndFile, or duplicate/held
// `entry` is the `report-confirmed` daemon event shape: {issue, pendingPath, commentId, kind} --
// by the time this runs, `entry.pendingPath` is wherever processConfirmedReport (below) has
// already claimed the file to (in-progress/ for a real run, unchanged for a dry one). Returns
// {ok: true, outcome, ...} (never throws for a recognized failure) -- `outcome` is one of the
// values documented in the outcome table below. Not exported: processConfirmedReport is the
// public entry point, since claiming/un-claiming the file is not optional behaviour a caller
// could reasonably want to skip.
async function routeConfirmedReport(entry, journalRoot, config, deps = {}, opts = {}) {
  const dry = !!opts.dry;
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const spoReportsDir = config.spoReportsDir;
  const archiveDir = path.join(spoReportsDir, 'archive');

  if (entry.kind === 'suggestion') {
    const built = buildSuggestionDraft(entry, deps);
    if (!built.ok) return { ok: false, error: built.error, step: built.step || 'BUILD_SUGGESTION_DRAFT' };
    return reviewAndFile(entry, built.draft, journalRoot, config, deps, opts, today);
  }

  const triaged = await intake.triageBugReport(entry.pendingPath, entry.issue, deps);

  // Make the retry visible: a step that silently costs twice as long and twice as much is the
  // kind of thing that only shows up in a bill. Not a terminal event -- findConfirmedAwaitingTriage
  // only treats `report-triaged`/`report-held` as "handled", so this never suppresses a re-scan.
  if (!dry && triaged.retriedAfterTimeout) {
    appendDaemonEvent(journalRoot, 'report-triage-retry', {
      issue: entry.issue,
      ...triaged.retriedAfterTimeout,
    });
  }
  // Same for a rotation cooldown -- see journalCooldowns' own header. Journaled even when
  // triaged.ok is false (the pool was exhausted): that IS the incident this makes visible, not
  // something to hide behind the "mechanical failure, no journal" rule just below.
  if (!dry && triaged.cooldowns) journalCooldowns(journalRoot, entry.issue, 'TRIAGE_BUG_REPORT', triaged.cooldowns);

  if (!triaged.ok) {
    // Mechanical failure -- not a terminal journal event by itself (retried next cycle, subject
    // to action 3.3's cap/backoff in processConfirmedReport's handleMechanicalFailure below).
    return { ok: false, error: triaged.error, step: 'TRIAGE_BUG_REPORT' };
  }

  if (triaged.outcome === 'duplicate') {
    if (dry) return { ok: true, outcome: 'would-duplicate', issueNumber: triaged.issue_number };
    const commented = intake.postIssueComment(triaged.issue_number, triaged.comment_markdown, deps);
    if (!commented.ok) return { ok: false, error: commented.error, step: 'POST_DUPLICATE_COMMENT' };
    const closed = intake.postIssueComment(
      entry.issue,
      `Duplicate of #${triaged.issue_number} -- closing this intake card.`,
      deps
    );
    if (!closed.ok) return { ok: false, error: closed.error, step: 'POST_DUPLICATE_CLOSE_COMMENT' };
    moveReportTo(entry.pendingPath, archiveDir, `duplicate: #${triaged.issue_number} — ${today}`);
    appendDaemonEvent(journalRoot, 'report-triaged', { issue: entry.issue, outcome: 'duplicate', duplicateOf: triaged.issue_number });
    return { ok: true, outcome: 'duplicate', issueNumber: triaged.issue_number };
  }

  if (triaged.outcome !== 'draft') {
    // 'not-reproduced' | 'insufficient' | 'schema-version' -- HELD, never archived (see header).
    const detail =
      triaged.outcome === 'schema-version'
        ? `Schema version mismatch: found ${triaged.found}, expected ${triaged.expected}. This report likely predates a schema change and needs a maintainer's own look.`
        : `Reason: ${triaged.reason}`;
    if (dry) return { ok: true, outcome: 'would-hold', reason: triaged.reason || detail };
    const commented = intake.postIssueComment(entry.issue, buildHoldComment(triaged.outcome, detail), deps);
    if (!commented.ok) return { ok: false, error: commented.error, step: 'POST_HOLD_COMMENT' };
    appendDaemonEvent(journalRoot, 'report-held', { issue: entry.issue, outcome: triaged.outcome, reason: triaged.reason || detail });
    return { ok: true, outcome: triaged.outcome, reason: triaged.reason || detail };
  }

  return reviewAndFile(entry, triaged.draft, journalRoot, config, deps, opts, today);
}

// processConfirmedReport(entry, journalRoot, config, deps, opts) -- the public entry point:
// claims entry.pendingPath (claimReport, above) BEFORE routeConfirmedReport ever gets a chance to
// spend an LLM call, so a second runner racing the SAME report-confirmed entry (the daemon's own
// timer and a hand-run `spo triage --file`, or two overlapping daemon cycles) loses the rename,
// is told `already-claimed`, and returns without calling triageBugReport/reviewCard at all --
// see this file's "action 2.6" section header above for the incident this closes.
//
// `opts.dry` claims nothing: routeConfirmedReport still runs triageBugReport/reviewCard so a
// preview shows the real verdict (unchanged behaviour), but a dry run must never take the file
// out from under the real one, so it operates on entry.pendingPath exactly as before this claim
// mechanism existed.
//
// Whatever routeConfirmedReport does NOT archive itself (only `filed`/`duplicate` move the file
// to archive/, via reviewAndFile/the duplicate branch) is restored to its ORIGINAL pending/ path
// in the `finally` below -- held, DO_NOT_FILE, and every mechanical failure all want the
// identical "back where a human still sees it, retried next cycle" outcome, so this is the one
// place that enforces it rather than every return inside routeConfirmedReport remembering to
// undo the claim. Checking `fs.existsSync(claim.path)` after the call (rather than switching on
// `result.outcome`) is deliberate: it is correct even for an outcome this function has never
// seen before, and even if routeConfirmedReport throws (the `finally` still runs, though a hard
// process kill obviously does not -- that is what reclaimStaleClaims is for).
// handleMechanicalFailure(issue, failure, journalRoot, deps) -- action 3.3. Called by
// processConfirmedReport for every {ok:false, error, step} routeConfirmedReport/reviewAndFile can
// return (never for a dry run -- processConfirmedReport's dry branch returns before this is ever
// reached, matching "skip journaling in dry-run mode" for every event below).
//
// Journals report-triage-error unconditionally, then re-reads the count SINCE THE REPORT'S OWN
// report-confirmed ANCHOR via mechanicalFailureHistory (which is itself now one higher, since the
// event was just appended) -- see that function's own header for why "since the anchor" and not
// "since the beginning of the journal" is load-bearing: it is what lets a maintainer's `spo
// triage --retry <issue>` (action 3.4) reset this count later, by re-confirming the report and
// moving the anchor forward.
//
// Below MECHANICAL_FAILURE_CAP the original failure is returned unchanged -- the report is simply
// retried next ELIGIBLE cycle (runAutoTriage's own backoff check throttles how soon "next" is). At
// the cap it posts buildMechanicalHoldComment's dedicated comment (never buildHoldComment's
// reproduction-verdict wording) and journals report-held-mechanical, which
// findConfirmedAwaitingTriage now also treats as handled -- turning what would otherwise be a
// {ok: false} into a normal-looking {ok: true, outcome: 'held-mechanical'} disposition, the same
// shape every other terminal outcome in this file already has.
function handleMechanicalFailure(issue, failure, journalRoot, deps) {
  const step = failure.step || 'TRIAGE';
  const errorStr = String(failure.error).slice(0, 300);
  appendDaemonEvent(journalRoot, 'report-triage-error', { issue, step, error: errorStr });

  const { count: attempts } = mechanicalFailureHistory(journalRoot, issue);
  if (attempts < MECHANICAL_FAILURE_CAP) return failure;

  // D1 fix (verifier finding, action 3.3 round 2): the hold is the mechanism; the comment is the
  // courtesy. A failed `postIssueComment` here (the SAME kind of `gh` outage or rate-limit this
  // repo already has precedent handling for -- see park-comment-failed) used to make this
  // function return the ORIGINAL failure, so report-held-mechanical was never journalled. Since
  // that event is the ONLY thing findConfirmedAwaitingTriage treats as handled, the report stayed
  // eligible forever and every cycle spawned a fresh `claude -p` -- `attempts` climbing pinned the
  // backoff at its 2h ceiling, but never stopped it: 12 spawns/day per report, forever. That is
  // the exact incident this action exists to close, reintroduced by a courtesy call's failure
  // vetoing the mechanism. So: journal report-held-mechanical and return `ok: true` REGARDLESS of
  // whether the comment posted, recording whether it did (`commentPosted`) so a maintainer reading
  // the journal can still tell a `gh` outage from a quiet report.
  const commented = intake.postIssueComment(issue, buildMechanicalHoldComment(issue, attempts, errorStr, step), deps);
  appendDaemonEvent(journalRoot, 'report-held-mechanical', {
    issue,
    attempts,
    lastError: errorStr,
    commentPosted: commented.ok === true,
    commentError: commented.ok ? undefined : commented.error,
  });
  return {
    ok: true,
    outcome: 'held-mechanical',
    attempts,
    lastError: errorStr,
    reason: `mechanical failure x${attempts}: ${errorStr}`,
  };
}

async function processConfirmedReport(entry, journalRoot, config, deps = {}, opts = {}) {
  const dry = !!opts.dry;
  if (dry) return routeConfirmedReport(entry, journalRoot, config, deps, opts);

  const claim = claimReport(config.spoReportsDir, entry.pendingPath);
  if (!claim.claimed) {
    // Lost the race: another runner's rename won between findConfirmedAwaitingTriage's scan and
    // this call. Not an error -- the winner's own report-triaged/report-held event will show up
    // on the journal once it finishes; nothing for this caller to do but skip.
    return { ok: true, outcome: 'already-claimed' };
  }
  appendDaemonEvent(journalRoot, 'report-triage-claimed', { issue: entry.issue, path: claim.path });

  const claimedEntry = { ...entry, pendingPath: claim.path };
  try {
    const result = await routeConfirmedReport(claimedEntry, journalRoot, config, deps, opts);
    // action 3.3: this is the ONE choke point every mechanical {ok:false, error, step} return in
    // routeConfirmedReport/reviewAndFile funnels through -- see handleMechanicalFailure's own
    // header. Called INSIDE the try, before the `finally` restores the claim, so a report that
    // gets held-mechanical here still goes back to pending/ exactly like every other held outcome.
    return !result.ok ? handleMechanicalFailure(entry.issue, result, journalRoot, deps) : result;
  } finally {
    // Restore FIRST, unlink the sidecar SECOND. The other order leaves a window in which the
    // file is in in-progress/ with no sidecar, which is exactly the shape reclaimStaleClaims'
    // fallback treats as an abandoned claim -- a concurrent sweep would reclaim it mid-restore
    // and the rename below would then throw ENOENT out of a finally, discarding the return value
    // and propagating through runAutoTriage into runForever, which has no try/catch. That kills
    // the daemon over a bookkeeping race.
    try {
      if (fs.existsSync(claim.path)) fs.renameSync(claim.path, entry.pendingPath);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      // Someone else already moved it back -- the report is in pending/ either way, which is all
      // this restore was for.
    }
    removeClaimSidecar(claim.path);
  }
}

// runAutoTriage(journalRoot, config, deps, opts) -- processConfirmedReport for the top
// config.autoTriageLimit CONFIRMED-and-not-yet-triaged reports (findConfirmedAwaitingTriage).
// `opts.dry`: previews every outcome (still runs triageBugReport/reviewCard so the caller sees
// the real verdict) but never comments, amends, moves, or journals a terminal event -- the exact
// same "look, don't touch" `spo ask --dry` already gives the fast-lane intake path.
//
// Journals exactly one `auto-triage` summary event per REAL (non-dry) call, and only when the
// cycle actually did something -- disposed of a report, tried and failed, or (action 3.3) skipped
// one for backoff. A cycle with nothing confirmed (top.length === 0) stays silent, same "only
// journal on real output" rule auto-pull.js's runAutoPull already follows. An all-errors cycle
// used to be silent too -- that is how report #449 (a triageBugReport deadline kill, 2026-08-30)
// went invisible in daemon.jsonl for hours; it is now journaled with `errorIssues`/`firstError` so
// a maintainer scanning the journal can see it without re-running `spo triage` by hand. A cycle
// that ONLY backed off (no disposal, no error) is journaled for the identical reason: the
// 12.8-hour stall this action closes stayed invisible partly because nothing distinguished "tried
// and failed" from "nothing happened" in daemon.jsonl -- a silent backoff would recreate exactly
// that blind spot for the one mechanism built to prevent the incident from repeating.
async function runAutoTriage(journalRoot, config, deps = {}, opts = {}) {
  const dry = !!opts.dry;
  const limit = (config && config.autoTriageLimit) || DEFAULT_AUTO_TRIAGE_LIMIT;

  // Recover any claim stranded by a process that died mid-triage before scanning for new work --
  // see reclaimStaleClaims' own header. Real cycles only: a dry run must mutate nothing.
  if (!dry) reclaimStaleClaims(journalRoot, config, deps);

  const top = findConfirmedAwaitingTriage(journalRoot, limit);

  const results = [];
  const errors = [];
  let filed = 0;
  let duplicates = 0;
  let held = 0;
  let heldMechanical = 0;
  let alreadyClaimed = 0;
  let backoffSkipped = 0;

  for (const entry of top) {
    // action 3.3: check backoff BEFORE claimReport is ever called -- a skip must not rename the
    // report into in-progress/ (claimReport does exactly that) and must not spend an LLM call.
    // Skipped in dry mode: a preview always shows the real verdict regardless of claim/backoff
    // mechanics, same posture processConfirmedReport's own dry branch already takes.
    if (!dry) {
      const { count, lastErrorAtMs } = mechanicalFailureHistory(journalRoot, entry.issue);
      if (shouldSkipForTriageBackoff(lastErrorAtMs, Date.now(), count, config)) {
        // N4 fix (verifier finding, action 3.3 round 2): `new Date(ms).toISOString()` throws
        // RangeError('Invalid time value') once `ms` is outside JS's own valid Date range
        // (+/-8.64e15 from the epoch -- ECMA-262's own limit, MAX_DATE_MS below) or is
        // Infinity/NaN. Reachable if a misconfigured autoTriageBackoffCeilingMs is Infinity (or
        // just huge) and enough mechanical failures have piled up: with ceiling=Infinity,
        // triageBackoffMs's `Math.min(raw, ceiling)` degenerates to `raw` itself, and `raw` is
        // STILL a finite JS number (base * 2^(errorCount-1) does not overflow to Infinity until
        // errorCount is enormous) while already being astronomically past MAX_DATE_MS --
        // verified: 15min base, errorCount 60 -> ~5.19e23, finite, still throws. So
        // `Number.isFinite` alone is not enough; the range check is load-bearing. config.js's own
        // positiveMsFromEnv rejects an env-supplied Infinity, but a config object built any other
        // way (a test, a future caller) is not guaranteed to go through it -- and runAutoTriage
        // itself has no try/catch, so an uncaught throw here kills the whole daemon over an
        // operator typo. Clamp defensively rather than trust the input.
        const MAX_DATE_MS = 8640000000000000;
        const nextEligibleAtMs = lastErrorAtMs + triageBackoffMs(count, config);
        const nextEligibleAtIso =
          Number.isFinite(nextEligibleAtMs) && Math.abs(nextEligibleAtMs) <= MAX_DATE_MS
            ? new Date(nextEligibleAtMs).toISOString()
            : null;
        appendDaemonEvent(journalRoot, 'report-triage-backoff', { issue: entry.issue, attempts: count, nextEligibleAtIso });
        backoffSkipped++;
        results.push({ issue: entry.issue, outcome: 'backoff', attempts: count, reason: `backing off until ${nextEligibleAtIso}`, nextEligibleAtIso });
        continue;
      }
    }

    const outcome = await processConfirmedReport(entry, journalRoot, config, deps, { dry });
    if (!outcome.ok) {
      errors.push({ issue: entry.issue, error: outcome.error });
      results.push({ issue: entry.issue, outcome: 'error', error: outcome.error });
      continue;
    }
    if (outcome.outcome === 'filed' || outcome.outcome === 'would-file') filed++;
    else if (outcome.outcome === 'duplicate' || outcome.outcome === 'would-duplicate') duplicates++;
    else if (outcome.outcome === 'already-claimed') alreadyClaimed++;
    else if (outcome.outcome === 'held-mechanical') {
      held++;
      heldMechanical++;
    } else held++;
    results.push({ issue: entry.issue, ...outcome });
  }

  const disposed = filed + duplicates + held;
  if (!dry && (disposed > 0 || errors.length > 0 || alreadyClaimed > 0 || backoffSkipped > 0)) {
    appendDaemonEvent(journalRoot, 'auto-triage', {
      processed: top.length,
      filed,
      duplicates,
      held,
      heldMechanical,
      alreadyClaimed,
      backoffSkipped,
      errors: errors.length,
      errorIssues: errors.map((e) => e.issue),
      firstError: errors.length > 0 ? String(errors[0].error).slice(0, 300) : undefined,
    });
  }

  return {
    ok: true,
    processed: top.length,
    filed,
    duplicates,
    held,
    heldMechanical,
    alreadyClaimed,
    backoffSkipped,
    errors,
    results,
  };
}

// ---- action 3.4: `spo triage --retry <issue>` -- a recovery path for a held report -----------
//
// THE GAP this closes: a report that reaches HOLD (report-held -- a real negative verdict, or
// report-held with outcome 'do-not-file' -- reviewCard said no; report-held-mechanical -- action
// 3.3's three-strikes cap) is a confirmed dead end today. All three are journalled as handled, so
// findConfirmedAwaitingTriage never returns the issue again. The report file is still sitting in
// pending/ (restored there by processConfirmedReport's own `finally`), still confirmed, still in
// the intake column -- and nothing short of hand-editing daemon.jsonl brings it back. 3.3's own
// buildMechanicalHoldComment already PROMISES `spo triage --retry <issue>` as the way out; this is
// what makes that promise true rather than a silent no-op.
//
// THE MECHANISM: append a FRESH report-confirmed event for the issue. One event does both jobs,
// and this is exactly why 3.3 anchored mechanicalFailureHistory on report-confirmed rather than
// scanning the whole journal: a later report-confirmed makes the issue eligible again
// (findConfirmedAwaitingTriage's own "no LATER handled event for this issue" scan) AND resets the
// mechanical-failure budget to zero in the same move (mechanicalFailureHistory only counts
// report-triage-error events AFTER the most recent anchor). No second mechanism -- 3.3's own test
// ("a later report-confirmed for the same issue resets the mechanical-failure count") already
// proved this shape works; this function is what fabricates that event for real instead of a test
// faking it by hand.
//
// PRECONDITIONS, all checked before anything is appended:
//   1. `issue` must have a report-confirmed event on record at all -- otherwise there is nothing
//      to re-confirm.
//   2. Its most recent handled-event (report-triaged / report-held / report-held-mechanical -- the
//      SAME "handled" vocabulary findConfirmedAwaitingTriage/mechanicalFailureHistory already use)
//      must actually be a HOLD. Refused if it is report-triaged: the report was already filed or
//      dispositioned as a duplicate, and re-running would re-file or re-comment on something
//      already settled. Refused if there is no handled-event at all -- the issue is ALREADY
//      eligible, and appending a second report-confirmed would put it in `top` TWICE in one cycle,
//      burning two of three autoTriageLimit slots on one report. processConfirmedReport's claim
//      mutex degrades that shape safely to `already-claimed` rather than crashing, but a command
//      whose whole purpose is recovery must never manufacture the waste on its own.
//   3. The report file recorded on that report-confirmed event must still exist. Held reports are
//      restored to their ORIGINAL pending/ path by processConfirmedReport's `finally`, so it
//      should be there -- if it is not, re-confirming anyway would loop straight back to a fresh
//      mechanical failure (nothing for claimReport to rename), which is exactly the dead end this
//      command exists to escape, not recreate.
//
// The re-confirm is journalled REGARDLESS of whether the courtesy comment posts -- 3.3's D1 lesson
// (a `gh` outage must never veto a mechanism built to survive `gh` outages) applied here: the hold
// is the mechanism, the comment is the courtesy, `commentPosted` records the truth without gating
// on it.
//
// opts.dry: same "look, don't touch" contract as runAutoTriage's own -- reports what WOULD be
// re-injected, appends nothing, comments nothing.
async function retryHeldReport(journalRoot, issue, config, deps = {}, opts = {}) {
  const dry = !!opts.dry;
  const lines = readDaemonEvents(journalRoot);

  // Precondition 1: find the most recent report-confirmed anchor for this issue.
  let anchor = null;
  let anchorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].event === 'report-confirmed' && lines[i].issue === issue) {
      anchor = lines[i];
      anchorIdx = i;
      break;
    }
  }
  if (!anchor) {
    return {
      ok: false,
      error: `retryHeldReport: issue #${issue} has no report-confirmed event on record -- nothing to re-confirm`,
    };
  }

  // Precondition 2: the LATEST handled-shaped event since that anchor. Normally at most one exists
  // (a confirmed report is routed exactly once before it becomes eligible again) -- scanning for
  // the last rather than stopping at the first is defensive against a journal shape this function
  // has never had to reason about before.
  const HANDLED_EVENTS = new Set(['report-triaged', 'report-held', 'report-held-mechanical']);
  let handled = null;
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (lines[i].issue === issue && HANDLED_EVENTS.has(lines[i].event)) handled = lines[i];
  }

  if (!handled) {
    return {
      ok: false,
      error:
        `retryHeldReport: issue #${issue} is already eligible for triage (no handled outcome since ` +
        'its last report-confirmed) -- re-confirming it again would double-queue it; run `spo triage --file` instead',
    };
  }
  if (handled.event === 'report-triaged') {
    return {
      ok: false,
      error:
        `retryHeldReport: issue #${issue} was already triaged (outcome: ${handled.outcome || 'unknown'}) -- ` +
        'filed or dispositioned as a duplicate, not held, so there is nothing to retry',
    };
  }

  // handled.event is report-held or report-held-mechanical from here on -- a genuine hold.
  const retriedFrom = handled.event;

  // Precondition 3: the report file this issue's confirm anchor points at must still be sitting
  // in pending/ (see this function's own header for why it should be, and why proceeding without
  // it would just manufacture a fresh mechanical failure). fs.statSync + isFile() rather than
  // fs.existsSync: existsSync alone returns true for a directory too, and action 3.1 already
  // fixed the identical existsSync-then-open TOCTOU/directory finding in state-machine.js's
  // isNonEmptyFile -- same shape here, wrapped so any stat error is just "not there", never a
  // crash.
  const pendingPath = anchor.pendingPath;
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!pendingPath || !isFile(pendingPath)) {
    // N4: a live daemon can claim this exact file into in-progress/ (claimReport) at any time,
    // including the gap between another cycle starting and this command running -- that is an
    // ordinary race, not data loss. Saying "missing ... no longer exists" in that case reads to a
    // maintainer as their report having been lost, when it is simply mid-cycle. Probe
    // in-progress/ and say so instead. `config` is guarded at every access (`&&`, no destructuring
    // that could throw on undefined) so a missing/partial config can never turn this refusal into
    // a crash -- it just falls through to the original "missing" wording.
    const spoReportsDir = config && config.spoReportsDir;
    const claimedPath =
      spoReportsDir && pendingPath ? path.join(spoReportsDir, IN_PROGRESS_DIRNAME, path.basename(pendingPath)) : null;
    if (claimedPath && isFile(claimedPath)) {
      return {
        ok: false,
        error:
          `retryHeldReport: issue #${issue}'s report is currently claimed by a running triage cycle ` +
          '(it is in `in-progress/`, not lost) -- try again shortly',
      };
    }
    return {
      ok: false,
      error:
        `retryHeldReport: issue #${issue}'s report file is missing from pending/ ` +
        `(expected at ${pendingPath || '(no pendingPath recorded on the report-confirmed event)'}) -- ` +
        'cannot re-inject a report that no longer exists',
    };
  }

  if (dry) {
    return { ok: true, dry: true, outcome: 'would-retry', issue, pendingPath, kind: anchor.kind, retriedFrom };
  }

  // The event is the mechanism; carry forward the exact shape findConfirmedAwaitingTriage/
  // routeConfirmedReport/processConfirmedReport read off a report-confirmed entry (issue,
  // pendingPath, kind -- see routeConfirmedReport's own header), plus commentId for parity with
  // the original event even though nothing downstream reads it back off a retry. retriedFrom/
  // retriedAt are pure markers for a maintainer reading daemon.jsonl -- neither
  // findConfirmedAwaitingTriage's event/issue matching nor mechanicalFailureHistory's own scan
  // look at any field but `event`/`issue`/`ts`, so extra fields on this event cannot break either.
  appendDaemonEvent(journalRoot, 'report-confirmed', {
    issue,
    pendingPath,
    commentId: anchor.commentId,
    kind: anchor.kind,
    retriedFrom,
    retriedAt: new Date().toISOString(),
  });

  // The comment is the courtesy: keeps the issue thread a truthful record of what a maintainer
  // did, but must never be able to veto the mechanism above (3.3's D1 lesson) -- so this call's
  // result only ever affects `commentPosted`/`commentError` below, never `ok`.
  const commentBody = [
    '### Pipeline: report re-injected for triage',
    '',
    `A maintainer ran \`spo triage --retry\` to recover this report from ${
      retriedFrom === 'report-held-mechanical' ? 'a mechanical hold' : 'a hold'
    } (\`${retriedFrom}\`).`,
    'It is confirmed and eligible for triage again as of this comment, and the mechanical-failure',
    'count has been reset to zero.',
  ].join('\n');
  const commented = intake.postIssueComment(issue, commentBody, deps);

  return {
    ok: true,
    outcome: 'retried',
    issue,
    pendingPath,
    kind: anchor.kind,
    retriedFrom,
    commentPosted: commented.ok === true,
    commentError: commented.ok ? undefined : commented.error,
  };
}

module.exports = {
  shouldAutoTriage,
  shouldSkipForTriageBackoff,
  triageBackoffMs,
  runAutoTriage,
  processConfirmedReport,
  retryHeldReport,
  findConfirmedAwaitingTriage,
  mechanicalFailureHistory,
  buildMechanicalHoldComment,
  listQueuedReports,
  moveReportTo,
  buildSuggestionDraft,
  claimReport,
  reclaimStaleClaims,
  claimSidecarPath,
  DEFAULT_AUTO_TRIAGE_MS,
  DEFAULT_AUTO_TRIAGE_LIMIT,
  DEFAULT_SUGGESTION_AREA,
  DEFAULT_TRIAGE_CLAIM_GRACE_MS,
  DEFAULT_TRIAGE_BACKOFF_BASE_MS,
  DEFAULT_TRIAGE_BACKOFF_CEILING_MS,
  MECHANICAL_FAILURE_CAP,
  IN_PROGRESS_DIRNAME,
};
