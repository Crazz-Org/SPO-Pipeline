'use strict';
// Two control-flow errors used only inside the state machine:
//
//   ParkSignal    - thrown by a handler to end the task at PARKED, with a reason string and
//                   optional detail object. Caught exactly once, at the top of runTask.
//   DeadlineError - thrown internally by deadline.js when a step's wall-clock budget expires.
//                   Handlers never see this directly; deadline.js turns a second consecutive
//                   one into a ParkSignal('step-deadline-exceeded-twice').
//
// Any OTHER thrown error is a real bug in this codebase and is left to propagate (crash the
// daemon/test), not swallowed into a park -- see orchestrator/README.md "catch-all" note.

class ParkSignal extends Error {
  constructor(reason, detail = {}) {
    super(`PARKED: ${reason}`);
    this.name = 'ParkSignal';
    this.reason = reason;
    this.detail = detail;
  }
}

class DeadlineError extends Error {
  constructor(label) {
    super(`deadline exceeded: ${label}`);
    this.name = 'DeadlineError';
    this.label = label;
  }
}

module.exports = { ParkSignal, DeadlineError };
