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
//     Step contracts table names the bound that actually exists instead: a per-step wall-clock
//     deadline (LLM_STEP_DEADLINE_MS / LLM_STEP_DEADLINE_MS_BY_STEP below) -- no longer uniform
//     across steps since PLAN's 2026-09-04 override and IMPLEMENT's action-2.2 one below.
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
// calls: fixed ~= 0, 4,531/turn, R^2 = 0.89), and its `L -> high` row was the one configuration
// that had never completed, until #516 completed it twice post-raise (864.152s, 1123.965s, both
// `ok: true`) -- see LLM_STEP_DEADLINE_MS_BY_STEP.
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
// VALIDATE) -- the default every one of them falls back to. LLM_STEP_DEADLINE_MS_BY_STEP below
// now overrides two of the five (PLAN, IMPLEMENT), so this 900000ms (15 minutes) figure alone
// governs only the other three (DIAGNOSE, CITATION_VERIFIER, VALIDATE); it still gives a real call
// room to finish under even an L-sized $12 budget before the process itself is killed. config.js's stepDeadlineMs is untouched and
// stays state-machine.js's outer callWithDeadline retry-once-then-park bookkeeping value
// (deadline.js) for every step, scripted or LLM -- but that JS timer is a no-op against a
// scripted step's own blocking spawnSync (steps/scripted.js), which is bounded instead by
// config.js's commandTimeoutsMs (see that file's action-2.1 comment). This constant only
// changes what invokeClaudeReal's own spawnSync timeout is armed with for an LLM call.
const LLM_STEP_DEADLINE_MS = 900000;

// LLM_STEP_DEADLINE_MS_BY_STEP -- per-step overrides of the figure above. PLAN and IMPLEMENT both
// carry one now (IMPLEMENT's own entry and its record are below PLAN's); DIAGNOSE,
// CITATION_VERIFIER and VALIDATE still take the default.
//
// WHY. 900000ms is not enough for PLAN on an L-sized card, and the pipeline could not plan one at
// all. Card #486 (size:L) was, before this raise, the only card ever to reach PLAN's `L -> high`
// row. Before the raise (commit 98fc04b, 2026-09-04T05:57:43Z), three attempts failed, zero
// reported tokens each: two killed BY the 900,000ms deadline (the ~825s reported is a pre-#158
// Date.now() artefact -- both actually ran at least the full 900,000ms, see action 2.1, commit
// e327171) and one a transport error (unparsable stdout, exit 143); the card terminal-parked
// `llm-transport-failed:PLAN`. Two more attempts followed a retry on 2026-09-04, both AFTER the
// raise (already running against 1,800,000ms) and both failing only on Fable account-cooling, not
// the deadline -- #486's own state.json still reads
// `all-accounts-cooling-until-2026-09-04T20:33:05.932Z` today. The effort ladder is PLAN low
// median 179.9s (n=29) -> medium median 352.7s (n=20) -> high 864.2s/1123.97s (n=2, both #516,
// post-raise, SUCCEEDED) -- PLAN's effort is a pure function of size (S -> low, M -> medium, L ->
// high, by construction, no exceptions in this corpus), so the ladder measures effort and size
// growing together, not effort alone -- x1.96 then x2.82 per step, not the constant "x2.1" claimed
// before.
//
// Only PLAN moves, and "every other step has room to spare against 900s" no longer describes them
// all -- and, per the evidence below, never fully did. IMPLEMENT's longest completed call
// journalled 920.322s (issue-517, ok: true), with 887.420s (issue-671) and 885.435s (issue-497)
// also above the figure this override was written against -- all three pre-monotonic-clock
// Date.now() readings (action 2.1, commit e327171), so "above" here means within that clock's own
// tens-of-seconds drift of the cap, not proven to exceed it; see the caveat in action 2.2's own
// paragraph below for what that drift does and does not put in doubt. #492's 870.510s (SUCCEEDED)
// was cited as the former maximum and the reason IMPLEMENT was left alone -- but that argument was
// already false when written: this override landed 2026-09-04T05:57:43Z (commit 98fc04b), and
// #492's own FIRST IMPLEMENT attempt had been killed BY the deadline six hours earlier
// (2026-09-04T00:02:36Z); the surviving 870.510s call was that attempt's retry. issue-385 carries
// two more IMPLEMENT kills that also predate the override (2026-08-30T20:21:31Z,
// 2026-09-03T22:01:56Z). DIAGNOSE peaked at 215.4s (issue-516); VALIDATE at 336.9s (issue-507).
// Seven IMPLEMENT calls (plus #486's two above) are now killed BY the 900,000ms deadline --
// unlike the completion figures above, a kill is the monotonic timer firing (`timedOut: true`),
// never a duration_s reading, so the clock issue does not touch this count. IMPLEMENT no longer
// has room to spare, and the record above says it never demonstrably did; this paragraph stands as
// that record, not as a decision about what to do next.
//
// This is a bet, and a bounded one: #486's calls were KILLED mid-flight, so we know 900s was not
// enough and do NOT know that 1800s is. If PLAN at `high` still times out, the journal says so,
// and the cheaper thing to try before more deadline is PLAN's own `L -> medium` -- except that row
// has never run: PLAN's effort is bySize, so no L-sized card has ever called PLAN at `medium` in
// this corpus. The nearest evidence is the `M -> medium` row itself (n=20, median 352.7s, max
// 993.903s, issue-515) -- a proxy for what an L card might cost at `medium`, not proof of it,
// since M and L are a different size row entirely. The cost of being wrong is ~3 x 1800s of wall
// clock before the transient-retry budget parks the card.
//
// ACTION 2.2 (card #158) ACTS ON THE IMPLEMENT RECORD ABOVE instead of leaving it as a record with
// no decision attached. IMPLEMENT's entry below is the identical 1,800,000ms PLAN's is, not an
// independently-chosen number.
//
// Measured against the corpus at large, not just the kills: of 80 IMPLEMENT calls carrying a
// duration_s, 71 completed (ok:true) and run median 262.8s / p90 495.7s -- 29% of the 900,000ms
// cap at the median, so the cap binds only the tail.
//
// THE CLOCK CAVEAT, stated once, here, because it bears on every duration_s figure below: every
// duration_s below predates card #158's monotonic-clock fix (e327171) and is a Date.now() reading;
// the observed disagreement with the monotonic timer reaches tens of seconds. That is immaterial
// to the median and p90 above, which sit multiples away from the cap, and immaterial to the seven
// kills below, which are the monotonic timer firing (`timedOut: true`) and not a duration_s
// reading at all. It is material only to figures within that drift of 900,000ms -- so no argument
// below rests on one.
//
// That tail runs at the cap's order of magnitude, though the corpus cannot say how close: every
// duration_s here was computed with Date.now(), which this same card's e327171 replaced after
// finding it can disagree with the monotonic timer gating spawnSync by tens of seconds on a 900s
// bound. issue-517's journalled 920.322s is that commit's own counter-example -- a successful,
// never-killed IMPLEMENT whose true elapsed was under the cap the monotonic timer never fired on.
// Three completions (issue-517, issue-671, issue-497) journalled 885-920s against 900,000ms; no
// pre-fix figure pins the tail closer than that.
//
// The load-bearing evidence is the seven kills, which the clock caveat above does not touch: 6 of
// the 80 duration_s-carrying calls were killed BY the deadline (issue-385, issue-492, issue-515
// x2, issue-516, issue-518); a 7th IMPLEMENT kill (issue-385, 2026-08-30T20:21:31Z) predates the
// duration_s field and is not in that 80. Counting it, IMPLEMENT accounts for 7 of the 9 deadline
// kills in the whole corpus; the other 2 are PLAN's own #486 pair above, both before PLAN's raise,
// and no PLAN call has been cut since.
//
// WHAT THE CORPUS CANNOT ESTABLISH, stated plainly rather than implied: that 1,800,000ms would
// have saved those seven. A killed call has no completion time -- there is no measurement of how
// long any of them would have taken to finish, only that 900,000ms was not enough. That is a bet,
// the same shape as PLAN's own bet above. #492 is the one case with a real number on both sides of
// a kill: its FIRST IMPLEMENT attempt was killed at 818.536s, and the RETRY of the SAME work on the
// SAME account needed 870.510s to finish -- inside 900,000ms, so it shows a second attempt can cost
// more than the first, not that 1,800,000ms is enough for a call that could not finish even once.
//
// THE PRECEDENT, AND ITS LIMIT. PLAN's identical raise is followed by two completions the old
// 900,000ms cap would have killed -- 993.903s (issue-515, effort medium) and 1,123.965s
// (issue-516, effort high) -- and no PLAN call has been cut since, over the ~2 days the corpus
// covers; #486 itself still fails PLAN twice post-raise (478.203s, 572.243s, effort high), for
// reasons other than the deadline. That is real evidence a 30-minute deadline can turn a kill into
// a completion. It is not proof for IMPLEMENT: PLAN's own
// population is a different step, a different effort ladder and a different size mix, and action
// 2.3's commit on this file -- which corrected this same comment's own numbers after they were
// found wrong -- is the record of what happens on this project when a figure measured on one
// population is offered as proof about another. Precedent that a longer deadline can work; not
// proof that this one works for IMPLEMENT specifically.
//
// WHY 1,800,000 AND NOT MORE: it is the largest value that leaves MAX_LLM_STEP_DEADLINE_MS below
// -- and therefore MAX_LEASE_AGE_MS and config.js's accountLeaseWaitMs -- exactly where PLAN's own
// raise already put them (Math.max is unmoved when a second entry ties the first, not merely when
// it stays lower). Any value above 1,800,000ms here would raise the lease bound along with it, an
// effect this action is not asking for and has not measured. THE COST OF BEING WRONG IS BOUNDED:
// a genuinely stuck IMPLEMENT now burns 30 minutes of wall clock instead of 15 before the
// transient-retry budget parks the card -- the same shape as PLAN's own "cost of being wrong"
// paragraph above.
const LLM_STEP_DEADLINE_MS_BY_STEP = {
  PLAN: 1800000, // 30 min
  IMPLEMENT: 1800000, // 30 min -- see the comment immediately above for the measurement and the bet
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
// two-attempt LLM step can legitimately hold one for 2 x MAX_LLM_STEP_DEADLINE_MS = 60 minutes --
// not the 30 minutes this comment stated before PLAN's 2026-09-04 override and IMPLEMENT's own
// above each raised the worst legitimate hold past LLM_STEP_DEADLINE_MS's default; that 30-minute
// figure was this comment restating the DEFAULT rather than the MAXIMUM, the exact drift the
// derivation two lines below was written to make impossible for the bound itself (only the prose
// above it still drifted). A 5-minute waiter therefore gave up while the holder was still
// legitimately alive and still un-sweepable for another 58 minutes, not 26.5 -- and parked the
// exact park class per-step leasing was built to avoid. The conclusion this constant exists to
// guarantee is unchanged either way: 63 minutes still outlasts the 60-minute worst legitimate
// hold, by construction, whichever step (or steps) contribute the longer deadline -- which is
// exactly why MAX_LEASE_AGE_MS is derived from MAX_LLM_STEP_DEADLINE_MS (the running maximum
// across every override) below, never from LLM_STEP_DEADLINE_MS (the default) or from a literal.
// Deriving the wait from this constant makes the wait outlast every legitimate hold by
// construction -- the same asymmetry product-repo-lock.js states for its own wait bound: waiting
// too long only delays a card, giving up too early parks a healthy one.
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
//                            As a MODEL signal this applies to IMPLEMENT only; VALIDATE's
//                            change-validator reads the same flag through `escalatesEffortOn`
//                            (effort high -> xhigh, model unchanged -- see its entry and
//                            shouldEscalateEffort). Neither applies to PLAN. See the note
//                            on the PLAN entry below.
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
    // Why xhigh is safe here: the escalation has already run -- 5 `xhigh` VALIDATE calls (#385,
    // #489, #507, #640 x2), all `ok: true`, mean 245.84s, mean 98.6k billable, max 336.852s
    // (issue-507) against a 900000ms deadline: roughly 2.7x headroom against the slowest call
    // measured, not the order of magnitude an earlier draft claimed. VALIDATE is not the cheapest
    // or fastest step in the pipeline -- DIAGNOSE is both (n=26, mean 100.1s, 53.6k billable) --
    // but VALIDATE at `xhigh` still has real room, which is why this step (not PLAN, where effort
    // `high` already blew the deadline) is where the first use of an effort above `high` landed.
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

// task.touchesRdoMembers / task.size decide whether a step's model is escalated this call -- NOT
// task.escalate, which nothing reads on any step (removed 2026-09-04). Never true for a step
// whose contract carries no escalatedModel at all (DIAGNOSE, CITATION_VERIFIER).
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
    // Per-step, not the module default: PLAN and IMPLEMENT get 1800000ms, every other step
    // 900000ms. steps/llm.js arms invokeClaudeReal's spawnSync timeout with this rather than
    // reading the constant itself.
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
