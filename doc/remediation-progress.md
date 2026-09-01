# Remediation plan — execution state

Companion to `doc/remediation-plan-2026-08.md`, which is the contract and does not change.
This file is what the plan *turned out to be* once executed: what is done, what the plan itself
got wrong, and what the next session needs to proceed safely. Update it at the end of every
chantier.

**State as of 2026-09-01.** **C5 is done** (seven commits on `claude-crazz/c5-truthful-kanban`),
on top of C4 (PR #66), C3 (PR #63), the comment-scan hotfix (PR #64) and the C3 handoff (PR #65).
Suite **1177 passing, 0 failing** (1032 at the start of C5), and green under UTC, Europe/Paris,
Asia/Kolkata, America/Los_Angeles and Pacific/Kiritimati — C5 was the first chantier to run the
suite outside one timezone, and it found five failures past UTC+13, two of them pre-existing.
Daemon + dashboard **running** in `--real` since 2026-09-01 07:17:38Z.

## Progress

| chantier | state |
|---|---|
| **C1** — truthful judges | **DONE**, gate green (live card #462) |
| **C2** — daemon robustness + live harness | **DONE**, gate green (live recette #469) |
| **C3** — token hemorrhage | **DONE and merged**; gate green except the 24h soak, which is **running** and has held 9h+ |
| **C4** — correct remediation loops | **DONE and merged** (PR #66) |
| **C5** — a truthful kanban & observability | **DONE and merged** (PR #71 + #72); **gate green** — supervised live card #473, 2026-09-01 |
| C6–C7 | not started |

Tests: 454 (plan baseline) → 759 (end of C2) → 892 (end of C3) → 1032 (end of C4) → **1177**
(end of C5).

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

## C5 commits (one per action; 5.0 and 5.1b are not in the plan)

| action | commit | what it does |
|---|---|---|
| — | `b9c300c` | C5's own measurement: the board, the journal and the plan's framing, re-measured |
| 5.0 | `ab282e6` | close the class that posted 140 comments to a live issue (killswitch + source sweep) |
| 5.1 | `526a405` | board moves leave a record, stop repeating themselves, and survive a pre-worktree park |
| 5.1b | `57944ec` | reconcile a parked task against the issue it owns |
| 5.2 | `922ba4f` | tokens, elapsed-minus-parked and attempt history on the card |
| 5.3 | `15dfa59` | the judge findings stop being journalled and lost |
| 5.4 | `900140c` | `spo status` stops naming the wrong thing on every parked card |
| 5.5 | `fb28427` | the dashboard stops overstating what it knows |

## What C5 corrected in the plan, and what it added

**5.1's premise was the wrong half.** The plan calls it "missing board moves". Measured: 14 of 18
tasks' journals stop at `Merging` while the board reads `Done`, because `realFinish` moved the
card without ever journalling a `board-move`. That single absent event, not fifteen missing moves,
is the divergence — and it had to close before any reconciler was buildable.

**The plan's prescribed mechanism for 5.1's pre-worktree move was unnecessary.** It asks for a
direct `gh api graphql updateProjectV2ItemFieldValue` mutation; `board.js` already had a
worktree-free mover (`moveIssueToColumn`) in production use by two callers.

**5.1b is not in the plan at all**, and the measurement demanded it. Three cards diverge; in all
three the journal is the stale side; and one of them (#443) is not a human resolution but a **false
park** — `pr:wait` read `closed false` at 13:17:57 and PR #447 merged at 13:18:27 with no close and
no reopen in its timeline, after which the maintainer abandoned an already-merged change. Nothing
in the system would ever have noticed. Filed as a MERGE defect; the reconciler is what catches it.

**5.3's `DIVERGES` could not be rendered at all** until the `citation-verifier` event was extended:
the contract requires `{verdict, entries}` and the event journalled `{verdict}`. The corpus's one
real DIVERGES is unrecoverable.

**There is no `spo report` subcommand.** The parking rate lives under `spo tokens`. The
disagreement the C4 handoff described was real; the command name was not.

**The intake-spend caveat is worse than C4 stated.** It is not that `spo tokens` cannot see intake
spend for want of a `taskDir` — `journal/daemon.jsonl` holds **zero `llm-call` events of any
kind**, so that spend is journalled nowhere. Any "today's spend" figure is short by an unknown
amount, and `spo status` now says so.

**Two production outages surfaced that nothing was reporting.** The unpark scan — the maintainer's
whole `retry`/`abandon` channel — failed **238 consecutive times over 33 hours** (2026-08-30 10:11
→ 2026-08-31 19:52) in silence; it has since recovered on its own and the cause is unrecoverable
because the event never captured stderr. And `usage-snapshot.json` had been three days stale under
a fresh page timestamp. Both are now visible; the first is also filed.

**The eighth production bug of the JSON-string class.** All 16 `change-validator` events in the
corpus carry `findings` as a JSON-encoded STRING, so `handleValidate`'s REJECT path
(`Array.isArray`) has never once threaded a finding into the next IMPLEMENT — the same shape that
makes C3's protected-files guard fail open. Fixed in passing; the guard itself is still filed.

## What C5's verification found (the loop is still earning its cost)

Every action had a real defect the hermetic suite passed green, and in four cases **the corpus, not
review, is what found it**:

- **A counting rule that matched no journal in existence.** 5.2 counted validate rejects as a
  `result` event under VALIDATE — which action 1.6 does append — and returned **zero for all 19
  tasks**, including the only card ever rejected, whose journal predates 1.6.
- **"0 tokens" and "not recorded" were the same value.** Every failed LLM call journals
  `{tokensSource: null, billableTokens: 0}`, so keying on the number printed `0` on a card that
  burned a transport failure, disagreeing with `spo tokens`'s `n/a` for the same journal.
- **A feature that would not have surfaced the outage it was built for.** 5.4's failing-scan
  counter broke on `unpark-scan-backoff-skip`, and the real journal interleaves
  `failed, skip, …, failed`. It reported the 33-hour, 238-failure outage as "x1 since 19:52:07".
- **A fix with no test that could detect its own reversal on the machine the bug was measured on.**
  5.5's local/UTC boundary test probed 23:30 local; at UTC+2 that is the same UTC date, so
  reverting the fix passed all 1175 tests under both Europe/Paris and a UTC CI. The disagreement is
  on the other side of midnight.

And three unpinned orderings that shipped green when inverted: the DIAGNOSE notice moved after the
diagnosis it announces, FINISH's `board-move` moved after the comment that can park (losing the
record of a card that did reach `Done`), and the `change-validator` verdict moved after the
findings comment. A page-wide `/STALE/` regex also let a full revert of the nightly-tile fix walk
through, because a different line contained the word.

Two tests turned out to prove nothing at all: a "stays pure" test with no filesystem spy (a
defensive `try { read } catch {}` — how anyone would write it in this codebase — survives a
throwing spy, so the spy has to COUNT), and a "never mistaken for a backoff entry" test whose task
had no journal directory and therefore produced no row for any implementation.

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

## C5's own measurement, 2026-09-01 (re-measured from scratch before writing 5.1)

Everything below was measured against the live board, `journal/*/`, and the product repo's API on
2026-09-01, not carried over from the section above. Where it corrects that section, it says so.

### The board is truthful; the journal is stale — and the mechanism is a built-in workflow

Last journalled `board-move` vs the live board, all 18 tasks:

| journal state | last `board-move` | board today | count |
|---|---|---|---|
| `DONE` | `Merging` | `Done` | **14** |
| `PARKED` | `Parked` | `Done` | 2 (213, 428) |
| `ABANDONED` | `Parked` | `Done` | 1 (443) |
| `PARKED` | `Parked` | `Parked` | 1 (385) |

**14 of 18 cards' journals stop at `Merging`.** That is not four divergences plus noise — it is the
FINISH gap dominating everything: `realFinish` moves the card to `Done` with its own `spawnStep`
and never writes a `board-move` event (`orchestrator/steps/scripted.js:1808`). Any reconciler
keying on `board-move` reads 14 of 18 healthy cards as divergent. **Fix this first in 5.1; without
it a reconciler is unbuildable.**

The board's `Done` on 213/428/443 was **not** a human dragging a card. The project has the
built-in **"Item closed"** workflow enabled (`Status → Done`, re-measured live today), so closing
the issue moves the card by itself. That corrects the earlier section's "a human then resolved it
by hand": a human closed the *issue*; GitHub moved the *card*. It also means issue closure is the
same signal the board itself already trusts — a reconciler keying on it is not inventing a source
of truth, it is reading the one the board uses.

Workflows re-measured today: `Pull request linked to issue` is now **false** (the board audit's
one functional FIX has landed), `Item closed` and `Item reopened` remain true. The `Status` field
is clean: 10 options, correct pipeline order, the 3 legacy names gone.

### #443 was not a human resolution at all — it was a false park

| time (2026-08-30) | event |
|---|---|
| 13:15:35 | `gh pr merge 447` → `pr-merge-enqueue exit 0`; `added_to_merge_queue` |
| 13:17:57 | `npm run pr:wait -- 447` exits **1** after 141.5 s → `ParkSignal('pr-closed-unmerged')` |
| 13:17:59 | card moved to `Parked`; 13:18:00 park comment posted |
| 13:18:26 | `removed_from_merge_queue` by `github-merge-queue[bot]` |
| 13:18:27 | **PR #447 merged** (`merged_at` = `closed_at` = 13:18:27Z) |
| 13:53:53 | maintainer replies `abandon` — on a card whose PR had merged 35 minutes earlier |

PR #447's own timeline records **no close and no reopen before 13:18:27**. `scripts/pr-wait.sh`
exits 1 only on a literal `closed false` read, so the pipeline turned one inconsistent API read,
during merge-queue processing, into a terminal verdict — and the park comment then misled the
maintainer into abandoning a merged change. This is a MERGE-step defect (a single unconfirmed read
treated as terminal), **not C5's to fix**, and it is filed. It is listed here because it is the
strongest argument for the reconciler: nothing else in the system would ever have noticed, and the
reconciler would have noticed within one scan interval instead of never.

### What 5.1's other three sub-items are actually worth (measured, not assumed)

- **Pre-worktree park moves: 6 real occurrences**, all `board-move-skipped {reason: "no worktree"}`
  — issue-385 ×5, issue-247 ×1. Never a `board-move-failed` in the whole corpus.
- **Redundant consecutive moves: 12**, across 7 tasks (201, 213, 247, 385, 428, 439, 452) — every
  one an `Implementing → Implementing` repeat on an IMPLEMENT retry. `Implementing` has 42 moves
  against `Planning`'s 29; the difference is exactly this.
- **DIAGNOSE surfacing**: 6 tasks entered DIAGNOSE, 18 attempts total, 4 of them ending in a park.
  DIAGNOSE has no column and no card-visible trace at all today.

### 5.3's corpus is real, and its payload shape has two traps

**7 `PASS_WITH_FINDINGS` verdicts with non-empty findings, and 1 `citation-verifier: DIVERGES`** —
all journalled, none ever surfaced. Two errata for whoever writes 5.3:

- Findings carry **`title` XOR `summary`, never both**: 4 of 9 have `title` (with `detail`), 5 have
  `summary`. A renderer that reads only one key drops half the corpus.
- The `citation-verifier` event journals **`{verdict}` and nothing else**
  (`orchestrator/state-machine.js:931`). There is no record of *what* diverged, so 5.3 cannot
  render a DIVERGES until that event is extended to carry the verifier's payload.

### 5.4: `spo status` names the wrong park reason on every parked card

`bin/spo:277` prints the **last journal event name**, not the park reason:

    issue-213  PARKED  unpark-scan-failed
    issue-385  PARKED  unpark-scan-failed
    issue-428  PARKED  unpark-scan-failed

The real reasons, sitting correctly in each `state.json`, are `diagnose-duplicate-root-cause`,
`prompt-missing-placeholder:citations`, `diagnose-duplicate-root-cause`. The unpark scan appends
`unpark-scan-failed` forever (238 of them on issue-213 alone), so it buries the one field the line
exists to show. 3 of 3 parked cards are misnamed today. `DONE` rows read `done` only by
coincidence — that happens to be the last event's name.

Also confirmed: **there is no `spo report` subcommand.** The parking rate lives in `bin/spo:390`
under `spo cost`/`spo tokens`, and its denominator is `report.parked + ...` computed there, against
`console/collect.js:423`'s three-way terminal (`DONE || PARKED || ABANDONED`). The disagreement is
real; the command name in the C4 handoff is not.

### 5.0: the live-write leak class, measured end to end

The whole suite was re-run under a `spawnSync` probe that logs every in-process real spawn and
blocks `gh`/`npm`/`git push`/`git worktree`. **1032/1032 still pass, and only 5 real spawns escape,
from 2 files:**

    command-timeout.test.js   npm run board:move -- 4321 Gate
    command-timeout.test.js   gh issue comment 4321 --repo x/y --body-file /tmp/ct-park-*/park-comment.md
    real-steps.test.js        npm run board:move -- 504 Validation
    real-steps.test.js        git -C /tmp/spo-judge-gate-missing-wt-*     rev-parse HEAD
    real-steps.test.js        git -C /tmp/spo-judge-validate-missing-wt-* rev-parse HEAD

So the class is real but now tiny, and nothing currently reaches `Crazz-Org/SPO-WebClient` (the
`gh` call targets the fixture repo `x/y`). That the suite passes with all five blocked is the
point: not one of them is load-bearing. Closing the class costs five `deps` injections plus a
shared killswitch, and it is worth doing **before** 5.1/5.2 touch `board.js` and `park-loop.js`.

## Gate C5 — GREEN, closed by supervised live card #473 on 2026-09-01

The fourth half was run and passed. A real bug report ("the docked minimap still slides right for
a left panel that no longer exists") was confirmed by the maintainer and followed transition by
transition, board and journal read against each other at every one.

**Seven `board-move` events. Zero failed. Zero skipped. The board matched the journal at all
seven.**

| time (UTC) | state | board move | board read back |
|---|---|---|---|
| 13:08:18 | WORKTREE | `Planning` | Planning |
| 13:10:33 | IMPLEMENT | `Implementing` | Implementing |
| 13:13:22 | CHECK | `Checks & PR` | Checks & PR |
| 13:14:56 | PUSH_PR | *(none — by design)* | Checks & PR |
| 13:15:03 | GATE | `Gate` | Gate |
| 13:18:03 | CI_CHECKS | *(none — by design)* | Gate |
| 13:18:09 | VALIDATE | `Validation` | Validation |
| 13:19:55 | MERGE | `Merging` | Merging |
| 13:22:52 | FINISH | **`Done`** | Done |

The two silent states are the documented coarsenings, and their silence is a result, not an
omission: a move at either one would have been the regression. `FINISH -> Done` is the event that
did not exist before action 5.1a and whose absence left 14 of 18 journals stopping at `Merging`.

**CONFIRM to merged PR: 25m 03s** (12:57:36 -> 13:22:39). Task journal 14m51s. 3 LLM calls,
**219,229 billable tokens**, 402.6s of model time, all on one account. No worktree leaked.

    PLAN      fable/low    pool2  133.186s   84,603
    IMPLEMENT sonnet/low   pool2  167.078s   75,299
    VALIDATE  fable/high   pool2  102.305s   59,327

**Action 5.3 fired in production for the first time, and its erratum paid for itself immediately.**
VALIDATE returned `PASS_WITH_FINDINGS` with two findings, and the journal recorded
`validate-findings-shape {shape: "json-string", count: 2}` -- the findings arrived JSON-ENCODED,
not as an array, exactly as measured across 100% of the corpus. Had 5.3 tested `Array.isArray`
(as handleValidate's own REJECT path did until this chantier) both would have been dropped
silently. Instead they reached the card as comment `5494576238`, and the first is worth the whole
action: the test IMPLEMENT had just written was **vacuous for 2 of its 3 cases**, because
destroyed mock elements are never removed from `allElements` -- a regression reintroducing
kind-dependent positioning would have passed it.

Also observed live: C3's 3.5 account rotation fired for the second time in production (pool1 hit a
usage limit at 13:07:41, `usageLimitStreak: 2` so the cooldown escalated from the 1h probe to 5h;
triage rotated to pool2 and finished **6 seconds later**), and C3's protected-files guard failed
open for the **third consecutive live card** -- `plan-files-undeclared {receivedType: "string"}`,
with absolute paths, still unfiled at the time of writing.

### The earlier, unattended evidence (superseded, kept for the numbers)

The other three halves: replay suite **1181 passing**, `daemon.js --dry-run` on a synthetic card
reaching `DONE` through the full 11-state path, and the divergence check above. Note the dry-run
cannot evidence the board at all -- `--dry-run` is not real mode, `moveCard` never fires and it
writes no `board-move`. Only a live card can.

`spo recette` was deliberately NOT used: it files a synthetic SPO-WebClient issue, which project
1's auto-add drops into the daemon's own queue, against the standing rule that no remediation work
goes on project 1. A real maintainer-supervised report is the cleaner instrument and exercises
intake/confirm/triage besides -- which #473 did: CONFIRM -> `report-confirmed` in 2m04s, triage
reproducing against the product tree and retitling the card from the reporter's symptom to its
cause.

    board-move: Planning · Implementing · Checks & PR · Gate · Validation · Merging · Done
    duration_s: PLAN 264.052s · IMPLEMENT 262.594s · VALIDATE 90.822s
    final comment: Billable-weighted tokens: 244.7k / Elapsed (first journal event to now): 17m35s

**Seven `board-move` events, including `FINISH -> Done`** -- the event whose absence left 14 of 18
journals stopping at `Merging`. Journal and board agree at every transition, which is the gate's
own wording. Zero `board-move-skipped` (no IMPLEMENT retry occurred, so the dedupe had nothing to
skip -- that half is pinned by tests, not by this card). No worktree leaked. The enriched Done
comment rendered real numbers, no parked line on a clean card, and no attempt rows. `duration_s`
carried the project's first per-step timings.

Better than a recette because it exercised intake, confirm and triage as well -- the stages the
recette skips, and the stages #477 records as journalling no token data at all.

The one thing this card did NOT cover: a card that parks, retries or diverges. Everything above is
the happy path, which is what the gate asks for and all it asks for.

## What C5 hands C6

**All five are filed as backlog cards** (2026-09-01, through `spo ask` with a `review-card`
verdict on each — the same intake every other card gets):

| card | what |
|---|---|
| card | what | where it lives now |
|---|---|---|
| [#475](https://github.com/Crazz-Org/SPO-WebClient/issues/475) | MERGE parks `pr-closed-unmerged` on a single unconfirmed read | **closed, half-fixed** — see below |
| [#476](https://github.com/Crazz-Org/SPO-WebClient/issues/476) | the unpark scan records neither why it failed nor that it recovered | project 2 |
| [#477](https://github.com/Crazz-Org/SPO-WebClient/issues/477) | intake/triage spend is captured and dropped | project 2 |
| [#478](https://github.com/Crazz-Org/SPO-WebClient/issues/478) | `duration_s` is written and never rendered | project 2 |
| [#480](https://github.com/Crazz-Org/SPO-WebClient/issues/480) | two timing-budget flakes in `test/lock.test.js` | project 2 |

**Filing all five onto project 1 was wrong, and it cost a half-fix within the hour.** The daemon
claims from project 1's `Todo` and `orchestrator/config.js` hardcodes `productRepo`/`ghRepo` to
SPO-WebClient, so a pipeline defect filed there gets claimed and fixed only as far as the product
tree reaches. #475 was claimed unattended and merged PR #479, which fixed the product half
(`scripts/pr-wait.sh` — a confirming second read plus 195 lines of tests, genuinely good work) and
left the orchestrator half (`realMerge` in `orchestrator/steps/scripted.js`) untouched. The card
then reached `Done`. A half-fix that closes its own card.

A second org project now exists for exactly this — **"SPO Factory"**, project 2,
`PVT_kwDOEyAVD84BiHMr` — and the rule is: **route by where the FIX lands, not where the symptom
shows.** Fixable in a SPO-WebClient worktree → project 1 (the daemon can do it); fixable in
SPO-Pipeline or SPO-Deploy → project 2. **No remediation-plan work goes on project 1.** Note that
`bin/spo ask` files SPO-WebClient issues and project 1's "Auto-add to project" workflow is still
enabled, so anything the intake produces lands in the daemon's queue by default and has to be
moved off straight away.

Filing them found two things worth keeping. `review-card` caught a citation of "SPO-Pipeline PR
#444" for the heartbeat removal — it is **Crazz-Org/SPO-WebClient PR #444**, and it checked both
repos to say so. And drafting #480 meant reproducing the flake rather than citing it, which turned
up a **second, more frequent one nobody had recorded**: under 4× parallel full-suite load, 14 runs
of `test/lock.test.js` failed `watchLock: fires onLost once…` **4 times** and the known SIGTERM
test **once**. The rarer of the two was the only one the project knew about.

**Still open, in the order they will bite:**

- **A successful unpark scan journals nothing**, so "is the retry channel alive?" is unanswerable
  from the journal — only "when did it last fail". That is why `spo status` renders the AGE of the
  last failure rather than claiming a card is failing now. Do NOT close this with a heartbeat; one
  was deliberately removed (PR #444). Filed.
- **MERGE treats one unconfirmed `closed false` read as terminal** (`realMerge`, both copies). It
  cost #443 a false park and a maintainer a merged change. Filed.
- **C3's protected-files guard still fails open on every real card** — `files_to_change` arrives as
  a JSON-encoded string. `normalizeFindingsPayload` (park-loop.js) is now the repo's parser for
  exactly this shape and 5.3 used it to fix the same bug in handleValidate's REJECT path; the same
  one-line treatment is what `handlePlan` needs. Do NOT promote the key to `required` first.
- **`duration_s` has no reader.** 5.4 writes it on every `llm-call`; nothing renders it yet. The
  first card run on C5 code will be the first with per-step timings — `spo task <id>` and the
  dashboard are the natural surfaces.
- **`test/lock.test.js`'s SIGTERM lock-release flake** is still there, ~1 run in 6–10 under load.
  It did not fire during C5's verification rounds, but it once scored a surviving mutant as killed.

## The follow-up pass, 2026-09-01 — five things C5 itself got wrong

C5 shipped, and the first live cycle on the new code exposed a defect in the observability C5 had
just added. `spo status` went from `238 failure(s), last 14h50m ago` to `no failures recorded` on
issue-213 and issue-428, because action 5.1b's reconciler appended one `reconciled-externally`
line and the failure-streak walk broke on it. **The outage indicator became an all-clear**, on a
channel nothing had proven healthy — the same class as the backoff-skip bug that walk already
carried a comment about, one layer out. Two exceptions in a row is the signal to stop enumerating
what does not end a streak and name what does: it now breaks only on a park cycle ending, or on
positive proof the scan worked.

Four more, from verification notes C5 had accepted at the time and should not have:

- **A nightly that FAILED was downgraded RED → ORANGE** by the very fact that nobody had run it
  since. Staleness qualifies a PASS; it must never soften a RED.
- **The verdicts tile's staleness is removed** — unrequested scope on an unmeasured threshold.
  Measured afterwards against the real 493-file `~/.spo-bench/verdicts`: ordinary weekday gaps run
  up to **15.6h**, so a 36h clock fires on any quiet weekend. The nightly's 36h means something
  because a nightly is scheduled; verdicts are push-driven.
- **The other half of 5.4's double-count**: a backoff entry was still folded into `queue depth`.
- `collectDaemonStats` no longer throws on a non-array.

The lesson is the one C5 already wrote down, arriving one more time: **run it against the real
thing.** Four of the seven actions shipped a wrong derived number the suite passed green, and this
sixth one was caught by the production journal within minutes of deploying.

**Two habits C5 would keep:**

- **Run the suite under more than one timezone.** `TZ=Pacific/Kiritimati node --test test/*.test.js`
  found five failures nobody knew about, two of them older than this chantier, and one in a file
  C5 never touched.
- **Run the built behaviour against `journal/*/` before believing a test.** Four of C5's seven
  actions shipped a wrong derived number that the hermetic suite passed green, and in every case
  the real corpus said so in one command. The suite asserts what argv a module builds; it cannot
  assert that a rule matches any journal that exists.

**Nothing is in flight.** Queue empty, no open PRs from C5's own work, no worktrees left behind.
Merging this needs a `git pull` in `/home/crazz/SPO-Pipeline` to reach the daemon — the merge alone
deploys nothing, and the pull SIGTERMs any in-flight card.
