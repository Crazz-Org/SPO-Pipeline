# Remediation plan — execution state

Companion to `doc/remediation-plan-2026-08.md`, which is the contract and does not change.
This file is what the plan *turned out to be* once executed: what is done, what the plan itself
got wrong, and what the next session needs to proceed safely. Update it at the end of every
chantier.

**State as of 2026-08-31.** `main` = `08a91ad`; C3 sits on `claude-crazz/spo-pipeline-remediation-prod-476444`
(`2114b8c`), unmerged. Suite **892 passing, 0 failing**.

## Progress

| chantier | state |
|---|---|
| **C1** — truthful judges | **DONE**, gate green (live card #462) |
| **C2** — daemon robustness + live harness | **DONE**, gate green (live recette #469) |
| **C3** — token hemorrhage | **DONE**, gate green except the 24h soak (needs the daemon started — maintainer's call) |
| C4–C7 | not started |

Tests: 454 (plan baseline) → 759 (end of C2) → **892** (end of C3).

## C3 commits (one per action, in order)

| action | commit | what it does |
|---|---|---|
| 3.1 | `129b913` | PLAN reuses a still-valid plan on retry instead of re-deriving it |
| 3.2 | `1ffc9ae` | park a plan that *declares* a protected file, before IMPLEMENT is paid for |
| 3.3 | `750d3c3` | cap mechanical triage failures at 3, with exponential backoff |
| 3.4 | `a453efb` | `spo triage --retry <issue> --file` re-injects a held report |
| 3.5 | `7bcd357` | classify a limit from structure, not free text; probe-then-escalate cooldown |
| 3.7 | `2114b8c` | docs only, per maintainer decision — no cap restored |

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

C3 added three more, each caught by measuring rather than reasoning:

- **3.2's specified detector had 33% precision and was unshippable.** The plan says to scan
  `plan_markdown` for `.claude/settings.json` / `.claude/hooks/`. Run over all 17 real plans in
  `journal/*/scratch/`, that scan fires on three: one true positive (#428) and **two false
  positives on cards that are DONE today** — issue-418's plan asserts a hook is *absent*,
  issue-429 *cites* `.claude/settings.json` as evidence. Structural, not unlucky:
  `prompts/plan.md:94` orders a falsification sweep over `.claude/`, and SPO-WebClient's
  `CLAUDE.md` — domain context on every PLAN call — names those paths in its own headings. Prose
  cannot separate "my plan edits this" from "my plan cites this", and the pipeline's own prompt
  demands citations. Resolved by maintainer decision: PLAN now returns `files_to_change` and the
  guard scans that declaration instead.
- **3.5's specified cooldown would have been worse than the bug.** The plan says align the default
  with the 5h Max session window. The pool is **2 accounts**: two usage limits inside one window
  take 100% of it down for five hours, and `daemon.js` has no pool-health gate, so every card
  pulled during that window parks at its first LLM step. The 5h figure also over-waits by
  construction — the window resets 5h after a session's *first message*, not after the limit hit.
  Shipped instead as probe-then-escalate: 1h first, 5h only if a second usage limit lands within
  2h. Overload (529 / `overloaded_error`) is a flat 5min and never escalates.
- **3.7's own premise was false.** See the decision section below.

## Live evidence gathered (feeds later chantiers)

- **3.1 (resume after park)** — measured at ~$14 of tokens on ONE card (#455), re-deriving a plan
  that already existed and was correct. Highest-value action in C3.
- **3.3 (auto-triage cap)** — hit a **12.8-hour** stall (53 cycles, 128 attempts, issues
  449/455/456), longer than the 2.5h incident the plan sized it from.
- **3.4** — its absence made a held report unrecoverable. `spo triage --retry <issue> --file` now
  exists (`a453efb`); it appends one `report-confirmed`, which both re-queues the report and resets
  3.3's failure budget.
- **5.3 (PASS_WITH_FINDINGS)** — observed live on #455: a substantive finding (orphaned
  `cachedZonePath` session state) was journalled and then dropped, exactly as the plan predicts.
- **New, not in the plan (suggest C4)** — a retry's leftover sweep runs `push origin --delete`
  without checking for an **open PR** on the branch, so a retry silently closes a green,
  merge-ready PR and orphans the commits. Observed on #455; `rescue/issue-455-run1` was tagged
  locally to save that work.
- **Untracked spend** — intake steps have no `taskDir`, so `spo tokens` cannot see them at all.
  Not in any chantier; suggest C5.

## The C3 soak's first find: 2.7 broke the retry channel outright

Starting the daemon after merging C3 produced `unpark-scan-failed` for all three parked cards
within a minute — the exact "journal spam" the soak criterion forbids. It was not spam.

`gh api <path>` is a GET, but **any** `-f`/`-F` field flips it to POST unless `--method`/`-X` says
otherwise. Action 2.7's pagination passed `-f per_page=100 -f page=N` to
`repos/<repo>/issues/<n>/comments`, which under POST is the *create an issue comment* endpoint, so
every scan got `422 "body" wasn't supplied`. Reproduced live on issue 213: the `-f` form exits 1;
the same call as a query string exits 0 and returns 4 comments.

Three things worth carrying forward:

- **The `retry`/`abandon` channel did not work at all** between 2.7 merging and the fix. Before 2.7
  the call was a correct one-page GET — the very limitation 2.7 existed to remove. It replaced a
  working one-page scan with a broken zero-page one.
- **It failed closed by accident.** The POST was rejected only because no `body` field was
  supplied; adding one would have had the daemon writing real comments onto live issues.
- **1164 `unpark-scan-failed` events read as transient `gh` flakiness** — a catalogued, dismissed
  symptom — which is why a total outage of the channel went unnoticed. The audit had already
  written those events off as polling noise.

The hermetic suite could not catch it: `runSync` is stubbed everywhere, so a test asserts what argv
a module *builds*, never what `gh` does with it — and three fakes keyed off `-f page=N`, pinning the
broken shape. The standing guard is therefore a source sweep (`test/gh-api-argv.test.js`) that fails
on any `gh api` call site passing `-f`/`-F` without an explicit `--method`/`-X`, `gh api graphql`
exempted. **Any future real-spawn smoke coverage should start here**, since this is the fifth
production bug to pass a green hermetic suite.

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

C3 held to the same pattern; every action needed a fix pass, and three would have shipped a real
regression:

- **3.1** would have handed IMPLEMENT `plan_path: undefined` after a SIGTERM during `buildBaseline`
  (which the post-merge hook really causes), turning a retry that used to work into a park — and a
  missing `invariants_path` makes `runInvariantCheck` return `[]`, so CHECK's invariant test goes
  silently vacuous. Its condition 6 also missed `diagnose-budget-exhausted` /
  `validate-reject-budget-exhausted`, leaving the exact no-progress loop it exists to prevent.
- **3.3** gated the mechanical hold on its comment posting. With `gh` failing, 8 cycles produced 8
  spawns and **zero** holds — the 12.8h incident throttled ~8× and not eliminated. *The hold is the
  mechanism; the comment is the courtesy, and the courtesy must not veto the mechanism.*
- **3.5**'s flat 5h cooldown (see corrections above), plus a test named `exact match only` that
  asserted only positive cases — swapping `Set.has` for `.includes` left all 886 green, though
  "never a substring test" is the load-bearing claim of that whole action.

Two lessons worth carrying into C4. **Measure the specified behaviour against the real corpus
before building it** — 3.2's detector was killed by running it over 17 real plans, not by review.
And **a docs-only action still needs adversarial verification**: 3.7 had no code to mutate, and its
audit still found a confidently-stated counterfactual that the journal flatly contradicts.

## Decision taken — 3.7: no cap, documentation only

The plan asked whether to restore `--max-budget-usd` caps. Maintainer decision, 2026-08-31:
**no mechanical change.** `2114b8c` corrects the documentation and adds nothing.

The reasoning had to be corrected against the journal, and the correction matters more than the
decision. The audit's single measured runaway — IMPLEMENT, 134 turns, $5.06 — did **not** hit the
15-minute deadline. `journal/issue-385/journal.jsonl`: 19:56:12 → 20:09:48, **816s elapsed**,
`terminalReason: "budget_exhausted"`, with `LLM_STEP_DEADLINE_MS` already armed since `3e8104b`
earlier that same day and **~84s of margin left**. The `--max-budget-usd` cap is what stopped it;
the caps were removed the next day in `2621aad`.

The decision stands anyway, for a reason only visible once the premise was fixed: `budget_exhausted`
is produced *by* `--max-budget-usd`, and no production path sets it, so that terminal reason cannot
recur — which also removes the mislabelled-park follow-up the plan attached to this action. The
practical cost of the removed cap is those ~84 seconds.

**If this is ever reopened**, the honest counter-argument is that a deadline bounds *time* while a
cap bounded *work*: 134 thrashing turns produce garbage either way, and the modern unit would be
turns or billable tokens, not dollars.

Two mechanisms the docs named turned out never to have existed at all: `BUDGET_BY_SIZE_USD` and
`task.llmBudgetUsd.<STEP>`. Both are absent repo-wide; only their descriptions survived.

## Current environment

- Daemon + dashboard **stopped**; bench worker **running** (GATE needs it).
- Nothing in flight; queue empty.
- Parked/abandoned cards holding product worktrees: **213** (`diagnose-duplicate-root-cause`),
  **385** (`prompt-missing-placeholder:citations`), **428** (`diagnose-duplicate-root-cause`),
  **443** (abandoned). Three parked + one abandoned — the plan's "four parked" is wrong.
- **C3's outstanding gate element is the unattended 24h soak**, which needs the daemon started.
  Everything else is green: 892/892 replay, `daemon.js --dry-run` drains a synthetic card to DONE
  leaking no worktree, and the park→retry-without-re-PLAN scenario is pinned by
  `test/plan-resume.test.js` (notably the two-real-runs test, which exercises the production writer
  of `baseMainSha` rather than a hand-built journal).
- None of C3 has run against a real card yet. 3.2 changes `prompts/plan.md`, the live LLM contract,
  so the first real PLAN after merge is the one that proves `files_to_change` is emitted; until
  then the guard fails open and journals `plan-files-undeclared`. Grep that event before promoting
  the key to `required`.
