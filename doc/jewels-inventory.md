# Jewels inventory

The assets that carry the project's real value, and what happens to each in the v2 migration.
Rule of thumb: **the jewels are domain knowledge and live-verification machinery; the
experiment is orchestration prose.** The first survives untouched or migrates whole; the
second is retired and replaced by the orchestrator.

## The jewels

| Asset | Where today (SPO-WebClient unless noted) | Destination | Why it matters |
|---|---|---|---|
| RDO catalogue + emitter + type system | `src/shared/rdo-members.ts`, `rdo-frame.ts`, `rdo-types.ts`, `src/server/rdo.ts`, request guards | **stays in the product** | The protocol *is* the project; a wire divergence is the one irreplaceable failure |
| Mock RDO server + strict validator (L1) + 7 custom matchers | `src/mock-server/`, `src/__tests__` matchers | stays in the product | Protocol conformance on every PR, no live world needed |
| Bench worker + L2 live gate + nightly + verdicts | `scripts/bench-*`, `src/e2e/bench/`, systemd unit, `~/.spo-bench/` | **migrates → SPO-Pipeline `bench/`** | The pre-production environment; the only proof a patch works against the real world |
| L2/L3 live flows + evidence discipline | `src/e2e/`, `doc/E2E-POLICY.md`, `doc/E2E-TESTING.md` | migrates → SPO-Pipeline | Encodes the live-testing knowledge: Survival-log proof, lagging read-backs, 3-attempt rule |
| Blast-radius policy + LOCKED accounts | product `CLAUDE.md` § E2E credentials, E2E-POLICY §7 | **now `accounts/spo-test-accounts.yml`** here | The wall of pre-production (isolation is policy, not network) |
| Citation discipline vs the Delphi source | product `CLAUDE.md` § RDO / § SPO-Original, `citation-verifier` agent | prompt → SPO-Pipeline `prompts/`; rules stay in product domain docs | Kind/arity from `RDOObjectServer.pas` or nothing; false citations are how the server dies |
| Domain references | `doc/civic-roles-reference.md`, `facility-tabs-reference.md`, `research-system-reference.md`, `spo-original-reference.md`, `supply-system.md`, road/concrete/texture docs | stay in the product | Product knowledge, not process; steps read them from the worktree |
| Legacy source trees | `~/SPO-Original`, `~/SPO-ASP` (separate repos, read-only) | unchanged | The authority for kind/arity and for what Voyager demonstrably emitted |
| Validator / reviewer prompts | `.claude/agents/change-validator.md`, `citation-verifier.md`, `card-reviewer.md` | become step prompts → SPO-Pipeline `prompts/` | The judgement steps of the state machine |
| Operational traps knowledge | product `CLAUDE.md` (gh pr edit broken, merge-queue semantics, `--delete-branch` kill, ISO-8859 `.pas` files, verdict-by-exit-code) | folded into step prompts and orchestrator code here | Hard-won; the orchestrator encodes them as code instead of prose |
| Live server logs surface | `http://158.69.153.134/logs/` reading discipline (product `CLAUDE.md`) | documented here + in step prompts | How a live run is proved rather than assumed |
| Product domain half of `CLAUDE.md` | product `CLAUDE.md` | **stays, trimmed to domain** (RDO rules, legacy source, style) | Loaded by every implement/plan step working in the worktree |

## The experiment — retired at strangler step 4

| Artifact | Fate |
|---|---|
| `.claude/commands/next-task.md` (39 KB driver choreography) | replaced by the orchestrator state machine |
| Kanban governance as a *locking* system (ownership law, Area reservations, heartbeats, GraphQL budget discipline) | the board becomes a **view + priority input**; a single orchestrator needs no distributed locks |
| The 18 anti-drift hooks (driver-scope, poll-loop, verdict-pipe, item-list guards…) | pointless without an LLM driver; scripts do not drift |
| Invariant files + attempt ledgers as anti-driver defense | the mechanism survives as plain orchestrator state (ledger per task), the defense rationale dies |
| Model routing as prose | becomes `--model` / `--effort` parameters per step |
| Session worktree machinery (`finish`, heartbeat reaping) | orchestrator-managed worktrees |

Retirement is gradual: nothing is deleted from the product until the old path stops being
exercised (strangler step 4), and every deletion goes through a product PR + gate like any
other change.
