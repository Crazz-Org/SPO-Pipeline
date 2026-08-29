'use strict';
// park-alert.js -- push notification on park, real mode only (state-machine.js's finalizePark
// calls this after the task's own PARKED journal/state/report are already written).
//
// WHY: a park is already well RECORDED -- journal event, state.json, report.md, the gh comment
// and the board move -- but every one of those surfaces has to be gone and looked at. A daemon
// left running overnight can park its whole queue and nothing says so. This is the push half.
//
// SHAPE: the daemon stays out of the notification business. SPO_PARK_ALERT_CMD (config.js's
// parkAlertCmd) names one executable; it is spawned as
//
//   <cmd> <taskId> <reason> <lastState>
//
// and the maintainer wires whatever it should do -- notify-send, an ntfy curl, a script that
// filters reasons (a rate-limit park that self-recovers may not deserve a ping; which reasons
// do is exactly what the auto-pull soak measures). Unset means no-op, and that is the default.
//
// POLICY: same as board.js's moveCard, verbatim -- an alert NEVER blocks or fails anything.
// Non-zero exit or spawn error is journaled (`park-alert-failed`) and the daemon proceeds; a
// hung command is cut off by a 10 s timeout. The task is terminal before this ever runs.
//
// `deps.spawnSync` is the test-only override, same convention as board.js / park-loop.js:
// production code never passes it.

const { spawnSync } = require('child_process');
const { appendEvent } = require('./journal');

const ALERT_TIMEOUT_MS = 10000;

function runSync(deps, command, args, opts = {}) {
  const spawnSyncFn = (deps && deps.spawnSync) || spawnSync;
  return spawnSyncFn(command, args, { encoding: 'utf8', timeout: ALERT_TIMEOUT_MS, ...opts });
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

// alertDaemon(cmd, deps, [id, reason, label]) -- the generic three-positional spawn every alert
// in this codebase reduces to: `<cmd> <id> <reason> <label>`. `label` defaults to `PARKED` in
// scripts/park-alert.sh (its 4th, optional positional -- backward compatible with every existing
// 3-arg spawn, this function's own default included) so a non-park alert (orchestrator/
// report-intake.js's own failure alerts) shows up distinctly in the log/ntfy title instead of
// misreporting itself as a park. Returns {ok, exit} -- never throws, no configured `cmd` is a
// silent no-op (the common case: not journaled, since every call would otherwise carry the same
// noise line).
function alertDaemon(cmd, deps, [id, reason, label]) {
  if (!cmd) return { ok: true, skipped: true };
  const result = runSync(deps, cmd, [String(id), String(reason), String(label || 'PARKED')]);
  const exit = normalizeExit(result);
  return { ok: exit === 0, exit };
}

// alertPark(ctx, deps, {reason, lastState}) -- alertDaemon wrapper for the park case specifically,
// journaling `park-alert`/`park-alert-failed` onto the task's own journal (every other caller of
// alertDaemon has no per-task journal to write into, and journals into daemon.jsonl itself).
function alertPark(ctx, deps, { reason, lastState }) {
  const cmd = ctx.config && ctx.config.parkAlertCmd;
  if (!cmd) return;

  const result = alertDaemon(cmd, deps, [ctx.id, reason, lastState]);
  if (!result.ok) {
    appendEvent(ctx.taskDir, 'PARKED', 'park-alert-failed', { cmd, exit: result.exit });
    return;
  }
  appendEvent(ctx.taskDir, 'PARKED', 'park-alert', { cmd, reason });
}

module.exports = { alertPark, alertDaemon, ALERT_TIMEOUT_MS };
