'use strict';
// board.js -- kanban column moves for the pilot: real-mode `npm run board:move -- <issue>
// "<Column>"` calls, one per orchestrator state, sharing one mapping table and one "never
// blocks the task" failure/skip policy. See CLAUDE.md's own `board:move` alias (cwd = a product
// worktree) -- this module is the one place besides steps/scripted.js's realFinish that spawns
// it.
//
// Column mapping (the maintainer created these five kanban columns alongside the existing
// Todo/Gate/Validation/Done, 2026-08-29):
//   WORKTREE (once the claimed worktree exists) -> Planning
//   IMPLEMENT                                    -> Implementing
//   CHECK                                        -> "Checks & PR"  (covers PUSH_PR too --
//                                                    no separate move at PUSH_PR)
//   GATE                                         -> Gate
//   VALIDATE                                     -> Validation
//   MERGE                                        -> Merging
//   PARKED                                       -> Parked
// CI_CHECKS is deliberately absent from the table -- it stays under "Gate", no move. FINISH
// keeps its own existing move to "Done" (steps/scripted.js's realFinish, unchanged) -- unlike
// every move here, that one still blocks the task on failure (finish-failed); this module is
// not involved in it.
//
// A move here NEVER blocks the task: a non-zero `board:move` exit, or no worktree yet to run it
// from (or no issue number at all), is journaled and the caller proceeds regardless -- board
// display is best-effort, the journal is the truth (the same principle FINISH's own move
// already lived by, generalized here to every other state).

const { spawnSync } = require('child_process');
const { appendEvent } = require('./journal');

const COLUMN_BY_STATE = {
  WORKTREE: 'Planning',
  IMPLEMENT: 'Implementing',
  CHECK: 'Checks & PR',
  GATE: 'Gate',
  VALIDATE: 'Validation',
  MERGE: 'Merging',
  PARKED: 'Parked',
};

// Same injection convention as steps/scripted.js's runSync / steps/llm.js's invokeClaudeReal:
// `deps.spawnSync` is the test-only override, production code never passes it.
function runSync(deps, command, args, opts = {}) {
  const spawnSyncFn = (deps && deps.spawnSync) || spawnSync;
  return spawnSyncFn(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

// moveCard(ctx, deps, state) -- spawns `npm run board:move -- <issue> "<Column>"` from
// ctx.task.worktreePath (cwd -- the alias needs a product cwd, same rule WORKTREE's own claim
// and FINISH's own move already follow). `state` must be a COLUMN_BY_STATE key; any other state
// name (notably CI_CHECKS) is a silent, unjournaled no-op by design. Never throws.
function moveCard(ctx, deps, state) {
  const column = COLUMN_BY_STATE[state];
  if (!column) return;

  const issue = ctx.task && ctx.task.issue;
  const worktreePath = ctx.task && ctx.task.worktreePath;

  if (!worktreePath) {
    appendEvent(ctx.taskDir, state, 'board-move-skipped', { reason: 'no worktree', column });
    return;
  }
  if (!issue) {
    appendEvent(ctx.taskDir, state, 'board-move-skipped', { reason: 'no issue', column });
    return;
  }

  const result = runSync(deps, 'npm', ['run', 'board:move', '--', String(issue), column], { cwd: worktreePath });
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, state, 'board-move-failed', { column, exit });
    return;
  }
  appendEvent(ctx.taskDir, state, 'board-move', { column });
}

module.exports = { COLUMN_BY_STATE, moveCard, runSync, normalizeExit };
