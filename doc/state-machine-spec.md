# Orchestrator state-machine spec — v1.1

Status: **draft for shadow mode**, revised against the measured improvisation analysis
([improvisation-analysis.md](improvisation-analysis.md), phase 2: 16 card sessions, 35.2 %
of driver actions improvised, dispositions BRANCH 78 % · PARK 18 % · DIAGNOSE 4 %). v1.1
adds the two states that analysis found missing (CI_CHECKS, the `main`-moved transition) and
the design consequences at the bottom.

## Principles

1. **Exit codes are the contract.** Every scripted step is judged on its exit code, never on
   printed text — the convention every existing script already follows.
2. **The catch-all is the error policy.** Any state, exit code or output the machine does not
   recognize → the task is **parked**: worktree left intact, one report written, one journal
   event, zero further tokens. Explicit error handling means a safe cheap catch-all, not
   foreseeing everything. Parked tasks are handled by the maintainer or an interactive
   session; every parking reason that recurs becomes a new branch (frequency-ordered). One
   case a task cannot produce a park for itself: the daemon *process* dying mid-run (crash,
   hard kill, a lost single-instance lock). `orchestrator/orphan-scan.js` covers it
   *a posteriori* — a `state.json` left on a non-terminal state with no `queue/` entry and a
   dead owner pid is reparked automatically (`task-orphaned-daemon-restart`) through the same
   `finalizePark` path a normal catch-all park uses (including restoring `worktreePath` onto the
   rebuilt ctx, so a still-dirty worktree is pushed to a `wip/` ref exactly as a live park would),
   the next time a `--real` daemon starts or runs its periodic scan. A `--shadow`/`--dry-run`
   start never does real side effects, so it only detects the orphan and journals
   `orphan-scan-would-repark` — it never parks. See `orchestrator/README.md` § Orphan recovery.
3. **LLM steps are stateless calls.** Each judgement step is one `claude -p` invocation with
   a pinned model, effort, tool set, JSON output schema and budget. Continuity between steps
   travels through files (plan, ledger, diff), never through a long-lived conversation.
4. **The jewels are not re-implemented.** The bench, the validators' criteria and the
   blast-radius policy are used as-is.
5. **Everything is journaled.** One append-only JSONL journal per task; the console renders
   journals, it never holds state of its own.

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
| WORKTREE | script | fresh worktree + branch off last green `main`; refuse if nightly says `main` is red (repair task only) | PLAN | PARKED |
| PLAN | `claude -p` | plan + invariants file + runnable check commands + `files_to_change` (action 3.2 — the plan's own declared list of files it will change; a sibling `optional` field of the output contract, not `required`, so its absence never parks — see step-contracts.js); once written, the driver resolves every invariant against the worktree and journals the result as the CHECK baseline (action 1.8) — an invariant that fails to resolve here is logged and excluded from that baseline, never a park, never a re-run of PLAN. **Action 3.1:** real mode only — shadow and `--dry-run` never reuse, checked explicitly as the guard's first condition. On a `retry` after a park, PLAN is skipped entirely (no LLM call) when the plan already on disk from the run that parked is still valid: `origin/main` has not moved since it was written, both plan/invariants files are still present, are regular files, and non-empty, the last PLAN `result` payload is not itself a failure (a transport-failure payload carries no `plan_path`/`invariant_ids`/`check_commands` to hand IMPLEMENT), and the park that ended the previous run was not one of the seven reasons that indict the plan itself (`plan-invalid`, `plan-requires-protected-files`, `diagnose-duplicate-root-cause`, `diagnose-no-new-cause`, `diagnose-budget-exhausted`, `validate-reject-budget-exhausted`, `ci-retry-budget-exhausted`) — every other park reason (transport failures, gate/CI failures, claim losses, merge conflicts) is orthogonal to whether the plan was right. The invariants baseline is still rebuilt fresh against the retried worktree either way; the plan/invariants text and PLAN's own declared `invariant_ids`/`check_commands` are carried forward with `plan_path`/`invariants_path` stamped explicitly (not merely trusted to already be present on the carried-forward payload), journalled as `plan-reused`. See `orchestrator/state-machine.js`'s `decidePlanReuse`. | IMPLEMENT | PARKED (plan invalid/not executable; a transport failure — the call never produced a verdict at all — is `llm-transport-failed:PLAN`, distinct from an invalid plan the model DID produce; **action 3.2:** `plan-requires-protected-files` — `{source: 'files_to_change', matches, declaredFiles}` when an entry of the model's own declared `files_to_change` names a protected file, scanned before any scratch file is written. `plan_markdown` prose is never scanned — measured at 33% precision (2 false positives against 1 true positive across all 17 real plans) and dropped for that reason. When `files_to_change` is absent, `null`, not an array, or contains a non-string entry, PLAN does not park and does not fall back to scanning prose — it journals `plan-files-undeclared` and proceeds normally; an empty array counts as a clean declaration, not an undeclared one) |
| IMPLEMENT | `claude -p` | write code + tests in the worktree per plan | CHECK | DIAGNOSE (a transport failure is never routed to DIAGNOSE — it PARKS `llm-transport-failed:IMPLEMENT` instead, since there is no answer for DIAGNOSE to diagnose) |
| CHECK | script | invariant substring check first (action 1.8: `orchestrator/invariants.js` re-resolves the PLAN-time baseline against the worktree as it now stands — an id that resolved at PLAN and no longer does is the one regression this fails on; one PLAN itself could never resolve was already excluded from the baseline and can never fail here; a missing/unparsable invariants file is journalled, never a failure), pure `fs`, no spawn, run before the three subprocess checks below so a free check never waits behind three that cost a spawn each; then typecheck, lint, `coverage:changed` (≥ 93 % on new/modified lines) | PUSH_PR | DIAGNOSE |
| PUSH_PR | script | commit, push, open PR (`Closes #N`) — PR precedes gate (CI needs it) | GATE | PARKED |
| GATE | script | `npm run gate` (bench job, background wait); read **exit code**: 0 PASS · 1 fail · 2 dirty · 3 worker down · 4 timeout. **Action 4.2:** exit 1 is no longer an unconditional route to DIAGNOSE — the exit code alone conflates three different situations the bench itself distinguishes. Read the bench's own verdict for HEAD (`<spoBenchDir>/verdicts/<sha>.json`, the same file CI_CHECKS reads below for its own `main`-moved test): the bench merges `origin/main` into the checkout itself before building (`worker.ts`'s `prepareRef`), so `baseMain` is absent from that file precisely when the branch no longer merges cleanly with `origin/main` — measured over all 375 `ref`-type verdicts `npm run gate` submits: 359/359 PASS carry `baseMain`, 14/16 FAIL do; the missing 2 are exactly the main-moved conflicts (confirmed end to end on card #439 / commit `379ada60`, which burned all 3 DIAGNOSE attempts and parked `diagnose-budget-exhausted` before a `retry` — a fresh worktree off the new `main` — reached DONE in 19 minutes). No verdict file **on disk** means the run is *non-attesting* (`worker.ts`'s `NON_ATTESTING = {DIRTY, ENVIRONMENT, ABANDONED}` is deliberately never written to `verdicts/`, yet `cli.ts`'s `wait()` still maps all three to exit 1) — nothing was learned about the code, so it parks rather than spending a DIAGNOSE call on it. A FAIL that DOES carry `baseMain` failed with `origin/main` already merged in by the bench; that is a real failure and still routes to DIAGNOSE, unchanged. A FAIL *without* `baseMain` fetches `origin/main` and attempts the same local merge CI_CHECKS' own `main`-moved path performs (below) — clean → back to CHECK and re-gate; conflict → `merge --abort` then PARKED. The plan's own intersection test is deliberately not implemented for this path: with no `baseMain` there is nothing to intersect against. | CI_CHECKS | exit 1 with a verdict carrying `baseMain` → DIAGNOSE (unchanged) · exit 1 and the lookup itself failed — `rev-parse HEAD` non-zero, or exit 0 with stdout that is not an object name (a failing `git rev-parse` prints the ref name itself, action 4.1's measurement), or a verdict file that is present but does not parse — → DIAGNOSE, journalled `gate-verdict-unreadable`, never a park: a failed diagnostic must not become the thing that parks the card · exit 1, no verdict file on disk → PARKED (`gate-non-attesting`, detail carries `verdictDirExists` so a misconfigured `spoBenchDir` is one look) · exit 1, FAIL without `baseMain`, merge conflicts → PARKED (`main-moved-conflict`) · main already moved once this task → PARKED (`main-moved-twice`, counter shared with CI_CHECKS) · nightly says `main` is red at the fetched sha → PARKED (`main-red-no-merge`, guard shared with CI_CHECKS) · 2/3/4 → PARKED |
| CI_CHECKS | script | Two checks the bench does not make. (0) Before either: a bounded **in-flight wait** (action 1.7) — a check-run with `conclusion: null` (still running) or zero check-runs at all (CI hasn't registered anything yet) is never read as green; re-poll `gh api .../check-runs` up to `ciChecksMaxPolls` times (default 30), sleeping `ciChecksPollIntervalMs` between polls (default 20000ms, injectable in tests; ~10 min total, deliberately uncalibrated — see config.js), journaling each observation, until nothing is in flight. *(2026-08-30 audit: 8/12 measured "green" events had `claude review` still in progress.)* (a) `gh pr checks <n>` once nothing is in flight — CI normally concluded while the gate queued; on red, map the failing check **by name**: `Coverage of changed lines` → IMPLEMENT · `Lint` → IMPLEMENT · `PR rules` (protected files, needs `rdo-approved`) → PARKED · anything else → DIAGNOSE. (b) the `main`-moved test: intersect `git diff --name-only <baseMain>..origin/main` with the branch's changed files — non-empty → merge `origin/main`, back to CHECK and re-gate (once; a second move → PARKED); while the nightly says `main` is red, never merge from it → PARKED. *(Added in v1.1: 5/16 measured sessions reached a green gate and could not merge — every one improvised CI forensics; 4/16 needed the `main`-moved branch.)* **Action 4.2:** the `mainMoveUsed` counter and the nightly-red guard are the exact same shared state GATE's own main-moved path (above) uses — a move already spent from either state blocks the other, and a nightly-red main blocks a merge attempted from either. | VALIDATE | per cause table, or still in flight after the bounded wait → PARKED (`ci-checks-still-running`) |
| DIAGNOSE | `claude -p` | one-line root cause from diff + gate log + ledger (diff.patch and, when entered from GATE, gate.log are really generated on entry — `steps/scripted.js`'s `prepareJudgeInputs`/`realGate`; gate.log is required only when this DIAGNOSE was entered from GATE, never from a CHECK failure or an empty IMPLEMENT, where no gate has run yet); append to ledger. The reply is one of two mutually-exclusive shapes: `root_cause: "<string>"` (+ category/suggested_fix), or the honest `root_cause: null` (+ a one-line `reason`) meaning "no cause beyond what the ledger already has" — a present-but-null `root_cause` satisfies the output contract, it is never treated as a missing answer. | IMPLEMENT (retry) | PARKED (3 attempts, same root cause twice → `diagnose-duplicate-root-cause`; the model explicitly has no new cause → `diagnose-no-new-cause`; a transport failure — no verdict produced at all — → `llm-transport-failed:DIAGNOSE`, never fabricated as a cause; or gate.log required but unproducible when entered from GATE → `judge-inputs-missing`) |
| VALIDATE | `claude -p` ×1–2 | `citation-verifier` (only if `rdo-members.ts` changed) then `change-validator`; JSON verdicts. Its declared `diff.patch` is really generated on entry (`prepareJudgeInputs`) — always producible post-PUSH_PR. citation-verifier is fail-closed: a verifier that cannot render a verdict (transport error, timeout, malformed payload) parks the card — it never passes by default. A REJECT's `reasons`/`findings` are appended to the ledger and threaded into the next IMPLEMENT's `diagnosis` placeholder (action 1.6), attributed as a VALIDATE rejection distinct from a DIAGNOSE finding — if both exist for a task, the most recently journaled one leads and the other stays visible for context. | MERGE | REJECT → IMPLEMENT (own budget of 3) · false citation → PARKED (`citation-false`) · verifier couldn't answer → PARKED (`citation-verifier-failed`) · verdict the code doesn't recognize → PARKED (`citation-verifier-unrecognized-verdict`) · change-validator transport failure (no verdict produced at all) → PARKED (`llm-transport-failed:VALIDATE`) · diff.patch unproducible → PARKED (`judge-inputs-missing`) |
| MERGE | script | `gh pr merge --merge` (enqueues), `npm run pr:wait`; exit code is the verdict. Exit 4 (still open) → **one** more bounded wait, then PARKED. The queue is never dequeued, re-enqueued, `--admin`-forced or fed empty commits by the machine — the measured costliest improvisation family (24 episodes; one wrote Done on an open PR). | FINISH | PARKED |
| FINISH | script | fast-forward main checkout, reap worktree, close task (board sync: Done + short comment) | DONE | PARKED |

Ledger per task (`journal/<task>/ledger.md`): one line per attempt —
`attempt N | root cause | outcome`. The 3-attempts rule is a string comparison over it. A
VALIDATE REJECT gets its own line, same shape but a distinct leading word so the two can never
be confused: `validate-reject N | reasons | outcome` (action 1.6).

## Step contracts

| Step | Model | Effort | Tools | Output | Wall-clock deadline |
|---|---|---|---|---|---|
| PLAN | Fable 5 (Opus 5 fallback) | per task size S/M/L → low/medium/high | Read, Grep, Glob, Bash(ro) | plan.md + invariants + check commands + `files_to_change` (`--json-schema` envelope; `files_to_change` is `optional`, not in the schema's `required`) | 900000ms / 15min |
| IMPLEMENT | Sonnet 5 — **Opus 5 on the wire rule** (`src/shared/rdo-*`, `src/server/rdo.ts`, `rdo-members.ts`, session phases) or L-sized task | per size | full edit tools in the worktree | diff summary + invariant rows + files-changed list (JSON) | 900000ms / 15min |
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

Every `claude -p` call: `--output-format json` (result, cost, **session_id**),
`--json-schema` for the payload, `--allowedTools`, `--model`, `--effort`,
`--permission-mode` per step (plus `--max-budget-usd` when a caller supplies a numeric
`maxBudgetUsd` — no daemon or intake path does; the only caller that does is the hand-run
`scripts/smoke-llm.js`), run under the account chosen by the scheduler
(`CLAUDE_CONFIG_DIR=<account dir>`). Domain context comes from the product worktree's
(trimmed) `CLAUDE.md` plus the step prompt from `prompts/`.

## Account pool

- **One place holds account information** (maintainer decision, 2026-08-29): the pool
  directory, default `~/.claude-accounts` (`SPO_ACCOUNTS_DIR` overrides it) — no separate
  registry file, no implicit fallback to the machine's ambient `claude` login. Every
  subdirectory of the pool is one account and is that account's own `CLAUDE_CONFIG_DIR`,
  authenticated once via `claude setup-token`; see `doc/setup.md` § Accounts for the guided
  procedure (`spo account add <name>`).
- A pool with zero registered accounts is a hard stop for real mode: `orchestrator/accounts.js`'s
  `pick()` throws `NoAccountsRegisteredError`, the state machine parks on it, and
  `daemon.js --real` refuses to even start.
- The scheduler assigns each step an account; a limit error puts the account in **cooldown**
  and the step retries on the next healthy account. Cooldowns are journal events.
  `orchestrator/steps/llm.js`'s `classifyFailure` (action 3.5) recognizes a limit only from
  structured signals — `api_error_status` 429 (**observed**: `intake.js:711`'s 12.8-hour Fable
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
  usage cooldown, rejected before it shipped). The real pool has **2 accounts**, and
  `daemon.js` has no pool-health gate: with `maxAttempts` equal to pool size, two usage limits
  inside one window would take the *whole pool* down for up to 5 hours, parking every card the
  daemon pulled in that window. A flat 5h also over-waits by construction — the Claude Max
  session window resets 5h after the *session's first message*, not after the limit hit, so
  `now + 5h` sleeps for (5h − the true remaining wait) longer than necessary, often 4h+. So:
  a first usage limit for an account (`limitKind: 'usage'`, i.e. 429 / `rate_limit_error` /
  `usage_limit_reached`) cools it for a **1-hour probe**; a usage limit landing again within a
  **2-hour escalation window** of that account's last one cools it for the real observed
  **5-hour** Claude Max session window instead (the probe just proved the window is still open).
  `overloaded` (529 / `overloaded_error`) stays a flat **5 minutes** and never escalates — a busy
  *server* says nothing about this account's own quota. An absent/unrecognised limit kind falls
  back to the usage flow (probe or escalated, by the same history check), never a shorter tier.
  Exhausting the pool inside one rotation pass never re-calls `pick()`, so the resulting park/
  error carries the last cooldown's own ISO timestamp explicitly rather than relying on `pick()`'s
  own reason string, which that path never reaches.
- This rotation rule is not daemon-only: `orchestrator/intake.js`'s three maintainer/auto-triage
  LLM steps (draftCard, reviewCard, triageBugReport) follow it too, via their own
  `callIntakeStepWithRotation` helper — same pick/call/cool/rotate mechanics as
  `state-machine.js`'s `callLlmStep`, bounded to one pass over the pool. Two differences, both
  required by intake's "never throw for a recognized failure" contract: exhausting the pool
  becomes `{ok: false, error}` rather than a `ParkSignal`, and — since intake has no per-task
  journal of its own — a cooldown comes back on the result's `cooldowns` array for the caller to
  journal (`auto-triage.js` appends `report-triage-cooldown`). See `orchestrator/README.md`'s
  "Account rotation" section for the full mechanics.
- **K parallel workers ≤ healthy accounts.** Parallelism scales implementation capacity;
  the gate stays serialized (one live world) — adding an account does not add gate
  throughput.
- `scripts/usage-report.js` becomes per-account: it is the instrument that says when one
  more subscription pays for itself.

## Observability — sessions and pipeline (the console)

Journals are the single source of truth; `~/.spo-bench/` remains the bench's own surface.

- `journal/<task-id>.jsonl` — every event: state transitions, step spawns and results
  (`{step, model, effort, account, session_id, tokensSource, freshInputTokens,
  cacheCreationTokens, cacheReadTokens, outputTokens, billableTokens, duration_s, exit,
  verdict}` — no dollar figure anywhere; `orchestrator/tokens.js`'s "billable-weighted" =
  fresh input + cache-creation + output, cache-read reported separately, never summed in),
  account cooldowns, parkings (with reason), attempts.
- **Claude session management**: the `session_id` of every step is recorded, so any step can
  be reopened for debugging with `claude --resume <session_id>` (full transcript, continue
  interactively). `claude agents` lists live background sessions.
- Console CLI (planned order): `spo status` (queue, active tasks + state, bench queue,
  accounts health, today's token usage) · `spo task <id>` (timeline from the journal) ·
  `spo parked` (parked tasks + reasons) · `spo resume <session_id>` (wraps
  `claude --resume`). A generated static HTML dashboard comes after the CLI, fed by the same
  journals.
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
   with a deadline, on expiry kill → retry once → PARKED. Never two live executors for one
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
option, per `orchestrator/config.js`'s `commandTimeoutsMs`:

| Class | Default | Covers |
|---|---|---|
| `git` | 120s | every `git` call (local ops + one round-trip against `origin`) |
| `gh` | 120s | every `gh` call (one REST/GraphQL request — not the CI_CHECKS poll budget above, which bounds the whole loop separately) |
| `npm-ci` | 600s (10 min) | `npm ci` (WORKTREE — a fresh worktree carries no `node_modules`) |
| `npm-gate` | 7800s (130 min), never retried | `npm run gate` (GATE — the bench job). Derived from the bench's own `DEFAULT_WAIT_TIMEOUT_MIN = 120` (7200s), which exits 4 into the designed `gate-timeout` park; our kill stays the last resort behind it. Not retried: a second `npm run gate` re-submits a bench job for the same (worktree, ref), which `job.ts` refuses as a duplicate → exit 2 → a false `gate-dirty-tree` park |
| `npm-run` | 660s (11 min) | every other `npm run <alias>` (`typecheck`, `lint`, `coverage:changed`, `board:take`, `board:move`, `pr:wait`) — bounded below by `pr:wait`'s own internal 600s bound (`scripts/pr-wait.sh`: 20 polls × 30s), so a legitimate "still in the merge queue" `pr:wait` exit is never killed by this timeout first |

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
live gate for every chantier from 3 on** -- chantier 7 action 7.2 adds a second scenario to the
same harness rather than a new tool; scenarios are plain data
(`orchestrator/recette.js`'s `SCENARIOS`), so the runner never has to change to gain one.

Refuses to run while a live daemon holds its own `journal/daemon.lock` (read-only check,
`--force` to override) -- there is no product-repo mutex until chantier 6 action 6.4, so this is
the only guard available today against a recette run colliding with a real card the daemon is
mid-flight on. See `orchestrator/README.md` § Recette for the full design: isolation, the
`trivial-doc-log` scenario and why it is docs-only, the cap and what tripping it does, the
assertion set, and cleanup's own idempotency contract.

## Open questions (tracked, not blocking shadow mode)

- Bug-report transport production → dev (HTTPS pull vs file pickup) and report schema v1.
- Board sync depth: view-only export vs writing Status/comment at transitions (current
  lean: write at transitions like today, through the existing board scripts).
- Whether CHECK runs inside the IMPLEMENT session (self-check) or only outside (current
  lean: both — the outside run is the one that counts).
