# The bench — remediation plan, derived from measurement

> **Derived from `doc/bench-audit-2026-09-02.md`, 2026-09-02.** Every row traces to a
> defect class D1–D11 in that document, and every claim it rests on was measured and then
> re-verified by an adversarial pass. Rows that do not trace to a measured defect are not here.

**This replaces plan rows 8.2–8.7 wholesale**, as `remediation-plan-2026-08.md`'s row 8.1
provided for. The mapping is in §5.

**It does not fit in one chantier, and the reason is not size.** The findings split along a
sharp line: one class is *bleeding now* and is fixed in hours; four are **contract** changes
that must land in a specific order because each makes the next verifiable; the rest are
independent hygiene that can run in parallel. Six chantiers, **B1 first and alone**.

---

## 1 · The three facts that shape the plan

**The gate is currently advisory, silent, and merging.** No gate has driven the live world since
2026-08-30T02:20:36Z; `bench/gate` has not been a required check since 2026-08-29T10:17:40Z; ten
PRs merged with no attestation at all and eleven more behind a gate that skipped the flows its
own artifact named. B1 exists because everything else is worthless while this is true.

**The damaging defect has a three-line fix that already exists.** `scripts/finish.sh:245-247`
reinstalls the worker when a merge touches `src/e2e/bench/` or `scripts/bench-`. The pipeline's
`realFinish` never runs it. That is the whole of the deploy-skew class, and it is why row 8.5's
migration is not the answer.

**The attestation cannot express what it is being asked to prove.** 509 of 509 verdicts carry no
field for liveness. Until B2 lands, no fix anywhere can be *observed* to work — which is exactly
how three and a half days of static-only gates went unnoticed. **B2 gates every later chantier's
evidence.**

---

## 2 · Order

```
B1  restore the gate            ← now, alone, blocking
 └ B2  the attestation carries its evidence   ← blocking for B3-B6's gates
    ├ B3  fail closed, and name the cause
    ├ B4  a history you can join and keep
    ├ B5  supervision, and tests that stay out of production
    └ B6  documents that match the machine     ← coordinate with chantier 9
```

B3–B6 are parallel once B2 lands. B6 overlaps chantier 9's corpus on the bench side; see §4.

---

## 3 · The chantiers

### B1 — Restore the gate

*The bleeding. Two of its five actions are the maintainer's and cannot be done by an agent.*

| # | action | files |
|---|---|---|
| 1.1 | **Preserve the evidence before touching anything.** Copy `~/.spo-bench/ref/checkout/report/e2e/` **and the checkout's `.git`** to a durable location. The 55 merge commits that key 53 verdicts' liveness (D6) exist only in that object store, are reachable from no ref, and are on no remote — `git gc` destroys the mapping. | operational; `doc/bench-audit-2026-09-02.md` §D6 |
| 1.2 | **Fast-forward the product checkout onto `main`.** `/home/crazz/SPO-WebClient` is on `feat/suggestion-report-kind`, 35 commits behind. `bench-install.sh` builds from wherever that checkout sits and the systemd unit pins `WorkingDirectory` there, so a rebuild before this installs three-day-old code from a feature branch. | operational |
| 1.3 | **Rebuild and restart the worker**, then confirm with **one gate artifact whose `live` block shows the stage ran**. `npm run gate -- --live` reaches the live path even under the current stale worker (`--live` is not in `KNOWN_FLAGS`, `cli.ts:88`, so it is passthrough) — use it to confirm the path *before* the restart, and the ordinary path after. | operational |
| 1.4 | **`realFinish` runs the reinstall rule**, and fast-forwards the main checkout as `doc/state-machine-spec.md:134` already promises. Both, in one action — the reinstall without the fast-forward installs the wrong binary and looks like it worked. | `orchestrator/steps/scripted.js` (`realFinish`), `doc/state-machine-spec.md`, `test/` |
| 1.5 | **Restore `bench/gate` to ruleset 21111153** — *last*, and only after 1.3 has produced a live artifact. Restoring a required check while the worker still certifies less than its name promises re-arms a lie. | operational (GitHub) |

**Gate B1**: a gate artifact dated after the restart whose `live` block names driven flows, on a
commit whose diff routes to at least one real flow · **and that drive confirmed from outside the
bench, in `http://158.69.153.134/logs/FIVEINTERFACESERVER/`** — a logon burst inside the job's
window whose shape matches the flows the artifact names, not the nightly's 9-logon signature ·
`bench/gate` present in the ruleset's current `required_status_checks` · full pipeline suite
green · the reinstall rule proven by a test that fails when `realFinish` skips it.

> **The server log is the acceptance test, not the artifact.** The whole of D1/D2 is a system
> whose every self-report agreed with every other and all of them were wrong. No live claim in
> B1-B6 is accepted on the bench's own evidence.

---

### B2 — The attestation carries its evidence

*D1, D4, D5. The contract change everything else is measured against.*

| # | action | files |
|---|---|---|
| 2.1 | **`BenchVerdict` gains what the gate actually did**: `live: {ran, skipped, why, flows}`, `staticProof: {used, why}`, and the existing `merged`/`mergedBase` surfaced rather than dropped. The worker already holds all of it in the artifact and the `JobReport` — this copies, it does not compute. | `src/e2e/bench/verdict.ts`, `worker.ts` (`writeVerdictIn`), `src/e2e/bench/*.test.ts` |
| 2.2 | **The GitHub status stops rendering a static-only PASS identically to a live one.** `statusDescription` names liveness and `merged`. | `src/e2e/bench/verdict.ts` |
| 2.3 | **The pipeline reads the verdict on exit 0 and refuses a routed-but-not-driven PASS.** Today `realGate` reads nothing when the gate exits 0. A card whose diff routes to a flow and whose verdict says the flow never ran is not green — *evidence over silence, and a skipped stage is never a pass.* | `orchestrator/steps/scripted.js` (`realGate`), `orchestrator/state-machine.js`, `test/` |
| 2.4 | **Reuse requires live evidence.** `mayReuseVerdict` matches on `tree + PASS + fingerprintStable` alone; add "the source itself drove the flows this diff routes". Note reuse is **89 records, not 62** — 27 encode it as prose inside `jobId`; **normalise the encoding in the same action** or the check will miss a third of them. | `src/e2e/bench/merge-queue.ts`, `merge-queue.test.ts` |
| 2.5 | **`fingerprintStable` becomes meaningful or goes.** It is `true` 509/509 and structurally cannot be false for a `ref` job: the submit-side fingerprint is the placeholder `"ref:<sha>"` and is waived, leaving two hashes taken on the worker's own just-reset checkout. Either compare the deposited tree to the gated tree — which is what a reader believes it says — or delete the field and let `merged` carry the honest version. **Do not leave a tautology as a reuse precondition.** | `src/e2e/bench/fingerprint.ts`, `worker.ts`, `merge-queue.ts`, `cli.ts` |

**Gate B2**: a synthetic verdict with `live.skipped: true` and non-empty `routing.required`
**fails** the pipeline's gate step in a test · a reuse attempt from a static-only source is
refused in a test · both halves of the reuse encoding covered by one assertion · full suite
green · one real gate artifact and its verdict agree field-for-field on liveness.

---

### B3 — Fail closed, and name the cause

*D7, D8.*

| # | action | files |
|---|---|---|
| 3.1 | **`verify-gate.js` fails closed** when routed flows are skipped for want of `--live`: `BLOCKED`, never `PASS`. This is the defence in depth that makes B1's deploy fix unnecessary to trust. | `scripts/verify-gate.js`, `verify-gate.test.ts` |
| 3.2 | **Unknown stops reading as green, in both repos, once.** `scripts/nightly-check.sh:70-73` maps `ENVIRONMENT|INTERRUPTED` to "MAIN: GREEN"; `orchestrator/steps/scripted.js:292-293` refuses only on `FAIL` with an exact sha match, so `INTERRUPTED` — written precisely so main does not read as proven — passes as green on the path that gates card flow. One semantics, one reader, or delete one of them. | `scripts/nightly-check.sh`, `orchestrator/steps/scripted.js`, `test/` |
| 3.3 | **The seven gate legs get a reachability test each.** `gate-worker-down`, `gate-timeout`, `gate-non-attesting`, `nightlyMainRed`, `main-red-no-merge`, `main-red-refuse-worktree`, `merge-queue-not-landing` have fired **zero times**, and at least one is unreachable as written. A leg nobody has seen fire is not a branch, it is a comment. | `orchestrator/steps/scripted.js`, `orchestrator/state-machine.js`, `test/` |
| 3.4 | **Stop collapsing distinct causes at the wire.** The pipeline parses the job id the CLI already prints and reads `done/<id>.json` for `verdict`, `detail` and `staticProof` before routing — exit 2 currently hides three causes, exit 3 three, exit 1 seven verdicts. | `orchestrator/steps/scripted.js`, `orchestrator/bench-queue-wait.js`, `test/` |
| 3.5 | **The rate limiter that cannot fire.** `src/e2e/config.ts:93,98` set `minIntervalMinutes: 0` and `maxRunsPerDay: 1000`, so `BLOCKED`'s rate-limit path is unreachable. Set real values or remove the path and its documentation. | `src/e2e/config.ts`, `src/e2e/run.ts` |

**Gate B3**: a routed diff gated with no `--live` produces `BLOCKED`, proven in a test · an
`INTERRUPTED` nightly does not read as green on either side, proven twice · every one of the
seven legs fires in a test · full suite green.

---

### B4 — A history you can join and keep

*D6, D8, D9, D11.*

| # | action | files |
|---|---|---|
| 4.1 | **The artifact and the attestation stop being filed under different names.** `verify-gate.js` names the artifact after the post-merge HEAD; `worker.ts:301` keys the verdict on the deposited sha. Record **both** shas in both files, so a join never depends on which one a reader guessed. | `scripts/verify-gate.js`, `src/e2e/bench/worker.ts`, `verdict.ts` |
| 4.2 | **One durable append-only line per job.** `done/` is purged after 24 h, which is why the whole non-attesting vocabulary — DIRTY, ENVIRONMENT, ABANDONED, INTERRUPTED — is invisible in a 509-record corpus. Append to `~/.spo-bench/jobs.jsonl` and purge only the `.log`. | `src/e2e/bench/job.ts`, `worker.ts`, `paths.ts` |
| 4.3 | **Re-gates become visible.** `attempt: 1` in 314 of 314 artifacts, though at least one sha was demonstrably gated twice. | `scripts/verify-gate.js`, `src/e2e/bench/worker.ts` |
| 4.4 | **A nightly drive can be attached to the commit it drove.** All 51 nightly live artifacts are `branch: "local"` and none contains a sha. | `src/e2e/bench/nightly.ts`, `src/e2e/run.ts` |
| 4.5 | **Delete the dead stores, and do not delete the live one.** `journals/` (219 of 219 lines unparseable, no reader ever existed) and `hook-llm/` go. `sessions/` is 94 % test fixtures — but **`sessions/*.finished` is still written by `finish.sh:275-276` and read by `board-take.sh:109-110`**, so a blanket `rm -rf sessions/` breaks the double-claim guard. Sweep by suffix, with a test. | `scripts/`, `~/.spo-bench/` (operational), `test/` |

**Gate B4**: a merged-base gate's artifact and verdict each name both shas and join in either
direction, proven in a test · a job that ends ENVIRONMENT appears in `jobs.jsonl` and survives a
simulated 48 h · the sessions sweep deletes fixtures and preserves `.finished`, proven by a test
that fails if the suffix filter is dropped · full suite green.

---

### B5 — Supervision, and tests that stay out of production

*D10, and the contamination finding.*

| # | action | files |
|---|---|---|
| 5.1 | **A deadline per stage.** `realRunCommand` spawns `git fetch`, `npm ci`, `npm run build:*`, `verify-gate.js` and `run.js` with no timeout and no kill. One wedged job parks every later card `gate-timeout` at two hours each. | `src/e2e/bench/worker.ts`, `worker.test.ts` |
| 5.2 | **The heartbeat reports progress, not existence.** It rides its own `setInterval` and says nothing about the loop; carry `{currentJob, startedAt}` so a client can tell ALIVE from PROGRESSING. | `src/e2e/bench/worker.ts`, `paths.ts` |
| 5.3 | **One staleness contract for the heartbeat.** The bench reads it by **mtime with a 20 s bound**; `console/collect.js`, reached from `bin/spo:1141`, reads it by **content with a 120 s bound**. Two readers, two contracts, one file. | `console/collect.js`, `src/e2e/bench/paths.ts`, `test/` |
| 5.4 | **The SPO-WebClient suite stops writing into the live bench.** 6938 of 7172 `gate-*` logs and 2249 of 2336 `.alive` files are test output in the production corpus. Point every test at a temporary `SPO_BENCH_DIR` — the pipeline already does exactly this (`test/helpers.js:65-80`) and is the model. Add a sweep test that fails if any test path can resolve to `~/.spo-bench`. **Corrected 2026-09-03 by 9.1's verification**: the original wording here cited
`sanctuarize.test.ts:151-156` as the deliberate writer. That file was deleted on 2026-08-29 in
`9a03ac49`, four days before this plan was written — a dangling citation in a remediation row, in
the plan produced by an audit about dangling citations. The live picture, measured: **15 test
files touch the bench dir; 4 name the real `~/.spo-bench` and never set `SPO_BENCH_DIR`** —
`src/__tests__/area-reservation.test.ts`, `src/__tests__/github-api-discipline.test.ts`,
`src/e2e/finish.test.ts`, `src/e2e/verify-gate.test.ts`. Those four are the action. Exactly one
file deletes the variable deliberately, to assert the default — **`src/e2e/bench/paths.test.ts`**
— and that assertion needs a different shape, not an exemption. | `src/e2e/**/*.test.ts`, `src/__tests__/`, a new sweep test |
| 5.5 | **World-lock: a crash must not erase what it was holding.** `acquire()` takes over a dead holder and drops its `pendingRestores` without marking `dirty`, so "a run that aborts before restore blocks every later run until a human clears it" holds only for a clean unwind — and a test pins the erasure as intended. | `src/e2e/world-lock.ts`, `world-lock.test.ts`, `doc/E2E-POLICY.md` |

**Gate B5**: a stage that hangs is killed and reported, in a test · the sweep test fails when a
bench test is pointed at the real corpus · a killed live run leaves the lock `dirty`, in a test ·
`~/.spo-bench/logs/` gains no new empty file across a full SPO-WebClient suite run · full suite
green.

---

### B6 — Documents that match the machine

*D3's documentary half. Small, and it must not be skipped: the pre-push hook dropped a real
check on the strength of a documented promise that had already stopped being true.*

| # | action | files |
|---|---|---|
| 6.1 | **Six documents still promise `bench/gate` is required on `main` with an empty bypass list.** Correct them against the ruleset's actual state at the time of writing — and if B1.5 restored the check, say so with its date rather than restating the old sentence. | `.claude/hooks/pre-push-gate.sh`, `CLAUDE.md`, `doc/bench-worker.md`, `doc/E2E-POLICY.md`, `scripts/deps-gate.sh` |
| 6.2 | **The pre-push hook enforces something again**, or its header stops claiming it does. It reads nothing under `~/.spo-bench/` today. | `.claude/hooks/pre-push-gate.sh` |
| 6.3 | **The worker's own header describes the worker that exists** — it still describes running in the depositing session's worktree, a mode removed in `54fa31dc`. Same for `bench-worker.md`'s fingerprint and live-drive promises. | `src/e2e/bench/worker.ts`, `doc/bench-worker.md` |
| 6.4 | **A doc-constant sweep on the bench side**, in the mould of the pipeline's `park-reason-doc-sweep.test.js` / `doc-constant-sweep.test.js`: pin the required-check list, the verdict vocabulary and the retention constants to their ground truth so the next divergence turns a test red. **Per-fact, never per-file allowlists.** | new test under `src/__tests__/`, `doc/` |

**Gate B6**: every promise about the required check resolves to the ruleset's live state · the
sweep fails when any pinned constant is edited on one side only · full suite green.

---

## 4 · Interaction with chantier 9

Chantier 9 audits the comment and documentation corpus. B6 edits documents on the **bench** side
(`SPO-WebClient`), which is outside chantier 9's declared corpus, so the two do not collide.
**B1.4 and B2.3 do edit `doc/state-machine-spec.md`**, which chantier 9 must not audit until they
land — the same documentary dependency the plan already records for 8.2/8.4/8.6, now carried by
B1 and B2 instead.

`doc/environments.md` is **not** rewritten by this plan. Row 8.4's "versioned boundary contract"
survives as B2.1–B2.3: the schema *is* the contract, and writing it down separately before the
schema exists would document a shape nobody has built.

---

## 5 · What this replaces

| old row | disposition |
|---|---|
| 8.2 "the attestation stops lying" | **kept and widened** → B2, plus B3.1's fail-closed. The original row asked for the field; measurement showed the pipeline must also *read* it and reuse must *check* it |
| 8.3 "kill the stale-build class structurally" | **superseded by B1.4** — self-attested build provenance is a bigger mechanism than the defect needs; the rule already exists in `finish.sh` and is simply never reached. A provenance field remains reasonable and is deliberately **not** planned: it would have detected the incident, but the reinstall rule prevents it |
| 8.4 "draw and freeze the boundary" | **absorbed into B2** — see §4 |
| 8.5 "move the infrastructure into `orchestrator/`" | **stays superseded**, with a corrected rationale: **four of ten defect classes are boundary-shaped, not zero**, and all four are *contract* defects. The migration fixes one class, leaves the boundary that actually hurt untouched, splits an atomic two-file contract change across two repositories, and puts the worker under a restart hook that has already orphaned a card |
| 8.6 "the live gate becomes a first-class pipeline step" | **narrowed to B3.3–B3.4.** Measurement does not support promoting the gate to real states: all seven existing legs have fired zero times. Make the legs real before adding more |
| 8.7 "nightly and main-red re-homed" | **replaced by B3.2 and B4.4** — the defect is not where the nightly lives, it is that two readers disagree about what unknown means and that a nightly drive names no commit |

---

## 6 · What is deliberately not here

- **A worker build-provenance field** (old 8.3). It would have caught the incident, but B1.4
  prevents it, and adding a second mechanism invites the two to disagree. Revisit if B1.4's rule
  is ever bypassed in practice.
- **Moving the bench.** §5, row 8.5.
- **`cache/`** — 3813 files, the corpus's bulk, unaudited. Its update fails on the same 404 and
  corrupt CAB every run; that is a product concern, not a gate concern.
- **The 116 verdicts from the vanished session-worktree era.** Their evidence is gone and no
  action recovers it.
- **Who removed `bench/gate` from the ruleset.** Not answerable from anything readable here; a
  GitHub audit-log question if it matters.
