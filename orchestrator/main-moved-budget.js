'use strict';
// main-moved-budget.js -- action 6.5's one normalisation, used by state-machine.js's
// resolveShadowCiChecks and by steps/scripted.js's realGate/realCiChecks (the three places that
// decide whether ANOTHER main-moved re-gate is still allowed this task). Its own dependency-free
// leaf, like product-repo-hold.js and bench-queue-wait.js, so all three call sites share one
// definition rather than three hand-copied comparisons.
//
// WHY THIS EXISTS rather than each call site just reading `config.mainMovedRegateBudget`
// directly: `ctx.counters.mainMoveUsed >= config.mainMovedRegateBudget` is a comparison against
// `undefined` the moment a config object omits the field -- and `>=` against `undefined` is
// ALWAYS false (both sides coerce toward NaN, and every comparison with NaN is false). So a
// config missing this field would silently grant an INFINITE main-moved budget rather than
// today's hard "second move parks" -- the exact class of silent footgun CLAUDE.md's `gh api -f`
// story warns about, and a worse one here because it would only bite once K>1 actually runs
// parallel cards for the first time. Same defensive shape product-repo-hold.js's own
// waitBoundMs already uses for `workers` (Number.isInteger + positive, else the documented safe
// default) -- config.js's own module.exports always sets the field (mainMovedRegateBudget: 1),
// so this only ever matters for a hand-built test config that predates this action.
function resolveMainMovedRegateBudget(config) {
  const n = config && config.mainMovedRegateBudget;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

module.exports = { resolveMainMovedRegateBudget };
