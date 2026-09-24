'use strict';
// llm.js -- the LLM step interface (PLAN, IMPLEMENT, DIAGNOSE, VALIDATE's two
// verifiers). state-machine-spec.md § Step contracts.
//
// Shadow mode (ctx.shadowMode === true): never touches the `claude` CLI. Returns the canned
// JSON payload from the task's shadow.llm.<stepName> fixture (see fixture.js for the array/
// scalar cursor convention), optionally preceded by an artificial delay read from
// `delays.<stepName>` (ms), same mechanism as steps/scripted.js. Unchanged by everything below.
//
// Real mode drives the vendored Claude Agent SDK's `query()` (card #239 chantier, action A5b --
// before this action, real mode spawned `claude -p ...` directly via `spawnSync` and parsed its
// `--output-format json` stdout; that transport is gone, not merely superseded, and `buildArgv`
// (its argv builder) has been deleted along with it, see this file's git history for its final
// form). Two layers:
//
//   invokeClaudeReal(opts, deps) -- the primitive. Takes the same per-call inputs the spec lists
//     (step, model, effort, allowedTools, permissionMode, maxBudgetUsd, jsonSchema,
//     promptText|promptFile, cwd, account, deadlineMs, sessionId) it always has -- the CUTOVER
//     changed the transport underneath, not this function's contract. Maps opts onto
//     `{prompt, options}` via `orchestrator/steps/sdk-call.js`'s `buildQueryOptions`, drives
//     `sdk.js`'s `loadQuery()`-resolved `query({prompt, options})`, reduces the resulting async
//     message stream via that same file's `consumeQueryStream`, and returns {ok, result,
//     sessionId, tokensSource, freshInputTokens, cacheCreationTokens, cacheReadTokens,
//     outputTokens, billableTokens, cacheCreationEphemeral1h, cacheCreationEphemeral5m,
//     modelUsage, numTurns, durationS, raw} -- byte-identical field set to the old transport's,
//     except `raw` is now always `undefined` (this transport reports no OS exit code at all --
//     see consumeQueryStream's own header decision 1). Card #214: `modelUsage` is the same four
//     billable-accounting fields plus `billableTokens`, broken out PER MODEL (keyed by the
//     model name modelUsage's own reply used) instead of summed across every model the call
//     touched -- present only when extractTokens() found at least one recognized field
//     (mirroring `tokensSource: 'modelUsage'`'s own presence rule), absent on a call that
//     reported nothing. Without it, a step whose call delegates to a subagent running a
//     DIFFERENT model than the contract resolved -- PLAN is measured to do this, see
//     step-contracts.js's own comment on its `allowedTools` -- has the subagent's tokens
//     summed into the same flat totals as the resolved model's own, with no way for a reader
//     to pull them back apart; the journalled `model` field then names only the step's
//     CONTRACT model, never the subagent's. `sessionId` is set on every branch representing a
//     call that was at least attempted (success, deadline kill, external signal, unparsable
//     stream) and null only when `claude` never started at all (an unreadable `oauthTokenFile`,
//     no `claude` resolved on PATH, or a malformed `opts.jsonSchema` string -- the three named
//     error classes `buildQueryOptions` throws and this function catches, see its own try/catch
//     below) -- see invokeClaudeReal's own inline comment for why each branch draws the line
//     where it does. `deps.query` and `deps.buildQueryOptions` are the two injection points tests
//     use; daemon production code passes neither. Action A5a (#239) added `deps.onLlmCallAttempt`
//     -- called immediately before `query()` itself now (previously immediately before the
//     spawn), the one choke point every real LLM call passes through (see that call site's own
//     comment for why). `durationS` (seconds, measured with monotonicNowMs() around the whole
//     query()/consume/confirm sequence, NOT Date.now() and NOT the SDK's own `duration_ms` --
//     see the durationS assignment's own comment for why this function's own measurement still
//     wins) is journaled as `duration_s` -- doc/state-machine-spec.md's Observability section
//     already documented that field before any code wrote it (measured 2026-09-01: zero of the 19
//     corpus journals' llm-call events carried it); true as of this change.
//
//     Token accounting (maintainer decision, 2026-08-31): the pool is Claude Max SUBSCRIPTION
//     accounts with a quota, never metered API billing, so a dollar figure never meant money
//     spent -- this build carries no cost/$ fields anywhere, only raw token counts extracted
//     defensively from modelUsage by extractTokens() below. "billable-weighted" = fresh input +
//     cache-creation + output; cache-READ is reported separately and never folded into that
//     total (near-free on a quota plan, and it dominates raw counts by orders of magnitude --
//     see console/usage-scan.js's own header). extractTokens() itself sets tokensSource to
//     'modelUsage' when at least one recognized field was found there, else null -- so a reader
//     can tell "zero tokens" from "not reported". Token-ledger lot, action 4.3: a null result from
//     extractTokens is no longer necessarily invokeClaudeReal's LAST word on the subject --
//     maybeRecoverTokens() then attempts to recover from the session transcript (tokensSource:
//     'transcript') for any branch that generated a real sessionId, which by construction excludes
//     the two branches where claude never started at all (an unreadable oauthTokenFile, and a
//     generic spawn failure such as ENOENT/EACCES/E2BIG) -- those keep tokensSource: null and
//     billableTokens: 0 unconditionally, because no transcript can exist for a session that was
//     never created. See maybeRecoverTokens' own comment for the full contract.
//
//   runLlm(ctx, stepName, fixtureKey, deps) -- the existing shadow-mode entry point every state-
//     machine handler already calls. Its shadow branch is untouched. Its real branch has two
//     sub-paths:
//       - ctx.task.llm.<stepName> present -- the legacy interim config source, honoured
//         verbatim (no template fill, no outputContract validation). Kept only for backward
//         compatibility with test/llm-real.test.js and test/account-rotation.test.js, which
//         construct exactly this shape.
//       - otherwise (the real `kind: "card"` path) -- step-contracts.js resolves
//         model/effort/tools/permissionMode/maxBudgetUsd/jsonSchema for this task shape,
//         task-values.js derives the {{placeholder}} values, prompt-template.js fills
//         prompts/<file>.md (a missing placeholder value throws MissingPlaceholderError, turned
//         into a ParkSignal here so the state machine parks with the placeholder named in the
//         reason). ctx.dryRun short-circuits right before the spawn: it writes
//         journal/<id>/dryrun-<STATE>.md (argv + filled prompt) and returns a minimal
//         outputContract-satisfying object marked {dryRun: true}. Otherwise invokeClaudeReal
//         runs for real, and a successful reply's `result` string is JSON.parsed and checked
//         against outputContract.required -- a missing key returns the same {kind: 'error'}
//         shape invokeClaudeReal itself uses for a spawn/parse failure. Card #207: a required key
//         that IS present but fails its outputContract.types entry (step-contracts.js's
//         checkOutputTypes) returns that identical {kind: 'error'} shape too -- a key with no
//         declared type is untouched, presence-checked only, exactly as before this card.
//     Every sub-path resolves cwd via config.cwdForStep, takes the account from ctx.account (set
//     by the caller's account-rotation retry loop -- see state-machine.js's callLlmStep), and
//     journals one event per call (an 'llm-call' for a real attempt, a 'dry-run' for a dry one).
//
// Deadline handling (rewritten by action A5b -- the paragraph this replaces described
// spawnSync's own synchronous `timeout` option, which no longer exists on this transport; see git
// history for that version if the pre-cutover doctrine is ever needed again). Going ASYNC means
// this function now owns cancellation EXPLICITLY -- there is no thread-blocking spawnSync call for
// a timer to preempt, and there is also no synchronous guarantee that returning means the child is
// dead. deadline.js's callWithDeadline/withTimeout race is STILL not reused for this job, for the
// original reason restated: it abandons the loser "to finish in the background" (see its own
// comment), which for a real subprocess would mean an orphaned `claude` process still spending
// budget -- exactly the property this function's own design refuses to accept as a limitation, and
// beats outright rather than merely inherits (see below).
//
// The mechanism: `options.abortController` (built fresh per call inside `buildQueryOptions`, one
// controller per `query()` call, never reused) is aborted by a `setTimeout` armed against
// `opts.deadlineMs`. MEASURED (this action, 2026-09-17, against the real vendored SDK -- see
// sdk-call.js's own header for the full probe): aborting does NOT kill the child promptly, and
// does NOT synchronize with the async iterator's own completion. The SDK's own internal escalation
// (`ProcessTransport.close()`) waits 2000ms, then SIGTERMs, then waits another 5000ms before
// SIGKILL -- a worst case of 7000ms from `abort()` to a GUARANTEED kill, which this transport
// BEATS the old one on: spawnSync's `timeout` sent exactly one signal and never escalated (see the
// corrected paragraph two below), so a `claude` process that traps and ignores SIGTERM ran to
// completion regardless of the deadline; this transport forces it dead within a bounded,
// MEASURED window regardless of whether it cooperates. But the async iterator (what
// `consumeQueryStream` awaits) was ALSO measured to settle up to ~5-7s BEFORE that kill actually
// lands -- so `invokeClaudeReal` does not treat "the stream ended" as "the call is over." After
// every `consumeQueryStream` call, it awaits `sdk-call.js`'s `confirmProcessExit` (bounded by that
// same file's `ABORT_CONFIRM_GRACE_MS`, derived from the two measured constants above plus
// margin) against the real child handle `buildQueryOptions`'s `spawnClaudeCodeProcess` hook
// captured -- and does not return until it knows whether the account lease its own caller
// (state-machine.js's `callLlmStep`) is about to release in a `finally` is safe to release. A live
// `claude` still holding that lease's `CLAUDE_CONFIG_DIR` when the lease frees would let a sibling
// worker start a SECOND `claude` on the same account inside the gap -- exactly what `lock.js`'s
// "never two `claude` processes on one `CLAUDE_CONFIG_DIR`" rule exists to prevent, reachable at
// K>=2 workers, not theoretical. If the grace window expires without a confirmed exit, this
// function does NOT claim a clean kill -- it returns `killConfirmed: false` and says so in
// `error`, honestly, rather than reporting a kill it cannot back up (a false "killed" is worse
// than a true "could not confirm": it is the field a maintainer reads when deciding whether the
// pool is cooling for a real reason). The state machine still wraps the whole call in
// callWithDeadline (see callLlmStep) for its existing "retry once, then PARK" bookkeeping.
//
// What this paragraph used to claim about spawnSync (kept, corrected, for the transport this
// action retired -- the reasoning is exactly why the new transport had to beat it, not merely
// match it): spawnSync's `timeout` sent `killSignal` (SIGTERM by default) and did NOT escalate to
// SIGKILL. Measured (action 6.2's verification) -- an ordinary child returned
// `signal=SIGTERM status=null error=ETIMEDOUT` after 410ms against a 400ms timeout, while a child
// that INSTALLED A SIGTERM HANDLER AND IGNORED IT ran to its own completion at 27651ms and
// returned `signal=null status=0`, i.e. never killed at all. A call killed by a deadline returns
// `{ok: false, timedOut: true, deadlineMs, killConfirmed, error: "... ran but exceeded the Xms
// deadline ..."}` -- callers that need to tell a deadline kill apart from a genuine spawn/parse
// failure (e.g. intake.js's triageBugReport, to decide whether a retry is worth it) test
// `timedOut`, never the message text; unchanged by this action.
//
// One property this action measured but did NOT close, recorded rather than silently accepted:
// `doc/accepted-gaps.md` carries this transport's own detached-grandchild finding -- a tool
// subprocess `claude` itself spawns can outlive a killed `claude`, symmetric with the old
// transport (neither ever signalled a process GROUP), pre-existing, not introduced or worsened
// here.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { sleep } = require('./scripted');
const config = require('../config');
const { appendEvent } = require('../journal');
const { ParkSignal } = require('../park-signal');
const { resolveStepContract, deadlineMsForStep, checkOutputTypes } = require('../step-contracts');
const { fillPromptTemplate, MissingPlaceholderError } = require('../prompt-template');
const { buildPromptValues } = require('../task-values');
const { monotonicNowMs } = require('../monotonic-clock');
const { recoverSessionTokens: recoverSessionTokensDefault } = require('../token-recovery');
const { loadQuery, resolveClaudeCodeExecutable } = require('../sdk');
const { isEnabled: isNoRealSpawnEnabled } = require('../no-real-spawn-guard');
const { createProgressCallback, clearLiveProgress } = require('../live-progress');

// sdk-call.js requires THIS file back (resolvePromptText, NONINTERACTIVE_ENV_DEFAULTS,
// extractTokens, classifyFailure, limitKindForFailure -- see its own header). A plain top-level
// `require('./sdk-call')` HERE would make that a genuine circular require: whichever of the two
// files is required FIRST by the outside world runs its top-level body, hits the other file's
// top-level `require()`, and -- because Node's require cache returns whatever the in-progress
// module's `module.exports` object currently IS, not what it will eventually become -- the file
// requiring THE ONE STILL MID-EXECUTION would destructure every name off an incomplete (still
// `{}`) exports object and silently get `undefined` for all of them. Lazy instead: `getSdkCall()`
// below calls `require('./sdk-call')` only from INSIDE invokeClaudeReal, i.e. only once this
// file's own module body (and therefore its `module.exports` assignment at the bottom) has
// already finished running for every real caller -- functions are only ever invoked after the
// module that defines them has finished loading, which is exactly what breaks the cycle. Node's
// own require cache makes the repeated `require()` calls this produces free after the first.
function getSdkCall() {
  return require('./sdk-call');
}

const REPO_ROOT = path.join(__dirname, '..', '..');

// "Non-interactive safe" env defaults for a background/batch caller. `-p` already makes the CLI
// headless (skips the workspace trust dialog -- see `claude --help`), so the one thing left that
// could add latency or a network call to a scripted invocation is the auto-updater; the doctor
// output on this machine (`claude doctor`, 2026-08) already shows
// "Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)", confirming this is a real,
// respected variable. Nothing else is set here on purpose: `--safe-mode` / `--bare` also turn
// off CLAUDE.md and hooks, which PLAN/IMPLEMENT need for product context.
const NONINTERACTIVE_ENV_DEFAULTS = {
  DISABLE_AUTOUPDATER: '1',
};

// Reads opts.promptText/opts.promptFile down to the final prompt string. Historically split out
// of the old transport's `buildArgv` (deleted by action A5b -- the prompt never lived in argv even
// there, see the E2BIG lesson this function's own callers now carry forward at
// sdk-call.js's buildQueryOptions, which calls this same function as its own first step) but two
// callers here still need the resolved text: invokeClaudeReal indirectly, via buildQueryOptions
// (to hand `query()` the prompt to write to the child's stdin) and writeDryRunArtifact (to display
// it). Throws the same "needs promptText or promptFile" error this function always has, at the
// same point in the call sequence -- buildQueryOptions calls this before touching the
// account/oauth-token file, so a missing prompt still fails first, exactly as invokeClaudeReal
// itself used to before this action moved that ordering into sdk-call.js.
function resolvePromptText(opts) {
  let prompt = opts.promptText;
  if ((prompt === undefined || prompt === null || prompt === '') && opts.promptFile) {
    prompt = fs.readFileSync(opts.promptFile, 'utf8');
  }
  if (!prompt) {
    throw new Error('llm.js: real-mode call needs promptText or promptFile');
  }
  return prompt;
}

// runLlm's dry-run branch overlays this onto `options.pathToClaudeCodeExecutable` when the real
// PATH walk (sdk.js's resolveClaudeCodeExecutable) finds nothing and no test has injected its own
// deps.resolveClaudeCodeExecutable -- see that branch's own comment for why a dry run must never
// let the real absence of `claude` on PATH throw. Deliberately not a real-looking path (no
// leading `/`, spelled out in words) so an artifact reader -- or a future citation grep -- can
// never mistake it for something the pipeline actually resolved.
const DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER = '<claude not found on PATH -- dry run>';

// Zero-value shape extractTokens returns when modelUsage is absent or carried nothing
// recognizable -- kept as one literal so every caller's "no tokens" result is byte-identical.
const ZERO_TOKENS = Object.freeze({
  tokensSource: null,
  freshInputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  billableTokens: 0,
  cacheCreationEphemeral1h: 0,
  cacheCreationEphemeral5m: 0,
});

// pickNumber(obj, ...keys) -- returns the first key present on obj whose value is a number, else
// 0. The dual-spelling defensive read every field below uses: modelUsage is produced by the
// `claude` CLI itself, never present in the session JSONL, so its exact key casing has no
// on-disk fixture to verify against. test/llm-real.test.js's own hand-written fixture is
// camelCase (inputTokens, cacheCreationInputTokens, ...) -- the strongest evidence available for
// this build -- but the real per-message usage block (verified from a live session file) is
// snake_case (input_tokens, cache_creation_input_tokens, ...). Both are accepted; a field this
// build has never seen at all just contributes 0, never throws.
function pickNumber(obj, ...keys) {
  for (const key of keys) {
    if (obj && typeof obj[key] === 'number') return obj[key];
  }
  return 0;
}

// extractTokens(modelUsage) -- sums the four billable-accounting fields (plus, best-effort, the
// ephemeral cache-creation TTL split) across every model entry in modelUsage -- a call can use
// more than one model (e.g. a fallback), the same reason the old sumCost summed across entries.
// Never throws: a missing/malformed field or a missing modelUsage entirely all just read as 0.
//
// tokensSource is 'modelUsage' the moment ANY recognized field on ANY entry is a number
// (including a legitimate 0), and stays null only when nothing recognizable was found at all --
// that is the "zero tokens" vs "not reported" distinction the maintainer asked for (a killed/
// E2BIG call, or a `claude` build that stops emitting modelUsage, should never silently read as
// "this call cost nothing").
//
// The ephemeral_1h/5m cache-creation split is a separate, best-effort read nested under
// modelUsage[model].cache_creation / .cacheCreation. No fixture in this repo has ever shown
// modelUsage carrying it (see test/llm-real.test.js's fixture -- flat fields only), only the raw
// session JSONL's message.usage.cache_creation block does. These two fields are captured here
// anyway, on the chance a future/undocumented modelUsage shape carries them, but read back
// EXACTLY 0/0 in a real smoke run against the live CLI (2026-08-31: fresh 910, cache-creation
// 8904, cache-read 21478, output 50 all correct, ephemeral 1h/5m both 0). Treat them as
// STRUCTURALLY 0 from this source, never as "no ephemeral cache was written" -- nothing
// downstream consumes them (tokens.js does not read them, `spo tokens` does not print them),
// and computeLikelyCacheExpiries deliberately does not depend on them. The reliable source for
// this split is a join against the session JSONL
// by sessionId (console/usage-scan.js already streams that file for other reasons; see
// orchestrator/tokens.js's own header for why the join, not this call site, is where that
// actually matters).
//
// Card #214: the SAME loop below also builds `perModel`, a per-model breakdown of the four
// billable-accounting fields (plus each model's own `billableTokens`) -- surfaced on the
// return value as `modelUsage`, present under the same `found` gate as `tokensSource` so a
// call that reported nothing recognizable carries no breakdown either (never an empty object).
// This is not a second walk: `Object.entries(modelUsage)` replaces the flat totals'
// `Object.values(modelUsage)` so the model name is available in the same iteration, rather
// than re-deriving the breakdown elsewhere. Measured motivation: 6 of 42 PLAN calls, measured
// 2026-09-10..12 while PLAN was Fable-only (PR #222 changes PLAN to Opus-first with a Fable
// fallback), spawned Opus subagents while the PLAN call itself resolved to `fable` -- see
// step-contracts.js's own comment on PLAN's `allowedTools` for the corrected, fuller-corpus
// measurement -- but this function already summed those subagents' tokens into the flat totals (the whole-tree
// accounting `modelUsage` itself provides), but the single `model` field on the journalled
// event named only `fable`, so every by-model view built off that field alone was wrong by the
// subagents' share. `modelUsage` is the fix: a reader that wants "how much did each model
// actually cost on this call" no longer has to guess from the resolved-model label.
function extractTokens(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return { ...ZERO_TOKENS };

  let found = false;
  let freshInputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let cacheCreationEphemeral1h = 0;
  let cacheCreationEphemeral5m = 0;
  const perModel = {};

  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!usage || typeof usage !== 'object') continue;
    const fi = pickNumber(usage, 'input_tokens', 'inputTokens');
    const cc = pickNumber(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens');
    const cr = pickNumber(usage, 'cache_read_input_tokens', 'cacheReadInputTokens');
    const out = pickNumber(usage, 'output_tokens', 'outputTokens');
    if (fi !== 0 || cc !== 0 || cr !== 0 || out !== 0) found = true;
    freshInputTokens += fi;
    cacheCreationTokens += cc;
    cacheReadTokens += cr;
    outputTokens += out;
    // Same billable formula as the flat total below (fresh input + cache-creation + output,
    // cache-read excluded -- see the flat `billableTokens` comment above for why), applied per
    // model instead of across the sum.
    perModel[model] = {
      freshInputTokens: fi,
      cacheCreationTokens: cc,
      cacheReadTokens: cr,
      outputTokens: out,
      billableTokens: fi + cc + out,
    };

    const nested = usage.cache_creation || usage.cacheCreation;
    if (nested && typeof nested === 'object') {
      const e1h = pickNumber(nested, 'ephemeral_1h_input_tokens', 'ephemeral1hInputTokens');
      const e5m = pickNumber(nested, 'ephemeral_5m_input_tokens', 'ephemeral5mInputTokens');
      if (e1h !== 0 || e5m !== 0) found = true;
      cacheCreationEphemeral1h += e1h;
      cacheCreationEphemeral5m += e5m;
    }
  }

  return {
    tokensSource: found ? 'modelUsage' : null,
    freshInputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    billableTokens: freshInputTokens + cacheCreationTokens + outputTokens,
    cacheCreationEphemeral1h,
    cacheCreationEphemeral5m,
    ...(found ? { modelUsage: perModel } : {}),
  };
}

// The token fields alone, lifted off an invokeClaudeReal result (or anything with the same
// shape) -- used every place below that needs to pass them along (a journal event, an error
// return) without repeating all nine names at every call site. Card #214 added the ninth,
// `modelUsage` (extractTokens's per-model breakdown) -- `raw.modelUsage` reads back `undefined`
// on any result extractTokens/ZERO_TOKENS never set it on, which JSON.stringify drops from the
// journalled line the same way it already drops an unset `duration_s` (see invokeClaudeReal's
// own comment), so a historical/not-found call journals no breakdown rather than a false one.
function tokenFieldsFrom(raw) {
  return {
    tokensSource: raw.tokensSource,
    freshInputTokens: raw.freshInputTokens,
    cacheCreationTokens: raw.cacheCreationTokens,
    cacheReadTokens: raw.cacheReadTokens,
    outputTokens: raw.outputTokens,
    billableTokens: raw.billableTokens,
    cacheCreationEphemeral1h: raw.cacheCreationEphemeral1h,
    cacheCreationEphemeral5m: raw.cacheCreationEphemeral5m,
    modelUsage: raw.modelUsage,
  };
}

// Token-ledger lot, action 4.3: recovers billable tokens for a call that really ran (sessionId
// set) but reported no modelUsage block (tokensSource: null) -- a deadline kill, an external
// signal kill, an unparsable reply, an is_error/non-zero-exit reply, or even a SUCCESSFUL call whose
// modelUsage happened to be empty/absent all land here identically. The decision to attempt
// recovery is made STRUCTURALLY -- sessionId is a non-empty string, tokensSource is falsy -- never
// by reading `error`/`result` text (see orchestrator/token-recovery.js's own header, and
// test/token-recovery.test.js's issue-439/issue-247 regression fixtures: a message that says
// "failed to spawn claude" for a call that in fact ran and was deadline-killed must not suppress
// recovery). token-recovery.js's recoverSessionTokens reads the session transcript `claude` itself
// wrote under that id and sums it through the SAME reader console/usage-scan.js's live dashboard
// uses (scanFile), so this can never disagree with that ledger.
//
// A5 (informational only, pinned by test/llm-real.test.js): every field on `result` other than the
// eight recovery-owned fields (tokensSource, freshInputTokens, cacheCreationTokens,
// cacheReadTokens, outputTokens, billableTokens, transcriptFilesRead, transcriptFilesSkipped) is
// returned byte-identical whether recovery finds something, finds nothing, or is never attempted
// at all (sessionId absent/null, or tokensSource already set) -- this function never touches
// kind/ok/error/timedOut/killedBySignal/deadlineMs/numTurns/durationS/raw.
//
// deps.recoverSessionTokens is the injection point, following this file's existing
// deps.query/deps.buildQueryOptions convention -- production passes nothing and gets the real
// module.
// Never throws itself: recoverSessionTokens's own contract is "never throw" (see its header), and
// the try/catch here is a backstop against that contract ever regressing, consistent with this
// file's own "only a programming error (bad opts) throws" rule.
//
// The guard below reads `result.tokensSource` FALSY, never `=== null`: extractTokens/ZERO_TOKENS
// always set it to exactly `null` when nothing was found, but a result object that simply OMITS
// the field entirely (undefined) must be treated the same way -- unmeasured, not skip-recovery --
// which is the safer of the two readings (a stricter `=== null` check would silently skip recovery
// for any future caller/shape that leaves the field absent instead of null).
//
// RULED ON, NOT CARRIED FORWARD BY DEFAULT (action A7, card #239 chantier, "token ledger on the
// SDK stream"). This action's own brief asked whether this whole function should be deleted: its
// premise was that "usage arrives on the stream with the SDK," so a call's `modelUsage` always
// comes from `consumeQueryStream`'s own `result` message now, making transcript recovery dead
// code left over from the retired `claude -p` transport. MEASURED, not assumed: that premise is
// true only of a call that produces a `result` message at all. sdk-call.js's own header (items 4
// and 5 on `consumeQueryStream`) already documents that a deadline kill, an external signal kill,
// and a stream that ends (cleanly or with a nonzero exit) with no `result` message are all real,
// reachable shapes on THIS transport -- every one of them still lands in `extractTokens(undefined)`
// (sdk-call.js), i.e. `tokensSource: null`, for exactly the same reason the old transport's
// equivalent branches did: there is no `modelUsage` block to read when the CLI never got to send
// one. test/token-recovery-e2e.test.js proves the WIRING end to end against a real `query()` call
// and a real spawned fixture standing in for `claude` -- for all four of those shapes, recovery
// (with `deps.recoverSessionTokens` NOT injected) finds the fixture's real, pre-written transcript
// tokens instead of reporting zero, and a fifth case (killed before the fixture ever wrote
// anything) correctly still returns `tokensSource: null`, never a fabricated zero.
//
// ONE PREMISE IN THAT PROOF IS A STRUCTURAL INFERENCE, NOT A MEASUREMENT, AND IS NAMED HERE SO IT
// DOES NOT QUIETLY BECOME ONE (Opus verifier, fix pass F2): the fixture writes its own transcript
// file because the TEST tells it to -- that proves "if a transcript exists on disk by the time a
// kill lands, this chain finds and sums it," not "the real `claude` binary, driven over
// `--input-format/--output-format stream-json`, actually persists one." Checked directly (this fix
// pass): every session transcript on this machine's pool was written by the daemon running release
// `41fb081` -- pre-cutover `claude -p` -- because the live daemon (`~/SPO-Pipeline`, a separate
// checkout from this chantier's worktree) has not pulled past `41fb081`, before A5b's cutover
// landed. No SDK-driven call has run against the real CLI binary yet, so no one has directly
// observed whether it still writes that file under the new wire protocol. The inference this
// ruling rests on is architectural, not empirical: it is the SAME `claude` binary either way, the
// transcript is that binary's own `--resume` bookkeeping (used by `console/usage-scan.js`'s live
// dashboard and `token-recovery.js` today, entirely independent of which flags drove a given
// call), and A5b's own session-id mint (invokeClaudeReal's `suppliedSessionId`, restored
// specifically so a killed call still has an id to search a transcript by) rests on this exact
// same premise -- so the two are settled together, not separately, by whichever lands first. This
// is A10's live-recette checklist's job, not this chantier's: the first real SDK-driven card that
// gets killed (a genuine deadline, not this file's own fixtures) is the observation that confirms
// or falsifies it. If it falsifies it, this ruling flips, and the transcript path really does need
// deleting then -- but the premise itself is not this action's to observe, since this chantier has
// not deployed against the real CLI yet.
//
// THE CORPUS FIGURE, CORRECTED (Opus verifier, fix pass F1): a first pass here counted 117 of 917
// `llm-call` events (12.8%) carrying `tokensSource: 'transcript'` and called that "not a rare
// corner ... the dominant shape recovery earns its keep on" because 92 of the 117 were `ok: true`.
// FALSE -- those 92 are not live `maybeRecoverTokens` output at all. They are the exact target set
// `scripts/backfill-legacy-tokens.js` (card #169) wrote retroactively: that script's own header
// names "exactly 92 events, 17 tasks, timestamps 2026-08-29T13:21:55.504Z ..
// 2026-08-31T08:39:23.895Z" for events journalled before token instrumentation began at
// 2026-09-01T06:24:27.014Z -- both boundary timestamps and the count match the corpus's 92
// `ok:true` transcript-sourced rows exactly, and none of the 92 carry `cacheCreationEphemeral1h`
// or `duration_s` (fields that did not exist yet when they ran) while all 92 carry the
// since-removed `costUsd` -- conclusive. Restricting to the LIVE era (`ts >=
// 2026-09-01T06:24:27.014Z`, the backfill's own instrumentation boundary) gives the real figure:
// **25 of 810 live `llm-call` events, 3.09%**, and every one of the 25 is `ok: false` -- ZERO live
// successful-call recoveries in this corpus. Of those 25: 5 recovered substantial, nonzero spend
// (241k-368k tokens each, `duration_s` ~1800s -- IMPLEMENT's own 30-minute step deadline, i.e.
// genuine deadline kills), and 20 recovered a real, measured 0 (fast ~2-4s `fable` failures whose
// transcript held one all-zero usage row -- the "found rows summing to 0" case this file's own
// header on `recoverSessionTokens` already distinguishes from "found no rows"). So "how often does
// this matter" is smaller than the first pass claimed, but the shape is exactly the one the
// end-to-end proof above targets -- kills and fast structural failures, not ordinary successes --
// which makes the ruling BETTER supported, not worse: recovery is not a rare corner case earning
// its keep on successes it was never needed for, it is caught doing precisely the job its own
// header describes, on every live occasion this corpus has given it to do so far.
//
// Conclusion: this function, its `deps.recoverSessionTokens` injection point, and
// `token-recovery.js` all stay. Removing them, as the card's own "Done means" asked for, would be
// a silent regression the moment the architectural premise above is confirmed: every call this
// transport's own deadline/signal/no-result paths produce would report `billableTokens: 0` for
// spend that genuinely happened, with nothing in the journal to tell a reader that from an honest,
// unmeasured `null`.
async function maybeRecoverTokens(result, opts, deps) {
  if (result.tokensSource || typeof result.sessionId !== 'string' || result.sessionId === '') {
    return result;
  }
  const recoverFn = deps.recoverSessionTokens || recoverSessionTokensDefault;
  let recovered = null;
  try {
    recovered = await recoverFn({
      sessionId: result.sessionId,
      accountConfigDir: opts.account && opts.account.configDir,
    });
  } catch {
    recovered = null;
  }
  if (!recovered) return result;
  return {
    ...result,
    tokensSource: recovered.tokensSource,
    freshInputTokens: recovered.freshInputTokens,
    cacheCreationTokens: recovered.cacheCreationTokens,
    cacheReadTokens: recovered.cacheReadTokens,
    outputTokens: recovered.outputTokens,
    billableTokens: recovered.billableTokens,
    // The one completeness signal recoverSessionTokens computes and this function used to drop on
    // the floor (token-ledger lot, action 4.3 fix): without these two, the journal records
    // "recovered N tokens" with no way to tell 1 file read from 1-of-100, the other 99 lost to an
    // error -- see token-recovery.js's own header on recoverSessionTokens for exactly which routes
    // increment transcriptFilesSkipped.
    transcriptFilesRead: recovered.transcriptFilesRead,
    transcriptFilesSkipped: recovered.transcriptFilesSkipped,
  };
}

// Action 3.5, replacing a `/limit|overloaded|rate/i` scan over the free text of parsed.result /
// parsed.terminal_reason (incident: any failure message merely containing "rate" -- "invalid
// rate parameter", "could not generate", "accurate output required", "corporate" -- was
// misclassified as a rate limit). The cost of one such false positive is not small:
// callLlmStep's response to 'limit' is to rotate to the NEXT account and re-pay the ENTIRE step
// on it, repeating across the whole pool, then cooling EVERY account for hours once exhausted --
// a single unlucky error message took the pool down.
//
// This trades that false positive away for an occasional false negative, deliberately: an
// unrecognised limit shape now falls through to 'error' and the task PARKS, which is one card a
// maintainer retries, versus a false positive that re-pays the step on every account in the pool
// and cools all of them. The failure result already carries `terminalReason` and
// `apiErrorStatus` (below), and both are journalled alongside the step's `result` payload -- so
// an unrecognised limit shape leaves exactly the evidence needed to extend the allowlist below.
// Extend it from THAT journal evidence, never from guesswork about what a message might say.
//
// Structured signals only, honestly labelled by how each entry earned its place (R7 -- a repo-
// wide sweep found this comment previously claimed the allowlist was "seeded from what this repo
// has actually observed plus the API's documented error type names", which overstated the
// evidence for more than one entry below):
//   - api_error_status 429 -- OBSERVED: the only recorded real limit in this repo,
//     intake.js:996-998's 12.8-hour Fable incident ("You've reached your Fable 5 limit",
//     api_error_status=429, 53 consecutive auto-triage cycles / 128 attempts).
//   - api_error_status 529 -- ANTICIPATED: Anthropic's documented "overloaded" status. Never
//     observed as a real reply in this repo; included because it is structured (not free text)
//     and documented, not because it has fired here.
//   - terminal_reason 'overloaded_error' -- ANTICIPATED: pinned only by a pre-existing
//     test/llm-real.test.js assertion, not a recorded reply.
//   - terminal_reason 'rate_limit_error' -- ANTICIPATED: the API's documented error type name
//     for a 429; the Fable incident above only recorded api_error_status, never this string, so
//     it has not actually been observed as a terminal_reason value in this repo either.
//   - terminal_reason 'usage_limit_reached' -- a GUESS, plainly: neither observed in this repo
//     nor a documented Anthropic error type. Kept anyway because an exact-match entry that never
//     fires costs nothing, and it's cheap insurance if that turns out to be the real string.
// terminal_reason is matched exactly against the allowlist (lowercased + trimmed), never a
// substring test -- extend it from journal evidence (a failure's terminalReason/apiErrorStatus
// are journalled alongside the step's result) as entries move from anticipated/guessed to
// actually observed, never from further guesswork about what a message might say.
// Everything else -> 'error', exactly as before.
const USAGE_LIMIT_TERMINAL_REASONS = new Set(['rate_limit_error', 'usage_limit_reached']);
const OVERLOADED_TERMINAL_REASONS = new Set(['overloaded_error']);

// R5 (F5): 429/529 used to be tested separately inside classifyFailure and limitKindForFailure,
// with nothing keeping the two in sync -- adding a status to one and not the other silently
// produced kind:'limit' with limitKind: undefined, i.e. the fail-safe long cooldown, exactly the
// case R2/F2 made visible rather than fixed on its own. One table now, consumed by both, the same
// way the terminal_reason Sets above are already shared (not duplicated) between the two
// functions and so cannot drift.
const LIMIT_STATUSES = new Map([
  [429, 'usage'],
  [529, 'overloaded'],
]);

function normalizedTerminalReason(parsed) {
  return typeof (parsed && parsed.terminal_reason) === 'string' ? parsed.terminal_reason.trim().toLowerCase() : '';
}

function classifyFailure(parsed) {
  if (!parsed) return 'error';
  if (LIMIT_STATUSES.has(parsed.api_error_status)) return 'limit';
  const reason = normalizedTerminalReason(parsed);
  if (USAGE_LIMIT_TERMINAL_REASONS.has(reason) || OVERLOADED_TERMINAL_REASONS.has(reason)) return 'limit';
  return 'error';
}

// Only meaningful once classifyFailure has already returned 'limit' -- splits WHICH kind of
// limit it was, so the caller (accounts.markLimit) can cool the account for the right amount of
// time instead of one guess covering both: 'usage' means THIS account's own quota is spent (429
// / rate_limit_error / usage_limit_reached); 'overloaded' means the SERVER is busy and this
// account's quota is fine (529 / overloaded_error). Returns undefined for a 'limit'
// classification that somehow matches neither bucket (cannot happen given LIMIT_STATUSES and the
// terminal_reason Sets above stay in sync with classifyFailure by construction -- there is
// nothing left for this function to duplicate -- but accounts.markLimit treats undefined as a
// fail-safe fallback to the usage tier regardless).
function limitKindForFailure(parsed) {
  if (!parsed) return undefined;
  if (LIMIT_STATUSES.has(parsed.api_error_status)) return LIMIT_STATUSES.get(parsed.api_error_status);
  const reason = normalizedTerminalReason(parsed);
  if (USAGE_LIMIT_TERMINAL_REASONS.has(reason)) return 'usage';
  if (OVERLOADED_TERMINAL_REASONS.has(reason)) return 'overloaded';
  return undefined;
}

// Card SPO-Pipeline#250 -- WHICH QUOTA a limit was drawn against, so the caller cools the right
// thing. The Anthropic usage quota has TWO kinds, not one:
//   - ACCOUNT-WIDE windows -- the 5-hour session limit and the weekly limit. Every model on the
//     account shares them, so switching model cannot get around one.
//   - PER-MODEL limits -- e.g. "You've reached your Fable limit. Switch to another model to
//     continue." The account's other models are still usable.
// Both reach the pipeline as api_error_status 429 / terminal_reason 'api_error', and in the
// `result` message only the reply TEXT tells them apart -- which this module never classifies on
// (see classifyFailure's header). The structured discriminator is the `rate_limit_event` the CLI
// emits BEFORE the synthetic assistant message and the `result`: `rate_limit_info.status ===
// 'rejected'` with a `rateLimitType` (MEASURED 2026-09-24 against the real CLI 2.1.280 through the
// vendored query(), recorded in test/fixtures/sdk-cli-exit1-error-results.json: session ->
// 'five_hour', weekly -> 'seven_day', Fable model limit -> 'seven_day_overage_included').
// sdk-call.js's consumeQueryStream captures the last REJECTED one; the event also fires on
// non-rejected status changes (`allowed_warning`, a window moving), which say nothing about why
// THIS call failed and are ignored there.
//
//   checked in this order                                       -> limitScope
//   rateLimitType 'five_hour' / 'seven_day'                     -> 'account' (cool every model)
//   rateLimitType 'seven_day_overage_included' /
//     'seven_day_opus' / 'seven_day_sonnet'                     -> 'model'   (that model only, #167)
//   apiError 'model_requires_usage_credits', or
//     errorCode 'credits_required'                              -> 'model'   (the cross-check below)
//   anything else: 'overage', another value, no rejected event  -> 'account' (the fail-safe)
//
// THE CROSS-CHECK (Opus verifier finding on #250, 2026-09-24). The CLI 2.1.280 takes its
// model-limit branch ("Switch to another model") when `rateLimitType === 'seven_day_overage_included'`
// OR when the 429 body's `error.details.error_code === 'credits_required'` -- and in that second
// case the header's rateLimitType may be absent or something else. On that branch it still marks
// the synthetic assistant message `api_error: 'model_requires_usage_credits'` (recorded: the Fable
// stream in test/fixtures/sdk-cli-exit1-error-results.json carries it; the two account-wide
// recordings carry `api_error: null`). Keying on rateLimitType alone would classify that case
// 'account' -- #167's regression, the account's other models cooled for nothing. 0 occurrences in
// the corpus; closed anyway. `apiError` / `errorCode` are TYPED fields, not reply text: the CLI's
// own schema describes `api_error` as the field for consumers that key on the cause instead of the
// message text, so reading them keeps classifyFailure's no-free-text rule. They are checked AFTER
// the account windows on purpose: an explicit five_hour/seven_day rejection is the stronger
// statement, and an account-wide window must never be narrowed to one model.
//
// Why the default is 'account', not 'model': accounts.markLimit's own fail-safe reasoning (see
// computeLimitUpdate's header). A wrong 'model' hands the next call on a DIFFERENT model straight
// back to an account whose shared window is spent -- a wasted call per other model per cooldown
// window, invisible except as a stream of `account-cooldown` events. A wrong 'account' costs the
// other models' capacity on that account for one cooldown window, visibly (`spo accounts`) -- and,
// since each model escalates off its own history, a wrong 'account' REPEATED within
// ESCALATION_WINDOW_MS (2h) escalates every model on the account to the 5-hour tier.
// 'overage' sits on the default side on purpose: it is not a per-model window by name, and
// nothing recorded says which models it covers. Only 'seven_day_overage_included' has been
// observed as a model limit; 'seven_day_opus' / 'seven_day_sonnet' are in the CLI 2.1.280 enum and
// per-model by name, never observed live.
//
// `limitKind === 'overloaded'` (529 / overloaded_error) has NO quota scope -- a busy server says
// nothing about this account's quota, and no rejected rate_limit_event accompanies it. It keeps
// exactly its pre-#250 behaviour: 'model', i.e. the flat 5-minute cooldown lands on the call's
// model only, as #167 made it.
//
// Extend the two Sets from recorded evidence (every journalled `account-cooldown` carries
// `rateLimitType`), never from a guess about what a new value means. Deliberately NOT in either
// Set: the CLI 2.1.280 enum also knows `seven_day_oauth_apps`, `seven_day_cowork` and
// `seven_day_omelette`. None is a per-model window by name, so all three fall to the 'account'
// default -- the right side for this pool, whose accounts are driven through OAuth tokens
// (a limit on the OAuth-apps window stops every model the token can reach).
const ACCOUNT_SCOPE_RATE_LIMIT_TYPES = new Set(['five_hour', 'seven_day']);
const MODEL_SCOPE_RATE_LIMIT_TYPES = new Set(['seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet']);
const MODEL_LIMIT_API_ERROR = 'model_requires_usage_credits';
const MODEL_LIMIT_ERROR_CODE = 'credits_required';
const LIMIT_SCOPE_DEFAULT = 'account';

// limitScopeFor(limitKind, rateLimitType, cause = {}) -- `cause.apiError` is the synthetic
// assistant message's `api_error`, `cause.errorCode` the rejected event's `rate_limit_info.errorCode`
// (both captured by sdk-call.js's consumeQueryStream; null/absent when the stream carried none).
function limitScopeFor(limitKind, rateLimitType, cause = {}) {
  if (limitKind === 'overloaded') return 'model';
  if (ACCOUNT_SCOPE_RATE_LIMIT_TYPES.has(rateLimitType)) return 'account';
  if (MODEL_SCOPE_RATE_LIMIT_TYPES.has(rateLimitType)) return 'model';
  const { apiError, errorCode } = cause || {};
  if (apiError === MODEL_LIMIT_API_ERROR || errorCode === MODEL_LIMIT_ERROR_CODE) return 'model';
  // 'overage', an unrecognised value, or null (no rejected event, no model-limit cause): the fail-safe.
  return LIMIT_SCOPE_DEFAULT;
}

// The real-mode primitive: drive `query()`, reduce its message stream, classify, return. Never
// throws on a failed/limited/malformed/timed-out call -- those come back as {ok: false, kind,
// ...}; only a programming error (bad opts -- a missing prompt, a malformed sessionId, an
// unreadable oauthTokenFile is NOT a programming error and does NOT throw, see below) throws.
//
// Rewritten by action A5b (card #239 chantier) to drive the vendored Claude Agent SDK instead of
// `spawnSync('claude', buildArgv(opts), ...)` -- see this file's own header for the full
// deadline/abort design this replaced, and orchestrator/steps/sdk-call.js's own header for the
// buildQueryOptions/consumeQueryStream/spawnClaudeCodeProcess/confirmProcessExit machinery this
// function drives.
async function invokeClaudeReal(opts, deps = {}) {
  // "Both, not either" (sdk-call.js's own spawnClaudeCodeProcess throw is the defense-in-depth
  // half; this is the fast, clean-shape half). Checked FIRST, before anything else in this
  // function touches the account/oauth-token file or builds a single option -- an armed run must
  // never even attempt to resolve `claude` on PATH.
  const isEnabledFn = deps.isNoRealSpawnEnabled || isNoRealSpawnEnabled;
  if (isEnabledFn(process.env)) {
    return {
      ok: false,
      kind: 'error',
      error:
        'llm.js: SPO_NO_REAL_SPAWN is set -- refusing to start a real query() call instead of ' +
        'silently reaching `claude` with live credentials. See orchestrator/no-real-spawn-guard.js.',
      sessionId: null,
      ...ZERO_TOKENS,
      numTurns: undefined,
      raw: undefined,
    };
  }

  const {
    buildQueryOptions: buildQueryOptionsFn,
    consumeQueryStream: consumeQueryStreamFn,
    confirmProcessExit: confirmProcessExitFn,
    ABORT_CONFIRM_GRACE_MS: abortConfirmGraceMs,
    OauthTokenUnreadableError,
    ClaudeExecutableNotFoundError,
    JsonSchemaParseError,
  } = getSdkCall();
  const buildOptions = deps.buildQueryOptions || buildQueryOptionsFn;

  // Session id parity, restored (card #239 chantier, action A5b-2 fix pass, Job 2). The old
  // spawnSync transport minted a UUID and passed it as `--session-id` BEFORE every spawn, which is
  // the only reason a call killed before `claude` ever wrote a line still had an id for
  // token-recovery.js to search a transcript by (see that file's own header). The A5b cutover
  // dropped this: `opts.sessionId` was passed through only when a caller already supplied one,
  // otherwise `buildQueryOptions` omitted the option and let the CLI mint its own, reported back
  // only once the `system`/`init` message arrived -- so a call killed before that message had NO
  // session id at all, a real loss of the guarantee recovery exists for (see token-recovery.js's
  // own "STALE CLAIM CORRECTED" paragraph, written by the fix pass that found this).
  //
  // Restored here, at the same point in the sequence the old transport minted it (immediately
  // before the call is actually attempted, after every earlier check -- killswitch above -- that
  // can still return sessionId: null for a call that never starts at all): opts.sessionId, when
  // the caller already supplied one (a non-empty string), is used verbatim and nothing is
  // generated -- deps.randomUUID (falling back to node's own crypto.randomUUID, following this
  // file's existing deps.query/deps.buildQueryOptions/deps.randomUUID injection convention -- the
  // OLD transport's deps.spawnSync is gone from this file, deleted along with buildArgv, not
  // merely renamed) is not even called in that case,
  // same as the old transport's own pin. A supplied sessionId that is a non-empty string but not
  // UUID-v4 shaped is left untouched here -- buildQueryOptions below still throws its own bare
  // TypeError for it (reason 3 of the five), exactly the "programming error, not a call failure"
  // contract this file has always applied to that field; minting must never paper over a caller's
  // malformed input.
  const randomUUIDFn = deps.randomUUID || randomUUID;
  const suppliedSessionId =
    typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : randomUUIDFn();
  if (opts.sessionId !== suppliedSessionId) {
    opts = { ...opts, sessionId: suppliedSessionId };
  }

  // buildQueryOptions throws for exactly five reasons (see its own header): a missing prompt
  // (bare Error) and a malformed opts.sessionId (bare TypeError) are PROGRAMMING errors and must
  // propagate exactly as this function always has for both; OauthTokenUnreadableError,
  // ClaudeExecutableNotFoundError and JsonSchemaParseError are the three the old transport's
  // invokeClaudeReal already treated as ordinary step failures (an unreadable oauthTokenFile
  // could always happen; the other two are new failure modes this transport specifically
  // introduces -- no `claude` resolved on PATH, or a malformed jsonSchema string caught before
  // ever reaching the CLI instead of after) -- caught here and mapped onto the same
  // `{ok:false, kind:'error', ...}` shape every other real-mode failure in this file already uses.
  let built;
  try {
    built = buildOptions(opts, deps);
  } catch (err) {
    if (
      err instanceof OauthTokenUnreadableError ||
      err instanceof ClaudeExecutableNotFoundError ||
      err instanceof JsonSchemaParseError
    ) {
      return {
        ok: false,
        kind: 'error',
        error: err.message,
        sessionId: null,
        ...ZERO_TOKENS,
        numTurns: undefined,
        raw: undefined,
      };
    }
    throw err;
  }
  const { prompt, options, getSpawnedProcess } = built;

  // Card #239 action A5a's choke point, moved from immediately-before-the-old-spawn to
  // immediately-before query() itself -- this transport's equivalent point, and still the ONE
  // place every real LLM call attempt is counted (see recette.js's makeCap and this call site's
  // own A5a-era comment history for why it has to be here and not, say, inside buildQueryOptions,
  // which can be called by a caller that never actually starts a query).
  if (typeof deps.onLlmCallAttempt === 'function') {
    deps.onLlmCallAttempt();
  }

  const queryFn = deps.query || (await loadQuery());
  const startedAtMs = monotonicNowMs();

  let stream;
  try {
    stream = queryFn({ prompt, options });
  } catch (err) {
    // query() throws SYNCHRONOUSLY, before any child exists, for every failure mode this repo's
    // own measurements found (sdk-call.js's ClaudeExecutableNotFoundError comment and its
    // spawnClaudeCodeProcess header) -- including the killswitch's own ENOREALSPAWN throw, the
    // defense-in-depth half of the check at the top of this function.
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: query() failed to start: ${err && err.message}`,
      sessionId: null,
      ...ZERO_TOKENS,
      numTurns: undefined,
      durationS: (monotonicNowMs() - startedAtMs) / 1000,
      raw: undefined,
    };
  }

  // Deadline ownership -- see this file's own header for the full design and what it was measured
  // against. Arms a real timer; on expiry, aborts the SAME AbortController buildQueryOptions built
  // for this call (one per call, never reused -- see that function's own comment). Cleared the
  // moment the stream settles for ANY reason, so a call that finishes before its deadline never
  // pays for an unused timer.
  //
  // Deliberately NOT `.unref()`d, despite an earlier draft of this comment arguing the opposite.
  // CORRECTED (Opus verifier, fix pass F3): that earlier draft attributed the fix to THIS timer
  // being ref'd -- false as shipped. MEASURED (fix pass F3, 2026-09-17): restoring `.unref()` on
  // this timer AND on sdk-call.js's confirmProcessExit timer, while leaving test/helpers.js's own
  // fake child untouched, still passes all 90 llm-real.test.js/llm-real-card.test.js tests -- so
  // ref'ing these two timers is, by itself, INERT; it fixes nothing on its own. The actual cure is
  // test/helpers.js's `fakeSpawnedChild`'s own `keepalive` interval, which is ref'd on purpose: a
  // fake/in-memory child (no real OS pipe handle) has nothing else to keep the event loop open, and
  // unref'ing THAT one interval (with both production timers left exactly as shipped) is what
  // reproduces the hang -- measured at 60/81 passing, 21 cancelled ("Promise resolution is still
  // pending but the event loop has already resolved"), exit code 1, not a quiet hang. That failure
  // mode is what makes this pattern safe to propagate to the 18+ files migrating next: a
  // mis-built/mis-wired fake child fails LOUDLY (cancelled tests, non-zero exit), it does not pass
  // silently while leaving a real hang uncovered.
  //
  // This timer stays ref'd anyway, for a DIFFERENT and better reason than the one the earlier
  // draft gave: the vendored SDK's own internal kill-escalation timers (ProcessTransport.close(),
  // see sdk-call.js's own SDK_ABORT_KILL_DELAY_MS/SDK_ABORT_SIGKILL_ESCALATION_MS header) are
  // THEMSELVES unref'd in the vendored source -- so *something* ref'd has to hold the event loop
  // open for the SDK's own SIGTERM/SIGKILL escalation to have a chance to land at all, in any
  // process (real or test) that has nothing else keeping it alive at that moment. In PRODUCTION
  // this is moot either way: the real child's stdio pipes (spawnClaudeCodeProcess's own real
  // `child_process.spawn`) are ref'd by Node's own default and already keep the loop alive for as
  // long as the call is genuinely in flight, so this timer being ref'd too changes nothing
  // observable there -- it is cleared in the `finally` below well before this function returns
  // either way.
  let deadlineHit = false;
  let deadlineTimer = null;
  if (typeof opts.deadlineMs === 'number' && opts.deadlineMs > 0) {
    deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      options.abortController.abort();
    }, opts.deadlineMs);
  }

  // Card #239 chantier, action A6: live-progress.js's own onMessage seam, attached only when the
  // caller supplied a taskDir (runLlm always does for a real card; a handful of hand-built test
  // contexts that call invokeClaudeReal directly do not, and simply get no progress recording --
  // the same "degrades to nothing extra" posture the old transcript probe had for a step it could
  // not identify). Built fresh per call (never reused across two invokeClaudeReal calls) because
  // its accumulated turn/tool/text state belongs to exactly one query() stream.
  const onMessage = opts.taskDir
    ? createProgressCallback({ taskDir: opts.taskDir, step: opts.step, account: opts.account && opts.account.name })
    : null;

  let consumed;
  try {
    consumed = await consumeQueryStreamFn(stream, onMessage ? { onMessage } : {});
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    // Cleared unconditionally here, not only on a success path -- a step that finished by
    // failure, limit, or deadline timeout is exactly as finished as one that succeeded, and must
    // not leave a record a reader could mistake for still-live work (card #239's Done means, this
    // action's own brief, verbatim). The one path this cannot cover is a hard crash (kill -9)
    // between a write and this line -- see live-progress.js's own LIVE_PROGRESS_STALE_MS comment
    // for the bound that covers that case instead.
    if (opts.taskDir) clearLiveProgress(opts.taskDir);
  }

  // The CLI's own reported id wins over the one we supplied, falling back to ours (Job 2, restoring
  // the old transport's `reportedSessionId = parsed.session_id || parsed.uuid || sessionId` pin --
  // see this file's own comment above where `suppliedSessionId` is resolved). `consumed.sessionId`
  // is whatever `consumeQueryStream` read off a `system`/`init` or `result` message -- null only
  // when the stream never got far enough to see either (e.g. killed before the first line), never
  // fabricated ahead of that evidence. By this point `queryFn` has already been called and returned
  // a stream -- every branch that follows (the thrown/no-result/is_error/success shapes
  // `consumeQueryStream` can return) represents a call that really started, so falling back to
  // `suppliedSessionId` here can never resurrect a session id for a call that never spawned (those
  // all return `sessionId: null` earlier in this function, before `queryFn` is ever reached, and are
  // untouched by this line).
  if (!consumed.sessionId) {
    consumed = { ...consumed, sessionId: suppliedSessionId };
  }

  // THE PROPERTY THIS ACTION EXISTS TO PROVE. MEASURED (this action, live probes against the real
  // vendored SDK -- see this file's own header and sdk-call.js's for the numbers): the async
  // iterator/stream can settle well BEFORE the real child process has actually exited -- an
  // abort-triggered rejection was measured landing ~5-7s ahead of the process's own confirmed
  // death. So this function never treats "the stream ended" as "the call is over": it always
  // confirms the real child's exit before deciding what to return, because its own caller
  // (state-machine.js's callLlmStep) releases this call's account lease in a `finally` immediately
  // after this function returns -- a live `claude` still holding that lease's CLAUDE_CONFIG_DIR at
  // that moment is exactly the race lock.js's "never two claude processes on one CLAUDE_CONFIG_DIR"
  // rule exists to prevent.
  //
  // COST, STATED PLAINLY (Opus verifier, fix pass F10; an earlier draft of this paragraph cited
  // "confirmProcessExit's own comment for why this is cheap on the ordinary path" -- that comment
  // states no such reason, so the claim was unbacked). MEASURED (fix pass F10, fakeSpawnDeps probe,
  // deleted after use, not committed): a cooperative child that replies and exits promptly confirms
  // in ~243ms -- confirmProcessExit reads `.exitCode`/`.signalCode` synchronously once the 'exit'
  // event has fired, so this really is close to free. But a `claude` that emits its `result`
  // message and then LINGERS (never exits on its own) is NOT cheap: this function still waits out
  // the abort/kill escalation before giving up -- measured ~4035ms at `deadlineMs=2000`, returning
  // `ok:false, timedOut:true` despite a structurally valid reply already having arrived. Bounded
  // (never past ABORT_CONFIRM_GRACE_MS) and correctly classified (the reply is discarded, not
  // silently returned as a success), and symmetric with the old spawnSync transport's own
  // equivalent wait -- so not a regression -- but it is a real cost on that path, not a near-zero
  // one, and this paragraph now says so instead of citing a reason that was never written down.
  // CORRECTION, card SPO-Pipeline#254 (2026-09-24): "the reply is discarded" above is no longer
  // true. Since #254, a `result` that arrived before the abort's throw is classified by
  // consumeQueryStream, and the deadline branch below spreads that into its timeout shape -- so
  // `result`, `apiErrorStatus` and `terminalReason` survive there as diagnostic detail. What still
  // holds: the call is never returned as a success (`ok:false, kind:'error', timedOut:true`
  // overrides it), and `limitKind` is dropped (see the deadline branch's own comment).
  // F8 (Opus verifier, fix pass): sdk-call.js's own header advertises this as backward compatible
  // with a caller/`deps.buildQueryOptions` that returns the pre-A5b `{ prompt, options }` shape
  // (no `getSpawnedProcess` at all) -- but an unconditional `getSpawnedProcess()` call here throws
  // `TypeError: getSpawnedProcess is not a function` on exactly that input instead of failing into
  // this file's own `{ok:false, kind:'error', ...}` contract, a real gap for the 18+ files about to
  // start injecting `deps` here (A5b-2). Guarded rather than assumed present; confirmProcessExitFn
  // already treats `undefined` as vacuously confirmed (sdk-call.js's own confirmProcessExit: "child
  // may be undefined ... treated as vacuously confirmed, since there is no process to wait for"),
  // so this degrades exactly the way an absent capture already does, not a new code path.
  const spawnedChild = typeof getSpawnedProcess === 'function' ? getSpawnedProcess() : undefined;
  const exitInfo = await confirmProcessExitFn(spawnedChild, abortConfirmGraceMs);
  const durationS = (monotonicNowMs() - startedAtMs) / 1000;

  if (deadlineHit) {
    // Honest, not optimistic (maintainer's own instruction, this action's design review): a false
    // "killed" is worse than a true "could not confirm" -- `killConfirmed` says which one this is,
    // separate from `timedOut` (which only ever means "we decided to cancel this call", not
    // "and it is definitely dead now"). intake.js's retry policy and a maintainer reading a park
    // both need `timedOut` for the same reason they always have (see this file's own header);
    // `killConfirmed`/`killedBySignal`/`signal` are the exit=143-equivalent diagnostic this
    // transport otherwise has no home for (consumeQueryStream's own header decision 1: `raw` is
    // always undefined here, so there is no OS exit code to read "someone killed this" off of the
    // way the old transport's isSpawnKilled branch could).
    //
    // Card SPO-Pipeline#254 (2026-09-24): `consumed` can now carry a classified `result` -- a child
    // that wrote its `result` and then hung until this deadline. `ok`/`kind` are overridden below
    // (a timeout is `kind:'error'`, whatever the `result` said), and `limitKind` is DROPPED here:
    // a timeout must never read as a limit anywhere, even to a reader that looks at `limitKind`
    // without checking `kind` first (callLlmStep and callIntakeStepWithRotation both check `kind`
    // first, but this shape does not rely on that). `result`, `apiErrorStatus` and `terminalReason`
    // are kept on purpose, as diagnostic detail: they say what the CLI reported before the hang.
    // Card SPO-Pipeline#250: `limitScope` is dropped with `limitKind` for the same reason (it is
    // the other half of the limit classification); `rateLimitType` is kept, as diagnostic detail,
    // alongside `apiErrorStatus`.
    const { limitKind: _droppedLimitKind, limitScope: _droppedLimitScope, ...consumedForTimeout } = consumed;
    const timeoutResult = exitInfo.confirmed
      ? {
          ...consumedForTimeout,
          ok: false,
          kind: 'error',
          timedOut: true,
          killConfirmed: true,
          killedBySignal: exitInfo.signal != null,
          signal: exitInfo.signal,
          deadlineMs: opts.deadlineMs,
          error:
            `llm.js: claude ran but exceeded the ${opts.deadlineMs}ms deadline and was killed ` +
            `(confirmed${exitInfo.signal ? `, signal ${exitInfo.signal}` : ''})`,
        }
      : {
          ...consumedForTimeout,
          ok: false,
          kind: 'error',
          timedOut: true,
          killConfirmed: false,
          deadlineMs: opts.deadlineMs,
          error:
            `llm.js: claude ran but exceeded the ${opts.deadlineMs}ms deadline; abort() was sent ` +
            `but the process did not confirm exit within the ${abortConfirmGraceMs}ms grace window ` +
            '-- it may still be running',
        };
    return maybeRecoverTokens({ ...timeoutResult, ...ZERO_TOKENS, numTurns: undefined, durationS, raw: undefined }, opts, deps);
  }

  // Not a deadline kill. An EXTERNAL signal (an operator's kill, an OOM kill, a service manager
  // stopping the worker -- KillMode=mixed makes this rarer than it once was, see the old
  // transport's own comment history, but the classification is still correct when it happens)
  // reaches this function as a stream throw (sdk-call.js header item 4: kind:'error'; item 4b, #254:
  // classified off the `result` when one arrived before the kill) with an honest message; enriched
  // with killedBySignal/signal when the directly-captured handle confirms a real signal killed it
  // -- the same distinction the old transport's isSpawnKilled branch existed to draw, preserved in
  // meaning even though the mechanism (a captured ChildProcess handle, not a spawnSync result
  // object) is entirely new.
  //
  // DELIBERATE DEPARTURE from the old transport -- decided 2026-09-24, #254 review. A signal that
  // lands AFTER an error `result` (e.g. a 429 `result`, then SIGTERM before the CLI exits on its
  // own) now returns that `result`'s classification -- `kind:'limit'` with its `limitKind` --
  // plus `killedBySignal:true`. The old `claude -p` transport tested isSpawnKilled BEFORE parsing
  // stdout, so the same sequence came back `kind:'error'`. Kept on purpose: the limit genuinely
  // happened (the CLI said so before the kill), so cooling that account and rotating is the right
  // response; reporting it as a transport error would retry a limited account. `kind` is left as
  // consumeQueryStream classified it -- this branch only adds the signal detail.
  if (!consumed.ok && exitInfo.confirmed && exitInfo.signal != null) {
    return maybeRecoverTokens(
      { ...consumed, killedBySignal: true, signal: exitInfo.signal, durationS },
      opts,
      deps
    );
  }

  // durationS here OVERRIDES whatever consumeQueryStream itself set (the SDK's own `duration_ms`,
  // when present) with this function's own monotonicNowMs()-based measurement -- same policy the
  // old transport's header documented for preferring a monotonic clock over anything the CLI
  // itself reports, for the same reason (this host's CLOCK_REALTIME demonstrably steps; see that
  // paragraph, unchanged, elsewhere in this file's header).
  return maybeRecoverTokens({ ...consumed, durationS }, opts, deps);
}

// snake_case -> camelCase, e.g. "root_cause" -> "rootCause". Used to bridge one real gap: every
// prompt file's declared JSON keys are snake_case, but state-machine.js's handlers were written
// against shadow mode's fixtures, which are camelCase for the one step where the two differ
// (DIAGNOSE: llm.DIAGNOSE fixtures use `rootCause`, diagnose.md's contract says `root_cause`).
// Every other step's key names already match by coincidence (verdict, findings, ...), so this
// is a no-op for them. Applied additively -- the original snake_case keys are always kept too,
// never replaced -- so nothing that reads the contract's own field names loses them.
function snakeToCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function withCamelAliases(payload) {
  const aliased = {};
  for (const [key, value] of Object.entries(payload)) {
    const camel = snakeToCamel(key);
    if (camel !== key) aliased[camel] = value;
  }
  return { ...aliased, ...payload };
}

// The minimal object that satisfies stepName's outputContract.required, for --dry-run: real
// enough to walk the state machine to DONE, never a stand-in for an actual judgement. Every
// shape carries `dryRun: true` so nothing downstream can mistake it for a real verdict.
//
// PLAN's plan_markdown/invariants_markdown cannot be empty here even though nothing ever reads
// the *content* for real in a dry run: handlePlan (state-machine.js) validates both are non-empty
// strings and writes them to scratch_dir/plan-<issue>.md / invariants-<issue>.md exactly as a
// real PLAN reply would, then journals the resulting plan_path/invariants_path -- task-values.js's
// IMPLEMENT/VALIDATE derivation reads those paths back from that journal on the *next* dry-run LLM
// call in the same walk. An empty string would fail handlePlan's own validation as "plan invalid"
// and PARK the very walk --dry-run exists to complete end to end.
function cannedDryRunPayload(stepName, contract, ctx) {
  const base = { ok: true, dryRun: true };
  switch (stepName) {
    case 'PLAN': {
      const issue = (ctx.task && ctx.task.issue) || 'unknown';
      return {
        ...base,
        plan_markdown: `# Plan (dry run)\n\n[dry-run] no real plan was composed for issue ${issue}.\n`,
        invariants_markdown: `# Invariants (dry run)\n\n[dry-run] no invariants were composed.\n`,
        invariant_ids: [],
        check_commands: [],
        // D2: files_to_change is optional (step-contracts.js), so this hand-written case -- which
        // does not go through the generic `required.reduce` default below -- used to omit it
        // entirely. handlePlan (state-machine.js) then journalled a false 'plan-files-undeclared'
        // event on EVERY --dry-run PLAN, poisoning the exact evidence (grep -c
        // plan-files-undeclared) that a real key-absence would be measured from. An empty array
        // is the clean declaration ("this dry run changes nothing"): no event, no park.
        files_to_change: [],
      };
    }
    case 'IMPLEMENT':
      return {
        ...base,
        summary: '[dry-run] no changes made',
        files_changed: [],
        invariants: [],
        tests_run: [],
        all_green: true,
      };
    case 'DIAGNOSE':
      return { ...base, root_cause: null, reason: '[dry-run] diagnose not performed' };
    case 'CITATION_VERIFIER':
      return { ...base, verdict: 'PASS', entries: [] };
    case 'VALIDATE':
      return { ...base, verdict: 'PASS', reasons: ['[dry-run] no verdict rendered'], findings: [] };
    default:
      // Defensive: every step in STEP_CONTRACTS is handled above; this only fires for a step
      // this module doesn't know about, and still satisfies whatever outputContract asked for.
      return contract.outputContract.required.reduce((acc, key) => ({ ...acc, [key]: null }), base);
  }
}

// Writes journal/<id>/dryrun-<STATE>.md: since action A5b, the `query()` OPTIONS this call would
// actually have been built with (the old transport's argv array is gone along with buildArgv --
// see this file's own header) plus the filled prompt text, so a --dry-run run can be inspected
// without ever having called the CLI. `options` here is real, not synthetic: it is
// buildQueryOptions's own output for these exact opts (see the call site below), so this artifact
// can never silently drift from what a real call would build -- there is only the one mapping
// function, used both times.
//
// `env` is DELIBERATELY EXCLUDED from what gets written. `options.env` (sdk-call.js's buildEnv)
// carries the full ambient process.env plus, when an account resolved, that account's live
// CLAUDE_CODE_OAUTH_TOKEN -- a credential, not debugging information, and this file is written
// under journal/<id>/, readable by anyone who can read the journal. The old transport's own
// dry-run artifact never carried env either (buildArgv never saw it -- invokeClaudeReal built the
// child's env entirely separately, never touching buildArgv's return value), so this preserves
// that same safety property under the new shape rather than introducing a leak the old artifact
// never had. `abortController` (an AbortController instance) and `spawnClaudeCodeProcess` (a
// function) are call MACHINERY, not information about what would be SENT to `claude` -- dropped
// for the same "show what would actually be sent" reason this whole rewrite exists for, not for
// safety.
function writeDryRunArtifact(taskDir, stepName, options, promptText) {
  const file = path.join(taskDir, `dryrun-${stepName}.md`);
  const { env, abortController, spawnClaudeCodeProcess, ...displayableOptions } = options;
  const body = [
    `# Dry run -- ${stepName}`,
    '',
    '## query() options',
    '```json',
    JSON.stringify(displayableOptions, null, 2),
    '```',
    '',
    '## filled prompt',
    '```',
    promptText,
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(file, body);
  return file;
}

// resolveCallModel(ctx, stepName) -- WHICH model this step's `query()` call will actually run
// on (the `--model` value buildQueryOptions puts on the vendored SDK's argv), answered BEFORE the
// call, from the same two inputs runLlm below answers it from.
//
// Card #167 needs this because cooldowns are now per (account, model): state-machine.js's
// callLlmStep has to lease an account healthy for the model it is about to spend, and cool THAT
// model's quota when the call comes back `{kind: 'limit'}`. Resolving it there by reaching for
// the step contract alone would have been wrong, and silently: runLlm has TWO branches, and the
// legacy `ctx.task.llm.<step>` override branch (hand-authored real-mode task files, and this
// suite's own account-rotation/llm-real tests) takes its model from the override, NOT from the
// contract. A callLlmStep that leased for the contract's model while the spawn ran on the
// override's would cool a quota nobody spent and leave the one that actually limited hot -- the
// exact class of bug this card exists to remove, reintroduced one layer up.
//
// So the precedence here mirrors runLlm's own, branch for branch: an override present at all
// wins (including one that names no model -- runLlm then puts `model: undefined` in its opts,
// sdk-call.js's buildQueryOptions drops a falsy model (`if (opts.model)`), no `--model` reaches
// the argv and the CLI runs its own default; an honest `undefined` here makes markLimit fall back
// to cooling every model, which is the safe direction). `|| undefined` mirrors that same
// truthiness test, so an override's empty-string model -- which also sends no `--model` -- cannot
// cool a key named '' while the default model that really ran stays hot. Otherwise the step
// contract decides, escalation flags and all.
//
// Deliberately NOT called from runLlm's own two branches. Each keeps its own independent
// expression, so test/accounts-per-model-cooldown.test.js's correspondence check compares two
// separately-written derivations against each other rather than one function against itself --
// a single shared helper would agree with itself even after a mutation broke both.
function resolveCallModel(ctx, stepName) {
  const override = ctx && ctx.task && ctx.task.llm && ctx.task.llm[stepName];
  if (override) return override.model || undefined;
  return resolveStepContract(stepName, (ctx && ctx.task) || {}).model;
}

async function runLlm(ctx, stepName, fixtureKey, deps = {}) {
  if (ctx.shadowMode) {
    const payload = ctx.fixture(fixtureKey, null);
    const delay = ctx.fixture(`delays.${stepName}`, 0);
    if (delay > 0) await sleep(delay);
    return payload;
  }

  // No implicit default account here (maintainer decision, 2026-08-29 -- see accounts.js):
  // real mode always reaches this with ctx.account already set by callLlmStep's account-
  // rotation loop. ctx.account stays null only for a handful of hand-built test contexts that
  // call runLlm directly without going through callLlmStep -- invokeClaudeReal treats a null
  // account the same as one with no configDir override (ambient `claude` credentials), which
  // is fine for those unit tests but is never what production real mode does.
  const account = ctx.account || null;
  const override = ctx.task && ctx.task.llm && ctx.task.llm[stepName];

  if (override) {
    // Legacy interim path: a task file supplying ctx.task.llm.<step> directly, honoured
    // verbatim with no template fill and no outputContract validation. Kept for backward
    // compatibility with hand-authored real-mode task files and this suite's own
    // test/llm-real.test.js / test/account-rotation.test.js, which construct exactly this
    // shape and assert on it. A `kind: "card"` task should not set ctx.task.llm.<step> -- see
    // the branch below, which is the real path step-contracts.js + prompt-template.js drive.
    const cwd =
      override.cwd ||
      config.cwdForStep(stepName, {
        worktreePath: ctx.task && ctx.task.worktreePath,
        repoRoot: REPO_ROOT,
      });

    const opts = {
      step: stepName,
      model: override.model,
      effort: override.effort,
      allowedTools: override.allowedTools,
      // Card #240: honoured verbatim like every other field on this legacy path -- a
      // hand-authored task file that sets neither gets the pre-#240 argv, unchanged.
      disallowedTools: override.disallowedTools,
      permissionMode: override.permissionMode,
      maxBudgetUsd: override.maxBudgetUsd,
      jsonSchema: override.jsonSchema,
      promptText: override.promptText,
      promptFile: override.promptFile,
      cwd,
      account,
      // Card #239 action A6: threaded through so invokeClaudeReal can attach live-progress.js's
      // per-message callback and clear its record when the call ends. Absent only for the
      // handful of hand-built test contexts that call runLlm with no ctx.taskDir at all -- see
      // invokeClaudeReal's own comment on why that degrades to "no progress recording" rather
      // than a throw.
      taskDir: ctx.taskDir,
      // Per-step (PLAN and IMPLEMENT 1800000ms, every other step 900000ms). This legacy override
      // path has no resolved contract to read the figure off, so it asks step-contracts directly
      // -- same source, so the two paths can never disagree about how long a call may run.
      deadlineMs: deadlineMsForStep(stepName),
    };

    const result = await invokeClaudeReal(opts, deps);

    appendEvent(ctx.taskDir, stepName, 'llm-call', {
      step: stepName,
      model: opts.model,
      effort: opts.effort,
      account: account && account.name,
      sessionId: result.sessionId,
      ...tokenFieldsFrom(result),
      // Present only on a call maybeRecoverTokens actually recovered (undefined otherwise, which
      // JSON.stringify drops from the journal line, same convention as duration_s below) -- see
      // maybeRecoverTokens' own comment for why these two are carried alongside the six token
      // fields instead of folded into tokenFieldsFrom.
      transcriptFilesRead: result.transcriptFilesRead,
      transcriptFilesSkipped: result.transcriptFilesSkipped,
      // Card #214: `numTurns` is deliberately NOT journalled here -- see the comment at
      // `parsed.num_turns`'s own read site in invokeClaudeReal for why (it is dropped from the
      // event, not from `result` -- `result.numTurns` is still a real field on the object above,
      // just never written into this journal line). `runLlm`'s override branch below returns
      // `result` (and therefore `result.numTurns`) to its caller unchanged.
      // duration_s: spelled with the underscore doc/state-machine-spec.md's Observability
      // section already used to describe this event, not tokenFieldsFrom's camelCase convention
      // -- see invokeClaudeReal's own comment for why it's measured around the spawn and present
      // on every branch (success, error, signal, deadline timeout) except the one where `claude`
      // never actually ran (an unreadable oauthTokenFile) -- undefined there, which
      // JSON.stringify drops from the journal line rather than writing a false "0s".
      duration_s: result.durationS,
      ok: result.ok,
    });

    return result;
  }

  // Real `kind: "card"` path: step-contracts.js supplies model/effort/tools/budget/schema,
  // prompt-template.js fills the step's own prompts/<file>.md from task-values.js's
  // placeholder derivation.
  const contract = resolveStepContract(stepName, ctx.task || {});

  let promptText;
  try {
    const values = buildPromptValues(ctx, stepName);
    promptText = fillPromptTemplate(contract.promptFile, values);
  } catch (err) {
    if (err instanceof MissingPlaceholderError) {
      throw new ParkSignal(`prompt-missing-placeholder:${err.placeholder}`, {
        step: stepName,
        promptFile: err.promptFile,
        placeholder: err.placeholder,
        missing: err.missing,
      });
    }
    throw err;
  }

  const cwd = config.cwdForStep(stepName, {
    worktreePath: ctx.task && ctx.task.worktreePath,
    repoRoot: REPO_ROOT,
  });

  const opts = {
    step: stepName,
    model: contract.model,
    effort: contract.effort,
    allowedTools: contract.allowedTools,
    disallowedTools: contract.disallowedTools, // card #240 -- see orchestrator/bash-policy.js
    permissionMode: contract.permissionMode,
    maxBudgetUsd: contract.maxBudgetUsd,
    jsonSchema: contract.jsonSchema,
    promptText,
    cwd,
    account,
    deadlineMs: contract.deadlineMs,
    // Card #239 action A6 -- see the override branch above's identical field for why.
    taskDir: ctx.taskDir,
  };

  if (ctx.dryRun) {
    // A dry run never calls query(), so `opts` here carries no sessionId (only a caller that
    // actually intends to spawn ever supplies or lets invokeClaudeReal's own resolution generate
    // one). Calling buildQueryOptions(opts) unmodified would then omit `options.sessionId`
    // entirely, showing options that are not what a real call would actually use -- this
    // artifact's whole stated purpose is to show what would be sent.
    //
    // The fix is the SAME stable literal placeholder this artifact has always used, never a
    // generated UUID: minting a real, joinable id here would fabricate a session that never
    // existed -- the identical error the OauthTokenUnreadableError branch already refuses to
    // produce for a real call (a recoverable-looking id pointing at nothing), except
    // self-inflicted on every single dry run instead of one failure mode. A downstream
    // token-ledger action joining on it would then read "lost session" instead of "no call was
    // made". A fixed literal is also stable across runs, so artifact diffs stay clean and no
    // churning id enters a committed path.
    //
    // buildQueryOptions is called directly here (deps.buildQueryOptions, following this file's
    // deps.query/deps.buildQueryOptions convention -- see invokeClaudeReal), not through
    // invokeClaudeReal itself: a dry run must never touch the killswitch check or attempt-count
    // hook invokeClaudeReal's own top does, and must never call query() at all.
    //
    // Fix pass (CI run 35620555644, all 8 of that run's failures traced to this one throw): the
    // ORIGINAL version of this comment argued a dry run should resolve a REAL `claude` on PATH so
    // `pathToClaudeCodeExecutable` -- "part of what would actually be sent" -- could tell a
    // maintainer their PATH is misconfigured instead of hiding it. True in spirit, wrong in
    // effect: buildQueryOptions's resolution is a real fs.accessSync PATH walk (sdk.js), and when
    // it finds nothing it THROWS ClaudeExecutableNotFoundError uncaught here, killing the whole
    // task (and, run through daemon.js as this suite's dry-run-demo/regression tests do, the
    // whole process) before it ever reaches DONE. That makes every dry run -- the one thing
    // gate.sh and this action's own --dry-run gate leg promise is hermetic ("no network calls...
    // the same commit yields the same verdict here and on a laptop", that script's own header;
    // scripted.js's dry-run half is "zero subprocesses" for the identical reason) -- depend on
    // whether the HOST happens to have a real `claude` binary on PATH. GitHub Actions' runner does
    // not, so CI failed 8/8 on exactly this while a laptop with `claude` installed (this session's
    // own worktree included) does not reproduce it at all -- measured, not assumed.
    //
    // The fix keeps the original intent (a real misconfiguration IS worth showing) without the
    // throw: deps.resolveClaudeCodeExecutable, when a caller already injects one, is used
    // verbatim, same as buildQueryOptions's own convention -- not because any test in this repo
    // currently depends on that exact resolution (VERIFIED 2026-09-22: forcing this branch to
    // throw on entry left `node --test test/*.test.js` at the identical 3321 pass / 1
    // pre-existing fail as an unmodified run, so no test in the suite reaches the dry-run branch
    // with an injected resolver today), but because it is the same injection contract
    // deps.query/deps.buildQueryOptions already use throughout this file, and a caller that
    // deliberately injects a resolver is trusted to mean it rather than silently overridden.
    // Only when nothing is injected -- the production path, and every dry-run-demo/regression
    // test above -- does this wrap the real resolver so an absent PATH entry becomes the
    // placeholder string below (still visible in the artifact, still names the misconfiguration)
    // instead of an uncaught throw.
    //
    // Built from `opts` UNMODIFIED, never with the sessionId placeholder already substituted in --
    // buildQueryOptions validates a supplied opts.sessionId as UUID-v4 shaped (a bare TypeError,
    // a programming-error contract this function must not suppress -- see that function's own
    // header, reason 3), and '<generated-at-spawn>' would trip that check immediately. The
    // placeholder is overlaid onto the DISPLAY copy afterward instead, below.
    const { buildQueryOptions: buildQueryOptionsFn } = getSdkCall();
    const buildOptionsForDryRun = deps.buildQueryOptions || buildQueryOptionsFn;
    const dryRunDeps = deps.resolveClaudeCodeExecutable
      ? deps
      : {
          ...deps,
          resolveClaudeCodeExecutable: (pathEnv) =>
            resolveClaudeCodeExecutable(pathEnv) || DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER,
        };
    const { options: dryRunOptions } = buildOptionsForDryRun(opts, dryRunDeps);
    const displayOptions = { ...dryRunOptions, sessionId: '<generated-at-spawn>' };
    const dryrunFile = writeDryRunArtifact(ctx.taskDir, stepName, displayOptions, promptText);
    appendEvent(ctx.taskDir, stepName, 'dry-run', {
      step: stepName,
      promptFile: contract.promptFile,
      model: opts.model,
      effort: opts.effort,
      dryrunFile,
    });
    return cannedDryRunPayload(stepName, contract, ctx);
  }

  const raw = await invokeClaudeReal(opts, deps);

  appendEvent(ctx.taskDir, stepName, 'llm-call', {
    step: stepName,
    model: opts.model,
    effort: opts.effort,
    account: account.name,
    sessionId: raw.sessionId,
    ...tokenFieldsFrom(raw),
    // See the override branch above for why these two ride alongside tokenFieldsFrom rather than
    // inside it.
    transcriptFilesRead: raw.transcriptFilesRead,
    transcriptFilesSkipped: raw.transcriptFilesSkipped,
    // Card #214: `numTurns` deliberately not journalled -- same reasoning as the override
    // branch above (see its comment) and invokeClaudeReal's own comment at `parsed.num_turns`.
    // `raw.numTurns` is still a real field on `raw`, read back below into every returned shape.
    duration_s: raw.durationS, // see the override branch above for why this is snake_case
    ok: raw.ok,
  });

  if (!raw.ok) return raw; // spawn/parse/limit/error failure from invokeClaudeReal -- unchanged

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(raw.result);
  } catch {
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: ${stepName} reply was not valid JSON`,
      sessionId: raw.sessionId,
      ...tokenFieldsFrom(raw),
      numTurns: raw.numTurns,
      raw: raw.raw,
    };
  }

  // `in` throws a TypeError on a non-object, and a model is perfectly capable of replying with
  // valid JSON that is not an object (`null`, a bare string, a number). That TypeError would
  // escape runLlm and reach runTask's "a real bug -- surface it" rethrow, killing the daemon on
  // what is really just a malformed reply. It is the one transport-shaped failure that would
  // otherwise slip past the llm-transport-failed guards in state-machine.js, so classify it the
  // same way every other unusable reply is classified. Arrays are objects but can never carry
  // the required keys, so they fall through to the missing-key branch below on their own.
  if (parsedPayload === null || typeof parsedPayload !== 'object') {
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: ${stepName} reply parsed to ${parsedPayload === null ? 'null' : typeof parsedPayload}, not an object`,
      sessionId: raw.sessionId,
      ...tokenFieldsFrom(raw),
      numTurns: raw.numTurns,
      raw: raw.raw,
    };
  }

  const missingKeys = contract.outputContract.required.filter((key) => !(key in parsedPayload));
  if (missingKeys.length > 0) {
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: ${stepName} reply missing required key(s): ${missingKeys.join(', ')}`,
      sessionId: raw.sessionId,
      ...tokenFieldsFrom(raw),
      numTurns: raw.numTurns,
      raw: raw.raw,
    };
  }

  // Card #207: every required key is now confirmed present -- check the ones step-contracts.js
  // also declares a type for. checkOutputTypes mutates parsedPayload in place for any array-typed
  // key whose value arrived as a JSON-encoded string that parses to the right shape (the same
  // leniency park-loop.js's normalizeFindingsPayload already applies for its own callers), so a
  // downstream reader of the returned payload sees the real array either way. A key that is
  // present but genuinely wrongly typed is reported through the exact same failure shape as a
  // missing key above -- same {ok:false, kind:'error', ...} fields, never a new failure channel --
  // naming the key, its declared type, and what actually arrived, so a park report says something
  // more useful than "reply missing required key(s)" for a key that was never missing at all.
  const { failures: typeFailures } = checkOutputTypes(parsedPayload, contract.outputContract);
  if (typeFailures.length > 0) {
    const describe = (f) => `${f.key} (expected ${f.type}, got ${JSON.stringify(f.received)})`;
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: ${stepName} reply has wrongly-typed key(s): ${typeFailures.map(describe).join(', ')}`,
      sessionId: raw.sessionId,
      ...tokenFieldsFrom(raw),
      numTurns: raw.numTurns,
      raw: raw.raw,
    };
  }

  return {
    ok: true,
    sessionId: raw.sessionId,
    ...tokenFieldsFrom(raw),
    numTurns: raw.numTurns,
    raw: raw.raw,
    ...withCamelAliases(parsedPayload),
  };
}

module.exports = {
  runLlm,
  invokeClaudeReal,
  resolvePromptText,
  extractTokens,
  tokenFieldsFrom,
  classifyFailure,
  // A4 (card #239 chantier, orchestrator/steps/sdk-call.js's consumeQueryStream): the SDK
  // transport's result message carries `api_error_status`/`terminal_reason` in the exact same
  // snake_case shape this function already reads (MEASURED against the real vendored SDK, a fake
  // `claude` emitting stream-json -- see sdk-call.js's own header), so consumeQueryStream calls
  // this directly on a `result` message instead of re-deriving the usage/overloaded split a second
  // time. Was already defined here and already shared with classifyFailure (see both functions'
  // own comments on why one table backs both) -- only the export was missing, since nothing outside
  // this file needed it before this action.
  limitKindForFailure,
  // Card SPO-Pipeline#250: the quota-scope half of a limit's classification, called by
  // consumeQueryStream alongside limitKindForFailure. The two Sets and the default are exported so
  // a test can pin the mapping table in this function's header entry by entry.
  limitScopeFor,
  ACCOUNT_SCOPE_RATE_LIMIT_TYPES,
  MODEL_SCOPE_RATE_LIMIT_TYPES,
  LIMIT_SCOPE_DEFAULT,
  MODEL_LIMIT_API_ERROR,
  MODEL_LIMIT_ERROR_CODE,
  withCamelAliases,
  cannedDryRunPayload,
  NONINTERACTIVE_ENV_DEFAULTS,
  // card #167: exported for state-machine.js's callLlmStep, which must know the model this call
  // will spend BEFORE it leases an account for it. See the function's own header.
  resolveCallModel,
  // Exported for test/llm-dryrun-placeholder.test.js's M1/M4 pins (fix pass on card #239's
  // dry-run CI fix) -- those tests read the artifact's displayed executable field back and
  // compare it against this same literal, rather than duplicating the string.
  DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER,
  // Exported for test/llm-real.test.js's A3/A5 pins (token-ledger lot, action 4.3): both need to
  // exercise the recovery DECISION directly, against a fixed synthetic result object, without a
  // live spawn's own timing jitter (durationS) making a byte-for-byte comparison flaky.
  maybeRecoverTokens,
};
