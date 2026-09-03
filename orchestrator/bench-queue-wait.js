'use strict';
// bench-queue-wait.js -- action 6.5's arithmetic for whether GATE's own npm-gate spawnSync
// timeout (config.js's commandTimeoutsMs['npm-gate']) already covers the worst-case wait a
// card's own bench job can queue behind once K workers can all reach GATE at the same time. Its
// own dependency-free leaf module, for the identical reason product-repo-hold.js is one (see
// that file's header): config.js and test/real-steps.test.js both need the SAME arithmetic, and
// a second hand-copied version is exactly the kind of drift CLAUDE.md's `gh api -f` story is
// about -- a constant restated in two places that quietly stops matching one of them.
//
// THE SHAPE OF THE WAIT, and why it is not "K x gate duration": SPO-WebClient's
// src/e2e/bench/worker.ts executes "queued jobs strictly one at a time" (that file's own header)
// on a single worker process. A burst of K workers hitting GATE together can queue at most K-1
// SIBLING jobs ahead of the last one submitted -- the same "K-1 OTHER workers" shape
// product-repo-hold.js's own waitBoundMs uses for a different shared, serial resource, and for
// the same reason. The nightly is a second, independent complication: worker.ts only starts one
// when "the queue came back empty" (see the `nightly(deps)` call site's own comment), so a
// nightly can never be QUEUED ahead of a ref job -- but it CAN already be RUNNING when the burst
// lands, and since the worker is strictly serial the whole burst then waits behind it once,
// never K times.
//
// THE THREE MEASURED CONSTANTS below, and where each comes from -- none is restated as a literal
// anywhere else:
//
//   OWN_GATE_JOB_MAX_MS -- 239.9s. GATE's own client-observed duration end to end (submission's
//     overhead included), n=23 real `npm run gate` spawns across 20 journals: mean 151.3s, p50
//     130.5s, p90 212.2s, max 239.9s (doc/remediation-progress.md's C3/C4 gate-figure table).
//     This is the worst this card's OWN job has ever taken once the burst clears.
//
//   SIBLING_REF_JOB_MAX_MS -- 161s. The bench's own service-time record for 'ref'-type jobs, the
//     type `npm run gate` submits (SPO-WebClient/scripts/bench-gate.sh). Re-measured directly
//     from `~/.spo-bench/done/*.json` (read-only; timestamps are each report's own startedAt/
//     finishedAt) while building this action: 3 ref reports on disk, durations 123.8/125.4/
//     160.2s -- max 160.2s, rounded up. doc/remediation-progress.md's own C6 measurement pass
//     cites 5 ref samples (123/123/124/125/161s, part of a stated n=8 across both job types);
//     this file's directory held only 3 ref + 2 nightly reports when re-measured for THIS
//     action, days later, on the same machine. THE SPOOL ROTATES, and that is what explains the
//     drop from 8 to 5: SPO-WebClient/src/e2e/bench/job.ts's `purgeDone` (line 217) rmSync's
//     every report whose mtime is older than the retention window it is passed, and worker.ts
//     calls it on each pass with DONE_RETENTION_MS = 24h (worker.ts:109, called at :922). So
//     ~/.spo-bench/done is a ONE-DAY sliding window, and every number below is the worst service
//     time seen within a day, NOT an all-time record -- a genuinely worse job could have run and
//     been swept before either measurement. Recorded plainly because it bounds what these
//     constants can claim: they are a floor on the true max, not the max. The conclusion below
//     survives it anyway, and that is the point of stating it -- npm-gate's 7800000ms clears
//     even the K=3 bound by a factor of ~9.8, so the true max would have to be nearly an order
//     of magnitude worse than a full day of observed traffic before the verdict changed. The two
//     measurements also agree on the max to within 1s (160.2s vs 161s) despite disagreeing on
//     sample count.
//
//   NIGHTLY_JOB_MAX_MS -- 232s. Same directory, 'nightly'-type reports: 2 on disk, 212.5/232.0s
//     -- max 232.0s, matching doc/remediation-progress.md's own 213/213/232s citation on the
//     high end (it also states 3 samples where this re-measurement found 2; the same 24h
//     rotation above is why, and the same floor-not-max caveat applies). ~1.7x a gate's own
//     service time, so a nightly caught mid-run is the single largest term in the worst case
//     below.
//
// WORST CASE for the LAST of K simultaneous submissions: one nightly caught mid-run, then K-1
// sibling GATE jobs each OTHER worker got in ahead of it, then this card's own job finally runs.
// Never restated as a literal outside benchQueueWaitBoundMs itself.
const OWN_GATE_JOB_MAX_MS = 239900;
const SIBLING_REF_JOB_MAX_MS = 161000;
const NIGHTLY_JOB_MAX_MS = 232000;

// benchQueueWaitBoundMs(workers) -- NIGHTLY_JOB_MAX_MS + (K-1) x SIBLING_REF_JOB_MAX_MS +
// OWN_GATE_JOB_MAX_MS. Same defensive `k` normalisation product-repo-hold.js's own waitBoundMs
// uses (Number.isInteger + positive, else 1): a caller with no opinion about K must get TODAY'S
// single-worker bound, never an artificially inflated or NaN one.
//
// At K=2 (this machine's real ceiling -- see doc/remediation-progress.md's account-pool
// section): 232000 + 161000 + 239900 = 632900ms (~10.5 min). At K=3 (shadow-only today):
// 232000 + 2*161000 + 239900 = 793900ms (~13.2 min). Both are dwarfed by npm-gate's own 7800000ms
// (130 min) ceiling -- see config.js's own comment at commandTimeoutsMs['npm-gate'] for the
// verdict this derivation supports: the existing timeout already covers K workers' worst-case
// bench queue wait by more than an order of magnitude, so this action pins the relationship with
// a test rather than building new machinery.
function benchQueueWaitBoundMs(workers) {
  const k = Number.isInteger(workers) && workers > 0 ? workers : 1;
  return NIGHTLY_JOB_MAX_MS + Math.max(0, k - 1) * SIBLING_REF_JOB_MAX_MS + OWN_GATE_JOB_MAX_MS;
}

module.exports = {
  OWN_GATE_JOB_MAX_MS,
  SIBLING_REF_JOB_MAX_MS,
  NIGHTLY_JOB_MAX_MS,
  benchQueueWaitBoundMs,
};
