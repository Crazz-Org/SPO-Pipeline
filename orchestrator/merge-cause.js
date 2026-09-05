'use strict';
// merge-cause.js -- SPO-Pipeline#85: MERGE used to park on the locally-observed SYMPTOM
// (`merge-queue-not-landing`, `detail.lastExit`) when `npm run pr:wait` gave up, even though
// GitHub knew the real blocking cause the whole time (measured: issue-443's PR merged 30s AFTER
// the park, issue-517's PR merged 17s BEFORE it -- GitHub's own answer is the truth, a locally
// observed exit code is not). This module is the PURE classifier half of the fix -- no I/O, no
// gh, no fs -- that turns one `gh pr view --json state,mergeable,mergeStateStatus` read (the I/O
// half lives in steps/scripted.js's `probeMergeability`, which calls this) into one of the five
// terminal cause reasons below, or an honest `unknown` when GitHub's own answer is not a
// blocking one -- in which case the caller keeps the old symptom reason as a fallback, never
// invents a cause GitHub did not actually give.
//
// UNKNOWN is the EXPECTED first answer, not an edge case: GitHub computes `mergeable` and
// `mergeStateStatus` LAZILY, so the first `gh pr view` on a PR kicks off a background job and
// answers `UNKNOWN` on both fields, with the real value only landing on a LATER read. Measured
// against real PRs on this account: 4 of 4 open PRs read `UNKNOWN`/`UNKNOWN` on the first call,
// and a definite answer arrived, across 9 timed cold PRs, only once ~1.55s of wall-clock had
// elapsed since that first UNKNOWN -- not after any particular number of calls. That is why the
// I/O half of this fix, `steps/scripted.js`'s `probeMergeability`, re-reads (bounded, sleeping
// between reads) rather than trusting a single read: a single read sees `CLEAN`/`UNKNOWN` (this
// module's own honest `unknown`) almost every time in production, which would make this whole
// module a near-no-op. This file stays the pure classifier either way -- it has no opinion on how
// many times its input was read, only on what a given reading means.
//
// GitHub's own documented enums (case-tolerant and null/undefined-safe below -- a real `gh`
// payload is always uppercase, but nothing here assumes a caller was equally careful):
//   mergeable:        MERGEABLE | CONFLICTING | UNKNOWN
//   mergeStateStatus: BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE
//
// Precedence, most-specific-fact first: merged > closed > conflict > blocked > behind > draft >
// unstable > unknown. `CLEAN`, `UNKNOWN`, and `HAS_HOOKS` are never a cause -- none of the three
// says the merge is BLOCKED on anything; they degrade to `{kind: 'unknown'}` same as an
// unrecognised enum value or missing input, so the fallback symptom reason is what parks.
//
// Naming note, deliberately NOT "improved": the reason is `merge-blocked`, never
// `merge-blocked-by-review` -- GitHub's own `BLOCKED` covers required reviews, failing required
// checks, AND branch protection alike, so a `-by-review` name would be a factual over-claim this
// module has no way to back up from `mergeStateStatus` alone.
const MERGE_CAUSE_REASONS = Object.freeze({
  CONFLICT: 'merge-conflict',
  BLOCKED: 'merge-blocked',
  BEHIND: 'merge-behind-base',
  DRAFT: 'merge-pr-draft',
  UNSTABLE: 'merge-checks-failing',
});

function upper(value) {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

// classifyMergeCause({state, mergeable, mergeStateStatus}) -> one of:
//   {kind: 'merged'}                     -- state is MERGED
//   {kind: 'closed'}                     -- state is CLOSED (and not merged)
//   {kind: 'cause', reason: <one of MERGE_CAUSE_REASONS>} -- GitHub gives a definite blocking answer
//   {kind: 'unknown'}                    -- GitHub has no usable answer (missing/null input,
//                                            UNKNOWN, CLEAN, HAS_HOOKS, or an enum value this
//                                            module does not recognise)
function classifyMergeCause({ state, mergeable, mergeStateStatus } = {}) {
  const st = upper(state);
  const mg = upper(mergeable);
  const ms = upper(mergeStateStatus);

  if (st === 'MERGED') return { kind: 'merged' };
  if (st === 'CLOSED') return { kind: 'closed' };
  if (mg === 'CONFLICTING' || ms === 'DIRTY') return { kind: 'cause', reason: MERGE_CAUSE_REASONS.CONFLICT };
  if (ms === 'BLOCKED') return { kind: 'cause', reason: MERGE_CAUSE_REASONS.BLOCKED };
  if (ms === 'BEHIND') return { kind: 'cause', reason: MERGE_CAUSE_REASONS.BEHIND };
  if (ms === 'DRAFT') return { kind: 'cause', reason: MERGE_CAUSE_REASONS.DRAFT };
  if (ms === 'UNSTABLE') return { kind: 'cause', reason: MERGE_CAUSE_REASONS.UNSTABLE };
  return { kind: 'unknown' };
}

module.exports = { MERGE_CAUSE_REASONS, classifyMergeCause };
