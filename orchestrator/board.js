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

const { appendEvent } = require('./journal');
const { armTimeout } = require('./command-timeout');

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
//
// action 2.1b: routed through command-timeout.js's armTimeout, so `npm run board:move` (a
// `moveCard` call is on the direct path of realWorktree/realCheck/realGate/realMerge -- see this
// file's own header) now carries the same class timeout every other real command in the daemon
// does, instead of running unbounded. `config` is optional and threaded through by each caller
// below (ctx.config for moveCard, an explicit opts.config for moveIssueToColumn, which has no
// ctx) -- a missing config arms no timeout, exactly the pre-2.1b behaviour, never a crash (see
// armTimeout/classTimeoutMs's own tolerance for a config-less call). The returned result carries
// `timedOut`/`commandClass`/`timeoutMs` so callers can journal a hang distinguishably -- see
// moveCard's and moveIssueToColumn's own failure paths below. Never retried and never thrown as a
// ParkSignal here: moveCard's whole contract is "never blocks the task" (this file's own header),
// so a caller that could throw on a hung board move would break every one of its own callers,
// several of them mid real-mode step (WORKTREE/CHECK/GATE/VALIDATE/MERGE). A board move gets
// another chance the next time this state's own move fires, or simply stays visually stale on the
// kanban board -- cosmetic, never load-bearing (the journal is the truth, per this file's header).
function runSync(deps, command, args, opts = {}, config) {
  return armTimeout(deps, config, command, args, opts);
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

  const result = runSync(deps, 'npm', ['run', 'board:move', '--', String(issue), column], { cwd: worktreePath }, ctx.config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, state, 'board-move-failed', { column, exit, timedOut: result.timedOut === true });
    return;
  }
  appendEvent(ctx.taskDir, state, 'board-move', { column });
}

// moveIssueToColumn(issueNumber, column, deps, {cwd, config}) -- the same `npm run board:move --
// <issue> "<Column>"` call moveCard makes, for a caller with no ctx/taskDir/worktree at all
// (orchestrator/report-intake.js, orchestrator/auto-triage.js -- neither has a task worktree,
// only an issue number and config.productRepo as cwd, the same cwd pullBoard/makeTask already
// use for their own npm/gh calls). Unlike moveCard, this does NOT journal (the caller has no
// ctx.taskDir -- it journals into daemon.jsonl itself) and DOES return the result, since a
// caller here has to react to a failed move (see report-intake.js's own header on why a failed
// move to "Intake" is not safe to ignore, unlike every moveCard failure). Never blocks by
// itself; whether to treat a failure as blocking is entirely the caller's call.
//
// `config` (action 2.1b, optional) is threaded through to runSync/armTimeout exactly like
// moveCard's own ctx.config -- an omitted config arms no timeout, same pre-2.1b behaviour, never
// a crash. `timedOut` rides on the returned failure shape so a caller can journal a hang
// distinguishably from a plain non-zero exit, same convention as the failure `exit`/`stderr`
// fields already carry.
function moveIssueToColumn(issueNumber, column, deps, { cwd, config } = {}) {
  const result = runSync(deps, 'npm', ['run', 'board:move', '--', String(issueNumber), column], { cwd }, config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    return { ok: false, exit, stderr: result && result.stderr, timedOut: result.timedOut === true };
  }
  return { ok: true };
}

module.exports = { COLUMN_BY_STATE, moveCard, moveIssueToColumn, runSync, normalizeExit };
