'use strict';
// Fixture for test/product-repo-lock.test.js's derivation check (action 6.4's item 6): a fresh
// process, so orchestrator/config.js's env-var-read commandTimeoutsMs (SPO_TIMEOUT_GIT_MS etc.,
// read once at require time) can actually be varied between runs -- mutating an already-required
// config.js's fields in-process would not exercise the real load path timeoutFromEnv uses.
//
// Prints JSON: the raw commandTimeoutsMs inputs product-repo-lock.js's WORST_HOLD_MS/
// MAX_LOCK_AGE_MS were built from, plus the derived numbers themselves and the call-count
// constants (SETUP_GIT_CALLS/SETUP_GH_CALLS) -- everything the test needs to independently
// recompute the expected values from the SAME documented formula, rather than hardcoding it twice.

const path = require('path');

const config = require(path.join(__dirname, '..', '..', 'orchestrator', 'config'));
const lockMod = require(path.join(__dirname, '..', '..', 'orchestrator', 'product-repo-lock'));

process.stdout.write(
  JSON.stringify({
    git: config.commandTimeoutsMs.git,
    gh: config.commandTimeoutsMs.gh,
    npmCi: config.commandTimeoutsMs['npm-ci'],
    SETUP_GIT_CALLS: lockMod.SETUP_GIT_CALLS,
    SETUP_GH_CALLS: lockMod.SETUP_GH_CALLS,
    WORST_HOLD_MS: lockMod.WORST_HOLD_MS,
    MAX_LOCK_AGE_MS: lockMod.MAX_LOCK_AGE_MS,
    // Action 6.4 (post-verification): WORKTREE's and FINISH's step deadlines are derived from the
    // SAME wait bound, so they are printed here and checked by the same derivation test -- a
    // literal that drifts past commandTimeoutsMs or past K is the exact failure this catches.
    workers: config.workers,
    stepDeadlineMs: config.stepDeadlineMs,
    WORKTREE_DEADLINE_MS: config.stepDeadlineMsByState.WORKTREE,
    FINISH_DEADLINE_MS: config.stepDeadlineMsByState.FINISH,
    waitBoundMs: lockMod.waitBoundMs(config),
  })
);
