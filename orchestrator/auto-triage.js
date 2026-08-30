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
// it to archive/). See processConfirmedReport's outcome table below.
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
const path = require('path');

const intake = require('./intake');
const board = require('./board');
const { appendDaemonEvent } = require('./journal');

const DEFAULT_AUTO_TRIAGE_MS = 15 * 60 * 1000; // maintainer's own call -- see config.js
const DEFAULT_AUTO_TRIAGE_LIMIT = 3;

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
    const moved = board.moveIssueToColumn(entry.issue, 'Todo', deps, { cwd: config.productRepo });
    if (!moved.ok) {
      appendDaemonEvent(journalRoot, 'report-promote-failed', { issue: entry.issue, exit: moved.exit });
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

// processConfirmedReport(entry, journalRoot, config, deps, opts) -- routes ONE confirmed report
// by its kind (threaded through from report-card.js's own header via report-intake.js's
// report-intake/report-confirmed journal events -- see report-intake.js's parseCardOutput):
//   kind === 'suggestion' -> buildSuggestionDraft (mechanical, no LLM) -> reviewAndFile
//   anything else         -> triageBugReport (reproduction) -> reviewAndFile, or duplicate/held
// `entry` is the `report-confirmed` daemon event: {issue, pendingPath, commentId, kind}. Returns
// {ok: true, outcome, ...} (never throws for a recognized failure) -- `outcome` is one of the
// values documented in the outcome table below.
async function processConfirmedReport(entry, journalRoot, config, deps = {}, opts = {}) {
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

  if (!triaged.ok) {
    return { ok: false, error: triaged.error }; // mechanical failure -- retried next cycle, no journal
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

  const top = findConfirmedAwaitingTriage(journalRoot, limit);

  const results = [];
  const errors = [];
  let filed = 0;
  let duplicates = 0;
  let held = 0;

  for (const entry of top) {
    const outcome = await processConfirmedReport(entry, journalRoot, config, deps, { dry });
    if (!outcome.ok) {
      errors.push({ issue: entry.issue, error: outcome.error });
      results.push({ issue: entry.issue, outcome: 'error', error: outcome.error });
      continue;
    }
    if (outcome.outcome === 'filed' || outcome.outcome === 'would-file') filed++;
    else if (outcome.outcome === 'duplicate' || outcome.outcome === 'would-duplicate') duplicates++;
    else held++;
    results.push({ issue: entry.issue, ...outcome });
  }

  const disposed = filed + duplicates + held;
  if (!dry && (disposed > 0 || errors.length > 0)) {
    appendDaemonEvent(journalRoot, 'auto-triage', {
      processed: top.length,
      filed,
      duplicates,
      held,
      errors: errors.length,
      errorIssues: errors.map((e) => e.issue),
      firstError: errors.length > 0 ? String(errors[0].error).slice(0, 300) : undefined,
    });
  }

  return { ok: true, processed: top.length, filed, duplicates, held, errors, results };
}

module.exports = {
  shouldAutoTriage,
  runAutoTriage,
  processConfirmedReport,
  findConfirmedAwaitingTriage,
  listQueuedReports,
  moveReportTo,
  buildSuggestionDraft,
  DEFAULT_AUTO_TRIAGE_MS,
  DEFAULT_AUTO_TRIAGE_LIMIT,
  DEFAULT_SUGGESTION_AREA,
};
