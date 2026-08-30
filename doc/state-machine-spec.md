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
   `finalizePark` path a normal catch-all park uses, the next time any daemon starts or runs its
   periodic scan. See `orchestrator/README.md` § Orphan recovery.
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
| INTAKE | script | take next task file from `queue/` (priority = file order; sources: board export, `/triage-report`, later in-game reports) | WORKTREE | PARKED |
| WORKTREE | script | fresh worktree + branch off last green `main`; refuse if nightly says `main` is red (repair task only) | PLAN | PARKED |
| PLAN | `claude -p` | plan + invariants file + runnable check commands | IMPLEMENT | PARKED (plan invalid/not executable; a transport failure — the call never produced a verdict at all — is `llm-transport-failed:PLAN`, distinct from an invalid plan the model DID produce) |
| IMPLEMENT | `claude -p` | write code + tests in the worktree per plan | CHECK | DIAGNOSE (a transport failure is never routed to DIAGNOSE — it PARKS `llm-transport-failed:IMPLEMENT` instead, since there is no answer for DIAGNOSE to diagnose) |
| CHECK | script | typecheck, lint, `coverage:changed` (≥ 93 % on new/modified lines), invariant substring check | PUSH_PR | DIAGNOSE |
| PUSH_PR | script | commit, push, open PR (`Closes #N`) — PR precedes gate (CI needs it) | GATE | PARKED |
| GATE | script | `npm run gate` (bench job, background wait); read **exit code**: 0 PASS · 1 fail · 2 dirty · 3 worker down · 4 timeout | CI_CHECKS | 1 → DIAGNOSE · 2/3/4 → PARKED |
| CI_CHECKS | script | Two checks the bench does not make. (a) `gh pr checks <n>` once — CI normally concluded while the gate queued; on red, map the failing check **by name**: `Coverage of changed lines` → IMPLEMENT · `Lint` → IMPLEMENT · `PR rules` (protected files, needs `rdo-approved`) → PARKED · anything else → DIAGNOSE. (b) the `main`-moved test: intersect `git diff --name-only <baseMain>..origin/main` with the branch's changed files — non-empty → merge `origin/main`, back to CHECK and re-gate (once; a second move → PARKED); while the nightly says `main` is red, never merge from it → PARKED. *(Added in v1.1: 5/16 measured sessions reached a green gate and could not merge — every one improvised CI forensics; 4/16 needed the `main`-moved branch.)* | VALIDATE | per cause table |
| DIAGNOSE | `claude -p` | one-line root cause from diff + gate log + ledger (diff.patch and, when entered from GATE, gate.log are really generated on entry — `steps/scripted.js`'s `prepareJudgeInputs`/`realGate`; gate.log is required only when this DIAGNOSE was entered from GATE, never from a CHECK failure or an empty IMPLEMENT, where no gate has run yet); append to ledger. The reply is one of two mutually-exclusive shapes: `root_cause: "<string>"` (+ category/suggested_fix), or the honest `root_cause: null` (+ a one-line `reason`) meaning "no cause beyond what the ledger already has" — a present-but-null `root_cause` satisfies the output contract, it is never treated as a missing answer. | IMPLEMENT (retry) | PARKED (3 attempts, same root cause twice → `diagnose-duplicate-root-cause`; the model explicitly has no new cause → `diagnose-no-new-cause`; a transport failure — no verdict produced at all — → `llm-transport-failed:DIAGNOSE`, never fabricated as a cause; or gate.log required but unproducible when entered from GATE → `judge-inputs-missing`) |
| VALIDATE | `claude -p` ×1–2 | `citation-verifier` (only if `rdo-members.ts` changed) then `change-validator`; JSON verdicts. Its declared `diff.patch` is really generated on entry (`prepareJudgeInputs`) — always producible post-PUSH_PR. citation-verifier is fail-closed: a verifier that cannot render a verdict (transport error, timeout, malformed payload) parks the card — it never passes by default. | MERGE | REJECT → IMPLEMENT (own budget of 3) · false citation → PARKED (`citation-false`) · verifier couldn't answer → PARKED (`citation-verifier-failed`) · verdict the code doesn't recognize → PARKED (`citation-verifier-unrecognized-verdict`) · change-validator transport failure (no verdict produced at all) → PARKED (`llm-transport-failed:VALIDATE`) · diff.patch unproducible → PARKED (`judge-inputs-missing`) |
| MERGE | script | `gh pr merge --merge` (enqueues), `npm run pr:wait`; exit code is the verdict. Exit 4 (still open) → **one** more bounded wait, then PARKED. The queue is never dequeued, re-enqueued, `--admin`-forced or fed empty commits by the machine — the measured costliest improvisation family (24 episodes; one wrote Done on an open PR). | FINISH | PARKED |
| FINISH | script | fast-forward main checkout, reap worktree, close task (board sync: Done + short comment) | DONE | PARKED |

Ledger per task (`journal/<task>/ledger.md`): one line per attempt —
`attempt N | root cause | outcome`. The 3-attempts rule is a string comparison over it.

## Step contracts

| Step | Model | Effort | Tools | Output | Budget cap |
|---|---|---|---|---|---|
| PLAN | Fable 5 (Opus 5 fallback) | per task size S/M/L → low/medium/high | Read, Grep, Glob, Bash(ro) | plan.md + invariants + check commands (`--json-schema` envelope) | per-step USD cap |
| IMPLEMENT | Sonnet 5 — **Opus 5 on the wire rule** (`src/shared/rdo-*`, `src/server/rdo.ts`, `rdo-members.ts`, session phases) or L-sized task | per size | full edit tools in the worktree | diff summary + invariant rows + files-changed list (JSON) | per-step USD cap |
| DIAGNOSE | Fable 5 | high | Read, Grep, Bash(ro) | one-line root cause (JSON) | small |
| VALIDATE: citation-verifier | Fable 5 | high | Read, Grep (product + `~/SPO-Original`, read-only) | PASS / REJECT / DIVERGES (JSON) | small |
| VALIDATE: change-validator | Fable 5 (never Sonnet — the executor may not judge itself) | high | Read, Grep, Glob, Bash(ro) | PASS / PASS WITH FINDINGS / REJECT + findings (JSON) | small |

Every `claude -p` call: `--output-format json` (result, cost, **session_id**),
`--json-schema` for the payload, `--max-budget-usd`, `--allowedTools`, `--model`, `--effort`,
`--permission-mode` per step, run under the account chosen by the scheduler
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
- The scheduler assigns each step an account; a limit error (5 h window / weekly cap) puts
  the account in **cooldown** until its window resets and the step retries on the next
  healthy account. Cooldowns are journal events.
- **K parallel workers ≤ healthy accounts.** Parallelism scales implementation capacity;
  the gate stays serialized (one live world) — adding an account does not add gate
  throughput.
- `scripts/usage-report.js` becomes per-account: it is the instrument that says when one
  more subscription pays for itself.

## Observability — sessions and pipeline (the console)

Journals are the single source of truth; `~/.spo-bench/` remains the bench's own surface.

- `journal/<task-id>.jsonl` — every event: state transitions, step spawns and results
  (`{step, model, effort, account, session_id, cost_usd, duration_s, exit, verdict}`),
  account cooldowns, parkings (with reason), attempts.
- **Claude session management**: the `session_id` of every step is recorded, so any step can
  be reopened for debugging with `claude --resume <session_id>` (full transcript, continue
  interactively). `claude agents` lists live background sessions.
- Console CLI (planned order): `spo status` (queue, active tasks + state, bench queue,
  accounts health, today's spend) · `spo task <id>` (timeline from the journal) ·
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
   task.
4. **Only allowlisted command forms are ever emitted** (58 guard refusals, 26 re-spelling
   episodes measured). The orchestrator's command table is the allowlist; there is nothing to
   re-spell.
5. **PARK is cheap, stalls are not.** PARK is only 18 % of episodes but ~31 % of wasted
   volume: the machine parks early on queue/infra stalls instead of waiting creatively.

## Shadow mode and promotion

1. Shadow on synthetic tasks: exercise every scripted transition, force each failure exit
   code at least once (kill the worker → 3, dirty tree → 2, timeout → 4).
2. Real S-sized cards: measure **parking rate** and **weighted tokens per merged card**
   (usage-report) against the experiment's baseline (≈ $12 API-equivalent per session,
   2026-08 measurement).
3. Promotion when parking rate < ~15 % over a representative batch; the old path retires
   card-type by card-type.

## Open questions (tracked, not blocking shadow mode)

- Bug-report transport production → dev (HTTPS pull vs file pickup) and report schema v1.
- Board sync depth: view-only export vs writing Status/comment at transitions (current
  lean: write at transitions like today, through the existing board scripts).
- Whether CHECK runs inside the IMPLEMENT session (self-check) or only outside (current
  lean: both — the outside run is the one that counts).
