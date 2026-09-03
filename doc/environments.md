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

## What the test accounts can and cannot do

*Recorded 2026-09-03 from the maintainer. None of this is derivable from either repo, and
misreading it is easy: the bench's own comments describe self-imposed rails in language that
sounds like domain constraints.*

**SPO is an MMO. `planitia` is a world/server, built for many players at once** — it carries
real human players alongside the LOCKED test accounts, and is the world designated for testing
(a crash there is not an incident). Concurrency is its normal operating mode.

**`Helartia` is a perimeter, not a mutex.** It is the town tests are confined *to*, so live
players elsewhere are never touched and tests still run against real player data. It serialises
nothing.

**The one real technical limit is one active session per account.** Two accounts means two
concurrent sessions are already possible; the webclient supports multiple players at once
because it is an MMO client. **So the bench's single-flight world lock is a bench policy, not a
property of the world** (`src/e2e/world-lock.ts`: *"one live session at a time, across both
accounts"*). It buys restore safety and rate limiting, and it could be replaced with per-account
session limits plus per-object restore guarding — see the note under "adding accounts" below.

### The capability axes

What a test account may do is governed by four independent things, and a flow that fails may be
failing on any of them rather than on the code:

| axis | what it gates | scope |
|---|---|---|
| **Tycoon level** | which buildings may be built, and which research may be done — a low-level account simply cannot reach some of both | per account, per world |
| **Civic role** | *where* you may build: a **Mayor** builds roads in their own town only; a **Minister** builds anywhere, but only in the zones within their ministry; a **President** builds anything anywhere | per world |
| **Prestige** | earned by playing | **world-locked** |
| **Nobility** | earned by *rebirth* — resetting the account on the same world in exchange for points; a recognition of player experience | **attached to the account, cross-world** |

`SPO_test3` is Mayor of Helartia and Minister of Agriculture; `Crazz` is a basic account. That
pairing is a **role topology**, not a pool of interchangeable logins — `politics-write` needs
*that* Mayor.

### Adding accounts

More accounts would let the bench run lanes in parallel: the game already permits it. What
would have to change is entirely on the bench side — the single-flight lock (replaced by
per-account sessions plus per-object restore guarding, since two lanes must not mutate the same
coordinates), N gateways on N ports (`E2E_GATEWAY_URL` is already env-parameterised), N ref
checkouts, and N worker slots.

Two cautions. **Role-exclusive flows do not scale with accounts** — there is one Mayor of
Helartia, so governance flows stay singleton unless more test towns gain their own role sets.
And **the rate limiter would stop being decorative**: it exists to keep a retry loop from
becoming a login storm against servers real players are using, and is currently inert
(`LIMITS.minIntervalMinutes: 0`, `maxRunsPerDay: 1000`). Serialisation is also doing unearned
safety work today — it is why no two gates have ever raced each other's restores, so
`world-lock.ts`'s crash path (it erases a dead holder's `pendingRestores`) becomes load-bearing
the moment lanes exist.

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
