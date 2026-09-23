# Permissions policy — SPO-Pipeline

> **Status as of 2026-08-30, extended and corrected 2026-09-22 (card #240).** Consistency audit of
> permissions ↔ process, tracking its correction. `.claude/settings.json` (this repo) and the
> `deny` in `~/.claude/settings.json` are up to date; the measures below describe the state
> *before* the fix and serve as reference.
>
> **Read § *The shell boundary the 92 rules never reached* before trusting §§ 1–3 about the
> automated steps.** Those sections were written about *Claude sessions*, where the curated rules
> do bind and the complaint is that too much is blocked. For seven of the eight in-repo tool
> policies the opposite was true: their bare `Bash` grant meant none of the 92 allow rules applied
> to them at all. Card #240 measured that and fixed it.

## The problem

Three permission layers exist, and the pipeline repo has none of them.

| Layer | Content | Scope |
|---|---|---|
| `~/.claude/settings.json` | 14 `gh` rules, **0 `git` rules** | all machines, all repos |
| `~/.claude/settings.local.json` | `git commit/config/push/remote` — writes only, not reads | same, not versioned |
| `SPO-WebClient/.claude/settings.json` | 70 rules (full git, npm, npx), hardened deny, 3 hooks | product |
| `SPO-Pipeline/.claude/settings.json` | **absent** | — |

Measured across SPO-Pipeline session transcripts (1,665 Bash calls):

```
uncovered : git status 73 · git log 73 · git diff 52 · git add 44 · git show 30
            git checkout 29 · git worktree 29 · gh api graphql 28 · git branch 25
            git pull 24 · gh api repos 23 · git fetch 21 · git grep 15 · git rev-parse 10
covered   : gh pr view 93 · gh pr merge 40 · gh pr create 34 · git push 52 · git commit 45
```

About **430 of ~500** git/gh calls trigger a permission request. Blocking is the rule, not the
exception — the opposite of the intent.

## Why it also hits the automated steps

`orchestrator/steps/llm.js`'s `invokeClaudeReal` drives the vendored Claude Agent SDK's `query()`
(card #239 chantier, action A5b, 2026-09-17 — no longer a direct `claude -p` spawn) with
`options.env.CLAUDE_CONFIG_DIR=~/.claude-accounts/poolN` (`sdk-call.js`'s `buildEnv`). **CORRECTED
-- this used to say these directories have no `settings.json`, and once did, but no longer does**:
that gap is CLOSED, at the USER layer, by the account-sync mechanism the section below this table
documents in full (`bin/spo`'s `cmdAccountSyncSettings`, run on every `account add` and every
`--real` daemon startup) -- read that section for the mechanism; this paragraph only stops
asserting the stale half of it. What remains to state here are the *project* rules, resolved from
the step's `cwd` (`config.js` → `cwdForStep`):

| Step | `cwd` | Project rules visible |
|---|---|---|
| PLAN, IMPLEMENT | product worktree (`~/.spo-worktrees/issue-N/`) | the 70 WebClient rules (`.claude/settings.json` is versioned, so present in every worktree) ✅ |
| DIAGNOSE, VALIDATE, CITATION_VERIFIER | SPO-Pipeline root | the repo's own 98 allow / 14 deny rules (`.claude/settings.json`, versioned at the pipeline root -- this row used to read "none ❌" before that file existed) ✅ |

These three steps run in `permissionMode: 'default'` with no human to respond: any Bash command
that isn't trivially read-only AND not covered by an allow rule (project or, since the fix below,
user) is **refused**, not queued.

> **Corrected 2026-09-22 (card #240).** That last sentence was true only of CITATION_VERIFIER.
> DIAGNOSE and VALIDATE declare bare `Bash` in `allowedTools`, which is itself an allow rule
> covering the whole tool — nothing of theirs was refused for want of a rule, whatever their
> `cwd` or `permissionMode`. Measured on the real corpus: DIAGNOSE ran 706 `Bash` calls and
> VALIDATE 969 in the 2026-08-29 → 2026-09-22 window, including `for` loops, `python3 -c`
> heredocs and `node -e` scripts, with zero permission refusals; CITATION_VERIFIER, the only
> contract with no `Bash` entry, attempted exactly one Bash call in 23 sessions and was told
> *"This Bash command contains multiple operations. The following part requires approval"* — the
> behaviour this paragraph describes, on the one step it actually described. See § *The shell
> boundary the 92 rules never reached*.

### The account layer counts too, and it's also plugged now

The paragraph above the table used to say *user* rules disappear for every LLM step -- true once,
corrected there now. Project policy ALONE would have been enough only as long as every step lands
in a directory that carries one — which is the case today (pipeline root or product worktree),
but that would have **masked** the user-layer gap without closing it: a step whose `cwd` had no
`.claude/settings.json` of its own would still have run with no rules at all.

An account's directory **is** its `CLAUDE_CONFIG_DIR`, so a `settings.json` placed inside it is
its user layer. `spo account sync-settings` installs `<repo>/.claude/settings.json` there as-is,
for every account in the pool: the permission floor no longer depends on the step's `cwd`, nor on
which account the rotation picked. The command is idempotent and runs on its own at two points —
`spo account add`, and every `--real` daemon startup, so an account added or reactivated between
runs doesn't fall behind.

The file written into the pool is machine-owned: it carries a `"//"` key that says so, and it is
rewritten on every sync. **The single source stays `<repo>/.claude/settings.json`**, the one git
tracks — the CLI does not keep a second copy of the rules that could drift. To change policy:
edit the source, then `bin/spo account sync-settings`.

A detail that could have gone unnoticed: `accounts.hasCredentials()` answers "does this account
hold real credentials?" by excluding the files the module manages itself. The synced
`settings.json` is therefore explicitly excluded — without that, syncing the pool would make
`spo accounts` report every account as authenticated, including ones that aren't. Covered by a
regression test.

RESOLVED, past tense (this paragraph used to describe a live consequence; it no longer is one):
DIAGNOSE is the safety net intended for CI forensics (`doc/improvisation-analysis.md`, cause R2 —
`gh run view --log-failed`, `gh api …/jobs`), and before `SPO-Pipeline/.claude/settings.json`
existed, it had none of these permissions; VALIDATE reads `git diff` from the product worktree
and would not have been able to either. Both now have the repo's own 98 allow / 14 deny rules —
`SPO-Pipeline/.claude/settings.json` exists (see the table above) — without touching the account
directories, which is the separate, ALSO now-closed gap the rest of this section documents.

## Deny ↔ process contradictions (arbitrated on 2026-08-30)

- `gh pr edit*` stays **deny** — the command is broken on Projects classic; the substitute is
  `gh api repos/… -X PATCH`, covered by the `gh api repos/Crazz-Org/…/*` rule.
- `gh issue close*` and `gh pr close*` **come out of deny, without an allow**: closing a card is
  part of the process (the orchestrator does it in Node in `report-intake.js`, outside the
  permission layer; a Claude session was blocked hard by it). They now ask for confirmation
  instead of being refused.
- `gh issue delete*` and `gh repo delete*` stay in deny — irreversible.

## Deliberate choices in the rules

- **`gh api graphql*` is allowed.** 28 uses, no CLI alternative to move a card on a Projects v2
  board. Explicit trade-off: a rule on `gh api` can't express "GET only", so this rule
  structurally allows any GraphQL mutation and **bypasses the deny rules set on `gh` subcommands**.
  Maintainer's decision, made knowingly.
- **`git fetch` / `git pull` are scoped**, unlike the product repo which allows them unrestricted.
  `--upload-pack='<cmd>'` and `ext::` URLs turn these commands into arbitrary execution; only the
  bare forms and `origin*` are allowed.
- **`git -C * <subcommand>*`**: the `*` placed before the subcommand can absorb injected options
  (`-c core.pager=…`). Known residual risk, kept for parity with the product repo's policy, which
  already uses these forms.
- `sed` is only allowed as `sed -n *` (read), never `sed -i`.

## Walls that `settings.json` can't tune

Some refusals come from the harness itself and **no allow rule lifts them**:

1. **Editing `.claude/settings.json` and `.claude/hooks/*.sh`.** The tool layer refuses
   ("which is a sensitive file" / auto-mode classifier refusal). A task log shows IMPLEMENT
   returning a partial verdict on this wall, rightly qualified as a *tooling blocker* and not a
   plan defect. **Any card whose plan requires editing these files must be applied by a human**
   — the driver cannot make it succeed. Treat it as a known park cause rather than an execution
   failure.
2. Bare `git stash` in a worktree — the stack is shared across worktrees, see session
   guidelines.

## The shell boundary the 92 rules never reached

**Added 2026-09-22, card #240.** Everything above this section is about Claude *sessions*. The
eight tool policies the orchestrator itself passes to `claude -p` are a separate layer, and for
seven of them the curated rules were inert.

### The finding

Five step contracts live in `orchestrator/step-contracts.js`, three intake policies in
`orchestrator/intake.js`. Seven of the eight declare bare `Bash` in `allowedTools`. The CLI reads a
bare tool name as an allow rule covering the **whole tool** — its own description for it is "Any
Bash command", against "Any Bash command starting with `<x>`" for `Bash(x *)`. So the 92 scoped
`Bash(...)` allows listed below bound exactly one policy, **CITATION_VERIFIER**, the only contract
that omits `Bash`; for the other seven the effective shell boundary was the 14 scoped denies and
nothing else.

Ordered by blast radius, which is a function of `cwd`, not of the grant:

| Policy | `cwd` | What a stray command reaches |
|---|---|---|
| `draftCard`, `reviewCard`, `triageBugReport` (`intake.js`) | `config.productRepo` → `~/SPO-WebClient` | the **live, persistent product checkout the daemon works from**, outside any card's lifecycle: no worktree to discard, no journal entry, no park path to halt the run |
| PLAN, IMPLEMENT | `~/.spo-worktrees/issue-N/` | a disposable per-card checkout that WORKTREE destroys |
| DIAGNOSE, VALIDATE, CITATION_VERIFIER | this repo's root | a versioned tree, recoverable through git |

### What was measured before any rule was written

Source: every pool-account transcript, `~/.claude-accounts/pool{1,2}/projects/**/*.jsonl` (1520
files; 1379 classified by the `# <step>` heading of the prompt that launched the session, the other
141 left unattributed rather than guessed at). Window 2026-08-29 → 2026-09-22, **13001 `Bash`
calls**: PLAN 3581, IMPLEMENT 6384, VALIDATE 969, DIAGNOSE 706, reviewCard 776, triageBugReport
580, draftCard 4, CITATION_VERIFIER 1.

```
compound (&& ; | newline heredoc $( ) ` )   10886 / 13001   83.7%
every top-level segment covered by the 92    5543 / 13001   42.6%
```

- **Rescoping `allowedTools` was measured and rejected.** Dropping bare `Bash` so the 92 curated
  rules bind would refuse ~57% of the pipeline's real shell traffic. Making them fit means adding
  `grep` (~8300 segment hits, the largest single verb and absent from the 92), `head`, `find`,
  `rg`, `awk`, `sort`, `tr`, `python3`, `npx jest`, `bash -c`, plus heredocs and `for` loops — 84
  distinct verbs for IMPLEMENT alone. That allowlist is "any shell" with extra maintenance.
- **Layering `deny` was measured and adopted.** Three real IMPLEMENT calls were refused by the
  existing 14 denies *while bare `Bash` was granted*, one with the denied part in the middle of an
  `&&` chain (`git status --porcelain && git reset --hard 3fa2a115 && git log …`). Deny beats the
  whole-tool allow and is evaluated per parsed subcommand.
- **The read-only contracts were read-only in prose only.** PLAN, in `permissionMode: 'plan'`, ran
  `cp /tmp/te-probe.test.tsx src/client/report/__te_probe.test.tsx` twice and `rm -rf "$TMPD/…"`
  seven times. Plan mode blocks `Edit`/`Write`; it does not block a write made through the shell.
  The three intake policies, across 1360 calls, mutated nothing at all — their whole surface is
  `gh issue list/view` (694), `curl -s … -o /tmp/…` (53), `gh api <path> --jq` (37), `gh pr view`
  (8), `git branch -a --contains` (2), `gh project item-list` (1).

### What landed

Per-policy deny lists in **`orchestrator/bash-policy.js`**, passed on the command line as
`--disallowedTools` (`orchestrator/steps/sdk-call.js`'s `buildQueryOptions`, which sets
`options.disallowedTools` on every real `query()` call; the vendored Claude Agent SDK itself
comma-joins that array into the flag when it spawns `claude` — `steps/llm.js`'s `buildArgv`, the
old transport's argv builder, was deleted by card #239's cutover). Nothing in
`.claude/settings.json` changed, and nothing could have: an agent cannot edit it (§ *Walls that
`settings.json` can't tune*). The 14
shared denies stay the single source and are **not** duplicated — `test/bash-deny-policy.test.js`
fails on any duplicate, so the two layers cannot fork.

| Policies | List | Measured cost on the window above |
|---|---|---|
| PLAN, DIAGNOSE, VALIDATE | `READ_ONLY_STEP_BASH_DENY` = host/daemon control + working-tree and git writes | 16 of PLAN's 3581 calls (7 `rm -rf` of its own temp dir, 2 `cp` into `src/`, 6 `git apply --check`, 1 `ssh -T`); **zero** for DIAGNOSE and VALIDATE |
| IMPLEMENT | `WRITE_STEP_BASH_DENY` = host/daemon control only — it is the one policy whose contract is to write | zero |
| `draftCard`, `reviewCard`, `triageBugReport` | `INTAKE_BASH_DENY` = the above plus the `gh` mutation surface, `gh api graphql`, and package installs | zero of 1360 calls |
| CITATION_VERIFIER | none — **unchanged**, still no `Bash` at all, still falling through to the 92 rules | — |

This is also what finally makes the `Bash(ro)` in every doc's "Read, Grep, Glob, Bash(ro)"
(`doc/state-machine-spec.md`'s step table, `prompts/README.md`'s, each prompt's own "never edit a
file") mean something at the tool layer instead of only in the prompt's prose.

**It is not a sandbox.** `bash -c`, `python3 -c`, `node -e`, `xargs` and `env` carry their payload
inside a string argument the matcher never parses, and shell redirection (`cat > f <<'EOF'`) is not
a command at all. Those channels stay open on purpose — denying them would break real work — and
they are named, with their measured counts, in `doc/accepted-gaps.md` § 18, together with the four
other residual gaps this fix leaves open.

## The content applied in `SPO-Pipeline/.claude/settings.json`

```json
{
  "permissions": {
    "allow": [
      "Read", "Grep", "Glob", "Edit", "Write",

      "Bash(git status*)", "Bash(git log*)", "Bash(git diff*)", "Bash(git show*)",
      "Bash(git branch*)", "Bash(git blame*)", "Bash(git grep*)", "Bash(git ls-files*)",
      "Bash(git ls-tree*)", "Bash(git rev-parse*)", "Bash(git rev-list*)",
      "Bash(git describe*)", "Bash(git merge-base*)", "Bash(git reflog*)",
      "Bash(git remote*)", "Bash(git config*)", "Bash(git check-ignore*)",
      "Bash(git worktree*)",

      "Bash(git add*)", "Bash(git commit*)", "Bash(git push*)", "Bash(git checkout*)",
      "Bash(git switch*)", "Bash(git restore*)", "Bash(git merge*)", "Bash(git rebase*)",
      "Bash(git cherry-pick*)", "Bash(git stash*)", "Bash(git tag*)", "Bash(git mv*)",
      "Bash(git apply*)", "Bash(git init*)",

      "Bash(git fetch)", "Bash(git fetch origin*)", "Bash(git fetch --all*)",
      "Bash(git pull)", "Bash(git pull origin*)", "Bash(git pull --ff-only*)",

      "Bash(git -C * status*)", "Bash(git -C * log*)", "Bash(git -C * diff*)",
      "Bash(git -C * show*)", "Bash(git -C * rev-parse*)", "Bash(git -C * branch*)",
      "Bash(git -C * worktree*)",

      "Bash(gh auth status*)", "Bash(gh api rate_limit*)", "Bash(gh api graphql*)",
      "Bash(gh api repos/Crazz-Org/SPO-WebClient/*)",
      "Bash(gh api repos/Crazz-Org/SPO-Pipeline/*)",
      "Bash(gh pr create*)", "Bash(gh pr view*)", "Bash(gh pr list*)", "Bash(gh pr diff*)",
      "Bash(gh pr checks*)", "Bash(gh pr merge*)",
      "Bash(gh issue create*)", "Bash(gh issue view*)", "Bash(gh issue list*)",
      "Bash(gh issue comment*)", "Bash(gh issue edit*)",
      "Bash(gh label list*)", "Bash(gh run list*)", "Bash(gh run view*)",
      "Bash(gh project list*)", "Bash(gh project field-list*)", "Bash(gh project item-list*)",
      "Bash(gh project item-add*)", "Bash(gh project item-edit*)",

      "Bash(node *)", "Bash(npm test*)", "Bash(npm run *)", "Bash(npm ci*)", "Bash(npm ls*)",
      "Bash(bin/spo *)", "Bash(./bin/spo *)",

      "Bash(ls *)", "Bash(pwd*)", "Bash(cd *)", "Bash(cat *)", "Bash(head *)",
      "Bash(tail *)", "Bash(wc *)", "Bash(sort *)", "Bash(uniq *)", "Bash(cut *)",
      "Bash(jq *)", "Bash(sed -n *)", "Bash(tree *)", "Bash(which *)", "Bash(echo *)",
      "Bash(mkdir -p *)",

      "mcp__ccd_session_mgmt__set_session_title"
    ],
    "deny": [
      "Bash(git clean*)", "Bash(git rm -rf*)", "Bash(git filter-branch*)",
      "Bash(git filter-repo*)", "Bash(git gc --prune*)", "Bash(git prune*)",
      "Bash(git reflog expire*)", "Bash(git push --force*)", "Bash(git push -f*)",
      "Bash(git reset --hard*)", "Bash(git branch -D*)",
      "Bash(gh pr edit*)", "Bash(gh issue delete*)", "Bash(gh repo delete*)"
    ]
  }
}
```

## Touch-ups elsewhere

**Done** — `~/.claude/settings.json`: `Bash(gh issue close*)` and `Bash(gh pr close*)` removed
from `deny`. This wasn't cosmetic: the user deny overrides the project allow, so as long as they
stayed there the hard block persisted regardless of what the repo set. The user `deny` now only
keeps `gh pr edit`, `gh issue delete`, `gh repo delete`.

**Done** — `SPO-WebClient/.claude/settings.local.json`: dead references removed. The `github`
and `context7` MCP servers were declared in `enabledMcpjsonServers` while `.mcp.json` only
contains `playwright`, and the `mcp__github__get_issue` rule allowed a tool that doesn't exist
(no reference to `mcp__github__*` or `mcp__context7__*` anywhere in the repo). Also removed:
`Bash(gh api graphql -f 'query= *)`, strictly covered by the neighboring `Bash(gh api *)` rule and
dependent on a quote in the command anyway, and `Bash(scripts/board-status.sh 268)`, pinned to a
one-off card number.

**Still to do**

- **`~/.claude/settings.local.json`**: its 4 rules (`git commit/config/push/remote`) are isolated
  writes, without the matching reads. Redundant for this repo now that project policy is in
  place; fold them into `~/.claude/settings.json` or remove them.
- **`~/.claude/settings.json`** still has no `git` rule at all. No effect here (the project
  covers it), but any other repo without its own policy starts from zero.
- **`Bash(gh api *)`** in `SPO-WebClient/.claude/settings.local.json`: an unscoped rule, it
  allows any mutation on any repo. Left as-is — tightening it would change the product repo's
  security posture, a decision separate from this audit.

## GitHub: the native tool is `gh`, not an MCP

- `gh` is authenticated (account `Crazz-E`, scopes `repo, project, workflow, read:org, gist`) and
  is already the foundation: the whole orchestrator calls it via `execFile` from Node
  (`steps/scripted.js`, `intake.js`, `park-loop.js`, `report-intake.js`). Those calls go
  **outside Claude's permission layer** — the automated pipeline is never blocked, only Claude
  sessions are.
- No GitHub MCP server is configured (`mcpServers` global is empty, no `.mcp.json` here). The
  `plugin:engineering:github` connector requires an OAuth flow that's impossible in a
  non-interactive session.
- **Don't add a GitHub MCP**: it would duplicate `gh` without adding anything and would
  introduce a second authentication surface. The real gap is documentation, not tooling — see
  this repo's `CLAUDE.md` for the `gh` conventions that used to be rediscovered every session.
