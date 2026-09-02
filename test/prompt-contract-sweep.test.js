'use strict';
// prompt-contract-sweep.test.js -- action 7bis.2. For every prompt in prompts/ (all eight files,
// the five state-machine steps AND the three intake-path steps -- see step-contracts.js's own
// header on why review-card.md/draft-card.md/triage-bug-report.md carry no STEP_CONTRACTS entry),
// checks BOTH directions of the placeholder contract, a live-crash guard action 7bis.4 introduced
// and caught, the prose tool-grant statement against the real allowedTools, and prompts/README.md's
// table against its own ground truth (step-contracts.js / orchestrator/intake.js). Modelled on
// test/gh-api-argv.test.js, test/no-real-spawn-sweep.test.js, test/park-reason-doc-sweep.test.js
// and test/doc-constant-sweep.test.js: read the SOURCE (or, for the five state-machine steps, call
// the REAL deriver, task-values.js's buildPromptValues, against a synthetic ctx -- preferred over
// re-implementing its logic, per this action's own brief) rather than hand-maintain a second copy
// of any of this that a future edit can forget to update.
//
// Four things this file checks per prompt/step:
//   1. every {{placeholder}} the file's HEADER declares is a key the step's own deriver actually
//      supplies (task-values.js's buildPromptValues for the five state-machine steps; the inline
//      value object at orchestrator/intake.js's own fillPromptTemplate call site for the three
//      intake steps) -- else prompt-template.js's fillPromptTemplate throws MissingPlaceholderError
//      the first time the step is ever really called.
//   2. every value the step's own deriver returns is consumed by the file (the reverse direction --
//      today's runtime check, llm.js's missing-key validation of a REPLY's fields, covers neither
//      this nor #1 for a PROMPT's placeholders; prompt-template.js's own missing-placeholder check
//      covers #1 only, only at runtime, only for whichever step happens to run).
//   3. every {{token}} actually written into the file's BODY is one the header declared -- if it is
//      not, prompt-template.js never fills it (it only extracts the declared set from the HEADER,
//      see prompt-template.js's own header comment) and the token survives to trip the stray-`{{}}`
//      check on the very first real call. This is exactly the class of bug action 7bis.4 introduced
//      and caught (`{{human_confirmed}}` written into a prompt BODY that never declared it).
//   4. where the prompt's own prose states its tool grant in so many words ("You hold `Read,
//      Grep`", "You may `Read`/`Grep`/..."), that stated set matches allowedTools exactly. Per this
//      action's brief, this is the load-bearing one: verify-citations.md does not merely state
//      `Read, Grep`, it *reasons* from it (telling the model to fall back to `Read` on an ISO-8859
//      file because it holds no `Bash`) -- a grant that drifted would leave the prompt teaching a
//      workaround for a constraint that no longer exists, and 7.5's own history records this exact
//      cell was already wrong once.
// Plus a fifth, separate check: prompts/README.md's step table against the same ground truth
// (step-contracts.js / intake.js) -- it is a DERIVED table, per this action's brief, so checking it
// against the live source (not a second hand-pinned literal, unlike test/doc-constant-sweep.test.js's
// PINS) is the correct posture here.
//
// Every checking function below is exported and driven, in the second half of this file, against
// synthetic fixtures carrying a known, deliberate divergence -- so a mutation to the checker itself
// (not just to the corpus it reads) fails a test. See this suite's own convention
// (test/no-real-spawn-sweep.test.js's fixture tests) for the same idea applied to a different sweep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Killswitch first, textually before any orchestrator require -- test/no-real-spawn-sweep.test.js
// enforces this repo-wide (see its own header for the incident: a real in-process spawnSync
// reaching `gh` with live pool credentials). This file never calls anything that spawns (it only
// reads task-values.js/prompt-template.js/step-contracts.js, all pure fs/path), but the rule is
// mechanical and file-wide on purpose -- see that sweep's own header on why a per-file judgment
// call is exactly what it refuses to trust.
require('./no-real-spawn');

const { STEP_CONTRACTS } = require('../orchestrator/step-contracts');
const { buildPromptValues } = require('../orchestrator/task-values');
const { extractPlaceholders, splitHeaderAndBody } = require('../orchestrator/prompt-template');

const REPO_ROOT = path.join(__dirname, '..');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');
const README_TEXT = fs.readFileSync(path.join(PROMPTS_DIR, 'README.md'), 'utf8');
const INTAKE_SRC = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator', 'intake.js'), 'utf8');

// =================================================================================================
// Checking functions -- exported at the bottom, unit-tested with fixtures in the second half.
// =================================================================================================

// Same idiom as gh-api-argv.test.js / no-real-spawn-sweep.test.js / park-reason-doc-sweep.test.js,
// verbatim: comments blanked (never deleted), so byte offsets -- and therefore every regex match
// position this file computes -- still line up with the real source, and prose that MENTIONS a
// pattern (this file's own header does, repeatedly) is never mistaken for a real call site.
function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
}

// direction 1 -- every declared placeholder must be a key the step's deriver supplies.
function underivablePlaceholders(declaredPlaceholders, derivedKeys) {
  return declaredPlaceholders.filter((p) => !derivedKeys.includes(p));
}

// direction 2 (the reverse) -- every key the step's deriver supplies must be consumed by the file.
function unusedDerivedValues(derivedKeys, declaredPlaceholders) {
  return derivedKeys.filter((k) => !declaredPlaceholders.includes(k));
}

// live-crash guard -- every {{token}} actually written into the BODY (not just the header) must be
// declared. Reuses prompt-template.js's own extractPlaceholders/splitHeaderAndBody (the header-only
// declaration scan) rather than re-implementing it, so this can never quietly disagree with what
// fillPromptTemplate itself does at runtime.
function undeclaredBodyReferences(promptFile) {
  const text = fs.readFileSync(promptFile, 'utf8');
  const { body } = splitHeaderAndBody(text);
  const declared = new Set(extractPlaceholders(text));
  const bodyTokens = new Set();
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(body))) bodyTokens.add(m[1]);
  return Array.from(bodyTokens).filter((t) => !declared.has(t));
}

// The prose tool-grant a prompt file states about itself, in one of the two shapes this corpus
// uses today ("You hold `A, B, C`" / "You may `A`/`B`/`C`"), or null when the file states no
// explicit tool-name list at all (plan.md, implement.md and triage-bug-report.md describe their
// permission generically -- "read-only", "full edit tools" -- without ever enumerating tool names;
// see the NO_PROSE_TOOL_GRANT set and its own regression test below).
function parseProseToolGrant(body) {
  const holdMatch = body.match(/You hold `([^`]+)`/);
  if (holdMatch) {
    return holdMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const mayMatch = body.match(/You may ((?:`[A-Za-z]+`\/?)+)/);
  if (mayMatch) {
    const tools = [];
    const re = /`([A-Za-z]+)`/g;
    let m;
    while ((m = re.exec(mayMatch[1]))) tools.push(m[1]);
    return tools;
  }
  return null;
}

function extractProseToolGrant(promptFile) {
  const text = fs.readFileSync(promptFile, 'utf8');
  const { body } = splitHeaderAndBody(text);
  return parseProseToolGrant(body);
}

// null when there is nothing to compare (no prose statement) or the two sets agree; otherwise the
// two-sided disagreement -- what the prose is missing that allowedTools grants, and what the prose
// claims that allowedTools does not grant. Reported both ways on purpose: a prose statement that
// UNDER-claims (silently drops a real tool) is as much a drift as one that OVER-claims.
function proseToolGrantMismatch(proseTools, allowedTools) {
  if (!proseTools) return null;
  const proseSet = new Set(proseTools);
  const grantSet = new Set(allowedTools);
  const missingFromProse = allowedTools.filter((t) => !proseSet.has(t));
  const extraInProse = proseTools.filter((t) => !grantSet.has(t));
  if (missingFromProse.length === 0 && extraInProse.length === 0) return null;
  return { missingFromProse, extraInProse };
}

// prompts/README.md's table is a DERIVED table (this action's own brief) over step-contracts.js /
// intake.js's live values -- so checking it against those live values, rather than a second
// hand-pinned literal (test/doc-constant-sweep.test.js's PINS idiom, built for genuinely
// independent constants), is the correct posture for THIS table specifically.
const MODEL_LABEL = { fable: 'Fable 5', sonnet: 'Sonnet 5', opus: 'Opus 5' };

function readmeRowProblems(row, contract) {
  const problems = [];
  if (!row) {
    problems.push('no matching README row found');
    return problems;
  }
  const baseLabel = MODEL_LABEL[contract.baseModel];
  if (baseLabel && !row.includes(baseLabel)) {
    problems.push(`row does not mention base model ${baseLabel}`);
  }
  if (contract.escalatedModel) {
    const escLabel = MODEL_LABEL[contract.escalatedModel];
    if (escLabel && !row.includes(escLabel)) {
      problems.push(`row does not mention escalated model ${escLabel}`);
    }
  }
  if (contract.allowedTools.includes('Edit') || contract.allowedTools.includes('Write')) {
    if (!/full edit tools/i.test(row)) {
      problems.push('row does not say "full edit tools" for a step holding Edit/Write');
    }
  } else {
    for (const tool of contract.allowedTools) {
      if (!row.includes(tool)) problems.push(`row does not mention tool ${tool}`);
    }
  }
  return problems;
}

// =================================================================================================
// Building the eight contracts -- five read from step-contracts.js + a real buildPromptValues()
// call, three read from orchestrator/intake.js's own source (see this file's header on why source,
// not re-implementation).
// =================================================================================================

// Synthetic ctx for buildPromptValues -- a tmpdir only, one journal.jsonl line this file writes
// itself, never the real repo, never a spawn (task-values.js touches only fs.existsSync/
// readFileSync -- verified by reading it for this action; it requires no child_process). Populated
// so every field every one of the five state-machine steps can derive resolves to a DEFINED value
// (task-values.js's own header: undefined/null is prompt-template.js's "missing" condition) --
// that is what lets "derivable" mean more than "the key merely exists on the returned object".
function makeSyntheticCtx() {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-contract-sweep-'));
  const planPayload = {
    plan_path: path.join(taskDir, 'scratch', 'plan-999.md'),
    invariants_path: path.join(taskDir, 'scratch', 'invariants-999.md'),
    invariant_ids: ['INV-1'],
    check_commands: ['echo synthetic-check'],
  };
  fs.writeFileSync(
    path.join(taskDir, 'journal.jsonl'),
    JSON.stringify({ ts: Date.now(), state: 'PLAN', event: 'result', payload: planPayload }) + '\n'
  );
  return {
    taskDir,
    task: {
      issue: 999,
      title: 'Synthetic task title',
      criterion: 'Synthetic acceptance criterion',
      worktreePath: path.join(taskDir, 'worktree'),
      size: 'M',
      citations: ['SyntheticFile.pas:42'],
      spoOriginalPath: path.join(taskDir, 'spo-original'),
    },
  };
}

const SYNTHETIC_CTX = makeSyntheticCtx();

// Hard-coded rather than derived, because each step also needs a README_ROW_RE entry below and a
// silently-auto-included step would fail obscurely instead of telling its author what to add. The
// price of hard-coding is that a sixth STEP_CONTRACTS entry would go unchecked while the sweep
// stayed green -- exactly the "green by construction for contracts that do not exist yet" failure
// Gate C7's first certification forbids. So the list is pinned to the real keys by an assertion in
// the sweep test below (`STEP_CONTRACT_STEPS covers every STEP_CONTRACTS entry`): adding a step
// turns this file red, with a message naming what to extend.
const STEP_CONTRACT_STEPS = ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE'];

const README_ROW_RE = {
  PLAN: /^\|\s*PLAN\s*\|.*$/m,
  IMPLEMENT: /^\|\s*IMPLEMENT\s*\|.*$/m,
  DIAGNOSE: /^\|\s*DIAGNOSE\s*\|.*$/m,
  CITATION_VERIFIER: /^\|\s*VALIDATE\s*—\s*citation-verifier\s*\|.*$/m,
  VALIDATE: /^\|\s*VALIDATE\s*—\s*change-validator\s*\|.*$/m,
  DRAFT_CARD: /^\|\s*draft-card\b.*$/m,
  REVIEW_CARD: /^\|\s*review-card\b.*$/m,
  TRIAGE_BUG_REPORT: /^\|\s*triage-bug-report\b.*$/m,
};

function readmeRowFor(step) {
  const m = README_TEXT.match(README_ROW_RE[step]);
  return m ? m[0] : null;
}

function contractFromStepContracts(step) {
  const def = STEP_CONTRACTS[step];
  return {
    step,
    promptFile: def.promptFile,
    allowedTools: def.allowedTools,
    baseModel: def.baseModel,
    escalatedModel: def.escalatedModel || null,
    derivedKeys: Object.keys(buildPromptValues(SYNTHETIC_CTX, step)),
    readmeRow: readmeRowFor(step),
  };
}

// ---- reading the three intake-path contracts out of orchestrator/intake.js's own source --------
//
// One "call site" is bounded by that function's own `// ---- NAME ----` section header (through
// the NEXT one) -- the same section markers this file's own comments above already name. Reading
// per-function slices, rather than the whole file at once, is what keeps draftCard's `model:
// 'sonnet'` from ever being confused with reviewCard's `model: 'fable'` a few hundred lines away.

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`prompt-contract-sweep: marker not found in orchestrator/intake.js: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end === -1 ? source.length : end);
}

// The balanced-brace span of the first `{...}` object literal reachable after `marker`, or null.
// Mirrors gh-api-argv.test.js's apiArgvSpans (a balanced-bracket scan over a known, uniform
// call-site convention) for `{`/`}` instead of `[`/`]`.
function objectLiteralAfter(source, marker) {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) return null;
  const open = source.indexOf('{', markerIdx);
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  return source.slice(open, close + 1);
}

// Splits `text` at commas sitting at DEPTH 0 relative to the object literal's own
// braces/brackets/parens, so a nested array or a ternary inside one value can never be mistaken
// for a top-level separator.
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  const tail = text.slice(last);
  if (tail.trim()) parts.push(tail);
  return parts;
}

// The top-level key names of one `{ ... }` object-literal SPAN (braces included), as either a
// `key: value` pair or a shorthand `key` property. Throws on any other shape (a computed key, a
// spread) rather than silently skipping it -- the three real call sites this reads
// (orchestrator/intake.js's draftCard/reviewCard/triageBugReport, each a `fillPromptTemplate
// (PROMPT, { ... })`) are all flat key/shorthand objects today; a future one that is not should
// fail this file loudly, not slide past unnoticed (the exact failure mode
// test/no-real-spawn-sweep.test.js's own header warns a whole-file exemption invites).
function objectLiteralKeys(spanText) {
  const inner = spanText.trim().replace(/^\{/, '').replace(/\}$/, '');
  const keys = [];
  for (const rawPart of splitTopLevelCommas(inner)) {
    const part = rawPart.trim();
    if (!part) continue;
    const kv = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
    if (kv) {
      keys.push(kv[1]);
      continue;
    }
    const shorthand = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (shorthand) {
      keys.push(shorthand[1]);
      continue;
    }
    throw new Error(`prompt-contract-sweep: unrecognized object-literal segment "${part}" -- extend objectLiteralKeys`);
  }
  return keys;
}

function intakeContract({ name, promptFileName, sliceStart, sliceEnd, promptMarker }) {
  const slice = blankComments(sliceBetween(INTAKE_SRC, sliceStart, sliceEnd));

  const allowedToolsMatch = slice.match(/allowedTools:\s*(\[[^\]]*\])/);
  if (!allowedToolsMatch) {
    throw new Error(`prompt-contract-sweep: no allowedTools found for intake step ${name}`);
  }
  const allowedTools = Array.from(allowedToolsMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);

  const modelMatch = slice.match(/\bmodel:\s*'([^']*)'/);
  if (!modelMatch) {
    throw new Error(`prompt-contract-sweep: no model found for intake step ${name}`);
  }

  const valuesSpan = objectLiteralAfter(slice, promptMarker);
  if (!valuesSpan) {
    throw new Error(`prompt-contract-sweep: no fillPromptTemplate value object found for intake step ${name}`);
  }

  return {
    step: name,
    promptFile: path.join(PROMPTS_DIR, promptFileName),
    allowedTools,
    baseModel: modelMatch[1],
    escalatedModel: null, // none of the three intake steps escalate
    derivedKeys: objectLiteralKeys(valuesSpan),
    readmeRow: readmeRowFor(name),
  };
}

const ALL_CONTRACTS = [
  ...STEP_CONTRACT_STEPS.map(contractFromStepContracts),
  intakeContract({
    name: 'DRAFT_CARD',
    promptFileName: 'draft-card.md',
    sliceStart: '// ---- DRAFT_CARD ----',
    sliceEnd: '// ---- review-card ----',
    promptMarker: 'fillPromptTemplate(DRAFT_CARD_PROMPT,',
  }),
  intakeContract({
    name: 'REVIEW_CARD',
    promptFileName: 'review-card.md',
    sliceStart: '// ---- review-card ----',
    sliceEnd: '// ---- mechanical corrections ----',
    promptMarker: 'fillPromptTemplate(REVIEW_CARD_PROMPT,',
  }),
  intakeContract({
    name: 'TRIAGE_BUG_REPORT',
    promptFileName: 'triage-bug-report.md',
    sliceStart: '// ---- triageBugReport ----',
    sliceEnd: '// ---- pullBoard ----',
    promptMarker: 'fillPromptTemplate(TRIAGE_BUG_REPORT_PROMPT,',
  }),
];

// Files with no explicit prose tool-grant statement to compare against allowedTools -- verified by
// reading each one in full for this action. plan.md and implement.md describe their permission
// generically ("this step runs read-only", "you hold full edit tools") without ever enumerating
// tool names in prose; triage-bug-report.md states no tool grant at all. Nothing else about these
// three is exempted: their placeholder-derivability, unused-value and stray-body-token checks all
// still run in evaluateContract below -- only the prose-vs-allowedTools comparison has nothing to
// compare against, per-file, not per-check.
const NO_PROSE_TOOL_GRANT = new Set(['plan.md', 'implement.md', 'triage-bug-report.md']);

// =================================================================================================
// evaluateContract -- the one function both the real sweep below AND the fixture tests drive, so
// a mutation to the checking logic itself (not just to the corpus it reads) fails a fixture test,
// not just a silent pass on the real corpus.
// =================================================================================================

function evaluateContract(contract) {
  const offenders = [];
  let placeholdersChecked = 0;
  let proseChecked = 0;

  if (!fs.existsSync(contract.promptFile)) {
    offenders.push(`${contract.step}: promptFile does not exist: ${contract.promptFile}`);
    return { offenders, placeholdersChecked, proseChecked };
  }

  const text = fs.readFileSync(contract.promptFile, 'utf8');
  const declared = extractPlaceholders(text);
  placeholdersChecked += declared.length;

  const underivable = underivablePlaceholders(declared, contract.derivedKeys);
  if (underivable.length > 0) {
    offenders.push(
      `${contract.step} (${path.basename(contract.promptFile)}): declares placeholder(s) not derivable by its step: ${underivable.join(', ')}`
    );
  }

  const unused = unusedDerivedValues(contract.derivedKeys, declared);
  if (unused.length > 0) {
    offenders.push(
      `${contract.step} (${path.basename(contract.promptFile)}): derives value(s) the file never uses: ${unused.join(', ')}`
    );
  }

  const stray = undeclaredBodyReferences(contract.promptFile);
  if (stray.length > 0) {
    offenders.push(
      `${contract.step} (${path.basename(contract.promptFile)}): body references undeclared placeholder(s) ${stray.join(', ')} -- a live crash the first real call hits (prompt-template.js's stray-token check)`
    );
  }

  const prose = extractProseToolGrant(contract.promptFile);
  if (prose) {
    proseChecked += 1;
    const mismatch = proseToolGrantMismatch(prose, contract.allowedTools);
    if (mismatch) {
      offenders.push(
        `${contract.step} (${path.basename(contract.promptFile)}): prose tool grant disagrees with allowedTools -- ` +
          `prose is missing [${mismatch.missingFromProse.join(', ')}], prose claims extra [${mismatch.extraInProse.join(', ')}]`
      );
    }
  }

  for (const problem of readmeRowProblems(contract.readmeRow, contract)) {
    offenders.push(`${contract.step}: prompts/README.md -- ${problem}`);
  }

  return { offenders, placeholdersChecked, proseChecked };
}

// =================================================================================================
// The real sweep.
// =================================================================================================

test('every prompt-contract entry: placeholders derivable both ways, no stray body reference, tool grant matches, README table agrees', () => {
  const offenders = [];
  let placeholdersChecked = 0;
  let proseChecked = 0;

  for (const contract of ALL_CONTRACTS) {
    const result = evaluateContract(contract);
    offenders.push(...result.offenders);
    placeholdersChecked += result.placeholdersChecked;
    proseChecked += result.proseChecked;
  }

  // Floors -- a glob/marker that silently stops matching anything must go red, not green. See
  // test/gh-api-argv.test.js's siteCount / test/doc-constant-sweep.test.js's PINS.length for the
  // same idiom. Measured 2026-09-02: 8 contracts, 40 declared placeholders total, 5 files with an
  // explicit prose tool-grant statement -- floors set comfortably below each so ordinary future
  // growth (a ninth prompt, a new placeholder) never trips them, but a collapse does.
  const distinctPromptFiles = new Set(ALL_CONTRACTS.map((c) => c.promptFile));
  assert.equal(distinctPromptFiles.size, ALL_CONTRACTS.length, 'expected one contract per prompt file, found a duplicate');
  assert.ok(distinctPromptFiles.size >= 8, `expected at least 8 distinct prompt files checked, found ${distinctPromptFiles.size}`);
  assert.ok(ALL_CONTRACTS.length >= 8, `expected at least 8 step contracts (5 state-machine + 3 intake), found ${ALL_CONTRACTS.length}`);
  assert.ok(placeholdersChecked >= 30, `expected at least 30 declared placeholders checked across all prompt files, found ${placeholdersChecked}`);
  assert.ok(proseChecked >= 5, `expected at least 5 prompt files with an explicit prose tool-grant statement checked, found ${proseChecked}`);

  assert.deepEqual(offenders, [], `prompt-contract divergence(s):\n  ${offenders.join('\n  ')}`);
});

test('STEP_CONTRACT_STEPS covers every STEP_CONTRACTS entry -- a new step cannot be silently unchecked', () => {
  const real = Object.keys(STEP_CONTRACTS).sort();
  const covered = [...STEP_CONTRACT_STEPS].sort();
  assert.deepEqual(
    covered,
    real,
    'orchestrator/step-contracts.js and this sweep disagree on the set of LLM steps. If you added a '
      + 'step, extend STEP_CONTRACT_STEPS *and* README_ROW_RE in this file, and add its row to '
      + 'prompts/README.md; if you removed one, drop it from both. Do not widen the floors instead.'
  );
  // The README regex table has to move in lockstep, or a new step would be checked for
  // placeholders and tool grants but not against prompts/README.md's derived table.
  for (const step of real) {
    assert.ok(README_ROW_RE[step], `no README_ROW_RE entry for step ${step}`);
    assert.ok(readmeRowFor(step), `prompts/README.md has no table row for step ${step}`);
  }
});

test('the prose-tool-grant exemption list is exactly the files with no explicit "You hold/may" statement', () => {
  const actual = new Set();
  for (const contract of ALL_CONTRACTS) {
    if (extractProseToolGrant(contract.promptFile) === null) {
      actual.add(path.basename(contract.promptFile));
    }
  }
  assert.deepEqual(
    actual,
    NO_PROSE_TOOL_GRANT,
    'the set of prompt files with no explicit tool-grant prose has changed -- update NO_PROSE_TOOL_GRANT ' +
      '(if a file GAINED a statement, nothing else is needed; if one LOST it, that drop is itself worth a second look)'
  );
});

// =================================================================================================
// Fixture tests -- prove the checking functions actually detect each class of divergence the plan
// names, driven against synthetic data with a known, deliberate defect. Every assertion below
// exercises the SAME function the real sweep above calls (evaluateContract, or one of the smaller
// functions it is built from) -- never a re-implementation -- so a mutation to the checker fails
// here even when the real corpus (already clean, per the sweep above) gives it nothing to catch.
// =================================================================================================

function writeTempPrompt(dir, name, contents) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

test('underivablePlaceholders: catches a placeholder the file declares that the step cannot derive', () => {
  const found = underivablePlaceholders(['known_field', 'ghost_field'], ['known_field']);
  assert.deepEqual(found, ['ghost_field']);
});

test('underivablePlaceholders: clean when every declared placeholder is derivable', () => {
  const found = underivablePlaceholders(['a', 'b'], ['a', 'b', 'c']);
  assert.deepEqual(found, []);
});

test('unusedDerivedValues: catches a value the step derives that no placeholder in the file consumes', () => {
  const found = unusedDerivedValues(['used_field', 'orphan_field'], ['used_field']);
  assert.deepEqual(found, ['orphan_field']);
});

test('unusedDerivedValues: clean when every derived value is consumed', () => {
  const found = unusedDerivedValues(['a', 'b'], ['a', 'b', 'c']);
  assert.deepEqual(found, []);
});

test('undeclaredBodyReferences: catches a body {{token}} the header never declared -- the 7bis.4 crash shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-contract-fixture-'));
  const promptFile = writeTempPrompt(
    dir,
    'fixture.md',
    [
      '<!--',
      '  Placeholders: {{declared_one}}',
      '-->',
      '',
      '# FIXTURE',
      '',
      'payload: {{declared_one}}',
      // Never declared in the header above -- exactly the shape action 7bis.4 introduced
      // ({{human_confirmed}} written into a prompt body that never declared it).
      'undeclared: {{undeclared_one}}',
    ].join('\n')
  );

  const found = undeclaredBodyReferences(promptFile);
  assert.deepEqual(found, ['undeclared_one']);
});

test('undeclaredBodyReferences: clean when every body token is declared in the header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-contract-fixture-'));
  const promptFile = writeTempPrompt(
    dir,
    'fixture.md',
    ['<!--', '  Placeholders: {{a}} {{b}}', '-->', '', '# FIXTURE', '', '{{a}} and {{b}}'].join('\n')
  );

  const found = undeclaredBodyReferences(promptFile);
  assert.deepEqual(found, []);
});

test('parseProseToolGrant + proseToolGrantMismatch: catches a "You hold" prose grant missing a real tool', () => {
  const prose = parseProseToolGrant('You are a step. You hold `Read, Grep` and no more.');
  assert.deepEqual(prose, ['Read', 'Grep']);

  const mismatch = proseToolGrantMismatch(prose, ['Read', 'Grep', 'Bash']);
  assert.notEqual(mismatch, null);
  assert.deepEqual(mismatch.missingFromProse, ['Bash']);
  assert.deepEqual(mismatch.extraInProse, []);
});

test('parseProseToolGrant + proseToolGrantMismatch: catches a "You may" prose grant claiming an extra tool', () => {
  const prose = parseProseToolGrant('You may `Read`/`Grep`/`Edit` the tree, read-only.');
  assert.deepEqual(prose, ['Read', 'Grep', 'Edit']);

  const mismatch = proseToolGrantMismatch(prose, ['Read', 'Grep']);
  assert.notEqual(mismatch, null);
  assert.deepEqual(mismatch.missingFromProse, []);
  assert.deepEqual(mismatch.extraInProse, ['Edit']);
});

test('proseToolGrantMismatch: clean (null) when the prose and allowedTools sets agree, in either order', () => {
  assert.equal(proseToolGrantMismatch(['Read', 'Grep', 'Bash'], ['Bash', 'Read', 'Grep']), null);
});

test('proseToolGrantMismatch: nothing to compare (null) when the file states no explicit tool grant', () => {
  assert.equal(proseToolGrantMismatch(null, ['Read', 'Grep']), null);
});

test('readmeRowProblems: catches a row missing a real tool name', () => {
  const row = '| DIAGNOSE | `diagnose.md` | Fable 5 | high | `Read, Grep` |';
  const problems = readmeRowProblems(row, {
    baseModel: 'fable',
    escalatedModel: null,
    allowedTools: ['Read', 'Grep', 'Bash'],
  });
  assert.ok(problems.some((p) => p.includes('Bash')), `expected a Bash-missing problem, got: ${JSON.stringify(problems)}`);
});

test('readmeRowProblems: catches a row missing the escalated model label', () => {
  const row = '| PLAN | `plan.md` | Fable 5 | per Size | `Read, Grep, Glob, Bash(ro)` |';
  const problems = readmeRowProblems(row, {
    baseModel: 'fable',
    escalatedModel: 'opus',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
  });
  assert.ok(
    problems.some((p) => p.includes('Opus 5')),
    `expected an Opus-5-missing problem, got: ${JSON.stringify(problems)}`
  );
});

test('readmeRowProblems: catches a missing row entirely', () => {
  const problems = readmeRowProblems(null, { baseModel: 'fable', escalatedModel: null, allowedTools: ['Read'] });
  assert.deepEqual(problems, ['no matching README row found']);
});

test('readmeRowProblems: clean when the row states model, escalation and tools correctly', () => {
  const row = '| VALIDATE — change-validator | `validate-change.md` | Fable 5 -- never Sonnet 5; Opus 5 on the wire rule or as fallback | high | `Read, Grep, Glob, Bash(ro)` |';
  const problems = readmeRowProblems(row, {
    baseModel: 'fable',
    escalatedModel: 'opus',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
  });
  assert.deepEqual(problems, []);
});

test('evaluateContract: a fully synthetic contract with FOUR independent, deliberate divergences is caught and each is named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-contract-fixture-'));
  const promptFile = writeTempPrompt(
    dir,
    'fixture-step.md',
    [
      '<!--',
      // Declares one derivable placeholder, one the (fake) step cannot derive.
      '  Placeholders: {{good_field}} {{underivable_field}}',
      '-->',
      '',
      '# FIXTURE STEP',
      '',
      'You hold `Read, Grep` and no more.', // prose omits Bash, which allowedTools grants below
      '',
      'payload: {{good_field}} {{underivable_field}}',
      // A stray body token the header never declared -- the 7bis.4 crash shape, on top of
      // everything else, to prove the checks are independent of each other.
      'stray: {{stray_field}}',
    ].join('\n')
  );

  const contract = {
    step: 'FIXTURE_STEP',
    promptFile,
    allowedTools: ['Read', 'Grep', 'Bash'], // prose above only claims Read, Grep -- Bash missing
    baseModel: 'fable',
    escalatedModel: null,
    // Derives 'good_field' (consumed) and 'orphan_field' (never referenced by the file) -- and
    // does NOT derive 'underivable_field', which the header declares.
    derivedKeys: ['good_field', 'orphan_field'],
    readmeRow: null, // deliberately absent -- the fifth divergence
  };

  const { offenders, placeholdersChecked, proseChecked } = evaluateContract(contract);

  assert.equal(placeholdersChecked, 2);
  assert.equal(proseChecked, 1);
  assert.equal(offenders.length, 5, `expected exactly 5 named divergences, got:\n  ${offenders.join('\n  ')}`);
  assert.ok(offenders.some((o) => o.includes('underivable_field')), 'missing the underivable-placeholder offender');
  assert.ok(offenders.some((o) => o.includes('orphan_field')), 'missing the unused-derived-value offender');
  assert.ok(offenders.some((o) => o.includes('stray_field')), 'missing the stray-body-reference offender');
  assert.ok(offenders.some((o) => o.includes('Bash')), 'missing the prose-tool-grant-mismatch offender');
  assert.ok(offenders.some((o) => o.includes('no matching README row found')), 'missing the README-row offender');
});

test('evaluateContract: a fully consistent synthetic contract is clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-contract-fixture-'));
  const promptFile = writeTempPrompt(
    dir,
    'fixture-clean.md',
    [
      '<!--',
      '  Placeholders: {{a_field}} {{b_field}}',
      '-->',
      '',
      '# FIXTURE CLEAN',
      '',
      'You hold `Read, Grep` and no more.',
      '',
      'payload: {{a_field}} {{b_field}}',
    ].join('\n')
  );

  const row = '| FIXTURE_STEP | `fixture-clean.md` | Fable 5 | high | `Read, Grep` |';
  const contract = {
    step: 'FIXTURE_STEP',
    promptFile,
    allowedTools: ['Read', 'Grep'],
    baseModel: 'fable',
    escalatedModel: null,
    derivedKeys: ['a_field', 'b_field'],
    readmeRow: row,
  };

  const { offenders } = evaluateContract(contract);
  assert.deepEqual(offenders, []);
});

test('objectLiteralKeys: reads both `key: value` and shorthand `key` properties, matching intake.js\'s own literals', () => {
  const keys = objectLiteralKeys("{ request_text: requestText, product_repo: productRepo, today, }");
  assert.deepEqual(keys, ['request_text', 'product_repo', 'today']);
});

test('objectLiteralKeys: throws (loudly, not silently) on a shape it does not recognize', () => {
  assert.throws(() => objectLiteralKeys('{ ...spreadIn }'), /unrecognized object-literal segment/);
});

module.exports = {
  underivablePlaceholders,
  unusedDerivedValues,
  undeclaredBodyReferences,
  parseProseToolGrant,
  extractProseToolGrant,
  proseToolGrantMismatch,
  readmeRowProblems,
  objectLiteralKeys,
  evaluateContract,
  ALL_CONTRACTS,
};
