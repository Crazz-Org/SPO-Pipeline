# Orchestrator state-machine spec — v1.1

Status: **draft for shadow mode**, revised against the measured improvisation analysis
([improvisation-analysis.md](improvisation-analysis.md), phase 2: 16 card sessions, 35.2 %
of driver actions improvised, dispositions BRANCH 78 % · PARK 18 % · DIAGNOSE 4 %). v1.1
adds the two states that analysis found missing (CI_CHECKS, the `main`-moved transition) and
the design consequences at the bottom.

**What in this document (and the rest of the doc/prompts/orchestrator-comment corpus) is
verified, and by what** is not stated inline — see
[`accepted-gaps.md`](accepted-gaps.md), action 7bis.5's register: exhaustively-read surface,
sweep-enforced facts, classified-historical logs, and the named, line-counted accepted gap
handed to chantier 9. This file's own prose is in that last bucket except for the specific
park-reason and documented-constant facts a sweep checks — see `accepted-gaps.md` §3.

## Principles

1. **Exit codes are the contract.** Every scripted step is judged on its exit code, never on
   printed text — the convention every existing script already follows. **Action B3.4's own
   narrow exception:** GATE's exit code still decides the ROUTE alone (park vs. proceed vs.
   re-gate) for exit 0, exit 1, exit 2, and exit 4, and for exit 3's OTHER two sub-causes
   (bench client not built, WORKER DOWN). What action B3.4 adds for those is a second, read-only
   pass that only ever refines the *name* already attached to an exit code that was going to park
   regardless: `<spoBenchDir>/done/<jobId>.json` (exit 1, where the bench's own
   `JobReport.verdict`/`detail` is read whenever it is available and well-formed — see
   `steps/scripted.js`'s `readGateJobReportForRouting`) and, only where no job id could ever
   exist yet to read a report by (exit 2/3's deposit-time refusals), the CLI's own printed
   stderr text. Both fall back to the exact exit-code-only reason that stood before this action
   whenever they are unavailable or unparseable — see the GATE row below for the complete
   account.
   **Card #211's own exception, ON TOP of B3.4's:** exit 3's fourth sub-cause, `WORKER DIED`,
   is NOT naming-only once a job id was printed — the exit code alone no longer decides the
   route for it. `recoverFromGateWorkerDied` (GATE row below) can resolve that exit 3 to
   `CI_CHECKS`, `DIAGNOSE`, `CHECK`, or a different park entirely, exactly as exit 0/1 already do
   off file content — because the CLI's own liveness read that produced the exit code was
   measured to be WRONG in the corpus, not merely under-specific. This is the one place in GATE
   where "the exit code decides the route" is not the final word; every other exit/sub-cause in
   this paragraph is unaffected. **Round 2:** the matched stderr literals (`NOT PUSHED`, `already has job`,
   `bench client not built`, `WORKER DIED`, and the `job … queued` marker `parseGateJobId`
   parses) all live in SPO-WebClient — `scripts/bench-gate.sh`, `scripts/bench-submit.sh`,
   `src/e2e/bench/cli.ts`, `src/e2e/bench/job.ts` — a repository this file does not own and whose
   wording nothing here enforces. `test/gate-stderr-literal-sweep.test.js` pins every one of them
   against the real product tree (resolved via that repo's own `git ls-files`, full paths only,
   never a bare basename) so a reword over there fails this suite immediately instead of silently
   reverting exit-2/3 routing to its pre-B3.4 collapse with every test here still green; it fails
   loudly, not silently, if the product repo is absent from disk entirely.
2. **The catch-all is the error policy.** Any state, exit code or output the machine does not
   recognize → the task is **parked**: worktree left intact, one report written, one journal
   event, zero further tokens. Explicit error handling means a safe cheap catch-all, not
   foreseeing everything. Parked tasks are handled by the maintainer or an interactive
   session; every parking reason that recurs becomes a new branch (frequency-ordered). One
   case a task cannot produce a park for itself: the process running it dying mid-run (crash,
   hard kill, a lost single-instance lock). Since chantier 6 split the daemon into a dispatcher,
   worker and scanner process (`orchestrator/README.md` § "How much the daemon takes on at once"),
   the **primary** cover is the dispatcher's own exit handler: `dispatcher.js`'s `handleExit` →
   `reparkCrashedWorker` runs the exact same `buildCtx`/`finalizePark` round trip a normal
   catch-all park uses, immediately, the moment a worker child exits abnormally — reason
   `worker-crashed`, detail `{exitCode, signal}`. Card #78: that round trip no longer runs
   in-process, on the thread holding the single-instance lock; `reparkCrashedWorker` spawns a
   short-lived `daemon.js --repark-task` child instead and returns, and `finalizePark` itself runs
   inside that child (`state-machine.js`'s `reparkCrashedTask`) — see `dispatcher.js`'s own header
   for the `<taskDir>/repark-claim.json` handoff that keeps this race-free against `orphan-
   scan.js`'s concurrent scan. `orchestrator/orphan-scan.js` is now the
   **fallback**, covering the case the dispatcher itself cannot: a `state.json` left on a
   non-terminal state with no `queue/` entry and a dead owner pid is reparked automatically
   (`task-orphaned-daemon-restart`) through the same `finalizePark` path (including restoring
   `worktreePath` onto the rebuilt ctx, so a still-dirty worktree is pushed to a `wip/` ref
   exactly as a live park would), the next time a `--real` daemon starts or the scanner runs its
   periodic scan. `orphan-scan.js` has a second, narrower shape for the same fallback role: a task
   claimed off `queue/` (a `task.json` on disk) that never reached even one handler — no
   `state.json` was ever written, so there is nothing to compare an owner pid against — is parked
   `task-orphaned-before-start` once it has sat unclaimed-by-any-live-worker for longer than the
   grace window; `lastState` is recorded as `INTAKE` (honest, not a guess: a task in this shape by
   definition never got past it) so a bare `retry` reply restarts it from the beginning, a
   complete recovery for a task that never ran. A `--shadow`/`--dry-run` start never does real
   side effects, so both shapes only detect the orphan and journal
   `orphan-scan-would-repark` — neither ever parks. `handleExit` also
   deliberately declines to call `reparkCrashedWorker` for a worker that crashes **during the
   dispatcher's own shutdown** (`dispatcher.js:643-656`, `childrenSignalled && outcome === 'crashed'`
   — keyed on "did we actually signal this child", not on `stopReason`, since a DRAIN sets
   `stopReason` and then waits minutes having signalled nobody):
   reparking here would spawn a fresh `daemon.js --repark-task` child in the middle of a shutdown
   already under way, and that child would carry the same risk a synchronous in-process repark
   used to carry directly — a `finalizePark` caught mid-write (state.json PARKED, no park-comment
   yet) if `reapSignalledChildren`'s own SIGKILL escalation ever reaches it (the one caller that
   signals a repark child at all — see `dispatcher.js`'s own comment on `{ includeReparking: true
   }`), which no later scan can ever recover — deferring instead just leaves an ordinary
   non-terminal `state.json` for orphan-scan to pick up cleanly next start. Since the drain, a deploy's pull drain-restarts the daemon
   (`scripts/release.sh`; the unit's `KillMode=mixed`), so an in-flight card reaches this fallback
   only if it outlives the drain bound (`config.js`'s drain timeout, default 45 min) or a second signal forces an immediate stop. See `orchestrator/README.md` § Orphan recovery.
   **Action 4.4:** the catch-all remains the error policy for every park reason except a closed,
   named allowlist of ones that are facts about the *world at that instant*, not about the card —
   `claim-rate-limited`, `gate-non-attesting` (action 4.2), `gate-live-blocked` (action B2.3),
   three of B3.4's four splits of non-attesting — `gate-environment`, `gate-interrupted`,
   `gate-abandoned` — plus B3.4's new `gate-stale` park (see the GATE row below), and the
   `llm-transport-failed:<STEP>` family (PLAN/IMPLEMENT/DIAGNOSE/VALIDATE, exact strings — never a prefix match). Those are auto-retried a bounded number of
   times (`config.transientRetryBudget`, default 2) with a journalled backoff
   (`config.transientRetryDelaysMs`, 1 min then 5 min, carried as an absolute `notBefore` on the
   re-queued task rather than a `sleep` — since chantier 6 split worker execution out into its own
   process (`orchestrator/README.md` § "How much the daemon takes on at once"), a sleep here would
   stall only the one worker process that is exiting anyway, not a shared drain loop; `notBefore`
   is still the right mechanism (a queued deadline survives that process exiting, a `sleep` would
   not), the original "stall every other card" justification just predates the split) before
   falling through to an ordinary park. A task on this
   path is never marked `PARKED` and never gets a park comment or board move — it is not parked,
   it is retrying — and a human's `retry` reply always resets the budget to zero and starts
   immediately, restoring the "a human can always make progress" guarantee. Everything else,
   including `push-pr-failed` (measured: every corpus occurrence is a logic failure, never a
   network one), still goes straight to the catch-all above. One exception inside the exception:
   a `gate-non-attesting` park whose detail carries `verdictDirExists: false` is a *misconfigured
   `spoBenchDir`*, not a transient fact — action 4.2 records that as a boolean rather than a
   distinct reason — so it is never auto-retried; retrying a wrong path costs a full
   WORKTREE/PLAN/IMPLEMENT/GATE run per attempt and can only look in the same wrong place again.
   The re-enqueue is one atomic write (`park-loop.js`'s `reEnqueueTask`, temp file + rename, with
   `transientRetries`/`notBefore` merged in): an entry visible without them would be "eligible
   now, budget unused", i.e. an unbounded retry loop after a SIGTERM in the gap. If that write
   fails, the task journals `transient-retry-failed` and takes the ordinary park — the journal
   never claims a retry that is not really queued. See `orchestrator/state-machine.js`'s
   `TRANSIENT_RETRY_REASONS`/`isTransientRetryReason`/`finalizePark`. Two further park reasons sit
   inside `state-machine.js`'s own dispatch loop rather than inside any handler, and so are never
   thrown as a `ParkSignal` at all — they call `finalizePark` directly, the same sink every other
   reason above eventually reaches: a run that hops between states more than `HOP_LIMIT` (200)
   times parks `state-machine-runaway` (`{hops}`) — the guard against a real handler bug producing
   a valid-looking but cyclic path (e.g. an infinite DIAGNOSE↔IMPLEMENT loop from a logic error),
   never tripped by any legitimate path, which completes in well under this many hops; and a
   `state` value with no entry in `HANDLERS` parks `unrecognized-state` (`{state}`) — defensive
   only, since every `state.json`/task-journal write in this codebase is produced by the state
   names this same file defines.
3. **LLM steps are stateless calls.** Each judgement step is one `claude` invocation (since card
   #239's transport cutover, action A5b, 2026-09-17: the vendored Claude Agent SDK's `query()`,
   never `claude -p` spawned directly -- see `orchestrator/steps/llm.js`'s own header) with
   a pinned model, effort, tool set, JSON output schema and budget. Continuity between steps
   travels through files (plan, ledger, diff), never through a long-lived conversation.
4. **The jewels are not re-implemented.** The bench, the validators' criteria and the
   blast-radius policy are used as-is.
5. **Everything is journaled.** One append-only JSONL journal per task; the console renders
   journals, it never holds state of its own. **Action 4.4:** a task taking the bounded
   auto-retry path above still journals `transient-retry` (`{reason, attempt, delayMs,
   notBefore}`) on the state it parked from, even though it never reaches `PARKED` itself — the
   journal stays the complete record either way. That event is written only once the queue entry
   is durably on disk; a re-enqueue that fails journals `transient-retry-failed` instead and the
   task parks normally, so the journal never records a retry the queue does not hold.

### Resume at CHECK (card #212)

A maintainer `retry` re-enqueues a parked card and `runTask` always restarts it at INTAKE, with
fresh counters — the right behaviour for most parks, but destructive for one narrow class: a
card parked because its branch conflicts with `origin/main` (`merge-conflict`,
`gate-merge-refused`, …) still has a perfectly good worktree, branch and open PR sitting on disk
and on GitHub, and INTAKE's own WORKTREE step would destroy that branch and close that PR before
trying again from scratch. `continue` is the non-destructive alternative: a queue entry carrying
`task.resume = {startState: 'CHECK', prNumber, worktreePath, commentId, fromReason}` (written by
a later action's unpark-scan, never by a maintainer's own `retry`) makes `runTask` skip INTAKE,
WORKTREE, PLAN and IMPLEMENT entirely and enter the loop directly at CHECK, on the SAME
`worktreePath`/branch (`` `claude-pipe/<id>` ``, the same convention `realWorktree`/`realPushPr`
already use) and the same `prNumber` the resume descriptor names.

What is rehydrated is exactly `worktreePath` and `prNumber` — the same two runtime-only fields
orphan-scan.js and a worker-crash repark already restore from a persisted `state.json`, because
neither one is ever written to `task.json`. For a maintainer's `continue`, everything else starts
as fresh as an ordinary INTAKE run: `ctx.counters` (diagnoseAttempts, validateRejects,
ciImplementRetries, mainMoveUsed) are `buildCtx`'s own zeros, never carried forward from whatever
the queue entry or an old `task.json` happens to hold. This is the same "only a human resets an
allowance" rule a `retry` already follows, and the human who queued a `continue` just did. A
descriptor a **machine** re-enqueue wrote is the exception: a pool-wait's own (card #251, below), or
a `continue` descriptor `carriedResume` carried forward (card #251, below). It carries a `counters`
object (diagnoseAttempts, validateRejects, ciImplementRetries, seenRootCauses), and `runTask`
restores it before anything else, so those survive the wake-up. They measure the change itself,
and a wait does not make the validator's, DIAGNOSE's or CI's earlier rejections any less true.
`mainMoveUsed` is the one counter that starts at 0 on every wake-up, machine or human. It is not
a quality allowance. It is a budget for `origin/main` moving under the worktree within one
uninterrupted pass, and the wait (up to 12h) is exactly when main moves. Carried, one earlier
main-moved merge plus one legitimate move during the wait would park the resumed run
`main-moved-twice` where the pre-#251 INTAKE restart and a `continue` both merge forward.
Resetting it cannot loop, because the pool-wait cap bounds the wake-ups. Only `counters` carried
IN the descriptor are restored, never stray counter-like fields on the task, and what is restored
is bounded: a value that is not a non-negative safe integer is ignored, one above 1000 is
clamped (still past every budget), and `seenRootCauses` keeps at most 100 strings. `ctx.cameFrom` is `null`, exactly as it is for the very first handler call of any run.

**Machine resume after a pool-wait (card #251).** A pool-wait (see Account pool below) used to
wake up at INTAKE, whatever state it fired in. On a card that had already reached VALIDATE, that
restart ran WORKTREE's leftover sweep, which closed the green PR and pushed its tip to a `wip/`
ref. It then re-ran IMPLEMENT, and all of that happened before Fable was probed again (#887,
#888 and #894 on 2026-09-16/17: 12 wake-ups, 1,664,184 billable tokens, 12 PRs closed). Now a
pool-wait fired in **VALIDATE** (`CITATION_VERIFIER` runs inside it, so its pool-wait is
journalled under VALIDATE too), with `ctx.prNumber` and the worktree on record, re-enqueues with
`task.resume = {startState: 'CHECK', prNumber, worktreePath, fromReason, source: 'pool-wait',
counters}` (`poolWaitResume` in `state-machine.js`). The wake-up takes this section's resume path
unchanged. It journals `resumed-at-check` (now also carrying `source: 'pool-wait'`), runs
`prepareResume`, and re-runs CHECK → PUSH_PR (PR reused) → GATE → CI_CHECKS, all scripted, before
VALIDATE. There is no INTAKE, WORKTREE, leftover sweep, PLAN or IMPLEMENT, so GATE/CI_CHECKS'
main-moved handling still covers an `origin/main` that moved during the wait. A pool-wait at
**PLAN, IMPLEMENT (before or after a PR exists) or DIAGNOSE still restarts at INTAKE**: the work
those steps produce is still pending, and resuming at CHECK would skip it
(`POOL_WAIT_RESUME_STATES` is `{VALIDATE}` alone). This also holds for a run that was itself a
machine resume and got back to IMPLEMENT or DIAGNOSE after a VALIDATE REJECT or a CI failure.
`carriedResume` drops a `source: 'pool-wait'` descriptor on any machine re-enqueue (pool-wait or
transient retry) fired in PLAN, IMPLEMENT or DIAGNOSE (`RESUME_SKIPS_WORK_STATES`), and still
carries it from the scripted states after CHECK. **A maintainer's `continue` is the exception, by
decision** (card #212 C4's rule, confirmed by card #255 on 2026-09-25): a run it resumed carries
that descriptor forward from every state, IMPLEMENT and DIAGNOSE included, so the maintainer's fix
and the PR are always kept. An INTAKE restart would run WORKTREE's leftover sweep, which closes the
PR the maintainer just fixed and leaves their commit only on a `wip/` ref, quietly turning
`continue` into `retry`.

**Where that wake-up starts (card #279, option B, decided 2026-09-25).** Out of **IMPLEMENT** — the
step a VALIDATE REJECT, a failure DIAGNOSE diagnosed, or the Lint/Coverage CI route sent the run
back to — `carriedResume` rewrites the descriptor's `startState` to `'IMPLEMENT'`, and the wake-up
re-runs that pending IMPLEMENT on the same worktree and PR. From **every other state**, DIAGNOSE
included, it writes `'CHECK'`: past IMPLEMENT the pending work is scripted again, and a re-enqueue
fired inside DIAGNOSE (at its lease, before any attempt is counted) recorded no finding for
IMPLEMENT to act on, so DIAGNOSE simply runs again after CHECK re-meets the failure. An IMPLEMENT
descriptor re-enqueued once its IMPLEMENT has run therefore goes back to `'CHECK'`. The machine
lineage never resumes at IMPLEMENT (it is dropped there, above). What the IMPLEMENT wake-up has to
work with: the counters the descriptor carried (the same set as a #251 resume — `diagnoseAttempts`,
`validateRejects`, `ciImplementRetries`, `seenRootCauses`; `mainMoveUsed` restarts at 0), so the
budgets stay enforced and IMPLEMENT's `diagnoseOrValidateRetry` effort escalation still fires; and
the feedback it acts on, which `task-values.js`'s `diagnosisSummary` reads from the most recent
DIAGNOSE `result` and VALIDATE `result` anywhere in the task's `journal.jsonl`, across runs, and
threads into IMPLEMENT's `{{diagnosis}}`. `prepareResume` runs first, under IMPLEMENT, and keeps
the run's own in-flight work (steps 6 and 9, below), as it does on every resume a machine re-enqueue
wrote, at CHECK too (card #281). No VALIDATE is spent on the unfixed diff, and DIAGNOSE never
re-meets a failure it has already named.

Before #279 (card #255's option A), this wake-up resumed at CHECK. After a VALIDATE REJECT, that
cost one VALIDATE call and one unit of reject budget per re-enqueue, re-validating the unchanged
diff before IMPLEMENT could run. On the DIAGNOSE path it cost more. When the re-enqueue fired in the
IMPLEMENT that follows DIAGNOSE, the wake-up met the same failure on the unchanged diff and entered
DIAGNOSE again, with the ledger and the carried `seenRootCauses` already naming the cause IMPLEMENT
never got to fix; it parked `diagnose-no-new-cause` or `diagnose-duplicate-root-cause`, neither of
them in `RESUMABLE_PARK_REASONS`, so only `retry` got the card out, and `retry` closes the PR.
Pinned end to end by `test/pool-wait-resume.test.js` part 5, which replays both paths through
`unparkScan` → `drainQueueOnce` and asserts the order off journal event indexes.

**The DIAGNOSE-path gap #279 left open is closed (card #281, 2026-09-25).** A `continue` lineage
whose CHECK fails after an IMPLEMENT (so IMPLEMENT's edits are still uncommitted), or after a
CI_CHECKS main-moved merge (so a merge commit sits on top of origin's tip), and that is then
re-enqueued inside DIAGNOSE, wakes up at CHECK on that tree. Until #281 `prepareResume` refused it
there (`resume-precondition-failed`, `dirty-worktree` or `not-fast-forward`), and every later
`continue` refused it again until a human cleaned the tree by hand. Since #281 the keep-the-tree
rule of steps 6 and 9 is keyed on **who wrote the descriptor**, not on the start state: a
descriptor one of `finalizePark`'s own re-enqueues wrote (`isMachineReEnqueueResume`: it carries
`counters`) keeps the run's own in-flight work at CHECK as at IMPLEMENT, and CHECK re-meets the
failure on it. The reason is the same as #279's: `finalizePark`'s re-enqueue branches return
before its `preserveWorktreeWip` housekeeping and before any PARKED write, so between the
re-enqueue and its wake-up nobody was handed the tree. `counters` is a reliable mark because every
`resume` a queue entry carries comes from `reEnqueueTask`'s `extra` (it strips the one `task.json`
still holds), and only three writers pass one: `carriedResume` and `poolWaitResume` always set
`counters`; `unparkScan`'s `continue` writes a fresh object without it; `retry` writes no
`resume`. A maintainer's `continue` after a park still refuses a dirty tree and commits ahead,
exactly as before: after a park the tree was preserved to `wip/` or handed to a human. A #251
machine pool-wait descriptor keeps the tree under the same rule; its refusals still fall back to
the INTAKE restart below. Pinned end to end by `test/pool-wait-resume.test.js` part 6.
`poolWaitMs`/`poolWaitAttempts` are written explicitly by the pool-wait branch, as before, so the
12h cap keeps accumulating across resumed wake-ups. Like a `continue`, a resume skips WORKTREE's
nightly-red check.

When `prepareResume` refuses a machine resume (any `resume-precondition-failed` step: a missing
worktree, a closed or mismatched PR, a failed fetch, a rewritten branch, …; a dirty tree or commits
on top of origin's tip are kept since card #281, not refused), or `runTask`'s own
descriptor or path checks refuse it, the card is **not** parked for a human. Nobody asked for
that resume; it is an optimisation over the INTAKE restart. So `runTask` journals
`machine-resume-refused` (`{step, …refusal detail, source: 'pool-wait', fallback: 'INTAKE'}`),
strips `resume`/`worktreePath`/`branch` from the task, and restarts the same run at INTAKE with
the carried counters (`mainMoveUsed` at 0: the fallback builds a fresh worktree from current
main). That is exactly the pre-#251 wake-up, whose leftover sweep then deals with
whatever the refusal found. A maintainer's `continue` refusal still parks
`resume-precondition-failed`, unchanged.

Before any of that is written, `task.resume` is validated: it must be a plain object, its
`startState` must be `'CHECK'` or `'IMPLEMENT'` (`RESUME_START_STATES`; `'IMPLEMENT'` since card
#279, and only on a descriptor without `source: 'pool-wait'`, since the machine lineage never
resumes there), `prNumber` must be a positive integer, and `worktreePath` must be a non-empty
string. A `task.resume` that fails any
of those checks — including one that is present but not an object at all — is parked
`resume-precondition-failed` (`{step: 'invalid-resume', field}`, naming the first field found
wrong) **before INTAKE or CHECK ever run**: an invalid resume must never silently fall back to
the destructive INTAKE restart it exists to avoid. A `task.resume` that is absent, or explicitly
`null`, behaves exactly as today — an ordinary INTAKE start, byte-identical to a task that has
never heard of this feature. A resumed `kind: "card"` task in real mode still needs `--real`,
exactly as INTAKE itself requires: an invalid or missing flag there parks `real-flag-required`
(replicating INTAKE's own guard, since a resume skips INTAKE and so never reaches it directly).

A valid resume journals exactly one event before entering the loop, `resumed-at-check`
(`{prNumber, worktreePath, commentId, fromReason, source}`, fields the resume descriptor did not
carry simply absent — `commentId` on a machine resume, `source` on a `continue`), and the very
first `state.json` this run writes already has `state: 'CHECK'` alongside
`prNumber`/`worktreePath` — never an intermediate INTAKE/WORKTREE snapshot a `continue` never
runs. A resume at IMPLEMENT (card #279) journals `resumed-at-implement` instead, with the same
fields, writes `state: 'IMPLEMENT'` first, and enters the loop at IMPLEMENT. `prepareResume`'s
spawns and events and every park of the resume path past validation are journalled under IMPLEMENT
(a refusal park's `lastState` is IMPLEMENT), with one exception: `prepareResume` runs under CHECK's
deadline, so its `deadline-exceeded` events are journalled under CHECK and a second expiry parks
`step-deadline-exceeded-twice` with detail `{state: 'CHECK'}` (that park's `lastState` is still
IMPLEMENT). An `invalid-resume` park, which fires before the start state is trusted, stays under
CHECK. PUSH_PR's one-shot resume exemption (`commit-skipped-resume`, `ctx.resumePushPending`)
is not armed: that PUSH_PR has IMPLEMENT's new work to commit, and one with nothing new parks as any
ordinary pass does.

**Real-mode precondition check (card #212 C2).** A `continue` hands the daemon a worktree, branch
and PR it has not touched since it parked — possibly hand-edited on GitHub in the meantime — and
CHECK's own real spawns (`npm run typecheck`/`lint`/`coverage:changed`) are not equipped to notice
any of that. In real mode only (never shadow/dry-run, which have no real worktree/branch/PR to
have drifted), immediately after the start state's `state.json` write and before the loop
enters it, `runTask` runs `prepareResume` (`orchestrator/steps/scripted.js`) under the same
per-step deadline every scripted step uses (CHECK's, for a resume at IMPLEMENT too). Every refusal is `ParkSignal('resume-precondition-
failed', {step, ...})` — the one reason already registered above — caught the same way any other
handler's `ParkSignal` is. In order:

1. `worktree-path-mismatch` — the resume descriptor's `worktreePath` must equal
   `<pipelineWorktreesDir>/<id>` exactly; anywhere else and no git/gh command may run against it,
   here or afterward (`{expected, actual}`). `runTask` makes this check itself, before the
   resume's first `state.json` write and before `resumed-at-<state>`, so the foreign path is never
   recorded anywhere a later reader (orphan-scan, `abandon`'s `git worktree remove --force`,
   `moveCard`'s cwd) could act on it; `prepareResume` repeats it as defence in depth. The park
   keeps the PREVIOUS park's `worktreePath` only when that recorded path really is
   `<pipelineWorktreesDir>/<id>`, otherwise `null`, and skips wip preservation (below).
2. `worktree-missing` — the directory does not exist. Maintainer decision: parks rather than being
   silently rebuilt, since a resume is supposed to be the non-destructive path. **Accepted gap:**
   `postParkComment`'s own `moveCard` call still hands it `ctx.task.worktreePath` as a spawn cwd
   (the path itself is trusted here, per F1 above — the refusal is that nothing exists AT it) —
   `moveCard` does not `fs.existsSync` it, so the spawn itself fails (ENOENT) and the move is
   recorded as `board-move-failed`, not silently skipped; the board card is left in whatever
   column it already sat in. Pre-existing `moveCard` behaviour, unchanged by this feature.
3. `pr-not-open` — `gh pr view <prNumber> --repo <ghRepo> --json state,headRefName` (the same shape
   MERGE's own `probeMergeability` uses, without its retry loop): a non-zero exit or unparsable
   stdout parks `pr-read-failed` (`{exit}` / `{unparsable: true}`); a `state` other than `OPEN`
   parks `pr-not-open` (`{prState}`). **Fix pass (F6):** once the PR is confirmed OPEN, its own
   `headRefName` must equal `claude-pipe/<id>` — the resume descriptor's `prNumber` is a
   maintainer-supplied number and could, by typo or stale record, name a real, open PR built off a
   different branch entirely; a mismatch parks `pr-branch-mismatch` (`{headRefName}`).
4. If `git rev-parse -q --verify MERGE_HEAD` exits 0 — a merge CI_CHECKS' own main-moved path left
   in progress (`main-moved-merge-failed` never aborts its own conflict) — **fix pass (F3):**
   `git ls-files -u` reads whether that merge is still conflicted before anything touches it. A
   non-zero exit parks `ls-files-failed` (`{exit}`); EMPTY stdout means every conflict is already
   resolved and staged — running `merge --abort` here would discard a maintainer's own resolution,
   so this parks `merge-in-progress` instead, untouched, for the maintainer to commit and push
   before the next `continue`; non-empty stdout (still-unmerged paths — the pipeline's own
   abandoned conflicted merge) runs `git merge --abort` exactly as before, parking
   `merge-abort-failed` (`{exit}`) on refusal and journalling `resume-merge-aborted` (`{}`) on
   success before the run continues.
5. `detached-or-wrong-branch` — `git symbolic-ref --short HEAD` must exit 0 and print exactly
   `claude-pipe/<id>` (`{head, exit}`).
6. `dirty-worktree` — `git status --porcelain` must exit 0 (else `status-failed {exit}`) with empty
   output. **After a machine re-enqueue (cards #279/#281), a dirty tree is kept instead**,
   journalled `resume-dirty-tree-kept` (`{entries}`, the porcelain line count), and the start
   state's handler runs on it. #279 applied this at IMPLEMENT only; #281 keys it on the descriptor
   carrying `counters` (`isMachineReEnqueueResume`, see *The DIAGNOSE-path gap #279 left open is
   closed*, above), so it holds at CHECK too. Such a descriptor follows a machine re-enqueue, not a
   park, so nobody was handed the tree in between: its uncommitted content is the run's own
   in-flight work — the edits of the IMPLEMENT before a CHECK failure (at IMPLEMENT, exactly the
   diff the DIAGNOSE finding IMPLEMENT is about to read talks about; at CHECK, a `continue` lineage
   re-enqueued inside DIAGNOSE, the diff CHECK failed on and now re-meets), or what an IMPLEMENT cut
   short by the pool-wait or transport failure left behind. An uninterrupted run already continues
   on both (IMPLEMENT after DIAGNOSE edits on top of the failed pass; `callLlmStep`'s account
   rotation and deadline retry re-run IMPLEMENT on whatever the cut-short call left), so keeping the
   tree extends that across the wait. Moving it to a `wip/` ref first (`preserveWorktreeWip`, what
   an INTAKE restart's leftover sweep does) was rejected: it would hand the run a diagnosis of a
   diff that is no longer in its tree. Nothing is discarded on any path: a later refusal parks with
   the kept tree preserved to `wip/` and the branch re-attached (below, card #281), and any later
   ordinary park preserves it to `wip/` as usual. After a maintainer's `continue` (no `counters`) a
   dirty tree still parks `dirty-worktree`.
7. `fetch-failed` — `git fetch origin` in the worktree (`{exit}`).
8. `remote-branch-missing` — `git rev-parse --verify --quiet refs/remotes/origin/claude-pipe/<id>`
   must exist: the resume's whole premise is a maintainer having pushed something to this branch.
9. Local `HEAD` is resolved (`rev-parse-failed {ref: 'HEAD'}` on failure) and compared to the remote
   tip. Equal: nothing to do. Otherwise `git merge-base --is-ancestor HEAD <remote-ref>` — exit 0
   (HEAD is an ancestor: the maintainer pushed a merge commit on top) runs
   `git merge --ff-only <remote-ref>` (`fast-forward-failed {exit}` on refusal); exit 1 (HEAD is
   NOT an ancestor: the maintainer rewrote the branch, or the worktree holds unpushed commits) parks
   `not-fast-forward` (`{head, remote}`) — never a reset in either direction, a human decides; any
   other exit parks `merge-base-failed` (`{exit}`). **After a machine re-enqueue (cards
   #279/#281, the same rule as step 6)**, exit 1 is first asked the other way round,
   `git merge-base --is-ancestor <remote-ref> HEAD`: exit 0 (the worktree only holds commits ON TOP
   of origin's tip — an IMPLEMENT that committed before it was cut short, or a CI_CHECKS main-moved
   merge whose CHECK then failed) keeps them, like the dirty tree at step 6, journalled
   `resume-unpushed-commits-kept` (`{head, remote}`), for PUSH_PR to push (its
   `commit-skipped-nothing-staged` case); exit 1 (a real divergence) still parks
   `not-fast-forward`, any other exit `merge-base-failed`. This is the last check, so no refusal
   ever follows a keep here. After a maintainer's `continue` exit 1 parks `not-fast-forward` without
   asking the other way round.
10. Success journals `resume-prepared` (`{head, fastForwardedFrom}` — the pre-fast-forward head, or
    `null` when nothing moved) and the start state's handler runs next: CHECK's own real spawns, or
    IMPLEMENT.

A maintainer's `continue` on a refusal park of a resume at IMPLEMENT resumes at CHECK, like every
`continue` (`unparkScan` always writes `startState: 'CHECK'`, with no `counters`): the tree was
handed to a human, so the in-flight rule no longer applies, and the human's reset counters take
over. When that refusal came after step 6 had kept a dirty tree (or was `pr-read-failed` on such a
tree, fix pass F1), the park preserved it to `wip/` and re-attached the branch (below), so this
`continue` finds a clean tree on `claude-pipe/<id>` and gets past steps 5 and 6 — one round trip,
not two (card #281), except in the step-9 residual below. It runs on the branch tip, not on the
preserved work, unless the maintainer pushes that work first (*What the next `continue` runs on*,
below).

**A resume-precondition park never touches a worktree it did not keep (fix pass, card #212, F2;
card #281).** On a machine resume (card #251) none of the refusals above parks at all; each one
falls back to the INTAKE restart, as described under *Machine resume after a pool-wait*. On a
`continue` and on a `continue` lineage's carried descriptor, every refusal above is `runTask`'s
`prepareResume` catch setting `ctx.skipWipPreserve = true` (`buildCtx`-defaulted `false`) before
it calls `finalizePark` — except the one case below. `finalizePark`'s own park-time housekeeping
(`preserveWorktreeWip`: detach HEAD, `git add -A`, commit to a throwaway `wip/<id>-<ts>` ref, push)
exists for a task that crashed or was orphaned mid-edit — not for a worktree a maintainer's
`continue` handed back exactly as it was left. Running it anyway over a `dirty-worktree` refusal
would strand the very state the maintainer needs to fix by hand AND detach `claude-pipe/<id>`, so
the next `continue` parks `detached-or-wrong-branch` forever; over a
`pr-not-open`/`merge-in-progress`/... refusal it would needlessly rewrite a tree the maintainer
never asked touched. `finalizePark` journals `wip-preserve-skipped` (`{reason:
'resume-precondition'}`) instead and leaves the worktree byte-for-byte as `prepareResume` found
it. `ctx.skipWipPreserve` is set on this one path only — an ordinary, non-resume park on a dirty
worktree still preserves exactly as before (and leaves HEAD detached, so a `continue` after it
parks `detached-or-wrong-branch`; pinned in `test/pool-wait-resume.test.js` part 6).

**The exception: a refusal after a KEPT dirty tree (card #281).** When step 6 kept a dirty tree
(`ctx.resumeKeptDirtyTree`, set by `prepareResume`) and a later step refuses (`fetch-failed`,
`remote-branch-missing`, `rev-parse-failed`, `fast-forward-failed`, a real `not-fast-forward`
divergence, `merge-base-failed`), that tree is the run's own in-flight work, the crashed-mid-edit
shape the housekeeping exists for, and nobody was handed it. Leaving it untouched made the
maintainer's `continue` (which refuses a dirty tree) park `dirty-worktree` in turn, a second round
trip. So the catch leaves `skipWipPreserve` false and sets `ctx.wipReattachBranch` to
`claude-pipe/<id>`: `finalizePark` preserves the tree to `wip/` like any ordinary park (`report.md`
and the park comment carry the `wip` ref), then, only once `preserveWorktreeWip` has returned a
ref (the push landed), `reattachWorktreeBranch` runs `git checkout claude-pipe/<id> --`, journalled
`wip-reattached` (`{branch}`) or `wip-reattach-failed` (`{branch, exit}`, or `{branch, step:
'timed-out', reason}`). The branch pointer never moves, so the tree ends clean, on its branch, at the
tip it had. No work is lost on any path: a successful push puts it on `wip/` before the checkout;
a failed status, detach, add or commit leaves it in the tree (detached or not); a failed push
leaves it on the detached local commit, which is why no re-attach follows. The catch requires the
worktree path to be the trusted `<pipelineWorktreesDir>/<id>` (a kept tree implies steps 1-5
passed, so it always is; the check is defence in depth). A refusal with nothing kept or on a clean
tree still skips the housekeeping. Step 9's keep never precedes a refusal.

One refusal before step 6 gets the same treatment (fix pass F1): **`pr-read-failed`** (step 3, a
`gh pr view` that exited non-zero or printed something unparsable, typically a transient GitHub
failure), on a machine descriptor only — in practice a `continue`-carried one: a #251 pool-wait
descriptor's `pr-read-failed` returns through `restartRefusedMachineResume` before the probe, and
that INTAKE fallback's WORKTREE sweep owns the tree. It fires before step 6 can keep anything, so the catch
probes the tree itself (`worktreeHoldsInFlightDirt`, on the trusted path): `git rev-parse -q
--verify MERGE_HEAD` must exit 1 (no merge in progress), `git symbolic-ref --short HEAD` must print
`claude-pipe/<id>`, and `git status --porcelain` must be non-empty — exactly the tree step 6 would
have kept. Then it preserves and re-attaches as above. Any probe failing, a timeout included,
answers no and the park skips the housekeeping as before; the probe never throws. The other
refusals before step 6 stay skipped, on purpose: `worktree-path-mismatch` and `worktree-missing`
have no trusted tree to touch; `pr-not-open` and `pr-branch-mismatch` name a PR no `continue` can
resume onto, so a clean tree would buy no second round trip; `ls-files-failed`, `merge-in-progress`,
`merge-abort-failed` and `detached-or-wrong-branch` leave a tree mid-merge or off its branch, which
`preserveWorktreeWip`'s detach-and-commit cannot safely preserve (and `merge-in-progress` is a
maintainer's own resolution); `status-failed` could not read the tree at all.

**Residual (fix pass F4):** the re-attach restores the branch's LOCAL tip, which a refusal before
step 9 has not compared with origin. When that tip also holds commits origin has never seen (an
IMPLEMENT that committed before it was cut short, a CI_CHECKS main-moved merge), the next
`continue` gets past steps 5 and 6 and then parks `not-fast-forward` at step 9, and the same
happens with a clean tree and such commits, where nothing is preserved at all. Nothing is lost —
the commits stay on the local branch — but that is still a second round trip. The maintainer's
way out is to put that work on `origin/claude-pipe/<id>` before replying `continue`: the `wip/`
commit when one was made (below; it descends from those commits), otherwise the local branch
itself (`git push origin claude-pipe/<id>` from the worktree). Either push is a fast-forward only
if the remote has not moved since the run last pushed it; a rejected push must never be forced —
merge the remote tip instead, as below. Step 9 then finds HEAD equal to, or an ancestor of, the
remote tip.

**What the next `continue` runs on (fix pass F5).** After a re-attach, the kept work is only on
the `wip/<id>-<ts>` ref. The next `continue` resumes at CHECK on the branch tip, without it: in
shape 1 (a `continue` lineage re-enqueued inside DIAGNOSE) CHECK re-meets the original failure,
and DIAGNOSE and IMPLEMENT run again on the pushed diff. To reuse the kept work instead, push the
`wip/` commit onto the branch before replying `continue` — `git push origin
<wip-sha>:refs/heads/claude-pipe/<id>` (the sha is the `wip` detail in the park comment and
`report.md`). `preserveWorktreeWip` committed it on a HEAD detached from the branch's LOCAL tip, so
that push is a fast-forward only when `origin/claude-pipe/<id>` is still that local tip or one of
its ancestors, i.e. when the remote has not moved since the run last pushed it: the usual case
after `fetch-failed` or `pr-read-failed`. Neither of those (nor `remote-branch-missing`, which found
no remote tip at all) ever compared the two tips, so that is an expectation, not a certainty, and
git's own verdict on the push settles it. After `fast-forward-failed` the remote HAS moved past the
local tip, and after `not-fast-forward` the two have diverged: there the push is rejected as a
non-fast-forward, and it must NEVER be forced — a force push deletes the remote commits the
refusal was protecting. Merge instead: check out `origin/claude-pipe/<id>`, `git merge <wip-sha>`,
and push that merge commit, which is a fast-forward of the remote tip. Either way the branch's local
tip is then an ancestor of the new remote tip, so the next `continue`'s step 9 fast-forwards onto it
(`resume-prepared.fastForwardedFrom`; after `fast-forward-failed` that is the same `git merge
--ff-only` that failed, so whatever made it fail must be gone first), CHECK runs on the kept work,
and PUSH_PR — clean tree, HEAD equal to `origin/claude-pipe/<id>`, on the resume's first pass —
takes its `commit-skipped-resume` case instead of parking `nothing-new-to-push`. The `wip(<id>):
parked -- resume-precondition-failed` commit then sits in the PR's history.

A refusal that fires before `prepareResume` has read the PR as `OPEN` on `claude-pipe/<id>`
(`worktree-path-mismatch`, `worktree-missing`, `pr-read-failed`, `pr-not-open`,
`pr-branch-mismatch`) also keeps the PREVIOUS park's `prNumber`, never the descriptor's: that
number is unverified, and a later `abandon` runs `gh pr close <state.prNumber>`, which would
close another card's PR. Refusals after that point record the verified number.

**Accepted gap:** `prepareResume` does not run `npm ci` and does not merge `origin/main` — GATE's
own main-moved path already does that merge-forward with a fresh budget on every resume
(`mainMoveUsed` starts at 0 after a `continue` and after a card #251 machine resume alike), and
that existing path does not reinstall
dependencies either. A maintainer's merge commit that changes `package-lock.json` therefore runs
CHECK (and everything after it) against `node_modules` as they were when the worktree was parked,
not as the new lockfile describes. **Contract for the maintainer:** resolve the conflict with an
actual merge commit pushed onto `claude-pipe/<id>` (or push nothing at all if `main` has since
moved past the conflict) — never a rebase or a force-push, which step 9 above refuses as
`not-fast-forward` rather than guess which side should win.

**PUSH_PR one-shot exemption (card #212 C2).** A resumed branch's `HEAD` legitimately already
equals `origin/claude-pipe/<id>` on its very first PUSH_PR pass — it was pushed before the park, or
`prepareResume` just fast-forwarded it to the maintainer's own push — which is otherwise identical
to card #213's "nothing new since a prior push" shape (`push-pr-failed`, `nothing-new-to-push`).
`ctx.resumePushPending` (set `true` by `runTask`'s resume path, both real and shadow/dry-run, next
to the other rehydration; `false` from `buildCtx` otherwise) is read once and cleared immediately
at the top of `realPushPr`, so the exemption applies at most once per task: on that one pass, the
`nothing-new-to-push` shape journals `commit-skipped-resume` (`{head, remoteBranchSha, branch}`)
and falls through to the push instead of parking; a later pass through the same function (a
CI-red retry looping DIAGNOSE → IMPLEMENT → CHECK → PUSH_PR back here) finds the flag already
false and parks exactly as before this action. The `nothing-implemented` shape (`HEAD` equals
`origin/main`) is never exempted — a resume with nothing implemented at all still parks.

**PR-number drift on the reused-PR path (fix pass, card #212, F6).** `realPushPr`'s own
`gh pr list` reuse path (see the PUSH_PR row below) recomputes the open PR number for this branch
on every pass; when `ctx.prNumber` was already set (non-null — a resume's own rehydration, or an
earlier pass through this same run) and GitHub's answer names a DIFFERENT number, that drift is
now journalled, `pr-number-changed` (`{from, to}`), rather than silently overwritten — another
open PR now existing for this branch leaves a record of it (reopening a PR keeps its number, so
that alone never fires it). `ctx.prNumber` is still reassigned to GitHub's answer either way; only the journalling
is new.

**The `continue` verb (card #212 C4/C5).** Everything above this point is `runTask`'s own side of
a resume, entered from a `task.resume` descriptor that has to come from somewhere. This is where
it comes from: `park-loop.js`'s `unparkScan`, reading a maintainer's `continue` reply the same way
it already reads `retry`/`abandon` (`CONTINUE_RE = /^continue\b/i`, added to `UNPARK_PATTERNS`
alongside them — `report-intake.js`'s own `CONFIRM_RE`/`DISCARD_RE` vocabulary is disjoint, no
collision).

`continue` is available for exactly the six park reasons a resume can restart from
(`RESUMABLE_PARK_REASONS`, `park-loop.js`, exported for `test/unpark-continue.test.js`'s own
membership sweep): `merge-conflict`, `gate-merge-refused`, `main-moved-merge-failed`,
`main-moved-twice`, `merge-behind-base`, `resume-precondition-failed` — every member also a
`TERMINAL_PARK_REASONS` entry in `state-machine.js`, since `continue` never resumes a reason the
code does not already treat as terminal. Eligibility (`continueEligibility`, read straight off
`state.json` — no extra `gh` call) additionally requires `state.state === 'PARKED'`, a verified
positive-integer `state.prNumber`, no `state.externallyResolved`, and a configured
`config.pipelineWorktreesDir`.

**Eligible:** re-enqueues exactly like a maintainer `retry` — same `reEnqueueTask`, same
`0000-retry-h-<key>-<id>.json` naming keyed on the comment id, same priority class `h`, same
effect-before-marker ordering and the same guarded `reEnqueueTask` catch (a failed write withholds
the marker; the next scan redoes the effect) — but with one extra field in the queue entry:
`resume: {startState: 'CHECK', prNumber: state.prNumber, worktreePath:
<pipelineWorktreesDir>/<id>, commentId, fromReason: state.reason}`. `worktreePath` is always the
PIPELINE's own path for this id, computed fresh from `config.pipelineWorktreesDir`, never
`state.json`'s own `worktreePath` — that field can be stale or (defence in depth) foreign, and
`prepareResume` (C2) refuses anything else anyway. The marker is `unparked-by-maintainer` with an
added `verb: 'continue'` field, the same event `retry` writes.

**Ineligible:** NEVER falls back to `retry` — reinterpreting a maintainer's explicit word as a
different one they did not type is exactly the silent-misbehaviour class this pipeline's `gh
api -f` incident (CLAUDE.md) already paid for once. Instead, one acknowledgement comment is
posted on the issue (`gh issue comment`, the same mechanism the `abandon` ack uses), its first
line starting `pipeline:` — so it can never itself match `UNPARK_PATTERNS` on a later scan — naming
why (`continueEligibility`'s own `why`: `not-resumable`, `no-pr`, `externally-resolved`,
`no-worktrees-dir`) and that `retry`/`abandon` remain available. `unpark-verb-refused`
(`{commentId, verb: 'continue', reason, why, ackExit}`) is then journalled whether or not the ack
itself succeeded — `ackExit` carries the ack's own `gh` exit code, and a non-zero one also
journals `continue-ack-failed` first, the same shape `abandon-ack-failed` already has. No queue
entry, no `unparked-by-maintainer`.

The refused comment must never be matched again on a later scan: `findParkAnchor` treats an
`unpark-verb-refused` event carrying a numeric `commentId` as a new anchor, exactly like
`park-comment` — the last of either kind wins, by journal position, same rule the anchor already
follows. A `retry`, `abandon`, or a later eligible `continue` posted AFTER the refusal is still
scanned normally, since it sits after this new boundary. `unpark-verb-refused` is deliberately NOT
in `retry-channel.js`'s `PARK_CYCLE_ENDING_EVENTS`: a refusal does not end the park cycle, so the
retry-channel health walk (`summarizeUnparkScanTail`) still reads through it correctly.

**`resume` must never leak into a run that did not ask for it.** `takeNextTask` renames the queue
entry straight over `journal/<id>/task.json`, so after a resumed run that file still carries
`resume` — and `reEnqueueTask` reads its "original" fields from exactly that file. `reEnqueueTask`
therefore strips `resume` from its stripped-field destructure, alongside
`worktreePath`/`branch`/`baseMainSha`/`transientRetries`/`notBefore`/`poolWaitMs`/
`poolWaitAttempts` — for EVERY caller: a maintainer `retry`, and both of `finalizePark`'s own
machine re-enqueues (the bounded transient auto-retry, the pool-exhaustion wait). `resume` comes
back only through `reEnqueueTask`'s `extra` parameter: from the `continue` branch, and from those
two machine re-enqueues when the run being retried was itself resumed (`carriedResume`, with
`prNumber` refreshed from the run and, since card #251, the run's `counters` added; since card
#279, `startState` rewritten from where the run left off), and from the pool-wait re-enqueue of a
VALIDATE pool-wait with a PR open (`poolWaitResume`, above). A transient park during a
`continue`-resumed run therefore retries through `prepareResume` again, instead of restarting at
INTAKE and closing the PR the maintainer just fixed, from every state (card #255, above): at
IMPLEMENT when it fired in IMPLEMENT, at CHECK from everywhere else (card #279, above). A run
resumed by a pool-wait retries at CHECK, except from PLAN/IMPLEMENT/DIAGNOSE, where it restarts at
INTAKE (see above). A maintainer `retry` always drops it.

**The park comment (card #212 C5).** `RETRY_ABANDON_LINE` stays byte-identical — pinned by
`test/park-loop.test.js`. For a park whose reason is on `RESUMABLE_PARK_REASONS`,
`buildParkComment` (`park-loop.js`) adds ONE extra line right after it, naming
`` `claude-pipe/<id>` `` and the `continue` reply; `resume-precondition-failed` gets its own
phrasing (fix what the reason above already names, then reply `continue` again — there may be no
conflict to push a merge commit onto). Every other park's comment renders byte-identical to
before this action.

## Task lifecycle

```
INTAKE → WORKTREE → PLAN → IMPLEMENT → CHECK → PUSH_PR → GATE → CI_CHECKS → VALIDATE → MERGE → FINISH → DONE
                                ▲                          │         │           │
                                └────────── DIAGNOSE ◄─────┴─────────┴───────────┘
                                                  (gate FAIL ≤3 distinct root causes ·
                                                   unknown CI failure · validator REJECT ≤3)
  any state ────────────────────────────────────────────► PARKED (catch-all: report + stop)
```

| State | Kind | Does | Success → | Failure → |
|---|---|---|---|---|
| INTAKE | script | take next task file from `queue/` (priority = file order; sources: board export, `/triage-report`, later in-game reports). **Action 3.2's INTAKE scan was removed 2026-09-05 (#118).** A `kind: "card"` task's criterion and title used to be scanned here for a protected-file mention, parking at zero cost; measured over the whole journal corpus that scan fired exactly once, on SPO-WebClient#482 — the card written to fix the PLAN-side guard, whose criterion *quotes* the protected paths as examples — one firing, zero true positives. Prose cannot tell "EDITS this file" from "CITES this file", the same measurement (33% precision) that had already retired the `plan_markdown` scan at PLAN. INTAKE no longer scans a card's *prose* for protected files: the only protected-file park is PLAN's, on the machine-readable `files_to_change` declaration. **It does now carry one gate of its own (card #226): the nightly-red pre-gate.** For a real-mode `kind: "card"` task only, INTAKE reads the *locally-known* `origin/main` sha (`git -C <productRepo> rev-parse origin/main` — deliberately **no** `git fetch` and **no** `withProductRepoLock`, since paying either per card is the cost this gate exists to remove) and runs it through the same `classifyNightly` WORKTREE/GATE/CI_CHECKS use. `red` parks `nightly-red-holding-intake` **before any transition into WORKTREE**, so a held card never pays realWorktree's lock/fetch/rev-parse/`npm ci` and produces no `WORKTREE` journal entry at all. Unlike its WORKTREE-state siblings that reason is **transient** (`TRANSIENT_RETRY_REASONS`): the card re-enqueues itself on the ordinary backoff and resumes once nightly is green, with no human `retry`. The gate **fails open** in both directions — a non-zero rev-parse (no product repo, a broken `.git`) proceeds to WORKTREE exactly as before, and a stale local sha classifies `unknown`, which also proceeds. It can therefore miss a red nightly; it can never invent one, and what it misses WORKTREE's own check still catches against the freshly fetched sha. | WORKTREE | PARKED (`invalid-task-json`, `real-flag-required`, `nightly-red-holding-intake`) |
| WORKTREE | script | Action B1.4 round 4: BEFORE anything else, inside the SAME product-repo lock span (`payBenchReinstallDebtIfOwed`), pays back a bench-worker reinstall an EARLIER card's FINISH deferred (`journal.js`'s `writeBenchReinstallOwed`/`bench-reinstall-owed.json`) rather than parked -- WORKTREE runs before GATE, so a card that starts while a reinstall is owed settles it before it can gate against a stale worker. Reuses the SAME fast-forward + conditional `bash scripts/bench-install.sh` sequence FINISH's own preamble below uses (`fastForwardMainAndInstall`, one implementation, not two) -- fetch, refuse (never force) unless `main` and clean of TRACKED changes, `git merge --ff-only origin/main`, then, ONLY if the bench checks idle on a SINGLE non-blocking read (never a poll) and `git merge-base --is-ancestor <owed sha> HEAD` confirms the debt's own record is still an ancestor of the fast-forwarded checkout, the reinstall itself. NEVER blocks or parks this card: a busy bench, an unreadable bench dir, a failed fast-forward, a failed ancestry check, a failed install, OR anything payBenchReinstallDebtIfOwed's own attempt throws (a `bench-install-timed-out`/`git-timed-out` ParkSignal from spawnStep's own timeout handling, or a raw Error from `clearBenchReinstallOwed`'s own fs call) all leave the record owed, journal why (`bench-debt-still-busy` / `bench-debt-dir-unreadable` / `bench-debt-ancestry-check-failed` / `bench-debt-attempt-failed` (R4, fifth pass — catches every thrown failure mode, exit code or not, so a wedged installer never terminally parks every card that starts), or the same `main-fast-forward-failed`/`bench-reinstall-failed` vocabulary FINISH uses), and WORKTREE proceeds exactly as if nothing were owed -- the NEXT card's WORKTREE tries again. A successful pay-back clears the record and journals `bench-debt-paid`. Superseded round 3's dedicated daemon scan timer (`orchestrator/bench-reconcile.js`, since deleted): that module held the SAME product-repo lock from a THIRD process the mutex's own wait-bound derivation assumes cannot exist. Then, WORKTREE's ordinary sequence: fresh worktree + branch off last green `main`; refuse if nightly says `main` is red (repair task only) | PLAN | PARKED — `product-repo-lock-timeout` when the chantier 6 product-repo mutex isn't acquired within its wait bound (`withProductRepoLock`, shared with FINISH below), plus real mode's own sequence: `worktree-fetch-failed` / `worktree-rev-parse-failed` / `worktree-add-failed` (the `git fetch origin` / `rev-parse origin/main` / `worktree add` calls themselves exit non-zero); `nightly-main-red` (the freshly-fetched `origin/main` sha matches a `FAIL` verdict in `~/.spo-bench/nightly/latest.json`, checked before anything is created); `worktree-npm-ci-failed` (`npm ci` in the fresh worktree). Card #424's leftover sweep (`sweepWorktreeLeftovers`, action 4.6) runs before `worktree add`: `worktrees/<taskId>` + branch `claude-pipe/<taskId>` is the pipeline's own exclusive namespace, so a retry may clean up its own previous attempt rather than collide with it — a dirty leftover worktree is pushed to a durable `wip/` ref then removed, but PARKS `worktree-dirty-leftover` if that preserve itself fails (never destroys unsaved work); a leftover local branch whose tip this run cannot vouch for (not an ancestor of `origin/main`, not equal to its own remote tip, not covered by one of this task's own `wip/<id>-*` refs) PARKS `branch-unmerged-leftover` rather than guess (card #385); any of the sweep's own cleanup calls failing (`worktree-remove`, `branch-delete`, `remote-preserve`, `remote-pr-lookup`, `remote-pr-close`, `remote-branch-delete`) PARKS `worktree-cleanup-failed` (`detail.step` names which one — card #455 added the PR-lookup/close steps so a remote branch delete never auto-closes an open PR as an invisible side effect). The claim itself (`npm run board:take`, run last — only once fetch/rev-parse/leftover-sweep/add/npm-ci have all succeeded, since only the fresh worktree gives the npm aliases a product cwd) maps its own exit code: 3 → `claim-lost`, 4 or 5 → `claim-rate-limited` (a GitHub board-claim rate limit — unrelated to the Claude account pool's own cooldowns under Account pool below, despite the similar name), 6 → `claim-finished-worktree`, anything else → `claim-unrecognized-exit`; see `orchestrator/README.md` "WORKTREE, in order — and why claim is last" for the full sequence and exit-code table. Shadow mode and `--dry-run` never reach any of the real-mode reasons above: their own generic scripted-step path (a non-zero exit from the fake `worktree` script, no `git`/`gh`/`npm` ever spawned) PARKS the distinct, generic `worktree-failed` instead. A shadow-mode fixture (`nightlyMainRed`) checked before the real/scripted branch is even chosen PARKS `main-red-refuse-worktree` — the shadow-only sibling of real mode's own `nightly-main-red` above, same concept (nightly says `main` is red), different code path (fixture vs a real read of `nightly/latest.json`). |
| PLAN | `claude -p` | plan + invariants file + runnable check commands + `files_to_change` (action 3.2 — the plan's own declared list of files it will change; a sibling `optional` field of the output contract, not `required`, so its absence never parks — see step-contracts.js); once written, the driver resolves every invariant against the worktree and journals the result as the CHECK baseline (action 1.8) — an invariant that fails to resolve here is logged and excluded from that baseline, never a park, never a re-run of PLAN. **Action 3.1:** real mode only — shadow and `--dry-run` never reuse, checked explicitly as the guard's first condition. On a `retry` after a park, PLAN is skipped entirely (no LLM call) when the plan already on disk from the run that parked is still valid: `origin/main` has not moved since it was written, both plan/invariants files are still present, are regular files, and non-empty, the last PLAN `result` payload is not itself a failure (a transport-failure payload carries no `plan_path`/`invariant_ids`/`check_commands` to hand IMPLEMENT), and the park that ended the previous run was not one of the eight reasons that indict the plan itself (`plan-invalid`, `plan-requires-protected-files`, `diagnose-duplicate-root-cause`, `diagnose-no-new-cause`, `diagnose-budget-exhausted`, `validate-reject-budget-exhausted`, `ci-retry-budget-exhausted`, `implement-stopped`) — every other park reason (transport failures, gate/CI failures, claim losses, merge conflicts) is orthogonal to whether the plan was right. The invariants baseline is still rebuilt fresh against the retried worktree either way; the plan/invariants text and PLAN's own declared `invariant_ids`/`check_commands` are carried forward with `plan_path`/`invariants_path` stamped explicitly (not merely trusted to already be present on the carried-forward payload), journalled as `plan-reused`. See `orchestrator/state-machine.js`'s `decidePlanReuse`. | IMPLEMENT | PARKED (plan invalid/not executable; a transport failure — the call never produced a verdict at all — is `llm-transport-failed:PLAN`, distinct from an invalid plan the model DID produce; **action 3.2, revised by #118 on 2026-09-05:** `plan-requires-protected-files` — `{source: 'files_to_change', matches, declaredFiles, planPath, invariantsPath}` when an entry of the model's own declared `files_to_change` names a protected file. The declaration is read through `park-loop.js`'s `normalizeFindingsPayload`, so **an array and a JSON-encoded string holding one are both declarations** — the string is what the wire sent until #229 (93 of 93 real replies; the previous `Array.isArray` test meant this guard had never once run on a live card), and since #229 (2026-09-13) it sends a real array instead (125 of 125 post-#229 PLAN `result` records, re-measured 2026-09-22), which is why accepting both shapes is what keeps the guard alive rather than a courtesy. The scan happens **after** the plan/invariants files are written and `files-written` is journalled — so a parked card leaves `plan-<issue>.md` on disk for a human to hand to an interactive session (SPO-Pipeline#31's criterion) — and **before** the action-1.8 baseline, which a parking card never pays for. The same scan runs on the action-3.1 reuse path over the carried-forward declaration (`reused: true` in the detail): no plan reaches IMPLEMENT without its declared file list having been read once. `plan_markdown` prose is never scanned — measured at 33% precision (2 false positives against 1 true positive across all 17 real plans) and dropped for that reason. When `files_to_change` is absent, `null`, an object, a bare unparsable string, or a list containing a non-string entry, PLAN does not park and does not fall back to scanning prose — it journals `plan-files-undeclared` (`receivedType`, plus `shape`, the normalizer's own verdict) and proceeds normally; an empty list counts as a clean declaration, not an undeclared one) |
| IMPLEMENT | `claude -p` | write code + tests in the worktree per plan | CHECK | DIAGNOSE (a transport failure is never routed to DIAGNOSE — it PARKS `llm-transport-failed:IMPLEMENT` instead, since there is no answer for DIAGNOSE to diagnose). An empty `files_changed` with a non-empty `stop_reason` — IMPLEMENT stopped on a finding only a human can act on — PARKS `implement-stopped` with that reason instead of paying DIAGNOSE to re-derive it, but only on a first, clean attempt: no DIAGNOSE / VALIDATE-reject / CI retry ever (this run's counters and the journal), a clean tree, HEAD still on the base sha. Otherwise it routes to DIAGNOSE as before, the reason journalled on `empty-implement` (measured: issue-888's later stop was overridden by DIAGNOSE and merged). It is plan-invalidating, so a `retry` re-plans — which a stop on a false precondition (752) did not strictly need, and PLAN is not shown the reason (card 51). A `files_changed` object grouping paths by kind (`{modified: [...], new: [...]}`) is flattened into one list, never read as empty |
| CHECK | script | invariant substring check first (action 1.8: `orchestrator/invariants.js` re-resolves the PLAN-time baseline against the worktree as it now stands — an id that resolved at PLAN and no longer does is the one regression this fails on; one PLAN itself could never resolve was already excluded from the baseline and can never fail here; a missing/unparsable invariants file is journalled, never a failure), pure `fs`, no spawn, run before the three subprocess checks below so a free check never waits behind three that cost a spawn each; then typecheck, lint, `coverage:changed` (≥ 93 % on new/modified lines) | PUSH_PR | DIAGNOSE |
| PUSH_PR | script | commit (a Conventional Commit subject — IMPLEMENT's `commit_subject` when valid, else derived from the card's category and title; `orchestrator/README.md` § PUSH_PR), push, open PR (`Closes #N`, then IMPLEMENT's optional `pr_body_markdown`, then a list of the files changed outside the plan's `files_to_change` — journalled `diff-outside-plan`, reported and never parked on (card 49) — then the stamp and the driver-derived RDO section) — PR precedes gate (CI needs it) | GATE | PARKED — every step of `add`/`commit`/`push`/`pr-create`/`pr-number-unparsed`/`diff-name-only` PARKS the single reason `push-pr-failed`, `detail.step` naming which one (principle 2 above: measured, every corpus occurrence is a logic failure, never a transient network one, so this is never on the bounded-auto-retry allowlist). `commit`'s own exit 1 ("nothing to commit") is not automatically a failure — a clean tree there is resolved against both `origin/<branch>` and `origin/main` to tell a genuinely empty pass (`detail.reason: 'nothing-implemented'`, HEAD sits on `origin/main` — IMPLEMENT never committed anything) from one that already pushed everything at HEAD (`detail.reason: 'nothing-new-to-push'`) from CI_CHECKS' own main-moved merge commit sitting unpushed (skips the commit, falls through to push, journalled `commit-skipped-nothing-staged`) — see the inline comment at `steps/scripted.js`'s `realPushPr` (card #213 vs card #385's main-moved case) for why a HEAD-vs-`origin/main` test alone is the wrong condition. A dirty tree after a failed commit (`detail.dirty: true`) or an unreadable `git status`/`rev-parse` mid-diagnosis both PARK the same `push-pr-failed` rather than let a diagnostic step itself bury the real cause. Shadow mode and `--dry-run` never reach any `detail.step` — their own generic scripted-step failure PARKS the same bare `push-pr-failed` reason with no `step` detail (`state-machine.js`'s `handlePushPr`). Touching `src/shared/rdo-members.ts` (checked against the real diff, not the task's own declared `touchesRdoMembers`, which intake only infers from issue text and can be wrong — card #385) with no `<Fichier>.pas:<Ligne>` citation found in either the catalogue diff or the issue criterion PARKS `rdo-citation-missing` — SPO-WebClient's own `check-pr-rules.js` CI check requires exactly this citation for any RDO-catalogue change; a maintainer resolving this park adds the citation to the PR body or the card criterion and retries. **rdo-symmetry (2026-09-06):** the same real-diff check now ALSO journals `rdo-diff-derived` (`{touched, path}`) unconditionally, both directions — the diff DID or did NOT touch `src/shared/rdo-members.ts` — set on `ctx.task.rdoDiffTouched` for the same process and readable back from the journal after a restart (`task-values.js`'s `lastJournaledRdoDiffTouched`). This is deliberately a SEPARATE field from `touchesRdoMembers`: that one stays a one-way (false→true) promotion because it is also IMPLEMENT's Opus-escalation trigger (step-contracts.js's `shouldEscalate`) and IMPLEMENT re-runs on the same `ctx.task` across every DIAGNOSE/VALIDATE-REJECT/CI retry after this point — lowering it here would silently demote those retries to sonnet. `rdoDiffTouched` is what VALIDATE's `citation-verifier` trigger reads instead (see the VALIDATE row below). **Card #212 C2's resume one-shot:** on a resumed task's first pass through this state ONLY, the `nothing-new-to-push` shape (`HEAD` already equal to `origin/claude-pipe/<id>`) does not park — it journals `commit-skipped-resume` and falls through to the push, exactly once (`ctx.resumePushPending`, cleared at the top of `realPushPr` whichever branch that call takes); `nothing-implemented` is never exempted, and a later pass through this state parks the ordinary way. See "Resume at CHECK" above for the full contract. |
| GATE | script | `npm run gate` (bench job, background wait); read **exit code**: 0 PASS · 1 fail · 2 dirty · 3 worker down · 4 timeout. **Action 4.2:** exit 1 is no longer an unconditional route to DIAGNOSE — the exit code alone conflates three different situations the bench itself distinguishes. Read the bench's own verdict for HEAD (`<spoBenchDir>/verdicts/<sha>.json`, the same file CI_CHECKS reads below for its own `main`-moved test): the bench merges `origin/main` into the checkout itself before building (`worker.ts`'s `prepareRef`), so `baseMain` is absent from that file precisely when the branch no longer merges cleanly with `origin/main` — measured over all 375 `ref`-type verdicts `npm run gate` submits: 359/359 PASS carry `baseMain`, 14/16 FAIL do; the missing 2 are exactly the main-moved conflicts (confirmed end to end on card #439 / commit `379ada60`, which burned all 3 DIAGNOSE attempts and parked `diagnose-budget-exhausted` before a `retry` — a fresh worktree off the new `main` — reached DONE in 19 minutes). No verdict file **on disk** means the run is *non-attesting* (`worker.ts`'s `NON_ATTESTING = {DIRTY, ENVIRONMENT, ABANDONED}` is deliberately never written to `verdicts/`, yet `cli.ts`'s `wait()` still maps all three to exit 1) — nothing was learned about the code, so it parks rather than spending a DIAGNOSE call on it. **Action B3.4:** before falling back to the undifferentiated park below, `realGate` now asks the job's own `<spoBenchDir>/done/<jobId>.json` (`SPO-WebClient/src/e2e/bench/job.ts`'s `JobReport`, written unconditionally by `Spool.writeReport` for every verdict, no `ref`-type or `NON_ATTESTING` restriction) which of the four non-attesting-shaped verdicts this actually was — `parseGateJobId` reads the job id off `cli.ts`'s own `` `job ${id} queued` `` line, already captured in `r.stdout`/`gate.log`; `readGateDoneReport` then reads and shape-guards that file (missing → `'missing'`, a read error other than ENOENT → `'unreadable'`, JSON that parses to `null`/a string/an array/anything with no non-empty `verdict` field → `'malformed'`/`'wrong-shape'`/`'no-verdict-field'` — none of these are ever read as a verdict, and the fallback below runs exactly as if this read did not exist). When a well-shaped report IS found: `verdict: 'ENVIRONMENT'` → PARKED `gate-environment` (measured against the live bench 2026-09-03: 7 of the last 29 completed `done/` jobs, all "git fetch failed while fetching \<sha\>" — this is the corroborated common case, not a hypothetical); `verdict: 'DIRTY'` → PARKED `gate-worker-dirty-checkout` (the WORKER's own shared `ref` checkout found dirty after `prepareRef` — never the session's own tree, which `gate-dirty-tree` below already refused at exit 2 before a job was ever deposited; a different fact from a different place, deliberately not sharing that name); `verdict: 'ABANDONED'` → PARKED `gate-abandoned` (the depositing session's pid was gone before the job started); `verdict: 'INTERRUPTED'` → PARKED `gate-interrupted` (the worker died mid-job; `recoverInterrupted` wrote this on restart, the body may have partially run). Each park's `detail` carries `headSha`, `jobId`, and the job report's own human-readable `detail` text (`jobDetail`) alongside the reason -- plus, since card #211's fix-pass, `exitFrom` (both on the `ParkSignal` detail and the reason's own journal event), pinned at `1` for this real exit-1 path so it is never confusable with the value `3` the exit-3 recovery path (below) carries when it reaches these SAME four reasons off the SAME `routeGateNonAttestingReport` helper. A report present but carrying any OTHER verdict (PASS/LEASED contradict exit 1 at all; FAIL/BLOCKED/STALE are already written to `verdicts/<sha>.json` and would not have reached this branch) is an inconsistency between the two files this code does not try to explain — falls through to `gate-non-attesting` unchanged, same as an unavailable read. Every `gate-job-report-read` attempt (found or not) is journalled with `jobId`/`donePath`/`skipped`/`verdict`, so a maintainer can always see whether the richer read was tried and why it did or did not apply. **Action B3.4, STALE:** a verdict of `STALE` ("the tree changed between deposit and the end of the run") already IS written to `verdicts/<sha>.json` (not in `NON_ATTESTING`) but used to fall through to the generic DIAGNOSE branch below, spending a judge call on a body verdict that no longer describes any tree that exists — it now parks `gate-stale` instead, best-effort enriched with the same `done/<jobId>.json` read's `detail` text when available (never required — `STALE` is already known from `verdicts/<sha>.json` alone). A FAIL that DOES carry `baseMain` failed with `origin/main` already merged in by the bench; that is a real failure and still routes to DIAGNOSE, unchanged. A FAIL *without* `baseMain` fetches `origin/main` and attempts the same local merge CI_CHECKS' own `main`-moved path performs (below) — clean → back to CHECK and re-gate; conflict → `merge --abort` then PARKED. The plan's own intersection test is deliberately not implemented for this path: with no `baseMain` there is nothing to intersect against. **Action B2.3:** exit 0 is no longer read as proof on its own either. `verdicts/<sha>.json` now carries `live` (`LiveAttestation` — `{status:'ran', flows}` · `{status:'skipped', why, required}` · `{status:'unknown', why}`, SPO-WebClient's `src/e2e/bench/verdict.ts`) and `staticProof`; `realGate` resolves HEAD and reads that verdict on EVERY exit, not only exit 1. `live.status === 'skipped'` with a non-empty `required` means routing named flows the live stage never drove — the bench-side fix (`verify-gate.js`) already fails that shape closed (`BLOCKED`, never `PASS`), so seeing it here at all means a worker binary that predates the fix, or a verdict reused/copied forward from one; either way this is the pipeline's own defence in depth, and reaching it means something is wrong that a human should see, not something a retry can fix (WORKTREE→PLAN→IMPLEMENT→GATE again just asks the same worker the same question) — not on `TRANSIENT_RETRY_REASONS`. Absence must stay safe: no verdict file, a verdict with no `live` key at all (515 of 517 real files on this machine as of this action — every verdict written before the field existed), or `live.status === 'unknown'` are all the identical fact — "nothing on file proves the live stage ran" — and none may be read as proof either way; parking on any of them would stall the whole backlog on old data, so they route exactly as before (journalled `gate-live-unknown`, `detail.verdictExists` distinguishing "no file for this sha" from "the file has no opinion"). `live.status === 'skipped'` with `required: []` (the common, legitimate case — 186 of 215 corpus skips, doc/bench-audit-2026-09-02.md) and `live.status === 'ran'` both proceed to CI_CHECKS unchanged. The SAME `liveRoutedButNotDriven` check also runs on the exit-1 path below against `verdict.verdict === 'BLOCKED'` — `cli.ts`'s `wait()` collapses every non-PASS/LEASED verdict to that one exit code, so a BLOCKED gate (the live stage refused to run, not a code failure) used to fall straight through to DIAGNOSE and ask a judge to diagnose a defect that was never observed; it now parks instead, on the same principle `gate-merge-refused` (card #212, renamed from `main-moved-conflict`) already established for a structurally similar "not the code's fault" situation — but NOT under one shared reason for every `BLOCKED`. Adversarial verification found `BLOCKED` has (at least) four producers in SPO-WebClient, and only two of them (`verify-gate.js`'s routed-but-undriven-diff check, and a pre-fix/reused verdict reaching the exit-0 path above) are the "routing required a live drive that never happened" fact `gate-live-not-driven`'s name asserts. `run.ts`'s `runLive` returning BLOCKED because the world lock refused the run (dirty, or another live run already in flight — single-flight, `world-lock.ts`) or, until 2026-09-03 also a live-run rate limiter that could never fire (`minIntervalMinutes: 0`, `maxRunsPerDay: 1000`) -- action B3.5 (SPO-WebClient PR #646) deleted that producer outright rather than tune it, so the world lock is now the only one, maps to `live.status === 'unknown'` (`liveAttestationFrom`, worker.ts) — the IDENTICAL value the exit-0 path above reads as "nothing proven either way" and refuses to park on. So the exit-1 arm now keys on the SAME `liveRoutedButNotDriven(verdict.live)` fact the exit-0 path uses, not the bare verdict string: a genuinely routed-but-undriven BLOCKED still parks `gate-live-not-driven`; every other BLOCKED (world lock, or `verify-gate.js`'s capability-question variant, where `required` can be empty and nothing was actually routed) parks under its own reason, `gate-live-blocked` — put on `TRANSIENT_RETRY_REASONS` (unlike `gate-live-not-driven`) because the operational case that motivates it, a maintainer's `gate:local --live` holding the single-flight lock, clears itself within minutes; see that reason's own entry in the Action-4.4 allowlist above for the bounded-cost argument on the genuinely-dirty case. Both reasons' `ParkSignal` detail now carries `exitFrom` (0 or 1) as well as the journal event, so the park comment itself says which path arrived without a maintainer having to open `journal.jsonl`. | CI_CHECKS | exit 1 with a verdict carrying `baseMain` → DIAGNOSE (unchanged) · exit 1 and the lookup itself failed — `rev-parse HEAD` non-zero, or exit 0 with stdout that is not an object name (a failing `git rev-parse` prints the ref name itself, action 4.1's measurement), or a verdict file that is present but does not parse — → DIAGNOSE, journalled `gate-verdict-unreadable`, never a park: a failed diagnostic must not become the thing that parks the card · exit 1, no verdict file on disk → PARKED (`gate-non-attesting`, detail carries `verdictDirExists` so a misconfigured `spoBenchDir` is one look) · exit 1, FAIL without `baseMain` — a bench merge REFUSAL: `worker.ts`'s `prepareRef` never got past checking whether the branch merges with `origin/main`, so no flow was ever tested, and the pipeline's own local `git merge origin/main` then hits the identical conflict → PARKED (`gate-merge-refused`, **card #212**, renamed from `main-moved-conflict` — measured over the real corpus, this throw is the ONLY producer of that name, 11/11 real parks, and every one was this same refusal; `main-moved-conflict` is no longer registered in `TERMINAL_PARK_REASONS` (test/park-reason-partition.test.js's own "NO DEAD ENTRIES" check forbids a member with no live producer) but stays in `console/plain-language.js`'s `PARK_REASONS` text, unproducing, so the dashboard can still render old journals that carried it; `detail` carries `headSha`, `mergeExit`, `jobId` (from `parseGateJobId(stdout)`), `refusalConfirmed` (whether `done/<jobId>.json`'s own `.detail` matches `worker.ts`'s "does not merge cleanly" literal — confirms the NAME only, the route is already fixed by the exit-1 + FAIL + no-baseMain facts), `testsRan: false`, `gatePassedOnSha: false`. **`gate-merge-refused` is TERMINAL** (on `TERMINAL_PARK_REASONS`, not `TRANSIENT_RETRY_REASONS` — pinned in `test/transient-retry.test.js`): a retry restarts the card at INTAKE and re-burns PLAN+IMPLEMENT+VALIDATE (~322k tokens p50) replacing the PR, and under spine contention the fresh attempt can conflict again; manual retries after a refusal DID reach DONE 3/3 times tried (#439, #510, #522), which argues for transient, but the driver keeps this a human decision rather than spending real LLM cost on an automatic retry loop — same class as `main-moved-conflict` before this rename, so the classification itself does not change) · main-moved re-gates already used this task's `mainMovedRegateBudget` (config.js, default 1 — **action 6.5**, see below) → PARKED (`main-moved-twice`, counter shared with CI_CHECKS; **card #212**: `testsRan: false` added to the detail when this throw is reached through GATE's own refusal branch above) · nightly says `main` is red at the fetched sha → PARKED (`main-red-no-merge`, guard shared with CI_CHECKS and MERGE's own regate; **card #212**: `testsRan: false` added when reached through GATE's own refusal branch, via `guardNightlyRed`'s own `extraDetail` parameter) · `liveRoutedButNotDriven(verdict.live)` true — `verdict.verdict === 'BLOCKED'` on exit 1, or `live.status === 'skipped'` with a non-empty `required` on exit 0 → PARKED `gate-live-not-driven` (action B2.3, one reason shared by both exit paths — `detail` carries `headSha`, `exitFrom`, `why`, `required`; not on `TRANSIENT_RETRY_REASONS`) · exit 1, `verdict.verdict === 'BLOCKED'` but NOT `liveRoutedButNotDriven` (the world lock refused the run, or before B3.5 deleted it, a rate limit that could never fire) → PARKED `gate-live-blocked` (`detail` carries `headSha`, `exitFrom: 1`, `liveStatus`, `why`; IS on `TRANSIENT_RETRY_REASONS` — see the Action-4.4 allowlist above) · 2/3 (**action B3.4, naming only — the route stays exit-code-only, see Principle 1's own exception above**): unlike exit 1, no job id can ever exist yet for most of exit 2/3's own sub-causes — `scripts/bench-gate.sh`'s two pre-flight refusals and `cli.ts` `submit()`'s WORKER-DOWN/duplicate-deposit checks all run BEFORE a job is deposited, so there is nothing to poll for. The one exit-3 case where a job WAS deposited ("WORKER DIED while pending") is different: a job id DOES exist (printed on stdout before the wait), and `done/<jobId>.json` may simply not have landed YET when the CLI's own liveness read declares the worker dead — card #211's fix-pass (see above) polls for it rather than assuming it can never come. `realGate` still matches the literal diagnostic text `scripts/bench-gate.sh` / `scripts/bench-submit.sh` / `cli.ts` already print to stderr (captured in `r.stderr`, unconditionally journalled to `gate.log` regardless of this match): exit 2, `/NOT PUSHED/` → PARKED `gate-not-pushed` (the head sha is not on `origin` yet — `scripts/bench-gate.sh`'s own check, before it ever execs into `bench-submit.sh`); `/already has job/` → PARKED `gate-duplicate-job` (`job.ts`'s `DuplicateJobError` — this worktree+ref already has an earlier deposit queued); anything else (the common case, `scripts/bench-gate.sh`'s own "DIRTY TREE" message — the session's own tree has uncommitted/untracked changes) → PARKED `gate-dirty-tree`, unchanged fallback, same name as before this action. Exit 3, `/bench client not built/` → PARKED `gate-worker-not-built` (`scripts/bench-submit.sh`: the client's `dist/e2e/bench/cli.js` was never built — needs `npm run build:e2e`, not a worker restart); `/WORKER DIED/` → PARKED `gate-worker-died-midjob` (`cli.ts` `wait()`'s own liveness read declared the worker dead while THIS job was already queued or running — see card #211's fix-pass just below for why that read is not proof of death, and what the pipeline now does before trusting it; the queue is preserved either way, so restarting the worker resumes it); **Action #211, fix-pass:** before parking under this text match, when a job id was ALSO printed (`parseGateJobId(r.stdout)`, the same anchor `readGateDoneReport` already relies on — the no-job-id sub-cases just above/below, `gate-worker-not-built`/`gate-worker-down`, never had a job to poll for and are unaffected, unchanged, and never sleep), this text alone is the gate CLI's OWN liveness read disagreeing with the worker's actual state, not proof of death — measured over the real corpus, 7 of 7 `gate-worker-died-midjob` parks (2026-09-11/12) were a LIVE worker that went on to PASS that exact job (`verdict.jobId === the job id printed on stdout`) 4.3–414.1s later, and 0 genuine worker deaths (`gate-worker-down`/`gate-interrupted`) occur anywhere in the same corpus. `recoverFromGateWorkerDied` polls `<spoBenchDir>/done/<jobId>.json` (`readGateDoneReport`, reused unchanged) every `config.gateDiedRecoveryPollIntervalMs` (default 5000ms) up to `config.gateDiedRecoveryMaxPolls` times (default 90, 450s total — the smallest round bound that saves all 7 of 7 measured gaps: 4.3, 15.2, 56.8, 68.3, 145.5, 203.4, 414.1s; 300s/60 polls would have saved only 6 of 7), checking once BEFORE the first sleep. A report naming a NON-attesting verdict (ENVIRONMENT/DIRTY/ABANDONED/INTERRUPTED — worker.ts never writes `verdicts/` for any of these four) routes IMMEDIATELY through the SAME per-verdict logic exit 1 uses off this same file (`routeGateNonAttestingReport`, shared with the exit-1 `if (!verdict)` branch above), at `exitFrom: 3` — never waiting for a `verdicts/` entry that can never arrive, and never a terminal `gate-worker-died-midjob` for a genuine death (`recoverInterrupted`'s own INTERRUPTED report reaches `gate-interrupted`, already auto-retryable, exactly as a real exit 1 would). A report naming an ATTESTING verdict (PASS/FAIL/BLOCKED/STALE) means a `verdicts/<headSha>.json` entry is coming but may not have LANDED yet — worker.ts writes the two files roughly 7ms apart — so that case does not park on the first poll either; it keeps polling, within the SAME remaining bound, until the entry lands or the bound runs out. Once found, freshness still gates whether it is trusted: `verdict.jobId === jobId`, since a same-sha verdict from an EARLIER job is real (23 of 26 multi-job shas in the corpus never had their verdicts file rewritten by the later job); a mismatch, a missing `jobId`, no file, or an unreadable HEAD are all treated as "not fresh yet" and also keep polling. A fresh `PASS` routes through `acceptPassedGate` — THE SAME acceptance checks a real exit-0 gate uses above (`gate-live-unknown`/`gate-live-not-driven`/CI_CHECKS), with `exitFrom: 3` wherever the exit-0 path would carry `exitFrom: 0`; a fresh non-PASS verdict routes through `routeGateVerdict` — THE SAME BLOCKED/FAIL-without-`baseMain`/STALE/DIAGNOSE logic a real exit-1 gate uses below, also with `exitFrom: 3`. Either route appends the done report's own `verdict`/`detail` to `journal/<id>/gate.log`, so a DIAGNOSE reached through a recovered FAIL sees WHY, not just that `npm run gate` once printed "WORKER DIED". No report within the bound, or an attesting report whose verdict never became fresh, still parks `gate-worker-died-midjob` exactly as before this action — **this reason stays terminal, unchanged, no new park reason**. Fix-pass defect 4: the park `detail` deliberately does NOT carry the raw `jobId` or the raw `workerDiedReason` (both go on the `gate-died-recovery` journal event instead) — only `exit: 3`, `recoveryPolls`, and `workerDiedReason` with every run of digits collapsed to a literal `N` (e.g. "heartbeat is N s old"), so `countRepeatedParks`' `JSON.stringify(detail)` fingerprint can actually recognise a repeat of this reason across two different job deposits — unnormalized, a fresh job id and the worker's own live heartbeat-age text made every occurrence fingerprint uniquely, silently killing the repeat-park warning for exactly this reason. Journalled `gate-died-recovery-start` (`jobId`, `maxPolls`, `pollIntervalMs`) when the wait begins and `gate-died-recovery` (`jobId`, `workerDiedReason`, `polls`, `outcome: 'pass'|'fail'|'no-report'|'stale-verdict'`) on the terminal PASS/non-PASS-attesting/bound-exhausted steps -- the four non-attesting routes journal their OWN specific event (`gate-environment` etc.) instead, so nothing here duplicates it. Fix-pass round 2, defect 2: a done report naming neither an attesting verdict NOR one of those four (`LEASED` flatly contradicts exit 3; so would any future verdict this file does not recognise) is unresolvable by waiting -- `done/<jobId>.json` is immutable once written -- so it falls back to `outcome: 'stale-verdict'` and the terminal park immediately, logged exactly once, never by looping back to re-poll and re-spawn `git rev-parse` on a report whose shape can never change (measured before this fix: 182 spawns at the default 90-poll bound). This is also the first `await` `realGate` ever places inside its own invocation — every real command before it runs through the BLOCKING `spawnSync`, which never yields the event loop, so GATE never needed its own `stepDeadlineMsByState` entry (the generic 120s ceiling was harmless because the timer could never fire mid-spawn). Arming a real `await` here would let that expired 120s timer fire retroactively and re-run `npm run gate` from scratch while the abandoned first call kept running (`deadline.js`'s `callWithDeadline` does not cancel the loser) — already measured happening in production on MERGE (card #587, a separate, pre-existing defect this action did not touch: `probeMergeability`'s own 750ms `pollSleep` after two 9-minute `pr:wait` spawns — **card #224** closed it the same way, giving MERGE its own derived `stepDeadlineMsByState.MERGE` built from every spawn timeout on every path `realMerge` can take, `spawnStep`'s retry-once included; see `config.js`'s own `MERGE_STEP_DEADLINE_MS` comment for the enumeration). So GATE now carries a derived `stepDeadlineMsByState.GATE` = `commandTimeoutsMs['npm-gate']` (7,800,000ms) + `config.gateDiedRecoveryMaxMs` (450,000ms) + one ordinary step deadline of margin (120,000ms) = 8,370,000ms — the same "poll budget plus one step deadline of margin" shape CI_CHECKS' own entry uses; it does not depend on `workers` (K), so it needs no entry in daemon.js's `--workers` recompute (it is inherited, like CI_CHECKS, through that block's own spread of `defaultConfig.stepDeadlineMsByState`). The `gateDiedRecoveryMaxPolls` count itself is guarded against a non-finite, non-positive-integer, or oversized override (`boundedPositiveIntFromEnv`, config.js) — a bad value falls back to the documented default of 90, so the derived GATE deadline can never exceed Node's own `2^31 - 1` ms ceiling on a single timer delay (past which Node silently CLAMPS the delay to 1ms rather than rejecting it, re-arming `callWithDeadline`'s timer to fire almost instantly and reproducing the exact hazard this deadline exists to close). anything else (the common case, `cli.ts` `submit()`'s own "WORKER DOWN" message — the worker daemon was already not running at deposit time) → PARKED `gate-worker-down`, unchanged fallback. **Retry policy, corrected in round 2:** the first cut of this action reported the whole nine-reason split as "naming correctness, not retry policy" and put none of them on `TRANSIENT_RETRY_REASONS` — but `DIRTY`/`ENVIRONMENT`/`ABANDONED`/`INTERRUPTED` previously shared ONE name, `gate-non-attesting`, and that name auto-retries; splitting it without carrying the retry marking along silently turned the commonest non-PASS bench outcome (`gate-environment`, 7 of 29 real completed jobs, all "git fetch failed") from auto-retried into terminal/human-only. Restored per reason, not blanket: `gate-environment` → **ADD** (a failed fetch is a fact about this worker's network at this moment, retrying asks the same bench the same question again, exactly `gate-non-attesting`'s own header comment's transient class); `gate-interrupted` → **ADD** (the worker restarted mid-job — precisely what `realFinish`'s bench reinstall does to a sibling card's in-flight gate, and the FINISH design already treats this as recovering and transient-retryable); `gate-abandoned` → **ADD** (the depositing session's pid was gone at start — a fact about that moment's process table, a fresh deposit has a live pid); `gate-stale` → **ADD** (newly a park at all under this action, so there is no PRIOR retry behaviour to preserve, but `verify-gate.js`'s own STALE detail text says the fix is literally "resubmit" and nothing about the code was implicated — terminal would waste a human's attention on a race a second gate run most likely clears on its own). `gate-worker-dirty-checkout` → **left OFF, a deliberate narrowing** versus the pre-split behaviour (DIRTY used to share `gate-non-attesting`'s auto-retry): `prepareRef` already runs the worker's shared `ref` checkout through `reset --hard` + `clean -fd` before every job (doc/bench-audit-2026-09-02.md's D5), so a DIRTY verdict reached AFTER that automatic cleanup already ran is not the ordinary case reset+clean exists to fix — it is what SURVIVES that cycle (git-ignored artifacts `clean -fd` does not touch, a stray process still holding a file, a permission problem, manual interference with a host resource shared across every card's gate). A bare retry re-runs the identical reset+clean on the identical checkout with no structural reason to expect a different answer, the same "real spend burned per attempt, for as long as the condition stands" argument `gate-non-attesting`'s own `verdictDirExists === false` carve-out already makes below — and because the checkout is shared, once genuinely stuck it blocks every card's gate, not only this one's, until a human clears it by hand. All four are pinned in `test/transient-retry.test.js`, one test per reason, that fails if the classification flips either direction. None of the four exit-2/3 reasons (`gate-not-pushed`, `gate-duplicate-job`, `gate-worker-not-built`, `gate-worker-died-midjob`) are added — neither `gate-dirty-tree` nor `gate-worker-down`, the reasons they refine, was ever on `TRANSIENT_RETRY_REASONS`, so leaving their children off it is the status quo continuing, not a new decision; also pinned, one test per reason. · 4 → PARKED `gate-timeout` · any other exit code (`npm run gate` returning something this table does not know about) → PARKED `gate-unrecognized-exit`, the catch-all this row falls back to rather than silently treating an unrecognized exit as one of the four known ones |
| CI_CHECKS | script | Two checks the bench does not make. (0) Before either: a bounded **in-flight wait** (action 1.7) — a check-run with `conclusion: null` (still running) or zero check-runs at all (CI hasn't registered anything yet) is never read as green; re-poll `gh api .../check-runs` up to `ciChecksMaxPolls` times (default 30), sleeping `ciChecksPollIntervalMs` between polls (default 20000ms, injectable in tests; ~10 min total, deliberately uncalibrated — see config.js), journaling each observation, until nothing is in flight. *(2026-08-30 audit: 8/12 measured "green" events had `claude review` still in progress.)* (a) `gh pr checks <n>` once nothing is in flight — CI normally concluded while the gate queued; on red, map the failing check **by name**: `Coverage of changed lines` → IMPLEMENT · `Lint` → IMPLEMENT · `PR rules (coverage ratchet, RDO citation)` (`ci-cause-table.js`'s `classifyCiFailure`, exact step-name match only, never a substring or prefix) → PARKED `pr-rules-needs-approval` · anything else, or no step name recovered at all (a non-zero `gh api .../actions/jobs/<id>`, an unparsable body, a job whose steps all passed, or a legacy bare-string shadow fixture) → DIAGNOSE, deliberately, per `ci-cause-table.js`'s own header: a step name this table does not recognize must degrade to "ask a judge", never to a silent retry or a silent park. **SPO-Pipeline#290, the flake re-run:** before a `Coverage of changed lines` failure is mapped — on a pull request that step runs the whole Jest suite, so a flaky test anywhere fails it — the failed job is re-run **once** (`gh api -X POST .../actions/jobs/<id>/rerun`) when all of these hold: no `ci-flake-rerun` event exists yet for this `headSha`; the bench verdict for `headSha` is `PASS`; the job's log (`gh api .../actions/jobs/<id>/logs`) yields at least one `FAIL <path>` under Jest's "Summary of all failing tests"; and none of those paths is in `git diff --name-only origin/main...HEAD`. The re-run is journalled `ci-flake-rerun` (`headSha`, `jobId`, `failingFiles`) and CI_CHECKS polls again, on the same `ciChecksMaxPolls` budget as the first wait (never a fresh one, so the derived CI_CHECKS deadline still holds), counting a check-run that still carries the re-run job's id as in flight. Green → on to (b) as usual; a second failure takes the mapping above unchanged. Any condition not met, a log or diff that cannot be read, or a refused POST → `ci-flake-rerun-skipped` with its `reason`, and the mapping above, unchanged. The table itself is not widened, a bench `PASS` never stands in for a CI pass, and the journal — not memory — is the once-per-sha guard, so a daemon restart cannot grant a second re-run. (b) the `main`-moved test: intersect `git diff --name-only <baseMain>..origin/main` with the branch's changed files — non-empty → merge `origin/main`, back to CHECK and re-gate; while the nightly says `main` is red, never merge from it → PARKED. *(Added in v1.1: 5/16 measured sessions reached a green gate and could not merge — every one improvised CI forensics; 4/16 needed the `main`-moved branch.)* **Action 4.2:** the `mainMoveUsed` counter and the nightly-red guard are the exact same shared state GATE's own main-moved path (above) uses — a move already spent from either state blocks the other, and a nightly-red main blocks a merge attempted from either. **Action 6.5:** the re-gate is now allowed up to `config.mainMovedRegateBudget` times per task (default **1** — today's "once" behaviour, unchanged), not a hardcoded once; the (n+1)th move → PARKED (`main-moved-twice`, the name kept for continuity even past a raised budget — it names the event, not a literal second occurrence). This is a settled decision, not a re-derivable default, but the gap it accepts is wider than "disjoint files, interacting behaviour": the intersection test runs once per CI_CHECKS **visit** (`steps/scripted.js`'s `realCiChecks`) — a task that loops DIAGNOSE→IMPLEMENT→CHECK→PUSH_PR→GATE→CI_CHECKS, or re-gates after its own main-moved merge, reaches it again each time; nothing re-ran it at VALIDATE or MERGE until **SPO-Pipeline#84** closed one specific slice of that window (below), so a sibling that merges into `origin/main` **after** this task's own CI_CHECKS pass — even one whose files DO intersect this branch's — went un-re-tested before MERGE tried to land this one too. `realCiChecks` itself still never `git fetch`es — four functions in this file spawn a `git fetch` (`fastForwardMainAndInstall`, `realWorktree`, `realGate` on its no-`baseMain` retry path, `realFinish`), and #84's re-gate (`regateAfterNonLandingUnguarded`, called from `realMerge`'s `regateAfterNonLanding`) added a fifth — so the one-shot intersection test CI_CHECKS itself runs can still be judging a stale `origin/main` at CI_CHECKS time, even though MERGE now re-fetches before it re-tests. **Observed, not merely modeled**: a 2026-09-02 K=2 `parallel-doc-log` recette run hit exactly this — two cards touching the same file, the second PR's CI_CHECKS intersection test passed clean, the first PR then merged and moved `main` under it, and GitHub's merge queue itself caught the resulting conflict ("This branch has conflicts that must be resolved") — and at the time, nothing routed that back to CHECK/re-gate the way GATE's and CI_CHECKS' own main-moved paths do; `pr:wait` just polled exit 4 until its bound. **SPO-Pipeline#85** narrowed, but did not close, the "parks on a symptom" gap this paragraph originally described in full: MERGE now asks GitHub itself before parking (see the MERGE row below), so a case shaped exactly like this one now usually surfaces as a real cause (`merge-behind-base`, `merge-conflict`, …) rather than the bare `merge-queue-not-landing` symptom — but only when GitHub's own read is itself a definite answer; `merge-queue-not-landing` still fires, honestly demoted to "GitHub had no answer", whenever it is not. **#84 itself is now fixed** (commit `2a316af`): once GitHub's probe (`#85`'s `probeMergeability`) attests a `merge-conflict` or `merge-behind-base` cause, `realMerge` re-runs this exact intersection test — `baseMain` from HEAD's bench verdict, a fresh `git fetch origin main`, `<baseMain>..origin/main` intersected with `origin/main...HEAD` — and on a non-empty intersection merges `origin/main` and routes back to CHECK instead of parking, under the same shared `mainMovedRegateBudget` and nightly-red guard GATE/CI_CHECKS already spend from. What remains open, deliberately: the re-gate is CONDITIONAL on GitHub naming the cause as one of those two, so a non-landing PR whose cause GitHub's probe cannot resolve to a definite answer still parks unenriched on `merge-queue-not-landing`, exactly as before; and the re-gate only ever re-runs the FILE-INTERSECTION test, so the wider gap this row and config.js's own `mainMovedRegateBudget` comment describe — disjoint files, interacting behaviour, which the intersection test was never built to catch — is entirely untouched by #84 and still has only the nightly as its backstop. See the MERGE row below for the mechanism, and its own header comment in `steps/scripted.js` (`regateAfterNonLanding`) for the full rationale. The `mainMovedRegateBudget` default itself is still a model, not a measurement of *this* gap (see config.js's own comment for the Poisson derivation over the measured 39-52% GATE-to-merge exposure and the measured 10.5% file-overlap rate across the 18 merged pipeline PRs, and doc/remediation-progress.md's "6.5's counter" section for the corpus it rests on) — but that corpus predates K>1 ever running for real, which chantier 6 made possible; the case above is the first observed instance of *this gap* since — not a `main-moved` event itself: the whole finding is that the main-moved path never fired (the intersection test passed clean), so no `main-moved-merge`/`main-moved-twice` event exists in any corpus for it. | VALIDATE | per cause table, or still in flight after the bounded wait → PARKED (`ci-checks-still-running`, `detail` carries `attempts`/`totalRuns`/`pendingRuns`) · the real path's own `git -C <worktree> rev-parse <ref>` (resolving HEAD before reading check-runs, and `origin/main` inside the main-moved test) failing → PARKED `ci-checks-rev-parse-failed` (`detail.ref` names which one) · `gh api .../commits/<sha>/check-runs` itself exiting non-zero → PARKED `ci-checks-read-failed` (a malformed-but-200 JSON body is not this reason — it degrades to an empty check list instead, never a park) · the main-moved path's own `git merge origin/main` exiting non-zero → PARKED `main-moved-merge-failed` (distinct from GATE's own `main-moved-conflict`: this merge runs directly in the worktree with no `merge --abort` cleanup step, since CI_CHECKS reaches it only after a green gate, not mid-DIAGNOSE) |
| DIAGNOSE | `claude -p` | one-line root cause from diff + gate log + ledger (diff.patch and, when entered from GATE, gate.log are really generated on entry — `steps/scripted.js`'s `prepareJudgeInputs`/`realGate`; gate.log is required only when this DIAGNOSE was entered from GATE, never from a CHECK failure or an empty IMPLEMENT, where no gate has run yet); append to ledger. The reply is one of two mutually-exclusive shapes: `root_cause: "<string>"` (+ category/suggested_fix), or the honest `root_cause: null` (+ a one-line `reason`) meaning "no cause beyond what the ledger already has" — a present-but-null `root_cause` satisfies the output contract, it is never treated as a missing answer. **Action (2026-09-09 remediation).** Measured 2026-09-09 against `~/.spo-state/journal` (the daemon's own production corpus): **3 of 44** DIAGNOSE `result` events (across the **16** cards that have any) serialize the model's WHOLE reply contract, itself JSON-encoded, into the `root_cause` string instead of a bare sentence — `root_cause: '{"root_cause": "...", "category": "...", "suggested_fix": "..."}'`. The three: issue-385 attempt 1 (183 ch, nested `root_cause: null`), issue-516 attempt 1 (1359 ch), issue-654 attempt 1 (1267 ch, three genuinely distinct causes once unwrapped — this task's own outcome was not itself changed by the fix, only its downstream visibility). `handleDiagnose` (`state-machine.js`) now unwraps exactly one level of that shape (`unwrapNestedDiagnoseContract`) before the duplicate guard, the null-cause park, the ledger line, or IMPLEMENT's own derivation ever see the value — the recovered sentence, category and suggested_fix are used exactly as if the model had returned them flat, and a nested `root_cause: null` reaches the same `diagnose-no-new-cause` park a direct one does; an object-shaped nested cause (neither a string nor `null`) is deliberately left un-unwrapped (shape `nested-contract-nonscalar`) rather than let the duplicate guard compare object identity. The recovered cause is also collapsed to one line (every run of whitespace, including embedded newlines, to a single space) before it reaches the ledger — the wire contract already specifies `root_cause` as one line, so this is fidelity to that contract, not a new rule; the flat path is untouched. An ordinary prose cause, including one that happens to start with a brace-like character that is not actually JSON, is never reinterpreted (unwrapping is conservative and exactly one level deep). Every detection is journalled `diagnose-nested-contract` (`{attempt, shape, recoveredCategory, recoveredSuggestedFix, nestedRootCauseNull}`), task-scoped and, so incidence is a one-grep answer on `daemon.jsonl` too, daemon-scoped with `{id, attempt, shape}`. | IMPLEMENT (retry) | PARKED (3 attempts, same root cause twice → `diagnose-duplicate-root-cause`; the model explicitly has no new cause → `diagnose-no-new-cause`; a transport failure — no verdict produced at all — → `llm-transport-failed:DIAGNOSE`, never fabricated as a cause; or gate.log required but unproducible when entered from GATE → `judge-inputs-missing`) |
| VALIDATE | `claude -p` ×1–2 | `citation-verifier` (only when the REAL diff touches the RDO catalogue **and** it produced citations — 2026-09-04 interim narrowing: the trigger `task.touchesRdoMembers` is an intake guess from the card's text while `citations` come from the diff at PUSH_PR, and when the guess is a false positive the step used to be invoked with an empty placeholder and park `prompt-missing-placeholder:citations` on an otherwise CI-green card — measured on #489 and #385. The skip journals `citation-verifier-skipped-no-citations`; it is a real signal, either intake over-flagged or an RDO change shipped uncited. **rdo-symmetry (2026-09-06):** the trigger itself was replaced — it now resolves `ctx.task.rdoDiffTouched` (in-memory, same process) then `task-values.js`'s `lastJournaledRdoDiffTouched` (restart-durable, reading PUSH_PR's own `rdo-diff-derived` event) then, only when PUSH_PR has not run yet at all, falls back to `Boolean(task.touchesRdoMembers)` — `state-machine.js`'s `resolveRdoDiffTouched`, strictly boolean at each step (a stray string/number never coerces past a real value). When the resolved diff truth is `false`, the skip is now its own distinct event, `citation-verifier-skipped-not-rdo-diff` (`{intakeGuess}`), instead of being indistinguishable from the no-citations skip above — the two skips answer different questions: "intake over-flagged" vs "RDO change shipped uncited") then `change-validator`; JSON verdicts. Its declared `diff.patch` is really generated on entry (`prepareJudgeInputs`) — always producible post-PUSH_PR. citation-verifier is fail-closed: a verifier that cannot render a verdict (transport error, timeout, malformed payload) parks the card — it never passes by default. A REJECT's `reasons`/`findings` are appended to the ledger and threaded into the next IMPLEMENT's `diagnosis` placeholder (action 1.6), attributed as a VALIDATE rejection distinct from a DIAGNOSE finding — if both exist for a task, the most recently journaled one leads and the other stays visible for context. Card #174: validate-change.md requires REJECT to carry "exactly one" `reasons` entry; a REJECT reaching handleValidate's REJECT branch with zero usable reasons (key absent, `null`, `[]`, `"[]"`, or an array of non-string entries) or more than one journals `reject-reasons-contract-violation` (`{attempt, reasonsKeyPresent, reasonsShape, usableCount}`), never a park — the wire contract (`step-contracts.js`'s VALIDATE `outputContract`, checked in `llm.js`) is a PRESENCE check on the key, not a shape check, so only a reply omitting `reasons` entirely parks `llm-transport-failed:VALIDATE` before a verdict is read, meaning `reasonsKeyPresent: false` reaches the REJECT branch only via a shadow-mode fixture — the legacy `ctx.task.llm.<step>` override returns `invokeClaudeReal`'s raw shape with no top-level `verdict` (parks `validate-unrecognized-verdict` instead), and `--dry-run`'s canned VALIDATE payload is always a `PASS` (REJECT is unreachable under `--dry-run`). A real, live reply sending `reasons: null`/`[]`/`"[]"`/a non-string-only array reaches the REJECT branch the same as a fixture would. A bare non-JSON string is salvaged as the one reason rather than discarded; every usable reason has internal whitespace (including an embedded newline) collapsed to single spaces (`collapseToOneLine`, shared with `handleDiagnose`'s nested-`root_cause` unwrap) before it reaches the ledger or the `result` event; and exactly one usable reason journals nothing new. | MERGE | REJECT → IMPLEMENT (own budget of 3) · false citation → PARKED (`citation-false`) · verifier couldn't answer → PARKED (`citation-verifier-failed`) · verdict the code doesn't recognize → PARKED (`citation-verifier-unrecognized-verdict`) · change-validator transport failure (no verdict produced at all) → PARKED (`llm-transport-failed:VALIDATE`) · diff.patch unproducible → PARKED (`judge-inputs-missing`) · change-validator answered with a verdict string this code does not recognize (neither `PASS`, `PASS_WITH_FINDINGS`, `REJECT`, nor a transport failure already handled above) → PARKED (`validate-unrecognized-verdict`, `detail.verdict` carries what it actually sent) |
| MERGE | script | `gh pr merge --merge` (enqueues), `npm run pr:wait`; exit code is the verdict. Exit 4 (still open) → **one** more bounded wait, then a GitHub mergeability probe, then PARKED. The queue is never dequeued, re-enqueued, `--admin`-forced or fed empty commits by the machine — the measured costliest improvisation family (24 episodes; one wrote Done on an open PR). **SPO-Pipeline#85:** on either PR-involving failure below (`pr:wait` exit 1, or the second bounded wait's own failure) the step no longer parks on that local read alone — it asks GitHub itself first, `gh pr view --json state,mergeable,mergeStateStatus` (run through the same journalled, timeout-guarded `spawnStep` every other `gh` call here uses; the read is journalled as `pr-mergeability`, fulfilling the "journal the PR number and the last `mergeStateStatus`" recommendation `doc/improvisation-analysis.md` wrote in 2026-08 and never implemented until now). **Post-verification efficacy fix:** GitHub computes `mergeable`/`mergeStateStatus` LAZILY — the first `gh pr view` on a PR *can* kick off a background job and answer `UNKNOWN`/`UNKNOWN`, with the real value only landing on a LATER read (measured at the time: 4 of 4 open PRs read `UNKNOWN`/`UNKNOWN` on the first call; a definite answer arrived, across 9 timed cold PRs, only once ~1.55s of wall-clock had elapsed since that first `UNKNOWN`, regardless of call count — PR #134 and #691 both resolved to `DIRTY`/`CONFLICTING` only on the second read). **Re-measured 2026-09-06** on all 13 currently-open `Crazz-Org/SPO-WebClient` PRs: 0 of 13 cold reads returned `UNKNOWN` — every one answered a definite `mergeable`/`mergeStateStatus` on the first call (0.40–0.77s wall-clock) and matched on a warm re-read 2s later — so `UNKNOWN` on a first read is not a general property of `gh pr view`; a days-stale PR just answers immediately. Neither measurement settles which of the two this probe hits in production: #141's bounded 3-attempt re-poll stays justified for the case production actually exercises — a PR the merge queue has just been touching, whose cached computation was invalidated by that activity — which is a different PR state than either measurement's PRs were in. A probe that read exactly once would fall straight back to the unenriched symptom reason on every `UNKNOWN` it did hit, making this whole action a near-no-op in exactly the state production exercises — so `probeMergeability` re-reads, bounded to 3 attempts total, sleeping ~750ms between reads (wall-clock, not call count; injectable via the same `deps.sleep`/`pollSleep` convention `realCiChecks`'s own in-flight poll above already uses) and stopping the moment the answer is definite or the PR reaches `MERGED`/`CLOSED`. Every attempt is journalled as its own `pr-mergeability` event carrying an `attempt` field, so the corpus shows exactly what GitHub said and when. Measured motivation: issue-443's PR **merged 30s AFTER** a `pr-closed-unmerged` park; issue-517's **merged 17s BEFORE** a `merge-queue-not-landing` one — a local exit code was stale in both directions. `orchestrator/merge-cause.js`'s pure `classifyMergeCause` turns the probe's answer into one of: `state: MERGED` → no park at all, `'FINISH'`; `state: CLOSED` → `pr-closed-unmerged` (the same reason as before, now confirmed rather than assumed from a single unconfirmed read); otherwise, GitHub's own `mergeable`/`mergeStateStatus`, precedence conflict → blocked → behind → draft → unstable: `mergeable: CONFLICTING` or `mergeStateStatus: DIRTY` → `merge-conflict` (**card #212**: `detail` also carries `headSha` — one guarded `git rev-parse HEAD` at the park (`readMergeConflictGateFacts`), since MERGE is only reachable after a GATE run that ACCEPTED the current HEAD earlier in this same attempt (a real exit-0 PASS, or card #211's exit-3 recovery reaching a fresh PASS) — plus `gatePassedOnSha` (`verdicts/<headSha>.json`'s own `verdict === 'PASS'`) and `liveStatus`; a failed rev-parse reads `headSha: null, gatePassedOnSha: null` — unknown, never `false`); `mergeStateStatus: BLOCKED` → `merge-blocked` (GitHub's own `BLOCKED` covers a required review, a failing required check, and branch protection alike — the reason does not claim which, since the enum alone cannot say); `BEHIND` → `merge-behind-base`; `DRAFT` → `merge-pr-draft`; `UNSTABLE` → `merge-checks-failing`. When the probe itself has no usable answer — a non-zero exit, unparsable JSON, a thrown error, or GitHub's own `CLEAN`/`UNKNOWN`/`HAS_HOOKS`/an enum this code does not recognise — the ORIGINAL, unenriched symptom reason still fires: the probe must never mask a park. Every one of these parks keeps its pre-existing detail key (`exit` or `lastExit`, the local read) and adds `prState`/`mergeable`/`mergeStateStatus` when the probe answered. **SPO-Pipeline#84 (the re-gate CI_CHECKS' row above names as still missing):** before either `parkFromMergeCause` call actually parks, and only when the probe's cause is `merge-conflict` or `merge-behind-base` — the two answers meaning `main` moved under the branch while it sat in the queue — `realMerge` makes exactly one re-gate attempt (`regateAfterNonLanding`, shared by both the exit-1 and exit-4 legs). It reuses the SAME cause the probe already read (never a second `gh pr view`), then re-runs CI_CHECKS' own intersection test: HEAD's bench verdict `baseMain`, `git fetch origin main`, `git diff --name-only <baseMain>..origin/main` intersected with `git diff --name-only origin/main...HEAD`. A non-empty intersection, under the same shared `mainMovedRegateBudget` and nightly-red guard GATE/CI_CHECKS already spend from, merges `origin/main` and returns to CHECK instead of parking — journalled as `main-moved-merge` (`{from: 'MERGE'}`, the same event name GATE's own main-moved path uses) plus a `merge-regate` event naming the outcome (`decision`: `rev-parse-failed`/`no-base-main`/`fetch-failed`/`diff-failed`/`no-intersection`/`budget-exhausted`/`origin-main-rev-parse-failed`/`merge-failed`/`spawn-park-suppressed`/`routed`). Any cause other than those two, or anything that keeps the re-gate from completing, falls straight through to the pre-existing park below, unchanged — the re-gate can only prevent a park, never worsen or rename one. That last property is enforced, not merely intended: every one of the re-gate's own spawns runs inside a guard that swallows a thrown `spawnStep` park (`git-timed-out`, `command-killed-by-signal`) into a `merge-regate {decision: 'spawn-park-suppressed', suppressedReason}` event rather than letting it unwind past the caller's already-obtained cause; `guardNightlyRed`'s `main-red-no-merge` is the single deliberate exception (never merge from a red `main`). This closes the specific window CI_CHECKS' own gap analysis describes (a sibling's merge moving `main` between this task's CI_CHECKS pass and its own MERGE), for the subset of that window's outcomes GitHub's own probe can actually see; it does not re-run CI_CHECKS' failing-check classification, only the file-intersection test. | FINISH | PARKED — `gh pr merge --merge` itself exiting non-zero → `pr-merge-enqueue-failed` (nothing was ever enqueued, `pr:wait` never runs); `pr:wait`'s own exit code, read after the enqueue succeeded: 1 (closed without merging) → the probe-then-park sequence above, falling back to `pr-closed-unmerged` when GitHub's own answer is unusable; 4 on the second, bounded re-wait (still open even after the one extra wait this row's Does column describes) → the same probe-then-park sequence, falling back to `merge-queue-not-landing` (`detail.lastExit` carries the second wait's own exit) only when GitHub's own answer is unusable — GitHub had no answer, not that the cause is unknowable in general; see CI_CHECKS' own **#84** discussion above and this row's own re-gate description just above for the one measured way a card can still reach this fallback with a real cause GitHub's probe could not resolve: a sibling's merge moves `main` under it in the GATE→merge-queue window, and the probe itself answers something other than a definite `merge-conflict`/`merge-behind-base` (an `UNKNOWN`, a read failure, or a cause the re-gate's own condition does not cover) — that window is no longer un-re-gated in general, only for the subset of outcomes GitHub's own probe cannot name; anything else the first `pr:wait` call returns (neither 0, 1, nor 4) → `pr-wait-unrecognized-exit` |
| FINISH | script | Action B1.4: FINISH now actually keeps the promise this row always made — fast-forward the main product checkout (`config.productRepo`), then reap the worktree, then close the task (board sync: Done + short comment). Before this action it never did: `realFinish` only ever did the board move, the issue comment and the worktree remove, so a PR merged by the daemon left `config.productRepo` exactly as stale as one merged by a human who never ran `npm run finish` (SPO-WebClient's own script) — measured root cause of the bench worker silently running a stale binary for 3.5 days across 11 merges (a commit changed both halves of a flag contract atomically and correctly; the bench worker, installed once from a binary and never rebuilt, disagreed with the new job body from the moment it landed). Two NEW steps run first, inside their own product-repo-lock critical section (phase `finish-sync`, ahead of the pre-existing teardown phase `finish` below — see product-repo-lock.js/product-repo-hold.js), in this order: (1) `git fetch origin`, then this card's own merge commit by PR number (`gh pr view <prNumber> --json mergeCommit` — ctx carries no merge sha directly; MERGE only ever enqueues and awaits the merge, never reads the resulting commit back), then `git diff --name-only <mergeSha>^ <mergeSha>` to learn whether the merge touched the bench worker's own sources (paths under `src/e2e/bench/` or `scripts/bench-`, the same test `scripts/finish.sh` already runs by hand) — this determines `benchTouched` REGARDLESS of whether the fast-forward below succeeds; (2) the fast-forward itself — refuse (never force) unless `config.productRepo` is on `main`, clean of TRACKED changes (`git status --porcelain --untracked-files=no` empty — post-verification hazard fix: narrowed from bare `--porcelain`, which counted untracked files and so refused in cases `scripts/finish.sh`'s own `git pull --ff-only` would sail straight through, parking a bench-touching card on a stray editor backup or scratch file in this human-shared checkout), and `git merge --ff-only origin/main` itself succeeds; (3) ONLY once the fast-forward succeeded AND `benchTouched` is true, wait for the bench worker to go IDLE — a second post-verification hazard fix: `bash scripts/bench-install.sh` ends in an unconditional `systemctl --user restart`, and this daemon runs `SPO_WORKERS=2` in production, so reinstalling while the bench is still busy can cut a SIBLING card's in-flight GATE mid-job (the cut job recovers as `INTERRUPTED`, writes no `verdicts/<sha>.json`, and that sibling parks `gate-non-attesting` — transient-retryable, but a REAL re-run of WORKTREE through GATE, not merely a wasted gate). `waitForBenchIdle` polls `~/.spo-bench/spool` and `~/.spo-bench/running` (the same two directories `spo status` already reports) until both are empty, bounded by `config.benchIdleWaitMaxPolls` × `config.benchIdleWaitPollIntervalMs` (default 180 × 5s = 15 minutes), reading `config.spoBenchDir` itself, never a hardcoded path (R2/W2, post-verification third pass: an UNREADABLE spool/running — anything other than "the directory simply is not there" — is never silently read as idle; it PARKS immediately, `finish-failed`/`bench-idle-wait`/`bench-dir-unreadable`, distinguishably from a merely busy bench, the same "tell a misconfiguration apart from a genuine empty answer" pattern `realGate`'s own `verdictDirExists` already uses one function away). R1 (post-verification third pass): a bench that stays BUSY for the whole bound no longer PARKS — it DEFERS. The old park was wrong on three counts, all measured: `finish-failed` is not on `state-machine.js`'s `TRANSIENT_RETRY_REASONS` (terminal, human-only); the park fired BEFORE the board move below, so a card whose PR had ALREADY MERGED sat in `Merging` with its worktree still on disk; and the 15-minute bound is not generous against SPO-WebClient's own bench leases — `worker.ts`'s own `DEFAULT_LEASE_MINUTES = 30` / `MAX_LEASE_MINUTES = 120` constants mean an ORDINARY human bench lease (2×–8× the bound) would terminally park any bench-touching card the daemon finished during it. So the bound being exhausted now journals `bench-reinstall-deferred` (`detail`/event carry `mergeSha`, `prNumber`, the last-observed `spool`/`running`, and the attempt count), records the debt DURABLY (`journal.js`'s `writeBenchReinstallOwed`, `<journalRoot>/bench-reinstall-owed.json` — survives a daemon restart, and a SECOND bench-touching card deferring during the same busy window overwrites this ONE record with its own, newer `mergeSha` rather than accumulating a duplicate — `bash scripts/bench-install.sh` always rebuilds from whatever is CURRENTLY checked out, so only the latest sha is ever useful to retry with), and lets FINISH complete NORMALLY — board move, comment, worktree remove, `DONE` — exactly as if nothing were owed. Round 4: the debt is paid back by the NEXT card's own WORKTREE, from inside that card's own product-repo lock span (`payBenchReinstallDebtIfOwed`, see the WORKTREE row above for the full mechanism) rather than a separate daemon scan timer — round 3's `orchestrator/bench-reconcile.js` shipped exactly that timer and was deleted: it held the SAME product-repo lock from a THIRD process the mutex's own wait-bound derivation (`product-repo-lock.js`'s `waitBoundMs`) assumes cannot exist. The journal alone must always answer "is a reinstall owed right now" — every branch above is named and loud on purpose; (4) only once the bench is confirmed idle, `bash scripts/bench-install.sh` (the same script `scripts/finish.sh`'s human-session rule runs) reinstalls the worker — never run against a checkout that could not be verified fresh first, which would install the wrong binary and report success, reproducing the exact defect this action closes, and never run while the bench is still busy, which would reproduce the SAME defect from the other direction (a cut sibling job). | DONE | PARKED (also `product-repo-lock-timeout`, same mutex as WORKTREE above — `detail.phase` is now one of `worktree` / `finish-sync` / `finish`, since FINISH itself acquires this mutex TWICE) — the pre-existing three (board move to `Done`, the closing issue comment, the final `git worktree remove`) still PARK the same `finish-failed` reason on a non-zero exit, `detail.step` naming which one (`board-move` / `issue-comment` / `worktree-remove`); this is deliberately the one park in the whole daemon that blocks on what is everywhere else a best-effort side effect (`board.js`'s own moveCard convention), because a card that cannot be marked `Done` is not done. Action B1.4 extends the SAME `finish-failed` vocabulary rather than inventing new reason strings, `detail.step` naming the new failure: `merge-sha-lookup` (`gh pr view` failed or returned no usable `mergeCommit.oid` — cannot safely determine anything past this point, always PARKS) · `bench-diff-check` (the `git diff --name-only` call itself failed — same reasoning) · `fast-forward` (the checkout was not on `main`, was dirty of TRACKED changes, or `git merge --ff-only` itself refused — `detail.reason` names which; PARKS only when `benchTouched` is true, i.e. reinstalling would have been necessary and unsafe; when `benchTouched` is false the card's PR has already merged and this is journalled as `main-fast-forward-failed`, not parked — a fast-forward failure this row's own drift measurement already showed real and non-blocking must not stall the whole backlog over a merge that never touched the bench; R3, post-verification third pass: `detail.reason` is `check-failed` — never `wrong-branch`/`dirty` — when the BRANCH or STATUS probe command itself failed to run (`detail.check` names which, `detail.exit` its real exit code) rather than genuinely answering "wrong branch"/"dirty", so a maintainer reading the journal is not misled into hunting for uncommitted work that was never there) · `bench-dir-unreadable` (R2/W2, post-verification third pass: `config.spoBenchDir`'s own `spool`/`running` could not be read for a reason OTHER than "the directory simply is not there" — `detail.code` carries the real errno; thrown immediately, on the FIRST read, never after polling, since no amount of waiting turns a misconfigured or permission-denied directory readable) · `bench-reinstall` (`bash scripts/bench-install.sh` itself exited non-zero). A stuck reinstall — `spawnStep`'s SINGLE attempt timing out, never retried (R2, post-verification third pass: matches `npm-gate`'s own pre-existing exemption, for the identical reason — a killed `bash` can leave `npm run build:e2e`/`systemctl restart` still running underneath it, and a retry would build into the SAME `dist/` concurrently) — is instead `bench-install-timed-out`, the `${commandClass}-timed-out` family's newest member (`command-timeout.js`'s own `'bench-install'` class, `SPO_TIMEOUT_BENCH_INSTALL_MS`, default 15 minutes, `detail.retried: false`). Every outcome of the new preamble is journalled either way (`merge-sha-lookup-failed` -- `gh pr view` exited non-zero or returned no usable `mergeCommit.oid`, so nothing past this point can be determined safely and the card parks `finish-failed`/`merge-sha-lookup`; `bench-diff-check-failed` -- the `git diff --name-only <mergeSha>^ <mergeSha>` call itself exited non-zero, so `benchTouched` is unknowable and the card parks `finish-failed`/`bench-diff-check`; both carry `prNumber` and the real `exit` code, and `bench-diff-check-failed` also carries the `mergeSha` step 2 resolved -- `main-fast-forwarded` / `main-fast-forward-failed`, `bench-busy-wait` per poll while the bench drains, `bench-idle` / `bench-idle-wait-timed-out`, `bench-reinstall-deferred` (R1, once the bound is exhausted with the bench still busy — see above), `bench-dir-unreadable`, `bench-reinstalled` / `bench-reinstall-failed` / `bench-reinstall-skipped`, `bench-diff-checked`), so the journal alone answers "did the worker get reinstalled, was a reinstall ever deferred, and is one owed right now" without reading a log. |

Ledger per task (`journal/<task>/ledger.md`): one line per attempt —
`attempt N | root cause | outcome`. The 3-attempts rule is a string comparison over it. A
VALIDATE REJECT gets its own line, same shape but a distinct leading word so the two can never
be confused: `validate-reject N | reasons | outcome` (action 1.6). When zero usable reasons
reached the ledger, `reasons` reads `(no reason given; reasons shape: <shape>)` instead of the
bare `(no reason given)` — see the VALIDATE row's own card #174 note above for `reasonsShape`'s
possible values.

**PLAN-time span-conflict flag, CHECK-time relief (issue #112).** The PLAN row's own invariant
baseline (above) never asked whether the SAME plan that froze an invariant's quote also orders a
change to that quote's own line span — no IMPLEMENT can satisfy both "keep this exact text" and
"rewrite this region" at once, and until this action the contradiction only ever surfaced LATER,
as a CHECK failure that cost a full DIAGNOSE/IMPLEMENT cycle to diagnose something the plan text
already gave away. `orchestrator/plan-span-guard.js`'s `detectSpanConflicts` — a pure predicate,
plain span overlap between an invariant's resolved (or, failing that, declared) span and any span
the plan's own `plan_markdown` names for the same file, across the three citation syntaxes real
plans use (a path attached to the citation, a bare `:N-M` under a path-bearing heading, or prose
"lines N-M") — runs at PLAN time, right before `invariants-baseline` is journalled, and marks each
matching baseline row `planSpanConflict: {planSpan, planLine, syntax}`. Nothing is dropped and
nothing about the baseline's `resolved`/`mode` changes; a match also journals
`invariants-plan-span-conflict` (`{conflicts: [{id, file, planSpan, planLine, syntax}]}`). CHECK
still re-resolves every baseline invariant exactly as before — the flag changes nothing about
what breaks. Only once `checkRegressions` reports a non-empty `broken` list does the flag matter:
if EVERY broken id in that SAME `invariants-checked` event carries `planSpanConflict`, CHECK
journals `invariants-span-conflict-relieved` (`{ids, conflicts}`) and lets the task proceed to
`PUSH_PR` instead of `DIAGNOSE` — one broken id without the flag, alongside one that has it, still
routes the whole event to DIAGNOSE (relief is all-or-nothing, never partial). Measured by
replaying `scripts/replay-plan-span-flags.js` over the 58-card journal corpus: 5 invariants were
both flagged and actually broke (487/INV-4, 488/INV-7, 491/INV-5, 491/INV-6, 508/INV-1, each a
plan/invariant self-contradiction per its own card's ledger), accounting for 7 of the corpus's 8
invariant-caused CHECK failures. One invariant broke WITHOUT being flagged — 517/INV-13, whose
plan names no line number at all for the file it cites, so no span-intersection rule can reach
it; a documented blind spot, not a bug the predicate is expected to close. The same predicate also
flags invariants on cards whose own event history never broke a single one — 140 flags across 37
of 53 such "clean" cards (any outcome: DONE, PARKED, or ABANDONED, the only requirement being that
no invariant ever broke), measured 2026-09-06. A narrower, more meaningful bucket restricts that
same "never broke" set to cards that additionally **merged cleanly** — `state.json`'s
`state === 'DONE'` OR `externallyResolved.via === 'pr-merged'` — and finds 138 flags across 36 of
49 such cards. In both buckets, not one of those invariants has ever broken, so the flag was never
consulted there: the predicate is not precise, only useful when it fires on something that
actually breaks. Both counts are re-derived with `scripts/replay-plan-span-flags.js` against a
live, non-git-tracked journal (`~/.spo-state/journal`) that keeps growing, so re-measuring later
will find different totals. The
complementary risk — a flagged invariant breaking because IMPLEMENT genuinely regressed something
unrelated to the plan's own contradiction, which relief would then wrongly excuse — has zero
instances in this corpus but is **unmeasured, not proven zero**: 58 cards cannot bound a rate this
low.

## Step contracts

| Step | Model | Effort | Tools | Output | Wall-clock deadline |
|---|---|---|---|---|---|
| PLAN | Opus 5.5 (`claude-opus-5-5`, since 2026-09-23; Opus 5 before), **Fable 5 fallback** on `task.planInvalidRetry` (since 2026-09-13; `EXP-PLAN-OPUS`, adopted 2026-09-24, `doc/model-experiments.md`; the Opus 5.5 base is on trial as `EXP-PLAN-OPUS-5-5`). `handlePlan` sets it for one in-run retry after a real-mode Opus reply that would park `plan-invalid`, or from the start when the card's most recent park was `plan-invalid`; each switch journals `plan-model-fallback`. Transport failures never fall back. Was Fable 5 with no escalation until 2026-09-13 | per task size S/M/L → medium/high/high (`PLAN_EFFORT_BY_SIZE`; low/medium/high until 2026-09-13) | Read, Grep, Glob, Bash(ro) | plan.md + invariants + check commands + `files_to_change` (`--json-schema` envelope; `files_to_change` is `optional`, not in the schema's `required`) | 1800000ms / 30min |
| IMPLEMENT | **Opus 5.5** on every path since 2026-09-23 (`EXP-IMPLEMENT-OPUS-5-5`; Sonnet 5 escalating to Opus 5 before) — effort escalates to **medium** on any of four triggers (`step-contracts.js`'s `escalationSignalFires` via `shouldEscalateEffort`, card #213 action 2 + its 2026-09-12 amendment): (1) `task.rdoDiffTouched === true`, the real diff once PUSH_PR has run; (2) `task.planDeclaresRdoMembers`, the PLAN's own `files_to_change` declaration naming `rdo-members.ts` (resolved by `state-machine.js`'s `resolvePlanDeclaresRdoMembers` before the call — an EMPTY declared list still counts and resolves `false`, with no fallback to (3)); (3) `task.touchesRdoMembers === true`[^rdo-wire], the intake guess, read only when (2) is undefined (PLAN never declared a list at all); or (4) `task.diagnoseOrValidateRetry === true` — a retry after a DIAGNOSE or a VALIDATE reject, independent of the RDO signals, escalating on observed difficulty; or an L-sized task | per size: S/M/L → low/medium/medium (`IMPLEMENT_EFFORT_BY_SIZE`); medium when a trigger fires | full edit tools in the worktree | diff summary + invariant rows + files-changed list (JSON) | 1800000ms / 30min |
| DIAGNOSE | Opus 5.5 since 2026-09-23 (Opus 5 from 2026-09-04; Fable 5 before) | high | Read, Grep, Bash(ro) | one-line root cause (JSON) | 900000ms / 15min |
| VALIDATE: citation-verifier | Fable 5; **Opus 5.5 (`claude-opus-5-5`) when no account has Fable quota left (a 529 overload doesn't count), onto an account with Opus 5.5 quota** (SPO-Pipeline#166/#277, `quotaFallbackModel` — see *Which steps may change model on a limit* below) | high | Read, Grep (product + `~/SPO-Original`, read-only) | PASS / REJECT / DIVERGES (JSON) | 900000ms / 15min |
| VALIDATE: change-validator | Fable 5 (never the executor's model — Opus 5.5 since 2026-09-23, Sonnet before — the executor may not judge itself; never Opus either — the wire rule escalates effort, not model). **One exception, under quota pressure only:** when no enabled account has Fable quota left (a 529 overload doesn't count), it retries on Opus 5.5 (`claude-opus-5-5`) at the same effort, on an account with Opus 5.5 quota (SPO-Pipeline#166, maintainer decision 2026-09-24; trigger set by #277, 2026-09-25; `EXP-JUDGE-QUOTA-FALLBACK` in `doc/model-experiments.md`) — the judge then sometimes grades its own model's work, accepted | high, **xhigh** when `task.rdoDiffTouched` is true (`step-contracts.js`'s `escalatesEffortOn`) — **action 1 of card #213 (2026-09-12)** moved this off `task.touchesRdoMembers` (an intake guess): on the 36-card window measured that day, the guess fired on 23 of 36 cards while the merged diff touched `rdo-members.ts` on only 2, so 17 of 19 `xhigh` calls under the old trigger judged a diff with no RDO in it. `rdoDiffTouched` is written onto `ctx.task` by `handleValidate` (`state-machine.js`, from `resolveRdoDiffTouched`) before this call, so a `--worker` resume that rebuilt `ctx.task` from `task.json` still escalates correctly, the same restart-durability `resolveRdoDiffTouched` already gave CITATION_VERIFIER's own trigger (#105) | Read, Grep, Glob, Bash(ro) | PASS / PASS WITH FINDINGS / REJECT + findings (JSON) | 900000ms / 15min |

**Which steps may change model on a limit** (SPO-Pipeline#166, done-means item 3). Exactly two:
VALIDATE's citation-verifier and change-validator, the only contracts with a `quotaFallbackModel`
(`step-contracts.js`), move from Fable 5 to Opus 5.5 — and only when **no enabled account has
Fable QUOTA left** (a model limit, a session or weekly window, a cooldown with no recorded
kind), **onto an account that has Opus 5.5 quota** (`accounts.quotaFallbackServable`: every
enabled account's Fable record cooling for one of those reasons, some enabled account healthy for
Opus 5.5). **A 529 overload doesn't count**: an account whose Fable cooldown is a 529's
(`cooldownKind: 'overloaded'`, 5 minutes) has Fable coming back within minutes, and waiting for it
is cheaper than a verdict from the executor's own model — the judge rule yields only "under quota
pressure" (decision 1). So one 529-cooling account is enough to wait, even when every other
account is out of Fable quota; a pool cooling on Fable from 529s alone waits as before. Resource management comes first (SPO-Pipeline#277, maintainer decision
2026-09-25: "it needs to check other accounts for FABLE quota available — it's how resource
management works"): a limit on one account cools it per its own scope and rotates on Fable to the
next account healthy for it, exactly as any step's limit does. Until #277 a Fable model limit
switched on that first account's limit, so a card was judged by Opus 5.5 while another account
still had Fable; and #166's pool-wide test counted only model-scoped usage cooldowns, so a pool with
no Fable anywhere parked whenever one account's cooldown had another cause, although another account
still had Opus 5.5 (#277's verifier finding F1). #166 decision 4 — an account-wide limit never falls
back, since switching model cannot get around it — holds per account: an account-wide limit cools
every model on **its** account until one shared end — `accounts.js`'s `computeLimitUpdate` gives every
model the latest of the per-model computations (#277 re-verification: before, each model escalated on its
own history, and an hour on the account read healthy for Opus 5.5 while still account-wide limited) — so
the fallback never lands there, and a pool where every account is
account-wide limited has no Opus 5.5 either and parks / pool-waits exactly as before, with no
`model-fallback`. `callLlmStep` (`state-machine.js`) switches once per call, on either of two
triggers asking that one question on the lease's clock: (a) a Fable call came back `kind: 'limit'`
(any kind, any scope), it has been cooled, and the condition now holds — this result left no account
with Fable; the fallback then gets a fresh pass over the pool, the limited account included when its
limit was a Fable model limit. (a) exists so the switch happens in that same call: the loop makes at
most one call per enabled account, so when the last account with Fable is the one that limits, it
would otherwise exit and park before another lease could reach (b). Or (b) leasing for Fable threw
`AllAccountsCoolingError` and the condition holds. A pool where some account is healthy for Fable
never falls back — including one where that account is leased by another live process:
`leaseHealthyAccount` then waits up to `accountLeaseWaitMs` for it (usually getting it) and parks
`all-accounts-leased` only when that wait expires. The dispatcher's clamp
(`first-call-model.js`'s `servableFor`) asks the same predicate: a queued resume is servable on the
fallback exactly when `quotaFallbackServable` holds — `test/dispatcher-model-clamp.test.js` checks
the clamp's model against the worker's first `--model` for every per-account Fable/Opus 5.5 state
over 2 and 3 accounts. A limit on the fallback call is handled like any other limit on Opus 5.5 (cooled per its
own scope, rotated, `all-accounts-cooling-after-retry` with `detail.quotaFallback` when the pool is
exhausted on it, its `attempts` then counting both models' calls); the step switches at most once per call — never back to Fable, and a second switch is a thrown bug, not a loop. The lease, the
`--model` on the argv, the cooldown key and `llm-call.model` all name the fallback model on the
fallback call. Journal: `model-fallback` `{step, from, to, cause: 'model-limit', trigger:
'limit-result'|'lease', account, rateLimitType}` (`cause` keeps #166's value whatever each
account's reason — those are the `account-cooldown` events before it); the fallback call's `llm-call` carries
`quotaFallback: true`, and so do the `change-validator` / `citation-verifier` verdict events (with
`judgeModel`) — `scripts/model-report.js`'s `judgeVerdicts` counts the two judges apart.
**Every other step never changes model on a limit**: PLAN, IMPLEMENT and DIAGNOSE (and the intake
steps: DRAFT_CARD, REVIEW_CARD, TRIAGE_BUG_REPORT) rotate accounts on the same model, then park /
pool-wait (maintainer decision 2026-09-24: no lane for them until an Opus 5.5 limit is observed).
PLAN's Fable fallback is a **quality** fallback (`planInvalidRetry`), never a quota one.

The deadline is NOT the same figure for all five rows: `step-contracts.js`'s `LLM_STEP_DEADLINE_MS_BY_STEP`
overrides two of them — PLAN and IMPLEMENT both carry 1800000ms — and the other three (DIAGNOSE,
CITATION_VERIFIER, VALIDATE) take `LLM_STEP_DEADLINE_MS`'s own 900000ms default. Whichever figure
applies is the deadline `invokeClaudeReal` arms for that call (`orchestrator/steps/llm.js`)
— the INNER deadline, real mode only. Since card #239's transport cutover (action A5b, 2026-09-17)
this is a real `setTimeout` that calls `options.abortController.abort()` on the vendored Claude
Agent SDK's `query()` stream, never a `spawnSync` `timeout` option — that mechanism, and the
blocking spawn it bounded, are both deleted, not merely superseded (see `steps/llm.js`'s own
"Deadline handling" header for the full design and the measured abort/kill-escalation timing).
`state-machine.js` also wraps every LLM step in the outer
`callWithDeadline` (`deadline.js`); before action A2 (card #239, 2026-09-17) that outer wrap used the
generic `stepDeadlineMs` (120000ms; no `stepDeadlineMsByState` entry existed for any LLM state), inert
in real mode (a JS timer cannot preempt the blocking `spawnSync` the inner deadline USED TO bound)
but live in shadow mode, where a fixture delay raced that flat 120s timer regardless of which inner
figure the row above states. A2 gave each of the five its own `stepDeadlineMsByState` entry
(`orchestrator/config.js`, generated from `STEP_CONTRACTS`'s own keys) — `deadlineMsForStep(step) +`
one ordinary `stepDeadlineMs` of margin, so PLAN/IMPLEMENT now carry 1920000ms and the other three
1020000ms — sized so the inner deadline always fires first, in anticipation of card #239's own
transport swap (`steps/llm.js`'s `invokeClaudeReal` moving off blocking `spawnSync` onto an awaited
stream, action A5b, landed the same day) — the change that made this outer timer genuinely LIVE in
real mode, racing the inner deadline for real on every LLM call now, not merely inert insurance.
Shadow mode still races each step's own outer figure instead of the flat 120s every LLM step used
to share, unaffected by the transport swap (shadow mode never spawns anything). There is no
per-step or per-size USD budget: `maxBudgetUsd` is plumbed
end to end (`step-contracts.js` → `steps/llm.js`'s conditional `--max-budget-usd`) but no
daemon or intake path sets it — see `orchestrator/README.md` § Budgets for the maintainer
decision and the bounds that actually are enforced.

**`outputContract` types (card #207, 2026-09-12; fix pass same day).** Every `required` list above
now has an optional sibling, `types` — a plain per-key label (`string`/`number`/`boolean`/`object`/
`array`/`<elementType>[]`, e.g. `string[]`). `steps/llm.js`'s reply check runs `checkOutputTypes`
(`step-contracts.js`) right after the existing presence filter: a required key with a declared type
that arrives wrongly typed fails the same way a missing key does, naming the key, its declared
type, and what actually arrived. A present `null` never fails (it already satisfied the presence
check before this card, and stays a wildcard against every declared type); an array-typed key also
accepts a JSON-encoded STRING that parses to an array of the right element type, normalizing it in
place — the same leniency `park-loop.js`'s `normalizeFindingsPayload` already applies for its own
callers.

The FIRST build of this card declared a type for a key whenever its shape looked settled from
reading the key's own prompt file, without replaying the live corpus against it first — an Opus
verifier's corpus replay found two of those declarations (IMPLEMENT's `tests_run`/`invariants`)
wrong: both arrive as a JSON-encoded string 100% of the time, and roughly a third of real replies
parse to a shape (an array of `{cmd|command, exit_code}` objects; a prose sentence) the declared
type would have rejected, parking real, already-working replies. This same-day fix pass corrected
that: the actually-enforced set today is `verdict` (VALIDATE, CITATION_VERIFIER), `root_cause`
(DIAGNOSE), `plan_markdown`/`invariants_markdown` (PLAN), and `summary` (IMPLEMENT) — five keys,
each corpus-replayed against every real reply in `~/.spo-state/journal/` with zero failures found —
except `root_cause`, which has no literal wire record to replay at all (`handleDiagnose` renames it
to `rootCause` before journalling, unlike every other key here) and was instead replayed via that
renamed field as a faithful proxy for the model's actual value.
Every other required key across the five steps — VALIDATE's `reasons`/`findings`, CITATION_VERIFIER's
`entries`, IMPLEMENT's `all_green`/`files_changed`/`invariants`/`tests_run`, PLAN's
`invariant_ids`/`check_commands` (and PLAN's optional `files_to_change`) — carried real, measured
type drift in the pre-#229 corpus and is never enforced post-parse, by necessity, not by oversight
(since #221 all but `invariants`/`tests_run` are declared schema-only, below): `step-contracts.js`'s
own header comment records the corpus/test evidence for each one. `resolveStepContract`'s `--json-schema`
envelope now also carries a `properties` object built from the same `types` map (omitted entirely
for a step that declares none), so the schema sent to the model matches the shape the pipeline
enforces. (That sentence once added that whether the harness enforces `--json-schema` at all was
unmeasured; it does — see the next paragraph.)

**Schema-only types (card #221, "B-scoped", 2026-09-26).** Since #229 every contract key is named
in `properties`, and the model sends native shapes; the harness validates `StructuredOutput`
against that schema and rejects a non-conforming call in-session, so the model retries in the same
turn. #221 declares a canonical type for eight of the keys listed above — PLAN's `invariant_ids`,
`check_commands`, `files_to_change` (`string[]`); IMPLEMENT's `files_changed` (`string[]`) and
`all_green` (`boolean`); VALIDATE's `reasons` (`string[]`) and `findings` (`object[]`);
CITATION_VERIFIER's `entries` (`object[]`) — and lists each in its contract's `schemaOnly`:
the type goes to the harness, and `checkOutputTypes` skips the key, so anything that still gets
past the harness reaches its tolerant downstream reader exactly as before (`parseFilesChanged`,
`normalizeFindingsPayload`, #640's verbatim `reasons` record, prompt-template.js). The post-parse
enforced set is still the five keys above. IMPLEMENT's `invariants` and `tests_run` stay `{}`: no
consumer, and their post-#229 shape does not match `implement.md`'s. The one new failure this can
add is the harness's own: a session that never produces a conforming call ends
`error_max_structured_output_retries` (`llm-transport-failed:<STEP>`). Convergence after a *type*
rejection was probed before merge — see the #221 pull request.

[^rdo-wire]: `task.touchesRdoMembers` (`intake.js`'s `makeTask`: `area === 'rdo' || /rdo-members\.ts/.test(body)`)
    stands in for the fuller wire rule stated in `SPO-WebClient/doc/kanban-workflow.md` —
    `src/shared/rdo-*`, `src/server/rdo.ts`, `rdo-members.ts`, session-phase code — but only
    detects a slice of it, and is set once at intake, before a plan exists. Card #213 action 2
    (2026-09-12) gave IMPLEMENT's own escalation two steps that DO re-derive against better
    evidence, checked before this field: PLAN's own declared `files_to_change`
    (`task.planDeclaresRdoMembers`, resolved fresh at each IMPLEMENT call — see the row above), and
    the real diff once PUSH_PR has run (`task.rdoDiffTouched`, re-derived from the literal file
    `src/shared/rdo-members.ts` and journaled both ways — see `rdo-symmetry` above). This field is
    read only when PLAN never declared a `files_to_change` list at all, i.e. as the last of the
    three; it is still promoted `false→true` by PUSH_PR (`steps/scripted.js`) and never the other
    way, for the same reason as before: **on IMPLEMENT's first pass, if neither of the two better
    sources has an answer yet, the correction from PUSH_PR arrives too late** — PUSH_PR runs after
    it, so the first IMPLEMENT sees the intake value alone. It is NOT too late for the retries.
    `runTask` carries one `ctx` across every hop and `steps/llm.js` re-reads `ctx.task` at each
    call, so any IMPLEMENT re-entered afterwards — from `handleDiagnose`, from `handleValidate` on
    a REJECT under budget, or from a Lint / Coverage-of-changed-lines CI retry via
    `ci-cause-table.js`'s `classifyCiFailure` — runs with the corrected flag (or, by then, with
    `rdoDiffTouched` itself already resolved and taking priority over it), and was measured
    spawning `--model opus` on exactly that path before #213. The promotion is one-way for this
    reason: lowering it at PUSH_PR would silently demote those retries to sonnet (since 2026-09-23:
    to `low` effort on an S card — IMPLEMENT is Opus 5.5 on every path) — the exact hole a
    naive "plan declaration always wins" order would have reopened from the other side, which is
    why `rdoDiffTouched` outranks the plan declaration rather than the reverse. The diff-derived
    truth for VALIDATE's citation-verifier lives in the separate `rdoDiffTouched` field, shared with
    IMPLEMENT's own source 1 above rather than duplicated.

Before any of the five calls above ever spawns, `steps/llm.js`'s real path fills the step's own
`prompts/<file>.md` template against the values `task-values.js` derives for it
(`buildPromptValues` → `fillPromptTemplate`). A template's header declares its placeholders; a
declared `{{name}}` with no value supplied, or any `{{...}}` token still present in the body after
every declared one has been substituted (a body reference to a name the header never declared,
almost always a typo), throws `prompt-template.js`'s typed `MissingPlaceholderError` before the
`claude` process is ever spawned — no tokens spent. `steps/llm.js` turns that into
`ParkSignal(`prompt-missing-placeholder:${err.placeholder}`, {step, promptFile, placeholder,
missing})` — the reason string carries the specific placeholder name, so two different broken
templates park distinguishably rather than colliding on one generic reason. A maintainer resolving
this park fixes the named prompt file's header/body mismatch and retries; nothing about the task
itself is at fault.

Every LLM call, since card #239's cutover (action A5b, 2026-09-17): the vendored Claude Agent
SDK's `query({prompt, options})`, never `claude -p` spawned directly any more (the old transport's
`spawnSync`/`buildArgv` are deleted, not merely superseded — see `orchestrator/steps/llm.js`'s and
`orchestrator/steps/sdk-call.js`'s own headers for the full design and what was MEASURED against
the real vendored SDK). `options` carries `--session-id=<uuid>` (action 4.1: generated by
`invokeClaudeReal` immediately before the call, or used verbatim when a caller already supplies
one, so a killed or unparsable call can still be tied back to the `claude` session that actually
ran; a first-class SDK option, not routed through `extraArgs`), `--json-schema` for the payload,
`--allowedTools` (comma-joined by the SDK's own argv builder), `--model`, `--effort`,
`--permission-mode` per step (plus `--max-budget-usd` when a caller supplies a numeric
`maxBudgetUsd` — no daemon or intake path does; the only caller that does is the hand-run
`scripts/smoke-llm.js`), and `--setting-sources=user,project,local`, pinned unconditionally — a
flag the OLD transport never emitted at all (see `sdk-call.js`'s own `SETTING_SOURCES` comment).
The result comes back as a `stream-json` message stream — never `--output-format json`'s single
flat reply — reduced by `sdk-call.js`'s `consumeQueryStream` down to the same `{result, cost,
**session_id**, ...}`-shaped object the old transport's parsed stdout produced (MEASURED,
byte-identical field names, same file's own header). Every call runs under the account chosen by
the scheduler (`CLAUDE_CONFIG_DIR=<account dir>`, now set via the SDK's own `options.env` rather
than a spawned child's inherited environment — same effect, different plumbing). Domain context
comes from whatever `CLAUDE.md` sits in the
step's own `cwd` -- the CLI loads it itself (`steps/llm.js` deliberately passes neither
`--safe-mode` nor `--bare`), and **nothing trims it**: an earlier "(trimmed)" here described an
intention nobody implemented. Which file that is depends on the step: `config.js`'s `cwdForStep`
gives the product worktree to PLAN and IMPLEMENT only, while DIAGNOSE and both VALIDATE steps run
from this repo's root *specifically to avoid* that tree, whose preamble was measured at ~40k input
tokens. Plus the step prompt from `prompts/`.

### Nightly verdict semantics (action B3.2)

Every real-mode reader of `<spoBenchDir>/nightly/latest.json` goes through one function,
`classifyNightly(nightly, targetSha)`, returning exactly one of three states -- never silently
folding one into another. There are three such readers, and since card #226 they no longer all
live in the same file: `realWorktree`'s own check and `guardNightlyRed` (shared by realCiChecks'
and realGate's main-moved paths), both in `orchestrator/steps/scripted.js`, plus `handleIntake`'s
nightly-red pre-gate in `orchestrator/state-machine.js`, which imports `classifyNightly` from
scripted.js rather than re-deriving the predicate. The three states:

- **`green`** -- verdict `PASS`, a `sha` recorded, and it equals the sha in question. The only
  state that means "proven".
- **`red`** -- verdict `FAIL`, a `sha` recorded, and it equals the sha in question. The only state
  anything refuses over: `main-red-no-merge` at CI_CHECKS'/GATE's shared main-moved guard,
  `nightly-main-red` at WORKTREE, and -- since card #226 -- `nightly-red-holding-intake` at
  INTAKE, which front-runs the WORKTREE one for a card that has not started yet. The INTAKE gate
  is the only one of the three that is transient (it re-enqueues itself); the other two are
  terminal, because by the time either fires the card has already started.
- **`unknown`** -- everything else: no file, unreadable/malformed JSON, no `verdict` field, an
  unrecognised verdict, a verdict that by design attests nothing about `main` (worker.ts's
  `ENVIRONMENT`/`INTERRUPTED`/`BLOCKED`/`DIRTY`/`ABANDONED`/`STALE`/`LEASED`), or a PASS/FAIL
  recorded for a *different* sha than the one in question (a sha mismatch is the routine case,
  not corruption -- not because nightly runs at most once a day: `nightlyDue` also re-fires on a
  main-moved event, rate-limited at just `NIGHTLY_MOVE_RATE_LIMIT_MS` = 15 minutes, so the nightly
  runs several times a day in practice, five drives on 2026-09-02 alone; a mismatch is routine
  because proving a *freshly-arrived* tip still takes time). `unknown` does **not** park -- measured
  against the 2026-09-02 corpus, of the five `origin/main` tips that day this guard would have
  classified `unknown` for all five (two were superseded before ever being nightly-proven; the
  fastest proof took 7 minutes), so treating `unknown` as a merge refusal here would park
  essentially every main-moved merge on timing, not on any real signal -- which is the same
  principle GATE's own `gate-verdict-unreadable` path already applies ("a failed diagnostic must
  not become the thing that parks the card") -- but it
  is never silently equivalent to `green` either: every real-mode call site journals a
  `nightly-unknown` event (`{sha, reason}`) at its own state (`INTAKE` / `WORKTREE` / `CI_CHECKS` /
  `GATE` -- `INTAKE` since card #226)
  whenever the classification comes back `unknown`, so an INTERRUPTED or stale nightly always
  leaves an explicit, distinguishable trace instead of reading as proof of anything.

Before this action, `INTERRUPTED` -- written by `worker.ts`'s `recoverInterrupted` precisely so a
worker death does not read as a clean run -- and a `FAIL` recorded for a sha `main` had since
moved past both fell through the same "not red" branch a genuine `PASS` did, in this file, and
`scripts/nightly-check.sh` (SPO-WebClient, the human-facing `npm run bench:nightly` probe over
the same file) printed the literal text "MAIN: GREEN" for both. That script now applies the
identical table (0/1/2 exit codes for green/red/unknown; see its own header) -- kept in sync by
hand across the repo boundary, not by a shared import, since the two are bash and Node in two
separate repos with no shared runtime.

## Account pool

- **One place holds account information** (maintainer decision, 2026-08-29): the pool
  directory, default `~/.claude-accounts` (`SPO_ACCOUNTS_DIR` overrides it) — no separate
  registry file, no implicit fallback to the machine's ambient `claude` login. Every
  subdirectory of the pool is one account and is that account's own `CLAUDE_CONFIG_DIR`,
  authenticated once via `claude setup-token`; see `doc/setup.md` § Accounts for the guided
  procedure (`spo account add <name>`).
- A pool with zero registered accounts is a hard stop for real mode: `orchestrator/accounts.js`'s
  `pick()` throws `NoAccountsRegisteredError('no-accounts-registered', ...)`, `callLlmStep`
  (`state-machine.js`) rethrows it verbatim as `ParkSignal('no-accounts-registered', ...)`, and
  `daemon.js --real` refuses to even start. `pick()`'s other sibling for a non-empty pool that
  still yields nobody healthy — every enabled account cooling *for the model the step needs*,
  `AllAccountsCoolingError` — is
  `'all-accounts-cooling-unknown'` when nothing in the registry ever recorded a cooldown to report
  a time for, else `` `all-accounts-cooling-until-${ISO timestamp}` `` naming the earliest cooldown
  any checked account will clear; both are rethrown the same verbatim way, distinct from
  `all-accounts-leased` above (that one fires when at least one account IS healthy, just not
  currently available) and from `all-accounts-cooling-after-retry` below (which fires only once
  every account in one full rotation pass was actually tried and limited, not merely found
  cooling before a single call was attempted).
- **A cooling park is now a deferred wait, not just a park** (card #119, action 1.2): whenever the
  deadline is recoverable from the park detail — `all-accounts-cooling-until-<ISO>` and
  `all-accounts-cooling-after-retry` both carry one, by the two bullets above and below —
  `state-machine.js`'s `finalizePark` re-enqueues the task with `notBefore` set to that exact
  deadline instead of parking it outright: the worker exits, and the card comes back on its own
  once the cooldown clears, no maintainer `retry` reply required. This is a mechanism separate
  from the transient-retry budget described elsewhere in this spec, with its own cap
  (`config.poolExhaustionWaitCapMs`, 12h) tracked as the task's ACCUMULATED wait rather than a
  fixed retry count. `all-accounts-cooling-unknown` and `all-accounts-leased` never wait this way —
  neither carries a recoverable deadline (no cooldown ever recorded a time; a lease, not a
  cooldown) — and both still park exactly as they did before this action.
- **Where a pool-wait wakes up** (card #251): a pool-wait fired in **VALIDATE** (CITATION_VERIFIER
  included) with a PR open **resumes at CHECK**, on the same worktree, branch and PR, with the
  run's validate-reject/DIAGNOSE/CI-retry counters carried (`mainMoveUsed` restarts at 0, so a
  main move during the wait merges forward). It re-runs only the scripted CHECK → PUSH_PR → GATE → CI_CHECKS
  before VALIDATE probes the pool again. A pool-wait at **PLAN, IMPLEMENT (before or after a PR)
  or DIAGNOSE restarts at INTAKE**, because the work of those steps is still pending — except in a
  run a maintainer's `continue` resumed, whose descriptor is carried from every state (cards
  #255/#279): out of IMPLEMENT it resumes at IMPLEMENT, out of DIAGNOSE (and every state other than
  IMPLEMENT) at CHECK, on the same worktree and PR. A refused machine resume falls back to that
  INTAKE restart, journalled `machine-resume-refused`.
  Either way the wake-up keeps accumulating against the same `poolExhaustionWaitCapMs`. Full
  contract: Resume at CHECK, above.
- **Exceeding the cap is its own park reason, carrying the evidence** (card #119, action 1.3):
  before this action, once the accumulated wait would exceed `poolExhaustionWaitCapMs` the park
  fell straight through, silently, under the SAME reason the original cooling park carried — a
  maintainer reading it could not tell "the pool blipped and we parked immediately" apart from
  "the machine waited most of a day and gave up." `finalizePark` now reassigns the park to its own
  reason, `all-accounts-cooling-wait-cap-exceeded` — a fifth `ACCOUNT_POOL_PARK_REASON_FAMILY`
  member, classified terminal like its four siblings but produced differently: it is never thrown
  as a `ParkSignal`, it is `finalizePark`'s own pool-wait branch reassigning its `reason` local.
  Its park detail carries the accumulated wait, the number of waits already taken, the cap that was
  exceeded, the deadline that would have been waited for, and the ORIGINAL family reason that
  triggered the wait (accounts.js's pick() or this file's own `all-accounts-cooling-after-retry`)
  — so the original evidence is never thrown away. No cooldown deadline is ever recoverable from
  this reason itself, by construction: `poolCooldownDeadlineMs` returns `null` for it explicitly,
  checked by name before either detail key is read, regardless of what its own evidence detail
  carries. This is the loop guard the cap exists to protect — without it, a cap-exceeded park whose
  detail happens to carry the original deadline would be re-enqueued forever the next time it is
  parked, reintroducing the exact unbounded hang the cap exists to prevent. The cap's basis (do not
  re-derive; measured against this lot's banked corpus) is two independent real numbers: the
  longest genuine pool-wide outage, 7.12h (merging all 12 `account-cooldown` intervals pool-wide
  into 7 episodes — 1.00h ×5, 5.00h, 7.12h), and the worst accumulated single-card wait, 5.00h
  (issue-497); the observed maximum number of re-enqueues for any one card is 2. NEVER cite
  16.69h — that figure does not reproduce: the whole-cluster span is 16.63h, but it contains a
  ~3.6h window in which the pool was not limited at all, so it is not an outage duration.
- The scheduler assigns each step an account; a limit error puts that account in **cooldown**
  — *for the model the call was running on* when the limit was that model's own, *for every
  model* when it was the account's shared session or weekly window (card SPO-Pipeline#250, below)
  — and the step retries on the next healthy account. Cooldowns are journal events.

  **The quota has two kinds, and the limit's scope says which** (card SPO-Pipeline#250). An
  **account-wide** window — the 5-hour session limit, the weekly limit — is shared by every model
  on the account: switching model cannot get around it. A **per-model** limit ("You've reached
  your Fable limit. Switch to another model to continue.") leaves the account's other models
  usable. Both reach the pipeline as the same 429 `result`; they differ in more than the reply
  text, and the classifier never reads that text. The structured discriminator is the
  `rate_limit_event` the CLI writes before the `result`: `rate_limit_info.status === 'rejected'`
  with a `rateLimitType` (measured 2026-09-24 against the real CLI 2.1.280 through the vendored
  `query()`, recorded in `test/fixtures/sdk-cli-exit1-error-results.json`).
  `sdk-call.js`'s `consumeQueryStream` keeps the last rejected one, ignoring non-rejected events
  (`allowed_warning`, window moves); `steps/llm.js`'s `limitScopeFor` maps it:

  | `rateLimitType` | `limitScope` | cools |
  |---|---|---|
  | `five_hour`, `seven_day` | `account` | every model in `KNOWN_MODELS`, plus the call's own model |
  | `seven_day_overage_included` (the Fable limit, recorded), `seven_day_opus`, `seven_day_sonnet` | `model` | the call's model only (#167) |
  | none of the above, but the assistant's `api_error` is `model_requires_usage_credits` or the event's `errorCode` is `credits_required` | `model` | the call's model only |
  | `overage`, any other value (incl. `seven_day_oauth_apps` / `seven_day_cowork` / `seven_day_omelette`), or no rejected event and no such cause | `account` | the fail-safe default |
  | — (a 529 / `overloaded_error`: no quota scope) | `model` | the call's model, 5 min flat — never shortening a longer cooldown still running on it (#277) |

  An `account`-scoped limit gives **every** model it cools the **same** end — the latest of the
  per-model escalation computations — and the same `cooldownKind`; each model still keeps its own
  escalation history (SPO-Pipeline#277's re-verification: with per-model ends, a Fable model limit an
  hour earlier escalated Fable to 5 h while Opus 5.5 got 1 h, so the account read healthy for Opus 5.5
  an hour later while its live limit was account-wide). A 529 written over a longer cooldown still
  running keeps that cooldown, its kind and its scope.

  Rows are checked top to bottom. The third row is the **typed cross-check**: the CLI 2.1.280
  also takes its model-limit branch when the 429 body's `error.details.error_code` is
  `credits_required`, with the header's `rateLimitType` absent or something else, and on that
  branch it still marks the synthetic assistant message `api_error: 'model_requires_usage_credits'`
  (the recorded Fable stream carries it; the recorded session and weekly streams carry `null`).
  Keying on `rateLimitType` alone would cool the whole account there — #167's regression.
  `api_error` and `errorCode` are typed cause fields, which the CLI's schema offers precisely so
  consumers can key on the cause instead of the message text, so reading them does not break the
  no-free-text rule below. An explicit `five_hour` / `seven_day` rejection still wins over them.
  The three `seven_day_*` values in the fourth row are in the CLI 2.1.280 enum but not per-model
  windows by name; on this OAuth-driven pool the account-wide default is the right side for them.

  **The default is account-wide on purpose** — `markLimit`'s own fail-safe reasoning: a wrong
  `model` hands the next call on a different model straight back to an account whose shared
  window is spent (a wasted call per other model per window, as #250 measured: 3 calls on the
  limited account per window instead of 1); a wrong `account` costs the other models' capacity on
  that account for one cooldown window, visibly in `spo accounts`. Not only one window: each model
  escalates off its own history, so a wrong `account` repeated within `ESCALATION_WINDOW_MS`
  (2 h) of the last one escalates **every** model on that account to the 5-hour tier, not just the
  model that really limited. That is the price of the default, accepted because the other error
  is invisible and this one is not. Both callers apply the same
  rule through `accounts.limitScopeOfResult`, so a result that carries no scope at all is
  account-wide too. `account-cooldown` events (and intake's `cooldowns` records) carry
  `limitScope` — the scope applied — and `rateLimitType`, verbatim or `null`, so the corpus can
  count the two kinds. A structured field, so this does not break the no-free-text rule below.

  **A model limit cools one `(account, model)` pair, not the account** (card #167). For the
  per-model kind, the pool's own corpus said so: every `kind:'limit'` #167 counted was on a
  Fable *call* (fable 186 calls / 12 limited; sonnet 107 / 0; opus 30 / 0) — a count by the
  call's model, which cannot tell the two quota kinds apart (#250's transcript-level recount:
  25 Fable model limits, 6 session, 4 weekly) — and one
  real account ran `IMPLEMENT/sonnet ok=true` at 07:55:26 seven minutes before `VALIDATE/fable`
  hit a limit at 08:02:42. The pre-#167 whole-account cooldown then removed that account's
  Sonnet (IMPLEMENT) capacity for the full 1h-or-5h window, though Sonnet was demonstrably
  usable. So `state.json` keys every cooldown, and its escalation history, under the model:
  `{accountName: {byModel: {<model>: {cooldownUntil, lastUsageLimitAt?, usageLimitStreak?,
  cooldownScope?, cooldownKind?}}}}`, where `<model>` is one of `step-contracts.js`'s own
  `baseModel`/`escalatedModel`/`quotaFallbackModel` values or one of its `INTAKE_MODELS` (the three
  intake steps' fixed models). `cooldownScope` (the scope `markLimit` applied) and `cooldownKind`
  (the limit kind) say why the record is cooling (SPO-Pipeline#166). Since SPO-Pipeline#277 the
  judge fallback reads `cooldownKind` only, to tell a 529 (`overloaded`: Fable back within minutes)
  from a quota cooldown; `cooldownScope` is diagnostic. A record without them is older than #166 and
  counts as a quota cooldown.
  `pick(poolDir, now, {model})` and `countHealthyAccounts(poolDir, now, model)` honour it;
  omitting the model keeps the old union answer ("cooling on anything") — the question `bin/spo`
  and the dashboard ask, through `coolingSummary`, not these two. `callLlmStep` resolves the model through
  `steps/llm.js`'s `resolveCallModel` — the same two branches `runLlm` itself resolves it from,
  so the model leased and cooled is always the `--model` the call's vendored-SDK `query()`
  argv actually carried (`test/accounts-per-model-cooldown.test.js` reads it off that argv).

  **This does NOT address pool-wide exhaustion of one model, and is not meant to.** All seven
  historical `all-accounts-*` parks were at PLAN or VALIDATE, both `baseModel: 'fable'` at the
  time; a per-model cooldown cannot conjure a Fable account when Fable is what is exhausted
  across the whole pool, so it would have prevented none of them and is measured neutral on
  that shape (`test/accounts-per-model-cooldown.test.js`). The structural answer there is model
  fallback, and SPO-Pipeline#166 built it for the judge steps only: when no account has Fable
  quota left (a 529 overload doesn't count), VALIDATE's citation-verifier and change-validator move to
  Opus 5.5 on an account that has it, instead of pool-waiting (rule set by #277, 2026-09-25) —
  see *Which steps may change model on a limit* under § Step contracts. Every other step still
  waits it out on its own model, and a pool with no Opus 5.5 either (every account account-wide
  limited) still parks on that shape exactly as before.

  A pre-#167 flat entry (no `byModel`) carries no attribution of its cooldown to any model and
  is read as nothing on record, never honoured and never an error — `state.json` is
  machine-owned and disposable, as `accounts.js`'s own header has always said.
  `orchestrator/steps/llm.js`'s `classifyFailure` (action 3.5) recognizes a limit only from
  structured signals — `api_error_status` 429 (**observed**: `intake.js:996-998`'s 12.8-hour Fable
  incident, the only recorded real limit in this repo) or 529 (**anticipated**: Anthropic's
  documented "overloaded" status, never itself observed here), or an exact (lowercased, trimmed)
  match of `terminal_reason` against an allowlist — `overloaded_error` and `rate_limit_error`
  (**anticipated**, not recorded reply text), `usage_limit_reached` (a plain **guess**, kept
  because an exact-match entry that never fires costs nothing) — never a substring scan over
  free text, since any failure message merely containing "rate" used to be misclassified as a
  limit. An unrecognised limit shape now falls through to a plain PARK instead of rotating;
  extend the allowlist from journal evidence (the failure's `terminalReason`/`apiErrorStatus`
  are journalled with the step's result) as entries move from anticipated/guessed to actually
  observed, never from further guesswork.
- **Cooldown duration is an escalating probe, not a flat number** (`orchestrator/accounts.js`'s
  `markLimit`, action 3.5's 2026-08-31 redesign — this action's own first cut used a flat 5-hour
  usage cooldown, rejected before it shipped). The real pool has **2 accounts**, and at the time
  had no pool-health gate anywhere: with `maxAttempts` equal to pool size, two usage limits
  inside one window would take the *whole pool* down for up to 5 hours, parking every card the
  daemon pulled in that window. (Chantier 6 action 6.3 later added the gate this section used to
  say was missing — see the dispatcher bullet below; the escalating-probe redesign here stands on
  its own regardless.) A flat 5h also over-waits by construction — the Claude Max
  session window resets 5h after the *session's first message*, not after the limit hit, so
  `now + 5h` sleeps for (5h − the true remaining wait) longer than necessary, often 4h+. So:
  a first usage limit for an `(account, model)` pair (`limitKind: 'usage'`, i.e. 429 /
  `rate_limit_error` / `usage_limit_reached`) cools **that pair** for a **1-hour probe**; a usage
  limit landing again within a **2-hour escalation window** of *that same pair's* last one cools
  it for the real observed **5-hour** Claude Max session window instead (the probe just proved
  the window is still open). The history is per-model for the same reason the cooldown is: a busy
  Fable hour must not put this account's Sonnet straight onto the 5h tier the first time it
  blinks. `overloaded` (529 / `overloaded_error`) stays a flat **5 minutes** and never escalates
  — a busy *server* says nothing about this account's own quota, on any model. A `markLimit` call
  that names no model at all cools **every** known model, i.e. exactly the pre-#167 behaviour:
  the fail-safe direction, since under-cooling would hand work straight back to a limited
  account, silently. An absent/unrecognised limit kind falls
  back to the usage flow (probe or escalated, by the same history check), never a shorter tier.
  Exhausting the pool inside one rotation pass never re-calls `pick()`, so the resulting park —
  `ParkSignal('all-accounts-cooling-after-retry', {attempts, lastResult, cooldownUntilIso})`,
  thrown by `callLlmStep` itself once its attempt loop runs out of accounts — carries the last
  cooldown's own ISO timestamp explicitly rather than relying on `pick()`'s own reason string,
  which that path never reaches. That same `cooldownUntilIso` is what the deferred wait above
  (card #119, action 1.2) reads as this reason's deadline.
- This rotation rule is not daemon-only: `orchestrator/intake.js`'s three maintainer/auto-triage
  LLM steps (draftCard, reviewCard, triageBugReport) follow it too, via their own
  `callIntakeStepWithRotation` helper — same pick/call/cool/rotate mechanics as
  `state-machine.js`'s `callLlmStep`, bounded to one pass over the pool. Two differences, both
  required by intake's "never throw for a recognized failure" contract: exhausting the pool
  becomes `{ok: false, error}` rather than a `ParkSignal`, and — since intake has no per-task
  journal of its own — a cooldown comes back on the result's `cooldowns` array for the caller to
  journal (`auto-triage.js` appends `report-triage-cooldown`). See `orchestrator/README.md`'s
  "Account rotation" section for the full mechanics.
- **K parallel workers ≤ healthy accounts — enforced, not aspirational** (chantier 6 action 6.3),
  **counted per model since SPO-Pipeline#166** (maintainer decision 2, 2026-09-24).
  `orchestrator/dispatcher.js`'s `fillSlots` re-clamps `K` immediately before *every* worker
  spawn — not once per loop, not once at startup — so an account that cools down mid-cycle (one of
  this dispatcher's own workers just hit a limit) is reflected on the very next spawn decision.
  The clamp is asked **per queued card**: `takeNextTask` walks the queue in its usual order and
  takes the first eligible entry for which fewer workers are live than
  `min(config.workers, accounts healthy for the model of that card's first LLM call)`. An entry
  the pool cannot serve at all (no account healthy for that model) stays queued and the next one is
  considered; a servable entry for which the live workers (EVERY one, whatever model it runs —
  leases are per call, not per worker) already reach that count holds its place — the scan stops
  there, so nothing queued behind it overtakes it. The first call's model
  (`orchestrator/first-call-model.js`'s `nextLlmCallForTask`) is the one model known at spawn time:

  | Queue entry | First LLM call | Model |
  |---|---|---|
  | fresh card, `retry`, any INTAKE restart | PLAN | `claude-opus-5-5` |
  | same, real mode, most recent park `plan-invalid` | PLAN (EXP-PLAN-OPUS) | `fable` |
  | a `resume` at CHECK runTask accepts (#251 pool-wait, #212 `continue`) | CITATION_VERIFIER or VALIDATE | `fable`; its `quotaFallbackModel` only when no account has Fable quota left — a 529 overload doesn't count — and some account is healthy for the fallback (`accounts.quotaFallbackServable`, #277) |
  | a `resume` at IMPLEMENT runTask accepts (a `continue` lineage carried out of IMPLEMENT, #279) | IMPLEMENT | `claude-opus-5-5` (no quota fallback) |

  Every later call is gated where its model is in hand — `account-lease.js`, once per LLM call.
  An account-wide limit (#250) cools every model, so it starves every row. Until #166 the count
  was **bare** — the union, "accounts cooling on no model" (card #167) — on the argument that a
  slot runs several models over a card's life; on 2026-09-16/17 that union turned a Fable-only
  exhaustion on both accounts into a daemon-wide `K = 0` for 29.87 h, stalling PLAN and IMPLEMENT
  work that needed no Fable. A pass in which no candidate the clamp judged has any account healthy
  for its model is journalled (`dispatcher-idle-no-healthy-accounts`, with the `candidates` it could not serve,
  `healthyByModel`, and `earliestCooldownUntil` — the earliest expiry of a model a held card
  needs) and the recovery edge journalled the same way
  (`dispatcher-healthy-accounts-returned`); an empty queue is judged for a fresh card, so a
  Fable-only exhaustion no longer reads as an idle daemon. A servable queue head *held* — the
  live workers, charged whatever model they run, already number the accounts healthy for its
  model, so nothing behind it is admitted — is journalled on the same edge-triggered terms since
  SPO-Pipeline#269: one `dispatcher-hold` per episode (`id`, `model`, `healthy`, `live`,
  `idleAccounts` — enabled accounts healthy for some model and holding no live lease, the
  throughput the hold costs) and one `dispatcher-hold-cleared` when it ends (`heldMs`, `taken`).
  An episode is one card on one model; every slot full (`live ≥ workers`) judges nothing and is
  not a hold. `spo status` and the dashboard's Workers tile name the starved model and card for
  an idle edge ("no account healthy for fable (needed by …)") and show a hold ("… held: waiting
  for a slot on fable"). Parallelism scales implementation capacity; the gate
  stays serialized — adding a *Claude* account does not add gate throughput. *(Corrected
  2026-09-03: this previously read "(one live world)", which gave the reason as a property of
  the world. It is not. `planitia` is an MMO world built for concurrent players, and the real
  limit is one active session per **SPO** account — so the bench's single-flight lock is its own
  policy, and more SPO test accounts could add gate throughput. See `doc/environments.md`,
  "What the test accounts can and cannot do".)*
- **Per-step account leases** (chantier 6 action 6.2, `orchestrator/account-lease.js`) stop two
  concurrent callers — a worker's `callLlmStep` and the scanner process's
  `callIntakeStepWithRotation` — from being handed the *same* account by `accounts.pick()`'s
  deterministic first-fit, invisible under the pre-C6 single-threaded daemon and a real bug once
  a worker and the scanner can run at once. A lease is per-step, not per-task, released the
  instant the one LLM call it wraps finishes; a healthy account currently leased by another live
  process is `AllAccountsLeasedError`, worth a bounded, BLOCKING in-process wait
  (`config.accountLeaseWaitMs`, default **67.2 min** (raised from 63 by action A2, card #239,
  2026-09-17 — `orchestrator/config.js` now gives every LLM step its own `stepDeadlineMsByState`
  entry, so `MAX_LEASE_AGE_MS` has to outlast the OUTER two-attempt bound, not the inner one alone;
  see `step-contracts.js`'s own comment) — `MAX_LEASE_AGE_MS`, `step-contracts.js`, the
  age at which a lease is swept as dead — never the ~90–265s a sibling's own step is *usually*
  measured at: a waiter has to outlast the longest a sibling can *legitimately* hold the lease, not
  its typical duration, and the old 5-minute default was found wrong in C6 verification for exactly
  that reason — it gave up while a legitimate holder was still alive and un-sweepable for up to
  62.2 more minutes, parking a healthy card `all-accounts-leased`) — distinct from
  `AllAccountsCoolingError` (a cooldown: still never worth a BLOCKING wait — the worker sleeping
  in-process for a 1h or 5h cooldown would pin the process for hours, doing nothing — but, since
  card #119 action 1.2, worth a DEFERRED one: the worker exits and the task is re-enqueued with
  `notBefore` set to the cooldown's own deadline, see the Account pool bullets above) — and parks
  `all-accounts-leased` if the lease wait is exhausted. Lease files live at `<poolDir>/.lease-<name>.json`;
  `countHealthyAccounts` above is deliberately blind to lease state (only to cooldowns, and in
  the dispatcher's case to cooldowns on the queued card's first-call model), since
  clamping K on lease churn — a lease frees every 90–265s — would make K flap on every single LLM
  call.
- `scripts/usage-report.js` becomes per-account: it is the instrument that says when one
  more subscription pays for itself.

## Observability — sessions and pipeline (the console)

Journals are the single source of truth; `~/.spo-bench/` remains the bench's own surface.

- `journal/<task-id>/journal.jsonl` — every event: state transitions, step spawns and results
  (`{step, model, effort, account, sessionId, tokensSource, freshInputTokens,
  cacheCreationTokens, cacheReadTokens, outputTokens, billableTokens, modelUsage,
  transcriptFilesRead, transcriptFilesSkipped, duration_s, exit, verdict}` — no dollar figure
  anywhere; `orchestrator/tokens.js`'s "billable-weighted" = fresh input + cache-creation +
  output, cache-read reported separately, never summed in). Card #214: `modelUsage` is the same
  four billable-accounting fields plus each model's own `billableTokens`, broken out PER MODEL
  and keyed by model name, present under the same condition as `tokensSource: 'modelUsage'`
  (absent, never an empty object, on a call that reported nothing recognizable, and absent on
  every event journalled before this card). It exists because `model` above names only the
  step's CONTRACT model, and a call can spend real tokens under a DIFFERENT model when it
  delegates — measured on PLAN: 6 of 42 calls, measured 2026-09-10..12 while PLAN was
  Fable-only (PR #222 changes PLAN to Opus-first with a Fable fallback), spawned
  Opus subagents while the PLAN call itself resolved to Fable (`orchestrator/step-contracts.js`'s
  own comment on PLAN's `allowedTools`, which also carries the corrected, fuller-corpus
  measurement — IMPLEMENT can delegate too, not only PLAN), and the subagents' tokens were
  already counted in the flat totals
  (`modelUsage` is whole-tree accounting) but invisible to any by-model view keyed on `model`
  alone. The same card removed `numTurns` from this event (it used to appear here too): measured
  to count agentic loop turns, not API requests, and to disagree with the real deduplicated
  request count by more than 1.5x on 45% of a rejoined corpus, with no CLI-documented schema
  defining it either way — `console/usage-scan.js`'s `requestCount` (computeStepDeltas/
  sessionRequestCount, fix pass) is the real per-step deduplicated request count, reusing its
  existing `message.id` dedup and `subagents/` walk (so a subagent's own requests are included,
  not dropped) — printed via `spo tokens --usage-delta`. `tokensSource` is one of three states:
  `'modelUsage'` (measured directly from the CLI's own reply), `'transcript'` (token-ledger lot
  action 4.3 — recovered from the call's own session transcript on disk when the CLI reply
  carried no `modelUsage`; a lower bound, a distinct source, never merged with a `modelUsage`
  figure), or `null` (not measured at all — `claude` never started, or no transcript was found
  either). `transcriptFilesRead`/`transcriptFilesSkipped` (action 4.3's own follow-up fix) are
  present only on a call `tokensSource: 'transcript'` recovery actually populated: the number of
  session-transcript files summed into that figure, and the number of candidate files dropped
  along the way (an over-cap file, a per-file read/stat error, or an abandoned root) — the
  completeness signal that tells "1 file, the whole story" apart from "1-of-100, the rest lost".
  `duration_s` was documented here well before any code wrote it — action 5.4 measured
  2026-09-01 that zero of the 19 corpus journals' `llm-call` events carried it, and made it
  true the same day: `orchestrator/steps/llm.js`'s `invokeClaudeReal` measures the seconds a
  call burned around the `claude` call itself and reports it on every branch (success, spawn
  error, external signal, and — the one a maintainer most wants — a deadline timeout, which
  still burned the full deadline even though it produced no result). The reading is taken on a
  monotonic clock (`process.hrtime.bigint()`, via `orchestrator/monotonic-clock.js` — card #158,
  2026-09-08; 5.4 itself used `Date.now()`), the same clock class libuv uses to enforce the
  `spawnSync` deadline (card #239's A5b replaced that deadline with an abort timer; the claim
  was not re-measured for the new one), so a duration and the deadline bounding it can no longer
  disagree the way a realtime reading and that deadline once did.
  Account cooldowns, parkings (with reason), attempts, transient retries (action 4.4 —
  `transient-retry`, `{reason, attempt, delayMs, notBefore}`, journalled on the re-enqueue itself,
  once the queue entry is written, with NO `parked` line — the task never reaches the `PARKED`
  state at all, it comes back around through `takeNextTask`; card #178: an earlier version of this
  mechanism journalled a `parked` line immediately before `transient-retry`, which made
  `countRepeatedParks` and `decidePlanReuse` (`orchestrator/park-loop.js` and
  `orchestrator/state-machine.js` respectively) treat a bounded auto-retry as a real park — fixed
  by dropping that line, since `transient-retry` already names the re-enqueue with its attempt,
  delay and `notBefore` (the park `detail` it does not carry is journalled by the producing step);
  `transient-retry-failed`, `{reason, attempt, error}`, when
  that write failed and the task fell through to an ordinary park instead), and pool-exhaustion
  waits (card #119 action 1.2 — `pool-wait`, `{reason, attempt, waitMs, accumulatedWaitMs,
  notBefore, deadlineSource}`, journalled the same way, on the re-enqueue with NO `parked` line,
  once the queue entry carrying the deferred `notBefore` is written — the task never reaches
  `PARKED`, same card #178 fix as `transient-retry` above; `deadlineSource` names which of the
  three resolution steps supplied the deadline (`earliestCooldownUntil`, `cooldownUntilIso`, or
  `reason-suffix`); `pool-wait-failed`, `{reason, attempt, error}`, when that write failed and the
  task fell through to an ordinary park instead — same shape and same reasoning as
  `transient-retry-failed`, a SEPARATE mechanism with its own budget; and, since card #119 action
  1.3, `pool-wait-cap-exceeded`, `{reason, poolWaitAttempts, accumulatedWaitMs, capMs, deadlineMs}`,
  journalled when the accumulated wait WOULD exceed the cap — `reason` here is
  the ORIGINAL family reason that triggered the wait, not the new
  `all-accounts-cooling-wait-cap-exceeded` reason the task actually parks under; this event IS one
  that reaches PARKED (the cap sink falls through to the ordinary park, unlike the two re-enqueue
  paths above), so it is journalled right before the one real `parked` line; this event is the
  audit trail for the cap binding, the park's own `reason`/detail carry the rest of the evidence).
- `journal/daemon.jsonl` — the daemon-scoped sibling of the per-task journals (dispatcher
  `worker-spawn`/`worker-exit`, the intake/confirm/triage scanners' own
  `report-intake`/`report-confirmed`/`report-triaged`/`auto-triage` events), and since
  SPO-Pipeline#117 the **`llm-call` events of the intake stages** — `DRAFT_CARD`, `REVIEW_CARD`
  and `TRIAGE_BUG_REPORT`, in the same shape and with the same field names a pipeline step writes
  into `journal.jsonl`. They live here rather than in a task journal because there is no card yet
  when they run: no `ctx.taskDir` exists to write into. One event per `claude` spawn, so a
  deadline-timeout retry and an account rotation each leave two — the doubled call is the shape
  most worth counting, not the one to collapse. `orchestrator/tokens.js` reads BOTH files through
  one accumulator, so there is still exactly one definition of "billable". Before that, the file
  held zero `llm-call` events of any kind and every spend figure the project reported was short by
  the whole of intake; `spo status` shipped a caveat line saying so, now removed.
- **Kanban truth (action 5.1)** — every column change a task causes is journalled, so the board
  and the journal can be reconciled against each other. `board-move` `{column}` on a successful
  move, including **FINISH's move to `Done`**, which was previously the one move that changed the
  board without leaving a record: 14 of the 18 tasks in the corpus have `Merging` as their last
  journalled move while the board reads `Done`, and that is the whole reason. A move made without
  a task worktree (a pre-WORKTREE park) runs from the product repo and carries
  `via: "product-repo"`. `board-move-failed` `{column, exit, timedOut}` on a non-zero exit;
  `board-move-skipped` `{reason, column}` for `already-in-column` (the card is already
  there, no spawn), the vestigial `no worktree` (neither a worktree nor a product repo, which
  the shipped config never produces), or `no issue` (`ctx.task.issue` unset, reachable for any
  task without one — `board.js`'s `moveCard`). A card entering DIAGNOSE for the first time posts one
  comment and journals `diagnose-surfaced` `{attempt, budget}`, or `diagnose-surface-failed`
  `{exit, timedOut}` — never blocking, exactly like a board move.
- **External reconciliation (action 5.1b)** — the board's `Done` on 213/428/443 was reached
  without any pipeline involvement (GitHub's built-in "Item closed" workflow moves the card on
  issue close, re-measured live 2026-09-01), and the JOURNAL was the side that never learned about
  it: 2 of the 3 were `PARKED` for a fix a human made and closed by hand hours later (213, 428);
  the third (443) was `ABANDONED` on a false park — `pr:wait` read `closed false` at 13:17:57,
  parked `pr-closed-unmerged`, and PR #447 actually merged 30 seconds later at 13:18:27, before the
  maintainer's own `abandon` reply at 13:53. Reaching `ABANDONED` at all is `park-loop.js`'s own
  unpark-scan reconciler recognizing an `abandon` reply on a `PARKED` task's issue thread: terminal,
  no re-enqueue, `state.json` written directly as `{state: 'ABANDONED', reason:
  'abandoned-by-maintainer', ...}` — the one park reason in this codebase that is neither thrown as
  a `ParkSignal` nor passed through `finalizePark`, because the task is not re-entering
  `runTask`'s loop at all. The state write happens before the ack comment or any cleanup, so a
  daemon crash at any point afterward resumes into a task that is already correctly terminal.
  `park-loop.js`'s `reconcileExternalClosure`, called
  from inside `unparkScan`'s own loop for every `PARKED`/`ABANDONED` task, reads the owning issue
  and — record, never overwrite — writes `state.json`'s `externallyResolved: {via: 'issue-closed'
  | 'pr-merged', closedAt, prNumber, mergedAt, at}` and journals `reconciled-externally` with the
  same detail, **without ever touching `state.state`**: the task really did park/abandon, and
  fabricating a `DONE` the pipeline never produced would make the journal lie the other way.
  `via: 'pr-merged'` (carrying the PR's own `merged_at`, legible against `closedAt` for 443's own
  30-second gap) only when `state.prNumber` is set and that PR actually merged; `'issue-closed'`
  otherwise (213/428's shape). Idempotent by construction — `state.externallyResolved` itself is
  the guard, so a reconciled task is never re-read — bounding the feature to at most 2 extra
  `gh api` reads per parked task, ever; a still-open parked task IS re-read every `unparkScan`
  cycle (60s by default), 1 read each, 3 today. A failed read (non-zero exit, timeout, unparsable
  JSON) journals `reconcile-scan-failed {step, exit, timedOut}` and never blocks or throws — same
  contract as every other real spawn in this file. `spo parked` (`bin/spo`'s `cmdParked`) prints a
  reconciled row under its own heading, separate from the still-PARKED and still-ABANDONED rows.
- **Judge findings, routed instead of lost (action 5.3)** — measured across all 19 journals
  (2026-09-01): 7 `change-validator PASS_WITH_FINDINGS` events carried a non-empty `findings`
  array (8 finding objects total) and one `citation-verifier DIVERGES` (issue-462,
  2026-08-31T08:35:08Z) — every one journalled and never read again; `PASS_WITH_FINDINGS` returned
  `MERGE` with the findings sitting only in `journal.jsonl`, and `DIVERGES` had nothing recorded
  beyond the bare verdict (`step-contracts.js`'s CITATION_VERIFIER contract requires
  `{verdict, entries}`, but the `citation-verifier` event only ever carried `{verdict}`; fixed —
  `entries` now rides along on both the `PASS` and `DIVERGES` branches). `handleValidate` now
  posts one structured comment on the **issue** (never the PR — this pipeline auto-merges, so
  there is no PR reviewer, and the PR closes on merge while the issue does not; the PR number is
  named inside the body so the link is not lost), before returning `MERGE`: change-validator's
  findings when the verdict is `PASS_WITH_FINDINGS` with a non-empty array, citation-verifier's
  `entries` when the verdict was `DIVERGES` — both in the same comment, in clearly-separated
  sections, when both apply to the same run. `findings` tolerates the same shape divergence
  `plan-files-undeclared` (action 3.2) already learned to expect — every one of the 8 measured
  findings arrived as a JSON-encoded STRING, not a real array — parsing either shape and
  journalling `validate-findings-shape {shape, count}` so a future divergence stays visible rather
  than silently dropped; a malformed payload (unparsable, `null`, an object, an array of
  non-object elements) never throws and never blocks the merge. No follow-up card is ever
  auto-filed on a judge verdict — deliberately: the plan's own "(optionally a follow-up draft
  card)" is the exact unattended-filing shape C3 gated behind a human `confirm` after the
  12.8-hour, 128-attempt auto-triage stall, and a comment is reversible where a filed card is not.
  Journals `validate-findings-posted {count, commentId}` on success,
  `validate-findings-post-failed {exit, timedOut}` on a non-zero `gh` exit or a timed-out spawn —
  never blocking, real mode only, same contract as `diagnose-surfaced`/board moves above.
- **Claude session management**: the `sessionId` of every step is recorded, so any step can
  be reopened for debugging with `claude --resume <sessionId>` (full transcript, continue
  interactively) — `spo resume <task-id>` prints the exact command per step (see below), it does
  not run it. `claude agents` lists live background sessions.
- Console CLI (`bin/spo`; ~20 subcommands ship today, not the four originally planned):
  `spo status` (queue, active tasks + state, bench queue, accounts health, today's token usage) ·
  `spo task <id>` (timeline from the journal) · `spo parked` (parked tasks + reasons) ·
  `spo resume <task-id|session_id>` — **prints** the `claude --resume <sessionId>` command for
  each recorded LLM step, one per line; it never spawns `claude` itself (`bin/spo`'s `cmdResume`)
  · `spo tokens`, `spo accounts`, `spo account add/enable/disable/clear-cooldown/sync-settings`,
  `spo ask`, `spo pull`, `spo pull-reports`, `spo intake`, `spo reports`, `spo triage`,
  `spo recette`, `spo dashboard` among others. `spo dashboard` (`cmdDashboard`, `bin/spo:1257`)
  writes static HTML (the flight deck, plus `health.html` beside it) from the same local surfaces
  or, with `--serve`, runs a live HTTP server (`console/serve.js`) over those surfaces plus host
  CPU/memory and an outbound production-version probe (`--no-prod` turns it off); either way it
  already ships alongside the CLI rather than after it.
- Nothing polls GitHub for state that has a local surface (verdicts, nightly, journals).

## Design consequences from the measured improvisation (v1.1)

The analysis's top families are mostly **states not to have** rather than branches to write:

1. **No shell-read alphabet in orchestrator states.** 164 ad-hoc `grep`/`cat`/`tail`/`ls`
   calls measured, half of them polling for a sub-agent's file. The orchestrator reads
   nothing ad hoc: steps read through their own granted tools, and the orchestrator consumes
   only declared outputs (JSON payloads, exit codes, journal events).
2. **No edit capability outside IMPLEMENT.** 15 blocked driver writes measured (3 aimed at
   the wrong checkout). Only the IMPLEMENT step holds edit tools, and only inside the task's
   worktree.
3. **Every step has a wall-clock deadline.** The "sub-agent hadn't returned" family (18
   episodes: list/ping/re-spawn loops, twice a duplicate executor) becomes: spawn once, wait
   with a deadline, on expiry kill → retry once → PARKED (`deadline.js`'s `callWithDeadline`:
   a state whose `withTimeout` wrapper races out twice in a row — the retry itself also missed
   the deadline, not merely the first attempt — parks `step-deadline-exceeded-twice`, `detail`
   naming the state; a single timeout is retried silently, journalled `deadline-exceeded` but
   never parked). Never two live executors for one
   task. **Two DIFFERENT mechanisms now enforce this, for two DIFFERENT reasons — one story
   before card #239's transport cutover (action A5b, 2026-09-17), a different one since.**
   `git`/`gh`/`npm` commands a scripted step spawns *through `spawnStep`* are still a genuinely
   BLOCKING `child_process.spawnSync` (the JS event loop never yields while one runs): `spawnSync`'s
   own `timeout` option, per `orchestrator/config.js`'s `commandTimeoutsMs` table (see below), is
   what actually kills those, and `deadline.js`'s `callWithDeadline` race around them is a no-op,
   exactly as it always was, for exactly the reason it always was — a blocking `spawnSync` never
   yields the event loop for a JS timer to fire in. LLM steps (PLAN/IMPLEMENT/DIAGNOSE/
   CITATION_VERIFIER/VALIDATE) no longer work this way at all: `steps/llm.js`'s `invokeClaudeReal`
   now drives the vendored Claude Agent SDK's `query()`, an AWAITED ASYNC STREAM that DOES yield
   the event loop — so `callWithDeadline`'s own JS-timer race for these five steps, genuinely a
   no-op before this cutover, became LIVE the moment it landed (`orchestrator/config.js`'s own
   comment on `LLM_STEP_DEADLINE_ENTRIES`, action A2 of the same chantier, says this outright: the
   outer timer every step already raced "becomes LIVE... for the first time"). Two mechanisms
   race for real now, not one live and one inert: the INNER deadline (`step-contracts.js`'s
   `deadlineMsForStep`, armed inside `invokeClaudeReal` itself as a real `setTimeout` that calls
   `options.abortController.abort()`, then confirms the real child's exit before returning — see
   `steps/llm.js`'s own "Deadline handling" header for the full design and the measured
   abort/kill-escalation timing) is the one that actually bounds a single call, designed to always
   fire FIRST; the OUTER deadline (`deadline.js`'s `callWithDeadline`) is retry-once-then-park
   bookkeeping, sized by `orchestrator/config.js`'s `LLM_STEP_DEADLINE_ENTRIES` as the inner
   deadline plus one `STEP_DEADLINE_MS` of margin (clamped to `MAX_TIMER_DELAY_MS`) specifically so
   it never fires before the inner one on a healthy call. Action 2.1 closed an unrelated, still-
   valid gap for `spawnStep`'s own call sites (the scripted-step half above, untouched by this
   cutover): before it, a hung `gh`/`git`/`npm` child
   froze the single-threaded daemon forever, holding the task lock, with nothing to recover it.
   Action 2.1b then found and closed the remaining gap: `board.js`'s `moveCard`, `park-loop.js`'s
   park comment and unpark scan, `report-intake.js`'s report-card/dedup/comment-scan spawns, and
   `intake.js`'s own `gh`/`npm` calls each spawn through their own private `runSync` instead of
   `spawnStep`, and used to carry no timeout at all — every one of them now arms the identical
   class default (`orchestrator/command-timeout.js`, factored out of `spawnStep` for exactly this
   reuse) too. Their failure handling is deliberately different from `spawnStep`'s own
   retry-then-park: none of these four is a mid-task step with something left to park (`moveCard`
   is explicitly best-effort, the other three run in the daemon loop with no task in scope at
   all), so a timeout there is converted into the failure the caller already models — journalled
   with `timedOut: true` so it stays visibly distinct from a plain non-zero exit — never retried,
   never thrown. Every real spawn in the daemon is bounded as of action 2.1b.
4. **Only allowlisted command forms are ever emitted** (58 guard refusals, 26 re-spelling
   episodes measured). The orchestrator's command table is the allowlist; there is nothing to
   re-spell.
5. **PARK is cheap, stalls are not.** PARK is only 18 % of episodes but ~31 % of wasted
   volume: the machine parks early on queue/infra stalls instead of waiting creatively.

## Scripted-step timeouts (action 2.1)

Every real `git`/`gh`/`npm` command any scripted step spawns (`orchestrator/steps/scripted.js`'s
`spawnStep`) is classified by command + leading args and armed with `spawnSync`'s own `timeout`
option, per `orchestrator/config.js`'s `commandTimeoutsMs` -- plus, since action B1.4, the ONE
`bash` call site FINISH's conditional bench-worker reinstall spawns (matched on the exact
`scripts/bench-install.sh` path, never bare `command === 'bash'`, so any OTHER future use of
`bash` in this codebase still falls through to "no class default"):

| Class | Default | Covers |
|---|---|---|
| `git` | 120s | every `git` call (local ops + one round-trip against `origin`) |
| `gh` | 120s | every `gh` call (one REST/GraphQL request — not the CI_CHECKS poll budget above, which bounds the whole loop separately) |
| `npm-ci` | 600s (10 min) | `npm ci` (WORKTREE — a fresh worktree carries no `node_modules`) |
| `npm-gate` | 7800s (130 min), never retried | `npm run gate` (GATE — the bench job). Derived from the bench's own `DEFAULT_WAIT_TIMEOUT_MIN = 120` (7200s), which exits 4 into the designed `gate-timeout` park; our kill stays the last resort behind it. Not retried: a second `npm run gate` re-submits a bench job for the same (worktree, ref), which `job.ts` refuses as a duplicate → exit 2 → a false `gate-dirty-tree` park |
| `npm-run` | 660s (11 min) | every other `npm run <alias>` (`typecheck`, `lint`, `coverage:changed`, `board:take`, `board:move`, `pr:wait`) — bounded below by `pr:wait`'s own internal 600s bound (`scripts/pr-wait.sh`: 20 polls × 30s), so a legitimate "still in the merge queue" `pr:wait` exit is never killed by this timeout first |
| `bench-install` | 900s (15 min) | action B1.4's conditional bench-worker reinstall (`bash scripts/bench-install.sh`) -- never retried on a timeout (spawnStep's own exemption, matching `npm-gate`'s), since a killed `bash` can leave `npm run build:e2e`/`systemctl restart` still running underneath it |

An explicit per-call `timeout` always overrides the class default. Every value has an
`SPO_TIMEOUT_*_MS` env override (see `config.js`).

**Kill → retry once → park, with a class-specific reason.** On a `spawnSync` timeout, Node
reports `status: null` with both `signal` (e.g. `SIGTERM`) and `error.code === 'ETIMEDOUT'` set
— this is branched out *before* the exit-code mapping, so a timeout is never misread as exit 1
(the trap that would otherwise route a hung GATE straight to DIAGNOSE, paying an LLM call to
diagnose a process the daemon itself killed). The killed command is retried once with the same
timeout; if the retry also times out, the task PARKS with a dedicated reason naming the command
class — `git-timed-out` / `gh-timed-out` / `npm-ci-timed-out` / `npm-gate-timed-out` /
`npm-run-timed-out` — never the calling state's own failure reason (so a timed-out GATE parks
`npm-gate-timed-out`, distinct from both `gate-timeout`, the *domain* exit-4 reason `npm run
gate` itself can return, and `DIAGNOSE`, which it never reaches). Both attempts are journaled as
`spawn` events (`attempt: 1`/`2`, `timedOut: true`), so the journal explains the park on its own.

**An EXTERNAL kill is not a timeout, and parks `command-killed-by-signal`.** A child killed by
something outside this process — a deploy restart's SIGTERM, an OOM kill, an operator's `kill` —
sets `signal` but **no `error`** at all, which is exactly what distinguishes it from the timeout
above. `isSpawnTimeout` used to report both as timeouts (`… || result.signal`), contradicting its
own stated contract; every one of the three `timedOut: true` events in the corpus was in fact a
deploy kill, and one of them parked `npm-run-timed-out` after 345 s of a 660 s budget. The kill now
takes the *same* path as a timeout — branched before the exit mapping, `exit: -1`, never routed on,
retried once, `npm-gate`/`bench-install` never retried — and parks under its own reason with the
evidence attached (`commandClass`, `signal`, `ms` vs `timeoutMs`). Deliberately ONE reason rather
than a `<class>-killed` family: the per-class split above exists because a wedged bench and a
wedged `git` need different remedies, whereas "something outside killed us" has one cause and one
remedy whatever the command was — and a reason string is a retry contract, so one new string is one
new contract instead of six. `command-killed-by-signal` is **not** on `TRANSIENT_RETRY_REASONS`,
which keeps the retry semantics of the only case ever observed exactly as they were.

## Daemon-loop and best-effort spawn timeouts (action 2.1b)

Action 2.1's own table above only covers commands a scripted step spawns *through `spawnStep`*.
Four other modules spawn real `git`/`gh`/`npm` through their own private `runSync`, never through
`spawnStep`, and used to carry no timeout at all:

| Module | Spawns | Where it runs |
|---|---|---|
| `board.js` | `npm run board:move` (`moveCard`) | mid-step, called from inside `realWorktree` / `realCheck` / `realGate` / `realMerge` / `postParkComment` |
| `park-loop.js` | `gh issue comment` (park comment, abandon ack), `gh api .../comments` (unpark scan) | after the task is already terminal, or the daemon-loop unpark scan (no task in scope) |
| `report-intake.js` | `npm run report:card`, `gh issue list` (dedup), `gh issue create`, `gh api .../comments` (confirm scan), `gh issue close` | the daemon-loop `autoIntakeMs` / `reportConfirmScanMs` timers (no task in scope) |
| `intake.js` | `gh api issues/<n>`, `gh issue comment`, `gh issue create`, `gh issue edit`, `gh label list` (fileCard's pre-create / amendCard's pre-edit inventory read via `resolveLabelArgs`, issues #196/#198), `npm run board:claim` | the maintainer-facing `spo ask` / `spo pull` path and auto-triage.js's driver (its three LLM steps already carry their own `deadlineMs`) |

All four now arm the identical class default from the same table above, via
`orchestrator/command-timeout.js`'s `armTimeout` (`classifyCommand` + `classTimeoutMs`, factored
out of `steps/scripted.js` so board.js — required *by* `steps/scripted.js` — does not have to
require its classifier back out of it). An explicit per-call `timeout` still wins, same as
`spawnStep`.

The failure handling is deliberately NOT `spawnStep`'s retry-then-`ParkSignal` policy:

- `board.js`'s `moveCard` is explicitly best-effort ("never blocks the task" is its own
  documented rule) and runs mid-step — a throw here would break every one of its callers.
- `park-loop.js`'s park comment and abandon ack run once the task is **already terminal**
  (`state.json`/`report.md` already written) — there is nothing left to park.

  **Card #212:** `buildParkComment` renders one extra plain-language line above the `<details>`
  JSON dump, keyed on the detail's own `gatePassedOnSha`/`testsRan` fields (never on the reason
  string) — `gatePassedOnSha === true` renders a bold statement that the gate had already PASSED
  on that sha and what a `retry` actually does to the pull request (verified against the code, not
  assumed: `reEnqueueTask` restarts the card at INTAKE, and `realWorktree`'s
  `sweepWorktreeLeftovers` rule 3b deliberately `gh pr close`s the still-open PR for this branch
  BEFORE rebuilding it fresh off the current `origin/main`, so the PR is genuinely closed on
  purpose, not just superseded — but rule 3a, immediately before it, already pushed the branch's
  tip to a durable `wip/<id>-<ts>` ref whenever that tip is not an ancestor of `origin/main`, so
  the commits are not lost; only the PR object and its green gate status are); `testsRan === false`
  renders a statement that no test ran on that sha because the bench refused the merge, not because
  a test failed. A detail carrying neither field renders no extra line, so every other park comment
  stays byte-identical to before this action.
- `report-intake.js` and `intake.js` run in the daemon loop or the maintainer-facing CLI path,
  outside any task — `ParkSignal` has no task to attach to.

So in all four, a timeout is converted into the failure the caller already models — the
non-zero-exit path each site already has (`board-move-failed`, `park-comment-failed`,
`unpark-scan-failed`, `abandon-ack-failed`, `report-intake`'s own per-report error entries,
`reportConfirmScan`'s error entries, and every `{ok: false, ...}` return in `intake.js`) — tagged
`timedOut: true` so a hang stays visibly distinct from a plain non-zero exit rather than reading
as an ordinary `gh`/`npm` failure. None of the four retries: each is either a best-effort
side-effect or a daemon-loop scan/CLI call that gets another chance on its own next cycle anyway,
so a retry here would only double the exposure for no gain. Every real spawn in the daemon is
bounded as of this action.

## Shadow mode and promotion

1. Shadow on synthetic tasks: exercise every scripted transition, force each failure exit
   code at least once (kill the worker → 3, dirty tree → 2, timeout → 4).
2. Real S-sized cards: measure **parking rate** and **weighted tokens per merged card**
   (usage-report) against the experiment's baseline (≈ $12 API-equivalent per session,
   2026-08 measurement -- dollars are the superseded unit of that historical baseline; the
   comparison itself is now made in billable-weighted tokens, see `orchestrator/tokens.js`).
3. Promotion when parking rate < ~15 % over a representative batch; the old path retires
   card-type by card-type.

## Recette: the supervised live harness (action 2.9)

Step 2 above ("real S-sized cards") needs *something real* to have actually run before its
numbers mean anything -- shadow mode and `--dry-run` only ever prove the state machine's own
logic against fixtures/canned payloads, never that a real card, run for real, produces the
journal a judge was supposed to see. `spo recette` (`orchestrator/recette.js`) is that
something: one trivial, synthetic `kind: "card"` task, driven through the real pipeline
(`config.real = true`) against a dedicated, distinctly-labelled GitHub issue in the product
repo, under a wall-clock + LLM-step-count cap, asserted against its own journal (not merely
"did it reach DONE"), cleaned up unconditionally on every exit path. **This is the standard
live gate for every chantier from 3 on** -- scenarios are plain data
(`orchestrator/recette.js`'s `SCENARIOS`), and for a `driver: 'inline'` scenario that only
changes what IMPLEMENT is asked to do, adding one really is just a new object literal. That
claim is scoped, not general: a scenario that changes *how* the pipeline is driven, not merely
what it asks IMPLEMENT to do, changes the runner too. Chantier 7 action 7.2 did exactly that:
scenarios now carry a `driver`, `inline` keeps this path unchanged, and `dispatcher` drives the
real `createDispatcher` with real worker children -- which needs its own out-of-process cap,
because the inline cap wraps `deps.spawnSync` and a dispatcher's workers are separate processes. It also forwards all seven
scan-timer env vars as `0` to the scanner child (a separate OS process that re-reads `config.js`
from scratch and never sees the parent's config object) -- six of them are genuinely disabled by
`0` (the `should*`/`shouldScan*` predicates all read `!(x > 0)` as "never due"), but
`SPO_REMOTE_REPORT_PULL_MS` is not one of them: `startRemoteReportPullLoop`'s first `tick()` runs
unconditionally on scanner startup regardless of that value, which only sets the reschedule delay
*after* that first pull. What actually keeps a dispatcher-driver scenario safe from a real
pull-and-ack is a second, explicit refusal -- see below. `parallel-doc-log` (K=2) is the scenario
that exercises this driver.

Refuses to run while a live daemon holds its own `journal/daemon.lock` (read-only check,
`--force` to override). Chantier 6 action 6.4 added a real product-repo mutex
(`orchestrator/product-repo-lock.js`), but recette does not itself take it -- WORKTREE and FINISH
acquire it either way, whichever driver ran them: `inline` reaches them through `drainQueueOnce`
in recette's own process, `dispatcher` through a real `daemon.js --worker` child. The lock is
taken inside those two steps (`steps/scripted.js`'s `withProductRepoLock`), not by whatever drove
them, which is what makes both drivers safe against a concurrent daemon without recette knowing
about the mutex at all. The daemon.lock check above is the coarser, earlier guard: it catches "a live daemon is
running at all" before recette starts, which 6.4's lock (scoped to one WORKTREE/FINISH call) does
not by itself. A `dispatcher`-driver scenario carries a second, unrelated refusal: its real
scanner child inherits `SPO_REMOTE_REPORT_URL` from this process's own environment exactly as it
inherits the zeroed scan timers above, and `remote-report-pull.js`'s first pull is unconditional
-- so recette refuses outright when that env var is set (`--force` to override, for a maintainer
who has confirmed by hand that a real pull-and-ack against `~/.spo-reports` is acceptable), rather
than risk a synthetic recette run making a genuine HTTPS pull against production bug reports. See
`orchestrator/README.md` § Recette for the full design: isolation, the `trivial-doc-log` scenario
and why it is docs-only, the cap and what tripping it does, the assertion set, and cleanup's own
idempotency contract.

## Open questions (tracked, not blocking shadow mode)

- Bug-report transport production → dev is no longer open: `remote-report-pull.js` implements
  the HTTPS pull (`config.remoteReportUrl`), live enough to need the recette refusal above.
  Report schema v1 is still open.
- Board sync depth: view-only export vs writing Status/comment at transitions (current
  lean: write at transitions like today, through the existing board scripts).
- Whether CHECK runs inside the IMPLEMENT session (self-check) or only outside (current
  lean: both — the outside run is the one that counts).

## Park-reason classification

Every park reason the code can produce is classified either transient (`TRANSIENT_RETRY_REASONS`,
keyed on the exact reason string) or terminal — the latter across three declarations:
`TERMINAL_PARK_REASONS` (exact string), `TERMINAL_PARK_REASON_PREFIXES` (`startsWith`), and
`ACCOUNT_POOL_PARK_REASON_FAMILY`, which holds the five account-pool reasons together in one place
so that the *classification* side of renaming or splitting any of them is a single-list edit. (The
rename itself is not: the producer and the partition test's own representative sample must move
too, and the test fails by name until they do.) Disjointness and full coverage are enforced by
`test/park-reason-partition.test.js`.
SPO-Pipeline#85's five GitHub-mergeability-cause reasons (`merge-conflict`, `merge-blocked`,
`merge-behind-base`, `merge-pr-draft`, `merge-checks-failing`) are all terminal.
