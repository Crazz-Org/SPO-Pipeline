# Remediation plan — execution state

> **Status: a dated record.** True as of its entry's date; never re-verified against present code.

Companion to `doc/remediation-plan-2026-08.md`, which is the contract. It did not change for
C1-C7. **It was amended once, on 2026-09-02, by the maintainer**: chantier 8 was appended after
C7 to cover the bench's remediation and migration. That is an addition, not a revision — nothing
in C1-C7 was rewritten, and the reason is recorded under "The bench" below.
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
| **C6** — pipelined parallelism (K workers) | **DONE and merged** (PR #73 + #74 + #75); **gate green** — all three parts, closed by a supervised parallel batch of 2 S-sized cards, 2026-09-02 |
| **C7** — truthfulness consolidation & docs | **in progress** — premises re-measured; 7.1/7.2/7.3/7.5 built and verified; gate running |
| **C7 bis** — what Gate C7 certifies | **in progress** — added 2026-09-02 after three Opus passes on the original clause returned 7, ~11 then ~52 divergences, 80% of the last in territory no pass had reached |
| **C8** — the bench: audit, remediation, migration | **not started** — added 2026-09-02. 8.1 (the audit) is the only committed row; it produces its own derived plan, and how many chantiers this really needs is 8.1's answer, not this table's |
| **C9** — the documentation corpus | **not started** — **re-planned 2026-09-02 to run in parallel with C8, from C8b on.** Its deferral rested on C8 rewriting `orchestrator/`; row 8.5 is superseded, so that premise is gone. One documentary dependency survives: C9 must not audit `doc/state-machine-spec.md` or `doc/environments.md` until the C8 actions that rewrite them (8.2, 8.4, 8.6) have landed |

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

**All six are filed as backlog cards** (2026-09-01, through `spo ask` with a `review-card` verdict
on each — the same intake every other card gets):

| card | what | where it lives now |
|---|---|---|
| [#475](https://github.com/Crazz-Org/SPO-WebClient/issues/475) | MERGE parks `pr-closed-unmerged` on a single unconfirmed read | **closed, half-fixed** — see below |
| [#476](https://github.com/Crazz-Org/SPO-WebClient/issues/476) | the unpark scan records neither why it failed nor that it recovered | project 2 |
| [#477](https://github.com/Crazz-Org/SPO-WebClient/issues/477) | intake/triage spend is captured and dropped | project 2 |
| [#478](https://github.com/Crazz-Org/SPO-WebClient/issues/478) | `duration_s` is written and never rendered | project 2 |
| [#480](https://github.com/Crazz-Org/SPO-WebClient/issues/480) | two timing-budget flakes in `test/lock.test.js` | project 2 |
| [#482](https://github.com/Crazz-Org/SPO-WebClient/issues/482) | the protected-files guard (action 3.2) has never once run | project 2 |

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
- **C3's protected-files guard still fails open on every real card** — filed as **#482**, project
  2. Four live occurrences now (#471, #473, #475, and one earlier), `receivedType: "string"` every
  time. `normalizeFindingsPayload` (park-loop.js) is the repo's parser for exactly this shape,
  already imported by state-machine.js, and 5.3 used it to fix the identical bug on the VALIDATE
  wire. Do NOT promote the key to `required` first. **Overlaps project 2's #31** ("PLAN should park
  a card whose plan requires editing `.claude/**`") — #31 is the behaviour 3.2 was meant to deliver
  and #482 is why it does not; close one with the other or they get worked twice.
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

## C6's own measurement — the funnel re-derived, 2026-09-01

C6 is the first chantier whose premise is measurable, because C5 shipped `duration_s` on every
`llm-call` and the corpus now holds two cards that carry it. Measured before building anything,
per the habit C3–C5 established. **The plan's funnel argument is wrong in its inputs, right in its
conclusion, and silent about the two things that actually bound K.**

### The plan's gate figure is correct. Its denominator is not.

The plan says: "at ~2.5 min per gate against **30–45 min of LLM work per card**, K=3 workers target
~3× throughput".

| quantity | plan | measured | source |
|---|---|---|---|
| gate service time | ~2.5 min | **mean 151.3 s** (p50 130.5, p90 212.2, max 239.9) | n=23 real `npm run gate` spawns across 20 journals |
| LLM work per card | 30–45 min | **6.7 min** (#473) / **10.3 min** (#475) | the only two cards with `duration_s` |

So the gate number is right to within a second, and **the model-time denominator is overstated by
3–6×**. Three LLM calls per card, not the dozen the plan's figure implies: PLAN (fable), IMPLEMENT
(sonnet), VALIDATE (fable). DIAGNOSE and CITATION_VERIFIER cost nothing on a green card because
they never run.

### But model time is the wrong denominator too, and re-derived properly the conclusion survives

A serialized resource's utilisation is set by the card's **cycle time**, not by the part of the
cycle that happens to be model work. Full decomposition, from `transition` events (seconds):

| phase | #473 | #475 | what it is |
|---|---|---|---|
| WORKTREE | 16.7 | 20.5 | fetch, `worktree add`, `npm ci` (11.9/14.7), `board:take` |
| PLAN | 133.2 | 264.1 | LLM (fable) |
| IMPLEMENT | 169.4 | 264.8 | LLM (sonnet) |
| CHECK | 95.3 | 91.0 | typecheck 43.9/42.4 + lint 16.9/16.9 + coverage 32.5/31.9 |
| PUSH_PR | 5.8 | 4.9 | commit, push, `gh pr create` |
| **GATE** | **127.0** | **165.9** | **the serialized bench** |
| CI_CHECKS | 60.6 | 0.6 | GitHub check-run polling |
| VALIDATE | 104.0 | 92.8 | LLM (fable) |
| MERGE | 177.4 | 149.3 | `gh pr merge` + **`npm run pr:wait`** (173.5/145.1) |
| FINISH | 4.4 | 4.1 | board move, comment, worktree remove |
| **total** | **893.8 (14.9 min)** | **1058.0 (17.6 min)** | |

Median wall clock over all 13 cards that ran without parking: **20.7 min**.

Bench load per card = mean gate 151.3 s × mean gates/card 1.2 (24 gates / 20 cards) = **181.6 s**,
against a ~976 s card: **18.6 % of a card per worker**, not the 5.5–8 % the plan's ratio implies.

    rho_bench(K=2) = 37 %     rho_bench(K=3) = 56 %

M/D/1 mean queue wait `rho*S/(2(1-rho))`: **+44 s per gate at K=2** (+4.5 % per card), **+96 s at
K=3** (+10 %). So the bench still does not saturate at K=3 — **but with about half the headroom the
plan believed.** The plan reached a sound conclusion through a wrong number: it understated the
gate's share of a card and overstated the card's length, and the two errors pointed the same way
and partly cancelled.

### Three things the funnel does not model, all measured

**1. The bench worker is co-resident on this 8-core box.** `~/.spo-bench/worker.json` → pid 270,
`node dist/e2e/bench/worker.js`, repo `/home/crazz/SPO-WebClient`, port 8080, up since 2026-08-28;
`nproc` = 8. "The bench serializes itself" is true and incomplete: its 123–161 s of work is **local
CPU on the same machine as the K workers**, competing with each card's CHECK (93 s of
typecheck+lint+coverage) and `npm ci`. Action 6.4's mutex covers WORKTREE-setup and
FINISH-teardown only. **Gate service time is therefore not independent of K, and every rho above is
a lower bound.** It already varies without any parallelism: two gates on green code 90 minutes
apart measured 125.0 s and 164.0 s (+31 %).

**2. The nightly is a competing consumer of that same single worker.** `~/.spo-bench/done` (n=8):
`ref` jobs 123/123/124/125/161 s, `nightly` jobs **213/213/232 s** — ~1.7× a gate. A nightly landing
mid-batch is a ~220 s head-of-line block on whichever card gates next. The plan never names it.

**3. A third of a card is pure GitHub I/O wait, and this — not the bench — is the strongest real
argument for K>1.** `npm run pr:wait` alone is 149–177 s (15–20 % of the card); CI_CHECKS adds
0.6–60.6 s. That time holds a worker slot and, today, an account, while consuming zero local CPU
and zero tokens. Counting WORKTREE/PUSH_PR/FINISH with it, **41–55 % of a card is not an LLM call
at all.**

### The binding constraint is the account pool: 2 wide, 1 healthy

`~/.claude-accounts/` holds exactly two accounts, `pool1` and `pool2`. At 13:42:05Z on 2026-09-01
`state.json` read `pool1: {cooldownUntil: 18:06:40Z, usageLimitStreak: 2, lastUsageLimitAt:
13:06:40Z}` — a 5-hour escalated cooldown. `spo status` agrees: `pool1 cooling, 4h22m remaining`.
All nine LLM calls across #471, #473 and #475 ran on `pool2`. That 13:06:40Z limit appears in **no
journal at all** — it fell in an intake step, which is #477's gap; the pool state file is the only
record it happened.

6.2 gates K on healthy accounts. So on this machine **K=3 is not reachable, K=2 is the ceiling, and
K=1 is a routine state rather than an edge case.** Gate C6's "shadow K=3 with one healthy account"
is fine as written (it is shadow); its "supervised parallel batch of 2 S-sized cards" needs two
healthy accounts and must not be requested while pool1 is cooling.

**C6's target should be stated as K=2, with K=3 shadow-tested — not "K=3 targets ~3×".**

### `accounts.pick()` is deterministic first-fit, which is a stronger case for 6.2 than the plan makes

`pick()` returns **the first enabled, non-cooling account in registry order**. No rotation, no
lease, no load awareness. The plan names `markLimit`'s unlocked read-modify-write; that is the
*second* bug. The first is that **two concurrent workers are handed the same account, every time**,
until one of them limits it. A lease is not an optimisation here, it is the only thing standing
between K workers and a self-inflicted usage limit.

### The measurement that inverts 6.2: K=2 on a 2-account pool has zero rotation headroom

This is the finding that changes an action rather than its framing, and it only appears if you
count mid-card account limits in the corpus rather than reasoning about the pool's size.

**Three of twenty cards (15 %) hit a usage limit mid-run and rotated out of it**, journalled as
`account-cooldown`:

| card | step | when |
|---|---|---|
| #201 | PLAN | 2026-08-30 16:37:14Z |
| #385 | PLAN | 2026-08-29 19:49:31Z |
| #385 | PLAN | 2026-08-30 20:00:42Z |
| #455 | VALIDATE | 2026-08-31 08:02:42Z |

Every one on `pool1`. Every one rotated to `pool2` and continued — **`all-accounts-cooling` has
never once been parked, in 20 cards.** #471 is the documented case: limit on `pool1`, rotation to
`pool2`, review finished **6 seconds later**.

That worked because the daemon is single-threaded, so the second account was always idle. **At K=2
on a 2-account pool it is not idle — the sibling worker holds it.** Under 6.2 as written ("the
worker leases the next healthy unleased account, parks `all-accounts-cooling` only when none
exists"), card A limits on `pool1`, finds `pool2` leased by card B, and **parks**. Its plan, its
worktree and its PR are lost until a retry.

So 6.2 as specified converts a **15–20 %-frequency, 6-second, zero-cost event into a park class
that has never fired in the project's history.** That is a regression C6 would introduce, and it is
measured, not modelled.

It also makes the lease granularity a live question rather than a preference. At `K <= healthy
accounts` the two designs are identical *until an account cools*, which is exactly when they
diverge:

| | card A limits mid-run at K=2 |
|---|---|
| **per-task lease** (plan as written) | A parks `all-accounts-cooling`; ~15–20 % of cards |
| **per-step lease + bounded wait** | A waits for B's current step (median LLM step ~2 min), takes the account, continues |

And the load itself changes: two workers on two accounts drive each account at roughly the serial
rate but twice as often overall, so usage limits should be expected **more** frequently at K=2,
not less. The 15 % figure is a floor.

### Accounts are already leased per STEP, and rotating between steps costs no prompt cache

`callLlmStep` (`orchestrator/state-machine.js:97`) calls `accounts.pick()` on **every LLM step**,
not once per task. And a card's three calls run `fable -> sonnet -> fable`, so **there is no
cross-step prompt cache for a rotation to lose**: the 0.4–1.6 M `cacheReadTokens` per call is
intra-call reuse across 10–27 turns (4–8 turns/min), not carried between steps.

This bears directly on 6.2's design. The plan's wording — "the worker leases the next healthy
unleased account" — reads as a **per-task** lease. Per task, a 2-account pool hard-caps K at 2 and
idles the pool for the 41–55 % of each card that is not an LLM call. Per step, K=3 stays viable on
2 accounts, blocking only inside LLM steps. **Measured, per-step leasing costs nothing in cache
terms.** This is a design choice with a measured price and it should be settled before 6.2 is
built, not discovered inside it.

### 6.5's counter: what the corpus says, and what it cannot say

**The corpus contains zero `main-moved` events.** Not one, across all 20 journals. The plan already
says 6.5's default of 2 is "a tunable with no journal evidence"; that is confirmed, and the reason
is structural rather than lucky.

For every card, the number of foreign merges that landed on `origin/main` inside its own window:

| card windows | live cards (window <= 95 min) | parked cards (window 6 h – 2.7 d) |
|---|---|---|
| n | 13 | 7 |
| foreign main merges | **0, in all 13** | 1–22 |

**0 main moves across 341 minutes of live card time.** The nonzero counts all belong to cards
sitting *parked* for days, which is not a card running. The cause is that today the pipeline is the
only writer of main during its own runs — the daemon is single-threaded, so it never merges while
another card is live, and the maintainer's hand-made PRs cluster in maintainer sessions.

**Which means K workers do not merely expose the main-moved path — they create it.** In steady
state each of the other K−1 workers merges once per card cycle, so over one card's own window the
expected number of sibling merges is exactly **K−1**. The plan's default of 2 lands on the right
number *only at K=3*, and by coincidence of the K it chose.

The re-gate-forcing exposure is narrower than the full card — GATE-start to merge, 7.8 min of 14.9
(#473) and 6.8 min of 17.6 (#475), i.e. 39–52 % of the cycle. **And a sibling merge only counts if
it touches a file the card touches**: `realCiChecks` (`orchestrator/steps/scripted.js:1717`)
computes `filesBranch.some(f => filesMain.has(f))` over `baseMain..origin/main` vs
`origin/main...HEAD`. So the counter increments on *intersecting* moves, not on moves.

Measured over the 18 merged pipeline PRs, pairwise: **16 of 153 card pairs (10.5 %) share at least
one file.** The overlap is concentrated in the few large cards — #213 (20 files) appears in 5 of
the 16 pairs, #418 in 5 — while the median card touches 2–4 files and intersects nothing.

Taking sibling merges as Poisson with `lambda = (K-1) x exposure x 0.105` (conservative: real
sibling merges are quasi-periodic, so they cluster *less* than Poisson):

| | K=2 (lambda 0.041–0.055) | K=3 (lambda 0.082–0.109) |
|---|---|---|
| one intersecting sibling merge → re-gate | 4.0–5.3 % of cards | 7.9–10.3 % |
| **two** → park `main-moved-twice` under today's boolean | **0.08–0.15 %** | **0.33–0.56 %** |

**So 6.5's counter does not need raising.** Today's boolean already parks fewer than 1 card in 178
at K=3 and fewer than 1 in 650 at K=2. The plan's default of 2 is defence against an event its own
file-intersection test makes ~10× rarer than a bare merge count suggests. This is a derivation from
a measured cycle decomposition, a measured file-overlap rate and a stated arrival model — **it is
not journal evidence, and none can exist until K>1 has run.** The honest form of 6.5 is therefore:
make the counter configurable (so the number is arguable rather than compiled in), **leave the
default at today's 1**, and write the derivation next to it instead of a confident comment around
a 2. The measured re-gate churn the plan's funnel warns about is ~4–10 % of cards, not "every
FINISH sends K-1 cards back through CHECK→GATE".

### What this changes for C6

- Build for **K=2**, shadow K=3. Do not restate the "~3×" target.
- **6.2 must settle per-step vs per-task leasing** before it is built. Per-step is free in cache
  terms and is the only one of the two that does not turn a 15–20 %-frequency rotation into a
  park. **This is a maintainer decision — it changes what the plan's own sentence says.**
- **6.4's mutex is sized for the wrong contention.** `npm ci` is 12–15 s; CHECK is 93 s and the
  bench's own 123–161 s runs on the same 8 cores. Whether CHECK needs admission control is
  unmeasured and only a real K=2 batch can answer it.
- **6.5's GATE timeout** must cover `K x` gate service *plus* a possible ~220 s nightly ahead of it
  in the queue. This, not the counter, is 6.5's real content.
- **6.5's counter: recommend leaving the default at 1** and making it configurable. See above.
- `duration_s` (#478) is the instrument this whole section had to be hand-derived from. Rendering
  it turns every future funnel question into one command.

### The two decisions C6 put to the maintainer, settled 2026-09-01

- **6.2 lease granularity: per-step lease + bounded wait.** A worker leases an account for one LLM
  step and releases it after; on a mid-run cooldown it waits for a sibling's step to finish rather
  than parking. This is an erratum to the plan's own sentence ("the worker leases the next healthy
  unleased account"), on the measurement above: per-task leasing converts a 15 %-frequency,
  6-second rotation into a park class that has never fired in 20 cards, and per-step leasing costs
  nothing in cache because a card's models are `fable -> sonnet -> fable`.
- **6.5 merge policy: accept explicitly, the nightly is the backstop.** No MERGE admission token
  (measured +42 s/card at K=2 and it does not fix the semantics it would be built for — B still
  merges never having been gated against A), and no widening of the main-moved test from file
  intersection to bare movement. **The counter becomes configurable and its default stays at
  today's 1**, with the derivation written next to it. Revisit only if a nightly catches a
  cross-card regression.


## Before C6's actions: the suite had to be trustworthy first (#480, and two more)

C6's verification loop is mutation testing, and mutation testing is only as good as the suite it
runs — C4 already had one surviving mutant scored as killed by a flake. So #480 was taken first,
and reproducing it rather than citing it found two more failures nobody had recorded, one of them
a real production race.

**Reproduce, don't cite.** 16 parallel full-suite runs in a worktree at `d51041e`:

| failure | rate before | rate after | what it actually was |
|---|---|---|---|
| `watchLock: fires onLost once…` | **4/16** | 0/40 | a fixed 60 ms budget for a condition reachable in ~10 ms; under 4× load the event loop starved and it read `calls.length === 0` |
| `bin/spo dashboard with no --out…` | 1/16 | 0/40 | **not in #480** — the one test whose subject is a repo-global path, so two concurrent suites race: A's `rmSync` lands between B's write and B's `existsSync` |
| `daemon.js: SIGTERM releases the lock` | 2/44 | 0/40 | **not a flake at all** — see below |
| `runAutoTriage: the THIRD mechanical failure…` | 1/40 | still open | **not in #480**, newly seen; not reproducible in 48 isolated runs of its own file + `report-intake`, so it needs full-suite load. Filed rather than chased. |

**A first measurement trap worth recording: the first reproduction run was against the wrong
tree.** `/home/crazz/SPO-Pipeline` is the *live checkout* and it sits at `992b145`, three commits
behind `main`. Run there, a fourth test failed 12/12 — `spo status: a card in action 4.4 backoff…`,
on the hardcoded `notBefore: '2026-09-01T13:00:00.000Z'` this document already warns about. It was
not a flake and not load-related: it is deterministic after 13:00Z, and `c3398a9` had already fixed
it. Only the deployed checkout still carries it. **The live checkout is docs-only behind main, so
nothing needs deploying — but measure in the worktree, not in `/home/crazz/SPO-Pipeline`.**

### The SIGTERM case was never a timing-budget flake — it is a production race

#480 filed it next to the `watchLock` one as a second timing budget. Raising its 5 s startup budget
to 30 s changed nothing; it kept firing at ~2 runs in 44.

`daemon.js` registered its `SIGINT`/`SIGTERM` handlers **after** `acquireLock` linked the lock file
into place. **Until a JS handler for a signal exists, Node applies the OS default disposition** —
SIGTERM terminates the process immediately, mid-statement, running no `exit` hooks at all. So a
SIGTERM landing in the window between `link()` and the handler registration killed the daemon and
left its lock file behind for the next start to stale-sweep. The test kills the daemon the instant
its lock file appears, which is precisely that window: **it was reporting a real defect all along,
and it is the post-merge hook that sends this daemon a SIGTERM on every single deploy.**

The fix is three lines of ordering: register the handlers, and an `exit` hook that releases
whatever `lock` ends up holding, *before* acquiring. Registering a JS handler changes the rule from
"terminate now" to "queue the signal, run the handler at the next event-loop turn", which makes
every synchronous statement after it — `link()` included — uninterruptible. The window does not
shrink; it closes.

**And a probabilistic guard is not a guard.** The SIGTERM test can only catch this by winning the
race (0 in 44 on an idle box), so the ordering is one edit from regressing green. It is now pinned
by a deterministic source-level assertion, the same standing-guard shape as
`test/gh-api-argv.test.js` — and that assertion was itself mutation-tested by reverting the
ordering, which it kills.

Suite: **1182 passing, 0 failing**, green under UTC, Europe/Paris, Pacific/Kiritimati,
America/Los_Angeles and Asia/Kolkata, and 0 failures across 40 parallel full-suite runs.

## C6 commits (one per action, in order)

| action | commit | what it does |
|---|---|---|
| — | `74a5818` | C6's own measurement: the funnel re-derived, and both maintainer decisions |
| — | `1271f1c` | #480, and the production race it turned out to be hiding |
| 6.1 | `8f8c599` | `daemon.js --worker` runs one task, takes no lock, and exits a code |
| 6.2 | `b788463` | per-step account leases; `markLimit` stops losing concurrent cooldowns |
| — | `95b635b` | C6's errata: the dispatcher's scans are not short calls; this box's clock jumps backward |
| 6.3 | `19d8789` | the dispatcher, with the scans moved off its thread into a scanner process |
| 6.4 | `9187f0f` | a product-repo mutex, and the two defects it took to make it work |
| 6.5 | `f8505d6` | a configurable main-moved budget, and the decision to accept the gap |
| 6.6 | `c2919aa` | auto-pull fills to a watermark, and the cold-start deadlock that found |
| — | `a6b2117` | six cross-action defects no single action's verification could see |
| 6.7 | `9b77e03` | worker rows that cannot double-count, and readers for what C6 wrote |
| 6.3 | `19d8789` | the dispatcher, with the scans moved off its thread into a scanner process |
| 6.4 | `9187f0f` | a product-repo mutex, and the two defects it took to make it work |
| 6.5 | `f8505d6` | a configurable main-moved budget, and the decision to accept the gap |
| 6.6 | `c2919aa` | auto-pull fills to a watermark, and the cold-start deadlock that found |
| — | (this branch) | cross-action verification: six findings, five fixed — see below |

### Cross-action verification (after 6.6)

Defects that per-action verification structurally could not see, because each action was correct
in isolation. Verified by measurement, then fixed with a mutation-tested assertion each.

| # | defect | verdict | fix |
|---|---|---|---|
| F1 | `dispatcher.js` `handleExit` never consulted `stopReason`, so the dispatcher's OWN shutdown parked healthy in-flight cards `worker-crashed` — deterministically on every circuit-breaker trip, since `run()` awaits those exits. `finalizePark` writes `state.json` PARKED *before* `postParkComment`, so a SIGKILL between them strands a card outside the retry channel permanently (`findParkAnchor` → null → `unparkScan` skips it forever). | **HELD** (measured) | `handleExit` checks `stopReason` first, like `handleScannerExit` already did; a shutdown-time exit is journalled `worker-exit-during-shutdown` and left to `orphanScan`, the path a deploy-time group SIGTERM already relied on (measured: 10/10 runs leave the card in IMPLEMENT) |
| F2 | Both children spawn `stdio: 'ignore'`, so a worker's uncaught error went to a **discarded** stderr and the dispatcher recorded only `{code: 1}`. Measured: a real `TypeError` left `daemon.jsonl` completely empty. | **HELD** (measured) | the worker journals its own crash (`uncaught-error`, with name/message/stack) before exiting; both fields hard-capped (2000/4000 chars) and flagged `truncated`, because a `JSON.parse` failure over up to 64 MiB of `claude` stdout embeds its input in the message |
| F3 | `takeNextTask` renames the queue file in the **dispatcher**; the worker writes `state.json` only after booting node. Die in that window and `orphanScan`, `unparkScan` and `taskAlreadyExists` all skip the task **forever**. Pre-6.3 the window was one statement in one process; **measured at 71–77 ms, median 74 ms**, on every task. | **HELD** (measured) | `orphanScan` treats "task.json present, state.json absent, not queued, not live-owned, older than the grace window" as an orphan and parks it `task-orphaned-before-start`, aged by the `taken` event's own timestamp |
| F4 | `accountLeaseWaitMs` was the one C6 bound derived from an **observed** maximum (90–265 s → 5 min) instead of from the bound it waits on. A sibling's legitimate hold is 2 × `LLM_STEP_DEADLINE_MS` = 30 min and is un-sweepable until `MAX_LEASE_AGE_MS` = 31.5 min, so a waiter gave up ~26 min early and parked `all-accounts-leased` — the exact park class per-step leasing exists to avoid. | **HELD** | derived: `accountLeaseWaitMs = MAX_LEASE_AGE_MS`. The constant moved to `step-contracts.js` (which requires nothing local) because `account-lease.js` requires `config.js` and the reverse would be a load-time cycle |
| F5 | The circuit breaker sits under `Restart=always`. **Worse than reported**: `StartLimitIntervalSec`/`StartLimitBurst` were in `[Service]`, where systemd **ignores** them — its own log says `Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring`, and `systemctl show` reported the 10 s default, not 300 s. With `RestartSec=5` the burst of 5 was unreachable, so the rate limiter the script's comment promises did not exist and a config error looped forever. | **HELD**, and worse | moved to `[Unit]`; `systemd-analyze verify` A/B warns on the old unit and is silent on the new one. Breaker state deliberately **not** persisted across restarts — see below |
| F6 | K clamped to 0 healthy accounts idled the dispatcher silently, journalling nothing. Pre-C6 the same pool state parked a card naming a `cooldownUntilIso`. | **HELD** | edge-triggered `dispatcher-idle-no-healthy-accounts` / `dispatcher-healthy-accounts-returned`, carrying the earliest cooldown expiry (null = a config error, not a cooldown) and the queue depth |

**F5, the part deliberately not built.** The breaker does not persist across restarts, and should
not on this evidence. With F1 fixed a trip parks at most `workerCrashLimit` (3) cards rather than
4, and with the `[Unit]` fix restarts are genuinely capped at 5 per 300 s — so the worst case is
bounded at ~15 parks and then a stopped unit, which is a loud, correct outcome. Persisting the
count across restarts would add cross-process state whose only job is to make a bounded case
slightly smaller, and would risk a stale counter refusing to start a healthy daemon. Revisit only
if a real trip is ever observed.

**F7, reported not fixed** (verified, one-line notes):
- `state-machine.js`'s `callLlmStep` releases the lease in a `finally` (`:158`) **before**
  `markLimit` (`:165`), so a sibling polling at 1 s can lease the just-limited account and burn a
  call. **HELD**, and it is the shape the file's own header describes as intended — so it is a
  design decision to revisit, not a slip, and changing the order touches the 6.2 lease contract.
- `main-moved-budget.js` does **not** share `orphan-scan.js`'s zero-coercion bug: `:19-22` is a
  documented `Number.isInteger(n) && n > 0` type guard, and `mainMovedRegateBudget` has no env
  override at all (`config.js:253` is a bare literal). **DID NOT HOLD.**
- `product-repo-hold.js`'s "about 52 min ... a 2.4x margin" comment (`:69-75`) contradicts the
  file's own `SPAWN_ATTEMPTS_PER_CALL = 2`: the real worst hold is 116.0 min against a
  `MAX_LOCK_AGE_MS` of 127.6 min, so the margin is **1.1x by construction** (127.6 = 116.0 × 1.1),
  not 2.4x, and the headroom is ~3 extra refs, not ~19. **HELD** — the comment is wrong, the code
  is right.

## What C6 corrected in the plan

**The funnel's denominator was wrong by 3–6×, and the conclusion survived anyway.** See C6's
measurement section above. The gate figure (~2.5 min) is exact; "30–45 min of LLM work per card" is
really 6.7–10.3 min. Re-derived against card *cycle* time the bench takes 18.6 % of a card per
worker, not 5.5–8 %, so K=3 gives ρ=56 % rather than the ~20 % the plan implied — feasible, with
half the headroom it believed. **K=3 is unreachable regardless**: the pool is two accounts.

**6.2's lease granularity inverts the plan's own sentence, on maintainer decision.** Per-task
leasing would convert a measured 15 %-frequency, 6-second mid-run rotation into a park class that
has never once fired. Per-step costs nothing (`fable -> sonnet -> fable`, no cross-step cache).

**The plan names one rotation loop; there are two.** `intake.js` has its own, and under C6 it runs
dispatcher-side — so the dispatcher competes with workers for the same two accounts.

**6.5's counter does not need raising, and the plan's default of 2 is right only at the K it
happened to pick.** The main-moved test is a file intersection (`realCiChecks`), 10.5 % of merged
card pairs share a file, and expected sibling merges per card window is K−1. Derived park rate
under today's boolean: 0.08–0.15 % at K=2. Full derivation above.

### Erratum, and it is the largest one C6 found: the dispatcher's "short calls" are not short

The plan's 6.3 row says the dispatcher's "own short calls (auto-pull, scans) stay spawnSync". The
scans include `runAutoTriage` → `intake.triageBugReport`/`reviewCard` → `llm.js`'s **blocking**
`spawnSync('claude', …)`. Measured on the live daemon's own journal, today:

| card | `report-triage-claimed` → `auto-triage` |
|---|---|
| #471 | **3 m 24.9 s** |
| #473 | **3 m 11.5 s** |

And the consequence, A/B'd against the real dispatcher with real worker children and an identical
3000 ms scan, sync versus async the only difference:

| scan | worker reaping lag | 100 ms timer ticks in ~9 s |
|---|---|---|
| blocking `spawnSync` | **2608 ms** | **1** |
| awaited | 7 ms | 58 |

So for three minutes at a time the dispatcher cannot reap an exit, refill a freed slot, service a
timer, or honour SIGTERM — and systemd's `TimeoutStopUSec` is 1 min 30 s, so a deploy SIGKILLs it
and `killAllWorkers` never runs. **A dispatcher built to the plan's premise serializes on intake
and delivers no parallelism at all.** The hermetic suite cannot see it: every dispatcher test sets
`real: false`, so the scan cycle returns at its first line.

The obvious fix — a per-cycle scan child — is wrong, and worth recording as a trap: `comment-scan.js`'s
scan state is documented as needing to survive across cycles ("a cache that resets every cycle is
not a cache; a backoff that resets every cycle never backs off"), so a fresh child per cycle
destroys the collaborator cache and action 2.7's per-issue backoff every cycle. Resolved instead
with a **long-lived scanner sibling process** supervised by the dispatcher — which is also what
`runForever` becomes, rather than the dead code 6.3's first cut left it as.

### This machine's wall clock jumps backward, and it corrupts mutation verdicts

Measured independently, twice: `Date.now()` moved **−2515 ms across a single 10 ms monotonic
interval**, once in 2331 samples over 25 s. A WSL2 clock-sync artifact.

Consequences worth carrying forward:

- Every bounded wait loop keyed on `Date.now()` deltas can over-wait by ~2.5 s. That is what makes
  `test/accounts.test.js`'s state-lock test fail ~1 run in 12.
- **A flaky suite silently misreports a surviving mutation as killed** — it already did so once in
  C4, and it did so again here (a mutation appeared killed by an unrelated concurrency test).
  Screen every mutation round for it.
- The fix is monotonic (`process.hrtime.bigint()`) for measuring *elapsed durations* only.
  Timestamps written to disk or compared across processes — lease `startedAt`, `cooldownUntil`,
  `notBefore`, the orphan grace window — must stay wall-clock, because a monotonic clock is
  meaningless across processes and reboots.

### What verification cost and bought, per action

The loop is still earning its cost, and in every action the survivor that mattered was **the
action's own central claim**:

- **6.1** — 6/25 survived. `config.queueDir` deleted passed all 1194 tests; losing it silently
  disables action 4.4's auto-retry under workers, and the worker exits `20` either way so nothing
  reports it. Two more were coincidental equality: every fixture had `id === basename(taskDir)`, so
  BOTH id-derivation branches survived being forced.
- **6.2** — 4/25 survived. Moving the lease release to before the `claude` spawn passed all 1223
  tests and then made two real OS processes hand the same `CLAUDE_CONFIG_DIR` to `claude`, 3 runs
  of 3. The tests only asserted the lease was gone *afterwards*, which "acquire and immediately
  drop" satisfies equally.
- **6.3** — 9/22 survived (7 non-equivalent). The worst: **forcing the worker's mode flag to
  `--shadow` passed all 1249 tests** — a live `--real` daemon would spawn shadow workers and every
  card would report DONE having touched nothing. Second: dropping `--queue`/`--journal` from the
  worker argv passed too, and the mutation run proved it by writing a stray `journal/` and `queue/`
  into the worktree. Both are the same shape as 6.2's: the action's boundary — what argv the child
  actually receives — was untested in every direction.


## Gate C6 — two of three parts green, measured 2026-09-02

The plan asks for three things. Two are machine-checkable and were run; the third needs the
maintainer.

### Part 1 — the dispatcher itself, `--dry-run`, K=3, ONE journal root, 3 synthetic cards

Criteria: a single lock, 3 worker exits, zero cross-task writes. **All met.**

| | |
|---|---|
| card outcomes | `gate-card-1/2/3` all **DONE** |
| worker pids | **3 distinct** (1125520, 1125526, 1125528) |
| `worker-spawn` / `worker-exit` | **3 / 3**, every one `code: 0`, `outcome: done` |
| lock files, sampled 354 times during the run | **max 1 at any instant** |
| cross-task writes | **0** |

The spawn/exit timeline is the part worth keeping: spawns at `00:05:22.940 / .944 / .948`, first exit
at `00:05:23.039`. **All three workers were spawned before any of them exited**, so this is real
concurrency rather than a serial drain that happens to produce three exits.

### Part 2 — K=3 against ONE healthy account

The plan says "shadow K=3". **Erratum: shadow mode cannot exercise this at all.** `callLlmStep`
short-circuits on `ctx.shadowMode` before `accounts.pick()` is ever reached, so a shadow run leases
nothing. `--dry-run` is the mode that runs account rotation and leasing for real while stopping
short of the spawn — `test/helpers.js`'s own `isolatedEnv` comment already says so. Run in
`--dry-run`.

A first, uncontended run passed (3 cards through 1 account, no parks, no leaked lease files) but
proved little: dry-run LLM steps are sub-millisecond, so a 4 ms poll caught the lease **once** in
the whole run — the workers may simply never have contended.

So contention was **forced**: an outside live process held the only account's lease for 9 s across
the whole run, in two arms differing only in the wait bound.

| arm | lease wait bound | outcome | progressed while the lease was held |
|---|---|---|---|
| short | 3 s (< the 9 s hold) | cards 1 and 2 **PARKED `all-accounts-leased`**; card 3 DONE (spawned after the hold expired) | **none** |
| long | 60 s (> the 9 s hold) | all three **waited, then DONE** | **none** |

**Both permitted behaviours observed — wait, and park — and sharing observed in neither.** That is
the criterion exactly: "excess workers wait or park, never share an account". The decisive column is
the last one: no card got past an LLM step while another process held the account.

### Part 3 — a supervised parallel batch of 2 S-sized cards: GREEN, 2026-09-02

Run on C6 deployed to production, K=2, both accounts healthy, auto-pull disabled so the batch was
the two cards chosen rather than whatever was topmost on the board. Cards **#485** and **#487**,
both `size:S`, fed by hand.

| | |
|---|---|
| outcome | both **DONE**; **PR #628** merged 04:22:36Z, **PR #629** merged 04:33:53Z |
| max concurrent workers | **2**, sustained ~15 min |
| accounts | `#485 -> pool1 -> pool2`, `#487 -> pool2 -> pool1` — **never the same account at the same time** |
| board moves | #485 **7**, ending `Done`; #487 **11**, including three `Implementing -> Checks & PR` returns |
| divergence | **zero** — board `Done`, journal `DONE`, for both |
| cleanup | both product worktrees reaped; worktree count back to its pre-batch value |
| cooldowns incurred | none; both accounts still `cooldown=none` afterwards |

The transition timeline is the evidence that this was genuine parallelism rather than a fast serial
drain:

    t=2s    both WORKTREE          <- the product-repo mutex (6.4) serialising setup
    t=19s   485 PLAN, 487 WORKTREE
    t=35s   both PLAN
    t=136s  485 IMPLEMENT, 487 PLAN
    t=448s  485 GATE, 487 IMPLEMENT
    t=923s  485 DONE, 487 DIAGNOSE  <- live-workers.json correctly drops to 1
    t=1609s both DONE

Three C6 mechanisms are visible in it. At t=2 both cards sit in WORKTREE and only one leaves at
t=19 — **6.4's mutex serialising the shared clone** while everything else overlaps. The account
column shows **6.2's per-step leases** handing the two workers different accounts and then rotating
them, never colliding. And at t=923 the live-worker table drops from 2 to 1 the moment #485
finishes — **6.3/6.6's publish-on-exit**, the mechanism whose absence at startup was 6.6's fatal
deadlock.

**#487 is the more valuable half of this gate.** It failed CHECK and went round the
DIAGNOSE → IMPLEMENT → CHECK loop three times before passing, while #485 ran to completion beside
it. So the batch exercised the remediation loop *under* parallelism, not just a clean happy path
twice — and the two cards' board moves stayed correctly interleaved and attributed throughout.

### What it cost to get here, recorded because it was avoidable

Setting the batch up, `spo pull --help` was used to check the flag. `--help` is not recognised by
that subcommand, so it **ran a real pull**, queued five of the maintainer's cards, and the
dispatcher took #484 to PLAN before it was stopped. Restored: queue cleared, product worktree
removed via `worktree remove --force` + `prune`, local branch deleted (nothing had been pushed, no
PR), the journal directory moved aside rather than destroyed, and the board card returned to
`Todo`. The `prune` also cleared two pre-existing stale worktree registrations, which is the
manoeuvre CLAUDE.md prescribes but did change the count beyond a pure restore. The three parked
cards' worktrees were explicitly checked and intact.

The lesson worth keeping: **on this CLI, probe a write-capable subcommand by reading `bin/spo`'s
usage line, never by passing it `--help`.**

## What C6 hands C7

C7 is "truthfulness consolidation & docs": 7.1 replay holes, 7.2 a `spo recette` scenario library,
7.3 concurrency tests, 7.4 (already done), 7.5 a final doc sweep. **Three of those rows were
written against a daemon that no longer exists**, and one of them is now largely delivered. Read
this before planning them.

### 7.3's first premise is gone, and most of that row is already built

The row asks for "runForever timers under a long drain". **`runForever` no longer drains anything.**
C6 moved it into a separate `daemon.js --scanner` process that runs timers only; the dispatcher
drains. So "timers under a long drain" is no longer a scenario the code can be in.

The defect that row was reaching for is real, was measured, and is fixed: the scans reach intake's
**blocking** `spawnSync('claude')`, measured at 3 m 24.9 s and 3 m 11.5 s on the live daemon, and
A/B'd at **reaping lag 9182 ms → 6 ms** and **3 of 90 → 88 of 90 timer ticks**. What C7 can still
add is a *test* that the dispatcher's loop stays responsive while a scan blocks — `test/dispatcher.test.js`
has one, pinned by injecting a blocking sleep into `run()`'s loop, so check what it already covers
before writing more.

"Double daemon" now means two different things and both have coverage: two dispatchers (refused by
the single-instance lock) and two scanners (the orphan case — a `detached` scanner survives its
dispatcher; closed with `--parent-pid`, and the leak was reproduced before being fixed).

"daemon + CLI concurrently" is the live one. The taskDir single-writer invariant is now written
down in `orchestrator/journal.js`, and C6 **added writers**: the dispatcher's crash-repark, and the
scanner's `orphanScan`/`unparkScan`/reconciler in a different process from the workers. That seam
is wider than it was when the row was written.

### 7.2's harness exercises a path production no longer takes

`spo recette` calls `drainQueueOnce`. That function still exists and is still correct, but **the
daemon no longer uses it** — the dispatcher does. So a recette scenario today validates a code path
production does not run. Before extending the harness with K>1 scenarios, decide whether recette
should drive the *dispatcher* instead; a K>1 scenario built on `drainQueueOnce` cannot exercise
parallelism at all, because that function is serial by construction.

Also still true and still a trap: **`spo recette` files a synthetic SPO-WebClient issue**, and
project 1's auto-add drops it into the daemon's own queue. C5's gate deliberately avoided it for
that reason.

### The surfaces C6 added, none of which existed when 7.1 was written

`orchestrator/dispatcher.js`, `account-lease.js`, `product-repo-lock.js`, `product-repo-hold.js`,
`worker-status.js`, `main-moved-budget.js`, `bench-queue-wait.js`, `monotonic-clock.js`, plus
`daemon.js`'s `--worker`/`--scanner` modes and `journal.js`'s live-worker helpers. 7.1's list of
replay holes predates all of it.

### Six things that will bite C7 specifically

- **The suite has no per-test timeout.** Several mutations "pass" by hanging for 100–150 s. Run
  `node --test --test-timeout=30000 test/*.test.js`. Never bare — bare walks into parked cards'
  product worktrees and reports ~1168 foreign failures.
- **Run a NEGATIVE timezone offset.** `TZ=Pacific/Niue` (UTC−11) found a real pre-existing failure
  at HEAD that UTC and UTC+14 had both missed — a fixture assuming two instants five hours apart
  share a local day, which no pair can across a 26-hour offset range.
- **This box's `Date.now()` jumps backward** — measured −2515 ms across a 10 ms monotonic interval,
  twice, independently. Bounded wait loops must use `process.hrtime.bigint()`; anything written to
  disk or compared across processes stays wall-clock. **A flaky suite silently misreports a
  surviving mutation as killed** — it did so in C4 and again in C6.
- **Tests that spawn real children must pass `--parent-pid`** or an interrupted run leaks detached
  processes. C6 accumulated 33 orphaned scanners this way before fixing it.
- **`git checkout -- <file>` is not a mutation-testing restore.** It reverts to HEAD, not to the
  working copy, and it silently wiped a real feature addition mid-round. Copy to `/tmp` and back.
  `git stash` is forbidden outright — the stack is shared across worktrees and live sessions.
- **`spo pull --help` is not a help flag.** That subcommand ignores it and runs a real pull. It
  queued five live cards and took one to PLAN. Read `bin/spo`'s usage line instead.

### Open, in the order they will bite

- **#483 — the cooldown model is wrong in two directions at once, and it is the live risk.**
  `markLimit` cools the whole ACCOUNT for 1 h/5 h, all three constants shaped around the 5-hour
  session window. Anthropic's quotas are **per model**, and one window is **7 days**. A card runs
  `fable → sonnet → fable`, so a Fable exhaustion kills every card at PLAN on an account whose
  Sonnet quota is fine — too broad — while a 5 h cooldown against a 7-day quota retries into a wall
  ~34 times a week — too short. And the cooldown is **never reconciled with the server**: `pick()`
  compares a locally-invented `cooldownUntil` to the wall clock and nothing re-checks. `pool1` hit
  its limit **twice on 2026-09-02** and the maintainer had to clear the entry by hand both times
  for K=2 to be reachable. **C6's K ≤ healthy-accounts clamp rests directly on this being right.**
- **`runAutoTriage`'s third-mechanical-failure test fails ~1 run in 40** under full-suite load and
  is not reproducible in 48 isolated runs of its own file. Needs full-suite load; unfiled.
- **`callLlmStep` releases the account lease before `markLimit` cools it**, so a sibling polling at
  1 s can lease the just-limited account and burn one call. Reported and deliberately not changed —
  it is the order `account-lease.js`'s own header describes as intended, so it is a 6.2 contract
  decision for the maintainer, not a slip.
- **The C6 circuit breaker's persistence question.** `workerCrashLimit` is per-restart. With the
  systemd rate limiter fixed (it was in `[Service]`, where systemd **ignores** it — its own journal
  says so) the worst case is bounded, so cross-restart persistence was deliberately not built.
- Still open on project 2: **#476**, **#477**, **#482** (overlaps **#31**), **#43**, **#31**, and
  the unowned half of **#475**.

### Operational state as C6 closes

- `main` = the C6 merge plus this handoff. Suite **1382 passing, 0 failing** under UTC,
  `Pacific/Niue` and `Pacific/Kiritimati`.
- The daemon runs **two processes**: a dispatcher (holds the lock) and a scanner child carrying
  `--parent-pid`, `--workers` and explicit `--queue`/`--journal`. `spo status` renders a `workers:`
  line and per-row worker detail.
- **Two systemd drop-ins were added and both are load-bearing.** `auto-pull-off.conf`
  (`SPO_AUTO_PULL_MS=0`) exists because another session filed ~140 cards into project 1's Todo and
  the daemon claims from exactly there; **removing it re-arms claiming on the next restart.**
  `workers.conf` (`SPO_WORKERS=2`) sets K for the gate. `config.js`'s own default is **K=1**, so
  parallelism is opt-in and deleting that drop-in is the safe rollback.
- **Deploying still restarts the daemon by itself** — the `git pull` fires the post-merge hook, not
  the merge. Check for in-flight tasks first; a docs-only merge needs no pull.

---

## C7 — its own measurement, before any of it was built

C6's handoff said three of C7's four remaining rows were written against a daemon that no longer
exists. That was right, and measuring found more: **two of 7.1's five named holes are already
closed**, 7.2's blocker is not the one the handoff named, and 7.3 has a genuinely flaky test in
the file that was supposed to close it.

### Baseline

`node --test --test-timeout=30000 test/*.test.js` at `f7cf9da`: **1382 passing, 0 failing**, twice
in a row. Wall clock ~17 s.

**`--experimental-test-coverage` is not usable on the whole suite**, two ways:

- The aggregated report is discarded — `Warning: Could not report code coverage. SyntaxError:
  Unexpected end of JSON input`. A test that kills a child process truncates that child's V8
  coverage file, and one truncated file kills the entire report. Excluding
  `dispatcher.test.js`, `worker-mode.test.js` and `journal-concurrent-append.test.js` brings the
  report back.
- Under coverage, `dispatcher.test.js:161` ("K=1: a task runs to DONE through a real spawned
  worker") **fails**: `exitEvt.code` is `null`, not `0`. See the flake below — coverage did not
  cause it, it exposed it.

So the coverage measurement below is the **intersection** of two runs (everything-but-those-three,
and those-three-alone): a line is reported as a hole only when *neither* run covered it.

### 7.1 — the hole list is two-fifths stale, and coverage is far higher than when it was written

Measured, all files, intersection of both runs: **97.53 % lines, 90.97 % branch, 96.43 % funcs.**

Of the five holes 7.1 names, **two are already closed**:

- **the `oauthTokenFile` branch** — `llm.js:376-383` (env injection *and* the unreadable-file
  error leg) is covered. The row was written when only `accounts.js`'s discovery was tested.
- **park-reason assertions in the account-rotation test** — `test/account-rotation.test.js` now
  asserts `caught.reason` on `all-accounts-cooling-after-retry`, `all-accounts-cooling-until-*`,
  `no-accounts-registered` and `all-accounts-leased`. Nothing left to add.

What is genuinely still uncovered:

| file | lines | what it is |
|---|---|---|
| `state-machine.js` | 181-182 | `invalid-task-json` — 7.1's own named catch-all |
| | 228-229 | `main-red-refuse-worktree` (the `nightlyMainRed` fixture at WORKTREE) |
| | 250 | `worktree-failed` shadow exit — 7.1's "worktree" |
| | 597 | `parseFilesChanged` on unparsable JSON |
| | 699 | `push-pr-failed` shadow exit — 7.1's "pushPr" |
| | 715 | `gate-unrecognized-exit` |
| | 772-773 | `main-red-no-merge` |
| | 828-831 | `diagnose-budget-exhausted` (marked defensive/unreachable in its own comment) |
| | 1160 | `pr-wait-unrecognized-exit` — 7.1's "prWait 1" |
| | 1172 | `finish-failed` — 7.1's "finish" |
| | 1433-1434 | the `park-repeat` event at repeat ≥ 2 |
| | 1497-1499 | `state-machine-runaway` — 7.1's own named catch-all |
| | 1747-1749 | `runScanCycle`'s `runAutoTriage` timer leg |
| | 1828 | `runForever`'s loop tail |
| `scripted.js` | 72-79 | the "no real command configured" throw |
| | 784-807 | **`preserveWorktreeWip`'s four error legs** (status/detach/add/commit → `wip-preserve-failed`) |
| | 1617-1618 | check-runs JSON unparsable → `null` — 7.1's "check-runs" |
| | 1842 | `pr-wait-unrecognized-exit` |
| `llm.js` | 354-357 | `limitKindForFailure`'s classification branches |
| | 599, 603-605 | the CITATION_VERIFIER / VALIDATE / default dry-run stubs |
| `account-lease.js` | 123-124 | the unreadable/torn lease-file catch |
| `orphan-scan.js` | 90-97 | the mtime fallback when the journal is unreadable |
| `journal.js` | 196-202 | the atomic-write rollback (unlink the tmp, rethrow) |

`preserveWorktreeWip`'s error legs are the notable one: it is a **C6 feature**, so 7.1's list
could not have named it. `product-repo-lock.js`, `product-repo-hold.js`, `worker-status.js`,
`main-moved-budget.js`, `bench-queue-wait.js` and `monotonic-clock.js` — the rest of what C6 added
— are fully covered.

### 7.2 — the blocker is the cap, not the drain

The handoff is right that `spo recette` drives `drainQueueOnce` and that production drives the
dispatcher. But the reason that is hard to change is one level down: **the cap is a `deps.spawnSync`
wrapper** (`makeCap`), counting `claude` invocations and enforcing wall clock *inside the same
process as the pipeline*. `drainQueueOnce` runs `runTask` in-process, so the wrapper sees every
spawn. A dispatcher runs its workers as **separate processes** — `createDispatcher` injects
`config.deps.spawn` (the child spawn), never the worker's own `spawnSync` — so the existing cap
cannot survive the move at all.

A dispatcher-driven scenario therefore needs an **out-of-process cap**: a wall-clock watchdog
calling `stop()` + `killAllChildren()`, and an LLM-step count read from the workers' journals
(`llm.js` appends an `llm-call` event per call to the taskDir, so the count is available to a
poller). That is the design decision 7.2 has to make before any scenario is written; it is not a
matter of swapping one function for another.

Also measured: `SCENARIOS` still holds exactly **one** entry, `trivial-doc-log`. Gate C7's "all
scenarios" is, today, one scenario.

### 7.3 — most of it exists, and the file that holds it has a real flake

`test/dispatcher.test.js` (42 tests) already covers, under names of its own:

- **double daemon** → "a second instance against the same journal root is refused"; plus the two
  scanner cases (`--parent-pid` mismatch exits; exactly one scanner at startup).
- **timers under a drain** → the row's own premise is gone, but its intent is covered twice: "a
  periodic scan runs in the scanner process while a worker is still alive" and "a BLOCKING scan in
  the scanner process does not stall the dispatcher".

**New finding — `test/dispatcher.test.js:161` is racy.** It waits for `state.json` to read `DONE`,
then calls `dispatcher.stop()`; `run()` kills the children on its way out. The worker writes
`state.json` *before* it exits, so a worker that has not yet reached exit is SIGTERMed — and the
journalled `worker-exit` carries `code: null`, not `0`. Asserting `exitEvt.code === 0` therefore
depends on winning a race the test does nothing to arbitrate. It passes 3/3 in isolation and
failed under whole-suite coverage load; the trap list's own warning that "a flaky suite silently
misreports a surviving mutation as killed" applies directly to the file C7 is meant to extend.

**daemon + CLI concurrently** is the part with no coverage, and it is wider than the `#443` seam
the row cites (that one, the triage `pending/` → `in-progress/` rename, was closed by 2.6): C6 put
the dispatcher's crash-repark and the scanner's `orphanScan`/`unparkScan`/reconciler in *different
processes* from the workers, all reaching for the same taskDir.

### 7.5 — the spec no longer describes the daemon it specifies

Vocabulary count over the whole of `doc/state-machine-spec.md` (416 lines):

| term | occurrences |
|---|---|
| `scanner` | **0** |
| `lease` | **0** |
| `live-workers` | **0** |
| `bench-queue` | **0** |
| `K workers` | **0** |
| `dispatcher` | **1** |
| `worker` | 3 |

C6 amended exactly one row (CI_CHECKS, in `f8505d6`) and added a decision record. The two-process
model, the account lease, the product-repo mutex and the live-worker table — the whole of what C6
shipped — are absent. Gate C7's "zero uncommented divergences" is an authoring job, not a re-read.

Of the plan's five named 7.5 items, one is confirmed live and precise: **`prompts/verify-citations.md`
says twice that the step holds `Read, Grep, Bash`; `step-contracts.js` grants `['Read', 'Grep']`**
and flags the disagreement in a `DIVERGENCE` comment rather than resolving it.

## C7 commits (one per action; the breaker fix, clear-cooldown and the cross-action pass are not in the plan)

| action | commit | what it does |
|---|---|---|
| — | `92ec755` | C7's own measurement: every row re-derived before anything was built |
| 7.1 | `b27fe32` | the replay holes that are *still* holes, closed (34 tests) |
| 7.3 | `c8ba6ad` | the concurrency tests, minus the race in the file that held them |
| — | `0d51d3d` | `consecutiveScannerCrashes` was neither consecutive nor reset |
| 7.2 | `c0e4bbb` | a recette scenario library, and the process boundary it exposed |
| — | `eff1928` | `spo account clear-cooldown`, after a live incident |
| 7.5 | `2a840be` | the spec stops describing a daemon that no longer exists |
| — | `719d143` | the doc gaps only a cross-action read could see |
| 7.2 | `740e381` | the gaps between "the assertion passes" and "the run is safe" |

Tests: 454 (plan baseline) → 1032 (C4) → 1177 (C5) → 1382 (C6) → **1511** (end of C7).

### What the re-measurement changed

Every C7 row was re-derived before being built, and the exercise paid for itself again:

- **7.1's list was two-fifths stale.** The `oauthTokenFile` branch and the account-rotation
  park-reason assertions were already closed; coverage was already 97.53 % lines / 90.97 % branch.
  What the row could *not* name was `preserveWorktreeWip`'s four error legs — a C6 feature that
  postdates it.
- **7.2's blocker was not the one the handoff named.** The handoff said the problem was that
  recette drives `drainQueueOnce` while production drives the dispatcher. True, but one level
  down the real obstacle is that the cap is a `deps.spawnSync` wrapper: a dispatcher runs workers
  as child processes, where that wrapper cannot reach at all.
- **7.3 was mostly already built**, and the file meant to hold it raced itself.
- **7.5 was far larger than five inconsistencies.** Two documents described a daemon that no
  longer existed: the spec said `scanner` **0** times and `lease` **0** times; `orchestrator/README.md`,
  169 KB of it, said `dispatcher` **0** times and still asserted the daemon "drains **serially**".

### The pattern held: in every action, the mutation that survived was the action's own claim

C6 recorded this six times. C7 recorded it four more, and two of them would have shipped:

| action | the survivor |
|---|---|
| 7.1 | a test that read its expectation back out of `statSync`, so `.mtimeMs → .ctimeMs` survived |
| breaker | the circuit-breaker `stopReason`'s two new field names — both assertion sites tested scenarios where the numbers were **equal**, so a straight swap shipped green twice over 1431 tests |
| 7.2 | the seven-var forwarding list, pinned only by accident: `SPO_AUTO_TRIAGE_MS` could be dropped and the suite stayed green, because config's own default for it is `0` — while the live drop-in sets `900000` |
| 7.2 | `scan-timers-disabled` validating the **parent's** config object, which the scanner process never reads |

That last one is the chantier's most important finding and is 6.5's failure exactly: every test
baked its own value in, so none read what production resolves.

### Three traps added to the standing list

- **Node reports a timed-out test as `cancelled`, not `fail`.** A mutation round reading `# fail`
  alone sees `# pass 1418 # fail 0` and calls a *killed* mutant a survivor. This compounds with
  the `--test-timeout=30000` rule: without the flag, mutations hang 100-150 s *and* then report as
  cancelled. Read `not ok` + `# fail` + `# cancelled` + the exit code, always.
- **`--experimental-test-coverage` cannot report on the whole suite.** One killed child truncates
  a V8 coverage file and the entire aggregate report is discarded. Coverage must be taken as the
  intersection of runs that exclude the child-spawning suites.
- **`test/no-real-spawn.js` patches `spawnSync` in the PARENT only.** Every hermetic guarantee
  this suite makes stops at a process boundary. Proved the hard way: a mutation routed tests
  through real worker children and created a real worktree and branch in `/home/crazz/SPO-WebClient`
  while the `--real` daemon was running. Cleaned up, nothing pushed — but no guard stopped it.

### Filed rather than fixed — the maintainer's decision, 2026-09-02

Verification found five production defects outside C7's scope. The decision was to fix the
scanner breaker (a one-line asymmetry with a lying field name) and file the rest with their
evidence, rather than land concurrency changes in a remediation plan's final chantier.

| # | what | severity |
|---|---|---|
| [#77](https://github.com/Crazz-Org/SPO-Pipeline/issues/77) | a failed `gh issue comment` strands a parked card forever — the retry channel dies silently, no race required | **high** |
| [#78](https://github.com/Crazz-Org/SPO-Pipeline/issues/78) | the crash-repark runs `finalizePark` synchronously in the dispatcher — the starvation class 6.3 moved the scans out for | **high** |
| [#79](https://github.com/Crazz-Org/SPO-Pipeline/issues/79) | scanner robustness: an unguarded rename kills it, `spo intake` has no daemon guard, and the fixed breaker now only reaches a scanner's first 60 s | **high** |
| [#80](https://github.com/Crazz-Org/SPO-Pipeline/issues/80) | `takeNextTask` drains a duplicate straight over a terminal taskDir | medium |
| [#81](https://github.com/Crazz-Org/SPO-Pipeline/issues/81) | twelve `*Ms` config fields read a malformed env override as "disabled" | medium |
| [#82](https://github.com/Crazz-Org/SPO-Pipeline/issues/82) | `no-real-spawn` is parent-only | medium |
| [#83](https://github.com/Crazz-Org/SPO-Pipeline/issues/83) | the reconciler's stale snapshot, and `orphanScan`'s inverted read order | low |

### The account cooldown, re-measured on the live pool

The maintainer reported the pipeline calling an account stuck while the dashboard showed under
100 % on the 5-hour window. Measured, and it is #483 in three parts at once:

- `pick()`'s only health test is `!cooldownUntil || cooldownUntil <= now` — a **locally invented**
  number compared to the wall clock, with **nothing ever reconciling against the server**.
- The cooldown key is the **account**, not the account+model. A Fable exhaustion at PLAN cools the
  account for Sonnet and Opus too, which is exactly why a dashboard can show headroom.
- 4 of the 7 cooldown events in the live journal carry **`defaulted: true`** — the server supplied
  no retry-after and the code guessed 1 h or 5 h.

All 7 cooldowns in the whole corpus are `pool1`, never `pool2` (Max 5x vs Max 20x).

Two things fixed on the spot: `~/.claude-accounts/labels.json` was **invalid JSON** (a stray `{`),
and `readLabels` swallows the parse error and returns `{}` — so the dashboard had been silently
showing no email/plan columns, degrading the very view being used to diagnose this. And
`spo account clear-cooldown` now exists, because hand-editing `state.json` takes no lock and
clears only the visible field: `lastUsageLimitAt` survives, so the next limit inside the 2 h
window escalates straight to the 5 h tier. Measured against the real code: limit #1 → 3600000,
limit #2 ten minutes later → **18000000**, clear, limit #3 → 3600000.

---
## What C7 hands the next session — written 2026-09-02, at commit `3d7a0b7`

**Branch `claude-crazz/c7-truthfulness-docs`, 23 commits on `f7cf9da`. Suite 1562 passing, 0
failing, 0 cancelled.** **Not yet merged.** The daemon is **stopped** (stopped for the live gate
run; restart it after merge). Every operational fact in this section is true as of the commit
named in the heading and nowhere re-verified since — that is what the file's status header means.

### Gate C7 — all three conjuncts

**1. Full suite green.** 1562 tests at `3d7a0b7`.

**2. `spo recette`, all scenarios.** Passed live: `trivial-doc-log`, and a K=2 `parallel-doc-log`
with real parallelism (two workers 5 ms apart on `pool1`/`pool2`, PRs #636 and #637 both merged,
board Todo unchanged at 142, zero `auto-pull` events, all seven scan timers confirmed `0` in the
scanner child's own `/proc` environ).

**3. The three certifications** that replaced the original clause (see "Chantier 7 bis" in the
plan for why the clause was unclosable by scope rather than by bar):

| | |
|---|---|
| **Enforced** | 7bis.1 park-reason sweep, 7bis.2 prompt-contract sweep, 7bis.3 documented-constant sweep. Both halves of 7bis.2 are now pinned to their ground truth: a sixth `STEP_CONTRACTS` entry and a fourth intake prompt each turn the sweep red. |
| **Exhaustive** | 7bis.4 — all 8 files under `prompts/` read line by line. Verification spot-checked 5 of the 8 against `step-contracts.js` / `task-values.js` / the state-machine branch reading each verdict and found nothing a line-by-line read should have caught. |
| **Declared** | `doc/accepted-gaps.md` — the partition, pinned to `bb35942`. Corpus **17,978** lines, retired **2,464**, accepted gap **14,368** across 65 files. Both figures supersede the plan's ~16,800 / ~2,290. |

### What verification actually found, and why it mattered

7bis.1, 7bis.3 and 7bis.4 shipped on a driver canary alone. The Opus pass with mutation testing
returned **seven mutants that survived the full suite**, and the C6/C7 pattern held for the fifth
time: **what survived was each action's own central claim.**

The structural one is worth carrying forward. `new ParkSignal(...)` is the **throw** site;
`finalizePark(...)` is the **sink**, and `state-machine.js:1527` is
`finalizePark(ctx, state, err.reason, err.detail)`. The sweep scanned throws and never the sink,
which carries six literal reasons no `ParkSignal` throws — four documented nowhere. One of them,
`abandoned-by-maintainer`, is written straight to `state.json.reason`, so a maintainer grepping
for `ParkSignal` would never have found it. **The sweep's headline claim was false while the
sweep was green.**

The rest were sweeps failing to guard themselves: `blankComments` could be reduced to a no-op and
stay green, because the fixture naming it omitted the `new` its own scanner requires; the floors
sat *below* the level at which four resolver families could be deleted; both allowlists were
unpinned, so one edit could exempt a reason forever; 29 % of `PINS` was deletable. In 7bis.2, the
prose tool-grant check read only the **first** statement — and `verify-citations.md` states its
grant twice, the second time under a heading titled *"repeated because it is the invariant that
matters most"*, in the one prompt that *reasons* from its grant.

**The lesson to carry into C8 and C9 is not "run more passes" — it is that for a sweep, green is
its normal state, so a scanner mutated into a no-op is indistinguishable from one that works.**
Only mutation testing separates them. Every sweep this chantier shipped now names the specific
resolver that died rather than reporting a smaller number.

### The register was caught undercounting three times

Each time by someone **re-deriving its numbers**, never by reading it: `bench-queue-wait.js`
missing from a table whose own subtotal was right (and the one file dropped from the accepted-gap
register was the bench file); the register's own 345 lines in no bucket; and `scripts/` —
6 tracked files, 177 comment lines across 665 — in neither the in-scope nor the out-of-scope list.
Its §7 also asserted a clean sibling grep that its own quoted command contradicts: `~16,800` is at
`doc/remediation-plan-2026-08.md:259`, in the chantier 7 bis preamble, present tense, as the
load-bearing premise of the whole scope argument — not in the 7bis.5 row as claimed.

**Root cause of the `scripts/` omission, and it is not local to the register:** the corpus
definition was inherited from execution rule 6's grep scope list, **which has the same blind
spot**. Rule 6's list should gain `scripts/` and `accounts/`.

### The two things a fresh session will get wrong

1. **An isolated worktree is not necessarily on the branch you named.** **Nine** agents across this
   chantier were provisioned at `f7cf9da` — the *pre-C7* base — while being told they were on the
   branch HEAD. **Make every subagent's first act `git rev-parse HEAD` against the base it was told
   to expect**, and give it a suite count to check against. Note `git reset --hard` is refused by
   the permission layer for subagents; `git checkout <sha>` from a clean tree is the fallback that
   works.
2. **`git checkout -- <file>` is not a mutation-testing restore, and `git stash` is forbidden.**
   Copy to `/tmp` and back, and verify with `git diff --stat` between mutants.

### The bench, and why C8's shape changed before C8 started

`doc/bench-audit-2026-09-02.md` and `doc/bench-plan-derived-2026-09-02.md` are 8.1's two
deliverables, produced early (read-only, in parallel with C7 bis, on the maintainer's decision).
**Everything in them is Fable's and unverified except one finding the driver checked personally:**

> **`bench/gate` has not been a required status check on SPO-WebClient's `main` since
> 2026-08-29T10:17Z.** Ruleset 21111153 version 47551828 required
> `["typecheck + tests","bench/gate"]`; version 48039109 requires `["typecheck + tests"]`.
> Verified via `/rulesets/21111153/history/{version_id}` — the `?ruleset_version_id=` query form
> is **silently ignored** and returns current state for every version, which is how this nearly
> went unconfirmed.

That reframes the `--live` defect: the stale worker made the gate **silent** from 2026-08-30, but
the ruleset had already made it **advisory** a day earlier. Every merge since went on CI alone.
`CLAUDE.md`, `doc/bench-worker.md` and `.claude/hooks/pre-push-gate.sh` all still promise the
opposite, and the pre-push hook dropped its own check on that promise.

**The audit contradicts plan row 8.5: do NOT move the bench into `orchestrator/`** — it reports 0
of 8 defect classes living at the repo boundary. **Consequence: chantier 9's deferral collapses**,
since it rested entirely on C8 rewriting `orchestrator/`.

**Both changes are now in the plan** (maintainer decision, 2026-09-02): row 8.5 is marked
**superseded** with the original hypothesis kept as written, the migration demoted from a
commitment to a question 8.1 answers on evidence, and chantier 9 **re-planned as parallel from
C8b on** with one surviving documentary dependency — it must not audit `doc/state-machine-spec.md`
or `doc/environments.md` until 8.2, 8.4 and 8.6 have landed. **The amendment states its own
provenance**: it rests on a Fable audit that is *not yet Opus-verified*, so **8.1 re-derives it
and may overturn it** — and if it does, it must say so explicitly rather than silently
re-adopting 8.5.

**Two acts the pipeline cannot perform**, both the maintainer's: restoring `bench/gate` to the
ruleset, and rebuilding/restarting the bench worker. **Do them together, in that order, and not
before the audit is verified** — the stale binary is the evidence, and restoring the required
check while the worker still runs it would re-arm a gate that certifies less than its name
promises. Confirm one gate artifact shows the live stage actually ran before calling it done.

### Filed this chantier

SPO-Pipeline **#77-#83** (the five production defects verification found and the maintainer chose
to file rather than fix in a final chantier), **#84** and **#85** (the GATE→merge-queue window, and
`merge-queue-not-landing` naming a symptom — both found by the live gate run). SPO-WebClient
**#640** (`CLAUDE.md` names `Rdo/Server/` as the RDO declaration authority; it holds none, and a
verifier obeying it rejects correct citations). **#77 reproduced live during the gate run**, four
hours after it was filed.
