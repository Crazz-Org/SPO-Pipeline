# Orchestrator state-machine spec — v1

Status: **draft for shadow mode**. This is the contract the daemon implements; it will be
revised against the measured improvisation rate mined from the experiment's transcripts
(audit phase 2) before the first real card runs.

## Principles

1. **Exit codes are the contract.** Every scripted step is judged on its exit code, never on
   printed text — the convention every existing script already follows.
2. **The catch-all is the error policy.** Any state, exit code or output the machine does not
   recognize → the task is **parked**: worktree left intact, one report written, one journal
   event, zero further tokens. Explicit error handling means a safe cheap catch-all, not
   foreseeing everything. Parked tasks are handled by the maintainer or an interactive
   session; every parking reason that recurs becomes a new branch (frequency-ordered).
3. **LLM steps are stateless calls.** Each judgement step is one `claude -p` invocation with
   a pinned model, effort, tool set, JSON output schema and budget. Continuity between steps
   travels through files (plan, ledger, diff), never through a long-lived conversation.
4. **The jewels are not re-implemented.** The bench, the validators' criteria and the
   blast-radius policy are used as-is.
5. **Everything is journaled.** One append-only JSONL journal per task; the console renders
   journals, it never holds state of its own.

## Task lifecycle

```
INTAKE → WORKTREE → PLAN → IMPLEMENT → CHECK → PUSH_PR → GATE → VALIDATE → MERGE → FINISH → DONE
                      ▲         ▲                  │         │
                      │         └── DIAGNOSE ◄─────┘         │  (gate FAIL, ≤3 attempts,
                      │                │                     │   each a distinct root cause)
                      │                └─────────────────────┘  (validator REJECT, own budget ≤3)
  any state ──────────┴──────────────────────────────► PARKED (catch-all: report + stop)
```

| State | Kind | Does | Success → | Failure → |
|---|---|---|---|---|
| INTAKE | script | take next task file from `queue/` (priority = file order; sources: board export, `/triage-report`, later in-game reports) | WORKTREE | PARKED |
| WORKTREE | script | fresh worktree + branch off last green `main`; refuse if nightly says `main` is red (repair task only) | PLAN | PARKED |
| PLAN | `claude -p` | plan + invariants file + runnable check commands | IMPLEMENT | PARKED (plan invalid/not executable) |
| IMPLEMENT | `claude -p` | write code + tests in the worktree per plan | CHECK | DIAGNOSE |
| CHECK | script | typecheck, lint, `coverage:changed` (≥ 93 % on new/modified lines), invariant substring check | PUSH_PR | DIAGNOSE |
| PUSH_PR | script | commit, push, open PR (`Closes #N`) — PR precedes gate (CI needs it) | GATE | PARKED |
| GATE | script | `npm run gate` (bench job, background wait); read **exit code**: 0 PASS · 1 fail · 2 dirty · 3 worker down · 4 timeout | VALIDATE | 1 → DIAGNOSE · 2/3/4 → PARKED |
| DIAGNOSE | `claude -p` | one-line root cause from diff + gate log + ledger; append to ledger | IMPLEMENT (retry) | PARKED (3 attempts, or same root cause twice) |
| VALIDATE | `claude -p` ×1–2 | `citation-verifier` (only if `rdo-members.ts` changed) then `change-validator`; JSON verdicts | MERGE | REJECT → IMPLEMENT (own budget of 3) · false citation → PARKED |
| MERGE | script | `gh pr merge --merge` (enqueues), `npm run pr:wait`; exit code is the verdict | FINISH | PARKED |
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

- Registry in `claude-accounts/` (git-ignored): one `CLAUDE_CONFIG_DIR` per Claude Max
  account, authenticated once via `claude setup-token`.
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
