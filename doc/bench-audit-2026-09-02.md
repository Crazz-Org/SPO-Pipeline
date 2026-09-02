> **Status: action 8.1 deliverable, produced 2026-09-02 by a Fable 5.1 read-only sweep of the
> bench corpus (509 verdicts, 7,347 stage logs). Per the protocol 8.1 mandates, every finding
> here is UNVERIFIED until an Opus agent re-verifies it by running probes — with one exception:
> the removal of `bench/gate` from SPO-WebClient's branch ruleset was verified independently by
> the driver against `repos/Crazz-Org/SPO-WebClient/rulesets/21111153/history/{version}`, which
> returns `["typecheck + tests","bench/gate"]` for version 47551828 and `["typecheck + tests"]`
> for version 48039109. Treat everything else as a claim to be checked, not as fact.**

# The bench, measured — action 8.1, 2026-09-02

Status: a dated measurement, true as of 2026-09-02T18:50Z, produced by the Fable half of the
C8 protocol. **Nothing here has been re-verified by Opus yet.** Every claim carries how it was
counted so that the re-verification can re-run it; the scripts are in the scratchpad next to
this file (`weekly.py`, `logs.py`, `merged.py`, `merged2.py`, `reuse.py`, `reuse2.py`,
`probes.py`, `journal.py`, `nightlyfail.py`). No repo was edited, no bench code was executed,
the worker (pid 270) was not touched.

Conventions, per this repo: **[observed]** = counted in the corpus or read in a file at a named
line; **[anticipated]** = follows from code that was read but has not fired in the corpus;
**[guess]** = an inference with no direct evidence. "read:" means a file says it; "inferred:"
means I concluded it from two or more things read or counted.

Method, in one line: take every artifact the bench leaves behind (`~/.spo-bench/`, the product
checkout's `report/e2e/`, the pipeline journal, GitHub's ruleset history and commit statuses),
join them on sha and time, and compare what they say the bench *did* against what the source
and the docs say it *does*.

---

## 1 · The sample

| store | files | span (UTC) | what it is | retention |
|---|---|---|---|---|
| `~/.spo-bench/verdicts/*.json` | **509** | 2026-08-22T08:38 → 09-02T16:51 | per-sha attestations; 393 from `ref/checkout`, 116 from session worktrees (the pre-#175 job type) | never purged |
| `~/.spo-bench/ref/checkout/report/e2e/gate-*.json` | **304** | 08-24T20:24 → 09-02T16:48 | verify-gate artifacts of `ref` jobs — the only record of whether the live stage ran | ignored by `git clean -fd`, kept |
| `~/.spo-bench/nightly/checkout/report/e2e/live-*.json` | **51** | 08-25T02:00 → 09-02T16:44 | nightly live drives of `main` (run.ts `main()` output) | kept |
| `~/.spo-bench/done/*.json` + `.log` | **13** + 13 | 09-02 only | job reports | **purged after 24 h** (`worker.ts` `DONE_RETENTION_MS`) |
| `~/.spo-bench/logs/` | **7,347** | 08-28T10:01 → 09-02T18:50 | 7,172 `gate-<stage>-*` stage logs + 175 `verdict-*`/`sanctuarize-*` | never purged, 119 MB |
| `~/.spo-bench/world/` | 2 | last 24 h | `world-lock.json`, `run-history.json` | run history trimmed to 24 h on every write |
| `~/.spo-bench/nightly/latest.json`, `worker.json`, `heartbeat` | 3 | now | current state | — |
| `~/.spo-bench/sessions/`, `journals/`, `hook-llm/` | 2,596 + 30 + 45 | 08-25 → 08-30 | residue of the retired hook layer (not bench data) | inert |
| `~/SPO-WebClient/report/e2e/` | 10 gate + 8 live | 08-21 (+1 live on 08-29) | pre-bench local `gate:local`/`test:live:local` artifacts | — |
| `~/SPO-WebClient/.claude/worktrees/*/report/e2e/` | **0** | — | the worktree-era artifacts: 4 worktrees survive, none has a `report/` | deleted with the worktrees |
| GitHub `Crazz-Org/SPO-WebClient` | 265 merged PRs (241 since 08-22) · ruleset 21111153 (7 versions) · `BENCH_OWNER` · `bench/gate` statuses | — | via `gh` read-only | — |
| `/home/crazz/SPO-Pipeline/journal/` | 23 task dirs · 27 `GATE` spawn events | 08-29 → 09-02 | the pipeline's own record of every `npm run gate` | — |
| source | `src/e2e/**` 14,593 lines incl. tests; `scripts/verify-gate.js` 432; `scripts/bench-*.sh`, `nightly-check.sh`, `finish.sh`; `dist/e2e/bench/*.js`; `orchestrator/steps/scripted.js` `realGate` | the `~/SPO-WebClient` working tree at `93528389` (08-30T10:16Z); `git diff 93528389 origin/main -- src/e2e scripts/` differs **only** in `b7a868bf` (the `people-search` flow + its routing rule, 08-31), so every line cited from `worker.ts`, `verify-gate.js`, `verdict.ts`, `merge-queue.ts`, etc. is identical on `origin/main` d03ea8b7 | read in full: `worker.ts`, `verify-gate.js`, `verdict.ts`, `fingerprint.ts`, `job.ts`, `cli.ts`, `nightly.ts`, `owner.ts`, `merge-queue.ts`, `checkout.ts`, `ci-proof.ts`, `paths.ts`, `run.ts`, `world-lock.ts`, `capability.ts`, `config.ts`, `preflight.ts`, `probe.ts`, `live-log.ts`, `flows.ts`, `session.ts`, `routing.ts`, the shell scripts, `.claude/hooks/pre-push-gate.sh` | — |

Two vocabulary terms used throughout, derived from each artifact's `live` field:

- **RAN** — `live.skipped` absent: `runLive()` executed (`live.status` ∈ PASS/FAIL/ENVIRONMENT/BLOCKED).
- **SKIP-STATIC** — `live.skipped: true`, `why: "nothing in this diff is observable over the wire"` (routing found no flow; legitimately static).
- **SKIP-NOFLAG** — `live.skipped: true`, `why: "live stage requires --live (worker-only); routed flows: …"` (verify-gate ran without `--live`; the worker defect).
- **NOLIVE** — `live: null`: the static stage failed before routing.

Verdict totals [observed, `jq` over 509 files]: PASS 489 · FAIL 20 · no other value ever
written. `fingerprintStable: true` 509/509. `reusedFrom` present 62. `merged: true` 64 (53
computed + 11 reused). `exceptions`: 0 ×485, 1 ×8, absent ×16. `published: true` 505.

Artifact totals [observed, `weekly.py`]: RAN 80 (79 PASS + 1 ENVIRONMENT) · SKIP-STATIC 181 ·
SKIP-NOFLAG 29 (17 of them with routed flows) · NOLIVE 14. Static authority: `CI` 33, replayed
on the bench 271.

---

## 2 · Taxonomy — what actually went wrong

Rows are ordered by how much of the corpus they touch. Each row names the mechanism, the
count, and the reader that was misled.

| # | class | mechanism | count | who is misled |
|---|---|---|---|---|
| **T1** | **PASS without evidence** | verify-gate exits 0 and the worker writes `verdict: PASS` whether or not the live stage ran; nothing downstream can tell the two apart | 29 SKIP-NOFLAG artifacts, 17 with routed flows; 23 merged PRs; **19 of 19 pipeline cards since 08-30T07:18Z** | the pipeline's GATE, `bench/gate` on GitHub, the maintainer |
| **T2** | **Advisory gate** | `bench/gate` is not a required status check on `main` since 2026-08-29T10:17Z; the ruleset requires only `typecheck + tests` | every merge since — all 26 pipeline PRs; 6 PRs merged *before* their bench verdict existed | everyone who read `CLAUDE.md:472-475`, `doc/bench-worker.md:170/276/500`, `.claude/hooks/pre-push-gate.sh` |
| **T3** | **Reuse provenance** | merge-queue reuse copies a PASS onto a new sha when trees match, with no age bound and no check that the source drove live; the log line says "already driven live" | 62 reused verdicts; source never drove live for 53 (85 %); 0 age bound | `bench/gate` on the queue sha, the merge queue |
| **T4** | **Evidence chain broken** | artifacts of merged gates are keyed by the merge-commit sha; `done/` (the only verdict→artifact link) is purged at 24 h; `verdicts/` is never purged; 98 % of `logs/` is test pollution; `run-history` keeps 24 h and labels every nightly `local` | 56 orphan artifacts / 64 merged verdicts / 30 verdicts with no artifact at all / 7,040 junk logs | any auditor, including this one |
| **T5** | **Bench binary provenance** | the worker runs whatever `dist/` was last built in `~/SPO-WebClient`; the only rebuild path is `scripts/finish.sh` step 4, which the pipeline never calls; the main checkout has sat on a feature branch since 08-30T10:17Z | 1 worker, up 5 d, `NRestarts=0`, binary from ≤ 08-28; 60+ commits behind | the worker, the CLI (`bench-submit.sh` loads the same `dist/`), every gate |
| **T6** | **Outcome collapse** | ENVIRONMENT→FAIL (1, before the 08-25 fix, still on disk); server "Internal server error"→FAIL in 4 nightlies; `cli.ts wait()` flattens 7 verdicts to exit 1; `nightly-check.sh` maps ENVIRONMENT/INTERRUPTED to GREEN | 1 + 4 + structural | the pipeline's GATE and main-red guard |
| **T7** | **Policy vs enforcement** | rate limiter disabled (0 min / 1000 per day); probe restore never verified; two mutating flows write outside Helartia (account scope); credentials in a public repo; `gateMaxAgeMinutes` enforced nowhere; owner-lease enforcement is "earned", not configured | 80 probes, 63 mails, 55 favourites | readers of `doc/environments.md` §pre-production |
| **T8** | **Cost: the bench replays what CI already proved** | `staticProof.used` only when CI concluded; the pipeline gates seconds after pushing, so CI is "still in_progress" | 271/304 artifacts replayed the suite (89 %); a CI-proven job took 33 s vs 125–206 s | the bench queue, C6's throughput model |

---

## 3 · Findings, frequency-ordered

### F1 — No pipeline gate has driven planitia since 2026-08-30T02:18Z; every one since 07:18Z attested PASS anyway [observed]

How counted: `weekly.py` over the 304 artifacts, `live` field classified as in §1; boundary
commits from `git --git-dir=~/SPO-WebClient/.git log`; pipeline side from
`journal/*/journal.jsonl` `state:"GATE" event:"spawn"`.

- Last artifact with the live stage run: `52677523` at 2026-08-30T02:18:22Z (merge of PR #440,
  a branch cut before the guard). First SKIP-NOFLAG: `e180bfb6` itself at 08-29T20:40:24Z —
  harmless (routed flows: none). First SKIP-NOFLAG with routed flows: `f6935775` at
  08-30T08:18:12Z. From `1339f4ee` (PR #435 merged 08-30T07:17:57Z, the first `main` carrying
  `e180bfb6`) onward: **29 of 29 artifacts are SKIP-NOFLAG**, 17 of them with routed flows
  (`login-spine+building-details` ×8, politics-write ×6, favorites ×3, mail ×1, people-search ×2).
- Pipeline side: 26 real `GATE` spawns in the journal, 25 exit 0, 1 exit 1 (issue-439, 5 s, the
  merge conflict). **15 exit-0 gates after 08-30T07:18Z** (issues 443, 439, 450, 201, 452, 385,
  455 ×2, 456, 462, 471, 475, 473, 485, 487) — every one advanced to CI_CHECKS on a static-only
  PASS. The journal records `exit: 0, ms: ~130000` and nothing else about the gate.
- GitHub side: `gh api repos/…/commits/da15052e…/status` → `bench/gate success "PASS — base
  215d9c6c — job job-01788322511527-e2f9db"`. The published status has no field for "live ran".
- Cause chain, each link read: `worker.ts` L≈482 (`origin/main`) passes `'--live'`; the running
  binary does not — `grep -c "'--live'" ~/SPO-WebClient/dist/e2e/bench/worker.js` → **0**;
  `dist/e2e/bench/worker.js` mtime 2026-08-29T07:39:25Z; `systemctl --user show
  spo-bench-worker` → `ExecMainStartTimestamp=2026-08-29 00:23:28 CEST` (= 08-28T22:23:28Z),
  `NRestarts=0`; `e180bfb6` authored 08-29T20:39:49Z. verify-gate.js itself is executed **from
  the job's checkout** (`cwd: request.worktree`), so the guard applies per branch content — which
  is why branches without `e180bfb6` kept running live until 08-30T02:18Z while the worker's
  argv never changed.
- Inferred: the `dist/` on disk was built by an **unguarded local live drive**:
  `~/SPO-WebClient/report/e2e/live-2026-08-29T07-39-38-076Z.json` (7 flows, PASS, branch
  `local`) started 13 s after the dist mtime — `npm run test:live:local` = `build:e2e && node
  dist/e2e/run.js`. That is the exact bug `e180bfb6` closed that evening (#428). [inferred from
  two mtimes; the command itself is not recorded]

### F2 — `bench/gate` has not been a required check since 2026-08-29T10:17Z; six PRs merged before the bench answered [observed]

How counted: `gh api repos/Crazz-Org/SPO-WebClient/rulesets/21111153` (current) and
`…/history/{47551828,48039109}`; `merged2.py` compares each queue-entry verdict's `createdAt`
with the PR's `mergedAt`.

- Ruleset version 47551828 (2026-08-25T05:49Z): `required_status_checks: [typecheck + tests,
  bench/gate]`. Version 48039109 (2026-08-29T10:17Z, actor = the maintainer's user id): only
  `typecheck + tests`. Current = 48039109. `bypass_actors: []`, `merge_queue` rule present
  (`check_response_timeout_minutes: 60`, one entry at a time).
- Consequence, measured: of 74 gated queue entries with a merged PR, **6 have a verdict written
  after the PR merged** (#436 −44 s, #438 −23 s, #440 −29 s, #444 −32 s, #446 −15 s, #637 −4 s).
  Median lead of verdict over merge otherwise 31 s — the bench is racing the queue, not gating it.
- What the docs and the hook say instead — all read, all now false: `CLAUDE.md:472-475`
  ("`typecheck + tests` **and** `bench/gate` required, no bypass … a PR cannot merge on CI
  alone"); `doc/bench-worker.md:170` ("ruleset: PR, CI green AND bench/gate green, no bypass"),
  `:276`, `:500`; `.claude/hooks/pre-push-gate.sh` ("`bench/gate` is a required status check on
  `main` with an EMPTY bypass list (ruleset 21111153)") — the hook *removed its own push-time
  check on that promise*.
- Why it changed is not in the corpus [guess]: the change is 30 min before PR #422 merged with
  `no-verdict` for its head — plausibly the maintainer unblocked a queue the bench could not
  serve. No commit, issue or doc records it.

### F3 — The gate spends ~90 % of its bench time replaying a suite CI is running at the same moment [observed]

How counted: `static.typecheck` over 304 artifacts (`CI` vs `PASS`); `done/*.json`
`startedAt→finishedAt` and `staticProof` for today's 13 jobs; pipeline journal `ms` per GATE.

- 271/304 artifacts (89 %) replayed typecheck+lint+jest on the bench; 33 took CI's proof.
- Today's `ref` jobs: 125–206 s with the replay; **33 s** for the one CI-proven job
  (`a5ee85f6`, `staticProof.used: true`). 5 of 7 replays say `"typecheck + tests" is still
  in_progress for this commit` — the pipeline submits the gate seconds after `PUSH_PR`
  (`PUSH_PR → GATE → CI_CHECKS`, spec line 67), so CI has not concluded.
- The last real jest log in `logs/` (`gate-unit + component tests-20260902T185008.log`, 1.0 MB):
  `375 suites, 8199 tests, 36.6 s` — plus typecheck and lint, on the one serialised resource.
- Read: C6's funnel (`remediation-progress.md:1216-1222`) puts the bench at 18.6 % of a card's
  cycle. Inferred: ~80 % of that is redundant when the static half comes from CI.

### F4 — 62 verdicts (12.2 %) are `reusedFrom`; 53 of those copied an attestation that never drove live; reuse has no age bound [observed + anticipated]

How counted: `reuse.py` / `reuse2.py` over `verdicts/`, source artifact located by head or by
the merge-commit pairing of F6.

- 62 reused, all `verdict: PASS`, all chain depth 1 (merge-queue.ts collapses chains), all
  `tree` equal to the source's. Gap source→reuse: median 3 min, max 136 min (`bb65e7af` ←
  `48182520`). Source drove live: **9**; SKIP-STATIC: 37; SKIP-NOFLAG: 16.
- `merge-queue.ts` `mayReuseVerdict` (read): requires `tree` equal, `verdict === 'PASS'`,
  `fingerprintStable` — **no age, no check that the source ran the live stage, no world-state
  key**. Its log line and `why` string say "identical tree to X, already driven live" — false for
  53 of 62 [observed].
- Live-world events between source and reuse (gate RAN + nightlies, 131 events in the corpus):
  4 reuses had ≥1 in between, 3 of them mutating (nightlies with `politics-write`,
  `mail-roundtrip`, `favorites-roundtrip`).
- Is tree-equality sound for a live-world attestation? Inferred, stated as a rule the code does
  not have: it is sound iff (a) the flows assert only properties the tree controls, and (b) the
  world the source saw is, for those properties, the world the reuse claims. (a) is false —
  `politics-read` asserts "the governed town is still listed", `politics-write` asserts
  `canGovern === true` on Helartia, `permission-negative` asserts `canGovern === false` for
  Crazz: server-side facts about a shared, mutable world. (b) is unbounded — `verdicts/` is never
  purged and `attested()` (`worker.ts` `mergeQueueDeps`) offers *every* verdict on disk as a
  candidate, so a queue entry whose tree matches a 10-day-old PASS would reuse it [anticipated;
  max observed 136 min]. The empirical risk today is low because every mutating flow restores on
  exit and gaps are minutes; the mechanism does not know that.

### F5 — Of merged PRs, 43 of 241 (18 %) were ever driven live; of pipeline cards, 6 of 26 (23 %), and 0 of 19 since 08-30 [observed]

How counted: `merged2.py` — for each merged PR since 08-22, resolve its head sha and any
`gh-readonly-queue/main/pr-N-*` verdict to an artifact (direct, via `reusedFrom`, or via the
merge-commit pairing) and take the best label.

| period | PRs | LIVE | STATIC (nothing routed) | NOFLAG (routed, not run) | UNKNOWN (artifact gone) |
|---|---|---|---|---|---|
| A · 08-22 → 08-24 (worktree jobs) | 78 | 2 | 3 | 0 | 73 |
| B · 08-25 → 08-30T07:18 (ref jobs, live) | 140 | 41 | 99 | 0 | 0 |
| C · 08-30T07:18 → now | 23 | 0 | 0 | **23** | 0 |
| **all** | **241** | **43** | **102** | **23** | **73** |
| pipeline cards (`claude-pipe/*`) | 26 | 6 | 1 | **19** | 0 |

Read against the routing table: STATIC is the honest answer for docs/tests/tooling diffs
(`routing.ts` first three rules). Period B's warranted-live rate: 41 LIVE vs 0 NOFLAG → the
bench did what it said. Period C: 0 of 23.

### F6 — The evidence chain does not survive contact with the bench's own retention [observed]

How counted: artifact heads vs verdict heads (`merged2.py`), `done/` count vs verdict count,
`logs/` burst analysis (`logs.py`).

- **56 artifacts are keyed by a sha that is no verdict** — `verify-gate.js` names the artifact
  `gate-<HEAD>.json` and, after `prepareRef` merged `origin/main`, HEAD is the merge commit;
  the verdict is keyed by the deposited sha (`worker.ts`: "The attestation still keys on the sha
  that was deposited, never the merge commit"). 53 of the 56 pair to a merged verdict by time
  (≤ 15 min before `createdAt`); 3 pair to nothing. **30 computed ref verdicts have no artifact
  at all**, all 08-25/26 [observed; cause not established — guess: `report/e2e` cleaned during the
  #178→#179 merge-queue revert/restore].
- The only field linking a verdict to its artifact is `report.gateArtifact` in `done/<job>.json`
  — purged after 24 h. 509 verdicts, 13 reports.
- `logs/`: 7,172 `gate-*` files, **7,040 in minutes with ≥ 4 files** (84 in one minute at
  08-30T03:58); 6,714 are empty; 223 read `fake npm: <stage> failed`. Source:
  `src/e2e/verify-gate.test.ts` runs the real `verify-gate.js` with a fake `npm` on PATH and
  never sets `SPO_BENCH_DIR` (`grep SPO_BENCH_DIR src/e2e/*.test.ts src/e2e/bench/*.test.ts` →
  nothing), so `captureStage()` (`verify-gate.js:143`) writes to `$HOME/.spo-bench/logs` — and
  since the bench replays jest on itself (F3), **every gate pollutes the bench's own log
  directory**. Real stage logs: ~77 per stage (jest logs > 2 KB: 08-28 30, 08-29 17, 08-30 14,
  08-31 6, 09-01 3, 09-02 7).
- `world/run-history.json`: trimmed to 24 h on every `recordRun`; every nightly is recorded as
  `branch: "local"` because `worker.ts` runs `dist/e2e/run.js` with no `--branch`
  (`run.ts main()` default). The limiter's "Last live run (local)" message can never name a
  branch.

### F7 — The worker's binary has no deploy path the pipeline uses, and a start-time provenance check would never have fired [observed]

How counted: `scripts/finish.sh:246-247` (read), `orchestrator/steps/scripted.js` grep for
`finish`/`bench-install` (no spawn of either), `systemctl --user show` (read),
`~/SPO-WebClient/.git/HEAD` + reflog (read).

- `finish.sh` step 4 is the *only* rebuild+restart of the worker ("reinstalls the bench worker
  when the merge touched its sources — the worker runs the main checkout's dist/, and nothing
  else rebuilds it"). The orchestrator's FINISH does its own worktree/branch cleanup and never
  runs `npm run finish` → since the pipeline replaced the sessions (08-29), no merge has
  reinstalled the worker. 4 commits touched `src/e2e/bench/**` or `scripts/verify-gate.js`
  after the running binary was built (`e180bfb6`, `3ce7fd25`, `730b97bc`, `481fba20`).
- `NRestarts=0`: the worker has not restarted since 08-28T22:23Z. Any check that runs at
  process start (8.3 as worded: "refuses to start") would not have fired once in this window
  [anticipated]. `bench-submit.sh` and `bench-wait.sh` load the same `dist/e2e/bench/cli.js`.
- `~/SPO-WebClient` (the worker's `WorkingDirectory`) is on branch `feat/suggestion-report-kind`
  at `93528389` since 2026-08-30T10:16:56Z; local `main` = `e9056711` (08-30T09:17Z);
  `origin/main` = `d03ea8b7`. `finish.sh` step 2 (ff the main checkout) has not run either.

### F8 — Outcome collapses: one durable, four in the wrong direction, two structural [observed + anticipated]

How counted: artifacts with `verdict ≠ live.status`; `verdicts/2fc1c8fc*.json`; nightly
`live-*.json` with `status: FAIL`; code read.

- **ENVIRONMENT → FAIL, durable**: `gate-2fc1c8fc….json` (08-24T21:48Z, `live.status:
  ENVIRONMENT`, "gateway is ready: http://localhost:8080 unreachable") carries `verdict: FAIL`;
  `verdicts/2fc1c8fc….json` still says FAIL, `published: true`. This is the bug `d8091f48`
  (08-25T10:59Z) fixed; the corpus has 1 instance before and 0 after. It was never revisited —
  as `worker.ts` says of itself, an attestation "is not self-correcting".
- **Server error → FAIL (red main)**: 4 of 51 nightlies FAIL, every one a single flow with
  `error: "Internal server error"` and zero failed assertions (08-28T08:20 building-details,
  08-28T14:31 politics-read, 08-28T14:41 login-spine, 08-29T07:28 building-details). A
  server-side transient was published as a FAIL of `main`; `nightly-check.sh` would have said
  `MAIN: RED` and the pipeline's `main-red-no-merge` / `main-red-refuse-worktree` would have
  parked any card at those shas. None ran then; 0 `main-red` parks in the journal [observed].
- **The other direction**: `nightly-check.sh` maps `ENVIRONMENT|INTERRUPTED` → `MAIN: GREEN`
  exit 0 ("the run proved nothing about main"); the pipeline's own guard
  (`scripted.js:292-293`) reads FAIL-at-this-sha only. Documented; still a fail-open.
- **Exit-code flattening**: `cli.ts wait()` returns 0 for PASS/LEASED and 1 for FAIL, BLOCKED,
  STALE, DIRTY, ABANDONED, INTERRUPTED and ENVIRONMENT. The pipeline (action 4.2) disambiguates
  by whether `verdicts/<sha>.json` exists — correct for a first gate, wrong when a **previous**
  verdict for the same sha exists (a re-gate after ENVIRONMENT reads the old PASS/FAIL)
  [anticipated; 0 observed].
- **BLOCKED is attesting**: `NON_ATTESTING = {DIRTY, ENVIRONMENT, ABANDONED}`; a BLOCKED (rate
  limit, dirty world, or — since `e180bfb6` — *a President-member diff gated without `--live`*)
  is written to `verdicts/` and published as `bench/gate=failure`, then reaches the pipeline as
  exit 1 with a verdict that has `baseMain` → DIAGNOSE (an LLM call to diagnose a missing flag)
  [anticipated; 0 BLOCKED verdicts exist; the last President-member diff was 08-25].
- **verify-gate's own collapse is fixed**: the exit table (`EXIT = {PASS:0, FAIL:1, BLOCKED:2,
  ENVIRONMENT:3}`) and the "CARRIED, not collapsed" block are as the comments say; the corpus
  agrees (0 post-fix instances).

### F9 — `fingerprintStable` is true 509/509 and is vacuous for 393 of them [observed]

- For `ref` jobs the `atSubmit` half is exempt by code (`worker.ts`: "A `ref` job is exempt from
  the atSubmit half, and necessarily") and `atStart`/`atEnd` fingerprint the worker's own
  checkout, which only the worker writes. The field can only be false if the worker's own build
  changed a tracked file. It has never been false; no STALE verdict exists.
- For the 64 merged verdicts, `tree` is `HEAD^{tree}` of the **merge commit** while `head` is the
  deposited sha: "fingerprintStable: true" describes a tree that is not the head's tree. That is
  the intended semantics (the tree that was driven) but nothing in the file says so.
- For the 116 worktree-era verdicts the field meant what it says and was true every time.
- `merge-queue.ts` filters reuse candidates on `fingerprintStable` — a filter that admits 100 %.

### F10 — What the LOCKED-account / world-lock policy actually enforced [observed + read]

Numbers from `probes.py` over 144 live bodies (80 gate RAN, 51 nightlies, 3 + 8 local on 08-21
and 08-29, 2 non-run files miscounted and excluded here).

| claim (`doc/environments.md` §pre-production, `E2E-POLICY.md`) | enforced by | measured |
|---|---|---|
| LOCKED accounts only | `config.ts` constants (`SPO_test3`, `Crazz`); nothing reads `accounts/spo-test-accounts.yml` in the product repo | 137 `login-spine` runs, all `SPO_test3`; `Crazz` only in `permission-negative` (55) and `mail-roundtrip` (64). **Passwords are literals in `src/e2e/config.ts` of a PUBLIC repo** (`gh repo view` → `visibility: PUBLIC`; the pipeline's `accounts/spo-test-accounts.yml` header acknowledges "these test credentials are already public") |
| mutations only on Helartia | `politics-write` → `findTown(GOVERNED_TOWN)` + `canGovern === true` assertion (`flows.ts`): by construction for the **one** town-mutating flow. No guard prevents a new `mutates: true` flow from targeting elsewhere | 80 `politics-write` probes, all `Helartia tax row 0 rate`. Two other mutating flows write account-scope state: `mail-roundtrip` sends to `Crazz` (63 PASS + 1 FAIL), `favorites-roundtrip` writes `SPO_test3`'s tree (55). Documented as exceptions; not "on Helartia" |
| evidence over silence — the `FIVEMODELSERVER/Survival` line | `probe.ts` `finish()`: FAIL unless `logLine` and `restored`. Only `RDOSetTaxValue` is probed; `LOG_MARKERS` has 3 entries, 1 used | **80/80 probes had the log line**. `readBack`: CONFIRMED 2, UNCONFIRMED 78 (OB-29 cache lag, `note` set) — read-back is informational, never failing. `restored: true` 80/80 — but `restore()` returns true when the write **did not throw**; the header's "assert the restore landed" is not implemented: no log line awaited, no read-back |
| capability exceptions read from the server, never assumed | `capability.ts` reads `IsPresident` + `canGovern` on the Capitol; verify-gate fails closed on `!determined` or `granted` | 2 artifacts (08-25, `303c289c` and queue entry `0635d366`): `IsPresident=false`, `canGovern=false`, `exceptions: 1`; 6 more verdicts on 08-24 with `exceptions: 1` (artifacts gone). Since `e180bfb6`, a President diff without `--live` is BLOCKED (see F8) |
| single-flight | the worker loop (one job) + `WorldLock.acquire` (pid-keyed, host-local) + `BENCH_OWNER` lease (5-min, renewed each minute; enforcement "earned" on first success) | `BENCH_OWNER = {host: Flyin2sky, pid: 270}` renewed 18:14:32Z; `world-lock.json` holder null, `dirty: false`; no dirty event is recorded anywhere (a cleared dirty flag leaves no trace) |
| rate limit | `LIMITS.minIntervalMinutes = 0`, `maxRunsPerDay = 1000` since 08-22 ("the queue is the throttle") | 21 nightlies on 08-28 alone (main-moved trigger, 15-min limit); peak day 38 gate live runs (08-25) |
| attestation freshness | `LIMITS.gateMaxAgeMinutes = 60` — read by nothing since the push hook stopped reading verdicts (#158 stage C) | no consumer; reuse has no age bound (F4) |

### F11 — The residue and the noise [observed]

- `sessions/` 2,596 files, `journals/` 30, `hook-llm/` 45 — the retired hook layer (08-25 →
  08-30), including 4 `.driving` markers for cards 177/218/251/370. Not bench data; the task
  brief lists them as corpus.
- Every nightly log carries `✗ Failed to download BuildingClasses/CLASSES.BIN.bak-2003: HTTP 404`
  from the gateway's UpdateService against the bench-wide cache (3 of 13 job logs today).
- `verdicts/` (509 files, 2.1 MB) is read in full by `listVerdicts` on every idle tick
  (`serveMergeQueue`) and every 30 s (`publishPendingStatuses`).

---

## 4 · The seven questions, answered

1. **Live stage per week.** Gate artifacts: **W35 (08-24→30): 80 RAN of 287** (79 PASS, 1
   ENVIRONMENT) — 38 on 08-25, 20 on 08-27, 9 on 08-29, 2 on 08-30; **W36 (08-31→09-02): 0 of
   17**. W34 (08-22/23): 65 verdicts, 0 surviving artifacts — unknown. Nightlies: W35 40 (36
   PASS, 4 FAIL), W36 11. Among gates whose diff *routed* a flow: W35 80/89 ran (90 %), W36 0/8.
   Boundaries: 08-21 local unguarded gates (3/10 live) → 08-22T08:38Z first worker verdict →
   08-24T20:24Z first `ref` artifact, 21:48Z first live via `ref`, 08-25T02:00Z first nightly →
   08-25T10:59Z ENVIRONMENT stops attesting → **08-29T10:17Z `bench/gate` dropped from the
   ruleset** → 08-29T20:39Z `e180bfb6` → **08-30T07:18Z first `main` with the guard; 0 live
   gates after 02:18Z**.
2. **Reuse.** 62 of 509 (12.2 %); 9 sources drove live, 53 did not; no age bound, no
   world-state key, false "already driven live" log line. Tree-equality is a sound basis for
   the *static* half and for the live half only under a staleness bound and a verified-restore
   invariant, neither of which exists (F4).
3. **Merged cards driven live.** 43/241 merged PRs (18 %; 26 % of the 168 with evidence);
   pipeline cards 6/26 (23 %); 0/19 since 08-30T07:18Z (F5).
4. **ENVIRONMENT/BLOCKED collapsed downstream.** 1 ENVIRONMENT→FAIL (08-24, durable); 4
   server-error→FAIL nightlies; 0 BLOCKED verdicts ever; `cli.ts` and `nightly-check.sh`
   collapses are structural and documented; the pipeline's disambiguation has one anticipated
   hole (pre-existing verdict). The fix the worker's comments describe stayed fixed (F8).
5. **`fingerprintStable`.** True 509/509; vacuous for the 393 `ref` verdicts; for 64 merged
   verdicts `tree` is the merge commit's, not the head's (F9).
6. **Policy vs enforcement.** Helartia-only holds for the single town-mutating flow by
   construction; the Survival line was present 80/80 but the restore is never verified and
   read-back never fails; capability reads worked twice; the rate limiter is off; credentials
   are public; `gateMaxAgeMinutes` is dead (F10).
7. **Unasked.** `bench/gate` is advisory (F2); the gate is 89 % redundant static replay (F3);
   the worker's deploy path is a script the pipeline never calls (F7); the evidence chain
   breaks at 24 h and at every merge (F6); 98 % of the "7,347 stage logs" are test pollution
   (F6); the dist that the stale worker's neighbours load was built by an unguarded local live
   drive (F1).

---

## 5 · Would X have been enough?

| X | would it have caught / prevented T1 (the silent downgrade)? | evidence |
|---|---|---|
| **Restarting the worker** (systemd) | **No.** `dist/` on disk (07:39Z 08-29) predates `e180bfb6`; a restart loads the same binary without `--live` | `grep -c "'--live'" dist/e2e/bench/worker.js` = 0 |
| **Rebuild + restart** (`scripts/bench-install.sh`) | Yes for T1, from that moment; nothing for T2–T8 | `bench-install.sh` runs `build:e2e` then restarts |
| **8.2 as written** (verdict carries `live`; GATE refuses static-only when flows were routed) | **Yes** — the first pipeline gate after the guard (issue-443, 08-30T13:14Z, routed `login-spine+building-details`) would have parked instead of merging PR #447; 18 further cards would have parked too, which is the point | 17 SKIP-NOFLAG artifacts with routed flows |
| **8.3 as written** ("refuses to start when older than the checkout") | **No.** `NRestarts=0`: the worker never started in the window. A per-job check (binary build sha vs `src/e2e/bench/**` at the job's `origin/main`) would have fired at the first job after 08-30T07:18Z | F7 |
| **`bench/gate` still required** (ruleset v47551828) | Not for T1 — the status would still say `success`. It would have prevented the 6 merge-before-verdict cases and made every pipeline merge wait for the bench | F2 |
| **Waiting for CI before GATE** | Not for T1; removes ~90 s per gate and F6's log pollution as a side effect | F3 |
| **Reading `gate-<sha>.json` in `realGate`** (no bench change) | Yes for T1 on non-merged gates; blind for the 64 merged runs whose artifact is keyed by the merge commit (F6) | 53 of 56 orphans pair only by time |
| **The nightly** | It never stopped: 51 live drives of `main`, 11 this week, every one with `politics-write` on Helartia. It proves `main` after the fact; it cannot prove a candidate | F1, F10 |

The honest reading: the class of defect is "a PASS whose evidence is absent", and the only
instrument that catches that class is **evidence carried in the verdict and demanded by the
reader** — the rule C1 gave the judges. Provenance (8.3) catches the *cause* this time; the
verdict field catches the *class* every time.

---

## 6 · Limits of the method

- **The worktree era is dark.** 116 verdicts (08-22 → 08-24) name session worktrees; 4
  worktrees survive and none has a `report/e2e`. Whether those gates drove live is not
  recoverable — 73 of 241 merged PRs are UNKNOWN for that reason, and the W34 live count is
  absent, not zero.
- **`done/` is 24 h deep.** The count of ENVIRONMENT / BLOCKED / STALE / ABANDONED /
  INTERRUPTED *jobs* over the corpus is unknowable; only their *attestations* (by design, none
  for the first three) can be counted. Job durations are today's 13 only.
- **Merge-commit pairing is by time.** 53 of 56 orphan artifacts were matched to a merged
  verdict by "nearest `createdAt` within 15 min before"; a queue busy enough to interleave two
  merged gates inside 15 min would mis-pair. 30 computed `ref` verdicts (08-25/26) have no
  artifact by any method; their live status is unknown and they are counted as
  `verdict-no-artifact`/UNKNOWN.
- **"Live events between" undercounts.** Only gate RAN artifacts and nightly `live-*.json` are
  known; `live` and `lease` jobs (a human's `npm run dev`, `npm run test:live`) leave nothing
  after 24 h. The 3-of-62 figure in F4 is a floor.
- **The reflog is the only witness to the running binary's age.** The process's in-memory code
  is inferred from the systemd start time and the dist mtime; the exact commit it was built from
  is bounded (≤ `f04c2338`, 08-28T21:22Z) rather than known.
- **Ruleset intent is not recorded.** F2's date and actor come from the history API; the reason
  is a guess and is marked as one.
- **Static analysis of source, dynamic evidence of one build.** Line references are to
  `origin/main` `d03ea8b7`; the worker executes an older build, and the checkout under
  `ref/checkout` executes whatever sha the last job fetched. Where the three disagree the doc
  says which one was read.
- **`gh` reads were made at 18:12–18:30Z on 09-02**; the ruleset, the lease variable and the
  statuses can change under the reader.
- **The scripts are mine.** `merged2.py`'s LIVE label is "any artifact for the head *or its
  queue entry* recorded `runLive`"; a stricter definition (head only) gives 41 not 43. Both are
  reported so the re-verification can pick.
- **Not measured**: the world lock's dirty history (a cleared flag leaves no trace); whether any
  probe's restore actually landed (the code never checks, so neither could I). The
  `people-search` flow (10 nightlies, 4 routed artifacts) is absent from the `flows.ts` I read
  because that tree predates `b7a868bf` (08-31); resolved by the diff in §1, not a discrepancy.
- **Source lines were read from a working tree, not from `origin/main`** — see §1's source row
  for why that is equivalent for every file cited.
