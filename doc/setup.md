# Setup — lives in SPO-Deploy

**Environment setup is owned by [SPO-Deploy](https://github.com/Crazz-Org/SPO-Deploy) — its
root README is the authority** (maintainer decision, 2026-08-29): the environment matrix, the
scripted procedure (`setup.sh dev|prod` + `setup.conf`), what stays manual by design (tokens,
logins), and the security rules.

Start there:

```bash
cd ~/SPO-Deploy && cp setup.conf.example setup.conf
```

```bash
cd ~/SPO-Deploy && ./setup.sh dev
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

Everything else (prerequisites, repos, bench/pre-prod, parameters table):
**SPO-Deploy README § Setup**.
