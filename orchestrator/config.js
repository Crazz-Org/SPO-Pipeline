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
