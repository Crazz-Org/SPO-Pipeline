'use strict';
// Action A2 (card #239, 2026-09-17): per-state OUTER deadlines for the five LLM steps
// (PLAN/IMPLEMENT/DIAGNOSE/CITATION_VERIFIER/VALIDATE), and the MAX_LEASE_AGE_MS re-derivation
// that has to move with them.
//
// THE HAZARD, restated because it is the reason every test below exists: steps/llm.js's
// invokeClaudeReal currently calls `spawnSync`, which BLOCKS the event loop -- so deadline.js's
// outer timer (armed from config.js's stepDeadlineMsByState, raced by deadline.js's
// callWithDeadline) has never been able to fire against a real LLM call, and none of the five LLM
// steps ever needed an entry there: every one fell back to the generic 120000ms stepDeadlineMs.
// Card #239's own transport swap (a LATER action -- an awaited async stream in place of that
// blocking spawn) will make that outer timer live for the first time. Landing this action AHEAD
// of that swap, rather than alongside it, means the two never ship out of step: the moment the
// transport changes, the outer timer is already sized so the inner one (step-contracts.js's
// deadlineMsForStep, the timeout that actually bounds one call) always fires first.
//
// See orchestrator/config.js's own LLM_STEP_DEADLINE_ENTRIES comment (right above its
// module.exports) and orchestrator/step-contracts.js's own MAX_LEASE_AGE_MS comment for the full
// writeup this file only summarises.

const test = require('node:test');
const assert = require('node:assert/strict');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js's own header for the incident this closes. Required
// before any orchestrator require below, per test/no-real-spawn-sweep.test.js's own standing rule.
require('./no-real-spawn');

const config = require('../orchestrator/config');
const stepContracts = require('../orchestrator/step-contracts');
const { deadlineMsFor } = require('../orchestrator/deadline');

// Node's own hard ceiling on a single setTimeout/setInterval delay (signed 32-bit ms,
// 2^31 - 1) -- config.js's own MAX_TIMER_DELAY_MS is a local, unexported constant, so this is
// re-stated directly, the same way test/real-steps.test.js's own GATE-clamp tests already do for
// the identical constant (see its own comment there).
const MAX_TIMER_DELAY_MS = 2147483647;

// STEP_CONTRACTS's own keys ARE the five LLM step names deadline.js sees (state-machine.js calls
// callLlmStep(ctx, 'PLAN', ...) / 'IMPLEMENT' / 'DIAGNOSE' / 'CITATION_VERIFIER' / 'VALIDATE',
// each identical to a STEP_CONTRACTS key) -- table-driven over THIS list, not a hand-written one,
// so a sixth LLM step added to STEP_CONTRACTS is picked up here automatically.
//
// Fix-pass F1 (Opus verifier, A2): widened to the UNION with LLM_STEP_DEADLINE_MS_BY_STEP's own
// keys, not STEP_CONTRACTS alone. A step present in ONE map but not the other is not reachable in
// production today -- resolveStepContract (step-contracts.js) throws for any step with no
// STEP_CONTRACTS entry, so LLM_STEP_DEADLINE_MS_BY_STEP can never legitimately hold a key
// STEP_CONTRACTS lacks. This widening is a DIAGNOSTIC-QUALITY fix, not a correctness one: without
// it, a step added to LLM_STEP_DEADLINE_MS_BY_STEP alone (an editing mistake, e.g. a typo'd step
// name) surfaced as 2 unrelated-looking test reds elsewhere in this suite; with the union, the
// SAME mistake surfaces here, by the step's own name, in the test built to catch exactly it.
// Verifier-measured: 11/11 still green against today's five-step table.
const LLM_STEPS = [...new Set([...Object.keys(stepContracts.STEP_CONTRACTS), ...Object.keys(stepContracts.LLM_STEP_DEADLINE_MS_BY_STEP)])];

test('LLM_STEPS is the five steps this action is about -- a guard against STEP_CONTRACTS silently losing or gaining a row without this suite noticing', () => {
  assert.deepEqual(LLM_STEPS.slice().sort(), ['CITATION_VERIFIER', 'DIAGNOSE', 'IMPLEMENT', 'PLAN', 'VALIDATE']);
});

// ---- every LLM step has an entry, strictly greater than its own inner deadline -----------------
for (const step of LLM_STEPS) {
  test(`stepDeadlineMsByState.${step} is a real, finite entry, strictly greater than deadlineMsForStep('${step}')`, () => {
    const inner = stepContracts.deadlineMsForStep(step);
    const outer = config.stepDeadlineMsByState[step];
    assert.equal(typeof outer, 'number', `${step} must have a numeric stepDeadlineMsByState entry`);
    assert.ok(Number.isFinite(outer), `${step}'s outer deadline must be finite, got ${outer}`);
    assert.ok(
      outer > inner,
      `${step}'s outer deadline (${outer}ms) must exceed its inner one (${inner}ms) -- the inner ` +
        'deadline must always fire first, or the outer retry-once-then-park timer (deadline.js) ' +
        'can kill a call that is still healthy'
    );
  });
}

// ---- no LLM step resolves to the generic ceiling, through the PRODUCTION lookup path -----------
//
// deadline.js's callWithDeadline calls deadlineMsFor(ctx.config, state) to pick one step's
// deadline -- THAT is the function that has to stop resolving to the generic ceiling for an LLM
// step, not merely config.stepDeadlineMsByState[step] read directly. A test that only inspected
// the config object would not prove deadline.js actually looks it up the same way production does
// (deadlineMsFor's own fallback is `config.stepDeadlineMs` when `stepDeadlineMsByState[state]` is
// null/undefined -- see deadline.js's own deadlineMsFor).
test("no LLM step resolves to the generic stepDeadlineMs through deadline.js's own deadlineMsFor -- the function production actually calls", () => {
  for (const step of LLM_STEPS) {
    const resolved = deadlineMsFor(config, step);
    assert.notEqual(
      resolved,
      config.stepDeadlineMs,
      `${step} must not resolve to the generic ${config.stepDeadlineMs}ms ceiling -- a real call ` +
        "legitimately runs longer than that and would be killed on its first event-loop turn " +
        "once card #239's transport swap makes this timer live"
    );
    assert.equal(
      resolved,
      config.stepDeadlineMsByState[step],
      `${step} must resolve through its own stepDeadlineMsByState entry, not some other path`
    );
  }
});

// ---- every entry tracks the formula, for every step LLM_STEPS names -----------------------------
//
// Fix-pass F8 (Opus verifier, A2): renamed. The old title ("generated, never hand-maintained")
// claimed this test could tell WHETHER config.js's entries come from a loop over STEP_CONTRACTS's
// keys versus five hand-typed literals that happen to be correct today -- measured, it cannot:
// replacing config.js's generation loop with the five correct literals (no drift introduced)
// still passes this test 345/0. What it actually pins, and the only thing a value-level
// comparison like this CAN pin, is that config.stepDeadlineMsByState[step] tracks the SAME formula
// config.js's own comment documents (deadlineMsForStep(step) + stepDeadlineMs, clamped to
// MAX_TIMER_DELAY_MS) for every step named in LLM_STEPS -- so a literal that drifts from that
// formula, or an inner deadlineMsForStep change that a stale literal did not follow, fails here.
// Whether config.js generates the entries or hand-maintains them correctly is not this test's
// business, and this test does not grep config.js's own source to find out -- that would pin the
// implementation, not the behavior, and would be a worse test than an honestly narrower name.
test('stepDeadlineMsByState tracks deadlineMsForStep(step) + stepDeadlineMs, clamped to MAX_TIMER_DELAY_MS, for every step LLM_STEPS names', () => {
  for (const step of LLM_STEPS) {
    const expected = Math.min(stepContracts.deadlineMsForStep(step) + config.stepDeadlineMs, MAX_TIMER_DELAY_MS);
    assert.equal(
      config.stepDeadlineMsByState[step],
      expected,
      `${step}'s stepDeadlineMsByState entry must equal deadlineMsForStep(step) + stepDeadlineMs, ` +
        'clamped to MAX_TIMER_DELAY_MS -- a value that drifts from this formula means the entry ' +
        'was hand-edited instead of re-derived'
    );
  }
});

// ---- the drift guard between step-contracts.js's copy of the margin and config.js's own --------
//
// step-contracts.js cannot require config.js (config.js already requires step-contracts.js for
// MAX_LEASE_AGE_MS -- the reverse direction is a load-time cycle), so STEP_DEADLINE_MARGIN_MS is a
// duplicate of config.js's own stepDeadlineMs, not an import of it. This is the pin that makes
// that duplication safe: the moment either file's value is retuned without the other, this test
// goes red by name, the same "typed independently of the code it checks" contract
// test/doc-constant-sweep.test.js already runs for its own ~20 duplicated numbers.
test("step-contracts.js's STEP_DEADLINE_MARGIN_MS matches config.js's own stepDeadlineMs -- the two must never drift, since config.js's LLM_STEP_DEADLINE_ENTRIES and step-contracts.js's MAX_LEASE_AGE_MS both depend on this SAME number staying equal on both sides", () => {
  assert.equal(
    stepContracts.STEP_DEADLINE_MARGIN_MS,
    config.stepDeadlineMs,
    'step-contracts.js duplicates config.js\'s STEP_DEADLINE_MS by necessity (no-cycle constraint) -- ' +
      'if this ever reads unequal, MAX_LEASE_AGE_MS was derived from a different margin than the one ' +
      'actually added to each LLM step\'s outer deadline'
  );
});

// ---- MAX_LEASE_AGE_MS strictly exceeds the worst legitimate two-attempt hold --------------------
//
// The worst legitimate hold is now the OUTER bound (once card #239's transport swap makes that
// outer timer the thing that actually governs one attempt), not the inner one alone:
// 2 x MAX_LLM_STEP_OUTER_DEADLINE_MS. Computed from the SAME exported constants the production
// code uses, never a literal, so a future change to either LLM_STEP_DEADLINE_MS_BY_STEP or
// STEP_DEADLINE_MARGIN_MS moves this test's own expectation along with the code.
test('MAX_LEASE_AGE_MS strictly exceeds 2 x MAX_LLM_STEP_OUTER_DEADLINE_MS, the worst legitimate two-attempt hold once the outer timer is live', () => {
  const worstHoldMs = 2 * stepContracts.MAX_LLM_STEP_OUTER_DEADLINE_MS;
  assert.ok(
    stepContracts.MAX_LEASE_AGE_MS > worstHoldMs,
    `MAX_LEASE_AGE_MS (${stepContracts.MAX_LEASE_AGE_MS}ms) must exceed the worst legitimate ` +
      `two-attempt hold (${worstHoldMs}ms), or a live holder's lease becomes sweepable -- two ` +
      "`claude` processes on one account, the D1 failure MAX_LEASE_AGE_MS exists to prevent"
  );
  // accountLeaseWaitMs is derived FROM MAX_LEASE_AGE_MS (config.js), so the same inequality has to
  // hold for the waiter a sibling actually competes against, not just for the raw constant.
  assert.ok(
    config.accountLeaseWaitMs >= stepContracts.MAX_LEASE_AGE_MS,
    `config.accountLeaseWaitMs (${config.accountLeaseWaitMs}ms) must be at least MAX_LEASE_AGE_MS ` +
      `(${stepContracts.MAX_LEASE_AGE_MS}ms), or a waiter gives up before a legitimately-held lease ` +
      'can even be swept'
  );
});

// ---- MUTATION PROOF: the test above is not vacuous ----------------------------------------------
//
// How this was actually checked (not merely asserted): step-contracts.js's MAX_LEASE_AGE_MS line
// was temporarily reverted, by hand, to the pre-A2 formula --
// `2 * MAX_LLM_STEP_DEADLINE_MS + Math.round(MAX_LLM_STEP_DEADLINE_MS / 10)` (the inner bound
// alone, no outer margin) -- with `stepDeadlineMsByState`'s five new LLM entries in config.js left
// IN PLACE (i.e. simulating "action A2 added the outer entries but someone forgot to re-derive the
// lease age"). Running `node --test test/llm-step-deadlines.test.js test/account-lease.test.js` in
// that state turned 2 of 34 tests RED: this file's "MAX_LEASE_AGE_MS strictly exceeds..." test
// immediately above (MAX_LEASE_AGE_MS read 3,780,000ms / 63 min against a worst hold of
// 3,840,000ms / 64 min -- shorter, not longer) and test/account-lease.test.js's own
// "MAX_LEASE_AGE_MS is DERIVED from MAX_LLM_STEP_OUTER_DEADLINE_MS..." formula pin. The file was
// then restored (`diff` confirmed byte-identical) and both suites re-run green (34/34). The
// assertions below are the same fact, pinned permanently so a future revert is caught without
// anyone having to repeat that manual step: the PRE-A2 formula, evaluated right now against the
// CURRENT (post-A2) constants, is measurably too short for the CURRENT worst hold.
test('MUTATION PROOF: the pre-A2 lease-age formula (2 x inner deadline + 10%) would NOT outlast the post-A2 worst legitimate hold -- confirms the re-derivation above is load-bearing, not vacuous', () => {
  const worstHoldMs = 2 * stepContracts.MAX_LLM_STEP_OUTER_DEADLINE_MS;
  const preA2FormulaMs =
    2 * stepContracts.MAX_LLM_STEP_DEADLINE_MS + Math.round(stepContracts.MAX_LLM_STEP_DEADLINE_MS / 10);

  // Fix-pass F7 (Opus verifier, A2): this used to also assert `!(preA2FormulaMs > worstHoldMs)`
  // as a "corollary" -- deleted. Measured: it is strictly implied by the `<` assertion below (no
  // input satisfies one and fails the other, `a < b` and `!(a > b)` are the same claim over reals),
  // so it discriminated nothing the assertion below did not already catch, and it carried its own
  // false-failure mode: it goes red whenever MAX_LLM_STEP_DEADLINE_MS >= 2,400,000 for reasons
  // having nothing to do with whether MAX_LEASE_AGE_MS was re-derived correctly (it fired that way
  // in two of the verifier's own mutations). One assertion, not two that say the same thing with
  // different blast radii.
  assert.ok(
    preA2FormulaMs < worstHoldMs,
    `sanity: the pre-A2 formula (${preA2FormulaMs}ms) must read LESS than the post-A2 worst hold ` +
      `(${worstHoldMs}ms) -- if this ever reads false, the mutation-proof this test documents no ` +
      'longer demonstrates anything and must be re-measured'
  );
});
