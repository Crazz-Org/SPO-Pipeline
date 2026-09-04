'use strict';
// llm.js -- the "claude -p" step interface (PLAN, IMPLEMENT, DIAGNOSE, VALIDATE's two
// verifiers). state-machine-spec.md § Step contracts.
//
// Shadow mode (ctx.shadowMode === true): never touches the `claude` CLI. Returns the canned
// JSON payload from the task's shadow.llm.<stepName> fixture (see fixture.js for the array/
// scalar cursor convention), optionally preceded by an artificial delay read from
// `delays.<stepName>` (ms), same mechanism as steps/scripted.js. Unchanged by everything below.
//
// Real mode spawns `claude -p ...` and parses its `--output-format json` stdout. Two layers:
//
//   invokeClaudeReal(opts, deps) -- the primitive. Takes exactly the per-call inputs the spec
//     lists (step, model, effort, allowedTools, permissionMode, maxBudgetUsd, jsonSchema,
//     promptText|promptFile, cwd, account, deadlineMs), builds argv, spawns with the resolved
//     prompt on the child's stdin, parses, classifies failures, and returns {ok, result,
//     sessionId, tokensSource, freshInputTokens, cacheCreationTokens, cacheReadTokens,
//     outputTokens, billableTokens, cacheCreationEphemeral1h, cacheCreationEphemeral5m,
//     numTurns, durationS, raw}. `deps.spawnSync` is an injection point for tests (and nothing
//     else) -- production code never passes it. `durationS` (seconds, wall clock measured around
//     the spawn itself) is journaled as `duration_s` -- doc/state-machine-spec.md's Observability
//     section already documented that field before any code wrote it (measured 2026-09-01: zero
//     of the 19 corpus journals' llm-call events carried it); true as of this change.
//
//     Token accounting (maintainer decision, 2026-08-31): the pool is Claude Max SUBSCRIPTION
//     accounts with a quota, never metered API billing, so a dollar figure never meant money
//     spent -- this build carries no cost/$ fields anywhere, only raw token counts extracted
//     defensively from modelUsage by extractTokens() below. "billable-weighted" = fresh input +
//     cache-creation + output; cache-READ is reported separately and never folded into that
//     total (near-free on a quota plan, and it dominates raw counts by orders of magnitude --
//     see console/usage-scan.js's own header). tokensSource is 'modelUsage' when at least one
//     recognized field was found, else null -- so a reader can tell "zero tokens" from "not
//     reported" (a killed/E2BIG call that never got a modelUsage block at all).
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
//         shape invokeClaudeReal itself uses for a spawn/parse failure.
//     Every sub-path resolves cwd via config.cwdForStep, takes the account from ctx.account (set
//     by the caller's account-rotation retry loop -- see state-machine.js's callLlmStep), and
//     journals one event per call (an 'llm-call' for a real attempt, a 'dry-run' for a dry one).
//
// Deadline handling: spawnSync's own `timeout` option (set to opts.deadlineMs) is what actually
// kills a hung `claude` process. deadline.js's callWithDeadline/withTimeout race is NOT reused
// for that job here on purpose: it works by racing a Promise against a setTimeout, which cannot
// preempt spawnSync -- spawnSync blocks the single JS thread synchronously, so no timer can fire
// until spawnSync itself returns. Worse, deadline.js's race explicitly abandons the loser "to
// finish in the background" (see its own comment), which for a real subprocess would mean an
// orphaned `claude -p` process still spending budget. spawnSync's `timeout` avoids both problems
// -- it is enforced by Node itself while the child runs, and it signals the child. The state
// machine still wraps the whole call in callWithDeadline (see callLlmStep) for its existing
// "retry once, then PARK" bookkeeping.
//
// One correction to what this paragraph used to claim, measured during action 6.2's verification
// rather than reasoned: spawnSync's `timeout` sends `killSignal` (SIGTERM by default) and does
// NOT escalate to SIGKILL. Measured directly -- an ordinary child returns
// `signal=SIGTERM status=null error=ETIMEDOUT` after 410ms against a 400ms timeout, while a child
// that INSTALLS A SIGTERM HANDLER AND IGNORES IT ran to its own completion at 27651ms and returned
// `signal=null status=0`. So "invokeClaudeReal always returns once its own timeout elapses" is
// true for a child that dies on SIGTERM, not unconditionally, and the outer callWithDeadline
// cannot rescue it either (its timer cannot fire while spawnSync blocks the thread -- that is the
// whole reason this paragraph exists). There is no evidence the `claude` CLI ignores SIGTERM, and
// nothing here changes killSignal on a guess; this comment is corrected because C6's worker design
// leans on this doctrine by name, and a doctrine has to say what it actually guarantees. A call
// killed this way returns `{ok: false, timedOut: true, deadlineMs, error: "... ran but exceeded
// the Xms deadline and was killed ..."}` -- callers that need to tell a deadline kill apart from
// a genuine spawn/parse failure (e.g. intake.js's triageBugReport, to decide whether a retry is
// worth it) test `timedOut`, never the message text.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { sleep } = require('./scripted');
const config = require('../config');
const { appendEvent } = require('../journal');
const { ParkSignal } = require('../park-signal');
const { resolveStepContract, deadlineMsForStep } = require('../step-contracts');
const { fillPromptTemplate, MissingPlaceholderError } = require('../prompt-template');
const { buildPromptValues } = require('../task-values');

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

// Reads opts.promptText/opts.promptFile down to the final prompt string. Split out of
// buildArgv because the prompt no longer lives in argv (see buildArgv's own comment) but two
// callers still need the resolved text: invokeClaudeReal (to write it to the child's stdin) and
// writeDryRunArtifact (to display it). Throws the same "needs promptText or promptFile" error
// buildArgv used to, and at the same point in the call sequence -- invokeClaudeReal calls this
// before touching the account/oauth-token file, so a missing prompt still fails first.
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

// Builds the argv for `claude`. Flag order:
//   -p --model <model> --effort <effort> --output-format json
//   [--max-budget-usd <n>] [--allowedTools <tools>] [--permission-mode <mode>]
//   [--json-schema <schema-json>]
// --max-budget-usd is conditional, like the other three: pushed only when opts.maxBudgetUsd is a
// number. No daemon or intake path supplies it -- the only caller that does is the hand-run
// scripts/smoke-llm.js (see doc/state-machine-spec.md / orchestrator/README.md § Budgets).
//
// The prompt is NOT one of these argv entries -- it goes to the child's stdin instead (see
// invokeClaudeReal). Linux caps each INDIVIDUAL argv/environ string at MAX_ARG_STRLEN
// (32 * PAGE_SIZE = 131072 bytes on this machine) -- a distinct, much smaller limit than ARG_MAX
// (the cumulative argv+environ budget, never remotely approached here). A filled prompt bigger
// than that made spawnSync fail with E2BIG before `claude` ever started, unconditionally, no
// matter the model/account/step. Reproduced 2026-08-30 on card #452: its IMPLEMENT prompt was
// 204826 bytes (a placeholder substituted twice into implement.md -- see that file's own fix);
// its PLAN prompt, same task, was 105307 bytes and passed with only ~26KB of headroom -- the
// cliff was one character-count away for every card, not particular to #452's size. `claude
// --help` documents stdin as a first-class prompt channel ("Input must be provided either
// through stdin or as a prompt argument when using --print"), and spawnSync's `input` option has
// no size ceiling of its own (bounded only by `maxBuffer` below, sized generously for this).
function buildArgv(opts) {
  const argv = ['-p'];
  if (opts.model) argv.push('--model', opts.model);
  if (opts.effort) argv.push('--effort', opts.effort);
  argv.push('--output-format', 'json');
  if (typeof opts.maxBudgetUsd === 'number') argv.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.allowedTools) {
    const tools = Array.isArray(opts.allowedTools) ? opts.allowedTools.join(' ') : opts.allowedTools;
    argv.push('--allowedTools', tools);
  }
  if (opts.permissionMode) argv.push('--permission-mode', opts.permissionMode);
  if (opts.jsonSchema) {
    const schema = typeof opts.jsonSchema === 'string' ? opts.jsonSchema : JSON.stringify(opts.jsonSchema);
    argv.push('--json-schema', schema);
  }
  return argv;
}

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
function extractTokens(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return { ...ZERO_TOKENS };

  let found = false;
  let freshInputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let cacheCreationEphemeral1h = 0;
  let cacheCreationEphemeral5m = 0;

  for (const usage of Object.values(modelUsage)) {
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
  };
}

// The token fields alone, lifted off an invokeClaudeReal result (or anything with the same
// shape) -- used every place below that needs to pass them along (a journal event, an error
// return) without repeating all eight names at every call site.
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
//     intake.js:796-798's 12.8-hour Fable incident ("You've reached your Fable 5 limit",
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

// The real-mode primitive: spawn `claude -p`, parse its JSON, classify, return. Never throws on
// a failed/limited/malformed call -- those come back as {ok: false, kind, ...}; only a
// programming error (bad opts) throws.
async function invokeClaudeReal(opts, deps = {}) {
  const spawnSyncFn = deps.spawnSync || spawnSync;
  const promptText = resolvePromptText(opts);
  const argv = buildArgv(opts);

  const env = { ...process.env, ...NONINTERACTIVE_ENV_DEFAULTS };
  if (opts.account && opts.account.configDir) {
    env.CLAUDE_CONFIG_DIR = opts.account.configDir;
  }
  // A registry entry may carry the account's long-lived subscription token in a file (the
  // `claude setup-token` output, pasted there by the operator -- see accounts.js's registry
  // format). Exported as CLAUDE_CODE_OAUTH_TOKEN for this one spawn only. An unreadable file
  // is an authoring error surfaced as a normal step failure, never a throw.
  if (opts.account && opts.account.oauthTokenFile) {
    try {
      env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(opts.account.oauthTokenFile, 'utf8').trim();
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        error: `llm.js: cannot read oauthTokenFile for account "${opts.account.name}": ${err.message}`,
        sessionId: null,
        ...ZERO_TOKENS,
        numTurns: undefined,
        raw: null,
      };
    }
  }

  const spawnOpts = {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
    // The prompt goes to the child's stdin, never argv -- see buildArgv's own comment on
    // MAX_ARG_STRLEN. spawnSync writes `input` into the child's stdin pipe (the default
    // 'pipe' stdio applies since spawnOpts sets no `stdio` of its own).
    input: promptText,
    maxBuffer: 64 * 1024 * 1024,
  };
  if (typeof opts.deadlineMs === 'number' && opts.deadlineMs > 0) {
    spawnOpts.timeout = opts.deadlineMs;
  }

  // duration_s (action 5.4, doc/state-machine-spec.md § Observability already documented this
  // field before any code wrote it -- measured 2026-09-01: zero of the 19 corpus journals'
  // llm-call events carried it). Measured around the spawn itself, not the whole function
  // (promptText/argv/env prep above is sub-millisecond and not what a maintainer means by "how
  // long did this call take"), and captured BEFORE any of the branches below so every one of
  // them -- success, spawn error, signal kill, deadline timeout, parse failure -- reports the
  // real wall-clock time this attempt burned. That matters most for exactly the failure a
  // maintainer is most likely to be staring at: a deadline-killed call still ran for the full
  // deadline, and previously that cost was invisible (ZERO_TOKENS records tokens as 0, which is
  // honest, but said nothing about time spent).
  const startedAt = Date.now();
  const spawnResult = spawnSyncFn('claude', argv, spawnOpts);
  const durationS = (Date.now() - startedAt) / 1000;
  const rawExit = spawnResult.status === undefined ? null : spawnResult.status;

  // Deadline kill FIRST, before the generic `error` branch. When spawnOpts.timeout fires, Node
  // fills in BOTH spawnResult.error (an Error with .code === 'ETIMEDOUT') AND spawnResult.signal
  // (the signal it used to kill the child, SIGTERM here) -- so the `error` branch below used to
  // swallow every deadline kill and report it as "failed to spawn claude", which is exactly
  // backwards: claude spawned fine, ran, and was killed for running too long. Reproduced
  // 2026-08-30 on card #449 (`spo triage --dry`: "triageBugReport: claude call failed (error):
  // llm.js: failed to spawn claude: spawnSync claude ETIMEDOUT [exit=143]").
  //
  // A bare `signal` with NO deadline armed is NOT a timeout (an OOM kill, an operator's SIGKILL)
  // -- that case keeps its own honest branch further down and never sets `timedOut`.
  //
  // `kind` stays 'error' on purpose: state-machine.js's callLlmStep rotates accounts on 'limit'
  // and treats everything else as a plain failure. A third kind would force an audit of every
  // `kind ===` test in the repo for no gain -- `timedOut` carries the information instead, and
  // that is what intake.js's triageBugReport retries on.
  const deadlineArmed = typeof spawnOpts.timeout === 'number';
  const killedByDeadline =
    (spawnResult.error && spawnResult.error.code === 'ETIMEDOUT') || (!!spawnResult.signal && deadlineArmed);

  if (killedByDeadline) {
    const detail = spawnResult.signal
      ? `signal ${spawnResult.signal}`
      : (spawnResult.error && (spawnResult.error.code || spawnResult.error.message)) || 'no signal reported';
    return {
      ok: false,
      kind: 'error',
      timedOut: true,
      deadlineMs: deadlineArmed ? spawnOpts.timeout : undefined,
      error: deadlineArmed
        ? `llm.js: claude ran but exceeded the ${spawnOpts.timeout}ms deadline and was killed (${detail})`
        : `llm.js: claude ran but was killed before it replied (${detail})`,
      sessionId: null,
      ...ZERO_TOKENS,
      numTurns: undefined,
      durationS,
      raw: rawExit,
    };
  }

  if (spawnResult.error) {
    // A REAL spawn failure: ENOENT (no `claude` on PATH), EACCES, EAGAIN...
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: failed to spawn claude: ${spawnResult.error.message}`,
      sessionId: null,
      ...ZERO_TOKENS,
      numTurns: undefined,
      durationS,
      raw: rawExit,
    };
  }
  if (spawnResult.signal) {
    // Signalled with no deadline armed -- not this module's timeout, something external.
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: claude was killed by signal ${spawnResult.signal} (no deadline was armed)`,
      sessionId: null,
      ...ZERO_TOKENS,
      numTurns: undefined,
      durationS,
      raw: rawExit,
    };
  }

  const exit = spawnResult.status === null || spawnResult.status === undefined ? 1 : spawnResult.status;

  let parsed = null;
  try {
    parsed = JSON.parse(spawnResult.stdout || '');
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: claude stdout was not valid JSON (exit ${exit})`,
      sessionId: null,
      ...ZERO_TOKENS,
      numTurns: undefined,
      durationS,
      raw: exit,
    };
  }

  const tokens = extractTokens(parsed.modelUsage);
  const sessionId = parsed.session_id || parsed.uuid || null;
  const numTurns = parsed.num_turns;

  if (parsed.is_error || exit !== 0) {
    const kind = classifyFailure(parsed);
    return {
      ok: false,
      kind,
      // Only present on a 'limit' classification -- see limitKindForFailure's own comment.
      // accounts.markLimit treats an absent/unrecognised limitKind as the usage-tier fail-safe,
      // so omitting the key on a plain 'error' costs nothing.
      ...(kind === 'limit' ? { limitKind: limitKindForFailure(parsed) } : {}),
      result: parsed.result,
      sessionId,
      ...tokens,
      numTurns,
      durationS,
      apiErrorStatus: parsed.api_error_status,
      terminalReason: parsed.terminal_reason,
      raw: exit,
    };
  }

  return { ok: true, result: parsed.result, sessionId, ...tokens, numTurns, durationS, raw: exit };
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

// Writes journal/<id>/dryrun-<STATE>.md: the exact argv `claude` would have been spawned with
// (buildArgv never spawns anything itself), and the filled prompt text, so a --dry-run run can
// be inspected without ever having called the CLI. No elision needed here any more -- since the
// prompt travels on stdin, not argv, "## argv" is already just the flag line
// (--model/--effort/--json-schema) a reader wants to scan; the filled prompt is shown in full
// underneath, its one and only copy in this file.
function writeDryRunArtifact(taskDir, stepName, argv, promptText) {
  const file = path.join(taskDir, `dryrun-${stepName}.md`);
  const body = [
    `# Dry run -- ${stepName}`,
    '',
    '## argv',
    '```json',
    JSON.stringify(argv),
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
      permissionMode: override.permissionMode,
      maxBudgetUsd: override.maxBudgetUsd,
      jsonSchema: override.jsonSchema,
      promptText: override.promptText,
      promptFile: override.promptFile,
      cwd,
      account,
      // Per-step (PLAN 1800000ms, every other step 900000ms). This legacy override path has no
      // resolved contract to read the figure off, so it asks step-contracts directly -- same
      // source, so the two paths can never disagree about how long a PLAN may run.
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
      numTurns: result.numTurns,
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
    permissionMode: contract.permissionMode,
    maxBudgetUsd: contract.maxBudgetUsd,
    jsonSchema: contract.jsonSchema,
    promptText,
    cwd,
    account,
    deadlineMs: contract.deadlineMs,
  };

  if (ctx.dryRun) {
    const argv = buildArgv(opts);
    const dryrunFile = writeDryRunArtifact(ctx.taskDir, stepName, argv, promptText);
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
    numTurns: raw.numTurns,
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
  buildArgv,
  resolvePromptText,
  extractTokens,
  tokenFieldsFrom,
  classifyFailure,
  withCamelAliases,
  cannedDryRunPayload,
  NONINTERACTIVE_ENV_DEFAULTS,
};
