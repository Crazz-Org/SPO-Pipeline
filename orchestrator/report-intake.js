'use strict';
// report-intake.js -- stages 1 and 2 of the human-first bug-report intake pipeline:
//
//   runReportIntake  -- (stage 1, MECHANICAL, zero LLM judgement) for each queued report under
//     ~/.spo-reports: renders it RAW via SPO-WebClient's `npm run report:card` (schema knowledge
//     lives there, beside the schema it reads -- this file never parses report content), dedups
//     mechanically by `anchorKey` (a grep-shaped `gh issue list --search`, not a judgement), files
//     a raw card labeled config.reportIntakeLabel, moves it to config.reportIntakeColumn, posts
//     the confirm/discard instructions, and moves the report file to ~/.spo-reports/pending/.
//   reportConfirmScan  -- (stage 2) for each pending raw card with no reply yet, acts on the
//     first AUTHORIZED "confirm" or "discard" reply posted after the instruction comment --
//     action 2.7's comment-scan.js's `scanForMatch` owns the fetch/pagination/allowlist/backoff
//     mechanics shared with park-loop.js's unparkScan (see that module's own header); this file
//     only supplies the confirm/discard pattern set and journals to daemon.jsonl (a pending
//     report belongs to no task, unlike unparkScan's per-task journal.jsonl). "confirm" hands
//     the report to auto-triage.js (stage 3+, orchestrator/auto-triage.js's runAutoTriage) via a
//     `report-confirmed` daemon event; "discard" closes the raw issue and archives the report;
//     anything else -- including a non-collaborator's reply -- is left alone.
//
// WHY the raw render can't live in this file: putting the report on the board with NO
// classification is the whole point of the human-first design (a bug that turns out to be "just"
// a bad render must never be silently excluded before a human sees it) -- but rendering it at all
// means reading `profile`/`anchor`/`observed`/`quickPicks`/`geometry`, which is exactly the
// product-repo knowledge "the one rule" keeps out of this repo. So the renderer lives beside the
// schema it reads (SPO-WebClient's scripts/report-card.js), and this file only ever spawns it and
// relays its opaque stdout -- the same relationship pullBoard already has with
// `npm run board:claim`.
//
// A failed move to reportIntakeColumn is NOT safe to ignore, unlike every board.js move
// elsewhere in this repo: a raw card with no cat:/size: labels, stuck in Todo, is claimable by
// auto-pull and would hand PLAN a report body with no acceptance criterion. intake.makeTask's own
// reportIntakeLabel guard is the second, independent line of defense against exactly that -- see
// its own comment -- but this file still journals and alerts on the failure so a maintainer sees
// it promptly rather than relying on the guard alone.

const fs = require('fs');
const os = require('os');
const path = require('path');

const intake = require('./intake');
const board = require('./board');
const { appendDaemonEvent } = require('./journal');
const { alertDaemon } = require('./park-alert');
const { listQueuedReports, moveReportTo } = require('./auto-triage');
const { armTimeout } = require('./command-timeout');
const commentScan = require('./comment-scan');

const DEFAULT_AUTO_INTAKE_MS = 15 * 60 * 1000;
const DEFAULT_AUTO_INTAKE_LIMIT = 3;
const DEFAULT_REPORT_CONFIRM_SCAN_MS = 5 * 60 * 1000;

// pure decision functions, identical shape to auto-pull.js's shouldAutoPull / auto-triage.js's
// shouldAutoTriage -- no Date.now() baked in, a test drives either with any (lastAt, nowMs) pair.
function shouldAutoIntake(lastAt, nowMs, autoIntakeMs) {
  if (!(autoIntakeMs > 0)) return false;
  if (lastAt === null || lastAt === undefined) return true;
  return nowMs - lastAt >= autoIntakeMs;
}

function shouldScanConfirms(lastAt, nowMs, reportConfirmScanMs) {
  if (!(reportConfirmScanMs > 0)) return false;
  if (lastAt === null || lastAt === undefined) return true;
  return nowMs - lastAt >= reportConfirmScanMs;
}

// action 2.1b: routed through command-timeout.js's armTimeout -- report:card / gh issue list /
// gh issue create (stage 1) and gh api comments / gh issue close (stage 2) used to spawn with no
// timeout at all, in a daemon-loop timer with no per-task lock to hold but every bit as capable of
// wedging the whole `spo` daemon process as any of the calls 2.1 already bounded (the daemon is
// single-threaded; a hung spawnSync here blocks auto-pull/auto-triage/the queue drain right along
// with it). `config` is threaded through from each caller below (runReportIntake/
// reportConfirmScan both already take it as a parameter) -- a missing config arms no timeout,
// same tolerant default armTimeout/classTimeoutMs already document. Never retried, never thrown:
// this is a daemon-loop scan, not a task step -- there is no ParkSignal to throw INTO (no ctx, no
// task), and every one of these calls gets another chance on the next autoIntakeMs/
// reportConfirmScanMs tick regardless, so a retry here would only double the exposure for no gain.
function runSync(deps, command, args, opts = {}, config) {
  return armTimeout(deps, config, command, args, opts);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// moveWithRetry -- SPO-WebClient's board's own auto-add GitHub Action (adds a newly-filed issue
// to the project) runs asynchronously after `gh issue create` returns, so a move attempted
// immediately can race it: board-move.sh's own exit 2 ("issue is not on the board") is exactly
// that race, reproduced live 2026-08-30 (issue #443 -- the move failed on the first try, then
// succeeded seconds later by hand). Retrying a few times with a short delay absorbs that window;
// deps.sleep is the test-injection point (real code never overrides it).
async function moveWithRetry(issueNumber, column, deps, opts, retries = 3, delayMs = 3000) {
  let result;
  for (let attempt = 0; attempt < retries; attempt++) {
    result = board.moveIssueToColumn(issueNumber, column, deps, opts);
    if (result.ok) return result;
    if (attempt < retries - 1) await (deps.sleep || sleep)(delayMs);
  }
  return result;
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

// The literal hand-off line reportConfirmScan looks for -- verbatim in every intake comment,
// the RETRY_ABANDON_LINE of this stage.
const CONFIRM_DISCARD_LINE =
  'pipeline: reply "confirm" to send this report through reproduction and review, or "discard" ' +
  'to close it. Nothing automated has looked at it yet -- this is the report exactly as it was ' +
  'captured.';

function buildIntakeComment({ reportFile }) {
  return [
    '### Raw bug report -- awaiting your read',
    '',
    `Source file: \`${reportFile}\``,
    '',
    'This card was filed mechanically -- no reproduction, no classification, nothing automated',
    'has judged it. What you see above is the report as captured.',
    '',
    CONFIRM_DISCARD_LINE,
  ].join('\n');
}

// Parses report-card.js's stdout contract:
//   anchorKey: <hex>
//   profile: desktop|mobile
//   kind: wrong-data|broken-action|visual|suggestion
//   title: <one line>
//   ---
//   <body markdown to EOF>
//
// `kind` is threaded through to stage 3 (auto-triage.js) via the report-intake/report-confirmed
// journal events below -- it is the one report-content field this repo reads directly, and only
// because report-card.js's own header already relays it as a plain enum value, the same way
// anchorKey/profile/title already are; auto-triage.js never re-derives it from the raw report.
function parseCardOutput(stdout) {
  const sep = (stdout || '').indexOf('\n---\n');
  if (sep === -1) return null;
  const header = stdout.slice(0, sep);
  const body = stdout.slice(sep + 5);
  const anchorKey = (header.match(/^anchorKey:\s*(.+)$/m) || [])[1];
  const profile = (header.match(/^profile:\s*(.+)$/m) || [])[1];
  const kind = (header.match(/^kind:\s*(.+)$/m) || [])[1];
  const title = (header.match(/^title:\s*(.+)$/m) || [])[1];
  if (!anchorKey || !profile || !title) return null;
  return { anchorKey: anchorKey.trim(), profile: profile.trim(), kind: kind ? kind.trim() : null, title: title.trim(), body };
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

// ---- stage 1: mechanical intake -----------------------------------------------------------

// runReportIntake(journalRoot, config, deps) -- report:card + mechanical anchorKey dedup +
// gh issue create + board move + confirm-instruction comment, for the top config.autoIntakeLimit
// queued reports. Zero LLM calls. Journals `report-intake` (with the confirm-scan anchor) per
// filed card, `report-intake-duplicate` per mechanical dedup hit, `report-intake-schema-version`
// on a version mismatch (report left in place, never silently dropped), and one aggregate
// `report-intake-cycle` summary when at least one report was disposed of.
async function runReportIntake(journalRoot, config, deps = {}) {
  const spoReportsDir = config.spoReportsDir;
  const productRepo = deps.productRepo || config.productRepo;
  const ghRepo = deps.ghRepo || config.ghRepo;
  const reportIntakeColumn = config.reportIntakeColumn || 'Intake';
  const reportIntakeLabel = config.reportIntakeLabel || 'report:raw';
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const limit = config.autoIntakeLimit || DEFAULT_AUTO_INTAKE_LIMIT;

  const top = listQueuedReports(spoReportsDir).slice(0, limit);

  const results = [];
  const errors = [];
  let filed = 0;
  let duplicates = 0;
  let schemaVersion = 0;

  for (const reportPath of top) {
    const file = path.basename(reportPath);

    const cardResult = runSync(deps, 'npm', ['run', 'report:card', '--', reportPath], { cwd: productRepo }, config);
    const cardExit = normalizeExit(cardResult);

    if (cardExit === 3) {
      schemaVersion++;
      const found = ((cardResult.stdout || '').match(/^found:\s*(.+)$/m) || [])[1] || 'unknown';
      const expected = ((cardResult.stdout || '').match(/^expected:\s*(.+)$/m) || [])[1] || 'unknown';
      appendDaemonEvent(journalRoot, 'report-intake-schema-version', { reportFile: file, found, expected });
      alertDaemon(config.parkAlertCmd, deps, [file, `schema version mismatch: found ${found}, expected ${expected}`, 'INTAKE']);
      results.push({ file, outcome: 'schema-version', found, expected });
      continue; // never archived -- see this file's header
    }
    if (cardExit !== 0) {
      const timedOut = cardResult.timedOut === true;
      errors.push({ file, error: `report:card exited ${cardExit}`, timedOut });
      results.push({ file, outcome: 'error', error: `report:card exited ${cardExit}`, timedOut });
      continue; // stays queued, retried next cycle
    }

    const card = parseCardOutput(cardResult.stdout);
    if (!card) {
      errors.push({ file, error: 'report:card stdout did not match the expected contract' });
      results.push({ file, outcome: 'error', error: 'unparsable report:card output' });
      continue;
    }

    // Mechanical dedup -- a grep-shaped search, no judgement. The identical query
    // triageBugReport's own § 3 will later run against a NEW report; here it only prevents this
    // stage from opening a second raw card for a repeat report.
    const searchResult = runSync(deps, 'gh', [
      'issue', 'list', '--repo', ghRepo, '--state', 'all',
      '--search', `anchorKey: ${card.anchorKey} in:body`, '--json', 'number',
    ], {}, config);
    if (normalizeExit(searchResult) === 0) {
      let hits = [];
      try {
        hits = JSON.parse(searchResult.stdout);
      } catch {
        hits = [];
      }
      if (Array.isArray(hits) && hits.length > 0) {
        const existingIssue = hits[0].number;
        const commented = intake.postIssueComment(
          existingIssue,
          `New occurrence: ${today}, profile ${card.profile}, report \`${file}\`.`,
          deps
        );
        if (!commented.ok) {
          errors.push({ file, error: commented.error });
          results.push({ file, outcome: 'error', error: commented.error });
          continue;
        }
        moveReportTo(reportPath, path.join(spoReportsDir, 'archive'), `duplicate: #${existingIssue} — ${today}`);
        appendDaemonEvent(journalRoot, 'report-intake-duplicate', { issue: existingIssue, reportFile: file });
        duplicates++;
        results.push({ file, outcome: 'duplicate', issueNumber: existingIssue });
        continue;
      }
    }
    // A failed search is NOT fatal -- worst case this cycle files a raw card that stage 3's own
    // dedup search catches later (it re-runs the identical query). Never blocks intake on it.

    const bodyFile = path.join(deps.tmpDir || os.tmpdir(), `spo-raw-report-${Date.now()}-${process.pid}.md`);
    fs.writeFileSync(bodyFile, card.body);
    const createResult = runSync(deps, 'gh', [
      'issue', 'create', '--repo', ghRepo, '--title', card.title,
      '--body-file', bodyFile, '--label', reportIntakeLabel,
    ], {}, config);
    if (normalizeExit(createResult) !== 0) {
      const error = `gh issue create exited ${normalizeExit(createResult)}`;
      const timedOut = createResult.timedOut === true;
      errors.push({ file, error, timedOut });
      results.push({ file, outcome: 'error', error, timedOut });
      continue;
    }
    const issueNumber = intake.parseIssueNumber(createResult.stdout);
    if (!issueNumber) {
      const error = 'could not parse an issue number from gh issue create output';
      errors.push({ file, error });
      results.push({ file, outcome: 'error', error });
      continue;
    }

    const moved = await moveWithRetry(issueNumber, reportIntakeColumn, deps, { cwd: productRepo, config });
    if (!moved.ok) {
      appendDaemonEvent(journalRoot, 'report-intake-move-failed', {
        issue: issueNumber,
        column: reportIntakeColumn,
        exit: moved.exit,
        timedOut: moved.timedOut === true,
      });
      alertDaemon(config.parkAlertCmd, deps, [String(issueNumber), `failed to move to "${reportIntakeColumn}"`, 'INTAKE']);
      // Continue anyway -- the card exists and carries reportIntakeLabel, which makeTask's own
      // guard also refuses to drain regardless of column. See this file's header.
    }

    const commented = intake.postIssueComment(issueNumber, buildIntakeComment({ reportFile: file }), deps);
    if (!commented.ok) {
      errors.push({ file, error: commented.error, issue: issueNumber });
      results.push({ file, outcome: 'error', error: commented.error, issueNumber });
      continue;
    }

    const pendingPath = moveReportTo(reportPath, path.join(spoReportsDir, 'pending'), `intake: #${issueNumber} — ${today}`);
    appendDaemonEvent(journalRoot, 'report-intake', {
      reportFile: file,
      pendingPath,
      issue: issueNumber,
      commentId: commented.commentId,
      kind: card.kind,
    });
    filed++;
    results.push({ file, outcome: 'filed', issueNumber });
  }

  const disposed = filed + duplicates + schemaVersion;
  if (disposed > 0) {
    appendDaemonEvent(journalRoot, 'report-intake-cycle', { processed: top.length, filed, duplicates, schemaVersion, errors: errors.length });
  }

  return { ok: true, processed: top.length, filed, duplicates, schemaVersion, errors, results };
}

// ---- stage 2: the confirm/discard comment scan -----------------------------------------------

// findPendingIntake(journalRoot) -- every `report-intake` event in daemon.jsonl with no LATER
// `report-confirmed`/`report-discarded` event for the same issue number -- the same
// anchor+alreadyHandled idiom auto-triage.js's findConfirmedAwaitingTriage (and, one level
// further back, park-loop.js's findParkAnchor) already use.
function findPendingIntake(journalRoot) {
  const lines = readDaemonEvents(journalRoot);
  const pending = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].event !== 'report-intake') continue;
    const issue = lines[i].issue;
    const handledLater = lines
      .slice(i + 1)
      .some((e) => (e.event === 'report-confirmed' || e.event === 'report-discarded') && e.issue === issue);
    if (!handledLater) pending.push(lines[i]);
  }
  return pending;
}

// firstLine matching itself now lives in comment-scan.js's scanForMatch -- CONFIRM_RE/DISCARD_RE
// stay here because they are reportConfirmScan's OWN vocabulary (park-loop.js has its own,
// RETRY_RE/ABANDON_RE), threaded into scanForMatch as `patterns` below.
const CONFIRM_RE = /^confirm\b/i;
const DISCARD_RE = /^discard\b/i;
const CONFIRM_PATTERNS = [
  { name: 'confirm', re: CONFIRM_RE },
  { name: 'discard', re: DISCARD_RE },
];

// action 2.7: reportConfirmScan's own event names for comment-scan.js's scanForMatch -- see that
// module's header for what each one means and park-loop.js's own UNPARK_SCAN_EVENTS for the
// sibling set. Daemon-scoped here (appendDaemonEvent), not task-scoped: a pending raw report has
// no task directory of its own (it belongs to no `journal/<id>/`, only daemon.jsonl -- see this
// file's own header), unlike park-loop.js's unparkScan which always has one.
const CONFIRM_SCAN_EVENTS = {
  truncated: 'report-confirm-scan-truncated',
  ignoredAuthor: 'report-confirm-scan-ignored-author',
  backoffSkip: 'report-confirm-scan-backoff-skip',
};

// reportConfirmScan(journalRoot, config, deps, scanState) -- one pass over every pending raw
// card. For each, comment-scan.js's scanForMatch fetches the issue's comments after the intake
// anchor (paginated, allowlisted, backed off on failure -- see that module's header) and finds
// the first AUTHORIZED comment whose FIRST LINE is "confirm"/"discard". Anything else on the
// issue -- a non-collaborator's reply, or a comment matching neither word -- is left alone.
// `scanState` (comment-scan.js's createScanState()) is a fresh one by default -- state-machine.js's
// runForever passes one it created once and keeps across cycles, so the collaborator cache and
// backoff table persist between scans instead of re-paying for both every cycle.
async function reportConfirmScan(journalRoot, config, deps = {}, scanState = commentScan.createScanState()) {
  const ghRepo = deps.ghRepo || config.ghRepo;
  const spoReportsDir = config.spoReportsDir;
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const pending = findPendingIntake(journalRoot);
  const nowMs = deps.now !== undefined ? deps.now : Date.now();

  let confirmed = 0;
  let discarded = 0;
  let skipped = 0;
  const errors = [];

  for (const entry of pending) {
    const scan = await commentScan.scanForMatch({
      deps,
      config,
      ghRepo,
      issue: entry.issue,
      anchorId: entry.commentId,
      patterns: CONFIRM_PATTERNS,
      scanState,
      journalRoot,
      journal: (event, detail) => appendDaemonEvent(journalRoot, event, { issue: entry.issue, ...detail }),
      events: CONFIRM_SCAN_EVENTS,
      scannerKey: 'report-confirm',
      now: nowMs,
      maxPages: config && config.commentScanMaxPages,
    });

    if (!scan.ok) {
      if (scan.reason === 'backoff') {
        skipped++;
        continue; // already journalled by scanForMatch
      }
      errors.push({
        issue: entry.issue,
        error:
          scan.reason === 'unparsable'
            ? 'unparsable comments reply'
            : `gh api comments exited ${scan.exit}`,
        timedOut: scan.timedOut === true,
      });
      continue;
    }
    if (!scan.match) continue;
    const match = scan.match.comment;

    if (scan.match.name === 'confirm') {
      appendDaemonEvent(journalRoot, 'report-confirmed', {
        issue: entry.issue,
        pendingPath: entry.pendingPath,
        commentId: match.id,
        kind: entry.kind,
      });
      confirmed++;
      continue;
    }

    // discard -- terminal, closes the raw card and archives the report.
    const closed = runSync(deps, 'gh', ['issue', 'close', String(entry.issue), '--repo', ghRepo, '--reason', 'not planned'], {}, config);
    if (normalizeExit(closed) !== 0) {
      errors.push({
        issue: entry.issue,
        error: `gh issue close exited ${normalizeExit(closed)}`,
        timedOut: closed.timedOut === true,
      });
      continue; // stays pending, retried next scan
    }
    moveReportTo(entry.pendingPath, path.join(spoReportsDir, 'archive'), `discarded: #${entry.issue} — ${today}`);
    appendDaemonEvent(journalRoot, 'report-discarded', { issue: entry.issue, discardCommentId: match.id });
    discarded++;
  }

  return { ok: true, pending: pending.length, confirmed, discarded, skipped, errors };
}

module.exports = {
  shouldAutoIntake,
  shouldScanConfirms,
  runReportIntake,
  reportConfirmScan,
  findPendingIntake,
  parseCardOutput,
  buildIntakeComment,
  CONFIRM_DISCARD_LINE,
  DEFAULT_AUTO_INTAKE_MS,
  DEFAULT_AUTO_INTAKE_LIMIT,
  DEFAULT_REPORT_CONFIRM_SCAN_MS,
};
