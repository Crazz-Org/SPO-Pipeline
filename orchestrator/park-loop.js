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
const { spawnSync } = require('child_process');

const { appendEvent, writeState } = require('./journal');
const { moveCard } = require('./board');

function runSync(deps, command, args, opts = {}) {
  const spawnSyncFn = (deps && deps.spawnSync) || spawnSync;
  return spawnSyncFn(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
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
      `> **Ce park est identique aux ${repeat} derniers** (\`${reason}\`, même détail). Une réponse`,
      "> `retry` seule ne changera rien : l'état que la machine refuse est inchangé d'une tentative",
      "> à l'autre. Corrige d'abord ce que le détail ci-dessous nomme.",
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

  const result = runSync(deps, 'gh', ['issue', 'comment', String(issue), '--repo', ghRepo, '--body-file', commentFile]);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, 'PARKED', 'park-comment-failed', { exit });
    return;
  }

  const commentId = parseCommentId(result.stdout);
  appendEvent(ctx.taskDir, 'PARKED', 'park-comment', { commentId, reason });
}

// ---- unpark scan (daemon, real mode) ---------------------------------------------------------
//
// Caveat: `gh api repos/<repo>/issues/<n>/comments` reads one page (GitHub's default, 30
// comments) -- fine for a fresh park (the maintainer's reply is the newest comment by
// construction), but a very long-lived parked issue could in principle need pagination this
// build does not implement.

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

function firstLine(text) {
  return ((text || '').split('\n')[0] || '').trim();
}

const RETRY_RE = /^retry\b/i;
const ABANDON_RE = /^abandon\b/i;

// Re-enqueues `id` with the ORIGINAL task.json fields (queue/<retry-...>.json) -- unlike
// intake.makeTask's zero-padded sequence naming (built for `spo pull`'s priority-order batch),
// a retry only ever concerns one already-known id, so a timestamp is enough for both uniqueness
// and filename-sort placement among whatever else is in queue/ at the time. worktreePath/branch
// are dropped even if present (they never are -- task.json is the original queue file, never
// rewritten with runtime fields -- see journal.js's own header comment) so WORKTREE derives both
// fresh from config.pipelineWorktreesDir/taskId on the retry, same as a first attempt.
function reEnqueueTask(queueDir, taskDir, id) {
  const original = readJsonSafe(path.join(taskDir, 'task.json')) || {};
  const { worktreePath, branch, ...rest } = original;
  fs.mkdirSync(queueDir, { recursive: true });
  const file = path.join(queueDir, `retry-${Date.now()}-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...rest, id }, null, 2) + '\n');
  return file;
}

// unparkScan(queueDir, journalRoot, config, deps) -- one pass over every journaled task. For
// each PARKED kind:"card" task with a park-comment anchor not yet acted on, reads the issue's
// comments and looks only at those posted after the anchor (ascending id order); the first one
// whose FIRST LINE is `retry` (optionally followed by more text) or `abandon`,
// case-insensitive, decides the outcome. Anything else on the issue -- including a `retry`
// posted BEFORE the park comment, or a comment matching neither word -- is left alone; a human
// conversation on the issue is allowed.
async function unparkScan(queueDir, journalRoot, config, deps = {}) {
  const ghRepo = (config && config.ghRepo) || 'Crazz-Org/SPO-WebClient';
  const ids = listTaskIds(journalRoot);

  for (const id of ids) {
    const taskDir = path.join(journalRoot, id);
    const state = readJsonSafe(path.join(taskDir, 'state.json'));
    if (!state || state.state !== 'PARKED') continue;

    const task = readJsonSafe(path.join(taskDir, 'task.json'));
    if (!task || task.kind !== 'card' || !task.issue) continue;

    const anchor = findParkAnchor(readJournalLines(taskDir));
    if (!anchor || anchor.alreadyHandled) continue;

    const commentsResult = runSync(deps, 'gh', ['api', `repos/${ghRepo}/issues/${task.issue}/comments`]);
    if (normalizeExit(commentsResult) !== 0) {
      appendEvent(taskDir, 'PARKED', 'unpark-scan-failed', { exit: normalizeExit(commentsResult) });
      continue;
    }

    let comments;
    try {
      comments = JSON.parse(commentsResult.stdout);
    } catch {
      appendEvent(taskDir, 'PARKED', 'unpark-scan-failed', { reason: 'unparsable-comments' });
      continue;
    }
    if (!Array.isArray(comments)) continue;

    const after = comments
      .filter((c) => typeof c.id === 'number' && c.id > anchor.commentId)
      .sort((a, b) => a.id - b.id);

    const match = after.find((c) => RETRY_RE.test(firstLine(c.body)) || ABANDON_RE.test(firstLine(c.body)));
    if (!match) continue;

    if (RETRY_RE.test(firstLine(match.body))) {
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
    const ack = runSync(deps, 'gh', ['issue', 'comment', String(task.issue), '--repo', ghRepo, '--body-file', ackFile]);
    if (normalizeExit(ack) !== 0) {
      appendEvent(taskDir, 'PARKED', 'abandon-ack-failed', { exit: normalizeExit(ack) });
    }
  }
}

module.exports = {
  buildParkComment,
  postParkComment,
  parseCommentId,
  RETRY_ABANDON_LINE,
  unparkScan,
  findParkAnchor,
  reEnqueueTask,
  countRepeatedParks,
  listTaskIds, // shared with orphan-scan.js -- same journal/<id>/ directory listing, one copy
  readJsonSafe, // shared with orphan-scan.js
  readJournalLines, // shared with state-machine.js's finalizePark -- countRepeatedParks' own input
};
