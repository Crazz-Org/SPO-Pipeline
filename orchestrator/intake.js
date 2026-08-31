'use strict';
// intake.js -- the maintainer-facing card intake path behind `spo ask` and `spo pull` (bin/spo).
//
//   draftCard    -- DRAFT_CARD step: request_text -> a draft card, via prompts/draft-card.md.
//                    Fast lane: `spo ask "<text>"`.
//   loadDraftFile -- the brainstorm lane: reads an already-written draft JSON off disk (an
//                    interactive session's own hand-off) instead of calling DRAFT_CARD at all.
//                    `spo ask --draft-file <path>`.
//   reviewCard -- the existing review-card step: draft -> a FILE/FILE_AMENDED/DO_NOT_FILE verdict,
//                 via prompts/review-card.md. Both lanes above feed the same reviewCard.
//   fileCard   -- applies review's mechanical corrections, then `gh issue create` + `gh issue
//                 comment` (the first comment is the review verdict, verbatim).
//   postIssueComment -- `gh issue comment` against a temp file, extracted out of fileCard so
//                 auto-triage.js's duplicate-report path (a comment on an EXISTING issue, no new
//                 issue) reuses the same spawn instead of a second implementation.
//   triageBugReport -- the auto-triage driver's own step: reproduces/routes/dedups ONE report
//                 from `~/.spo-reports` via prompts/triage-bug-report.md, and either drafts a
//                 card (still going through reviewCard/fileCard below, never filing itself) or
//                 reports why it stopped short. Behind `spo triage` / orchestrator/auto-triage.js
//                 -- see orchestrator/README.md § Auto-triage.
//   pullBoard  -- reads the product repo's cheap pool read (`npm run board:claim`) and parses its
//                 claimable-candidate lines, in priority order.
//   makeTask   -- turns one candidate into a local queue/<seq>-issue-<n>.json task file, the same
//                 shape state-machine.js's takeNextTask() consumes (see orchestrator/README.md
//                 "Task-file format" and the `kind: "card"` shape under "Real mode").
//
// Every LLM call reuses steps/llm.js's invokeClaudeReal (never a second spawn primitive) and
// accounts.js's pool (never a second account source). Every gh/npm call is injected the same way
// steps/scripted.js's spawnStep already is: `deps.spawnSync` -- production code never passes it,
// so a real run always spawns the real `claude`/`gh`/`npm` binaries on PATH. No function here
// ever writes to the product board -- `fileCard` files a NEW issue (the board's own auto-add
// workflow puts it in Todo), and `pullBoard`/`makeTask` only ever read.

const fs = require('fs');
const path = require('path');
const os = require('os');

const accounts = require('./accounts');
const config = require('./config');
const { invokeClaudeReal, tokenFieldsFrom } = require('./steps/llm');
const { fillPromptTemplate } = require('./prompt-template');
const { parseCommentId } = require('./park-loop');
const { armTimeout } = require('./command-timeout');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const DRAFT_CARD_PROMPT = path.join(PROMPTS_DIR, 'draft-card.md');
const REVIEW_CARD_PROMPT = path.join(PROMPTS_DIR, 'review-card.md');
const TRIAGE_BUG_REPORT_PROMPT = path.join(PROMPTS_DIR, 'triage-bug-report.md');

const DRAFT_REQUIRED = ['title', 'body_markdown', 'category', 'size', 'area', 'is_bug_report', 'confirmed'];
const REVIEW_REQUIRED = ['verdict', 'corrections', 'first_comment_markdown'];
const REVIEW_VERDICTS = new Set(['FILE', 'FILE_AMENDED', 'DO_NOT_FILE']);

const TRIAGE_OUTCOMES = new Set(['schema-version', 'not-reproduced', 'insufficient', 'duplicate', 'draft']);

const VALID_CATEGORIES = new Set(['defect', 'latent-trap', 'feature', 'observation', 'doc-infra']);
const VALID_SIZES = new Set(['S', 'M', 'L']);
const VALID_AREAS = new Set(['docs', 'rdo', 'bench', 'renderer', 'gateway', 'client', 'e2e', 'shared', 'ci']);

// config.stepDeadlineMs (120000ms) is sized for the daemon's own scripted/LLM steps and must stay
// that way -- it is not a fit for either intake step. draftCard and reviewCard are the
// maintainer-facing `spo ask`/`spo pull` path, not the daemon loop: reviewCard in particular runs
// fable at effort high verifying citations into the sibling product repo, real cross-repo file
// reads that legitimately run long. Reproduced 2026-08-29 with the review budget already fixed to
// $3 (see step-contracts.js's SMALL_BUDGET_USD, PR #13): a real review still died at the 120s
// wall-clock mark with "llm.js: failed to spawn claude: spawnSync claude ETIMEDOUT [exit=143]" --
// (that exact message no longer occurs since the 2026-08-30 fix -- a deadline kill now says
// "claude ran but exceeded the Xms deadline and was killed", see steps/llm.js's `timedOut`) --
// the spawnSync timeout firing before the model finished, not a budget kill. 300000ms (300s) is
// this build's local, intake-only deadline -- draftCard and reviewCard each fall back to it only
// when the caller (deps.deadlineMs, kept first so tests can still inject a short deadline) hasn't
// already supplied one; config.stepDeadlineMs and every other step remain untouched.
const INTAKE_DEADLINE_MS = 300000;

// formatLlmFailure(prefix, raw) -- renders an invokeClaudeReal {ok: false, ...} failure as a
// one-line diagnosable message. The base `${raw.error || raw.result || ''}` clause is empty for
// exactly the case that matters most: a budget kill ends with `is_error: true` and an empty
// `result` (steps/llm.js's classifyFailure path), so on its own the message collapses to
// "claude call failed (error): " -- no signal at all. raw also carries terminalReason,
// apiErrorStatus, and raw (the exit code) whenever steps/llm.js's is_error/non-zero-exit branch
// set them; appended here, present-fields-only, so the message stays diagnosable even when the
// primary text is blank.
function formatLlmFailure(prefix, raw) {
  const base = `${prefix}: claude call failed (${raw.kind || 'error'}): ${raw.error || raw.result || ''}`;
  const details = [];
  if (raw.terminalReason !== undefined && raw.terminalReason !== null) {
    details.push(`terminal_reason=${raw.terminalReason}`);
  }
  if (raw.apiErrorStatus !== undefined && raw.apiErrorStatus !== null) {
    details.push(`api_error_status=${raw.apiErrorStatus}`);
  }
  if (raw.raw !== undefined && raw.raw !== null) {
    details.push(`exit=${raw.raw}`);
  }
  return details.length > 0 ? `${base} [${details.join(', ')}]` : base;
}

// ---- shared spawn primitive (same injection convention as steps/llm.js / steps/scripted.js) ----
//
// action 2.1b: routed through command-timeout.js's armTimeout -- every `gh`/`npm` call this file
// makes (fetchIssue, postIssueComment, fileCard, amendCard, pullBoard, makeTask) used to spawn
// with no timeout at all. The three LLM steps (draftCard/reviewCard/triageBugReport) already have
// their own deadline via invokeClaudeReal's deadlineMs -- this only covers the plain gh/npm
// spawns alongside them. Reads config.commandTimeoutsMs directly off the module-level `config`
// required above (the same static default every other field in this file falls back to, e.g.
// `deps.productRepo || config.productRepo`) rather than threading a config parameter through
// every one of this file's public functions -- none of them take one today, and `spo ask`/
// `spo pull`/auto-triage.js never pass a different orchestrator config into this module.
function runSync(deps, command, args, opts = {}) {
  return armTimeout(deps, config, command, args, opts);
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

// ---- shared account-rotation + timeout-retry loop for the intake LLM steps -------------------
//
// draftCard/reviewCard/triageBugReport used to call a bare `accounts.pick()` (no rotation, no
// markLimit) -- incident, 2026-08-30/31: triageBugReport (then on fable) failed 53 consecutive
// auto-triage cycles over 12.8 hours, 128 attempts, every one re-picking the same rate-limited
// account, because nothing ever cooled it down. This is the fix, mirroring state-machine.js's
// callLlmStep (see its own header comment) exactly for the pick/call/cool/retry mechanics --
// pick a healthy account, call, and on a `{kind: 'limit'}` result cool that account down
// (accounts.markLimit) and pick again, bounded to one pass over the pool's enabled accounts, so
// a step can never retry the same account twice for a limit and never spins forever.
//
// Two differences from that idiom, both required by intake's own contract (see each caller's
// header comment for the fuller rationale):
//
//   1. Intake never throws for a recognized failure. Exhausting the pool (every account
//      limited) or finding nothing to try at all (accounts.pick()'s AllAccountsCoolingError /
//      NoAccountsRegisteredError) becomes {ok: false, error, cooldowns}, never a ParkSignal and
//      never a throw -- the caller's job is to report and move on, same as every other intake
//      failure.
//   2. Intake has no ctx.taskDir, so there is no per-task journal.jsonl to write a cooldown
//      into. Every cooldown this call causes is collected into `cooldowns` (returned on BOTH
//      the success and the failure shape) for the CALLER to journal -- auto-triage.js appends
//      `report-triage-cooldown`. Returning it, rather than swallowing it, is the actual fix for
//      the 12.8-hour incident: a silent rotation is exactly what made it invisible.
//
// Composition with the existing timeout retry (draftCard/reviewCard/triageBugReport's own
// per-function discipline, unchanged): each account attempt below calls once, and on
// `timedOut === true` retries ONCE on the SAME account/deadline (a deadline kill says nothing
// about account health -- see triageBugReport's own comment on why). Only once that inner retry
// is exhausted does `kind` decide whether to rotate: a `{kind: 'limit'}` result (from either the
// first call or the timeout retry) cools the account and moves to the next one; anything else
// returns immediately, rotation never considered. One account attempt therefore costs at most
// TWO invokeClaudeReal calls, and the whole loop at most `enabled accounts * 2` -- the hard
// bound that matters for an unattended 15-minute timer against a metered API. Note the two
// paths do compose in one direction: an account can time out, burn its same-account retry, and
// have THAT retry come back `{kind: 'limit'}`, which then cools it and rotates. That path costs
// two calls on the account it gave up on, still inside the same bound, and it keeps its
// `retriedAfterTimeout` record (see the hoist comment inside the loop).
//
// `buildOpts(account)` builds the exact `invokeClaudeReal` opts object the caller already built
// inline, with `account` now supplied by this loop instead of a single `pickAccount()` call.
// Returns either {ok: false, error, cooldowns} (pool exhausted or nothing to try), or
// {raw, account, retriedAfterTimeout, cooldowns} for the caller to finish parsing/validating.
async function callIntakeStepWithRotation(prefix, deps, buildOpts) {
  const accountsDir = (deps && deps.accountsDir) || config.claudeAccountsDir;
  const maxAttempts = Math.max(accounts.readRegistry(accountsDir).filter((a) => a.enabled).length, 1);

  const cooldowns = [];
  let raw = null;
  // Hoisted OUT of the loop on purpose. A timeout retry costs a second full LLM call, and
  // auto-triage.js journals it as `report-triage-retry` precisely because "a step that silently
  // costs twice as long and twice as much is the kind of thing that only shows up in a bill."
  // The one path that can both retry AND rotate -- account A times out, its same-account retry
  // comes back `{kind: 'limit'}`, so A is cooled and B is tried -- must not drop A's retry
  // record on the floor when B answers (or when the pool then runs out): that would make the
  // single most expensive shape (a duplicate call followed by a rotation) the one shape with no
  // trace. Last non-null record wins; it names its own `account`, so it stays unambiguous after
  // a rotation.
  let retriedAfterTimeout = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let account;
    try {
      account = accounts.pick(accountsDir);
    } catch (err) {
      if (err instanceof accounts.AllAccountsCoolingError || err instanceof accounts.NoAccountsRegisteredError) {
        return {
          ok: false,
          error: `${prefix}: ${err.message}`,
          cooldowns,
          ...(retriedAfterTimeout ? { retriedAfterTimeout } : {}),
        };
      }
      throw err;
    }

    const opts = buildOpts(account);

    raw = await invokeClaudeReal(opts, deps);
    if (!raw.ok && raw.timedOut === true) {
      const record = {
        account: account.name,
        deadlineMs: raw.deadlineMs !== undefined ? raw.deadlineMs : opts.deadlineMs,
        firstError: formatLlmFailure(prefix, raw),
      };
      raw = await invokeClaudeReal(opts, deps);
      record.retryOk = raw.ok === true;
      record.retryTimedOut = raw.timedOut === true;
      retriedAfterTimeout = record;
    }

    if (!(raw && raw.ok === false && raw.kind === 'limit')) {
      return { raw, account, retriedAfterTimeout, cooldowns };
    }

    const event = accounts.markLimit(accountsDir, account.name, raw.retryAfterMs);
    cooldowns.push({ account: account.name, ...event });
  }

  const lastDetail = raw ? `${raw.error || raw.result || raw.kind}` : 'no attempts made';
  return {
    ok: false,
    error: `${prefix}: all accounts cooling after rotating through ${cooldowns.length} account(s); last result: ${lastDetail}`,
    cooldowns,
    // Carried on the exhaustion shape too -- see the hoist comment above. Present only when a
    // timeout retry actually fired somewhere in the pass, same "only when it happened"
    // convention withIntakeRetryAndCooldowns uses.
    ...(retriedAfterTimeout ? { retriedAfterTimeout } : {}),
  };
}

// withIntakeRetryAndCooldowns(retriedAfterTimeout, cooldowns) -- returns a function that stamps
// a result with `retriedAfterTimeout` (when the timeout retry fired) and `cooldowns` (when
// rotation cooled at least one account), same "only present when it happened" convention as the
// original per-function `withRetry` closures this replaces. Order matters: retriedAfterTimeout
// is spread before cooldowns, but neither ever collides with the other's key.
function withIntakeRetryAndCooldowns(retriedAfterTimeout, cooldowns) {
  return (res) => {
    let out = retriedAfterTimeout ? { ...res, retriedAfterTimeout } : res;
    if (cooldowns && cooldowns.length > 0) out = { ...out, cooldowns };
    return out;
  };
}

// ---- DRAFT_CARD ------------------------------------------------------------------------------

// draftCard(requestText, deps) -- calls prompts/draft-card.md through invokeClaudeReal (model
// sonnet, effort medium, small budget, an account from the pool via accounts.pick), then parses
// and validates the returned contract. Returns {ok: true, draft, sessionId, ...tokenFields} or
// {ok: false, error} -- never throws for a recognized failure (no account available, a spawn
// failure, invalid JSON, a missing/invalid field): those are all "mechanical failure", the
// caller's job to report and exit non-zero on, not a crash.
//
// Model choice: Sonnet 5, not Fable -- drafting is execution-shaped work (turning a request into
// prose + citations), the same tier IMPLEMENT runs on. review-card stays the neutral judge on
// Fable 5: a different model from the drafter, and cheap, since its own context is tiny (one
// card, not a whole worktree).
//
// Retry policy: same one-retry-on-`timedOut`-only discipline as triageBugReport (see that
// function's header for the full rationale) -- same account, same deadline, never on a
// malformed reply. Result carries `retriedAfterTimeout` on both success and failure.
//
// Account rotation: routed through callIntakeStepWithRotation (see its own header) instead of a
// bare accounts.pick() -- a {kind: 'limit'} result now cools the account and rotates to the next
// one, bounded to one pass over the pool, instead of re-picking the same limited account forever.
// Result carries `cooldowns` whenever this call caused at least one.
async function draftCard(requestText, deps = {}) {
  const productRepo = deps.productRepo || config.productRepo;
  const today = deps.today || new Date().toISOString().slice(0, 10);

  const promptText = fillPromptTemplate(DRAFT_CARD_PROMPT, {
    request_text: requestText,
    product_repo: productRepo,
    today,
  });

  const attempt = await callIntakeStepWithRotation('draftCard', deps, (account) => ({
    step: 'DRAFT_CARD',
    model: 'sonnet',
    effort: 'medium',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'plan', // read-only -- draft-card.md: "you hold no edit tool"
    maxBudgetUsd: undefined, // no $ cap -- Claude Max subscription, no overage risk
    jsonSchema: { type: 'object', required: DRAFT_REQUIRED },
    promptText,
    cwd: productRepo, // needs Read/Grep over the product tree to find file:line references
    account,
    deadlineMs: deps.deadlineMs || INTAKE_DEADLINE_MS,
  }));

  if (attempt.ok === false) return attempt; // pool exhausted or nothing to try -- see helper header

  const { raw, retriedAfterTimeout, cooldowns } = attempt;
  const withRetry = withIntakeRetryAndCooldowns(retriedAfterTimeout, cooldowns);

  if (!raw.ok) {
    return withRetry({ ok: false, error: formatLlmFailure('draftCard', raw) });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.result);
  } catch {
    return withRetry({ ok: false, error: 'draftCard: reply was not valid JSON' });
  }

  const check = validateDraftContract(parsed);
  if (!check.ok) {
    return withRetry({ ok: false, error: `draftCard: ${check.error}` });
  }

  return withRetry({ ok: true, draft: parsed, sessionId: raw.sessionId, ...tokenFieldsFrom(raw) });
}

// The contract every draft must satisfy, whichever lane produced it: draftCard's own LLM reply,
// or loadDraftFile's file read for the brainstorm lane below. One checker, so the two lanes can
// never quietly drift apart on what counts as a valid draft.
function validateDraftContract(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'draft is not a JSON object' };
  }
  const missing = DRAFT_REQUIRED.filter((key) => !(key in parsed));
  if (missing.length > 0) {
    return { ok: false, error: `missing required key(s): ${missing.join(', ')}` };
  }
  if (!VALID_CATEGORIES.has(parsed.category)) {
    return { ok: false, error: `unrecognized category "${parsed.category}"` };
  }
  if (!VALID_SIZES.has(parsed.size)) {
    return { ok: false, error: `unrecognized size "${parsed.size}"` };
  }
  if (!VALID_AREAS.has(parsed.area)) {
    return { ok: false, error: `unrecognized area "${parsed.area}"` };
  }
  return { ok: true };
}

// loadDraftFile(filePath) -- the brainstorm-lane entry point behind `spo ask --draft-file
// <path>`: reads an already-written draft JSON from disk (an interactive session's own
// hand-off) and validates it against the exact same contract draftCard's own LLM reply is
// checked against above -- never a second, looser check. Skips the DRAFT_CARD LLM call
// entirely; the caller goes straight from this to reviewCard -> fileCard. Returns {ok: true,
// draft} or {ok: false, error} -- a missing key or a bad enum value is reported clearly, never a
// crash or a silent guess.
function loadDraftFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `loadDraftFile: cannot read ${filePath}: ${err.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `loadDraftFile: ${filePath} is not valid JSON` };
  }

  const check = validateDraftContract(parsed);
  if (!check.ok) {
    return { ok: false, error: `loadDraftFile: ${filePath} ${check.error}` };
  }

  return { ok: true, draft: parsed };
}

// ---- review-card -------------------------------------------------------------------------------

// reviewCard(draft, deps) -- fills prompts/review-card.md's existing placeholder names from the
// draft, calls it the same way (model fable, effort high). Returns {ok: true, review, sessionId,
// ...tokenFields} where `review` is {verdict, corrections, first_comment_markdown}, or {ok: false,
// error}.
//
// Retry policy: same one-retry-on-`timedOut`-only discipline as triageBugReport (see that
// function's header for the full rationale) -- same account, same deadline, never on a
// malformed reply. Result carries `retriedAfterTimeout` on both success and failure.
async function reviewCard(draft, deps = {}) {
  const ghRepo = deps.ghRepo || config.ghRepo;
  const productRepo = deps.productRepo || config.productRepo;

  const promptText = fillPromptTemplate(REVIEW_CARD_PROMPT, {
    card_title: draft.title,
    card_body: draft.body_markdown,
    card_category: draft.category,
    card_size: draft.size,
    card_area: draft.area,
    repo: ghRepo,
    // 'yes' only when auto-triage.js passes deps.humanConfirmed for a report a maintainer has
    // already replied "confirm" to (orchestrator/report-intake.js's reportConfirmScan) -- every
    // other caller (spo ask, /SPO-Draft, spo pull's own review of a board candidate) gets the
    // default 'no'. See prompts/review-card.md § 0 for what this changes.
    human_confirmed: deps.humanConfirmed ? 'yes' : 'no',
  });

  // Account rotation: routed through callIntakeStepWithRotation (see its own header) instead of
  // a bare accounts.pick() -- see draftCard's own comment on why. Result carries `cooldowns`
  // whenever this call caused at least one.
  const attempt = await callIntakeStepWithRotation('reviewCard', deps, (account) => ({
    step: 'REVIEW_CARD',
    model: 'fable',
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], // review-card.md: "Read, Grep, Glob, Bash(ro)"
    permissionMode: 'default',
    maxBudgetUsd: undefined, // no $ cap -- Claude Max subscription, no overage risk
    jsonSchema: { type: 'object', required: REVIEW_REQUIRED },
    promptText,
    cwd: productRepo, // reads the product tree + `gh issue list --repo {{repo}}`
    account,
    deadlineMs: deps.deadlineMs || INTAKE_DEADLINE_MS,
  }));

  if (attempt.ok === false) return attempt; // pool exhausted or nothing to try -- see helper header

  const { raw, retriedAfterTimeout, cooldowns } = attempt;
  const withRetry = withIntakeRetryAndCooldowns(retriedAfterTimeout, cooldowns);

  if (!raw.ok) {
    return withRetry({ ok: false, error: formatLlmFailure('reviewCard', raw) });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.result);
  } catch {
    return withRetry({ ok: false, error: 'reviewCard: reply was not valid JSON' });
  }

  const missing = REVIEW_REQUIRED.filter((key) => !(key in parsed));
  if (missing.length > 0) {
    return withRetry({ ok: false, error: `reviewCard: reply missing required key(s): ${missing.join(', ')}` });
  }
  if (!REVIEW_VERDICTS.has(parsed.verdict)) {
    return withRetry({ ok: false, error: `reviewCard: unrecognized verdict "${parsed.verdict}"` });
  }

  return withRetry({ ok: true, review: parsed, sessionId: raw.sessionId, ...tokenFieldsFrom(raw) });
}

// ---- mechanical corrections ---------------------------------------------------------------

// review-card.md's own contract only promises "one string per named correction" in free text --
// it names no machine format. The one shape this build treats as mechanical (auto-applied,
// never guessed at) is a "field: value" line naming exactly `category`, `size` or `area`, whose
// value is itself one of that field's valid enum members -- anything else (a missing file:line,
// a rewritten "done means" sentence, a field name with a value this build doesn't recognize) is
// prose: left untouched here, and never silently dropped, since first_comment_markdown (posted
// verbatim as the issue's first comment) always carries the full corrections text for a human to
// read.
const MECHANICAL_CORRECTION_RE = /^\s*(category|size|area)\s*:\s*([^\s].*?)\s*$/i;

function applyMechanicalCorrections(draft, corrections) {
  const applied = { ...draft };
  const unmechanical = [];

  for (const correction of corrections || []) {
    const m = typeof correction === 'string' && correction.match(MECHANICAL_CORRECTION_RE);
    if (!m) {
      unmechanical.push(correction);
      continue;
    }
    const field = m[1].toLowerCase();
    const rawValue = m[2].trim();

    if (field === 'category' && VALID_CATEGORIES.has(rawValue)) {
      applied.category = rawValue;
    } else if (field === 'size' && VALID_SIZES.has(rawValue.toUpperCase())) {
      applied.size = rawValue.toUpperCase();
    } else if (field === 'area' && VALID_AREAS.has(rawValue)) {
      applied.area = rawValue;
    } else {
      unmechanical.push(correction); // named the right field but not a value this build knows
    }
  }

  return { applied, unmechanical };
}

// fetchIssue(issueNumber, deps) -- `gh api repos/<repo>/issues/<n>`, reduced to {title, body}.
// Extracted out of amendCard so auto-triage.js's mechanical "suggestion" draft path (a report
// kind that skips triageBugReport entirely -- see auto-triage.js's own header) can reuse the
// identical spawn instead of a second implementation. Returns {ok: true, title, body} or
// {ok: false, error}.
function fetchIssue(issueNumber, deps = {}) {
  const ghRepo = deps.ghRepo || config.ghRepo;
  const result = runSync(deps, 'gh', ['api', `repos/${ghRepo}/issues/${issueNumber}`]);
  if (normalizeExit(result) !== 0) {
    return {
      ok: false,
      error: `fetchIssue: gh api issues/${issueNumber} exited ${normalizeExit(result)}`,
      timedOut: result.timedOut === true,
    };
  }
  let issue;
  try {
    issue = JSON.parse(result.stdout) || {};
  } catch {
    return { ok: false, error: `fetchIssue: gh api issues/${issueNumber} reply was not valid JSON` };
  }
  return { ok: true, title: issue.title || '', body: issue.body || '' };
}

// ---- fileCard -----------------------------------------------------------------------------

function parseIssueNumber(stdout) {
  const m = (stdout || '').match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseIssueUrl(stdout) {
  const m = (stdout || '').match(/https?:\/\/\S+\/issues\/\d+/);
  return m ? m[0] : null;
}

// postIssueComment(issueNumber, markdown, deps) -- `gh issue comment <n> --body-file <f>` against
// a temp file, the exact call fileCard already made for the review verdict, extracted so
// auto-triage.js's duplicate-report path (posting a new-occurrence note on an existing issue,
// never a fresh one) and report-intake.js's confirm-instruction comment reuse the identical spawn
// instead of a second implementation. Returns {ok: true, commentId} (commentId parsed from `gh`'s
// own `.../issues/<n>#issuecomment-<id>` stdout, same regex park-loop.js's parseCommentId already
// uses -- report-intake.js's stage 1 needs it as reportConfirmScan's anchor; every other caller
// simply ignores the field) or {ok: false, error}.
function postIssueComment(issueNumber, markdown, deps = {}) {
  const ghRepo = deps.ghRepo || config.ghRepo;
  const tmpDir = deps.tmpDir || os.tmpdir();
  const stamp = `${Date.now()}-${process.pid}`;
  const commentFile = path.join(tmpDir, `spo-card-comment-${stamp}.md`);
  fs.writeFileSync(commentFile, markdown || '');

  const commentResult = runSync(deps, 'gh', [
    'issue',
    'comment',
    String(issueNumber),
    '--repo',
    ghRepo,
    '--body-file',
    commentFile,
  ]);
  const commentExit = normalizeExit(commentResult);
  if (commentExit !== 0) {
    return {
      ok: false,
      error: `postIssueComment: gh issue comment exited ${commentExit}`,
      timedOut: commentResult.timedOut === true,
    };
  }
  return { ok: true, commentFile, commentId: parseCommentId(commentResult.stdout) };
}

// fileCard(draft, review, deps) -- applies review's mechanical corrections, writes the body and
// first-comment files under os.tmpdir(), then runs exactly the two gh commands CLAUDE.md's
// intake flow names:
//   gh issue create --repo <repo> --title <t> --body-file <f> --label cat:<category> --label
//                    size:<S|M|L>
//   gh issue comment <n> --repo <repo> --body-file <f>
// (the board's own auto-add workflow moves the new issue to Todo -- this never touches the
// board directly). Returns {ok: true, issueNumber, url} or {ok: false, error}. Refuses to run at
// all for a DO_NOT_FILE verdict -- the caller (bin/spo) is expected to have already skipped that
// case, but this is the one place a wrong caller cannot accidentally file a card nobody wanted.
function fileCard(draft, review, deps = {}) {
  if (!review || (review.verdict !== 'FILE' && review.verdict !== 'FILE_AMENDED')) {
    return { ok: false, error: `fileCard: refusing to file for verdict "${review && review.verdict}"` };
  }

  const ghRepo = deps.ghRepo || config.ghRepo;
  const tmpDir = deps.tmpDir || os.tmpdir();

  const { applied } = applyMechanicalCorrections(draft, review.corrections);

  const stamp = `${Date.now()}-${process.pid}`;
  const bodyFile = path.join(tmpDir, `spo-card-body-${stamp}.md`);
  fs.writeFileSync(bodyFile, applied.body_markdown || '');

  const createResult = runSync(deps, 'gh', [
    'issue',
    'create',
    '--repo',
    ghRepo,
    '--title',
    applied.title,
    '--body-file',
    bodyFile,
    '--label',
    `cat:${applied.category}`,
    '--label',
    `size:${applied.size}`,
  ]);
  const createExit = normalizeExit(createResult);
  if (createExit !== 0) {
    return {
      ok: false,
      error: `fileCard: gh issue create exited ${createExit}`,
      stderr: createResult && createResult.stderr,
      timedOut: createResult.timedOut === true,
    };
  }

  const issueNumber = parseIssueNumber(createResult.stdout);
  if (!issueNumber) {
    return { ok: false, error: 'fileCard: could not parse an issue number from gh issue create output' };
  }

  const commented = postIssueComment(issueNumber, review.first_comment_markdown, { ...deps, ghRepo, tmpDir });
  if (!commented.ok) {
    return { ok: false, error: `fileCard: ${commented.error}`, issueNumber };
  }

  const url = parseIssueUrl(createResult.stdout) || `https://github.com/${ghRepo}/issues/${issueNumber}`;
  return { ok: true, issueNumber, url, bodyFile, commentFile: commented.commentFile };
}

// amendCard(issueNumber, draft, review, deps) -- fileCard's sibling for the human-first intake
// path: EDITS the issue a report was already mechanically filed under (report-intake.js's
// runReportIntake) instead of creating a second one. Deliberate, not a shortcut -- see
// orchestrator/README.md § Report intake for the full argument, summarized: the raw card already
// carries the report's `<!-- anchorKey: k -->` marker (it has to, so a repeat report's dedup
// search finds it); a second issue with the same marker would make that search ambiguous
// forever, and prompts/triage-bug-report.md § 3's own dedup, run against THIS report, would find
// its own raw card and call the report a duplicate of itself.
//
// The pre-edit body is preserved (never silently lost to the overwrite) inside a collapsed
// `<details>` block appended after the drafted body -- string concatenation, not a judgement
// call, and it sits alongside GitHub's own edit history as a second record of what the
// maintainer actually confirmed.
//
// Same refusal guard as fileCard, same applyMechanicalCorrections reuse, same postIssueComment
// reuse for the review verdict. Returns {ok: true, issueNumber, url} or {ok: false, error}.
function amendCard(issueNumber, draft, review, deps = {}) {
  if (!review || (review.verdict !== 'FILE' && review.verdict !== 'FILE_AMENDED')) {
    return { ok: false, error: `amendCard: refusing to amend for verdict "${review && review.verdict}"` };
  }

  const ghRepo = deps.ghRepo || config.ghRepo;
  const tmpDir = deps.tmpDir || os.tmpdir();

  const original = fetchIssue(issueNumber, deps);
  if (!original.ok) {
    return { ok: false, error: `amendCard: ${original.error}` };
  }
  const originalBody = original.body;

  const { applied } = applyMechanicalCorrections(draft, review.corrections);

  const body = [
    applied.body_markdown || '',
    '',
    '<details><summary>Original report (raw intake, before reproduction/review)</summary>',
    '',
    originalBody,
    '',
    '</details>',
    '',
  ].join('\n');

  const stamp = `${Date.now()}-${process.pid}`;
  const bodyFile = path.join(tmpDir, `spo-amend-body-${stamp}.md`);
  fs.writeFileSync(bodyFile, body);

  const reportIntakeLabel = deps.reportIntakeLabel || config.reportIntakeLabel;
  const editArgs = [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    ghRepo,
    '--title',
    applied.title,
    '--body-file',
    bodyFile,
    '--add-label',
    `cat:${applied.category}`,
    '--add-label',
    `size:${applied.size}`,
  ];
  if (reportIntakeLabel) editArgs.push('--remove-label', reportIntakeLabel);

  const editResult = runSync(deps, 'gh', editArgs);
  const editExit = normalizeExit(editResult);
  if (editExit !== 0) {
    return {
      ok: false,
      error: `amendCard: gh issue edit exited ${editExit}`,
      stderr: editResult && editResult.stderr,
      timedOut: editResult.timedOut === true,
    };
  }

  const commented = postIssueComment(issueNumber, review.first_comment_markdown, { ...deps, ghRepo, tmpDir });
  if (!commented.ok) {
    return { ok: false, error: `amendCard: ${commented.error}`, issueNumber };
  }

  return { ok: true, issueNumber, url: `https://github.com/${ghRepo}/issues/${issueNumber}`, bodyFile };
}

// ---- triageBugReport --------------------------------------------------------------------------

// triageBugReport(reportFile, deps) -- calls prompts/triage-bug-report.md through
// invokeClaudeReal (model opus, effort medium, an account from the pool) for ONE report file
// under ~/.spo-reports: reproduces it, routes it (desktop/mobile), dedups by anchorKey, and
// either drafts a card (never files it -- reviewCard/fileCard do that, same gate every other
// card gets) or reports why it stopped short. Returns {ok: true, outcome, ...} where the extra
// fields depend on outcome (see prompts/triage-bug-report.md's header), or {ok: false, error} for
// a mechanical failure (no account, a bad spawn, invalid JSON, an unrecognized outcome, or -- for
// outcome "draft" -- a draft that fails the same validateDraftContract every other draft is
// checked against). Never throws for a recognized failure, same discipline as draftCard/reviewCard.
//
// Model/effort/budget: opus/medium (maintainer decision, 2026-08-31). It ran fable/high, the
// tier reviewCard uses, on the reasoning that this step judges evidence (log correlation,
// geometry predicates) rather than doing execution-shaped work like draftCard. Two things moved
// it. First, availability: fable/high wedged the whole report pipeline for 12.8 hours on
// 2026-08-30/31 -- 53 consecutive auto-triage cycles, 128 attempts across issues 449/455/456,
// every one dying on "You've reached your Fable 5 limit" (api_error_status=429). At the time,
// pickAccount() neither rotated nor cooled, so each cycle re-picked the one account that could
// not serve the one model this step asked for -- fixed below by callIntakeStepWithRotation
// (plan action 3.6, 2026-08-31). Second, quality: a fable verdict on this project has
// repeatedly needed an Opus re-read before it could be acted on, and triage is the step that
// decides whether a human's bug report becomes a card at all -- a wrong "do-not-file" is
// invisible and unrecoverable without `spo triage --retry`, which does not exist yet (plan 3.4).
// Effort drops high -> medium with the model change rather than staying pinned: Opus 5 at medium
// is the stronger judge here, and holding effort at high would raise the per-report cost of a
// step that runs on every confirmed report for no measured gain.
//
// Plan action 3.3 (cap + backoff on classifier false positives) is still separate work; this
// change (3.6) is what makes an opus limit on the picked account actually rotate instead of
// wedging the whole pipeline again.
//
// Bash is in allowedTools (unlike draftCard's read-only set): step 1's server-log curl and step
// 3's `gh issue list --search` dedup both need it; permissionMode stays 'plan' regardless --
// neither of those is a write.
//
// `selfIssue` -- required, not optional: under the human-first design the report has ALREADY
// been filed as a raw card (orchestrator/report-intake.js's runReportIntake) before this ever
// runs, so its own dedup search (prompts/triage-bug-report.md § 3) would otherwise find its own
// raw card and call the report a duplicate of itself. Every real caller (auto-triage.js's
// processConfirmedReport) always has this issue number by construction.
//
// Retry policy: exactly one retry, same account, same deadline, and only when steps/llm.js
// reported `timedOut: true` (a deadline kill, not a parsed-reply failure). The result then
// carries `retriedAfterTimeout: {account, deadlineMs, firstError, retryOk, retryTimedOut}` --
// auto-triage.js journals it as `report-triage-retry`. See the retry's own inline comment below
// for why the same account/deadline, not a rotated one.
//
// Account rotation (plan action 3.6, 2026-08-31): routed through callIntakeStepWithRotation (see
// its own header) instead of a bare accounts.pick() -- a {kind: 'limit'} result now cools the
// account and rotates to the next healthy one, bounded to one pass over the pool, instead of
// re-picking the same limited account forever (the 12.8-hour incident this fixes). Result
// carries `cooldowns` whenever this call caused at least one; auto-triage.js journals each as
// `report-triage-cooldown`. Composes with the timeout retry above WITHOUT conflict: rotation
// only ever looks at the result AFTER the timeout retry has already run its course on the same
// account, so a single logical call never both retries-for-timeout AND rotates-for-limit at once
// -- see callIntakeStepWithRotation's header for the exact ordering.
async function triageBugReport(reportFile, selfIssue, deps = {}) {
  const productRepo = deps.productRepo || config.productRepo;
  const ghRepo = deps.ghRepo || config.ghRepo;
  const today = deps.today || new Date().toISOString().slice(0, 10);

  const promptText = fillPromptTemplate(TRIAGE_BUG_REPORT_PROMPT, {
    report_file: reportFile,
    product_repo: productRepo,
    repo: ghRepo,
    today,
    self_issue: String(selfIssue),
  });

  // ONE retry, and only on a deadline kill (steps/llm.js's `timedOut`, never a parsed-reply
  // failure). Rationale, 2026-08-30 (report #449): triageBugReport is the one intake step with no
  // retry at all -- state-machine.js's callLlmStep retries LLM steps on `kind: 'limit'` by
  // rotating accounts, but nothing covers this path -- and its prompt runs a `curl` against a
  // third-party game server, so a hang is plausible AND plausibly transient.
  //
  // Same account on purpose: a deadline kill says nothing about account health (the account
  // worked; the prompt hung), cooling it via accounts.markLimit would be factually wrong, and
  // accounts.pick() has no exclusion parameter anyway. Same deadline and same budget: the cause
  // is a hang, not structural slowness -- doubling the deadline would let one report hold a whole
  // `spo triage` cycle for 10 minutes on no measurement at all.
  //
  // A malformed reply is NOT retried: that is a prompt/model defect, and re-running it costs
  // another full budget to reproduce the same defect.
  //
  // (The retry loop itself now lives inside callIntakeStepWithRotation, called below -- this
  // comment stays here, next to the call site, since it explains a design decision specific to
  // this step, not the shared mechanics.)
  const attempt = await callIntakeStepWithRotation('triageBugReport', deps, (account) => ({
    step: 'TRIAGE_BUG_REPORT',
    model: 'opus',
    effort: 'medium',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'plan', // read-only -- triage-bug-report.md: "never file, never post, never move the report"
    maxBudgetUsd: deps.maxBudgetUsd, // no $ cap by default -- Claude Max subscription, no overage risk
    jsonSchema: { type: 'object', required: ['outcome'] },
    promptText,
    cwd: productRepo, // needs Read/Grep/Bash over the product tree, plus curl/gh
    account,
    deadlineMs: deps.deadlineMs || INTAKE_DEADLINE_MS,
  }));

  if (attempt.ok === false) return attempt; // pool exhausted or nothing to try -- see helper header

  const { raw, retriedAfterTimeout, cooldowns } = attempt;
  // Every exit below carries the retry record when there was one, so the case worth diagnosing
  // -- a retry followed by an unusable reply -- is not the one case that loses the trace.
  const withRetry = withIntakeRetryAndCooldowns(retriedAfterTimeout, cooldowns);

  if (!raw.ok) {
    return withRetry({ ok: false, error: formatLlmFailure('triageBugReport', raw) });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.result);
  } catch {
    return withRetry({ ok: false, error: 'triageBugReport: reply was not valid JSON' });
  }

  if (!parsed || typeof parsed !== 'object' || !TRIAGE_OUTCOMES.has(parsed.outcome)) {
    return withRetry({ ok: false, error: `triageBugReport: unrecognized outcome "${parsed && parsed.outcome}"` });
  }

  if (parsed.outcome === 'draft') {
    // Reproduced live 2026-08-30: fable occasionally double-encodes the nested `draft` object
    // as a JSON STRING (`"draft": "{\"title\": ...}"`) instead of a literal object, despite the
    // header's own example showing it unquoted. Recover it rather than discard a real,
    // well-reproduced finding over a formatting slip -- one JSON.parse, and only when `draft`
    // is a string in the first place (an already-correct object is untouched).
    if (typeof parsed.draft === 'string') {
      try {
        parsed.draft = JSON.parse(parsed.draft);
      } catch {
        return withRetry({ ok: false, error: 'triageBugReport: draft was a string and not valid JSON either' });
      }
    }
    const check = validateDraftContract(parsed.draft);
    if (!check.ok) {
      return withRetry({ ok: false, error: `triageBugReport: draft ${check.error}` });
    }
  }
  if (parsed.outcome === 'duplicate' && !(Number.isInteger(parsed.issue_number) && parsed.issue_number > 0)) {
    return withRetry({ ok: false, error: 'triageBugReport: outcome "duplicate" missing a valid issue_number' });
  }

  // retriedAfterTimeout is spread AFTER ...parsed on purpose: a model reply that happened to
  // contain this key by accident must never shadow our own retry record.
  return withRetry({ ok: true, outcome: parsed.outcome, ...parsed, sessionId: raw.sessionId, ...tokenFieldsFrom(raw) });
}

// ---- pullBoard ------------------------------------------------------------------------------

// One candidate line looks like `  <rank> #<issue> area=<a> <title>` (leading indent, `area=`
// value may legitimately be empty -- CLAUDE.md: "an empty area blocks nothing"). The other
// lines `npm run board:claim` prints (rateLimit/items/busy-areas/candidates headers, `#<n>
// blocked by …` tails) are recognized and skipped silently; anything else is unrecognized and
// skipped WITH a warning, never a crash.
const CANDIDATE_LINE_RE = /^\s*(\d+)\s+#(\d+)\s+area=(\S*)\s+(.+?)\s*$/;
const NOISE_LINE_RE = /^(rateLimit\b|items:\s|busy areas:|candidates:\s*\d)/;
const BLOCKED_LINE_RE = /^#\d+\s+blocked by/;

function parseBoardClaimOutput(stdout) {
  const candidates = [];
  const warnings = [];

  for (const rawLine of (stdout || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    const m = line.match(CANDIDATE_LINE_RE);
    if (m) {
      candidates.push({ rank: Number(m[1]), issue: Number(m[2]), area: m[3] || '', title: m[4] });
      continue;
    }
    if (NOISE_LINE_RE.test(line) || BLOCKED_LINE_RE.test(line)) continue;

    warnings.push(`pullBoard: skipped unrecognized line: ${line}`);
  }

  return { candidates, warnings };
}

// pullBoard(deps) -- spawns `npm run board:claim` (cwd = the product repo) and parses its
// claimable-candidate lines, in the priority order they were printed. Read-only: never claims,
// never writes the board. Returns {ok: true, candidates, warnings} or {ok: false, error}.
function pullBoard(deps = {}) {
  const productRepo = deps.productRepo || config.productRepo;
  const result = runSync(deps, 'npm', ['run', 'board:claim'], { cwd: productRepo });
  const exit = normalizeExit(result);
  const stdout = (result && result.stdout) || '';

  if (exit !== 0) {
    return { ok: false, error: `pullBoard: npm run board:claim exited ${exit}`, stdout, timedOut: result.timedOut === true };
  }

  const { candidates, warnings } = parseBoardClaimOutput(stdout);
  return { ok: true, candidates, warnings };
}

// ---- makeTask -------------------------------------------------------------------------------

// The "done means"/acceptance section of a card body, else the full body. draft-card.md's own
// output heads that section `## Done means` (or, inline, `Done means:`); a card filed by a human
// or an older path might instead use an "Acceptance"/"Acceptance criteria" heading -- both forms
// are recognized here.
const CRITERION_HEADING_RE = /^#{1,6}\s*(?:done means|acceptance(?:\s+criteria)?)\s*$/im;
const CRITERION_INLINE_RE = /^[ \t]*(?:\*\*)?(?:done means|acceptance(?:\s+criteria)?)(?:\*\*)?:\s*(.+)$/im;

// Strips <details>...</details> blocks -- nesting included -- out of an issue body.
//
// Why here: amendCard (above) archives the pre-edit body inside a
// <details><summary>Original report (raw intake...)</summary> block -- content deliberately
// collapsed, never an acceptance criterion. An in-game bug report embeds its own
// <details><summary>journal (N entries captured)</summary> on top, so the final body carries
// TWO copies of the report and TWO WebSocket journals, nested. On card #452, extractCriterion's
// fallback below (the whole body, for lack of a "Done means" heading) turned that into a 99896-
// byte criterion -- against 1-2KB for a normal card (#347: 1048B, #201: 1930B, #450: 2177B) --
// copied verbatim into every LLM prompt for the task.
//
// A depth-tracking scanner, not a regex: a non-greedy /<details.*?<\/details>/ stops at the
// nested block's own closing tag and leaves an orphaned </details> plus a copy of the report
// (verified against #452's real body); the greedy variant swallows real text sitting between two
// sibling blocks instead. Neither handles arbitrary nesting.
//
// An unclosed <details> returns the ENTIRE original text untouched, stripping nothing: a
// too-long criterion beats one truncated by malformed markup, and by the time an opening tag
// has no matching close there is no well-formed prefix left to salvage anyway.
const DETAILS_TAG_RE = /<\/?details\b[^>]*>/gi;

function stripDetailsBlocks(text) {
  let out = '';
  let depth = 0;
  let last = 0;
  let match;
  DETAILS_TAG_RE.lastIndex = 0;
  while ((match = DETAILS_TAG_RE.exec(text))) {
    const isOpen = match[0][1] !== '/';
    if (isOpen) {
      if (depth === 0) out += text.slice(last, match.index);
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) last = match.index + match[0].length;
    } else {
      // An orphaned </details> (no open block in progress) -- drop the tag, keep the text.
      out += text.slice(last, match.index);
      last = match.index + match[0].length;
    }
  }
  if (depth > 0) return text; // unclosed <details> -- bail out, return the original as-is
  out += text.slice(last);
  return out;
}

function extractCriterion(body) {
  // Stripped before EITHER search runs, not just before the fallback: a "Done means" heading
  // could itself live inside amendCard's archived copy, and extracting it from there would
  // report the pre-review criterion instead of the triaged one. No card filed via
  // draft-card.md ever puts its own "## Done means" inside a <details> block -- it is always a
  // top-level section -- so this never touches the common case.
  const stripped = stripDetailsBlocks(body || '');
  // Safety net: a body that is ENTIRELY one <details> block would otherwise strip to nothing,
  // parking the card on a missing-placeholder error. A too-long criterion is recoverable; an
  // empty one is not.
  const text = stripped.trim() ? stripped : (body || '');

  const heading = text.match(CRITERION_HEADING_RE);
  if (heading) {
    const rest = text.slice(heading.index + heading[0].length);
    // Stop at the next heading OR the first blank line (paragraph break), whichever comes
    // first -- draft-card.md's own "Done means" section is one line or a short paragraph, and
    // its own text always ends with a trailing "Source: maintainer request, <date>" line
    // separated by a blank line, which must never be swept into the criterion.
    const nextHeading = rest.match(/^#{1,6}\s+\S/m);
    const blankLine = rest.match(/\n[ \t]*\n/);
    const cutPoints = [nextHeading && nextHeading.index, blankLine && blankLine.index].filter(
      (n) => typeof n === 'number'
    );
    const cut = cutPoints.length ? Math.min(...cutPoints) : -1;
    const section = (cut === -1 ? rest : rest.slice(0, cut)).trim();
    if (section) return section;
  }

  const inline = text.match(CRITERION_INLINE_RE);
  if (inline) {
    const afterLabel = text.slice(inline.index).replace(/^[ \t]*(?:\*\*)?(?:done means|acceptance(?:\s+criteria)?)(?:\*\*)?:\s*/i, '');
    const blank = afterLabel.search(/\n[ \t]*\n/);
    const section = (blank === -1 ? afterLabel : afterLabel.slice(0, blank)).trim();
    if (section) return section;
  }

  return text.trim();
}

function taskAlreadyExists(queueDir, journalRoot, id, issueNumber) {
  if (fs.existsSync(path.join(journalRoot, id))) return true;
  if (!fs.existsSync(queueDir)) return false;

  for (const file of fs.readdirSync(queueDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(queueDir, file), 'utf8'));
      if (existing && (existing.id === id || existing.issue === issueNumber)) return true;
    } catch {
      // malformed queue file -- not this task, never crash the scan over it
    }
  }
  return false;
}

// Zero-padded sequence prefix for the next queue file, so filename sort (state-machine.js's
// processing order) matches the order `spo pull` wrote them in. Scans existing `NNNN-...json`
// prefixes and picks max+1, starting at 1 for an empty/missing queue dir.
function nextQueueSeq(queueDir) {
  if (!fs.existsSync(queueDir)) return 1;
  let max = 0;
  for (const file of fs.readdirSync(queueDir)) {
    const m = file.match(/^(\d+)-/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// makeTask(candidate, deps) -- fetches the issue body via `gh api repos/<repo>/issues/<n>` and
// writes queue/<zero-padded-seq>-issue-<n>.json in the `kind: "card"` shape state-machine.js's
// takeNextTask() consumes. Skips (never overwrites, never crashes) an issue already present in
// queue/ or journal/. Returns {ok: true, skipped, id, [file, task]} or {ok: false, error}.
function makeTask(candidate, deps = {}) {
  const ghRepo = deps.ghRepo || config.ghRepo;
  const queueDir = deps.queueDir || path.join(config.REPO_ROOT, 'queue');
  const journalRoot = deps.journalRoot || path.join(config.REPO_ROOT, 'journal');
  const id = `issue-${candidate.issue}`;

  if (taskAlreadyExists(queueDir, journalRoot, id, candidate.issue)) {
    return { ok: true, skipped: true, id, reason: `${id} already present in queue/ or journal/` };
  }

  const apiResult = runSync(deps, 'gh', ['api', `repos/${ghRepo}/issues/${candidate.issue}`]);
  const apiExit = normalizeExit(apiResult);
  if (apiExit !== 0) {
    return {
      ok: false,
      error: `makeTask: gh api issues/${candidate.issue} exited ${apiExit}`,
      timedOut: apiResult.timedOut === true,
    };
  }

  let issue;
  try {
    issue = JSON.parse(apiResult.stdout);
  } catch {
    return { ok: false, error: `makeTask: gh api issues/${candidate.issue} reply was not valid JSON` };
  }

  const body = issue.body || '';
  const labels = Array.isArray(issue.labels) ? issue.labels.map((l) => String((l && l.name) || l)) : [];

  // Second, independent guard against a mechanically-filed raw report card (report-intake.js's
  // runReportIntake, labeled config.reportIntakeLabel) ending up drained by the daemon before a
  // human has confirmed it and auto-triage has amended it with a real category/size/area. The
  // FIRST guard is the board column itself (SPO-WebClient's claim-read.sh only reads Status ==
  // Todo) -- this one covers the case that column move failed and the raw card ended up in Todo
  // anyway (see report-intake.js's own header on that failure mode). Skipping, not erroring:
  // a raw card here is not a mistake to report, it is exactly the state it is meant to be in
  // until a human acts.
  const reportIntakeLabel = deps.reportIntakeLabel || config.reportIntakeLabel;
  if (reportIntakeLabel && labels.includes(reportIntakeLabel)) {
    return { ok: true, skipped: true, id, reason: `${id} still carries "${reportIntakeLabel}" -- not yet confirmed/triaged` };
  }

  const sizeLabel = labels.find((l) => /^size:/i.test(l));
  const size = sizeLabel ? sizeLabel.split(':')[1].trim().toUpperCase() : 'M';
  const area = candidate.area || '';
  const touchesRdoMembers = area === 'rdo' || /rdo-members\.ts/.test(body);

  const task = {
    id,
    kind: 'card',
    issue: candidate.issue,
    title: issue.title || candidate.title,
    criterion: extractCriterion(body),
    size: VALID_SIZES.has(size) ? size : 'M',
    area,
    touchesRdoMembers,
  };

  fs.mkdirSync(queueDir, { recursive: true });
  const seq = nextQueueSeq(queueDir);
  const filename = `${String(seq).padStart(4, '0')}-issue-${candidate.issue}.json`;
  fs.writeFileSync(path.join(queueDir, filename), JSON.stringify(task, null, 2) + '\n');

  return { ok: true, skipped: false, id, file: filename, task };
}

module.exports = {
  draftCard,
  loadDraftFile,
  reviewCard,
  fileCard,
  amendCard,
  fetchIssue,
  postIssueComment,
  triageBugReport,
  pullBoard,
  makeTask,
  // exported for direct unit tests of the parsing/matching helpers
  validateDraftContract,
  applyMechanicalCorrections,
  parseBoardClaimOutput,
  extractCriterion,
  parseIssueNumber,
  parseIssueUrl,
  DRAFT_REQUIRED,
  REVIEW_REQUIRED,
  VALID_CATEGORIES,
  VALID_SIZES,
  VALID_AREAS,
  TRIAGE_OUTCOMES,
};
