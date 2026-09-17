'use strict';
// Unit tests for orchestrator/steps/sdk-call.js's buildQueryOptions (card #239 chantier, action
// A3). This file never spawns the real `claude` CLI -- test 3 spawns a real `node` process
// running a throwaway fixture script that only dumps its own argv, never a live agent (see that
// test's own comment for why this is the one place in the file that crosses a process boundary).

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
