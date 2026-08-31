'use strict';
// ci-cause-table.js -- the CI_CHECKS "failing check -> what happens" mapping, shared by the
// shadow-fixture path (state-machine.js's handleCiChecks) and the real check-runs path
// (steps/scripted.js's realCiChecks), so the two can never silently drift apart.
//
// Action 4.3: this table used to classify on `checkName` alone, against three names --
// 'Coverage of changed lines', 'Lint', 'PR rules' -- copied from doc/state-machine-spec.md's
// CI_CHECKS row. NONE of those three names is a check name: `gh api
// repos/<repo>/commits/<sha>/check-runs` only ever returns JOB names (the names GitHub Actions
// shows as top-level entries on a PR), and they are the step names from *inside* ci.yml's
// `verify` job. Measured on five real SPO-WebClient commits, the complete set of job names the
// runtime can ever see is: `typecheck + tests`, `claude review`, `analyze`, `CodeQL`, `label`,
// `release`, `orphan watch`, `Dependabot` -- not one of the three names above. So every CI
// failure the pipeline has ever seen fell through to the `anything else` row (DIAGNOSE), and the
// IMPLEMENT and PARK rows had never once fired in production.
//
// The fix: `check_run.id` IS the GitHub Actions job id. `gh api repos/<repo>/actions/jobs/<id>`
// returns that job with a `steps[]` array, each `{name, conclusion}` -- and THAT is where the
// three names above actually live. Verified against six real failed runs (33373038192 /
// 33286934385 / 33278461271 / 33253561998 / 33248044255 / 33216988010): each yielded exactly
// `Coverage of changed lines`, `Lint`, `Tests` as step names, matching what this table was
// written against all along. steps/scripted.js's realCiChecks now does that second lookup and
// passes the failing STEP name here as `stepName`; classification below runs on `stepName`, not
// `checkName`.
//
// `checkName` is kept as the first parameter only so the shadow-fixture path's legacy
// single-argument call (`classifyCiFailure(failingCheck)`, every pre-4.3 fixture in the suite)
// keeps working: a bare check name with no step lands on the `stepName` absent branch below and
// resolves to DIAGNOSE, whatever the name is. That IS a real, deliberate routing change for
// those fixtures, not a shim to preserve old behaviour -- the old behaviour was itself the bug
// (a fixture named 'Lint' used to route straight to IMPLEMENT, which the measurement above shows
// could never happen for a real 'Lint' CHECK name). It is not, however, a claim that shadow mode
// can no longer reach IMPLEMENT or PARK: state-machine.js's resolveShadowCiChecks also accepts a
// `{check, step}` fixture and calls this function with both arguments, because dropping shadow
// mode's end-to-end coverage of the two routes this action makes reachable would have been a
// regression dressed up as a simplification.
//
// The real step names in `.github/workflows/ci.yml`'s `verify` job, in order: `Checkout`,
// `Setup Node.js`, `Install dependencies`, `Lint`, `Typecheck (server + client)`,
// `Build (server + client + terrain-test)`, `Audit production dependencies (SEC-D-1)`, `Tests`,
// `Coverage of changed lines`, `PR rules (coverage ratchet, RDO citation)`,
// `Skills manifest is current`, `Hooks parse`.
//
// Matching is EXACT ONLY -- no substring, no prefix, no case folding. C3 shipped a bug behind
// exactly that kind of loose match; this table does not repeat it. A step name this table does
// not recognise (renamed in ci.yml, a step this chantier never measured, or no step info at
// all) deliberately degrades to DIAGNOSE rather than to a silent retry or a silent park: DIAGNOSE
// is "ask a judge", the one outcome that is always safe to fall back to when the table's own
// knowledge of ci.yml might be stale.
function classifyCiFailure(checkName, stepName) {
  if (typeof stepName === 'string' && stepName.length > 0) {
    if (stepName === 'Lint') return { kind: 'retry', nextState: 'IMPLEMENT' };
    if (stepName === 'Coverage of changed lines') return { kind: 'retry', nextState: 'IMPLEMENT' };
    if (stepName === 'PR rules (coverage ratchet, RDO citation)') {
      return { kind: 'park', reason: 'pr-rules-needs-approval' };
    }
    return { kind: 'retry', nextState: 'DIAGNOSE' };
  }
  // No step info: the real path's job lookup came back empty/unusable (a non-zero `gh api`, an
  // unparsable body, a job whose steps all passed, a check no GitHub Actions job backs at all),
  // or a legacy bare-string shadow fixture. Either way, `checkName` alone is not enough to
  // classify -- see the header above -- so this always falls to DIAGNOSE, never to IMPLEMENT or
  // PARK.
  return { kind: 'retry', nextState: 'DIAGNOSE' };
}

module.exports = { classifyCiFailure };
