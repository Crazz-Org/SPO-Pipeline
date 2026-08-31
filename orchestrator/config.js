#!/usr/bin/env node
'use strict';
// Default runtime configuration for the orchestrator daemon.
// Every field here can be overridden by a daemon.js CLI flag (see orchestrator/README.md).

const path = require('path');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..');

// cwd policy for real-mode `claude -p` calls (steps/llm.js). Shadow mode never spawns anything,
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
const CI_CHECKS_POLL_INTERVAL_MS =
  process.env.SPO_CI_CHECKS_POLL_INTERVAL_MS !== undefined
    ? Number(process.env.SPO_CI_CHECKS_POLL_INTERVAL_MS)
    : 20000;

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

module.exports = {
  // Wall-clock deadline for a single step invocation (scripted or llm), in milliseconds.
  // On expiry the step is treated as killed, retried once, and PARKED if it expires again.
  stepDeadlineMs: STEP_DEADLINE_MS,

  // DIAGNOSE -> IMPLEMENT retry budget: at most this many DIAGNOSE attempts per task,
  // and any root cause seen twice parks immediately even under budget.
  diagnoseBudget: 3,

  // VALIDATE (change-validator) REJECT budget: a separate counter from diagnoseBudget.
  validateRejectBudget: 3,

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
  stepDeadlineMsByState: {
    CI_CHECKS: CI_CHECKS_MAX_POLLS * CI_CHECKS_POLL_INTERVAL_MS + STEP_DEADLINE_MS,
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
  commandTimeoutsMs: {
    git: timeoutFromEnv('SPO_TIMEOUT_GIT_MS', 120000),
    gh: timeoutFromEnv('SPO_TIMEOUT_GH_MS', 120000),
    'npm-ci': timeoutFromEnv('SPO_TIMEOUT_NPM_CI_MS', 600000),
    'npm-gate': timeoutFromEnv('SPO_TIMEOUT_NPM_GATE_MS', 7800000),
    'npm-run': timeoutFromEnv('SPO_TIMEOUT_NPM_RUN_MS', 660000),
  },

  // Poll interval for daemon.js when run without --once (queue watch mode).
  pollIntervalMs: 5000,

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
  orphanScanMs: process.env.SPO_ORPHAN_SCAN_MS !== undefined ? Number(process.env.SPO_ORPHAN_SCAN_MS) : 60 * 1000,

  // How stale state.json's updatedAt must be, on top of a dead owner pid, before a task is
  // treated as orphaned rather than mid-transition-write. Longer than any legitimate step
  // (stepDeadlineMs above), short enough that a real orphan does not sit unrecovered for long.
  // SPO_ORPHAN_GRACE_MS overrides.
  orphanGraceMs:
    process.env.SPO_ORPHAN_GRACE_MS !== undefined ? Number(process.env.SPO_ORPHAN_GRACE_MS) : 4 * 60 * 1000,

  // How often the running daemon re-reads its own lock file to confirm it is still the holder
  // (orchestrator/lock.js's watchLock) -- acquireLock only ever checks once, at startup.
  // SPO_LOCK_WATCH_MS overrides.
  lockWatchMs: process.env.SPO_LOCK_WATCH_MS !== undefined ? Number(process.env.SPO_LOCK_WATCH_MS) : 15 * 1000,

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

  // Where WORKTREE creates one `git worktree add` per task (<dir>/<taskId>). Gitignored
  // (worktrees/ in .gitignore) -- disposable, FINISH removes its own entry with
  // `git worktree remove --force`.
  pipelineWorktreesDir: process.env.SPO_WORKTREES_DIR || path.join(REPO_ROOT, 'worktrees'),

  // owner/repo for every `gh api` / `gh pr` / `gh issue` real call.
  ghRepo: 'Crazz-Org/SPO-WebClient',

  // Local surfaces this build reads instead of polling GitHub/the bench for state that already
  // has one: ~/.spo-bench/nightly/latest.json (WORKTREE's/CI_CHECKS' nightly-red refusal) and
  // ~/.spo-bench/verdicts/<sha>.json (CI_CHECKS' baseMain, for the main-moved intersection).
  spoBenchDir: path.join(os.homedir(), '.spo-bench'),

  // ---- kanban piloting: auto-pull (orchestrator/auto-pull.js) ----------------------------
  //
  // daemon.js --real polls the board on this timer, between drain passes (state-machine.js's
  // runForever), running the same pullBoard + makeTask `spo pull` already does by hand, for the
  // top autoPullLimit claimable candidates. 0 disables the timer entirely. SPO_AUTO_PULL_MS
  // overrides -- see orchestrator/README.md § Kanban piloting for the GraphQL cost.
  autoPullMs: process.env.SPO_AUTO_PULL_MS !== undefined ? Number(process.env.SPO_AUTO_PULL_MS) : 5 * 60 * 1000,
  // How many claimable candidates one auto-pull cycle takes off the board. NOT a concurrency
  // setting -- drainQueueOnce works the queue strictly serially -- but because runForever
  // AWAITS that drain before pulling again, a pull only ever happens with the daemon idle: so
  // this is the most cards that can sit off the board, unstarted, at any moment.
  //
  // Default 1 (maintainer decision, 2026-08-29): the daemon takes one card, finishes it, then
  // looks again. Cards stay on the board -- visible, reorderable, claimable by a human --
  // until the daemon is actually ready for them. Raise it if serial intake proves to be the
  // bottleneck. SPO_AUTO_PULL_LIMIT overrides.
  autoPullLimit:
    process.env.SPO_AUTO_PULL_LIMIT !== undefined ? Number(process.env.SPO_AUTO_PULL_LIMIT) : 1,

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
  autoIntakeMs:
    process.env.SPO_AUTO_INTAKE_MS !== undefined ? Number(process.env.SPO_AUTO_INTAKE_MS) : 15 * 60 * 1000,

  // How many queued reports one intake cycle files. SPO_AUTO_INTAKE_LIMIT overrides.
  autoIntakeLimit:
    process.env.SPO_AUTO_INTAKE_LIMIT !== undefined ? Number(process.env.SPO_AUTO_INTAKE_LIMIT) : 3,

  // The Status column a raw report's card is filed into -- a human moves it out (by replying
  // "confirm"/"discard" on the issue, per report-intake.js's reportConfirmScan; this is a
  // comment-driven trigger, the card's OWN column never has to move for the pipeline to notice).
  // Deliberately not "Parked": SPO-WebClient's scripts/board-move.sh disarms the driver-scope
  // marker of whatever checkout the move runs from on a move to Done/Parked -- this repo has no
  // task worktree for these moves (cwd = config.productRepo, same as pullBoard/makeTask), and
  // "Intake"/"Todo" both avoid that branch entirely. A new Status option on the product's
  // project board -- see orchestrator/README.md § Report intake for the one-time board setup.
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
  reportConfirmScanMs:
    process.env.SPO_REPORT_CONFIRM_SCAN_MS !== undefined ? Number(process.env.SPO_REPORT_CONFIRM_SCAN_MS) : 5 * 60 * 1000,

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
  autoTriageMs:
    process.env.SPO_AUTO_TRIAGE_MS !== undefined ? Number(process.env.SPO_AUTO_TRIAGE_MS) : 0,

  // How many CONFIRMED reports one auto-triage cycle processes. SPO_AUTO_TRIAGE_LIMIT overrides.
  autoTriageLimit:
    process.env.SPO_AUTO_TRIAGE_LIMIT !== undefined ? Number(process.env.SPO_AUTO_TRIAGE_LIMIT) : 3,

  // Once a confirmed report survives reproduction + review as FILE/FILE_AMENDED, its (single,
  // amended-in-place) card moves straight to Todo -- true by default, since the human already
  // authorized it by confirming. Set false to leave it in reportIntakeColumn for a second human
  // look before it becomes eligible for auto-pull. SPO_AUTO_TRIAGE_PROMOTE_TO_TODO overrides
  // ('0'/'false' disables).
  autoTriagePromoteToTodo: !['0', 'false'].includes(String(process.env.SPO_AUTO_TRIAGE_PROMOTE_TO_TODO).toLowerCase()),

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
  remoteReportPullMs:
    process.env.SPO_REMOTE_REPORT_PULL_MS !== undefined ? Number(process.env.SPO_REMOTE_REPORT_PULL_MS) : 5 * 60 * 1000,

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
  cacheTtlMs: process.env.SPO_CACHE_TTL_MS !== undefined ? Number(process.env.SPO_CACHE_TTL_MS) : 60 * 60 * 1000,

  REPO_ROOT,
  cwdForStep,
  WORKTREE_SIDE_STEPS,
};
