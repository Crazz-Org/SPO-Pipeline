'use strict';
// Unit tests for orchestrator/steps/sdk-call.js's buildQueryOptions (card #239 chantier, action
// A3). This file never spawns the real `claude` CLI -- test 3, and action A8's own canUseTool-
// shadowing probes further down, spawn a real `node` process running a throwaway fixture script
// that only dumps its own argv or exits immediately, never a live agent (see each test's own
// comment for why crossing a process boundary is still hermetic there).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp } = require('./helpers');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and why this require has to land
// before the orchestrator require(s) below. It patches spawnSync only (not the async spawn()
// query() itself uses for test 3 below) -- see that module's own "scope: spawnSync only" comment.
//
// F8 (Opus verifier, killswitch check, fix pass; UPDATED by action A5b, the cutover this note
// used to describe as future work): the killswitch's real hook, `options.spawnClaudeCodeProcess`
// (never a `child_process.spawn` patch -- patching `spawn` cannot reliably intercept the SDK's own
// ESM-linked import of it, and would break dispatcher.js's three legitimate spawn call sites
// besides), is now WIRED by `buildQueryOptions` itself, unconditionally, for every call this
// module builds options for -- not merely a future hook A5 would add. That means this file's own
// test 3 below (the one real `query()` spawn in this file, a throwaway `node` fixture that dumps
// argv and exits, never `claude`) now ALSO passes through that same check, and this file's own
// top-of-file `require('./no-real-spawn')` arms SPO_NO_REAL_SPAWN process-wide (see that require's
// own comment) -- so test 3 opts back out explicitly, via `isNoRealSpawnEnabled: () => false` in
// its own deps, rather than being silently blocked. See that test's own comment for why this is
// safe (the fixture is not `claude`, and the override is deps-scoped, not an env mutation that
// could leak into a sibling test).
require('./no-real-spawn');

const {
  buildQueryOptions,
  normalizeAllowedTools,
  buildEnv,
  SETTING_SOURCES,
  ANTHROPIC_ENV_KEYS_TO_STRIP,
  SDK_ABORT_KILL_DELAY_MS,
  SDK_ABORT_SIGKILL_ESCALATION_MS,
  OauthTokenUnreadableError,
  ClaudeExecutableNotFoundError,
  JsonSchemaParseError,
} = require('../orchestrator/steps/sdk-call');
const { resolveStepContract } = require('../orchestrator/step-contracts');
const { loadQuery } = require('../orchestrator/sdk');

const FAKE_EXECUTABLE_PATH = '/fake/bin/claude'; // never resolved for real -- always injected

function fakeResolver(returnValue) {
  return () => returnValue;
}

// Splits a flat argv array (as dumped by test 3's real `query()` fixture, below) into a map of
// flag -> value, so that test can read the SDK's own real argv output back generically instead of
// hand-parsing a positional array.
function argvFlagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

// ---- test 1: contract parity, table-driven over the five real step contracts -------------------
//
// Derives its expectations from resolveStepContract's own output (the ground truth every real
// `kind: "card"` call resolves against, steps/llm.js's runLlm) and checks buildQueryOptions's
// `options` directly against it -- so a future change to any step's model/effort/tools/schema is
// caught here without this file needing an edit.
//
// Action A5b (card #239 chantier, the cutover): this test used to ALSO cross-check against
// buildArgv's argv (the old spawnSync transport, kept alive purely so this test could compare the
// two). buildArgv is deleted -- there is only one transport now, so there is nothing left to cross
// -check against; this test lost that half of its own value the moment the thing it was comparing
// against stopped existing, not because this action weakened it. What remains (the assertions
// against `contract` directly) is the SAME rigor the old test always had on that half.
const REAL_STEPS = ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE', 'CITATION_VERIFIER'];

for (const step of REAL_STEPS) {
  test(`buildQueryOptions: ${step} carries model/effort/tools/permissionMode/schema/budget unchanged from its resolved contract`, () => {
    const contract = resolveStepContract(step, {});
    const opts = {
      step,
      model: contract.model,
      effort: contract.effort,
      allowedTools: contract.allowedTools,
      permissionMode: contract.permissionMode,
      maxBudgetUsd: contract.maxBudgetUsd,
      jsonSchema: contract.jsonSchema,
      promptText: `test prompt for ${step}`,
      cwd: '/tmp',
      account: null,
    };

    const { options } = buildQueryOptions(opts, { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) });

    // model / effort / permissionMode: every one of these five contracts sets all three, so
    // asserting equality (not just "when truthy") is a real assertion, not a vacuous one.
    assert.equal(options.model, contract.model);
    assert.equal(options.effort, contract.effort);
    assert.equal(options.permissionMode, contract.permissionMode);

    // allowedTools: the SDK wants an array (comma-joined internally, see this file's own header
    // measurement) -- step-contracts.js's own contract already carries one.
    assert.deepEqual(options.allowedTools, contract.allowedTools);

    // jsonSchema -> outputFormat.schema: every one of these five contracts declares a jsonSchema
    // object (resolveStepContract always builds one, even when `properties` is undefined -- see
    // step-contracts.js's own `jsonSchema: {type: 'object', required: ..., ...}`).
    assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: contract.jsonSchema });

    // maxBudgetUsd: none of the five real contracts set one (resolveStepContract's own comment:
    // "No $ cap ... no production path sets this any more") -- so the key must be OMITTED from
    // options, not merely falsy. Asserted structurally (typeof, 'in') rather than assuming the
    // value, so this still holds if that ever changes for one step.
    assert.equal(typeof contract.maxBudgetUsd, 'undefined');
    assert.equal('maxBudgetUsd' in options, false);
  });
}

// ---- action A8 (card #239 chantier, "per-step tool and permission policy in code") -------------
//
// A8's brief asked whether `options.canUseTool` -- the SDK's own permission-decision callback --
// is the mechanism that closes the card, or whether A3 above already closed it. RULING, MEASURED
// (this action, no real spawn -- see the shadowing probe further down for the reproduction):
// `canUseTool` would be COMPLETELY SHADOWED for every one of today's real per-step tool policies,
// and re-verification (this fix pass) found the callback is dead for a SECOND, independent reason
// on top of the first -- both are recorded in full, with their own measurements, in
// doc/accepted-gaps.md entry 16 (read that entry for the ruling's narrative; this comment only
// orients the tests below):
//
//   1. `step-contracts.js`'s STEP_CONTRACTS and `intake.js`'s three inline call sites
//      (draftCard/reviewCard/triageBugReport -- EIGHT in-code tool policies total, not five; see
//      ALL_POLICIES below) declare every `allowedTools` entry as a bare name. The vendored SDK's
//      own diagnostic for this (`process.emitWarning(..., {code:
//      'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'})`, `vendor/claude-agent-sdk/sdk.mjs`'s `RGe`/`n9`
//      functions) fires for every one of them.
//   2. `.claude/settings.json` -- installed as the USER layer of every pool account regardless of
//      which of the eight policies above is rescoped -- carries its OWN bare allows for `Read`,
//      `Grep`, `Glob`, `Edit`, `Write` (MEASURED: `.claude/settings.json`'s `permissions.allow`
//      has 98 entries, of which exactly those five tool names plus one MCP name are bare; the
//      other 92 are scoped `Bash(...)`; all 14 `deny` entries are also scoped). The SDK's own
//      warning text says this in so many words -- "Allow rules from settings files can also
//      shadow the callback but are not visible here" -- so rescoping those five tool names inside
//      STEP_CONTRACTS/intake.js would NOT unshadow them; the settings file would keep shadowing on
//      its own. `Bash` is the only tool in every one of the eight policies (all but
//      CITATION_VERIFIER's) that is NOT bare-allowed by settings.json today, so it is the only one
//      rescoping could actually affect -- and doing that is the DECISION doc/accepted-gaps.md
//      entry 16 hands to the maintainer, not something this test file asserts either way.
//
// So wiring `canUseTool` today would add a callback the real pipeline never actually calls for
// ANY declared tool call, on either of the two independent reasons above -- the "callback added
// but never exercised" anti-pattern this action's own brief explicitly forbade.
//
// What DOES satisfy the card's own Done means ("per-step tool and permission policy is expressed
// in code and covered by the suite") is what A3 already built for STEP_CONTRACTS's five steps:
// `allowedTools`/`permissionMode` live in code and test 1 above already checks every step's
// `options.allowedTools`/`options.permissionMode` against its contract, table-driven. The
// policy-audit tests immediately below are this action's actual addition on top of that: they
// name the SECURITY PROPERTIES the table-driven equality check leaves implicit, they extend
// coverage to the three intake.js policies A3 never touched (M15, verifier fix pass -- the card's
// clause covers ALL of this repo's in-code tool policy, and intake.js's three were uncovered by
// anything except the doc-parity sweep until this fix pass), and the shadowing probes further down
// are the measurement backing the ruling above, not a policy check of their own.
//
// F7 (verifier fix pass): every shadow-probe test below is written to PASS TODAY and FAIL the
// day any of these eight policies ever gains a scoped `allowedTools` entry (the SDK's own
// shadowing rule stops applying to a scoped entry -- see the "omits a SCOPED allowedTools entry"
// test further down). That is not a bug to fix if it happens: it is this suite correctly
// reporting that the ruling's premise changed and needs re-reading, not evidence the SDK or this
// file regressed. Read a red test here as "someone rescoped a tool, go re-read
// doc/accepted-gaps.md entry 16", never as "revert whatever caused this".

// M15 (verifier fix pass): intake.js builds its three LLM-step option objects inline
// (draftCard/reviewCard/triageBugReport) -- there is no callable accessor for them the way
// step-contracts.js's resolveStepContract is one for STEP_CONTRACTS, so this reads the file's
// ACTUAL source text rather than hand-copying the arrays into this test file (a hand copy would
// just be a second place for the same drift to hide from -- the exact failure mode
// test/doc-constant-sweep.test.js exists to catch for prose, applied here to test fixtures
// instead). Anchored on each call site's own `step: '<LABEL>'` literal, unique per site.
const INTAKE_JS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'intake.js'), 'utf8');

// `source` defaults to the real file (every production call site below relies on that default);
// the two boundary tests just below this function override it with a synthetic snippet so they
// can probe the trailing-comma/spread distinction without needing intake.js itself to be edited.
function extractIntakeStepPolicy(stepLabel, source = INTAKE_JS_SOURCE) {
  const anchor = `step: '${stepLabel}'`;
  const anchorIdx = source.indexOf(anchor);
  assert.notEqual(anchorIdx, -1, `orchestrator/intake.js: could not find ${anchor}`);
  const window = source.slice(anchorIdx, anchorIdx + 400);
  const allowedToolsMatch = window.match(/allowedTools:\s*(\[[^\]]*\])/);
  const permissionModeMatch = window.match(/permissionMode:\s*'([^']*)'/);
  assert.ok(allowedToolsMatch, `orchestrator/intake.js: no allowedTools found near ${anchor}`);
  assert.ok(permissionModeMatch, `orchestrator/intake.js: no permissionMode found near ${anchor}`);
  // Tolerate exactly ONE reformatting variant -- a trailing comma before the closing bracket
  // (valid JS array-literal syntax, invalid JSON) -- and nothing more permissive. MEASURED: a
  // pure reformat with values unchanged (`['Read', 'Grep', 'Glob', 'Bash',]`) throws
  // `SyntaxError: Unexpected token ']'` from a bare JSON.parse; stripping only `,\s*]$` fixes
  // that one case and leaves a computed entry -- `[...BASE_TOOLS, 'Bash']`, which this static
  // regex-and-parse extraction has no way to evaluate -- throwing exactly as loudly as before
  // (`Unexpected token '.'`). A quiet catch-and-skip here would be the vacuous pass this whole
  // audit exists to avoid: the policy genuinely cannot be read in that shape, so this must fail,
  // not silently approve.
  const jsonLiteral = allowedToolsMatch[1].replace(/'/g, '"').replace(/,\s*\]$/, ']');
  return {
    allowedTools: JSON.parse(jsonLiteral),
    permissionMode: permissionModeMatch[1],
  };
}

test('extractIntakeStepPolicy: tolerates a single trailing comma before the closing bracket -- a pure reformat, values unchanged, must not be mistaken for a policy change', () => {
  const snippet = "step: 'DRAFT_CARD',\n    allowedTools: ['Read', 'Grep', 'Glob', 'Bash',],\n    permissionMode: 'plan',";
  const result = extractIntakeStepPolicy('DRAFT_CARD', snippet);
  assert.deepEqual(result, { allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], permissionMode: 'plan' });
});

test('extractIntakeStepPolicy: a trailing comma PLUS an added tool still surfaces the added tool -- the tolerance is for formatting only, never for the policy content', () => {
  const snippet = "step: 'DRAFT_CARD',\n    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'NotebookEdit',],\n    permissionMode: 'plan',";
  const result = extractIntakeStepPolicy('DRAFT_CARD', snippet);
  assert.deepEqual(result.allowedTools, ['Read', 'Grep', 'Glob', 'Bash', 'NotebookEdit']);
});

test('extractIntakeStepPolicy: a computed allowedTools entry (spread) still throws loudly -- a static regex-and-parse extraction cannot evaluate it, and must not silently approve what it cannot read', () => {
  const snippet = "step: 'DRAFT_CARD',\n    allowedTools: [...BASE_TOOLS, 'Bash'],\n    permissionMode: 'plan',";
  assert.throws(() => extractIntakeStepPolicy('DRAFT_CARD', snippet), /Unexpected token/);
});

// The EIGHT in-code tool policies this repo actually has, audited uniformly: STEP_CONTRACTS's
// five (via resolveStepContract, the real accessor) plus intake.js's three (via the source-text
// extraction above, since intake.js exposes no accessor). `.contract()` is a function, not a
// cached value, so each test call re-reads the live source/table rather than a snapshot taken at
// module load.
const ALL_POLICIES = [
  ...REAL_STEPS.map((step) => ({ name: step, contract: () => resolveStepContract(step, {}) })),
  { name: 'intake.draftCard', contract: () => extractIntakeStepPolicy('DRAFT_CARD') },
  { name: 'intake.reviewCard', contract: () => extractIntakeStepPolicy('REVIEW_CARD') },
  { name: 'intake.triageBugReport', contract: () => extractIntakeStepPolicy('TRIAGE_BUG_REPORT') },
];

test('.claude/settings.json: the bare-allow shape this ruling depends on is still what was measured (Read/Grep/Glob/Edit/Write bare, every Bash rule scoped, no bare deny)', () => {
  // Not a claim about STEP_CONTRACTS/intake.js -- a claim about the OTHER policy layer
  // (`.claude/settings.json`) that the comment block above says would keep shadowing `canUseTool`
  // even if a maintainer rescoped one of these five tool names inside this repo's own code. If
  // this ever changes, the "rescoping wouldn't help" half of the ruling needs re-reading before
  // anyone acts on it -- this test exists to make that loud instead of silent.
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8'));
  const allow = settings.permissions.allow;
  const deny = settings.permissions.deny;
  const bareAllow = allow.filter((rule) => !rule.includes('('));
  const bareDeny = deny.filter((rule) => !rule.includes('('));
  assert.deepEqual(new Set(bareAllow), new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'mcp__ccd_session_mgmt__set_session_title']));
  assert.deepEqual(bareDeny, []);
  assert.equal(allow.includes('Bash'), false, 'settings.json must not bare-allow Bash -- see the sibling card this entry points at');
});

// LEGACY_TOOL_ALIASES: MEASURED against the installed CLI binary (2.1.274,
// `~/.local/share/claude/versions/2.1.274`, `strings -a` + direct byte search, not the vendored
// sdk.mjs -- see doc/accepted-gaps.md entry 16's own measurement) -- a legacy-name alias table
// (`var i={Task:"Agent",...}`) canonicalizes the wire name `Task` to `Agent` before any permission
// check runs. A guard that only checks for the literal string `'Task'` (this test's first draft)
// is evaded by the CLI's own canonical spelling -- checked here.
const LEGACY_TOOL_ALIASES = { Task: 'Agent' };

test('ALL_POLICIES: no policy declares "Task" OR its CLI-canonical alias "Agent" in allowedTools -- PLAN\'s own measured subagent gap stays undeclared, in EITHER spelling, never silently promoted to a grant', () => {
  for (const policy of ALL_POLICIES) {
    const contract = policy.contract();
    assert.equal(contract.allowedTools.includes('Task'), false, `${policy.name} must not declare Task`);
    for (const canonical of Object.values(LEGACY_TOOL_ALIASES)) {
      assert.equal(contract.allowedTools.includes(canonical), false, `${policy.name} must not declare ${canonical} (Task's CLI-canonical name)`);
    }
  }
});

// CLI_WRITE_TOOLS: the CLI's OWN definition of "this is a write tool", not this test file's guess
// -- MEASURED against the installed binary: `var Kyr=["Write","Edit","MultiEdit","NotebookEdit"],
// fAt=new Set(Kyr);function uWe(e,n){...return fAt.has(qc(e))||...}` (`uWe`, consulted from the
// CLI's own PostToolUse/PostToolUseFailure hook matching). An earlier draft of this test used
// `['Edit','Write']`, missing `MultiEdit`/`NotebookEdit` from the CLI's own set.
const CLI_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

test('ALL_POLICIES: IMPLEMENT is the only policy whose allowedTools grants one of the CLI\'s own dedicated write tools (Write/Edit/MultiEdit/NotebookEdit) -- NOT a general "can this policy write" check', () => {
  // HONEST SCOPE, stated because a broader test NAME would be false regardless of any mutation:
  // every OTHER policy here (PLAN, DIAGNOSE, VALIDATE, and all three intake.js steps) also
  // declares bare `Bash`, which can write via redirection or a `git`/`gh` mutating command just as
  // well as a dedicated tool can -- a whitelist over TOOL NAMES cannot characterize what an
  // arbitrary Bash command does, and this test does not claim otherwise. What it DOES claim,
  // narrowly and truthfully: none of the seven non-IMPLEMENT policies grants a dedicated write
  // tool ON TOP OF whatever Bash already lets through.
  for (const policy of ALL_POLICIES) {
    const contract = policy.contract();
    const grantsWrite = contract.allowedTools.some((tool) => CLI_WRITE_TOOLS.includes(tool));
    assert.equal(grantsWrite, policy.name === 'IMPLEMENT', `${policy.name}'s allowedTools grants a dedicated write tool: ${grantsWrite}`);
  }
});

test('ALL_POLICIES: permissionMode matches this build\'s own chosen per-step default exactly -- never "bypassPermissions"', () => {
  // NOT "documented" -- step-contracts.js's own header is explicit that permissionMode is NOT
  // sourced from state-machine-spec.md or prompts/README.md; it is "chosen so a step whose
  // contract is 'read-only' never needs a human approval prompt it cannot answer (headless -p),
  // and the one step with edit tools (IMPLEMENT) auto-accepts them" -- this build's OWN inferred
  // default, stated as such rather than attributed to a doc that never fixed a value. A
  // 'bypassPermissions' mode would skip `.claude/settings.json` (the single source of policy,
  // installed on every pool account) entirely, not merely relax it -- CLAUDE.md § Permissions:
  // DIAGNOSE/VALIDATE/CITATION_VERIFIER run headless with no human, so "whatever
  // `.claude/settings.json` doesn't allow is refused, not queued", never auto-approved instead.
  const EXPECTED = {
    PLAN: 'plan',
    IMPLEMENT: 'acceptEdits',
    DIAGNOSE: 'default',
    CITATION_VERIFIER: 'default',
    VALIDATE: 'default',
    'intake.draftCard': 'plan',
    'intake.reviewCard': 'default',
    'intake.triageBugReport': 'plan',
  };
  for (const policy of ALL_POLICIES) {
    const contract = policy.contract();
    assert.equal(contract.permissionMode, EXPECTED[policy.name]);
    assert.notEqual(contract.permissionMode, 'bypassPermissions');
  }
});

// ---- the canUseTool-shadowing probe itself, hermetic, one real query() spawn per step ----------
//
// Same fixture shape as test 3 further down (a throwaway `node` script, never `claude`, that
// exits immediately with no output) -- proves the SHADOWED claim above against the REAL vendored
// SDK rather than resting it on a reading of the minified source. `process.emitWarning` is a
// process-wide EventEmitter, so each probe installs and removes its own listener rather than
// sharing one across tests (node:test runs this file's tests in one process, sequentially).
function fixtureThatExitsCleanly(tmpDir) {
  const fixturePath = path.join(tmpDir, 'fake-claude-exit0.js');
  fs.writeFileSync(fixturePath, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  return fixturePath;
}

async function captureShadowWarnings(opts) {
  const tmpDir = mkTmp('sdk-call-canusetool-probe-');
  const fixturePath = fixtureThatExitsCleanly(tmpDir);
  const warnings = [];
  const onWarning = (warning) => {
    if (warning && warning.code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') warnings.push(warning.message);
  };
  process.on('warning', onWarning);
  try {
    const { prompt, options } = buildQueryOptions(
      { promptText: 'probe', cwd: tmpDir, account: null, ...opts.contractFields },
      { resolveClaudeCodeExecutable: fakeResolver(fixturePath), isNoRealSpawnEnabled: () => false }
    );
    if (opts.canUseTool) options.canUseTool = opts.canUseTool;
    const query = await loadQuery();
    const q = query({ prompt, options });
    // eslint-disable-next-line no-unused-vars
    for await (const _msg of q) {
      // the fixture exits(0) with no stdout -- nothing to consume
    }
    // n9()'s emitWarning call happens synchronously during query()'s own construction, well
    // before this loop even starts, but yield once so a test runner that defers 'warning'
    // dispatch to the next tick (Node does, per its own docs) has delivered it before we check.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', onWarning);
  }
  return warnings;
}

for (const policy of ALL_POLICIES) {
  test(`canUseTool would be shadowed for ${policy.name}'s exact declared allowedTools (MEASURED, not assumed)`, async () => {
    const contract = policy.contract();
    const warnings = await captureShadowWarnings({
      contractFields: { allowedTools: contract.allowedTools, permissionMode: contract.permissionMode },
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    });
    assert.equal(warnings.length, 1, `expected exactly one shadow warning for ${policy.name}, got ${JSON.stringify(warnings)}`);
    for (const tool of contract.allowedTools) {
      assert.ok(
        warnings[0].includes(tool),
        `shadow warning for ${policy.name} must name ${tool}: ${warnings[0]}`
      );
    }
  });
}

test('canUseTool shadow warning does NOT fire when no canUseTool callback is supplied (sanity: the warning is caused by the callback, not by allowedTools alone)', async () => {
  const contract = resolveStepContract('PLAN', {});
  const warnings = await captureShadowWarnings({
    contractFields: { allowedTools: contract.allowedTools, permissionMode: contract.permissionMode },
    canUseTool: undefined,
  });
  assert.deepEqual(warnings, []);
});

test('canUseTool shadow warning omits a SCOPED allowedTools entry (e.g. "Bash(git *)") -- proves the probe discriminates bare vs. scoped, not just "always warns"', async () => {
  const warnings = await captureShadowWarnings({
    contractFields: { allowedTools: ['Read', 'Bash(git *)'], permissionMode: 'default' },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('Read'), `expected Read to be named shadowed: ${warnings[0]}`);
  assert.ok(!warnings[0].includes('Bash(git *)'), `scoped entry must not be named shadowed: ${warnings[0]}`);
});

// ---- test: action A5b's own additions to buildQueryOptions -- abortController and
// spawnClaudeCodeProcess/getSpawnedProcess -----------------------------------------------------
test('buildQueryOptions: sets a fresh, real AbortController on options.abortController, one per call', () => {
  const first = buildQueryOptions(
    { promptText: 'a', cwd: '/tmp' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  const second = buildQueryOptions(
    { promptText: 'b', cwd: '/tmp' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.ok(first.options.abortController instanceof AbortController);
  assert.ok(second.options.abortController instanceof AbortController);
  assert.notEqual(first.options.abortController, second.options.abortController, 'each call must get its own controller, never a shared one');
  assert.equal(first.options.abortController.signal.aborted, false);
});

test('buildQueryOptions: sets options.spawnClaudeCodeProcess to a function, and returns a getSpawnedProcess accessor', () => {
  const { options, getSpawnedProcess } = buildQueryOptions(
    { promptText: 'a', cwd: '/tmp' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.equal(typeof options.spawnClaudeCodeProcess, 'function');
  assert.equal(typeof getSpawnedProcess, 'function');
  // Nothing has called query() yet in this test -- the hook has never fired, so there is no
  // captured process to read back.
  assert.equal(getSpawnedProcess(), undefined);
});

test('buildQueryOptions: spawnClaudeCodeProcess throws ENOREALSPAWN when SPO_NO_REAL_SPAWN is armed, and spawns nothing', () => {
  const { options } = buildQueryOptions(
    { promptText: 'a', cwd: '/tmp' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH), isNoRealSpawnEnabled: () => true }
  );
  assert.throws(
    () => options.spawnClaudeCodeProcess({ command: 'node', args: [], cwd: '/tmp', env: {} }),
    (err) => err.code === 'ENOREALSPAWN'
  );
});

test('buildQueryOptions: spawnClaudeCodeProcess reads the killswitch fresh at CALL time, not at buildQueryOptions\'s own call time', () => {
  // The armed/unarmed decision must not be baked in when `options` is built -- a deadline race
  // could arm the var well after this function returned (see sdk-call.js's own header on this
  // hook). Simulated here with a stateful injected isNoRealSpawnEnabled rather than mutating
  // process.env, so this test can never leak a real env change into a sibling test.
  let armed = false;
  const { options } = buildQueryOptions(
    { promptText: 'a', cwd: '/tmp' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH), isNoRealSpawnEnabled: () => armed }
  );
  armed = true;
  assert.throws(
    () => options.spawnClaudeCodeProcess({ command: 'node', args: [], cwd: '/tmp', env: {} }),
    (err) => err.code === 'ENOREALSPAWN'
  );
});

// ---- test: the SDK's own kill-escalation constants stay pinned to the vendored source ----------
test('SDK_ABORT_KILL_DELAY_MS and SDK_ABORT_SIGKILL_ESCALATION_MS are still the literals the vendored SDK declares -- a re-vendor that changes either must fail this, not silently invalidate the grace-window derivation', () => {
  const vendoredSrc = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'claude-agent-sdk', 'sdk.mjs'), 'utf8');
  assert.match(
    vendoredSrc,
    new RegExp(`q1e=${SDK_ABORT_KILL_DELAY_MS}\\b`),
    'the vendored source no longer declares the 2000ms outer delay this constant was measured from -- re-derive ABORT_CONFIRM_GRACE_MS from the new source before trusting it'
  );
  // F1 (Opus verifier, fix pass): `new RegExp(\`,${SDK_ABORT_SIGKILL_ESCALATION_MS},\`)` (a bare
  // `,5000,`) is UNANCHORED -- the vendored source declares TWO separate `,5000,` sites (win32's
  // `setTimeout((l,u)=>{...},5000,a,c).unref()` and the POSIX branch below), so this pin could go
  // on passing even if the ONE branch Linux actually takes (the POSIX SIGTERM->SIGKILL escalation
  // this file's own ABORT_CONFIRM_GRACE_MS is derived from) changed its literal, as long as the
  // OTHER, platform-irrelevant site still said 5000. MEASURED: mutating only the POSIX literal
  // (5000 -> 3000, in a /tmp clone of the vendored file, never this worktree) left the old pin
  // GREEN. Anchored to the POSIX branch's own exact surrounding code instead -- the SIGTERM kill
  // immediately followed by the SIGKILL-escalation setTimeout literal -- so a change to either
  // `,5000,` site this constant does NOT derive from can no longer masquerade as the one it does.
  assert.match(
    vendoredSrc,
    new RegExp(`kill\\("SIGTERM"\\),setTimeout\\(\\(l\\)=>\\{if\\(l\\.exitCode===null\\)l\\.kill\\("SIGKILL"\\)\\},${SDK_ABORT_SIGKILL_ESCALATION_MS},`),
    'the vendored source no longer declares the 5000ms SIGTERM->SIGKILL escalation this constant was measured from -- re-derive ABORT_CONFIRM_GRACE_MS from the new source before trusting it'
  );
});

// ---- test: normalizeAllowedTools's own two supported shapes ------------------------------------

// F4 (Opus verifier, fix pass): this test used to assert `normalizeAllowedTools(tools) === tools`
// as a deliberate, positive property ("same reference, not just deepEqual") -- true of
// normalizeAllowedTools in isolation (it still returns its array argument as-is; see its own
// header comment), but pinning that sameness here read as endorsing it, and the real defect
// (buildQueryOptions storing that SAME reference on `options.allowedTools`, aliasing
// step-contracts.js's own shared, process-lifetime array) was reachable from exactly this
// property. Flipped to deepEqual-only: this test now pins the SHAPE normalizeAllowedTools
// produces, not its object identity -- identity is no longer this function's concern to prove
// safe. The actual non-aliasing guarantee belongs at the level where it matters and is pinned
// below, in the buildQueryOptions-level regression test.
test('normalizeAllowedTools: an array passes through with the same VALUES (identity is not pinned here -- see the buildQueryOptions-level test below)', () => {
  const tools = ['Read', 'Grep', 'Bash'];
  assert.deepEqual(normalizeAllowedTools(tools), tools);
});

// F4's actual regression test, at the level the aliasing bug was reachable from: buildQueryOptions
// must copy step-contracts.js's allowedTools array before storing it on `options`, never alias it.
// Demonstrated the way the verifier's finding described the blast radius -- mutate one call's
// result and confirm a LATER, independent call for the same step is unaffected, proving
// `options.allowedTools` is not the same array STEP_CONTRACTS hands out to every caller for the
// rest of the process.
test('buildQueryOptions: does not alias step-contracts.js\'s own allowedTools array -- mutating one call\'s options.allowedTools must not affect the next', () => {
  const contract = resolveStepContract('PLAN', {});
  const originalToolsSnapshot = [...contract.allowedTools];

  const first = buildQueryOptions(
    { promptText: 'first call', cwd: '/tmp', allowedTools: contract.allowedTools },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.notEqual(first.options.allowedTools, contract.allowedTools, 'options.allowedTools must be a fresh copy, not the contract\'s own array');
  first.options.allowedTools.push('Write'); // simulates a downstream mutation

  // step-contracts.js's own array must be untouched by the mutation above.
  assert.deepEqual(contract.allowedTools, originalToolsSnapshot);

  const second = buildQueryOptions(
    { promptText: 'second call', cwd: '/tmp', allowedTools: contract.allowedTools },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.deepEqual(second.options.allowedTools, originalToolsSnapshot, "a later call's options must not inherit the earlier call's mutation");
});

// R1 (Opus verifier, second fix pass): the SAME aliasing class F4 fixed for allowedTools, found by
// a wider inventory of every array/object reaching `options`. This one is NOT latent: `required`
// IS the step's declared output contract (steps/llm.js's runLlm checks a reply against exactly
// this array), and step-contracts.js reuses the SAME `.required` array across every call for a
// step -- never rebuilt, never frozen -- even though it rebuilds the outer `jsonSchema` object and
// `.properties` fresh each time. Before this fix, 24/24 passed with `outputFormat.schema` aliased
// directly onto opts.jsonSchema; this test is what pins the deep copy so it cannot regress silently.
test('buildQueryOptions: does not alias step-contracts.js\'s own jsonSchema object -- mutating one call\'s outputFormat.schema.required must not affect the next (R1)', () => {
  const contract = resolveStepContract('PLAN', {});
  const originalRequiredSnapshot = [...contract.jsonSchema.required];

  const first = buildQueryOptions(
    { promptText: 'first call', cwd: '/tmp', jsonSchema: contract.jsonSchema },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.notEqual(
    first.options.outputFormat.schema,
    contract.jsonSchema,
    'outputFormat.schema must be a fresh copy, not the contract\'s own object'
  );
  assert.notEqual(
    first.options.outputFormat.schema.required,
    contract.jsonSchema.required,
    'outputFormat.schema.required must be a fresh array, not the contract\'s own'
  );
  first.options.outputFormat.schema.required.push('POISON'); // simulates a downstream mutation

  // step-contracts.js's own array must be untouched by the mutation above.
  assert.deepEqual(contract.jsonSchema.required, originalRequiredSnapshot);

  const second = buildQueryOptions(
    { promptText: 'second call', cwd: '/tmp', jsonSchema: contract.jsonSchema },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.deepEqual(
    second.options.outputFormat.schema.required,
    originalRequiredSnapshot,
    "a later call's options must not inherit the earlier call's mutation"
  );
});

// Optional (Opus verifier, second fix pass): the maxBudgetUsd typeof guard matches buildArgv's own
// (llm.js: `typeof opts.maxBudgetUsd === 'number'`), but nothing pinned it here -- a string value
// surviving into `options.maxBudgetUsd` (the SDK would then push it through unchanged, since
// nothing in this file coerces it) was a real, if cheap, test gap rather than a known defect.
test('buildQueryOptions: maxBudgetUsd is only accepted when it is a number -- a string is not silently passed through', () => {
  const { options } = buildQueryOptions(
    { promptText: 'hi', cwd: '/tmp', maxBudgetUsd: '0.5' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.equal('maxBudgetUsd' in options, false);
});

test('normalizeAllowedTools: a space-separated string (the legacy override shape, orchestrator/README.md:247) splits on whitespace', () => {
  assert.deepEqual(normalizeAllowedTools('Read Grep'), ['Read', 'Grep']);
  assert.deepEqual(normalizeAllowedTools('Read   Grep\tBash'), ['Read', 'Grep', 'Bash']);
});

test('normalizeAllowedTools: absent/empty returns undefined so buildQueryOptions omits the key entirely', () => {
  assert.equal(normalizeAllowedTools(undefined), undefined);
  assert.equal(normalizeAllowedTools(null), undefined);
  assert.equal(normalizeAllowedTools(''), undefined);
  assert.equal(normalizeAllowedTools('   '), undefined);
});

// ---- test 2: resolved-env assertions ------------------------------------------------------------

test('buildEnv: credential vars present and correct, ambient vars survive, ANTHROPIC_* stripped', () => {
  const tmpDir = mkTmp('sdk-call-env-');
  const tokenFile = path.join(tmpDir, 'oauth-token');
  fs.writeFileSync(tokenFile, 'the-subscription-token\n');

  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'fake-ambient-api-key';
  process.env.ANTHROPIC_AUTH_TOKEN = 'fake-ambient-auth-token';
  try {
    const env = buildEnv({
      account: { name: 'acct-1', configDir: '/tmp/acct-1-config', oauthTokenFile: tokenFile },
    });

    // The two credential vars this pipeline actually needs.
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'the-subscription-token'); // trimmed
    assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/acct-1-config');

    // query()'s env REPLACES the child's environment wholesale (measured against the real
    // vendored SDK -- see sdk-call.js's own header) -- so these three surviving is the whole
    // point of spreading process.env first, not an incidental side effect.
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.DISABLE_AUTOUPDATER, '1');

    // The deliberate departure from today's invokeClaudeReal: never let an ambient API key or
    // auth token silently outrank the pool's subscription credential.
    for (const key of ANTHROPIC_ENV_KEYS_TO_STRIP) {
      assert.equal(key in env, false, `${key} must be stripped from the resolved env`);
    }
    assert.deepEqual([...ANTHROPIC_ENV_KEYS_TO_STRIP].sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].sort());

    // F1 (Opus verifier, fix pass): the two assertions above alone cannot tell "buildEnv strips
    // the keys off its OWN COPY" apart from "buildEnv deletes the keys off process.env itself" --
    // both would leave the returned `env` looking identical. Asserted HERE, inside the try block
    // and BEFORE the `finally` below re-assigns both keys back onto process.env -- that
    // re-assignment is what a prior version of this test relied on unconditionally, which would
    // silently restore process.env even if buildEnv's `delete env[key]` had actually been
    // `delete process.env[key]`, masking exactly this defect. `env !== process.env` pins that the
    // resolved env is a fresh object in the first place (spreading process.env, per buildEnv's own
    // header, always produces one -- but a future refactor that started mutating process.env
    // directly instead of spreading it first would defeat that guarantee silently).
    assert.notEqual(env, process.env);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'fake-ambient-api-key', 'buildEnv must not mutate the real process.env');
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'fake-ambient-auth-token', 'buildEnv must not mutate the real process.env');
  } finally {
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    if (savedAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
  }
});

test('buildEnv: no account, or an account with no oauthTokenFile, still returns a usable env with no throw', () => {
  assert.doesNotThrow(() => buildEnv({}));
  const env = buildEnv({ account: { name: 'no-token', configDir: null } });
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false);
  assert.equal('CLAUDE_CONFIG_DIR' in env, false);
});

// ---- settingSources: pinned unconditionally, never read from opts ------------------------------

test('buildQueryOptions: settingSources is always exactly [user, project, local], regardless of opts', () => {
  const { options } = buildQueryOptions(
    { promptText: 'hi', cwd: '/tmp', settingSources: ['user'] }, // an opts field that does not exist -- must be ignored
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(options.settingSources, SETTING_SOURCES); // same values as the exported constant
  assert.notEqual(options.settingSources, SETTING_SOURCES); // but a fresh array, not the frozen original
});

// ---- test 4: error classes -----------------------------------------------------------------------

test('buildQueryOptions: unreadable oauthTokenFile throws OauthTokenUnreadableError, never a plain step-failure return', () => {
  const tmpDir = mkTmp('sdk-call-bad-oauth-');
  const missingFile = path.join(tmpDir, 'does-not-exist');
  assert.throws(
    () =>
      buildQueryOptions(
        { promptText: 'hi', cwd: '/tmp', account: { name: 'broken-acct', oauthTokenFile: missingFile } },
        { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
      ),
    (err) => err instanceof OauthTokenUnreadableError && err.accountName === 'broken-acct' && /broken-acct/.test(err.message)
  );
});

test('buildQueryOptions: unresolvable claude executable throws ClaudeExecutableNotFoundError', () => {
  assert.throws(
    () => buildQueryOptions({ promptText: 'hi', cwd: '/tmp' }, { resolveClaudeCodeExecutable: fakeResolver(null) }),
    (err) => err instanceof ClaudeExecutableNotFoundError
  );
});

// F2 (Opus verifier, fix pass): the string-jsonSchema parse branch is not a hypothetical shape --
// it is LIVE on the legacy override path (runLlm's `ctx.task.llm.<step>` branch, llm.js:1031
// passes `override.jsonSchema` straight through with no validation), the same path this file's
// allowedTools normalization already accounts for its own string shape (orchestrator/README.md's
// documented `allowedTools: 'Read Grep'` example). Every step-contract test above (test 1) only
// exercises jsonSchema as an OBJECT (what resolveStepContract always builds) -- this is the only
// test in the file that proves the string branch itself actually parses.
test('buildQueryOptions: opts.jsonSchema as a JSON-encoded string parses into outputFormat.schema (legacy override path, llm.js:1031)', () => {
  const schemaObject = { type: 'object', required: ['foo'], properties: { foo: {} } };
  const { options } = buildQueryOptions(
    { promptText: 'hi', cwd: '/tmp', jsonSchema: JSON.stringify(schemaObject) },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: schemaObject });
});

// F3 (Opus verifier, fix pass): a malformed jsonSchema string must fail as a NAMED class (mapped
// by A5 onto a normal step failure, matching today's transport's outcome for the same input --
// see JsonSchemaParseError's own comment), never as a bare, uncaught SyntaxError that would crash
// a worker instead.
test('buildQueryOptions: a malformed jsonSchema string throws JsonSchemaParseError, never a bare SyntaxError', () => {
  assert.throws(
    () =>
      buildQueryOptions(
        { promptText: 'hi', cwd: '/tmp', jsonSchema: '{not valid json' },
        { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
      ),
    (err) => err instanceof JsonSchemaParseError && err.rawJsonSchema === '{not valid json'
  );
  // Distinct from the other two named classes, same posture as the sessionId TypeError check
  // above -- and distinct from a bare SyntaxError too, which is exactly the shape this class
  // exists to replace.
  assert.throws(
    () =>
      buildQueryOptions(
        { promptText: 'hi', cwd: '/tmp', jsonSchema: '{not valid json' },
        { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
      ),
    (err) =>
      !(err instanceof OauthTokenUnreadableError) &&
      !(err instanceof ClaudeExecutableNotFoundError) &&
      err.name === 'JsonSchemaParseError'
  );
});

test('buildQueryOptions: a malformed non-empty sessionId throws a plain TypeError (a programming error, not a step failure)', () => {
  assert.throws(
    () =>
      buildQueryOptions(
        { promptText: 'hi', cwd: '/tmp', sessionId: 'not-a-uuid' },
        { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
      ),
    TypeError
  );
  // Not an OauthTokenUnreadableError / ClaudeExecutableNotFoundError -- distinct failure classes,
  // asserted so a future refactor cannot quietly merge the sessionId check into the other two's
  // catch-and-map treatment (this one must propagate, per this file's own header comment).
  assert.throws(
    () => buildQueryOptions({ promptText: 'hi', cwd: '/tmp', sessionId: 'not-a-uuid' }, {}),
    (err) => !(err instanceof OauthTokenUnreadableError) && !(err instanceof ClaudeExecutableNotFoundError)
  );
});

test('buildQueryOptions: a well-formed UUID-v4 sessionId is accepted as a first-class option, not extraArgs', () => {
  const uuid = '12345678-1234-4123-8123-123456789abc';
  const { options } = buildQueryOptions(
    { promptText: 'hi', cwd: '/tmp', sessionId: uuid },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.equal(options.sessionId, uuid);
  assert.equal('extraArgs' in options, false);
});

test('buildQueryOptions: an absent/empty sessionId omits the option entirely (no key, not an empty string)', () => {
  for (const value of [undefined, null, '']) {
    const { options } = buildQueryOptions(
      { promptText: 'hi', cwd: '/tmp', sessionId: value },
      { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
    );
    assert.equal('sessionId' in options, false);
  }
});

test('buildQueryOptions: pathToClaudeCodeExecutable is always set from the injected resolver', () => {
  const { options } = buildQueryOptions(
    { promptText: 'hi', cwd: '/tmp' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.equal(options.pathToClaudeCodeExecutable, FAKE_EXECUTABLE_PATH);
});

test('buildQueryOptions: reuses resolvePromptText -- same error for a call with neither promptText nor promptFile', () => {
  assert.throws(
    () => buildQueryOptions({ cwd: '/tmp' }, { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }),
    /needs promptText or promptFile/
  );
});

test('buildQueryOptions: cwd passes through unchanged', () => {
  const { options } = buildQueryOptions(
    { promptText: 'hi', cwd: '/some/worktree/path' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.equal(options.cwd, '/some/worktree/path');
});

test('buildQueryOptions: does not set maxTurns -- this action introduces no turn/time policy', () => {
  const { options } = buildQueryOptions(
    { promptText: 'hi', cwd: '/tmp', model: 'opus', effort: 'high' },
    { resolveClaudeCodeExecutable: fakeResolver(FAKE_EXECUTABLE_PATH) }
  );
  assert.equal('maxTurns' in options, false);
});

// ---- test 3: one real argv-level probe against the real vendored SDK ---------------------------
//
// Everything above checks buildQueryOptions's OWN return value. This test is the only place in
// this file (or anywhere in this action) that proves those values actually reach `claude`-shaped
// argv when handed to a REAL `query()` from the vendored SDK -- comma-joined allowedTools,
// --json-schema's exact shape, --session-id, and the pinned --setting-sources all live inside the
// SDK's own (unpublished, minified) argv builder, which nothing in this repo can assert against
// except by running it. It cannot reach a real agent: pathToClaudeCodeExecutable points at a
// throwaway `node` script (never `claude`) that does nothing but dump its own argv to a file and
// exit -- no network call, no API key, no session is ever created. mkTmp() (test/helpers.js) is
// used for both the fixture script and the dump file, per this suite's standing rule that no test
// touches a raw os.tmpdir() path directly (test/*-sweep.test.js enforces it repo-wide).
test('buildQueryOptions: a real query() spawn emits the exact measured argv shape', async () => {
  const tmpDir = mkTmp('sdk-call-argv-probe-');
  const dumpFile = path.join(tmpDir, 'argv-dump.json');
  const fixturePath = path.join(tmpDir, 'fake-claude.js');
  fs.writeFileSync(
    fixturePath,
    [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'fs.writeFileSync(process.env.SDK_CALL_TEST_ARGV_DUMP_FILE, JSON.stringify(process.argv.slice(2)));',
      'process.exit(0);',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );

  const uuid = '87654321-4321-4321-8321-abcdef123456';
  process.env.SDK_CALL_TEST_ARGV_DUMP_FILE = dumpFile;
  let prompt, options;
  try {
    ({ prompt, options } = buildQueryOptions(
      {
        promptText: 'hello from the argv probe',
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'default',
        allowedTools: ['Read', 'Bash'],
        maxBudgetUsd: 0.5,
        sessionId: uuid,
        jsonSchema: { type: 'object', required: ['foo'] },
        cwd: tmpDir,
        account: null,
      },
      // Action A5b wired `options.spawnClaudeCodeProcess` to the SAME killswitch check
      // (no-real-spawn-guard's isEnabled(process.env)) this file's own top-of-file
      // `require('./no-real-spawn')` arms process-wide (see that require's own comment). This
      // test's spawn is the one this file's header already argues is legitimate -- a throwaway
      // `node` fixture that dumps argv and exits, never `claude`, no network call, no session --
      // so it opts out of that check the same explicit way a real production call never would:
      // isNoRealSpawnEnabled is a deps injection point, not an env mutation, so nothing here
      // weakens the killswitch for any other test or any real call.
      { resolveClaudeCodeExecutable: fakeResolver(fixturePath), isNoRealSpawnEnabled: () => false }
    ));

    const query = await loadQuery();
    const q = query({ prompt, options });
    // The fixture exits(0) with no stdout at all, so the async generator simply completes with
    // no messages -- nothing here waits on a reply, only on the child having run and exited.
    // eslint-disable-next-line no-unused-vars
    for await (const _msg of q) {
      // no messages expected from a fixture that only writes a file and exits
    }
  } finally {
    delete process.env.SDK_CALL_TEST_ARGV_DUMP_FILE;
  }

  assert.ok(fs.existsSync(dumpFile), 'the fixture executable must have run and written the dump file');
  const argv = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));

  assert.equal(argvFlagValue(argv, '--model'), 'sonnet');
  assert.equal(argvFlagValue(argv, '--effort'), 'high');
  assert.equal(argvFlagValue(argv, '--permission-mode'), 'default');
  assert.equal(argvFlagValue(argv, '--max-budget-usd'), '0.5');
  assert.equal(argvFlagValue(argv, '--allowedTools'), 'Read,Bash'); // comma-joined, not space-joined
  assert.deepEqual(JSON.parse(argvFlagValue(argv, '--json-schema')), { type: 'object', required: ['foo'] });
  assert.ok(argv.includes(`--setting-sources=user,project,local`), 'settingSources must reach argv as one comma-joined flag');
  assert.ok(argv.includes(`--session-id=${uuid}`), 'sessionId must reach argv as --session-id=<uuid>, not via extraArgs');
  assert.equal(argv.includes('--extraArgs'), false);
});
