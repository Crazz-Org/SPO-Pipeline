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
const holdMod = require(path.join(__dirname, '..', '..', 'orchestrator', 'product-repo-hold'));

process.stdout.write(
  JSON.stringify({
    git: config.commandTimeoutsMs.git,
    gh: config.commandTimeoutsMs.gh,
    npmCi: config.commandTimeoutsMs['npm-ci'],
    // Action B1.4: FINISH's own 'finish-sync' critical section (fast-forward + conditional bench
    // reinstall) needs the bench-install class' own timeout too, plus its call-count constants, so
    // the derivation test below can recompute finishSyncHoldMs/finishStepDeadlineMs from the SAME
    // documented formula product-repo-hold.js uses, rather than hardcoding it a second time.
    benchInstall: config.commandTimeoutsMs['bench-install'],
    // Post-verification hazard fix (action B1.4): the bounded bench-idle wait ahead of the
    // reinstall runs INSIDE 'finish-sync' too, so it has to be part of the SAME recomputation --
    // see product-repo-hold.js's own finishSyncHoldMs comment.
    benchIdleWaitMaxMs: config.benchIdleWaitMaxMs,
    SETUP_GIT_CALLS: lockMod.SETUP_GIT_CALLS,
    SETUP_GH_CALLS: lockMod.SETUP_GH_CALLS,
    FINISH_SYNC_GIT_CALLS: holdMod.FINISH_SYNC_GIT_CALLS,
    FINISH_SYNC_GH_CALLS: holdMod.FINISH_SYNC_GH_CALLS,
    FINISH_SYNC_BENCH_INSTALL_CALLS: holdMod.FINISH_SYNC_BENCH_INSTALL_CALLS,
    // R2 (post-verification, third pass): 'bench-install' is exempt from spawnStep's retry
    // (never runs twice on a timeout -- see spawnStep's own comment), so finishSyncHoldMs
    // budgets it at ONE attempt, not SPAWN_ATTEMPTS_PER_CALL's usual two -- printed here so
    // the derivation test below recomputes from the SAME source rather than hardcoding 1 a
    // second time.
    FINISH_SYNC_BENCH_INSTALL_ATTEMPTS: holdMod.FINISH_SYNC_BENCH_INSTALL_ATTEMPTS,
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
