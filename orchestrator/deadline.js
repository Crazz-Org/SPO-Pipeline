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

async function callWithDeadline(ctx, state, fn) {
  try {
    return await withTimeout(fn, ctx.config.stepDeadlineMs, state);
  } catch (err) {
    if (!(err instanceof DeadlineError)) throw err;
    appendEvent(ctx.taskDir, state, 'deadline-exceeded', { attempt: 1, deadlineMs: ctx.config.stepDeadlineMs });
    try {
      return await withTimeout(fn, ctx.config.stepDeadlineMs, state);
    } catch (err2) {
      if (!(err2 instanceof DeadlineError)) throw err2;
      appendEvent(ctx.taskDir, state, 'deadline-exceeded', { attempt: 2, deadlineMs: ctx.config.stepDeadlineMs });
      throw new ParkSignal('step-deadline-exceeded-twice', { state });
    }
  }
}

module.exports = { callWithDeadline, withTimeout };
