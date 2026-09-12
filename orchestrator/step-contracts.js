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

// ---- outputContract types (card #207) --------------------------------------------------------
//
// Every outputContract below was `{ required: [...] }` (PLAN also carries `optional`) with no
// type information at all -- llm.js's reply check only ever asked "is the key present"
// (`key in parsedPayload`), and the --json-schema envelope built by resolveStepContract() only
// ever sent `{ type: 'object', required }`, no `properties`. Measured 2026-09-11: all 3 raw
// VALIDATE `reasons` values in the live journal are the JSON-encoded TEXT of an array, not an
// array -- a string satisfies a presence-only check exactly as well as the real shape does. This
// section adds a `types` sibling map to `required`/`optional`, kept minimal and boring on
// purpose (a plain string label per key, not a schema library): `required`/`optional` stay the
// authority on PRESENCE, `types` is consulted only for a key that is both present and named
// here. A key with no entry in `types` -- because its step carries no `types` map at all, or
// because this build could not pin its real shape confidently enough to enforce it (see the
// per-entry comments below) -- behaves exactly as before this card: presence-checked, never
// type-checked.
//
// THE HONEST SUMMARY, stated plainly rather than left to be inferred from the per-entry comments
// below: with the exclusions this section documents, the keys this card actually enforces are
// `verdict` (on both VALIDATE and CITATION_VERIFIER), `root_cause` (DIAGNOSE), `plan_markdown` and
// `invariants_markdown` (PLAN), and `summary` (IMPLEMENT) -- and the live corpus shows NONE of
// those five was ever sent wrongly typed. Every other required key across the five steps --
// `reasons`/`findings` (VALIDATE), `entries` (CITATION_VERIFIER), `all_green`/`files_changed`/
// `invariants`/`tests_run` (IMPLEMENT), `invariant_ids`/`check_commands` (PLAN) -- has REAL,
// measured type drift in the corpus and stays undeclared BY NECESSITY, not by oversight: each
// one's actual normalization already lives downstream, in state-machine.js, while this file only
// ever gets to see the reply before that normalization runs. So this card adds the mechanism and
// closes it around the five keys the corpus shows are actually stable; it does NOT remove the
// drift on the other nine -- that drift is real, it is measured, and it is exactly as wide after
// this card as before it.
//
// SPELLING: 'string' | 'number' | 'boolean' | 'object' | 'array' (an array of unchecked element
// type) | '<elementType>[]' (an array whose every element must itself satisfy <elementType> --
// NONE of the array spellings are actually used below any more, as of this same card's fix pass
// (2026-09-12): every key that was ever declared with one (`tests_run`, `invariants`,
// `files_to_change`) was removed for a measured reason, see the "NINE MORE KEYS" section further
// down. `checkOutputTypes()`'s own element check stays generic over any of the four scalar labels
// regardless -- this is a statement about today's table, not a constraint the mechanism imposes).
// Chosen over a JSON-Schema-shaped object
// per key (`{type: 'array', items: {type: 'string'}}`) because every real key here is either a
// bare scalar or a flat array of one element type -- nothing in prompts/ or the five outputContract
// tables below ever asks a model for a nested array-of-arrays or a keyed object shape precise
// enough to be worth validating field-by-field, so the extra generality would document a shape
// this build never checks. Plain strings also read the same in this table as in a
// `console.log(stepDef.outputContract)` dump, which a JSON-Schema fragment would not.
//
// checkOutputTypes(payload, outputContract) -- run by llm.js's reply check, AFTER the existing
// presence filter (`required.filter(key => !(key in payload))`) has already returned no missing
// keys, so every key this function inspects is confirmed present. Two things it deliberately does
// NOT do, both load-bearing:
//
//   1. It skips `null`. A present-but-null value already satisfies llm.js's presence check today
//      (the `in` operator, not truthiness -- see DIAGNOSE's own `root_cause` comment below, the
//      one field this build already documents as "possibly null"), and a stricter reading here
//      would silently re-introduce the exact class of regression item 4 of this card's spec
//      forbids: a reply that reaches its consumer today would start failing at this gate instead.
//      No declared type is "nullable" as a result -- null is a wildcard against every type, not a
//      value `checkOutputTypes` was ever asked to validate the CONTENTS of.
//
//   2. For an array-typed key (`array`, `string[]`, `object[]`), a value that arrives as a STRING
//      is given one chance: `JSON.parse` it, and if the parsed result is an array whose elements
//      all satisfy the declared element type, accept it -- and NORMALIZE it in place (the caller
//      replaces the string with the parsed array before returning `ok: true`), exactly what
//      `park-loop.js`'s `normalizeFindingsPayload` already does for every consumer that calls it
//      directly. Nothing in the five `outputContract`s below actually exercises this path today
//      (see the `reasons`/`findings` writeup right below for why the one obvious candidate,
//      VALIDATE's `reasons`, does NOT use it) -- it is exercised directly by
//      test/step-contracts.test.js's own table-driven `checkOutputTypes` tests, and stays here for
//      the array-typed key a future step's contract does want this leniency for. A value that is
//      neither the declared array type nor a string that parses into one is a genuine type
//      failure, same as any other key.
//
// WHY VALIDATE's `reasons` IS **NOT** DECLARED, even though it looks like the textbook case this
// card was written for (validate-change.md documents it as an array; the live corpus sends it
// JSON-encoded 100% of the time, 65/65 raw records measured 2026-09-13 against the live journal --
// up from the 3/3 the criticity review first saw, the corpus having simply grown since) --
// normalizing it here would be WRONG, not just
// unnecessary, for a reason distinct from (and stronger than) the array-shape arguments below for
// `findings`/`all_green`/`invariant_ids`/`check_commands`: state-machine.js's `handleValidate`
// journals `result.reasons` **VERBATIM, PRE-NORMALIZATION**, on purpose (its own comment: "this is
// the ONLY record of what the validator actually sent ... Raw here, normalized there; the pair is
// what makes the claim falsifiable") into the `change-validator` event, specifically because card
// #640's bug was three DIAGNOSE attempts unable to tell "the validator sent nothing" from "the
// validator sent it and our OWN reader dropped it" -- and test/validate-findings.test.js pins the
// raw event byte-for-byte equal to the JSON-encoded string the model sent
// ("change-validator journals reasons verbatim, pre-normalization"). If `checkOutputTypes`
// normalized `reasons` in place, `result` (this function's own return value) would already carry
// the parsed ARRAY by the time `handleValidate` journals it as "raw", silently re-introducing
// exactly the ambiguity #640's fix exists to prevent, just one layer earlier. The actual
// normalization VALIDATE needs already happens, correctly, downstream in `handleValidate` itself
// (`normalizeFindingsPayload(result.reasons)`, unrelated to this function) -- this card's job is
// to ADD enforcement, not to move a normalization step that is already in the right place for a
// reason. Left undeclared, the same as `findings` right below, though for a different, and in this
// case decisive, reason.
//
// NINE MORE KEYS ARE DELIBERATELY LEFT OUT OF `types` ENTIRELY (`reasons`, just discussed, makes
// ten in total), not given a lenient type -- their real shape is wider than any type this
// checker could enforce, or their wire shape must reach a downstream consumer untouched, without
// reintroducing a measured regression, through this exact real-mode `runLlm` path (not a
// shadow-mode fixture, which never reaches this code). Six of the nine (`findings`, `all_green`,
// `files_changed`, `invariant_ids`, `check_commands`, `entries`) were left out of this card's
// FIRST build, on a REASONED basis -- a real corpus shape or a pinned test already on record. The
// remaining three (`tests_run`, `invariants`, `files_to_change`) were NOT -- the first build
// declared and enforced two of them (`tests_run`, `invariants`) from implement.md's documented
// shape alone, never having replayed the live corpus against them, and an Opus verifier's replay
// found that reasoning wrong (see their own bullets below for the measured numbers). This is why
// the module header above states the enforced set as a closed, corpus-checked list rather than
// claiming this section's absence of a consumer proves a wider shape is safe: absence-of-evidence
// was exactly the mistake the first build made:
//
//   - VALIDATE's `findings` -- test/validate-findings.test.js's real-mode "malformed findings ...
//     never throw and never block the merge" case sends `findings` as an unparsable string
//     ('this is not JSON {{{'), `null`, an array of NULLS (`[null, null]` -- `null` elements fail
//     the `object[]` element check even though the outer value is a real array), and a bare object
//     (`{oops: true}`), and asserts `HANDLERS.VALIDATE` still returns `MERGE` for every one of
//     them, never a park. `normalizeFindingsPayload` (park-loop.js) is the actual, already-correct
//     contract for this field downstream, and it is strictly more permissive than "array,
//     JSON-string-of-array, or null" -- declaring `object[]` here would park all four cases that
//     test pins as non-fatal. Left undeclared.
//   - IMPLEMENT's `all_green` -- state-machine.js's own comment on `handleImplement` (search
//     "issue-247") records a REAL production reply: `{ok: true, filesChanged: "[]", allGreen:
//     "false", ...}` -- `allGreen`/`all_green` sent as the STRING `"false"`, not the boolean.
//     Declaring `boolean` here would turn that exact, already-observed shape into a park
//     (`llm-transport-failed:IMPLEMENT`) where today it reaches CHECK/DIAGNOSE exactly as
//     intended. This card's own criticity note independently confirms the field is read NOWHERE
//     in orchestrator/, console/, bin/ or scripts/ (only journaled), so there is no consumer this
//     enforcement would protect, only a park it would newly cause. Left undeclared.
//   - IMPLEMENT's `files_changed` -- test/implement-empty-result.test.js's real-mode
//     "an unparsable filesChanged string" and "filesChanged that parses as valid JSON but is NOT
//     an array (an object)" cases both pin `HANDLERS.IMPLEMENT` routing to DIAGNOSE (journalling
//     `empty-implement`), never a park -- state-machine.js's own `parseFilesChanged` is the
//     already-correct contract (`Array.isArray(raw) ? raw : (JSON.parse succeeds AND is an array
//     ? that : null)`, collapsing every OTHER shape to `null`, treated as "no files changed").
//     Declaring `string[]` here (even with the JSON-string leniency above, which only accepts a
//     string that PARSES to the right array -- a bare `'not json'` or a JSON object satisfies
//     neither) would park both of those pinned cases instead of routing them to DIAGNOSE. Left
//     undeclared.
//   - IMPLEMENT's `tests_run` -- the first build's `string[]` declaration was corpus-checked
//     AFTER the fact, not before, by an Opus verifier replaying every real IMPLEMENT reply in
//     ~/.spo-state/journal (186 replies, 2026-08-29 -> 2026-09-12). The field is a JSON-ENCODED
//     STRING on the wire 100% of the time (never a real array -- same wire convention as PLAN's
//     `invariant_ids`/`check_commands` below, and just as deliberate on implement.md's side),
//     which `checkOutputTypes`'s JSON-string leniency parses fine -- but 69 of those 186 parse to
//     an array of `{cmd|command, exit_code}` OBJECTS, not the plain command strings implement.md's
//     own worked example shows, and the leniency's element check then fails on the parsed
//     objects, same as it would on the raw string. Declaring `string[]` would have parked those
//     69 replies (37% of the corpus) at `llm-transport-failed:IMPLEMENT` -- and since IMPLEMENT is
//     in TRANSIENT_RETRY_LLM_STEPS, the retry loop would have re-sent the identical reply into the
//     identical park every cycle. No consumer reads `tests_run` for anything but journalling
//     today, so there is nothing this enforcement would have protected. Left undeclared.
//   - IMPLEMENT's `invariants` -- same corpus replay, same verdict: a JSON-ENCODED STRING 100% of
//     the time, and 22 of 186 (12%) do not parse to an array of objects at all -- a prose
//     sentence, an unparsable fragment, or a JSON array of something other than an object.
//     Declaring `object[]` would have parked those 22 as `llm-transport-failed:IMPLEMENT`, into
//     the same auto-retry loop as `tests_run` above. Left undeclared.
//   - PLAN's `invariant_ids` and `check_commands` -- NOT because their shape is uncertain (it is
//     the most confidently measured shape in this whole table): prompt-template.js's own
//     `stringifyValue` comment records that 158 of 158 successful PLAN `result` payloads send BOTH
//     fields as a JSON-ENCODED STRING, never a real array, and that this is deliberate, not a
//     defect -- card #153 measured and closed "won't-fix" a proposal to normalize them, because
//     14.5% of declared `check_commands` contain a comma, and re-joining a real array with ", "
//     for the IMPLEMENT/VALIDATE prompt that reads them back (task-values.js: "PLAN's plan_path/
//     invariants_path/invariant_ids/check_commands feed IMPLEMENT and VALIDATE") is NOT losslessly
//     reversible. `checkOutputTypes`'s own JSON-string leniency would NORMALIZE this field in
//     place -- turning the on-the-wire JSON string into a real array BEFORE task-values.js reads
//     it back -- which would make `stringifyValue`'s `Array.isArray` branch fire on the very next
//     prompt fill and silently reintroduce the exact comma-corruption #153 was closed to prevent,
//     on 100% of cards, not an edge case. `plan_markdown`/`invariants_markdown` carry no such
//     downstream re-render and are declared `string` below without incident.
//   - PLAN's `files_to_change` -- OPTIONAL (see `optional` below), so a declared type here was
//     always schema-only: `checkOutputTypes` never enforces or normalizes a key that is not also
//     in `required` (see its own header comment further down). The first build declared it
//     `string[]` anyway, reasoning that a schema-only declaration could not cause harm -- true for
//     enforcement, but still a confidence claim doc/state-machine-spec.md and this header made
//     about the corpus without having measured it. Measured now (2026-09-12, corrected 2026-09-13
//     for a counting trap -- `handlePlan` journals `result` TWICE per real reply, once markdown-
//     only and again with paths added, so a raw record count is not a reply count; 315 raw records
//     collapse to 156 distinct replies by `sessionId`): 130 of 130 DISTINCT replies that declare
//     `files_to_change` send it as a JSON-encoded string, 0 a real array (the other 26 of the 156
//     omit the key entirely) --
//     the same wire convention as `invariant_ids`/`check_commands` above, for the same reason
//     (`normalizeFindingsPayload`/`guardDeclaredFiles` are its actual, already-correct downstream
//     contract). Left undeclared, for honesty about what was actually checked, even though nothing
//     here currently enforces it either way.
//
// CITATION_VERIFIER's `entries` is ALSO left undeclared, for the same structural reason as
// `findings` rather than a distinct one: it is produced by the same "LLM replies with a JSON
// array of judge-authored objects" shape, is read through the identical
// `normalizeFindingsPayload` tolerant path when VALIDATE later renders a DIVERGES verdict
// (state-machine.js's `divergesEntriesNorm`, ~:1577), and this card's own "Not measured" section
// names it, alongside `findings`, as a field whose real-corpus shape this action did not audit --
// declaring a type from the key's name and one prompt reading alone is exactly what item 2 of
// this card's spec says not to do. `verdict` (CITATION_VERIFIER's other required key) is declared
// below; only `entries` is left out.
function scalarTypeOk(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

// arrayElementTypeOk(items, elementType) -- every element of `items` (already confirmed an
// array by the caller) satisfies `elementType`, one of the four scalarTypeOk labels above.
function arrayElementTypeOk(items, elementType) {
  return items.every((item) => scalarTypeOk(item, elementType));
}

// valueSatisfiesType(value, type) -- the non-array-leniency half of the check: does `value`,
// AS GIVEN (no JSON.parse attempt), satisfy `type`. Exported separately from checkOutputTypes so
// the table-driven test can exercise every (type, value) pair directly, without constructing a
// full payload/outputContract per case.
function valueSatisfiesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type.endsWith('[]')) {
    const elementType = type.slice(0, -2);
    return Array.isArray(value) && arrayElementTypeOk(value, elementType);
  }
  return scalarTypeOk(value, type);
}

// checkOutputTypes(payload, outputContract) -- returns { payload, failures }. `payload` is the
// SAME object the caller passed in, mutated in place for any array-typed key whose value was
// accepted via the JSON-string leniency (so every downstream reader, not just this function, sees
// the real array) -- callers that must not mutate their input should pass a shallow copy.
// `failures` is an array of `{ key, type, received }`, one entry per present, non-null,
// declared-type key whose value did not satisfy its type (after the JSON-string leniency above);
// empty when every checked key was fine.
//
// ENFORCEMENT IS REQUIRED-KEYS-ONLY, DELIBERATELY -- a key named in `types` but not in
// `outputContract.required` is skipped here entirely: no type check, no JSON-string
// normalization, nothing. That is not an oversight; it is what keeps `types` usable for
// `properties` on an OPTIONAL key without also making that key's shape load-bearing. No key in
// today's table is actually both optional and typed -- PLAN's `files_to_change` was the one real
// example until this same card's fix pass (2026-09-12) removed it from `types` entirely (its own
// declared type had never been corpus-checked either, see the "NINE MORE KEYS" section) -- so this
// rule exists for a future optional-and-typed key, proven directly by
// test/step-contracts.test.js's synthetic-outputContract test rather than by any real one. Before
// that removal, `files_to_change`'s own downstream reader (state-machine.js's guardDeclaredFiles,
// task-values.js's lastJournaledPlanFiles) already tolerated absent/null/an object/an unparsable
// string by falling back to "not declared", journalled and unparked -- had this function enforced
// a type on it too, a malformed OPTIONAL field would have newly PARKED the whole PLAN step, the
// exact class of regression this card exists to avoid, just for a different key than the one the
// card names.
//
// A key present in `payload` AND in `outputContract.required` AND named in `outputContract.types`
// is inspected; everything else -- absent, optional, or with no declared type at all -- is
// untouched, "behaves exactly as today" per this card's own requirement.
function checkOutputTypes(payload, outputContract) {
  const types = (outputContract && outputContract.types) || {};
  const required = (outputContract && outputContract.required) || [];
  const failures = [];
  for (const [key, type] of Object.entries(types)) {
    if (!required.includes(key)) continue; // optional keys: schema-only, never enforced -- see above
    if (!(key in payload)) continue; // absence is the presence filter's job, not this one's
    const value = payload[key];
    if (value === null) continue; // null is a wildcard against every declared type -- see header

    if (valueSatisfiesType(value, type)) continue;

    // The JSON-string leniency: an array-shaped type accepts a STRING that parses to an array of
    // the right element type, normalising it in place -- see the header comment's item 2 and the
    // VALIDATE `reasons` example it walks through.
    const isArrayType = type === 'array' || type.endsWith('[]');
    if (isArrayType && typeof value === 'string') {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && valueSatisfiesType(parsed, type)) {
        payload[key] = parsed;
        continue;
      }
    }

    failures.push({ key, type, received: value });
  }
  return { payload, failures };
}

// jsonSchemaPropertyFor(type) -- one declared `types` entry, translated to the JSON-Schema
// fragment `--json-schema`'s `properties` object wants for it. Comment on the envelope build
// site (resolveStepContract, below) for what this is -- and is not -- known to do once sent.
function jsonSchemaPropertyFor(type) {
  if (type === 'array') return { type: 'array' };
  if (type.endsWith('[]')) return { type: 'array', items: { type: type.slice(0, -2) } };
  return { type };
}

// jsonSchemaPropertiesFor(types) -- undefined (never an empty object) when the step declares no
// `types` at all, so an entry with nothing declared omits `properties` from its envelope exactly
// as every step did before this card -- "behaves exactly as today" applies to the schema sent to
// the model, not just to llm.js's own check.
function jsonSchemaPropertiesFor(types) {
  if (!types) return undefined;
  const properties = {};
  for (const [key, type] of Object.entries(types)) {
    properties[key] = jsonSchemaPropertyFor(type);
  }
  return properties;
}

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

// ACTION 3 (card #213), measured 2026-09-12: THE LADDER IS SPENT. Per-call figures across the four
// LLM steps, split at 2026-09-10 (before -> since) -- the raises above are 98fc04b (2026-09-04,
// PLAN) and 6287cd2 (2026-09-08, card #158, IMPLEMENT): IMPLEMENT 26 -> 53 requests, $0.86 ->
// $3.38, 226s -> 741s. PLAN 11 -> 16, $2.68 -> $4.46, 208s -> 434s. VALIDATE 7 -> 8, $1.24 ->
// $2.01, 82s -> 233s. DIAGNOSE (deadline unchanged) 9 -> 13, $0.83 -> $0.92, 59s -> 142s.
//
// WINDOW AND DERIVATION, so a future reader can tell a DRIFTED figure from a WRONG one: the since
// side is the cards whose first llm-call is >= 2026-09-10 -- 36 cards, 139 calls, $492.54 at the
// time of measuring, on a LIVE daemon, so the window grows after this was written (re-measured the
// same day at 150 calls it reads 98.0% / 3.85, against the 98.4% / 4.00 recorded below: drift, not
// error). Dollars are tier-weighted relative effort on a Max subscription, not a bill. The
// "requests" column is the ONE figure here NOT derivable from the journal: llm-call carries no
// such field, and numTurns is not it (it reproduces IMPLEMENT's before-side 26 and then diverges,
// 43 vs 53; PLAN's is not close either way). It comes from the card's transcript rejoin, which
// walks the subagents/ subtree -- cited here rather than silently, because every other figure in
// this block can be re-derived from ~/.spo-state/journal and that one cannot.
//
// THE ATTRIBUTION IS CONFOUNDED, stated plainly because the figures above invite the opposite
// reading: 98fc04b, which raised PLAN's deadline, ALSO retuned models and effort on that same
// 2026-09-04 change (IMPLEMENT's own size -> effort map among them) -- so no figure above isolates
// the deadline's own effect from the rest of what that commit did. What the corpus DOES support is
// the co-movement, not the deadline alone: DIAGNOSE is the one step whose deadline never moved (it
// still takes LLM_STEP_DEADLINE_MS's 900000ms default above), and its cost per call is the one that
// barely moved too -- $0.83 -> $0.92, +11%, against IMPLEMENT's +293% -- "barely moved", not "did
// not move": the figure above is still an increase.
//
// Reliability rose over the same window -- 98.4% of calls now return ok:true, against 88.4% before,
// at 4.00 calls/card against 5.60 -- under the identical confound: evidence the 2026-09-04 change
// worked, not evidence of which part of it did.
//
// THE NEW CEILING IS ALREADY BINDING. Two IMPLEMENT calls were killed AT the 1,800,000ms deadline
// on 2026-09-12 -- issue-542 (1,800.519s) and issue-544 (1,800.66s) -- the same failure shape this
// override was raised to fix at 900,000ms, recurring now at 1,800,000ms.
//
// THE LADDER IS SPENT: reliability already sits at 98.4% and two calls hit the new ceiling anyway,
// so a further raise is not aimed at what is actually failing them, and buys nothing the ladder was
// meant to buy. The untried direction is DOWN: PLAN's own `L -> medium` (recommended above,
// :145-146, still never run -- PLAN's effort is bySize, so no L-sized card has ever called PLAN
// below `high`) is cheaper than another deadline increase and has not been measured either way.

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
//                            VALIDATE's change-validator reads this flag through
//                            `escalatesEffortOn` (effort high -> xhigh, model unchanged -- see its
//                            entry and shouldEscalateEffort). Does not apply to PLAN. See the note
//                            on the PLAN entry below.
//                            IMPLEMENT no longer lists this string in its own `escalatesOn` (card
//                            #213, action 2) -- it reads task.touchesRdoMembers directly, as the
//                            LAST of three sources, from inside its 'planDeclaresRdoMembers'
//                            branch below. See that entry and shouldEscalate's own header.
//   - 'lSize'             -- task.size === 'L', IMPLEMENT only ("... or L-sized task").
//   - 'planDeclaresRdoMembers' -- IMPLEMENT only (card #213, action 2). NOT a single field read:
//                            shouldEscalate resolves this trigger from THREE sources, most-
//                            trustworthy first -- (1) task.rdoDiffTouched === true, strictly
//                            boolean (the real diff, once PUSH_PR has run), (2)
//                            task.planDeclaresRdoMembers (the plan's own declaration, resolved by
//                            state-machine.js's resolvePlanDeclaresRdoMembers before the call --
//                            true/false when PLAN declared a files_to_change list, even an EMPTY
//                            one; undefined when it never declared at all), (3)
//                            task.touchesRdoMembers === true, the fallback, reached only when (2)
//                            was undefined. Escalating on a PLAN declaration rather than the
//                            intake guess narrows the trigger to evidence the plan actually
//                            produced; the fallback to touchesRdoMembers exists so a card that has
//                            reached neither of the first two sources yet keeps today's pre-#213
//                            behaviour, and in particular so scripted.js's touchesRdoMembers
//                            false->true promotion after PUSH_PR (its own comment forbids the
//                            reverse) still keeps a later IMPLEMENT retry on Opus. See
//                            shouldEscalate's own header for the full order and why it is not
//                            "plan first".
//   - 'diagnoseOrValidateRetry' -- IMPLEMENT only (card #213's 2026-09-12 amendment, trigger 4).
//                            task.diagnoseOrValidateRetry === true, set by handleImplement
//                            (state-machine.js) from `ctx.counters.diagnoseAttempts > 0 ||
//                            ctx.counters.validateRejects > 0` immediately before the call -- a
//                            retry after a DIAGNOSE or a VALIDATE reject escalates on OBSERVED
//                            difficulty, independent of the wire/plan signals above.
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
      // Card #207: `plan_markdown`/`invariants_markdown` are plan.md/invariants.md's full text
      // (prose) -- 'string'. `invariant_ids`/`check_commands` are REQUIRED but deliberately left
      // OUT of `types` -- see this file's own "outputContract types" header comment for why (158
      // of 158 measured PLAN replies send them as a JSON-encoded STRING on purpose, per card #153,
      // and this checker's own JSON-string leniency would normalize that string into a real array
      // before task-values.js/prompt-template.js read it back for IMPLEMENT's/VALIDATE's own
      // prompt, silently reintroducing #153's comma-corruption regression). `files_to_change` is
      // ALSO left out of `types` entirely, as of this same card's fix pass (2026-09-12) -- see the
      // header comment for the measured reason (130 of 130 DISTINCT replies that declare it send a
      // JSON-encoded string, 0 a real array; it stays `optional` below regardless).
      types: {
        plan_markdown: 'string',
        invariants_markdown: 'string',
      },
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
    // Card #213, action 2 (+ 2026-09-12 amendment): 'touchesRdoMembers' (the intake guess) is
    // gone from this list -- see this table's own preamble comment on 'touchesRdoMembers' and
    // 'planDeclaresRdoMembers' for the three-source resolution the latter now drives, and
    // shouldEscalate's header for why the intake guess is still read, just no longer named here.
    // 'lSize' is untouched -- an L-sized card still escalates on size alone, independent of the
    // other two.
    escalatesOn: ['planDeclaresRdoMembers', 'lSize', 'diagnoseOrValidateRetry'],
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
      // Card #207: `summary` is implement.md's few sentences of prose -- 'string', declared and
      // enforced. `invariants` and `tests_run` are REQUIRED but, as of this same card's fix pass
      // (2026-09-12), deliberately left OUT of `types` -- the first build declared them
      // (`invariants: 'object[]'`, `tests_run: 'string[]'`) reasoning from implement.md's own
      // documented shape (`[{"id": "INV-1", "status": "HELD"}, ...]` / `["...", ...]`) rather than
      // from the corpus, and a corpus replay found that wrong: measured against
      // ~/.spo-state/journal (186 real IMPLEMENT replies, 2026-09-12), `tests_run` is a
      // JSON-encoded string 100% of the time, and 69 of those 186 parse to an array of
      // `{cmd|command, exit_code}` OBJECTS, not strings -- `checkOutputTypes`'s own JSON-string
      // leniency parses the wire string fine, but the parsed array then fails its OWN
      // `string[]` element check. `invariants` is also a JSON-encoded string 100% of the time, and
      // 22 of those 186 do not parse to an array of objects (a prose sentence, an unparsable
      // fragment, or a JSON array of something other than objects). Declaring either type here
      // would have parked roughly a third of real IMPLEMENT replies as `llm-transport-failed:
      // IMPLEMENT` -- and since IMPLEMENT is in TRANSIENT_RETRY_LLM_STEPS, the park would have
      // auto-retried into the identical failure and re-spent tokens every cycle. `all_green` and
      // `files_changed` are undeclared for a separate, earlier-measured reason -- see this file's
      // own "outputContract types" header comment for the full evidence (issue-247's real
      // `allGreen: "false"`, and test/implement-empty-result.test.js's real-mode "unparsable
      // filesChanged string" / "valid JSON but not an array" cases, both of which must still reach
      // `state-machine.js`'s own `parseFilesChanged`-based routing to DIAGNOSE, never a park at
      // this gate).
      types: {
        summary: 'string',
      },
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
    outputContract: {
      required: ['root_cause'],
      // Card #207: 'string' -- diagnose.md documents root_cause as "one line" prose or `null`;
      // the `null` half needs no entry here at all, since checkOutputTypes() treats a present
      // `null` as a wildcard against every declared type (same "possibly null" idiom the comment
      // two lines above this one already documents for the presence check, kept consistent
      // rather than re-litigated per consumer). test/diagnose-nested-contract.test.js's own
      // "nested contract" shape (a model that wraps its whole reply JSON-encoded INSIDE
      // root_cause) is still a plain string at this top level either way -- the nesting is
      // unwrapped downstream, in state-machine.js's unwrapNestedDiagnoseContract, never here.
      types: { root_cause: 'string' },
    },
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
    outputContract: {
      required: ['verdict', 'entries'],
      // Card #207: `verdict` is one of three enum strings (verify-citations.md: PASS / REJECT /
      // DIVERGES) -- 'string' catches a genuinely wrong-shaped reply (a number, an object)
      // without re-encoding the enum itself, which state-machine.js's own verdict-dispatch
      // already owns. `entries` is DELIBERATELY left out of `types` -- see this file's own
      // "outputContract types" header comment for why (same structural pattern as VALIDATE's
      // `findings`, and this card's own "Not measured" section names it unaudited).
      types: { verdict: 'string' },
    },
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
    // every path; `xhigh` now comes from the diff-derived `rdoDiffTouched`, not intake's guess.
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
    escalatesEffortOn: ['rdoDiffTouched'],
    neverModel: 'sonnet', // documentation only -- 'sonnet' never appears as base or escalated
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'default',
    cwdKind: 'pipeline',
    outputContract: {
      required: ['verdict', 'reasons', 'findings'],
      // Card #207 -- the action's central judgement call, see this file's own "outputContract
      // types" header comment for the full evidence trail. Short version:
      //   - `verdict` is one of three enum strings (validate-change.md: PASS / PASS_WITH_FINDINGS
      //     / REJECT) -- 'string' only, same reasoning as CITATION_VERIFIER's above.
      //   - `reasons` is DELIBERATELY left out of `types`, even though it looks like the textbook
      //     case (validate-change.md documents it as an array; the corpus sends it JSON-encoded
      //     100% of the time, 65/65 raw records measured 2026-09-13, up from 3/3 at the original
      //     criticity review -- the corpus has simply grown): state-machine.js's `handleValidate` journals
      //     `result.reasons` -- this function's OWN return value -- VERBATIM into the
      //     `change-validator` event, on purpose, as "the ONLY record of what the validator
      //     actually sent" (card #640's fix). Normalizing it here would corrupt that raw record
      //     one layer earlier than #640's fix was written to guard against --
      //     test/validate-findings.test.js's "(card #640)" test pins the raw event byte-for-byte
      //     equal to the JSON-encoded string. The normalization VALIDATE actually needs already
      //     happens, correctly, downstream in `handleValidate` itself.
      //   - `findings` is ALSO left out of `types` -- test/validate-findings.test.js's real-mode
      //     "malformed findings ... never block the merge" case (unparsable string, null, an array
      //     of nulls, a bare object) pins that this pipeline already handles those shapes correctly
      //     through this exact `runLlm` path, and a declared `object[]` would park every one of
      //     them instead.
      types: { verdict: 'string' },
    },
  },
};

// task.touchesRdoMembers / task.size / task.rdoDiffTouched / task.planDeclaresRdoMembers /
// task.diagnoseOrValidateRetry decide whether a step's model is escalated this call -- NOT
// task.escalate, which nothing reads on any step (removed 2026-09-04). Never true for a step
// whose contract carries no escalatedModel at all (DIAGNOSE, CITATION_VERIFIER).
//
// Card #213, action 2 (+ its 2026-09-12 amendment): IMPLEMENT's 'planDeclaresRdoMembers' trigger
// is NOT a single field read -- it is a THREE-SOURCE resolution, most-trustworthy first, and
// deliberately in THIS order rather than "plan declaration first":
//   1. task.rdoDiffTouched === true, strictly boolean -- the real diff, once PUSH_PR has run.
//      Checked first because it is ground truth, when it exists.
//   2. task.planDeclaresRdoMembers -- the plan's own declaration (resolved by state-machine.js's
//      resolvePlanDeclaresRdoMembers, before the call): true/false when PLAN declared a
//      files_to_change list, even an EMPTY one (guardDeclaredFiles's own header: "an empty list
//      IS a declaration"); undefined when it never declared at all. A `false` here escalates
//      false and does NOT fall through to source 3 -- the plan spoke and said no.
//   3. task.touchesRdoMembers === true -- STILL NEEDED, as the fallback for a card that has
//      reached neither of the above (no plan declaration at all, PUSH_PR hasn't run yet). This is
//      IMPLEMENT's pre-#213 behaviour, kept so scripted.js's touchesRdoMembers false->true
//      promotion after PUSH_PR (its own comment forbids the reverse) still keeps a later
//      IMPLEMENT retry on Opus: a naive "plan declaration, then intake guess" order with no
//      fallback would re-open that hole from the other side (a plan that omitted rdo-members.ts
//      on a card whose diff later turned out to touch it would otherwise demote every following
//      retry to Sonnet). Reached only when source 2 resolved to undefined.
// All three reads live inside the ONE 'planDeclaresRdoMembers' branch below, gated by that one
// escalatesOn entry -- IMPLEMENT's own contract no longer lists the literal string
// 'touchesRdoMembers' (see the STEP_CONTRACTS preamble comment on both names), but the field
// itself is still read, right here, as the documented step 3.
//
// Trigger 4 (2026-09-12 amendment): task.diagnoseOrValidateRetry === true, independent of the
// three sources above -- a retry after a DIAGNOSE or a VALIDATE reject escalates on OBSERVED
// difficulty (set by handleImplement, state-machine.js, from ctx.counters at call time). Being
// INDEPENDENT is the whole point of it, so it is evaluated BEFORE the three-source block, which
// returns out of the entire function on a `planDeclaresRdoMembers === false` card -- see the
// comment at its call site for the 19-of-26 measurement that placement cost when it sat below.
function shouldEscalate(stepDef, task) {
  if (!stepDef.escalatedModel) return false;
  if (task && task.size === 'L' && stepDef.escalatesOn.includes('lSize')) return true;
  // Trigger 4 is evaluated HERE, ahead of the RDO block, and the placement is load-bearing rather
  // than stylistic. The block below ends a `planDeclaresRdoMembers === false` card by returning
  // out of the WHOLE function, so with trigger 4 underneath it the amendment's own "independent"
  // trigger was unreachable for every card whose plan declared a list not naming the catalogue.
  // Measured on ~/.spo-state/journal before this fix: 81 of 100 cards with a PLAN result declared
  // a list, 5 name rdo-members.ts, so 76 resolve `false`; of the 26 cards that ever ran DIAGNOSE
  // or took a VALIDATE reject -- trigger 4's entire population -- 19 (73%) never reached it. It
  // fired on 7. Order among independent OR-triggers cannot change a result, which is why hoisting
  // is safe and why `lSize` already sits above the block for the same reason. The tempting
  // alternative -- guarding the block with `&& task.planDeclaresRdoMembers !== false` -- was
  // measured and REJECTED: it skips source 1, so a card with a no-catalogue declaration whose diff
  // DID touch the catalogue demotes to Sonnet on every retry, reopening exactly the hole that
  // realPushPr's one-way touchesRdoMembers promotion (steps/scripted.js) exists to prevent.
  // Referred to by name, not by file:line, deliberately: this card moved that block's line numbers
  // three times in one lot, and a name does not drift.
  if (task && task.diagnoseOrValidateRetry === true && stepDef.escalatesOn.includes('diagnoseOrValidateRetry')) {
    return true;
  }
  if (task && stepDef.escalatesOn.includes('planDeclaresRdoMembers')) {
    if (task.rdoDiffTouched === true) return true; // source 1: the real diff
    if (task.planDeclaresRdoMembers === true) return true; // source 2: the plan declared it
    if (task.planDeclaresRdoMembers === false) return false; // declared, and said no -- blocks SOURCE 3 only; trigger 4 already ran above
    if (task.touchesRdoMembers === true) return true; // source 3: intake's guess, undeclared plan
  }
  return false;
}

// The effort-side twin of shouldEscalate, reading `escalatedEffort`/`escalatesEffortOn` instead of
// `escalatedModel`/`escalatesOn`. Deliberately a SEPARATE function and a separate pair of fields:
// a step may escalate on one axis, the other, or neither, and VALIDATE is the case that forced the
// split -- it escalates effort and must never escalate model (see its entry). False for any step
// with no escalatedEffort at all, which is every step except VALIDATE.
//
// ACTION 1 (card #213), measured 2026-09-12: 'rdoDiffTouched' replaces 'touchesRdoMembers' in
// THIS function's own vocabulary -- the two functions no longer share one signal set for the RDO
// wire ('lSize' is still shared). VALIDATE's escalatesEffortOn now names task.rdoDiffTouched
// (resolveRdoDiffTouched, state-machine.js's handleValidate) instead of the intake guess: on the
// 36-card window from 2026-09-10, intake's touchesRdoMembers fired on 23 of 36 cards while the
// merged diff actually touched rdo-members.ts on only 2, so 17 of 19 xhigh VALIDATE calls judged a
// diff with no RDO in it at all ($2.35 vs $1.60 for `high`, ~$10.07 of the window -- the window's
// one VALIDATE rejection, issue-536, came from a `high` call). Precedent: #105 (2026-09-06) made
// the same correction for CITATION_VERIFIER's own trigger.
//
// The touchesRdoMembers branch this function used to carry is DROPPED, not kept as unreachable
// decoration: VALIDATE was the only step with an escalatedEffort at all, so once its
// escalatesEffortOn stopped naming 'touchesRdoMembers' nothing in STEP_CONTRACTS names it here any
// more -- the same "a signal nothing sets" situation 'escalateFlag' was in above shouldEscalate's
// own vocabulary comment, and removed for the same reason (see that comment). shouldEscalate (the
// model-side twin) still reads task.touchesRdoMembers -- action 2 (card #213, landed after this
// comment was first written) folded it into IMPLEMENT's 'planDeclaresRdoMembers' branch as that
// resolution's step-3 fallback, rather than dropping it the way this function did; see
// shouldEscalate's own header for why MODEL escalation still needs it and EFFORT escalation here
// does not.
function shouldEscalateEffort(stepDef, task) {
  if (!stepDef.escalatedEffort) return false;
  const on = stepDef.escalatesEffortOn || [];
  if (task && task.rdoDiffTouched === true && on.includes('rdoDiffTouched')) return true;
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

  const schemaProperties = jsonSchemaPropertiesFor(stepDef.outputContract.types);

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
    // Card #207: `properties`, built from the step's declared `types` (jsonSchemaPropertiesFor,
    // above) so the schema the model receives matches the shape checkOutputTypes() enforces on
    // the reply -- `undefined` (never `{}`) for a step whose outputContract carries no `types` at
    // all, so `--json-schema` for such a step is byte-for-byte what it was before this card
    // (`resolveStepContract: jsonSchema.required mirrors the step outputContract`,
    // test/step-contracts.test.js, is unaffected). UNMEASURED, same as the `required`-only
    // envelope this replaces: whether adding `properties` changes what the model actually sends,
    // or whether `claude -p --json-schema` enforces this schema at all -- see this card's own
    // "What the card measured, and what it did NOT" section. The schema is a declaration; the
    // enforcement is checkOutputTypes() in llm.js's reply check.
    jsonSchema: {
      type: 'object',
      required: stepDef.outputContract.required,
      ...(schemaProperties !== undefined ? { properties: schemaProperties } : {}),
    },
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
  // Card #207: exported for llm.js's reply check (checkOutputTypes) and for the table-driven
  // type-checker tests in test/step-contracts.test.js (valueSatisfiesType, jsonSchemaPropertiesFor).
  checkOutputTypes,
  valueSatisfiesType,
  jsonSchemaPropertiesFor,
};
