'use strict';
// sdk-call.js -- action A3 (card #239 chantier, "Drive LLM steps through the Claude Agent SDK
// instead of spawning `claude -p`"). This module will hold every moving part of the SDK call
// (A4 adds stream consumption, A5 wires invokeClaudeReal to it); THIS action adds exactly one
// exported pure function -- buildQueryOptions -- plus the error classes it can throw.
//
// buildQueryOptions(opts, deps) -> { prompt, options } takes today's invokeClaudeReal opts shape
// (see steps/llm.js's own header for the authoritative field list) and produces the
// `{prompt, options}` argument `sdk.js`'s loadQuery()-resolved `query` function expects. It never
// calls query() itself and never spawns anything -- buildArgv (llm.js) stays the argv builder for
// the CURRENT transport until A5 cuts the real spawn over; this function is its SDK-shaped
// sibling, built and tested against the same five step contracts so the two cannot silently
// diverge before the cutover.
//
// ---- how the mapping below was measured, not assumed ------------------------------------------
//
// Every field mapping in this file was checked against the REAL vendored SDK
// (vendor/claude-agent-sdk/sdk.mjs), not read off its (unpublished, minified, no .d.ts shipped)
// source by inspection alone. Method: a fake `pathToClaudeCodeExecutable` that dumps its own
// `process.argv` to a file, run through a real `query({prompt, options})` call, argv-diffed
// against this file's claims. test/sdk-call-options.test.js's own "argv-level" test (case 3 in
// its own header) is a trimmed, checked-in version of exactly this probe -- this comment records
// what a wider one-off probe (this session, 2026-09-17, deleted after use, not committed) found,
// for the fields the checked-in test does not itself re-derive:
//
//   sdk.query({ prompt: 'hello', options: {
//     pathToClaudeCodeExecutable: '<fake>', model: 'sonnet', effort: 'high',
//     permissionMode: 'default', allowedTools: ['Read','Bash'], maxBudgetUsd: 0.5,
//     sessionId: '<uuid>', settingSources: ['user','project','local'],
//     outputFormat: { type: 'json_schema', schema: { type: 'object', required: ['foo'] } },
//     cwd: '/tmp', env: {...process.env, FOO: 'bar'},
//   }})
//   -> argv: --output-format stream-json --verbose --input-format stream-json
//            --effort high --max-budget-usd 0.5 --model sonnet
//            --json-schema {"type":"object","required":["foo"]}
//            --allowedTools Read,Bash --setting-sources=user,project,local
//            --permission-mode default --session-id=<uuid>
//
// ONE claim in this action's own brief did NOT survive that probe and is corrected here rather
// than carried forward: `sessionId` is a FIRST-CLASS top-level `options.sessionId`, not something
// that has to go through `extraArgs` -- `sdk.mjs` itself reads `this.options.sessionId` and emits
// `--session-id=<uuid>` from it directly (grep `--session-id=` in the vendored file). The
// `extraArgs: {'session-id': ...}` route the brief described would have worked too (`extraArgs`
// is a generic passthrough that stringifies whatever key/value pairs it is given), but it is the
// wrong tool here -- redundant with an option the SDK already exposes -- and is not what this
// file does. See the sessionId branch in buildQueryOptions below.
//
// Two more fields worth recording because they are easy to get backwards from reading the
// minified source alone: `--output-format` is ALWAYS forced to `stream-json` by the SDK itself
// (never `json`, never configurable) -- this file passes no `outputFormat.type` other than
// `json_schema` and never touches the CLI's actual output mode. And `jsonSchema` is NOT a
// top-level option at all -- the schema travels nested under `outputFormat: {type: 'json_schema',
// schema}`, and only `outputFormat.schema` (not the whole `outputFormat` object) reaches
// `--json-schema`.
//
// `allowedTools` and `settingSources` DID match the brief exactly: `sdk.mjs` comma-joins
// `allowedTools` (`--allowedTools Read,Bash`, confirmed by the probe above and by static
// inspection of the `ut.join(",")` call site), and emits `--setting-sources=<csv>` ONLY when the
// option is present at all (`if(N!==void 0)` in `sdk.mjs` -- omitting it leaves the CLI's own
// default in charge), which is exactly why this file pins it unconditionally rather than passing
// it through from `opts` -- see the settingSources comment below.
//
// ---- allowedTools: array today, not the "space-separated string" this action's brief expected -
//
// `step-contracts.js`'s STEP_CONTRACTS table (the real `kind: "card"` path every production call
// takes) already declares `allowedTools` as a JS array literal for all five steps (e.g.
// `allowedTools: ['Read', 'Grep', 'Glob', 'Bash']` on PLAN) -- verified by reading that file
// directly, not carried forward from the brief's "step-contracts.js carries these as
// space-separated strings" claim, which does not match what is actually in STEP_CONTRACTS. The
// space-separated STRING shape only exists in `orchestrator/README.md`'s hand-written example of
// the LEGACY override path (`allowedTools: 'Read Grep'`, orchestrator/README.md:247) -- a shape
// `runLlm`'s override branch (llm.js) still honours verbatim via `ctx.task.llm.<step>`, and which
// `buildArgv`'s own `Array.isArray(opts.allowedTools) ? ... .join(' ') : opts.allowedTools` guard
// already defends against today. `normalizeAllowedTools` below keeps that same defensiveness for
// both real shapes this pipeline actually produces (an array from step-contracts.js, or a
// space-separated string from a hand-authored override / README example) -- test 1's table-driven
// contract-parity check below exercises the array shape (the one every production call takes);
// there is no override-path fixture exercising the string shape yet, so that half of
// normalizeAllowedTools is covered by its own direct unit assertion instead (see
// test/sdk-call-options.test.js).
//
// ---- the no-real-spawn killswitch: safe today, but its future hook belongs to A5, not here -----
//
// This module itself never spawns anything -- buildQueryOptions is a pure mapping function, and
// resolveClaudeCodeExecutable (sdk.js) only `fs.statSync`/`fs.accessSync`s candidate PATH entries,
// never execs. So it is unconditionally safe under SPO_NO_REAL_SPAWN as written: there is no real
// child process for the killswitch to need to stop yet. That changes the moment A5 wires
// invokeClaudeReal to actually call `query({prompt, options})` -- and the mechanism that call
// needs is NOT "patch child_process.spawn", the way test/no-real-spawn.js patches spawnSync and
// orchestrator/no-real-spawn-guard.js patches everything else. Two measurements against the real
// vendored SDK settle why:
//
//   1. Patching `child_process.spawn` does not reliably intercept it. The vendored `sdk.mjs` does
//      `import { spawn as K1e } from "child_process"` -- an ES module named import, resolved and
//      bound at LINK time, before any of the module's own code runs. MEASURED: replacing
//      `require('child_process').spawn` BEFORE this file's first `await import()` of the vendored
//      module (sdk.js's `loadSdk`) is the patch the SDK's own `K1e` binds to (1 intercepted call);
//      replacing it AFTER that first import has already run does nothing at all (0 intercepted
//      calls -- a real child actually spawns). `daemon.js:103`
//      (`require('./no-real-spawn-guard').installGuard()`, first line after the file's own
//      leading comment block) happens to run before any LLM step ever reaches this module, so
//      today's real daemon process is accidentally safe -- but that ordering is a property of
//      daemon.js's own require sequence, not of anything this module or the guard itself
//      enforces. It would not hold for, say, a test process that requires sdk-call.js (and
//      therefore triggers the SDK's own import chain the first time buildQueryOptions actually
//      runs) before requiring no-real-spawn-guard, or for any future lazy-loading of the SDK. And
//      patching `spawn` at all would break `dispatcher.js`'s three legitimate call sites
//      (spawnOne/spawnScanner/reparkCrashedWorker) -- exactly why
//      orchestrator/no-real-spawn-guard.js deliberately excludes `spawn` from PATCHED_FUNCTIONS
//      today (see that file's own "scope" section).
//   2. The SDK has its own, purpose-built hook: `options.spawnClaudeCodeProcess`. MEASURED: when
//      set, `query()` calls it INSTEAD OF its internal `spawnLocalProcess`, synchronously, during
//      `query()`'s own construction -- a throw inside it propagates out of `query()` itself before
//      any real process is created, the same "fails before any child exists" shape
//      ClaudeExecutableNotFoundError above already uses for the executable-resolution failure.
//
// So the future hook is: A5 sets `options.spawnClaudeCodeProcess` here, in buildQueryOptions, to a
// function that reads `no-real-spawn-guard`'s `isEnabled(process.env)` -- AT CALL TIME, never at
// this module's require/load time, the same "read fresh every call" posture isEnabled() already
// documents for itself -- and throws the guard's own shaped error instead of spawning when armed.
// This action does not implement that: no `spawnClaudeCodeProcess` key is set on `options` below,
// and no test in test/sdk-call-options.test.js exercises one. Recorded here so A5 does not have to
// rediscover the two measurements above from scratch, and so this module's current
// "unconditionally safe, nothing to hook yet" state is never mistaken for "the killswitch is
// wired up."
const fs = require('fs');
const { resolveClaudeCodeExecutable } = require('../sdk');
const { resolvePromptText, NONINTERACTIVE_ENV_DEFAULTS } = require('./llm');

// Same UUID-v4 shape check llm.js's invokeClaudeReal applies to opts.sessionId (see that file's
// own SESSION_ID_UUID_V4_RE comment for the full reasoning: the real `claude` CLI's `--help` says
// a supplied --session-id "must be a valid UUID" and exits 1 before any API call on a malformed
// one). Duplicated here rather than imported: llm.js does not export it (it is a private detail
// of invokeClaudeReal, out of this action's scope -- see the chantier brief's "do not touch
// invokeClaudeReal" instruction), and this module must not reach into llm.js's internals to get
// it. If invokeClaudeReal is ever rewired onto this file's opts resolution (A5), the two copies
// become one and this duplication goes away in the same change.
const SESSION_ID_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Pinned, never read from opts or the environment. MEASURED (see the header's probe): `sdk.mjs`
// emits `--setting-sources=<csv>` only when the option is passed at all, and emits NOTHING --
// leaving the CLI's own built-in default in charge -- when it is omitted. `.claude/settings.json`
// is this pipeline's entire permission policy (CLAUDE.md § Permissions) and CLAUDE.md itself is
// the product context PLAN/IMPLEMENT need, so which sources get read can never be left to depend
// on a CLI default this repo does not control and that can change under a future `claude` upgrade
// -- it has to be pinned in code. `[...SETTING_SOURCES]` at each call site (never the shared array
// itself) so nothing downstream can mutate the module-level constant by holding a reference to
// one call's `options.settingSources`.
//
// THE THIRD DELIBERATE DEPARTURE from today's real-mode transport (F5, Opus verifier, fix pass;
// the other two are ANTHROPIC_ENV_KEYS_TO_STRIP above and the allowedTools comma-vs-space join
// documented in this file's header). Today's `buildArgv` (llm.js) never emits `--setting-sources`
// at all -- there is no such flag in its argv list, no opts field feeding one, nothing. So this is
// not "preserving today's behaviour under a new transport": it is this action CHOOSING to pin a
// flag the current pipeline has never passed, on the reasoning above (the CLI's own undocumented
// default must not silently gate CLAUDE.md/`.claude/settings.json`). Read: `['user', 'project',
// 'local']` is UNVERIFIED to be equivalent to the CLI's own flag-absent default for THIS vendored
// version (VENDORED_CLAUDE_CODE_VERSION, sdk.js) -- nothing in this action measured what that
// default actually is, only that passing no flag leaves it "whatever the CLI does when the
// program never asked." If the two ever turn out to differ, that is a real behaviour change this
// pipeline is choosing to make on purpose, not a regression to chase down.
//
// F9 (Opus verifier, fix pass): registered as a named gap, `doc/accepted-gaps.md` §13. HALF
// settled by that action's own tracing of the real CLI binary: the internal allowed-source list is
// `[userSettings, projectSettings, localSettings, flagSettings, policySettings]`, and
// `--setting-sources` (whose own `--help` enum is exactly `user`/`project`/`local`) only ever
// narrows the first three -- `flagSettings`/`policySettings` (managed/enterprise policy) are added
// UNCONDITIONALLY regardless of the flag, so this pin can never cause a policy setting to be
// silently lost. NOT settled: whether omitting the flag entirely reads the same three sources this
// pin names, or a different subset -- that depends on a launch-time default inside a compiled
// binary this repo does not build from source; traced to an accessor pair and a same-shaped
// default constant, not proven without a live session. See the accepted-gaps entry for the full
// trace and the reopen condition (closes at A10's live recette, which already runs one real card
// through this transport at real cost).
const SETTING_SOURCES = Object.freeze(['user', 'project', 'local']);

// Card #239's Done means: "no step acquires an API key" -- the pool is Claude Max SUBSCRIPTION
// accounts (steps/llm.js's own token-accounting header), never metered API billing, and an
// ambient ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN would silently take precedence over the pool's
// subscription credential (CLAUDE_CODE_OAUTH_TOKEN), billing the API instead of drawing on the
// quota this pipeline is built around. Today's invokeClaudeReal (llm.js) inherits both unfiltered
// -- `{...process.env, ...NONINTERACTIVE_ENV_DEFAULTS}` was always a plain spread, never a
// decision about these two keys -- so this is a DELIBERATE DEPARTURE from today's real-mode
// transport, made here rather than silently carried forward. See buildEnv below for where these
// are actually stripped, and test/sdk-call-options.test.js's own env test for the pin (a fake key
// injected into process.env, asserted absent from the resolved env).
//
// This posture is not this pipeline's alone: MEASURED, the vendored SDK's own persistent bash-tool
// CLASS (`vendor/claude-agent-sdk/sdk.mjs`) spawns `/bin/bash --noprofile --norc` with an env built
// by a helper that copies `process.env` verbatim EXCEPT any key matching
// `t.startsWith("ANTHROPIC_")`, which it skips unconditionally -- that helper's return value is
// that class's own DEFAULT second constructor argument. Scoped honestly: a `query()` call from
// THIS pipeline spawns exactly one child, the `claude` CLI itself (`pathToClaudeCodeExecutable`)
// -- it never instantiates this bash-tool class, since tools run INSIDE that child process, not
// SDK-side in ours. So this is not a claim about what our own calls do; it is that the SDK's own
// bash-tool class, when the SDK itself runs Bash directly (a caller using it as an in-process
// agent framework, which this pipeline does not), builds its env this same way. Stripping
// ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN here is this file aligning with a posture the SDK already
// applies to itself, not inventing a new one from scratch.
const ANTHROPIC_ENV_KEYS_TO_STRIP = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

// Thrown by buildEnv when opts.account.oauthTokenFile cannot be read. Today's invokeClaudeReal
// treats this as "a normal step failure, never a throw" -- it RETURNS `{ok: false, kind: 'error',
// ...}` rather than letting the exception escape (see llm.js's own inline comment: "An unreadable
// file is an authoring error surfaced as a normal step failure, never a throw"). buildQueryOptions
// keeps that same OUTCOME by construction once A5 lands: A5 wraps the call to buildQueryOptions in
// a try/catch and maps THIS class (and only this class, plus ClaudeExecutableNotFoundError below)
// onto that {ok:false, kind:'error', ...} shape -- never rethrows it, never crashes the daemon on
// it. A throw at THIS layer, rather than a second return shape from a function whose only
// documented success shape is `{prompt, options}`, is what lets a caller tell "resolved cleanly"
// apart from "failed for a reason I need to inspect" without every success path having to check an
// error field that is almost always absent. Contrast with the sessionId TypeError below, which A5
// must NOT catch this way -- that one is a programming error, not a step failure, and is meant to
// propagate exactly like it does in invokeClaudeReal today.
class OauthTokenUnreadableError extends Error {
  constructor(accountName, cause) {
    super(`sdk-call.js: cannot read oauthTokenFile for account "${accountName}": ${cause.message}`);
    this.name = 'OauthTokenUnreadableError';
    this.accountName = accountName;
    this.cause = cause;
  }
}

// Thrown by buildQueryOptions when resolveClaudeCodeExecutable finds no `claude` on PATH.
// MEASURED (sdk.js's own header, A1): `query()` throws SYNCHRONOUSLY at construction with no
// `pathToClaudeCodeExecutable` at all -- even with a real, working `claude` on PATH, because the
// SDK's only self-contained fallback is the platform npm binary package this repo deliberately
// did not vendor (sdk.js's header). So a null resolution here is a REAL failure mode this pipeline
// will actually hit on any account whose pool image lacks `claude` on PATH, not a defensive
// assertion against a case that "can't happen" -- hence its own named error class, the same
// reasoning as OauthTokenUnreadableError above: A5 catches this one too and maps it onto today's
// `{ok:false, kind:'error', ...}` shape, since it stands in for a spawn that never had a chance to
// start, the same class of failure invokeClaudeReal's own `spawnResult.error` (ENOENT) branch
// already reports that way today.
class ClaudeExecutableNotFoundError extends Error {
  constructor() {
    super(
      'sdk-call.js: no "claude" executable found on PATH -- the Agent SDK has no fallback of ' +
        'its own to the platform npm binary package (deliberately not vendored, see sdk.js), so ' +
        'pathToClaudeCodeExecutable must resolve to something real before query() can be built'
    );
    this.name = 'ClaudeExecutableNotFoundError';
  }
}

// Thrown by buildQueryOptions when opts.jsonSchema is a STRING that is not valid JSON (F3, Opus
// verifier, fix pass). This branch exists so this file can accept the same "already-JSON-encoded
// string" shape today's buildArgv (llm.js) does -- and that shape is LIVE, not hypothetical: the
// legacy override path (runLlm's `ctx.task.llm.<step>` branch, llm.js:1002) passes
// `override.jsonSchema` straight through into opts.jsonSchema with no validation of its own, the
// same path orchestrator/README.md's own hand-written example documents. Today's transport never
// looks at that string until `claude --json-schema <string>` runs and the CLI itself rejects a
// malformed one (exit 1, a normal step failure via invokeClaudeReal's "stdout was not valid JSON"
// or CLI-argument-error branches) -- nothing in this repo's own code ever parses it. This file's
// mapping DOES parse it (outputFormat.schema must be an object, not a string -- see that block's
// own comment), so a malformed string now fails inside buildQueryOptions instead of inside the
// CLI. Left as a bare `JSON.parse` throw, that would surface as an uncaught SyntaxError -- a
// class A5 is documented to catch NEITHER of (only OauthTokenUnreadableError and
// ClaudeExecutableNotFoundError are named for A5 to map), so it would crash a worker where today's
// transport produces an ordinary step failure. Named and thrown here instead, specifically so A5
// can add it as a THIRD class it catches and maps onto `{ok:false, kind:'error', ...}` -- matching
// today's outcome (a step failure, never a crash) for this exact input shape.
class JsonSchemaParseError extends Error {
  constructor(rawJsonSchema, cause) {
    super(`sdk-call.js: opts.jsonSchema is a string but not valid JSON: ${cause.message}`);
    this.name = 'JsonSchemaParseError';
    this.rawJsonSchema = rawJsonSchema;
    this.cause = cause;
  }
}

// normalizeAllowedTools(allowedTools) -> string[] | undefined
//
// The SDK's own `options.allowedTools` wants an ARRAY (comma-joined internally into
// `--allowedTools a,b`, see this file's header measurement) -- todays's `buildArgv` (llm.js)
// accepts either an array (space-joined into `--allowedTools "a b"`) or a bare string (passed to
// argv untouched) and this function preserves that same tolerance, converging both shapes onto
// the one the SDK needs:
//   - an array (step-contracts.js's STEP_CONTRACTS -- the shape every real `kind: "card"` call
//     takes today) is returned AS THE SAME REFERENCE it was given -- this function does not copy.
//     That is deliberate here (a pure "which shape did I get" normalizer has no reason to own
//     copying), but it means the caller must not treat the result as safe to hand to something
//     that could mutate it: step-contracts.js's STEP_CONTRACTS arrays are process-lifetime,
//     shared across EVERY call for that step, never rebuilt per call (see resolveStepContract's
//     own `allowedTools: stepDef.allowedTools`). buildQueryOptions is the one that defensively
//     copies before storing this on `options` -- see its own comment at the call site (F4, this
//     action's fix pass: the first cut skipped that copy and aliased the contract's array
//     directly onto `options.allowedTools`, so `options.allowedTools.push(...)` would have
//     permanently altered that step's tool grant for every later call in the process. Latent,
//     never triggered by the SDK itself, but a whole-process blast radius for one missing `[...]`
//     is worth naming here even though the fix lives one function down).
//   - a string (the legacy override path's documented shape, orchestrator/README.md:247's
//     `allowedTools: 'Read Grep'`) is split on whitespace -- `.split` always allocates a fresh
//     array, so this branch never has the aliasing question the array branch does.
//   - anything falsy (not supplied at all) returns undefined, so buildQueryOptions omits the
//     `allowedTools` key entirely rather than sending an empty array (an empty `--allowedTools`
//     the CLI would read as "allow nothing", a different call from "the flag was never passed").
function normalizeAllowedTools(allowedTools) {
  if (Array.isArray(allowedTools)) return allowedTools;
  if (typeof allowedTools === 'string' && allowedTools.trim() !== '') {
    return allowedTools.trim().split(/\s+/);
  }
  return undefined;
}

// buildEnv(opts) -- the child environment for the eventual query() spawn, built the same way
// invokeClaudeReal (llm.js) builds it today so PATH/HOME/DISABLE_AUTOUPDATER all survive (query's
// own `env` REPLACES the child's environment wholesale rather than merging with it -- MEASURED
// against the real vendored SDK, see this file's header comment -- so starting from
// `{...process.env, ...NONINTERACTIVE_ENV_DEFAULTS}` is not optional, it is the only way any of
// this repo's ambient environment reaches the child at all), plus ONE deliberate departure: see
// ANTHROPIC_ENV_KEYS_TO_STRIP's own comment above for why those two keys are removed rather than
// carried forward from process.env the way everything else is.
//
// Throws OauthTokenUnreadableError (never returns an error shape) on an unreadable
// account.oauthTokenFile -- see that class's own comment for why a throw here still nets out to
// "never a throw" at the invokeClaudeReal-facing layer once A5 lands.
function buildEnv(opts) {
  const env = { ...process.env, ...NONINTERACTIVE_ENV_DEFAULTS };
  if (opts.account && opts.account.configDir) {
    env.CLAUDE_CONFIG_DIR = opts.account.configDir;
  }
  if (opts.account && opts.account.oauthTokenFile) {
    try {
      env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(opts.account.oauthTokenFile, 'utf8').trim();
    } catch (err) {
      throw new OauthTokenUnreadableError(opts.account.name, err);
    }
  }
  for (const key of ANTHROPIC_ENV_KEYS_TO_STRIP) delete env[key];
  return env;
}

// buildQueryOptions(opts, deps = {}) -> { prompt, options }
//
// opts is exactly today's invokeClaudeReal opts (steps/llm.js's own header lists the authoritative
// set): step, model, effort, allowedTools, permissionMode, maxBudgetUsd, jsonSchema,
// promptText|promptFile, cwd, account, deadlineMs, sessionId. `step` and `deadlineMs` are read by
// NOTHING in this function -- `step` is carried by opts only for the caller's own bookkeeping
// (journalling, error messages), and `deadlineMs` is a policy A5 applies around the `query()` call
// itself (an async iteration timeout), not a `query()` option -- there is no argv flag for it and
// this action introduces no such policy (see the chantier brief's own "do NOT set maxTurns" note,
// same reasoning: no turn/time cap is this action's job to invent).
//
// deps.resolveClaudeCodeExecutable overrides sdk.js's real PATH walk -- the one injection point
// this function needs, following steps/llm.js's existing deps.spawnSync/deps.randomUUID
// convention (a function reference, not a pre-resolved value, so a test can assert it was CALLED
// the expected number of times / with the expected argument, not just stub its answer).
//
// Never throws for a missing model/effort/etc -- those are simply omitted when falsy. It DOES
// throw for exactly FIVE reasons (F6, Opus verifier, fix pass: an earlier draft of this comment
// said "three" and then listed four -- miscounted before this fix pass added the fifth), in this
// order:
//   1. resolvePromptText's own "needs promptText or promptFile" Error (reused, not reimplemented,
//      same error/order as this action's brief specified).
//   2. OauthTokenUnreadableError, from buildEnv, when account.oauthTokenFile cannot be read.
//   3. TypeError, when opts.sessionId is a non-empty string that is not UUID-v4 shaped -- kept as
//      a bare TypeError, not a named class, because llm.js's invokeClaudeReal already throws
//      exactly this way today for exactly this reason (a malformed --session-id makes the real
//      CLI exit 1 before any API call -- see that file's own comment on
//      SESSION_ID_UUID_V4_RE) and this action's brief is explicit that the contract must not
//      change: "a programming error that throws, exactly as invokeClaudeReal does today".
//   4. ClaudeExecutableNotFoundError, when no PATH resolution (real or injected) finds `claude`.
//   5. JsonSchemaParseError, when opts.jsonSchema is a string that is not valid JSON -- see that
//      class's own comment (F3, fix pass) for why this is named rather than a bare SyntaxError.
// Reasons 2, 4 and 5 are named classes specifically so A5 can catch and map ONLY those three onto
// today's `{ok:false, kind:'error', ...}` step-failure shape, while letting reason 1's Error and
// reason 3's TypeError propagate uncaught, matching invokeClaudeReal's existing behaviour for both
// (a missing prompt and a malformed sessionId are both already bare throws today, never a step
// failure return).
function buildQueryOptions(opts, deps = {}) {
  const prompt = resolvePromptText(opts);

  // Same relative order as invokeClaudeReal (llm.js): prompt first, then the account-derived env
  // (which can throw OauthTokenUnreadableError), then sessionId validation. The executable
  // resolution is new in this transport (buildArgv/invokeClaudeReal never needed one -- spawnSync
  // just tries `claude` on PATH itself and reports ENOENT if it is missing) so it has no
  // equivalent "original position" to preserve; placed last among the throwing checks since it
  // depends on nothing opts carries.
  const env = buildEnv(opts);

  if (typeof opts.sessionId === 'string' && opts.sessionId !== '' && !SESSION_ID_UUID_V4_RE.test(opts.sessionId)) {
    throw new TypeError(
      `sdk-call.js: opts.sessionId must be a valid UUID (the real "claude" CLI's --session-id ` +
        `requires one and exits 1 before any API call otherwise) -- got ${JSON.stringify(opts.sessionId)}`
    );
  }

  const resolveExecutable = deps.resolveClaudeCodeExecutable || resolveClaudeCodeExecutable;
  const pathToClaudeCodeExecutable = resolveExecutable(process.env.PATH || '');
  if (!pathToClaudeCodeExecutable) {
    throw new ClaudeExecutableNotFoundError();
  }

  const options = {
    pathToClaudeCodeExecutable,
    // Pinned unconditionally -- never read from opts. See SETTING_SOURCES's own comment for why.
    settingSources: [...SETTING_SOURCES],
    env,
    cwd: opts.cwd,
  };

  if (opts.model) options.model = opts.model;
  if (opts.effort) options.effort = opts.effort;
  if (opts.permissionMode) options.permissionMode = opts.permissionMode;

  const allowedTools = normalizeAllowedTools(opts.allowedTools);
  // F4 (Opus verifier, fix pass): copy, never alias. normalizeAllowedTools's array branch returns
  // the SAME reference it was given (see its own comment) -- for the real `kind: "card"` path
  // that reference is step-contracts.js's STEP_CONTRACTS array for this step, shared across every
  // call for the process's whole lifetime. Storing it directly on `options` would let anything
  // downstream that mutates `options.allowedTools` (a future A4/A5 change, a caller cloning
  // options shallowly and pushing) permanently change that step's tool grant for every later
  // call -- exactly the same "never hand out the shared reference" defence SETTING_SOURCES
  // already applies above (`[...SETTING_SOURCES]`, never the frozen constant itself). Measured:
  // before this fix, `buildQueryOptions('PLAN', {}).options.allowedTools ===
  // resolveStepContract('PLAN', {}).allowedTools`; test/sdk-call-options.test.js's own regression
  // test pins the array is a fresh copy by mutating one call's result and checking a second call
  // is unaffected.
  if (allowedTools !== undefined) options.allowedTools = [...allowedTools];

  if (typeof opts.maxBudgetUsd === 'number') options.maxBudgetUsd = opts.maxBudgetUsd;

  if (opts.jsonSchema) {
    // outputFormat.schema must be an OBJECT -- the SDK's own argv builder JSON.stringifies it
    // itself when it emits `--json-schema` (see this file's header measurement); today's
    // buildArgv accepts opts.jsonSchema as either an object or an already-JSON-encoded string
    // (used verbatim, never re-parsed) -- LIVE on the legacy override path, llm.js:1002's
    // `jsonSchema: override.jsonSchema` (F2, Opus verifier, fix pass: not merely a theoretical
    // shape, the same override path this file's allowedTools normalization already accounts for)
    // -- so a string here is parsed back into an object rather than nested as a
    // string-inside-JSON, which would double-encode it on the SDK's own stringify pass.
    let schema = opts.jsonSchema;
    if (typeof opts.jsonSchema === 'string') {
      try {
        schema = JSON.parse(opts.jsonSchema);
      } catch (err) {
        // See JsonSchemaParseError's own comment for why this is named rather than a bare
        // SyntaxError: a malformed string here must fail like a normal step failure once A5
        // catches and maps it, matching what happens today (the real CLI rejects it, exit 1),
        // not crash the worker the way an unnamed, uncaught SyntaxError would.
        throw new JsonSchemaParseError(opts.jsonSchema, err);
      }
      // JSON.parse always allocates a fresh object tree from a string -- no aliasing question for
      // this branch, unlike the object branch below.
    } else {
      // R1 (Opus verifier, second fix pass): deep-copy, never alias -- the SAME F4 aliasing class,
      // but with a larger blast radius than allowedTools's, because it is not latent. MEASURED:
      // resolveStepContract (step-contracts.js) rebuilds its outer `jsonSchema` object and its
      // `.properties` fresh on every call, but reuses the SAME `.required` ARRAY across every call
      // for a given step (never rebuilt, never frozen) -- opts.jsonSchema here, on the real
      // `kind: "card"` path, IS that object, `.required` included. Storing it directly as
      // `options.outputFormat.schema` (as this branch used to) let a downstream mutation of
      // `options.outputFormat.schema.required` permanently corrupt that step's OWN output
      // contract for every later call in the process:
      //   first.options.outputFormat.schema.required.push('POISON')
      //   -> resolveStepContract(step, {}).jsonSchema.required now carries 'POISON' too
      //   -> a SECOND, independent buildQueryOptions call for the same step inherits it
      // `required` IS the step's declared output contract (steps/llm.js's runLlm checks a reply's
      // required keys against exactly this array), and A4 (stream/result mapping) is the next
      // action most likely to read -- and touch -- it, unlike allowedTools which nothing in this
      // codebase mutates today. `JSON.parse(JSON.stringify(...))` is lossless here BY
      // CONSTRUCTION: the SDK's own argv builder JSON.stringifies this exact value to build
      // `--json-schema` (see this file's header measurement), so nothing that can survive that
      // trip can be lost by taking it one extra time here -- if step-contracts.js ever put
      // something a JSON round-trip cannot represent (a function, a Symbol, a circular reference)
      // into a jsonSchema object, this round-trip throwing loudly on it is the correct outcome,
      // not silent data loss this comment needs to guard against.
      schema = JSON.parse(JSON.stringify(schema));
    }
    options.outputFormat = { type: 'json_schema', schema };
  }

  // First-class option, not extraArgs -- see this file's header for the measurement that
  // corrected this from the action's original brief.
  if (typeof opts.sessionId === 'string' && opts.sessionId !== '') {
    options.sessionId = opts.sessionId;
  }

  return { prompt, options };
}

module.exports = {
  buildQueryOptions,
  normalizeAllowedTools,
  buildEnv,
  SETTING_SOURCES,
  ANTHROPIC_ENV_KEYS_TO_STRIP,
  OauthTokenUnreadableError,
  ClaudeExecutableNotFoundError,
  JsonSchemaParseError,
};
