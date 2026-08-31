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
    const handledLater = lines
      .slice(i + 1)
      .some((e) => (e.event === 'report-triaged' || e.event === 'report-held') && e.issue === issue);
    if (!handledLater) confirmed.push(lines[i]);
  }
  return confirmed.slice(0, limit);
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
  if (!reviewed.ok) return { ok: false, error: reviewed.error };

  if (reviewed.review.verdict === 'DO_NOT_FILE') {
    const reason = firstNonBlankLine(reviewed.review.first_comment_markdown);
    if (dry) return { ok: true, outcome: 'would-hold', reason };
    const commented = intake.postIssueComment(entry.issue, reviewed.review.first_comment_markdown, deps);
    if (!commented.ok) return { ok: false, error: commented.error };
    appendDaemonEvent(journalRoot, 'report-held', { issue: entry.issue, outcome: 'do-not-file', reason });
    return { ok: true, outcome: 'do-not-file', reason };
  }

  if (dry) {
    return { ok: true, outcome: 'would-file', draft, review: reviewed.review };
  }

  const amended = intake.amendCard(entry.issue, draft, reviewed.review, deps);
  if (!amended.ok) return { ok: false, error: amended.error };

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
  if (!fetched.ok) return { ok: false, error: fetched.error };

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
    if (!built.ok) return { ok: false, error: built.error };
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
    return { ok: false, error: triaged.error }; // mechanical failure -- retried next cycle, no terminal journal
  }

  if (triaged.outcome === 'duplicate') {
    if (dry) return { ok: true, outcome: 'would-duplicate', issueNumber: triaged.issue_number };
    const commented = intake.postIssueComment(triaged.issue_number, triaged.comment_markdown, deps);
    if (!commented.ok) return { ok: false, error: commented.error };
    const closed = intake.postIssueComment(
      entry.issue,
      `Duplicate of #${triaged.issue_number} -- closing this intake card.`,
      deps
    );
    if (!closed.ok) return { ok: false, error: closed.error };
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
    if (!commented.ok) return { ok: false, error: commented.error };
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
    return await routeConfirmedReport(claimedEntry, journalRoot, config, deps, opts);
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
// cycle actually did something -- disposed of a report, or tried and failed. A cycle with
// nothing confirmed (top.length === 0) stays silent, same "only journal on real output" rule
// auto-pull.js's runAutoPull already follows. An all-errors cycle used to be silent too -- that
// is how report #449 (a triageBugReport deadline kill, 2026-08-30) went invisible in
// daemon.jsonl for hours; it is now journaled with `errorIssues`/`firstError` so a maintainer
// scanning the journal can see it without re-running `spo triage` by hand.
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
  let alreadyClaimed = 0;

  for (const entry of top) {
    const outcome = await processConfirmedReport(entry, journalRoot, config, deps, { dry });
    if (!outcome.ok) {
      errors.push({ issue: entry.issue, error: outcome.error });
      results.push({ issue: entry.issue, outcome: 'error', error: outcome.error });
      continue;
    }
    if (outcome.outcome === 'filed' || outcome.outcome === 'would-file') filed++;
    else if (outcome.outcome === 'duplicate' || outcome.outcome === 'would-duplicate') duplicates++;
    else if (outcome.outcome === 'already-claimed') alreadyClaimed++;
    else held++;
    results.push({ issue: entry.issue, ...outcome });
  }

  const disposed = filed + duplicates + held;
  if (!dry && (disposed > 0 || errors.length > 0 || alreadyClaimed > 0)) {
    appendDaemonEvent(journalRoot, 'auto-triage', {
      processed: top.length,
      filed,
      duplicates,
      held,
      alreadyClaimed,
      errors: errors.length,
      errorIssues: errors.map((e) => e.issue),
      firstError: errors.length > 0 ? String(errors[0].error).slice(0, 300) : undefined,
    });
  }

  return { ok: true, processed: top.length, filed, duplicates, held, alreadyClaimed, errors, results };
}

module.exports = {
  shouldAutoTriage,
  runAutoTriage,
  processConfirmedReport,
  findConfirmedAwaitingTriage,
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
  IN_PROGRESS_DIRNAME,
};
