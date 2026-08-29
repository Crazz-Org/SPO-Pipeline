'use strict';
// ci-cause-table.js -- the CI_CHECKS "failing check name -> what happens" mapping, shared by
// the shadow-fixture path (state-machine.js's handleCiChecks) and the real check-runs path
// (steps/scripted.js's realCiChecks), so the two can never silently drift apart.
//
// doc/state-machine-spec.md's CI_CHECKS row: "Coverage of changed lines" -> IMPLEMENT,
// "Lint" -> IMPLEMENT, "PR rules" (protected files, needs `rdo-approved`) -> PARKED,
// anything else -> DIAGNOSE.

function classifyCiFailure(checkName) {
  if (checkName === 'Coverage of changed lines') return { kind: 'retry', nextState: 'IMPLEMENT' };
  if (checkName === 'Lint') return { kind: 'retry', nextState: 'IMPLEMENT' };
  if (checkName === 'PR rules') return { kind: 'park', reason: 'pr-rules-needs-approval' };
  return { kind: 'retry', nextState: 'DIAGNOSE' };
}

module.exports = { classifyCiFailure };
