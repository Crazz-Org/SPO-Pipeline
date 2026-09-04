# The bench — measurement

> **Status: a dated record.** Every figure is true as of 2026-09-02 and nowhere re-verified
> since. Where a number is quoted elsewhere in `doc/`, this file is the source.

Action 8.1 of `remediation-plan-2026-08.md`. The bench is the e2e gate that stands between a
change and `main`: a session or the pipeline runs `npm run gate`, a worker drives the change
against a live world, and an attestation says PASS. It has never been measured. This document
measures the artifacts it actually produced.

The governing method is the plan's own: **measure the corpus, never the code's own account of
itself.** Where the two disagreed, the corpus won every time.

---

## 1 · The sample

`~/.spo-bench/`, 984 MB, plus the two checkouts that write into it. Every population below was
read **in full**; nothing was sampled.

| store | size | what it is |
|---|---|---|
| `verdicts/<sha>.json` | **509** | the attestation. The only bench file the pipeline reads |
| `ref/checkout/report/e2e/gate-<sha>.json` | **304** | the gate artifact — the only place liveness is recorded |
| `~/SPO-WebClient/report/e2e/gate-*.json` | 10 | pre-bench, all 2026-08-21; holds the corpus's only `BLOCKED` |
| `nightly/checkout/report/e2e/live-*.json` | 51 | nightly live drives |
| `done/job-*.{json,log}` | **13 jobs** | the full job record — purged after 24 h |
| `journals/*.jsonl` | 30 files / 219 lines | the bench's own audit trail |
| `sessions/` | 2596 | `.alive` 2336, `.refusals` 211, `.finished` 45, `.driving` 4 |
| `logs/` | 7347 | per-stage logs |
| `world/`, `cache/`, `ref/`, `spool/`, `running/`, `hook-llm/` | | `spool/` and `running/` empty |

Cross-referenced against the 260 SPO-WebClient pull requests merged since 2026-08-21 and the
27-card pipeline journal under `SPO-Pipeline/journal/`.

### Method

A three-part read-only sweep by **Fable 5.1** — corpus, source, boundary — then **every finding
re-verified by Opus running real probes**, one verifier per sweep, each instructed to construct
the most plausible world in which the finding is false and then test that world. Nothing was
executed against the worker, the daemon, GitHub, or the live world; no rebuild, no restart, no
`git pull`. The stale worker binary was preserved deliberately: it is the primary evidence.

The verification was not a formality. It **refuted** five derived claims, **corrected four of
the driver's own numbers**, and found two things all three sweeps missed. Section 6 records what
that says about the method itself.

### Two stores are contaminated, and it matters

The SPO-WebClient test suite writes into the live corpus.

| store | test-written | clean |
|---|---|---|
| `logs/gate-*` (7172) | **6938 (96.7 %)** — 6714 empty, 224 `fake npm: … failed` | 234 |
| `sessions/*.alive` (2336) | **2249 point at `/tmp/.wsg-test/` fixtures** | 83 dead worktrees, 3 real |
| `sessions/*.refusals` (211) | 196 keyed to a fixture | 15 |
| **`verdicts/`, `report/e2e/`, `done/`, `nightly/`, `journals/`** | **0** | **all clean** |

Every headline in this document is computed over the clean stores. The contamination is worth
naming anyway: this project has already been bitten once by tests reaching production state, and
this time they reached the bench's own evidence store. `sanctuarize.test.ts:151-156` writes to
the real bench *deliberately*, to assert the default.

---

## 2 · The incident

Three independent things happened in 24 hours, and the corpus dates all of them.

| when (UTC) | what |
|---|---|
| 2026-08-28T22:23:28 | worker pid 270 starts, from a binary that predates everything below |
| **2026-08-29T10:17:40** | **`bench/gate` dropped from ruleset 21111153** (v47551828 → v48039109). The gate becomes **advisory** |
| 2026-08-29T10:47:23 | **PR #422 merges with no bench verdict at all** — thirty minutes later |
| 2026-08-29T20:39:49 | `e180bfb6` authored: `verify-gate.js` runs live **only with `--live`**, and `worker.ts:482` starts passing it — **one commit, both halves of the contract** |
| 2026-08-30T02:20:12 → 02:20:36 | **the last gate that ever drove the live world** (`gate-52677523`, a merge-queue entry, not a card) |
| **2026-08-30T07:17:57** | `e180bfb6` reaches `main` in PR #435. New script, old worker. The gate goes **silent** |
| 2026-08-30T10:26:08 | the tenth and last un-attested merge |

**The gate was made optional on the 29th and silent on the 30th, by unrelated acts.** Neither
was noticed, because nothing anywhere reports either condition.

### The mechanism is not "the binary is stale"

A `ref` job runs the **gated tree's own** `scripts/verify-gate.js` (`worker.ts:482-486`,
`cwd: request.worktree`), while the worker runs from a binary installed separately. So the
moment `e180bfb6` landed on `main` — and `prepareRef` merges `origin/main` into every ref —
the *callee* had the new contract and the *caller* did not. `grep -c -- '--live'
dist/e2e/bench/worker.js` is **0**; `src/e2e/bench/worker.ts:482` is **1**.

The two clocks are intrinsic: the job body **must** come from the commit under test. That is the
single most important structural fact in this audit, and it is why the fix is not a rebuild.

### Confirmed from outside the bench — the game server's own logs

*Added 2026-09-03 on the maintainer's instruction: a live scenario is confirmed against
`http://158.69.153.134/logs/`, never against the bench's own artifacts. It is the only witness
the system under test cannot write to.*

`FIVEINTERFACESERVER/Survival 26-09-02.log` records every `LOGON ATTEMPT: User=…` with a
timestamp, in UTC. For **2026-09-02**, against the bench's own `done/` records:

| the bench claims | the server shows |
|---|---|
| 5 `nightly` jobs, each *"live drive exited 0 (PASS)"* | **5 bursts of exactly 9 logons** (7 `SPO_test3`, 2 `Crazz`), each opening within a minute of its job's start |
| 8 `ref` gate jobs, each *"verify-gate exited 0 (PASS)"* | **nothing. Not one logon in any of the eight windows** |

```
nightly 03:56:17 → 03:59:51   burst 03:57:04 → 03:59:31
nightly 04:30:23 → 04:33:49   burst 04:31:02 → 04:33:35
nightly 12:52:53 → 12:56:34   burst 12:53:34 → 12:56:17
nightly 16:28:53 → 16:32:24   burst 16:29:46 → 16:32:06
nightly 16:43:57 → 16:47:22   burst 16:44:40 → 16:47:07
ref     04:15 · 04:28 · 14:56 · 14:59 · 16:33 · 16:37 · 16:40 · 16:48   — no logon in any window
```

`world/run-history.json` holds exactly five entries for the day, all `branch: "local"`, matching
the five bursts. **Three witnesses agree, and the third is outside the system under test.**

Two observations for later use:

- **The nightly's signature is 9 logons.** A gate's live drive routes a diff-dependent flow set,
  so it will produce a *different* burst — which is what makes the check discriminating rather
  than merely present/absent.
- One logon sits outside every bench job: `SPO_test3` at 22:20:46, with
  `SPO_test3.IP = 82.165.165.224` as the log's last line. Not attributable to anything in the
  corpus; recorded, not chased.

### Ten merges with no attestation whatsoever

| PR | merged (UTC) | title |
|---|---|---|
| #422 | 08-29T10:47:23 | fix(board-take): surface the real write-failure diagnostic |
| #423 | 08-29T13:08:19 | Fix board scripts: align with renamed Status options |
| #425 | 08-29T14:04:55 | chore(pilot): retire the anti-drift hooks |
| #438 | 08-29T22:34:32 | feat(scripts): report:card, the raw bug-report renderer |
| #440 | 08-30T02:20:08 | feat(server): report-pull endpoint |
| #435 | 08-30T07:20:52 | **fix: gate:local reaches the live world unguarded** |
| #441 | 08-30T08:20:15 | chore(pilot): retire the /next-task driver |
| #444 | 08-30T09:09:43 | chore(pilot): remove the dead heartbeat |
| #445 | 08-30T09:20:09 | feat(report): capture mobile componentChain |
| #446 | 08-30T10:26:08 | feat(report): a "could be better" report kind |

No PR merged before 2026-08-29T10:17:40Z lacks a verdict. **#435 is the commit that introduced
`--live`** — the gate safety fix, merged without a gate, which then silenced the gate.

---

## 3 · Taxonomy

Ordered by what the corpus says they cost, not by how alarming they read.

| # | class | scale | where it lives |
|---|---|---|---|
| **D1** | A PASS attestation does not record whether anything was proven | 509/509 verdicts | the contract |
| **D2** | The gate stopped driving live and nothing reported it | 17 artifacts + 10 reuse copies | deploy skew |
| **D3** | The merge-safety chain has three links; all three are gone | 10 un-attested merges | contract + GitHub |
| **D4** | Reuse propagates a static-only PASS | 89 reuse records | the contract |
| **D5** | `fingerprintStable` cannot be false | 509/509 true | the bench |
| **D6** | Evidence is filed under a different sha than the attestation | 53 of 509 | the bench |
| **D7** | Distinct causes collapse into one verdict, one exit code, one leg | 7 → 1 | the contract |
| **D8** | The whole non-attesting vocabulary is invisible in the corpus | 3 verdicts, 24 h window | the bench |
| **D9** | The journal was unreadable from the first line ever written | 219/219 | the bench |
| **D10** | Liveness is not progress | latent | the bench |
| **D11** | Dead stores, and one that only looks dead | ~11.4 MB | the bench |

### D1 — the attestation says PASS and nothing else

`BenchVerdict` (`verdict.ts:23-67`) has no field for what was proven. **Zero of 509 verdicts
carry a `live`, `flows`, `static` or `detail` key** — not because the bench does not know, but
because `writeVerdictIn` (`worker.ts:307-319`) copies only a capability-exception count out of
the artifact. `statusDescription` (`verdict.ts:162-183`) renders a static-only PASS identically
to a live one: today's `main` tip carries `bench/gate: success, "PASS — base 9b62f3d8 — job
job-01788367243413-e5022e"`.

The pipeline then reads **nothing** on exit 0 (`scripted.js:1347`).

> *A downstream reader wrongly believes:* `verdict: PASS` means the routed flows were driven
> against the live world.

**This is the class that made every other one invisible.** D2 ran for three and a half days
inside a system whose attestation had no way to mention it.

### D2 — the gate stopped driving live

| all 314 gate artifacts | |
|---|---|
| live ran | **83** (82 PASS + 1 ENVIRONMENT) |
| `skipped: true` | **215** |
| `"live": null` | 16 |
| field absent | 0 |

Of the 215 skips, **186 are legitimate** — `"nothing in this diff is observable over the wire"`.
Twenty-nine say `"live stage requires --live (worker-only)"`, and **17 of those 29 name real
flows they did not drive**, inside the artifact that says PASS:

> `"live stage requires --live (worker-only); routed flows: login-spine, people-search,
> politics-read, politics-write, building-details"`

Live drives per ISO week, gate + nightly: **W35 (Aug 24–30) 80 + 40; W36 (Aug 31–Sep 6) 0 + 11.**
The nightly still drives daily — it calls `dist/e2e/run.js` directly (`worker.ts:495-502`) and
never needed the flag, which is why the bench looked alive throughout.

**Of 260 PRs merged since 2026-08-21: 44 (16.9 %) were gated with a live drive**, 109 skipped
with nothing routed, **11 skipped although the diff routed**, 96 have no artifact (all from the
2026-08-22..24 era, when gates ran in per-session worktrees that no longer exist).

**Pipeline exposure, measured — not inferred:**

| | |
|---|---|
| `npm run gate` spawns after 2026-08-30T07:18Z | **15**, all exit 0, **15 of 15 static-only** |
| of those, with flows routed | **13 of 15** (only cards 450 and 475 routed nothing) |
| distinct cards | 14 |
| cards that reached **DONE** on a routed static-only gate | **10** |
| **PRs merged into `main`** behind a routed static-only gate | **11** |

The eleventh is PR #447 (card #443): the PR merged, the card ended `abandoned-by-maintainer` →
`reconciled-externally ABANDONED`. Mapping ground truth: eight `journal/*/gate.log` files name
their artifact verbatim; the rest join on head sha and on `verdict.tree` against
`git rev-parse <artifact.head>^{tree}`, and the two keys agree.

**Nothing anywhere compares the worker's binary to its source or to the tree it gates.**
`worker.json` records `{pid, startedAt, repo, port}` and no build provenance; `workerStatus`
(`src/e2e/bench/paths.ts:143-163`) checks pid liveness and heartbeat age only. The one rule that would have
caught it exists and is never reached — see D3.

### D3 — three links, all gone

1. **The ruleset.** `bench/gate` stopped being required at 2026-08-29T10:17:40Z. Current
   required contexts: `["typecheck + tests"]`. (The `?ruleset_version_id=` query form is
   **silently ignored** and returns current state for every version; only
   `/rulesets/<id>/history/<version>` answers. That is how this nearly went unconfirmed.)
2. **The hook.** `.claude/hooks/pre-push-gate.sh` removed its own attestation check *citing that
   ruleset* — "`bench/gate` is a required status check on `main` with an EMPTY bypass list". It
   now enforces exactly one thing: no push to `main`. It reads nothing under `~/.spo-bench/`.
3. **The pipeline.** `realCiChecks` reads `commits/<sha>/check-runs`. `bench/gate` is a commit
   **status**, not a check-run, so **the pipeline has never observed it at all**. Its only
   live-evidence input is `npm run gate`'s exit code — which D2 made unconditional.

Six documents still promise the opposite, and one of them is the hook that dropped its check.

### D4 — reuse propagates a static-only PASS

`mayReuseVerdict` (`merge-queue.ts:178-188`) matches on **`tree` equality + `PASS` +
`fingerprintStable`**. No age bound, no `baseMain`, no world state — `world-lock` is not
imported anywhere in the bench package — and **no check that the source was itself driven live**.

Reuse is **89 records, not the 62 that carry a `reusedFrom` key**: 27 more encode it as prose
appended inside `jobId` (an encoding change at `19490070`, 2026-08-26). All 89 are tree-equal;
all 89 copy the source's `branch`. Of the 89 sources: 17 ran live, 46 skipped legitimately,
**15 are `requires --live` skips**, 11 have no artifact.

So the blast radius of D2 is **27, not 17** — the 17 direct attestations plus 10 reuse copies
descending from them.

### D5 — `fingerprintStable` is true 509 times and cannot be false

For a `ref` job the submit-side fingerprint is the literal placeholder `"ref:<sha>"`
(`cli.ts:179`) and is explicitly waived (`worker.ts:543-546`). What remains is
`atStart.hash === atEnd.hash`, both taken by the worker on **its own checkout, which
`prepareRef` has just `reset --hard`ed and `clean -fd`ed**, and every writer in between
(`build:server`, `build:e2e`, the artifact) targets a gitignored path. It can only be false if
`fingerprintTree` throws.

Two explanations were offered and one is wrong: it is **not** survivor bias from a `STALE`
filter — `STALE` *is* attested. It is structural.

> *A downstream reader wrongly believes:* `fingerprintStable: true` is a positive finding about
> the tree. `mayReuseVerdict` treats it as a precondition — a precondition that is a tautology.

There is already an honest field in the record doing the job this one pretends to: **`merged`
(64/509)** says "the tree judged is not the tree pushed". `statusDescription` drops it, so a
merged-base PASS and a clean PASS also render identically.

### D6 — the evidence and the attestation are filed under different names

`verify-gate.js` names the artifact after the checkout's HEAD **after** `prepareRef` merged
`origin/main`; `worker.ts:301` keys the verdict on the **deposited** sha. When the gate merged,
the two differ, and every join by sha silently fails.

The separation is perfect: of 393 verdicts written from `ref/checkout`, **248 have an artifact
under their own head and not one of those 248 is `merged:true`**; of the 145 without, 62 are
reuse copies that never ran a gate, **53 are `merged:true`**. From the other side, **55 of the
56 "orphan" artifacts are two-parent merge commits**, 54 provably of a `merged:true` verdict
with `mergedBase === parent1`.

This looked at first like mass evidence loss. It is not — **53 verdicts' liveness is recoverable
by first-parent lookup**, and after that recovery the genuinely unexplained residual is **3**.

> **Operational consequence.** Those merge commits exist **only** in
> `~/.spo-bench/ref/checkout`'s object store, are reachable from no ref, and are on no remote.
> `git gc` there would prune them and destroy the mapping. Preserving `report/e2e/` is not
> enough — **the checkout's `.git` must be preserved too.**

### D7 — collapse

| where | collapses |
|---|---|
| `run.ts:109` | a flow assertion failure and "the world was left dirty" → the same `FAIL` |
| `verify-gate.js` exit code | *whether the live stage ran*, the routed flow list, the static authority, capability exceptions — all discarded |
| `worker.ts:487` | a signal kill or ENOENT → a code FAIL |
| `cli.ts:221-227` | FAIL, BLOCKED, STALE, DIRTY, ABANDONED, INTERRUPTED, ENVIRONMENT → exit 1 |
| pipeline gate legs | exit 2 hides three causes, exit 3 three, exit 1 seven verdicts |

**All seven pipeline gate legs** — `gate-worker-down`, `gate-timeout`, `gate-non-attesting`,
`nightlyMainRed`, `main-red-no-merge`, `main-red-refuse-worktree`, `merge-queue-not-landing` —
**have fired zero times** across the whole journal corpus. A leg that has never fired is a leg
nobody has seen work.

Two readers of the nightly collapse in the same direction, in different repositories:
`scripts/nightly-check.sh:70-73` maps `ENVIRONMENT|INTERRUPTED` to "MAIN: GREEN" against its own
header, and `scripted.js:292-293` refuses only on `FAIL` with an exact sha match — so
`INTERRUPTED`, written by `recoverInterrupted` *precisely so that main does not read as proven*,
passes as green on the path that gates card flow.

### D8 — the non-attesting vocabulary is invisible

`NON_ATTESTING = {DIRTY, ENVIRONMENT, ABANDONED}` (three, not five: `STALE` and `BLOCKED` **are**
attested; `INTERRUPTED` is `done/`-only). A non-attesting outcome writes a `done/` report and no
verdict — and `done/` is purged after 24 h (`worker.ts:106`, `:576`). **The corpus is
structurally unable to show them**, which is why 509 verdicts contain exactly two values.

`BLOCKED`'s rate-limit path cannot fire either: `src/e2e/config.ts:93,98` set `minIntervalMinutes: 0`
and `maxRunsPerDay: 1000`. The corpus's only `BLOCKED` sits in the pre-bench main-checkout store
from 2026-08-21.

Related: `attempt: 1` in **314 of 314** artifacts, though `3ef3d3c3` was demonstrably gated
twice on 2026-08-28. **Re-gates are invisible.**

The 20 FAILs, classified: 7 unit-test, 3 lint, 2 routing-unmapped (with the reason printed in
the artifact), 1 ENVIRONMENT-reported-as-FAIL, 2 merge-conflict, 1 post-fetch failure, 4 from
the vanished session-worktree era. **Five are unobservable, not fourteen.**

### D9 — the journal was never readable

**219 of 219 lines in `journals/*.jsonl` fail `JSON.parse`.** The writer printed a header and
then concatenated a *complete object* as a positional member:

```
{"session_key":"…","branch":"…","timestamp":"…",{"tool":"Bash","path":"…"}}
```

The test that guarded it asserted substrings and never parsed a line. **Nothing ever read the
directory** — it was written for 51 hours and retired with no consumer having existed. The fix
is one line, and there is nothing left to fix it for.

### D10 — liveness is not progress

`realRunCommand` spawns `git fetch`, `npm ci`, `npm run build:*`, `verify-gate.js` and `run.js`
with **no timeout and no kill**. The heartbeat rides its own `setInterval` (`worker.ts:750`),
independent of the loop, and `workerStatus` never looks at the age of `running/`. A worker
blocked in `npm ci` for a day reads ALIVE, while every later card parks `gate-timeout` at two
hours each. Latent: it has not happened.

Two readers, two staleness contracts, on the same heartbeat file: the bench reads it **by mtime
with a 20 s bound**; `console/collect.js` — reached from `bin/spo:1102` — reads it **by
content with a 120 s bound**.

### D11 — dead stores, and one that only looks dead

`sessions/`, `journals/` and `hook-llm/` are the residue of hooks retired 2026-08-29/30:
**~11.4 MB allocated for ~428 KB of bytes**. `sessions/` is 94 % test fixtures and its last
write anywhere was 2026-08-30T09:10:18Z. All four `.driving` pids are dead.

> **But `sessions/*.finished` is live**: still written by `finish.sh:275-276` and read by
> `board-take.sh:109-110`. **A blanket `rm -rf sessions/` would break the double-claim guard.**

---

## 4 · What the corpus cannot say

The honest inverse of section 3, because an audit that only lists defects overstates what is
knowable.

- **Whether any gate before 2026-08-25 drove live.** 116 of 509 verdicts were produced inside
  per-session `SPO-WebClient/.claude/worktrees/<slug>/` checkouts, all dated 2026-08-22..24.
  Those worktrees are gone and took their artifacts with them.
- **Why any non-attesting run aborted**, beyond 24 hours. D8.
- **Which commit a nightly drive proved.** All 51 nightly live artifacts are `branch: "local"`
  and **not one contains a 40-hex string** — a nightly can never be attached to the commit it
  drove.
- **Whether a gate was re-run.** D8, `attempt: 1` everywhere.
- **Who removed `bench/gate` from the ruleset, and when relative to the `--live` change.** The
  history payload's `actor` is null; the two acts are ten hours apart on one day and the
  relationship is not determinable from anything readable here.

---

## 5 · Would the migration have helped?

Plan row 8.5 proposed moving ~7.5 k lines of bench infrastructure into `orchestrator/`. The
plan's current amendment says **0 of 8 defect classes live at the repo boundary**. That is
wrong, and so is the first re-derivation that replaced it.

Applying the definition strictly — *exists only because two separately deployed components talk
through a file/exit-code contract, and would be structurally impossible under one deploy and one
supervision model* — and demanding a **single-repo counterexample** for each class:

| genuinely at the boundary | not |
|---|---|
| **D1** attestation opacity — the schema *is* the wire | D5, D6, D8, D9, D10, D11 — bench-internal |
| **D3** the merge-safety chain | D2 — the intrinsic worker↔job-body boundary, which no relocation removes |
| **D7** exit-code collapse — the exit code *is* the wire | stale docs — a single-repo instance was found in this very audit (`doc/state-machine-spec.md:128` promises FINISH fast-forwards the main checkout; `realFinish` does not) |
| **process-tree ownership across `exec`** — the pipeline's timeout kills `npm`, the `cli.js` grandchild survives | synthetic tests — a deliberate strategy choice: `test/helpers.js:65-80` points every daemon subprocess at a fresh empty `SPO_BENCH_DIR` |

**Four of ten, and the four are contract defects, not location defects.**

**The strongest case *for* migration, stated fairly**: SPO-Pipeline's installed `post-merge`
hook restarts its units on every pull. A worker installed as a third SPO-Pipeline unit would
inherit that, and D2's proximate cause is exactly "never restarted after `--live` landed".

Three measurements defeat it:

1. **`e180bfb6` touched `verify-gate.js`, `worker.ts` and both their test files in one commit.**
   Row 8.5 keeps `src/e2e/*` in the product repo, so that atomic change becomes two PRs in two
   repositories merged at two times. If the product half lands first, **every gate is
   static-only — D2 exactly, as a normal state of the world rather than an accident.**
2. **The boundary that actually hurt survives.** The job body must come from the gated commit.
   8.5 relocates the caller and never the callee.
3. **It adds a failure mode.** `worker.ts:779-780` maps SIGTERM to `process.exit(0)`; a job cut
   mid-flight recovers as `INTERRUPTED`, writes no verdict, and the pipeline parks
   `gate-non-attesting`. Under 8.5 every `git pull` in SPO-Pipeline would park any card
   mid-gate. Not hypothetical — `journal/issue-385` carries `task-orphaned-daemon-restart` at
   2026-08-30T14:09:08Z, with two `lock-stale-taken` events in `journal/daemon.jsonl`.

**Verdict: keep 8.5 superseded, and correct the plan's number in the same edit.** The decisive
evidence is not architectural. It is that **`scripts/finish.sh:245-247` already contains the
three-line rule that would have prevented the entire incident** — reinstall the worker when a
merge touches `src/e2e/bench/` or `scripts/bench-` — and `realFinish` (`scripted.js:1944-1994`)
simply never runs it. When the fix for the damaging class is three lines on one side of the
boundary, moving 7.5 k lines across it is not the proportionate answer.

> **A trap that governs the fix.** `bench-install.sh` builds from whatever
> `/home/crazz/SPO-WebClient` is checked out at. That checkout is on `feat/suggestion-report-kind`
> @ `9352838`, **35 commits behind `origin/main`** — it drifted because the spec promises FINISH
> fast-forwards the main checkout and `realFinish` does not. It *does* contain `e180bfb6`, so a
> rebuild today would restore `--live`; but the systemd unit pins `WorkingDirectory` there, so
> the worker would then run three-day-old bench code off a feature branch. **The reinstall rule
> and the fast-forward must land together**, or the fix installs the wrong binary and looks like
> it worked.

---

## 6 · Limits of the method

- **Read-only, so nothing was exercised.** Every "unreachable" is a static reading of control
  flow plus an absence in the corpus. The one claim that would flip everything if wrong —
  "the running process spawns `verify-gate.js` without `--live`" — rests on the deployed
  binary's text, 29 dated artifacts saying so in prose, the process being 22 hours older than
  the commit, and zero live drives since. No reading was found under which a ref gate drove the
  world after 2026-08-30T02:20:36Z.
- **The premise about model reliability was wrong, and in a way worth recording.** The protocol
  assumed the sweep model's citations are dependable and its conclusions are not. **This time
  the conclusions largely held and the citations did not.** One sweep's broken references are
  all in `.ts` files (`cli.ts` is 310 lines and was cited to `:458`; `fingerprint.ts` is 80 and
  cited to `:277`); the other's are all in shell scripts (`bench-submit.sh` is 15 lines, cited
  to `:65-69`). **Between the two there is no file type whose citations could be trusted without
  re-resolution.** Every citation in this document was re-resolved against the file.
- **Verification refuted five derived claims** and corrected four of the driver's own numbers —
  most consequentially "for 40 % of merged PRs whether the live stage ran is unrecoverable",
  which D6 shows to be false. A single-pass audit would have shipped all of them.
- **Two clocks in the corpus.** `logs/` filename stamps are **local time** while every JSON
  field is UTC. No headline date here is taken from a filename. `ps -o lstart` is a third,
  broken clock: it drifts between reads of a never-restarted process (17:36:44, 17:38:31,
  17:40:04, 17:40:09, 17:40:18 for the same pid), because it derives from
  `now − CLOCK_BOOTTIME` under WSL2 suspend. `worker.json` and `/proc/270` agree to 282 ms.
- **The card↔artifact mapping is exact for the 26 pipeline gate spawns** and inferred nowhere,
  but only 8 `gate.log` files survive (the file is overwritten per run), so the method rests on
  a two-key join validated against those 8.
- **`done/`'s 24 h window is the binding constraint on everything about job outcomes.** The 13
  jobs there are today's. Anything this document says about DIRTY / ENVIRONMENT / ABANDONED /
  INTERRUPTED is read from code, not from history, because the history does not exist.
- **The migration counterfactual in section 5 is reasoning about an unbuilt design.** It rests
  on three measurements rather than on taste, but it remains the least empirical claim here and
  should be the first thing a future pass challenges.
- **Not read line by line:** `flows.ts`, `probe.ts`, `ws-driver.ts`, `live-log.ts`, `routing.ts`,
  and most `.test.ts` siblings. No finding above depends on them.
- **`cache/` (3813 files) was not audited.** It is game assets and the corpus's bulk; its only
  observed property is that its update fails on the same 404 and corrupt CAB every run.
