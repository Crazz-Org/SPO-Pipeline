# CLAUDE.md — SPO-Pipeline

Autonomous orchestrator for the SPO-WebClient backlog: a GitHub card enters `Todo`, comes out
`Done` with a merged PR, or gets *parked* with a reason. `orchestrator/` is the state machine,
`prompts/` the LLM steps, `doc/state-machine-spec.md` the spec.

> This file is loaded on every LLM call whose `cwd` is the repo root — DIAGNOSE, VALIDATE,
> CITATION_VERIFIER (`config.js` → `cwdForStep`). Keeping it short is a cost constraint, not a
> style preference: adding context here means paying for it on every step.

## `gh` conventions — traps already paid for

Don't rediscover them. `gh` is the project's native GitHub tool (account `Crazz-E`, scopes
`repo, project, workflow`); no GitHub MCP is configured and none should be added.

- **`gh pr edit` does not work** on this repo (Projects classic board) — the command is
  `deny`. Editing a PR goes through `gh api repos/Crazz-Org/<repo>/pulls/<n> -X PATCH`.
- **Moving a card on the board** has no CLI equivalent: it's `gh api graphql` with a
  `updateProjectV2ItemFieldValue` mutation. Field ids are read with
  `gh project field-list 1 --owner Crazz-Org --format json`; full record in
  `doc/board-audit.md`.
- **Adding an option to a single-select field**: also a GraphQL mutation — no
  `gh project field-create` exists for that (`orchestrator/README.md`).
- **`gh api` with `-f` is a POST**, not a GET, unless `--method GET` is also passed. Query
  parameters belong in the path (`...?per_page=100&page=2`). Cost of learning this: `-f` on
  `issues/<n>/comments` POSTs to *create a comment*, so the unpark scan 422'd on every cycle and
  the maintainer's `retry` channel was dead for as long as it shipped. `test/gh-api-argv.test.js`
  now fails any call site that repeats it (`gh api graphql` exempted — POST by definition).
- **Verdict by exit code**, never by reading `gh`'s text output.
- The orchestrator's `gh` calls go through Node's `execFile` — they never go through Claude's
  permission layer. A permission block therefore never concerns the daemon, only a Claude
  session.

## Permissions

Policy, measures, and trade-offs: `doc/permissions.md`. Two things to know before planning a
card:

- **`.claude/settings.json` and `.claude/hooks/*.sh` cannot be edited** by an agent: the
  harness refuses them as sensitive files, regardless of the repo's own rules. A card whose
  plan requires editing them cannot succeed — park it with that reason instead of failing it
  in IMPLEMENT.
- DIAGNOSE / VALIDATE / CITATION_VERIFIER run from the repo root in
  `permissionMode: 'default'` **with no human**: whatever `.claude/settings.json` doesn't
  allow is refused, not queued.
- `.claude/settings.json` is the **single source** of policy: it is also installed as the
  user layer of every account in the pool (`spo account sync-settings`, automatic on
  `account add` and on every `--real` startup). Resync after editing it.

## Working a chantier (driver sessions only)

The method is not optional and not re-invented per session — it is the plan's execution rules
(`doc/remediation-plan-2026-08.md` § *Execution rules*) plus what execution corrected in them
(`doc/remediation-progress.md` § *The driver workflow that worked*). Read both before dispatching.

- **One action = one Sonnet subagent** (effort `medium`), spec self-contained with its tests.
  **Verified by an Opus subagent** (effort `high`): adversarial diff review **+ mutation testing** —
  the highest-value part of the loop; it repeatedly caught tests passing for the wrong reason.
- **Subagents never commit.** The driver commits after verification: keeps "one commit per action"
  exact and stops parallel agents clobbering each other. One PR per chantier.
- **One chantier at a time**, next starts only on a green gate: `node --test test/*.test.js`
  (never bare) + `daemon.js --dry-run` + the chantier's listed checks. *(live recette)* gates stop
  and ask the maintainer.
- Items marked **DECISION** are never delegated; the driver frames, the maintainer decides.
- **Sibling grep** (rule 6): any action correcting a factual claim greps the old *and* new phrasing
  across `doc/`, `prompts/`, `orchestrator/`, `bin/spo`, `console/`, `scripts/`, `accounts/`,
  `README.md`, and reports what it found; the Opus verifier checks it did.
- Audits use the other pairing: read-only **Fable 5.1** sweep, then **every** finding re-verified by
  Opus running a real probe — Fable's line refs hold, its derived conclusions have been inverted.

## Git

The repo uses worktrees for two distinct purposes:

- `worktrees/issue-<n>/` — checkouts **of SPO-WebClient**, created and destroyed by the
  WORKTREE step. Don't touch them by hand while a task is running.
- `.claude/worktrees/<slug>/` — working worktrees on *this* repo.

The `git stash` stack is shared across all worktrees, and several sessions can run in
parallel: never use bare `git stash` / `git stash pop`. Prefer a WIP commit.
