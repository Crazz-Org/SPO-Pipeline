# Deploying the pipeline

How new orchestrator code reaches the running daemon, what that costs the cards in flight, and
what is still open. Written 2026-09-05, after a `git pull` at 04:23:43 (CEST) parked two healthy cards. **All journal
timestamps below are UTC**, which is what `journal/` records — that same pull is `02:23:43Z` there.
Wall-clock times quoted from `journalctl` or from the reflog are local; each is marked.

Everything below that states a number or a mechanism was measured against `journal/` or against a
probe on this box. Where a claim is inferred rather than measured, it says so.

---

## 1. What a deploy is

A merge on GitHub deploys nothing. `git pull` in `~/SPO-Pipeline` is the deploy: it fires
`.git/hooks/post-merge` (a symlink to `scripts/git-hooks/post-merge`), which restarts
`spo-pipeline-daemon.service` and `spo-pipeline-dashboard.service`. Neither the merge nor a
worktree's own pull does anything.

Three facts about that, all verified in the code:

**The pull alone already mixes two versions, with no restart involved.** The dispatcher and the
scanner are long-lived processes carrying the code they loaded at start. A worker is not: it is a
fresh process per card, spawned as `node <DAEMON_PATH> --worker …`
(`dispatcher.js` `buildWorkerArgv`), and `DAEMON_PATH` is `path.join(__dirname, 'daemon.js')` — a
live path, re-read at every spawn. So the instant `git pull` finishes writing files, the next
worker this dispatcher spawns is running the *new* code under an *old* dispatcher and an *old*
scanner. The post-merge restart closes that window; it does not prevent it. **This is the design
defect. The restart is the dressing, not the cause.**

**Until 2026-09-05 the restart killed whatever was in flight.** Every signal was
`process.exit(143)` on the spot, and daemon.js's exit hook then SIGTERMed every worker's process
group. Fixed — see §3.

**The pipeline recorded no version of itself.** It is meticulous about the *product*'s
provenance: WORKTREE runs `git fetch origin`, cuts from `origin/main`, journals `base-main`, and
refuses a card whose base has a red nightly. It had no equivalent for the orchestrator:
`dispatcher-start` carried `pid` and `workers` only, and every `rev-parse HEAD` in the codebase
points at the *product* worktree. "Which version of the pipeline produced this park?" was
unanswerable after the fact. Fixed — see §4.

---

## 2. The two anomalies

### 2.1 The unit went `failed` on every deliberate stop — FIXED

`daemon.js` installs SIGINT/SIGTERM handlers, and it must: until a JS handler for a signal exists,
Node applies the OS default disposition and dies mid-statement, leaking the single-instance lock
file. Those handlers exit 130/143. The unit declared no `SuccessExitStatus`, so systemd read every
one of those as a failure. Measured on this box on 2026-09-05:

```
ExecMainStatus=143   Result=exit-code   ActiveState=failed   UnitFileState=disabled
```

The consequence is not cosmetic. `post-merge` gates on `is-active OR is-enabled`, and a `failed`,
disabled unit answers no to both — so the hook skipped the daemon **in silence**. The pull printed
a dashboard restart, said nothing about the daemon, and looked exactly like a deploy that had
covered both. `spo-pipeline-dashboard.service` never had the problem, and the reason is instructive:
it installs no signal handler at all, so SIGTERM kills it on the default disposition and systemd
counts a death by the signal it sent as a success.

Fixed in `scripts/daemon-install.sh` (`SuccessExitStatus=143 130`, plus `TimeoutStopSec`, §3) and
in the hook, which now prints the skip. **The installer must be re-run for any of this to reach the
box** — see §6.

### 2.2 `task-orphaned-daemon-restart` vs what a restart actually produces — MEASURED

The `auto-pull-on.conf` drop-in states that a restart parks the in-flight card as
`task-orphaned-daemon-restart`, deliberately kept off `TRANSIENT_RETRY_REASONS`. The 04:23 restart
produced `llm-transport-failed:PLAN` and `npm-run-timed-out` instead. The question was whether
orphan-scan had replaced that path or the two coexist by timing.

**Neither. Both paths are real, both are deploy-reachable, and the drop-in describes the rarer one.**

The two have to be counted with windows pointing in opposite directions, and getting that wrong is
how the first cut of this section reached a wrong answer. A card that parks *itself* does so in the
seconds **before** the restart completes; an orphan park is written by `orphanScan` **after** the
next start. Across every card journal (58 `parked` events, 17 `dispatcher-start` events):

| path | count | detail |
|---|---|---|
| self-park, in the 30s **before** a `dispatcher-start` | 4 | 3 × `llm-transport-failed:PLAN` (#486, #515, #654), 1 × `npm-run-timed-out` (#517) |
| `task-orphaned-daemon-restart`, **after** a `dispatcher-start` | 1 | `issue-488`: worker spawned 20:13:54Z, **`dispatcher-start` 20:36:38Z**, orphan park 20:40:46Z |

`journal/issue-385` also carries a `task-orphaned-daemon-restart` park, but it is not machine-written:
its detail is a hand-typed `note` reconstructing a lock-churn incident, and it appears nowhere in
`daemon.jsonl`. `daemon.jsonl` holds exactly **one** orphan park, and it is deploy-adjacent — so the
honest reading is *1 of 1*, not *0 of 2*.

Self-parks outnumber orphan parks 4 to 1 at deploy boundaries, and `issue-488` is the clean instance
of the condition the mechanism below predicts: at 20:36:38 its worker sat between a GATE
`board-move` and the next GATE `spawn` — an `await`-shaped poll gap (the successful re-run shows the
same 4-minute gap), so the SIGTERM handler ran, the worker died without parking, and orphanScan
picked it up.

The mechanism, measured with a probe rather than reasoned:

> A worker blocked in `spawnSync` does not die on SIGTERM. libuv's handler only marks the signal;
> the JS handler runs on the next event-loop turn, and `spawnSync` blocks that loop for as long as
> the child runs. The signal *does* kill the child (`claude`, `npm`) because the group kill reaches
> it. `spawnSync` then returns, the step's error path runs — and the park path is itself a chain of
> synchronous `spawnSync` calls, so the worker completes an **entire ordinary park**, with a
> step-level reason, before its own SIGTERM handler ever fires.

The probe: a node process with `process.once('SIGTERM', () => process.exit(143))`, blocked in
`spawnSync('sleep', ['100'], {timeout: 660000})`, signalled at its own process group. It ran two
further `spawnSync` calls (2.0s of them) and only *then* ran the handler. Production matches
exactly: #515's SIGTERM landed at 02:23:43.4 and the worker went on to `git status`, the park
alert, a **board move to Parked at 02:23:45.4** and a **GitHub park comment at 02:23:46.5** — three
seconds of live side effects on a healthy card, on behalf of a process that was being replaced.

So which path fires is decided by *whether the worker is inside a blocking `spawnSync` when the
signal lands* — not by "SIGTERM timing" in the loose sense, and not by one having superseded the
other. `task-orphaned-daemon-restart` needs the worker itself to die without parking, which requires
it to be at an `await`; `issue-488` is that case, and the other four are not.

**The retry semantics do differ, and in three directions rather than two:**

| reason | on `TRANSIENT_RETRY_REASONS`? | what a maintainer must do |
|---|---|---|
| `llm-transport-failed:<STEP>` | yes | nothing — auto-retried within `transientRetryBudget` |
| `npm-run-timed-out` | no | post a `retry` comment |
| `task-orphaned-daemon-restart` | no (deliberate) | post a `retry` comment |

The drop-in's claim is therefore wrong in the common case and understates the good one. **The
drop-in is a live systemd file, not a repo file, so this document does not edit it** — see §6 for
the correction to apply.

The drain (§3) makes all three rare by construction: a card is only signalled at all if it is still
running when the bound expires.

### 2.3 Found in passing: `isSpawnTimeout` calls any external signal a timeout — NOT changed

`command-timeout.js`:

```js
return !!(deadlineArmed && result && ((result.error && result.error.code === 'ETIMEDOUT') || result.signal));
```

Its own comment says it is "true only when spawnSync's OWN `timeout` option (never an operator's
kill -9, an OOM kill, or any other external signal) is what ended the child". The `|| result.signal`
clause does the opposite. Measured:

| case | `error.code` | `signal` |
|---|---|---|
| genuine `timeout` expiry | `ETIMEDOUT` | `SIGTERM` |
| external SIGTERM, deadline armed but nowhere near expiry | *(none)* | `SIGTERM` |
| ordinary non-zero exit | *(none)* | `null` |

So the clause fires **only** for external signals — it is precisely the false-positive generator,
and it is why #517 read `npm-run-timed-out` after 345s of a 660s budget. Tightening it to the
`ETIMEDOUT` test alone is a two-token change and strictly more accurate.

**Deliberately not done here.** `spawnStep` retries on `timedOut` and then throws
`ParkSignal('<class>-timed-out')`, so the change re-classifies parks for *every* command class at
once, and a park reason is a retry contract (`TRANSIENT_RETRY_REASONS` keys on the string). It
belongs in its own card with its own corpus pass, not folded into a deploy change. Filed.

---

## 3. What landed: the drain

The first SIGTERM/SIGINT now asks the dispatcher to drain instead of killing.

- The **scanner dies immediately**, inside `requestDrain` rather than in the drain block. It is the
  only producer of new queue entries (auto-pull) and the only thing that re-enqueues parked ones,
  and between the signal landing and the loop noticing there is a whole poll interval in which it
  could otherwise claim a fresh card for a process on its way out.
- The loop stops calling `fillSlots`: nothing new is claimed.
- The cards already in flight are **waited for**, bounded, woken by any exit rather than by the
  poll — so a restart on an idle daemon costs nothing: **15 ms from SIGTERM to process exit**,
  measured end to end on a real daemon. (It was 4497 ms before verification caught it: `sleep()` is
  a non-`unref`'d `setTimeout`, so the *loser* of the poll race held the event loop open for its
  full 5 s after `run()` had already returned. `waitedMs: 0` was true of the wait and false of the
  process — and it is the process that `systemctl stop` waits for.)
- Stragglers past the bound are signalled exactly as before, then given `drainKillGraceMs` (60 s) to
  finish *dying* — writing their park, preserving their worktree WIP, posting their anchor comment —
  and **SIGKILLed by the daemon itself** if they do not. `await Promise.allSettled(pending)` alone is
  unbounded, and production's stragglers are precisely the processes that do not die on time; the
  only backstop was systemd's cgroup SIGKILL, which skips daemon.js's exit hook and leaks the
  single-instance lock file. **A drain can never be worse than the kill it replaces, only slower.**
- `dispatcher-drain-end` is written **after** the reap, not at the bound, and carries `outcomes`
  alongside `survivors`. The first cut recorded the *decision* ("we stopped waiting") in the
  vocabulary of an *outcome* ("a card was lost"): measured with a straggler that ignores SIGTERM, it
  logged `drained:false, survivors:[…]` at +1001 ms and the card then exited 0 at +8035 ms, with
  nothing correcting the record. Per §2.2 that is the common case, not the exotic one.
- A clean drain **exits 0**.

**The bound is 45 minutes, and it is measured, not chosen.** 56 `worker-spawn` → `worker-exit`
pairs in `journal/daemon.jsonl`:

| p50 | p75 | p90 | p95 | max |
|---|---|---|---|---|
| 22.9 min | 33.7 min | 43.1 min | 45.7 min | 56.2 min |

(Percentiles are `sorted[floor(p·n)]`. `ceil(p·n)−1` gives 22.4 / 33.0 instead — stated because the
two conventions differ by half a minute here and the number is load-bearing.)

**The population is conditioned on survival, and that biases the p95 low.** `daemon.jsonl` holds 64
`worker-spawn` events and 56 `worker-exit` events. The 8 spawns with no exit are exactly the cards a
restart killed — the population this bound exists for — and they are excluded because they have no
exit to measure. A longer-tailed truth would argue for a *longer* bound, never a shorter one, so the
direction of the bias is safe; it is recorded rather than corrected because there is no honest way
to impute a duration for a card that was cut.

A card is not "a few minutes" of work; a bound picked from that intuition would have killed the
median card. 45 min is the p95: 19 deploys in 20 cost nothing, and the twentieth costs exactly what
every deploy used to.

**Three things have to track that number, and they are not all in one file:**

| where | what | why |
|---|---|---|
| `config.js` `drainTimeoutMs` | 45 min (`SPO_DRAIN_TIMEOUT_MS`) | the bound itself; `0` disables the drain and restores the pre-drain behaviour exactly |
| `config.js` `drainKillGraceMs` | 60 s (`SPO_DRAIN_KILL_GRACE_MS`) | how long a *signalled* straggler gets to finish dying before the daemon SIGKILLs it itself. ~20× the one measured park-after-signal (3.1 s). |
| unit `TimeoutStopSec` | 2820 s = 2700 + 60 + 60 | systemd SIGKILLs the cgroup when this expires. Below the sum it does not *shorten* the drain, it **deletes the orderly end** of it. Pinned by a test against `config.js`'s source text — including the grace, because pinning `>= drainSec` alone passed with zero grace, i.e. with that half deleted. |
| `post-merge` `restart --no-block` | — | without it a `git pull` blocks the terminal for up to 45 min |

**Escape hatch:** a second signal exits immediately.
`systemctl --user kill -s TERM spo-pipeline-daemon.service` after a `stop` that is taking too long.
There is no counter behind this — `requestDrain` simply refuses once a drain is under way, and the
handler falls through to the pre-drain exit. (A `signalCount > 1` arm existed in the first cut and
was deleted: mutation testing showed removing it left the suite green, because `requestDrain`'s own
refusal always got there first, for every ordering. Two mechanisms for one decision, one of them
untestable.)

**A pull DURING a drain is not a missed deploy.** With `--no-block` and a 47-minute ceiling, the unit
can sit in `deactivating` for a long time, and `systemctl is-active` exits non-zero for that state —
which the hook used to read as "neither active nor enabled" and skip. It is not a skip: a `restart`
is already queued behind the stop, and its *start* execs from `WorkingDirectory`, so it picks up the
newer merge as well. The hook now reads the state from stdout and says so.

---

## 4. What landed: provenance

`dispatcher-start` now carries `pipelineSha` / `pipelineRef`, and every worker writes a
`pipeline-version` line as the **first** thing in its card journal, before anything it could park
on. The worker reads its own sha from its own `__dirname` rather than inheriting the dispatcher's —
which is the point: after a pull with no restart the two genuinely differ, and the two lines
disagreeing is that gap made visible instead of inferred.

`pipeline-version.js` reads `.git` by hand and never spawns `git` (`test/no-real-spawn.js` makes an
in-process `spawnSync` of git a suite-wide error; a worker's event loop is already blocked for
minutes at a time; and git need not be on PATH for the daemon to be correct about anything else).

**What it cannot see: an uncommitted edit.** A sha identifies a commit, not a working tree, so a
hand-edited `~/SPO-Pipeline` reports the sha it was last on while running something else. Detecting
that honestly costs a `git status` subprocess per card, for a condition that exists *only because
the service runs out of an editable checkout at all*. §5 removes the condition instead of measuring
it.

---

## 5. OPEN: separating "the code that runs" from "the checkout we edit"

### The problem, stated once

`~/SPO-Pipeline` is three things at once: the tree the service executes, the tree a human edits, and
the tree `git pull` mutates. Because `DAEMON_PATH` is resolved per spawn, mutating it while the
daemon runs is enough to split versions with no restart at all. The drain and the restart both
narrow the window; neither can close it, because the window is a property of the layout.

Concretely, three exposures survive everything in §3:

1. **The pull instant.** Between `git pull` writing files and `post-merge`'s SIGTERM arriving, the
   old dispatcher can spawn a new-code worker. Milliseconds, but unbounded if the hook is not armed.
2. **The skipped-unit case.** If the hook skips (unit stopped, §2.1), the files change and *nothing*
   restarts. The gap is then as long as the maintainer's attention span. This is not hypothetical:
   the daemon ran eight-hour-old code for a working day on 2026-09-03.
3. **Hand edits.** Any agent or human editing the live checkout is editing a running program. This
   repo already has a standing rule against it (`CLAUDE.md`), which is another way of saying the
   layout requires discipline to be safe.

### Options

**A — Status quo + drain (what is deployed today).**
Cost: zero, already done. Closes the "cards killed" half entirely. Leaves all three exposures above.
Relies on a rule (`never edit ~/SPO-Pipeline`) that is enforced by convention only.

**B — Immutable release trees + a symlink.**
`~/.spo-releases/<sha>/` holds a detached checkout per release; `~/.spo-current` is a symlink;
`ExecStart` runs `~/.spo-current/orchestrator/daemon.js`. Deploying is *create the tree, move the
symlink, drain-restart*. `~/SPO-Pipeline` becomes an ordinary development checkout that the service
never reads.

The property that makes this work is not the symlink, it is Node's module resolution: `__dirname`
is the **realpath**, so a running daemon's `DAEMON_PATH` points into its own release tree.
Moving the symlink under a live daemon changes nothing for it; its workers keep coming from the
tree it started in. **Version cohesion becomes a property of the layout rather than of timing.**
Exposure 1 and 3 disappear outright; exposure 2 becomes visible (the symlink and the running
process's tree can be compared, and `pipelineSha` already reports the latter).

Cost, measured rather than guessed — and it is smaller than it looks, because most of this repo's
state already lives outside the tree:

| state | where it lives today | moves? |
|---|---|---|
| account pool | `~/.claude-accounts` | no |
| product checkout | `~/SPO-WebClient` | no |
| product worktrees | `~/.spo-worktrees` | no |
| bench | `~/.spo-bench` | no |
| **`queue/`** | `<repoRoot>/queue` | **yes** |
| **`journal/`** | `<repoRoot>/journal` | **yes** |

So the work is: relocate two directories (4 call sites — `daemon.js:413-414`, `bin/spo:281-282` —
each already overridable by flag), a release script, an install-script change, a `post-merge`
change, and a `spo deploy`/rollback path. Plus disk: one small checkout per retained release.
Rollback becomes `ln -sfn` + drain-restart, which is a real gain this layout gets for free.

**C — Stage-and-swap without releases.** Pull into a hidden clone, then `mv` it over the live tree.
Cheaper than B on paper, but it has B's state problem *and* keeps a mutable "current" tree, and
`mv` over a directory a live process holds open is not atomic in the way the symlink is. Strictly
worse than B; listed only to record that it was considered.

**D — Status quo + a hard rule and a check.** Keep A, and add a startup assertion that the daemon
refuses to run from a dirty working tree. Cost: near zero. Closes exposure 3 loudly instead of
silently; leaves 1 and 2.

### Recommendation, and the question that governs it

**B, if the pipeline is ever to update itself through its own pipeline. Otherwise A+D.**

That conditional is not hedging. A process that rewrites the file it is executing has no clean
solution in layout A — there is no moment at which "the code that ran the merge" and "the code on
disk" can be made to agree, and the drain does not help, because the card doing the deploying is
itself in flight. Under B the question does not arise: the card writes a *new* release tree and
moves a symlink, and the running daemon is untouched until it drains on its own terms.

So: **do we want the pipeline to be able to update itself through its own pipeline?**

- **Yes** → B is not optional, and should be built before the first self-update card is written.
- **No** → A+D is defensible and costs a day less. The rule "never edit `~/SPO-Pipeline`" stays a
  rule, and D makes it loud.

Not implemented pending that answer.

---

## 6. Applying this to the box

Nothing in §3/§4 reaches the running services until the code is deployed **and the installer is
re-run** — `SuccessExitStatus` and `TimeoutStopSec` live in the generated unit file, not in the repo
the daemon reads.

Order matters, and step 0 is not optional: the pull fires the hook, which restarts the daemon.

```
# 0. the daemon may now be stopped WITHOUT killing a card -- it drains.
bin/spo status
systemctl --user stop spo-pipeline-daemon.service
#    ...this can take up to 47 min if a card is running. To stop waiting:
#    systemctl --user kill -s TERM spo-pipeline-daemon.service
#    Wait for `inactive` (not `deactivating`) before step 1 if you want the pull to redeploy.

# 1. deploy
cd ~/SPO-Pipeline && git pull

# 2. regenerate the unit (SuccessExitStatus, TimeoutStopSec) and re-arm the hooks
scripts/daemon-install.sh
```

`daemon-install.sh` ends with `enable --now` + `restart`: it **starts the daemon**. With
`SPO_AUTO_PULL_MS` at its current `300000` that means claiming cards. Set the drop-in to
`SPO_AUTO_PULL_MS=0` first if the box should come back up idle.

**And correct the drop-in's own comment**, which §2.2 shows to be wrong
(`~/.config/systemd/user/spo-pipeline-daemon.service.d/auto-pull-on.conf`). Its last paragraph
should read: a restart no longer kills the in-flight card at all — it drains, up to 45 minutes; only
a card still running past that bound is signalled, and such a card parks with a *step-level* reason
(`llm-transport-failed:<STEP>`, auto-retried; or a `*-timed-out` reason, which is not) far more often
than with `task-orphaned-daemon-restart`.
