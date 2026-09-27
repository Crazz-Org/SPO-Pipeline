'use strict';
// merge-queue.js -- SPO-Pipeline#294: the PURE classifier half of the merge-queue probe (the I/O
// half is steps/scripted.js's `probeMergeQueue`, next to `probeMergeability`). No I/O, no gh, no
// fs -- same split merge-cause.js already makes for the mergeability read.
//
// WHY A SECOND PROBE: once MERGE has put a PR in GitHub's merge queue, `npm run pr:wait` reads only
// open/closed/merged, and a PR GitHub REMOVED from the queue (its merge-group CI run failed, say)
// is still open. `probeMergeability` then reads `OPEN / MERGEABLE / CLEAN` -- the PR's OWN head
// checks are green -- which merge-cause.js rightly treats as "no cause", so the card used to park
// `merge-queue-not-landing` ("GitHub didn't say why") while GitHub's timeline had said exactly
// why. Measured on SPO-WebClient PR 998 (2026-09-26): Added 06:39:11Z, Removed `failed_checks`
// 06:41:56Z, park 06:48 on `merge-queue-not-landing`, with the PR still OPEN and
// `mergeQueueEntry: null`.
//
// Input: the `pullRequest` node of one `gh api graphql` read --
//   {state, mergedAt, mergeQueueEntry: {state} | null,
//    timelineItems: {nodes: [{__typename: 'AddedToMergeQueueEvent', createdAt} |
//                            {__typename: 'RemovedFromMergeQueueEvent', createdAt, reason}]}}
// `reason` is GitHub's own lowercase value (`failed_checks`, `merged`, ... -- measured, not
// documented), kept verbatim: this module never maps it to a vocabulary of its own.
//
// Output, precedence most-definite-fact first:
//   {kind: 'merged'}   -- state MERGED, or the last queue event is a removal with reason `merged`
//   {kind: 'unknown'}  -- state CLOSED: not a queue fact; MERGE's own mergeability probe already
//                         names a closed PR (`pr-closed-unmerged`), and a queue answer here would
//                         only compete with it
//   {kind: 'queued', entryState} -- a live `mergeQueueEntry`, or the last queue event is an
//                         addition (a removal BEFORE the latest addition is a re-enqueue, not a
//                         removal)
//   {kind: 'removed', removedAt, removalReason, addedAt} -- the last queue event is a removal
//                         (any reason but `merged`) after the last addition. `addedAt` is null
//                         when that addition fell outside the read's window; the caller then has
//                         no bounds to look the merge-group run up by, and says so.
//   {kind: 'unknown'}  -- empty, malformed, or no queue event at all
//
// "Last" is timeline order, which is chronological (GitHub's `timelineItems(last: N)`), never a
// re-sort on `createdAt` -- two events stamped in the same second keep the order GitHub gave.

const ADDED = 'AddedToMergeQueueEvent';
const REMOVED = 'RemovedFromMergeQueueEvent';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classifyMergeQueue(pr) {
  if (!isObject(pr) || typeof pr.state !== 'string') return { kind: 'unknown' };
  const st = pr.state.toUpperCase();
  if (st === 'MERGED') return { kind: 'merged' };
  if (st === 'CLOSED') return { kind: 'unknown' };

  if (isObject(pr.mergeQueueEntry)) {
    return { kind: 'queued', entryState: typeof pr.mergeQueueEntry.state === 'string' ? pr.mergeQueueEntry.state : null };
  }

  const nodes = isObject(pr.timelineItems) && Array.isArray(pr.timelineItems.nodes) ? pr.timelineItems.nodes : null;
  if (!nodes) return { kind: 'unknown' };

  let lastAddedIdx = -1;
  let lastRemovedIdx = -1;
  nodes.forEach((node, idx) => {
    if (!isObject(node)) return;
    if (node.__typename === ADDED) lastAddedIdx = idx;
    else if (node.__typename === REMOVED) lastRemovedIdx = idx;
  });
  if (lastAddedIdx === -1 && lastRemovedIdx === -1) return { kind: 'unknown' };
  if (lastAddedIdx > lastRemovedIdx) return { kind: 'queued', entryState: null };

  const removed = nodes[lastRemovedIdx];
  const removalReason = typeof removed.reason === 'string' ? removed.reason : null;
  if (removalReason && removalReason.toLowerCase() === 'merged') return { kind: 'merged' };
  const added = lastAddedIdx === -1 ? null : nodes[lastAddedIdx];
  return {
    kind: 'removed',
    removedAt: typeof removed.createdAt === 'string' ? removed.createdAt : null,
    removalReason,
    addedAt: added && typeof added.createdAt === 'string' ? added.createdAt : null,
  };
}

// pickMergeGroupRun(workflowRuns, prNumber) -- the merge-group run for one queue window, out of an
// `actions/runs?event=merge_group&created=<added>..<removed>` page. Other PRs' merge-group runs can
// share the window, so the head branch is the filter: GitHub names it
// `gh-readonly-queue/<base>/pr-<N>-<sha>` (measured: `gh-readonly-queue/main/pr-998-e3a157f4...`).
// `pr-<N>-` with the trailing dash, so PR 99 never matches PR 998's branch. Several matches (a
// re-run inside the window) -> the most recently created. Null when nothing matches or the input
// is not an array.
function pickMergeGroupRun(workflowRuns, prNumber, baseBranch = 'main') {
  if (!Array.isArray(workflowRuns)) return null;
  const prefix = `gh-readonly-queue/${baseBranch}/pr-${prNumber}-`;
  let best = null;
  for (const run of workflowRuns) {
    if (!isObject(run) || typeof run.head_branch !== 'string' || !run.head_branch.startsWith(prefix)) continue;
    if (!best || String(run.created_at || '') > String(best.created_at || '')) best = run;
  }
  if (!best) return null;
  return {
    mergeGroupRunId: Number.isInteger(best.id) ? best.id : null,
    mergeGroupRunUrl: typeof best.html_url === 'string' ? best.html_url : null,
    runConclusion: typeof best.conclusion === 'string' ? best.conclusion : null,
  };
}

module.exports = { classifyMergeQueue, pickMergeGroupRun };
