# Environments

Three environments, one singularity: **there is only one live game world**, so pre-production
shares its backend with production. Isolation between them is not a network boundary — it is
a *blast-radius policy*. This document is the reference for which code runs where, and what
flows between them.

## The three environments

| Environment | Code | Backend | Purpose |
|---|---|---|---|
| **Development** | local branch | mock RDO server (L1) — never the live world; throwaway gateways on ports 8081+ | write and test fast, outside the real world |
| **Pre-production = the L2 LIVE gate** | candidate branch | **the production Delphi servers** (`planitia`, Free Space zone) | prove a patch against the real world before merge |
| **Production** | latest `v*` Release | the same Delphi servers, player-facing | serve players; emit bug reports toward dev |

## Pre-production: isolation is the blast-radius policy

The pre-prod gateway is built from the candidate branch by the bench worker (one owner:
port 8080, serialized jobs) and driven headless against the live servers. What makes this
safe is policy, enforced by the gate — not a separate server:

- **LOCKED test accounts only** (`accounts/spo-test-accounts.yml`) — never another player's
  assets, never a world-scope value;
- **mutations only on Helartia** (the town `SPO_test3` is Mayor of);
- **evidence over silence**: a mutation is proven by the `FIVEMODELSERVER/Survival` log line,
  never by a `success: true` response; a crash is a failure, but silence is not a pass;
- **capability exceptions are recorded, not overridden**: the presidential members need a
  capability no test account holds; the gate reads that from the server (`IsPresident`,
  `canGovern`) and fails closed if it is ever granted without a flow driving it.

Until the bench migrates here, the authoritative procedure lives in the product repo:
`doc/E2E-POLICY.md`, `doc/bench-worker.md`, `doc/E2E-TESTING.md`.

## Flows between environments

```
                    releases (v* tag → GitHub Release)
  SPO-WebClient ────────────────────────────────► SPO-Deploy ──► dedicated server (production)
        ▲                                                              │
        │  merge (after gate)                                          │ bug reports
        │                                                              ▼
  SPO-Pipeline ◄── pull (secured transport, schema-versioned) ── report store
        │
        └── gate L2: candidate branch → bench → live servers (pre-production)
```

- **Delivery**: product tags `v*` → GitHub Release (existing `release.yml`) → SPO-Deploy's
  `deploy.sh` rolls it onto the dedicated server.
- **Bug reports (production → dev)**: production writes reports against a versioned schema;
  the dev machine **pulls** them (the dev box has the initiative and is not reachable from
  outside; exact transport to be decided — HTTPS endpoint vs file pickup) into the pipeline
  intake queue (today `~/.spo-reports` + `/triage-report`; becomes the orchestrator queue).
  The far target — player reports a bug in-game, the pipeline debugs it, the fix ships in the
  nightly release — is this loop, closed.
  **The intake contract** (maintainer decision, 2026-08-29): a report becomes a task only
  once **confirmed** — a replayable reproduction, or verifiable visual evidence. UI/ergonomics
  and data-display problems qualify as defects; a player preference with nothing objectively
  broken does not (`DO_NOT_FILE`, criterion named). Suggestions enter the board only through
  the maintainer's own filing, never through the bug-report channel — the confirmation gate is
  `prompts/review-card.md` § 0.
- **Verification**: branch → L2 gate (pre-prod) → merge → Release → production. The nightly
  run proves `main` itself.

## What may touch what

| Actor | Dev (mock) | Pre-prod (bench) | Production |
|---|---|---|---|
| Developer / implement step | ✅ | never directly — deposits a bench job | never |
| Bench worker | — | ✅ sole owner (port 8080, LOCKED accounts, Helartia) | reads server logs only |
| SPO-Deploy | — | — | ✅ deploys releases |
| Pipeline intake | — | — | pulls bug reports |
