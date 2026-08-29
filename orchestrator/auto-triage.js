'use strict';
// auto-triage.js -- turns the webclient's bug-report queue (~/.spo-reports, config.spoReportsDir)
// into filed GitHub issues, without a human running `/triage-report` by hand. Behind `spo triage`
// (on demand, bin/spo) and, when config.autoTriageMs is set, the daemon's own timer
// (state-machine.js's runForever, real mode only) -- the exact same automate-the-manual-command
// pattern auto-pull.js already established for `spo pull`.
//
// Reuses orchestrator/intake.js end to end: triageBugReport (reproduce/route/dedup/draft, via
// prompts/triage-bug-report.md) for the reasoning `/triage-report` asks a human session to do,
// then the SAME reviewCard/fileCard gate every other card filed by this repo goes through --
// never a second, parallel review or filing path. Only the mechanical bookkeeping
// `/triage-report`'s own §6/§7 describe (moving the report to archive/, writing the one-line
// disposition sidecar, deciding when to journal) lives here.
//
// "The one rule": this file never reads report CONTENT (no `journal`, `anchorKey`, `geometry`,
// `profile` field is ever parsed here) -- it only lists report FILENAMES under spoReportsDir to
// sequence them (the same class of direct read this repo already does for ~/.spo-bench), and
// archives/comments using only the outcome intake.triageBugReport already judged. All schema and
// reproduction knowledge stays inside the `claude -p` session triageBugReport spawns, reasoning
// against the product tree itself -- never encoded in this file. See orchestrator/README.md
// § Auto-triage and doc/bug-reporting.md (the product repo) for the queue's own shape.
//
// Maintainer decision, 2026-08-29: unlike auto-pull (which only ever reads a board a human
// already curated), an unattended `spo triage` risks filing on a hallucinated "reproduced"
// verdict with nobody watching -- reproduction is a genuine LLM judgement call, not a
// deterministic parse. So: `spo triage` defaults to --dry (bin/spo), and the daemon timer stays
// OPT-IN (config.autoTriageMs defaults to 0/disabled, unlike autoPullMs's nonzero default) until
// a maintainer has run `spo triage --dry` by hand enough times to trust the reproduction step.

const fs = require('fs');
const path = require('path');

const intake = require('./intake');
const { appendDaemonEvent } = require('./journal');

const DEFAULT_AUTO_TRIAGE_MS = 15 * 60 * 1000; // maintainer's own call once enabled -- see config.js
const DEFAULT_AUTO_TRIAGE_LIMIT = 3;

// Pure decision function, same shape as auto-pull.js's shouldAutoPull -- no Date.now() baked in,
// a test drives it with any (lastTriageAt, nowMs) pair. autoTriageMs <= 0 (the default) disables
// the timer entirely regardless of lastTriageAt.
function shouldAutoTriage(lastTriageAt, nowMs, autoTriageMs) {
  if (!(autoTriageMs > 0)) return false;
  if (lastTriageAt === null || lastTriageAt === undefined) return true;
  return nowMs - lastTriageAt >= autoTriageMs;
}

// listQueuedReports(spoReportsDir) -- the queue's own top-level *.json files (never
// spoReportsDir/archive/, which readdirSync's isFile() filter already excludes since it is a
// directory entry, not a file), oldest first. doc/bug-reporting.md: filenames are
// <createdAtUtc>_<profile>_<anchorKey>.json, so lexical order IS chronological order -- the same
// fact triage-report.md's own § 0 states. A missing directory is an empty queue, not an error
// (doc/bug-reporting.md: "An empty queue is a normal outcome").
function listQueuedReports(spoReportsDir) {
  if (!fs.existsSync(spoReportsDir)) return [];
  return fs
    .readdirSync(spoReportsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(spoReportsDir, name));
}

// archiveReport(reportPath, dispositionLine) -- mv into <spoReportsDir>/archive/ and write the
// one-line disposition sidecar beside it, the exact convention triage-report.md § 6 documents
// (`<file>.disposition.txt`), so a maintainer reading the archive later sees the identical shape
// whether a human or this driver triaged the report.
function archiveReport(reportPath, dispositionLine) {
  const dir = path.dirname(reportPath);
  const archiveDir = path.join(dir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const base = path.basename(reportPath);
  fs.renameSync(reportPath, path.join(archiveDir, base));
  fs.writeFileSync(path.join(archiveDir, `${base}.disposition.txt`), `${dispositionLine}\n`);
}

function firstNonBlankLine(text) {
  return ((text || '').split('\n').find((l) => l.trim()) || '').trim();
}

// The disposition line for an outcome that never reaches a draft -- triage-report.md § 6's own
// table, reused verbatim.
function dispositionLineFor(triaged, today) {
  if (triaged.outcome === 'not-reproduced') return `not-reproduced: ${triaged.reason} — ${today}`;
  if (triaged.outcome === 'insufficient') return `insufficient: ${triaged.reason} — ${today}`;
  if (triaged.outcome === 'schema-version') {
    return `schema-version: ${triaged.found} vs ${triaged.expected} — ${today}`;
  }
  return `unknown outcome "${triaged.outcome}" — ${today}`;
}

// runAutoTriage(spoReportsDir, journalRoot, config, deps, opts) -- triageBugReport, then
// reviewCard/fileCard (both REUSED, unchanged) for the top config.autoTriageLimit queued reports.
// `opts.dry` (default false): runs triageBugReport and, for a draft, reviewCard too -- so the
// caller sees the full verdict -- but never calls fileCard/postIssueComment/archiveReport and
// never journals; the queue is left exactly as found (the same "look, don't touch" `spo ask
// --dry` already gives the fast-lane intake path). A report whose triageBugReport/reviewCard/
// fileCard call fails mechanically (bad account, bad JSON, a failed gh call) is left in the
// queue for the next cycle, in both modes -- never archived on a failure that was never judged.
//
// Journals exactly one `auto-triage` event to journalRoot/daemon.jsonl per REAL (non-dry) call,
// and only when at least one report was actually disposed of -- same "only journal on real
// output" rule auto-pull.js's runAutoPull already follows. Returns {ok: true, processed, filed,
// duplicates, notReproduced, insufficient, schemaVersion, doNotFile, errors, results}.
async function runAutoTriage(spoReportsDir, journalRoot, config, deps = {}, opts = {}) {
  const dry = !!opts.dry;
  const limit = (config && config.autoTriageLimit) || DEFAULT_AUTO_TRIAGE_LIMIT;
  const today = deps.today || new Date().toISOString().slice(0, 10);

  const top = listQueuedReports(spoReportsDir).slice(0, limit);

  const results = [];
  const errors = [];
  let filed = 0;
  let duplicates = 0;
  let notReproduced = 0;
  let insufficient = 0;
  let schemaVersion = 0;
  let doNotFile = 0;

  for (const reportPath of top) {
    const file = path.basename(reportPath);

    const triaged = await intake.triageBugReport(reportPath, deps);
    if (!triaged.ok) {
      errors.push({ file, error: triaged.error });
      results.push({ file, outcome: 'error', error: triaged.error });
      continue; // stays queued -- never judged, never archived
    }

    if (triaged.outcome === 'duplicate') {
      duplicates++;
      if (!dry) {
        const commented = intake.postIssueComment(triaged.issue_number, triaged.comment_markdown, deps);
        if (!commented.ok) {
          errors.push({ file, error: commented.error });
          results.push({ file, outcome: 'error', error: commented.error });
          continue; // stays queued -- the comment failed, retry next cycle
        }
        archiveReport(reportPath, `duplicate: #${triaged.issue_number} — ${today}`);
      }
      results.push({ file, outcome: 'duplicate', issueNumber: triaged.issue_number });
      continue;
    }

    if (triaged.outcome !== 'draft') {
      // 'not-reproduced' | 'insufficient' | 'schema-version' -- no gh call at all, just archive.
      if (triaged.outcome === 'not-reproduced') notReproduced++;
      else if (triaged.outcome === 'insufficient') insufficient++;
      else if (triaged.outcome === 'schema-version') schemaVersion++;

      if (!dry) archiveReport(reportPath, dispositionLineFor(triaged, today));
      results.push({ file, outcome: triaged.outcome, reason: triaged.reason });
      continue;
    }

    // outcome === 'draft' -- the same reviewCard gate every other card here goes through.
    const reviewed = await intake.reviewCard(triaged.draft, deps);
    if (!reviewed.ok) {
      errors.push({ file, error: reviewed.error });
      results.push({ file, outcome: 'error', error: reviewed.error });
      continue; // stays queued
    }

    if (reviewed.review.verdict === 'DO_NOT_FILE') {
      doNotFile++;
      if (!dry) {
        archiveReport(reportPath, `do-not-file: ${firstNonBlankLine(reviewed.review.first_comment_markdown)} — ${today}`);
      }
      results.push({ file, outcome: 'do-not-file', review: reviewed.review });
      continue;
    }

    if (dry) {
      results.push({ file, outcome: 'would-file', draft: triaged.draft, review: reviewed.review });
      continue;
    }

    const filedResult = intake.fileCard(triaged.draft, reviewed.review, deps);
    if (!filedResult.ok) {
      errors.push({ file, error: filedResult.error });
      results.push({ file, outcome: 'error', error: filedResult.error });
      continue; // stays queued -- the filing failed, retry next cycle
    }
    filed++;
    archiveReport(reportPath, `filed: #${filedResult.issueNumber} — ${today}`);
    results.push({ file, outcome: 'filed', issueNumber: filedResult.issueNumber, url: filedResult.url });
  }

  const disposed = filed + duplicates + notReproduced + insufficient + schemaVersion + doNotFile;
  if (!dry && disposed > 0) {
    appendDaemonEvent(journalRoot, 'auto-triage', {
      processed: top.length,
      filed,
      duplicates,
      notReproduced,
      insufficient,
      schemaVersion,
      doNotFile,
      errors: errors.length,
    });
  }

  return {
    ok: true,
    processed: top.length,
    filed,
    duplicates,
    notReproduced,
    insufficient,
    schemaVersion,
    doNotFile,
    errors,
    results,
  };
}

module.exports = {
  shouldAutoTriage,
  runAutoTriage,
  listQueuedReports,
  DEFAULT_AUTO_TRIAGE_MS,
  DEFAULT_AUTO_TRIAGE_LIMIT,
};
