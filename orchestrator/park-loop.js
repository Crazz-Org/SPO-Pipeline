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
//     anchor.
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
function buildParkComment({ reason, detail, lastState, repeat = 1 }) {
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
function postParkComment(ctx, deps, { reason, detail, lastState, repeat = 1 }) {
  moveCard(ctx, deps, 'PARKED');

  const issue = ctx.task && ctx.task.issue;
  if (!issue) {
    appendEvent(ctx.taskDir, 'PARKED', 'park-comment-skipped', { reason: 'no issue' });
    return;
  }

  const ghRepo = (ctx.config && ctx.config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const body = buildParkComment({ reason, detail, lastState, repeat });
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
function reEnqueueTask(queueDir, taskDir, id) {
  const original = readJsonSafe(path.join(taskDir, 'task.json')) || {};
  const { worktreePath, branch, ...rest } = original;
  fs.mkdirSync(queueDir, { recursive: true });
  const file = path.join(queueDir, `0000-retry-${Date.now()}-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...rest, id }, null, 2) + '\n');
  return file;
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
async function unparkScan(queueDir, journalRoot, config, deps = {}, scanState = commentScan.createScanState()) {
  const ghRepo = (config && config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const ids = listTaskIds(journalRoot);
  const nowMs = deps.now !== undefined ? deps.now : Date.now();

  for (const id of ids) {
    const taskDir = path.join(journalRoot, id);
    const state = readJsonSafe(path.join(taskDir, 'state.json'));
    if (!state || state.state !== 'PARKED') continue;

    const task = readJsonSafe(path.join(taskDir, 'task.json'));
    if (!task || task.kind !== 'card' || !task.issue) continue;

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
    // never re-enters runTask's loop) and ack on the issue, never re-enqueue.
    writeState(taskDir, {
      ...state,
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
  }
}

module.exports = {
  buildParkComment,
  postParkComment,
  parseCommentId,
  RETRY_ABANDON_LINE,
  unparkScan,
  shouldScanUnpark,
  findParkAnchor,
  reEnqueueTask,
  countRepeatedParks,
  listTaskIds, // shared with orphan-scan.js -- same journal/<id>/ directory listing, one copy
  readJsonSafe, // shared with orphan-scan.js
  readJournalLines, // shared with state-machine.js's finalizePark -- countRepeatedParks' own input
};
