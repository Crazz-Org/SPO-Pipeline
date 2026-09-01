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

  const result = runSync(deps, 'gh', ['issue', 'comment', String(issue), '--repo', ghRepo, '--body-file', commentFile], {}, ctx.config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, 'PARKED', 'park-comment-failed', { exit, timedOut: result.timedOut === true });
    return;
  }

  const commentId = parseCommentId(result.stdout);
  appendEvent(ctx.taskDir, 'PARKED', 'park-comment', { commentId, reason });
}

// ---- action 5.1d: surface DIAGNOSE on the card -------------------------------------------------
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

// The anchor for the CURRENT park cycle: the LAST `park-comment` event with a numeric
// commentId, and whether an `unparked-by-maintainer`/`abandoned-by-maintainer` event already
// follows it (in which case this cycle was already handled -- idempotent across scans, whether
// or not the re-enqueued task has been drained back out of PARKED yet).
function findParkAnchor(lines) {
  let anchorIndex = -1;
  let commentId = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].event === 'park-comment' && typeof lines[i].commentId === 'number') {
      anchorIndex = i;
      commentId = lines[i].commentId;
    }
  }
  if (anchorIndex === -1) return null;

  const alreadyHandled = lines
    .slice(anchorIndex + 1)
    .some((e) => e.event === 'unparked-by-maintainer' || e.event === 'abandoned-by-maintainer');

  return { commentId, alreadyHandled };
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

    const anchor = findParkAnchor(readJournalLines(taskDir));
    if (!anchor || anchor.alreadyHandled) continue;

    const scan = await commentScan.scanForMatch({
      deps,
      config,
      ghRepo,
      issue: task.issue,
      anchorId: anchor.commentId,
      patterns: UNPARK_PATTERNS,
      scanState,
      journalRoot,
      journal: (event, detail) => appendEvent(taskDir, 'PARKED', event, detail),
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
      });
      continue;
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
