# Remediation plan — execution state

Companion to `doc/remediation-plan-2026-08.md`, which is the contract and does not change.
This file is what the plan *turned out to be* once executed: what is done, what the plan itself
got wrong, and what the next session needs to proceed safely. Update it at the end of every
chantier.

**State as of 2026-08-31.** `main` = `652bb3b`. Suite **759 passing, 0 failing**.

## Progress

| chantier | state |
|---|---|
| **C1** — truthful judges | **DONE**, gate green (live card #462) |
| **C2** — daemon robustness + live harness | **DONE**, gate green (live recette #469) |
| **C3** — token hemorrhage | **3.6 done out of order**; 3.1–3.5, 3.7 open. **3.7 is a DECISION** |
| C4–C7 | not started |

Tests: 454 (plan baseline) → 759.

## Corrections to the plan itself

The plan is an audit artifact, not scripture. Two of its numbers were wrong and were corrected
against the product source, not by guesswork:

- **`npm-gate` 900s was 8x too small.** `npm run gate` reaches `src/e2e/bench/cli.ts`, whose
  `DEFAULT_WAIT_TIMEOUT_MIN = 120` (7200s), after which the bench exits 4 into the designed
  `gate-timeout` park. A 900s kill destroys a legitimate queue wait, and the retry re-submits a
  bench job that `job.ts` refuses as a duplicate -> exit 2 -> the card parks `gate-dirty-tree`:
  a busy bench reported as a dirty worktree that is perfectly clean. Now 7800s, and `npm-gate`
  is the one command never retried.
- **The chantier-gate command was unusable.** Bare `node --test` walks into any parked card's
  product worktree under `worktrees/issue-<n>/` and runs SPO-WebClient's TypeScript suites:
  1926 tests / 1168 failures with four parked cards. Use `node --test test/*.test.js`.

**2.1's scope was insufficient for its own stated purpose**, so 2.1b was added: four modules
spawned `gh`/`npm` through private `runSync`s with no timeout, and `board.js`'s `moveCard` is
called from *inside* the steps 2.1 covered.

## Live evidence gathered (feeds later chantiers)

- **3.1 (resume after park)** — measured at ~$14 of tokens on ONE card (#455), re-deriving a plan
  that already existed and was correct. Highest-value action in C3.
- **3.3 (auto-triage cap)** — hit a **12.8-hour** stall (53 cycles, 128 attempts, issues
  449/455/456), longer than the 2.5h incident the plan sized it from.
- **3.4** — its absence made a held report unrecoverable; there is still no `spo triage --retry`.
- **5.3 (PASS_WITH_FINDINGS)** — observed live on #455: a substantive finding (orphaned
  `cachedZonePath` session state) was journalled and then dropped, exactly as the plan predicts.
- **New, not in the plan (suggest C4)** — a retry's leftover sweep runs `push origin --delete`
  without checking for an **open PR** on the branch, so a retry silently closes a green,
  merge-ready PR and orphans the commits. Observed on #455; `rescue/issue-455-run1` was tagged
  locally to save that work.
- **Untracked spend** — intake steps have no `taskDir`, so `spo tokens` cannot see them at all.
  Not in any chantier; suggest C5.

## Operational facts that cost time to learn

- **Merging restarts the daemon.** A post-merge hook `systemctl restart`s daemon + dashboard on
  every `git pull` in main. It SIGTERMs any in-flight `claude`, which parks the card
  `llm-transport-failed:<STEP>`. **Check for in-flight tasks before merging.** `systemctl --user
  mask` does NOT work here (the units are real files); just re-run `stop` after each pull.
- **The suite could contaminate the live product repo.** Fixed via `SPO_PRODUCT_REPO` /
  `SPO_WORKTREES_DIR`, set by `test/helpers.js` for every daemon subprocess. Before that, a
  mutation-testing round left 44 real worktrees and 61 branches in `~/SPO-WebClient`, invisible
  to `git status` because `worktrees/` is gitignored.
- **Cleaning leaked worktrees**: `git worktree remove --force` + `prune`, **never `rm -rf`**,
  which leaves stale registrations.
- **`spo recette` runs ~9 minutes.** Run it in the background; a foreground tool ceiling will
  SIGTERM it and its cleanup will not run.

## The driver workflow that worked

One action = one **Sonnet** subagent (medium effort) with a self-contained spec including its
tests. Each verified by an **Opus** subagent (high effort) doing adversarial diff review **plus
mutation testing**. Subagents never commit — the driver commits after verification, which keeps
"one commit per action" exact and stops agents clobbering each other.

Verification found a defect in nearly every action, and several were *the fix creating the bug it
was preventing*: `preserveWorktreeWip` throwing inside `finalizePark` (a crash loop over one hung
`git status`); a typo'd `SPO_TIMEOUT_*_MS` crashing the daemon through `spawnSync`'s own
validation; the triage claim's mtime fallback un-claiming live claims; a comment-scan allowlist
bypassable by omitting a field. **Mutation testing repeatedly found tests that passed for the
wrong reason** — the single highest-value part of the loop.

## Open decision — 3.7, reframed

The plan asks whether to restore `--max-budget-usd` caps. **That question no longer means
anything**: dollars were retired this session (`spo tokens`, billable-weighted tokens = fresh
input + cache creation + output, cache reads reported separately). Also, `step-contracts.js` sets
`maxBudgetUsd: undefined` everywhere, so the spec's "per-step USD cap" column describes a
mechanism that does not exist.

The live question is: **is a consumption ceiling needed on top of the existing 15-minute
`LLM_STEP_DEADLINE_MS`, and in what unit?** The runaway the audit cited (IMPLEMENT at 134 turns)
would hit that deadline regardless. Cheapest correct slice, whichever way it goes: fix the spec's
Budget-cap column, which is factually wrong today.

## Current environment

- Daemon + dashboard **stopped**; bench worker **running** (GATE needs it).
- Nothing in flight; queue empty.
- Four parked/abandoned cards hold product worktrees: 213, 385, 428, 443.
