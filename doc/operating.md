# Operating the pipeline

Start it, stop it, deploy it, see what it is doing, and get a stuck card moving again.

`doc/deployment.md` is the *design* — why the layout is what it is, and what each measurement
proved. **This file is the runbook.** Where the two overlap, this one is the command and that one
is the reason.

---

## The shape of it

Two systemd `--user` units, both running from a **release symlink**, never from a checkout anyone
edits:

```
~/SPO-Pipeline/          the DEV checkout. Edited, pulled, and the ONLY tree allowed to deploy.
                         The services never read it.
~/.spo-releases/<sha>/   one immutable clone per release, detached at <sha>
~/.spo-current  ->  ~/.spo-releases/<sha>       what both units' ExecStart points at
~/.spo-state/{queue,journal}                    all mutable state, outside every tree
~/.claude-accounts/      the account pool          ~/.spo-worktrees/  product checkouts, per card
```

| unit | what it is |
|---|---|
| `spo-pipeline-daemon.service` | the orchestrator. Claims cards, runs the state machine, spends money. |
| `spo-pipeline-dashboard.service` | read-only console on `http://localhost:8090/` |

---

## Is it running, and what is it doing

```bash
systemctl --user is-active spo-pipeline-daemon.service     # active / inactive / failed / deactivating
bin/spo status                                             # queue, accounts, spend, every card's state
bin/spo task <id>                                          # one card's full journal
tail -f ~/.spo-parks.log                                   # parks, as they happen
```

`deactivating` is a real and now-common state: a stop **drains** (below), so the unit can sit
there for the better part of an hour. It is not stuck.

Which code is actually running — the question that used to be unanswerable:

```bash
readlink ~/.spo-current                                    # the release the units point at
grep -m1 pipelineSha ~/.spo-state/journal/daemon.jsonl     # what the dispatcher recorded at start
scripts/release.sh --list                                  # every release, current and previous marked
```

Every worker also writes a `pipeline-version` line as the **first** entry in its card journal, so
"which version produced this park?" is answerable per card.

---

## Starting and stopping

```bash
systemctl --user start spo-pipeline-daemon.service
systemctl --user stop  spo-pipeline-daemon.service     # DRAINS -- see below
systemctl --user restart spo-pipeline-daemon.service
```

**A stop drains.** It stops claiming immediately (the scanner dies first — it is the only thing
that pulls new cards), then *waits* for the cards already in flight, bounded by
`config.drainTimeoutMs` (45 min, the measured p95 of real card runs). A card still running past
the bound is signalled, given 60 s to finish dying, then SIGKILLed by the daemon itself.

- clean drain → exit **0**, unit goes `inactive`
- bound expired → exit **143**, which the unit declares a success (`SuccessExitStatus`)

**Don't want to wait?** Send the signal a second time:

```bash
systemctl --user kill -s TERM spo-pipeline-daemon.service
```

That is the pre-drain behaviour exactly: immediate exit, in-flight cards cut. `SPO_DRAIN_TIMEOUT_MS=0`
disables the drain permanently for anyone who wants that.

**Stopping for a while?** `systemctl --user disable` as well as `stop`, or the next `git pull`
restarts it (the hook deploys to a unit that is active *or* enabled).

---

## The production switch: claiming or not

`SPO_AUTO_PULL_MS` decides whether the daemon reads the board and claims real cards. At `0` it
still runs the retry channel, report intake, auto-triage and orphan recovery — it just claims
nothing new and spends nothing.

```bash
systemctl --user show spo-pipeline-daemon.service -p Environment | tr ' ' '\n' | grep AUTO_PULL
```

It is set by drop-ins under `~/.config/systemd/user/spo-pipeline-daemon.service.d/`.

> **Trap, and it is silent.** systemd applies drop-ins in **lexicographic order** and the last
> setting of a key wins. A file called `auto-pull-off.conf` sorts *before* `auto-pull-on.conf` and
> loses — it looks applied and is not. The live off-switch is therefore `zz-auto-pull-off.conf`.
> Always verify with the `show` command above, never by reading the file you just wrote.

After editing any drop-in: `systemctl --user daemon-reload`.

---

## Deploying

**A merge on GitHub deploys nothing.** `git pull` in `~/SPO-Pipeline` — that checkout only — is
the deploy:

```bash
cd ~/SPO-Pipeline && git pull
```

The `post-merge` hook cuts `~/.spo-releases/<sha>`, moves `~/.spo-current`, and drain-restarts
both units. A pull or `git merge --ff-only` in **any other worktree** deploys nothing and says so —
before the release layout it restarted the services, which would now have deployed that worktree's
branch.

Deploying by hand, without a pull:

```bash
scripts/release.sh              # from the deploy checkout's HEAD
scripts/release.sh <ref>        # from a specific ref
scripts/release.sh --no-restart # cut and switch, leave the services running the old tree
```

> **Anything that lives in the generated systemd unit needs the installer re-run**, not just a
> pull: `KillMode`, `SuccessExitStatus`, `TimeoutStopSec`, `SPO_PARK_ALERT_CMD`, `ExecStart`.
> ```bash
> scripts/daemon-install.sh && scripts/dashboard-install.sh
> ```
> `daemon-install.sh` ends in `enable --now` — **it starts the daemon.** Set `SPO_AUTO_PULL_MS=0`
> first if the box should come back idle.

### Rolling back

```bash
scripts/release.sh --rollback
```

Moves the symlink to the previous release and drain-restarts. The previous release is never
pruned, however old, so this always has somewhere to go.

---

## Getting a stuck card moving

A parked card comes back with a `retry` comment on its GitHub issue — that is the whole
mechanism, and the unpark scan picks it up within a minute:

```bash
bin/spo parked                                        # what is parked, and why
gh issue comment <n> --repo Crazz-Org/SPO-WebClient --body retry
```

Some park reasons retry themselves (`TRANSIENT_RETRY_REASONS` in `state-machine.js`) — those show
as `BACKOFF`, not `PARKED`, and need nothing from you. Everything else is terminal until a human
comments.

`abandon` instead of `retry` closes a card out.

---

## Traps that have already cost something

Each of these was learned the expensive way. None is discoverable from the code alone.

**`git` in a hook inherits `GIT_DIR`.** Any script or test that shells out to `git` from inside a
hook acts on the *hook's* repository, not the directory it names. On 2026-09-05 this repo's own
test suite, run by the pre-push gate, wrote empty commits onto the branch being pushed, detached
two live worktrees, left `refs/heads/main` a dangling symref and set `core.bare=true`. Strip
`GIT_*` (`test/helpers.js`'s `gitEnv`, and both deploy scripts do it too). Guarded by
`test/no-git-env-sweep.test.js`.

**The unit file is part of the behaviour.** `KillMode=control-group` is systemd's default, and it
SIGTERMs *every* process in the cgroup — so the drain shipped inert while 20 tests stayed green,
because they all signalled the daemon process only. Anything that depends on how the process is
started or signalled must be pinned textually against the generated unit.
See `doc/deployment.md` §3.

**The installer's unit heredoc is unquoted.** It has to be, to expand `$REPO`/`$NODE_BIN`/`$HOME` —
which makes every backtick pair and `$(...)` inside it a command that runs at install time and
pastes its output into the unit. Guarded by `test/daemon-install.test.js`.

**State is outside the tree, and starting without it is refused.** If `~/.spo-state` were missing
while real state sat in the repo, the daemon would come up on an *empty* journal: orphan recovery
finds nothing, the retry channel is silently dead, and the board still shows cards parked. It
refuses instead, printing the `mv` commands (`orchestrator/state-root.js`).

**`gh pr edit` is denied on this repo** (Projects classic). Use
`gh api repos/Crazz-Org/<repo>/pulls/<n> -X PATCH`. And `gh api -f` is a POST unless
`--method GET` is passed — that one killed the retry channel for a whole chantier.

**Never bare `node --test`.** It descends into parked cards' product worktrees and reports
thousands of foreign failures. Always `node --test test/*.test.js`.

---

## Housekeeping

- **Releases** prune to `SPO_RELEASE_KEEP` (5), never removing current or previous.
- **`wip/*` branches on SPO-WebClient** accumulate — `preserveWorktreeWip` pushes one whenever a
  card parks with uncommitted work. There is **no reaper**; they hold preserved work, so clearing
  them is a deliberate act, not routine tidying.
- **`~/.spo-worktrees/issue-<n>/`** belong to cards that are parked or in flight. The WORKTREE step
  creates and destroys them; don't remove one by hand while its card is live.

---

## Tunables

All are systemd `Environment=` settings, read at daemon start.

| variable | default | what it does |
|---|---|---|
| `SPO_AUTO_PULL_MS` | 300000 | claim interval; `0` = claim nothing |
| `SPO_WORKERS` | 1 (live box: 2) | concurrent cards |
| `SPO_DRAIN_TIMEOUT_MS` | 2700000 | how long a stop waits for in-flight cards; `0` disables the drain |
| `SPO_DRAIN_KILL_GRACE_MS` | 60000 | grace for a signalled straggler before SIGKILL |
| `SPO_STATE_DIR` | `~/.spo-state` | queue + journal |
| `SPO_RELEASE_KEEP` | 5 | releases retained |
| `SPO_SOURCE_REPO` | `~/SPO-Pipeline` | the one checkout allowed to deploy |
| `SPO_DEPLOY_BRANCH` | `main` | the branch a deploy may come from |

`TimeoutStopSec` in the unit must stay **≥ `SPO_DRAIN_TIMEOUT_MS` + `SPO_DRAIN_KILL_GRACE_MS`**, or
systemd SIGKILLs the cgroup mid-drain — which skips the daemon's exit hook and leaks its lock file.
A test pins that relationship.
