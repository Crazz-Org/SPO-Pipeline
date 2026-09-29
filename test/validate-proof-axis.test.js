'use strict';
// validate-proof-axis.test.js -- card SPO-Pipeline#314. VALIDATE (prompts/validate-change.md) gains
// a third axis, proof: each flow in PLAN's `proof_flows` (card #312) must assert the change's
// observable effect, not merely that no error occurred (REJECT for a flow the criterion names or a
// `new:` flow; a finding for an existing flow PLAN chose itself). The no-waiver rule keys on the
// gate report's `Requested flows:` line (renderGateReport, steps/scripted.js), never on precedent:
// a live-run clause's flow the gate was asked for and did not drive is REJECT; one it was never
// asked for is never REJECT and never a plain PASS -- a mandatory finding, since IMPLEMENT cannot
// change what the gate is asked (card 2026-09-30 adjustment). VALIDATE runs from this repo's root
// with no worktree, so task-values.js hands it the product's flow file as {{flows_path}} and PLAN's
// two keys as {{proof_flows}} / {{regression_flows}}.
//
// Same approach as test/review-validate-scope.test.js and test/proof-flows-prompts.test.js: each
// sentence is pinned inside the section it belongs to, so a sentence elsewhere in the file can
// never satisfy it. The LLM's own verdict is not replayable here (test/no-real-spawn.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const { buildPromptValues, NO_FLOWS_DECLARED } = require('../orchestrator/task-values');
const { fillPromptTemplate, extractPlaceholders } = require('../orchestrator/prompt-template');
const { STEP_CONTRACTS } = require('../orchestrator/step-contracts');
const { appendEvent } = require('../orchestrator/journal');
const { renderGateReport, NO_REQUESTED_FLOWS } = require('../orchestrator/steps/scripted');
const { mkTmp } = require('./helpers');

const VALIDATE_PROMPT = STEP_CONTRACTS.VALIDATE.promptFile;
const read = () => fs.readFileSync(VALIDATE_PROMPT, 'utf8');

// slice(text, start, end): text between two markers, throwing when either is missing.
function slice(text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) throw new Error(`validate-change.md: start marker not found: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`validate-change.md: end marker not found: ${end}`);
  return text.slice(from, to);
}

const proofSection = () => slice(read(), '### 3 · Proof', '## Your verdict');
const neverDoSection = () => slice(read(), '## What you never do\n', '## The three axes you judge');
const verdictTable = () => slice(read(), '## Your verdict', '`REJECT` is reserved for');

// ---- the prompt ---------------------------------------------------------------------------------

test('validate-change.md: three axes, the third is proof, read from flows_file\'s assertions.check calls', () => {
  const text = read();
  assert.match(text, /## The three axes you judge/);
  assert.doesNotMatch(text, /two axes/);
  const proof = proofSection();
  assert.match(proof, /`FLOWS` list in `flows_file`/);
  assert.match(proof, /`assertions\.check\(<what>, <condition>, <detail>\)`/);
  assert.match(proof, /The ones in `proof_flows`/);
});

test('validate-change.md: an only-no-error proof flow is REJECT when demanded (criterion-named or new:), a finding when it is an existing flow PLAN chose', () => {
  const proof = proofSection();
  const demanded = proof.indexOf('**A demanded proof flow whose checks assert only that no error occurred is `REJECT`.**');
  const planChosen = proof.indexOf('**An existing flow PLAN chose on its own that asserts only that no error occurred is a\n    finding, not a `REJECT`**');
  assert.ok(demanded >= 0, 'missing the demanded -> REJECT sentence');
  assert.ok(planChosen > demanded, 'missing the PLAN-chosen -> finding sentence, after the demanded one');
  const demandedPart = proof.slice(demanded, planChosen);
  assert.match(demandedPart, /A\s+flow is demanded when the criterion's `Proof flows:` line names it, or when it is a\s+`new:<name>` flow, whichever list it came from/);
  const planChosenPart = proof.slice(planChosen, proof.indexOf('- **`proof_flows` is `["none'));
  assert.match(planChosenPart, /`PASS_WITH_FINDINGS`, naming the flow/);
  assert.match(planChosenPart, /SPO-WebClient#1188/);
  // the verdict table carries the case too, so the table and § 3 cannot disagree
  assert.match(verdictTable(), /\| `REJECT` \| The criterion is \*\*not\*\* met — including a live proof the gate was asked for and did not drive, or a demanded proof flow that asserts only that no error occurred/);
});

test('validate-change.md: a new:<flow> must exist after the change, and a `none — <reason>` is judged against the diff', () => {
  const proof = proofSection();
  assert.match(proof, /\*\*A `new:<name>` flow exists\*\* in `flows_file`[\s\S]{0,120}missing, the criterion is not met: `REJECT`/);
  assert.match(proof, /Judge whether the reason\s+holds against the diff/);
  assert.match(proof, /the\s+reason does not hold: `PASS_WITH_FINDINGS`/);
});

// the part of § 3 about one undriven clause flow: from the "Asked for" bullet to the next paragraph
const askedSplit = () => {
  const proof = proofSection();
  const from = proof.indexOf('- **Asked for and not driven:');
  const to = proof.indexOf("**Flows the criterion does not demand are the gate's to drive.**");
  assert.ok(from >= 0 && to > from, 'missing the asked / never-asked bullets');
  const part = proof.slice(from, to);
  const never = part.indexOf('- **Never asked for:');
  assert.ok(never > 0, 'missing the never-asked bullet');
  return { asked: part.slice(0, never), never: part.slice(never) };
};

test('validate-change.md: what counts as a live-run clause, and the gate report is read for what was asked AND what was driven', () => {
  const proof = proofSection();
  assert.match(proof, /A \*live-run clause\* is a\s+criterion's `Proof flows:` line/);
  // a pre-#312 criterion (a `test:live --flows=` Done-when, no `Proof flows:` line) is a live-run
  // clause too, so the asked / never-asked split applies to it -- the whole sentence is pinned
  assert.match(proof, /or any\s+clause requiring a live run, such as a Done-when that a `test:live \.\.\.` run exits 0\./);
  assert.match(proof, /\*\*Did the proof run\? Read the gate's attestation, never precedent\.\*\*/);
  // the prompt quotes the exact line renderGateReport writes when nothing asked the gate for a flow
  assert.ok(proof.includes('`' + NO_REQUESTED_FLOWS + '`'), 'the prompt must quote NO_REQUESTED_FLOWS verbatim');
  // a report without the line (none written for this HEAD) falls on the never-asked side, never REJECT
  assert.match(proof, /No such line, or no gate report at all, means it was asked for none\./);
  assert.match(proof, /\*\*What it drove\*\*: the `"live"` object of its `## Other fields` JSON block/);
  // every live-block shape measured on ~/.spo-bench/verdicts
  assert.match(proof, /`"status": "ran"`\s+with `"flows": \[\.\.\.\]`/);
  assert.match(proof, /`"status": "skipped"` \(for instance with\s+`"required": \[\]`/);
  assert.match(proof, /`"status":\s+"unknown"`, no `"live"` object, or no gate report at all: it drove none/);
  assert.match(proof, /A flow the gate drove is met,\s+whether it was asked for or not/);
});

test('validate-change.md: asked for and not driven is REJECT, never waived, and precedent is not a reason', () => {
  const { asked } = askedSplit();
  assert.match(asked, /\*\*Asked for and not driven: `REJECT`, never `PASS` and never `PASS_WITH_FINDINGS`\.\*\*/);
  assert.match(asked, /on `Requested flows:` and missing from the `live` block's driven flows/);
  assert.match(asked, /\*\*Precedent is not a reason\*\*: that earlier cards\s+were passed with the same clause unmet/);
});

test('validate-change.md: never asked for is never REJECT and never a plain PASS -- a mandatory finding with the fixed wording', () => {
  const { never } = askedSplit();
  assert.match(never, /\*\*Never asked for: never `REJECT`, and never a plain `PASS`\.\*\*/);
  assert.match(never, /IMPLEMENT cannot change\s+what the gate is asked/);
  assert.match(never, /the\s+verdict is at most `PASS_WITH_FINDINGS`, and it carries a finding titled exactly\s+`live proof not driven: the gate was not asked for <flows>`/);
  // #1009: an IMPLEMENT that runs test:live itself does not satisfy the clause -- the prompt must
  // never suggest it does
  assert.match(never, /running `test:live` itself does not satisfy the clause either: a\s+run from the worktree never rewrites the gate's verdict for the commit/);
  assert.match(never, /Card #1009 was\s+REJECTed on exactly this[\s\S]{0,200}`diagnose-duplicate-root-cause`/);
  // and the verdict table allows the PWF for this case
  assert.match(verdictTable(), /\| `PASS_WITH_FINDINGS` \| [^\n]*or because the gate was never asked for its live proof \(§ 3\)/);
});

test('validate-change.md: nothing tells VALIDATE (or the next IMPLEMENT) to satisfy a live clause by running it', () => {
  const text = read();
  assert.doesNotMatch(text, /the retry must run/i);
  assert.doesNotMatch(text, /IMPLEMENT\b[^.]{0,60}\b(?:should|must|can|to)\s+(?:re-?)?run\b[^.]{0,40}test:live/i);
});

test('validate-change.md: "do not check tests" is reworded so it cannot contradict reading the gate\'s attestation', () => {
  const never = neverDoSection();
  assert.doesNotMatch(read(), /Do not check that tests pass/);
  assert.match(never, /\*\*Do not re-run tests, and do not re-check that they pass\.\*\*/);
  assert.match(never, /`gate_report` is its attestation of what ran/);
  assert.match(never, /which live flows the gate was asked for and drove, and\s+never runs one itself/);
});

test('validate-change.md: an undriven regression flow, or a proof flow the criterion never demanded, is a reasons line, never a verdict -- the gate (#313) owns it', () => {
  const proof = proofSection();
  const at = proof.indexOf('**Flows the criterion does not demand are the gate\'s to drive.**');
  assert.ok(at >= 0, 'missing the undemanded-flows paragraph');
  const undemanded = proof.slice(at);
  assert.match(undemanded, /A regression flow \(in\s+`regression_flows`, or on the criterion's `Regression flows:` line\)/);
  assert.match(undemanded, /A proof flow PLAN chose on its own, when the criterion carries\s+no live-run clause/);
  assert.match(undemanded, /One of either that did not run is a `reasons` line naming it, never a verdict of its own/);
  assert.match(undemanded, /SPO-Pipeline#313[\s\S]{0,120}`live-proof-missing`/);
});

test('validate-change.md: the payload carries the three new placeholders and the header declares them', () => {
  const text = read();
  assert.match(text, /flows_file: {3}\{\{flows_path\}\}/);
  assert.match(text, /proof_flows: {2}\{\{proof_flows\}\}/);
  assert.match(text, /regression_flows: \{\{regression_flows\}\}/);
  const declared = extractPlaceholders(text);
  for (const name of ['flows_path', 'proof_flows', 'regression_flows']) {
    assert.ok(declared.includes(name), `header must declare {{${name}}}: ${declared}`);
  }
  // pre-#312 plans: the prompt says what the fixed text means
  assert.ok(proofSection().includes(`When it reads \`${NO_FLOWS_DECLARED}\``));
  // ... and falls back to the criterion's own line, not to "skip the axis"
  assert.match(proofSection(), /\(none declared\)` \(a card planned\s+before PLAN returned the key\), take the flows named on the criterion's `Proof flows:` line/);
});

// ---- task-values.js -----------------------------------------------------------------------------

function taskDirWithPlan(payload) {
  const taskDir = mkTmp('spo-validate-proof-');
  if (payload) appendEvent(taskDir, 'PLAN', 'result', { payload });
  return taskDir;
}

const basePlan = {
  ok: true,
  plan_path: '/tmp/scratch/plan-1.md',
  invariants_path: '/tmp/scratch/invariants-1.md',
  invariant_ids: ['INV-1'],
  check_commands: ['npm test'],
};

test('buildPromptValues(VALIDATE): flows_path is the worktree\'s src/e2e/flows.ts, absolute', () => {
  const wt = mkTmp('spo-validate-proof-wt-');
  const values = buildPromptValues({ task: { issue: 1, criterion: 'c', worktreePath: wt }, taskDir: taskDirWithPlan(basePlan) }, 'VALIDATE');
  assert.equal(values.flows_path, path.join(wt, 'src', 'e2e', 'flows.ts'));
  assert.ok(path.isAbsolute(values.flows_path));
});

test('buildPromptValues(VALIDATE): no worktree leaves flows_path undefined, so the missing-placeholder park fires (fail-closed)', () => {
  const values = buildPromptValues({ task: { issue: 1, criterion: 'c' }, taskDir: taskDirWithPlan(basePlan) }, 'VALIDATE');
  assert.equal(values.flows_path, undefined);
  assert.throws(() => fillPromptTemplate(VALIDATE_PROMPT, values), (err) => err.name === 'MissingPlaceholderError' && err.missing.includes('flows_path'));
});

test('buildPromptValues(VALIDATE): proof_flows / regression_flows come from PLAN\'s result payload, array or JSON string alike', () => {
  const wt = mkTmp('spo-validate-proof-wt-');
  const fromArray = buildPromptValues(
    {
      task: { issue: 1, criterion: 'c', worktreePath: wt },
      taskDir: taskDirWithPlan({ ...basePlan, proof_flows: ['mail-roundtrip', 'new:mail-delete-refresh'], regression_flows: ['mail-drafts'] }),
    },
    'VALIDATE'
  );
  assert.deepEqual(fromArray.proof_flows, ['mail-roundtrip', 'new:mail-delete-refresh']);
  assert.deepEqual(fromArray.regression_flows, ['mail-drafts']);
  const fromString = buildPromptValues(
    {
      task: { issue: 1, criterion: 'c', worktreePath: wt },
      taskDir: taskDirWithPlan({ ...basePlan, proof_flows: '["none — a refactor, no wire change"]', regression_flows: '[]' }),
    },
    'VALIDATE'
  );
  assert.deepEqual(fromString.proof_flows, ['none — a refactor, no wire change']);
  assert.deepEqual(fromString.regression_flows, []);
});

test('buildPromptValues(VALIDATE): the LAST PLAN result is read, not the first (a planInvalidRetry re-plan changes the flows)', () => {
  const wt = mkTmp('spo-validate-proof-wt-');
  const taskDir = taskDirWithPlan({ ...basePlan, proof_flows: ['mail-roundtrip'], regression_flows: ['mail-drafts'] });
  // the re-plan: a second PLAN `result` for the same task, with different flows
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { ...basePlan, proof_flows: ['new:mail-delete-refresh'], regression_flows: ['mail-reply', 'mail-drafts'] },
  });
  const values = buildPromptValues({ task: { issue: 1, criterion: 'c', worktreePath: wt }, taskDir }, 'VALIDATE');
  assert.deepEqual(values.proof_flows, ['new:mail-delete-refresh']);
  assert.deepEqual(values.regression_flows, ['mail-reply', 'mail-drafts']);
});

test('buildPromptValues(VALIDATE): a plan from before #312 (neither key) renders the fixed "(none declared)" text and still fills', () => {
  const wt = mkTmp('spo-validate-proof-wt-');
  const values = buildPromptValues({ task: { issue: 1, criterion: 'c', worktreePath: wt }, taskDir: taskDirWithPlan(basePlan) }, 'VALIDATE');
  assert.equal(values.proof_flows, NO_FLOWS_DECLARED);
  assert.equal(values.regression_flows, NO_FLOWS_DECLARED);
  assert.equal(NO_FLOWS_DECLARED, '(none declared)');
  const filled = fillPromptTemplate(VALIDATE_PROMPT, values);
  assert.match(filled, /proof_flows: {2}\(none declared\)\n/);
  assert.match(filled, /regression_flows: \(none declared\)\n/);
});

test('buildPromptValues(VALIDATE): a malformed key (object, non-string element, unparsable string) is "(none declared)" too, never undefined', () => {
  const wt = mkTmp('spo-validate-proof-wt-');
  for (const bad of [{ a: 1 }, ['ok', 3], 'not json', null]) {
    const values = buildPromptValues(
      { task: { issue: 1, criterion: 'c', worktreePath: wt }, taskDir: taskDirWithPlan({ ...basePlan, proof_flows: bad, regression_flows: bad }) },
      'VALIDATE'
    );
    assert.equal(values.proof_flows, NO_FLOWS_DECLARED, `proof_flows for ${JSON.stringify(bad)}`);
    assert.equal(values.regression_flows, NO_FLOWS_DECLARED, `regression_flows for ${JSON.stringify(bad)}`);
  }
});

test('fillPromptTemplate(VALIDATE): the flow lists render as JSON, so a `none — <reason>` with a comma stays one element', () => {
  const wt = mkTmp('spo-validate-proof-wt-');
  const values = buildPromptValues(
    {
      task: { issue: 1, criterion: 'c', worktreePath: wt },
      taskDir: taskDirWithPlan({ ...basePlan, proof_flows: ['none — a refactor, no wire change'], regression_flows: [] }),
    },
    'VALIDATE'
  );
  const filled = fillPromptTemplate(VALIDATE_PROMPT, values);
  assert.ok(filled.includes('proof_flows:  ["none — a refactor, no wire change"]'), 'proof_flows must render as a JSON array');
  assert.ok(filled.includes('regression_flows: []'), 'an empty regression list renders as [], not an empty string');
  assert.ok(filled.includes(`flows_file:   ${path.join(wt, 'src', 'e2e', 'flows.ts')}`));
});

// ---- the contract: every placeholder VALIDATE's prompt declares, the deriver supplies ----------

test('STEP_CONTRACTS.VALIDATE: its prompt declares flows_path/proof_flows/regression_flows, and buildPromptValues supplies every declared placeholder, with and without #312\'s keys', () => {
  const declared = extractPlaceholders(fs.readFileSync(STEP_CONTRACTS.VALIDATE.promptFile, 'utf8'));
  for (const name of ['flows_path', 'proof_flows', 'regression_flows']) assert.ok(declared.includes(name), name);
  const wt = mkTmp('spo-validate-proof-wt-');
  for (const plan of [basePlan, { ...basePlan, proof_flows: ['login-spine'], regression_flows: [] }]) {
    const values = buildPromptValues({ task: { issue: 1, criterion: 'c', worktreePath: wt }, taskDir: taskDirWithPlan(plan) }, 'VALIDATE');
    const missing = declared.filter((name) => values[name] === undefined || values[name] === null);
    assert.deepEqual(missing, [], `VALIDATE placeholders with no value: ${missing}`);
    assert.doesNotThrow(() => fillPromptTemplate(STEP_CONTRACTS.VALIDATE.promptFile, values));
  }
});

// ---- gate-report.md's `Requested flows:` line (renderGateReport, steps/scripted.js) -------------

// A real bench verdict shape (~/.spo-bench/verdicts/8f68f031….json, 2026-09-29), trimmed.
const realVerdict = () => ({
  head: '8f68f0310068acdea0327cb8e47a29c3642fecc0',
  verdict: 'PASS',
  baseMain: 'b30251eed25f2c736b16cc8be47c7f5a0785da75',
  live: { status: 'ran', flows: ['login-spine', 'profile-read'] },
});

test('renderGateReport: with nothing requested, the report carries exactly the "none" line, right after the header fields', () => {
  assert.equal(NO_REQUESTED_FLOWS, 'Requested flows: none — the gate was not asked for any flow');
  for (const opts of [undefined, {}, { requestedFlows: undefined }, { requestedFlows: [] }]) {
    const report = renderGateReport(realVerdict(), opts);
    const lines = report.split('\n');
    assert.equal(lines.filter((l) => l.startsWith('Requested flows:')).length, 1, `one line for ${JSON.stringify(opts)}`);
    assert.deepEqual(lines.slice(0, 6), [
      '# Gate report',
      '',
      '**Verdict:** PASS',
      '**Base main:** b30251eed25f2c736b16cc8be47c7f5a0785da75',
      NO_REQUESTED_FLOWS,
      '',
    ]);
  }
  // even a verdict with none of the header fields gets the line
  assert.match(renderGateReport({ live: { status: 'skipped', required: [] } }), /^Requested flows: none — the gate was not asked for any flow$/m);
});

test('renderGateReport: a requested list renders as "Requested flows: a, b", and the live block stays in Other fields', () => {
  const report = renderGateReport(realVerdict(), { requestedFlows: ['profile-read', 'new:mail-delete-refresh'] });
  assert.match(report, /^Requested flows: profile-read, new:mail-delete-refresh$/m);
  assert.ok(!report.includes(NO_REQUESTED_FLOWS));
  assert.match(report, /## Other fields[\s\S]*"live": \{\s+"status": "ran",\s+"flows": \[/);
  // one requested flow is a list too, never the "none" line
  assert.match(renderGateReport(realVerdict(), { requestedFlows: ['login-spine'] }), /^Requested flows: login-spine$/m);
  // a non-array, or a list of nothing but empty / non-string entries, asked the gate for nothing
  for (const junk of ['login-spine', { flows: ['login-spine'] }, ['', null, 3]]) {
    const lines = renderGateReport(realVerdict(), { requestedFlows: junk }).split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('Requested flows:')), [NO_REQUESTED_FLOWS], JSON.stringify(junk));
  }
  // the junk is dropped, the real names kept
  assert.match(renderGateReport(realVerdict(), { requestedFlows: ['', 'login-spine', null] }), /^Requested flows: login-spine$/m);
});

// The only production caller today: prepareJudgeInputs asks the gate for nothing, so the report
// VALIDATE reads says so -- a report that claimed a flow was requested would turn every live-run
// clause into a REJECT that IMPLEMENT cannot fix (#1009). #313 changes this caller, and this test.
test('prepareJudgeInputs: the gate-report.md written today carries the "none" Requested flows line', () => {
  const { buildCtx } = require('../orchestrator/state-machine');
  const { prepareJudgeInputs } = require('../orchestrator/steps/scripted');
  const { gateReportPath } = require('../orchestrator/task-values');
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null });
  const headSha = 'headsharequestedflows0000000000000000000';
  const mainSha = 'mainsharequestedflows0000000000000000000';
  const spoBenchDir = mkTmp('spo-validate-proof-bench-');
  fs.mkdirSync(path.join(spoBenchDir, 'verdicts'), { recursive: true });
  fs.writeFileSync(path.join(spoBenchDir, 'verdicts', `${headSha}.json`), JSON.stringify(realVerdict()));
  const taskDir = path.join(mkTmp('spo-validate-proof-journalroot-'), 'card-rf');
  fs.mkdirSync(taskDir, { recursive: true });
  const task = { id: 'card-rf', kind: 'card', issue: 1, worktreePath: mkTmp('spo-validate-proof-wt-') };
  const ctx = buildCtx('card-rf', task, taskDir, {
    shadowMode: false,
    dryRun: false,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-validate-proof-worktrees-'),
    spoBenchDir,
  });
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${mainSha}\n`);
      if (args.includes('rev-list') && args.includes('--count')) return ok('1\n');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) return ok('diff --git a/g.ts b/g.ts\n+x\n');
      return ok('');
    },
  };
  assert.ok(prepareJudgeInputs(ctx, deps, { forState: 'VALIDATE' }).gateReportProduced);
  const lines = fs.readFileSync(gateReportPath(taskDir), 'utf8').split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('Requested flows:')), [NO_REQUESTED_FLOWS]);
});
