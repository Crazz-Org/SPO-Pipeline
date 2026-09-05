'use strict';
// park-loop.js -- the PARKED <-> kanban round trip for a real, kind:"card" task:
//
//   postParkComment -- called once, from state-machine.js's finalizePark, the moment a card
//     task parks in real mode: moves the card to "Parked" (board.js's moveCard, never blocks)
//     and posts a structured comment on the issue naming the reason and the literal
//     retry/abandon hand-off line.
//   unparkScan -- called once per daemon poll cycle (state-machine.js's runForever, real mode
//     only): for every journaled task still PARKED with a recorded park-comment anchor, reads
//     the issue's comments and acts on the first "retry" or "abandon" reply posted after that
//     anchor. An "abandon" match also runs abandonCleanup (action 4.5) -- a best-effort reclaim
//     of the leaked product worktree, its local/remote claude-pipe/<id> branch, and the open PR
//     (issue #443, where all three sat leaked indefinitely because ABANDONED used to do nothing
//     but write state.json).
//   reconcileExternalClosure -- action 5.1b, called from inside unparkScan's own per-task loop,
//     BEFORE the retry/abandon comment scan: for a PARKED or ABANDONED task whose owning issue
//     has since closed OUTSIDE the pipeline (a human fixed it by hand, or -- issue #443's shape --
//     the pipeline's own PR merged 30 seconds after a false park), records that fact on
//     `state.json` (`externallyResolved`) and in the journal (`reconciled-externally`) without
//     ever rewriting `state.state` -- see that function's own header for the full story and the
//     measured evidence.
//
// Anchor mechanics: `gh issue comment` prints the created comment's URL,
// `.../issues/<n>#issuecomment-<id>`. The numeric id is journaled as the park comment's anchor
// -- GitHub comment ids are monotonically increasing site-wide, so "a comment posted after the
// park comment" is exactly "a comment whose id is greater than the anchor", with no reliance on
// clocks or timestamps.

const fs = require('fs');
const path = require('path');

const { appendEvent, writeState } = require('./journal');
const { moveCard } = require('./board');
const { armTimeout } = require('./command-timeout');
const commentScan = require('./comment-scan');
const retryChannel = require('./retry-channel');
const { summarizeTask, formatAttemptLines } = require('./task-summary');
const { formatTokenCount } = require('./tokens');

// action 2.1b: routed through command-timeout.js's armTimeout -- the park comment's own `gh issue
// comment` (postParkComment) and the unpark scan's `gh api .../comments` + abandon-ack `gh issue
// comment` (unparkScan) used to spawn with no timeout at all. Both call sites run with the task
// ALREADY TERMINAL (postParkComment, called from finalizePark after state.json/report.md are
// already written) or with no task in scope at all (unparkScan, a daemon-loop scan) -- so unlike
// steps/scripted.js's spawnStep, a timeout here is never retried and never thrown as a
// ParkSignal: there is nothing left to park, and a retry buys nothing a task that gets scanned
// again on the next poll cycle wouldn't already get for free. `config` is threaded through from
// each caller (ctx.config for postParkComment, the existing `config` parameter for unparkScan) --
// a missing config arms no timeout, same tolerant default as every other armTimeout caller.
function runSync(deps, command, args, opts = {}, config) {
  return armTimeout(deps, config, command, args, opts);
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

function parseCommentId(stdout) {
  const m = (stdout || '').match(/#issuecomment-(\d+)/);
  return m ? Number(m[1]) : null;
}

// The literal hand-off line the unpark scan looks for -- verbatim in every park comment.
const RETRY_ABANDON_LINE =
  'pipeline: reply "retry" (optionally after fixing) to requeue, or "abandon" to close this attempt.';

// countRepeatedParks(lines, reason, detail) -- how many parks in a row, most recent first, share
// this exact reason + JSON.stringify(detail) fingerprint. Card #385's loop: branch-unmerged-
// leftover parked four times running, byte-identical detail every time, because each attempt's
// own WIP commit was what tripped the NEXT park (see steps/scripted.js's preserveWorktreeWip
// header). A maintainer's bare "retry" could never do anything but reproduce the same park --
// this is what lets finalizePark tell them so instead of letting the streak run forever. Walks
// only `parked` events (everything else journaled between two parks -- transitions, spawns -- is
// irrelevant to the streak) and stops at the first one that doesn't match; the park just
// journaled by the caller is itself included and always matches itself, so the result is never
// less than 1.
function countRepeatedParks(lines, reason, detail) {
  const fingerprint = JSON.stringify(detail);
  const parks = (lines || []).filter((line) => line && line.event === 'parked');
  let count = 0;
  for (let i = parks.length - 1; i >= 0; i--) {
    const park = parks[i];
    if (park.reason === reason && JSON.stringify(park.detail) === fingerprint) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

// `repeat` defaults to 1 (a first-time park) for every existing caller/test that doesn't pass it.
// >= 2 inserts a loop warning just above RETRY_ABANDON_LINE, which stays present verbatim in
// every case -- unparkScan's retry/abandon parsing and the rest of this suite depend on it.
//
// Action 5.2: `billableTokens`/`hasTokenData`/`parksCount`/`diagnoseAttempts`/`validateRejects`/
// `ciImplementRetries` are the card's CUMULATIVE totals across every attempt this taskDir has
// ever made (task-summary.js's summarizeTask -- see its own header for why cumulative, not just
// this run), computed by postParkComment below and handed in as plain numbers so this function
// stays pure -- no fs, directly unit-testable with no journal on disk at all, exactly as before.
// All six default so every pre-5.2 caller/test that doesn't pass them still renders (tokens as
// "not recorded", no attempt rows, no total-parks line) rather than throwing or printing
// "undefined". Inserted between RETRY_ABANDON_LINE and the <details> block, never touching either
// -- both are load-bearing (unparkScan's retry/abandon anchor, the maintainer-facing detail dump)
// and this only adds to the comment, never reorders or drops what was already there.
function buildParkComment({
  reason,
  detail,
  lastState,
  repeat = 1,
  billableTokens = 0,
  hasTokenData = false,
  parksCount = null,
  diagnoseAttempts,
  validateRejects,
  ciImplementRetries,
}) {
  const lines = [
    '### Pipeline parked',
    '',
    `**Reason:** \`${reason}\``,
    `**Last state:** \`${lastState}\``,
    '',
    'What the machine expects from you: read the reason above (and the detail below, if any),',
    'fix whatever it names if it needs fixing, then reply on this issue.',
    '',
  ];
  if (repeat >= 2) {
    lines.push(
      `> **This park is identical to the last ${repeat}** (\`${reason}\`, same detail). Replying`,
      '> `retry` on its own will change nothing: the state the machine refuses is the same from one',
      '> attempt to the next. Fix what the detail below names first.',
      ''
    );
  }
  lines.push(RETRY_ABANDON_LINE, '');

  const tokensText = hasTokenData ? formatTokenCount(billableTokens) : 'not recorded';
  const parksText =
    typeof parksCount === 'number' && parksCount > 0
      ? `, ${parksCount} ${parksCount === 1 ? 'park' : 'parks'} so far (this one included)`
      : '';
  lines.push(`**This card so far:** billable-weighted tokens ${tokensText}${parksText}.`, '');

  const attemptLines = formatAttemptLines({ diagnoseAttempts, validateRejects, ciImplementRetries });
  if (attemptLines.length > 0) {
    lines.push('Attempts:');
    lines.push(...attemptLines, '');
  }

  if (detail && Object.keys(detail).length > 0) {
    lines.push(
      '<details><summary>detail</summary>',
      '',
      '```json',
      JSON.stringify(detail, null, 2),
      '```',
      '</details>',
      ''
    );
  }
  return lines.join('\n');
}

// postParkComment(ctx, deps, {reason, detail, lastState, repeat}) -- moves the card to "Parked"
// (never blocks -- board.js's own rule) and posts the structured comment above. Journals
// `park-comment` with the parsed comment id (the unpark scan's anchor) on success,
// `park-comment-failed` on a non-zero gh exit -- neither one blocks anything, since the task is
// already terminal by the time this runs (state-machine.js's finalizePark calls it after the
// task's own PARKED state.json/report.md are already written). `repeat` defaults to 1, same as
// buildParkComment's own default, for any caller that doesn't compute a streak.
//
// Action 5.2: this is where the card's cumulative totals get COMPUTED (ctx.taskDir -> journal ->
// task-summary.js's summarizeTask), then handed to buildParkComment as plain numbers -- keeping
// that function pure, per its own header. Deliberately NOT `ctx.counters`: this function is
// called with bare `{task, taskDir, config}` fixtures in several tests (no `.counters` at all),
// and even where a real ctx.counters exists it only ever holds THIS run's attempts (state-
// machine.js's buildCtx resets it to 0 on every retry) -- reading the journal instead is what
// makes the totals genuinely cumulative across a card's whole park history, not just its latest
// attempt.
function postParkComment(ctx, deps, { reason, detail, lastState, repeat = 1 }) {
  moveCard(ctx, deps, 'PARKED');

  const issue = ctx.task && ctx.task.issue;
  if (!issue) {
    appendEvent(ctx.taskDir, 'PARKED', 'park-comment-skipped', { reason: 'no issue' });
    return;
  }

  const ghRepo = (ctx.config && ctx.config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const summary = summarizeTask(ctx.taskDir);
  const body = buildParkComment({
    reason,
    detail,
    lastState,
    repeat,
    billableTokens: summary.billableTokens,
    hasTokenData: summary.hasTokenData,
    parksCount: summary.parksCount,
    diagnoseAttempts: summary.diagnoseAttempts,
    validateRejects: summary.validateRejects,
    ciImplementRetries: summary.ciImplementRetries,
  });
  const commentFile = path.join(ctx.taskDir, 'park-comment.md');
  fs.writeFileSync(commentFile, body);

  // Issue #77: an anchor is what makes a parked card reachable again, and until this change
  // a non-zero `gh issue comment` left the card with none. findParkAnchor then returned null
  // and NOTHING could reach the card -- unparkScan `continue`s without an anchor, orphanScan
  // skips it as terminal, and the dispatcher's crash-repark journals
  // `worker-exit-after-terminal`. A maintainer's `retry` reply produced no reaction and no
  // error: the same silent-retry-channel shape this project has already paid for once (the
  // `gh api -f` POST bug, CLAUDE.md). ONE non-zero exit was enough -- a rate limit, a network
  // blip, a commandTimeoutsMs expiry, or a body over 65536 chars. No race required.
  //
  // STAMPED here, JOURNALLED after the call. Both halves are load-bearing and they pull in
  // opposite directions:
  //
  //   stamped before -- the timestamp is the scan's "since" boundary, so it must predate the
  //     call. alertPark has already fired by now, so a maintainer CAN reply `retry` while
  //     this `gh` call is still in flight; a boundary taken afterwards would miss it.
  //   journalled after -- the anchor must remain the LAST journal event this worker appends.
  //     unparkScan has no live-worker guard: what stops it acting on a park mid-write is
  //     precisely that it cannot act before the anchor exists, and the anchor is provably
  //     last. Writing it first would let unparkScan re-enqueue a task whose parking worker is
  //     still writing -- issue #43's shape. The ordering test below pins this.
  const anchoredAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();

  const result = runSync(deps, 'gh', ['issue', 'comment', String(issue), '--repo', ghRepo, '--body-file', commentFile], {}, ctx.config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, 'PARKED', 'park-comment-failed', { exit, timedOut: result.timedOut === true });
    // Strictly last, and after the diagnostic event above: see `anchoredAt`.
    appendEvent(ctx.taskDir, 'PARKED', 'park-anchor', { at: anchoredAt });
    return;
  }

  const commentId = parseCommentId(result.stdout);
  appendEvent(ctx.taskDir, 'PARKED', 'park-comment', { commentId, reason });
}

// ---- action 5.1: surface DIAGNOSE on the card -------------------------------------------------
//
// Fix round (2026-09-03, adversarial pass, S3): this and its two state-machine.js sibling
// comments used to append the letter "d" to this action id. The plan (doc/remediation-plan-2026-08.md:188) does not
// letter row 5.1's sub-items at all -- it names three in one cell: pre-worktree board moves,
// DIAGNOSE activity surfaced (this one), and dropping the redundant IMPLEMENT-retry move.
// doc/remediation-progress.md:658 confirms the same referent under "DIAGNOSE surfacing" ("6 tasks
// entered DIAGNOSE, 18 attempts total, 4 of them ending in a park"). Only the letter "d" was
// invented (by whichever pass first wrote this comment) -- the id itself was never ambiguous.
// Renamed to the plan's actual, unlettered id.
//
// Measured: 6 tasks entered DIAGNOSE (18 attempts total, 4 ending in a park). DIAGNOSE has no
// board column at all (see board.js's own COLUMN_BY_STATE header) and, before this, no
// card-visible trace either -- to a maintainer watching the board, a card in DIAGNOSE looks like a
// card sitting in "Implementing" doing nothing for however many minutes it spends real LLM budget.
//
// Decision (not a driver's free choice, see doc/remediation-progress.md's own C5 write-up): one
// comment, on the FIRST DIAGNOSE entry per task only, never per attempt. A new column would need a
// GraphQL single-select option-add mutation (no `gh project field-create` for it --
// orchestrator/README.md) and would fragment a pipeline view that is deliberately coarse; a
// comment per attempt would put up to 18 comments on 6 issues for one week's corpus alone. state-
// machine.js's handleDiagnose calls this exactly once per task (gated on its own
// ctx.counters.diagnoseSurfaced flag, real mode only), so "first entry" is enforced by the caller,
// not here -- this function itself always posts when called, same division of labour as moveCard
// (board.js) taking the column unconditionally and its caller deciding when to call it.
//
// Same "never blocks the task" policy as postParkComment above, for the same reason: a maintainer
// notification is best-effort, and a hung/failing `gh issue comment` here must not stall or park a
// task that is otherwise diagnosing normally. Journals `diagnose-surfaced {attempt, budget}` on
// success, `diagnose-surface-failed {exit}` on a non-zero exit (including a timeout, `exit: -1`
// per normalizeExit, with `timedOut: true` alongside it) -- never throws either way.
function buildDiagnoseSurfaceComment({ attempt, budget }) {
  return [
    '### Pipeline diagnosing',
    '',
    `This change failed its checks. The pipeline is diagnosing (attempt ${attempt} of ${budget}).`,
    '',
    'No human action is needed unless this card parks.',
    '',
  ].join('\n');
}

function postDiagnoseSurfaceComment(ctx, deps, { attempt, budget }) {
  const issue = ctx.task && ctx.task.issue;
  if (!issue) {
    appendEvent(ctx.taskDir, 'DIAGNOSE', 'diagnose-surface-skipped', { reason: 'no issue' });
    return;
  }

  const ghRepo = (ctx.config && ctx.config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const body = buildDiagnoseSurfaceComment({ attempt, budget });
  const commentFile = path.join(ctx.taskDir, 'diagnose-comment.md');
  fs.writeFileSync(commentFile, body);

  const result = runSync(deps, 'gh', ['issue', 'comment', String(issue), '--repo', ghRepo, '--body-file', commentFile], {}, ctx.config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, 'DIAGNOSE', 'diagnose-surface-failed', { exit, timedOut: result.timedOut === true });
    return;
  }

  appendEvent(ctx.taskDir, 'DIAGNOSE', 'diagnose-surfaced', { attempt, budget });
}

// ---- action 5.3: route the judge findings that are journalled and then lost ------------------
//
// Measured (2026-09-01, all 19 journals): 7 `change-validator PASS_WITH_FINDINGS` events carry a
// non-empty `findings` array (8 finding objects total -- issue-456 alone posted two), and one
// `citation-verifier DIVERGES` (issue-462, 2026-08-31T08:35:08Z). Every one of them was
// `appendEvent`'d by handleValidate (state-machine.js) and never read again -- PASS_WITH_FINDINGS
// returns 'MERGE' with the findings sitting only in journal.jsonl, and DIVERGES "is flagged for a
// human, not blocking" in a comment that names no human-facing surface at all. This is that
// surface.
//
// Posted on the ISSUE, not the PR (contra the plan's "a structured PR comment"): this pipeline
// auto-merges (VALIDATE -> MERGE has no human gate -- state-machine-spec.md's own state table),
// so there is no PR reviewer to read a PR comment before it closes on merge. The issue is where
// every other pipeline comment already lands (postParkComment, postDiagnoseSurfaceComment, the
// FINISH comment in steps/scripted.js), it is what the board tracks, and it OUTLIVES the PR
// (which GitHub closes on merge, taking any PR-side comment out of the maintainer's ordinary
// view). `prNumber` is named inside the body instead, so the link a PR comment would have given
// for free is not lost.
//
// Called from handleValidate BEFORE it returns 'MERGE' (not from a separate MERGE-adjacent hook):
// the findings/entries only exist in the same call's `result`/`cv` locals, and posting here keeps
// the comment landing while the change is still in flight, not after the card is already closed.
//
// Erratum A -- findings carry `title` XOR `summary`, never both. The 8 measured findings have
// exactly four key-sets:
//
//     9 keys: area, category, detail, failure_scenario, file, line, short_summary, size, title  x1
//     5 keys: area, category, detail, size, title                                               x2
//     6 keys: area, category, file, line, size, summary                                         x1
//     4 keys: area, category, size, summary                                                     x4
//
// 4 of 8 have `title` and no `summary`; 4 have `summary` and no `title`. `file`/`line` are present
// on 2 of 8; `detail`, `failure_scenario`, `short_summary` are sporadic. formatFindingLine below
// renders whichever of `title`/`summary` is present as the headline and never prints `undefined`
// for a key that is absent -- see the corpus example inline on that function.
//
// Erratum A, second half -- `findings` sometimes arrives as a JSON-ENCODED STRING, not an array.
// Every one of the 8 measured findings above actually arrived this way (`"findings":"[{...}]"`,
// not `"findings":[{...}]`) -- the same shape `orchestrator/steps/scripted.js`'s
// `plan-files-undeclared` incident already learned to expect from `files_to_change`. normalizeFindingsPayload
// tolerates a string (parses it), an array (uses it as-is), and anything else (null, an object, an
// unparsable string, absent) by returning an empty list -- never throwing -- while journalling the
// shape actually received (`validate-findings-shape`) so a future divergence from either shape is
// visible on the record instead of silently dropped, the exact fate this action exists to end.
//
// Erratum B -- `citation-verifier DIVERGES` had nothing to render. `step-contracts.js`'s
// CITATION_VERIFIER contract requires `{verdict, entries}`, but state-machine.js's own
// `citation-verifier` journal event carried only `{verdict}` -- the single real DIVERGES in the
// corpus (issue-462) recorded exactly `{"verdict":"DIVERGES"}`; what actually diverged is
// unrecoverable today. Fixed at the source in state-machine.js's handleValidate (both branches
// that already journal a `cv.verdict` now also journal `cv.entries`, PASS included -- see that
// file's own comment on why PASS gets it too, cheaply, rather than leaving the exact same
// discard-by-omission bug for a verdict this action didn't happen to be measuring).
//
// Decision recorded here, not just in the plan: NO auto-filed follow-up card. The plan floats
// "(and optionally a follow-up draft card)"; this build does not build it. Unattended filing on a
// judge's own verdict is the exact class of behaviour C3 gated behind a human `confirm` after the
// 12.8-hour, 128-attempt auto-triage stall (`intake.js:796-798`; `doc/audit-2026-08-30-
// remediation-plan.md` does not exist in this repo -- the citation was stale) -- and a
// comment is reversible (ignore it, reply, resolve it by hand) where a filed card is not (it sits
// in the backlog, competing for the same intake budget as everything else, until a human notices
// and closes it). A comment that names the finding is enough for a maintainer to decide whether it
// is worth a card at all.

// Small, deliberately generous caps -- not asked for by the corpus (largest measured payload is
// 2 findings, ~1.5KB of prose) but cheap insurance against the exact failure mode
// `plan-files-undeclared`'s own header already measured for a different field: GitHub caps a
// comment body at 65536 chars, and an unbounded model-controlled array/string is the input that
// blows past it. Rendering stops silently truncating past these caps with a `(+N more)` /
// `... (truncated)` marker rather than ever producing an oversized body.
const MAX_RENDERED_ITEMS = 30;
const MAX_FIELD_LENGTH = 8000;
// GitHub refuses an issue comment body over 65,536 characters with a 422. 60,000 leaves room for
// the truncation marker appended below it and for any future preamble line.
const MAX_BODY_LENGTH = 60000;

function truncateField(value) {
  return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}... (truncated)` : value;
}

// A non-empty string, trimmed -- or null. The one predicate every field below is read through, so
// `''`, `null`, `undefined`, and a non-string (a stray number/object the model sent where prose
// was expected) all collapse to the same "nothing to render" outcome instead of five different
// ad-hoc checks that could each get the falsy cases slightly wrong.
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? truncateField(value.trim()) : null;
}

// normalizeFindingsPayload(raw) -- tolerates every shape `result.findings` (VALIDATE's
// change-validator payload) has actually been observed or could plausibly arrive as: a real
// array (used as-is), a JSON-encoded string (parsed), or anything else -- `null`, `undefined`, an
// object, an unparsable string -- which becomes an empty list, NEVER a throw. `shape` is what
// state-machine.js journals alongside the count, per erratum A's second half above: the point is
// that a future payload shape this function doesn't expect is visible in the journal, not that it
// crashes or silently renders nothing with no trace.
function normalizeFindingsPayload(raw) {
  if (Array.isArray(raw)) return { items: raw, shape: 'array' };
  if (typeof raw === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { items: [], shape: 'unparsable-string' };
    }
    if (Array.isArray(parsed)) return { items: parsed, shape: 'json-string' };
    return { items: [], shape: `json-string-${parsed === null ? 'null' : typeof parsed}` };
  }
  if (raw === null) return { items: [], shape: 'null' };
  if (raw === undefined) return { items: [], shape: 'absent' };
  return { items: [], shape: typeof raw };
}

// formatFindingLine(finding, index) -- one change-validator finding, matching erratum A above.
// Real corpus example (issue-232, the 4-key `summary`-only shape), rendered:
//
//   **1. The new `export { server as httpServer }` in src/server/server.ts makes the raw...**
//
//   category: `latent-trap` · area: `gateway` · size: `S`
//
// A malformed element (not an object -- `null`, a bare string, a number: the "array of nulls"
// case) renders a one-line placeholder instead of throwing on `finding.title`.
function formatFindingLine(finding, index) {
  if (!finding || typeof finding !== 'object') {
    return `**${index}.** _(malformed finding: ${JSON.stringify(finding === undefined ? null : finding)})_`;
  }
  const headline = str(finding.title) || str(finding.summary) || '_(no title or summary given)_';
  const parts = [`**${index}. ${headline}**`];

  const meta = [];
  if (str(finding.category)) meta.push(`category: \`${str(finding.category)}\``);
  if (str(finding.area)) meta.push(`area: \`${str(finding.area)}\``);
  if (str(finding.size)) meta.push(`size: \`${str(finding.size)}\``);
  if (str(finding.file)) {
    const loc = typeof finding.line === 'number' ? `${str(finding.file)}:${finding.line}` : str(finding.file);
    meta.push(`\`${loc}\``);
  }
  if (meta.length > 0) parts.push(meta.join(' · '));

  // `detail` is the prose body when `title` won the headline (the 5-/9-key shapes); when
  // `summary` won the headline instead (the 4-/6-key shapes) there is no separate body key --
  // the summary already carried the whole finding. Never render the same string twice.
  if (str(finding.detail)) parts.push(str(finding.detail));
  if (str(finding.short_summary) && str(finding.short_summary) !== headline) {
    parts.push(`_${str(finding.short_summary)}_`);
  }
  if (str(finding.failure_scenario)) parts.push(`Failure scenario: ${str(finding.failure_scenario)}`);

  return parts.join('\n\n');
}

// formatEntryLine(entry, index) -- one citation-verifier entry (`{member, citation, finding}` per
// verify-citations.md's own output contract). Same malformed-element tolerance as
// formatFindingLine, for the same reason: `entries` is exactly as model-controlled as `findings`.
function formatEntryLine(entry, index) {
  if (!entry || typeof entry !== 'object') {
    return `**${index}.** _(malformed entry: ${JSON.stringify(entry === undefined ? null : entry)})_`;
  }
  const member = str(entry.member) || '_(unnamed member)_';
  const citation = str(entry.citation) ? ` — \`${str(entry.citation)}\`` : '';
  const parts = [`**${index}. ${member}${citation}**`];
  if (str(entry.finding)) parts.push(str(entry.finding));
  return parts.join('\n\n');
}

function renderItems(items, formatLine) {
  const capped = items.slice(0, MAX_RENDERED_ITEMS);
  const lines = capped.map((item, i) => formatLine(item, i + 1));
  if (items.length > MAX_RENDERED_ITEMS) {
    lines.push(`_(+${items.length - MAX_RENDERED_ITEMS} more, not rendered)_`);
  }
  return lines;
}

// buildValidateFindingsComment -- PURE (no fs, no spawn; unit-testable with only in-memory
// values, same discipline as buildParkComment above). One comment for both sources rather than
// two: a card can only get here through handleValidate's own MERGE branch, where at most one
// change-validator verdict and one citation-verifier verdict exist for the run, and posting them
// separately would put two comments on the same issue seconds apart with no way to tell, from
// either one alone, that they belong to the same VALIDATE pass. Sections are clearly separated by
// their own `####` heading instead.
//
// `diverges` is a separate boolean from `divergesEntries.length` on purpose: the DIVERGES verdict
// itself is the human-facing signal (erratum B) -- an empty/malformed `entries` payload is a
// second, independent defect worth surfacing (via `_(no entries reported)_` below), not a reason
// to fall silently back to today's "flagged for a human" that names no human-facing surface.
function buildValidateFindingsComment({ prNumber, findings = [], diverges = false, divergesEntries = [] }) {
  const lines = ['### Pipeline validation findings', ''];
  // `PR #N.`, NOT "Merged via #N." -- this comment is posted from handleValidate BEFORE
  // realMerge runs, and realMerge can still park four ways (pr-merge-enqueue-failed,
  // pr-closed-unmerged, merge-queue-not-landing, pr-wait-unrecognized-exit). Posting before the
  // merge is deliberate (the findings must land while the card is still moving, not after it
  // closes), so the wording is what has to be honest: an issue permanently carrying "Merged via
  // #427." next to a park comment saying the PR closed unmerged is exactly the kind of
  // board-vs-reality divergence this chantier exists to end. #443 is the corpus proof that the
  // four park paths are not theoretical.
  if (typeof prNumber === 'number') lines.push(`PR #${prNumber}.`, '');
  lines.push(
    'This did not block the merge -- this pipeline auto-merges once its own checks pass, so',
    'there is no human reviewer on the PR itself. These are recorded here for you to read, act',
    'on, or dismiss at your own judgement.',
    ''
  );

  if (diverges) {
    lines.push(
      '#### Citation verifier: DIVERGES',
      '',
      'Every touched citation checked out true, but at least one intentionally diverges from a',
      'literal reading of the Pascal declaration (verify-citations.md rule 1 or 2) -- correct, but',
      'flagged for you to confirm the intent, not to fix.',
      ''
    );
    if (Array.isArray(divergesEntries) && divergesEntries.length > 0) {
      renderItems(divergesEntries, formatEntryLine).forEach((line) => lines.push(line, ''));
    } else {
      lines.push('_(no entries reported)_', '');
    }
  }

  if (Array.isArray(findings) && findings.length > 0) {
    lines.push(
      '#### Change validator: PASS_WITH_FINDINGS',
      '',
      'The change passed. These are non-blocking findings from that pass.',
      ''
    );
    renderItems(findings, formatFindingLine).forEach((line) => lines.push(line, ''));
  }

  // The per-field and per-item caps above bound each PIECE; they do not bound the WHOLE. Measured:
  // 30 findings each at the 8000-char field cap render a 722,497-character body against GitHub's
  // 65,536 limit -- 11x over. `gh` would 422, the post would journal
  // `validate-findings-post-failed`, the merge would proceed, and the findings would be lost
  // again, which is the exact failure this action exists to end. So the joined body is capped
  // too, and says so where it cuts rather than ending mid-sentence.
  const body = lines.join('\n');
  if (body.length <= MAX_BODY_LENGTH) return body;
  return (
    body.slice(0, MAX_BODY_LENGTH) +
    `\n\n_[truncated: the rendered findings exceeded ${MAX_BODY_LENGTH} characters. The full payload is in this task's journal, under the \`change-validator\` event.]_`
  );
}

// postValidateFindingsComment(ctx, deps, {...}) -- same mechanics as postParkComment above: build
// the body with the pure function, write it to ctx.taskDir, spawn through the timeout-armed
// runSync, verdict by exit code, journal the outcome. It never BLOCKS -- but the "never throws"
// half was measured and is false, in exactly the way postParkComment's identical shape is: a
// `spawnSync` that returns undefined/null or throws outright, an absent or unwritable taskDir,
// all propagate out (armTimeout assigns `result.commandClass` on the raw return). Real spawnSync
// does none of those, but a mutation round or a full disk does. The caller therefore owns the
// catch: handleValidate wraps this call, because a throw here escapes into runTask
// (state-machine.js) and kills the daemon over a best-effort comment -- the shape C3 already
// shipped once.
// Journals `validate-findings-posted {count, commentId}` on success,
// `validate-findings-post-failed {exit, timedOut}` on a non-zero `gh` exit or a timed-out spawn.
function postValidateFindingsComment(ctx, deps, { prNumber, findings = [], diverges = false, divergesEntries = [] }) {
  const issue = ctx.task && ctx.task.issue;
  if (!issue) {
    appendEvent(ctx.taskDir, 'VALIDATE', 'validate-findings-post-skipped', { reason: 'no issue' });
    return;
  }

  const ghRepo = (ctx.config && ctx.config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const body = buildValidateFindingsComment({ prNumber, findings, diverges, divergesEntries });
  const commentFile = path.join(ctx.taskDir, 'validate-findings-comment.md');
  fs.writeFileSync(commentFile, body);

  const result = runSync(deps, 'gh', ['issue', 'comment', String(issue), '--repo', ghRepo, '--body-file', commentFile], {}, ctx.config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, 'VALIDATE', 'validate-findings-post-failed', { exit, timedOut: result.timedOut === true });
    return;
  }

  const commentId = parseCommentId(result.stdout);
  const count = (Array.isArray(findings) ? findings.length : 0) + (Array.isArray(divergesEntries) ? divergesEntries.length : 0);
  appendEvent(ctx.taskDir, 'VALIDATE', 'validate-findings-posted', { count, commentId });
}

// ---- unpark scan (daemon, real mode) ---------------------------------------------------------
//
// action 2.7: the fetch/pagination/allowlist/backoff work is comment-scan.js's `scanForMatch` --
// see that module's own header for the full rationale (the one-page cap, the author allowlist
// and its fail-open/stale decision, per-issue backoff). What stays here: the retry/abandon
// pattern set, the anchor (`findParkAnchor`, below -- park-loop.js's own park-comment journal
// entries, unrelated to report-intake.js's daemon.jsonl anchor), and what a match DOES (re-enqueue
// vs terminal ABANDONED + ack comment).

function listTaskIds(journalRoot) {
  if (!fs.existsSync(journalRoot)) return [];
  return fs
    .readdirSync(journalRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJournalLines(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
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

// The anchor for the CURRENT park cycle, and whether an `unparked-by-maintainer` /
// `abandoned-by-maintainer` event already follows it (in which case this cycle was already
// handled -- idempotent across scans, whether or not the re-enqueued task has been drained
// back out of PARKED yet).
//
// TWO shapes, and the weaker one is the point (issue #77):
//
//   `park-comment`  -- the comment landed, so its numeric commentId is the boundary. GitHub
//                      comment ids increase monotonically, so "id > anchorId" is exactly
//                      "posted after we commented". Preferred whenever it exists.
//   `park-anchor`   -- journalled before the `gh` call, so it survives that call failing or
//                      the daemon being SIGTERMed mid-call. Its timestamp is the boundary
//                      instead: a `retry` counts if it was posted after the park.
//
// The LAST of either kind wins, by journal position -- so a later successful cycle's
// commentId supersedes an earlier cycle's bare timestamp, and a park whose comment failed
// supersedes the commentId of the cycle before it. Taking the last `park-comment` alone
// would let a stale id from a PREVIOUS cycle act as this cycle's boundary, which silently
// narrows the scan window rather than widening it.
function findParkAnchor(lines) {
  let anchorIndex = -1;
  let commentId = null;
  let sinceMs = null;
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i];
    if (e.event === 'park-comment' && typeof e.commentId === 'number') {
      anchorIndex = i;
      commentId = e.commentId;
      sinceMs = null;
      continue;
    }
    if (e.event === 'park-anchor') {
      const at = Date.parse(e.at);
      // An unparseable stamp is no anchor at all: falling back to "scan everything" would
      // let a `retry` from a previous cycle re-trigger this one.
      if (!Number.isFinite(at)) continue;
      anchorIndex = i;
      commentId = null;
      sinceMs = at;
    }
  }
  if (anchorIndex === -1) return null;

  const alreadyHandled = lines
    .slice(anchorIndex + 1)
    .some((e) => e.event === 'unparked-by-maintainer' || e.event === 'abandoned-by-maintainer');

  return { commentId, sinceMs, alreadyHandled };
}

// firstLine matching itself now lives in comment-scan.js's scanForMatch -- RETRY_RE/ABANDON_RE
// stay here because they are unparkScan's OWN vocabulary (report-intake.js has its own,
// CONFIRM_RE/DISCARD_RE), threaded into scanForMatch as `patterns` below.
const RETRY_RE = /^retry\b/i;
const ABANDON_RE = /^abandon\b/i;
const UNPARK_PATTERNS = [
  { name: 'retry', re: RETRY_RE },
  { name: 'abandon', re: ABANDON_RE },
];

// action 2.7: unparkScan's own event names for comment-scan.js's scanForMatch -- see that
// module's header for what each one means. Task-scoped (appendEvent), not daemon-scoped: a
// truncated scan, an ignored non-collaborator, or a backoff skip are all facts about THIS
// parked task's own issue, so they belong in journal/<id>/journal.jsonl beside
// unpark-scan-failed, not buried in daemon.jsonl where a maintainer looking at one task would
// never think to check.
const UNPARK_SCAN_EVENTS = {
  truncated: 'unpark-scan-truncated',
  ignoredAuthor: 'unpark-scan-ignored-author',
  backoffSkip: 'unpark-scan-backoff-skip',
};

// shouldScanUnpark(lastScanAt, nowMs, unparkScanMs) -- pure predicate, same shape as
// orphan-scan.js's shouldScanOrphans / report-intake.js's shouldScanConfirms. Action 2.7 bullet
// 4: unparkScan used to run unconditionally on EVERY drainQueueOnce cycle (pollIntervalMs, 5s by
// default) in real mode -- a `gh api .../comments` call per parked task every 5 seconds is
// exactly the unbounded-per-cycle-retry shape the plan's own "12.8-hour auto-triage stall"
// postmortem warns about, just for a different endpoint. A dedicated 60s-by-default timer
// (config.unparkScanMs, state-machine.js's runForever) gives it the same treatment orphanScan
// and reportConfirmScan already had.
function shouldScanUnpark(lastScanAt, nowMs, unparkScanMs) {
  if (!(unparkScanMs > 0)) return false;
  if (lastScanAt === null || lastScanAt === undefined) return true;
  return nowMs - lastScanAt >= unparkScanMs;
}

// Re-enqueues `id` with the ORIGINAL task.json fields (queue/0000-retry-<ts>-<id>.json) --
// unlike intake.makeTask's zero-padded sequence naming (built for `spo pull`'s priority-order
// batch), a retry only ever concerns one already-known id, so a timestamp is enough for both
// uniqueness and (combined with the `0000-` prefix below) filename-sort placement among whatever
// else is in queue/ at the time. worktreePath/branch are dropped even if present (they never are
// -- task.json is the original queue file, never rewritten with runtime fields -- see journal.js's
// own header comment) so WORKTREE derives both fresh from config.pipelineWorktreesDir/taskId on
// the retry, same as a first attempt.
//
// action 2.8: the `0000-` prefix. `listQueueFiles` (state-machine.js) processes queue/ in plain
// filename-sort order, and intake.js's `nextQueueSeq` never hands out a fresh card a sequence
// below `0001` (it starts at 1 for an empty/missing queue dir and only grows from there) -- so
// `0000-retry-...` sorts strictly before EVERY `NNNN-issue-...` fresh card, unconditionally, by
// the 4th character alone ('0' < '1'), with no dependence on what follows in either name. Before
// this fix the file was just `retry-<ts>-<id>.json`, and `'r' > '0'`-`'9'` put every retry BEHIND
// every fresh card in filename-sort order -- the opposite of both this comment's original intent
// and the spec's: a maintainer's explicit "retry" should not wait behind newly auto-pulled work.
// Multiple retries queued at once still sort relative to each other by their own timestamp, same
// as before. Nothing else parses this filename's shape: `takeNextTask`'s own `path.basename(file,
// '.json')` id fallback is never reached for a retry (task.json's own `id` field, restored above,
// always wins first), and every other reader of queue/ (bin/spo, orphan-scan.js's `queuedIds`,
// intake.js's `nextQueueSeq`) only ever checks `.endsWith('.json')` or a leading `\d+-`, both
// still true here.
// Action 3.1: `baseMainSha` is stripped alongside worktreePath/branch for the same reason --
// it is the run's own record of where origin/main sat when IT ran, not a durable task fact.
// realWorktree (steps/scripted.js) re-derives the current sha on every run and writes it fresh
// to ctx.task.baseMainSha; if a stale value from the parked run survived into the retried
// task.json, handlePlan's reuse guard (state-machine.js) would find `ctx.task.baseMainSha`
// already set from last week and could pass condition (1) on a sha nobody just measured --
// exactly the "origin/main hasn't moved" check the guard exists to make trustworthy, defeated
// by its own leftover state.
// Action 4.4: `transientRetries`/`notBefore` are stripped alongside worktreePath/branch/
// baseMainSha, for the SAME reason and for both of this function's callers -- unparkScan (a
// human's `retry` reply) and finalizePark's own bounded auto-retry (state-machine.js). Neither
// call site duplicates this read/strip/write: finalizePark reuses this exact function and hands
// its two fields in through `extra`, which is merged into the SAME single write.
//
// `extra` exists precisely so that the queue entry is never observable without them, and that is
// a correctness requirement, not tidiness. 4.4's first cut wrote the file here and then had
// finalizePark read it back, patch `transientRetries`/`notBefore` on and write it a second time.
// Between those two writes the entry sat in queue/ carrying NEITHER field, i.e. "eligible right
// now, zero retries used" -- and the post-merge hook SIGTERMs this daemon routinely
// (doc/remediation-progress.md), so a death inside that window is not hypothetical. The recovered
// entry would be taken immediately with a budget reset to 0, hit the same transient reason, and
// re-enqueue itself again with the budget reset again: an unbounded retry loop, which is the one
// thing the budget exists to prevent. Same reasoning for the temp-file-then-rename below --
// `writeFileSync` onto the final name is not atomic, and every OTHER reader of this directory
// (state-machine.js's takeNextTask/listQueueFiles, orphan-scan.js's queuedIds, console
// collectQueue, intake.js's nextQueueSeq) keys off `*.json`, so a half-written entry under the
// real name is a torn read waiting to happen. queuedIds is the sharp one: it falls back to the
// FILENAME when the JSON does not parse, so a torn `0000-retry-<ts>-<id>.json` is keyed under
// `0000-retry-<ts>-<id>` instead of `<id>`, the task looks absent from the queue, and orphan-scan
// reparks a card that is sitting right there waiting out its own backoff. The temp name is
// dot-prefixed so it matches neither the `*.json` filter nor nextQueueSeq's `^(\d+)-`; the rename
// is atomic within the directory, so the entry only ever appears complete.
//
// The maintainer-facing consequence is the one worth stating in plain language: a human typing
// `retry` on a parked issue ALWAYS restores the full auto-retry budget and starts immediately,
// never inheriting a stale `transientRetries` count or a `notBefore` deadline left over from
// whatever auto-retry attempt (if any) led to this park. That is deliberate, and it is the
// property that keeps a human always able to make progress: an exhausted transient-retry budget
// is a fact about how many times THE MACHINE tried unattended, not a ceiling on how many times a
// human who has now looked at the reason gets to ask for another attempt.
function reEnqueueTask(queueDir, taskDir, id, extra = {}) {
  const original = readJsonSafe(path.join(taskDir, 'task.json')) || {};
  const { worktreePath, branch, baseMainSha, transientRetries, notBefore, ...rest } = original;
  fs.mkdirSync(queueDir, { recursive: true });
  const name = `0000-retry-${Date.now()}-${id}.json`;
  const file = path.join(queueDir, name);
  const tmp = path.join(queueDir, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...rest, id, ...extra }, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

// action 4.5 -- issue #443, measured: ABANDONED used to write state.json and nothing else, so
// the product worktree, its claude-pipe/<id> branch (local AND remote), and the open PR all
// leaked forever -- `spo status`/`spo parked` had no way to even SEE the card once it left
// PARKED, let alone act on it. abandonCleanup(deps, config, taskDir, id, task, state) is the
// best-effort reclaim of all three, run by unparkScan strictly AFTER the ABANDONED state.json
// write, the abandoned-by-maintainer event, and the ack comment above -- never before. That
// ordering is what makes a crash mid-cleanup safe: state.json is already the durable, terminal
// fact by the time any `git`/`gh` call below runs, so a daemon restart mid-cleanup finds a card
// that is correctly ABANDONED with some leftovers still on disk (a nuisance a maintainer can
// clean up by hand, same as issue #443 itself) rather than a card stuck in an ambiguous
// half-abandoned state. Every step is independently exit-code-checked and journals its own
// outcome; nothing here throws on its own, and the caller (unparkScan) wraps the whole call in
// try/catch anyway as a second line of defence -- one card's cleanup blowing up must never abort
// the scan for the other parked tasks in the same pass.
//
// `id` is unparkScan's own loop variable -- the journal/<id> directory name, i.e. the same
// taskId realWorktree (steps/scripted.js) builds `claude-pipe/${taskId}` from. task.json on disk
// is the original queue file moved as-is (state-machine.js's own comment on that rename) and is
// NEVER rewritten with the runtime `branch` field realWorktree sets on ctx.task in memory -- so
// `task.branch` read back off disk here is realistically always undefined, and the fallback
// below is what actually fires. It is spelled out anyway, matching realPushPr's own fallback
// expression verbatim, so this stays correct even if that assumption about task.json ever stops
// holding.
function abandonCleanup(deps, config, taskDir, id, task, state) {
  const productRepo = config && config.productRepo;
  const ghRepo = (config && config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const branch = (task && task.branch) || `claude-pipe/${id}`;
  const journal = (event, detail) => appendEvent(taskDir, 'PARKED', event, detail);

  // 1. Close the PR FIRST, before touching either branch. Real observation, issue #455: deleting
  // a remote branch on GitHub auto-closes any PR built from it as a side effect -- if the remote
  // delete (step 4) ran first, the PR would end up closed anyway, but as an unlogged side effect
  // of a branch cleanup instead of a deliberate action this cleanup made and journalled. Closing
  // it here, first, and on purpose, is the difference between a recorded decision and a silent
  // one. An already-closed PR is not treated as an error beyond the journal line -- `gh pr close`
  // on an already-closed PR still exits 0.
  if (state.prNumber) {
    const close = runSync(deps, 'gh', ['pr', 'close', String(state.prNumber), '--repo', ghRepo], {}, config);
    const exit = normalizeExit(close);
    if (exit === 0) journal('abandon-pr-closed', { prNumber: state.prNumber });
    else journal('abandon-cleanup-failed', { step: 'pr-close', prNumber: state.prNumber, exit });
  }

  // 2. Worktree. A dirty working tree is NEVER destroyed by a cleanup path -- it may be the only
  // durable copy of uncommitted work, and a maintainer who just typed "abandon" gets to inspect
  // it by hand rather than lose it silently to a background scan. Same for a `git status` call
  // that itself fails: an inconclusive answer is treated the same as "dirty", never as "clean".
  let worktreeRemoved = false;
  if (state.worktreePath && fs.existsSync(state.worktreePath)) {
    const status = runSync(deps, 'git', ['-C', state.worktreePath, 'status', '--porcelain'], {}, config);
    const statusExit = normalizeExit(status);
    if (statusExit !== 0) {
      journal('abandon-cleanup-skipped', { step: 'worktree', worktreePath: state.worktreePath, reason: 'status-failed' });
    } else if (status.stdout.trim() !== '') {
      journal('abandon-cleanup-skipped', { step: 'worktree', worktreePath: state.worktreePath, reason: 'dirty' });
    } else {
      const remove = runSync(deps, 'git', ['-C', productRepo, 'worktree', 'remove', '--force', state.worktreePath], {}, config);
      const exit = normalizeExit(remove);
      if (exit === 0) {
        worktreeRemoved = true;
        journal('abandon-worktree-removed', { worktreePath: state.worktreePath });
      } else {
        journal('abandon-cleanup-failed', { step: 'worktree', exit });
      }
    }
  }

  // 3. Local branch -- reachable only once step 2 actually removed the worktree: git refuses to
  // delete a branch checked out in a live worktree, and a skipped-dirty worktree deliberately
  // still holds it (the maintainer needs it there to inspect). The ancestry check below mirrors
  // steps/scripted.js's sweepWorktreeLeftovers rule 2 verbatim, on purpose -- the maintainer
  // abandoned the CARD, not the commits, so an unmerged local-only tip is left alone here exactly
  // as it would be for a retry's own leftover sweep, not force-deleted just because "abandon" is
  // a terminal word.
  const localRef = `refs/heads/${branch}`;
  let localBranchKept = false; // a local claude-pipe/<id> tip this cleanup deliberately left behind
  if (worktreeRemoved) {
    const localRevParse = runSync(deps, 'git', ['-C', productRepo, 'rev-parse', '--verify', '--quiet', localRef], {}, config);
    if (normalizeExit(localRevParse) === 0) {
      const localSha = localRevParse.stdout.trim();
      const ancestor = runSync(deps, 'git', ['-C', productRepo, 'merge-base', '--is-ancestor', localRef, 'origin/main'], {}, config);
      let safe = normalizeExit(ancestor) === 0;
      let remoteSha = null;
      if (!safe) {
        const remoteRevParse = runSync(
          deps,
          'git',
          ['-C', productRepo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
          {},
          config
        );
        remoteSha = normalizeExit(remoteRevParse) === 0 ? remoteRevParse.stdout.trim() : null;
        safe = remoteSha !== null && remoteSha === localSha;
      }
      if (safe) {
        const del = runSync(deps, 'git', ['-C', productRepo, 'branch', '-D', branch], {}, config);
        const exit = normalizeExit(del);
        if (exit === 0) journal('abandon-branch-deleted', { branch, sha: localSha });
        else {
          journal('abandon-cleanup-failed', { step: 'local-branch', exit });
          localBranchKept = true; // the delete failed -- the tip is still there
        }
      } else {
        journal('abandon-cleanup-skipped', { step: 'local-branch', branch, localSha, remoteSha, reason: 'unmerged' });
        localBranchKept = true;
      }
    }
  } else {
    // Step 2 declined (dirty / status-failed / remove-failed), or there was no worktree on disk to
    // begin with -- so the block above never even asked whether a local tip survives. Ask now:
    // it's a read-only local rev-parse, and step 4 below needs the answer.
    const localRevParse = runSync(deps, 'git', ['-C', productRepo, 'rev-parse', '--verify', '--quiet', localRef], {}, config);
    localBranchKept = normalizeExit(localRevParse) === 0;
  }

  // 4. Remote branch. Two conditions, not one.
  //
  // (a) Step 1 already closed the PR, so the PR closing as GitHub's own side effect of this delete
  //     is redundant with a decision already made and journalled, not a surprise.
  //
  // (b) This cleanup did NOT keep a local claude-pipe/<id> tip. steps/scripted.js gets this second
  //     condition for free and never had to write it down: its rule 2 THROWS ParkSignal on a tip it
  //     cannot vouch for, so its rule 3 (this same remote delete) is simply unreachable whenever
  //     the local branch survives. Nothing here throws -- every step is journalled and execution
  //     continues -- so the guard has to be explicit, and without it the mirroring of rule 2 stops
  //     exactly where it matters: a dirty worktree (step 2) or an unvouched tip (step 3) is
  //     preserved on the grounds that "the maintainer abandoned the CARD, not the commits", and
  //     then the very next block deletes the only pushed copy of those same commits. That is the
  //     "never destroy what wasn't first saved somewhere durable" rule (steps/scripted.js's
  //     dirty-leftover branch, card #385) inverted inside one function. When the local tip is
  //     kept, the remote one is kept with it and the skip is journalled so the leftover is a
  //     recorded decision rather than a silent omission.
  const remoteCheck = runSync(
    deps,
    'git',
    ['-C', productRepo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    {},
    config
  );
  if (normalizeExit(remoteCheck) === 0) {
    const remoteSha = remoteCheck.stdout.trim();
    if (localBranchKept) {
      journal('abandon-cleanup-skipped', { step: 'remote-branch', branch, remoteSha, reason: 'local-branch-kept' });
    } else {
      // (c) `localBranchKept === false` is not by itself proof that nothing is lost. Step 3 also
      //     deletes a local tip vouched for ONLY by `localSha === remoteSha` -- pushed work that
      //     origin/main does not contain. Deleting the remote copy of that is exactly card #455's
      //     loss, reached through `abandon` instead of through a retry, and it would contradict
      //     this function's own stated rule one block up. steps/scripted.js's rule 3 (action 4.6)
      //     answers this by preserving before deleting; do the same here, so `retry` and `abandon`
      //     cannot disagree about whether the pipeline destroys unmerged pushed commits.
      //
      //     A failed preservation SKIPS the delete rather than throwing: abandonCleanup's whole
      //     contract is that no step throws and none of them can leave the card un-ABANDONED. A
      //     leftover remote branch is a recorded, recoverable omission; a destroyed one is not.
      let preservedRef = null;
      const contained = runSync(
        deps,
        'git',
        ['-C', productRepo, 'merge-base', '--is-ancestor', remoteSha, 'origin/main'],
        {},
        config
      );
      if (normalizeExit(contained) !== 0) {
        const ref = `wip/${id}-${Date.now()}`;
        const save = runSync(
          deps,
          'git',
          ['-C', productRepo, 'push', 'origin', `${remoteSha}:refs/heads/${ref}`],
          {},
          config
        );
        if (normalizeExit(save) !== 0) {
          journal('abandon-cleanup-skipped', {
            step: 'remote-branch',
            branch,
            remoteSha,
            reason: 'preserve-failed',
            exit: normalizeExit(save),
          });
          return;
        }
        preservedRef = ref;
        journal('abandon-remote-preserved', { branch, sha: remoteSha, ref });
      }
      const del = runSync(deps, 'git', ['-C', productRepo, 'push', 'origin', '--delete', branch], {}, config);
      const exit = normalizeExit(del);
      if (exit === 0) journal('abandon-remote-branch-deleted', { branch, sha: remoteSha, preservedRef });
      else journal('abandon-cleanup-failed', { step: 'remote-branch', exit });
    }
  }
}

// ---- action 5.1b: reconcile a parked/abandoned task against the issue it owns -----------------
//
// The measurement (doc/remediation-progress.md's "C5's own measurement" section, 2026-09-01,
// re-run from scratch, not carried over from the plan) found the JOURNAL is the stale side on 3
// of 18 tasks, and the BOARD is already right -- because the project has the built-in "Item
// closed" workflow enabled (Status -> Done, re-measured live), so closing an issue moves the card
// by itself with no `gh project` mutation and no human dragging anything. Issue closure is
// therefore already the signal the board itself trusts; this function invents no new source of
// truth, it just makes the JOURNAL catch up to what the board already knows:
//
//   issue-213, issue-428: PARKED (`diagnose-duplicate-root-cause`), closed 2026-08-30 by a human
//     who fixed the work by hand and closed the issue -- nothing ever told the pipeline. Today
//     `spo parked` still lists both as awaiting a `retry`/`abandon` reply that will never come.
//   issue-443: ABANDONED (`abandoned-by-maintainer`, from a MERGE-step false park). `pr:wait`
//     read `closed false` at 13:17:57 and parked `pr-closed-unmerged`; PR #447 actually MERGED at
//     13:18:27, 30 seconds later, with no close/reopen anywhere in its own timeline before that.
//     The maintainer then read the park comment and replied `abandon` at 13:53 -- abandoning a
//     change that had already merged. A reconciler would have caught this within one scan
//     interval instead of never; the MERGE-step defect itself (a single unconfirmed `closed`
//     read treated as terminal) is filed separately and is NOT this action's to fix.
//
// The central design rule, worth restating here because it is the one a future "simplification"
// will be tempted to undo: RECORD, NEVER OVERWRITE. `state.state` is never rewritten by this
// function. The task really did park (or really was abandoned) -- the pipeline's own verdict at
// the time was correct given what it knew, and fabricating a `DONE` the pipeline never actually
// produced would make the journal lie in the opposite direction from today's staleness. Instead,
// both facts land on the record side by side: `state.json` gets an `externallyResolved: {via,
// closedAt, prNumber, mergedAt, at}` field, and `journal.jsonl` gets one `reconciled-externally`
// event carrying the same detail. `via` is what tells the 213/428 shape (a human closed the
// issue) apart from the 443 shape (the pipeline's own PR actually merged): 'pr-merged' only when
// `state.prNumber` is set AND that PR's own `merged_at` is non-null, 'issue-closed' otherwise --
// carrying the PR's `merged_at` alongside the issue's `closed_at` is what makes 443's 30-second
// gap legible from the journal alone, without cross-referencing GitHub by hand.
//
// Idempotence is the OTHER load-bearing property, and it is enforced by the simplest guard
// available: `state.externallyResolved` itself. Once written, this function returns immediately
// on every later call for the same task -- no re-read, ever. That bounds the whole feature to at
// most 2 extra `gh api` reads per parked task, ever (issue + PR, and the PR read only fires when
// the issue already came back closed -- never speculatively, per the caller's own contract
// below). The other side of that bound is deliberate, not an oversight: a task whose issue is
// STILL open IS re-read every cycle unparkScan runs, because that is the only way a close ever
// gets noticed. Measured cost: 3 parked tasks in today's corpus, so at most 3 extra `gh api`
// reads per unparkScan cycle (60s by default, config.unparkScanMs) while any of them stays open
// and unreconciled -- falling to 0 once all three are reconciled or newly parked ones settle.
//
// Same "never blocks, never throws" contract as every other real spawn in this file
// (command-timeout.js's own header, action 2.1b): a failed read -- non-zero exit, a spawnSync
// timeout, unparsable JSON, from either the issue read or the PR read -- journals
// `reconcile-scan-failed {step, exit, timedOut}` and returns without writing anything, so the
// SAME task is simply re-attempted next cycle, same as an ordinary `unpark-scan-failed`. Nothing
// here ever throws past its own boundary, and the caller wraps the call in try/catch anyway (same
// belt-and-suspenders as abandonCleanup's own call site below) so one task's reconciliation
// blowing up can never abort the scan for every other task in the same pass.
//
// Explicitly OUT of scope, on purpose, left for a different action if it's ever wanted:
//   - a non-terminal task (still PLAN/IMPLEMENT/...) whose issue closes mid-flight -- a stronger
//     signal ("stop working now") than this function's "the outcome is already settled", but a
//     different decision with different failure modes, not this one's to make;
//   - a DONE task whose issue is later reopened;
//   - moving anything on the board -- the board is already correct in all three measured cases,
//     there is nothing here to move.
function reconcileExternalClosure(deps, config, taskDir, task, state) {
  // The guard IS the idempotence contract -- see header. Once this fires, this function is a
  // no-op for this task forever, by construction, with no separate "already reconciled" flag to
  // keep in sync.
  if (state.externallyResolved) return;

  const ghRepo = (config && config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const journal = (event, detail) => appendEvent(taskDir, state.state, event, detail);

  const issueResult = runSync(deps, 'gh', ['api', `repos/${ghRepo}/issues/${task.issue}`], {}, config);
  const issueExit = normalizeExit(issueResult);
  if (issueExit !== 0) {
    journal('reconcile-scan-failed', { step: 'issue', exit: issueExit, timedOut: issueResult.timedOut === true });
    return;
  }

  let issue;
  try {
    issue = JSON.parse(issueResult.stdout);
  } catch {
    journal('reconcile-scan-failed', { step: 'issue', exit: issueExit, timedOut: false, reason: 'unparsable' });
    return;
  }

  // Still open -- exactly the case that must be re-read next cycle, not journalled as any kind
  // of failure. No `externallyResolved` is written, so the guard above lets it straight through
  // again on the next call.
  if (!issue || issue.state !== 'closed') return;

  const closedAt = (issue && issue.closed_at) || null;
  let via = 'issue-closed';
  let mergedAt = null;

  // The PR read only happens here -- prNumber present AND the issue already confirmed closed --
  // never speculatively (a park/abandon with no PR yet, or one whose issue is still open, never
  // costs this second read at all).
  if (state.prNumber) {
    const prResult = runSync(deps, 'gh', ['api', `repos/${ghRepo}/pulls/${state.prNumber}`], {}, config);
    const prExit = normalizeExit(prResult);
    if (prExit !== 0) {
      journal('reconcile-scan-failed', { step: 'pr', exit: prExit, timedOut: prResult.timedOut === true });
      return; // the issue read succeeded but the PR read didn't -- retry the whole thing next cycle
    }
    let pr;
    try {
      pr = JSON.parse(prResult.stdout);
    } catch {
      journal('reconcile-scan-failed', { step: 'pr', exit: prExit, timedOut: false, reason: 'unparsable' });
      return;
    }
    if (pr && pr.merged_at) {
      via = 'pr-merged'; // the 443 shape -- the pipeline's own change actually merged
      mergedAt = pr.merged_at;
    }
    // else: a PR exists but never merged -- still the 213/428 shape, `via` stays 'issue-closed'.
  }

  const externallyResolved = {
    via,
    closedAt,
    prNumber: state.prNumber || null,
    mergedAt,
    at: new Date().toISOString(),
  };
  writeState(taskDir, { ...state, externallyResolved });
  journal('reconciled-externally', externallyResolved);
}

// unparkScan(queueDir, journalRoot, config, deps, scanState) -- one pass over every journaled
// task. For each PARKED kind:"card" task with a park-comment anchor not yet acted on, comment-
// scan.js's scanForMatch fetches the issue's comments after that anchor (paginated, allowlisted,
// backed off on failure -- see that module's header) and finds the first AUTHORIZED comment
// whose FIRST LINE is `retry` (optionally followed by more text) or `abandon`, case-insensitive.
// Anything else on the issue -- including a `retry` posted BEFORE the park comment, one from a
// non-collaborator, or a comment matching neither word -- is left alone; a human conversation on
// the issue is allowed. `scanState` (comment-scan.js's createScanState()) is a fresh one by
// default -- callers that run this repeatedly (state-machine.js's runForever) pass one they
// created once and keep across cycles, so the collaborator cache and backoff table persist.
//
// action 5.1b: BEFORE the retry/abandon comment scan below, every PARKED *or* ABANDONED task
// (readJsonSafe's `state.state`, not this loop's own filter -- an ABANDONED task never reaches
// the comment-scan section at all, see the `continue` a few lines down) gets a chance at
// `reconcileExternalClosure` above. It runs first, unconditionally, and its own guard (already
// reconciled? issue still open? no prNumber?) is what decides whether it actually spends an API
// call -- NOT any check in this loop, so there is no ordering hazard where a "skip reconciliation
// this time" decision here could also accidentally skip the comment scan for a still-PARKED task.
// Wrapped in try/catch on top of reconcileExternalClosure's own internal never-throws contract,
// same belt-and-suspenders as abandonCleanup's own call site below: this loop runs once per
// journaled task per cycle, and one task's reconciliation misbehaving must never stop the daemon
// (a throw out of unparkScan kills it -- state-machine.js's runForever) or skip every task after
// it in `ids`.
async function unparkScan(queueDir, journalRoot, config, deps = {}, scanState = commentScan.createScanState()) {
  const ghRepo = (config && config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const ids = listTaskIds(journalRoot);
  const nowMs = deps.now !== undefined ? deps.now : Date.now();

  for (const id of ids) {
    const taskDir = path.join(journalRoot, id);
    const state = readJsonSafe(path.join(taskDir, 'state.json'));
    if (!state || (state.state !== 'PARKED' && state.state !== 'ABANDONED')) continue;

    const task = readJsonSafe(path.join(taskDir, 'task.json'));
    if (!task || task.kind !== 'card' || !task.issue) continue;

    try {
      reconcileExternalClosure(deps, config, taskDir, task, state);
    } catch (err) {
      appendEvent(taskDir, state.state, 'reconcile-scan-failed', {
        step: 'unexpected',
        error: String((err && err.message) || err),
      });
    }

    // ABANDONED is terminal -- it was never part of the retry/abandon comment scan before this
    // action (the loop's original filter was `state.state !== 'PARKED'`) and reconciling it does
    // not change that; only reconcileExternalClosure runs for it.
    if (state.state !== 'PARKED') continue;

    const lines = readJournalLines(taskDir);
    const anchor = findParkAnchor(lines);
    if (!anchor || anchor.alreadyHandled) continue;

    // Card #476, half 2. The tail is summarized BEFORE the scan, on the same lines findParkAnchor
    // just read (never a second read of the file), because what makes this cycle's outcome worth
    // journalling is what the journal said a moment ago -- see retryChannel.shouldJournalScanOk.
    const tailBefore = retryChannel.summarizeUnparkScanTail(lines);
    // scanForMatch's own journal callback may write positive evidence of its own this cycle
    // (`unpark-scan-truncated`, `unpark-scan-ignored-author` -- both prove `gh` answered). If it
    // does, the outcome is already on record and an `unpark-scan-ok` beside it would be a second
    // line saying the same thing, every cycle, for as long as the condition holds -- i.e. the
    // per-cycle heartbeat this event exists specifically not to be.
    let positiveThisCycle = false;
    const journalScanEvent = (event, detail) => {
      if (retryChannel.UNPARK_SCAN_SUCCESS_EVENTS.has(event)) positiveThisCycle = true;
      appendEvent(taskDir, 'PARKED', event, detail);
    };

    const scan = await commentScan.scanForMatch({
      deps,
      config,
      ghRepo,
      issue: task.issue,
      anchorId: anchor.commentId,
      sinceMs: anchor.sinceMs,
      patterns: UNPARK_PATTERNS,
      scanState,
      journalRoot,
      journal: journalScanEvent,
      events: UNPARK_SCAN_EVENTS,
      scannerKey: 'unpark',
      now: nowMs,
      maxPages: config && config.commentScanMaxPages,
    });

    if (!scan.ok) {
      if (scan.reason === 'backoff') continue; // already journalled by scanForMatch
      appendEvent(taskDir, 'PARKED', 'unpark-scan-failed', {
        exit: scan.exit,
        timedOut: scan.timedOut === true,
        reason: scan.reason === 'unparsable' ? 'unparsable-comments' : undefined,
        // Card #476, half 1: `gh`'s own first stderr line. `undefined` (dropped by the JSON
        // encoder, never written as `null`) on the 'unparsable' branch, where `gh` exited 0 and
        // there is genuinely nothing it said -- the absence is the honest record there, and the
        // pre-#476 shape of every other field on this event is unchanged.
        stderr: scan.stderr || undefined,
      });
      continue;
    }

    // The scan reached GitHub. Card #476, half 2: journal that ONLY when it is an outcome CHANGE
    // -- the first proven-live scan of this park cycle, or a recovery from a standing failure
    // streak. A scan that succeeds when a success is already on record writes nothing at all,
    // which is what keeps a 60s-cadence scanner from re-becoming the journal's dominant line.
    //
    // Written as a LITERAL, not as `retryChannel.UNPARK_SCAN_OK_EVENT`, for two reasons that
    // point the same way: test/park-reason-doc-sweep.test.js resolves journal event names out of
    // the source and treats an unresolvable dynamic argument as a sweep hole to be closed, not
    // ignored; and the readers' break-set lives in retry-channel.js, so writer and reader are two
    // places either way. The agreement between them is pinned by a test that emits this event and
    // asserts the next cycle stays silent -- a drifted name makes it repeat every 60 seconds,
    // which is the failure this event exists to avoid, and the test fails on it.
    if (!positiveThisCycle && retryChannel.shouldJournalScanOk(tailBefore)) {
      appendEvent(taskDir, 'PARKED', 'unpark-scan-ok', {
        // What CHANGED, so the line carries its own justification: the streak it ends, or the
        // fact that it is this park cycle's first recorded outcome.
        afterFailures: tailBefore.count,
        firstFailedAt: tailBefore.firstFailedAt || undefined,
      });
    }

    if (!scan.match) continue;
    const match = scan.match.comment;

    if (scan.match.name === 'retry') {
      reEnqueueTask(queueDir, taskDir, id);
      appendEvent(taskDir, 'PARKED', 'unparked-by-maintainer', { retryCommentId: match.id });
      continue;
    }

    // abandon -- terminal, mark it directly on state.json (no HANDLERS involvement: this task
    // never re-enters runTask's loop) and ack on the issue, never re-enqueue. The state write
    // happens BEFORE anything else below, including the cleanup a few lines down: once
    // state.json says ABANDONED, that fact is durable on disk, so a daemon crash at any point
    // after this line -- mid-ack, mid-cleanup -- resumes into a task that is already correctly
    // terminal, never one an interrupted write left ambiguous.
    // Re-read state.json rather than spreading the in-memory `state` captured at the top of this
    // loop iteration: reconcileExternalClosure runs EARLIER IN THE SAME CYCLE and writes
    // `externallyResolved` to disk, so spreading the stale snapshot silently drops it. That is
    // not hypothetical for the shape this reconciler exists for -- a maintainer who fixes a card
    // by hand and closes its issue may well also reply `abandon` on it (the 213/428 shape), and
    // the two land in the same cycle. Losing the field costs a second issue read and a DUPLICATE
    // `reconciled-externally` line in an append-only journal on the next cycle, breaking the
    // "at most 2 reads per task, ever" bound this feature is budgeted on.
    writeState(taskDir, {
      ...(readJsonSafe(path.join(taskDir, 'state.json')) || state),
      state: 'ABANDONED',
      reason: 'abandoned-by-maintainer',
      updatedAt: new Date().toISOString(),
    });
    appendEvent(taskDir, 'PARKED', 'abandoned-by-maintainer', { abandonCommentId: match.id });

    const ackFile = path.join(taskDir, 'abandon-ack.md');
    fs.writeFileSync(ackFile, 'Understood -- closing this attempt.\n');
    const ack = runSync(deps, 'gh', ['issue', 'comment', String(task.issue), '--repo', ghRepo, '--body-file', ackFile], {}, config);
    if (normalizeExit(ack) !== 0) {
      appendEvent(taskDir, 'PARKED', 'abandon-ack-failed', { exit: normalizeExit(ack), timedOut: ack.timedOut === true });
    }

    // action 4.5: reclaim the worktree/branches/PR this attempt leaked (issue #443, measured --
    // see abandonCleanup's own header). Caught here, on top of every individual step inside
    // abandonCleanup already being exit-code-checked and non-throwing, because this loop
    // processes EVERY parked task in one pass -- an unanticipated throw from this one card's
    // cleanup (a bad path, an unexpected deps.spawnSync shape, ...) must never abort the scan
    // before the next id in `ids` is even reached.
    try {
      abandonCleanup(deps, config, taskDir, id, task, state);
    } catch (err) {
      appendEvent(taskDir, 'PARKED', 'abandon-cleanup-failed', { step: 'unexpected', error: String((err && err.message) || err) });
    }
  }
}

module.exports = {
  buildParkComment,
  postParkComment,
  buildDiagnoseSurfaceComment,
  postDiagnoseSurfaceComment,
  normalizeFindingsPayload,
  buildValidateFindingsComment,
  postValidateFindingsComment,
  parseCommentId,
  RETRY_ABANDON_LINE,
  unparkScan,
  reconcileExternalClosure,
  shouldScanUnpark,
  findParkAnchor,
  reEnqueueTask,
  abandonCleanup,
  countRepeatedParks,
  listTaskIds, // shared with orphan-scan.js -- same journal/<id>/ directory listing, one copy
  readJsonSafe, // shared with orphan-scan.js
  readJournalLines, // shared with state-machine.js's finalizePark -- countRepeatedParks' own input
};
