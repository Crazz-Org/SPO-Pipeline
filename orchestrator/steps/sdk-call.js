'use strict';
// sdk-call.js -- actions A3 and A4 (card #239 chantier, "Drive LLM steps through the Claude Agent
// SDK instead of spawning `claude -p`"). This module holds every moving part of the SDK call (A5b
// -- landed the same day, 2026-09-17, not merely planned -- wires invokeClaudeReal to it: see that
// file's own "Deadline handling" header for the design A5b built around this module). A3 added
// buildQueryOptions -- the pure opts-to-{prompt,options}
// mapper -- plus the error classes it can throw. Action A4 added the other half:
// consumeQueryStream, which takes the async iterable a real `query({prompt, options})` call
// returns and reduces it down to today's invokeClaudeReal return shape. Like buildQueryOptions, it
// never spawns anything itself -- it is handed an already-running stream and only reads from it --
// and it does not own the deadline or the journal (see steps/llm.js's own header for what A5b
// added around it).
//
// TENSE (corrected by A9): A3/A4 wrote most of this file BEFORE the cutover, so comments below
// still say "today's transport", "today's `claude -p`" or "today's buildArgv". Read each of those
// as the PRE-cutover transport (commit 41fb081, deleted by A5b), not as anything now running.
// "Today's invokeClaudeReal return shape" is the exception: that shape is still the current one.
//
// buildQueryOptions(opts, deps) -> { prompt, options } takes today's invokeClaudeReal opts shape
// (see steps/llm.js's own header for the authoritative field list) and produces the
// `{prompt, options}` argument `sdk.js`'s loadQuery()-resolved `query` function expects. It never
// calls query() itself and never spawns anything -- buildArgv (llm.js) was the argv builder for
// the OLD transport, until action A5b cut the real spawn over and deleted it, not merely
// superseded it; this function is the SDK-shaped mapper that replaced it, built and tested
// against the same five step contracts so the two could never silently
// diverge before the cutover, which has now happened.
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
//      calls -- a real child actually spawns). `daemon.js:111`
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
// A5b (this action) implements that: `makeSpawnClaudeCodeProcess` below builds a function that
// reads `no-real-spawn-guard`'s `isEnabled(process.env)` AT CALL TIME (never at this module's
// require/load time, or even at buildQueryOptions's own call time -- a deadline race could arm the
// var well after `options` was built) and throws the guard's own `ENOREALSPAWN`-coded error
// instead of spawning when armed.
//
// ---- the SECOND job this same hook does: capturing a real handle for A5b's own abort/no-orphan
// proof -----------------------------------------------------------------------------------------
//
// `options.spawnClaudeCodeProcess` is called *instead of* the SDK's own internal
// `spawnLocalProcess`, synchronously, during `query()`'s own construction, and MEASURED (this
// action, 2026-09-17, against the real vendored SDK -- a real `query()` call, a fake `claude`
// executable, script deleted after use, not committed) to receive `{command, args, cwd, env,
// signal}` and expect back an object satisfying exactly the properties the transport actually
// touches on it: `.stdin`, `.stdout`, `.kill(signal)`, `.killed`, `.exitCode`, `.signalCode`, and
// `.on/.once/.off('exit', (code, signal) => ...)`. A raw `child_process.spawn(...)` result
// satisfies every one of those natively (it IS a real `ChildProcess`) -- confirmed end-to-end
// against a real `query()` call, both for an ordinary success (structured_output round-tripped
// correctly through a hand-spawned child) and for an abort (the SDK's own `close()` method called
// `.kill('SIGTERM')` then, after its own escalation delay, `.kill('SIGKILL')` on the exact object
// this function returned -- see llm.js's own header for the timing that measurement produced and
// what it's used for).
//
// Returning the raw `ChildProcess` INSTEAD OF reimplementing the SDK's own `spawnLocalProcess`
// wrapping (a stderr-tail ring buffer for richer error text, and a 200ms post-exit grace waiting
// for stdio streams to close before synthesizing its own `'exit'` event) is a deliberate choice,
// not an oversight: those two things exist for diagnostic richness, not correctness, and
// reimplementing them exactly would mean privately maintaining a second copy of internal SDK
// plumbing that a future re-vendor could silently invalidate. The ONE correctness property losing
// that wrapping does NOT excuse is stderr drainage: an OS pipe has a bounded buffer (historically
// 64KB on Linux), and a child that writes enough to it without anyone reading blocks on its own
// `write()` call -- a real hang risk for a chatty `claude` process, not a theoretical one.
// MEASURED: a fake child that wrote >800KB to stderr before ever reading stdin completed normally
// through this function's drain-and-discard handler below, with no hang; the same fixture without
// the drain would have deadlocked (not itself re-measured, since that would mean shipping the
// deadlock to prove it -- the pipe-buffer mechanism is standard POSIX behaviour, not a claim
// specific to this SDK).
function makeSpawnClaudeCodeProcess(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const isEnabledFn = deps.isNoRealSpawnEnabled || isNoRealSpawnEnabled;
  let capturedProcess;

  function spawnClaudeCodeProcess(spawnArgs) {
    // "Both, not either" (this hook's own throw, plus invokeClaudeReal's own isEnabled() check at
    // its top -- see that file's header): this is the defense-in-depth half, reached if a future
    // caller ever gets to query() by some route that skips invokeClaudeReal's own check.
    if (isEnabledFn(process.env)) {
      const err = new Error(
        'sdk-call.js: a real query() call reached spawnClaudeCodeProcess -- SPO_NO_REAL_SPAWN is ' +
          'set, so this refuses to spawn a real `claude` process instead of silently reaching it ' +
          'with live credentials. This means a mutated or regressed isRealMode/config.real gate let ' +
          'a call reach this hook -- see orchestrator/no-real-spawn-guard.js.'
      );
      err.code = 'ENOREALSPAWN';
      throw err;
    }
    const child = spawnFn(spawnArgs.command, spawnArgs.args, {
      cwd: spawnArgs.cwd,
      env: spawnArgs.env,
      signal: spawnArgs.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Drain and discard -- see this function's own header for why an unread stderr pipe is a real
    // hang risk. This function's caller (llm.js's invokeClaudeReal) never reads stderr text back
    // out of this object for its own error messages -- consumeQueryStream's failure branches build
    // their diagnostic text from the stream's own result/errors fields, never from stderr -- so
    // discarding rather than buffering costs nothing this pipeline actually uses today.
    child.stderr.on('data', () => {});
    child.stderr.on('error', () => {});
    capturedProcess = child;
    return child;
  }

  return { spawnClaudeCodeProcess, getSpawnedProcess: () => capturedProcess };
}

// ---- the SDK's own internal kill-escalation timing (measured, not assumed) ---------------------
//
// vendor/claude-agent-sdk/sdk.mjs's ProcessTransport.close() -- invoked when
// `options.abortController` aborts -- does NOT kill immediately. MEASURED (grep against the
// vendored file, both constants read directly off their own declaration, not inferred):
// `var q1e=2000,hR=2048,uG="sdk-exit-after-stderr-drained",Z1e=200;` -- close() waits `q1e`
// (2000ms) before even checking whether the process is still alive, and only if it is, sends
// SIGTERM and arms a SECOND, unref'd `setTimeout(...,5000,...)` that sends SIGKILL if the process
// still hasn't exited by then. So the SDK's own worst case, analytically: 2000 + 5000 = 7000ms from
// `abortController.abort()` to a GUARANTEED SIGKILL delivery -- not the 5000ms an earlier static
// read of this same file found in isolation (that read the SIGKILL escalation setTimeout but
// missed the outer 2000ms gate it is nested inside).
//
// CROSS-VALIDATED against a LIVE run (this action, 2026-09-17; a fake `claude` that installs a
// SIGTERM handler and never exits on its own, run through a real `query()` call from this repo's
// vendored SDK via a custom spawnClaudeCodeProcess identical in shape to the one above, script
// deleted after use, not committed): abort() called, the directly-captured child's own `'exit'`
// event fired at t=5854ms in one run and t=7132ms in another -- both within the analytically-
// derived 7000ms bound plus scheduling/reap overhead, never past it.
//
// Named as two separate constants, matching the vendored source's own two-stage shape, rather than
// folded into one opaque number -- so a future re-vendor that changes either literal (triggered by
// bumping VENDORED_SDK_VERSION/VENDORED_CLAUDE_CODE_VERSION in sdk.js, per that file's own pin) is
// easy to re-derive from this comment instead of silently drifting. test/sdk-call-options.test.js
// pins that both literals still appear together in the vendored file, the same "pin what a
// re-vendor could silently change" posture sdk.js's own VENDORED_SDK_VERSION pair already uses.
const SDK_ABORT_KILL_DELAY_MS = 2000;
const SDK_ABORT_SIGKILL_ESCALATION_MS = 5000;
// Margin for scheduling/event-loop/process-reap overhead ON TOP of the SDK's own analytically-
// derived worst case -- both live measurements above landed inside this margin (largest observed
// overshoot ~132ms), nowhere close to exhausting it.
const ABORT_GRACE_MARGIN_MS = 1500;
// llm.js's invokeClaudeReal holds its own return for up to this long, after calling abort(),
// before giving up on confirming the real child actually exited -- see that file's own header for
// the account-lease race this exists to close.
const ABORT_CONFIRM_GRACE_MS = SDK_ABORT_KILL_DELAY_MS + SDK_ABORT_SIGKILL_ESCALATION_MS + ABORT_GRACE_MARGIN_MS;

// confirmProcessExit(child, graceMs) -> Promise<{confirmed, code, signal}>
//
// Resolves once `child` (the object spawnClaudeCodeProcess captured/returned above) has actually
// exited, or after `graceMs` has elapsed without that happening -- whichever comes first. Never
// guesses: `confirmed` is only ever true when the real `'exit'` event fired (or had already fired
// before this function was even called -- checked via `.exitCode`/`.signalCode`, both `null` only
// while a process is still running, per Node's own ChildProcess contract). `child` may be
// `undefined` (query() threw before ever calling spawnClaudeCodeProcess -- e.g. the killswitch
// fired first) -- treated as vacuously confirmed, since there is no process to wait for.
//
// llm.js's invokeClaudeReal calls this, bounded by ABORT_CONFIRM_GRACE_MS, to hold its own return
// until it knows whether the account lease its caller is about to release is safe to release -- see
// that file's own header for the incident this closes.
function confirmProcessExit(child, graceMs) {
  if (!child) return Promise.resolve({ confirmed: true, code: null, signal: null });
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ confirmed: true, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let settled = false;
    // Deliberately NOT `.unref()`d -- see llm.js's own deadline-timer comment (invokeClaudeReal)
    // for the full, corrected reasoning (fix pass F3): ref'ing THIS timer is not itself what fixes
    // the hang (MEASURED: unref'ing both this timer and llm.js's deadline timer together, while
    // leaving test/helpers.js's fake child's own ref'd `keepalive` interval untouched, still passes
    // all 90 llm-real.test.js/llm-real-card.test.js tests). It stays ref'd for a different reason
    // that IS real: the vendored SDK's own kill-escalation timers are themselves unref'd in the
    // vendored source, so something ref'd has to hold the loop open for a SIGKILL to have a chance
    // to land when nothing else in the process is doing so. Cleared as soon as either branch below
    // settles either way.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ confirmed: false, code: child.exitCode, signal: child.signalCode });
    }, graceMs);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ confirmed: true, code, signal });
    });
  });
}
const fs = require('fs');
const { spawn } = require('child_process');
const { resolveClaudeCodeExecutable } = require('../sdk');
const { isEnabled: isNoRealSpawnEnabled } = require('../no-real-spawn-guard');
const {
  resolvePromptText,
  NONINTERACTIVE_ENV_DEFAULTS,
  // Reused, never reimplemented, by consumeQueryStream below -- all three are the SAME functions
  // the pre-cutover `claude -p`/`--output-format json` transport used on `invokeClaudeReal`'s
  // parsed stdout. MEASURED (this action, 2026-09-17, against the REAL vendored SDK -- a fake
  // `claude` executable emitting stream-json lines, consumed through a real `query()` call, see
  // consumeQueryStream's own header): the SDK's `result` message carries `api_error_status` and
  // `terminal_reason` in the exact same snake_case shape and spelling `classifyFailure`/
  // `limitKindForFailure` already read off `--output-format json`'s parsed object -- there is
  // nothing SDK-specific to translate. `limitKindForFailure` was already defined in llm.js but not
  // exported (nothing outside that file needed it before this action) -- added to its
  // module.exports in this same change, its own body untouched.
  extractTokens,
  classifyFailure,
  limitKindForFailure,
} = require('./llm');

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
// reasoning as OauthTokenUnreadableError above: action A5b (landed 2026-09-17, the same day) made
// invokeClaudeReal catch this one too and map it onto the same
// `{ok:false, kind:'error', ...}` shape, since it stands in for a spawn that never had a chance to
// start -- the same class of failure the OLD transport's `invokeClaudeReal` reported through its
// own `spawnResult.error` (ENOENT) branch, deleted along with the rest of that transport, not
// merely superseded.
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
// string" shape the old transport's now-deleted buildArgv (llm.js) used to -- and that shape is
// LIVE, not hypothetical: the legacy override path (runLlm's `ctx.task.llm.<step>` branch,
// llm.js:1063) passes `override.jsonSchema` straight through into opts.jsonSchema with no
// validation of its own, the same path orchestrator/README.md's own hand-written example
// documents. The OLD transport never looked at that string until `claude --json-schema <string>`
// ran and the CLI itself rejected a malformed one (exit 1, a normal step failure via
// invokeClaudeReal's "stdout was not valid JSON" or CLI-argument-error branches) -- nothing in
// that transport's own code ever parsed it. This file's
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

// buildQueryOptions(opts, deps = {}) -> { prompt, options, getSpawnedProcess }
//
// A5b added `getSpawnedProcess` to this return (previously just `{ prompt, options }`) -- a zero-
// arg accessor for the real child `spawnClaudeCodeProcess` captures once query({prompt, options})
// actually calls it (undefined until then, e.g. if the killswitch throws first). Existing callers
// that destructure only `{ options }` (test/sdk-call-stream.test.js's own probe helper predates
// this) are unaffected -- an extra property on the returned object is backward compatible.
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
// this function needs, following steps/llm.js's existing deps.randomUUID convention (a function
// reference, not a pre-resolved value, so a test can assert it was CALLED the expected number of
// times / with the expected argument, not just stub its answer) -- the OLD transport's
// deps.spawnSync is gone from this codepath entirely, deleted along with buildArgv, not merely
// renamed; this file's own equivalent injection point for the real spawn is deps.spawn, read by
// makeSpawnClaudeCodeProcess above, not by this function.
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
// Reasons 2, 4 and 5 are named classes specifically so action A5b (landed 2026-09-17, the same
// day) could make invokeClaudeReal catch and map ONLY those three onto
// the `{ok:false, kind:'error', ...}` step-failure shape, while letting reason 1's Error and
// reason 3's TypeError propagate uncaught, matching invokeClaudeReal's existing behaviour for both
// (a missing prompt and a malformed sessionId are both already bare throws today, never a step
// failure return).
function buildQueryOptions(opts, deps = {}) {
  // THE E2BIG LESSON (carried forward from the old transport's now-deleted `buildArgv`, action
  // A5b -- record it here, not there, since this is where the prompt now travels through this
  // pipeline's own code before reaching the child). Linux caps each INDIVIDUAL argv/environ string
  // at MAX_ARG_STRLEN (32 * PAGE_SIZE = 131072 bytes on this machine) -- a distinct, much smaller
  // limit than ARG_MAX (the cumulative argv+environ budget, never remotely approached here). A
  // filled prompt bigger than that made the OLD transport's spawnSync call fail with E2BIG before
  // `claude` ever started, unconditionally, no matter the model/account/step. Reproduced
  // 2026-08-30 on card #452: its IMPLEMENT prompt was 204826 bytes (a placeholder substituted
  // twice into implement.md -- see that file's own fix); its PLAN prompt, same task, was 105307
  // bytes and passed with only ~26KB of headroom -- the cliff was one character-count away for
  // every card, not particular to #452's size. The lesson still applies on THIS transport: the
  // prompt is never placed into `options` as an argv-shaped string anywhere in this function --
  // it is returned here, separately, as `prompt`, and the SDK itself sends it to the child over
  // STDIN as a stream-json `user` message (MEASURED, `vendor/claude-agent-sdk/sdk.mjs`'s `d0()`:
  // `t.write(me({type:"user",...,content:[{type:"text",text:n}]})+"\n")` where `t` is the
  // transport's own stdin writer) -- the same "prompt travels on stdin, never argv" property
  // `buildArgv`'s own comment established, preserved by construction rather than by convention,
  // since this function never has an opportunity to put it anywhere else.
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

  // card #240 (merged into this chantier from main, 2026-09-22 -- postdates action A5b's own
  // 2026-09-17 cutover, so the OLD transport's now-deleted buildArgv is where this flag's argv
  // shape was originally proven, never this function until this merge). Same copy-never-alias
  // discipline as allowedTools just above: orchestrator/bash-policy.js's lists are frozen and
  // shared across every call for a step's whole process lifetime. The vendored SDK accepts
  // `options.disallowedTools` as its own first-class array field (measured,
  // `vendor/claude-agent-sdk/sdk.mjs`: `disallowedTools:F=[]` on its own options destructure,
  // comma-joined into `--disallowedTools` by the SDK's own argv builder) -- so, unlike the OLD
  // transport's hand-built space-joined string, this needs no join of its own; the array travels
  // to the SDK exactly the way allowedTools already does. Omitted (not set to `[]`) when empty or
  // absent, matching buildArgv's own "omit the flag entirely" behaviour for CITATION_VERIFIER
  // (the one policy step-contracts.js gives no disallowedTools entry at all).
  const disallowedTools = normalizeAllowedTools(opts.disallowedTools);
  if (disallowedTools !== undefined && disallowedTools.length > 0) {
    options.disallowedTools = [...disallowedTools];
  }

  if (typeof opts.maxBudgetUsd === 'number') options.maxBudgetUsd = opts.maxBudgetUsd;

  if (opts.jsonSchema) {
    // outputFormat.schema must be an OBJECT -- the SDK's own argv builder JSON.stringifies it
    // itself when it emits `--json-schema` (see this file's header measurement); the old
    // transport's now-deleted buildArgv accepted opts.jsonSchema as either an object or an
    // already-JSON-encoded string (used verbatim, never re-parsed) -- LIVE on the legacy override
    // path, llm.js:1063's `jsonSchema: override.jsonSchema` (F2, Opus verifier, fix pass: not
    // merely a theoretical shape, the same override path this file's allowedTools normalization
    // already accounts for)
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

  // A5b: own the AbortController rather than letting query() default one internally (`let{
  // abortController:g=Pd()...}` in the vendored source -- MEASURED, `Pd()` is a plain
  // `new AbortController()`). invokeClaudeReal needs a reference it can call `.abort()` on when
  // its own deadline timer fires, and the SDK only ever reads `options.abortController` back OUT
  // of what it was given (there is no "give me the one you built" accessor) -- so a caller-owned
  // one, built here, is the only way to get one at all.
  options.abortController = new AbortController();

  // The killswitch AND the abort/no-orphan proof's own captured handle -- see
  // makeSpawnClaudeCodeProcess's own header for both jobs this one hook does and why they share a
  // seam. `getSpawnedProcess` is exposed on this function's return (not on `options` itself, which
  // stays exactly the shape query() consumes) so invokeClaudeReal can read the real child back out
  // after calling query({prompt, options}).
  const { spawnClaudeCodeProcess, getSpawnedProcess } = makeSpawnClaudeCodeProcess(deps);
  options.spawnClaudeCodeProcess = spawnClaudeCodeProcess;

  return { prompt, options, getSpawnedProcess };
}

// consumeQueryStream(stream, ctx = {}) -> Promise<today's invokeClaudeReal return shape>
//
// Takes the async iterable a real `query({prompt, options})` call returns (from `sdk.js`'s
// `loadQuery()`-resolved `query` function, handed `buildQueryOptions`'s own output) and reduces it
// to EXACTLY the object `invokeClaudeReal` (steps/llm.js) returns today, key for key -- see that
// function's own header for the authoritative field list this matches. It never spawns (the
// stream is already running when this function receives it -- A5 owns the `query()` call itself),
// never arms or checks a deadline (A5's job: an abort signal/timeout race around the iteration
// this function does, not inside it), and never journals (runLlm's two `appendEvent` call sites
// stay the only place that happens, unchanged by this action).
//
// F6 (Opus verifier, fix pass): the "key for key" claim above is true of this function's OWN
// return value, but only PRE-RECOVERY -- `invokeClaudeReal` today wraps every branch except the
// two where `claude` never started (an unreadable oauthTokenFile, a spawn failure) in
// `maybeRecoverTokens` (llm.js), which can overwrite the six token fields on a result whose
// `tokensSource` came back falsy. `consumeQueryStream` never calls it -- that wiring is
// `invokeClaudeReal`'s own, and lands in the SAME commit as this function (action A5b), not in a
// later one.
//
// STALE CLAIM CORRECTED (action A7, card #239 chantier, "token ledger on the SDK stream"): this
// paragraph used to end "A7 ... owns wiring that half in for this transport, not this action" --
// true when it was written, false by the time A7 actually started: A5b's own commit already
// wired every `invokeClaudeReal` return branch (the deadline-kill shape, the external-signal-kill
// shape, and the ordinary success/failure shape) through `maybeRecoverTokens` before returning
// (see llm.js's own three `return maybeRecoverTokens(...)` call sites). A7's actual job turned
// out to be a different one than its own name implied: the card's brief asked it to verify
// whether that wiring was still needed at all, on the theory that "usage arrives on the stream
// with the SDK" makes transcript recovery dead code. MEASURED (A7, real `query()` call, a real
// spawned `node` fixture standing in for `claude`, never an injected `deps.recoverSessionTokens`
// -- see test/token-recovery-e2e.test.js): a deadline kill, an external signal kill, and a stream
// that ends (cleanly or not) with no `result` message ALL still reach this function's own
// item-4/item-5 branches below with `tokensSource` staying null (`extractTokens(undefined)` --
// there is no `result` message for those branches to read `modelUsage` off of, on this transport
// exactly as much as the old one).
//
// What that proof does NOT measure (Opus verifier, fix pass F2, named so it is not mistaken for
// settled): the fixture's transcript file exists because the TEST writes it, not because a real
// `claude` binary was observed doing so under this wire protocol. No SDK-driven call has run
// against the real CLI yet (this chantier's worktree is ahead of the live daemon, still on
// pre-cutover `claude -p` at `41fb081`) -- so "the real binary's own `--resume` bookkeeping
// persists the transcript independent of the wire protocol" is a structural inference (same
// binary, same on-disk mechanism either way), not a measurement, until the first real SDK-driven
// kill confirms it. See llm.js's own `maybeRecoverTokens` comment for the fuller statement of that
// premise and where it gets settled (A10's live-recette checklist). If it is confirmed, recovery
// is not dead code on this transport; A7 kept it on that basis, corrected this paragraph and this
// file's own doc consumers instead of deleting anything, rather than carrying the removal forward
// on an unverified premise. See llm.js's own `maybeRecoverTokens` comment and token-recovery.js's
// header for the fuller ruling, and the A7 report for the real corpus counts (810 live-era
// `llm-call` events, 25 recovered via `'transcript'`, 3.09%, every one `ok: false` -- corrected by
// the same fix pass after an earlier count wrongly included 92 pre-instrumentation events
// `scripts/backfill-legacy-tokens.js` wrote retroactively, not live recoveries) that answer "how
// often" rather than only "can it".
//
// ---- how the message shapes below were measured, not assumed ----------------------------------
//
// Same discipline as buildQueryOptions's own header: every claim below was checked against the
// REAL vendored SDK (vendor/claude-agent-sdk/sdk.mjs), not read off its (unpublished, minified, no
// .d.ts shipped) source by inspection. Method: a fake `pathToClaudeCodeExecutable` -- a `node`
// script that writes literal stream-json lines (JSON objects the way `claude --output-format
// stream-json` would emit them, one per stdout line) read from an env var -- run through a real
// `query({prompt, options})` call from THIS repo's vendored SDK, iterating the real async
// generator it returns and logging exactly what came out. test/sdk-call-options.test.js's own
// "argv-level" test (A3, case 3) already crosses this same process boundary for argv; this action
// reuses that fixture shape for message content instead. Deleted after use, not committed; this
// comment records the findings for the shapes the checked-in tests (test/sdk-call-options.test.js
// additions below) do not themselves re-derive:
//
//   1. PASS-THROUGH, NOT TRANSFORMED. A `result` message fed in with `is_error:false,
//      modelUsage:{...}, num_turns:12, duration_ms:1234, structured_output:{...}` comes back out
//      of the async iterator with every one of those keys byte-identical, same snake_case spelling
//      the CLI's own `--output-format json` reply already uses. F3 (Opus verifier, fix pass)
//      corrected the evidence sentence this claim used to rest on: it named FIVE fields
//      (`api_error_status`, `num_turns`, `terminal_reason`, `session_id`, `duration_ms`) as "NONE
//      of them occur in the file at all" -- re-measured in this worktree's own vendored copy
//      (`grep -oF '<name>' vendor/claude-agent-sdk/sdk.mjs | wc -l`): `api_error_status` 0,
//      `num_turns` 0, `terminal_reason` 0 -- genuinely absent, so the SDK has no hardcoded
//      knowledge of these three and cannot rename or drop them -- but `session_id` 29 and
//      `duration_ms` 3, which DO occur (the SDK reads its own session id and timing internally
//      for bookkeeping the query() caller never sees, e.g. `this.lastErrorResultText`'s own
//      construction grepped in the is_error branch's comment below). The CONCLUSION survives
//      unchanged -- the probe above independently confirms both fields still arrive on the
//      message object byte-identical to what the fake CLI wrote, so "the SDK reads it too" is not
//      the same claim as "the SDK transforms or strips it" -- but the ORIGINAL sentence's method
//      (grep for absence, as a stand-in for pass-through) was only valid for three of the five
//      names it listed. This is WHY `classifyFailure`/`limitKindForFailure` (llm.js) can be called
//      on a `result` message with zero adaptation -- the field names they already read are exactly
//      the ones present.
//   2. `errors` MUST BE AN ARRAY OF STRINGS, or the SDK itself throws while building the message.
//      MEASURED: a `result` message with `subtype:'error_during_execution', api_error_status:429`
//      and NO `errors` key at all threw `Cannot read properties of undefined (reading 'map')`
//      from INSIDE the SDK's own message construction, before this function ever saw a message --
//      i.e. an error-subtype `result` message structurally REQUIRES `errors` to be present. Given
//      `errors:['rate limited']` (an array of strings), it passed through untouched. Given
//      `errors:[{message:'rate limited', type:'api_error'}]` (an array of objects, the shape a
//      structured API error type might plausibly take), the SDK threw `n.trim is not a function`
//      -- so the SDK itself calls something like `.trim()` on each entry, meaning `errors` is
//      documented-by-behaviour to be `string[]`, never `object[]`. Both throws happen inside the
//      SDK's own iteration, which is exactly the "throws mid-iteration" case item 4 below covers --
//      this function's own try/catch around the loop is what stands between a malformed message
//      from a future CLI build and a crashed worker.
//   3. `is_error:true` DOES NOT STRUCTURALLY MEAN "NO `result` KEY" -- CORRECTED, F1 (Opus
//      verifier, fix pass). This action's own probe only ever constructed `is_error:true` on the
//      four error subtypes (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`,
//      `error_max_structured_output_retries`), none of which carried a `result` field -- and wrongly
//      generalised that to "every `is_error:true` message," a claim it never actually tested. The
//      verifier measured against the real CLI binary's own zod schemas (2.1.274, one file this
//      probe never reached): `subtype:'success'` declares `is_error` as a REQUIRED BOOLEAN, not the
//      literal `false` -- the agentic loop can complete normally and still report an error. Only
//      that schema declares `api_error_status` and `result` (required there); the four error
//      subtypes' schema declares neither. Consequence that made this a real defect, not a
//      theoretical gap: the one limit this repo has EVER actually recorded (the Fable 429 incident,
//      llm.js's own `classifyFailure` comment) arrives as `subtype:'success', is_error:true,
//      api_error_status:429, result:'<limit text>'`, with NO `errors` field at all -- the exact
//      opposite of what item 3 used to claim. `invokeClaudeReal`'s own `is_error`/`exit!==0` branch
//      (llm.js) already sets `result: parsed.result` unconditionally on failure -- so `result`
//      carrying the diagnostic text here is not a divergence to correct for, it is the SAME shape
//      today's transport already relies on, and `orchestrator/intake.js`'s `formatLlmFailure`
//      (`raw.error || raw.result || ''`) already falls back to exactly this field. The `errors`
//      array (this file's own `error`-field decision, below) is the fallback needed ONLY for the
//      four error subtypes, which genuinely never carry `result` -- see the is_error branch's own
//      comment, and grep `sdk.mjs` for `is_error?e.subtype==="success"?e.result:e.errors` for the
//      SDK's own construction of the identical distinction, mirrored here rather than reinvented.
//   4. A NONZERO-EXIT CHILD WITH NO RESULT MESSAGE THROWS MID-ITERATION. A fake `claude` that
//      wrote a `system`/`init` line, an `assistant` line, then `process.exit(1)` with no `result`
//      line at all made the `for await` loop itself throw `Error: Claude Code process exited with
//      code 1` on its next iteration -- a generic `Error`, not a named class, and not something the
//      messages already yielded gave any advance warning of. Two things follow: this function's
//      loop MUST be wrapped in try/catch (an uncaught throw here would propagate out of
//      `consumeQueryStream` itself, which its own contract -- "never spawn, but always return
//      today's shape" -- does not allow), and `sessionId` from an `init` message already seen
//      BEFORE the throw is still honest and must be kept (the session really was created; only the
//      LLM step failed to complete it) -- matching invokeClaudeReal's existing convention that
//      `sessionId` is reported whenever a session really exists, not only on a clean return.
//   5. A ZERO-EXIT CHILD WITH NO RESULT MESSAGE DOES **NOT** THROW. A fake `claude` that wrote only
//      a `system`/`init` line and then `process.exit(0)` let the `for await` loop complete
//      normally -- no error, no result. This is a SEPARATE case from item 4 (a clean exit that
//      simply never got around to emitting a result, vs. a crash), and both need their own branch
//      below: this function cannot tell "the model finished with nothing to say" apart from "a
//      `claude` build stopped emitting `result` lines" any more than the old transport's
//      `!parsed || typeof parsed !== 'object'` branch could tell "malformed JSON" apart from "the
//      CLI changed its output shape" -- both are reported the same honest way, `kind:'error'`.
//
// ---- the five decisions this action's brief asked for, and what backs each one ------------------
//
// 1. `raw`. Today it is the child's exit status (an OS int: 0, a positive failure code, or the
//    value spawnSync leaves on a signal kill) -- `orchestrator/intake.js`'s `formatLlmFailure`
//    reads it as `exit=<raw.raw>`, present-fields-only (guarded by `!== undefined && !== null`,
//    the same convention this whole file's `apiErrorStatus`/`terminalReason` fields already use).
//    There is no exit status on this transport: `query()` never surfaces the child's process exit
//    code to its caller at all (confirmed by reading every message shape probed above -- none
//    carries one; the SDK manages the child process internally and reports success/failure only
//    through `is_error`/`subtype`). This function sets `raw: undefined` on every branch, always --
//    never a fabricated 0-or-1 standing in for "no exit code available." That keeps
//    `formatLlmFailure`'s existing `!== undefined && !== null` guard doing exactly what it already
//    does for the oauthTokenFile-unreadable branch today (which also carries no `raw` key): the
//    `exit=` detail is silently omitted, not replaced with a lie. WHAT A READER CAN AND CANNOT
//    COMPARE: an old journal line's implicit "exit=143" (SIGTERM) or "exit=3" (a real CLI failure
//    code) meant something concrete about the OS-level process outcome; a reader who sees no
//    `exit=` detail on a new-transport park must not infer "the process exited 0" or "no crash
//    happened" from the absence -- it means only "this transport does not report an exit code,"
//    the same non-inference the oauthTokenFile branch already required before this action existed.
// 2. `result` vs `structured_output`. MEASURED (item 1 above, and directly): a real `result`
//    message CAN carry both simultaneously (a fake reply with `result:'{"foo":"bar"}'` AND
//    `structured_output:{foo:'bar'}` passed through with both fields intact, unmodified, not
//    merged or deduplicated by the SDK), and CAN carry only `structured_output` with no `result`
//    key at all (a fake reply with `structured_output:{hello:'world'}` and no `result` field
//    passed through exactly that way) -- so this function cannot assume either is authoritative by
//    elimination. Every one of this pipeline's five real step contracts sets a `jsonSchema`
//    (test/sdk-call-options.test.js's own table-driven test 1, A3), which `buildQueryOptions`
//    always turns into `options.outputFormat = {type:'json_schema', schema}` -- so `structured_output`
//    is the field this pipeline's OWN request shape asks the SDK to populate, and it arrives
//    already parsed (a real JS object, not text needing a second decode). `result`'s free-text
//    shape is the CLI's own historical field, not something this pipeline's json-schema-driven
//    calls are designed to depend on. So: prefer `structured_output` (re-stringified with
//    `JSON.stringify`, since today's contract -- `runLlm`'s `JSON.parse(raw.result)` -- needs a
//    STRING, never a bare object) when it is a non-null object; fall back to `result` verbatim when
//    it is already a string (the CLI's own historical shape, kept for a future/legacy call that
//    sets no `jsonSchema` and therefore gets no `structured_output` back); JSON.stringify a
//    non-string, non-undefined `result` as a last defensive resort (so `runLlm`'s `JSON.parse`
//    contract is never handed a non-string no matter which of these three shapes actually arrives).
//    Neither present leaves `result` genuinely absent (`undefined`) -- exactly the shape
//    `JSON.parse(undefined)` already fails on in `runLlm` today, which is the SAME "reply was not
//    valid JSON" step failure the old transport already produces for a `result` missing entirely,
//    not a new failure mode this action invents.
//
//    UPHELD, and named the FOURTH DELIBERATE DEPARTURE (Opus verifier, fix pass) from today's
//    real-mode transport -- `buildQueryOptions`'s own header already names three (stripping
//    `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, the `allowedTools` comma-vs-space join, and
//    pinning `settingSources` unconditionally); preferring `structured_output` over `result` is a
//    fourth, and belongs in this function's header rather than that one since it is
//    `consumeQueryStream`'s own decision, not `buildQueryOptions`'s. The reasoning the verifier
//    added: the CLI's success schema types `result` as any string, and F1 (above) is itself the
//    proof that a `subtype:'success'` reply can carry ordinary prose there (the Fable limit text).
//    A second live path in the CLI yields a success with an EMPTY `result` and `structured_output`
//    stripped entirely. `--json-schema` genuinely reaches the CLI on every real call this pipeline
//    makes (`buildQueryOptions` always sets `options.outputFormat` -- all five step contracts
//    declare a `jsonSchema`, test/sdk-call-options.test.js's own table-driven test 1, A3), so every
//    real call asks for `structured_output` to be populated; a turn that cannot produce a
//    schema-valid reply fails with its OWN `error_max_structured_output_retries` subtype (this
//    file's error-subtype handling above) rather than emitting free-text prose into either field.
//    So `structured_output` present implies schema-valid, a guarantee `result` never carries --
//    inverting the preference (result-first) would hand `runLlm`'s `JSON.parse(raw.result)` the
//    turn's CLOSING PROSE instead of the payload, and would do so on the ORDINARY json-schema
//    call, not an edge case: `structured_output` is populated from the model's own
//    `StructuredOutput` TOOL CALL (the CLI's result message sets `structured_output:
//    sr.at(-1)?.data` -- the last such call's parsed `input.text`; `StructuredOutput` is matched
//    there as `e.type === "tool_use" && e.name === "StructuredOutput"`), while `result` is the
//    turn's final assistant TEXT. Two different productions, not two renderings of one string --
//    so the two disagreeing is the expected shape of a json-schema reply, and only
//    `structured_output` is the schema payload at all. The `tool_deferred` path named above is
//    NOT itself such a case: there the CLI strips `structured_output` outright
//    (`{api_error_status:O, api_error_code:L, structured_output:A, ...se} = P; yield {...se,
//    is_error:!1, stop_reason:"tool_deferred", result:""}`) and sets `result:''`, so both
//    orderings park identically -- it is evidence that `result` is not a reliable JSON carrier,
//    not evidence that the preference decides anything there.
//    `step-contracts.js`'s `checkOutputTypes` array-from-JSON-string
//    leniency (llm.js's own comment on it) simply stops firing on this transport, since a value
//    that arrived as a JSON string under the old transport now arrives as a real array already --
//    not a behaviour change, just a leniency with nothing left to correct. Today's single-source
//    (`result`-only) contract was FRAGILE, not faithful, to keep as this transport's own default;
//    `structured_output`-first is the one that cannot be handed non-JSON by construction.
// 3. The error subtypes. `error_max_turns` and `error_max_budget_usd` have no dedicated vocabulary
//    entry in today's transport (`classifyFailure`/`limitKindForFailure`, llm.js) -- neither
//    function looks at `subtype` at all, only at `api_error_status` and `terminal_reason`. Rather
//    than inventing a subtype-keyed branch (a new failure channel this action's brief explicitly
//    rules out), this function calls `classifyFailure`/`limitKindForFailure` UNIFORMLY on every
//    `is_error:true` result message regardless of subtype -- which is correct by construction: if
//    a future `error_max_turns` reply ever also happens to carry `api_error_status:429` (a rate
//    limit that ALSO caused the loop to be cut short), it is still classified `kind:'limit'`
//    exactly like a plain `error_during_execution`/429 reply would be, because the classification
//    depends only on the two fields it has always depended on. Absent those two fields (the
//    ordinary case for `error_max_turns`/`error_max_budget_usd`/`error_max_structured_output_retries`
//    -- none of the three represents an account-wide quota or server-overload condition, they are
//    all THIS call's own agentic-loop/budget/retry caps being hit), `classifyFailure` falls through
//    to its existing `'error'` default -- the SAME park reason (`llm-transport-failed:<STEP>`,
//    state-machine.js's four `kind === 'error' || timedOut` guards) a plain malformed-JSON or
//    spawn failure already produces today. No production path sets `--max-turns` or
//    `--max-budget-usd` (this action's brief, and `buildQueryOptions`'s own header on
//    `deadlineMs`/turn caps), so `error_max_turns`/`error_max_budget_usd` are not reachable from a
//    real card today regardless of this mapping -- recorded for when A8 (per-step permission
//    policy) or a future action considers setting either.
//    F1 (Opus verifier, fix pass) corrected a narrower claim THIS decision used to rest on: the
//    classification call is uniform across every `is_error:true` message regardless of subtype
//    (unchanged by the fix), but WHICH FIELD carries the diagnostic text is not -- `subtype:'success'`
//    (is_error:true) is classified the SAME way (`classifyFailure` never looks at `subtype`) but
//    reports its text via `result`, while the four error subtypes report theirs via `errors` -- see
//    the is_error branch's own comment and header item 3 for the corrected shape.
// 4. A stream that ends with no result message (item 5 above), and a stream that throws
//    mid-iteration (item 4 above). Both produce `{ok:false, kind:'error', error:<honest string>,
//    ...}` -- the same shape the old transport's "stdout was not valid JSON" branch uses for its
//    own "something is structurally wrong with what came back" case. `sessionId` is read from
//    whatever `system`/`init` message this function has already seen by the time either branch is
//    reached (`null` if none arrived, e.g. a `pathToClaudeCodeExecutable` that resolves but the
//    child dies before ever writing its first line) -- consistent with invokeClaudeReal's existing
//    rule that a session id is reported only when a session really exists, never fabricated ahead
//    of evidence and never withheld once evidence (the `init` message) exists.
//
// ---- the sixth decision: does this function take a per-message callback? -----------------------
//
// Yes -- `ctx.onMessage`, called once per message in stream order, BEFORE this function's own
// classification of that message (so a callback sees `assistant`/`user` progress -- never
// `stream_event`, which requires `includePartialMessages` and is set nowhere in orchestrator/)
// messages this function itself has no other use for, and sees the terminal `result` message too,
// same as everything else). Optional (`typeof ctx.onMessage === 'function'` gates it; `ctx` itself
// defaults to `{}` so a caller that only wants the return shape -- every test in this action, and
// A5 until A6 lands -- can call `consumeQueryStream(stream)` with no second argument at all).
// Wrapped in its own try/catch, separate from the loop's own try/catch: a callback that throws
// must never be indistinguishable from the STREAM throwing (item 4 above) -- a progress-reporting
// bug in A6's own code must not get misreported as "query() stream threw" and misroute a card into
// a transport-failure park for a failure that was never the LLM call's own. This action does not
// build what A6 does with the messages it forwards (no live-progress plumbing, no journal writes
// from inside the callback -- out of scope, per the chantier brief) -- only the seam A6 attaches
// to, so A6 does not have to duplicate this function's own stream-iteration/classification logic
// to get a look at the same messages.
async function consumeQueryStream(stream, ctx = {}) {
  const onMessage = typeof ctx.onMessage === 'function' ? ctx.onMessage : null;

  let sessionId = null;
  let resultMessage = null;

  try {
    for await (const message of stream) {
      if (message && typeof message === 'object') {
        // The authoritative id: MEASURED, a `system`/`init` message's own `session_id` is the
        // first evidence a session exists at all, and a terminal `result` message's `session_id`
        // (set again below, once `resultMessage` is known) is the CLI's own last word on the same
        // question -- both are CLI-reported, never one this function generates itself (this
        // function never mints anything -- see this file's own header, buildQueryOptions never has
        // either). STALE CLAIM CORRECTED TWICE (Opus verifier fix pass F7, then this action's Job
        // 2): an earlier draft here said "unlike invokeClaudeReal", as if invokeClaudeReal still
        // minted its own session id -- true before action A5b, false right after it (A5b's cutover
        // dropped the mint entirely). F7's own fix pass corrected THAT to "invokeClaudeReal never
        // mints one either any more" -- true for the few days between A5b and this action's Job 2,
        // false again now: Job 2 restored the mint in llm.js's invokeClaudeReal (a UUID, generated
        // before `query()` is called and supplied as `options.sessionId`, following the same
        // deps.randomUUID convention the pre-A5b transport used -- see token-recovery.js's own
        // header for the recovery guarantee this restores). So this message's own `session_id`
        // IS, in the ordinary case, the same value invokeClaudeReal already supplied -- this
        // function still reports whatever the CLI actually says (the CLI is the authority on what
        // it named the session, per invokeClaudeReal's own "CLI wins, falls back to ours"
        // comment), it is only that "ours" is no longer a hypothetical the CLI always overrides in
        // practice; it is a real id invokeClaudeReal's own fallback uses when this function's
        // `sessionId` comes back null (the stream never got far enough to see either message).
        // The `subtype === 'init'` guard is UNPINNED (mutation-proof, Opus verifier fix pass:
        // dropping it leaves every test in this file green) but not a gap worth a test for --
        // every `system` message the CLI emits on a given run carries the SAME `session_id`, so a
        // wider `message.type === 'system'` match would read the identical value here regardless.
        // Left in place as the more PRECISE match (this is the one message the SDK's own
        // `apiKeySource`/`init` semantics document as authoritative for the id), not because a
        // looser one has been observed to disagree.
        if (
          message.type === 'system' &&
          message.subtype === 'init' &&
          typeof message.session_id === 'string' &&
          message.session_id !== ''
        ) {
          sessionId = message.session_id;
        } else if (message.type === 'result') {
          resultMessage = message;
          if (typeof message.session_id === 'string' && message.session_id !== '') {
            sessionId = message.session_id;
          }
        }
      }
      if (onMessage) {
        try {
          onMessage(message);
        } catch {
          // A callback's own bug is never this function's failure to report -- see the header's
          // "sixth decision" section for why this is a SEPARATE try/catch from the loop's own.
        }
      }
    }
  } catch (err) {
    // The stream itself threw mid-iteration (header item 4: MEASURED, a nonzero-exit child with
    // no result message produces exactly this). `sessionId` above already reflects whatever `init`
    // message arrived before the throw, honestly null otherwise.
    return {
      ok: false,
      kind: 'error',
      error: `sdk-call.js: query() stream threw before a result message arrived: ${err && err.message}`,
      sessionId,
      ...extractTokens(undefined), // the shared "nothing recognizable was found" zero-token shape
      numTurns: undefined,
      durationS: undefined,
      raw: undefined,
    };
  }

  if (!resultMessage) {
    // The stream ended cleanly with no throw, but also no `result` message (header item 5:
    // MEASURED, a zero-exit child that never wrote one). Distinct from the throw branch above --
    // both are real and both need their own branch, per this action's brief -- but land on the
    // same reported shape, the same way the old transport's "stdout was not valid JSON" and
    // "spawn failed" branches are different causes that both report `kind: 'error'`.
    return {
      ok: false,
      kind: 'error',
      error: 'sdk-call.js: query() stream ended with no result message',
      sessionId,
      ...extractTokens(undefined),
      numTurns: undefined,
      durationS: undefined,
      raw: undefined,
    };
  }

  // F1 (Opus verifier, fix pass): `is_error:true` does NOT structurally mean "no result message
  // shape" -- it can arrive on EITHER of the two message shapes the SDK's own zod schemas declare
  // (measured by the verifier against the real CLI binary, 2.1.274, one file this action's own
  // probe never constructed): `subtype:'success'` declares `is_error` as a required BOOLEAN, not
  // the literal `false` -- the agentic loop can complete normally and still report an error (a 429
  // mid-response is exactly this shape, and IS the one limit this repo has ever actually recorded,
  // the Fable incident). Only the success schema declares `api_error_status` and `result`
  // (required there); the four error subtypes' schema declares neither. So resultMessage below is
  // one of THREE shapes, not two: SDKResultSuccess (is_error:false), SDKResultSuccess-with-error
  // (subtype:'success', is_error:true -- carries `result`, may carry `api_error_status`, never
  // carries `errors`), or SDKResultError (one of the four error subtypes -- carries `errors`,
  // never `result` or `api_error_status`). extractTokens is the SAME function invokeClaudeReal
  // calls on `parsed.modelUsage` (llm.js) -- modelUsage's shape is unchanged by this transport
  // (header item 1: pass-through, not transformed), so no adaptation is needed here either.
  const tokens = extractTokens(resultMessage.modelUsage);
  const numTurns = resultMessage.num_turns;
  // duration_ms is this transport's own measurement of the call (the CLI/SDK's, not this
  // function's own wall-clock read -- this function does not spawn and does not own timing, see
  // this file's header) -- converted to seconds for the same `durationS` field name/unit
  // invokeClaudeReal already reports. Left `undefined`, never fabricated as 0, when the field is
  // absent (defensive: every probed message carried it, but nothing guarantees a future CLI build
  // always will).
  const durationS = typeof resultMessage.duration_ms === 'number' ? resultMessage.duration_ms / 1000 : undefined;

  if (resultMessage.is_error) {
    const kind = classifyFailure(resultMessage);
    // F1 (Opus verifier, fix pass): dispatch on `subtype`, mirroring the vendored SDK's OWN
    // construction of its internal `lastErrorResultText` (grepped from the real `sdk.mjs`, not
    // reasoned from the outside):
    //   e.is_error ? (e.subtype === "success" ? e.result : e.errors.map(n=>n.trim()).filter(Boolean).join("; ")) : void 0
    // i.e. the SDK itself treats `result` as the diagnostic text on `subtype:'success'` and
    // `errors` (trimmed, empty entries dropped, joined) as the diagnostic text on every other
    // subtype -- exactly the two schema shapes this branch's own header comment now documents.
    // `isSuccessSubtypeError` names which of the two this reply is.
    const isSuccessSubtypeError = resultMessage.subtype === 'success';
    // F4 (Opus verifier, fix pass): computed BEFORE the return object, not inline, because the
    // gate on whether to include `error` at all must be the JOINED, TRIMMED, FILTERED text, never
    // the raw array's `.length`. The original inline version gated on
    // `resultMessage.errors.length > 0` and then trimmed/filtered AFTER -- so `errors:['']` (length
    // 1, passes the gate) produced `error: ''`, and `errors:['', '  boom  ', '']` produced
    // `'; boom  ; '` instead of the SDK's own `'boom'` (re-measured through the real SDK against
    // both cases; the SDK's construction -- see this branch's own header comment -- filters BEFORE
    // joining, this file's original code filtered the same way but gated the KEY's presence on the
    // wrong, pre-filter length). An empty joined string is exactly the collapse
    // `orchestrator/intake.js`'s `formatLlmFailure` (`raw.error || raw.result || ''`) warns is "no
    // signal at all" -- the one case the `error` field exists to prevent -- so gating on the
    // POST-join, POST-filter string (`joinedErrors` truthy, i.e. non-empty) is the only gate that
    // cannot silently produce that collapse.
    const joinedErrors = Array.isArray(resultMessage.errors)
      ? resultMessage.errors
          .map((e) => String(e).trim())
          .filter(Boolean)
          .join('; ')
      : '';
    return {
      ok: false,
      kind,
      // Only present on a 'limit' classification -- same convention as invokeClaudeReal's own
      // identical branch (llm.js): an absent/unrecognised limitKind is accounts.markLimit's own
      // fail-safe fallback, so omitting the key on a plain 'error' costs nothing.
      ...(kind === 'limit' ? { limitKind: limitKindForFailure(resultMessage) } : {}),
      // `result`: TODAY'S TRANSPORT PARITY, corrected by F1 -- present ONLY on
      // `subtype:'success'`, since that is the one schema that actually declares the field
      // (required there). This is the shape the one limit this repo has ever recorded (the Fable
      // 429 incident) actually arrives as: the loop completed, `is_error:true`,
      // `api_error_status:429`, and the CLI's own limit-reached text sits in `result` -- the same
      // field the pre-cutover `claude -p` transport carried it in (`invokeClaudeReal`'s
      // `is_error`/`exit!==0` branch, llm.js, sets `result: parsed.result` unconditionally on
      // failure). No `error` key is set alongside it -- matching that transport exactly, which
      // never sets one on this branch either; `result` alone is the diagnostic text, and
      // `orchestrator/intake.js`'s `formatLlmFailure` (`raw.error || raw.result || ''`) already
      // falls back to it.
      ...(isSuccessSubtypeError ? { result: resultMessage.result } : {}),
      // `error` populated from `joinedErrors` (header item 2: MEASURED to be required, string[], on
      // every real error-SUBTYPE message -- narrowed by F1 to exclude `subtype:'success'`, which
      // never carries `errors` at all per the corrected header) -- this is NOT inventing a new
      // failure field or a new failure channel (the shape still returns `{ok:false, kind, ...}`
      // exactly like every other branch in this file and in invokeClaudeReal); it is populating
      // the EXISTING optional `error` string with the one diagnostic source THIS shape actually
      // has, since the `result`-text fallback structurally cannot exist for it (no `result` field
      // on the error-subtype schema at all). Gated on the POST-filter string, not the raw array --
      // see `joinedErrors`'s own comment above (F4) for why the gate has to be the joined text.
      ...(!isSuccessSubtypeError && joinedErrors ? { error: joinedErrors } : {}),
      sessionId,
      ...tokens,
      numTurns,
      durationS,
      apiErrorStatus: resultMessage.api_error_status,
      terminalReason: resultMessage.terminal_reason,
      raw: undefined,
    };
  }

  // Success (SDKResultSuccess, is_error:false). See decision 2 above for the structured_output vs
  // result precedence and why each branch below exists.
  let result;
  if (resultMessage.structured_output !== null && typeof resultMessage.structured_output === 'object') {
    result = JSON.stringify(resultMessage.structured_output);
  } else if (typeof resultMessage.result === 'string') {
    result = resultMessage.result;
  } else if (resultMessage.result !== undefined) {
    result = JSON.stringify(resultMessage.result);
  }
  // Neither present: `result` stays undefined, and runLlm's existing `JSON.parse(raw.result)`
  // fails exactly the way it already does today for a success reply with no usable payload --
  // no new failure mode, see decision 2's own closing sentence.

  return {
    ok: true,
    result,
    sessionId,
    ...tokens,
    numTurns,
    durationS,
    raw: undefined,
  };
}

module.exports = {
  buildQueryOptions,
  consumeQueryStream,
  normalizeAllowedTools,
  buildEnv,
  makeSpawnClaudeCodeProcess,
  confirmProcessExit,
  SETTING_SOURCES,
  ANTHROPIC_ENV_KEYS_TO_STRIP,
  SDK_ABORT_KILL_DELAY_MS,
  SDK_ABORT_SIGKILL_ESCALATION_MS,
  ABORT_GRACE_MARGIN_MS,
  ABORT_CONFIRM_GRACE_MS,
  OauthTokenUnreadableError,
  ClaudeExecutableNotFoundError,
  JsonSchemaParseError,
};
