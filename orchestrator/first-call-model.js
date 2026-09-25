'use strict';
// first-call-model.js -- SPO-Pipeline#166 (maintainer decision 2, 2026-09-24): the two halves of
// the dispatcher's model-aware K-clamp. nextLlmCallForTask answers WHICH LLM call a queued task
// will make first, on which model; servableFor answers how many enabled accounts could serve it
// right now, and on which model. dispatcher.js's fillSlots asks both of every eligible queue entry
// (through takeNextTask's `admit`), and an account counts as healthy only for the model that card
// needs next.
//
// A MODULE OF ITS OWN so any other reader of the queue can ask the same question without a require
// cycle -- auto-pull.js is that reader since SPO-Pipeline#268: its watermark does not count toward
// K a due entry the clamp would skip, and asks these two functions at run time, never at load (the
// lazy lookups below would throw). state-machine.js requires auto-pull.js at load
// time, and dispatcher.js requires state-machine.js at load time, so auto-pull.js reaching these
// through dispatcher.js would close state-machine -> auto-pull -> dispatcher -> state-machine,
// and dispatcher.js's destructured `takeNextTask` would read a half-loaded module as undefined.
// This module's own load-time requires are accounts.js and steps/llm.js, neither of which requires
// state-machine.js, auto-pull.js or dispatcher.js; the two state-machine.js functions it needs
// (lastParkWasPlanInvalid, resumeValidationError) are looked up at CALL time, by which point every
// module in the cycle has finished loading -- the same lazy-require idiom steps/llm.js uses for
// sdk-call.js. test/dispatcher-model-clamp.test.js pins that requiring it first loads nothing of
// the cycle.

const accounts = require('./accounts');
// The clamp resolves a queued task's first call model, and a judge step's quota fallback, through
// the same two functions callLlmStep uses.
const { resolveCallModel, resolveQuotaFallbackModel } = require('./steps/llm');

function stateMachine() {
  return require('./state-machine');
}

// nextLlmCallForTask(task, taskDir, config) -> {step, model, quotaFallbackModel, basis}: the FIRST
// LLM call a queued task will make once a worker takes it, which is the only call whose model the
// dispatcher can know at spawn time. The rule, one row per task shape runTask can start from:
//
//   task shape (queue entry)                       first LLM call        model today
//   ---------------------------------------------  --------------------  -----------------------
//   fresh card / `retry` / INTAKE restart            PLAN                  claude-opus-5-5
//   same, real mode, last park was plan-invalid    PLAN (EXP-PLAN-OPUS)  fable
//   `resume` accepted by runTask (startState CHECK) CITATION_VERIFIER or   fable, falling back to
//     -- a #251 pool-wait resume or a #212         VALIDATE (both judge  quotaFallbackModel on a
//     `continue`                                    steps, one contract)  Fable model limit
//
// Why these rows and nothing else. INTAKE and WORKTREE make no LLM call, so a run from INTAKE
// first calls PLAN; a still-valid plan (decidePlanReuse) skips PLAN and first calls IMPLEMENT, on
// PLAN's own base model, and decidePlanReuse refuses reuse after a plan-invalid park, which is
// exactly when PLAN would be on Fable. A resume skips INTAKE..PLAN..IMPLEMENT and re-runs only
// scripted steps (CHECK, PUSH_PR, GATE, CI_CHECKS) before VALIDATE, whose first call is
// CITATION_VERIFIER when the diff touches the RDO catalogue and VALIDATE otherwise -- both `fable`
// with the same quota fallback, pinned equal by test/dispatcher-model-clamp.test.js so a contract
// change that splits them fails there instead of silently making this row half wrong. A resume
// runTask would refuse (resumeValidationError) restarts at INTAKE (a machine resume) or parks with
// no call (a `continue`), so it gets the fresh-card row. Off the happy path the first call can
// differ -- a red GATE sends a resumed card to DIAGNOSE (claude-opus-5-5), a refused prepareResume
// sends a machine resume back to INTAKE -- and those are not predictable before the worker runs;
// the clamp answers for the happy path and the worker's own lease (account-lease.js, per call,
// with that call's model) stays the authority for every call after it.
//
// The model and the quota fallback come from steps/llm.js's resolveCallModel and
// resolveQuotaFallbackModel, the functions callLlmStep leases with, so a legacy `task.llm.<step>`
// override is honoured the same way (and has no quota fallback, as in callLlmStep). The PLAN row's cross-run signal is state-machine.js's own lastParkWasPlanInvalid,
// read from the same journal.jsonl handlePlan reads it from, and gated on real mode as handlePlan
// gates it.
const JUDGE_FIRST_STEP = 'VALIDATE';

function firstCallFor(step, task, basis) {
  // A `quotaFallbackStep` carried in on the queue entry (a hand-written task.json) is dropped
  // first, exactly as callLlmStep drops it before its first call: only callLlmStep arms that
  // signal, so it can never move a FIRST call onto the fallback model, and the clamp must not
  // resolve one that does.
  const clean = { ...task };
  delete clean.quotaFallbackStep;
  const ctx = { task: clean };
  return {
    step,
    model: resolveCallModel(ctx, step),
    quotaFallbackModel: resolveQuotaFallbackModel(ctx, step),
    basis,
  };
}

function nextLlmCallForTask(task, taskDir, config) {
  const t = task && typeof task === 'object' && !Array.isArray(task) && !task.__invalid ? task : {};
  const resume = t.resume;
  if (resume !== undefined && resume !== null && !stateMachine().resumeValidationError(resume)) {
    return firstCallFor(JUDGE_FIRST_STEP, t, 'resume-at-check');
  }
  const realMode = !(config && (config.shadowMode || config.dryRun));
  const planInvalidRetry = realMode && typeof taskDir === 'string' && stateMachine().lastParkWasPlanInvalid({ taskDir });
  return firstCallFor('PLAN', { ...t, planInvalidRetry }, planInvalidRetry ? 'fresh-after-plan-invalid-park' : 'fresh');
}

// servableFor(call, accountsDir, now, accountsApi) -> {model, healthy, viaFallback,
// fallbackConsidered}: how many enabled accounts could serve `call` right now, and on which model.
// Mirrors callLlmStep's own order: the step's model first; a judge step's quotaFallbackModel ONLY
// when leasing its model would throw AllAccountsCoolingError AND accounts.modelLimitedOnEveryAccount
// says that exhaustion is a known MODEL limit on every account (#166 decision 4: an account-wide
// limit never triggers a fallback, and an unscoped/overloaded cooldown is not known to be a model
// limit). Anything looser would spawn a card whose first call parks straight into a pool-wait --
// the spin the clamp exists to avoid. `accountsApi` is injectable for the rule's own unit test;
// production passes accounts.js. An account-wide cooldown (#250 `limitScope:'account'`) cools every model, so it counts against
// the step's model and the fallback model alike -- no special case needed here.
function servableFor(call, accountsDir, now, accountsApi = accounts) {
  const base = accountsApi.countHealthyAccounts(accountsDir, now, call.model);
  if (base > 0) return { model: call.model, healthy: base, viaFallback: false, fallbackConsidered: false };
  const fallbackConsidered =
    Boolean(call.quotaFallbackModel) && accountsApi.modelLimitedOnEveryAccount(accountsDir, call.model, now) === true;
  if (fallbackConsidered) {
    const fb = accountsApi.countHealthyAccounts(accountsDir, now, call.quotaFallbackModel);
    if (fb > 0) return { model: call.quotaFallbackModel, healthy: fb, viaFallback: true, fallbackConsidered };
  }
  return { model: call.model, healthy: 0, viaFallback: false, fallbackConsidered };
}

module.exports = { nextLlmCallForTask, servableFor };
