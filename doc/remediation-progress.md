# Remediation plan — execution state

Companion to `doc/remediation-plan-2026-08.md`, which is the contract and does not change.
This file is what the plan *turned out to be* once executed: what is done, what the plan itself
got wrong, and what the next session needs to proceed safely. Update it at the end of every
chantier.

**State as of 2026-09-01.** `main` = `dd5a97d` — **C4 is merged** (PR #66, seven commits), on top
of C3 (PR #63), the comment-scan hotfix (PR #64) and the C3 handoff (PR #65). Suite **1032
passing, 0 failing** (894 at the start of C4). Daemon + dashboard **running** in `--real` on C4
code since 2026-09-01 07:40:02 CEST, verified scanning with the fixed `gh api` argv and
journalling nothing.

## Progress

| chantier | state |
|---|---|
| **C1** — truthful judges | **DONE**, gate green (live card #462) |
| **C2** — daemon robustness + live harness | **DONE**, gate green (live recette #469) |
| **C3** — token hemorrhage | **DONE and merged**; gate green except the 24h soak, which is **running** and has held 9h+ |
| **C4** — correct remediation loops | **DONE and merged** (PR #66) |
| C5–C7 | not started |

Tests: 454 (plan baseline) → 759 (end of C2) → 892 (end of C3) → **1032** (end of C4).

## C3 commits (one per action, in order)

| action | commit | what it does |
|---|---|---|
| 3.1 | `129b913` | PLAN reuses a still-valid plan on retry instead of re-deriving it |
| 3.2 | `1ffc9ae` | park a plan that *declares* a protected file, before IMPLEMENT is paid for |
| 3.3 | `750d3c3` | cap mechanical triage failures at 3, with exponential backoff |
| 3.4 | `a453efb` | `spo triage --retry <issue> --file` re-injects a held report |
| 3.5 | `7bcd357` | classify a limit from structure, not free text; probe-then-escalate cooldown |
| 3.7 | `2114b8c` | docs only, per maintainer decision — no cap restored |

Plus, outside the plan, the hotfix the soak immediately forced: `5a6d69a` (`gh api` `-f` is a POST).

## C4 commits (one per action; 4.6 and the abandon follow-up are not in the plan)

| action | commit | what it does |
|---|---|---|
| 4.1 | `c1139ea` | a main-moved merge commit is no longer read as "nothing to commit" at PUSH_PR |
| 4.5 | `9d18c84` | ABANDONED cleans up after itself (worktree, branches, PR) and is visible everywhere |
| 4.3 | `db413bd` | classify a CI failure on the failing STEP, not the job name; budget the CI-driven IMPLEMENT retry |
| 4.2 | `421e83a` | route a GATE failure on what the bench actually attested |
| 4.6 | `4f68385` | the retry's remote-branch delete no longer destroys an open PR |
| — | `e25e50e` | the same preservation applied to `abandon`, which 4.6's verification caught disagreeing with `retry` |
| 4.4 | `9cf47f2` | bounded auto-retry for a closed allowlist of transient parks |

## C4's corrections to the plan

Five more specified behaviours were wrong, and every one was caught by running it against the
real corpus before building it — none by review. The pattern from C3 held exactly.

- **4.1's condition was wrong.** The plan says `commit exit != 0` + clean tree + `HEAD !=
  origin/main` → skip the commit and push. Measured against issue-213 run 1: it created its PR at
  19:23:03 and parked `commit exit 1` at 19:38:02 with `HEAD != origin/main`, because the branch
  already carried its first-pass commits. That rule would have pushed a no-op and re-gated a
  byte-identical sha, looping DIAGNOSE→IMPLEMENT until the diagnose budget parked it anyway. The
  real discriminator is whether origin already has this tip (`HEAD` vs `origin/<branch>`).
- **4.2's pre-check is answered, and it inverts the action.** The bench DOES write a verdict for a
  failed run — but `SPO-WebClient/src/e2e/bench/worker.ts` assigns `report.baseMain` only AFTER
  `prepareRef`, and `prepareRef` is what detects "does not merge cleanly with origin/main". So
  `baseMain` is absent in *exactly* the case 4.2 exists to catch, and the plan's "derive baseMain
  and intersect the file lists" cannot run there at all. Measured over the 375 real `ref`-type
  gates in `~/.spo-bench/verdicts`: 359/359 PASS carry `baseMain`, 14/16 FAIL do, and the 2 that
  don't are the conflicts. One is `379ada60` — issue-439's own gate, written 1.7s before it
  exited 1, and its DIAGNOSE attempt 2 says so in prose.
- **The intersection test is not needed at GATE at all.** The bench merges `origin/main` itself,
  so a FAIL that carries `baseMain` already failed *with main in the tree*. It is a real failure
  and belongs to a judge.
- **4.3's cause table had never fired, once.** `Coverage of changed lines` / `Lint` / `PR rules`
  are STEP names inside ci.yml's `verify` job; `gh api .../check-runs` only ever returns JOB
  names (`typecheck + tests`, `claude review`, `analyze`, `CodeQL`, `label`, `release`, `orphan
  watch`, `Dependabot`). Every CI failure the pipeline has ever seen fell through to DIAGNOSE.
  Recoverable because **`check_run.id` IS the Actions job id** — verified on six real failed runs,
  which return exactly the names the audit wrote the table against.
- **4.4's allowlist named a park reason that does not exist.**
  `llm-transport-failed:CITATION_VERIFIER` is never thrown; `handleValidate` routes that to
  `citation-verifier-failed` deliberately.

Also measured and deliberately NOT built, because the evidence refused it: an ignore-list for
repo-level CI checks. `Release` and CI's `push` trigger are both `branches: [main]`, so on a
`claude-pipe/<id>` head sha only `pull_request`-triggered runs appear.

## What C4's verification found (the loop is still earning its cost)

Every action had a real defect or a serious coverage gap. Three were again *the fix creating the
bug it was preventing*, and one was a live-world side effect nobody had noticed:

- **The suite was writing to the live product repo.** `finalizePark` in real mode with no injected
  `deps` falls back to the real `spawnSync`, and `ghRepo` defaults to `Crazz-Org/SPO-WebClient`,
  so `postParkComment` ran `gh issue comment` for real — 140 fabricated "Pipeline parked" comments
  on issue #1 in one night, four per full-suite run across every mutation round. `test/helpers.js`
  isolates `spo` SUBPROCESSES; nothing isolated an in-process call. Fixed file-locally in
  `9cf47f2` (that file went from 15.9s to 0.31s — the gap was all network); **the repo-wide guard
  and the second, untraced leaking file are still open.**
- **`spawnStep` is not a plain call**, and two actions in a row shipped the same bug on it: it
  retries a timed-out command once and then THROWS `ParkSignal('<class>-timed-out')`. 4.3's job
  lookup, documented as "never parks", parked the card *before* `check-failed` was written —
  erasing the record of the CI failure that `spo`, the dashboard and the judges all read. 4.2's
  `merge --abort` could unwind past the `main-moved-conflict` park it was cleaning up for.
- **4.5's cleanup inverted its own principle.** It skipped deleting a local branch it could not
  vouch for, then deleted that same branch on the remote two blocks later, PR already closed.
  `sweepWorktreeLeftovers` never had this hole because its rule 2 *throws*, making its own remote
  delete unreachable; `abandonCleanup` deliberately never throws, so the mirror stopped exactly
  where it mattered.
- **4.4's queue write was two steps** — entry first, `transientRetries`/`notBefore` patched on
  second. A death in that window (the post-merge hook SIGTERMs this daemon routinely) restarts the
  card with the budget reset: the unbounded loop the budget exists to prevent. Now one atomic
  write via temp file + rename.
- **Mutation testing again found tests passing for the wrong reason**, at a rate that has not
  fallen: 4/17, 8/24, 14/48, 8/37, 6/10, 4/26. The two most dangerous both looked fine: dropping
  `--head <branch>` from 4.6's `gh pr list` (the lookup then answers with the repo's oldest open
  PR on ANY branch, and that number goes to `gh pr close`), and replacing 4.6's `wip/<id>-<ts>`
  with a constant ref name (a non-fast-forward deadlock no retry can clear).

## Still open after C4

- ~~142 test-generated comments on issue #1~~ — **deleted 2026-09-01**, all 142, on the
  maintainer's decision; the issue is back to 0 comments. Two of them (10:24Z, reason `x`) came
  from a second test file that was never traced, so that evidence is now gone with them.
- **The repo-wide test-isolation guard** for in-process `gh`/`git` spawns (see above). This is the
  one that matters: the file-local killswitch in `9cf47f2` closes one file, not the class.
- **`test/lock.test.js`'s SIGTERM lock-release test is flaky**, ~1 full-suite run in 6–10 under
  load, pre-existing at `a68a0b9`. It matters because a flaky suite silently misreports a
  surviving mutation as killed — which it did once, during 4.6's verification.
- **`spo report` still uses `done + parked`** as its terminal denominator, so it now disagrees
  with the dashboard that 4.5 fixed.
- **`<class>-timed-out` reasons are not on 4.4's allowlist.** Probably they belong there, but each
  timeout-prone call site needs an audit of what half-mutated state it can leave behind first, and
  there is no corpus evidence yet — those reasons are themselves new.
- **`main-moved-twice` is strictly more reachable**: `mainMoveUsed` is now shared between GATE and
  CI_CHECKS, so a GATE-level merge spends the single budget.
- **A card being auto-retried is double-counted** by `spo status` — once in `queue depth`, once as
  active in its last state. A consequence of 4.4's design, not drift.
- `wip/<id>-<ts>` is now built inline in three places. CLAUDE.md's own `gh api -f` story is about
  exactly this shape of duplication.

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
  locally to save that work. **Located precisely during C3's C4 prep**:
  `orchestrator/steps/scripted.js:587`. The asymmetry is the bug — the *local* branch delete
  immediately above it (`:566-573`) does a full ancestry / wip-ref safety analysis and parks
  `branch-unmerged-leftover` rather than destroy unmerged work, while the *remote* delete fires on
  nothing but "the ref exists". Deleting a remote branch on GitHub auto-closes any open PR on it.
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

## The 24h soak — 9h23m held, then deliberately reset

Started **2026-08-31 21:35 CEST**, restarted at **22:07:44** when the C3 handoff merged, and
reset again at **2026-09-01 07:40:02** by the `git pull` that deployed C4. Note it is the *pull*
in the live checkout that fires the post-merge hook, not the merge on GitHub — merging PR #66 left
the daemon untouched at 22:07:44 and still running C3 code until the pull.

**It held 9h23m with all four numbers unchanged**, and the maintainer chose to reset it there
rather than wait out the remaining 14h of an empty-queue scan loop (2026-09-01). C3's soak
criterion is therefore satisfied at 9h23m, not 24h; if a future session wants the full figure it
must start a fresh clock and not merge across it.

Immediately after the C4 restart, all four numbers were still 1179 / 0 / 24 / 135, and the
scanner was observed alive on the new code.

Two things to know before reading a green soak as proof:

- **`NRestarts` is a weak signal here.** systemd only counts *automatic* restarts; the post-merge
  hook's explicit `systemctl restart` never increments it. `journalctl --user -u
  spo-pipeline-daemon` is the honest record.
- **Silence is ambiguous.** A *successful* unpark scan journals nothing, so "no new
  `unpark-scan-failed`" reads identically to a dead scanner. Check positively: sample the daemon's
  children (`ps --ppid $(systemctl --user show spo-pipeline-daemon -p ExecMainPID --value)`) over
  ~90s and you should catch `gh api repos/.../issues/<n>/comments?per_page=100&page=1` — the
  query-string GET, no `-f`. Done on 2026-08-31 at 22:40 for issues 213/385/428.

The numbers that matter:

| signal | value at soak start | pass condition |
|---|---|---|
| `unpark-scan-failed` (across all `journal/*/journal.jsonl`) | **1179** | **stays 1179.** Any growth = the scan is failing again |
| daemon `NRestarts` | 0 | stays 0 — C2's hang-proofing is what makes an unattended soak possible |
| `parked` events | **24** | no new ones without a card actually running. *(This row said 23 at handoff; the live count was already 24 and has stayed there. The newest park event is `2026-08-31T07:16:48Z`, 12.6h before the soak began — the discrepancy was a counting artifact, not a park. Don't chase it.)* |
| `daemon.jsonl` lines | 135 | grows only with real cycle summaries, never spam |

Measured immediately after the hotfix: **+0 spam over 3 minutes of cycles**, against +3/minute
before it. That is the criterion the plan's "absence of journal spam" was asking for.

`spo tokens` still reports `n/a` for every task: all 18 journals predate token capture (shipped
2026-08-31), and **no card ran during the soak** — the queue stayed empty throughout, so C4 has no
token data either. The first real card after this point is the first one with token data at all.

## What C4 hands C5

C5 is "a truthful kanban & observability". C4 added seven journal events and one park reason that
**nothing renders yet** — so the board and the dashboard are now less truthful than before, in a
way C5's own actions are the natural place to fix:

| event / reason | written by | who shows it today |
|---|---|---|
| `transient-retry` | `finalizePark` (4.4) | nobody |
| `ci-implement-retry`, park `ci-retry-budget-exhausted` | `handleCiChecks` (4.3) | nobody |
| `check-failed` now carries `step` + `jobId` | `realCiChecks` (4.3) | the old `check` field only |
| `gate-verdict`, `gate-non-attesting`, `main-moved-conflict` | `realGate` (4.2) | nobody |
| `commit-skipped-nothing-staged` | `realPushPr` (4.1) | nobody |
| `abandon-*` (7 of them) | `abandonCleanup` (4.5) | `spo parked` shows the state, not the cleanup |
| `leftover-remote-preserved`, `leftover-pr-closed` | `sweepWorktreeLeftovers` (4.6) | nobody |

### Measured 2026-09-01, after the first live card — read this before writing 5.1

**The happy path's board moves are proven, and the plan's framing of the gap is wrong.**

Issue #471 entered 11 states and produced **6** `board-move` events:

    WORKTREE -> Planning · IMPLEMENT -> Implementing · CHECK -> Checks & PR
    GATE -> Gate · VALIDATE -> Validation · MERGE -> Merging

That is not five missing moves. The columns are deliberately coarser than the states: "Checks &
PR" covers CHECK+PUSH_PR, "Gate" covers GATE+CI_CHECKS. Two real gaps remain, and they are small:

- **During CI_CHECKS the board says `Gate`.** The gate has finished; CI is what is running. On
  #471 that was 41 seconds, but the in-flight poll is bounded at ~10 minutes.
- **FINISH's move to `Done` is not journalled as a `board-move` event at all.** It happens (the
  board shows Done) via FINISH's own board sync, so the journal cannot tell a maintainer when the
  card reached Done, and any journal-vs-board reconciler that keys on `board-move` will read the
  final transition as missing.

**The three standing divergences are the journal being stale, NOT the board.** Measured:

| issue | last pipeline `board-move` | GitHub issue closed | journal today | board today |
|---|---|---|---|---|
| 213 | 2026-08-29 21:08 → `Parked` | 2026-08-30 01:50 | `PARKED` | `Done` |
| 428 | 2026-08-29 20:52 → `Parked` | 2026-08-30 07:20 | `PARKED` | `Done` |
| 443 | 2026-08-30 13:17 → `Parked` | 2026-08-30 13:18 | `ABANDONED` | `Done` |

In every case the pipeline moved the card to `Parked` correctly, a human then resolved it by hand
outside the pipeline, and **nothing ever reconciled the journal**. So 5.1's premise — "missing
board moves" — describes the wrong half of today's actual divergence. The board is right; the
journal is three days stale. Whatever 5.1 builds, a *reconciler* that notices "the issue this task
owns has been closed while the task sits PARKED" is the thing that would have fixed all three, and
it is not in the plan.

(#443 also raises a column question with no answer today: ABANDONED has no board column, so a
human put it in `Done`.)

Two C4 side effects that are squarely 5.4/5.5's problem, not follow-ups:

- **A card being auto-retried is double-counted** by `spo status` — once in `queue depth`, once as
  active in its last state. It is deliberately not PARKED (4.4), so nothing else names it either. A
  maintainer watching the board during a 5-minute backoff sees a card that looks stuck.
- **`spo report` and the dashboard now disagree** about the parking rate: 4.5 made `collect.js`
  count ABANDONED as terminal, `bin/spo`'s report still uses `done + parked`.

And the standing 5.4 gap the audit never listed: **intake steps have no `taskDir`, so `spo tokens`
cannot see their spend at all.** Any "today's spend" figure 5.4 prints is short by that amount
until intake gets a task directory.

**5.1's and 5.2's surfaces are the ones that leaked to the live repo.** `board.js`'s `moveCard` and
`park-loop.js`'s comment writers are exactly where an in-process test with no injected `deps`
posts to `Crazz-Org/SPO-WebClient` for real — see the 140-comment incident above. Inject `deps` in
every test touching them, and consider closing the class first: it is cheap insurance for a
chantier that spends its whole time in those two files.

## The first live card on C3+C4 code — issue #471, 2026-09-01

A maintainer bug report filed from the WebClient at 07:54 CEST reached a **merged PR at 08:36**,
42 minutes later, on one human word (`confirm`). Zero parks, zero human intervention beyond that
word. This is the first card to run since C3 merged, so it is the first production exercise of
BOTH C3 and C4.

| stage | time | outcome |
|---|---|---|
| remote pull → intake | 07:56 → 08:03 | raw card #471 filed, `report:raw`, `kind: visual` |
| confirm scan | 08:08 | `report-confirmed` |
| auto-triage | 08:18 → 08:21 | reproduced, reviewed **FILE**, labelled `cat:feature` `size:S` |
| PLAN → IMPLEMENT → CHECK | 08:22 → 08:29 | 6/6 invariants held, PR #472 opened |
| GATE → CI_CHECKS | 08:31 | gate exit 0; in-flight poll caught 1 of 5 runs still pending |
| VALIDATE → MERGE → DONE | 08:33 → 08:36 | `PASS`, no findings; merged; board Done; no worktree leaked |

**194,424 billable tokens**, 3 LLM calls (PLAN fable/low 71,505 · IMPLEMENT sonnet/low 72,922 ·
VALIDATE fable/high 49,997). The first card in the project's history with token data at all —
`spo tokens` had read `n/a` across all 18 previous journals. Note the shape: 1.5M cache-read
against 10.0k fresh input, which is exactly why dollars were the wrong headline unit.

### What this proved

- **C3's 3.5 fired, and the C3 correction is what saved it.** REVIEW_CARD hit a usage limit on
  `pool1`: `limitKind: usage`, `cooldownMs: 3600000`, `escalated: false`, `defaulted: false`. The
  1h probe, not the plan's flat 5h — which on a 2-account pool would have taken half the pool down
  until 13:20. It rotated to `pool2` and finished the review **6 seconds later**.
- **C3's 3.3 triage claim ran** (`report-triage-claimed` → in-progress/), the mechanism whose
  absence produced the 12.8-hour, 128-attempt stall.
- **C4's 4.3 fetch extension works**: `checks-green` now carries `id` and `app` per check run, and
  the `app` guard earns itself immediately — `CodeQL` reports as `github-advanced-security`, so its
  `id` is NOT an Actions job id and must never be fed to `actions/jobs/<id>`.
- **C4's cost on the green path is zero**, as designed: no job lookup (nothing red), no verdict
  read at GATE (exit 0), no `commit-skipped-nothing-staged` (real work was staged).
- `ciImplementRetries` reaches state.json; `baseMainSha` recorded at WORKTREE.

### What it found: the protected-files guard fails open on every real card

`files_to_change` **is** emitted — prompts/plan.md's change works. It arrives as a **JSON-encoded
string**, not an array:

    "[\"/home/crazz/SPO-Pipeline/worktrees/issue-471/src/client/styles/design-tokens.css\", ...]"

`handlePlan` checks `Array.isArray(...)`, sees a `string`, journals
`plan-files-undeclared { receivedType: "string" }` and proceeds. So 3.2's guard has never once run
on a real card, and the open question this doc asked the next session to grep is answered: the key
is present, the shape is wrong, and it must NOT be promoted to `required` until that is fixed.

Two further notes for whoever fixes it: the paths are **absolute**, not repo-relative (the scan
still substring-matches `.claude/…`, but verify it), and C3 killed 3.2's original prose detector
for 33% precision — a guard that starts firing must not start firing wrongly.

**Seventh production bug to pass the hermetic suite green.** Every test constructs the payload as
a real array; only the live model serialises it.

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

- Daemon + dashboard **running** since 2026-08-31 22:07:44 CEST (the C3 soak); bench worker
  **running** (GATE needs it).
- Nothing in flight; queue empty.
- Parked/abandoned cards holding product worktrees: **213** (`diagnose-duplicate-root-cause`),
  **385** (`prompt-missing-placeholder:citations`), **428** (`diagnose-duplicate-root-cause`),
  **443** (abandoned). Three parked + one abandoned — the plan's "four parked" is wrong.
- **C3's gate**: replay 894/894 ✅; `daemon.js --dry-run --once` drains a synthetic card to DONE
  leaking no worktree and journalling no spurious `plan-files-undeclared` ✅; the
  park→retry-without-re-PLAN scenario pinned by `test/plan-resume.test.js` ✅ (notably the
  two-real-runs test, which exercises the production writer of `baseMainSha` rather than a
  hand-built journal). The 24h soak is **running** — see § The 24h soak.
- **C4 anchors are spent.** `steps/scripted.js` moved under four of C4's seven commits; re-resolve
  from scratch for C5 rather than trusting any line number written before `9cf47f2`.
- None of C3 has run against a real card yet. 3.2 changes `prompts/plan.md`, the live LLM contract,
  so the first real PLAN after merge is the one that proves `files_to_change` is emitted; until
  then the guard fails open and journals `plan-files-undeclared`. Grep that event before promoting
  the key to `required`.
