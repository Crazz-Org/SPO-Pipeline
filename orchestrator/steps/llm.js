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
//     sessionId, costUsd, numTurns, raw}. `deps.spawnSync` is an injection point for tests (and
//     nothing else) -- production code never passes it.
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
// -- it is enforced by Node itself while the child runs, and it actually kills the child. The
// state machine still wraps the whole call in callWithDeadline (see callLlmStep) for its
// existing "retry once, then PARK" bookkeeping; that layer keeps working as before because
// invokeClaudeReal always returns (never hangs) once its own spawnSync timeout elapses. A call
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
const { resolveStepContract, LLM_STEP_DEADLINE_MS } = require('../step-contracts');
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

// Builds the argv for `claude`, in the exact flag order the spec gives:
//   -p --model <model> --effort <effort> --output-format json --max-budget-usd <n>
//   [--allowedTools <tools>] [--permission-mode <mode>] [--json-schema <schema-json>]
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
        costUsd: 0,
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

  const spawnResult = spawnSyncFn('claude', argv, spawnOpts);
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
      costUsd: 0,
      numTurns: undefined,
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
      costUsd: 0,
      numTurns: undefined,
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
      costUsd: 0,
      numTurns: undefined,
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
      deadlineMs: LLM_STEP_DEADLINE_MS,
    };

    const result = await invokeClaudeReal(opts, deps);

    appendEvent(ctx.taskDir, stepName, 'llm-call', {
      step: stepName,
      model: opts.model,
      effort: opts.effort,
      account: account && account.name,
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
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
    deadlineMs: LLM_STEP_DEADLINE_MS,
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
    costUsd: raw.costUsd,
    numTurns: raw.numTurns,
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
      costUsd: raw.costUsd,
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
      costUsd: raw.costUsd,
      numTurns: raw.numTurns,
      raw: raw.raw,
    };
  }

  return {
    ok: true,
    sessionId: raw.sessionId,
    costUsd: raw.costUsd,
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
  sumCost,
  classifyFailure,
  withCamelAliases,
  cannedDryRunPayload,
  NONINTERACTIVE_ENV_DEFAULTS,
};
