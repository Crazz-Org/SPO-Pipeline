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
//     promptText|promptFile, cwd, account, deadlineMs), builds argv, spawns, parses, classifies
//     failures, and returns {ok, result, sessionId, costUsd, numTurns, raw}. `deps.spawnSync`
//     is an injection point for tests (and nothing else) -- production code never passes it.
//
//   runLlm(ctx, stepName, fixtureKey, deps) -- the existing shadow-mode entry point every state-
//     machine handler already calls. Its shadow branch is untouched. Its real branch reads the
//     per-step call config from ctx.task.llm.<stepName> (the natural real-mode analogue of
//     task.shadow.llm.<stepName> -- a real task file supplies model/effort/tools/prompt the
//     same place a synthetic one supplies canned answers), resolves cwd via config.cwdForStep,
//     takes the account from ctx.account (set by the caller's account-rotation retry loop --
//     see state-machine.js's callLlmStep), calls invokeClaudeReal, and journals one event.
//
// Deadline handling: spawnSync's own `timeout` option (set to opts.deadlineMs) is what actually
// kills a hung `claude` process. deadline.js's callWithDeadline/withTimeout race is NOT reused
// for that job here on purpose: it works by racing a Promise against a setTimeout, which cannot
// preempt spawnSync -- spawnSync blocks the single JS thread synchronously, so no timer can fire
// until spawnSync itself returns. Worse, deadline.js's race explicitly abandons the loser "to
// finish in the background" (see its own comment), which for a real subprocess would mean an
// orphaned `claude -p` process still spending budget. spawnSync's `timeout` avoids both problems
// -- it is enforced by Node itself while the child runs, and it actually kills the child. The
// state machine still wraps the whole call in callWithDeadline (see callLlmStep) for its
// existing "retry once, then PARK" bookkeeping; that layer keeps working as before because
// invokeClaudeReal always returns (never hangs) once its own spawnSync timeout elapses.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { sleep } = require('./scripted');
const config = require('../config');
const { DEFAULT_ACCOUNT } = require('../accounts');
const { appendEvent } = require('../journal');

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

// Builds the argv for `claude`, in the exact flag order the spec gives:
//   -p <prompt> --model <model> --effort <effort> --output-format json --max-budget-usd <n>
//   [--allowedTools <tools>] [--permission-mode <mode>] [--json-schema <schema-json>]
function buildArgv(opts) {
  let prompt = opts.promptText;
  if ((prompt === undefined || prompt === null || prompt === '') && opts.promptFile) {
    prompt = fs.readFileSync(opts.promptFile, 'utf8');
  }
  if (!prompt) {
    throw new Error('llm.js: real-mode call needs promptText or promptFile');
  }

  const argv = ['-p', prompt];
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

// Sums costUSD across every model entry in modelUsage -- a call can use more than one model
// (e.g. a fallback), and the spec asks for the total.
function sumCost(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return 0;
  let total = 0;
  for (const usage of Object.values(modelUsage)) {
    if (usage && typeof usage.costUSD === 'number') total += usage.costUSD;
  }
  return total;
}

// limit/429-shaped errors -> 'limit' (caller should cool the account down and retry on the next
// one); anything else -> 'error' (existing failure handling, no account rotation).
function classifyFailure(parsed) {
  if (parsed && parsed.api_error_status === 429) return 'limit';
  const haystack = [parsed && parsed.result, parsed && parsed.terminal_reason]
    .filter((s) => typeof s === 'string')
    .join(' ');
  if (/limit|overloaded|rate/i.test(haystack)) return 'limit';
  return 'error';
}

// The real-mode primitive: spawn `claude -p`, parse its JSON, classify, return. Never throws on
// a failed/limited/malformed call -- those come back as {ok: false, kind, ...}; only a
// programming error (bad opts) throws.
async function invokeClaudeReal(opts, deps = {}) {
  const spawnSyncFn = deps.spawnSync || spawnSync;
  const argv = buildArgv(opts);

  const env = { ...process.env, ...NONINTERACTIVE_ENV_DEFAULTS };
  if (opts.account && opts.account.configDir) {
    env.CLAUDE_CONFIG_DIR = opts.account.configDir;
  }

  const spawnOpts = {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  };
  if (typeof opts.deadlineMs === 'number' && opts.deadlineMs > 0) {
    spawnOpts.timeout = opts.deadlineMs;
  }

  const spawnResult = spawnSyncFn('claude', argv, spawnOpts);

  if (spawnResult.error) {
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: failed to spawn claude: ${spawnResult.error.message}`,
      sessionId: null,
      costUsd: 0,
      numTurns: undefined,
      raw: spawnResult.status === undefined ? null : spawnResult.status,
    };
  }
  if (spawnResult.signal) {
    return {
      ok: false,
      kind: 'error',
      error: `llm.js: claude was killed by signal ${spawnResult.signal} (deadline exceeded?)`,
      sessionId: null,
      costUsd: 0,
      numTurns: undefined,
      raw: spawnResult.status === undefined ? null : spawnResult.status,
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
      costUsd: 0,
      numTurns: undefined,
      raw: exit,
    };
  }

  const costUsd = sumCost(parsed.modelUsage);
  const sessionId = parsed.session_id || parsed.uuid || null;
  const numTurns = parsed.num_turns;

  if (parsed.is_error || exit !== 0) {
    return {
      ok: false,
      kind: classifyFailure(parsed),
      result: parsed.result,
      sessionId,
      costUsd,
      numTurns,
      apiErrorStatus: parsed.api_error_status,
      terminalReason: parsed.terminal_reason,
      raw: exit,
    };
  }

  return { ok: true, result: parsed.result, sessionId, costUsd, numTurns, raw: exit };
}

async function runLlm(ctx, stepName, fixtureKey, deps = {}) {
  if (ctx.shadowMode) {
    const payload = ctx.fixture(fixtureKey, null);
    const delay = ctx.fixture(`delays.${stepName}`, 0);
    if (delay > 0) await sleep(delay);
    return payload;
  }

  const callConfig = (ctx.task && ctx.task.llm && ctx.task.llm[stepName]) || {};
  const account = ctx.account || DEFAULT_ACCOUNT;
  const cwd =
    callConfig.cwd ||
    config.cwdForStep(stepName, {
      worktreePath: ctx.task && ctx.task.worktreePath,
      repoRoot: REPO_ROOT,
    });

  const opts = {
    step: stepName,
    model: callConfig.model,
    effort: callConfig.effort,
    allowedTools: callConfig.allowedTools,
    permissionMode: callConfig.permissionMode,
    maxBudgetUsd: callConfig.maxBudgetUsd,
    jsonSchema: callConfig.jsonSchema,
    promptText: callConfig.promptText,
    promptFile: callConfig.promptFile,
    cwd,
    account,
    deadlineMs: ctx.config && ctx.config.stepDeadlineMs,
  };

  const result = await invokeClaudeReal(opts, deps);

  appendEvent(ctx.taskDir, stepName, 'llm-call', {
    step: stepName,
    model: opts.model,
    effort: opts.effort,
    account: account.name,
    sessionId: result.sessionId,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    ok: result.ok,
  });

  return result;
}

module.exports = {
  runLlm,
  invokeClaudeReal,
  buildArgv,
  sumCost,
  classifyFailure,
  NONINTERACTIVE_ENV_DEFAULTS,
};
