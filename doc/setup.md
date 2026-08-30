# Setup — lives in SPO-Deploy

**Environment setup is owned by [SPO-Deploy](https://github.com/Crazz-Org/SPO-Deploy) — its
root README is the authority** (maintainer decision, 2026-08-29): the environment matrix, the
scripted procedure (`deploy.sh setup dev|prod` + `setup.conf`), what stays manual by design
(tokens, logins), and the security rules.

Start there:

```bash
cd ~/SPO-Deploy && cp setup.conf.example setup.conf
```

```bash
cd ~/SPO-Deploy && ./deploy.sh setup dev
```

## § Accounts — the one section that stays here

The Claude Max account pool is this repo's own runtime surface (referenced by `bin/spo` and
the daemon's `--real` startup check):

- The pool directory is the **single source of truth**: `~/.claude-accounts` (override:
  `SPO_ACCOUNTS_DIR`), one subdirectory per account, **outside every git repository** — a
  token cannot be committed.
- Register an account (guided — it prints the complete next steps):

```bash
cd ~/SPO-Pipeline && bin/spo account add pool1
```

- List and health: `cd ~/SPO-Pipeline && bin/spo accounts` · disable/enable:
  `cd ~/SPO-Pipeline && bin/spo account disable pool1` (marker file, reversible).
- Verify an account end to end (one real call, ~$0.02):

```bash
cd ~/SPO-Pipeline && node scripts/smoke-llm.js pool1
```

- An **empty pool** refuses `--real` at daemon startup and parks mid-run
  (`no-accounts-registered`): the pipeline uses only registered accounts, never the machine's
  ambient `claude` login.
- **Labeling accounts with an email/plan for the dashboard**: nothing Claude Code writes into an
  account's directory carries an email address or subscription tier (only a hashed user id) —
  the dashboard's "Claude accounts" table can only show them if you add
  `~/.claude-accounts/labels.json` by hand, e.g. `{"pool1": {"email": "you@example.com", "plan":
  "Max 20x"}}`. See `orchestrator/accounts.js`'s `readLabels`.
- Each account directory **is** a `CLAUDE_CONFIG_DIR`, so it is also its own user-settings tier
  — the machine's `~/.claude/settings.json` is never read by a pipeline step. `<repo>/.claude/settings.json`
  is installed into every account as that tier, so the permission floor does not depend on which
  account the rotation picks. `spo account add` does it for the new account and every `--real`
  daemon start re-applies it, so this is normally automatic; run it by hand after editing the
  policy, or to check what would change:

```bash
cd ~/SPO-Pipeline && bin/spo account sync-settings --dry
```

  The file it writes is machine-owned and carries a `"//"` marker saying so — edit
  `<repo>/.claude/settings.json` and re-sync, never the copy in the pool. Details and the
  reasoning: `doc/permissions.md`.

Everything else (prerequisites, repos, bench/pre-prod, parameters table):
**SPO-Deploy README § Setup**.
