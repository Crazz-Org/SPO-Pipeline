# Orchestrator state-machine spec — v1.1

Status: **draft for shadow mode**, revised against the measured improvisation analysis
([improvisation-analysis.md](improvisation-analysis.md), phase 2: 16 card sessions, 35.2 %
of driver actions improvised, dispositions BRANCH 78 % · PARK 18 % · DIAGNOSE 4 %). v1.1
adds the two states that analysis found missing (CI_CHECKS, the `main`-moved transition) and
the design consequences at the bottom.

**What in this document (and the rest of the doc/prompts/orchestrator-comment corpus) is
verified, and by what** is not stated inline — see
[`accepted-gaps.md`](accepted-gaps.md), action 7bis.5's register: exhaustively-read surface,
sweep-enforced facts, classified-historical logs, and the named, line-counted accepted gap
handed to chantier 9. This file's own prose is in that last bucket except for the specific
park-reason and documented-constant facts a sweep checks — see `accepted-gaps.md` §3.

## Principles

1. **Exit codes are the contract.** Every scripted step is judged on its exit code, never on
   printed text — the convention every existing script already follows. **Action B3.4's own
   narrow exception:** GATE's exit code still decides the ROUTE alone (park vs. proceed vs.
   re-gate — unchanged by this action for every exit code). What action B3.4 adds is a second,
   read-only pass that only ever refines the *name* already attached to an exit code that was
   going to park regardless: `<spoBenchDir>/done/<jobId>.json` (exit 1, where the bench's own
   `JobReport.verdict`/`detail` is read whenever it is available and well-formed — see
   `steps/scripted.js`'s `readGateJobReportForRouting`) and, only where no job id could ever
   exist yet to read a report by (exit 2/3's deposit-time refusals), the CLI's own printed
   stderr text. Both fall back to the exact exit-code-only reason that stood before this action
   whenever they are unavailable or unparseable — see the GATE row below for the complete
   account. **Round 2:** the matched stderr literals (`NOT PUSHED`, `already has job`,
   `bench client not built`, `WORKER DIED`, and the `job … queued` marker `parseGateJobId`
   parses) all live in SPO-WebClient — `scripts/bench-gate.sh`, `scripts/bench-submit.sh`,
   `src/e2e/bench/cli.ts`, `src/e2e/bench/job.ts` — a repository this file does not own and whose
   wording nothing here enforces. `test/gate-stderr-literal-sweep.test.js` pins every one of them
   against the real product tree (resolved via that repo's own `git ls-files`, full paths only,
   never a bare basename) so a reword over there fails this suite immediately instead of silently
   reverting exit-2/3 routing to its pre-B3.4 collapse with every test here still green; it fails
   loudly, not silently, if the product repo is absent from disk entirely.
2. **The catch-all is the error policy.** Any state, exit code or output the machine does not
   recognize → the task is **parked**: worktree left intact, one report written, one journal
   event, zero further tokens. Explicit error handling means a safe cheap catch-all, not
   foreseeing everything. Parked tasks are handled by the maintainer or an interactive
   session; every parking reason that recurs becomes a new branch (frequency-ordered). One
   case a task cannot produce a park for itself: the process running it dying mid-run (crash,
   hard kill, a lost single-instance lock). Since chantier 6 split the daemon into a dispatcher,
   worker and scanner process (`orchestrator/README.md` § "How much the daemon takes on at once"),
   the **primary** cover is the dispatcher's own exit handler: `dispatcher.js`'s `handleExit` →
   `reparkCrashedWorker` runs the exact same `buildCtx`/`finalizePark` round trip a normal
   catch-all park uses, immediately and in-process, the moment a worker child exits abnormally —
   reason `worker-crashed`, detail `{exitCode, signal}`. `orchestrator/orphan-scan.js` is now the
   **fallback**, covering the case the dispatcher itself cannot: a `state.json` left on a
   non-terminal state with no `queue/` entry and a dead owner pid is reparked automatically
   (`task-orphaned-daemon-restart`) through the same `finalizePark` path (including restoring
   `worktreePath` onto the rebuilt ctx, so a still-dirty worktree is pushed to a `wip/` ref
   exactly as a live park would), the next time a `--real` daemon starts or the scanner runs its
   periodic scan. `orphan-scan.js` has a second, narrower shape for the same fallback role: a task
   claimed off `queue/` (a `task.json` on disk) that never reached even one handler — no
   `state.json` was ever written, so there is nothing to compare an owner pid against — is parked
   `task-orphaned-before-start` once it has sat unclaimed-by-any-live-worker for longer than the
   grace window; `lastState` is recorded as `INTAKE` (honest, not a guess: a task in this shape by
   definition never got past it) so a bare `retry` reply restarts it from the beginning, a
   complete recovery for a task that never ran. A `--shadow`/`--dry-run` start never does real
   side effects, so both shapes only detect the orphan and journal
   `orphan-scan-would-repark` — neither ever parks. `handleExit` also
   deliberately declines to call `reparkCrashedWorker` for a worker that crashes **during the
   dispatcher's own shutdown** (`dispatcher.js:485-499`, `stopReason && outcome === 'crashed'`):
   reparking from inside a process already SIGTERMed and about to be SIGKILLed risks a
   `finalizePark` caught mid-write (state.json PARKED, no park-comment yet), which no later
   scan can ever recover — deferring instead just leaves an ordinary non-terminal `state.json`
   for orphan-scan to pick up cleanly next start. This is not a corner case: a merge's `git pull`
   SIGTERMing an in-flight card is this project's single most common shutdown, so the fallback
   above is the primary path for that one. See `orchestrator/README.md` § Orphan recovery.
   **Action 4.4:** the catch-all remains the error policy for every park reason except a closed,
   named allowlist of ones that are facts about the *world at that instant*, not about the card —
   `claim-rate-limited` (a board-claim rate limit), `gate-non-attesting` (action 4.2's bench-
   attested-nothing park), `gate-live-blocked` (action B2.3's world-lock/rate-limit BLOCKED park —
   see the GATE row below), and the `llm-transport-failed:<STEP>` family (PLAN/IMPLEMENT/DIAGNOSE/
   VALIDATE, exact strings — never a prefix match). Those are auto-retried a bounded number of
   times (`config.transientRetryBudget`, default 2) with a journalled backoff
   (`config.transientRetryDelaysMs`, 1 min then 5 min, carried as an absolute `notBefore` on the
   re-queued task rather than a `sleep` — since chantier 6 split worker execution out into its own
   process (`orchestrator/README.md` § "How much the daemon takes on at once"), a sleep here would
   stall only the one worker process that is exiting anyway, not a shared drain loop; `notBefore`
   is still the right mechanism (a queued deadline survives that process exiting, a `sleep` would
   not), the original "stall every other card" justification just predates the split) before
   falling through to an ordinary park. A task on this
   path is never marked `PARKED` and never gets a park comment or board move — it is not parked,
   it is retrying — and a human's `retry` reply always resets the budget to zero and starts
   immediately, restoring the "a human can always make progress" guarantee. Everything else,
   including `push-pr-failed` (measured: every corpus occurrence is a logic failure, never a
   network one), still goes straight to the catch-all above. One exception inside the exception:
   a `gate-non-attesting` park whose detail carries `verdictDirExists: false` is a *misconfigured
   `spoBenchDir`*, not a transient fact — action 4.2 records that as a boolean rather than a
   distinct reason — so it is never auto-retried; retrying a wrong path costs a full
   WORKTREE/PLAN/IMPLEMENT/GATE run per attempt and can only look in the same wrong place again.
   The re-enqueue is one atomic write (`park-loop.js`'s `reEnqueueTask`, temp file + rename, with
   `transientRetries`/`notBefore` merged in): an entry visible without them would be "eligible
   now, budget unused", i.e. an unbounded retry loop after a SIGTERM in the gap. If that write
   fails, the task journals `transient-retry-failed` and takes the ordinary park — the journal
   never claims a retry that is not really queued. See `orchestrator/state-machine.js`'s
   `TRANSIENT_RETRY_REASONS`/`isTransientRetryReason`/`finalizePark`. Two further park reasons sit
   inside `state-machine.js`'s own dispatch loop rather than inside any handler, and so are never
   thrown as a `ParkSignal` at all — they call `finalizePark` directly, the same sink every other
   reason above eventually reaches: a run that hops between states more than `HOP_LIMIT` (200)
   times parks `state-machine-runaway` (`{hops}`) — the guard against a real handler bug producing
   a valid-looking but cyclic path (e.g. an infinite DIAGNOSE↔IMPLEMENT loop from a logic error),
   never tripped by any legitimate path, which completes in well under this many hops; and a
   `state` value with no entry in `HANDLERS` parks `unrecognized-state` (`{state}`) — defensive
   only, since every `state.json`/task-journal write in this codebase is produced by the state
   names this same file defines.
3. **LLM steps are stateless calls.** Each judgement step is one `claude -p` invocation with
   a pinned model, effort, tool set, JSON output schema and budget. Continuity between steps
   travels through files (plan, ledger, diff), never through a long-lived conversation.
4. **The jewels are not re-implemented.** The bench, the validators' criteria and the
   blast-radius policy are used as-is.
5. **Everything is journaled.** One append-only JSONL journal per task; the console renders
   journals, it never holds state of its own. **Action 4.4:** a task taking the bounded
   auto-retry path above still journals `transient-retry` (`{reason, attempt, delayMs,
   notBefore}`) on the state it parked from, even though it never reaches `PARKED` itself — the
   journal stays the complete record either way. That event is written only once the queue entry
   is durably on disk; a re-enqueue that fails journals `transient-retry-failed` instead and the
   task parks normally, so the journal never records a retry the queue does not hold.

## Task lifecycle

```
INTAKE → WORKTREE → PLAN → IMPLEMENT → CHECK → PUSH_PR → GATE → CI_CHECKS → VALIDATE → MERGE → FINISH → DONE
                                ▲                          │         │           │
                                └────────── DIAGNOSE ◄─────┴─────────┴───────────┘
                                                  (gate FAIL ≤3 distinct root causes ·
                                                   unknown CI failure · validator REJECT ≤3)
  any state ────────────────────────────────────────────► PARKED (catch-all: report + stop)
```

| State | Kind | Does | Success → | Failure → |
|---|---|---|---|---|
| INTAKE | script | take next task file from `queue/` (priority = file order; sources: board export, `/triage-report`, later in-game reports). **Action 3.2:** for a `kind: "card"` task, the criterion and title are scanned for a protected-file mention (`.claude/settings.json`, `.claude/settings.local.json`, anything under `.claude/hooks/` — see `orchestrator/intake.js`'s `detectProtectedFiles`) after the `invalid-task-json`, `shadow.forceState`, and `real-flag-required` checks but before `appendEvent('INTAKE', 'ok')` runs; a hit parks the task at zero cost, since INTAKE never makes an LLM call either way. | WORKTREE | PARKED (also `plan-requires-protected-files`, `{source: 'criterion', matches}`, when the card's own criterion or title names a protected file) |
| WORKTREE | script | Action B1.4 round 4: BEFORE anything else, inside the SAME product-repo lock span (`payBenchReinstallDebtIfOwed`), pays back a bench-worker reinstall an EARLIER card's FINISH deferred (`journal.js`'s `writeBenchReinstallOwed`/`bench-reinstall-owed.json`) rather than parked -- WORKTREE runs before GATE, so a card that starts while a reinstall is owed settles it before it can gate against a stale worker. Reuses the SAME fast-forward + conditional `bash scripts/bench-install.sh` sequence FINISH's own preamble below uses (`fastForwardMainAndInstall`, one implementation, not two) -- fetch, refuse (never force) unless `main` and clean of TRACKED changes, `git merge --ff-only origin/main`, then, ONLY if the bench checks idle on a SINGLE non-blocking read (never a poll) and `git merge-base --is-ancestor <owed sha> HEAD` confirms the debt's own record is still an ancestor of the fast-forwarded checkout, the reinstall itself. NEVER blocks or parks this card: a busy bench, an unreadable bench dir, a failed fast-forward, a failed ancestry check, a failed install, OR anything payBenchReinstallDebtIfOwed's own attempt throws (a `bench-install-timed-out`/`git-timed-out` ParkSignal from spawnStep's own timeout handling, or a raw Error from `clearBenchReinstallOwed`'s own fs call) all leave the record owed, journal why (`bench-debt-still-busy` / `bench-debt-dir-unreadable` / `bench-debt-ancestry-check-failed` / `bench-debt-attempt-failed` (R4, fifth pass — catches every thrown failure mode, exit code or not, so a wedged installer never terminally parks every card that starts), or the same `main-fast-forward-failed`/`bench-reinstall-failed` vocabulary FINISH uses), and WORKTREE proceeds exactly as if nothing were owed -- the NEXT card's WORKTREE tries again. A successful pay-back clears the record and journals `bench-debt-paid`. Superseded round 3's dedicated daemon scan timer (`orchestrator/bench-reconcile.js`, since deleted): that module held the SAME product-repo lock from a THIRD process the mutex's own wait-bound derivation assumes cannot exist. Then, WORKTREE's ordinary sequence: fresh worktree + branch off last green `main`; refuse if nightly says `main` is red (repair task only) | PLAN | PARKED — `product-repo-lock-timeout` when the chantier 6 product-repo mutex isn't acquired within its wait bound (`withProductRepoLock`, shared with FINISH below), plus real mode's own sequence: `worktree-fetch-failed` / `worktree-rev-parse-failed` / `worktree-add-failed` (the `git fetch origin` / `rev-parse origin/main` / `worktree add` calls themselves exit non-zero); `nightly-main-red` (the freshly-fetched `origin/main` sha matches a `FAIL` verdict in `~/.spo-bench/nightly/latest.json`, checked before anything is created); `worktree-npm-ci-failed` (`npm ci` in the fresh worktree). Card #424's leftover sweep (`sweepWorktreeLeftovers`, action 4.6) runs before `worktree add`: `worktrees/<taskId>` + branch `claude-pipe/<taskId>` is the pipeline's own exclusive namespace, so a retry may clean up its own previous attempt rather than collide with it — a dirty leftover worktree is pushed to a durable `wip/` ref then removed, but PARKS `worktree-dirty-leftover` if that preserve itself fails (never destroys unsaved work); a leftover local branch whose tip this run cannot vouch for (not an ancestor of `origin/main`, not equal to its own remote tip, not covered by one of this task's own `wip/<id>-*` refs) PARKS `branch-unmerged-leftover` rather than guess (card #385); any of the sweep's own cleanup calls failing (`worktree-remove`, `branch-delete`, `remote-preserve`, `remote-pr-lookup`, `remote-pr-close`, `remote-branch-delete`) PARKS `worktree-cleanup-failed` (`detail.step` names which one — card #455 added the PR-lookup/close steps so a remote branch delete never auto-closes an open PR as an invisible side effect). The claim itself (`npm run board:take`, run last — only once fetch/rev-parse/leftover-sweep/add/npm-ci have all succeeded, since only the fresh worktree gives the npm aliases a product cwd) maps its own exit code: 3 → `claim-lost`, 4 or 5 → `claim-rate-limited` (a GitHub board-claim rate limit — unrelated to the Claude account pool's own cooldowns under Account pool below, despite the similar name), 6 → `claim-finished-worktree`, anything else → `claim-unrecognized-exit`; see `orchestrator/README.md` "WORKTREE, in order — and why claim is last" for the full sequence and exit-code table. Shadow mode and `--dry-run` never reach any of the real-mode reasons above: their own generic scripted-step path (a non-zero exit from the fake `worktree` script, no `git`/`gh`/`npm` ever spawned) PARKS the distinct, generic `worktree-failed` instead. A shadow-mode fixture (`nightlyMainRed`) checked before the real/scripted branch is even chosen PARKS `main-red-refuse-worktree` — the shadow-only sibling of real mode's own `nightly-main-red` above, same concept (nightly says `main` is red), different code path (fixture vs a real read of `nightly/latest.json`). |
| PLAN | `claude -p` | plan + invariants file + runnable check commands + `files_to_change` (action 3.2 — the plan's own declared list of files it will change; a sibling `optional` field of the output contract, not `required`, so its absence never parks — see step-contracts.js); once written, the driver resolves every invariant against the worktree and journals the result as the CHECK baseline (action 1.8) — an invariant that fails to resolve here is logged and excluded from that baseline, never a park, never a re-run of PLAN. **Action 3.1:** real mode only — shadow and `--dry-run` never reuse, checked explicitly as the guard's first condition. On a `retry` after a park, PLAN is skipped entirely (no LLM call) when the plan already on disk from the run that parked is still valid: `origin/main` has not moved since it was written, both plan/invariants files are still present, are regular files, and non-empty, the last PLAN `result` payload is not itself a failure (a transport-failure payload carries no `plan_path`/`invariant_ids`/`check_commands` to hand IMPLEMENT), and the park that ended the previous run was not one of the seven reasons that indict the plan itself (`plan-invalid`, `plan-requires-protected-files`, `diagnose-duplicate-root-cause`, `diagnose-no-new-cause`, `diagnose-budget-exhausted`, `validate-reject-budget-exhausted`, `ci-retry-budget-exhausted`) — every other park reason (transport failures, gate/CI failures, claim losses, merge conflicts) is orthogonal to whether the plan was right. The invariants baseline is still rebuilt fresh against the retried worktree either way; the plan/invariants text and PLAN's own declared `invariant_ids`/`check_commands` are carried forward with `plan_path`/`invariants_path` stamped explicitly (not merely trusted to already be present on the carried-forward payload), journalled as `plan-reused`. See `orchestrator/state-machine.js`'s `decidePlanReuse`. | IMPLEMENT | PARKED (plan invalid/not executable; a transport failure — the call never produced a verdict at all — is `llm-transport-failed:PLAN`, distinct from an invalid plan the model DID produce; **action 3.2:** `plan-requires-protected-files` — `{source: 'files_to_change', matches, declaredFiles}` when an entry of the model's own declared `files_to_change` names a protected file, scanned before any scratch file is written. `plan_markdown` prose is never scanned — measured at 33% precision (2 false positives against 1 true positive across all 17 real plans) and dropped for that reason. When `files_to_change` is absent, `null`, not an array, or contains a non-string entry, PLAN does not park and does not fall back to scanning prose — it journals `plan-files-undeclared` and proceeds normally; an empty array counts as a clean declaration, not an undeclared one) |
| IMPLEMENT | `claude -p` | write code + tests in the worktree per plan | CHECK | DIAGNOSE (a transport failure is never routed to DIAGNOSE — it PARKS `llm-transport-failed:IMPLEMENT` instead, since there is no answer for DIAGNOSE to diagnose) |
| CHECK | script | invariant substring check first (action 1.8: `orchestrator/invariants.js` re-resolves the PLAN-time baseline against the worktree as it now stands — an id that resolved at PLAN and no longer does is the one regression this fails on; one PLAN itself could never resolve was already excluded from the baseline and can never fail here; a missing/unparsable invariants file is journalled, never a failure), pure `fs`, no spawn, run before the three subprocess checks below so a free check never waits behind three that cost a spawn each; then typecheck, lint, `coverage:changed` (≥ 93 % on new/modified lines) | PUSH_PR | DIAGNOSE |
| PUSH_PR | script | commit, push, open PR (`Closes #N`) — PR precedes gate (CI needs it) | GATE | PARKED — every step of `add`/`commit`/`push`/`pr-create`/`pr-number-unparsed`/`diff-name-only` PARKS the single reason `push-pr-failed`, `detail.step` naming which one (principle 2 above: measured, every corpus occurrence is a logic failure, never a transient network one, so this is never on the bounded-auto-retry allowlist). `commit`'s own exit 1 ("nothing to commit") is not automatically a failure — a clean tree there is resolved against both `origin/<branch>` and `origin/main` to tell a genuinely empty pass (`detail.reason: 'nothing-implemented'`, HEAD sits on `origin/main` — IMPLEMENT never committed anything) from one that already pushed everything at HEAD (`detail.reason: 'nothing-new-to-push'`) from CI_CHECKS' own main-moved merge commit sitting unpushed (skips the commit, falls through to push, journalled `commit-skipped-nothing-staged`) — see the inline comment at `steps/scripted.js`'s `realPushPr` (card #213 vs card #385's main-moved case) for why a HEAD-vs-`origin/main` test alone is the wrong condition. A dirty tree after a failed commit (`detail.dirty: true`) or an unreadable `git status`/`rev-parse` mid-diagnosis both PARK the same `push-pr-failed` rather than let a diagnostic step itself bury the real cause. Shadow mode and `--dry-run` never reach any `detail.step` — their own generic scripted-step failure PARKS the same bare `push-pr-failed` reason with no `step` detail (`state-machine.js`'s `handlePushPr`). Touching `src/shared/rdo-members.ts` (checked against the real diff, not the task's own declared `touchesRdoMembers`, which intake only infers from issue text and can be wrong — card #385) with no `<Fichier>.pas:<Ligne>` citation found in either the catalogue diff or the issue criterion PARKS `rdo-citation-missing` — SPO-WebClient's own `check-pr-rules.js` CI check requires exactly this citation for any RDO-catalogue change; a maintainer resolving this park adds the citation to the PR body or the card criterion and retries. |
| GATE | script | `npm run gate` (bench job, background wait); read **exit code**: 0 PASS · 1 fail · 2 dirty · 3 worker down · 4 timeout. **Action 4.2:** exit 1 is no longer an unconditional route to DIAGNOSE — the exit code alone conflates three different situations the bench itself distinguishes. Read the bench's own verdict for HEAD (`<spoBenchDir>/verdicts/<sha>.json`, the same file CI_CHECKS reads below for its own `main`-moved test): the bench merges `origin/main` into the checkout itself before building (`worker.ts`'s `prepareRef`), so `baseMain` is absent from that file precisely when the branch no longer merges cleanly with `origin/main` — measured over all 375 `ref`-type verdicts `npm run gate` submits: 359/359 PASS carry `baseMain`, 14/16 FAIL do; the missing 2 are exactly the main-moved conflicts (confirmed end to end on card #439 / commit `379ada60`, which burned all 3 DIAGNOSE attempts and parked `diagnose-budget-exhausted` before a `retry` — a fresh worktree off the new `main` — reached DONE in 19 minutes). No verdict file **on disk** means the run is *non-attesting* (`worker.ts`'s `NON_ATTESTING = {DIRTY, ENVIRONMENT, ABANDONED}` is deliberately never written to `verdicts/`, yet `cli.ts`'s `wait()` still maps all three to exit 1) — nothing was learned about the code, so it parks rather than spending a DIAGNOSE call on it. **Action B3.4:** before falling back to the undifferentiated park below, `realGate` now asks the job's own `<spoBenchDir>/done/<jobId>.json` (`SPO-WebClient/src/e2e/bench/job.ts`'s `JobReport`, written unconditionally by `Spool.writeReport` for every verdict, no `ref`-type or `NON_ATTESTING` restriction) which of the four non-attesting-shaped verdicts this actually was — `parseGateJobId` reads the job id off `cli.ts`'s own `` `job ${id} queued` `` line, already captured in `r.stdout`/`gate.log`; `readGateDoneReport` then reads and shape-guards that file (missing → `'missing'`, a read error other than ENOENT → `'unreadable'`, JSON that parses to `null`/a string/an array/anything with no non-empty `verdict` field → `'malformed'`/`'wrong-shape'`/`'no-verdict-field'` — none of these are ever read as a verdict, and the fallback below runs exactly as if this read did not exist). When a well-shaped report IS found: `verdict: 'ENVIRONMENT'` → PARKED `gate-environment` (measured against the live bench 2026-09-03: 7 of the last 29 completed `done/` jobs, all "git fetch failed while fetching \<sha\>" — this is the corroborated common case, not a hypothetical); `verdict: 'DIRTY'` → PARKED `gate-worker-dirty-checkout` (the WORKER's own shared `ref` checkout found dirty after `prepareRef` — never the session's own tree, which `gate-dirty-tree` below already refused at exit 2 before a job was ever deposited; a different fact from a different place, deliberately not sharing that name); `verdict: 'ABANDONED'` → PARKED `gate-abandoned` (the depositing session's pid was gone before the job started); `verdict: 'INTERRUPTED'` → PARKED `gate-interrupted` (the worker died mid-job; `recoverInterrupted` wrote this on restart, the body may have partially run). Each park's `detail` carries `headSha`, `jobId`, and the job report's own human-readable `detail` text (`jobDetail`) alongside the reason. A report present but carrying any OTHER verdict (PASS/LEASED contradict exit 1 at all; FAIL/BLOCKED/STALE are already written to `verdicts/<sha>.json` and would not have reached this branch) is an inconsistency between the two files this code does not try to explain — falls through to `gate-non-attesting` unchanged, same as an unavailable read. Every `gate-job-report-read` attempt (found or not) is journalled with `jobId`/`donePath`/`skipped`/`verdict`, so a maintainer can always see whether the richer read was tried and why it did or did not apply. **Action B3.4, STALE:** a verdict of `STALE` ("the tree changed between deposit and the end of the run") already IS written to `verdicts/<sha>.json` (not in `NON_ATTESTING`) but used to fall through to the generic DIAGNOSE branch below, spending a judge call on a body verdict that no longer describes any tree that exists — it now parks `gate-stale` instead, best-effort enriched with the same `done/<jobId>.json` read's `detail` text when available (never required — `STALE` is already known from `verdicts/<sha>.json` alone). A FAIL that DOES carry `baseMain` failed with `origin/main` already merged in by the bench; that is a real failure and still routes to DIAGNOSE, unchanged. A FAIL *without* `baseMain` fetches `origin/main` and attempts the same local merge CI_CHECKS' own `main`-moved path performs (below) — clean → back to CHECK and re-gate; conflict → `merge --abort` then PARKED. The plan's own intersection test is deliberately not implemented for this path: with no `baseMain` there is nothing to intersect against. **Action B2.3:** exit 0 is no longer read as proof on its own either. `verdicts/<sha>.json` now carries `live` (`LiveAttestation` — `{status:'ran', flows}` · `{status:'skipped', why, required}` · `{status:'unknown', why}`, SPO-WebClient's `src/e2e/bench/verdict.ts`) and `staticProof`; `realGate` resolves HEAD and reads that verdict on EVERY exit, not only exit 1. `live.status === 'skipped'` with a non-empty `required` means routing named flows the live stage never drove — the bench-side fix (`verify-gate.js`) already fails that shape closed (`BLOCKED`, never `PASS`), so seeing it here at all means a worker binary that predates the fix, or a verdict reused/copied forward from one; either way this is the pipeline's own defence in depth, and reaching it means something is wrong that a human should see, not something a retry can fix (WORKTREE→PLAN→IMPLEMENT→GATE again just asks the same worker the same question) — not on `TRANSIENT_RETRY_REASONS`. Absence must stay safe: no verdict file, a verdict with no `live` key at all (515 of 517 real files on this machine as of this action — every verdict written before the field existed), or `live.status === 'unknown'` are all the identical fact — "nothing on file proves the live stage ran" — and none may be read as proof either way; parking on any of them would stall the whole backlog on old data, so they route exactly as before (journalled `gate-live-unknown`, `detail.verdictExists` distinguishing "no file for this sha" from "the file has no opinion"). `live.status === 'skipped'` with `required: []` (the common, legitimate case — 186 of 215 corpus skips, doc/bench-audit-2026-09-02.md) and `live.status === 'ran'` both proceed to CI_CHECKS unchanged. The SAME `liveRoutedButNotDriven` check also runs on the exit-1 path below against `verdict.verdict === 'BLOCKED'` — `cli.ts`'s `wait()` collapses every non-PASS/LEASED verdict to that one exit code, so a BLOCKED gate (the live stage refused to run, not a code failure) used to fall straight through to DIAGNOSE and ask a judge to diagnose a defect that was never observed; it now parks instead, on the same principle `main-moved-conflict` already established for a structurally similar "not the code's fault" situation — but NOT under one shared reason for every `BLOCKED`. Adversarial verification found `BLOCKED` has (at least) four producers in SPO-WebClient, and only two of them (`verify-gate.js`'s routed-but-undriven-diff check, and a pre-fix/reused verdict reaching the exit-0 path above) are the "routing required a live drive that never happened" fact `gate-live-not-driven`'s name asserts. `run.ts`'s `runLive` returning BLOCKED because the world lock refused the run (dirty, or another live run already in flight — single-flight, `world-lock.ts`) or, until 2026-09-03 also a live-run rate limiter that could never fire (`minIntervalMinutes: 0`, `maxRunsPerDay: 1000`) -- action B3.5 (SPO-WebClient PR #646) deleted that producer outright rather than tune it, so the world lock is now the only one, maps to `live.status === 'unknown'` (`liveAttestationFrom`, worker.ts) — the IDENTICAL value the exit-0 path above reads as "nothing proven either way" and refuses to park on. So the exit-1 arm now keys on the SAME `liveRoutedButNotDriven(verdict.live)` fact the exit-0 path uses, not the bare verdict string: a genuinely routed-but-undriven BLOCKED still parks `gate-live-not-driven`; every other BLOCKED (world lock, or `verify-gate.js`'s capability-question variant, where `required` can be empty and nothing was actually routed) parks under its own reason, `gate-live-blocked` — put on `TRANSIENT_RETRY_REASONS` (unlike `gate-live-not-driven`) because the operational case that motivates it, a maintainer's `gate:local --live` holding the single-flight lock, clears itself within minutes; see that reason's own entry in the Action-4.4 allowlist above for the bounded-cost argument on the genuinely-dirty case. Both reasons' `ParkSignal` detail now carries `exitFrom` (0 or 1) as well as the journal event, so the park comment itself says which path arrived without a maintainer having to open `journal.jsonl`. | CI_CHECKS | exit 1 with a verdict carrying `baseMain` → DIAGNOSE (unchanged) · exit 1 and the lookup itself failed — `rev-parse HEAD` non-zero, or exit 0 with stdout that is not an object name (a failing `git rev-parse` prints the ref name itself, action 4.1's measurement), or a verdict file that is present but does not parse — → DIAGNOSE, journalled `gate-verdict-unreadable`, never a park: a failed diagnostic must not become the thing that parks the card · exit 1, no verdict file on disk → PARKED (`gate-non-attesting`, detail carries `verdictDirExists` so a misconfigured `spoBenchDir` is one look) · exit 1, FAIL without `baseMain`, merge conflicts → PARKED (`main-moved-conflict`) · main-moved re-gates already used this task's `mainMovedRegateBudget` (config.js, default 1 — **action 6.5**, see below) → PARKED (`main-moved-twice`, counter shared with CI_CHECKS) · nightly says `main` is red at the fetched sha → PARKED (`main-red-no-merge`, guard shared with CI_CHECKS) · `liveRoutedButNotDriven(verdict.live)` true — `verdict.verdict === 'BLOCKED'` on exit 1, or `live.status === 'skipped'` with a non-empty `required` on exit 0 → PARKED `gate-live-not-driven` (action B2.3, one reason shared by both exit paths — `detail` carries `headSha`, `exitFrom`, `why`, `required`; not on `TRANSIENT_RETRY_REASONS`) · exit 1, `verdict.verdict === 'BLOCKED'` but NOT `liveRoutedButNotDriven` (the world lock refused the run, or before B3.5 deleted it, a rate limit that could never fire) → PARKED `gate-live-blocked` (`detail` carries `headSha`, `exitFrom: 1`, `liveStatus`, `why`; IS on `TRANSIENT_RETRY_REASONS` — see the Action-4.4 allowlist above) · 2/3 (**action B3.4, naming only — the route stays exit-code-only, see Principle 1's own exception above**): unlike exit 1, no job id can ever exist yet for most of exit 2/3's own sub-causes — `scripts/bench-gate.sh`'s two pre-flight refusals and `cli.ts` `submit()`'s WORKER-DOWN/duplicate-deposit checks all run BEFORE a job is deposited, and the one exit-3 case where a job WAS deposited ("WORKER DIED while pending") returns the instant the worker is found dead, before its OWN restart-time `recoverInterrupted` has had any chance to write that job's `done/<jobId>.json` — so `realGate` instead matches the literal diagnostic text `scripts/bench-gate.sh` / `scripts/bench-submit.sh` / `cli.ts` already print to stderr (captured in `r.stderr`, unconditionally journalled to `gate.log` regardless of this match): exit 2, `/NOT PUSHED/` → PARKED `gate-not-pushed` (the head sha is not on `origin` yet — `scripts/bench-gate.sh`'s own check, before it ever execs into `bench-submit.sh`); `/already has job/` → PARKED `gate-duplicate-job` (`job.ts`'s `DuplicateJobError` — this worktree+ref already has an earlier deposit queued); anything else (the common case, `scripts/bench-gate.sh`'s own "DIRTY TREE" message — the session's own tree has uncommitted/untracked changes) → PARKED `gate-dirty-tree`, unchanged fallback, same name as before this action. Exit 3, `/bench client not built/` → PARKED `gate-worker-not-built` (`scripts/bench-submit.sh`: the client's `dist/e2e/bench/cli.js` was never built — needs `npm run build:e2e`, not a worker restart); `/WORKER DIED/` → PARKED `gate-worker-died-midjob` (`cli.ts` `wait()`: the worker process died while THIS job was already queued or running — the queue is preserved, restarting the worker resumes it); anything else (the common case, `cli.ts` `submit()`'s own "WORKER DOWN" message — the worker daemon was already not running at deposit time) → PARKED `gate-worker-down`, unchanged fallback. **Retry policy, corrected in round 2:** the first cut of this action reported the whole nine-reason split as "naming correctness, not retry policy" and put none of them on `TRANSIENT_RETRY_REASONS` — but `DIRTY`/`ENVIRONMENT`/`ABANDONED`/`INTERRUPTED` previously shared ONE name, `gate-non-attesting`, and that name auto-retries; splitting it without carrying the retry marking along silently turned the commonest non-PASS bench outcome (`gate-environment`, 7 of 29 real completed jobs, all "git fetch failed") from auto-retried into terminal/human-only. Restored per reason, not blanket: `gate-environment` → **ADD** (a failed fetch is a fact about this worker's network at this moment, retrying asks the same bench the same question again, exactly `gate-non-attesting`'s own header comment's transient class); `gate-interrupted` → **ADD** (the worker restarted mid-job — precisely what `realFinish`'s bench reinstall does to a sibling card's in-flight gate, and the FINISH design already treats this as recovering and transient-retryable); `gate-abandoned` → **ADD** (the depositing session's pid was gone at start — a fact about that moment's process table, a fresh deposit has a live pid); `gate-stale` → **ADD** (newly a park at all under this action, so there is no PRIOR retry behaviour to preserve, but `verify-gate.js`'s own STALE detail text says the fix is literally "resubmit" and nothing about the code was implicated — terminal would waste a human's attention on a race a second gate run most likely clears on its own). `gate-worker-dirty-checkout` → **left OFF, a deliberate narrowing** versus the pre-split behaviour (DIRTY used to share `gate-non-attesting`'s auto-retry): `prepareRef` already runs the worker's shared `ref` checkout through `reset --hard` + `clean -fd` before every job (doc/bench-audit-2026-09-02.md's D5), so a DIRTY verdict reached AFTER that automatic cleanup already ran is not the ordinary case reset+clean exists to fix — it is what SURVIVES that cycle (git-ignored artifacts `clean -fd` does not touch, a stray process still holding a file, a permission problem, manual interference with a host resource shared across every card's gate). A bare retry re-runs the identical reset+clean on the identical checkout with no structural reason to expect a different answer, the same "real spend burned per attempt, for as long as the condition stands" argument `gate-non-attesting`'s own `verdictDirExists === false` carve-out already makes below — and because the checkout is shared, once genuinely stuck it blocks every card's gate, not only this one's, until a human clears it by hand. All four are pinned in `test/transient-retry.test.js`, one test per reason, that fails if the classification flips either direction. None of the four exit-2/3 reasons (`gate-not-pushed`, `gate-duplicate-job`, `gate-worker-not-built`, `gate-worker-died-midjob`) are added — neither `gate-dirty-tree` nor `gate-worker-down`, the reasons they refine, was ever on `TRANSIENT_RETRY_REASONS`, so leaving their children off it is the status quo continuing, not a new decision; also pinned, one test per reason. · 4 → PARKED `gate-timeout` · any other exit code (`npm run gate` returning something this table does not know about) → PARKED `gate-unrecognized-exit`, the catch-all this row falls back to rather than silently treating an unrecognized exit as one of the four known ones |
| CI_CHECKS | script | Two checks the bench does not make. (0) Before either: a bounded **in-flight wait** (action 1.7) — a check-run with `conclusion: null` (still running) or zero check-runs at all (CI hasn't registered anything yet) is never read as green; re-poll `gh api .../check-runs` up to `ciChecksMaxPolls` times (default 30), sleeping `ciChecksPollIntervalMs` between polls (default 20000ms, injectable in tests; ~10 min total, deliberately uncalibrated — see config.js), journaling each observation, until nothing is in flight. *(2026-08-30 audit: 8/12 measured "green" events had `claude review` still in progress.)* (a) `gh pr checks <n>` once nothing is in flight — CI normally concluded while the gate queued; on red, map the failing check **by name**: `Coverage of changed lines` → IMPLEMENT · `Lint` → IMPLEMENT · `PR rules (coverage ratchet, RDO citation)` (`ci-cause-table.js`'s `classifyCiFailure`, exact step-name match only, never a substring or prefix) → PARKED `pr-rules-needs-approval` · anything else, or no step name recovered at all (a non-zero `gh api .../actions/jobs/<id>`, an unparsable body, a job whose steps all passed, or a legacy bare-string shadow fixture) → DIAGNOSE, deliberately, per `ci-cause-table.js`'s own header: a step name this table does not recognize must degrade to "ask a judge", never to a silent retry or a silent park. (b) the `main`-moved test: intersect `git diff --name-only <baseMain>..origin/main` with the branch's changed files — non-empty → merge `origin/main`, back to CHECK and re-gate; while the nightly says `main` is red, never merge from it → PARKED. *(Added in v1.1: 5/16 measured sessions reached a green gate and could not merge — every one improvised CI forensics; 4/16 needed the `main`-moved branch.)* **Action 4.2:** the `mainMoveUsed` counter and the nightly-red guard are the exact same shared state GATE's own main-moved path (above) uses — a move already spent from either state blocks the other, and a nightly-red main blocks a merge attempted from either. **Action 6.5:** the re-gate is now allowed up to `config.mainMovedRegateBudget` times per task (default **1** — today's "once" behaviour, unchanged), not a hardcoded once; the (n+1)th move → PARKED (`main-moved-twice`, the name kept for continuity even past a raised budget — it names the event, not a literal second occurrence). This is a settled decision, not a re-derivable default, but the gap it accepts is wider than "disjoint files, interacting behaviour": the intersection test runs once per CI_CHECKS **visit** (`steps/scripted.js`'s `realCiChecks`) — a task that loops DIAGNOSE→IMPLEMENT→CHECK→PUSH_PR→GATE→CI_CHECKS, or re-gates after its own main-moved merge, reaches it again each time; nothing re-runs it at VALIDATE or MERGE, so a sibling that merges into `origin/main` **after** this task's own CI_CHECKS pass — even one whose files DO intersect this branch's — is never re-tested before MERGE tries to land this one too. `realCiChecks` also never `git fetch`es (the only fetches in this file are `realWorktree`'s at WORKTREE and `realGate`'s on the no-`baseMain` retry path), so the one-shot intersection test itself can already be judging a stale `origin/main`. **Observed, not merely modeled**: a 2026-09-02 K=2 `parallel-doc-log` recette run hit exactly this — two cards touching the same file, the second PR's CI_CHECKS intersection test passed clean, the first PR then merged and moved `main` under it, and GitHub's merge queue itself caught the resulting conflict ("This branch has conflicts that must be resolved") — but nothing routes that back to CHECK/re-gate the way GATE's and CI_CHECKS' own main-moved paths do; `pr:wait` just polls exit 4 until its bound, and the task parks on a symptom (`merge-queue-not-landing`) rather than the actual cause. Filed as **#84** ("The GATE→merge-queue-landing window is never re-gated: a sibling merge parks the card instead"), not fixed; the nightly is a backstop for drift in general, not a check this specific window runs. The `mainMovedRegateBudget` default itself is still a model, not a measurement of *this* gap (see config.js's own comment for the Poisson derivation over the measured 39-52% GATE-to-merge exposure and the measured 10.5% file-overlap rate across the 18 merged pipeline PRs, and doc/remediation-progress.md's "6.5's counter" section for the corpus it rests on) — but that corpus predates K>1 ever running for real, which chantier 6 made possible; the case above is the first observed instance of *this gap* since — not a `main-moved` event itself: the whole finding is that the main-moved path never fired (the intersection test passed clean), so no `main-moved-merge`/`main-moved-twice` event exists in any corpus for it. | VALIDATE | per cause table, or still in flight after the bounded wait → PARKED (`ci-checks-still-running`, `detail` carries `attempts`/`totalRuns`/`pendingRuns`) · the real path's own `git -C <worktree> rev-parse <ref>` (resolving HEAD before reading check-runs, and `origin/main` inside the main-moved test) failing → PARKED `ci-checks-rev-parse-failed` (`detail.ref` names which one) · `gh api .../commits/<sha>/check-runs` itself exiting non-zero → PARKED `ci-checks-read-failed` (a malformed-but-200 JSON body is not this reason — it degrades to an empty check list instead, never a park) · the main-moved path's own `git merge origin/main` exiting non-zero → PARKED `main-moved-merge-failed` (distinct from GATE's own `main-moved-conflict`: this merge runs directly in the worktree with no `merge --abort` cleanup step, since CI_CHECKS reaches it only after a green gate, not mid-DIAGNOSE) |
| DIAGNOSE | `claude -p` | one-line root cause from diff + gate log + ledger (diff.patch and, when entered from GATE, gate.log are really generated on entry — `steps/scripted.js`'s `prepareJudgeInputs`/`realGate`; gate.log is required only when this DIAGNOSE was entered from GATE, never from a CHECK failure or an empty IMPLEMENT, where no gate has run yet); append to ledger. The reply is one of two mutually-exclusive shapes: `root_cause: "<string>"` (+ category/suggested_fix), or the honest `root_cause: null` (+ a one-line `reason`) meaning "no cause beyond what the ledger already has" — a present-but-null `root_cause` satisfies the output contract, it is never treated as a missing answer. | IMPLEMENT (retry) | PARKED (3 attempts, same root cause twice → `diagnose-duplicate-root-cause`; the model explicitly has no new cause → `diagnose-no-new-cause`; a transport failure — no verdict produced at all — → `llm-transport-failed:DIAGNOSE`, never fabricated as a cause; or gate.log required but unproducible when entered from GATE → `judge-inputs-missing`) |
| VALIDATE | `claude -p` ×1–2 | `citation-verifier` (only when the task is flagged RDO **and** the real diff produced citations — 2026-09-04 interim narrowing: the trigger `task.touchesRdoMembers` is an intake guess from the card's text while `citations` come from the diff at PUSH_PR, and when the guess is a false positive the step used to be invoked with an empty placeholder and park `prompt-missing-placeholder:citations` on an otherwise CI-green card — measured on #489 and #385. The skip journals `citation-verifier-skipped-no-citations`; it is a real signal, either intake over-flagged or an RDO change shipped uncited) then `change-validator`; JSON verdicts. Its declared `diff.patch` is really generated on entry (`prepareJudgeInputs`) — always producible post-PUSH_PR. citation-verifier is fail-closed: a verifier that cannot render a verdict (transport error, timeout, malformed payload) parks the card — it never passes by default. A REJECT's `reasons`/`findings` are appended to the ledger and threaded into the next IMPLEMENT's `diagnosis` placeholder (action 1.6), attributed as a VALIDATE rejection distinct from a DIAGNOSE finding — if both exist for a task, the most recently journaled one leads and the other stays visible for context. | MERGE | REJECT → IMPLEMENT (own budget of 3) · false citation → PARKED (`citation-false`) · verifier couldn't answer → PARKED (`citation-verifier-failed`) · verdict the code doesn't recognize → PARKED (`citation-verifier-unrecognized-verdict`) · change-validator transport failure (no verdict produced at all) → PARKED (`llm-transport-failed:VALIDATE`) · diff.patch unproducible → PARKED (`judge-inputs-missing`) · change-validator answered with a verdict string this code does not recognize (neither `PASS`, `PASS_WITH_FINDINGS`, `REJECT`, nor a transport failure already handled above) → PARKED (`validate-unrecognized-verdict`, `detail.verdict` carries what it actually sent) |
| MERGE | script | `gh pr merge --merge` (enqueues), `npm run pr:wait`; exit code is the verdict. Exit 4 (still open) → **one** more bounded wait, then PARKED. The queue is never dequeued, re-enqueued, `--admin`-forced or fed empty commits by the machine — the measured costliest improvisation family (24 episodes; one wrote Done on an open PR). | FINISH | PARKED — `gh pr merge --merge` itself exiting non-zero → `pr-merge-enqueue-failed` (nothing was ever enqueued, `pr:wait` never runs); `pr:wait`'s own exit code, read after the enqueue succeeded: 1 (closed without merging) → `pr-closed-unmerged`; 4 on the second, bounded re-wait (still open even after the one extra wait this row's Does column describes) → `merge-queue-not-landing` (`detail.lastExit` carries the second wait's own exit — see CI_CHECKS' own **#84** discussion above for the one measured way a card actually reaches this: a sibling's merge moves `main` under it in the un-re-gated GATE→merge-queue window); anything else the first `pr:wait` call returns (neither 0, 1, nor 4) → `pr-wait-unrecognized-exit` |
| FINISH | script | Action B1.4: FINISH now actually keeps the promise this row always made — fast-forward the main product checkout (`config.productRepo`), then reap the worktree, then close the task (board sync: Done + short comment). Before this action it never did: `realFinish` only ever did the board move, the issue comment and the worktree remove, so a PR merged by the daemon left `config.productRepo` exactly as stale as one merged by a human who never ran `npm run finish` (SPO-WebClient's own script) — measured root cause of the bench worker silently running a stale binary for 3.5 days across 11 merges (a commit changed both halves of a flag contract atomically and correctly; the bench worker, installed once from a binary and never rebuilt, disagreed with the new job body from the moment it landed). Two NEW steps run first, inside their own product-repo-lock critical section (phase `finish-sync`, ahead of the pre-existing teardown phase `finish` below — see product-repo-lock.js/product-repo-hold.js), in this order: (1) `git fetch origin`, then this card's own merge commit by PR number (`gh pr view <prNumber> --json mergeCommit` — ctx carries no merge sha directly; MERGE only ever enqueues and awaits the merge, never reads the resulting commit back), then `git diff --name-only <mergeSha>^ <mergeSha>` to learn whether the merge touched the bench worker's own sources (paths under `src/e2e/bench/` or `scripts/bench-`, the same test `scripts/finish.sh` already runs by hand) — this determines `benchTouched` REGARDLESS of whether the fast-forward below succeeds; (2) the fast-forward itself — refuse (never force) unless `config.productRepo` is on `main`, clean of TRACKED changes (`git status --porcelain --untracked-files=no` empty — post-verification hazard fix: narrowed from bare `--porcelain`, which counted untracked files and so refused in cases `scripts/finish.sh`'s own `git pull --ff-only` would sail straight through, parking a bench-touching card on a stray editor backup or scratch file in this human-shared checkout), and `git merge --ff-only origin/main` itself succeeds; (3) ONLY once the fast-forward succeeded AND `benchTouched` is true, wait for the bench worker to go IDLE — a second post-verification hazard fix: `bash scripts/bench-install.sh` ends in an unconditional `systemctl --user restart`, and this daemon runs `SPO_WORKERS=2` in production, so reinstalling while the bench is still busy can cut a SIBLING card's in-flight GATE mid-job (the cut job recovers as `INTERRUPTED`, writes no `verdicts/<sha>.json`, and that sibling parks `gate-non-attesting` — transient-retryable, but a REAL re-run of WORKTREE through GATE, not merely a wasted gate). `waitForBenchIdle` polls `~/.spo-bench/spool` and `~/.spo-bench/running` (the same two directories `spo status` already reports) until both are empty, bounded by `config.benchIdleWaitMaxPolls` × `config.benchIdleWaitPollIntervalMs` (default 180 × 5s = 15 minutes), reading `config.spoBenchDir` itself, never a hardcoded path (R2/W2, post-verification third pass: an UNREADABLE spool/running — anything other than "the directory simply is not there" — is never silently read as idle; it PARKS immediately, `finish-failed`/`bench-idle-wait`/`bench-dir-unreadable`, distinguishably from a merely busy bench, the same "tell a misconfiguration apart from a genuine empty answer" pattern `realGate`'s own `verdictDirExists` already uses one function away). R1 (post-verification third pass): a bench that stays BUSY for the whole bound no longer PARKS — it DEFERS. The old park was wrong on three counts, all measured: `finish-failed` is not on `state-machine.js`'s `TRANSIENT_RETRY_REASONS` (terminal, human-only); the park fired BEFORE the board move below, so a card whose PR had ALREADY MERGED sat in `Merging` with its worktree still on disk; and the 15-minute bound is not generous against SPO-WebClient's own bench leases — `worker.ts`'s own `DEFAULT_LEASE_MINUTES = 30` / `MAX_LEASE_MINUTES = 120` constants mean an ORDINARY human bench lease (2×–8× the bound) would terminally park any bench-touching card the daemon finished during it. So the bound being exhausted now journals `bench-reinstall-deferred` (`detail`/event carry `mergeSha`, `prNumber`, the last-observed `spool`/`running`, and the attempt count), records the debt DURABLY (`journal.js`'s `writeBenchReinstallOwed`, `<journalRoot>/bench-reinstall-owed.json` — survives a daemon restart, and a SECOND bench-touching card deferring during the same busy window overwrites this ONE record with its own, newer `mergeSha` rather than accumulating a duplicate — `bash scripts/bench-install.sh` always rebuilds from whatever is CURRENTLY checked out, so only the latest sha is ever useful to retry with), and lets FINISH complete NORMALLY — board move, comment, worktree remove, `DONE` — exactly as if nothing were owed. Round 4: the debt is paid back by the NEXT card's own WORKTREE, from inside that card's own product-repo lock span (`payBenchReinstallDebtIfOwed`, see the WORKTREE row above for the full mechanism) rather than a separate daemon scan timer — round 3's `orchestrator/bench-reconcile.js` shipped exactly that timer and was deleted: it held the SAME product-repo lock from a THIRD process the mutex's own wait-bound derivation (`product-repo-lock.js`'s `waitBoundMs`) assumes cannot exist. The journal alone must always answer "is a reinstall owed right now" — every branch above is named and loud on purpose; (4) only once the bench is confirmed idle, `bash scripts/bench-install.sh` (the same script `scripts/finish.sh`'s human-session rule runs) reinstalls the worker — never run against a checkout that could not be verified fresh first, which would install the wrong binary and report success, reproducing the exact defect this action closes, and never run while the bench is still busy, which would reproduce the SAME defect from the other direction (a cut sibling job). | DONE | PARKED (also `product-repo-lock-timeout`, same mutex as WORKTREE above — `detail.phase` is now one of `worktree` / `finish-sync` / `finish`, since FINISH itself acquires this mutex TWICE) — the pre-existing three (board move to `Done`, the closing issue comment, the final `git worktree remove`) still PARK the same `finish-failed` reason on a non-zero exit, `detail.step` naming which one (`board-move` / `issue-comment` / `worktree-remove`); this is deliberately the one park in the whole daemon that blocks on what is everywhere else a best-effort side effect (`board.js`'s own moveCard convention), because a card that cannot be marked `Done` is not done. Action B1.4 extends the SAME `finish-failed` vocabulary rather than inventing new reason strings, `detail.step` naming the new failure: `merge-sha-lookup` (`gh pr view` failed or returned no usable `mergeCommit.oid` — cannot safely determine anything past this point, always PARKS) · `bench-diff-check` (the `git diff --name-only` call itself failed — same reasoning) · `fast-forward` (the checkout was not on `main`, was dirty of TRACKED changes, or `git merge --ff-only` itself refused — `detail.reason` names which; PARKS only when `benchTouched` is true, i.e. reinstalling would have been necessary and unsafe; when `benchTouched` is false the card's PR has already merged and this is journalled as `main-fast-forward-failed`, not parked — a fast-forward failure this row's own drift measurement already showed real and non-blocking must not stall the whole backlog over a merge that never touched the bench; R3, post-verification third pass: `detail.reason` is `check-failed` — never `wrong-branch`/`dirty` — when the BRANCH or STATUS probe command itself failed to run (`detail.check` names which, `detail.exit` its real exit code) rather than genuinely answering "wrong branch"/"dirty", so a maintainer reading the journal is not misled into hunting for uncommitted work that was never there) · `bench-dir-unreadable` (R2/W2, post-verification third pass: `config.spoBenchDir`'s own `spool`/`running` could not be read for a reason OTHER than "the directory simply is not there" — `detail.code` carries the real errno; thrown immediately, on the FIRST read, never after polling, since no amount of waiting turns a misconfigured or permission-denied directory readable) · `bench-reinstall` (`bash scripts/bench-install.sh` itself exited non-zero). A stuck reinstall — `spawnStep`'s SINGLE attempt timing out, never retried (R2, post-verification third pass: matches `npm-gate`'s own pre-existing exemption, for the identical reason — a killed `bash` can leave `npm run build:e2e`/`systemctl restart` still running underneath it, and a retry would build into the SAME `dist/` concurrently) — is instead `bench-install-timed-out`, the `${commandClass}-timed-out` family's newest member (`command-timeout.js`'s own `'bench-install'` class, `SPO_TIMEOUT_BENCH_INSTALL_MS`, default 15 minutes, `detail.retried: false`). Every outcome of the new preamble is journalled either way (`merge-sha-lookup-failed` -- `gh pr view` exited non-zero or returned no usable `mergeCommit.oid`, so nothing past this point can be determined safely and the card parks `finish-failed`/`merge-sha-lookup`; `bench-diff-check-failed` -- the `git diff --name-only <mergeSha>^ <mergeSha>` call itself exited non-zero, so `benchTouched` is unknowable and the card parks `finish-failed`/`bench-diff-check`; both carry `prNumber` and the real `exit` code, and `bench-diff-check-failed` also carries the `mergeSha` step 2 resolved -- `main-fast-forwarded` / `main-fast-forward-failed`, `bench-busy-wait` per poll while the bench drains, `bench-idle` / `bench-idle-wait-timed-out`, `bench-reinstall-deferred` (R1, once the bound is exhausted with the bench still busy — see above), `bench-dir-unreadable`, `bench-reinstalled` / `bench-reinstall-failed` / `bench-reinstall-skipped`, `bench-diff-checked`), so the journal alone answers "did the worker get reinstalled, was a reinstall ever deferred, and is one owed right now" without reading a log. |

Ledger per task (`journal/<task>/ledger.md`): one line per attempt —
`attempt N | root cause | outcome`. The 3-attempts rule is a string comparison over it. A
VALIDATE REJECT gets its own line, same shape but a distinct leading word so the two can never
be confused: `validate-reject N | reasons | outcome` (action 1.6).

## Step contracts

| Step | Model | Effort | Tools | Output | Wall-clock deadline |
|---|---|---|---|---|---|
| PLAN | Fable 5 (Opus 5 fallback) | per task size S/M/L → low/medium/high | Read, Grep, Glob, Bash(ro) | plan.md + invariants + check commands + `files_to_change` (`--json-schema` envelope; `files_to_change` is `optional`, not in the schema's `required`) | 900000ms / 15min |
| IMPLEMENT | Sonnet 5 — **Opus 5 on `task.touchesRdoMembers`**, set once at intake from the issue's own Area field or a literal `rdo-members.ts` mention in its body[^rdo-wire], or an L-sized task | per size | full edit tools in the worktree | diff summary + invariant rows + files-changed list (JSON) | 900000ms / 15min |
| DIAGNOSE | Fable 5 | high | Read, Grep, Bash(ro) | one-line root cause (JSON) | 900000ms / 15min |
| VALIDATE: citation-verifier | Fable 5 | high | Read, Grep (product + `~/SPO-Original`, read-only) | PASS / REJECT / DIVERGES (JSON) | 900000ms / 15min |
| VALIDATE: change-validator | Fable 5 (never Sonnet — the executor may not judge itself) | high | Read, Grep, Glob, Bash(ro) | PASS / PASS WITH FINDINGS / REJECT + findings (JSON) | 900000ms / 15min |

The deadline is the same figure for all five rows — `step-contracts.js`'s `LLM_STEP_DEADLINE_MS`,
the `spawnSync` timeout `invokeClaudeReal` arms for every one of these calls
(`orchestrator/steps/llm.js`) — but that figure governs real mode only. `state-machine.js` still
wraps every LLM step in the outer `callWithDeadline` (`deadline.js`) using the generic
`stepDeadlineMs` (120000ms; no `stepDeadlineMsByState` entry exists for any LLM state), which is
inert in real mode (a JS timer cannot preempt the blocking `spawnSync` that `LLM_STEP_DEADLINE_MS`
already bounds) but live in shadow mode, where a fixture delay races that 120s timer instead of
the 900000ms figure above. There is no per-step or per-size USD budget: `maxBudgetUsd` is plumbed
end to end (`step-contracts.js` → `steps/llm.js`'s conditional `--max-budget-usd`) but no
daemon or intake path sets it — see `orchestrator/README.md` § Budgets for the maintainer
decision and the bounds that actually are enforced.

[^rdo-wire]: `task.touchesRdoMembers` (`intake.js`'s `makeTask`: `area === 'rdo' || /rdo-members\.ts/.test(body)`)
    stands in for the fuller wire rule stated in `SPO-WebClient/doc/kanban-workflow.md` —
    `src/shared/rdo-*`, `src/server/rdo.ts`, `rdo-members.ts`, session-phase code — but only
    detects a slice of it, and is set once at intake, before a plan exists. IMPLEMENT never sees
    a rederivation against the plan or the real diff; PUSH_PR (`steps/scripted.js`) does
    re-derive the flag from the real diff, but only for the literal file
    `src/shared/rdo-members.ts`, and only in time to escalate the change-validator that follows
    IMPLEMENT, not IMPLEMENT itself.

Before any of the five calls above ever spawns, `steps/llm.js`'s real path fills the step's own
`prompts/<file>.md` template against the values `task-values.js` derives for it
(`buildPromptValues` → `fillPromptTemplate`). A template's header declares its placeholders; a
declared `{{name}}` with no value supplied, or any `{{...}}` token still present in the body after
every declared one has been substituted (a body reference to a name the header never declared,
almost always a typo), throws `prompt-template.js`'s typed `MissingPlaceholderError` before the
`claude` process is ever spawned — no tokens spent. `steps/llm.js` turns that into
`ParkSignal(`prompt-missing-placeholder:${err.placeholder}`, {step, promptFile, placeholder,
missing})` — the reason string carries the specific placeholder name, so two different broken
templates park distinguishably rather than colliding on one generic reason. A maintainer resolving
this park fixes the named prompt file's header/body mismatch and retries; nothing about the task
itself is at fault.

Every `claude -p` call: `--output-format json` (result, cost, **session_id**),
`--json-schema` for the payload, `--allowedTools`, `--model`, `--effort`,
`--permission-mode` per step (plus `--max-budget-usd` when a caller supplies a numeric
`maxBudgetUsd` — no daemon or intake path does; the only caller that does is the hand-run
`scripts/smoke-llm.js`), run under the account chosen by the scheduler
(`CLAUDE_CONFIG_DIR=<account dir>`). Domain context comes from whatever `CLAUDE.md` sits in the
step's own `cwd` -- the CLI loads it itself (`steps/llm.js` deliberately passes neither
`--safe-mode` nor `--bare`), and **nothing trims it**: an earlier "(trimmed)" here described an
intention nobody implemented. Which file that is depends on the step: `config.js`'s `cwdForStep`
gives the product worktree to PLAN and IMPLEMENT only, while DIAGNOSE and both VALIDATE steps run
from this repo's root *specifically to avoid* that tree, whose preamble was measured at ~40k input
tokens. Plus the step prompt from `prompts/`.

### Nightly verdict semantics (action B3.2)

Every real-mode reader of `<spoBenchDir>/nightly/latest.json` inside `orchestrator/steps/
scripted.js` (realWorktree's own check, and `guardNightlyRed`, shared by realCiChecks' and
realGate's main-moved paths) goes through one function, `classifyNightly(nightly, targetSha)`,
returning exactly one of three states -- never silently folding one into another:

- **`green`** -- verdict `PASS`, a `sha` recorded, and it equals the sha in question. The only
  state that means "proven".
- **`red`** -- verdict `FAIL`, a `sha` recorded, and it equals the sha in question. The only state
  a merge-onto-main decision refuses over (`main-red-no-merge` at CI_CHECKS'/GATE's shared
  main-moved guard, `nightly-main-red` at WORKTREE).
- **`unknown`** -- everything else: no file, unreadable/malformed JSON, no `verdict` field, an
  unrecognised verdict, a verdict that by design attests nothing about `main` (worker.ts's
  `ENVIRONMENT`/`INTERRUPTED`/`BLOCKED`/`DIRTY`/`ABANDONED`/`STALE`/`LEASED`), or a PASS/FAIL
  recorded for a *different* sha than the one in question (a sha mismatch is the routine case,
  not corruption -- not because nightly runs at most once a day: `nightlyDue` also re-fires on a
  main-moved event, rate-limited at just `NIGHTLY_MOVE_RATE_LIMIT_MS` = 15 minutes, so the nightly
  runs several times a day in practice, five drives on 2026-09-02 alone; a mismatch is routine
  because proving a *freshly-arrived* tip still takes time). `unknown` does **not** park -- measured
  against the 2026-09-02 corpus, of the five `origin/main` tips that day this guard would have
  classified `unknown` for all five (two were superseded before ever being nightly-proven; the
  fastest proof took 7 minutes), so treating `unknown` as a merge refusal here would park
  essentially every main-moved merge on timing, not on any real signal -- which is the same
  principle GATE's own `gate-verdict-unreadable` path already applies ("a failed diagnostic must
  not become the thing that parks the card") -- but it
  is never silently equivalent to `green` either: every real-mode call site journals a
  `nightly-unknown` event (`{sha, reason}`) at its own state (`WORKTREE` / `CI_CHECKS` / `GATE`)
  whenever the classification comes back `unknown`, so an INTERRUPTED or stale nightly always
  leaves an explicit, distinguishable trace instead of reading as proof of anything.

Before this action, `INTERRUPTED` -- written by `worker.ts`'s `recoverInterrupted` precisely so a
worker death does not read as a clean run -- and a `FAIL` recorded for a sha `main` had since
moved past both fell through the same "not red" branch a genuine `PASS` did, in this file, and
`scripts/nightly-check.sh` (SPO-WebClient, the human-facing `npm run bench:nightly` probe over
the same file) printed the literal text "MAIN: GREEN" for both. That script now applies the
identical table (0/1/2 exit codes for green/red/unknown; see its own header) -- kept in sync by
hand across the repo boundary, not by a shared import, since the two are bash and Node in two
separate repos with no shared runtime.

## Account pool

- **One place holds account information** (maintainer decision, 2026-08-29): the pool
  directory, default `~/.claude-accounts` (`SPO_ACCOUNTS_DIR` overrides it) — no separate
  registry file, no implicit fallback to the machine's ambient `claude` login. Every
  subdirectory of the pool is one account and is that account's own `CLAUDE_CONFIG_DIR`,
  authenticated once via `claude setup-token`; see `doc/setup.md` § Accounts for the guided
  procedure (`spo account add <name>`).
- A pool with zero registered accounts is a hard stop for real mode: `orchestrator/accounts.js`'s
  `pick()` throws `NoAccountsRegisteredError('no-accounts-registered', ...)`, `callLlmStep`
  (`state-machine.js`) rethrows it verbatim as `ParkSignal('no-accounts-registered', ...)`, and
  `daemon.js --real` refuses to even start. `pick()`'s other sibling for a non-empty pool that
  still yields nobody healthy — every enabled account cooling, `AllAccountsCoolingError` — is
  `'all-accounts-cooling-unknown'` when nothing in the registry ever recorded a cooldown to report
  a time for, else `` `all-accounts-cooling-until-${ISO timestamp}` `` naming the earliest cooldown
  any checked account will clear; both are rethrown the same verbatim way, distinct from
  `all-accounts-leased` above (that one fires when at least one account IS healthy, just not
  currently available) and from `all-accounts-cooling-after-retry` below (which fires only once
  every account in one full rotation pass was actually tried and limited, not merely found
  cooling before a single call was attempted).
- The scheduler assigns each step an account; a limit error puts the account in **cooldown**
  and the step retries on the next healthy account. Cooldowns are journal events.
  `orchestrator/steps/llm.js`'s `classifyFailure` (action 3.5) recognizes a limit only from
  structured signals — `api_error_status` 429 (**observed**: `intake.js:747-749`'s 12.8-hour Fable
  incident, the only recorded real limit in this repo) or 529 (**anticipated**: Anthropic's
  documented "overloaded" status, never itself observed here), or an exact (lowercased, trimmed)
  match of `terminal_reason` against an allowlist — `overloaded_error` and `rate_limit_error`
  (**anticipated**, not recorded reply text), `usage_limit_reached` (a plain **guess**, kept
  because an exact-match entry that never fires costs nothing) — never a substring scan over
  free text, since any failure message merely containing "rate" used to be misclassified as a
  limit. An unrecognised limit shape now falls through to a plain PARK instead of rotating;
  extend the allowlist from journal evidence (the failure's `terminalReason`/`apiErrorStatus`
  are journalled with the step's result) as entries move from anticipated/guessed to actually
  observed, never from further guesswork.
- **Cooldown duration is an escalating probe, not a flat number** (`orchestrator/accounts.js`'s
  `markLimit`, action 3.5's 2026-08-31 redesign — this action's own first cut used a flat 5-hour
  usage cooldown, rejected before it shipped). The real pool has **2 accounts**, and at the time
  had no pool-health gate anywhere: with `maxAttempts` equal to pool size, two usage limits
  inside one window would take the *whole pool* down for up to 5 hours, parking every card the
  daemon pulled in that window. (Chantier 6 action 6.3 later added the gate this section used to
  say was missing — see the dispatcher bullet below; the escalating-probe redesign here stands on
  its own regardless.) A flat 5h also over-waits by construction — the Claude Max
  session window resets 5h after the *session's first message*, not after the limit hit, so
  `now + 5h` sleeps for (5h − the true remaining wait) longer than necessary, often 4h+. So:
  a first usage limit for an account (`limitKind: 'usage'`, i.e. 429 / `rate_limit_error` /
  `usage_limit_reached`) cools it for a **1-hour probe**; a usage limit landing again within a
  **2-hour escalation window** of that account's last one cools it for the real observed
  **5-hour** Claude Max session window instead (the probe just proved the window is still open).
  `overloaded` (529 / `overloaded_error`) stays a flat **5 minutes** and never escalates — a busy
  *server* says nothing about this account's own quota. An absent/unrecognised limit kind falls
  back to the usage flow (probe or escalated, by the same history check), never a shorter tier.
  Exhausting the pool inside one rotation pass never re-calls `pick()`, so the resulting park —
  `ParkSignal('all-accounts-cooling-after-retry', {attempts, lastResult, cooldownUntilIso})`,
  thrown by `callLlmStep` itself once its attempt loop runs out of accounts — carries the last
  cooldown's own ISO timestamp explicitly rather than relying on `pick()`'s own reason string,
  which that path never reaches.
- This rotation rule is not daemon-only: `orchestrator/intake.js`'s three maintainer/auto-triage
  LLM steps (draftCard, reviewCard, triageBugReport) follow it too, via their own
  `callIntakeStepWithRotation` helper — same pick/call/cool/rotate mechanics as
  `state-machine.js`'s `callLlmStep`, bounded to one pass over the pool. Two differences, both
  required by intake's "never throw for a recognized failure" contract: exhausting the pool
  becomes `{ok: false, error}` rather than a `ParkSignal`, and — since intake has no per-task
  journal of its own — a cooldown comes back on the result's `cooldowns` array for the caller to
  journal (`auto-triage.js` appends `report-triage-cooldown`). See `orchestrator/README.md`'s
  "Account rotation" section for the full mechanics.
- **K parallel workers ≤ healthy accounts — enforced, not aspirational** (chantier 6 action 6.3).
  `orchestrator/dispatcher.js`'s `fillSlots` re-clamps `K` to
  `Math.min(config.workers, accounts.countHealthyAccounts(accountsDir))` immediately before
  *every* worker spawn — not once per loop, not once at startup — so an account that cools down
  mid-cycle (one of this dispatcher's own workers just hit a limit) is reflected on the very next
  spawn decision. A clamp to zero healthy accounts is journalled
  (`dispatcher-idle-no-healthy-accounts`) and the recovery edge journalled the same way
  (`dispatcher-healthy-accounts-returned`). Parallelism scales implementation capacity; the gate
  stays serialized — adding a *Claude* account does not add gate throughput. *(Corrected
  2026-09-03: this previously read "(one live world)", which gave the reason as a property of
  the world. It is not. `planitia` is an MMO world built for concurrent players, and the real
  limit is one active session per **SPO** account — so the bench's single-flight lock is its own
  policy, and more SPO test accounts could add gate throughput. See `doc/environments.md`,
  "What the test accounts can and cannot do".)*
- **Per-step account leases** (chantier 6 action 6.2, `orchestrator/account-lease.js`) stop two
  concurrent callers — a worker's `callLlmStep` and the scanner process's
  `callIntakeStepWithRotation` — from being handed the *same* account by `accounts.pick()`'s
  deterministic first-fit, invisible under the pre-C6 single-threaded daemon and a real bug once
  a worker and the scanner can run at once. A lease is per-step, not per-task, released the
  instant the one LLM call it wraps finishes; a healthy account currently leased by another live
  process is `AllAccountsLeasedError`, worth a bounded wait (`config.accountLeaseWaitMs`, default
  **31.5 min** — `MAX_LEASE_AGE_MS`, `step-contracts.js`, the age at which a lease is swept as
  dead — never the ~90–265s a sibling's own step is *usually* measured at: a waiter has to outlast
  the longest a sibling can *legitimately* hold the lease, not its typical duration, and the old
  5-minute default was found wrong in C6 verification for exactly that reason — it gave up while a
  legitimate holder was still alive and un-sweepable for up to 26.5 more minutes, parking a healthy
  card `all-accounts-leased`) — distinct from
  `AllAccountsCoolingError` (a cooldown, never worth waiting on) — and parks `all-accounts-leased`
  if that wait is exhausted. Lease files live at `<poolDir>/.lease-<name>.json`;
  `countHealthyAccounts` above is deliberately blind to lease state (only to cooldowns), since
  clamping K on lease churn — a lease frees every 90–265s — would make K flap on every single LLM
  call.
- `scripts/usage-report.js` becomes per-account: it is the instrument that says when one
  more subscription pays for itself.

## Observability — sessions and pipeline (the console)

Journals are the single source of truth; `~/.spo-bench/` remains the bench's own surface.

- `journal/<task-id>/journal.jsonl` — every event: state transitions, step spawns and results
  (`{step, model, effort, account, sessionId, tokensSource, freshInputTokens,
  cacheCreationTokens, cacheReadTokens, outputTokens, billableTokens, duration_s, exit,
  verdict}` — no dollar figure anywhere; `orchestrator/tokens.js`'s "billable-weighted" =
  fresh input + cache-creation + output, cache-read reported separately, never summed in).
  `duration_s` was documented here well before any code wrote it — action 5.4 measured
  2026-09-01 that zero of the 19 corpus journals' `llm-call` events carried it, and made it
  true the same day: `orchestrator/steps/llm.js`'s `invokeClaudeReal` now measures wall-clock
  seconds around the `claude` spawn itself and reports it on every branch (success, spawn
  error, external signal, and — the one a maintainer most wants — a deadline timeout, which
  still burned the full deadline even though it produced no result).
  Account cooldowns, parkings (with reason), attempts, transient retries (action 4.4 —
  `transient-retry`, `{reason, attempt, delayMs, notBefore}`, journalled right after `parked` on
  a bounded-retry-eligible reason, once the queue entry is written — the task never reaches the
  `PARKED` state itself; `transient-retry-failed`, `{reason, attempt, error}`, when that write
  failed and the task fell through to an ordinary park instead).
- **Kanban truth (action 5.1)** — every column change a task causes is journalled, so the board
  and the journal can be reconciled against each other. `board-move` `{column}` on a successful
  move, including **FINISH's move to `Done`**, which was previously the one move that changed the
  board without leaving a record: 14 of the 18 tasks in the corpus have `Merging` as their last
  journalled move while the board reads `Done`, and that is the whole reason. A move made without
  a task worktree (a pre-WORKTREE park) runs from the product repo and carries
  `via: "product-repo"`. `board-move-failed` `{column, exit, timedOut}` on a non-zero exit;
  `board-move-skipped` `{reason, column}` for `already-in-column` (the card is already
  there, no spawn), the vestigial `no worktree` (neither a worktree nor a product repo, which
  the shipped config never produces), or `no issue` (`ctx.task.issue` unset, reachable for any
  task without one — `board.js`'s `moveCard`). A card entering DIAGNOSE for the first time posts one
  comment and journals `diagnose-surfaced` `{attempt, budget}`, or `diagnose-surface-failed`
  `{exit, timedOut}` — never blocking, exactly like a board move.
- **External reconciliation (action 5.1b)** — the board's `Done` on 213/428/443 was reached
  without any pipeline involvement (GitHub's built-in "Item closed" workflow moves the card on
  issue close, re-measured live 2026-09-01), and the JOURNAL was the side that never learned about
  it: 2 of the 3 were `PARKED` for a fix a human made and closed by hand hours later (213, 428);
  the third (443) was `ABANDONED` on a false park — `pr:wait` read `closed false` at 13:17:57,
  parked `pr-closed-unmerged`, and PR #447 actually merged 30 seconds later at 13:18:27, before the
  maintainer's own `abandon` reply at 13:53. Reaching `ABANDONED` at all is `park-loop.js`'s own
  unpark-scan reconciler recognizing an `abandon` reply on a `PARKED` task's issue thread: terminal,
  no re-enqueue, `state.json` written directly as `{state: 'ABANDONED', reason:
  'abandoned-by-maintainer', ...}` — the one park reason in this codebase that is neither thrown as
  a `ParkSignal` nor passed through `finalizePark`, because the task is not re-entering
  `runTask`'s loop at all. The state write happens before the ack comment or any cleanup, so a
  daemon crash at any point afterward resumes into a task that is already correctly terminal.
  `park-loop.js`'s `reconcileExternalClosure`, called
  from inside `unparkScan`'s own loop for every `PARKED`/`ABANDONED` task, reads the owning issue
  and — record, never overwrite — writes `state.json`'s `externallyResolved: {via: 'issue-closed'
  | 'pr-merged', closedAt, prNumber, mergedAt, at}` and journals `reconciled-externally` with the
  same detail, **without ever touching `state.state`**: the task really did park/abandon, and
  fabricating a `DONE` the pipeline never produced would make the journal lie the other way.
  `via: 'pr-merged'` (carrying the PR's own `merged_at`, legible against `closedAt` for 443's own
  30-second gap) only when `state.prNumber` is set and that PR actually merged; `'issue-closed'`
  otherwise (213/428's shape). Idempotent by construction — `state.externallyResolved` itself is
  the guard, so a reconciled task is never re-read — bounding the feature to at most 2 extra
  `gh api` reads per parked task, ever; a still-open parked task IS re-read every `unparkScan`
  cycle (60s by default), 1 read each, 3 today. A failed read (non-zero exit, timeout, unparsable
  JSON) journals `reconcile-scan-failed {step, exit, timedOut}` and never blocks or throws — same
  contract as every other real spawn in this file. `spo parked` (`bin/spo`'s `cmdParked`) prints a
  reconciled row under its own heading, separate from the still-PARKED and still-ABANDONED rows.
- **Judge findings, routed instead of lost (action 5.3)** — measured across all 19 journals
  (2026-09-01): 7 `change-validator PASS_WITH_FINDINGS` events carried a non-empty `findings`
  array (8 finding objects total) and one `citation-verifier DIVERGES` (issue-462,
  2026-08-31T08:35:08Z) — every one journalled and never read again; `PASS_WITH_FINDINGS` returned
  `MERGE` with the findings sitting only in `journal.jsonl`, and `DIVERGES` had nothing recorded
  beyond the bare verdict (`step-contracts.js`'s CITATION_VERIFIER contract requires
  `{verdict, entries}`, but the `citation-verifier` event only ever carried `{verdict}`; fixed —
  `entries` now rides along on both the `PASS` and `DIVERGES` branches). `handleValidate` now
  posts one structured comment on the **issue** (never the PR — this pipeline auto-merges, so
  there is no PR reviewer, and the PR closes on merge while the issue does not; the PR number is
  named inside the body so the link is not lost), before returning `MERGE`: change-validator's
  findings when the verdict is `PASS_WITH_FINDINGS` with a non-empty array, citation-verifier's
  `entries` when the verdict was `DIVERGES` — both in the same comment, in clearly-separated
  sections, when both apply to the same run. `findings` tolerates the same shape divergence
  `plan-files-undeclared` (action 3.2) already learned to expect — every one of the 8 measured
  findings arrived as a JSON-encoded STRING, not a real array — parsing either shape and
  journalling `validate-findings-shape {shape, count}` so a future divergence stays visible rather
  than silently dropped; a malformed payload (unparsable, `null`, an object, an array of
  non-object elements) never throws and never blocks the merge. No follow-up card is ever
  auto-filed on a judge verdict — deliberately: the plan's own "(optionally a follow-up draft
  card)" is the exact unattended-filing shape C3 gated behind a human `confirm` after the
  12.8-hour, 128-attempt auto-triage stall, and a comment is reversible where a filed card is not.
  Journals `validate-findings-posted {count, commentId}` on success,
  `validate-findings-post-failed {exit, timedOut}` on a non-zero `gh` exit or a timed-out spawn —
  never blocking, real mode only, same contract as `diagnose-surfaced`/board moves above.
- **Claude session management**: the `sessionId` of every step is recorded, so any step can
  be reopened for debugging with `claude --resume <sessionId>` (full transcript, continue
  interactively) — `spo resume <task-id>` prints the exact command per step (see below), it does
  not run it. `claude agents` lists live background sessions.
- Console CLI (`bin/spo`; ~20 subcommands ship today, not the four originally planned):
  `spo status` (queue, active tasks + state, bench queue, accounts health, today's token usage) ·
  `spo task <id>` (timeline from the journal) · `spo parked` (parked tasks + reasons) ·
  `spo resume <task-id|session_id>` — **prints** the `claude --resume <sessionId>` command for
  each recorded LLM step, one per line; it never spawns `claude` itself (`bin/spo`'s `cmdResume`)
  · `spo tokens`, `spo accounts`, `spo account add/enable/disable/clear-cooldown/sync-settings`,
  `spo ask`, `spo pull`, `spo pull-reports`, `spo intake`, `spo reports`, `spo triage`,
  `spo recette`, `spo dashboard` among others. `spo dashboard` (`cmdDashboard`, `bin/spo:1102`)
  is a generated static HTML page reading the same local journals, and already ships alongside
  the CLI rather than after it.
- Nothing polls GitHub for state that has a local surface (verdicts, nightly, journals).

## Design consequences from the measured improvisation (v1.1)

The analysis's top families are mostly **states not to have** rather than branches to write:

1. **No shell-read alphabet in orchestrator states.** 164 ad-hoc `grep`/`cat`/`tail`/`ls`
   calls measured, half of them polling for a sub-agent's file. The orchestrator reads
   nothing ad hoc: steps read through their own granted tools, and the orchestrator consumes
   only declared outputs (JSON payloads, exit codes, journal events).
2. **No edit capability outside IMPLEMENT.** 15 blocked driver writes measured (3 aimed at
   the wrong checkout). Only the IMPLEMENT step holds edit tools, and only inside the task's
   worktree.
3. **Every step has a wall-clock deadline.** The "sub-agent hadn't returned" family (18
   episodes: list/ping/re-spawn loops, twice a duplicate executor) becomes: spawn once, wait
   with a deadline, on expiry kill → retry once → PARKED (`deadline.js`'s `callWithDeadline`:
   a state whose `withTimeout` wrapper races out twice in a row — the retry itself also missed
   the deadline, not merely the first attempt — parks `step-deadline-exceeded-twice`, `detail`
   naming the state; a single timeout is retried silently, journalled `deadline-exceeded` but
   never parked). Never two live executors for one
   task. Two independent mechanisms enforce this, because a JS timer cannot preempt a
   synchronous child: `claude -p` calls (LLM steps) are killed by `spawnSync`'s own `timeout`
   option inside `steps/llm.js`'s `invokeClaudeReal`, racing `deadline.js`'s `callWithDeadline`
   as a belt-and-suspenders around the whole call; every `git`/`gh`/`npm` command a scripted step
   spawns *through `spawnStep`* is killed the same way, per `orchestrator/config.js`'s
   `commandTimeoutsMs` table (see below). `callWithDeadline`'s own JS-timer race is a no-op here,
   since a blocking `spawnSync` never yields the event loop for the timer to fire in. Action 2.1
   closed this gap for `spawnStep`'s own call sites: before it, a hung `gh`/`git`/`npm` child
   froze the single-threaded daemon forever, holding the task lock, with nothing to recover it.
   Action 2.1b then found and closed the remaining gap: `board.js`'s `moveCard`, `park-loop.js`'s
   park comment and unpark scan, `report-intake.js`'s report-card/dedup/comment-scan spawns, and
   `intake.js`'s own `gh`/`npm` calls each spawn through their own private `runSync` instead of
   `spawnStep`, and used to carry no timeout at all — every one of them now arms the identical
   class default (`orchestrator/command-timeout.js`, factored out of `spawnStep` for exactly this
   reuse) too. Their failure handling is deliberately different from `spawnStep`'s own
   retry-then-park: none of these four is a mid-task step with something left to park (`moveCard`
   is explicitly best-effort, the other three run in the daemon loop with no task in scope at
   all), so a timeout there is converted into the failure the caller already models — journalled
   with `timedOut: true` so it stays visibly distinct from a plain non-zero exit — never retried,
   never thrown. Every real spawn in the daemon is bounded as of action 2.1b.
4. **Only allowlisted command forms are ever emitted** (58 guard refusals, 26 re-spelling
   episodes measured). The orchestrator's command table is the allowlist; there is nothing to
   re-spell.
5. **PARK is cheap, stalls are not.** PARK is only 18 % of episodes but ~31 % of wasted
   volume: the machine parks early on queue/infra stalls instead of waiting creatively.

## Scripted-step timeouts (action 2.1)

Every real `git`/`gh`/`npm` command any scripted step spawns (`orchestrator/steps/scripted.js`'s
`spawnStep`) is classified by command + leading args and armed with `spawnSync`'s own `timeout`
option, per `orchestrator/config.js`'s `commandTimeoutsMs` -- plus, since action B1.4, the ONE
`bash` call site FINISH's conditional bench-worker reinstall spawns (matched on the exact
`scripts/bench-install.sh` path, never bare `command === 'bash'`, so any OTHER future use of
`bash` in this codebase still falls through to "no class default"):

| Class | Default | Covers |
|---|---|---|
| `git` | 120s | every `git` call (local ops + one round-trip against `origin`) |
| `gh` | 120s | every `gh` call (one REST/GraphQL request — not the CI_CHECKS poll budget above, which bounds the whole loop separately) |
| `npm-ci` | 600s (10 min) | `npm ci` (WORKTREE — a fresh worktree carries no `node_modules`) |
| `npm-gate` | 7800s (130 min), never retried | `npm run gate` (GATE — the bench job). Derived from the bench's own `DEFAULT_WAIT_TIMEOUT_MIN = 120` (7200s), which exits 4 into the designed `gate-timeout` park; our kill stays the last resort behind it. Not retried: a second `npm run gate` re-submits a bench job for the same (worktree, ref), which `job.ts` refuses as a duplicate → exit 2 → a false `gate-dirty-tree` park |
| `npm-run` | 660s (11 min) | every other `npm run <alias>` (`typecheck`, `lint`, `coverage:changed`, `board:take`, `board:move`, `pr:wait`) — bounded below by `pr:wait`'s own internal 600s bound (`scripts/pr-wait.sh`: 20 polls × 30s), so a legitimate "still in the merge queue" `pr:wait` exit is never killed by this timeout first |
| `bench-install` | 900s (15 min) | action B1.4's conditional bench-worker reinstall (`bash scripts/bench-install.sh`) -- never retried on a timeout (spawnStep's own exemption, matching `npm-gate`'s), since a killed `bash` can leave `npm run build:e2e`/`systemctl restart` still running underneath it |

An explicit per-call `timeout` always overrides the class default. Every value has an
`SPO_TIMEOUT_*_MS` env override (see `config.js`).

**Kill → retry once → park, with a class-specific reason.** On a `spawnSync` timeout, Node
reports `status: null` with both `signal` (e.g. `SIGTERM`) and `error.code === 'ETIMEDOUT'` set
— this is branched out *before* the exit-code mapping, so a timeout is never misread as exit 1
(the trap that would otherwise route a hung GATE straight to DIAGNOSE, paying an LLM call to
diagnose a process the daemon itself killed). The killed command is retried once with the same
timeout; if the retry also times out, the task PARKS with a dedicated reason naming the command
class — `git-timed-out` / `gh-timed-out` / `npm-ci-timed-out` / `npm-gate-timed-out` /
`npm-run-timed-out` — never the calling state's own failure reason (so a timed-out GATE parks
`npm-gate-timed-out`, distinct from both `gate-timeout`, the *domain* exit-4 reason `npm run
gate` itself can return, and `DIAGNOSE`, which it never reaches). Both attempts are journaled as
`spawn` events (`attempt: 1`/`2`, `timedOut: true`), so the journal explains the park on its own.

## Daemon-loop and best-effort spawn timeouts (action 2.1b)

Action 2.1's own table above only covers commands a scripted step spawns *through `spawnStep`*.
Four other modules spawn real `git`/`gh`/`npm` through their own private `runSync`, never through
`spawnStep`, and used to carry no timeout at all:

| Module | Spawns | Where it runs |
|---|---|---|
| `board.js` | `npm run board:move` (`moveCard`) | mid-step, called from inside `realWorktree` / `realCheck` / `realGate` / `realMerge` / `postParkComment` |
| `park-loop.js` | `gh issue comment` (park comment, abandon ack), `gh api .../comments` (unpark scan) | after the task is already terminal, or the daemon-loop unpark scan (no task in scope) |
| `report-intake.js` | `npm run report:card`, `gh issue list` (dedup), `gh issue create`, `gh api .../comments` (confirm scan), `gh issue close` | the daemon-loop `autoIntakeMs` / `reportConfirmScanMs` timers (no task in scope) |
| `intake.js` | `gh api issues/<n>`, `gh issue comment`, `gh issue create`, `gh issue edit`, `npm run board:claim` | the maintainer-facing `spo ask` / `spo pull` path and auto-triage.js's driver (its three LLM steps already carry their own `deadlineMs`) |

All four now arm the identical class default from the same table above, via
`orchestrator/command-timeout.js`'s `armTimeout` (`classifyCommand` + `classTimeoutMs`, factored
out of `steps/scripted.js` so board.js — required *by* `steps/scripted.js` — does not have to
require its classifier back out of it). An explicit per-call `timeout` still wins, same as
`spawnStep`.

The failure handling is deliberately NOT `spawnStep`'s retry-then-`ParkSignal` policy:

- `board.js`'s `moveCard` is explicitly best-effort ("never blocks the task" is its own
  documented rule) and runs mid-step — a throw here would break every one of its callers.
- `park-loop.js`'s park comment and abandon ack run once the task is **already terminal**
  (`state.json`/`report.md` already written) — there is nothing left to park.
- `report-intake.js` and `intake.js` run in the daemon loop or the maintainer-facing CLI path,
  outside any task — `ParkSignal` has no task to attach to.

So in all four, a timeout is converted into the failure the caller already models — the
non-zero-exit path each site already has (`board-move-failed`, `park-comment-failed`,
`unpark-scan-failed`, `abandon-ack-failed`, `report-intake`'s own per-report error entries,
`reportConfirmScan`'s error entries, and every `{ok: false, ...}` return in `intake.js`) — tagged
`timedOut: true` so a hang stays visibly distinct from a plain non-zero exit rather than reading
as an ordinary `gh`/`npm` failure. None of the four retries: each is either a best-effort
side-effect or a daemon-loop scan/CLI call that gets another chance on its own next cycle anyway,
so a retry here would only double the exposure for no gain. Every real spawn in the daemon is
bounded as of this action.

## Shadow mode and promotion

1. Shadow on synthetic tasks: exercise every scripted transition, force each failure exit
   code at least once (kill the worker → 3, dirty tree → 2, timeout → 4).
2. Real S-sized cards: measure **parking rate** and **weighted tokens per merged card**
   (usage-report) against the experiment's baseline (≈ $12 API-equivalent per session,
   2026-08 measurement -- dollars are the superseded unit of that historical baseline; the
   comparison itself is now made in billable-weighted tokens, see `orchestrator/tokens.js`).
3. Promotion when parking rate < ~15 % over a representative batch; the old path retires
   card-type by card-type.

## Recette: the supervised live harness (action 2.9)

Step 2 above ("real S-sized cards") needs *something real* to have actually run before its
numbers mean anything -- shadow mode and `--dry-run` only ever prove the state machine's own
logic against fixtures/canned payloads, never that a real card, run for real, produces the
journal a judge was supposed to see. `spo recette` (`orchestrator/recette.js`) is that
something: one trivial, synthetic `kind: "card"` task, driven through the real pipeline
(`config.real = true`) against a dedicated, distinctly-labelled GitHub issue in the product
repo, under a wall-clock + LLM-step-count cap, asserted against its own journal (not merely
"did it reach DONE"), cleaned up unconditionally on every exit path. **This is the standard
live gate for every chantier from 3 on** -- scenarios are plain data
(`orchestrator/recette.js`'s `SCENARIOS`), and for a `driver: 'inline'` scenario that only
changes what IMPLEMENT is asked to do, adding one really is just a new object literal. That
claim is scoped, not general: a scenario that changes *how* the pipeline is driven, not merely
what it asks IMPLEMENT to do, changes the runner too. Chantier 7 action 7.2 did exactly that:
scenarios now carry a `driver`, `inline` keeps this path unchanged, and `dispatcher` drives the
real `createDispatcher` with real worker children -- which needs its own out-of-process cap,
because the inline cap wraps `deps.spawnSync` and a dispatcher's workers are separate processes. It also forwards all seven
scan-timer env vars as `0` to the scanner child (a separate OS process that re-reads `config.js`
from scratch and never sees the parent's config object) -- six of them are genuinely disabled by
`0` (the `should*`/`shouldScan*` predicates all read `!(x > 0)` as "never due"), but
`SPO_REMOTE_REPORT_PULL_MS` is not one of them: `startRemoteReportPullLoop`'s first `tick()` runs
unconditionally on scanner startup regardless of that value, which only sets the reschedule delay
*after* that first pull. What actually keeps a dispatcher-driver scenario safe from a real
pull-and-ack is a second, explicit refusal -- see below. `parallel-doc-log` (K=2) is the scenario
that exercises this driver.

Refuses to run while a live daemon holds its own `journal/daemon.lock` (read-only check,
`--force` to override). Chantier 6 action 6.4 added a real product-repo mutex
(`orchestrator/product-repo-lock.js`), but recette does not itself take it -- WORKTREE and FINISH
acquire it either way, whichever driver ran them: `inline` reaches them through `drainQueueOnce`
in recette's own process, `dispatcher` through a real `daemon.js --worker` child. The lock is
taken inside those two steps (`steps/scripted.js`'s `withProductRepoLock`), not by whatever drove
them, which is what makes both drivers safe against a concurrent daemon without recette knowing
about the mutex at all. The daemon.lock check above is the coarser, earlier guard: it catches "a live daemon is
running at all" before recette starts, which 6.4's lock (scoped to one WORKTREE/FINISH call) does
not by itself. A `dispatcher`-driver scenario carries a second, unrelated refusal: its real
scanner child inherits `SPO_REMOTE_REPORT_URL` from this process's own environment exactly as it
inherits the zeroed scan timers above, and `remote-report-pull.js`'s first pull is unconditional
-- so recette refuses outright when that env var is set (`--force` to override, for a maintainer
who has confirmed by hand that a real pull-and-ack against `~/.spo-reports` is acceptable), rather
than risk a synthetic recette run making a genuine HTTPS pull against production bug reports. See
`orchestrator/README.md` § Recette for the full design: isolation, the `trivial-doc-log` scenario
and why it is docs-only, the cap and what tripping it does, the assertion set, and cleanup's own
idempotency contract.

## Open questions (tracked, not blocking shadow mode)

- Bug-report transport production → dev is no longer open: `remote-report-pull.js` implements
  the HTTPS pull (`config.remoteReportUrl`), live enough to need the recette refusal above.
  Report schema v1 is still open.
- Board sync depth: view-only export vs writing Status/comment at transitions (current
  lean: write at transitions like today, through the existing board scripts).
- Whether CHECK runs inside the IMPLEMENT session (self-check) or only outside (current
  lean: both — the outside run is the one that counts).
