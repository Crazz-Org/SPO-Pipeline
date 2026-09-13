# Manual nightly proof of `main`

**Status (2026-09-13).** The Pipeline side is built: `spo nightly` and `spo nightly reprove`
(`orchestrator/nightly-proof.js`, `bin/spo`, `test/nightly-proof.test.js`), plus a label on the
dashboard's Nightly tile. The WebClient side, § B, is **specified here and not built**. Its one
DECISION (§ A.6) was taken by the maintainer on 2026-09-13: **Option A, the last attesting result
wins**. **`classifyNightly` does not change.**

Citations to SPO-WebClient are to `main` at `609928f1`. Citations to this repo are to the commit
this document landed in.

---

## Why: 2026-09-13

- **The red.** Nightly job `job-01789271268730-a5655e` recorded `FAIL` at `609928f1` (still
  `origin/main`'s tip when this was written), finishing `04:00:47Z`. All 13 flows in its log failed
  the same way: `Timed out after 60000 ms waiting for RESP_LOGIN_SUCCESS (for REQ_LOGIN_WORLD)`.
  The log also holds 12 `connect ETIMEDOUT 158.69.153.134:8000` lines, which point at the game
  server.
- **A red on an unchanged tip never clears itself.** `nightlyDue` returns `false` for a sha that
  is already proven *before* it looks at the window (`nightly.ts:246`, ahead of `:261`). Two tests
  pin that behaviour: `nightly.test.ts:489` ("does not re-run when the current main sha was already
  proven, even inside the window past the gap") and `:513`. So tonight's 02:00 window will **not**
  drive `609928f1` again. Only a new commit on `main` re-arms the nightly.
- **What it costs.** By 13:00Z, 39 cards were parked `nightly-main-red`, from 74 park events.
  That reason is terminal (`orchestrator/state-machine.js`, `TERMINAL_PARK_REASONS`), so a green
  nightly releases none of them. Each one needs a `retry`.
- **The `ref` job run at 13:10Z did not prove `main`.**
  - It was `job-01789305042228-5fe39b`, submitted with `--ref=main`. The worker ran
    `git reset --hard main` in `ref/checkout` (`checkout.ts:286`). That checkout's HEAD is the
    *local branch* `main`, and every earlier `reset --hard <ref>` had moved that branch along with
    it. So `main` there meant whatever the previous job had gated: `4492d8da`, the head of
    `claude-pipe/issue-602`, 12 commits on top of `609928f1`.
  - Its report says so: `fingerprints.atStart.head = 4492d8da…` and `baseMain = 609928f1`.
  - verify-gate picked only 2 flows for that diff (`login-spine`, `building-details`).
  - What it does show: at 13:11Z `REQ_LOGIN_WORLD` got an answer (login-spine PASS). That supports
    the "transient blip" reading. It is **not** a proof of `609928f1` over the nightly's flow set.
    § D.2 tracks the `--ref=<branch>` defect.

---

## A. The design

### A.1 A human writes a request; the worker deposits the job

A manual proof is **not** a new way to submit a job. It is a **request marker**:
`~/.spo-bench/nightly/manual-request.json`.

- **Who writes it:** only WebClient's new `request-nightly` CLI command (§ B4), after the human
  gate.
- **Who reads it:** only the worker, from `maybeRunNightly`, in the idle branch
  (`worker.ts:1017`).
- **What the worker does:** it deposits an ordinary `type: 'nightly'` job carrying
  `trigger: 'manual'`, using the same checkout, the same build steps and the same `run.js` drive as
  a scheduled nightly (`worker.ts:902`).

This design keeps constraint 1 (no racing schedulers) by construction:

| What the current design protects | Why a marker keeps it |
|---|---|
| Only the worker's serialized queue drives the live world | The CLI never touches `spool/`, and it never touches `nightly/checkout`, which the worker owns (`nightly.ts:15-20`). The job is still deposited from `maybeRunNightly`, one nightly at a time (`nightly.ts:310-312`). |
| A nightly never starts while anyone waits | The marker is read only in the idle branch, where "the queue came back empty" holds (`worker.ts:1010-1017`). A request made during a busy hour waits there; it does not queue ahead of sessions. |
| `submit` never accepts `--type=nightly` | Unchanged. `cli.ts:141` keeps `['live', 'lease', 'ref']`. `request-nightly` is a separate command that cannot put anything into the spool. |
| "Who may deposit one: the worker alone" (`bench-worker.md` §8) | Still true. A human may *request* one, and the worker decides when to deposit it. |

### A.2 The human gate

Constraint 2 says "not a session's call". Here is what enforces it, and how far each piece goes.

1. **It refuses inside Claude Code.** `CLAUDECODE` is set in every shell Claude Code spawns. It was
   observed in this session's own environment, and nothing in this repo strips it
   (`grep -rn CLAUDECODE orchestrator bin scripts` finds nothing). The check exists in `request-nightly`
   (§ B4, the authoritative copy) and in `spo nightly reprove` (the courtesy copy).
   - *To probe once, on a real run:* that a daemon-spawned PLAN/IMPLEMENT step's shell carries it too.
2. **It needs a terminal, and the human types the sha.** stdin and stdout must both be TTYs, and
   the human types the first 8 characters of the tip. The Bash tool's stdin is not a TTY.
3. **The daemon can't reach it.** `test/nightly-proof.test.js` fails if any module in
   `orchestrator/`, `console/` or `scripts/` requires `nightly-proof.js`, and if any file in
   `prompts/` names the command or the marker.
4. **Every request is recorded.** `requestedBy` records the Unix user, host, tty, entry point and a
   required free-text reason. It appears in `latest.json`, in `nightly/manual/`, in `jobs.jsonl`,
   in `spo nightly` and on the dashboard tile.

**The limit.** Every session runs as the same Unix user, so none of this stops a process that sets
out to evade it: it can unset `CLAUDECODE`, allocate a pty with `script`, or write the marker file
itself. That is the same limit as every other deny rule here (`doc/permissions.md`). What stays
bounded even against a forged request:

- **It cannot invent a green.** A forged request buys one more *real* live drive of the *real*
  tip. `main` turns green only if that drive passes.
- **It cannot clear red with a broken drive.** A manual run that proves nothing never overwrites
  `latest.json` (§ A.3). Without that rule, a manual run with a broken checkout would replace a
  `FAIL` with `ENVIRONMENT`, `classifyNightly` would read that as `unknown`, and `unknown` does not
  park (`steps/scripted.js:1359`). Red would be cleared with no proof at all.
- **It cannot drive the world more often.** Manual drives count against the same 15-minute limit
  as automatic ones (§ A.4).

**Not built, on purpose: a per-sha cap on manual runs.** A cap would be enforced by the same
forgeable TTY interaction as the request itself, so it adds no protection against a session. And
it would block the real case where the game server is still down at the first manual attempt.

**Not built, on purpose: a dashboard button.** The server is GET-only (`console/serve.js:143`),
it listens on the LAN, and nginx hosts a copy externally (SPO-Deploy). A button would add the
first write endpoint to that server. Any session could reach it with `curl`, and a browser button
has no TTY to gate on. The tile shows the result instead.

### A.3 What gets written

**`nightly/latest.json`** gains fields. Every addition is optional, so a reader of the old shape
is unaffected:

```jsonc
{
  "jobId": "job-…", "sha": "<main commit driven>", "verdict": "PASS",
  "submittedAt": "…", "finishedAt": "…", "detail": "…", "logFile": "…",

  "trigger": "scheduled" | "manual",       // absent on files written before this change ≡ "scheduled"
  "scheduledSubmittedAt": "…",             // deposit time of the last SCHEDULED run; a manual write carries it forward
  "requestedBy": {                         // manual only
    "user": "crazz", "host": "…", "tty": "/dev/pts/3",
    "via": "bench-cli" | "spo", "reason": "game server ETIMEDOUT at 04:00, not the code",
    "requestedAt": "…"
  },
  "supersedes": {                          // manual only: a summary of the record this one replaced
    "jobId": "…", "sha": "…", "verdict": "FAIL", "trigger": "scheduled", "finishedAt": "…"
  }
}
```

**When a manual run replaces `latest.json`: only when it attests.** That means `verdict` is `PASS`
or `FAIL` *and* the driven sha equals the requested sha.

- Any other outcome leaves `latest.json` untouched: `ENVIRONMENT` (prepare or fingerprint failed,
  or the deadline killed the drive), `INTERRUPTED`, `STALE`, or "superseded" (the tip moved before
  the deposit). A scheduled nightly's `INTERRUPTED` still overwrites (`worker.ts:228`), because
  there the rule exists so a death "does not leave yesterday's PASS standing". A manual run has no
  such duty: the record it would overwrite is a real measurement of the same sha.
- **Every manual outcome**, attested or not, is written to `nightly/manual/<jobId>.json`. That is
  the same shape plus `requestedSha`, `attested: boolean`, and for an outcome where no job ran,
  `outcome: "superseded" | "already-green" | "prepare-failed"`. The worker never deletes these.

### A.4 How it interacts with the schedule: the decision, and why

**A manual run is independent of the 20 h slot, and counts against the 15-minute drive limit.**

- **The 20 h gap is not reset.** `NIGHTLY_MIN_GAP_MS` answers "has tonight's slot been used"
  (`nightly.ts:50-57`). A manual run does not use that slot: it re-measures one sha because a
  human asked. If it reset the gap, a request served at 01:30 UTC would cancel that night's window
  run for 20 hours, and nothing on the record would say so. Constraint 3 exists to prevent that
  kind of hidden effect. So the worker measures the gap from `scheduledSubmittedAt`, falling back to
  `submittedAt` for older files.
- **Independence costs no extra drives.** `isAlreadyProven` (`nightly.ts:246`) already refuses any
  automatic run on a sha that `latest.json` has attested, whatever wrote that record. If a manual
  run proves `X` at 01:50, the 02:00 window finds `X` proven and does nothing.
- **The 15-minute limit does count manual drives.** `NIGHTLY_MOVE_RATE_LIMIT_MS`
  (`nightly.ts:59-67`) exists to cap how often the live world is driven. It is not a slot. A manual
  run *is* a live drive, so it counts. No automatic move-triggered run fires within 15 minutes of a
  manual deposit, and a manual request is not served within 15 minutes of any nightly deposit. The
  request **waits**; it is not refused. Implementation: pass `lastRunAtMs` (already a parameter of
  `nightlyDue`, `nightly.ts:240`, which `maybeRunNightly` never passes today) as the later of
  `latest.submittedAt` and the newest `nightly/manual/*.json` `submittedAt`.
- **The window rarely decides anything.** Because `isAlreadyProven` runs first, the window path
  (`nightly.ts:261-265`) only decides three cases:
  - the tip can't be resolved;
  - there is no prior record;
  - the tip moved or is unproven, is still inside its 15-minute limit, and the window is open with
    the gap cleared.

  "Reset the counter" would have changed very little, and people tend to overestimate it.

The same paragraph belongs in `scripts/nightly-check.sh`'s header, next to the existing rate-limit
rationale (§ B5).

### A.5 How the result reaches `classifyNightly`: unchanged

A manual run that attests writes the same `verdict` and `sha` fields to the same file.
`classifyNightly` (`steps/scripted.js:405`) reads only those two fields, so it classifies a manual
record exactly like a scheduled one. Nothing else changes either:

- `guardNightlyRed` (`:473`)
- WORKTREE's park (`:1354-1363`)
- `nightly-check.sh` (`:87-117`)
- the dispatch rule in `kanban-workflow.md` § While `main` is red

Constraint 3 is met by the new fields, and the classification ignores them. The dashboard's tile
test pins that `trigger` changes nothing about status.

### A.6 DECISION (taken 2026-09-13: Option A): a manual PASS on the same sha as a scheduled FAIL

This is the one point that changes what the gate's input can say. **The maintainer chose Option A**:
"always the last result, it's logical." Option B is kept below as the record of what was weighed.

- **Option A (chosen): the last attesting write wins.** A manual PASS on `609928f1` turns it
  green. `classifyNightly` and `nightly-check.sh` are unchanged, and `supersedes` keeps the
  disagreement on the record.
  - *Why:* the scheduled run is one sample too. Running at 04:00 does not make it more
    authoritative than the same drive at 14:00.
- **Option B: disagreement reads `unknown`.** If `supersedes.sha === sha` and the verdicts differ,
  classify `unknown`. That means a change to `classifyNightly` and to `nightly-check.sh`, in step.
  - *What it really buys:* less than it seems. `unknown` does not park at WORKTREE
    (`scripted.js:1359`), and the guards only record an event for it (`:480`). So B unblocks
    dispatch exactly as A does, and differs only in *claiming* nothing: the tile reads UNKNOWN, not
    GREEN, until `main` moves.
  - Neither option catches a genuinely flaky regression that gets a lucky manual PASS. What
    protects against re-rolling is the human gate (§ A.2), not the classification.

The WebClient session in § B implements **A**. Nothing in this repo's `classifyNightly`, its guards
or `test/nightly-verdict-semantics.test.js` changes. Revisiting B later would be a separate, reviewed
action here plus a matching `nightly-check.sh` change, never bundled with § B.

---

## B. WebClient companion spec (for a separate SPO-WebClient session)

Scope: `src/e2e/bench/{job,nightly,worker,cli}.ts`, their tests, `scripts/nightly-check.sh`,
`package.json`, `doc/bench-worker.md` §8 and `doc/kanban-workflow.md` § While `main` is red.
No other file needs to change.

### B1. `job.ts`

```ts
export type NightlyTrigger = 'scheduled' | 'manual';

export interface ManualRequester {
  user: string;        // os.userInfo().username
  host: string;        // os.hostname()
  tty: string;         // fs.readlinkSync('/proc/self/fd/0'), or 'unknown'
  via: 'bench-cli' | 'spo';
  reason: string;      // required, trimmed, non-empty
  requestedAt: string; // ISO
}

// JobRequest (job.ts:36) — nightly only; absent ≡ 'scheduled'
trigger?: NightlyTrigger;
requestedBy?: ManualRequester;

// JobsLogLine (job.ts:122) — nightly only
trigger?: NightlyTrigger;
```

`appendJobsLog` copies `trigger` for nightly reports. To make that possible, `JobReport` gains the
same optional `trigger` field, set by `runJob` from the request.

### B2. `nightly.ts`

- `NightlyResult` (`:70`) gains the optional fields listed in § A.3.
- New paths:
  - `manualRequestFile(paths)` → `nightly/manual-request.json`
  - `manualRecordFile(paths, id)` → `nightly/manual/<id>.json`

  Here `id` is the `jobId`. For an outcome where no job ran, it is
  `manual-<epochMs>-<first 8 chars of requestedSha>`.
- `interface ManualRequest { sha: string; requestedBy: ManualRequester }`.
- `readManualRequest(paths)`: returns `null` if the file is absent. If it is unparseable, or `sha`
  is not 40 hex chars, delete it, `log` the reason, and return `null`. A corrupt marker must not
  wedge the idle loop, the same rule as `readNightlyResult` (`:130-138`).
- `nightlyDue` (`:234`): measure the 20 h gap from
  `last.scheduledSubmittedAt ?? last.submittedAt`. `maybeRunNightly` passes `lastRunAtMs` as
  described in § A.4.
- New pure function `manualProofDue(pending: boolean, nowMs: number, lastRunAtMs?: number): boolean`
  returns `!pending && isRateLimitExceeded(lastRunAtMs, nowMs, NIGHTLY_MOVE_RATE_LIMIT_MS)`.
- `maybeRunNightly` (`:305`) checks the manual request **before** the scheduled path:
  1. `pending` (`:310-312`) covers both triggers.
  2. If there is a request but `!manualProofDue(...)`: return `false` and **keep** the request.
  3. If `last` is PASS and `last.sha === request.sha`: write a manual record
     `{outcome: 'already-green'}`, delete the request, return `false`.
  4. Run `prepareCheckout`. On failure: write a manual record with `verdict: 'ENVIRONMENT'`,
     `attested: false` and the failed step; delete the request; **do not** call
     `writeNightlyResult`; return `false`.
  5. Take the fingerprint. On failure: the same as step 4.
  6. If `fingerprint.head !== request.sha`: write a manual record
     `{outcome: 'superseded', requestedSha, sha: fingerprint.head}`, delete the request, return
     `false`. Main moved, and the move trigger will prove the new tip.
  7. Otherwise call `spool.submit({type: 'nightly', …as :353-363…, trigger: 'manual', requestedBy})`.
     Then delete the request and return `true`.
     - Deposit before delete. If the worker crashes between the two, the next tick sees a pending
       nightly (step 1). After that job finishes, the leftover request hits step 3 (if the run
       passed) or re-queues a second drive (if it failed). That second drive is visible and
       rate-limited. Accept it; don't add a lock for it.
  8. The scheduled path is unchanged, except that its deposit sets `trigger: 'scheduled'`.
- `nightlyResultFromReport` (`:376`) takes the request instead of just `submittedAt`. It returns
  the § A.3 shape. For a scheduled run, `scheduledSubmittedAt = submittedAt`.
- New `publishManualResult(paths, report, request)`:
  - Always write the manual record.
  - Call `writeNightlyResult` **only if** `report.verdict` is `PASS` or `FAIL` **and**
    `(report.fingerprints.atStart ?? report.fingerprints.atSubmit).head === request.fingerprint.head`.
  - When it does, set `supersedes` from the previous `readNightlyResult`, and carry
    `scheduledSubmittedAt` forward: take `previous.scheduledSubmittedAt`, or `previous.submittedAt`
    when the previous record was not manual.

### B3. `worker.ts`

- `:373`: if `request.trigger === 'manual'`, call `publishManualResult`. Otherwise keep today's
  `writeNightlyResult`.
- `recoverInterrupted` (`:228`): for a manual nightly, write the manual record with
  `verdict: 'INTERRUPTED'`, `attested: false`. Do **not** touch `latest.json`.
- `BUILD_STEPS`, the `run.js` branch (`:902`), owner-lease checks and the deadline handling are
  unchanged. A manual nightly *is* a nightly.

### B4. `cli.ts`: new command `request-nightly`

`KNOWN_FLAGS` (`:88`) gains `reason` and `via`. `submit`'s whitelist (`:141`) is **unchanged**.
Update its comment so it points at `request-nightly` as the only sanctioned way to ask for a
nightly.

`request-nightly [--reason=<text>] [--via=spo]`. The checks run in this order, and the first
failure wins:

| # | Check | Exit |
|---|---|---|
| 1 | `process.env.CLAUDECODE` set → "refused: running inside a Claude Code session…" | 5 |
| 2 | `!process.stdin.isTTY \|\| !process.stdout.isTTY` → "needs a terminal" | 5 |
| 3 | `--reason` missing or blank → usage | 1 |
| 4 | worker down (`workerAlive`) | 3 |
| 5 | `git ls-remote origin refs/heads/main` in the worker repo, run read-only. It touches no checkout, and a bad result is anything but 40 hex chars | 6 |
| 6 | `latest.json` is PASS at the tip → "already green at <sha> — nothing to re-prove" | 2 |
| 7 | a `manual-request.json` already exists → print its sha, user and time | 2 |
| 8 | a queued or running nightly already targets the tip | 2 |
| 9 | Print: the tip; the current record (verdict, trigger, finishedAt, detail, logFile); every `nightly/manual/*.json` whose `requestedSha` is the tip; and *"This drives the live world on the locked account, through the queue, the next time it is idle."* Then prompt `type the first 8 characters of <tip> to confirm:` — a mismatch or EOF exits 2 | 2 |
| 10 | Write the marker: write a tmp file, then `fs.linkSync(tmp, target)`. `EEXIST` means a race lost, exit 2. Unlink the tmp. Print where the result will land | 0 |

- `via` defaults to `bench-cli`. Only `spo` is otherwise accepted. It is a label and grants nothing.
- Add to the file's header comment: exit codes 5 and 6, and why the command exists apart from
  `submit`.
- `status` (`:287`): add the trigger to nightly lines, and add a `manual request pending: <sha> by
  <user>` line.
- `package.json`: `"bench:nightly-request": "node dist/e2e/bench/cli.js request-nightly"`.

The Pipeline wrapper calls exactly
`node <repo>/dist/e2e/bench/cli.js request-nightly --via=spo --reason=<text>`, with `cwd` set to
the repo and stdio inherited (`orchestrator/nightly-proof.js`, `reprove`).

### B5. `scripts/nightly-check.sh`

- The classification table (`:87-117`) is **unchanged** (Option A, § A.6).
- Append `trigger=<scheduled|manual>` to the GREEN and RED lines, plus
  ` by=<requestedBy.user>` when the trigger is manual. Read both with
  `jq -r '.trigger // "scheduled"'`.
- Header: add the § A.4 paragraph beside the existing `NIGHTLY_MIN_GAP_MS` /
  `NIGHTLY_MOVE_RATE_LIMIT_MS` rationale (`:29-43`). Add § A.3's attest-only rule as the reason a
  manual `ENVIRONMENT` can never show up here.

### B6. Docs

- `bench-worker.md` §8 table:
  - "Who may deposit one" becomes: *The worker alone. A human may request one
    (`npm run bench:nightly-request`), and the worker still deposits it from its idle branch.*
  - Add a row "Manual proof": attest-only replacement of `latest.json`, independent of the 20 h
    slot, counted against the 15-minute limit (with § A.4's why).
  - Update the published-surface JSON block.
- `kanban-workflow.md` § While `main` is red: add one paragraph. *A maintainer who has read the log
  and believes a red is not the code may request a manual proof. A session may not: asking for one
  is asking past rule 1. The proof re-drives the same tip, and turns `main` green only if it
  passes.*
- The invariants list (`bench-worker.md:916-919`): add the manual path.

### B7. Tests the WebClient session must add

- `nightly.test.ts`:
  - `manualProofDue` against the rate limit.
  - Each step of `maybeRunNightly`'s manual branch: request kept while rate-limited; already-green;
    prepare failure leaves `latest.json` **byte-identical**; superseded; deposit carries `trigger`
    and `requestedBy`; request deleted after the deposit.
  - A corrupt marker is deleted and does not throw.
  - The gap is measured from `scheduledSubmittedAt`: a manual record at 01:30 does not suppress a
    02:00 window run for a different sha.
- `worker.test.ts`:
  - A manual PASS or FAIL replaces `latest.json`, with `supersedes` and `scheduledSubmittedAt`
    carried forward.
  - Manual ENVIRONMENT, STALE and INTERRUPTED (via `recoverInterrupted`) leave it untouched and
    write a manual record.
  - A scheduled INTERRUPTED still overwrites it (regression guard).
- `cli.test.ts`:
  - Each row of the B4 table, with injected env, TTY flags and an injected `ls-remote`.
  - `submit --type=nightly` is still refused (regression guard).
- **Mutation check the verifier must run.** Delete the attest-only condition in
  `publishManualResult`. The "prepare failure / ENVIRONMENT leaves latest.json byte-identical"
  test must go red. That condition is what stops a broken manual run from clearing red.

---

## C. Pipeline side (built)

| Command | What it does | Exit |
|---|---|---|
| `spo nightly` | Prints MAIN GREEN/RED/UNKNOWN from `classifyNightly` against `git ls-remote` origin/main. If ls-remote fails it uses the local ref and labels it; it never silently uses a stale tip. Also prints the record, its trigger and who asked, `supersedes`, a pending request, manual runs for the tip, and the cards parked `nightly-main-red`. When red, it shows the reprove hint. | 0 / 1 / 2, the same codes as `nightly-check.sh` |
| `spo nightly reprove --reason "<text>"` | Refuses under `CLAUDECODE` or without a TTY, before spawning anything. Otherwise runs WebClient's `request-nightly` with an inherited terminal. | 5 not a human · 6 bench CLI not built · otherwise WebClient's own code. Exit 1 prints a hint that the companion may not be deployed yet. |

The dashboard's Nightly tile appends ` — manual, by <user>` when `trigger === 'manual'`. Its
status logic is untouched.

**Never** in this repo: anything that writes under `~/.spo-bench`, and any caller of `reprove`
outside `bin/spo`. `test/nightly-proof.test.js` enforces both, and was mutation-checked: removing
each gate condition, adding a daemon-side require, and naming the command in a prompt each turned
it red.

---

## D. Out of scope: follow-ups found while measuring

1. **Root cause of today's red: an unreachable game server maps to `FAIL`.** This is the "Known
   limit" in `bench-worker.md` §8: `run.js` only maps to PASS or FAIL. A run where *every* flow
   fails at `REQ_LOGIN_WORLD` with `connect ETIMEDOUT` to the game server learned nothing about the
   code, so it should be `ENVIRONMENT`. That would have made today `unknown`, with no human needed.
   It's a WebClient change to the driver's verdict mapping. It complements this document rather
   than replacing it: a genuine-looking FAIL that a human suspects is flaky still needs § A.
2. **`submit --type=ref --ref=<branch>` resolves to `ref/checkout`'s own stale local branch.**
   `checkout.ts:286` runs `git reset --hard <ref>` while HEAD sits on local `main`. So `--ref=main`
   gates whatever the previous job left there, and reports it as `main`. The fix is to resolve a
   branch-name ref to `origin/<branch>`, or to detach before resetting. It's a WebClient card.
3. **Deny rules.** A `Bash(*request-nightly*)` / `Bash(*nightly reprove*)` deny belongs in both
   repos' `.claude/settings.json`. Agents can't edit that file, so the maintainer adds it with
   `/update-config`, then runs `spo account sync-settings` here.
4. **Releasing the parks.** A green nightly releases none of the `nightly-main-red` parks. Posting
   `retry` on each is outward-facing and is not automated here. `spo nightly` lists them.
