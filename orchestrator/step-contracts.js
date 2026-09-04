'use strict';
// step-contracts.js -- the authoritative table for the pipeline's five LLM steps (PLAN,
// IMPLEMENT, DIAGNOSE, CITATION_VERIFIER, VALIDATE). doc/state-machine-spec.md § Step
// contracts is the source of truth; prompts/README.md's own per-step table restates the same
// facts for readers of prompts/ and is consulted only where the spec is silent. Every place the
// two disagreed while this file was written is called out in a comment next to the field it
// affects -- see orchestrator/README.md "Real mode" for the summary list.
//
// Three of prompts/'s eight files deliberately have NO entry here -- `review-card.md`,
// `draft-card.md` and `triage-bug-report.md`. state-machine-spec.md § Step contracts lists
// exactly five rows, and all three of those are driven by the intake path
// (orchestrator/intake.js's reviewCard/draftCard/triageBugReport, which carry their own
// model/effort/allowedTools inline), never by orchestrator/state-machine.js's callLlmStep.
//
// Two things below are NOT sourced from either doc, because neither one gives a number or names
// a CLI permission-mode value per step -- they are this build's own inferred defaults:
//   - maxBudgetUsd: always undefined below (see the comment above resolveStepContract's own
//     `maxBudgetUsd: undefined` for the maintainer's reasoning) -- not scaled by task.size the
//     way effort is, and no per-task override field is read anywhere. state-machine-spec.md's
//     Step contracts table names the bound that actually exists instead: a uniform per-step
//     wall-clock deadline (LLM_STEP_DEADLINE_MS below).
//   - permissionMode: chosen so a step whose contract is "read-only" never needs a human
//     approval prompt it cannot answer (headless -p), and the one step with edit tools
//     (IMPLEMENT) auto-accepts them since nothing reviews a diff before the mechanical checks.

const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// spec: "per task size S/M/L -> low/medium/high" (PLAN, IMPLEMENT only -- DIAGNOSE and both
// VALIDATE steps are pinned "high" regardless of size; validate-change.md's own text: "Effort
// is high regardless of task size -- the mission is not proportional to diff size").
const EFFORT_BY_SIZE = { S: 'low', M: 'medium', L: 'high' };

// IMPLEMENT_EFFORT_BY_SIZE -- IMPLEMENT no longer shares PLAN's map: its S row is 'medium'.
//
// THIS IS A DELIBERATE EXPERIMENT, NOT A MEASURED RESULT. Read the numbers before trusting the
// change, because the first version of this comment got them wrong and the correction is the
// interesting part.
//
// The corpus CANNOT answer whether raising IMPLEMENT's floor helps, and it cannot answer it by
// construction: `effort` is a pure function of `size` through this very map, so across every
// IMPLEMENT call ever made there are ZERO observations of an S-sized card run at 'medium'. Size
// and effort are perfectly confounded. Any comparison of "S cards" against "M cards" is a
// comparison of two different card populations, not of two effort settings.
//
// What the 7 merged cards of 2026-09-01/04 actually show, counting MERGED cards only:
//
//   S -> low      4 cards, 11 IMPLEMENT calls  = 2.75/card, mean 436,445 billable
//   M -> medium   3 cards,  6 IMPLEMENT calls  = 2.00/card, mean 531,037 billable
//
// Fewer attempts at 'medium', but MORE tokens per merged card -- and the token figure is carried
// entirely by one card (#492, 1,135,558). The two halves disagree, n is 7, and the result flips on
// a single card. An earlier draft of this comment claimed 1.0 calls and 229k for the M side; that
// set excluded #492 (still in flight when it was counted) and included #489 (parked, never
// merged). It also claimed no DIAGNOSE call sits on a medium-effort card -- #492 has one.
//
// So why change it at all? One argument survives, and it is not from this corpus: effort 'low' is
// below the CLI's own default for coding and agentic work, and IMPLEMENT is the only step that
// writes code. That is a reason to TRY 'medium', not evidence that it wins.
//
// HOW TO SETTLE IT. This map is the intervention: with S -> medium, the next S-sized cards are the
// first observations of that cell that have ever existed. Compare them against the S/low baseline
// above -- 2.75 IMPLEMENT calls, 436k billable per merged card -- over ~8 cards. If IMPLEMENT calls
// per merged card do not fall below ~2.0, revert this map to { S: 'low', M: 'medium', L: 'high' };
// the experiment will have answered no, which is a result worth having either way.
//
// PLAN deliberately keeps the shared map. Its cost is essentially all per-turn (fit over 9 real
// calls: fixed ~= 0, 4,531/turn, R^2 = 0.89), and its `L -> high` row is already the one
// configuration that has never completed -- see LLM_STEP_DEADLINE_MS_BY_STEP.
const IMPLEMENT_EFFORT_BY_SIZE = { S: 'medium', M: 'medium', L: 'high' };

const DEFAULT_SIZE = 'M'; // used only if task.size is missing/unrecognized

// Per-call $ budget cap (`--max-budget-usd`) is intentionally NOT set anywhere in this file --
// the maintainer runs a Claude Max subscription with no overage risk, so every LLM step
// (this table and orchestrator/intake.js's draftCard/reviewCard/triageBugReport) omits the flag
// entirely and runs unlimited. See steps/llm.js's buildArgv: the flag is only pushed when
// opts.maxBudgetUsd is a number, so `undefined` here means "no cap", not "cap of undefined".

// config.js's stepDeadlineMs (120000ms) is sized for the daemon's own scripted steps
// (steps/scripted.js) and is not a fit for a real LLM step, even with the $ cap above removed:
// a step with no budget still has to stop eventually. Reproduced 2026-08-29: a real PLAN step (fable) died at the 120s
// wall-clock mark with "llm.js: failed to spawn claude: spawnSync claude ETIMEDOUT [exit=143]"
// (that exact message no longer occurs since the 2026-08-30 fix -- a deadline kill now says
// "claude ran but exceeded the Xms deadline and was killed", see steps/llm.js's `timedOut`)
// -- the spawnSync timeout, not the budget, cutting the call off mid-flight -- and parked card
// issue-247 with reason plan-invalid. This is the same family of bug PR #14 fixed for
// intake.js's draftCard/reviewCard (INTAKE_DEADLINE_MS); this constant is steps/llm.js's
// equivalent for the daemon's five LLM steps (PLAN, IMPLEMENT, DIAGNOSE, CITATION_VERIFIER,
// VALIDATE). 900000ms (15 minutes) gives a real call room to finish under even an L-sized
// $12 budget before the process itself is killed. config.js's stepDeadlineMs is untouched and
// stays state-machine.js's outer callWithDeadline retry-once-then-park bookkeeping value
// (deadline.js) for every step, scripted or LLM -- but that JS timer is a no-op against a
// scripted step's own blocking spawnSync (steps/scripted.js), which is bounded instead by
// config.js's commandTimeoutsMs (see that file's action-2.1 comment). This constant only
// changes what invokeClaudeReal's own spawnSync timeout is armed with for an LLM call.
const LLM_STEP_DEADLINE_MS = 900000;

// LLM_STEP_DEADLINE_MS_BY_STEP -- per-step overrides of the figure above. Only PLAN has one.
//
// WHY. 900000ms is not enough for PLAN on an L-sized card, and the pipeline could not plan one at
// all. Card #486 (size:L) is the only card ever to reach PLAN's `L -> high` row: three attempts,
// three failures, two of them deadline kills at ~825s of measured wall clock, zero reported
// tokens each. It terminal-parked `llm-transport-failed:PLAN` after burning ~33 minutes. The
// effort ladder measured over the same corpus is PLAN low ~158s -> medium ~339s -> high >=825s,
// roughly x2.1 per step, against a deadline that does not move with it.
//
// Only PLAN moves. Every other step has room to spare against 900s: IMPLEMENT's longest real call
// was 871s (#492, and that one SUCCEEDED -- it is the reason this is a raise for PLAN rather than
// a cut for everyone), DIAGNOSE peaked at 142s, VALIDATE at 124s.
//
// This is a bet, and a bounded one: #486's calls were KILLED mid-flight, so we know 900s was not
// enough and do NOT know that 1800s is. If PLAN at `high` still times out, the journal says so and
// the evidence-backed fallback is PLAN's own `L -> medium` (proven: max 567s observed), not more
// deadline. The cost of being wrong is ~3 x 1800s of wall clock before the transient-retry budget
// parks the card.
const LLM_STEP_DEADLINE_MS_BY_STEP = {
  PLAN: 1800000, // 30 min
};

// The longest any single LLM call may legitimately run, across every step. MAX_LEASE_AGE_MS below
// is derived from THIS, not from LLM_STEP_DEADLINE_MS: the moment one step got a longer deadline,
// deriving the lease bound from the default would have understated the worst legitimate hold and
// reintroduced exactly the defect C6's verification found -- a waiter giving up while the holder
// is still alive and still un-sweepable. Computed from the map so it can never drift from it.
const MAX_LLM_STEP_DEADLINE_MS = Math.max(LLM_STEP_DEADLINE_MS, ...Object.values(LLM_STEP_DEADLINE_MS_BY_STEP));

// deadlineMsForStep(stepName) -- the spawnSync timeout steps/llm.js arms for one call. Falls back
// to LLM_STEP_DEADLINE_MS for any step with no override, including an unrecognized name (the
// intake steps, which carry their own INTAKE_DEADLINE_MS, never reach here).
function deadlineMsForStep(stepName) {
  return LLM_STEP_DEADLINE_MS_BY_STEP[stepName] || LLM_STEP_DEADLINE_MS;
}

// MAX_LEASE_AGE_MS -- the age past which account-lease.js presumes a lease dead and sweeps it
// regardless of pid liveness. Its full justification (why 2x, why the +10% slack, and the
// residual SIGTERM-ignoring-child risk it deliberately does not close) lives in
// account-lease.js's own comment, which re-exports this constant; it is DEFINED here, next to
// the deadline it is derived from, for one reason: config.js needs it too, and config.js cannot
// require account-lease.js -- account-lease.js requires config.js, so that direction is a
// load-time cycle. step-contracts.js requires nothing local, so it is the one place both can
// read.
//
// What config.js needs it for (cross-action defect, C6 verification): accountLeaseWaitMs is how
// long a worker waits for a sibling's lease before parking `all-accounts-leased`, and it was the
// single C6 bound derived from an OBSERVED maximum (measured step durations of 90-265s -> a
// 5-minute wait) instead of from the bound it actually waits on. This constant IS that bound: a
// lease younger than it is legitimately held and cannot be swept, and a sibling worker's own
// two-attempt LLM step can legitimately hold one for 2 x LLM_STEP_DEADLINE_MS = 30 minutes. A
// 5-minute waiter therefore gave up while the holder was still legitimately alive and still
// un-sweepable for another 26.5 minutes, and parked the exact park class per-step leasing was
// built to avoid. Deriving the wait from this constant makes the wait outlast every legitimate
// hold by construction -- the same asymmetry product-repo-lock.js states for its own wait bound:
// waiting too long only delays a card, giving up too early parks a healthy one.
const MAX_LEASE_AGE_MS = 2 * MAX_LLM_STEP_DEADLINE_MS + Math.round(MAX_LLM_STEP_DEADLINE_MS / 10);

// One table entry per step. `escalatesOn` lists which task-shape signals can move `baseModel`
// to `escalatedModel` -- resolved by resolveStepContract() below, per
// state-machine-spec.md § Step contracts' per-row escalation language:
//   REMOVED 2026-09-04: 'escalateFlag' (task.escalate === true). It was never sourced from the
//   remediation plan -- it entered with this file in `4d76168` as a stand-in this build invented
//   for the spec's phrase "Opus 5 fallback", and `task.escalate` is assigned NOWHERE in
//   orchestrator/, bin/ or console/. It could not fire, so the fallback both docs promised did not
//   exist. Deleted rather than wired: falling back off Fable when Fable is unavailable is a real
//   need (a Fable quota exhaustion cools the whole ACCOUNT, every model with it -- see accounts.js's
//   markLimit), but it is served today by account rotation + cooldown, and doing it at the model
//   layer is a separate design decision, not a dead boolean.
//   - 'touchesRdoMembers' -- task.touchesRdoMembers === true, standing in for the RDO wire rule
//                            stated in SPO-WebClient/doc/kanban-workflow.md (not this repo's
//                            CLAUDE.md, which has no RDO rule) -- "src/shared/rdo-*,
//                            src/server/rdo.ts, rdo-members.ts, session phases".
//                            intake.js's makeTask only detects a slice of that
//                            (`area === 'rdo' || /rdo-members\.ts/.test(body)`), once at
//                            intake, before a plan exists.
//                            Per the spec's own Step
//                            contracts table this applies to IMPLEMENT and to VALIDATE's
//                            change-validator (its escalation is stated explicitly in the
//                            prompt file validate-change.md itself, not just the table) --
//                            NOT to PLAN. See the note on the PLAN entry below.
//   - 'lSize'             -- task.size === 'L', IMPLEMENT only ("... or L-sized task").
const STEP_CONTRACTS = {
  PLAN: {
    promptFile: path.join(PROMPTS_DIR, 'plan.md'),
    baseModel: 'fable',
    // No escalation. Both docs described one -- the spec's "Opus 5 fallback", README's matching
    // row -- and neither was reachable: the only trigger PLAN carried was 'escalateFlag', which
    // nothing sets (see the removal note above). Removed rather than left as decoration, so the
    // table says what the code does.
    escalatedModel: null,
    escalatesOn: [],
    effort: 'bySize',
    // Spec + README table both say "Read, Grep, Glob, Bash(ro)" -- the "(ro)" is enforced by
    // the prompt's own text ("you hold no edit tool there") and by permissionMode below, not
    // by a distinct --allowedTools value (the CLI has no read-only Bash sub-permission to pass
    // here).
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'plan', // read-only planning mode; matches the state's own name
    cwdKind: 'worktree', // reads {{worktree}}; config.cwdForStep already encodes this split
    outputContract: {
      // plan_path/invariants_path are NOT here: PLAN runs permissionMode: 'plan' (read-only --
      // see below) and cannot write those files itself, so it returns their full text instead
      // (plan_markdown/invariants_markdown) and handlePlan (state-machine.js) writes them at the
      // canonical scratch_dir/plan-<issue>.md convention, then journals plan_path/invariants_path
      // itself for task-values.js's IMPLEMENT/VALIDATE placeholder derivation to keep reading.
      required: ['plan_markdown', 'invariants_markdown', 'invariant_ids', 'check_commands'],
      // Action 3.2: files_to_change is declared but deliberately NOT required. `required` above
      // drives BOTH llm.js's missing-key validation (~line 680) and the `--json-schema` envelope
      // built below -- promoting files_to_change into it would park every card whose PLAN reply
      // omits the new key, on a live pipeline, before a single real card has exercised it.
      // `optional` is llm.js's own concept to leave alone, not enforce: prompts/plan.md now asks
      // for the key, handlePlan (state-machine.js) journals a `plan-files-undeclared` event when
      // it is absent/malformed, and once the journal shows real PLAN calls emitting it reliably,
      // promoting it to `required` here is a one-line change.
      optional: ['files_to_change'],
    },
  },

  IMPLEMENT: {
    promptFile: path.join(PROMPTS_DIR, 'implement.md'),
    baseModel: 'sonnet',
    escalatedModel: 'opus',
    escalatesOn: ['touchesRdoMembers', 'lSize'],
    effort: 'bySize',
    effortBySize: IMPLEMENT_EFFORT_BY_SIZE, // floor raised to 'medium' -- see that map's comment
    // Neither doc enumerates the literal tool names behind "full edit tools in the worktree"
    // (spec) / "full edit tools" (README) -- this is the concretization this build needs to
    // pass a real --allowedTools value. Read/Grep/Glob to navigate the plan and invariants,
    // Bash to run the check commands, Edit/Write to make the change.
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    permissionMode: 'acceptEdits', // no human in the loop to approve each edit
    cwdKind: 'worktree',
    outputContract: {
      required: ['summary', 'files_changed', 'invariants', 'tests_run', 'all_green'],
    },
  },

  DIAGNOSE: {
    promptFile: path.join(PROMPTS_DIR, 'diagnose.md'),
    // Fable -> Opus, 2026-09-04. Two independent reasons, neither of them "Fable was failing":
    //
    // COST. Opus is half Fable's token price, and DIAGNOSE is ~16% of tier-weighted spend. The
    // maintainer's own triageBugReport decision (intake.js, 2026-08-31) already records Opus as at
    // least Fable's equal as a JUDGE on this project -- that finding was taken on the one step
    // where it was examined and never propagated to the four steps that judge.
    //
    // AVAILABILITY. Four of five steps defaulted to Fable, and accounts.markLimit keys its cooldown
    // by ACCOUNT, not by model -- so a Fable-only usage limit takes the whole account out for every
    // model, Sonnet IMPLEMENT included. That has stalled the pool twice: 12.8h on 2026-08-30/31 (53
    // cycles, 128 attempts) and again on 2026-09-04 with every account at 100% Fable quota. DIAGNOSE
    // is the cheapest step to take off that single point of failure.
    //
    // NOT because Fable was diagnosing badly. Post-C1 the corpus shows 8/8 DIAGNOSE calls succeeded
    // and ZERO diagnose-* parks across 10 cards -- every card that entered a DIAGNOSE->IMPLEMENT
    // loop (#487, #488, #492) reached DONE. The plan's own conditional ("if diagnose-* parks stay
    // > 10% after C1, escalate attempt 3 to Opus") is measurably NOT met; the pre-C1 17% was the
    // blind-judge artifact action 1.3 fixed. So this is a lateral move made for price and quota,
    // and the 8/8 baseline (~52k mean billable, ~90s, ~20 turns) is what a future reader should
    // compare against to tell whether it cost anything.
    baseModel: 'opus',
    escalatedModel: null, // no escalation column for this step in either doc
    escalatesOn: [],
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Bash'],
    permissionMode: 'default',
    cwdKind: 'pipeline', // judges artifacts the orchestrator already produced
    // diagnose.md's header declares two mutually-exclusive shapes; "root_cause" (possibly
    // null) is the one key common to both, so it is the only one whose *presence* is a hard
    // requirement -- see llm.js's `in` check, which treats a present-but-null root_cause as
    // satisfied, never as "missing".
    outputContract: { required: ['root_cause'] },
  },

  CITATION_VERIFIER: {
    promptFile: path.join(PROMPTS_DIR, 'verify-citations.md'),
    baseModel: 'fable',
    escalatedModel: null, // no escalation column for this step in either doc
    escalatesOn: [],
    effort: 'high',
    // RESOLVED (action 7.5): the spec row, prompts/README.md's table, and this entry all said
    // "Read, Grep" for citation-verifier, but verify-citations.md's own body disagreed with all
    // three -- it said twice, in its own words, "You hold Read, Grep, Bash and no more". The code
    // was already right (this step never invokes Bash); the prompt's self-description was the
    // outlier and has been corrected to match (`prompts/verify-citations.md`, both mentions).
    allowedTools: ['Read', 'Grep'],
    permissionMode: 'default',
    cwdKind: 'pipeline',
    outputContract: { required: ['verdict', 'entries'] },
  },

  VALIDATE: {
    promptFile: path.join(PROMPTS_DIR, 'validate-change.md'),
    baseModel: 'fable',
    // The wire-rule escalation was INVERTED, and it was live in the corpus. Fable is the more
    // capable and the more expensive tier; Opus is half its price. So `fable -> opus` made the
    // judge WEAKER exactly where the stakes are highest. Card #462 shows both halves in one run:
    // IMPLEMENT escalated sonnet -> opus (a real upgrade) while VALIDATE escalated fable -> opus
    // (a downgrade), leaving the unescalated citation verifier (fable) more capable than the
    // change-validator judging the same diff.
    //
    // Fixed by escalating the lever that actually points up: EFFORT. The model stays Fable on
    // every path, and the RDO wire buys `xhigh` instead of `high`.
    //
    // Why xhigh is safe here: VALIDATE is the cheapest and fastest step in the pipeline -- 6/6
    // successful calls, mean 57.8k billable, mean 77s, max 124s against a 900000ms deadline. There
    // is an order of magnitude of headroom, which is why this step (not PLAN, where effort `high`
    // already blew the deadline) is where the first use of an effort above `high` belongs.
    escalatedModel: null,
    escalatesOn: [],
    escalatedEffort: 'xhigh',
    escalatesEffortOn: ['touchesRdoMembers'],
    neverModel: 'sonnet', // documentation only -- 'sonnet' never appears as base or escalated
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'default',
    cwdKind: 'pipeline',
    outputContract: { required: ['verdict', 'reasons', 'findings'] },
  },
};

// task.touchesRdoMembers / task.size / task.escalate decide whether a step's model is escalated
// this call. Never true for a step whose contract carries no escalatedModel at all (DIAGNOSE,
// CITATION_VERIFIER).
function shouldEscalate(stepDef, task) {
  if (!stepDef.escalatedModel) return false;
  if (task && task.touchesRdoMembers === true && stepDef.escalatesOn.includes('touchesRdoMembers')) return true;
  if (task && task.size === 'L' && stepDef.escalatesOn.includes('lSize')) return true;
  return false;
}

// The effort-side twin of shouldEscalate, reading `escalatedEffort`/`escalatesEffortOn` instead of
// `escalatedModel`/`escalatesOn`. Deliberately a SEPARATE function and a separate pair of fields:
// a step may escalate on one axis, the other, or neither, and VALIDATE is the case that forced the
// split -- it escalates effort and must never escalate model (see its entry). Same signal
// vocabulary as shouldEscalate so a reader learns one set of names, and false for any step with no
// escalatedEffort at all, which is every step except VALIDATE.
function shouldEscalateEffort(stepDef, task) {
  if (!stepDef.escalatedEffort) return false;
  const on = stepDef.escalatesEffortOn || [];
  if (task && task.touchesRdoMembers === true && on.includes('touchesRdoMembers')) return true;
  if (task && task.size === 'L' && on.includes('lSize')) return true;
  return false;
}

// Resolves the per-task-shaped call config for one step: model/effort/budget as the table and
// task.size/escalation flags decide, plus the static fields (promptFile, allowedTools,
// permissionMode, cwdKind, outputContract) and a minimal --json-schema envelope built from the
// output contract's required keys (state-machine-spec.md § Step contracts preamble: every
// `claude -p` call gets `--json-schema` for its payload).
function resolveStepContract(stepName, task = {}) {
  const stepDef = STEP_CONTRACTS[stepName];
  if (!stepDef) {
    throw new Error(`step-contracts.js: no contract for step "${stepName}"`);
  }

  const escalated = shouldEscalate(stepDef, task);
  const model = escalated ? stepDef.escalatedModel : stepDef.baseModel;

  const size = (task && task.size) || DEFAULT_SIZE;
  // Each step may bring its own size->effort map (IMPLEMENT does, with a raised floor); the shared
  // EFFORT_BY_SIZE is the default for any step that does not.
  const effortMap = stepDef.effortBySize || EFFORT_BY_SIZE;
  const baseEffort = stepDef.effort === 'bySize' ? effortMap[size] || effortMap[DEFAULT_SIZE] : stepDef.effort;
  // Effort escalation is resolved AFTER the size map, and overrides it: a step whose signal fires
  // gets its escalated effort regardless of what the card's size label said.
  const effortEscalated = shouldEscalateEffort(stepDef, task);
  const effort = effortEscalated ? stepDef.escalatedEffort : baseEffort;

  return {
    step: stepName,
    promptFile: stepDef.promptFile,
    model,
    escalated,
    effort,
    effortEscalated,
    // Per-step, not the module default: PLAN gets 1800000ms, every other step 900000ms. steps/llm.js
    // arms invokeClaudeReal's spawnSync timeout with this rather than reading the constant itself.
    deadlineMs: deadlineMsForStep(stepName),
    allowedTools: stepDef.allowedTools,
    permissionMode: stepDef.permissionMode,
    // No $ cap: steps/llm.js's buildArgv only passes --max-budget-usd when this is a number.
    maxBudgetUsd: undefined,
    jsonSchema: { type: 'object', required: stepDef.outputContract.required },
    cwdKind: stepDef.cwdKind,
    outputContract: stepDef.outputContract,
  };
}

module.exports = {
  STEP_CONTRACTS,
  EFFORT_BY_SIZE,
  IMPLEMENT_EFFORT_BY_SIZE,
  LLM_STEP_DEADLINE_MS,
  LLM_STEP_DEADLINE_MS_BY_STEP,
  MAX_LLM_STEP_DEADLINE_MS,
  deadlineMsForStep,
  shouldEscalateEffort,
  MAX_LEASE_AGE_MS,
  shouldEscalate,
  resolveStepContract,
};
