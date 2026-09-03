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
// exactly once on a timeout for every command class except 'npm-gate' (not used inside either
// critical section) and, as of R2 (post-verification, third pass), 'bench-install' -- see
// spawnStep's own comment for why a retry there is actively unsafe (a killed `bash` can leave
// `npm run build:e2e`/`systemctl restart` still running underneath it; a second attempt would
// build into the SAME `dist/` concurrently, the exact "installs the wrong binary and reports
// success" defect this action exists to close). 'bench-install' is therefore counted at ONE
// attempt in finishSyncHoldMs below, not SPAWN_ATTEMPTS_PER_CALL -- see that function's own
// comment. A call that times out TWICE (every OTHER class) throws ParkSignal and ends the
// section, so `2 x timeout` per call remains a genuine ceiling for all of them.
const SPAWN_ATTEMPTS_PER_CALL = 2;

// SETUP_GIT_CALLS = 27 -- every `git` spawnStep reachable inside ONE acquire-to-release span of
// steps/scripted.js's realWorktree, counting the WORST legitimate branch through all of it (a
// dirty leftover that must be preserved, an unmergeable local branch, a remote tip that needs
// preserving past an open PR, AND an owed bench-worker reinstall to pay back) -- i.e. every call
// that CAN run in a single pass, not just the happy path's 3:
//   realWorktree itself:          fetch, rev-parse origin/main, worktree add                 (3)
//   sweep rule 1 (worktree):      worktree list, status, [preserve: status/detach/add/
//                                 commit/rev-parse/push], worktree remove --force, prune    (10)
//   sweep rule 2 (local branch):  rev-parse --verify, merge-base, rev-parse --verify(remote),
//                                 for-each-ref, branch -D                                    (5)
//   sweep rule 3 (remote branch): rev-parse --verify, merge-base, push(preserve),
//                                 push --delete                                              (4)
//   action B1.4 round 4 (debt repayment, payBenchReinstallDebtIfOwed calling
//   fastForwardMainAndInstall): fetch, rev-parse --abbrev-ref HEAD, status --porcelain,
//   merge --ff-only, merge-base --is-ancestor (the debt's own extra safety check)             (5)
//                                                                    3 + 10 + 5 + 4 + 5  =  27
const SETUP_GIT_CALLS = 27;

// SETUP_GH_CALLS = 2 -- sweep rule 3's `gh pr list` + `gh pr close` (closing an open PR before an
// otherwise-invisible `push --delete` auto-closes it -- card #455).
const SETUP_GH_CALLS = 2;

// realWorktree's own single `npm ci`.
const SETUP_NPM_CI_CALLS = 1;

// action B1.4 round 4: payBenchReinstallDebtIfOwed's own `bash scripts/bench-install.sh`, once
// per WORKTREE (only reached when a debt is actually owed AND the fast-forward above succeeded
// AND the bench is confirmed idle -- counted here anyway as the worst case a hold-time budget
// must cover, same convention FINISH_SYNC_BENCH_INSTALL_CALLS below already uses).
const SETUP_BENCH_INSTALL_CALLS = 1;
// Exempt from spawnStep's retry, same exemption and same reasoning as
// FINISH_SYNC_BENCH_INSTALL_ATTEMPTS below (a killed `bash` can leave `npm run build:e2e`/
// `systemctl restart` still running underneath it; a second attempt would build into the SAME
// dist/ concurrently) -- so its worst-case hold is ONE attempt, not SPAWN_ATTEMPTS_PER_CALL's two.
const SETUP_BENCH_INSTALL_ATTEMPTS = 1;

// FINISH's teardown critical section (phase 'finish') is ONE `git worktree remove --force` --
// realFinish's board move and issue comment are deliberately outside the lock (neither touches
// config.productRepo).
const FINISH_GIT_CALLS = 1;

// Action B1.4: FINISH's SECOND, EARLIER critical section (phase 'finish-sync' -- fast-forward
// config.productRepo's own checkout to origin/main, then conditionally reinstall the bench worker
// when the merge touched its own sources; see steps/scripted.js's realFinish for the full
// rationale and scripts/finish.sh in SPO-WebClient for the human-session rule this puts on the
// pipeline's own path for the first time). Counted the same way SETUP_GIT_CALLS/SETUP_GH_CALLS
// above are -- every spawnStep call site reachable inside this ONE acquire-to-release span,
// worst case (every check attempted, not just the happy path):
//   realFinish's OWN calls, ahead of the shared function:
//     `git fetch origin`, `git diff --name-only <mergeSha>^ <mergeSha>`                  (2 git)
//     `gh pr view <prNumber> --json mergeCommit`                                          (1 gh)
//   fastForwardMainAndInstall (round 4: the SAME function payBenchReinstallDebtIfOwed calls,
//   above -- see its own header for why realFinish's call site still counts its `fetch` even
//   though `skipFetch: true` means this particular caller never actually runs it: the call SITE
//   is real source this budget must cover, and over-counting a worst-case hold is the safe
//   direction):
//     `git fetch origin`, `git rev-parse --abbrev-ref HEAD`, `git status --porcelain`,
//     `git merge --ff-only origin/main`                                                  (4 git)
//     `bash scripts/bench-install.sh` (only when the merge touched the bench worker AND the
//     fast-forward itself succeeded -- counted here anyway as the worst case a hold-time budget
//     must cover)                                                                (1 bench-install)
//                                                                          2 + 4 = 6 git, 1 gh
const FINISH_SYNC_GIT_CALLS = 6;
const FINISH_SYNC_GH_CALLS = 1;
const FINISH_SYNC_BENCH_INSTALL_CALLS = 1;
// R2 (post-verification, third pass): 'bench-install' is exempt from spawnStep's retry (see
// spawnStep's own comment and SPAWN_ATTEMPTS_PER_CALL's above), so its worst-case hold is ONE
// attempt, not two -- a literal 1, named here rather than reusing SPAWN_ATTEMPTS_PER_CALL, so
// a reader of finishSyncHoldMs's own arithmetic below sees the exemption without having to
// cross-reference spawnStep's source.
const FINISH_SYNC_BENCH_INSTALL_ATTEMPTS = 1;

// UNBOUNDED_LOOP_GIT_CALLS -- the ONE `git` spawnStep call site inside the enumeration's scope
// that is deliberately NOT part of the counts above (sweep rule 2's per-candidate
// `merge-base --is-ancestor`, inside the `for (const candidate of ...)` loop). Named and exported
// rather than left as prose so test/product-repo-lock.test.js's source guard can hold the whole
// enumeration to the actual code: total git call SITES in the locked span == SETUP_GIT_CALLS +
// this. Without that, lowering SETUP_GIT_CALLS to the happy path's 3 passes every derivation test
// (they recompute the expectation from the same constant) while dropping MAX_LOCK_AGE_MS from
// ~166 min (action B1.4 round 4's own shipped default) to ~61 min -- i.e. sweeping a LIVE,
// legitimate holder, the clone-corruption direction this whole module exists to avoid. Originally
// measured (action 6.4, before this file's SETUP_GIT_CALLS carried round 4's debt-repayment
// terms): that mutation survived the full 1303-test suite before the guard existed.
const UNBOUNDED_LOOP_GIT_CALLS = 1;

// NOT counted, and this is a DELIBERATE, DOCUMENTED GAP rather than a silent one: sweep rule 2's
// `for-each-ref` loop (steps/scripted.js, the `for (const candidate of splitLines(wipRefs.stdout))`
// block) re-checks every `wip/<task-id>-*` ref this task has ever pushed, and that count is not
// bounded by any constant in this codebase -- it grows by one every time this exact task id parks
// with a dirty or unmergeable leftover and gets retried. Folding it in honestly would require
// inventing a cap this codebase does not have.
//
// QUANTIFIED, because "unbounded" alone would overstate it. CORRECTED in C6's cross-action
// verification, and RECOMPUTED again in action B1.4 round 4 (this arithmetic has now been wrong
// twice from stale hand-restated numbers -- pinned by VALUE below, in
// test/product-repo-lock.test.js, never by shape alone, precisely so a third drift is caught by
// the suite rather than by a fourth verification pass).
//
// The real arithmetic, from the constants directly above (SETUP_GIT_CALLS now 27, including round
// 4's own debt-repayment terms) and config.js's shipped commandTimeoutsMs (git/gh 120000, npm-ci
// 600000, bench-install 900000):
//
//   27 git    x 2 x 120000 = 6,480,000 ms
//    2 gh     x 2 x 120000 =   480,000 ms
//    1 npm-ci x 2 x 600000 = 1,200,000 ms
//    1 bench-install x 1 x 900000 =  900,000 ms   (never retried -- SETUP_BENCH_INSTALL_ATTEMPTS)
//                            = 9,060,000 ms = 151.0 min   (worstHoldMs)
//
// against product-repo-lock.js's MAX_LOCK_AGE_MS = WORST_HOLD_MS + 10% = 9,966,000 ms = 166.1 min.
// So the margin is 1.1x, not a larger figure -- and it is 1.1x BY CONSTRUCTION, since
// MAX_LOCK_AGE_MS is *defined* as WORST_HOLD_MS x 1.1. The headroom for the unbounded wip-ref term
// is therefore 166.1 - 151.0 = 15.1 min, i.e. roughly THREE extra refs whose `merge-base
// --is-ancestor` each burns a doubled 120s timeout (or ~7 at a single timeout), not nineteen.
//
// Timing out `merge-base --is-ancestor` against a LOCAL clone at all is already pathological, so
// "a wedged filesystem rather than an operating point" is still probably the right read -- but
// three refs of margin is thin enough that a task id which parks with a dirty leftover many times
// over should be treated as the real risk here. Recorded so the
// day it happens is a grep, not a rediscovery.

// worstHoldMs(commandTimeoutsMs) -- the longest ONE holder of the product-repo lock can
// legitimately keep it during WORKTREE's setup phase. Never restated as a literal anywhere; this
// is the single definition every other number below and in product-repo-lock.js is built from.
// action B1.4 round 4: the SETUP_BENCH_INSTALL_CALLS term is new -- payBenchReinstallDebtIfOwed's
// own conditional reinstall, budgeted at SETUP_BENCH_INSTALL_ATTEMPTS (1), never
// SPAWN_ATTEMPTS_PER_CALL (2), for the identical never-retried reason FINISH_SYNC_BENCH_INSTALL's
// own term below is.
function worstHoldMs(commandTimeoutsMs) {
  const t = commandTimeoutsMs || {};
  return (
    SETUP_GIT_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.git +
    SETUP_GH_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.gh +
    SETUP_NPM_CI_CALLS * SPAWN_ATTEMPTS_PER_CALL * t['npm-ci'] +
    SETUP_BENCH_INSTALL_CALLS * SETUP_BENCH_INSTALL_ATTEMPTS * t['bench-install']
  );
}

// finishHoldMs(commandTimeoutsMs) -- the same for FINISH's teardown phase (worktree remove),
// which is far smaller. Kept separate rather than reusing worstHoldMs for both: FINISH's own
// deadline below would otherwise be ~29x larger than anything FINISH can actually do, and a
// deadline should be as small as the work it covers honestly allows.
function finishHoldMs(commandTimeoutsMs) {
  const t = commandTimeoutsMs || {};
  return FINISH_GIT_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.git;
}

// finishSyncHoldMs(commandTimeoutsMs, benchIdleWaitMaxMs) -- action B1.4's own critical section
// (fast-forward + conditional bench reinstall, phase 'finish-sync'), the worst legitimate hold
// FINISH's FIRST lock acquisition can run for.
//
// benchIdleWaitMaxMs is the SECOND parameter deliberately, not folded into commandTimeoutsMs:
// it is not a spawnSync class timeout (nothing is spawned while waiting -- see steps/scripted.js's
// waitForBenchIdle, a plain fs poll loop), it is config.js's own
// benchIdleWaitMaxPolls x benchIdleWaitPollIntervalMs, the bounded wait the post-verification
// hazard fix added ahead of the reinstall so an unconditional `systemctl restart` inside
// bench-install.sh cannot cut a SIBLING card's in-flight GATE on this daemon's real K=2
// deployment. Counted ONCE, not x SPAWN_ATTEMPTS_PER_CALL: it is a single bounded wait with its
// own explicit ceiling, not a spawnStep call subject to the retry-once convention the other terms
// here are.
//
// NOT folded into MAX_LOCK_AGE_MS (product-repo-lock.js), and that is a deliberate, checked
// choice, not an oversight: MAX_LOCK_AGE_MS -- the age past which ANY holder of the ONE shared
// lock file is swept regardless of which phase it is in -- is derived from worstHoldMs
// (WORKTREE's own setup phase) alone. At today's shipped defaults that is ~151 minutes (action
// B1.4 round 4: up from ~116, once WORKTREE's own critical section gained its debt-repayment
// terms -- see SETUP_GIT_CALLS/SETUP_BENCH_INSTALL_CALLS above), against finishSyncHoldMs's own
// ~58 minutes (6 git + 1 gh, each x2 x120s, plus 1 bench-install at a SINGLE attempt -- R2,
// post-verification third pass: never retried, see spawnStep's own comment -- x900s, plus the
// bench-idle wait's own 900000ms ceiling = 1440000 + 240000 + 900000 + 900000 = 3480000ms =
// 58 min) -- comfortably inside the existing ceiling, the same way the original
// finishHoldMs (4 minutes) always was. Guarded, not just asserted in prose:
// test/product-repo-lock.test.js's own derivation test recomputes both numbers from the SAME
// commandTimeoutsMs input on every run and fails loudly the day a raised 'bench-install' (or
// 'git'/'gh') timeout, or a raised benchIdleWaitMaxMs, ever makes this section's worst legitimate
// hold exceed WORKTREE's -- the point past which sweeping a live finish-sync holder becomes
// possible again, the exact clone-corruption shape this whole mutex exists to prevent.
function finishSyncHoldMs(commandTimeoutsMs, benchIdleWaitMaxMs) {
  const t = commandTimeoutsMs || {};
  const idleWait = Number.isFinite(benchIdleWaitMaxMs) && benchIdleWaitMaxMs > 0 ? benchIdleWaitMaxMs : 0;
  return (
    FINISH_SYNC_GIT_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.git +
    FINISH_SYNC_GH_CALLS * SPAWN_ATTEMPTS_PER_CALL * t.gh +
    // R2: FINISH_SYNC_BENCH_INSTALL_ATTEMPTS (1), not SPAWN_ATTEMPTS_PER_CALL (2) -- a timed-out
    // 'bench-install' is never retried (spawnStep's own comment), so a second attempt's own
    // 900000ms must not be budgeted for here; doing so was the tell that the retry itself was
    // still live when this was first written.
    FINISH_SYNC_BENCH_INSTALL_CALLS * FINISH_SYNC_BENCH_INSTALL_ATTEMPTS * t['bench-install'] +
    idleWait
  );
}

// finishStepDeadlineMs(commandTimeoutsMs, workers, genericDeadlineMs, benchIdleWaitMaxMs) --
// FINISH's OWN stepDeadlineMsByState entry (config.js), covering the WHOLE state, not just one
// lock span. lockedStepDeadlineMs below (`waitBoundMs + holdMs + genericDeadlineMs`) fits a step
// that acquires the product-repo lock exactly ONCE -- true for WORKTREE, no longer true for
// FINISH once action B1.4 gave it a SECOND, independent acquire/release pair ('finish-sync' ahead
// of 'finish'). A worst-case run can legitimately wait out (K-1) other holders TWICE, once per
// acquisition, so the wait bound is counted twice; the two phases' own hold times simply add,
// since they never overlap (one is released before the other is ever requested).
// benchIdleWaitMaxMs is threaded straight through to finishSyncHoldMs -- see that function's own
// header for why it is a parameter here rather than baked into commandTimeoutsMs.
function finishStepDeadlineMs(commandTimeoutsMs, workers, genericDeadlineMs, benchIdleWaitMaxMs) {
  return (
    2 * waitBoundMs(commandTimeoutsMs, workers) +
    finishSyncHoldMs(commandTimeoutsMs, benchIdleWaitMaxMs) +
    finishHoldMs(commandTimeoutsMs) +
    genericDeadlineMs
  );
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
  SETUP_BENCH_INSTALL_CALLS,
  SETUP_BENCH_INSTALL_ATTEMPTS,
  FINISH_GIT_CALLS,
  FINISH_SYNC_GIT_CALLS,
  FINISH_SYNC_GH_CALLS,
  FINISH_SYNC_BENCH_INSTALL_CALLS,
  FINISH_SYNC_BENCH_INSTALL_ATTEMPTS,
  worstHoldMs,
  finishHoldMs,
  finishSyncHoldMs,
  finishStepDeadlineMs,
  waitBoundMs,
  lockedStepDeadlineMs,
};
