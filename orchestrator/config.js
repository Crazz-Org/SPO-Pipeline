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

module.exports = {
  // Wall-clock deadline for a single step invocation (scripted or llm), in milliseconds.
  // On expiry the step is treated as killed, retried once, and PARKED if it expires again.
  stepDeadlineMs: 120000,

  // DIAGNOSE -> IMPLEMENT retry budget: at most this many DIAGNOSE attempts per task,
  // and any root cause seen twice parks immediately even under budget.
  diagnoseBudget: 3,

  // VALIDATE (change-validator) REJECT budget: a separate counter from diagnoseBudget.
  validateRejectBudget: 3,

  // Poll interval for daemon.js when run without --once (queue watch mode).
  pollIntervalMs: 5000,

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
  productRepo: path.join(os.homedir(), 'SPO-WebClient'),

  // Where WORKTREE creates one `git worktree add` per task (<dir>/<taskId>). Gitignored
  // (worktrees/ in .gitignore) -- disposable, FINISH removes its own entry with
  // `git worktree remove --force`.
  pipelineWorktreesDir: path.join(REPO_ROOT, 'worktrees'),

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

  // ---- park alerting (orchestrator/park-alert.js) ----------------------------------------
  //
  // One executable, spawned as `<cmd> <taskId> <reason> <lastState>` every time a real-mode
  // task parks -- the push half of a park (the pull surfaces are the journals and `spo
  // parked`). Unset (the default) means no-op. The command decides what a park is worth
  // (notify-send, ntfy, a reason filter); the daemon only reports. Never blocks a task.
  parkAlertCmd: process.env.SPO_PARK_ALERT_CMD || null,

  // NOTE -- no cumulative spend ceiling, deliberately (maintainer decision, 2026-08-29). The
  // pool is Claude Max SUBSCRIPTION accounts (accounts.js), not the metered API: the `costUsd`
  // the CLI reports, and that cost.js sums, is a NOTIONAL API-equivalent figure, not money
  // leaving an account. It is worth measuring -- it is the migration plan's efficiency metric
  // against the old driver's baseline, and `spo cost` reports it -- but capping it would be
  // enforcing a limit that does not exist. What actually constrains a run is the pool itself:
  // per-account rate limits and the cooldowns accounts.js already tracks.
  //
  // The PER-STEP caps in step-contracts.js stay, and are not about money either: they cut off
  // a step that has run away (a PLAN spinning past $3 is a broken PLAN, whoever pays).

  REPO_ROOT,
  cwdForStep,
  WORKTREE_SIDE_STEPS,
};
