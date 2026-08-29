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
const { spawnSync } = require('child_process');

const accounts = require('./accounts');
const config = require('./config');
const { invokeClaudeReal } = require('./steps/llm');
const { fillPromptTemplate } = require('./prompt-template');
const { SMALL_BUDGET_USD } = require('./step-contracts');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const DRAFT_CARD_PROMPT = path.join(PROMPTS_DIR, 'draft-card.md');
const REVIEW_CARD_PROMPT = path.join(PROMPTS_DIR, 'review-card.md');

const DRAFT_REQUIRED = ['title', 'body_markdown', 'category', 'size', 'area', 'is_bug_report', 'confirmed'];
const REVIEW_REQUIRED = ['verdict', 'corrections', 'first_comment_markdown'];
const REVIEW_VERDICTS = new Set(['FILE', 'FILE_AMENDED', 'DO_NOT_FILE']);

const VALID_CATEGORIES = new Set(['defect', 'latent-trap', 'feature', 'observation', 'doc-infra']);
const VALID_SIZES = new Set(['S', 'M', 'L']);
const VALID_AREAS = new Set(['docs', 'rdo', 'bench', 'renderer', 'gateway', 'client', 'e2e', 'shared', 'ci']);

// ---- shared spawn primitive (same injection convention as steps/llm.js / steps/scripted.js) ----

function runSync(deps, command, args, opts = {}) {
  const spawnSyncFn = (deps && deps.spawnSync) || spawnSync;
  return spawnSyncFn(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function normalizeExit(result) {
  if (result && result.error) return -1;
  const status = result && result.status;
  return status === null || status === undefined ? 1 : status;
}

function pickAccount(deps) {
  const accountsDir = (deps && deps.accountsDir) || config.claudeAccountsDir;
  return accounts.pick(accountsDir);
}

// ---- DRAFT_CARD ------------------------------------------------------------------------------

// draftCard(requestText, deps) -- calls prompts/draft-card.md through invokeClaudeReal (model
// sonnet, effort medium, small budget, an account from the pool via accounts.pick), then parses
// and validates the returned contract. Returns {ok: true, draft, sessionId, costUsd} or
// {ok: false, error} -- never throws for a recognized failure (no account available, a spawn
// failure, invalid JSON, a missing/invalid field): those are all "mechanical failure", the
// caller's job to report and exit non-zero on, not a crash.
//
// Model choice: Sonnet 5, not Fable -- drafting is execution-shaped work (turning a request into
// prose + citations), the same tier IMPLEMENT runs on. review-card stays the neutral judge on
// Fable 5: a different model from the drafter, and cheap, since its own context is tiny (one
// card, not a whole worktree).
async function draftCard(requestText, deps = {}) {
  let account;
  try {
    account = pickAccount(deps);
  } catch (err) {
    return { ok: false, error: `draftCard: ${err.message}` };
  }

  const productRepo = deps.productRepo || config.productRepo;
  const today = deps.today || new Date().toISOString().slice(0, 10);

  const promptText = fillPromptTemplate(DRAFT_CARD_PROMPT, {
    request_text: requestText,
    product_repo: productRepo,
    today,
  });

  const opts = {
    step: 'DRAFT_CARD',
    model: 'sonnet',
    effort: 'medium',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'plan', // read-only -- draft-card.md: "you hold no edit tool"
    maxBudgetUsd: SMALL_BUDGET_USD,
    jsonSchema: { type: 'object', required: DRAFT_REQUIRED },
    promptText,
    cwd: productRepo, // needs Read/Grep over the product tree to find file:line references
    account,
    deadlineMs: deps.deadlineMs || config.stepDeadlineMs,
  };

  const raw = await invokeClaudeReal(opts, deps);
  if (!raw.ok) {
    return { ok: false, error: `draftCard: claude call failed (${raw.kind || 'error'}): ${raw.error || raw.result || ''}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.result);
  } catch {
    return { ok: false, error: 'draftCard: reply was not valid JSON' };
  }

  const check = validateDraftContract(parsed);
  if (!check.ok) {
    return { ok: false, error: `draftCard: ${check.error}` };
  }

  return { ok: true, draft: parsed, sessionId: raw.sessionId, costUsd: raw.costUsd };
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
// costUsd} where `review` is {verdict, corrections, first_comment_markdown}, or {ok: false,
// error}.
async function reviewCard(draft, deps = {}) {
  let account;
  try {
    account = pickAccount(deps);
  } catch (err) {
    return { ok: false, error: `reviewCard: ${err.message}` };
  }

  const ghRepo = deps.ghRepo || config.ghRepo;
  const productRepo = deps.productRepo || config.productRepo;

  const promptText = fillPromptTemplate(REVIEW_CARD_PROMPT, {
    card_title: draft.title,
    card_body: draft.body_markdown,
    card_category: draft.category,
    card_size: draft.size,
    card_area: draft.area,
    repo: ghRepo,
  });

  const opts = {
    step: 'REVIEW_CARD',
    model: 'fable',
    effort: 'high',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], // review-card.md: "Read, Grep, Glob, Bash(ro)"
    permissionMode: 'default',
    maxBudgetUsd: SMALL_BUDGET_USD,
    jsonSchema: { type: 'object', required: REVIEW_REQUIRED },
    promptText,
    cwd: productRepo, // reads the product tree + `gh issue list --repo {{repo}}`
    account,
    deadlineMs: deps.deadlineMs || config.stepDeadlineMs,
  };

  const raw = await invokeClaudeReal(opts, deps);
  if (!raw.ok) {
    return { ok: false, error: `reviewCard: claude call failed (${raw.kind || 'error'}): ${raw.error || raw.result || ''}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.result);
  } catch {
    return { ok: false, error: 'reviewCard: reply was not valid JSON' };
  }

  const missing = REVIEW_REQUIRED.filter((key) => !(key in parsed));
  if (missing.length > 0) {
    return { ok: false, error: `reviewCard: reply missing required key(s): ${missing.join(', ')}` };
  }
  if (!REVIEW_VERDICTS.has(parsed.verdict)) {
    return { ok: false, error: `reviewCard: unrecognized verdict "${parsed.verdict}"` };
  }

  return { ok: true, review: parsed, sessionId: raw.sessionId, costUsd: raw.costUsd };
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

// ---- fileCard -----------------------------------------------------------------------------

function parseIssueNumber(stdout) {
  const m = (stdout || '').match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseIssueUrl(stdout) {
  const m = (stdout || '').match(/https?:\/\/\S+\/issues\/\d+/);
  return m ? m[0] : null;
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
  const commentFile = path.join(tmpDir, `spo-card-comment-${stamp}.md`);
  fs.writeFileSync(bodyFile, applied.body_markdown || '');
  fs.writeFileSync(commentFile, review.first_comment_markdown || '');

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
    return { ok: false, error: `fileCard: gh issue create exited ${createExit}`, stderr: createResult && createResult.stderr };
  }

  const issueNumber = parseIssueNumber(createResult.stdout);
  if (!issueNumber) {
    return { ok: false, error: 'fileCard: could not parse an issue number from gh issue create output' };
  }

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
    return { ok: false, error: `fileCard: gh issue comment exited ${commentExit}`, issueNumber };
  }

  const url = parseIssueUrl(createResult.stdout) || `https://github.com/${ghRepo}/issues/${issueNumber}`;
  return { ok: true, issueNumber, url, bodyFile, commentFile };
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
    return { ok: false, error: `pullBoard: npm run board:claim exited ${exit}`, stdout };
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

function extractCriterion(body) {
  const text = body || '';

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
    return { ok: false, error: `makeTask: gh api issues/${candidate.issue} exited ${apiExit}` };
  }

  let issue;
  try {
    issue = JSON.parse(apiResult.stdout);
  } catch {
    return { ok: false, error: `makeTask: gh api issues/${candidate.issue} reply was not valid JSON` };
  }

  const body = issue.body || '';
  const labels = Array.isArray(issue.labels) ? issue.labels.map((l) => String((l && l.name) || l)) : [];
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
};
