#!/usr/bin/env node
'use strict';
// Default runtime configuration for the orchestrator daemon.
// Every field here can be overridden by a daemon.js CLI flag (see orchestrator/README.md).

const path = require('path');

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

  // Claude Max account pool: registry (accounts.json) + runtime cooldown state (state.json),
  // see orchestrator/accounts.js. Git-ignored (claude-accounts/ in .gitignore) -- a missing
  // registry here is not an error, accounts.js falls back to one implicit default account.
  claudeAccountsDir: path.join(REPO_ROOT, 'claude-accounts'),

  REPO_ROOT,
  cwdForStep,
  WORKTREE_SIDE_STEPS,
};
