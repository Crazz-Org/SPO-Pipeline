> **Status: action 8.1 deliverable, produced 2026-09-02 by a Fable 5.1 read-only sweep of the
> bench corpus (509 verdicts, 7,347 stage logs). Per the protocol 8.1 mandates, every finding
> here is UNVERIFIED until an Opus agent re-verifies it by running probes — with one exception:
> the removal of `bench/gate` from SPO-WebClient's branch ruleset was verified independently by
> the driver against `repos/Crazz-Org/SPO-WebClient/rulesets/21111153/history/{version}`, which
> returns `["typecheck + tests","bench/gate"]` for version 47551828 and `["typecheck + tests"]`
> for version 48039109. Treat everything else as a claim to be checked, not as fact.**

# Bench remediation plan — derived from the 8.1 measurement (2026-09-02)

Status: a derived plan, Fable half, **not yet Opus-verified**. It supersedes rows 8.2–8.7 of
`doc/remediation-plan-2026-08.md` (which call themselves "provisional scaffolding, not a
contract") and it answers the question Chantier 9 hangs on. Evidence is cited as `F<n>` into
`bench-audit-2026-09-02.md` (same directory). Convention as in that doc: **[observed]** /
**[anticipated]** / **[guess]**; "read:" vs "inferred:".

## What the measurement changed about the problem

The brief's framing was *one chantier, then migrate*. The corpus says three things that
re-shape it:

1. **The defect is a class, not an incident.** The `--live` downgrade (F1) is one member of
   "a PASS whose evidence is absent". The same corpus holds three more members nobody had
   listed: `bench/gate` is not required on `main` since 08-29T10:17Z, so every merge since has
   been on CI alone (F2, [observed]); 53 of 62 reused verdicts copy a PASS that never drove
   live, with no age bound (F4); and for 64 merged gates the artifact that would prove the drive
   is filed under a sha nobody knows (F6). A fix that repairs the flag and the binary leaves
   three of four members standing.
2. **The cause is deployment, not architecture.** The worker's only rebuild path is
   `scripts/finish.sh` step 4, which the pipeline never calls; the worker has `NRestarts=0`; the
   main checkout has sat on a feature branch since 08-30 (F7). Nothing in F1–F11 is caused by
   the bench living in `SPO-WebClient`; two things (F2, F7) are caused by the *pipeline* not
   doing what the sessions used to do (`finish`) and by a GitHub setting.
3. **The cost is real and it is not the live drive.** 89 % of gates replay a 37-second jest
   suite (plus typecheck and lint) that CI is running at the same moment; a CI-proven gate takes
   33 s, a replayed one 125–206 s (F3). The plan's baseline sentence — "the bench is NOT the
   current bottleneck" — stays true; the correction is that the bench is spending its time on
   the wrong stage while skipping the one it exists for.

So: **three chantiers, sequenced by dependency, and no migration.** The split is by *what can
be verified after it lands*, which is the rule C1–C7 used.

## Rows 8.2–8.7, judged one by one

| row | verdict | why (evidence) |
|---|---|---|
| 8.2 verdict carries live evidence; GATE refuses static-only | **supported, and it is the load-bearing row** | Would have parked issue-443 on 08-30T13:14Z and every card since (F1, §5 of the audit). Strengthened: the worker *already* opens the artifact per job (`countCapabilityExceptions(report.gateArtifact)`), so lifting `live` into the verdict is ~20 lines, not a schema project. Widened: the same field must feed `statusDescription` (GitHub shows "PASS — base …" with no live indicator) and the merge-queue reuse (F4). |
| 8.3 worker attests its own provenance; refuses to start when stale | **supported in intent, contradicted in mechanism** | `NRestarts=0` — a start-time check would not have fired once in 5 days (F7). The check has to run **per job**, comparing the binary's recorded build sha against `src/e2e/bench/**` + `scripts/verify-gate.js` at the job's fetched `origin/main`, and it has to cover `cli.js` too (same stale `dist/`). And provenance alone is the *cause* detector; 8.2 is the *class* detector — 8.3 is second, not co-equal. |
| 8.4 draw and freeze the boundary (versioned contract) | **supported, as the verdict schema v1 — not as a prerequisite for moving files** | The contract already exists de facto: `verdicts/<sha>.json` + `bench/gate` + exit codes 0–4 + `nightly/latest.json`. 8.2 versions it. Writing it down is a day; nothing else in this plan waits on it. |
| 8.5 move `src/e2e/bench/**` into `orchestrator/` | **contradicted — not the problem, and it would import the problem** | 0 of 8 defect classes are located in the repo boundary (F1–F11). The "infrastructure vs product knowledge" split puts `gateway.ts` (builds the product, starts its server on 8080), `checkout.ts` (`npm ci` of the product) and the merge-queue serving (a GitHub-side concern of the product repo) on the infrastructure side — they are product-coupled. The stale-binary class is a *deploy* defect; the pipeline has the same class on its own side (memory: "merging restarts the daemon — the `git pull` fires the hook, not the merge"), so moving the worker in would give it the daemon's restart hook, which is the thing 8.3 says is not a fix. `npm run gate`, `npm run dev` (lease), the merge queue and the nightly are used by humans and by the product repo's own CI story; a move breaks them for one consumer's convenience. **Recommendation: do not move. Re-decide after C8a–C8c have run for a week, on the measured park/reuse rates, not before.** |
| 8.6 live gate as a first-class pipeline step (timeouts, park reasons, retry budgets) | **half already built, half re-scoped** | Timeouts exist (`npm-gate` 7800 s, C2), the park legs exist (`gate-worker-down` / `gate-timeout` / `gate-non-attesting`, C4) — and **0 of them has ever fired** in 26 real gates (F1, journal). What is missing is routing on *verdict fields* instead of exit codes: `live.skipped` with routed flows → park; `verdict: BLOCKED` → park with the bench's reason, never DIAGNOSE (F8); a verdict older than the gate's own spawn time → treat as absent (F8, the pre-existing-verdict hole). That is 8.2's pipeline half, not a new state. |
| 8.7 nightly re-homed as a pipeline schedule | **not the problem** | The nightly is the one part of the bench that never stopped working: 51 live drives, 47 PASS, every one with `politics-write` on Helartia (F1, F10). Its two defects are classification — 4 "Internal server error" runs published as FAIL of `main` (F8), and `nightly-check.sh`/`nightlyMainRed` reading ENVIRONMENT as GREEN — both fixed in place in a morning. Owning its schedule from `orchestrator/` adds a second scheduler for a job that already queues correctly behind every gate. |

Two things none of the rows names, both structural causes rather than symptoms: **the ruleset**
(F2) and **the deploy path** (F7). Both are in C8a below.

**Consequence for Chantier 9**: since this plan does **not** move the bench into
`orchestrator/`, and C8's remaining spec/doc edits are confined to the GATE row of
`state-machine-spec.md`, `doc/environments.md` §pre-production and `orchestrator/README.md`'s
bench paragraph, C9's "after, not parallel" sequencing loses its stated force. **Re-plan C9 as
parallel to C8b/C8c**, with one exclusion: the three files just named are C8's until C8c's gate
is green.

---

## Chantier 8a — The gate tells the truth, and the merge listens to it

**Why first**: 19 of 19 pipeline cards since 08-30 merged on a gate that drove nothing (F1,
F5); every merge since 08-29T10:17Z would have gone through even if the bench had said FAIL
(F2). Until both are closed, no live recette in C8b/C8c can prove anything. Everything here is
small, mechanical and verifiable on the next real card; nothing here moves a file.

Two of the rows are **maintainer acts, not agent work**, and are listed because the gate cannot
be green without them.

| # | Action | Files |
|---|---|---|
| 8a.1 | **DECISION / maintainer act — restore `bench/gate` as a required status check** on ruleset 21111153 (it was, in version 47551828 of 08-25; removed 08-29T10:17Z by the maintainer's account, reason unrecorded — F2). Record the reason for the 08-29 removal in `doc/bench-worker.md` §11 either way. If the answer is "keep it advisory", then 8a.4's pipeline check becomes the *only* gate and the docs in 8a.6 say so. | GitHub ruleset (manual); `doc/bench-worker.md` |
| 8a.2 | **Maintainer act — rebuild and restart the worker from `origin/main`**: `git -C ~/SPO-WebClient checkout main && git pull --ff-only && bash scripts/bench-install.sh` (F7: the checkout is on `feat/suggestion-report-kind`, the binary predates `e180bfb6`, `NRestarts=0`). Do it **after** 8a.3 has merged so the first restarted worker already writes the honest verdict — the audit's evidence (pid 270's state) is not needed once Opus has re-verified F1/F7. | operator; `scripts/bench-install.sh` |
| 8a.3 | **The verdict carries the live evidence** (8.2, bench half). `worker.ts` `processOldest` reads `report.gateArtifact` (it already does, for `exceptions`) and copies into `verdicts/<sha>.json`: `live: {ran: boolean, status, flows: [{name,status}], routed: [...], skippedWhy}`, `static: {from: 'CI'|'replay'}`, and `artifact: <path>` + `artifactHead` (so the merge-commit artifact of F6 is reachable). `statusDescription` gains ` — live <n>/<m> flows` or ` — static only`, inside the 140-char budget. `BenchVerdict` in `verdict.ts` is the schema; bump a `schema: 2` field. Tests: `worker.test.ts` for a RAN, a SKIP-STATIC and a SKIP-NOFLAG artifact; `verdict.test.ts` for the description. | `src/e2e/bench/worker.ts`, `src/e2e/bench/verdict.ts`, `src/e2e/bench/*.test.ts` |
| 8a.4 | **GATE routes on the verdict, not the exit code** (8.2 pipeline half + the real content of 8.6). In `realGate`, after exit 0: read `verdicts/<HEAD>.json`; **park `gate-live-skipped`** when `live.ran === false` and `live.routed` is non-empty (detail: `skippedWhy`, the routed flows); **park `gate-static-only-unverifiable`** when the verdict predates this GATE's own spawn time (F8's pre-existing-verdict hole — compare `createdAt` to the spawn `ts`); accept exit 0 only with `live.ran === true` or `routed: []`. After exit 1: `verdict: BLOCKED` → park `gate-blocked` carrying the bench's own reason, never DIAGNOSE (F8). A verdict without `schema >= 2` (an old worker) → park `gate-verdict-unversioned` — which is the second, cheaper half of 8.3: **a stale worker cannot produce an acceptable verdict at all**. `gate-report.md` (action 1.3) renders the `live` block so VALIDATE sees it. Spec: GATE row rewritten; the three new park reasons added (7bis.1's sweep will demand it). | `orchestrator/steps/scripted.js` (`realGate`, `renderGateReport`), `orchestrator/state-machine.js`, `doc/state-machine-spec.md` (GATE row), `test/` |
| 8a.5 | **Per-job binary provenance** (8.3, corrected mechanism — F7). `build:e2e` stamps `dist/e2e/bench/build-info.json` `{sha, builtAt, sources: sha256 of src/e2e/bench/** + scripts/verify-gate.js + scripts/bench-*.sh}`; the worker records it in every verdict (`worker: {sha, builtAt}`) and, **on every `ref` job**, after `git fetch origin main`, hashes the same source set at `origin/main` and compares: mismatch → `ENVIRONMENT` with detail `worker binary <sha8> predates origin/main's bench sources — run scripts/bench-install.sh`, and a log line every tick until it is fixed. `cli.ts` performs the same comparison at `submit` and prints a warning (it cannot refuse: the fix is the worker's). Tests inject the hash function. | `src/e2e/bench/worker.ts`, `cli.ts`, `paths.ts` (build-info path), `package.json` (`build:e2e`), `src/e2e/bench/*.test.ts` |
| 8a.6 | **The pipeline's FINISH does what `finish.sh` did for the worker.** `realFinish` (or the dispatcher, after a merge lands on `main`) runs the two `finish.sh` steps the sessions used to run: fast-forward the main checkout, and `bash scripts/bench-install.sh` when the merge touched `src/e2e/bench/**`, `scripts/verify-gate.js` or `scripts/bench-*.sh` (F7: the only deploy path, never called since 08-29). Behind `withProductRepoLock`; journaled `bench-reinstalled` / `bench-reinstall-failed` (the latter parks nothing — the next gate's 8a.5 will refuse honestly). **Trap**: the restart SIGTERMs a running job only if one is in flight — do it when `~/.spo-bench/running/` is empty, else defer to the next FINISH. | `orchestrator/steps/scripted.js` (`realFinish`), `orchestrator/dispatcher.js`, `test/` |
| 8a.7 | **Docs stop claiming what 8a.1 decides**: `CLAUDE.md:472-475`, `doc/bench-worker.md:170,276,283-285,500`, `doc/E2E-POLICY.md:9,62,95`, `.claude/hooks/pre-push-gate.sh` (its comment block about ruleset 21111153 — the hook is unchanged otherwise; it is a sensitive file, so the comment edit is a **product-repo PR by the maintainer**, not an agent edit), `doc/environments.md` §pre-production (add the verdict schema as the contract — 8.4's real content). 7bis.6's sibling grep applies: `bench/gate` ×5 files. | `SPO-WebClient/CLAUDE.md`, `doc/bench-worker.md`, `doc/E2E-POLICY.md`, `SPO-Pipeline/doc/environments.md`, `orchestrator/README.md` |

**Gate C8a**: full suite green in both repos + a supervised `spo recette` card whose diff
**routes to `login-spine+building-details`** (touch a file under `src/server/ws-handlers/`),
whose verdict shows `live.ran: true` with both flows named, whose `bench/gate` description says
`live 2/2 flows`, and which **cannot merge until that status is green** (8a.1) + the same
recette against a **deliberately stale worker** (rebuild from `origin/main~1` of a bench-source
commit, do not restart after the next merge): the gate parks `gate-live-skipped` or the worker
attests `ENVIRONMENT` (8a.5), never PASS + `journal/*/journal.jsonl` shows `bench-reinstalled`
after the merge of a PR touching `src/e2e/bench/`.

---

## Chantier 8b — The evidence survives, and reuse is honest

**Why second**: C8a makes the next gate truthful; this makes the *record* truthful, so the
next audit is a script instead of a reconstruction, and so the merge queue's reuse cannot
launder a static PASS into a live one. Nothing here changes what a gate does to planitia.

| # | Action | Files |
|---|---|---|
| 8b.1 | **Reuse only what was proven, and not forever** (F4). `mayReuseVerdict` requires the source `live.ran === true` **or** the entry's own routing to be empty — a static-only source may only satisfy a static-only entry; adds an age bound (`REUSE_MAX_AGE_MS`, default 6 h — the max observed gap is 136 min; a tunable stated as such) and refuses when a **nightly FAIL** sits between source and entry (the world may have changed in a way `main` noticed). The copied verdict carries `reusedFrom`, `reusedAt`, and the source's `live` block verbatim; the `why` string says "static-only, nothing to re-drive" when that is what happened. Tests: the four combinations. | `src/e2e/bench/merge-queue.ts`, `worker.ts` (`mergeQueueDeps.reuse`), `merge-queue.test.ts` |
| 8b.2 | **The artifact is filed under the sha that was deposited** (F6). `verify-gate.js` accepts `--attest-head=<sha>`; the worker passes `request.fingerprint.head`; the artifact is `gate-<attest-head>.json` and records `mergeCommit: <HEAD>` and `mergedBase`. 56 orphans stop being produced; the 30 verdicts with no artifact are a historical gap, noted in the doc, not repaired. | `scripts/verify-gate.js`, `src/e2e/bench/worker.ts`, `src/e2e/verify-gate.test.ts` |
| 8b.3 | **Retention that an audit can use** (F6). `done/` keeps reports 30 d (logs may stay at 24 h — they are 100 KB–1 MB each); `verdicts/` gains a purge at 30 d **with** an index line appended to `~/.spo-bench/verdicts.jsonl` on every write (head, verdict, live.ran, reusedFrom, jobId, createdAt) so the count survives the purge and `listVerdicts` stops reading 500 files per idle tick; `run-history.json` keeps 30 d and the nightly passes `--branch=main`. | `src/e2e/bench/worker.ts` (`DONE_RETENTION_MS`), `verdict.ts`, `job.ts`, `nightly.ts`, `paths.ts` |
| 8b.4 | **The test suite stops writing into the live bench** (F6: 7,040 of 7,172 stage logs). `verify-gate.test.ts` (and any test that executes `verify-gate.js`) sets `SPO_BENCH_DIR` to a `mkdtemp`; `captureStage()` refuses `$HOME/.spo-bench` when `JEST_WORKER_ID` is set — belt and braces, since the bench replays this suite on itself. One-time cleanup of `logs/` is an operator act (119 MB, 6,714 empty files), not a script. | `src/e2e/verify-gate.test.ts`, `scripts/verify-gate.js`, `src/e2e/pre-push-gate.test.ts` |
| 8b.5 | **Server errors are ENVIRONMENT, not a red `main`** (F8). In `run.ts`, a flow whose `error` is a gateway/RDO transport failure (`Internal server error`, connect/timeout classes — enumerate from the 4 nightlies and `ws-driver.ts`'s error shapes) with zero failed assertions sets `status: ENVIRONMENT` for the run, exit 3; `nightly-check.sh` and `scripted.js`'s `nightlyMainRed` gain a third state `UNKNOWN` for ENVIRONMENT/INTERRUPTED (exit 2, "proved nothing") instead of GREEN — the pipeline treats UNKNOWN like today's GREEN for merging but journals `main-status-unknown` so it is visible. Tests: the four nightlies' shapes. | `src/e2e/run.ts`, `src/e2e/flows.ts` (`runFlow`), `scripts/nightly-check.sh`, `orchestrator/steps/scripted.js`, `src/e2e/run.test.ts`, `test/` |
| 8b.6 | **The probe verifies its restore** (F10). `probe.ts` `restore()` awaits the Survival marker for the restore write (same window mechanism) and reads the value back once; `restored` is true only on the marker; a missing marker marks the world dirty (`lock.addPendingRestore` stays until proven). Read-back stays informational (OB-29). | `src/e2e/probe.ts`, `src/e2e/probe.test.ts`, `doc/E2E-POLICY.md` §5 |
| 8b.7 | **`bench:status` reports what an operator needs** (F2, F7, F10): worker binary sha vs `origin/main` bench sources, ruleset's required checks (`gh api …/rules/branches/main`, read-only), `BENCH_OWNER` holder, last nightly with its classification, queue depth, count of verdicts with `live.ran` in the last 24 h. `spo status` (5.4) shows the same three lines. | `scripts/bench-status.sh`, `src/e2e/bench/cli.ts`, `bin/spo` |

**Gate C8b**: full suite green + a merge-queue entry whose tree equals a **static-only** PR-head
verdict is *reused* with `why` = "static-only" and `live.ran: false`; one whose tree equals a
**live-driven** head is reused with the source's `live` block; one older than the age bound is
**gated** + a gate on a branch that merges `origin/main` files its artifact under the deposited
sha + a full jest run on the bench adds **0** files to `~/.spo-bench/logs` + a nightly against a
gateway returning `Internal server error` publishes `ENVIRONMENT` and `nightly-check.sh` exits 2.

---

## Chantier 8c — The bench spends its time on the live stage

**Why third**: it is the only chantier that changes the pipeline's state order, so it rides on
a gate that is already truthful (C8a) and a record that can show the saving (C8b). It is also
the row most likely to be *contradicted* by measurement, which is why it is last: the C6 funnel
(18.6 % of card cycle on the bench) was computed with a gate that skipped the live stage; a real
live drive adds 30–90 s per flow set (nightlies with 7–8 flows take ~210 s) — **measure the
post-C8a gate before building this**.

| # | Action | Files |
|---|---|---|
| 8c.1 | **Measure first** (execution rule "measure, don't review"): over the first 10 post-C8a gates, record from the verdict `static.from`, `live.ran`, flow count, and from the journal `ms`. Decide 8c.2 on the numbers: if a live gate with CI proof is under ~90 s, the static wait is worth it; if the live stage dominates, it is not. | `doc/remediation-progress.md` (the numbers) |
| 8c.2 | **GATE waits for CI's static proof before submitting** (F3). Reorder or split: `PUSH_PR → CI_STATIC (bounded wait for `typecheck + tests`, reusing 1.7's poll loop) → GATE → CI_CHECKS (the remaining checks)`. The bench then takes `--skip-static --static-from=ci` on every pipeline gate; a CI failure routes by the existing cause table **before** the bench is paid for. Expected: ref job 125–206 s → 33 s + live. Spec: the state table gains the split; `mainMovedRegateBudget` accounting unchanged. | `orchestrator/state-machine.js`, `orchestrator/steps/scripted.js`, `doc/state-machine-spec.md`, `test/` |
| 8c.3 | **A President-member diff is a live question the pipeline can ask** (F8/F10). With `--live` back, `capabilities.length > 0` runs the capability read; the pipeline treats `exceptions > 0` as PASS-with-record and posts the exception block (already in the artifact) to the PR — 5.3's PASS_WITH_FINDINGS channel. No new bench code; one pipeline read. | `orchestrator/steps/scripted.js`, `orchestrator/state-machine.js` |
| 8c.4 | **`doc/environments.md` says what is enforced** (F10): mutations on Helartia by construction for one flow, account-scope writes for two, credentials public by acknowledgement, rate limiter off by decision, lease enforcement earned, restore verified since 8b.6. Replace the four bullets with the F10 table's "enforced by" column. | `doc/environments.md`, `SPO-WebClient/doc/E2E-POLICY.md` §6/§9 |

**Gate C8c**: full suite green + 10 consecutive pipeline gates with `static.from: CI` and
`live.ran: true` where routed + the measured bench time per card in
`doc/remediation-progress.md`, compared against C6's 18.6 % + `spo recette` all scenarios.

---

## What is deliberately NOT in this plan

- **Moving `src/e2e/bench/**` into `orchestrator/`** (8.5) — see the row-by-row table. The
  boundary is written down (8a.7) and versioned (8a.3, `schema: 2`); that is what lets the two
  repos evolve independently, and it costs a day. The move would cost weeks, and the corpus
  shows no defect it would fix.
- **A pipeline-owned nightly** (8.7) — the nightly works; its classification is fixed in 8b.5.
- **Turning the rate limiter back on** — a maintainer decision from 08-22 ("the queue is the
  throttle"); the corpus shows peak 38 live gates + 21 nightlies in a day with no server-side
  refusal recorded. Note it in 8c.4; do not change it.
- **Rotating the LOCKED credentials out of the public repo** — a product-repo security decision
  the maintainer has already taken the other way (the `accounts/` file says so); recorded, not
  re-litigated.
- **Repairing the 30 artifact-less verdicts and the one durable ENVIRONMENT→FAIL** (F6, F8) —
  historical; the 24 h purge that hid them is what 8b.3 changes.

## Order and sizing

C8a is one PR per repo (product: 8a.3, 8a.5; pipeline: 8a.4, 8a.6, 8a.7) plus two maintainer
acts, and it can start the day the Opus re-verification confirms F1, F2 and F7. C8b is two PRs
(product: 8b.1–8b.6; pipeline: 8b.5's guard, 8b.7). C8c is one pipeline PR after 8c.1's
numbers. **Chantier 9 runs in parallel from C8b on**, with the three-file exclusion above.
