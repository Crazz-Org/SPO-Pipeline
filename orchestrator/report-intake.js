'use strict';
// report-intake.js -- stages 1 and 2 of the human-first bug-report intake pipeline:
//
//   runReportIntake  -- (stage 1, MECHANICAL, zero LLM judgement) for each queued report under
//     ~/.spo-reports: renders it RAW via SPO-WebClient's `npm run report:card` (schema knowledge
//     lives there, beside the schema it reads -- this file never parses report content), dedups
//     mechanically by `anchorKey` (a grep-shaped `gh issue list --search`, not a judgement), files
//     a raw card labeled config.reportIntakeLabel on the PRIVATE config.reportIntakeRepo, posts
//     the confirm/discard instructions there, and moves the report file to ~/.spo-reports/pending/.
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
// WHY the raw render can't live in this file: putting the report in front of a human with NO
// classification is the whole point of the human-first design (a bug that turns out to be "just"
// a bad render must never be silently excluded before a human sees it) -- but rendering it at all
// means reading `profile`/`anchor`/`observed`/`quickPicks`/`geometry`, which is exactly the
// product-repo knowledge "the one rule" keeps out of this repo. So the renderer lives beside the
// schema it reads (SPO-WebClient's scripts/report-card.js), and this file only ever spawns it and
// relays its opaque stdout -- the same relationship pullBoard already has with
// `npm run board:claim`.
//
// WHY the raw card goes to a PRIVATE repository (card SPO-Pipeline#299). That render is the
// report exactly as captured: the reporter's `username` and `world`, their observed/expected
// free text and quick picks, and the whole client journal, verbatim. Until #299 stage 1 filed it
// on config.ghRepo (SPO-WebClient -- public) and moved it onto project 1 (public too), so the
// first real player report would have been published the moment it was filed; every one filed
// before #299 came from a test account, which is the only reason nothing leaked. So:
//   - every stage-1 and stage-2 `gh` call names reportIntakeRepo (or, in stage 2, the repo the
//     pending event itself recorded), never ghRepo -- a spawn aimed at ghRepo from this file would
//     be carrying player data onto a public surface, and test/report-intake.test.js runs a whole
//     cycle and fails on any spawn that names ghRepo at all;
//   - stage 1 FAILS CLOSED (checkReportIntakeRepo below): an unset setting, one equal to ghRepo,
//     a failed or unparsable visibility read, or anything but `"private": true` refuses the WHOLE
//     cycle before the first render -- nothing filed, every report left in the queue. There is no
//     fallback to ghRepo, ever: "file it publicly for now" is the exact defect being closed;
//   - the move to project 1's reportIntakeColumn is gone. The private repository's issues are not
//     on project 1, and a raw card has no business on a public board anyway. (That move was the
//     one board write in this repo a failure of which was NOT safe to ignore -- a raw card stuck
//     in Todo was claimable -- so its removal also retires that failure mode; intake.makeTask's
//     reportIntakeLabel guard stays as defence in depth.)
// Stage 3 (auto-triage.js) is the only stage that writes to ghRepo; this file writes nothing
// there at all.

const fs = require('fs');
const os = require('os');
const path = require('path');

const intake = require('./intake');
const board = require('./board');
const { appendDaemonEvent } = require('./journal');
const { alertDaemon } = require('./park-alert');
// sameRepoName / sameEventRepo / isLegacyPublicEntry (card #299) live in auto-triage.js, which
// stage 3 needs them in too; this file already requires it, so the reverse would be a cycle.
const { listQueuedReports, moveReportTo, sameRepoName, sameEventRepo, isLegacyPublicEntry } = require('./auto-triage');
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
//
// Card SPO-Pipeline#299: NO caller in this file any more -- stage 1 files the raw card on the
// private reportIntakeRepo, which is not on project 1, so there is nothing to move (see this
// file's header). Kept, and exported, for stage 3: once auto-triage.js files a NEW public card
// on ghRepo instead of editing the raw one, that card's first move races the same auto-add
// Action this was written for.
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

// ---- stage 1: the private-repository gate (card SPO-Pipeline#299) --------------------------

// `owner/name`, each segment GitHub's own character set. Checked before the name is spliced into
// the `gh api repos/<it>` path: a value such as `x/../users/y` would otherwise ask gh about some
// OTHER resource, whose own `private` field (or its absence) says nothing about where the raw
// card would land.
const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// checkReportIntakeRepo(config, deps) -- the fail-closed gate every stage-1 cycle passes before
// it renders a single report. Returns {ok: true, repo} only when config.reportIntakeRepo names a
// well-formed repository, other than ghRepo (compared case-insensitively: GitHub's names are),
// that one `gh api repos/<repo>` GET reports as `"private": true`. Anything else is {ok: false,
// repo, reason}:
//   unset               -- no SPO_REPORT_INTAKE_REPO (config.js has no default, deliberately)
//   malformed           -- not `owner/name` (see REPO_NAME_RE)
//   same-as-public-repo -- the setting, or the repository gh actually answered for (a renamed
//                          repository redirects), is ghRepo
//   visibility-check-failed -- gh exited non-zero or timed out (exit/timedOut/stderr attached)
//   visibility-unparsable   -- gh exited 0 with something that is not a repository object
//   not-private         -- the repository answered, and `private` is anything but `true`
// `private !== true`, not `private === false`: a reply that omits the field, or carries it as the
// string "true", proves nothing about the repository, and only proof lets a raw report through.
// A plain GET -- no `-f`, which would make it a POST (test/gh-api-argv.test.js).
function checkReportIntakeRepo(config, deps = {}) {
  const repo = (config && config.reportIntakeRepo) || '';
  const ghRepo = deps.ghRepo || (config && config.ghRepo) || '';
  if (!repo) return { ok: false, repo, reason: 'unset' };
  if (!REPO_NAME_RE.test(repo) || repo.split('/').some((seg) => seg === '.' || seg === '..')) {
    return { ok: false, repo, reason: 'malformed' };
  }
  if (sameRepoName(repo, ghRepo)) return { ok: false, repo, reason: 'same-as-public-repo' };

  const result = runSync(deps, 'gh', ['api', `repos/${repo}`], {}, config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    return {
      ok: false,
      repo,
      reason: 'visibility-check-failed',
      exit,
      timedOut: result && result.timedOut === true,
      stderr: commentScan.firstStderrLine(result) || undefined,
    };
  }
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, repo, reason: 'visibility-unparsable' };
  }
  if (sameRepoName(body.full_name, ghRepo)) return { ok: false, repo, reason: 'same-as-public-repo' };
  if (body.private !== true) return { ok: false, repo, reason: 'not-private' };
  return { ok: true, repo };
}

// The throttle. A refused cycle leaves the queue untouched, so the NEXT cycle -- every
// autoIntakeMs, forever, while the setting stays wrong -- is refused for the same reason. One
// event and one alert per cycle would be the shape that once buried a real 33-hour outage under
// 1164 near-identical journal lines (auto-pull.js's pullAndEnqueue header), and a push alert every
// 15 minutes gets muted, which is worse than none. So the state lives in daemon.jsonl itself
// (shared by the daemon's timer and a hand-run `spo intake`, and it survives a restart), read
// back as the most recent of the two events below:
//   - a refusal is journalled, and alerted, only when the last gate event is NOT already a
//     refusal of the same {repo, reason} -- the first refusal, or a CHANGED reason (the setting
//     was edited, the repository went from missing to public, ...), is news; a repeat is not;
//   - the first cycle that PASSES after a journalled refusal journals
//     `report-intake-repo-accepted` {repo} (no alert -- intake resuming is visible in the
//     `report-intake` events that follow). That closes the episode: a later refusal, even for
//     the same reason, is journalled and alerted afresh.
// Bound: one refusal plus one acceptance per real transition. A flapping `gh` (the visibility
// GET failing every other cycle) would still produce two lines per flap -- each one a genuine
// change of what intake did, which is the line between signal and the noise this avoids.
// Reads only happen with a non-empty queue (runReportIntake returns before the gate otherwise).
function lastRepoGateEvent(journalRoot) {
  const events = readDaemonEvents(journalRoot);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'report-intake-refused-not-private' || e.event === 'report-intake-repo-accepted') return e;
  }
  return null;
}

// ---- stage 1: mechanical intake -----------------------------------------------------------

// runReportIntake(journalRoot, config, deps) -- private-repository gate + report:card +
// mechanical anchorKey dedup + gh issue create + confirm-instruction comment, for the top
// config.autoIntakeLimit queued reports. Zero LLM calls. Every `gh` call names reportIntakeRepo
// (see this file's header). Journals `report-intake` (with the confirm-scan anchor and `repo`)
// per filed card, `report-intake-duplicate` per mechanical dedup hit, `report-intake-schema-
// version` on a version mismatch (report left in place, never silently dropped), one aggregate
// `report-intake-cycle` summary when at least one report was disposed of, and the gate's own
// throttled `report-intake-refused-not-private` / `report-intake-repo-accepted`.
async function runReportIntake(journalRoot, config, deps = {}) {
  const spoReportsDir = config.spoReportsDir;
  const productRepo = deps.productRepo || config.productRepo;
  const reportIntakeLabel = config.reportIntakeLabel || 'report:raw';
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const limit = config.autoIntakeLimit || DEFAULT_AUTO_INTAKE_LIMIT;

  const top = listQueuedReports(spoReportsDir).slice(0, limit);

  // An empty queue spends nothing -- not even the visibility GET below. Same shape this function
  // always had (the loop simply never ran); returned early now so the gate is not paid for on
  // every tick of an idle daemon.
  if (top.length === 0) {
    return { ok: true, processed: 0, filed: 0, duplicates: 0, schemaVersion: 0, errors: [], results: [] };
  }

  const gate = checkReportIntakeRepo(config, deps);
  const lastGate = lastRepoGateEvent(journalRoot);
  if (!gate.ok) {
    const repeat =
      lastGate &&
      lastGate.event === 'report-intake-refused-not-private' &&
      lastGate.repo === gate.repo &&
      lastGate.reason === gate.reason;
    if (!repeat) {
      appendDaemonEvent(journalRoot, 'report-intake-refused-not-private', {
        repo: gate.repo,
        reason: gate.reason,
        queued: top.length,
        exit: gate.exit,
        timedOut: gate.timedOut,
        stderr: gate.stderr,
      });
      alertDaemon(config.parkAlertCmd, deps, [
        gate.repo || '(SPO_REPORT_INTAKE_REPO unset)',
        `report intake refused (${gate.reason}): raw reports are only filed on a private repository -- ${top.length} report(s) left queued`,
        'INTAKE',
      ]);
    }
    // ok:false -- nothing was attempted, and a caller (bin/spo's cmdIntake) must not read this
    // as "the queue was empty". Every report stays exactly where it was.
    return {
      ok: false,
      refused: true,
      reason: gate.reason,
      repo: gate.repo,
      queued: top.length,
      processed: 0,
      filed: 0,
      duplicates: 0,
      schemaVersion: 0,
      errors: [],
      results: [],
    };
  }
  if (lastGate && lastGate.event === 'report-intake-refused-not-private') {
    appendDaemonEvent(journalRoot, 'report-intake-repo-accepted', { repo: gate.repo });
  }

  const reportIntakeRepo = gate.repo;
  // intake.postIssueComment reads its target from deps.ghRepo. Overridden HERE, once, so neither
  // comment below can fall back to config.ghRepo -- the public repository -- by omission.
  const repoDeps = { ...deps, ghRepo: reportIntakeRepo };

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

    // Mechanical dedup -- a grep-shaped search, no judgement, over the PRIVATE repository's raw
    // cards only: it prevents this stage from opening a second raw card for a repeat report. The
    // raw cards filed on ghRepo before card #299 are not searched -- a repeat of one of those
    // opens a fresh private card, which is the point.
    const searchResult = runSync(deps, 'gh', [
      'issue', 'list', '--repo', reportIntakeRepo, '--state', 'all',
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
          repoDeps
        );
        if (!commented.ok) {
          errors.push({ file, error: commented.error });
          results.push({ file, outcome: 'error', error: commented.error });
          continue;
        }
        moveReportTo(reportPath, path.join(spoReportsDir, 'archive'), `duplicate: ${reportIntakeRepo}#${existingIssue} — ${today}`, journalRoot);
        appendDaemonEvent(journalRoot, 'report-intake-duplicate', { issue: existingIssue, repo: reportIntakeRepo, reportFile: file });
        duplicates++;
        results.push({ file, outcome: 'duplicate', issueNumber: existingIssue, repo: reportIntakeRepo });
        continue;
      }
    }
    // A failed search is NOT fatal -- worst case this cycle files a second raw card for a repeat
    // report, on the private repository, where a maintainer discards it. Never blocks intake on it.

    const bodyFile = path.join(deps.tmpDir || os.tmpdir(), `spo-raw-report-${Date.now()}-${process.pid}.md`);
    fs.writeFileSync(bodyFile, card.body);
    const createResult = runSync(deps, 'gh', [
      'issue', 'create', '--repo', reportIntakeRepo, '--title', card.title,
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

    // No board move here any more (card #299): the private repository is not on project 1. See
    // this file's header.

    const commented = intake.postIssueComment(issueNumber, buildIntakeComment({ reportFile: file }), repoDeps);
    if (!commented.ok) {
      errors.push({ file, error: commented.error, issue: issueNumber });
      results.push({ file, outcome: 'error', error: commented.error, issueNumber });
      continue;
    }

    // moveReportTo can now return `null` (its swallowed-ENOENT branch -- see that function's own
    // header in auto-triage.js): the source report vanished before this move could complete, so
    // there is no real path to vouch for. `pendingPath` here is used for NOTHING but this journal
    // field -- grepped every use of this binding, and reportConfirmScan/routeConfirmedReport/
    // processConfirmedReport all read it back off the EVENT (entry.pendingPath), never off this
    // local variable directly. Writing `null` rather than omitting the field is deliberate: an
    // absent field reads, to a maintainer or to any future reader that just checks `'pendingPath'
    // in entry`, as an OLDER event shape that never carried one at all -- indistinguishable from
    // "we didn't try". `null` says "we tried, and could not vouch for it", which is what actually
    // happened, and auto-triage.js's own `retryHeldReport` already guards `if (!pendingPath ||
    // !isFile(pendingPath))` (and this action's own new guards in auto-triage.js's
    // claimReport/routeConfirmedReport) already treat a falsy pendingPath as an anticipated shape,
    // not a new one to react badly to.
    //
    // `repo` (card #299) is where the raw issue lives: `issue` is a number IN that repository, and
    // reportConfirmScan reads it back off this event rather than off the current setting (see
    // there). An event WITHOUT it was filed on ghRepo before #299 -- the legacy shape.
    const pendingPath = moveReportTo(reportPath, path.join(spoReportsDir, 'pending'), `intake: ${reportIntakeRepo}#${issueNumber} — ${today}`, journalRoot);
    appendDaemonEvent(journalRoot, 'report-intake', {
      reportFile: file,
      pendingPath,
      issue: issueNumber,
      repo: reportIntakeRepo,
      commentId: commented.commentId,
      kind: card.kind,
      // Card #299: stage 3's duplicate path puts the profile on a PUBLIC issue, in a fixed line
      // -- recorded here, where it is already parsed, so stage 3 never has to read the report.
      profile: card.profile,
    });
    filed++;
    results.push({ file, outcome: 'filed', issueNumber, repo: reportIntakeRepo });
  }

  const disposed = filed + duplicates + schemaVersion;
  if (disposed > 0) {
    appendDaemonEvent(journalRoot, 'report-intake-cycle', { processed: top.length, repo: reportIntakeRepo, filed, duplicates, schemaVersion, errors: errors.length });
  }

  return { ok: true, repo: reportIntakeRepo, processed: top.length, filed, duplicates, schemaVersion, errors, results };
}

// ---- stage 2: the confirm/discard comment scan -----------------------------------------------

// Card #299: an issue number is only meaningful WITH its repository (sameEventRepo, from
// auto-triage.js) -- the private repo's #12 and the public repo's legacy #12 are two different
// reports. Events that carry no `repo` are the pre-#299 shape (filed on ghRepo).
// findPendingIntake(journalRoot) -- every `report-intake` event in daemon.jsonl with no LATER
// `report-confirmed`/`report-discarded` event for the same issue in the same repository -- the
// same anchor+alreadyHandled idiom auto-triage.js's findConfirmedAwaitingTriage (and, one level
// further back, park-loop.js's findParkAnchor) already use.
function findPendingIntake(journalRoot) {
  const lines = readDaemonEvents(journalRoot);
  const pending = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].event !== 'report-intake') continue;
    const entry = lines[i];
    const handledLater = lines
      .slice(i + 1)
      .some(
        (e) =>
          (e.event === 'report-confirmed' || e.event === 'report-discarded') &&
          e.issue === entry.issue &&
          sameEventRepo(e, entry)
      );
    if (!handledLater) pending.push(entry);
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
//
// Card #299 -- which repository each entry is scanned on:
//   - the repository the `report-intake` event RECORDED (`entry.repo`), not the current
//     config.reportIntakeRepo. `issue` is a number in that repository; if the setting has since
//     changed, the raw card still lives where it was filed, and scanning the new repository's
//     same-numbered issue would act on a stranger's reply to a different report. So the comments,
//     the collaborator allowlist (comment-scan.js caches it per repository) and a discard's
//     `gh issue close` all follow `entry.repo`;
//   - an entry scanned this way is scanned whatever the CURRENT setting's state -- unset, or
//     pointing at a repository that is not private. This stage publishes nothing: it reads
//     comments, journals, and on "discard" closes the issue where it already is. Stage 1's gate
//     guards the one write that could publish a report (filing it); refusing the scan too would
//     only strand reports a maintainer has already answered;
//   - a LEGACY entry (isLegacyPublicEntry: filed on the public ghRepo before #299) is skipped,
//     never scanned: `issue` is a public issue, and nothing about it should flow further from here
//     automatically. It is journalled `report-intake-legacy-public` ONCE per issue (a prior event
//     for the same issue suppresses the next -- the entry stays pending, so without that it would
//     repeat every scan) and left for the one-time manual cleanup README § Report intake describes.
async function reportConfirmScan(journalRoot, config, deps = {}, scanState = commentScan.createScanState()) {
  const ghRepo = deps.ghRepo || config.ghRepo;
  const spoReportsDir = config.spoReportsDir;
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const pending = findPendingIntake(journalRoot);
  const nowMs = deps.now !== undefined ? deps.now : Date.now();

  let confirmed = 0;
  let discarded = 0;
  let skipped = 0;
  let legacy = 0;
  const errors = [];

  // Read once per scan, not once per legacy entry: the set of issues already journalled legacy.
  let legacyJournalled = null;

  for (const entry of pending) {
    if (isLegacyPublicEntry(entry, ghRepo)) {
      legacy++;
      if (legacyJournalled === null) {
        legacyJournalled = new Set(
          readDaemonEvents(journalRoot)
            .filter((e) => e.event === 'report-intake-legacy-public')
            .map((e) => e.issue)
        );
      }
      if (!legacyJournalled.has(entry.issue)) {
        appendDaemonEvent(journalRoot, 'report-intake-legacy-public', {
          issue: entry.issue,
          repo: entry.repo || null,
          reportFile: entry.reportFile,
          pendingPath: entry.pendingPath,
        });
        legacyJournalled.add(entry.issue);
      }
      continue;
    }
    const repo = entry.repo;

    const scan = await commentScan.scanForMatch({
      deps,
      config,
      ghRepo: repo,
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
        // Project-2 card #476 was measured on the unpark side of this shared scanner, but the
        // blindness is the scanner's, not park-loop.js's: "gh api comments exited 1" names no
        // endpoint, no HTTP status and no cause either. `stderr` is `gh`'s own first line,
        // dropped (never `null`) on the 'unparsable' branch, where `gh` exited 0 and said nothing.
        error:
          scan.reason === 'unparsable'
            ? 'unparsable comments reply'
            : `gh api comments exited ${scan.exit}`,
        stderr: scan.stderr || undefined,
        timedOut: scan.timedOut === true,
      });
      continue;
    }
    if (!scan.match) continue;
    const match = scan.match.comment;

    if (scan.match.name === 'confirm') {
      // `repo` carried forward: stage 3 must address the raw issue where it lives, and
      // findPendingIntake matches this event back to its intake entry by (repo, issue).
      appendDaemonEvent(journalRoot, 'report-confirmed', {
        issue: entry.issue,
        repo,
        pendingPath: entry.pendingPath,
        commentId: match.id,
        kind: entry.kind,
        profile: entry.profile,
      });
      confirmed++;
      continue;
    }

    // discard -- terminal, closes the raw card and archives the report.
    const closed = runSync(deps, 'gh', ['issue', 'close', String(entry.issue), '--repo', repo, '--reason', 'not planned'], {}, config);
    if (normalizeExit(closed) !== 0) {
      errors.push({
        issue: entry.issue,
        error: `gh issue close exited ${normalizeExit(closed)}`,
        timedOut: closed.timedOut === true,
      });
      continue; // stays pending, retried next scan
    }
    moveReportTo(entry.pendingPath, path.join(spoReportsDir, 'archive'), `discarded: ${repo}#${entry.issue} — ${today}`, journalRoot);
    appendDaemonEvent(journalRoot, 'report-discarded', { issue: entry.issue, repo, discardCommentId: match.id });
    discarded++;
  }

  return { ok: true, pending: pending.length, confirmed, discarded, skipped, legacy, errors };
}

module.exports = {
  shouldAutoIntake,
  shouldScanConfirms,
  runReportIntake,
  reportConfirmScan,
  checkReportIntakeRepo,
  isLegacyPublicEntry,
  moveWithRetry,
  findPendingIntake,
  parseCardOutput,
  buildIntakeComment,
  CONFIRM_DISCARD_LINE,
  DEFAULT_AUTO_INTAKE_MS,
  DEFAULT_AUTO_INTAKE_LIMIT,
  DEFAULT_REPORT_CONFIRM_SCAN_MS,
};
