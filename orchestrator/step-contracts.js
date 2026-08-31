'use strict';
// step-contracts.js -- the authoritative table for the pipeline's five LLM steps (PLAN,
// IMPLEMENT, DIAGNOSE, CITATION_VERIFIER, VALIDATE). doc/state-machine-spec.md § Step
// contracts is the source of truth; prompts/README.md's own per-step table restates the same
// facts for readers of prompts/ and is consulted only where the spec is silent. Every place the
// two disagreed while this file was written is called out in a comment next to the field it
// affects -- see orchestrator/README.md "Real mode" for the summary list.
//
// `review-card.md` (the sixth prompt file) deliberately has NO entry here: state-machine-spec.md
// § Step contracts lists exactly five rows, and prompts/README.md's own header names
// `review-card` as "not yet a state-machine-spec.md row" -- it is driven by the intake path
// (card filing), never by orchestrator/state-machine.js's callLlmStep.
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

// One table entry per step. `escalatesOn` lists which task-shape signals can move `baseModel`
// to `escalatedModel` -- resolved by resolveStepContract() below, per
// state-machine-spec.md § Step contracts' per-row escalation language:
//   - 'escalateFlag'      -- task.escalate === true. The generic "fallback" hook: the spec
//                            says "Opus 5 fallback" for PLAN and "... or as fallback" for
//                            change-validator (prompts/README.md), meaning "when Fable is
//                            unavailable" -- this build has no way to detect that at the CLI
//                            layer, so a task-level override flag stands in for it.
//   - 'touchesRdoMembers' -- task.touchesRdoMembers === true, the RDO wire rule (CLAUDE.md's
//                            "the RDO wire ... src/shared/rdo-*, src/server/rdo.ts,
//                            rdo-members.ts, session phases"). Per the spec's own Step
//                            contracts table this applies to IMPLEMENT and to VALIDATE's
//                            change-validator (its escalation is stated explicitly in the
//                            prompt file validate-change.md itself, not just the table) --
//                            NOT to PLAN. See the DIVERGENCE note on the PLAN entry below.
//   - 'lSize'             -- task.size === 'L', IMPLEMENT only ("... or L-sized task").
const STEP_CONTRACTS = {
  PLAN: {
    promptFile: path.join(PROMPTS_DIR, 'plan.md'),
    baseModel: 'fable',
    escalatedModel: 'opus',
    // DIVERGENCE: prompts/README.md's own step table reads "Fable 5 (Opus 5 on the wire rule
    // or as fallback)" for PLAN -- but state-machine-spec.md's Step contracts row for PLAN
    // reads only "Fable 5 (Opus 5 fallback)", with no wire-rule clause. The spec wins per the
    // task brief, so PLAN escalates on the generic fallback flag only, never on
    // task.touchesRdoMembers.
    escalatesOn: ['escalateFlag'],
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
    escalatesOn: ['touchesRdoMembers', 'lSize', 'escalateFlag'],
    effort: 'bySize',
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
    baseModel: 'fable',
    escalatedModel: null, // neither doc, nor diagnose.md itself, names an Opus alternative
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
    // DIVERGENCE (flagged, not corrected here): both the spec row and prompts/README.md's
    // table say "Read, Grep" for citation-verifier -- but verify-citations.md's own body says
    // twice, in its own words, "You hold Read, Grep, Bash and no more". The two tables the task
    // brief names as authorities agree with each other, so this entry follows them (no Bash);
    // the prompt file's stricter self-description is not itself contradicted by omitting a
    // tool the prompt never actually needs to invoke (it is read-only regardless).
    allowedTools: ['Read', 'Grep'],
    permissionMode: 'default',
    cwdKind: 'pipeline',
    outputContract: { required: ['verdict', 'entries'] },
  },

  VALIDATE: {
    promptFile: path.join(PROMPTS_DIR, 'validate-change.md'),
    baseModel: 'fable',
    escalatedModel: 'opus',
    // validate-change.md's own text states the wire-rule (and fallback) escalation explicitly
    // ("The caller escalates you to Opus 5 when the diff touches the RDO wire ... or when
    // Fable is unavailable -- you never run as Sonnet 5"); the spec's table row is silent on
    // escalation but does not contradict it ("Fable 5 (never Sonnet -- the executor may not
    // judge itself)"). Matches the task brief's own instruction that touchesRdoMembers
    // escalates VALIDATE.
    escalatesOn: ['touchesRdoMembers', 'escalateFlag'],
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
  if (task && task.escalate === true && stepDef.escalatesOn.includes('escalateFlag')) return true;
  if (task && task.touchesRdoMembers === true && stepDef.escalatesOn.includes('touchesRdoMembers')) return true;
  if (task && task.size === 'L' && stepDef.escalatesOn.includes('lSize')) return true;
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
  const effort = stepDef.effort === 'bySize' ? EFFORT_BY_SIZE[size] || EFFORT_BY_SIZE[DEFAULT_SIZE] : stepDef.effort;

  return {
    step: stepName,
    promptFile: stepDef.promptFile,
    model,
    escalated,
    effort,
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
  LLM_STEP_DEADLINE_MS,
  shouldEscalate,
  resolveStepContract,
};
