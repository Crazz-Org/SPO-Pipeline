# Permissions policy — SPO-Pipeline

> **Status as of 2026-08-30.** Consistency audit of permissions ↔ process, tracking its
> correction. `.claude/settings.json` (this repo) and the `deny` in `~/.claude/settings.json` are
> up to date; the measures below describe the state *before* the fix and serve as reference.

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

`orchestrator/steps/llm.js` launches `claude -p` with `CLAUDE_CONFIG_DIR=~/.claude-accounts/poolN`.
These directories have **no** `settings.json`: user rules disappear for every LLM step. What
remains are the *project* rules, resolved from the step's `cwd` (`config.js` → `cwdForStep`):

| Step | `cwd` | Project rules visible |
|---|---|---|
| PLAN, IMPLEMENT | product worktree (`worktrees/issue-N/`) | the 70 WebClient rules (`.claude/settings.json` is versioned, so present in every worktree) ✅ |
| DIAGNOSE, VALIDATE, CITATION_VERIFIER | SPO-Pipeline root | **none** ❌ |

These three steps run in `permissionMode: 'default'` with no human to respond: any Bash command
that isn't trivially read-only is **refused**, not queued.

### The account layer counts too, and it's also plugged now

The table above says *user* rules disappear for every LLM step. Project policy is enough as long
as each step lands in a directory that carries one — which is the case today (pipeline root or
product worktree), which **masks** the gap without closing it. A step whose `cwd` had no
`.claude/settings.json` would run with no rules at all.

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

Direct consequence: DIAGNOSE is the safety net intended for CI forensics
(`doc/improvisation-analysis.md`, cause R2 — `gh run view --log-failed`, `gh api …/jobs`) and it
has none of these permissions. VALIDATE must read `git diff` from the product worktree and can't
either. Creating `SPO-Pipeline/.claude/settings.json` fixes both at once, without touching the
account directories.

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
