'use strict';
// Per-step wall-clock deadline: spawn once, wait with a deadline, on expiry treat the step as
// killed, retry once, and PARK if the retry also expires. Never a third attempt, never two
// live invocations of the same step for the same task (state-machine-spec.md design
// consequence #3 / improvisation-analysis.md row R5 -- the "sub-agent hadn't returned" family).

const { appendEvent } = require('./journal');
const { ParkSignal, DeadlineError } = require('./park-signal');

// Races fn() (a () => Promise) against a ms timer. Resolves/rejects with whichever settles
// first; the loser is left to finish in the background and is simply ignored (see
// orchestrator/README.md for the one caveat this implies for the deadline test).
function withTimeout(fn, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DeadlineError(label));
    }, ms);

    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
  });
}

// The deadline for one state: config.stepDeadlineMsByState[state] when the state declares its
// own, else the generic config.stepDeadlineMs. A state needs an override when it sleeps on
// purpose inside its own invocation -- CI_CHECKS' bounded in-flight wait is the only one today,
// and config.js derives its ceiling from that wait's own budget so the two cannot drift apart.
// A state whose deadline is SHORTER than the work it legitimately does is not merely retried:
// withTimeout abandons the loser rather than cancelling it, so the overrun invocation keeps
// running (and keeps spending) alongside its own retry.
function deadlineMsFor(config, state) {
  const byState = config.stepDeadlineMsByState;
  if (byState && byState[state] != null) return byState[state];
  return config.stepDeadlineMs;
}

async function callWithDeadline(ctx, state, fn) {
  const deadlineMs = deadlineMsFor(ctx.config, state);
  try {
    return await withTimeout(fn, deadlineMs, state);
  } catch (err) {
    if (!(err instanceof DeadlineError)) throw err;
    appendEvent(ctx.taskDir, state, 'deadline-exceeded', { attempt: 1, deadlineMs });
    try {
      return await withTimeout(fn, deadlineMs, state);
    } catch (err2) {
      if (!(err2 instanceof DeadlineError)) throw err2;
      appendEvent(ctx.taskDir, state, 'deadline-exceeded', { attempt: 2, deadlineMs });
      throw new ParkSignal('step-deadline-exceeded-twice', { state });
    }
  }
}

module.exports = { callWithDeadline, withTimeout, deadlineMsFor };
