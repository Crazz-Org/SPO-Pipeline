#!/usr/bin/env node
'use strict';
// Default runtime configuration for the orchestrator daemon.
// Every field here can be overridden by a daemon.js CLI flag (see orchestrator/README.md).

const path = require('path');
const os = require('os');

// The ONLY require in this otherwise-inert data module, and deliberately a dependency-free leaf
// (it requires nothing itself, this file included -- see its header). It owns action 6.4's
// product-repo mutex arithmetic, which BOTH product-repo-lock.js and this file's own
// stepDeadlineMsByState below have to derive from. Requiring product-repo-lock.js instead would
// be a cycle (that file requires this one) and would silently yield NaN deadlines.
const productRepoHold = require('./product-repo-hold');
// MAX_LEASE_AGE_MS is defined in step-contracts.js (which requires nothing local) rather than in
// account-lease.js, because account-lease.js requires THIS file -- see its own comment.
// STEP_CONTRACTS/deadlineMsForStep: action A2 (card #239) generates the five LLM entries of
// stepDeadlineMsByState below FROM STEP_CONTRACTS's own keys (never a sixth hand-written pair of
// lines) and from deadlineMsForStep's own resolution -- see that block's comment.
const stepContracts = require('./step-contracts');
const { MAX_LEASE_AGE_MS } = stepContracts;

const REPO_ROOT = path.join(__dirname, '..');

// cwd policy for real-mode LLM calls (steps/llm.js's invokeClaudeReal, the vendored Agent SDK's
// query() since card #239's transport cutover, action A5b, 2026-09-17 -- no longer `claude -p`
// spawned directly). Shadow mode never spawns anything,
// so it never calls cwdForStep -- this only matters once real mode is actually reached.
//
// Split by where the step's authority lives, not by which model runs it:
//   - orchestration-side steps (DIAGNOSE, VALIDATE, CITATION_VERIFIER) judge artifacts the
//     orchestrator already produced -- diff, gate log, ledger, PR -- and run from this repo's
//     own root.
//   - worktree-side steps (PLAN, IMPLEMENT) read and write the product itself, so they run
//     from inside the task's own product worktree.
//
// WHY this is a policy and not "always the worktree": a live measurement (2026-08, this
// machine) of a `claude -p` call issued from the product worktree showed ~40k input tokens of
// preamble (root + directory-scoped CLAUDE.md files, doc auto-discovery) before the model does
// any work; the same call issued from a lean directory with no such tree was far smaller.
// Multiplied across every PLAN/IMPLEMENT/DIAGNOSE/VALIDATE call in a task, that is real,
// avoidable spend -- so DIAGNOSE/VALIDATE deliberately do NOT run inside the product worktree,
// even though nothing stops their read-only tools from reaching into it.
const WORKTREE_SIDE_STEPS = new Set(['PLAN', 'IMPLEMENT']);

// worktreePath and repoRoot are parameters, not something this function reads off ctx/task --
// shadow mode never calls it, and real mode's one caller (steps/llm.js) is the one place that
// knows both. Falls back to repoRoot for a worktree-side step with no worktreePath yet (should
// not happen once WORKTREE's real mode exists, but a cheap, documented default beats a throw).
function cwdForStep(stepName, { worktreePath, repoRoot } = {}) {
  const root = repoRoot || REPO_ROOT;
  if (WORKTREE_SIDE_STEPS.has(stepName) && worktreePath) return worktreePath;
  return root;
}

const STEP_DEADLINE_MS = 120000;

// See the stepDeadlineMsByState note below: these two are consts rather than inline literals so
// the CI_CHECKS deadline can be derived from the poll budget instead of hand-synchronised.
const CI_CHECKS_MAX_POLLS =
  process.env.SPO_CI_CHECKS_MAX_POLLS !== undefined ? Number(process.env.SPO_CI_CHECKS_MAX_POLLS) : 30;
// Env override for the drain bound below. 0 is meaningful (drain off, pre-drain behaviour
// restored) -- see that field's comment, and dispatcher.js's resolveDrainTimeoutMs, for why only a
// non-finite or negative (or malformed/empty) value falls back to the default rather than 0 doing
// so -- routed through nonNegativeMsFromEnv (defined below) for exactly that reason.
const DRAIN_KILL_GRACE_MS = nonNegativeMsFromEnv('SPO_DRAIN_KILL_GRACE_MS', 60 * 1000);
const DRAIN_TIMEOUT_MS = nonNegativeMsFromEnv('SPO_DRAIN_TIMEOUT_MS', 45 * 60 * 1000);
const CI_CHECKS_POLL_INTERVAL_MS = positiveMsFromEnv('SPO_CI_CHECKS_POLL_INTERVAL_MS', 20000);

// Post-verification hazard fix (action B1.4): bench-install.sh ends in an unconditional
// `systemctl --user restart spo-bench-worker.service` (worker.ts:1636 maps the SIGTERM straight to
// `process.exit(0)`, no drain), and this daemon runs K=2 in production (SPO_WORKERS=2 on the live
// systemd drop-in) -- so a card reaching FINISH's reinstall step can cut a SIBLING card's
// in-flight GATE. That recovers as `gate-non-attesting` (transient-retryable -- see
// state-machine.js's own TRANSIENT_RETRY_REASONS comment) but re-runs WORKTREE through GATE for
// that card, real LLM spend, not merely "a wasted gate". steps/scripted.js's waitForBenchIdle
// polls `~/.spo-bench/spool` and `~/.spo-bench/running` (the SAME two directories `spo status`
// already reports, bin/spo's own collectBenchQueueDepth) before ever invoking bench-install.sh,
// same maxPolls/pollIntervalMs shape as CI_CHECKS_MAX_POLLS/CI_CHECKS_POLL_INTERVAL_MS above.
//
// Hoisted here (not left as literals in steps/scripted.js) for the SAME reason CI_CHECKS_MAX_POLLS
// is: stepDeadlineMsByState's FINISH entry below has to derive from the SAME bound, or a legitimate
// bench-idle wait can outlast the very deadline meant to cover it -- see product-repo-hold.js's own
// finishSyncHoldMs comment for the full account of why this is threaded through as an explicit
// parameter rather than folded into commandTimeoutsMs.
//
// DEFAULT: 180 polls x 5s = 900000ms (15 min) -- deliberately generous relative to the worst
// realistic case (orchestrator/bench-queue-wait.js's own measured constants: a nightly caught
// mid-run, 232000ms, plus up to two queued sibling ref jobs at K=3, 2 x 161000ms -- 554000ms
// total, well under 900000ms), the same "large enough never to legitimately fire" posture
// CI_CHECKS/WORKTREE/FINISH's own deadlines already use, not a tight fit. SPO_BENCH_IDLE_WAIT_
// MAX_POLLS / SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS override.
const BENCH_IDLE_WAIT_MAX_POLLS =
  process.env.SPO_BENCH_IDLE_WAIT_MAX_POLLS !== undefined ? Number(process.env.SPO_BENCH_IDLE_WAIT_MAX_POLLS) : 180;
const BENCH_IDLE_WAIT_POLL_INTERVAL_MS = positiveMsFromEnv('SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS', 5000);
// The product of the two above, computed once so config.js's own FINISH derivation and
// steps/scripted.js's actual poll loop can never restate (and drift from) the same number twice.
const BENCH_IDLE_WAIT_MAX_MS = BENCH_IDLE_WAIT_MAX_POLLS * BENCH_IDLE_WAIT_POLL_INTERVAL_MS;

// Hoisted for the SAME reason CI_CHECKS_MAX_POLLS above is (action 6.4): WORKTREE's and FINISH's
// stepDeadlineMsByState entries are derived from these two, and a field of the export object
// cannot be read while that object is still being built. Both are still exported verbatim as
// `commandTimeoutsMs` / `workers` below -- this only moves the declaration, never the value.
const COMMAND_TIMEOUTS_MS = {
  git: timeoutFromEnv('SPO_TIMEOUT_GIT_MS', 120000),
  gh: timeoutFromEnv('SPO_TIMEOUT_GH_MS', 120000),
  'npm-ci': timeoutFromEnv('SPO_TIMEOUT_NPM_CI_MS', 600000),
  'npm-gate': timeoutFromEnv('SPO_TIMEOUT_NPM_GATE_MS', 7800000),
  'npm-run': timeoutFromEnv('SPO_TIMEOUT_NPM_RUN_MS', 660000),
  // Action B1.4: FINISH's conditional bench-worker reinstall (`bash scripts/bench-install.sh`,
  // command-timeout.js's own 'bench-install' class) -- an `npm run build:e2e` plus a
  // `systemctl --user restart`, neither bounded by any OTHER class's own budget (not npm-ci, not
  // npm-run's pr:wait-sized bound). 15 minutes is generous relative to a measured `build:e2e`
  // (well under it) with headroom for a cold cache; see product-repo-hold.js's own comment for why
  // this does not need to be folded into the product-repo mutex's MAX_LOCK_AGE_MS.
  'bench-install': timeoutFromEnv('SPO_TIMEOUT_BENCH_INSTALL_MS', 900000),
};
const WORKERS = positiveIntFromEnv('SPO_WORKERS', 1);

// Card #211: `npm run gate` exit 3, stderr `WORKER DIED while job <id> was pending: ...`, is the
// gate CLI's OWN liveness read (cli.ts's `workerStatus`) disagreeing with the worker's actual
// state -- not proof the worker died. Measured over the real corpus (7 real `gate-worker-died-
// midjob` parks, 2026-09-11/12): 7 of 7 were a LIVE worker that went on to PASS that exact job
// (`verdict.jobId === the job id printed on stdout`), 4.3-414.1s after the park. The park comment
// is what a maintainer acts on, and the documented response to a park (`retry`) restarts the card
// at INTAKE, destroying an already-green, already-merged-worthy PR -- see this action's own issue
// (#211) for two cards that cost exactly that.
//
// steps/scripted.js's realGate polls `<spoBenchDir>/done/<jobId>.json` (`readGateDoneReport`,
// already used elsewhere in this same function, reused unchanged) before parking under this name
// -- but ONLY when a job id was actually printed (`parseGateJobId(r.stdout)`); the no-job-id exit-3
// sub-causes (`gate-worker-not-built`, `gate-worker-down`) never had a job to poll for and are
// unaffected. Same maxPolls/pollIntervalMs shape as BENCH_IDLE_WAIT_MAX_POLLS/CI_CHECKS_MAX_POLLS
// above -- hoisted here, AFTER COMMAND_TIMEOUTS_MS (unlike those two), because this block's own
// MAX_POLLS ceiling (see GATE_DIED_RECOVERY_MAX_POLLS_CEILING below) needs
// COMMAND_TIMEOUTS_MS['npm-gate'] already resolved -- for the identical reason
// stepDeadlineMsByState's GATE entry below has to derive from the SAME bound, or a legitimate
// recovery wait can outlast the very deadline meant to cover it.
//
// DEFAULT: 90 polls x 5s = 450000ms (7.5 min). Measured against the corpus's own gaps between the
// park and the job's own PASS verdict landing -- 4.3, 15.2, 56.8, 68.3, 145.5, 203.4, 414.1s -- 450s
// is the smallest round bound that saves all 7 of 7; 300s (60 polls) would have saved only 6 of 7,
// missing the 414.1s case. Costs at most 7.5 minutes on a GENUINE worker death, which has 0
// occurrences in the corpus (0 `gate-worker-down`/`gate-interrupted` parks either). SPO_GATE_DIED_
// RECOVERY_MAX_POLLS / SPO_GATE_DIED_RECOVERY_POLL_INTERVAL_MS override.
const GATE_DIED_RECOVERY_POLL_INTERVAL_MS = positiveMsFromEnv('SPO_GATE_DIED_RECOVERY_POLL_INTERVAL_MS', 5000);
// Node's own hard ceiling on a single setTimeout/setInterval delay: signed 32-bit ms
// (2^31 - 1, ~24.8 days). Past it, Node does not throw -- it clamps the delay to 1ms (a stderr TimeoutOverflowWarning only)
// (measured) -- which is what makes an oversized GATE deadline dangerous rather than merely slow:
// a 1ms-clamped `deadline.js` timer re-arms `callWithDeadline` almost instantly, and because
// `withTimeout` abandons the loser rather than cancelling it, `npm run gate` gets spawned a SECOND
// time while the first is still running.
const MAX_TIMER_DELAY_MS = 2147483647;
// Fix-pass finding (adversarial verification of this action, defect 2): the largest poll count
// that keeps the WHOLE derived GATE deadline (npm-gate's own spawnSync timeout + this bound + one
// ordinary step deadline of margin -- the exact `stepDeadlineMsByState.GATE` formula below) at or
// under MAX_TIMER_DELAY_MS. See `boundedPositiveIntFromEnv`'s own header (above the
// module.exports this file ends with) for why `positiveIntFromEnv` alone cannot catch an oversized
// override (`1e10` IS a positive integer). `Math.max(0, ...)`: if `commandTimeoutsMs['npm-gate']`
// and `stepDeadlineMs` alone already exceed the ceiling (an extreme override of
// SPO_TIMEOUT_NPM_GATE_MS), there is no room left for even a single poll -- 0, not a negative
// count, is the honest answer ("this bound cannot be honoured at all", never "poll a negative
// number of times").
const GATE_DIED_RECOVERY_MAX_POLLS_CEILING = Math.max(
  0,
  Math.floor((MAX_TIMER_DELAY_MS - COMMAND_TIMEOUTS_MS['npm-gate'] - STEP_DEADLINE_MS) / GATE_DIED_RECOVERY_POLL_INTERVAL_MS)
);
// Fix-pass round 2, defect 6 (residual overflow): `boundedPositiveIntFromEnv`'s own ceiling check
// only fires when SPO_GATE_DIED_RECOVERY_MAX_POLLS is ITSELF overridden -- an absent override
// returns the literal default (90) without ever consulting the ceiling. That left two paths to the
// exact hazard this whole guard exists to close, neither touching SPO_GATE_DIED_RECOVERY_MAX_POLLS
// at all: SPO_GATE_DIED_RECOVERY_POLL_INTERVAL_MS=1e8 (90 polls x 100,000,000ms alone is
// ~9 billion ms) or SPO_TIMEOUT_NPM_GATE_MS=2147000000 (leaves only ~364,000ms of headroom, well
// under the default 90 x 5000ms recovery bound). Chosen rule: the resolved poll count -- default
// or explicit override alike -- is ALWAYS re-clamped to the ceiling via this outer `Math.min`, so
// which of the three env vars caused the overflow never matters; the poll count is what absorbs
// it (reducing HOW LONG recovery waits, never disabling the deadline's own safety margin). The
// pathological remainder -- npm-gate's timeout plus margin alone already at or past the ceiling,
// so even 0 polls cannot fit -- is not reachable through this value alone; see the GATE
// stepDeadlineMsByState entry below for the final, unconditional clamp that closes it.
const GATE_DIED_RECOVERY_MAX_POLLS = Math.min(
  boundedPositiveIntFromEnv('SPO_GATE_DIED_RECOVERY_MAX_POLLS', 90, GATE_DIED_RECOVERY_MAX_POLLS_CEILING),
  GATE_DIED_RECOVERY_MAX_POLLS_CEILING
);
// The product of the two above, same reason BENCH_IDLE_WAIT_MAX_MS is: config.js's own GATE
// deadline derivation and steps/scripted.js's actual poll loop must never restate (and drift from)
// the same number twice.
const GATE_DIED_RECOVERY_MAX_MS = GATE_DIED_RECOVERY_MAX_POLLS * GATE_DIED_RECOVERY_POLL_INTERVAL_MS;

// ---- card #224: MERGE's own worst-case bound, the half card #211 deliberately deferred --------
//
// THE DEFECT IS THE SAME ONE THE GATE ENTRY BELOW DESCRIBES, and #211's own comment names this
// step by name as the place it had already fired: `callWithDeadline` (deadline.js) races a JS
// timer against the step's promise, `withTimeout` ABANDONS the loser rather than cancelling it,
// and a step whose body blocks the event loop in `spawnSync` past its deadline and only THEN
// awaits hands control to an already-expired timer -- so the step is re-run from scratch while
// the first invocation keeps executing, unaware.
//
// MEASURED IN PRODUCTION, not reasoned about (SPO-WebClient#587,
// ~/.spo-state/journal/issue-587/journal.jsonl): `npm run pr:wait` ran 533842ms (8.9 min) against
// MERGE's INHERITED generic `stepDeadlineMs` of 120000ms -- MERGE had no entry here until this card.
// `probeMergeability`'s first `await pollSleep(...)` yielded 1ms later, `deadline-exceeded` fired,
// and realMerge re-ran from the top -- a SECOND `gh pr merge` enqueue. ~18 minutes later the
// abandoned first invocation was still running `gh pr view` / `git rev-parse` / `git fetch` /
// `git diff` against a worktree the card no longer owned (the second run had already parked it).
// That is the part with real damage potential: an abandoned run racing a `retry` or the orphan
// scan for the same worktree.
//
// THE COUNTS BELOW ARE steps/scripted.js's own, enumerated per path rather than taken from the
// journal's trace -- #587 only shows the spawns that leg happened to reach, and the re-gate path
// (SPO-Pipeline#84) is a further seven `git` spawns the trace never got to. The worst case is
// `realMerge`'s `w1.exit === 4` leg, which is the leg #587 took, run all the way to a
// `merge-conflict` park. Every call site named here is a `spawnStep(ctx, deps, 'MERGE', ...)` in
// steps/scripted.js, and test/real-steps.test.js pins the three per-tool totals against the file
// itself, so an added spawn fails there rather than quietly shrinking this margin:
//
//   npm-run x5 -- board.js's `moveCard` spawns `npm run board:move` through
//                 command-timeout.js's `armTimeout`, which deliberately does NOT retry => 1.
//                 Then w1 and w2, both `npm run pr:wait`, through `spawnStep`, which retries ONCE
//                 on a timeout/kill before throwing => 2 + 2.
//   gh      x8 -- `gh pr merge` plus `probeMergeability`'s `gh pr view`, one per attempt,
//                 MERGE_PROBE_MAX_ATTEMPTS = 3 of them; 4 spawns, each retried once => 8.
//   git    x16 -- `regateAfterNonLandingUnguarded`'s SEVEN (`rev-parse HEAD`, `fetch origin main`,
//                 two `diff --name-only`, `rev-parse origin/main`, `merge origin/main`,
//                 `merge --abort`) plus `readMergeConflictGateFacts`' own `rev-parse HEAD`. Both
//                 helpers are reachable on the SAME park path, not alternatives: a re-gate merge
//                 that conflicts aborts, journals `merge-failed`, returns null, and `realMerge`
//                 then reads the gate facts before parking. 8 spawns, each retried once => 16.
//   polls      -- `probeMergeability` sleeps MERGE_PROBE_POLL_INTERVAL_MS between attempts,
//                 (MERGE_PROBE_MAX_ATTEMPTS - 1) times. Tiny, and folded in anyway because it is
//                 the ONLY `await` in the whole step -- it is precisely the yield that armed the
//                 timer #587 fired.
//
// plus one ordinary step deadline of margin, the identical shape CI_CHECKS' and GATE's own
// entries use. Default total: 5x660000 + 8x120000 + 16x120000 + 2x750 + 120000 = 6301500ms
// (~105 min) -- smaller than the GATE entry's own 8370000ms, and DELIBERATELY large enough never
// to fire, exactly the posture the WORKTREE/FINISH block comment below argues for: the real
// defence against a hung child is spawnSync's own per-command timeout, never this timer.
//
// THE RETRY FACTOR IS NOT PADDING. `spawnStep` retries once on a timeout for every class except
// `npm-gate`/`bench-install` (neither of which MERGE spawns), so a spawn's real ceiling is two
// budgets, not one. Leaving it out would under-derive this entry by 2,880,000ms -- the same
// class of mistake as having no entry at all, only smaller.
//
// Does NOT depend on `workers` (K). Verified by grep, not assumed: every call site of
// `withProductRepoLock` in steps/scripted.js is inside `realWorktree` or `realFinish` -- nothing on
// any MERGE path waits on the product-repo mutex. So, like CI_CHECKS and GATE, this entry needs no
// recompute in daemon.js's `--workers` block; it is inherited through that block's own spread of
// `defaultConfig.stepDeadlineMsByState`.
//
// MERGE_PROBE_* mirror steps/scripted.js's constants of the same name and must stay equal to
// them. config.js is inert data and must not require a step module (see commandTimeoutsMs's own
// comment), and moving the constants here would change `probeMergeability`'s control flow -- out
// of scope for a card whose whole fix is the BUDGET. So they are mirrored, exported below as
// `mergeProbeMaxAttempts`/`mergeProbePollIntervalMs`, and pinned equal to scripted.js's own
// exported values by test/real-steps.test.js rather than trusted to stay in step by hand.
const MERGE_PROBE_MAX_ATTEMPTS = 3;
const MERGE_PROBE_POLL_INTERVAL_MS = 750;
// spawnStep's retry-once-then-park policy (steps/scripted.js): attempt 1 plus at most one retry.
const SPAWN_STEP_MAX_ATTEMPTS = 2;
// `npm run board:move` (moveCard, unretried) + w1 + w2, the latter two retried.
const MERGE_NPM_RUN_SPAWNS = 1 + SPAWN_STEP_MAX_ATTEMPTS * 2;
// `gh pr merge` + one `gh pr view` per probe attempt, all retried.
const MERGE_GH_SPAWNS = SPAWN_STEP_MAX_ATTEMPTS * (1 + MERGE_PROBE_MAX_ATTEMPTS);
// The re-gate path's seven + readMergeConflictGateFacts' one, all retried.
const MERGE_REGATE_GIT_SPAWNS = 7;
const MERGE_GATE_FACTS_GIT_SPAWNS = 1;
const MERGE_GIT_SPAWNS = SPAWN_STEP_MAX_ATTEMPTS * (MERGE_REGATE_GIT_SPAWNS + MERGE_GATE_FACTS_GIT_SPAWNS);
const MERGE_PROBE_POLL_MS = (MERGE_PROBE_MAX_ATTEMPTS - 1) * MERGE_PROBE_POLL_INTERVAL_MS;
// Same unconditional final clamp the GATE entry below carries, for the same reason and against the
// same hazard: every term above is an `SPO_TIMEOUT_*_MS` env override away from being arbitrarily
// large, and a single timer delay over 2^31-1 is SILENTLY clamped by Node to 1ms -- which re-arms
// callWithDeadline almost instantly and recreates, at maximum severity, the very misfire this
// entry exists to prevent. An explicit ceiling of 2147483647ms of margin beats 1ms of none.
const MERGE_STEP_DEADLINE_MS = Math.min(
  MERGE_NPM_RUN_SPAWNS * COMMAND_TIMEOUTS_MS['npm-run'] +
    MERGE_GH_SPAWNS * COMMAND_TIMEOUTS_MS.gh +
    MERGE_GIT_SPAWNS * COMMAND_TIMEOUTS_MS.git +
    MERGE_PROBE_POLL_MS +
    STEP_DEADLINE_MS,
  MAX_TIMER_DELAY_MS
);

// Hoisted out of the `orphanScanMs`/`unparkScanMs` fields below (action 7's scanner-crash-breaker
// fix) so scannerHealthyUptimeMs's own default can be DERIVED from these two instead of a third,
// independently-typed literal that could silently drift from them -- see that field's own comment
// for why THESE two, specifically, are the right derivation source. Still exported verbatim as
// `orphanScanMs` / `unparkScanMs` below; this only moves the declaration, same pattern as
// CI_CHECKS_MAX_POLLS/CI_CHECKS_POLL_INTERVAL_MS above.
const ORPHAN_SCAN_MS = nonNegativeMsFromEnv('SPO_ORPHAN_SCAN_MS', 60 * 1000);
const UNPARK_SCAN_MS = nonNegativeMsFromEnv('SPO_UNPARK_SCAN_MS', 60 * 1000);

// Hoisted out of the `autoTriageMs` field below (action 3.3) so autoTriageBackoffBaseMs can
// default off the SAME resolved value rather than re-parsing SPO_AUTO_TRIAGE_MS a second time and
// risking the two silently drifting apart.
const AUTO_TRIAGE_MS = nonNegativeMsFromEnv('SPO_AUTO_TRIAGE_MS', 0);

// A SPO_TIMEOUT_*_MS override, or the default when the variable is absent OR unusable.
//
// These five values are the only thing standing between a hung `gh` and a daemon frozen forever
// holding the lock, so a malformed one must never silently disarm the bound. A bare
// `Number(process.env.X)` returns NaN for "10m" or "2min" -- and node's spawnSync VALIDATES the
// timeout option and throws RangeError ERR_OUT_OF_RANGE *before spawning*. That turned a typo in
// a systemd drop-in into a synchronous throw out of board.js's moveCard and park-loop.js's
// postParkComment, both documented "never throws" and both running inside finalizePark: the task
// never reaches PARKED, the daemon exits 1, and orphanScan reparks through the same path on
// restart. The same crash-loop shape review found in preserveWorktreeWip.
//
// So: fall back to the DEFAULT, never to "unbounded". A typo should cost you your override, not
// the guarantee the override was tuning. command-timeout.js keeps its own guard for a config
// object assembled by some other caller.
//
// The bound must be a POSITIVE integer, which rules out two values that look benign and are not:
// `Number('')` is 0 and `Number('0')` is 0, and spawnSync reads a timeout of 0 as NO TIMEOUT.
// An empty or zeroed SPO_TIMEOUT_*_MS would therefore disarm the very guarantee it names, which
// is worse than the NaN case because it fails silently instead of loudly. There is deliberately
// no way to disarm a bound through the environment: set an absurdly large value if you need to
// watch a command run to completion.
function timeoutFromEnv(name, defaultMs) {
  const raw = process.env[name];
  if (raw === undefined) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultMs;
  return parsed;
}

// N5 fix (verifier finding, action 3.3 round 2): same fallback idiom as timeoutFromEnv just
// above, minus the integer requirement -- these two feed Date arithmetic
// (`new Date(lastErrorAtMs + triageBackoffMs(...))` in auto-triage.js), never spawnSync's
// timeout option, so a fractional override is harmless. The finite/positive requirement is for
// the identical reason timeoutFromEnv has one: `SPO_AUTO_TRIAGE_BACKOFF_BASE_MS=abc` (or a
// negative value) must not silently disable the backoff by turning
// `Math.min(NaN, ceiling)` (triageBackoffMs) into NaN, where `x < NaN` is always false and every
// report would then be "eligible" immediately, no throttle at all. Excluding non-finite also
// closes the other half of the same failure mode from the OTHER direction: a ceiling of
// `Infinity` is what makes `new Date(...)` throw RangeError in runAutoTriage (N4) -- rejecting it
// here at the config layer means an env override can never reintroduce that crash, only
// auto-triage.js's own defensive clamp (N4) can still see a raw `Infinity` handed in via a
// config object assembled by a test or some future caller that bypasses this file entirely.
function positiveMsFromEnv(name, defaultMs) {
  const raw = process.env[name];
  if (raw === undefined) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return parsed;
}

// Same fallback idiom as positiveMsFromEnv above, for the subset of *_MS timers where 0 is not a
// typo but a documented, load-bearing SENTINEL -- an on/off switch (SPO_ORPHAN_SCAN_MS=0 disables
// that scanner; SPO_AUTO_PULL_MS=0 is the LIVE PRODUCTION setting on the systemd drop-in
// zz-auto-pull-off.conf, and turning it into the 5-minute default here would make the production
// daemon start claiming cards again) or a zero-length settling window (SPO_ORPHAN_GRACE_MS=0 /
// SPO_TRIAGE_CLAIM_GRACE_MS=0 mean "reclaim immediately, skip the anti-race wait"). positiveMsFromEnv
// cannot be reused for these: it rejects 0 by construction, correctly, for its own 12 call sites --
// reusing it here would turn every one of these documented off-switches/zero-windows into its
// default the moment someone set them to the very value that means "off"/"immediately".
//
// A MALFORMED override must still fall back rather than silently disarming the subsystem it names
// -- that is the actual defect this helper exists to close. Before it existed, every one of these
// fields was a bare `Number(process.env.X)`: `Number('abc')` is NaN, and consumers guard with
// `if (!(x > 0)) return false` (or, for lockWatchMs's sibling shape elsewhere, no guard at all) --
// so a systemd drop-in typo silently disabled the scanner/timer it named, or in the no-guard case
// made a `setInterval` fire at 1ms. So: unset, empty/whitespace, non-finite, or negative all fall
// back to the default; zero and positive values (including fractional) pass through unchanged.
function nonNegativeMsFromEnv(name, defaultMs) {
  const raw = process.env[name];
  if (raw === undefined) return defaultMs;
  if (typeof raw === 'string' && raw.trim() === '') return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMs;
  return parsed;
}

// Same fallback idiom as timeoutFromEnv/positiveMsFromEnv above, for a plain POSITIVE INTEGER
// COUNT rather than a duration (action 6.3's SPO_WORKERS / SPO_WORKER_CRASH_LIMIT) -- a bad
// override falls back to the default rather than producing 0 (dispatcher.js would then spawn
// nothing, ever, and the daemon would look alive while doing no work) or a fraction (a K of 1.5
// worker means nothing).
// Same posture as positiveIntFromEnv below, for a knob where 0 IS a legal setting ("take no
// cards off the board") rather than a synonym for "unset". Absent -> the documented default; a
// non-integer (`Number('abc')` is NaN), a fractional or a negative value -> ALSO the documented
// default, never something larger: an operator typo must not be able to raise a rate cap above
// what this file documents. The only way to get a number other than the default is to name it.
function nonNegativeIntFromEnv(name, defaultN) {
  const raw = process.env[name];
  if (raw === undefined) return defaultN;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return defaultN;
  return parsed;
}

function positiveIntFromEnv(name, defaultN) {
  const raw = process.env[name];
  if (raw === undefined) return defaultN;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultN;
  return parsed;
}

// Card #211 fix-pass (adversarial verification): same fallback idiom as positiveIntFromEnv above,
// PLUS an upper bound -- for the narrow class of positive-integer COUNTS that get multiplied by a
// duration and folded into a `stepDeadlineMsByState` entry (today: gateDiedRecoveryMaxPolls alone;
// `ciChecksMaxPolls`/`benchIdleWaitMaxPolls` have the identical unguarded-magnitude gap, filed
// separately). `positiveIntFromEnv` alone is not enough here: `1e10` IS a positive integer, so it
// sails through that guard unchanged, and `maxPolls * pollIntervalMs` can then push the derived
// deadline past Node's own hard ceiling on a single `setTimeout`/`setInterval` delay -- a signed
// 32-bit ms count, `2^31 - 1` (`2147483647`, ~24.8 days). Node does not throw past that ceiling,
// it clamps the delay to 1ms with only a stderr warning (measured) -- so an oversized override does not
// fail loudly: it re-arms `deadline.js`'s own timer to fire almost instantly, reproducing the exact
// retroactive-deadline hazard (`npm run gate` spawned a SECOND time while the first still ran) the
// derived GATE entry exists to close, through the very tunable meant to size it. `maxN` is the
// caller's own pre-computed ceiling (see GATE_DIED_RECOVERY_MAX_POLLS_CEILING below for how GATE's
// is derived); non-finite, non-integer, non-positive, or over that ceiling all fall back to
// `defaultN`, never to something silently larger.
function boundedPositiveIntFromEnv(name, defaultN, maxN) {
  const raw = process.env[name];
  if (raw === undefined) return defaultN;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maxN) return defaultN;
  return parsed;
}

// ---- action A2 (card #239, 2026-09-17): per-state OUTER deadlines for the five LLM steps -------
//
// Action A2 landed AHEAD of action A5b (card #239, 2026-09-17, same day), which then replaced
// steps/llm.js's invokeClaudeReal spawnSync (BLOCKING -- the event loop never
// yielded, so deadline.js's setTimeout could not fire while a real `claude` call ran) with
// an awaited async stream. STALE UNTIL THIS FIX PASS: this comment used to describe A5b in the
// future tense ("the moment that lands... becomes LIVE") -- A5b has since landed (invokeClaudeReal
// now drives the vendored Agent SDK's query(), see steps/llm.js's own header), so the outer timer
// every step already races (deadline.js's callWithDeadline) genuinely IS LIVE now for PLAN/
// IMPLEMENT/DIAGNOSE/CITATION_VERIFIER/VALIDATE, not merely about to become so -- and until THIS
// action (A2), none of the five had an entry below, so
// every one fell back to the generic STEP_DEADLINE_MS (120000ms). A call that legitimately runs
// 900000-1800000ms (LLM_STEP_DEADLINE_MS_BY_STEP, step-contracts.js) would be killed by that 120s
// ceiling on its very first event-loop turn, retried once (a SECOND full LLM call, real spend, per
// deadline.js's callWithDeadline), and parked step-deadline-exceeded-twice -- while
// deadline.js's withTimeout abandons the loser rather than cancelling it, so the first, still
// in-flight call keeps running and keeps spending the account's quota after the lease that was
// guarding it has already been released (state-machine.js's callLlmStep releases in a `finally`,
// the instant callWithDeadline returns OR throws) -- two live `claude` processes on one
// CLAUDE_CONFIG_DIR, the exact state account-lease.js exists to prevent, reopened at the deadline
// layer instead of the lease layer. This is the identical argument this file's own GATE entry
// above already makes for card #211, and the identical production incident MERGE's own
// (separate, un-fixed) defect recorded for card #587.
//
// Same derivation shape as CI_CHECKS/GATE above: the step's own INNER deadline
// (step-contracts.js's deadlineMsForStep -- the timeout that actually bounds one call) plus one
// ordinary STEP_DEADLINE_MS of margin for everything runLlm legitimately does around the call
// itself (prompt fill, journal append, reply parse, token-usage mapping), clamped to
// MAX_TIMER_DELAY_MS exactly as GATE's own entry is. THE INVARIANT THIS BUILDS, stated plainly
// because every other entry in this block exists to keep it true: the inner deadline always fires
// first. This outer timer is retry-once-then-park bookkeeping, and must never be the thing that
// cuts off a call that is still healthy.
//
// Generated from STEP_CONTRACTS's own keys (step-contracts.js), not five hand-written lines: a
// sixth LLM step added to that table with no entry here is exactly the drift this loop makes
// impossible -- see test/llm-step-deadlines.test.js's table-driven pin, which fails the moment a
// STEP_CONTRACTS key has no corresponding (and correctly derived) entry below.
//
// step-contracts.js's own MAX_LEASE_AGE_MS is re-derived alongside this, in the same action,
// because a bound sized for "the outer deadline never fires" (true before this action) is no
// longer safe for "the outer deadline IS the enforced ceiling on one attempt" (true once card
// #239's transport swap lands) -- see that constant's own header for the arithmetic.
const LLM_STEP_DEADLINE_ENTRIES = {};
for (const stepName of Object.keys(stepContracts.STEP_CONTRACTS)) {
  LLM_STEP_DEADLINE_ENTRIES[stepName] = Math.min(
    stepContracts.deadlineMsForStep(stepName) + STEP_DEADLINE_MS,
    MAX_TIMER_DELAY_MS
  );
}

module.exports = {
  // Wall-clock deadline for a single step invocation (scripted or llm), in milliseconds.
  // On expiry the step is treated as killed, retried once, and PARKED if it expires again.
  stepDeadlineMs: STEP_DEADLINE_MS,

  // DIAGNOSE -> IMPLEMENT retry budget: at most this many DIAGNOSE attempts per task,
  // and any root cause seen twice parks immediately even under budget.
  diagnoseBudget: 3,

  // VALIDATE (change-validator) REJECT budget: a separate counter from diagnoseBudget.
  validateRejectBudget: 3,

  // ---- action 4.4: bounded auto-retry for a closed, named allowlist of transient park reasons
  // (state-machine.js's TRANSIENT_RETRY_REASONS: claim-rate-limited, gate-non-attesting, the
  // llm-transport-failed:<STEP> family) -- see finalizePark's own header comment for the full
  // eligibility rule and why these three are facts about the WORLD at that instant rather than
  // facts about the card. This is a narrow, explicit exception to Principle 2's catch-all
  // (doc/state-machine-spec.md), never a generic "retry everything" policy -- every other park
  // reason, including push-pr-failed (measured: all four corpus occurrences are logic failures,
  // `step: commit`, never a network failure), still goes straight to the ordinary park.
  //
  // transientRetryBudget: at most this many auto-retries per task, PER REASON-AGNOSTIC counter
  // (ctx.task.transientRetries, carried on the re-enqueued task.json) -- the 3rd occurrence of
  // ANY allowlisted reason, not just three of the SAME one, exhausts it and parks for real. A
  // human's `retry` reply resets it to 0 (park-loop.js's reEnqueueTask strips the field) -- see
  // that function's own header for why that is the property that keeps a human always able to
  // make progress.
  transientRetryBudget: 2,

  // transientRetryDelaysMs: 1 min, then 5 min. Attempt N (1-indexed) uses index
  // min(N-1, length-1), so a budget raised past this array's length keeps reusing the LAST
  // (longest) delay rather than throwing or silently retrying with no delay at all. The delay is
  // carried on the re-queued task as `notBefore` (an absolute ISO timestamp, not a sleep) and
  // enforced by takeNextTask -- the daemon's drainQueueOnce loop is awaited by runForever, so a
  // literal `sleep` here would stall every OTHER card in the queue for the same 1-5 minutes.
  // Journalled per-attempt (`transient-retry` event) so the attempt number and the wait are both
  // visible in the journal, not just "retrying".
  transientRetryDelaysMs: [60 * 1000, 5 * 60 * 1000],

  // ---- action 1.2 (card #119): the pool-exhaustion WAIT cap -- a SEPARATE mechanism from
  // transientRetryBudget/transientRetryDelaysMs above, sharing none of its budget or delay table.
  // A cooling account-pool park (state-machine.js's ACCOUNT_POOL_PARK_REASON_FAMILY, when a
  // deadline is recoverable -- poolCooldownDeadlineMs) is re-enqueued with `notBefore` set to that
  // deadline instead of parking outright, PROVIDED the accumulated wait for this task
  // (ctx.task.poolWaitMs) does not EXCEED this cap -- the test is `<=`, so exactly at the cap
  // still waits; past it, the card parks `all-accounts-cooling-wait-cap-exceeded` (action 1.3).
  //
  // poolExhaustionWaitCapMs: 12 hours. Basis, measured against this lot's banked corpus (do not
  // re-derive; see this action's own spec) -- two independent numbers, both real:
  //   - the longest genuine pool-wide outage measured is 7.12h: merging all 12 `account-cooldown`
  //     intervals pool-wide gives 7 episodes -- 1.00h x5, 5.00h, 7.12h;
  //   - the worst accumulated single-card wait in the corpus is 5.00h (issue-497).
  // 12h covers the worst OF EITHER measurement with headroom to spare, without being so large that
  // a task can sit re-enqueued for the better part of a day. NEVER cite 16.69h here -- that figure
  // does not reproduce: the whole-cluster span is 16.63h, but it contains a ~3.6h window in which
  // the pool was not limited at all, so it is not an outage duration.
  poolExhaustionWaitCapMs: 12 * 60 * 60 * 1000,

  // CI_CHECKS -> IMPLEMENT retry budget: a separate counter from diagnoseBudget and
  // validateRejectBudget (action 4.3). Before this action, ci-cause-table.js classified on the
  // check NAME, which -- see that file's header -- was never one GitHub Actions actually
  // reports, so CI_CHECKS -> IMPLEMENT had never once fired in production and this budget had
  // nothing to guard. It ships in the same commit as the fix that makes the path reachable: a
  // lint/coverage failure IMPLEMENT cannot fix would otherwise bounce CI_CHECKS <-> IMPLEMENT
  // forever, free and unlogged, the moment the classification bug above is corrected.
  ciRetryBudget: 3,

  // ---- action 6.5: the main-moved re-gate counter (GATE and CI_CHECKS share it -- action 4.2
  // made that sharing explicit; this action only changes what the counter is compared against).
  //
  // THE DECISION THIS DEFAULT RECORDS, settled by the maintainer rather than re-derived here:
  // the GitHub merge queue serializes LANDING, not semantics -- two merged PRs with disjoint
  // files but interacting behaviour can both land without either ever being re-gated against the
  // other, and the main-moved test below (both realGate's and realCiChecks') only catches a
  // FILE-INTERSECTING move, not a bare one. Two ways to close that gap were considered and both
  // declined:
  //   - a dispatcher-held MERGE admission token, measured at +42s/card at K=2 -- declined on that
  //     cost, which still stands. "Would not even fix the semantics it was built for" was slightly
  //     too absolute as written (SPO-Pipeline#84). A MERGE-only token DOES prevent a sibling from
  //     landing while this card is itself inside MERGE, which covers the one incident recette.js
  //     records (PR #632 landed while PR #633 sat in the queue -- both cards in MERGE at once).
  //     It does NOT close the window #84 is about: that window opens at realCiChecks' intersection
  //     test and runs through VALIDATE and through the wait for the token itself, so a sibling
  //     HOLDING the token can land inside it, and this card then enters MERGE gated against a main
  //     that has already moved -- the same file-intersecting park, un-prevented. #84 closes that
  //     whole window at MERGE instead (for the subset of outcomes GitHub's probe can name), and
  //     far more cheaply: a `git fetch` + the same set comparison, conditioned on GitHub's own
  //     probe attesting the base moved -- see realMerge's regateAfterNonLanding. For the gap this
  //     block is actually about, below -- disjoint files, interacting behaviour -- the original
  //     claim stands unqualified: no re-gate test, token or none, catches the interaction.
  //   - widening the intersection test to "main moved at all", the one option that WOULD buy the
  //     semantic safety -- costs ~6-8% more bench load, declined against an unquantified risk
  //     that already has a backstop (the nightly, which drives every merged main and would catch
  //     an interaction the pipeline missed).
  // So: accept the gap explicitly, the nightly is the accepted backstop, and this budget is
  // exactly what the CI_CHECKS/GATE spec rows now say ("configurable ... once at the default").
  // Narrower than when this was written: #84 closed the file-intersecting case's own
  // GATE-to-merge-queue-landing window at MERGE, conditional on GitHub attesting
  // `merge-conflict`/`merge-behind-base`; what remains accepted here is the disjoint-files,
  // interacting-behaviour case, plus any file-intersecting one whose cause that probe cannot name.
  //
  // THE NUMBER ITSELF is a MODEL, not a measurement, and is written down as one rather than
  // dressed up as derived from data that does not exist. It was derived against the THEN-20-task
  // journal, which contained ZERO `main-moved` events -- because every one of those 20 tasks ran
  // at K=1, structurally unable to merge a sibling card's PR while another of its own cards was
  // live. Both halves of that premise have since changed, and the model has NOT been re-derived
  // against them (re-verified 2026-09-06):
  //   - K>1 has run for real. The daemon runs SPO_WORKERS=2 (see `WORKERS` above, doc/operating.md's
  //     env table, and the live workers.conf systemd drop-in), and the daemon journal records
  //     genuinely overlapping workers on 2026-09-04 -- issue-509 was spawned while issue-508 was
  //     still running, among several such pairs.
  //   - The corpus is no longer 20 tasks: the journal now holds 62 task directories, and two of
  //     them park on the main-moved path under that K=2 run -- issue-510 `main-moved-conflict`
  //     (GATE) and issue-509 `main-moved-merge-failed` (CI_CHECKS), both 2026-09-04. No
  //     `main-moved-merge` SUCCESS event exists in any task, so the path's success arm is still
  //     unobserved; but "the corpus contains zero main-moved events" is no longer true of the
  //     path as a whole.
  // So K workers do not merely expose this path, they CREATE it -- observed now, not only argued.
  // Over one card's own window the expected count of sibling merges is exactly K-1 (one per other
  // worker, once per cycle).
  //
  // The model: sibling merges as Poisson with lambda = (K-1) x exposure x intersectionRate,
  // "conservative" stated plainly rather than proven -- real sibling merges are quasi-periodic
  // (each worker's own cycle), so they cluster LESS than a Poisson arrival would, not more.
  //   exposure    = 39-52% of a card's cycle is GATE-start-to-merge (7.8/14.9 and 6.8/17.6 min
  //                 on the only two cards with phase timing, #473/#475).
  //   intersectionRate = 10.5% -- 16 of 153 pairs (C(18,2)) among the 18 merged pipeline PRs
  //                 share at least one file; concentrated in a few large cards (#213 in 5 pairs,
  //                 #418 in 5), median card touches 2-4 files and intersects nothing.
  //   lambda(K=2) = 0.041-0.055, lambda(K=3) = 0.082-0.109.
  //
  //           | one re-gate (>=1 intersecting sibling merge) | two (park under budget 1) |
  //   K=2     | 4.0-5.3% of cards                              | 0.08-0.15%                 |
  //   K=3     | 7.9-10.3%                                       | 0.33-0.56%                 |
  //
  // Today's boolean (equivalent to budget 1) already parks fewer than 1 card in 650 at K=2 and
  // fewer than 1 in 178 at K=3 -- a raised default would be defending against an event the
  // pipeline's OWN file-intersection test already makes ~10x rarer than a bare merge count
  // suggests, and the plan's default of 2 lands on K-1 only at the K=3 the plan happened to
  // choose, which is a coincidence of that choice, not a derivation. So: DEFAULT STAYS AT 1 --
  // no behaviour change from today's hard boolean -- and the number is configurable so it is
  // arguable rather than compiled in.
  //
  // What would actually settle this later: a `main-moved-merge` event count against a card
  // count once K>1 has run in production for a while -- the same "no calibration data exists
  // yet" honesty ciChecksMaxPolls' own comment above states, and no journal evidence for this
  // number CAN exist before then. Full derivation: doc/remediation-progress.md, "6.5's counter:
  // what the corpus says, and what it cannot say".
  mainMovedRegateBudget: 1,

  // CI_CHECKS in-flight bounded wait (steps/scripted.js's realCiChecks) -- action 1.7. A
  // check-run with `conclusion: null` (still running) or an empty check_runs array (CI has not
  // even registered yet) is NOT green: the audit measured 8/12 real "green" events with `claude
  // review` still in progress. ciChecksMaxPolls is the total number of `gh api .../check-runs`
  // fetches attempted (the first fetch counts as poll 1) before giving up and parking
  // `ci-checks-still-running` -- never advancing toward MERGE while a run is still in flight.
  // ciChecksPollIntervalMs is the sleep between polls; the sleep itself goes through
  // `deps.sleep` (production: the real setTimeout-based one; tests inject a no-op so the suite
  // never actually waits). SPO_CI_CHECKS_MAX_POLLS / SPO_CI_CHECKS_POLL_INTERVAL_MS override.
  //
  // Defaults are deliberately generous (30 x 20s ~ 10 min) and NOT calibrated, because no
  // calibration data exists: across all 13 real cards in journal/, CI_CHECKS reached
  // `checks-green` 0.6s after entering the state, every single time -- one API call, in-flight
  // runs skipped by the very bug this action fixes. The pipeline has therefore never once
  // waited for CI to actually conclude, so the true distribution is unmeasured. What IS known:
  // PUSH_PR -> checks-green ran 2-4 min on those same cards, and that clock stopped while
  // `claude review` was still running, so real conclusion is longer than 4 min.
  //
  // Erring long is the cheap direction. Waiting too long costs daemon wall-clock on one card;
  // parking too early costs a human round trip, and human wait was the measured #1 bottleneck
  // (77.3h of the 85.5h corpus). Recalibrate from real `checks-in-flight` events once this has
  // run in production -- that is the first data the pipeline will ever have on the question.
  ciChecksMaxPolls: CI_CHECKS_MAX_POLLS,
  ciChecksPollIntervalMs: CI_CHECKS_POLL_INTERVAL_MS,

  // Per-state deadline overrides, consulted by deadline.js before stepDeadlineMs. CI_CHECKS is
  // the one step that sleeps ON PURPOSE inside its own invocation (the bounded in-flight wait
  // above), so the generic 120s ceiling would fire mid-wait -- and deadline.js does not cancel
  // the loser, so the abandoned invocation would keep polling `gh api` and could still run the
  // main-moved `git merge origin/main` in the worktree of a card that has already parked. Worse,
  // the park would read `step-deadline-exceeded-twice` instead of `ci-checks-still-running`,
  // making 1.7's own park unreachable. Derive the ceiling from the bound so the two can never
  // drift apart again: the full poll budget plus one ordinary step deadline of margin for the
  // `gh api` calls themselves.
  //
  // WORKTREE and FINISH (action 6.4) are the same class of problem for the same reason, and the
  // history matters because it is the reason anyone would ever revisit these two numbers:
  //
  //   THIS TIMER WAS ALWAYS INERT IN REAL MODE. See the commandTimeoutsMs comment below: every
  //   real command in these steps runs through a BLOCKING spawnSync, so the event loop never
  //   yields and deadline.js's setTimeout could never fire. 6.4's product-repo mutex introduced
  //   the first `await` ever placed in that path (its poll loop's `await sleep(pollMs)`), which
  //   ARMED a timer that had never been live -- it did not expose a latent bug, it created a new
  //   one. Measured during 6.4's verification: with a holder still inside the critical section,
  //   WORKTREE parked `step-deadline-exceeded-twice` at 2 x stepDeadlineMs instead of ever
  //   reaching the mutex's own 116-minute wait bound, which the bound made unreachable dead code.
  //
  //   SO THESE ENTRIES ARE DELIBERATELY LARGE ENOUGH NEVER TO FIRE, and that is the correct
  //   answer rather than a cop-out: it restores the documented status quo. The real protection in
  //   these two steps is, and always was, spawnSync's own per-command timeouts
  //   (commandTimeoutsMs below), armed by steps/scripted.js's spawnStep -- never this timer.
  //
  //   THE HAZARD IF ONE EVER DOES FIRE, which is why "large enough" is not good enough on its
  //   own: deadline.js's withTimeout ABANDONS the loser rather than cancelling it (deadline.js
  //   lines 11-13). Measured, not reasoned about: when the WORKTREE timer fired during a lock
  //   wait, TWO realWorktree invocations subsequently entered the critical section -- 5ms apart,
  //   serialized by the mutex but both running fetch / the leftover sweep / `git worktree add`
  //   against the SHARED clone for a task that had ALREADY PARKED, leaving an orphan worktree and
  //   branch behind. That is a clone-corruption path opened by the very mutex that exists to
  //   prevent clone corruption. Shrinking either entry below its derived value reopens it.
  //
  // Derived, never literals, from product-repo-hold.js's own arithmetic so a change to
  // commandTimeoutsMs or to `workers` moves all of these together: the longest legitimate WAIT on
  // the mutex ((K-1) x worst hold), plus that phase's own longest legitimate WORK, plus one
  // ordinary step deadline of margin -- the identical shape CI_CHECKS uses above.
  stepDeadlineMsByState: {
    // Action A2 (card #239): PLAN/IMPLEMENT/DIAGNOSE/CITATION_VERIFIER/VALIDATE -- see
    // LLM_STEP_DEADLINE_ENTRIES's own derivation and full hazard writeup just above this export.
    ...LLM_STEP_DEADLINE_ENTRIES,
    CI_CHECKS: CI_CHECKS_MAX_POLLS * CI_CHECKS_POLL_INTERVAL_MS + STEP_DEADLINE_MS,
    WORKTREE: productRepoHold.lockedStepDeadlineMs(
      COMMAND_TIMEOUTS_MS,
      WORKERS,
      STEP_DEADLINE_MS,
      productRepoHold.worstHoldMs(COMMAND_TIMEOUTS_MS)
    ),
    // Action B1.4: FINISH now acquires the product-repo lock TWICE (phase 'finish-sync' -- the
    // fast-forward + conditional bench reinstall this action added, ahead of the pre-existing
    // teardown phase 'finish' -- still just `git worktree remove`), so its own wait can legitimately
    // happen twice, not once -- lockedStepDeadlineMs's single-wait shape no longer fits it. The
    // FOURTH argument is the hazard-fix bench-idle wait's own bound (BENCH_IDLE_WAIT_MAX_MS above)
    // -- that wait runs INSIDE 'finish-sync', ahead of the reinstall, so it has to be folded into
    // this deadline for the identical reason the bench-install timeout itself already is. See
    // product-repo-hold.js's finishStepDeadlineMs for the full derivation.
    FINISH: productRepoHold.finishStepDeadlineMs(COMMAND_TIMEOUTS_MS, WORKERS, STEP_DEADLINE_MS, BENCH_IDLE_WAIT_MAX_MS),

    // Card #211: GATE never had an entry here, and that was only ever safe because realGate's
    // exit-3/WORKER-DIED recovery wait is the FIRST `await` this function ever places inside its
    // own invocation -- every real command before it runs through the BLOCKING `spawnSync`, which
    // never yields the event loop, so deadline.js's setTimeout could not fire while a real
    // `npm run gate` (116-344s in the corpus) was still running. Adding a recovery poll that DOES
    // yield (`await pollSleep`) arms a timer that was previously always a no-op -- and once armed,
    // the generic 120s `stepDeadlineMs` ceiling expires long before either the gate itself or the
    // recovery wait can finish. deadline.js's callWithDeadline does not cancel the loser on expiry
    // (withTimeout abandons it), so a retroactively-fired deadline re-runs realGate from scratch --
    // a SECOND real `npm run gate` spawned while the first is still running. This already happened
    // in production on MERGE (card #587, same shape: probeMergeability's 750ms pollSleep after two
    // 9-minute pr:wait spawns) -- that MERGE defect is separate and is not fixed here.
    //
    // Derived, never a literal, same "poll budget plus one step deadline of margin" shape
    // CI_CHECKS' own entry above uses: the npm-gate command's own spawnSync timeout
    // (commandTimeoutsMs['npm-gate'], the real ceiling on how long one gate run can block) plus the
    // recovery wait's own bound (gateDiedRecoveryMaxMs, GATE_DIED_RECOVERY_MAX_MS above) plus one
    // ordinary step deadline of margin for the handful of git/gh calls the recovery and main-moved
    // paths still make. Does NOT depend on `workers` (K) -- unlike WORKTREE/FINISH above, nothing
    // here waits on the product-repo mutex -- so daemon.js's --workers recompute (see its own
    // comment) does not need a GATE entry: this one is safe to inherit via the spread it already
    // does off defaultConfig.stepDeadlineMsByState, the same as CI_CHECKS.
    //
    // Fix-pass round 2, defect 6 (residual overflow): GATE_DIED_RECOVERY_MAX_POLLS_CEILING's own
    // `Math.max(0, ...)` (above) covers the recovery term -- but when `commandTimeoutsMs['npm-gate']`
    // ALONE (an extreme `SPO_TIMEOUT_NPM_GATE_MS` override) already leaves no room even at 0 polls,
    // the sum below can still exceed MAX_TIMER_DELAY_MS with nothing left upstream to reduce.
    // Chosen rule for this remainder: clamp the FINAL sum, unconditionally. This is the honest
    // last resort, not a silent one -- Node would otherwise clamp the very same oversized value to
    // 1ms on its own (measured, undocumented as a throw), which is worse than an explicit ceiling:
    // 2147483647ms of margin before the timer could ever misfire beats 1ms of none.
    GATE: Math.min(COMMAND_TIMEOUTS_MS['npm-gate'] + GATE_DIED_RECOVERY_MAX_MS + STEP_DEADLINE_MS, MAX_TIMER_DELAY_MS),

    // Card #224: the MERGE half of the defect the GATE comment just above describes and names
    // ("that MERGE defect is separate and is not fixed here"). Derived, never a literal --
    // MERGE_STEP_DEADLINE_MS above carries the full per-spawn enumeration, the production trace it
    // was measured against (SPO-WebClient#587), why the spawnStep retry factor is in it, and why it
    // does not depend on `workers`.
    MERGE: MERGE_STEP_DEADLINE_MS,
  },

  // ---- action 2.1: real spawnSync per-command-class timeouts -----------------------------
  //
  // The spec claimed "every step has a wall-clock deadline"; in real mode that was false.
  // stepDeadlineMsByState above races a JS timer against a Promise (deadline.js's
  // withTimeout), but every real command in steps/scripted.js runs through `spawnSync`, which
  // blocks the event loop -- so that timer cannot fire while a `gh`/`git`/`npm` child is stuck,
  // and the daemon (single-threaded, holding the task lock) hangs forever. Measured: GATE
  // observed running 129-240s past its supposedly-enforced 120s. The only real defence is
  // `spawnSync`'s OWN `timeout` option, armed per call by steps/scripted.js's spawnStep --
  // see ./command-timeout.js's classifyCommand for how a call site's (command, args) maps to
  // one of these keys (action 2.1b moved it there, out of steps/scripted.js, once board.js/
  // park-loop.js/report-intake.js/intake.js needed the identical mapping for their own spawns).
  //
  // Values, and why:
  //   git      -- 120s. Every git call here is either local (fast) or one round-trip over the
  //               network (fetch/push/rev-parse against origin) -- matches the pre-existing
  //               generic stepDeadlineMs, comfortable margin for a slow link.
  //   gh       -- 120s. Same reasoning for a single REST/GraphQL call -- this is not the
  //               bounded CI_CHECKS poll loop (that has its own ciChecksMaxPolls/
  //               ciChecksPollIntervalMs budget above), just one `gh api`/`gh pr` invocation.
  //   npm-ci   -- 600s (10 min). A product worktree carries no node_modules (WORKTREE's own
  //               header comment in scripted.js) -- a full cold install.
  //   npm-gate -- 7800s (130 min). The remediation plan says 900s; that number is WRONG and is
  //               corrected here, derived the same way npm-run is derived from pr-wait.sh.
  //               `npm run gate` -> scripts/bench-gate.sh -> bench-submit.sh --wait ->
  //               src/e2e/bench/cli.ts, whose DEFAULT_WAIT_TIMEOUT_MIN is 120 -- SEVEN THOUSAND
  //               TWO HUNDRED seconds, after which it exits 4 on its own and realGate maps that
  //               to the designed ParkSignal('gate-timeout'). A 900s kill therefore fires
  //               EIGHT TIMES too early: it destroys a legitimate queue wait, and the retry then
  //               re-runs `npm run gate`, which re-submits a bench job for the same
  //               (worktree, ref). job.ts refuses that with DuplicateJobError -> cli.ts returns
  //               2 -> realGate parks `gate-dirty-tree`. So a merely BUSY bench would have
  //               parked the card with a reason describing a dirty worktree that is perfectly
  //               clean. Compounding it: spawnSync's timeout kills only the direct child, so the
  //               orphaned `node cli.js wait` grandchild survives and keeps the first job alive,
  //               making the duplicate refusal near-certain rather than a race.
  //               7800s = the bench's own 7200s bound plus 600s of margin, so the bench always
  //               gets to render its own verdict first and our kill stays the true last resort.
  //   npm-run  -- 660s (11 min), the default for every OTHER `npm run <alias>` this file spawns
  //               (typecheck, lint, coverage:changed, board:take, board:move, pr:wait). Bounded
  //               BELOW by SPO-WebClient's scripts/pr-wait.sh's own internal bound -- it polls
  //               at most 20 times at a 30s interval (600s) before exiting 4 ("still open") on
  //               purpose. Our spawnSync timeout must exceed that bound, or a legitimate
  //               "still in the merge queue" outcome (which realMerge's own bounded re-wait is
  //               built to handle) would be killed by US first and misread as a hang. 660s
  //               gives pr:wait's own worst case a 60s margin; typecheck/lint/coverage:changed/
  //               board:take/board:move are all far inside it on this codebase's current size.
  //               Recalibrate down once real per-alias durations are measured -- "erring long
  //               is the cheap direction" (see ciChecksMaxPolls's own comment above for the
  //               same philosophy).
  //
  // An explicit `opts.timeout` passed by a spawnStep call site always wins over these defaults
  // (steps/scripted.js). Every value is independently overridable; SPO_TIMEOUT_* env vars.
  commandTimeoutsMs: COMMAND_TIMEOUTS_MS,

  // Poll interval for daemon.js when run without --once (queue watch mode).
  // How long a drain (dispatcher.js's requestDrain, reached from daemon.js's SIGTERM/SIGINT
  // handler) waits for the cards already in flight before signalling them anyway. The claiming
  // half stops immediately either way; this bound governs only the waiting half.
  //
  // 45 MINUTES, AND THE NUMBER IS MEASURED, NOT CHOSEN. 56 worker-spawn -> worker-exit pairs in
  // journal/daemon.jsonl (the whole recorded history at the time of writing) run: p50 22.9 min,
  // p75 33.7, p90 43.1, p95 45.7, max 56.2. A card is not a "few minutes" of work, and a bound
  // picked from that intuition would have killed the median card. 45 min is the p95: 19 cards in
  // 20 survive a deploy untouched, and the twentieth dies exactly where it died before this
  // existed -- a drain can never be worse than the kill it replaces, only slower.
  //
  // TWO THINGS MUST TRACK THIS NUMBER, and neither is in this file:
  //   - the unit's TimeoutStopSec (scripts/daemon-install.sh). systemd SIGKILLs the whole cgroup
  //     when its own stop timeout expires, so a TimeoutStopSec below this bound does not shorten
  //     the drain, it DELETES it -- and a SIGKILL is strictly worse than the SIGTERM this replaces
  //     (no park, no worktree WIP preserved, recovery deferred to the next start's orphanScan).
  //   - the post-merge hook's `systemctl restart --no-block`. Without --no-block a `git pull`
  //     blocks the maintainer's terminal for as long as this bound allows.
  // A maintainer who does not want to wait sends the signal a second time (see requestDrain);
  // SPO_DRAIN_TIMEOUT_MS=0 disables the drain entirely and restores the pre-drain behaviour.
  drainTimeoutMs: DRAIN_TIMEOUT_MS,
  // After the drain's bound expires and the stragglers are SIGTERMed, how long to let them finish
  // and exit before escalating to SIGKILL. Not a duplicate of the bound above: that one governs
  // waiting for a HEALTHY card to finish its work, this one governs waiting for a SIGNALLED one to
  // finish DYING -- writing its park, preserving its worktree WIP, posting its anchor comment.
  //
  // It exists because `await Promise.allSettled(pending)` is unbounded and production's stragglers
  // are exactly the processes that do not die on time: a worker blocked in spawnSync does not run
  // its signal handler until the loop turns (doc/deployment.md 2.2, measured -- #515 took 3.1s
  // from SIGTERM to its last GitHub write). Without this the only backstop was systemd's SIGKILL of
  // the whole cgroup at TimeoutStopSec, which skips daemon.js's exit hook entirely and leaks the
  // single-instance lock file for the next start to stale-sweep.
  //
  // 60s is ~20x the one measured park-after-signal (3.1s) and still leaves the unit's
  // TimeoutStopSec (drain + this + slack) comfortably ahead of it. 0 escalates immediately.
  drainKillGraceMs: DRAIN_KILL_GRACE_MS,
  pollIntervalMs: 5000,

  // ---- action 6.3: the dispatcher (orchestrator/dispatcher.js) --------------------------

  // How many workers the dispatcher runs concurrently. Default 1, deliberately -- this is a
  // large refactor (queue draining moves from in-process runTask calls to spawned `--worker`
  // child processes for EVERY task, including at K=1: "one code path, not two", see
  // dispatcher.js's own header) and the default must not change today's throughput behaviour on
  // its own; parallelism is opt-in. Re-clamped to accounts.countHealthyAccounts(...) before EVERY
  // spawn regardless of this value -- see dispatcher.js and account-lease.js's own header for why
  // the measured ceiling on the real two-account pool is K=2, and why K=1 (one account cooling)
  // is a routine state, not an edge case: one account sat in a 5-hour cooldown for most of
  // 2026-09-01. --workers / SPO_WORKERS overrides; a non-positive-integer override falls back to
  // this default rather than to 0 (which would spawn nothing, silently, forever).
  workers: WORKERS,

  // How many CONSECUTIVE worker crashes (dispatcher.js's own classifier: any exit that is
  // neither 0 (DONE) nor 20 (PARKED) -- see daemon.js's --worker header for the full exit-code
  // table) trip the dispatcher's circuit breaker and make IT exit non-zero, rather than reparking
  // forever. "Consecutive" is scoped to the DISPATCHER'S OWN LIFETIME, across every task it has
  // spawned a worker for, not per-task -- and is reset by ANY worker exiting 0 or 20, because a
  // park is a successful run of the state machine (an ordinary outcome the plan itself calls out
  // as "not a crash"), and without that reset an unlucky run of ordinary parked cards would trip
  // a breaker meant to catch a broken state machine, not a busy one.
  //
  // Default 3 is a TUNABLE WITH NO JOURNAL EVIDENCE BEHIND IT, stated plainly rather than dressed
  // up as derived: there has never been a worker crash in this project's history, because there
  // have never been workers -- action 6.1 is what first made `--worker` exist at all, and this
  // config was written the same week. Every other numeric default this remediation has shipped
  // (diagnoseBudget, ciRetryBudget, the various *Ms timers above) was sized against the real
  // journal corpus; this one cannot be, and pretending otherwise would be worse than saying so.
  // What WOULD justify changing it: a `worker-crashed` daemon.jsonl history once workers have
  // actually run in production for a while -- specifically, whether real crashes cluster (a
  // handler bug that reliably reproduces, where a LOW limit is correct: stop fast, page a human)
  // or scatter (transient infrastructure flakiness across otherwise-healthy runs, where a HIGHER
  // limit avoids a daemon that stops itself on ordinary noise). Recalibrate from that data once it
  // exists, the same way ciChecksMaxPolls's own comment above describes for CI wait budgets --
  // this is the same "erring toward a number with no evidence, stated as such" posture, not a
  // silent guess. SPO_WORKER_CRASH_LIMIT overrides.
  workerCrashLimit: positiveIntFromEnv('SPO_WORKER_CRASH_LIMIT', 3),

  // How many CONSECUTIVE crashes of the SCANNER child (daemon.js --scanner, spawned/supervised by
  // dispatcher.js -- action 6.3's post-verification correction, see that file's header) trip a
  // SEPARATE circuit breaker from workerCrashLimit above -- see dispatcher.js's
  // handleScannerExit for the justification: a scanner crash (scan/intake machinery) and a worker
  // crash (state-machine execution) are different failure domains, and sharing one counter would
  // make the trip detail actively misleading about which one is actually broken. Same posture as
  // workerCrashLimit on evidence: there has never been a scanner before this action, so this
  // default (3, matching workerCrashLimit's own) carries the identical "no journal evidence yet"
  // caveat -- recalibrate once a `scanner-crashed` daemon.jsonl history exists to look at.
  // SPO_SCANNER_CRASH_LIMIT overrides.
  scannerCrashLimit: positiveIntFromEnv('SPO_SCANNER_CRASH_LIMIT', 3),

  // How long (ms) a spawned scanner must stay alive -- measured by dispatcher.js's own
  // handleScannerExit with orchestrator/monotonic-clock.js's monotonicNowMs, an ELAPSED-DURATION
  // measurement inside that one process, never written to disk or compared across processes (see
  // that file's own header) -- before ITS crash is treated as the START of a fresh consecutive
  // streak rather than an extension of the previous one. This is what makes
  // consecutiveScannerCrashes actually consecutive: a worker has a terminal outcome (0/20) that
  // defines "healthy", but the scanner's own loop never returns on its own (state-machine.js's
  // runForever is `for (;;)`), so there is no terminal-outcome signal to reset on -- uptime is the
  // only substitute dispatcher.js has for "this run of the scanner was fine, not a symptom of the
  // same failure as the last one."
  //
  // DERIVED, not invented: shouldScanOrphans/shouldScanUnpark (orphan-scan.js / park-loop.js) both
  // treat a null last-run as due NOW, so EVERY scanner -- healthy or about to crash on its next
  // line -- completes one orphan+unpark pass on its very first loop iteration, regardless of
  // orphanScanMs/unparkScanMs. That freebie first pass is therefore NOT evidence the scanner is
  // doing real, sustained work; surviving long enough for orphanScanMs/unparkScanMs to come due A
  // SECOND time is -- that is what "completing scan cycles" (as opposed to merely starting up)
  // actually means for this process. Default is the larger of the two (ORPHAN_SCAN_MS,
  // UNPARK_SCAN_MS -- equal today at 60s, but expressed as a derivation in case they diverge)
  // rather than pollIntervalMs (5s): pollIntervalMs is just this loop's own tick, and a scanner
  // that ticks once and dies has not been shown to do anything useful, only to have started.
  //
  // STATED PLAINLY, same posture as workerCrashLimit/scannerCrashLimit's own comments above and
  // mainMovedRegateBudget further down: THIS IS A TUNABLE WITH NO JOURNAL EVIDENCE BEHIND IT. The
  // live daemon's journal has zero scanner-crashed events across its ~6h of post-C6 uptime (2
  // dispatcher-start events) -- there is no observed crash-clustering pattern to calibrate against,
  // only the code-level argument above for why uptime, not a fixed cadence, is the right signal and
  // why THESE timers are the right source for it. Recalibrate once a real scanner-crashed history
  // exists. SPO_SCANNER_HEALTHY_UPTIME_MS overrides.
  scannerHealthyUptimeMs: positiveMsFromEnv('SPO_SCANNER_HEALTHY_UPTIME_MS', Math.max(ORPHAN_SCAN_MS, UNPARK_SCAN_MS)),

  // ---- crash recovery: orphaned tasks + lock re-verification (orchestrator/orphan-scan.js,
  // orchestrator/lock.js) -- see doc/daemon-crash-recovery.md for the incident this covers
  // (2026-08-30, card #385: a daemon that died mid-DIAGNOSE left state.json frozen on a
  // non-terminal state, invisible to both the queue and unparkScan, requiring a manual fix).

  // How often runForever's real-mode loop re-scans journal/ for a task whose state.json is
  // non-terminal, has no queue/ entry, and whose recorded owner pid is no longer alive on this
  // host -- see orphan-scan.js. A crash is also always caught once, unconditionally, at daemon
  // startup (before this timer's first tick) -- that is the case that matters (crash -> systemd
  // restart), this timer is the belt-and-suspenders for a daemon that keeps running but somehow
  // loses track of a task. SPO_ORPHAN_SCAN_MS overrides.
  orphanScanMs: ORPHAN_SCAN_MS,

  // action 2.7 bullet 4: park-loop.js's unparkScan used to run unconditionally on EVERY
  // drainQueueOnce cycle (pollIntervalMs, 5s by default) in real mode -- a `gh api .../comments`
  // call per parked task every 5 seconds, unbounded. This is its own dedicated timer now, same
  // shape and same default as orphanScanMs above (park-loop.js's shouldScanUnpark). SPO_UNPARK_SCAN_MS
  // overrides, 0 disables (a parked task then only unparks via a hand-run `spo retry`/equivalent,
  // never the daemon's own scan).
  unparkScanMs: UNPARK_SCAN_MS,

  // action 2.7: the sane bound on comment-scan.js's own pagination (`fetchCommentsAfterAnchor`),
  // shared by park-loop.js's unparkScan and report-intake.js's reportConfirmScan -- see that
  // module's own header for the full rationale. 20 pages * 100/page = 2000 comments scanned
  // before a cycle gives up on ONE issue and journals the truncation distinguishably from "no
  // reply" (unpark-scan-truncated / report-confirm-scan-truncated) rather than looking like
  // nothing happened. SPO_COMMENT_SCAN_MAX_PAGES overrides.
  commentScanMaxPages:
    process.env.SPO_COMMENT_SCAN_MAX_PAGES !== undefined ? Number(process.env.SPO_COMMENT_SCAN_MAX_PAGES) : 20,

  // How stale state.json's updatedAt must be, on top of a dead owner pid, before a task is
  // treated as orphaned rather than mid-transition-write. Longer than any legitimate step
  // (stepDeadlineMs above), short enough that a real orphan does not sit unrecovered for long.
  // SPO_ORPHAN_GRACE_MS overrides.
  orphanGraceMs: nonNegativeMsFromEnv('SPO_ORPHAN_GRACE_MS', 4 * 60 * 1000),

  // How often the running daemon re-reads its own lock file to confirm it is still the holder
  // (orchestrator/lock.js's watchLock) -- acquireLock only ever checks once, at startup.
  // SPO_LOCK_WATCH_MS overrides.
  lockWatchMs: positiveMsFromEnv('SPO_LOCK_WATCH_MS', 15 * 1000),

  // Claude Max account pool directory -- the single source of truth (maintainer decision,
  // 2026-08-29): every subdirectory is one account, plus a machine-written state.json for
  // cooldowns. See orchestrator/accounts.js and doc/setup.md § Accounts. Machine-level by
  // default, deliberately outside the repo (never git-ignored-but-present here) -- overridable
  // with the SPO_ACCOUNTS_DIR env var, and as always by the explicit first argument every
  // accounts.js function takes (tests point this at a temp dir). A missing or empty pool
  // directory is not an error by itself -- accounts.js.readRegistry() just returns []; it is
  // accounts.pick() (called once a step actually needs an account) that throws
  // NoAccountsRegisteredError, and daemon.js --real refuses to start on that.
  claudeAccountsDir: process.env.SPO_ACCOUNTS_DIR || path.join(os.homedir(), '.claude-accounts'),

  // ---- action 6.2: per-account leases + atomic pool state --------------------------------
  //
  // accountLeaseWaitMs -- how long callLlmStep/callIntakeStepWithRotation (via
  // orchestrator/account-lease.js's leaseHealthyAccount) will WAIT for a healthy account's lease
  // to free up before giving up and parking `all-accounts-leased`. Per-step leasing was chosen
  // over per-task leasing precisely so a worker can wait out a SIBLING's in-flight step rather
  // than park (doc/remediation-progress.md's C6 decision record).
  //
  // DERIVED FROM MAX_LEASE_AGE_MS, not from an observed maximum. This was the one C6 bound that
  // was not, and it was wrong for it (cross-action defect, found in C6 verification). The old
  // default was 5 minutes, justified against measured step durations of 90-265s -- but what a
  // waiter must outlast is not the duration a step USUALLY takes, it is the longest a sibling can
  // LEGITIMATELY hold the lease, and that is a bound this codebase already states:
  //
  //   sibling worker, one two-attempt LLM step   2 x MAX_LLM_STEP_OUTER_DEADLINE_MS = 64    min
  //   scanner, one two-call triage step          2 x INTAKE_DEADLINE_MS             = 10    min
  //   the age at which a lease is swept as dead  MAX_LEASE_AGE_MS                   = 67.2  min
  //
  // The first row reads 64 min, not the 60 min this table stated before action A2 (card #239,
  // 2026-09-17) -- that 60-minute figure was 2 x MAX_LLM_STEP_DEADLINE_MS, the INNER deadline
  // alone, correct only while the OUTER per-state timer (deadline.js's callWithDeadline, armed
  // from this file's own stepDeadlineMsByState) had no entry for any LLM step and so could never
  // fire against a real call -- a blocking spawnSync never yielded the event loop. A2 gave every
  // LLM step an outer entry (deadlineMsForStep(step) + STEP_DEADLINE_MS, this file's own
  // stepDeadlineMsByState above), so that once card #239's transport swap (action A5b, landed the
  // same day) made that timer live -- which it now is, not merely anticipated -- the
  // worst legitimate per-attempt hold becomes the OUTER bound, not the inner one alone --
  // MAX_LLM_STEP_OUTER_DEADLINE_MS = MAX_LLM_STEP_DEADLINE_MS + STEP_DEADLINE_MARGIN_MS =
  // 1,920,000ms (step-contracts.js). MAX_LEASE_AGE_MS is derived from that running maximum for
  // exactly this reason: the 67.2-minute figure on the third row already tracks the new bound
  // without a second edit here; only this table's prose has to be kept honest by hand -- the same
  // drift this exact table already recorded once, when the first row read 30 min after PLAN's
  // 2026-09-04 override and IMPLEMENT's own (step-contracts.js, action 2.2) had already raised the
  // bound the row describes.
  //
  // Against a 5-minute wait every one of those is longer. A worker at K=2 therefore gave up while
  // the holder was still legitimately alive AND still un-sweepable for up to another 62.2 minutes
  // (67.2 - 5), and parked `all-accounts-leased` -- the exact park class per-step leasing exists to
  // avoid. The real pool is 2 accounts against 3 contenders (2 workers + the scanner), so this is
  // an ordinary operating point, not an exotic one.
  //
  // MAX_LEASE_AGE_MS is the correct derivation because it is the ceiling by CONSTRUCTION: a lease
  // younger than it may be legitimately held, and one older than it is swept and taken by the very
  // next poll. A waiter willing to outlast it therefore always terminates in one of two honest
  // ways -- it gets a lease, or the holder ages out and it takes that one -- instead of parking a
  // healthy card. Same asymmetry product-repo-lock.js states for its own wait bound: waiting too
  // long only delays a card, giving up too early parks one that was fine.
  //
  // Never applies to a cooling account -- see accounts.js's AllAccountsLeasedError vs
  // AllAccountsCoolingError split; a cooldown is never worth waiting out. SPO_ACCOUNT_LEASE_WAIT_MS
  // overrides (positiveMsFromEnv: a non-positive/non-finite override falls back to this default,
  // never to "wait forever").
  accountLeaseWaitMs: positiveMsFromEnv('SPO_ACCOUNT_LEASE_WAIT_MS', MAX_LEASE_AGE_MS),

  // accountLeasePollMs -- how often the wait above re-checks whether a lease has freed up. Each
  // check is one directory listing plus a few small JSON reads (leasedAccountNames), cheap
  // enough that a 1s cadence costs nothing noticeable even with several workers waiting at once,
  // while still resolving a freed lease promptly relative to the multi-minute bound it polls
  // inside of. SPO_ACCOUNT_LEASE_POLL_MS overrides.
  accountLeasePollMs: positiveMsFromEnv('SPO_ACCOUNT_LEASE_POLL_MS', 1000),

  // accountStateLockWaitMs -- how long accounts.js's markLimit will wait for <poolDir>/.state.lock
  // before giving up and falling back to today's UNLOCKED read-modify-write (see markLimit's own
  // comment for the "degrade, never fail" doctrine: losing a concurrent cooldown update is a
  // wasted call, failing an LLM step's own already-failed attempt over pool bookkeeping is a
  // parked card). This runs in the hot path right after a step has already failed with a limit,
  // so it stays far short of accountLeaseWaitMs above -- but not so short that ordinary
  // contention (two workers hitting a limit on DIFFERENT accounts in the same instant, each
  // doing one small JSON read+write under the lock) routinely blows through it and degrades for
  // no reason: 2s is generous headroom over a lock hold time measured in single-digit
  // milliseconds, while still trivial next to a 90s+ step. SPO_ACCOUNT_STATE_LOCK_WAIT_MS
  // overrides.
  accountStateLockWaitMs: positiveMsFromEnv('SPO_ACCOUNT_STATE_LOCK_WAIT_MS', 2000),

  // accountStateLockPollMs -- retry cadence for the wait above. Short, because the whole point is
  // a bound that resolves quickly once the other holder's write completes (typically well under
  // a millisecond of actual critical-section time). SPO_ACCOUNT_STATE_LOCK_POLL_MS overrides.
  accountStateLockPollMs: positiveMsFromEnv('SPO_ACCOUNT_STATE_LOCK_POLL_MS', 10),

  // ---- real-mode scripted steps (steps/scripted.js) --------------------------------------
  //
  // The product checkout every WORKTREE/CHECK/PUSH_PR/GATE/CI_CHECKS/MERGE/FINISH real command
  // runs against or from. Always this literal join, never a relative "../SPO-WebClient" --
  // see CLAUDE.md's own warning that ".." resolves differently from inside a worktree.
  // SPO_PRODUCT_REPO / SPO_WORKTREES_DIR exist so a test subprocess can be pointed away from the
  // real product checkout. Without them a test that reaches realWorktree -- which normally it
  // cannot, but a mutation that makes shadow mode take a real path can -- creates REAL git
  // worktrees and branches in ~/SPO-WebClient. That happened during a mutation-testing round on
  // 2026-08-31: 44 fixture-named worktrees and 61 branches landed in the live product repo, and
  // because `worktrees/` is gitignored, `git status` stayed clean while bare `node --test` walked
  // into them and reported 12980 failures that had nothing to do with the code under test.
  productRepo: process.env.SPO_PRODUCT_REPO || path.join(os.homedir(), 'SPO-WebClient'),

  // Where WORKTREE creates one `git worktree add` per task (<dir>/<taskId>). Disposable --
  // FINISH removes its own entry with `git worktree remove --force`.
  //
  // OUTSIDE REPO_ROOT, and that is the whole point. This defaulted to `<REPO_ROOT>/worktrees`
  // until 2026-09-05. Claude Code loads a CLAUDE.md from every ancestor directory of its cwd, so a
  // product worktree nested under the pipeline repo pulled `SPO-Pipeline/CLAUDE.md` into every PLAN
  // and IMPLEMENT call -- verified by running `claude -p` in `worktrees/issue-640` and asking which
  // files it had loaded:
  //
  //     /home/crazz/SPO-Pipeline/CLAUDE.md
  //     /home/crazz/SPO-Pipeline/worktrees/issue-640/CLAUDE.md
  //
  // That file's own header asserts the opposite ("loaded on every LLM call whose `cwd` is the repo
  // root -- DIAGNOSE, VALIDATE, CITATION_VERIFIER"), and both halves of the belief cost something.
  // Correctness: on card SPO-WebClient#640 an IMPLEMENT read its § Permissions -- written about
  // THIS repo's `.claude/settings.json` and `.claude/hooks/*.sh` -- generalized it to all of
  // `.claude/`, quoted its "park it with that reason instead of failing it in IMPLEMENT"
  // instruction verbatim, and declared the card impossible. It was not: card #671 edited
  // `.claude/agents/card-reviewer.md` and merged. 521.5k billable tokens on a false park. Tokens:
  // the file is kept deliberately short because "adding context here means paying for it on every
  // step", sized believing that meant 3 steps of 5. It was 5 of 5.
  //
  // `$HOME` has no CLAUDE.md and neither does `~/.spo-worktrees`, so a worktree there sees exactly
  // one: the product's own, at its root. Sibling convention to `~/.spo-bench`. Anything that moves
  // this back under REPO_ROOT reinstates the leak -- test/orphan-scan.test.js pins that it does not.
  pipelineWorktreesDir: process.env.SPO_WORKTREES_DIR || path.join(os.homedir(), '.spo-worktrees'),

  // productRepoLockPollMs -- action 6.4's product-repo mutex (orchestrator/product-repo-lock.js):
  // how often a worker blocked on the lock re-checks whether it has freed up. Same cadence and
  // same reasoning as accountLeasePollMs above (one small fs read, cheap enough that 1s costs
  // nothing even with a couple of workers waiting at once) -- the bound this polls inside of is
  // derived in product-repo-lock.js itself, not here, from commandTimeoutsMs above (see that
  // file's own header for why a *derived* bound cannot live in this deliberately-inert config
  // object). SPO_PRODUCT_REPO_LOCK_POLL_MS overrides.
  productRepoLockPollMs: positiveMsFromEnv('SPO_PRODUCT_REPO_LOCK_POLL_MS', 1000),

  // owner/repo for every `gh api` / `gh pr` / `gh issue` real call.
  ghRepo: 'Crazz-Org/SPO-WebClient',

  // Local surfaces this build reads instead of polling GitHub/the bench for state that already
  // has one: ~/.spo-bench/nightly/latest.json (INTAKE's nightly-red pre-gate, card #226, plus
  // WORKTREE's and CI_CHECKS'/GATE's own nightly-red refusals),
  // ~/.spo-bench/verdicts/<sha>.json (CI_CHECKS' baseMain, for the main-moved intersection), and
  // (action 5.4) ~/.spo-bench/spool + ~/.spo-bench/running for `spo status`'s bench queue depth.
  // SPO_BENCH_DIR override added by that same action, matching the SPO_ACCOUNTS_DIR /
  // SPO_WORKTREES_DIR / SPO_PRODUCT_REPO pattern already established below -- the test suite's
  // isolatedEnv() (test/helpers.js) points this at a throwaway tmp dir for every `spo status`
  // subprocess it spawns, so no test ever reads the maintainer's real ~/.spo-bench.
  spoBenchDir: process.env.SPO_BENCH_DIR || path.join(os.homedir(), '.spo-bench'),

  // Post-verification hazard fix (action B1.4): steps/scripted.js's waitForBenchIdle reads these
  // two before ever invoking bench-install.sh -- see BENCH_IDLE_WAIT_MAX_POLLS's own comment above
  // (near CI_CHECKS_MAX_POLLS) for the full rationale and the default's derivation.
  // benchIdleWaitMaxMs is the pre-multiplied bound (maxPolls x pollIntervalMs) -- exported so it
  // can be read directly wherever only the total matters (this file's own FINISH deadline above),
  // without re-deriving it from the other two a second time.
  benchIdleWaitMaxPolls: BENCH_IDLE_WAIT_MAX_POLLS,
  benchIdleWaitPollIntervalMs: BENCH_IDLE_WAIT_POLL_INTERVAL_MS,
  benchIdleWaitMaxMs: BENCH_IDLE_WAIT_MAX_MS,

  // Card #211: steps/scripted.js's realGate reads these three before parking `gate-worker-died-
  // midjob` on an exit-3 WORKER DIED with a known job id -- see GATE_DIED_RECOVERY_MAX_POLLS's own
  // comment above for the full rationale and the default's derivation. gateDiedRecoveryMaxMs is
  // the pre-multiplied bound (maxPolls x pollIntervalMs), exported so this file's own GATE
  // stepDeadlineMsByState entry above can read the total directly rather than re-deriving it.
  gateDiedRecoveryMaxPolls: GATE_DIED_RECOVERY_MAX_POLLS,
  gateDiedRecoveryPollIntervalMs: GATE_DIED_RECOVERY_POLL_INTERVAL_MS,
  gateDiedRecoveryMaxMs: GATE_DIED_RECOVERY_MAX_MS,

  // Card #224: NOT read by steps/scripted.js -- `probeMergeability` keeps its own two constants
  // (moving them here would change that function's control flow, which this card's fix
  // deliberately does not touch). These are the MIRRORS the MERGE stepDeadlineMsByState entry
  // above derives from, exported for exactly one purpose: so test/real-steps.test.js can pin them
  // equal to steps/scripted.js's own exported MERGE_PROBE_MAX_ATTEMPTS/MERGE_PROBE_POLL_INTERVAL_MS
  // and a change to the probe loop cannot silently under-derive the deadline that covers it.
  mergeProbeMaxAttempts: MERGE_PROBE_MAX_ATTEMPTS,
  mergeProbePollIntervalMs: MERGE_PROBE_POLL_INTERVAL_MS,
  // The MERGE spawn-site counts the same derivation depends on, exported for the same reason: a
  // sweep test pins them against the real number of `spawnStep(ctx, deps, 'MERGE', ...)` call
  // sites in steps/scripted.js, so adding a spawn to any MERGE path fails loudly here rather than
  // quietly shrinking the margin.
  mergeSpawnCounts: {
    npmRun: MERGE_NPM_RUN_SPAWNS,
    gh: MERGE_GH_SPAWNS,
    git: MERGE_GIT_SPAWNS,
    spawnStepMaxAttempts: SPAWN_STEP_MAX_ATTEMPTS,
  },

  // ---- kanban piloting: auto-pull (orchestrator/auto-pull.js) ----------------------------
  //
  // daemon.js --scanner polls the board on this timer (state-machine.js's runForever's scan
  // cycle), running the same pullBoard + makeTask `spo pull` already does by hand, for the top
  // autoPullLimit claimable candidates. 0 disables the timer entirely. SPO_AUTO_PULL_MS
  // overrides -- see orchestrator/README.md § Kanban piloting for the GraphQL cost.
  //
  // action 6.3 correction: this used to run inside the SAME process (and, pre-dispatcher, the
  // same serial loop) that drained the queue -- "a pull only ever happens with the daemon idle"
  // was true then. It is no longer true: the scanner is now its own process, on its own timer,
  // entirely independent of whether the dispatcher's workers are busy. A pull can now land while
  // K workers are mid-task; they simply pick the new card up via their own next takeNextTask.
  autoPullMs: nonNegativeMsFromEnv('SPO_AUTO_PULL_MS', 5 * 60 * 1000),
  // How many claimable candidates one auto-pull cycle takes off the board.
  //
  // Default 1 (maintainer decision, 2026-08-29): the daemon takes one card at a time off the
  // board. Cards stay on the board -- visible, reorderable, claimable by a human -- until a
  // worker is actually ready for them. Raise it if intake proves to be the bottleneck.
  // SPO_AUTO_PULL_LIMIT overrides.
  // SPO_AUTO_PULL_LIMIT=0 means ZERO -- see nonNegativeIntFromEnv above and auto-pull.js's
  // resolveNonNegativeInt. It used to be `Number(...)` straight through into a `|| DEFAULT`, so
  // the off switch resolved to 3.
  autoPullLimit: nonNegativeIntFromEnv('SPO_AUTO_PULL_LIMIT', 1),

  // ---- kanban piloting: human-first bug-report intake --------------------------------------
  //
  // Two independent stages, on two independent timers -- orchestrator/report-intake.js (stage
  // 1: mechanical filing, stage 2: the confirm/discard comment scan) and orchestrator/
  // auto-triage.js (stage 3+: reproduction + the existing reviewCard/fileCard gate, but ONLY for
  // a report a human has already replied "confirm" to). Maintainer decision, 2026-08-30,
  // superseding the single-stage "probation column" design: no LLM looks at a report until a
  // human has read it RAW (no reproduction, no classification) and asked for it to be pursued.
  // See orchestrator/README.md § Auto-triage / § Report intake for the full design and why.

  // Where the webclient's bug-report queue lives -- outside any git tree by design
  // (SPO-WebClient's doc/bug-reporting.md § "The queue": `npm run finish` retires worktrees, and
  // a queue inside one would disappear with the branch that produced the reports). Never derived
  // from productRepo -- a sibling machine-level surface, same class as spoBenchDir above.
  // SPO_REPORTS_DIR overrides.
  spoReportsDir: process.env.SPO_REPORTS_DIR || path.join(os.homedir(), '.spo-reports'),

  // daemon.js --real polls ~/.spo-reports on this timer and mechanically files a RAW card per
  // report (orchestrator/report-intake.js's runReportIntake) -- render + grep-shaped dedup +
  // `gh issue create` + a column move. Nonzero by default, UNLIKE autoTriageMs below: this stage
  // contains zero LLM judgement (see report-intake.js's own header), so it is the same risk
  // class as auto-pull, not auto-triage. SPO_AUTO_INTAKE_MS overrides, 0 disables.
  autoIntakeMs: nonNegativeMsFromEnv('SPO_AUTO_INTAKE_MS', 15 * 60 * 1000),

  // How many queued reports one intake cycle files. SPO_AUTO_INTAKE_LIMIT overrides.
  autoIntakeLimit:
    process.env.SPO_AUTO_INTAKE_LIMIT !== undefined ? Number(process.env.SPO_AUTO_INTAKE_LIMIT) : 3,

  // The Status column a raw report's card is filed into -- a human moves it out (by replying
  // "confirm"/"discard" on the issue, per report-intake.js's reportConfirmScan; this is a
  // comment-driven trigger, the card's OWN column never has to move for the pipeline to notice).
  // Deliberately not "Parked", but NOT for the reason this comment used to give. It claimed
  // scripts/board-move.sh disarms the driver-scope marker of whatever checkout the move runs
  // from on a move to Done/Parked. Re-read on 2026-09-01 while verifying action 5.1b, which
  // moves cards to "Parked" from exactly this cwd: the live SPO-WebClient scripts/board-move.sh
  // is 125 lines of `gh api graphql` -- resolve the option id, write, re-read to confirm -- with
  // no git operation, no file write and no disarm branch anywhere in it. The claim is stale,
  // left over from the retired hook layer. The real reason "Intake" is its own column is that a
  // raw, unconfirmed report is not a parked pipeline card and a maintainer must not have to tell
  // them apart. A new Status option on the product's project board -- see
  // orchestrator/README.md § Report intake for the one-time board setup.
  // SPO_REPORT_INTAKE_COLUMN overrides.
  reportIntakeColumn: process.env.SPO_REPORT_INTAKE_COLUMN || 'Intake',

  // Marks a mechanically-filed raw card so nothing downstream mistakes it for a judged one.
  // Gates nothing by itself -- SPO-WebClient's claim-read.sh (what auto-pull reads) never
  // consults labels, only the Status column -- so intake.makeTask ALSO skips any issue carrying
  // this label, as a second, independent guard against a raw card that ends up in Todo through a
  // failed column move (see report-intake.js's own header on that failure mode).
  reportIntakeLabel: process.env.SPO_REPORT_INTAKE_LABEL || 'report:raw',

  // The confirm/discard comment scan's own timer (orchestrator/report-intake.js's
  // reportConfirmScan) -- deliberately NOT hung off pollIntervalMs (5s): a pending raw card may
  // sit for days, and N pending cards x 12 scans/minute is a REST budget leak for no benefit.
  // SPO_REPORT_CONFIRM_SCAN_MS overrides, 0 disables (report-intake still FILES raw cards, they
  // just never automatically progress past a maintainer's comment).
  reportConfirmScanMs: nonNegativeMsFromEnv('SPO_REPORT_CONFIRM_SCAN_MS', 5 * 60 * 1000),

  // daemon.js --real polls for reports a human has already replied "confirm" to (via the scan
  // above) on this timer, running orchestrator/intake.js's triageBugReport (reproduce/route/
  // dedup) + the existing reviewCard/fileCard gate. 0 (DISABLED) is no longer the load-bearing
  // safety default it was in the single-stage design -- see report-intake.js's header: nothing
  // reaches this stage without a prior human "confirm", so the risk this timer used to gate
  // (autonomous filing on a hallucinated reproduction) already requires a human act upstream.
  // Kept nonzero-by-default is still deliberately the maintainer's OWN call, not silently
  // flipped in this rewrite -- SPO_AUTO_TRIAGE_MS keeps the exact same name and env var; the
  // live systemd drop-in (SPO_AUTO_TRIAGE_MS=900000) keeps meaning "how often confirmed reports
  // are processed" without needing to change.
  autoTriageMs: AUTO_TRIAGE_MS,

  // How many CONFIRMED reports one auto-triage cycle processes. SPO_AUTO_TRIAGE_LIMIT overrides.
  autoTriageLimit:
    process.env.SPO_AUTO_TRIAGE_LIMIT !== undefined ? Number(process.env.SPO_AUTO_TRIAGE_LIMIT) : 3,

  // ---- action 3.3: mechanical-failure backoff (orchestrator/auto-triage.js) --------------
  //
  // A confirmed report whose triage fails MECHANICALLY (a deadline kill, a spawn failure, pool
  // exhaustion -- anything that never reached a verdict) used to be retried on every single
  // auto-triage cycle, forever: the audit sized this from a 2.5h incident, and the live evidence
  // since was worse -- a 12.8h stall across issues 449/455/456, 53 cycles, 128 attempts, running
  // the account pool down to exhaustion, every attempt a real `claude -p` reproduction. See
  // auto-triage.js's MECHANICAL_FAILURE_CAP (three strikes, then held with a dedicated comment)
  // and shouldSkipForTriageBackoff (this pair of settings).
  //
  // autoTriageBackoffBaseMs: the wait before the FIRST retry after a mechanical failure, doubled
  // per additional failure since the report's own report-confirmed anchor (mechanicalFailureHistory
  // resets the count on a fresh confirm -- see that function's own header, and note this is the
  // hook action 3.4's `spo triage --retry <issue>` uses to reset the budget by re-confirming).
  // Defaults to autoTriageMs ITSELF when that is configured (> 0): the first retry then waits
  // exactly one ordinary auto-triage cycle -- the cadence the daemon already runs at -- rather
  // than a second hand-picked number that could drift out of sync with it. Falls back to 15
  // minutes (auto-triage.js's own DEFAULT_AUTO_TRIAGE_MS, mirrored here as a literal rather than
  // required in, since config.js and auto-triage.js have never had a require() coupling and one
  // extra correlated constant is not worth inventing one) when autoTriageMs is unset/disabled (0)
  // -- e.g. a hand-run `spo triage --file` with no daemon timer configured at all.
  // SPO_AUTO_TRIAGE_BACKOFF_BASE_MS overrides.
  autoTriageBackoffBaseMs: positiveMsFromEnv(
    'SPO_AUTO_TRIAGE_BACKOFF_BASE_MS',
    AUTO_TRIAGE_MS > 0 ? AUTO_TRIAGE_MS : 15 * 60 * 1000
  ),

  // Absolute ceiling on the doubling above, regardless of how many mechanical failures have piled
  // up since the confirm anchor -- unbounded doubling is otherwise a real risk if
  // MECHANICAL_FAILURE_CAP ever changes (today's cap of 3 keeps the worst case small, but that is
  // a fact about auto-triage.js, not about this constant, and the two should not have to be kept
  // in sync by hand). 2 hours: long enough that a genuinely broken account pool or a wide
  // claude-code outage is not hammered every cycle while a maintainer is away, short enough that
  // fixing the mechanical cause during a normal working day still gets the report retried again
  // that same day without needing `spo triage --retry` by hand. SPO_AUTO_TRIAGE_BACKOFF_CEILING_MS
  // overrides.
  autoTriageBackoffCeilingMs: positiveMsFromEnv('SPO_AUTO_TRIAGE_BACKOFF_CEILING_MS', 2 * 60 * 60 * 1000),

  // Once a confirmed report survives reproduction + review as FILE/FILE_AMENDED, its (single,
  // amended-in-place) card moves straight to Todo -- true by default, since the human already
  // authorized it by confirming. Set false to leave it in reportIntakeColumn for a second human
  // look before it becomes eligible for auto-pull. SPO_AUTO_TRIAGE_PROMOTE_TO_TODO overrides
  // ('0'/'false' disables).
  autoTriagePromoteToTodo: !['0', 'false'].includes(String(process.env.SPO_AUTO_TRIAGE_PROMOTE_TO_TODO).toLowerCase()),

  // action 2.6: how stale a claim in spoReportsDir/in-progress/ must be, on top of a dead owner
  // pid, before auto-triage.js's reclaimStaleClaims treats it as abandoned (a process that died
  // mid-triage) rather than mid-write -- the exact same role orphanGraceMs plays above for a
  // crashed task's state.json, reused rather than inventing a second constant for an identical
  // shape of race. SPO_TRIAGE_CLAIM_GRACE_MS overrides.
  triageClaimGraceMs: nonNegativeMsFromEnv('SPO_TRIAGE_CLAIM_GRACE_MS', 4 * 60 * 1000),

  // ---- stage 0: remote report pull (orchestrator/remote-report-pull.js) -------------------
  //
  // Pulls queued reports from a production server's own bug-report store over HTTPS (the
  // dev box has the initiative -- it is not reachable from outside, doc/environments.md's own
  // "Flows between environments") and deposits them into spoReportsDir above, where stage 1
  // (report-intake.js) picks them up exactly as it does a locally-captured report. See
  // orchestrator/README.md § Report intake.
  //
  // Unset by default (both are required) -- deliberately inert until a maintainer opts a given
  // production deployment in, same posture "the intake column is a new maintainer-owned board
  // option" already has. SPO_REMOTE_REPORT_URL overrides; must be `https://` or the driver
  // refuses to run rather than silently downgrading to plaintext.
  remoteReportUrl: process.env.SPO_REMOTE_REPORT_URL || null,

  // Where the pull token lives on THIS machine -- outside every git tree, chmod 600, the same
  // "typed by hand, never scripted" reasoning SPO-Deploy's README already applies to every other
  // credential. Must match the SPO_REPORT_PULL_TOKEN pasted into production's own .env.
  // SPO_REPORT_PULL_TOKEN_FILE overrides.
  remoteReportTokenFile:
    process.env.SPO_REPORT_PULL_TOKEN_FILE || path.join(os.homedir(), '.spo-reports', '.pull-token'),

  // daemon.js --real polls production's /list route on this timer. Nonzero by default is SAFE
  // here (unlike a judgement-bearing timer) because the driver stays inert without BOTH
  // remoteReportUrl and a readable token file -- see remote-report-pull.js's own early return.
  // SPO_REMOTE_REPORT_PULL_MS overrides, 0 disables outright.
  remoteReportPullMs: nonNegativeMsFromEnv('SPO_REMOTE_REPORT_PULL_MS', 5 * 60 * 1000),

  // How many production-listed reports one pull cycle fetches. SPO_REMOTE_REPORT_PULL_LIMIT overrides.
  remoteReportPullLimit:
    process.env.SPO_REMOTE_REPORT_PULL_LIMIT !== undefined ? Number(process.env.SPO_REMOTE_REPORT_PULL_LIMIT) : 5,

  // Transport-level cap on one fetched report's byte size (untrusted input from a public
  // server) -- not schema knowledge, just a defensive ceiling matching bug-report-schema.ts's
  // own MAX_BODY_BYTES. SPO_REMOTE_REPORT_MAX_BYTES overrides.
  remoteReportMaxBytes:
    process.env.SPO_REMOTE_REPORT_MAX_BYTES !== undefined ? Number(process.env.SPO_REMOTE_REPORT_MAX_BYTES) : 4 * 1024 * 1024,

  // Backpressure: a pull cycle skips outright once the LOCAL spoReportsDir queue already holds
  // this many files, so a runaway or hostile production endpoint cannot fill the dev disk.
  // SPO_REMOTE_REPORT_QUEUE_CEILING overrides.
  remoteReportQueueCeiling:
    process.env.SPO_REMOTE_REPORT_QUEUE_CEILING !== undefined ? Number(process.env.SPO_REMOTE_REPORT_QUEUE_CEILING) : 50,

  // ---- park alerting (orchestrator/park-alert.js) ----------------------------------------
  //
  // One executable, spawned as `<cmd> <taskId> <reason> <lastState>` every time a real-mode
  // task parks -- the push half of a park (the pull surfaces are the journals and `spo
  // parked`). Unset (the default) means no-op. The command decides what a park is worth
  // (notify-send, ntfy, a reason filter); the daemon only reports. Never blocks a task.
  parkAlertCmd: process.env.SPO_PARK_ALERT_CMD || null,

  // NOTE -- no cumulative dollar ceiling, deliberately (maintainer decision, 2026-08-29, restated
  // 2026-08-31: dollars retired as the headline metric entirely). The pool is Claude Max
  // SUBSCRIPTION accounts (accounts.js) with a quota, never the metered API -- there was never a
  // real dollar spend to cap. What is worth measuring, and what `spo tokens`
  // (orchestrator/tokens.js) reports, is TOKEN efficiency: fresh input + cache-creation + output
  // ("billable-weighted tokens"), cache-read kept separate since it is near-free on a quota plan.
  // What actually constrains a run is the pool itself: per-account rate limits and the cooldowns
  // accounts.js already tracks.
  //
  // The PER-STEP caps in step-contracts.js stay, and were never about money either: they cut off
  // a step that has run away, whoever/whatever pays.

  // The observed lifetime of the `claude` CLI's "ephemeral 1h" prompt-cache tier (the real
  // per-message usage block's `cache_creation.ephemeral_1h_input_tokens`, verified from a live
  // session file 2026-08-31). This is a property of the Anthropic platform, not something this
  // project sets or controls -- it is named here only so orchestrator/tokens.js's advisory
  // "likely cache expiry" signal (a call whose gap since the task's previous llm-call exceeded
  // this TTL and whose own cache-creation tokens dominate its cache-read tokens) has one place
  // to read the threshold from, instead of a magic number buried in that module. Purely
  // informational: nothing in the state machine reads this value, and no behavior (retry, park,
  // scheduling, account rotation) is ever driven by it. SPO_CACHE_TTL_MS overrides (tests use
  // this to shorten the TTL rather than fabricating hour-long timestamps).
  cacheTtlMs: positiveMsFromEnv('SPO_CACHE_TTL_MS', 60 * 60 * 1000),

  REPO_ROOT,
  cwdForStep,
  WORKTREE_SIDE_STEPS,
};
