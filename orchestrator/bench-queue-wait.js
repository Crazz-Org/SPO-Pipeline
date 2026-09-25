'use strict';
// bench-queue-wait.js -- action 6.5's arithmetic for whether GATE's wait limits already cover the
// worst-case wait a card's own bench job can queue behind once K workers can all reach GATE at
// the same time. Its own dependency-free leaf module, for the identical reason product-repo-hold.js
// is one (see that file's header): the arithmetic has more than one reader --
// test/real-steps.test.js pins it, scripts/bench-queue-wait-measure.js re-measures against it --
// and a second hand-copied version is exactly the kind of drift CLAUDE.md's `gh api -f` story is
// about. Nothing in production calls it (card #246, verified 2026-09-24); config.js's
// BENCH_IDLE_WAIT_MAX_MS comment quotes its constants in prose only.
//
// THE SHAPE OF THE WAIT, and why it is not "K x gate duration": SPO-WebClient's
// src/e2e/bench/worker.ts executes "queued jobs strictly one at a time" (that file's own header)
// on a single worker process. A burst of K workers hitting GATE together can queue at most K-1
// SIBLING jobs ahead of the last one submitted -- the same "K-1 OTHER workers" shape
// product-repo-hold.js's own waitBoundMs uses for a different shared, serial resource. A sibling
// is usually a `ref` job (`npm run gate`), but a pipeline worker can also have a `live` drive
// queued: job-01789372589014-426943 (191.7s) came from ~/.spo-worktrees/issue-752 inside that
// card's IMPLEMENT window on 2026-09-14. So a sibling costs the larger of the two maxima.
//
// Ahead of the siblings, the burst can find the worker ALREADY BUSY, with up to TWO jobs rather
// than one. worker.ts's idle branch ("Only when the queue came back empty") calls
// serveMergeQueue() and then the nightly in the SAME tick, and the nightly's own pending check
// (nightly.ts's maybeRunNightly) looks only for another nightly -- so one idle tick can deposit a
// merge-queue `ref` job AND a nightly back to back. Observed once in the corpus: the
// gh-readonly-queue job df36ec and the nightly de0474, deposited 1 ms apart at
// 2026-09-12T13:08:37.587Z, ran back to back (228.9s + 183.1s). A burst landing just after such a
// tick waits behind both. The model therefore charges a HEAD job (the largest of the nightly,
// live and ref maxima -- whatever single job is already running) PLUS one COMPANION ref job (the
// merge-queue entry of that tick). That over-counts when the head is itself the merge-queue job,
// which keeps it a bound. One companion, not several: GitHub's merge queue here runs "one entry
// at a time" (worker.ts's processOldest comment), and the corpus has exactly one two-job tick in
// 515 reports and none larger; serveMergeQueue would deposit one job per queued entry if the
// queue ever held more.
//
// Out of the model, deliberately: a human's bench LEASE (worker.ts's DEFAULT_LEASE_MINUTES = 30,
// MAX_LEASE_MINUTES = 120) and any number of human jobs queued ahead of the burst. Both are
// unbounded by anything the pipeline controls, and both are what the bench CLI's own 120-min
// give-up and FINISH's deferred reinstall (steps/scripted.js's waitForBenchIdle R1 comment) exist
// to absorb.
//
// THE FOUR MEASURED CONSTANTS below -- re-derived for card #246 on 2026-09-24 with
// `node scripts/bench-queue-wait-measure.js` (read-only; that script's header states the method),
// over EVERYTHING on disk: the bench spool's 515 reports (startedAt 2026-09-02T22:40Z to
// 2026-09-22T09:02Z) and the journal's 258 real `npm run gate` spawns (2026-08-29 to 2026-09-22).
// Each is that corpus's MAX, rounded up to the next whole second. None is restated as a literal
// anywhere else except its test pin.
//
//   OWN_GATE_JOB_MAX_MS -- 713s. GATE's own client-observed duration end to end, submission to
//     verdict: n=258, median 251.8s, p95 427.7s, max 712.7s, zero timeouts. CONSERVATIVE BY
//     CONSTRUCTION: the client's clock also runs while the job is queued, so this term re-counts
//     some of the wait the other terms already bound. Measured on the max itself: that 712.7s
//     run (2026-09-12, ending 09:01:45Z) was ~342s queued behind a nightly and a sibling ref job,
//     then 370.3s of its own service. It used to be 239.9s, measured on 23 early spawns.
//
//   SIBLING_REF_JOB_MAX_MS -- 677s. Service time of 'ref'-type jobs -- the type `npm run gate`
//     submits (SPO-WebClient/scripts/bench-gate.sh) and the type a merge-queue entry is gated as
//     -- from each report's own startedAt/finishedAt: n=345, median 232.0s, p95 382.7s, max
//     676.9s (a FAIL; the worst PASS is 587.3s -- the worker is held the same either way). It
//     used to be 161s.
//
//   NIGHTLY_JOB_MAX_MS -- 776s. Same source, 'nightly' reports: n=163, median 215.3s, p95
//     273.1s, max 775.6s (a FAIL; the worst PASS is 291.5s). It used to be 232s.
//
//   LIVE_JOB_MAX_MS -- 316s. Same source, 'live' reports: n=7, median 90.5s, max 316.0s. Not
//     modelled at all before card #246. It competes for the head term and for the sibling term;
//     today it loses both (to the nightly and to ref), so it changes no number yet.
//
// WHY THE OLD VALUES WERE LOW, and why the corpus is the whole spool rather than a window: they
// were measured when this header believed ~/.spo-bench/done was a ONE-DAY sliding window, which
// had been true -- `purgeDone` used to delete every report older than worker.ts's
// DONE_RETENTION_MS (24h). SPO-WebClient 215e1083 (B4.2, 2026-09-03) changed that:
// SPO-WebClient/src/e2e/bench/job.ts's `purgeDone` (line 358) now `continue`s past every name
// that does not `endsWith('.log')`, so only logs rotate and every `.json` report is kept (its own
// doc comment gives the reason). The 3 ref + 2 nightly reports the old values came from were one
// day of early traffic, and ref jobs have slowed since (median 150s before 2026-09-05, 244s from
// 2026-09-12 on, same script with --until/--since). A trailing window would repeat that error:
// measured on 2026-09-24, the last 7 days hold only 13 ref and 4 nightly reports and would pin the
// nightly at 225s -- the bench has been quiet since 2026-09-22, so a window shrinks the bound as
// traffic stops, not as jobs get faster.
//
// A max over a growing corpus can still grow, and NOTHING re-checks these automatically: a test
// against the live spool would not be hermetic, so the suite only pins the literals. Re-running
// `node scripts/bench-queue-wait-measure.js --check` is a MANUAL step -- do it in any bench or
// model audit (next to `node scripts/model-report.js`, doc/model-experiments.md), and before
// quoting the margins below. It exits 1 once the corpus outgrows a pinned value; the fix is a
// deliberate edit here plus in test/real-steps.test.js.
const OWN_GATE_JOB_MAX_MS = 713000;
const SIBLING_REF_JOB_MAX_MS = 677000;
const NIGHTLY_JOB_MAX_MS = 776000;
const LIVE_JOB_MAX_MS = 316000;
const MEASURED = Object.freeze({ OWN_GATE_JOB_MAX_MS, SIBLING_REF_JOB_MAX_MS, NIGHTLY_JOB_MAX_MS, LIVE_JOB_MAX_MS });

// benchQueueWaitBoundMs(workers, measured) --
//   HEAD + COMPANION + (K-1) x SIBLING + OWN_GATE, where
//   HEAD      = max(nightly, live, ref): the one job already running when the burst lands;
//   COMPANION = ref: the merge-queue job an idle tick can deposit alongside a nightly;
//   SIBLING   = max(ref, live): what each OTHER worker can have queued ahead;
//   OWN_GATE  = this card's own gate, client-observed.
// Same defensive `k` normalisation product-repo-hold.js's own waitBoundMs uses (Number.isInteger
// + positive, else 1): a caller with no opinion about K must get TODAY'S single-worker bound,
// never an artificially inflated or NaN one.
//
// At today's values: K=1 776000 + 677000 + 713000 = 2166000ms (~36.1 min); K=2 (this machine's
// real ceiling -- see doc/remediation-progress.md's account-pool section) 2843000ms (~47.4 min);
// K=3 3520000ms (~58.7 min). THE LIMIT THAT FIRES FIRST is the bench CLI's own give-up,
// SPO-WebClient/src/e2e/bench/cli.ts's `DEFAULT_WAIT_TIMEOUT_MIN` (120 min = 7200000ms; exit 4,
// which realGate parks as `gate-timeout`), not npm-gate's 7800000ms spawnSync kill -- config.js's
// npm-gate comment says why that one sits 600000ms above the bench's. Against the 120 min: ~2.5x
// at K=2 and ~2.0x at K=3 (~2.7x and ~2.2x against npm-gate's 130 min), not the ~9.8x this
// comment claimed before card #246. The pipeline's longest real gate run (712.7s, above) is a
// quarter of the K=2 bound. test/real-steps.test.js pins both relationships rather than building
// new machinery.
//
// `measured` defaults to this module's own four constants; it exists so a test can hand in a
// hypothetical corpus (a live drive outlasting the nightly or a ref job, say) and see the head
// and sibling terms follow it -- at today's values live changes neither.
function benchQueueWaitBoundMs(workers, measured = MEASURED) {
  const k = Number.isInteger(workers) && workers > 0 ? workers : 1;
  const head = Math.max(measured.NIGHTLY_JOB_MAX_MS, measured.LIVE_JOB_MAX_MS, measured.SIBLING_REF_JOB_MAX_MS);
  const companion = measured.SIBLING_REF_JOB_MAX_MS;
  const sibling = Math.max(measured.SIBLING_REF_JOB_MAX_MS, measured.LIVE_JOB_MAX_MS);
  return head + companion + Math.max(0, k - 1) * sibling + measured.OWN_GATE_JOB_MAX_MS;
}

module.exports = {
  OWN_GATE_JOB_MAX_MS,
  SIBLING_REF_JOB_MAX_MS,
  NIGHTLY_JOB_MAX_MS,
  LIVE_JOB_MAX_MS,
  benchQueueWaitBoundMs,
};
