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
// CI_CHECKS is deliberately absent from the table -- it stays under "Gate", no move. Action 5.1e
// re-weighed this rather than leaving it un-examined: the one live card that ever measured it
// (#471) spent 41 seconds in CI_CHECKS, and the daemon's own in-flight poll for it is bounded at
// ~10 minutes worst case. A single-select option-add is a GraphQL schema mutation (no `gh project
// field-create` for it -- orchestrator/README.md), and the columns are deliberately coarser than
// the states already ("Checks & PR" alone covers CHECK+PUSH_PR, no separate PUSH_PR move below).
// A 41-second-typical window on a ~10-minute worst-case bound does not earn a sixth column.
// Decision: no new column, unchanged.
//
// FINISH keeps its own existing move to "Done" (steps/scripted.js's realFinish, unchanged) and is
// deliberately absent from COLUMN_BY_STATE too -- NOT an oversight, do not add a `FINISH: 'Done'`
// entry. Every entry in this table is reached through moveCard, whose whole contract (this
// header, below) is "never blocks the task"; FINISH's move to Done is the one move in the whole
// daemon that MUST block on failure -- a card the daemon cannot mark Done is not actually done.
// Adding the entry would silently arm the non-blocking path for it. realFinish journals its own
// `board-move`/`board-move-failed` events directly (action 5.1a) so the journal can still answer
// "when did this reach Done" without going through this module at all -- see realFinish's own
// header comment in steps/scripted.js for the matching note and the measurement that motivated
// it (14 of 18 corpus tasks had `Merging` as their last journalled board-move before this).
//
// A move here NEVER blocks the task: a non-zero `board:move` exit, or no worktree AND no
// config.productRepo to fall back to (action 5.1b), or no issue number at all, is journaled and
// the caller proceeds regardless -- board display is best-effort, the journal is the truth (the
// same principle FINISH's own move already lived by, generalized here to every other state).

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

// Action 5.1c: an in-memory, per-ctx memo of the last column THIS RUN successfully moved a card
// to. Measured: 12 redundant consecutive moves across 7 tasks (201, 213, 247, 385, 428, 439,
// 452), every one an Implementing -> Implementing repeat -- state-machine.js's handleImplement
// calls moveCard(ctx, deps, 'IMPLEMENT') unconditionally on every entry, and DIAGNOSE -> IMPLEMENT
// re-enters it on every retry. Implementing has 42 moves in the corpus against Planning's 29; the
// gap is exactly this. Each redundant move is a real `npm run board:move` spawn AND a real
// GraphQL mutation against the shared 5000-point hourly budget, for a card that is already
// sitting in the column it is about to be told to move to.
//
// Keyed on the ctx object itself via a WeakMap, deliberately NOT a field written onto ctx and
// NOT persisted to state.json or read back from the journal: a fresh ctx -- a retry (which always
// restarts a task at INTAKE), an orphan-scan repark, a plain daemon restart -- has no entry here
// and the very next moveCard call re-asserts the column from scratch, exactly like a first move
// would. So does a human who moved the card by hand on the live board in the meantime. A
// persistent memo would let the board drift out of sync permanently and stay that way -- the
// exact failure this whole action (5.1) exists to prevent, so the memo's lifetime is capped at
// "this process, this ctx" on purpose.
//
// Only a column a move ACTUALLY SUCCEEDED at is ever recorded (set below, after the exit check) --
// a failed move leaves the memo untouched, so the next attempt to the same column still spawns
// and gets a real chance to land, instead of a transient failure permanently "poisoning" the
// column as already-handled.
const lastMovedColumn = new WeakMap();

// moveCard(ctx, deps, state) -- spawns `npm run board:move -- <issue> "<Column>"`, cwd =
// ctx.task.worktreePath when it exists (the alias needs a product cwd, same rule WORKTREE's own
// claim and FINISH's own move already follow); action 5.1b falls back to ctx.config.productRepo
// when there is no worktree yet (see below). `state` must be a COLUMN_BY_STATE key; any other
// state name (notably CI_CHECKS) is a silent, unjournaled no-op by design. Never throws.
function moveCard(ctx, deps, state) {
  const column = COLUMN_BY_STATE[state];
  if (!column) return;

  // 5.1c dedupe, checked before anything else: a card already sitting in `column` (per this
  // run's own memo, above) gets no spawn and no GraphQL mutation, just a visible skip so the
  // dedupe itself is on the record rather than a silent no-op.
  if (lastMovedColumn.get(ctx) === column) {
    appendEvent(ctx.taskDir, state, 'board-move-skipped', { reason: 'already-in-column', column });
    return;
  }

  const issue = ctx.task && ctx.task.issue;
  const worktreePath = ctx.task && ctx.task.worktreePath;
  // Action 5.1b: a park (or any other move) before the worktree exists used to just give up --
  // measured 6 real `board-move-skipped {reason: "no worktree"}` occurrences in the corpus
  // (issue-385 x5, issue-247 x1), all of them PARKED. The product repo checkout
  // (ctx.config.productRepo) always exists even when the per-task worktree does not, and it is
  // already the cwd moveIssueToColumn's own callers (report-intake.js, auto-triage.js) use for
  // exactly this alias with no worktree in scope at all -- so fall back to it here instead of
  // giving up. Deliberately general (any state reaching this line, not just PARKED): it is the
  // identical `board:move` call either way, and special-casing PARKED would just be a trap for
  // the next reader who adds a state that also needs this. `via: 'product-repo'` distinguishes
  // the fallback in the journal from an ordinary worktree-cwd move rather than leaving the two
  // indistinguishable.
  //
  // Known risk, stated honestly rather than pretended away: this path is not perfectly reliable
  // -- the corpus has exactly one `report-intake-move-failed {issue: 443, column: "Intake", exit:
  // 2}` (2026-08-30) from this same moveIssueToColumn call. That is why the fallback below
  // journals its own failures distinguishably (still carrying `via: 'product-repo'`) instead of
  // silently assuming it always works.
  const cwd = worktreePath || (ctx.config && ctx.config.productRepo);
  const viaProductRepo = !worktreePath && !!cwd;

  if (!cwd) {
    appendEvent(ctx.taskDir, state, 'board-move-skipped', { reason: 'no worktree', column });
    return;
  }
  if (!issue) {
    appendEvent(ctx.taskDir, state, 'board-move-skipped', { reason: 'no issue', column });
    return;
  }

  const result = runSync(deps, 'npm', ['run', 'board:move', '--', String(issue), column], { cwd }, ctx.config);
  const exit = normalizeExit(result);
  if (exit !== 0) {
    appendEvent(ctx.taskDir, state, 'board-move-failed', {
      column,
      exit,
      timedOut: result.timedOut === true,
      ...(viaProductRepo ? { via: 'product-repo' } : {}),
    });
    return;
  }
  appendEvent(ctx.taskDir, state, 'board-move', { column, ...(viaProductRepo ? { via: 'product-repo' } : {}) });
  // Record the successful column LAST, only once the spawn is known to have exited 0 -- see the
  // memo's own header comment above for why a failure must never reach this line.
  lastMovedColumn.set(ctx, column);
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
