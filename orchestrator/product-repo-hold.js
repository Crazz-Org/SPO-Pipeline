'use strict';
// product-repo-hold.js -- the arithmetic behind action 6.4's product-repo mutex, and nothing else.
//
// WHY ITS OWN FILE, with NO requires at all: two modules need these numbers, and one of them is
// config.js. product-repo-lock.js requires config.js (for commandTimeoutsMs/workers), so config.js
// requiring product-repo-lock.js back would be a cycle -- and a cycle here is not a style
// complaint: Node hands the first-loaded module a HALF-BUILT copy of the second's exports, so
// config.js would silently read `undefined` for the very constants it is trying to derive a
// deadline from, and every derived value would come out NaN. Keeping the formula in a
// dependency-free leaf lets BOTH sides compute it from the same source with no cycle and, more
// importantly, no second copy of the arithmetic to drift (the exact drift CLAUDE.md's own
// `gh api -f` story is about).
//
// Every function here takes `commandTimeoutsMs` as an argument rather than reading config itself:
// that is what makes the derivation testable against a fabricated timeout table, and what keeps
// this module honest about having no opinion of its own about configuration.

// Each spawnStep call's worst case is TWO attempts, not one: steps/scripted.js's spawnStep retries
// exactly once on a timeout for every command class except 'npm-gate' (which is not used inside
// either critical section). A call that times out TWICE throws ParkSignal and ends the section, so
// `2 x timeout` per call is a genuine ceiling rather than an approximation.
const SPAWN_ATTEMPTS_PER_CALL = 2;

// SETUP_GIT_CALLS = 22 -- every `git` spawnStep reachable inside ONE acquire-to-release span of
// steps/scripted.js's realWorktree, counting the WORST legitimate branch through all of it (a
// dirty leftover that must be preserved, an unmergeable local branch, and a remote tip that needs
// preserving past an open PR) -- i.e. every call that CAN run in a single pass, not just the
// happy path's 3:
//   realWorktree itself:          fetch, rev-parse origin/main, worktree add                 (3)
//   sweep rule 1 (worktree):      worktree list, status, [preserve: status/detach/add/
//                                 commit/rev-parse/push], worktree remove --force, prune    (10)
//   sweep rule 2 (local branch):  rev-parse --verify, merge-base, rev-parse --verify(remote),
//                                 for-each-ref, branch -D                                    (5)
//   sweep rule 3 (remote branch): rev-parse --verify, merge-base, push(preserve),
//                                 push --delete                                              (4)
//                                                                        3 + 10 + 5 + 4  =  22
const SETUP_GIT_CALLS = 22;

// SETUP_GH_CALLS = 2 -- sweep rule 3's `gh pr list` + `gh pr close` (closing an open PR before an
// otherwise-invisible `push --delete` auto-closes it -- card #455).
const SETUP_GH_CALLS = 2;

// realWorktree's own single `npm ci`.
const SETUP_NPM_CI_CALLS = 1;

// FINISH's critical section is ONE `git worktree remove --force` -- realFinish's board move and
// issue comment are deliberately outside the lock (neither touches config.productRepo).
const FINISH_GIT_CALLS = 1;

// UNBOUNDED_LOOP_GIT_CALLS -- the ONE `git` spawnStep call site inside the enumeration's scope
// that is deliberately NOT part of the counts above (sweep rule 2's per-candidate
// `merge-base --is-ancestor`, inside the `for (const candidate of ...)` loop). Named and exported
// rather than left as prose so test/product-repo-lock.test.js's source guard can hold the whole
// enumeration to the actual code: total git call SITES in the locked span == SETUP_GIT_CALLS +
// this. Without that, lowering SETUP_GIT_CALLS to the happy path's 3 passes every derivation test
// (they recompute the expectation from the same constant) while dropping MAX_LOCK_AGE_MS from
// ~127.6 min to ~24 min -- i.e. sweeping a LIVE, legitimate holder, the clone-corruption direction
// this whole module exists to avoid. Measured: that mutation survived the full 1303-test suite
// before the guard existed.
const UNBOUNDED_LOOP_GIT_CALLS = 1;

// NOT counted, and this is a DELIBERATE, DOCUMENTED GAP rather than a silent one: sweep rule 2's
// `for-each-ref` loop (steps/scripted.js, the `for (const candidate of splitLines(wipRefs.stdout))`
// block) re-checks every `wip/<task-id>-*` ref this task has ever pushed, and that count is not
// bounded by any constant in this codebase -- it grows by one every time this exact task id parks
// with a dirty or unmergeable leftover and gets retried. Folding it in honestly would require
// inventing a cap this codebase does not have.
//
// QUANTIFIED, because "unbounded" alone would overstate it. CORRECTED in C6's cross-action
// verification: the figures this paragraph carried until then ("~52 min ... a 2.4x margin ...
// roughly 19 wip refs") contradicted this file's OWN model and were far too reassuring.
//
// They were built from 24 single-attempt git calls plus one doubled one, which silently assumes
// SPAWN_ATTEMPTS_PER_CALL = 1 at almost every call site and drops `npm ci` (2 x 600s = 20 min)
// entirely. The file's own constant is 2, and worstHoldMs below applies it to every term. The
// real arithmetic, from the constants directly above and config.js's shipped commandTimeoutsMs
// (git/gh 120000, npm-ci 600000):
//
//   22 git x 2 x 120s = 5,280,000 ms
//    2 gh  x 2 x 120s =   480,000 ms
//    1 npm x 2 x 600s = 1,200,000 ms
//                     = 6,960,000 ms = 116.0 min   (worstHoldMs, and config.js's own "116-minute
//                                                   wait bound" agrees)
//
// against product-repo-lock.js's MAX_LOCK_AGE_MS = WORST_HOLD_MS + 10% = 127.6 min. So the margin
// is 1.1x, not 2.4x -- and it is 1.1x BY CONSTRUCTION, since MAX_LOCK_AGE_MS is *defined* as
// WORST_HOLD_MS x 1.1; no arithmetic here could ever have produced 2.4. The headroom for the
// unbounded wip-ref term is therefore 127.6 - 116.0 = 11.6 min, i.e. roughly THREE extra refs
// whose `merge-base --is-ancestor` each burns a doubled 120s timeout (or ~6 at a single timeout),
// not nineteen.
//
// The conclusion the old paragraph drew -- "a wedged filesystem rather than an operating point"
// -- was resting on ~6x more headroom than exists. It is still probably right, because timing out
// `merge-base --is-ancestor` against a LOCAL clone at all is already pathological, but it is now
// three refs of margin rather than nineteen, and that is thin enough that a task id which parks
// with a dirty leftover many times over should be treated as the real risk here. Recorded so the
// day it happens is a grep, not a rediscovery.

// worstHoldMs(commandTimeoutsMs) -- the longest ONE holder of the product-repo lock can
// legitimately keep it during WORKTREE's setup phase. Never restated as a literal anywhere; this
// is the single definition every other number below and in product-repo-lock.js is built from.
function worstHoldMs(commandTimeoutsMs) {
  const t = commandTimeoutsMs || {};
  return (
    SETUP_GIT_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.git +
    SETUP_GH_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.gh +
    SETUP_NPM_CI_CALLS * SPAWN_ATTEMPTS_PER_CALL * t['npm-ci']
  );
}

// finishHoldMs(commandTimeoutsMs) -- the same for FINISH's teardown phase, which is far smaller.
// Kept separate rather than reusing worstHoldMs for both: FINISH's own deadline below would
// otherwise be ~29x larger than anything FINISH can actually do, and a deadline should be as
// small as the work it covers honestly allows.
function finishHoldMs(commandTimeoutsMs) {
  const t = commandTimeoutsMs || {};
  return FINISH_GIT_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.git;
}

// waitBoundMs(commandTimeoutsMs, workers) -- (K-1) x worstHoldMs. K-1, not K: at most K-1 OTHER
// workers can each legitimately hold this lock ahead of a blocked worker before its own turn
// comes. At K=1 this is 0 -- nothing else in this pipeline can legitimately hold the lock while a
// lone worker wants it.
function waitBoundMs(commandTimeoutsMs, workers) {
  const k = Number.isInteger(workers) && workers > 0 ? workers : 1;
  return Math.max(0, k - 1) * worstHoldMs(commandTimeoutsMs);
}

// lockedStepDeadlineMs(commandTimeoutsMs, workers, genericDeadlineMs, holdMs) -- the
// config.stepDeadlineMsByState entry a step that can BLOCK ON THIS MUTEX needs.
//
// THE RULE, and it is the one CI_CHECKS' own entry in config.js already states: derive the ceiling
// from the bound so the two can never drift apart again. A step whose deadline is shorter than the
// wait it can legitimately perform does not merely get retried -- see the hazard note in config.js
// -- so this is `the longest legitimate wait` + `this phase's own longest legitimate work` + the
// generic per-step deadline as margin, exactly the shape CI_CHECKS uses
// (maxPolls * pollInterval + STEP_DEADLINE_MS).
function lockedStepDeadlineMs(commandTimeoutsMs, workers, genericDeadlineMs, holdMs) {
  return waitBoundMs(commandTimeoutsMs, workers) + holdMs + genericDeadlineMs;
}

module.exports = {
  SPAWN_ATTEMPTS_PER_CALL,
  SETUP_GIT_CALLS,
  SETUP_GH_CALLS,
  UNBOUNDED_LOOP_GIT_CALLS,
  SETUP_NPM_CI_CALLS,
  FINISH_GIT_CALLS,
  worstHoldMs,
  finishHoldMs,
  waitBoundMs,
  lockedStepDeadlineMs,
};
