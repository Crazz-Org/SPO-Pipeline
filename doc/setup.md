# Setup

The reproducible procedure for standing up a working copy of the pipeline: clone the repos,
register a Claude account, and verify. Every command below is copy-paste; the § Parameters
table at the bottom names every path/port this doc uses so a different machine can substitute
its own.

## § Prerequisites

- WSL2 (Linux) or a plain Linux box.
- Node.js **>= 22** (`node --version`) -- the whole tree is Node built-ins only, zero
  dependencies (see `orchestrator/README.md`).
- `gh` CLI, authenticated (`gh auth status`) -- the real scripted steps (`WORKTREE`, `PUSH_PR`,
  `CI_CHECKS`, `MERGE`, `FINISH`) call it against the product repo.
- `jq` -- required by some of the product repo's own board/bench scripts (see
  `SPO-WebClient/CLAUDE.md` § Environment).

## § Repos

Three repos, three roles (see the root `README.md` § Ecosystem):

```bash
git clone https://github.com/Crazz-Org/SPO-Pipeline.git ~/SPO-Pipeline
git clone https://github.com/Crazz-Org/SPO-WebClient.git "$HOME/SPO-WebClient"   # the product
git clone https://github.com/Crazz-Org/SPO-Deploy.git ~/SPO-Deploy               # production deploy, optional for dev
```

`$HOME/SPO-WebClient` is not a convention you can change per-checkout: `orchestrator/config.js`'s
`productRepo` is always `path.join(os.homedir(), 'SPO-WebClient')`, never a relative path (a
session worktree's `..` does not resolve there -- same reasoning the product's own CLAUDE.md
gives for its own worktrees).

Verify the pipeline checkout on its own, before touching accounts or the product:

```bash
cd ~/SPO-Pipeline
node --test
```

Bare `node --test`, no arguments, from the repo root -- `node --test test/` does not work on
this codebase (see `orchestrator/README.md` § Tests for why).

## § Accounts (DEV)

**One source of truth: the pool directory.** The pipeline uses ONLY the Claude accounts present
under the pool directory (default `~/.claude-accounts`, see § Parameters) -- there is no
`accounts.json` to author by hand, and no implicit fallback to whatever `claude` login happens
to be active on this machine. An empty pool means zero real-mode LLM calls can run:
`orchestrator/daemon.js --real` refuses to even start, and `scripts/smoke-llm.js` refuses to
run without an account name.

1. Create the first account's slot:

   ```bash
   spo account add pool1
   ```

   This creates `~/.claude-accounts/pool1/` and prints the next steps -- it never runs `claude`
   itself.

2. Follow the printed steps: run `CLAUDE_CONFIG_DIR=~/.claude-accounts/pool1 claude setup-token`
   by hand, paste the token it prints into `~/.claude-accounts/pool1/oauth-token`, then:

   ```bash
   chmod 600 ~/.claude-accounts/pool1/oauth-token
   ```

3. Verify:

   ```bash
   spo accounts
   ```

   Expect one row: `pool1  enabled=true  cooldownUntil=-  token=yes  credentials=no`.

Repeat `spo account add <name>` for each additional Claude Max subscription -- `K` parallel
workers scales with `K` healthy accounts (`doc/state-machine-spec.md` § Account pool). Disable
an account without deleting its credentials with `spo account disable <name>`
(`spo account enable <name>` reverses it); both just toggle a `disabled` marker file, nothing
destructive.

**Never the ambient login.** If you're used to a plain `claude` (no `CLAUDE_CONFIG_DIR`) already
being logged in on this machine, that login is invisible to the pipeline -- it is not one of the
`~/.claude-accounts/` subdirectories, so `spo accounts` won't list it and no orchestrator step
will ever use it. Register it properly with `spo account add` (a fresh `CLAUDE_CONFIG_DIR`, its
own `claude setup-token`) instead of pointing the pool at your personal config directory.

## § Pre-production (the L2 bench)

The L2 live gate (`npm run gate` in the product repo, driven by `orchestrator/steps/scripted.js`'s
`realGate`) is a **separate** account surface from the Claude pool above: it drives the live
Delphi game world under the product's own LOCKED test accounts, never a Claude Max login.

- The bench worker itself is installed and owned by the product repo:
  `SPO-WebClient/scripts/bench-install.sh` (see `SPO-WebClient/CLAUDE.md` § Commands /
  `doc/bench-worker.md` there for the full spec -- this doc does not re-derive it).
- The LOCKED test accounts it drives against are this repo's own `accounts/spo-test-accounts.yml`
  -- the machine-readable mirror of the product's `CLAUDE.md` § "E2E credentials — LOCKED"
  (`SPO_test3`/`Crazz`, already public since the product repo is public). "Never change without
  explicit developer approval" applies to this file exactly as it does to the prose it mirrors.
- Verify the worker is up and reachable before depositing a gate job:

  ```bash
  cd "$HOME/SPO-WebClient"
  npm run bench:status
  ```

## § Parameters

| Parameter | Default | Set via |
|---|---|---|
| Account pool directory | `~/.claude-accounts` | `SPO_ACCOUNTS_DIR` env var, or `--accounts-dir <dir>` on `spo accounts`/`spo account ...`/`spo dashboard` |
| Dashboard port | `8090` | `spo dashboard --serve --port <n>` -- **never 8080**, that port belongs to the product repo's bench worker |
| Task queue directory | `<repo>/queue` | `--queue <dir>` on `orchestrator/daemon.js` and `bin/spo` |
| Journal root | `<repo>/journal` | `--journal <dir>` on `orchestrator/daemon.js` and `bin/spo` |
| Product repo checkout | `$HOME/SPO-WebClient` | fixed (`orchestrator/config.js`'s `productRepo`) -- not overridable, see § Repos above |
| Pipeline worktrees directory | `<repo>/worktrees` | fixed (`orchestrator/config.js`'s `pipelineWorktreesDir`), git-ignored |
| Bench/nightly local surface | `~/.spo-bench` | fixed (`orchestrator/config.js`'s `spoBenchDir`) -- owned by the product repo's bench worker |

## § Verify

```bash
cd ~/SPO-Pipeline
node --test                          # the whole suite -- must be fully green
node scripts/smoke-llm.js pool1      # one real `claude` CLI call under the named account,
                                      # ~$0.02 -- NOT part of node --test, run by hand only
spo dashboard --serve                # http://localhost:8090/ -- Ctrl-C to stop
```

`node --test` never touches `~/.claude-accounts/`, the product repo, or the bench -- every test
builds its own `fs.mkdtempSync(os.tmpdir())` directories (see `orchestrator/README.md` § Tests).
`scripts/smoke-llm.js` is the one script that spends real money and calls the real `claude` CLI;
run it once per newly registered account to confirm the token actually works before pointing
real tasks at it.
