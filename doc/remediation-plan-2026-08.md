# Pipeline remediation & optimization plan — audit of 2026-08-30

Produced by the multi-agent audit of 2026-08-30: 9 reader-auditors, one per subsystem
(123 raw findings), 16 adversarial verifications (11 confirmed, 5 partially corrected,
0 refuted), cross-checked against the real run journals (`journal/`, 15 cards, 91 LLM calls,
$131.60), then reviewed by a 3-critic panel (completeness, architecture, parallelization
design) whose corrections are folded in. This document is the **execution contract** for the
production phase: one work package (chantier) at a time, fully tested before moving to the
next.

## The pipeline's objective, restated

A GitHub card enters `Todo` and leaves either as `Done` with a merged PR, or parked with a
reason — no human in the loop except at the decision points (confirm/discard on bug reports,
retry/abandon on parks). Promotion criterion (spec §Shadow mode): parking rate < 15% and
weighted cost per merged card below the baseline (~$12/session of the old driver).

## Measured baseline (real journals, 2026-08-29/30)

- **Economics**: $131.60 across 91 calls. PLAN = 52% ($67.85), of which **$24.4 (36% of PLAN
  spend) is re-planning after a park** (retry restarts at INTAKE). **46% of total spend went
  to the 4 cards that never merged.** Cost per merged card ≈ $13.2 (above the $12 baseline);
  clean merges ≈ $7.1. Card parking rate: 27% (target < 15%).
- **Latency**: 77.3h of the 85.5h wall-clock corpus = **waiting for a human reply after a
  park**. Active time is LLM-dominated (IMPLEMENT 3.0h, PLAN 1.6h). GATE = ~2.5 min/run
  (0.68h total): **the bench is NOT the current bottleneck** — and it has its own queue
  (`~/.spo-bench/spool` → `running`), so "one live world" serialization is already enforced
  outside the pipeline.
- **Test truthfulness**: the `node --test` suite is 100% hermetic (no real spawn anywhere) —
  4 production bugs sailed through it green in 48h (E2BIG #452, deadline-kill #449, missing
  placeholder #443, head=base #247). Real VALIDATE verdicts did drive transitions, but were
  rendered **without their declared inputs** (`diff.patch`, `gate.log`, `gate-report.md` are
  never written); CITATION_VERIFIER has **never been executable** in real mode (citations
  never populated → systematic park, observed on issue-385) and **fails open** when its call
  errors.
- **Journal**: 46% of the corpus's lines are `unpark-scan-failed` spam (gh polled every 5s
  with no timer or backoff; a continuous 2h04 outage of the retry channel on 08-30).

## Execution rules for the chantiers

1. **One chantier at a time.** Chantier N+1 does not start until chantier N's test gate is
   green.
2. **One action = one subagent.** Every action is specified with its target files so a
   **Sonnet** subagent can execute it with no conversational context — its tests are part of
   the action. **Verification** of each action (adversarial diff review + running the
   targeted tests) is done by an **Opus** subagent. The driver (production session) stays the
   architect: it decomposes, reviews the verifications, and settles edge cases. Items marked
   **DECISION** are never delegated: the driver frames them and has the maintainer decide
   before dispatching the mechanical half.
3. **Chantier gate**: full replay suite green (`node --test`) + `daemon.js --dry-run` on a
   synthetic card + the listed specific checks. Gates marked *(live recette)* require a real,
   maintainer-supervised card — the driver stops and explicitly asks for it. From chantier 3
   on, the live recette goes through the `spo recette` harness (action 2.9).
4. **Every behavior change** is reflected in `doc/state-machine-spec.md` /
   `orchestrator/README.md` within the same action — when an action amends a specific spec
   line, that file is listed in its Files column.
5. One commit per action, one PR per chantier (`gh api ... -X PATCH` to edit a PR, never
   `gh pr edit`). Line numbers in this plan date from the audit: two actions touching the
   same region (e.g. 2.7 rewrites the comment-scan area) are sequenced rebase-aware, with
   the driver re-resolving anchors.

---

## Chantier 1 — Truthful judges (fail-closed + real inputs)

**Why first**: as long as DIAGNOSE/VALIDATE judge without inputs and the citation verifier
passes silently on failure, no downstream verdict can be trusted — everything else in this
plan leans on those verdicts.

| # | Action (Sonnet executes, Opus verifies) | Files |
|---|---|---|
| 1.1 | **Fail-closed CITATION_VERIFIER**: `cv.ok === false` or missing `verdict` → `ParkSignal('citation-verifier-failed')`, never a default PASS. Cover the WHOLE branch (PASS/REJECT/DIVERGES/error/absence) — zero tests exist today. | `orchestrator/state-machine.js:421`, `test/` (new) |
| 1.2 | **Populate `citations`**: `realPushPr` stores the extracted citations on `ctx.task.citations` in addition to the `rdo-citation` journal event; `task-values.js` reads the journal event as fallback (survives a restart). Test: simulated RDO card driven to VALIDATE. | `orchestrator/steps/scripted.js:543`, `orchestrator/task-values.js:136` |
| 1.3 | **Judge inputs, conditional on entry point**: the diff is generated **on DIAGNOSE/VALIDATE entry** (`git diff origin/main...HEAD` for committed work, plain `git diff` for the pre-commit case — DIAGNOSE is reachable from CHECK-fail/empty-implement BEFORE any push, and must never park for a missing gate.log there; the spec says "CHECK Failure → DIAGNOSE, never PARKED"). `gate.log` = **a copy of the LAST gate run's output** (not `logs/GATE.log`, which accumulates across visits); required only when arriving from GATE. `gate-report.md` from `~/.spo-bench/verdicts/<sha>.json` when present. VALIDATE requires `diff.patch` (always available post-PUSH_PR) and parks `judge-inputs-missing` otherwise. | `orchestrator/steps/scripted.js`, `orchestrator/state-machine.js`, `orchestrator/task-values.js:16-41` |
| 1.4 | **Transport-failure routing**: in handlePlan/handleImplement/handleValidate/handleDiagnose, `result.ok === false && (kind === 'error' \|\| timedOut)` → `ParkSignal('llm-transport-failed:<STEP>')` with the detail — never DIAGNOSE, never `plan-invalid`/`validate-unrecognized-verdict`. (issue-452: three Fable diagnoses, $1.75, paid to diagnose a $0 E2BIG.) `kind:'limit'` unchanged here (rotation) — the classifier itself is hardened in 3.5. | `orchestrator/state-machine.js:186,243,427` |
| 1.5 | **Honor the `root_cause: null` contract**: a DIAGNOSE replying "no new cause" → `ParkSignal('diagnose-no-new-cause')` instead of fabricating `unspecified-cause-N` and paying another IMPLEMENT (observed on 213/428/452). | `orchestrator/state-machine.js:382` |
| 1.6 | **REJECT threading**: a VALIDATE REJECT's `reasons`/`findings` go to the ledger AND into the next IMPLEMENT's `{{diagnosis}}` (same mechanism as the existing DIAGNOSE→IMPLEMENT fix). | `orchestrator/state-machine.js:432`, `orchestrator/task-values.js` |
| 1.7 | **In-flight CI ≠ green**: `conclusion: null` or zero check-runs → bounded wait (re-poll ×N with sleep) then route via the cause table; stop advancing toward MERGE with CI still running (8 of 12 real "green" events had `claude review` still in progress). | `orchestrator/steps/scripted.js:695` |
| 1.8 | **Invariants** — **DECISION first**: keep or drop the spec's promise (§CHECK, substring check of the PLAN's `invariant_ids`, never implemented). If kept: define the exact scan target (diff? test files? check output?) then dispatch the mechanical half. If dropped: amend spec + prompts (plan.md). | `orchestrator/steps/scripted.js:424`, `doc/state-machine-spec.md`, `prompts/plan.md` |

**Gate C1**: full replay + dry-run + *(live recette)* one S-sized `touchesRdoMembers` card
with **one provoked failure** (e.g. a gate fail) so DIAGNOSE runs with its real inputs;
assertions: CITATION_VERIFIER actually executes, VALIDATE reads `diff.patch`.

---

## Chantier 2 — Daemon robustness + live harness

**Why before economics**: "every step has a wall-clock deadline" is currently false in real
mode (GATE observed at 129–240s past the "enforced" 120s; a hung `gh` freezes the daemon
forever while holding the lock) — and chantier 3's unattended soak is impossible until that
is fixed. This chantier also builds the recette harness reused by every later one.

| # | Action | Files |
|---|---|---|
| 2.1 | **Real timeouts for scripted steps**: `spawnStep` arms `spawnSync.timeout` per command class (git 120s, npm ci 600s, gate 900s, gh 120s). **Known trap**: spawnStep maps `status:null` → exit 1 — branch on `result.signal`/`result.error` BEFORE the exit mapping, or a timeout-killed GATE reads as "gate fail" and pays a DIAGNOSE (the very anti-pattern 1.4 removes). Contracted real-mode test: injected spawn asserting the timeout option AND the kill→retry-once→park bookkeeping. | `orchestrator/steps/scripted.js:78-101`, `orchestrator/config.js`, `test/` |
| 2.2 | **http.js: fix the truncation hang** (oversize response → destroy without settling → remote-pull loop silently dead). | `orchestrator/http.js:48` |
| 2.3 | **Orphan repark restores `worktreePath`** from the state.json snapshot so `preserveWorktreeWip` actually runs (today a guaranteed no-op — the sweepWorktreeLeftovers net on the next retry remains, but costs one extra park cycle). | `orchestrator/orphan-scan.js:99` |
| 2.4 | **orphanScan outside --real**: a `--shadow`/`--dry-run` start against the live journal root must no longer convert real orphans into anchor-less, comment-less parks. | `orchestrator/daemon.js:233`, `orchestrator/orphan-scan.js` |
| 2.5 | **Atomic writes**: `state.json` via tmp+rename; lock creation via write-tmp+link (the empty file readable between open and write is currently sweepable as stale). | `orchestrator/journal.js:34`, `orchestrator/lock.js:78` |
| 2.6 | **Triage mutex**: rename `pending/<f>.json` → `in-progress/` BEFORE the LLM call (same idiom as takeNextTask) — kills the concurrent daemon-vs-`spo triage` double-triage (#443: filed AND held 20s apart, PR #447 closed by hand). | `orchestrator/auto-triage.js:107`, `orchestrator/report-intake.js` |
| 2.7 | **Unified comment-scan rewrite** (unparkScan + reportConfirmScan): pagination (`per_page=100` + page loop, filter `id > anchor`), **author allowlist** (repo collaborators, read once and cached — retry/abandon/confirm/discard no longer honored from any commenter), backoff on consecutive failures, dedicated timer (60s). Note: timer cadence is only guaranteed after C6 (the single-threaded daemon blocks inside steps) — the gate asserts per-cycle behavior, not cadence. | `orchestrator/park-loop.js:232-266`, `orchestrator/report-intake.js`, `orchestrator/state-machine.js:751` |
| 2.8 | **Retry priority**: name retry files so they sort BEFORE fresh cards (`0000-retry-…`), per park-loop's own comment and the spec (observed bounded inversion: at most autoPullLimit cards). | `orchestrator/park-loop.js:211-220` |
| 2.9 | **`spo recette`**: supervised live harness — one trivial synthetic card end-to-end in `--real` against a dedicated test issue, capped budget, automatic cleanup, assertions on the produced journal. Becomes the standard live gate for chantiers 3+. | `bin/spo`, `orchestrator/` (new module), `test/` |

**Gate C2**: replay + chaos tests (kill -9 mid-step, simulated hung child via injected spawn,
double start, lock takeover) + green `spo recette`.

---

## Chantier 3 — Stopping the token hemorrhage

**Why**: 36% of PLAN spend re-paid, an infinite triage loop (2.5h of 300s sessions on report
#449, down to pool exhaustion), $12 burned on a structurally impossible card (#428).

| # | Action | Files |
|---|---|---|
| 3.1 | **Resume after park**: `realWorktree` journals the **`origin/main` sha** in a readable event (today the rev-parse output is discarded — there is nothing to compare against at retry time); on unpark-retry, if `journal/<id>/scratch/plan-*.md` exists AND the sha has not moved, handlePlan short-circuits by re-journaling the existing paths — otherwise re-PLAN. `reEnqueueTask` only carries the sha forward. Measurable saving: ~$24 on the corpus. | `orchestrator/steps/scripted.js` (realWorktree), `orchestrator/state-machine.js:181`, `orchestrator/park-loop.js` |
| 3.2 | **Protected-files guard**: after PLAN, scan `plan_markdown` (and the criterion at intake) for `.claude/settings.json` / `.claude/hooks/` → `ParkSignal('plan-requires-protected-files')` BEFORE paying IMPLEMENT (CLAUDE.md already documents this hard wall; #428 = $12.01). | `orchestrator/state-machine.js` (handlePlan), `orchestrator/intake.js` |
| 3.3 | **Auto-triage cap + backoff**: per-report mechanical-failure counter (journaled `report-triage-error` events, counted); after 3, a **distinct mechanical hold** (`report-held-mechanical`, dedicated comment — not the "reproduction did not confirm" text); exponential backoff between cycles for the same report. | `orchestrator/auto-triage.js:107-244` |
| 3.4 | **Recovery path for a held report**: `spo triage --retry <issue>` re-injects a held report (mechanical or do-not-file) into the flow — today a confirmed dead end. | `orchestrator/auto-triage.js:113`, `bin/spo` |
| 3.5 | **Reliable `limit` classifier**: `kind:'limit'` only on `api_error_status === 429` or a structured `terminal_reason` — never again the `/limit\|overloaded\|rate/i` substring over free text (any message containing "rate" re-pays the full step on EVERY account, then cools the entire pool for 1h). Settle the default cooldown duration (the CLI's `retryAfterMs` does not exist — the hint is dead code): align it with the real observed windows (5h session). | `orchestrator/steps/llm.js:146`, `orchestrator/accounts.js` |
| 3.6 | **Intake plays by daemon rules**: account rotation + `markLimit` on `kind:'limit'` (draftCard/reviewCard/triageBugReport currently re-pick the same rate-limited account every cycle). Builds on 3.5. | `orchestrator/intake.js:111,628-661` |
| 3.7 | **`--max-budget-usd` caps** — **DECISION first**: their removal is a recorded maintainer decision (step-contracts.js:34, "Claude Max, no overage risk") that this audit proposes to reverse as a runaway guard (IMPLEMENT at $5.06/134 turns observed). If restored: p95 calibration (PLAN $6, IMPLEMENT $8, judges $3, intake $3) + a **distinct** park reason `step-budget-exceeded` (after 1.4, a budget kill would otherwise park as `llm-transport-failed`, semantically wrong). If kept as-is: align spec/config/README, which all still promise caps that don't exist. | `orchestrator/step-contracts.js:34-55`, `doc/state-machine-spec.md`, `orchestrator/config.js:261` |

**Gate C3**: replay + simulated resume scenario (park→retry without re-PLAN) + **unattended
24h soak** (now possible: C2 made the daemon hang-proof) watching `spo cost` and the absence
of journal spam.

---

## Chantier 4 — Correct remediation loops (main-moved, CI, transients)

**Why**: the main-moved path — 4 of 16 measured sessions needed it — is a confirmed
deterministic trap (PUSH_PR park, then a `branch-unmerged-leftover` loop on retry), and the
77h of human wait time includes purely transient parks.

| # | Action | Files |
|---|---|---|
| 4.1 | **Fix the post-merge PUSH_PR trap**: commit exit≠0 + clean tree (`git status --porcelain` empty) + `HEAD != origin/main` → skip the commit, proceed to push (CI_CHECKS's merge commit already exists). Keep the park for the historical HEAD==origin/main case (empty implement, issues 213/247/385). Also fixes the retry loop (`branch-unmerged-leftover`: the local merge never pushed is covered by no sweep rule). | `orchestrator/steps/scripted.js:505-520` |
| 4.2 | **GATE-fail with main moved**: **pre-check first** — does the bench write `verdicts/<sha>.json` (with `baseMain`) for a FAILED run? If not, derive baseMain from the `origin/main` sha journaled by 3.1. Then: before routing exit 1 to DIAGNOSE, run the main-moved intersection test (same logic as CI_CHECKS); if main moved → merge→CHECK directly, without spending the diagnose budget (issue-439: budget exhausted on a conflict IMPLEMENT is structurally unable to resolve — confirmed). Amend the spec's CI_CHECKS row. | `orchestrator/steps/scripted.js:644-655` (reuses `:705-744`), `doc/state-machine-spec.md` (GATE/CI_CHECKS rows) |
| 4.3 | **CI cause table aligned** with the product repo's real check names + a budget counter for CI-driven IMPLEMENT retries (today free and ledger-less). | `orchestrator/ci-cause-table.js`, `orchestrator/state-machine.js` |
| 4.4 | **Auto-retry for transient parks**: `claim-rate-limited`, network push/fetch → N spaced retries (journaled backoff) before a terminal park — cuts human wait without widening the catch-all (an explicit allowlist of reasons, no generic retry). Amend spec Principles 2/5 (the catch-all stays the error policy; this is an explicit allowlist). | `orchestrator/steps/scripted.js:415`, `orchestrator/state-machine.js` (finalizePark), `doc/state-machine-spec.md` (Principles 2/5) |
| 4.5 | **Complete ABANDONED**: cleanup (worktree remove, local+remote branch, close any open PR), visible state in `spo status`/`spo parked`/dashboard (today invisible or counted as PARKED everywhere; the leaked #443 worktree). | `orchestrator/park-loop.js`, `bin/spo:192-206`, `console/collect.js` |

**Gate C4**: replay (main-moved ×2 and transient scenarios) + *(live recette via 2.9)* one
card with a provoked main-moved (merge a trivial PR while the card sits at GATE).

---

## Chantier 5 — A truthful kanban & observability

**Why**: the maintainer steers from the board and the issue comments; every board/reality gap
costs a human intervention (the measured #1 bottleneck).

| # | Action | Files |
|---|---|---|
| 5.1 | **Missing board moves**: pre-worktree park moved via direct `gh api graphql` (`updateProjectV2ItemFieldValue` mutation, field ids in `doc/board-audit.md` — no product cwd needed); DIAGNOSE activity surfaced (a "diagnosing, attempt N/3" comment or a dedicated column — driver decision); drop the redundant move on every IMPLEMENT retry. | `orchestrator/board.js`, `orchestrator/state-machine.js:239` |
| 5.2 | **Tokens and duration on the card** (unit updated 2026-08-31: dollars retired as the headline metric — see the token-accounting rewrite): enriched final Done comment (billable-weighted tokens, duration, attempt count — billable tokens are already summed at FINISH, `sumJournalBillableTokens`); park comments carry cumulative billable tokens + attempt history. | `orchestrator/steps/scripted.js:789`, `orchestrator/park-loop.js` (buildParkComment) |
| 5.3 | **PASS_WITH_FINDINGS routed**: validator findings produce a structured PR comment (and optionally a follow-up draft card) instead of being journaled then lost. Same for the citation verifier's DIVERGES verdict. | `orchestrator/state-machine.js:429` |
| 5.4 | **`spo status` per spec**: bench queue depth (`~/.spo-bench/spool`), account health + cooldowns, today's spend; `llm-call` events gain `duration_s`. | `bin/spo:192`, `orchestrator/steps/llm.js:518` |
| 5.5 | **Dashboard**: consistent week KPI, generation timestamps, synthetic tasks excluded from all-time stats. | `console/collect.js:263`, `console/render.js:750` |

**Gate C5**: replay + *(live recette via 2.9)* following the board at every transition — zero
board/journal divergence tolerated on the happy path.

---

## Chantier 6 — Pipelined parallelism (K workers, the bench funnel)

**Why second-to-last**: a large refactor — it must land on a stabilized (C1–C4) and
observable (C5) base. **Funnel analysis**: the bench already serializes itself (spool/running
queue, `bench-submit --wait`); at ~2.5 min per gate against 30–45 min of LLM work per card,
K=3 workers target ~3× throughput — **reduced by re-gate churn**: every FINISH can send up to
K−1 in-flight cards back through CHECK→GATE (see 6.5). The limiting factor becomes the
account pool (K ≤ healthy accounts, dynamic).

**Architecture decision (panel-endorsed)**: **worker processes**, NO global async refactor.
`spawnSync` stays INSIDE the workers (llm.js's spawnSync-timeout doctrine — "an async race
abandons the loser, leaving an orphaned `claude -p` still spending" — remains valid); timer
starvation only afflicts the dispatcher, which no longer runs any step. A handler bug crashes
ONE worker, not K tasks (the "a bug crashes the daemon loudly" doctrine is preserved).
Actions 6.5–6.7 are **design consequences** of parallelization (spec §Account pool + the
one-re-merge invariant), not remediations of observed defects: their defaults (e.g. the
counter of 2) are tunables with no journal evidence behind them.

| # | Action (execution order is mandatory) | Files |
|---|---|---|
| 6.1 | **Worker mode + crash doctrine**: `daemon.js --worker <taskDir>` runs ONE task (runTask) and exits. `state.json.owner` becomes `{host, workerPid, workerStartedAt}` (startedAt disambiguates pid reuse). Worker crash with a live dispatcher → the dispatcher's exit handler is authoritative and reparks (`worker-crashed`, exit code in detail); the periodic orphanScan SKIPS any task in the live-worker table (else double-repark). Dispatcher crash → workers die with it (systemd `KillMode=control-group`, the default) and the restart's orphanScan recovers them. Each worker in its own **process group** (kill(-pid) takes the `claude` child with it — a killed worker never orphans a still-spending call). Circuit breaker: N consecutive worker crashes → the dispatcher exits non-zero (a state-machine bug stays loud, not a repark treadmill). | `orchestrator/daemon.js`, `orchestrator/orphan-scan.js`, `orchestrator/state-machine.js` (snapshot) |
| 6.2 | **Account leases + atomic pool state**: per-account lease files under the pool dir (`{pid, startedAt}`, swept by the same pid-liveness idiom as lock.js); `pick()` excludes accounts leased by another live pid; cooldowns written atomically (one file per account, or tmp+rename+merge — `markLimit` is today an unlocked read-modify-write that loses concurrent cooldowns). Mid-task rotation: the worker leases the next healthy unleased account, parks `all-accounts-cooling` only when none exists. Cooldowns stay pool-global (a rate limit is per account, not per worker). The dispatcher re-checks K ≤ healthy accounts before EVERY spawn. | `orchestrator/accounts.js:183-232`, `orchestrator/state-machine.js:82-114` |
| 6.3 | **Dispatcher**: main loop — takes up to K tasks, spawns the workers (plain async `spawn` on the dispatcher side, no generalized wrapper), awaits their exits; the single-instance lock stays with the dispatcher; its own short calls (auto-pull, scans) stay spawnSync. **daemon.jsonl multi-process policy decided and documented**: either small O_APPEND lines (park detail stays `{id, reason, lastState}`), or worker events relayed through their exit summary and written only by the dispatcher — pick one. **The taskDir single-writer invariant written down**: dispatcher-side scanners only touch a taskDir that is terminal or whose owner is dead (the live-worker table enforces it). `worker-spawn`/`worker-exit` events journaled. | `orchestrator/daemon.js`, `orchestrator/state-machine.js` (parallel drainQueueOnce), `orchestrator/journal.js` |
| 6.4 | **Product-repo mutex**: serialize the WORKTREE-setup phase (fetch, worktree add/prune, branch -D, npm ci) and FINISH-teardown (worktree remove) behind a bounded lockfile (lock.js's `wx` idiom) — K concurrent fetches/worktree mutations on the same clone contend on `.git` locks (FETCH_HEAD, packed-refs, .git/worktrees) and would spuriously park as `worktree-fetch-failed`/`worktree-add-failed`; K simultaneous `npm ci` runs spike disk/CPU. | `orchestrator/steps/scripted.js:361-418,833-841`, `orchestrator/lock.js` (reused) |
| 6.5 | **Multi-card main-moved & merge policy**: `mainMoveUsed` → configurable counter (default 2, a tunable with no journal evidence) with re-gate; GATE timeout must cover bench-queue wait (K×duration — or have bench-submit report queue position so the deadline arms at run start, not submit). **DECISION to settle**: the GitHub merge queue serializes LANDING, not semantics — two cards with disjoint files but interacting behavior can merge without a cross re-gate (the main-moved test is a file intersection). Options: accept explicitly (backstop = the nightly) OR a dispatcher-held MERGE admission token (one card between CI_CHECKS-green and FINISH at a time). Amend the spec ("once; a second move → PARKED", CI_CHECKS row). | `orchestrator/state-machine.js:362`, `orchestrator/config.js`, `doc/state-machine-spec.md` (CI_CHECKS row) |
| 6.6 | **Intake/auto-pull adapted**: explicit invariant "in-flight + queued ≤ K" (auto-pull fills to the watermark — autoPullLimit's old meaning relied on the awaited drain, which disappears); `makeTask` checks `journal/` BEFORE `queue/` (closes the double-enqueue window); the dispatcher never starts a queue file whose id matches a live worker. | `orchestrator/config.js:117-128`, `orchestrator/intake.js:852`, `orchestrator/auto-pull.js`, `orchestrator/daemon.js` |
| 6.7 | **Worker observability**: `spo status` lists workers (task, state, account, duration); dashboard adapted. | `bin/spo`, `console/collect.js` |

**Gate C6**: the **dispatcher itself** in `--dry-run` with K=3 on ONE journal root and 3
synthetic cards (a single lock, 3 worker exits, zero cross-task writes) + shadow K=3 with
**one healthy account** (excess workers wait or park, never share an account) + *(live
recette via 2.9)* a supervised parallel batch of 2 S-sized cards.

---

## Chantier 7 — Truthfulness consolidation & docs

| # | Action | Files |
|---|---|---|
| 7.1 | **Replay holes closed**: shadow failure exits never forced (worktree/check/pushPr/prMergeEnqueue/finish, prWait 1), real-mode error legs (fetch/rev-parse/npm-ci, add/commit/diff/patch, check-runs, merge enqueue, issue-comment/worktree-remove), the oauthTokenFile branch, runTask catch-alls (invalid-task-json, runaway), park-reason assertions in the account-rotation test. | `test/` |
| 7.2 | **`spo recette` scenario library**: extend the 2.9 harness with K>1 and main-moved scenarios (C4/C6's ad-hoc recettes become replayable scenarios). | `bin/spo`, `orchestrator/` |
| 7.3 | **Concurrency tests**: runForever timers under a long drain, double daemon, daemon+CLI concurrently (the exact seam of bug #443). | `test/` |
| 7.4 | **Killed-call accounting** — DONE as a side effect of the 2026-08-31 token-accounting rewrite: dollars were retired as the headline metric entirely (billable-weighted tokens = fresh input + cache-creation + output now replace the old $12-baseline comparison, superseded unit), and a deadline-killed/E2BIG call now journals `tokensSource: null` instead of the old `costUsd: 0` — extractTokens()'s ZERO_TOKENS shape makes "not reported" distinct from a genuine zero-token call, which is what this action originally asked for. | `orchestrator/steps/llm.js`, `orchestrator/tokens.js` |
| 7.5 | **Final doc sweep**: remaining inconsistencies (verify-citations.md's Bash mention, plan.md's plan-probe promise, prompts/README.md drift, budget caps per decision 3.7, spec §CHECK per decision 1.8). | `prompts/`, `doc/` |

**Gate C7**: full suite green + `spo recette` (all scenarios) + an Opus re-read of the
updated spec against the code (zero uncommented divergences).

---

## Notable findings deliberately NOT addressed here (decisions on record)

- **The ~40k-token PLAN/IMPLEMENT preamble** (the product CLAUDE.md is never trimmed despite
  the spec's "(trimmed)"): a real lever, but on the SPO-WebClient side (trim the CLAUDE.md or
  provide a lean pipeline variant) — file it as a product card, not here. Measure the real
  share first via `duration_s` + costs after C5.
- **The midnight claim-lost trap**: already fixed on the SPO-WebClient side (PR #451) —
  verified.
- **The judges' cwd** (they pay for the pipeline CLAUDE.md and its useless-to-them `gh`
  conventions): marginal once 1.3 lands (judges read their inputs, not the repo); re-evaluate
  after measuring.
- **Fable vs Opus for DIAGNOSE**: project memory — Fable diagnoses have already produced
  parks that needed Opus re-verification. The plan keeps Fable (per spec); if `diagnose-*`
  parks stay > 10% after C1, escalate DIAGNOSE attempt 3 to Opus (maintainer decision).
- **Board-only pre-worktree parks** (card left in Todo): documented "board is best-effort"
  behavior — fixed anyway in 5.1 because it is cheap, but never blocking.
