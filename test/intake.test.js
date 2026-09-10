'use strict';
// Unit tests for orchestrator/intake.js (draftCard/loadDraftFile/reviewCard/fileCard/pullBoard/
// makeTask) and bin/spo's cmdAsk/cmdPull wiring around them. Every LLM call is injected via
// deps.spawnSync (same convention as test/llm-real-card.test.js); every gh/npm call is injected
// the same way (same convention as test/real-steps.test.js). No real `claude`/`gh`/`npm`
// process is ever spawned. cmdAsk/cmdPull are exercised through bin/spo's own `deps.intake`
// override (see bin/spo's header comment on cmdAsk) rather than reimplementing their logic here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { mkTmp, writePoolDir, timeoutResult } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const intake = require('../orchestrator/intake');
const accounts = require('../orchestrator/accounts');
const spo = require('../bin/spo');
const orchestratorConfig = require('../orchestrator/config');
const { lockPath } = require('../orchestrator/lock');
const { stateJournalRoot, stateQueueDir } = require('../orchestrator/state-root');
// A genuine daemon-side consumer of config.ghRepo -- see "the daemon-untouched pin" section far
// below for why this is required here rather than intake.js's fileCard (fileCard has exactly one
// caller in the whole codebase, bin/spo's cmdAsk -- not a daemon call site at all).
const parkLoop = require('../orchestrator/park-loop');

function fakeSpawnSync(responder) {
  return (command, args, opts) => responder(command, args, opts);
}

// The same shape invokeClaudeReal's real spawn parses (llm-real-card.test.js's own helper).
function realShapedReply(resultObj, overrides = {}) {
  return {
    result: typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj),
    is_error: false,
    num_turns: 1,
    session_id: 'sess-intake-1',
    modelUsage: { 'claude-x': { costUSD: 0.001 } },
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}

function poolDir() {
  return writePoolDir(mkTmp('spo-intake-pool-'), [{ name: 'acct1' }]);
}

// A two-account pool for the rotation tests below -- registry order is alphabetical (see
// accounts.js's readRegistry), so 'acct1' is always picked first, 'acct2' second.
function twoAccountPoolDir() {
  return writePoolDir(mkTmp('spo-intake-pool2-'), [{ name: 'acct1' }, { name: 'acct2' }]);
}

// A {kind: 'limit', limitKind: 'usage'} shaped raw spawn result -- api_error_status: 429 is
// steps/llm.js's own unambiguous classifyFailure rule (see its header comment): a structured
// status, never the free-text scan action 3.5 removed.
function limitSpawnResult() {
  return {
    status: 1,
    stdout: JSON.stringify(realShapedReply('rate limited', { is_error: true, api_error_status: 429 })),
    stderr: '',
    signal: null,
  };
}

// A {kind: 'limit', limitKind: 'overloaded'} shaped raw spawn result -- api_error_status: 529 is
// Anthropic's documented "overloaded" status (action 3.5): the SERVER is busy, not this
// account's own quota, so accounts.markLimit cools it for the flat 5-minute tier, never the
// usage tiers (1h probe / 5h escalated), no matter how often it recurs.
function overloadedSpawnResult() {
  return {
    status: 1,
    stdout: JSON.stringify(
      realShapedReply('overloaded', { is_error: true, api_error_status: 529, terminal_reason: 'overloaded_error' })
    ),
    stderr: '',
    signal: null,
  };
}

const VALID_DRAFT = {
  title: 'Header lacks a connection-state badge',
  body_markdown: [
    'The header never shows whether the gateway connection is up.',
    '',
    '## Done means',
    'The header renders a badge reflecting connection state.',
    '',
    'Source: maintainer request, 2026-08-29',
  ].join('\n'),
  category: 'feature',
  size: 'S',
  area: 'client',
  is_bug_report: false,
  confirmed: false,
};

// ---- draftCard --------------------------------------------------------------------------------

test('draftCard: happy path sends model sonnet / effort medium and returns the validated draft', async () => {
  let seenArgv = null;
  let seenInput = null;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenArgv = argv;
      seenInput = opts.input;
      return { status: 0, stdout: JSON.stringify(realShapedReply(VALID_DRAFT)), stderr: '', signal: null };
    }),
  };

  const result = await intake.draftCard('the header has no connection badge', deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, VALID_DRAFT);

  const modelIdx = seenArgv.indexOf('--model');
  assert.equal(seenArgv[modelIdx + 1], 'sonnet');
  const effortIdx = seenArgv.indexOf('--effort');
  assert.equal(seenArgv[effortIdx + 1], 'medium');
  assert.ok(seenInput.includes('the header has no connection badge'));
});

test('draftCard: reply whose result is not valid JSON -> {ok:false, error}', async () => {
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply('not json at all')),
      stderr: '',
      signal: null,
    })),
  };

  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test('draftCard: reply missing a required key -> clear error, never a crash', async () => {
  const incomplete = { ...VALID_DRAFT };
  delete incomplete.confirmed;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply(incomplete)),
      stderr: '',
      signal: null,
    })),
  };

  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /confirmed/);
});

test('draftCard: reply with an unrecognized category -> clear error', async () => {
  const bad = { ...VALID_DRAFT, category: 'urgent' };
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply(bad)),
      stderr: '',
      signal: null,
    })),
  };

  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /category/);
});

test('draftCard: no account registered -> clear error, never spawns', async () => {
  let called = false;
  const deps = {
    accountsDir: mkTmp('spo-intake-empty-pool-'), // empty pool -- zero registered accounts
    spawnSync: fakeSpawnSync(() => {
      called = true;
      return { status: 0, stdout: '{}', stderr: '', signal: null };
    }),
  };

  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /no-accounts-registered/);
  assert.equal(called, false);
});

// ---- draftCard: one retry on a deadline timeout, never on a malformed reply -------------------
// Same policy as triageBugReport's own retry (see that section below) -- draftCard/reviewCard
// were the two other intake LLM steps with no retry at all (card #449 follow-up, 2026-08-30).

test('draftCard: a deadline timeout is retried exactly once, and the retry\'s answer is the result', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return calls === 1 ? timeoutSpawnResult() : okSpawnResult(VALID_DRAFT);
    },
  };
  const result = await intake.draftCard('anything', deps);
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, VALID_DRAFT);
  assert.equal(result.retriedAfterTimeout.retryOk, true);
  assert.equal(result.retriedAfterTimeout.retryTimedOut, false);
});

test('draftCard: the retry uses the SAME account and the SAME deadline as the first attempt', async () => {
  const seenOpts = [];
  const deps = {
    accountsDir: poolDir(),
    deadlineMs: 12345,
    spawnSync: (command, args, opts) => {
      seenOpts.push(opts);
      return seenOpts.length === 1 ? timeoutSpawnResult() : okSpawnResult(VALID_DRAFT);
    },
  };
  await intake.draftCard('anything', deps);
  assert.equal(seenOpts.length, 2);
  assert.equal(seenOpts[0].timeout, 12345);
  assert.equal(seenOpts[1].timeout, 12345);
  assert.deepEqual(seenOpts[0].env.CLAUDE_CONFIG_DIR, seenOpts[1].env.CLAUDE_CONFIG_DIR);
});

test('draftCard: two consecutive timeouts -- one retry only, then give up', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return timeoutSpawnResult();
    },
  };
  const result = await intake.draftCard('anything', deps);
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeded the \d+ms deadline/);
  assert.equal(result.retriedAfterTimeout.retryTimedOut, true);
});

test('draftCard: a malformed reply is NOT retried', async () => {
  const deps = { accountsDir: poolDir(), spawnSync: seqSpawnSync([{ status: 0, stdout: 'not json at all', stderr: '', signal: null }, okSpawnResult(VALID_DRAFT)]) };
  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, false);
  assert.equal(result.retriedAfterTimeout, undefined);
});

// ---- draftCard: account rotation on kind:'limit' (plan action 3.6) -----------------------------
// Incident, 2026-08-30/31: intake's bare accounts.pick() never rotated and never called
// markLimit, so a rate-limited account was re-picked forever. draftCard is "one other step"
// alongside triageBugReport's fuller coverage below.

test('draftCard: a kind:\'limit\' failure on the first account rotates to a healthy second, whose result is returned', async () => {
  const accountsDir = twoAccountPoolDir();
  const seenOpts = [];
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) => {
      seenOpts.push(opts);
      if (opts.env.CLAUDE_CONFIG_DIR.endsWith('acct1')) return limitSpawnResult();
      return okSpawnResult(VALID_DRAFT);
    },
  };

  const result = await intake.draftCard('anything', deps);

  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, VALID_DRAFT);
  assert.equal(seenOpts.length, 2);
  assert.notEqual(seenOpts[0].env.CLAUDE_CONFIG_DIR, seenOpts[1].env.CLAUDE_CONFIG_DIR, 'must call on two DIFFERENT accounts');
  assert.ok(seenOpts[0].env.CLAUDE_CONFIG_DIR.endsWith('acct1'));
  assert.ok(seenOpts[1].env.CLAUDE_CONFIG_DIR.endsWith('acct2'));
});

test('draftCard: the limited account is actually cooled down (markLimit written to state.json)', async () => {
  const accountsDir = twoAccountPoolDir();
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) =>
      opts.env.CLAUDE_CONFIG_DIR.endsWith('acct1') ? limitSpawnResult() : okSpawnResult(VALID_DRAFT),
  };

  const result = await intake.draftCard('anything', deps);

  assert.equal(result.ok, true);
  assert.equal(result.cooldowns.length, 1);
  assert.equal(result.cooldowns[0].account, 'acct1');
  // 429 -> limitKind 'usage' -> R1's 1h PROBE tier on a first-ever hit for this account
  // (fresh pool dir per test), not the escalated 5h tier.
  assert.equal(result.cooldowns[0].cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);

  const state = accounts.readState(accountsDir);
  assert.ok(state.acct1, 'acct1 should be cooling');
  assert.ok(state.acct1.cooldownUntil > Date.now());
  assert.ok(!state.acct2, 'acct2 should not be cooling');
});

test('draftCard: a 529 (overloaded) failure cools the account for the short 5-minute tier, not the 5-hour usage tier', async () => {
  const accountsDir = twoAccountPoolDir();
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) =>
      opts.env.CLAUDE_CONFIG_DIR.endsWith('acct1') ? overloadedSpawnResult() : okSpawnResult(VALID_DRAFT),
  };

  const result = await intake.draftCard('anything', deps);

  assert.equal(result.ok, true);
  assert.equal(result.cooldowns.length, 1);
  assert.equal(result.cooldowns[0].account, 'acct1');
  assert.equal(result.cooldowns[0].cooldownMs, accounts.OVERLOADED_COOLDOWN_MS);

  const state = accounts.readState(accountsDir);
  assert.ok(state.acct1.cooldownUntil <= Date.now() + accounts.OVERLOADED_COOLDOWN_MS + 5000);
});

test('draftCard: every account limited -> {ok:false, error} naming the exhaustion, never a throw', async () => {
  const accountsDir = twoAccountPoolDir();
  let calls = 0;
  const deps = {
    accountsDir,
    spawnSync: () => {
      calls++;
      return limitSpawnResult();
    },
  };

  const result = await intake.draftCard('anything', deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /draftCard/);
  assert.match(result.error, /cooling|exhaust/i);
  assert.equal(calls, 2, 'exactly one attempt per enabled account, never a third');
  assert.equal(result.cooldowns.length, 2);

  const state = accounts.readState(accountsDir);
  assert.ok(state.acct1);
  assert.ok(state.acct2);
});

test('draftCard: a normal (non-limit, non-timeout) failure does not rotate at all', async () => {
  const accountsDir = twoAccountPoolDir();
  let calls = 0;
  const deps = {
    accountsDir,
    spawnSync: () => {
      calls++;
      return {
        status: 1,
        stdout: JSON.stringify(realShapedReply('bad schema', { is_error: true, api_error_status: 400 })),
        stderr: '',
        signal: null,
      };
    },
  };

  const result = await intake.draftCard('anything', deps);

  assert.equal(calls, 1, 'must not rotate on a non-limit failure');
  assert.equal(result.ok, false);
  assert.equal(result.cooldowns, undefined);

  const state = accounts.readState(accountsDir);
  assert.deepEqual(state, {}, 'no account should be cooled down for a non-limit failure');
});

// ---- loadDraftFile (the brainstorm lane) -------------------------------------------------------

test('loadDraftFile: happy path reads and validates an already-written draft JSON', () => {
  const dir = mkTmp('spo-draft-file-');
  const file = path.join(dir, 'draft.json');
  fs.writeFileSync(file, JSON.stringify(VALID_DRAFT, null, 2));

  const result = intake.loadDraftFile(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, VALID_DRAFT);
});

test('loadDraftFile: missing required key -> clear error, exit non-zero (no crash)', () => {
  const dir = mkTmp('spo-draft-file-missing-');
  const file = path.join(dir, 'draft.json');
  const incomplete = { ...VALID_DRAFT };
  delete incomplete.area;
  fs.writeFileSync(file, JSON.stringify(incomplete));

  const result = intake.loadDraftFile(file);
  assert.equal(result.ok, false);
  assert.match(result.error, /area/);
});

test('loadDraftFile: file does not exist -> clear error, never throws', () => {
  const result = intake.loadDraftFile('/nonexistent/path/draft.json');
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot read/);
});

// ---- reviewCard ---------------------------------------------------------------------------------

test('reviewCard: sends model fable / effort high, returns a DO_NOT_FILE verdict untouched', async () => {
  let seenArgv = null;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
      return {
        status: 0,
        stdout: JSON.stringify(
          realShapedReply({
            verdict: 'DO_NOT_FILE',
            corrections: [],
            first_comment_markdown: '### Card review\n\nNot a defect -- documented behaviour.',
          })
        ),
        stderr: '',
        signal: null,
      };
    }),
  };

  const result = await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(result.ok, true);
  assert.equal(result.review.verdict, 'DO_NOT_FILE');

  const modelIdx = seenArgv.indexOf('--model');
  assert.equal(seenArgv[modelIdx + 1], 'fable');
  const effortIdx = seenArgv.indexOf('--effort');
  assert.equal(seenArgv[effortIdx + 1], 'high');
});

test('reviewCard: deps.humanConfirmed threads {{human_confirmed}} into the prompt ("yes"/"no")', async () => {
  let seenPrompts = [];
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenPrompts.push(opts.input);
      return { status: 0, stdout: JSON.stringify(realShapedReply({ verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' })), stderr: '', signal: null };
    }),
  };

  await intake.reviewCard(VALID_DRAFT, { ...deps, humanConfirmed: true });
  await intake.reviewCard(VALID_DRAFT, deps); // no humanConfirmed at all -- every other caller

  assert.ok(seenPrompts[0].includes('human_confirmed:  yes'));
  assert.ok(seenPrompts[1].includes('human_confirmed:  no'));
});

// ---- reviewCard: one retry on a deadline timeout, never on a malformed reply -------------------

test('reviewCard: a deadline timeout is retried exactly once, and the retry\'s answer is the result', async () => {
  let calls = 0;
  const VALID_REVIEW = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return calls === 1 ? timeoutSpawnResult() : okSpawnResult(VALID_REVIEW);
    },
  };
  const result = await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.review.verdict, 'FILE');
  assert.equal(result.retriedAfterTimeout.retryOk, true);
  assert.equal(result.retriedAfterTimeout.retryTimedOut, false);
});

test('reviewCard: the retry uses the SAME account and the SAME deadline as the first attempt', async () => {
  const seenOpts = [];
  const VALID_REVIEW = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };
  const deps = {
    accountsDir: poolDir(),
    deadlineMs: 12345,
    spawnSync: (command, args, opts) => {
      seenOpts.push(opts);
      return seenOpts.length === 1 ? timeoutSpawnResult() : okSpawnResult(VALID_REVIEW);
    },
  };
  await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(seenOpts.length, 2);
  assert.equal(seenOpts[0].timeout, 12345);
  assert.equal(seenOpts[1].timeout, 12345);
  assert.deepEqual(seenOpts[0].env.CLAUDE_CONFIG_DIR, seenOpts[1].env.CLAUDE_CONFIG_DIR);
});

test('reviewCard: two consecutive timeouts -- one retry only, then give up', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return timeoutSpawnResult();
    },
  };
  const result = await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeded the \d+ms deadline/);
  assert.equal(result.retriedAfterTimeout.retryTimedOut, true);
});

test('reviewCard: a malformed reply is NOT retried', async () => {
  const VALID_REVIEW = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };
  const deps = { accountsDir: poolDir(), spawnSync: seqSpawnSync([{ status: 0, stdout: 'not json at all', stderr: '', signal: null }, okSpawnResult(VALID_REVIEW)]) };
  const result = await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(result.ok, false);
  assert.equal(result.retriedAfterTimeout, undefined);
});

// ---- reviewCard: the split recommendation fails open (action 5.1) ------------------------------
//
// A card judged too big must never come back as an error -- losing a real finding because it was
// big is strictly worse than filing it big. See prompts/review-card.md's § 4 addition.

test('reviewCard: a split recommendation parses as an ordinary FILE_AMENDED, verdict intact -- a recommended split must never become an error', async () => {
  const SPLIT_REVIEW = {
    verdict: 'FILE_AMENDED',
    corrections: ['split into two cards: (1) gateway reconnect banner, (2) client badge render'],
    first_comment_markdown:
      '### Card review\n\nThis reads as two independent changes; recommend splitting into two cards.',
  };
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply(SPLIT_REVIEW)),
      stderr: '',
      signal: null,
    })),
  };

  const result = await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(result.ok, true);
  assert.equal(result.review.verdict, 'FILE_AMENDED');
  assert.deepEqual(result.review.corrections, SPLIT_REVIEW.corrections);
});

test('reviewCard: a reply naming no split at all still parses cleanly, and REVIEW_REQUIRED never grew a split field', async () => {
  assert.deepEqual(intake.REVIEW_REQUIRED, ['verdict', 'corrections', 'first_comment_markdown']);

  const PLAIN_REVIEW = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply(PLAIN_REVIEW)),
      stderr: '',
      signal: null,
    })),
  };

  const result = await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(result.ok, true);
});

// ---- prompts/review-card.md § 4: the splitting addition, scoped to the new block --------------
//
// Mutation testing on the previous version of this test (a single whole-file regex) found it
// vacuous: § 0 (around line 70) already carries the pre-existing sentence "as `FILE_AMENDED`,
// **never** `DO_NOT_FILE` on desirability grounds", so a whole-file match on that vocabulary pair
// is satisfied by § 0 alone and proves nothing about the § 4 addition -- deleting or inverting
// the new sentence left the old test green. Slice the file down to the § 4 section itself before
// asserting anything, the same idiom test/prompt-contract-sweep.test.js uses to slice
// orchestrator/intake.js between named markers -- and, symmetrically, throw loudly if a marker
// is missing rather than silently widen the slice (that silent widening is exactly the defect
// being fixed here, just one level up: a slice with no boundary is a whole-file match by another
// name).
function sliceReviewCardSection(startMarker, endMarker) {
  const promptText = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'review-card.md'), 'utf8');
  const start = promptText.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`intake.test.js: marker not found in prompts/review-card.md: ${startMarker}`);
  }
  const end = promptText.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`intake.test.js: end marker not found in prompts/review-card.md: ${endMarker}`);
  }
  return promptText.slice(start, end);
}

function reviewCardSplitSection() {
  return sliceReviewCardSection(
    '### 4 · Is the weight right, and the ground named?',
    '## Your verdict — one of three'
  );
}

test('prompts/review-card.md § 4: the "is this N cards" question and its three tells are named', () => {
  const slice = reviewCardSplitSection();

  // The general "this is N cards" question, not just the pre-existing area-collision sentence.
  assert.match(slice, /N cards/);

  // The three tells, pinned on short stable tokens rather than whole sentences: deleting any one
  // of them must fail this test, but rewording around them (bold vs code-quoting, "and" vs
  // em-dash, clause reordering) must not.
  assert.match(slice, /subsystems/i); // tell 1: several subsystems, not one
  assert.match(slice, /X and Y/); // tell 2: "X and Y" -- a conjunction, not one change
  assert.match(slice, /independent acceptance criteria/i); // tell 3
});

test('prompts/review-card.md § 4: the fail-open direction is stated, and its inversion is absent', () => {
  const slice = reviewCardSplitSection();

  // Positive: the verdict vocabulary itself, scoped to § 4 so it cannot be satisfied by § 0's
  // own, unrelated instance of the same pair (see comment above). Killed by deleting the
  // sentence outright.
  assert.match(slice, /FILE_AMENDED[`*,\s]*never[`*\s]*DO_NOT_FILE/);
  // Killed by the inversion mutation ("`DO_NOT_FILE`, never `FILE_AMENDED`") -- the exact
  // opposite promise. Asserted separately from the line above so an inversion cannot pass by
  // having the positive phrase coincidentally still match some other, unrelated text in the
  // slice: this pins the ABSENCE of the reversed order, not just the presence of the forward one.
  assert.doesNotMatch(slice, /DO_NOT_FILE[`*,\s]*never[`*\s]*FILE_AMENDED/);

  // The "never" is bound to SIZE/SCOPE grounds only, and checks 1-2 keep their own DO_NOT_FILE.
  // Without that qualifier the instruction reads as "an oversized card is always FILE_AMENDED",
  // which would order the reviewer to file a card it has just found to be a duplicate, or whose
  // claim does not hold against the code -- § 0 qualifies its own "never" the same way, for the
  // same reason.
  //
  // The first cut of this pin was `/checks 1-2[\s\S]{0,160}DO_NOT_FILE/`, and it was the same
  // vacuity class as the bug this whole test was written to fix: it pinned TOKEN CO-OCCURRENCE
  // inside a window, not meaning. Two mutations that destroy the rule kept it green --
  // "checks 1-2 **no longer** keep their own DO_NOT_FILE" (the exact inversion), and gutting the
  // parenthetical entirely while leaving both tokens in place. Meanwhile it died on three
  // harmless rewordings. So pin the operative clause, the enumeration, and the absence of a
  // negation separately:

  // (a) WHICH ground the "never" is bound to. Deleting just this clause survived the old pin.
  assert.match(slice, /on size or scope grounds/i);

  // (b) checks 1-2 retain DO_NOT_FILE, with their cases named -- gutting the parenthetical drops
  //     the enumeration even if the bare tokens survive. Tolerates "1-2", "1 and 2", and either
  //     dash, and is case-insensitive; those variants are reformattings, not meaning changes.
  assert.match(slice, /checks\s+1\s*(?:[\u2013\u2014-]|and)\s*2/i);
  assert.match(slice, /duplicate/i);
  assert.match(slice, /already fixed/i);

  // (c) and that retention must not be negated. "checks 1-2 no longer keep their own
  //     DO_NOT_FILE" satisfies every co-occurrence assertion above while telling the reviewer
  //     the exact opposite. Nothing in § 4 legitimately says "no longer", or "never keep".
  assert.doesNotMatch(slice, /no longer/i);
  assert.doesNotMatch(slice, /never\s+(?:keep|keeps|yield|yields|retain|retains)/i);

  // (d) and the retention stated POSITIVELY as an ordered subject-verb-object pin, because (c)
  //     is a blocklist and a blocklist is whack-a-mole: "checks 1-2 DO NOT keep their own
  //     DO_NOT_FILE", "...LOSE their own...", "...ARE SUPERSEDED here..." all walk past (c)
  //     while inverting the rule. This one line closes that whole verb family at no cost to the
  //     capitalisation / "1 and 2" tolerance above.
  //
  //     KNOWN LIMIT, recorded rather than chased: these pins hold the retention clause's
  //     presence, subject and verb. They do NOT hold its predicate, and they cannot detect a
  //     nullifying condition appended after it -- flipping the enumeration ("...already fixed is
  //     NOT DO_NOT_FILE") or appending "...only while the card is not oversized" both leave the
  //     clause textually intact and subvert it downstream. Closing those needs a reader, not a
  //     regex.
  assert.match(slice, /checks\s+1\s*(?:[\u2013\u2014-]|and)\s*2\s+keep their own[\s\S]{0,20}DO_NOT_FILE/i);
});

test('prompts/review-card.md § 4: "when unsure, file it" cannot be satisfied by its own negation', () => {
  const slice = reviewCardSplitSection();

  // The naive regex /not sure[\s\S]{0,80}file it/ is insufficient: "not sure, hold the card
  // back: do not file it" -- the exact inversion -- also contains "not sure" followed within 80
  // characters by the substring "file it", so it passes that regex too. The actual instruction
  // text negates a DIFFERENT clause ("do not hold the card back", not "do not file it"), so
  // anchor there instead and separately forbid "do not" landing next to "file it".
  // Pinned as an ORDERED pair, not two independent tokens: keeping "do not hold the card back"
  // while swapping the imperative ("file it" -> "withhold it") inverts the instruction and left
  // an earlier, token-only version of this assertion green.
  assert.match(slice, /do not hold the card back[\s\S]{0,40}file it/i);
  assert.doesNotMatch(slice, /do not\s+file it/i);
});

// ---- fileCard: mechanical corrections + gh argv shapes -----------------------------------------

test('fileCard: FILE_AMENDED applies mechanical category/size/area corrections, leaves prose alone', () => {
  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push({ command, argv });
      if (argv[0] === 'issue' && argv[1] === 'create') {
        return {
          status: 0,
          stdout: 'https://github.com/Crazz-Org/SPO-WebClient/issues/321\n',
          stderr: '',
          signal: null,
        };
      }
      return { status: 0, stdout: '', stderr: '', signal: null };
    }),
  };

  const review = {
    verdict: 'FILE_AMENDED',
    corrections: ['category: latent-trap', 'size: L', 'area: rdo', 'add a file:line citation to the body'],
    first_comment_markdown: '### Card review\n\nFile amended.',
  };

  const result = intake.fileCard(VALID_DRAFT, review, deps);

  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 321);
  assert.equal(result.url, 'https://github.com/Crazz-Org/SPO-WebClient/issues/321');

  assert.equal(spawnCalls.length, 2);
  const [create, comment] = spawnCalls;

  assert.equal(create.command, 'gh');
  assert.deepEqual(create.argv, [
    'issue',
    'create',
    '--repo',
    'Crazz-Org/SPO-WebClient',
    '--title',
    VALID_DRAFT.title,
    '--body-file',
    create.argv[create.argv.indexOf('--body-file') + 1],
    '--label',
    'cat:latent-trap', // corrected -- was "feature"
    '--label',
    'size:L', // corrected -- was "S"
  ]);

  assert.equal(comment.command, 'gh');
  assert.deepEqual(comment.argv, [
    'issue',
    'comment',
    '321',
    '--repo',
    'Crazz-Org/SPO-WebClient',
    '--body-file',
    comment.argv[comment.argv.indexOf('--body-file') + 1],
  ]);

  // Body content and the prose (non-mechanical) correction are untouched -- title/body stay
  // the draft's own; only category/size/area moved.
  const bodyFile = create.argv[create.argv.indexOf('--body-file') + 1];
  assert.equal(fs.readFileSync(bodyFile, 'utf8'), VALID_DRAFT.body_markdown);
  const commentFile = comment.argv[comment.argv.indexOf('--body-file') + 1];
  assert.equal(fs.readFileSync(commentFile, 'utf8'), review.first_comment_markdown);

  // area was corrected mechanically, not left at the draft's own "client".
  assert.ok(!create.argv.includes('cat:feature'));
  assert.ok(!create.argv.includes('size:S'));
});

test('fileCard: a FILE_AMENDED verdict whose only correction is a split recommendation still files -- fileCard refuses a verdict, never a correction\'s content', () => {
  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push({ command, argv });
      if (argv[0] === 'issue' && argv[1] === 'create') {
        return {
          status: 0,
          stdout: 'https://github.com/Crazz-Org/SPO-WebClient/issues/900\n',
          stderr: '',
          signal: null,
        };
      }
      return { status: 0, stdout: '', stderr: '', signal: null };
    }),
  };

  const review = {
    verdict: 'FILE_AMENDED',
    // Deliberately adversarial: the split prose carries its own "size: S" / "size: M" tokens,
    // mid-sentence -- the exact shape a naive scan of `corrections` could mistake for a
    // mechanical field:value correction.
    corrections: ['split into two cards: (1) gateway reconnect banner — size: S, (2) client badge render — size: M'],
    first_comment_markdown: '### Card review\n\nRecommend splitting into two cards.',
  };

  const result = intake.fileCard(VALID_DRAFT, review, deps);

  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 900);
  assert.equal(spawnCalls.length, 2); // create + comment -- same as any other FILE_AMENDED

  // The split recommendation rides in `corrections` as prose, never as a label: this action's
  // central claim, and nothing above pinned it. MECHANICAL_CORRECTION_RE is anchored ^...$ over
  // the WHOLE correction string, so "size: S" embedded mid-sentence inside the split text never
  // qualifies -- applyMechanicalCorrections leaves VALID_DRAFT's own category/size untouched, and
  // those (not anything parsed out of the split prose) are what must reach `gh issue create`.
  const [create] = spawnCalls;
  assert.ok(create.argv.includes(`cat:${VALID_DRAFT.category}`));
  assert.ok(create.argv.includes(`size:${VALID_DRAFT.size}`));
  // The split's own "size: M" (card 2) must never surface as a label in its own right -- proof
  // the embedded field:value was left as prose, not silently picked up.
  assert.ok(!create.argv.includes('size:M'));
});

test('applyMechanicalCorrections: an unrecognized value under a known field is left as prose', () => {
  const { applied, unmechanical } = intake.applyMechanicalCorrections(VALID_DRAFT, ['category: not-a-real-category']);
  assert.equal(applied.category, VALID_DRAFT.category); // unchanged
  assert.deepEqual(unmechanical, ['category: not-a-real-category']);
});

test('fileCard: refuses to run for a DO_NOT_FILE verdict, never spawns', () => {
  let called = false;
  const deps = { spawnSync: fakeSpawnSync(() => { called = true; return { status: 0, stdout: '', stderr: '', signal: null }; }) };
  const review = { verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'nope' };

  const result = intake.fileCard(VALID_DRAFT, review, deps);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('fileCard: gh issue create failure -> clear error, never attempts the comment', () => {
  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push(argv);
      return { status: 1, stdout: '', stderr: 'gh: some failure', signal: null };
    }),
  };
  const review = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };

  const result = intake.fileCard(VALID_DRAFT, review, deps);
  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 1); // never reached the comment call
});

// ---- action 2.1b: intake.js's own gh/npm spawns are now bounded too --------------------------
//
// fetchIssue/postIssueComment/fileCard/amendCard/pullBoard/makeTask used to spawn `gh`/`npm` with
// no timeout at all -- the three LLM steps (draftCard/reviewCard/triageBugReport) already have
// their own deadline via invokeClaudeReal, but the plain gh/npm calls alongside them did not.
// These are the maintainer-facing `spo ask`/`spo pull` path and auto-triage.js's own driver, not
// a task step -- a timeout here is reported through the exact {ok: false, ...} shape each
// function already returns on a plain non-zero exit, tagged `timedOut: true`, never thrown.

test('fileCard: a timed-out gh issue create never throws -- reported as an error with timedOut: true, never attempts the comment', () => {
  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push(argv);
      return timeoutResult();
    }),
  };
  const review = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };

  const result = intake.fileCard(VALID_DRAFT, review, deps);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(spawnCalls.length, 1);
});

// ---- triageBugReport: outcome parsing, including the string-encoded-draft recovery -------------

test('triageBugReport: outcome "draft" with a literal nested object -- accepted as-is', async () => {
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply({ outcome: 'draft', draft: VALID_DRAFT })),
      stderr: '',
      signal: null,
    })),
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, VALID_DRAFT);
});

test('triageBugReport: outcome "draft" with `draft` double-encoded as a JSON string is recovered, not rejected', async () => {
  // Reproduced live 2026-08-30: fable occasionally replies {"outcome":"draft","draft":"{...}"}
  // -- the nested object escaped into a string -- instead of a literal nested object.
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply({ outcome: 'draft', draft: JSON.stringify(VALID_DRAFT) })),
      stderr: '',
      signal: null,
    })),
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, VALID_DRAFT);
});

test('triageBugReport: `draft` is a string but not valid JSON either -- clear error, never crashes', async () => {
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply({ outcome: 'draft', draft: 'not json at all' })),
      stderr: '',
      signal: null,
    })),
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON either/);
});

test('triageBugReport: outcome "not-reproduced" passes through untouched', async () => {
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(realShapedReply({ outcome: 'not-reproduced', reason: 'no matching log line' })),
      stderr: '',
      signal: null,
    })),
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'not-reproduced');
  assert.equal(result.reason, 'no matching log line');
});

// ---- triageBugReport: one retry on a deadline timeout, never on a malformed reply -------------
// Card #449, 2026-08-30: triageBugReport was the one intake LLM step with no retry at all, and
// its prompt runs a `curl` against a third-party server -- a plausible, plausibly transient hang.

function timeoutSpawnResult() {
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return { error: err, status: 143, stdout: '', stderr: '', signal: 'SIGTERM' };
}

function seqSpawnSync(responses) {
  let i = 0;
  return fakeSpawnSync(() => responses[Math.min(i++, responses.length - 1)]);
}

function okSpawnResult(resultObj) {
  return { status: 0, stdout: JSON.stringify(realShapedReply(resultObj)), stderr: '', signal: null };
}

test('triageBugReport: a deadline timeout is retried exactly once, and the retry\'s answer is the result', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: (command, args, opts) => {
      calls++;
      return calls === 1 ? timeoutSpawnResult() : okSpawnResult({ outcome: 'draft', draft: VALID_DRAFT });
    },
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'draft');
  assert.equal(result.retriedAfterTimeout.retryOk, true);
  assert.equal(result.retriedAfterTimeout.retryTimedOut, false);
});

test('triageBugReport: the retry uses the SAME account and the SAME deadline as the first attempt', async () => {
  const seenOpts = [];
  const deps = {
    accountsDir: poolDir(),
    deadlineMs: 12345,
    spawnSync: (command, args, opts) => {
      seenOpts.push(opts);
      return seenOpts.length === 1 ? timeoutSpawnResult() : okSpawnResult({ outcome: 'not-reproduced', reason: 'x' });
    },
  };
  await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(seenOpts.length, 2);
  assert.equal(seenOpts[0].timeout, 12345);
  assert.equal(seenOpts[1].timeout, 12345);
  assert.deepEqual(seenOpts[0].env.CLAUDE_CONFIG_DIR, seenOpts[1].env.CLAUDE_CONFIG_DIR);
});

test('triageBugReport: two consecutive timeouts -- one retry only, the failure says the call RAN past its deadline', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return timeoutSpawnResult();
    },
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(calls, 2); // no loop -- exactly one retry attempted, then give up
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeded the \d+ms deadline/);
  assert.equal(result.retriedAfterTimeout.retryTimedOut, true);
});

test('triageBugReport: a malformed reply is NOT retried', async () => {
  const deps = { accountsDir: poolDir(), spawnSync: seqSpawnSync([{ status: 0, stdout: 'not json at all', stderr: '', signal: null }, okSpawnResult({ outcome: 'draft', draft: VALID_DRAFT })]) };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(result.ok, false);
  assert.equal(result.retriedAfterTimeout, undefined);
});

// ---- the blast radius of steps/llm.js's timeout misclassification -----------------------------
// This is WHY the `|| (!!signal && deadlineArmed)` clause in steps/llm.js mattered enough to get
// its own pass rather than riding along with PR #127's command-timeout.js fix: `timedOut` is the
// one flag in this codebase that spends money. An externally-signalled `claude` -- a deploy
// restart, an operator's `kill`, an OOM kill -- used to arrive here as `timedOut: true` and buy a
// second full TRIAGE_BUG_REPORT call on a metered account, re-running a prompt that had just been
// deliberately stopped. Nothing about an external kill says "transient"; the retry rationale
// (a hung third-party `curl`) does not apply to it at all.

function externalKillSpawnResult(signal = 'SIGTERM') {
  // No `error` field: node fills one in only when ITS OWN deadline fired. Measured on node
  // v22.23.2 -- see test/llm-real.test.js's own block for the full table.
  return { status: null, stdout: '', stderr: '', signal };
}

test('triageBugReport: an EXTERNAL kill is NOT retried -- it is not a timeout, and the retry costs a real metered call', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return externalKillSpawnResult();
    },
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(calls, 1, 'exactly one call -- the second one was the bug');
  assert.equal(result.ok, false);
  assert.equal(result.retriedAfterTimeout, undefined);
  assert.match(result.error, /killed by signal SIGTERM/);
  assert.doesNotMatch(result.error, /exceeded the \d+ms deadline/);
});

test('triageBugReport: a genuine deadline kill is STILL retried -- the fix must not disarm the retry it was built for', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return calls === 1 ? timeoutSpawnResult() : okSpawnResult({ outcome: 'draft', draft: VALID_DRAFT });
    },
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.retriedAfterTimeout.retryOk, true);
});

test('triageBugReport: a genuine deadline kill in the shape the corpus records (signal null, exit 143) is retried too', async () => {
  // `claude` traps SIGTERM and exits 143 itself, so every one of the 9 recorded deadline kills in
  // ~/.spo-state/journal has `signal: null` -- the shape the deleted clause could never have
  // classified, and the one this retry has always actually run on.
  let calls = 0;
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return calls === 1
        ? { error: err, status: 143, stdout: '', stderr: '', signal: null }
        : okSpawnResult({ outcome: 'draft', draft: VALID_DRAFT });
    },
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(calls, 2);
  assert.equal(result.retriedAfterTimeout.retryOk, true);
});

test('triageBugReport: a retry followed by an unusable reply still carries retriedAfterTimeout', async () => {
  let calls = 0;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      calls++;
      return calls === 1 ? timeoutSpawnResult() : { status: 0, stdout: 'not json at all', stderr: '', signal: null };
    },
  };
  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
  assert.equal(result.retriedAfterTimeout.retryOk, false);
});

// ---- triageBugReport: account rotation on kind:'limit' (plan action 3.6) -----------------------
// The live incident this responds to, 2026-08-30/31: triageBugReport (then on fable) failed 53
// consecutive auto-triage cycles over 12.8 hours -- 128 attempts across issues 449/455/456,
// every one re-picking the same rate-limited account, because pickAccount() never rotated and
// never called markLimit. callIntakeStepWithRotation (orchestrator/intake.js) is the fix.

test('triageBugReport: a kind:\'limit\' failure on the first account rotates to a healthy second, whose result is returned', async () => {
  const accountsDir = twoAccountPoolDir();
  const seenOpts = [];
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) => {
      seenOpts.push(opts);
      if (opts.env.CLAUDE_CONFIG_DIR.endsWith('acct1')) return limitSpawnResult();
      return okSpawnResult({ outcome: 'not-reproduced', reason: 'no matching log line' });
    },
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'not-reproduced');
  assert.equal(seenOpts.length, 2);
  assert.notEqual(seenOpts[0].env.CLAUDE_CONFIG_DIR, seenOpts[1].env.CLAUDE_CONFIG_DIR, 'must call on two DIFFERENT accounts');
  assert.ok(seenOpts[0].env.CLAUDE_CONFIG_DIR.endsWith('acct1'));
  assert.ok(seenOpts[1].env.CLAUDE_CONFIG_DIR.endsWith('acct2'));
});

test('triageBugReport: the limited account is actually cooled down (markLimit written to state.json)', async () => {
  const accountsDir = twoAccountPoolDir();
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) =>
      opts.env.CLAUDE_CONFIG_DIR.endsWith('acct1')
        ? limitSpawnResult()
        : okSpawnResult({ outcome: 'not-reproduced', reason: 'x' }),
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, true);
  assert.equal(result.cooldowns.length, 1);
  assert.equal(result.cooldowns[0].account, 'acct1');
  // 429 -> limitKind 'usage' -> R1's 1h PROBE tier on a first-ever hit for this account
  // (fresh pool dir per test), not the escalated 5h tier.
  assert.equal(result.cooldowns[0].cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);

  const state = accounts.readState(accountsDir);
  assert.ok(state.acct1, 'acct1 should be cooling');
  assert.ok(state.acct1.cooldownUntil > Date.now());
  assert.ok(!state.acct2, 'acct2 should not be cooling');
});

test('triageBugReport: a 529 (overloaded) failure cools the account for the short 5-minute tier, not the 5-hour usage tier', async () => {
  const accountsDir = twoAccountPoolDir();
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) =>
      opts.env.CLAUDE_CONFIG_DIR.endsWith('acct1')
        ? overloadedSpawnResult()
        : okSpawnResult({ outcome: 'not-reproduced', reason: 'x' }),
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, true);
  assert.equal(result.cooldowns.length, 1);
  assert.equal(result.cooldowns[0].account, 'acct1');
  assert.equal(result.cooldowns[0].cooldownMs, accounts.OVERLOADED_COOLDOWN_MS);

  const state = accounts.readState(accountsDir);
  assert.ok(state.acct1.cooldownUntil <= Date.now() + accounts.OVERLOADED_COOLDOWN_MS + 5000);
});

test('triageBugReport: every account limited -> {ok:false, error} naming the exhaustion, never a throw', async () => {
  const accountsDir = twoAccountPoolDir();
  let calls = 0;
  const deps = {
    accountsDir,
    spawnSync: () => {
      calls++;
      return limitSpawnResult();
    },
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /triageBugReport/);
  assert.match(result.error, /cooling|exhaust/i);
  assert.equal(calls, 2, 'exactly one attempt per enabled account, never a third');
  assert.equal(result.cooldowns.length, 2);

  const state = accounts.readState(accountsDir);
  assert.ok(state.acct1);
  assert.ok(state.acct2);
});

test('triageBugReport: no accounts registered at all -> {ok:false, error}, never a throw, never spawns', async () => {
  let called = false;
  const deps = {
    accountsDir: mkTmp('spo-intake-empty-pool2-'), // empty pool -- zero registered accounts
    spawnSync: () => {
      called = true;
      return { status: 0, stdout: '{}', stderr: '', signal: null };
    },
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /no-accounts-registered/);
  assert.equal(called, false);
});

test('triageBugReport: a normal (non-limit, non-timeout) failure does not rotate at all', async () => {
  const accountsDir = twoAccountPoolDir();
  let calls = 0;
  const deps = {
    accountsDir,
    spawnSync: () => {
      calls++;
      return {
        status: 1,
        stdout: JSON.stringify(realShapedReply('bad schema', { is_error: true, api_error_status: 400 })),
        stderr: '',
        signal: null,
      };
    },
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(calls, 1, 'must not rotate on a non-limit failure');
  assert.equal(result.ok, false);
  assert.equal(result.cooldowns, undefined);

  const state = accounts.readState(accountsDir);
  assert.deepEqual(state, {}, 'no account should be cooled down for a non-limit failure');
});

// Regression guard: a deadline timeout must retry on the SAME account and must NEVER cool it,
// even when a second, healthy account is available and rotation would otherwise be possible.
// This is the deliberate design triageBugReport's own retry-policy comment explains: a deadline
// kill says nothing about account health (the account worked; the prompt hung).
test('triageBugReport: a timeout retries on the SAME account (never rotates) and does NOT cool it, even with a second account available', async () => {
  const accountsDir = twoAccountPoolDir();
  const seenOpts = [];
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) => {
      seenOpts.push(opts);
      return seenOpts.length === 1 ? timeoutSpawnResult() : okSpawnResult({ outcome: 'not-reproduced', reason: 'x' });
    },
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, true);
  assert.equal(seenOpts.length, 2);
  assert.equal(seenOpts[0].env.CLAUDE_CONFIG_DIR, seenOpts[1].env.CLAUDE_CONFIG_DIR, 'the retry must reuse the SAME account');
  assert.ok(seenOpts[0].env.CLAUDE_CONFIG_DIR.endsWith('acct1'), 'must never even try acct2 for a timeout');
  assert.equal(result.cooldowns, undefined, 'a timeout must never cool an account');

  const state = accounts.readState(accountsDir);
  assert.deepEqual(state, {}, 'no account should be cooled down for a timeout');
});

// The one shape where the timeout retry and the rotation DO chain: acct1 times out, its
// same-account retry comes back {kind: 'limit'}, so acct1 is cooled and acct2 answers. That is
// the most expensive single call the loop can make (two spawns on an account it then gives up
// on), so it must be the LEAST likely to lose its trace -- `retriedAfterTimeout` has to survive
// the rotation, or auto-triage.js never journals `report-triage-retry` for a duplicate call that
// really happened and really got billed.
test('triageBugReport: a timeout retry that then hits a limit still carries retriedAfterTimeout out through the rotation', async () => {
  const accountsDir = twoAccountPoolDir();
  const seenOpts = [];
  const deps = {
    accountsDir,
    spawnSync: (command, args, opts) => {
      seenOpts.push(opts);
      if (seenOpts.length === 1) return timeoutSpawnResult(); // acct1, first call
      if (seenOpts.length === 2) return limitSpawnResult(); // acct1, same-account retry -> limit
      return okSpawnResult({ outcome: 'not-reproduced', reason: 'x' }); // acct2
    },
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, true);
  assert.equal(seenOpts.length, 3, 'two calls on acct1 (call + retry), one on acct2');
  assert.ok(seenOpts[0].env.CLAUDE_CONFIG_DIR.endsWith('acct1'));
  assert.ok(seenOpts[1].env.CLAUDE_CONFIG_DIR.endsWith('acct1'), 'the timeout retry must stay on acct1');
  assert.ok(seenOpts[2].env.CLAUDE_CONFIG_DIR.endsWith('acct2'), 'the limit must then rotate to acct2');

  assert.ok(result.retriedAfterTimeout, 'the retry record must survive the rotation');
  assert.equal(result.retriedAfterTimeout.account, 'acct1', 'and must still name the account it happened on');
  assert.equal(result.cooldowns.length, 1);
  assert.equal(result.cooldowns[0].account, 'acct1');
});

test('triageBugReport: a timeout retry followed by pool exhaustion still carries retriedAfterTimeout', async () => {
  const accountsDir = twoAccountPoolDir();
  let calls = 0;
  const deps = {
    accountsDir,
    spawnSync: () => {
      calls++;
      return calls === 1 ? timeoutSpawnResult() : limitSpawnResult();
    },
  };

  const result = await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(result.ok, false);
  assert.equal(calls, 3, 'acct1: timeout + retry(limit); acct2: limit. Never more than accounts * 2');
  assert.match(result.error, /cooling|exhaust/i);
  assert.equal(result.cooldowns.length, 2);
  assert.ok(result.retriedAfterTimeout, 'the exhaustion shape must carry the retry record too');
  assert.equal(result.retriedAfterTimeout.account, 'acct1');
});

// ---- fetchIssue -----------------------------------------------------------------------------

test('fetchIssue: returns {title, body}, a clear error on a non-zero exit or bad JSON', () => {
  const okDeps = { spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: JSON.stringify({ title: 't', body: 'b' }), stderr: '', signal: null })) };
  const okResult = intake.fetchIssue(501, okDeps);
  assert.deepEqual(okResult, { ok: true, title: 't', body: 'b' });

  const failDeps = { spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: '', stderr: 'boom', signal: null })) };
  assert.equal(intake.fetchIssue(501, failDeps).ok, false);

  const badJsonDeps = { spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: 'not json', stderr: '', signal: null })) };
  assert.equal(intake.fetchIssue(501, badJsonDeps).ok, false);
});

test('fetchIssue: action 2.1b -- arms the gh class timeout; a timed-out spawn returns {ok: false, timedOut: true}, never throws', () => {
  let seenOpts = null;
  const armDeps = { spawnSync: fakeSpawnSync((c, a, opts) => { seenOpts = opts; return { status: 0, stdout: '{}', stderr: '', signal: null }; }) };
  intake.fetchIssue(501, armDeps);
  assert.equal(seenOpts.timeout, orchestratorConfig.commandTimeoutsMs.gh);

  const timeoutDeps = { spawnSync: fakeSpawnSync(() => timeoutResult()) };
  const result = intake.fetchIssue(501, timeoutDeps);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

// ---- postIssueComment ---------------------------------------------------------------------

test('postIssueComment: action 2.1b -- arms the gh class timeout; a timed-out spawn returns {ok: false, timedOut: true}, never throws', () => {
  let seenOpts = null;
  const armDeps = {
    spawnSync: fakeSpawnSync((c, a, opts) => {
      seenOpts = opts;
      return { status: 0, stdout: 'https://github.com/x/y/issues/1#issuecomment-1\n', stderr: '', signal: null };
    }),
  };
  intake.postIssueComment(1, 'hello', armDeps);
  assert.equal(seenOpts.timeout, orchestratorConfig.commandTimeoutsMs.gh);

  const timeoutDeps = { spawnSync: fakeSpawnSync(() => timeoutResult()) };
  const result = intake.postIssueComment(1, 'hello', timeoutDeps);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

// ---- amendCard: edits the raw-intake issue in place, never creates a second one ----------------

test('amendCard: edits the existing issue, preserves the original body in a <details> block, posts the review comment', () => {
  const spawnCalls = [];
  const deps = {
    ghRepo: 'x/y',
    reportIntakeLabel: 'report:raw',
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push(argv);
      if (argv[0] === 'api') return { status: 0, stdout: JSON.stringify({ body: 'RAW REPORT BODY HERE' }), stderr: '', signal: null };
      if (argv[0] === 'issue' && argv[1] === 'edit') return { status: 0, stdout: '', stderr: '', signal: null };
      if (argv[0] === 'issue' && argv[1] === 'comment') return { status: 0, stdout: 'https://x/y/issues/501#issuecomment-1\n', stderr: '', signal: null };
      return { status: 0, stdout: '', stderr: '', signal: null };
    }),
  };
  const review = { verdict: 'FILE', corrections: [], first_comment_markdown: 'review verdict text' };

  const result = intake.amendCard(501, VALID_DRAFT, review, deps);

  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 501);

  const editCall = spawnCalls.find((a) => a[0] === 'issue' && a[1] === 'edit');
  assert.ok(editCall, 'gh issue edit was called');
  assert.equal(editCall[2], '501');
  assert.ok(editCall.includes('--remove-label'));
  assert.ok(editCall.includes('report:raw'));

  const bodyFileArg = editCall[editCall.indexOf('--body-file') + 1];
  const writtenBody = fs.readFileSync(bodyFileArg, 'utf8');
  assert.ok(writtenBody.includes('RAW REPORT BODY HERE')); // original preserved
  assert.ok(writtenBody.includes('<details>'));

  assert.ok(spawnCalls.some((a) => a[0] === 'issue' && a[1] === 'comment' && a[2] === '501'));
});

test('amendCard: refuses to run for a DO_NOT_FILE verdict, never spawns', () => {
  let called = false;
  const deps = { spawnSync: fakeSpawnSync(() => { called = true; return { status: 0, stdout: '', stderr: '', signal: null }; }) };
  const review = { verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'nope' };

  const result = intake.amendCard(501, VALID_DRAFT, review, deps);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('amendCard: gh issue edit failure -> clear error, never attempts the comment', () => {
  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push(argv);
      if (argv[0] === 'api') return { status: 0, stdout: JSON.stringify({ body: 'x' }), stderr: '', signal: null };
      return { status: 1, stdout: '', stderr: 'gh: boom', signal: null };
    }),
  };
  const review = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };

  const result = intake.amendCard(501, VALID_DRAFT, review, deps);
  assert.equal(result.ok, false);
  assert.equal(spawnCalls.filter((a) => a[0] === 'issue' && a[1] === 'comment').length, 0);
});

test('amendCard: a timed-out gh issue edit never throws -- reported as an error with timedOut: true, never attempts the comment', () => {
  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push(argv);
      if (argv[0] === 'api') return { status: 0, stdout: JSON.stringify({ body: 'x' }), stderr: '', signal: null };
      return timeoutResult();
    }),
  };
  const review = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };

  const result = intake.amendCard(501, VALID_DRAFT, review, deps);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(spawnCalls.filter((a) => a[0] === 'issue' && a[1] === 'comment').length, 0);
});

// ---- pullBoard: board:claim output parsing -----------------------------------------------------

test('pullBoard: parses candidate lines in order, skips known header/tail noise, warns on garbage', () => {
  const stdout = [
    'rateLimit cost=2 remaining=4998 resetAt=2026-08-29T12:00:00Z',
    'items: 42/50',
    'busy areas: rdo, e2e',
    'candidates: 3',
    '  1 #501 area=client Header lacks a connection badge',
    '  2 #502 area= Something with no area at all',
    '  3 #503 area=rdo Add ObjectAt overload',
    '#504 blocked by #501',
    '!!! not a recognized line shape at all !!!',
  ].join('\n');

  const deps = { productRepo: '/tmp/does-not-matter', spawnSync: fakeSpawnSync(() => ({ status: 0, stdout, stderr: '', signal: null })) };

  const result = intake.pullBoard(deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [
    { rank: 1, issue: 501, area: 'client', title: 'Header lacks a connection badge' },
    { rank: 2, issue: 502, area: '', title: 'Something with no area at all' },
    { rank: 3, issue: 503, area: 'rdo', title: 'Add ObjectAt overload' },
  ]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /not a recognized line shape/);
});

test('pullBoard: a non-zero exit is reported, never crashes', () => {
  const deps = { spawnSync: fakeSpawnSync(() => ({ status: 3, stdout: '', stderr: 'boom', signal: null })) };
  const result = intake.pullBoard(deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /exited 3/);
});

test('pullBoard: action 2.1b -- arms the npm-run class timeout; a timed-out spawn returns {ok: false, timedOut: true}, never crashes', () => {
  let seenOpts = null;
  const armDeps = {
    productRepo: '/tmp/does-not-matter',
    spawnSync: fakeSpawnSync((c, a, opts) => { seenOpts = opts; return { status: 0, stdout: '', stderr: '', signal: null }; }),
  };
  intake.pullBoard(armDeps);
  assert.equal(seenOpts.timeout, orchestratorConfig.commandTimeoutsMs['npm-run']);

  const timeoutDeps = { spawnSync: fakeSpawnSync(() => timeoutResult()) };
  const result = intake.pullBoard(timeoutDeps);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

// ---- extractCriterion: <details> stripping (regression #452) ------------------------------

test('extractCriterion: strips amendCard\'s archived "Original report" <details> block', () => {
  const body = [
    'The header never shows connection state.',
    '',
    '<details><summary>Original report (raw intake, before reproduction/review)</summary>',
    '',
    'raw report text nobody should see in the criterion',
    '',
    '</details>',
  ].join('\n');
  const criterion = intake.extractCriterion(body);
  assert.ok(!criterion.includes('Original report'));
  assert.ok(!criterion.includes('raw report text'));
  assert.ok(criterion.includes('The header never shows connection state.'));
});

test('extractCriterion: nested <details> (the real #452 shape) leaves no stray tags or archived copies', () => {
  const body = [
    'Triaged summary of the bug.',
    '',
    '<details><summary>journal (3 entries captured)</summary>',
    'EVENT_TYCOON_UPDATE ...',
    '</details>',
    '',
    '<details><summary>Original report (raw intake, before reproduction/review)</summary>',
    '',
    'raw report body',
    '<details><summary>journal (3 entries captured)</summary>',
    'EVENT_TYCOON_UPDATE ...',
    '</details>',
    '',
    '</details>',
  ].join('\n');
  const criterion = intake.extractCriterion(body);
  assert.ok(!criterion.includes('<details'));
  assert.ok(!criterion.includes('</details'));
  assert.ok(!criterion.includes('raw report body'));
  assert.ok(criterion.includes('Triaged summary of the bug.'));
});

test('extractCriterion: an unclosed <details> is left intact, never truncated', () => {
  const body = 'useful text\n<details><summary>s</summary>\nrest of the body';
  const criterion = intake.extractCriterion(body);
  assert.equal(criterion, body.trim());
});

test('extractCriterion: an orphaned </details> is dropped, surrounding text kept', () => {
  const body = 'a\n</details>\nb';
  const criterion = intake.extractCriterion(body);
  assert.ok(!criterion.includes('</details'));
  assert.ok(criterion.includes('a'));
  assert.ok(criterion.includes('b'));
});

test('extractCriterion: a "Done means" heading survives the strip untouched', () => {
  const body = ['## Done means', 'X.', '', '<details><summary>s</summary>archived</details>'].join('\n');
  assert.equal(intake.extractCriterion(body), 'X.');
});

test('extractCriterion: a body that is ENTIRELY one <details> block falls back to the raw body, never empty', () => {
  const body = '<details><summary>s</summary>everything is in here</details>';
  const criterion = intake.extractCriterion(body);
  assert.ok(criterion.length > 0);
  assert.ok(criterion.includes('everything is in here'));
});

test('extractCriterion: a body with no <details> at all is unaffected (non-regression)', () => {
  const body = 'The header never shows connection state.\n\nMore context here.';
  assert.equal(intake.extractCriterion(body), body.trim());
});

test('makeTask: a card body shaped like #452 (archived original report, nested journal) yields a short criterion', () => {
  const queueDir = mkTmp('spo-intake-queue-');
  const journalRoot = mkTmp('spo-intake-journal-');
  const journalBlock = '<details><summary>journal (3 entries captured)</summary>\n' + 'x'.repeat(50000) + '\n</details>';
  const issueBody = [
    'Building Inspector shows the wrong tenant count.',
    '',
    journalBlock,
    '',
    '<details><summary>Original report (raw intake, before reproduction/review)</summary>',
    '',
    'the raw report, itself containing another copy:',
    journalBlock,
    '',
    '</details>',
  ].join('\n');

  const deps = {
    queueDir,
    journalRoot,
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify({
        title: 'desktop . Building Inspector',
        body: issueBody,
        labels: [{ name: 'size:S' }],
      }),
      stderr: '',
      signal: null,
    })),
  };

  const candidate = { rank: 1, issue: 452, area: '', title: 'desktop . Building Inspector' };
  const result = intake.makeTask(candidate, deps);

  assert.equal(result.ok, true);
  assert.ok(result.task.criterion.length < 2000, `criterion too long: ${result.task.criterion.length} bytes`);
  assert.ok(result.task.criterion.includes('Building Inspector shows the wrong tenant count.'));
});

// ---- makeTask -------------------------------------------------------------------------------

test('makeTask: writes the expected queue/<seq>-issue-<n>.json shape', () => {
  const queueDir = mkTmp('spo-intake-queue-');
  const journalRoot = mkTmp('spo-intake-journal-');
  const issueBody = [
    'The header never shows connection state.',
    '',
    '## Done means',
    'The header renders a badge reflecting connection state.',
    '',
    'Source: maintainer request, 2026-08-29',
  ].join('\n');

  const deps = {
    queueDir,
    journalRoot,
    spawnSync: fakeSpawnSync((command, argv) => {
      assert.equal(command, 'gh');
      assert.deepEqual(argv, ['api', 'repos/Crazz-Org/SPO-WebClient/issues/501']);
      return {
        status: 0,
        stdout: JSON.stringify({
          title: 'Header lacks a connection badge',
          body: issueBody,
          labels: [{ name: 'size:L' }, { name: 'cat:feature' }],
        }),
        stderr: '',
        signal: null,
      };
    }),
  };

  const candidate = { rank: 1, issue: 501, area: 'client', title: 'Header lacks a connection badge' };
  const result = intake.makeTask(candidate, deps);

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.file, '0001-issue-501.json');

  const written = JSON.parse(fs.readFileSync(path.join(queueDir, result.file), 'utf8'));
  assert.deepEqual(written, {
    id: 'issue-501',
    kind: 'card',
    issue: 501,
    title: 'Header lacks a connection badge',
    criterion: 'The header renders a badge reflecting connection state.',
    size: 'L',
    area: 'client',
    touchesRdoMembers: false,
  });
});

test('makeTask: a timed-out gh api issues/<n> never throws -- reported as an error with timedOut: true', () => {
  const queueDir = mkTmp('spo-intake-queue-timeout-');
  const journalRoot = mkTmp('spo-intake-journal-timeout-');
  const deps = { queueDir, journalRoot, spawnSync: fakeSpawnSync(() => timeoutResult()) };

  const result = intake.makeTask({ rank: 1, issue: 504, area: 'client', title: 'x' }, deps);

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('makeTask: area "rdo" sets touchesRdoMembers true even with no explicit mention in the body', () => {
  const queueDir = mkTmp('spo-intake-queue-rdo-');
  const journalRoot = mkTmp('spo-intake-journal-rdo-');
  const deps = {
    queueDir,
    journalRoot,
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify({ title: 'Add ObjectAt overload', body: 'no special markers here', labels: [] }),
      stderr: '',
      signal: null,
    })),
  };

  const result = intake.makeTask({ rank: 1, issue: 503, area: 'rdo', title: 'Add ObjectAt overload' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.task.touchesRdoMembers, true);
  assert.equal(result.task.size, 'M'); // no size: label -> default M
});

test('makeTask: skips an issue already present in queue/, never spawns', () => {
  const queueDir = mkTmp('spo-intake-queue-dedup-');
  const journalRoot = mkTmp('spo-intake-journal-dedup-');
  fs.writeFileSync(
    path.join(queueDir, '0001-issue-501.json'),
    JSON.stringify({ id: 'issue-501', kind: 'card', issue: 501 })
  );

  let called = false;
  const deps = {
    queueDir,
    journalRoot,
    spawnSync: fakeSpawnSync(() => {
      called = true;
      return { status: 0, stdout: '{}', stderr: '', signal: null };
    }),
  };

  const result = intake.makeTask({ rank: 1, issue: 501, area: 'client', title: 'x' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('makeTask: skips an issue already present in journal/, never spawns', () => {
  const queueDir = mkTmp('spo-intake-queue-dedup2-');
  const journalRoot = mkTmp('spo-intake-journal-dedup2-');
  fs.mkdirSync(path.join(journalRoot, 'issue-501'), { recursive: true });

  let called = false;
  const deps = {
    queueDir,
    journalRoot,
    spawnSync: fakeSpawnSync(() => {
      called = true;
      return { status: 0, stdout: '{}', stderr: '', signal: null };
    }),
  };

  const result = intake.makeTask({ rank: 1, issue: 501, area: 'client', title: 'x' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('makeTask: skips an issue still carrying reportIntakeLabel -- not yet confirmed/triaged by the human-first pipeline', () => {
  const queueDir = mkTmp('spo-intake-queue-rawskip-');
  const journalRoot = mkTmp('spo-intake-journal-rawskip-');

  const deps = {
    queueDir,
    journalRoot,
    reportIntakeLabel: 'report:raw',
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify({ title: 'raw card', body: 'raw body', labels: [{ name: 'report:raw' }] }),
      stderr: '',
      signal: null,
    })),
  };

  const result = intake.makeTask({ rank: 1, issue: 502, area: 'client', title: 'x' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /report:raw/);
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0);
});

// ---- bin/spo: cmdAsk / cmdPull wiring, via deps.intake --------------------------------------
//
// Drives the REAL bin/spo cmdAsk/cmdPull (parseArgs included) against a fake intake module --
// never the real orchestrator/intake.js, so no account pool / spawnSync fixture is needed here.
// console.log/console.error are captured, and process.exitCode is reset around every test since
// it is process-global state these commands write to.

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function withExitCodeReset(fn) {
  return async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await fn();
    } finally {
      process.exitCode = before;
    }
  };
}

// noNetworkProjectBoard() -- a `deps.projectBoard` fake with no `gh` reachability at all: this
// repo's own rule (CLAUDE.md / the driver brief) is "inject the deps", not "rely on
// test/no-real-spawn.js's killswitch as a backstop". Every cmdAsk test below that does NOT pass
// its own `deps.projectBoard` override falls through to the REAL `orchestrator/project-board.js`
// (bin/spo's own `deps.projectBoard || require(...)`) -- harmless today only because
// PROJECT_NUMBER_BY_REPO has no entry for the default repo (Crazz-Org/SPO-WebClient), so
// `projectNumberForRepo` returns null and `placeOnBoard` (the only function in that module that
// actually spawns `gh`) is never reached. That is an accident of the CURRENT mapping table, not a
// guarantee this test file enforces -- a future entry added for SPO-WebClient (or a bug in
// `projectNumberForRepo` itself) would silently arm a real `gh api graphql` spawn from these
// tests, caught only by the killswitch, if at all. Passing this fake removes that dependency
// entirely: `projectNumberForRepo` always answers null (so `wouldPlaceOnBoard` is always false)
// and `placeOnBoard` throws immediately if anything ever reaches it.
function noNetworkProjectBoard() {
  return {
    projectNumberForRepo: () => null,
    placeOnBoard: () => {
      throw new Error('noNetworkProjectBoard: placeOnBoard must not be called by this test');
    },
  };
}

// Card #100 post-verification fix (F1): `refuseIfDaemonLockHeld` (bin/spo) ALWAYS checks the REAL
// default journal root -- `stateJournalRoot(resolveStateRoot())` -- in addition to whatever
// `--journal` a command's own opts resolve to (its own ANTI-EVASION note explains why: nothing on
// THIS process's argv can move where a live daemon's lock actually is). That means isolating a
// cmdPull/cmdIntake test via `--journal` ALONE no longer isolates it -- the guard still probes
// this machine's true `~/.spo-state/journal`, which measurably DOES hold a live daemon lock on
// this box (verification's own F1 probe proved it, and it is why the pre-#100 versions of the two
// tests below started flaky-refusing the moment the guard first landed). `SPO_STATE_DIR` is the
// only thing that actually redirects `resolveStateRoot()` (orchestrator/state-root.js) -- so it is
// what isolates the REAL default, not a flag or a `deps` override. Testing through the real
// resolution rather than injecting the path is also the card #133 lesson this fix exists to
// respect: an injected path can never prove the resolution itself is safe.
function withIsolatedStateDir(fn) {
  return async () => {
    const stateDir = mkTmp('spo-cmd-state-');
    const saved = process.env.SPO_STATE_DIR;
    process.env.SPO_STATE_DIR = stateDir;
    try {
      await fn(stateDir);
    } finally {
      if (saved === undefined) delete process.env.SPO_STATE_DIR;
      else process.env.SPO_STATE_DIR = saved;
    }
  };
}

test(
  'spo ask --dry: prints draft + review, files nothing, exit 0',
  withExitCodeReset(async () => {
    let fileCardCalled = false;
    const fakeIntake = {
      draftCard: async (text) => {
        assert.equal(text, 'add a status badge');
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({
        ok: true,
        review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'looks good' },
      }),
      fileCard: () => {
        fileCardCalled = true;
        return { ok: true, issueNumber: 1, url: 'x' };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['add', 'a', 'status', 'badge', '--dry']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: noNetworkProjectBoard() });
    } finally {
      console_.restore();
    }

    assert.equal(fileCardCalled, false);
    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes('--- draft ---')));
    assert.ok(console_.logs.some((l) => l.includes('--- review ---')));
  })
);

test(
  'spo ask: DO_NOT_FILE prints the reason and files nothing, exit 0',
  withExitCodeReset(async () => {
    let fileCardCalled = false;
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({
        ok: true,
        review: { verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'not a defect, see #12' },
      }),
      fileCard: () => {
        fileCardCalled = true;
        return { ok: true, issueNumber: 1, url: 'x' };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['some', 'request', 'text']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: noNetworkProjectBoard() });
    } finally {
      console_.restore();
    }

    assert.equal(fileCardCalled, false);
    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes('DO_NOT_FILE')));
    assert.ok(console_.logs.some((l) => l.includes('not a defect, see #12')));
  })
);

test(
  'spo ask: FILE_AMENDED files and prints the issue number + url',
  withExitCodeReset(async () => {
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({
        ok: true,
        review: { verdict: 'FILE_AMENDED', corrections: ['size: M'], first_comment_markdown: 'amended' },
      }),
      fileCard: (draft, review) => {
        assert.equal(review.verdict, 'FILE_AMENDED');
        return { ok: true, issueNumber: 77, url: 'https://github.com/Crazz-Org/SPO-WebClient/issues/77' };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['some', 'request']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: noNetworkProjectBoard() });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes('filed #77')));
    assert.ok(console_.logs.some((l) => l.includes('https://github.com/Crazz-Org/SPO-WebClient/issues/77')));
  })
);

test(
  'spo ask --draft-file: skips draftCard entirely, uses loadDraftFile',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    let loadDraftFileArg = null;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      loadDraftFile: (filePath) => {
        loadDraftFileArg = filePath;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({
        ok: true,
        review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' },
      }),
      fileCard: () => ({ ok: true, issueNumber: 9, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--draft-file', '/tmp/some-draft.json']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: noNetworkProjectBoard() });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(loadDraftFileArg, '/tmp/some-draft.json');
    assert.equal(process.exitCode, undefined);
  })
);

test(
  'spo ask --draft-file: a loadDraftFile error (e.g. missing key) is a mechanical failure -- exit non-zero, review never called',
  withExitCodeReset(async () => {
    let reviewCardCalled = false;
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      loadDraftFile: () => ({ ok: false, error: 'loadDraftFile: /tmp/x.json missing required key(s): area' }),
      reviewCard: async () => {
        reviewCardCalled = true;
        return { ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } };
      },
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--draft-file', '/tmp/x.json']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: noNetworkProjectBoard() });
    } finally {
      console_.restore();
    }

    assert.equal(reviewCardCalled, false);
    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('missing required key(s): area')));
  })
);

test(
  'spo pull --limit 2: makeTask is called for only the top 2 of 3 candidates, in order',
  withExitCodeReset(
    withIsolatedStateDir(async () => {
      const madeFor = [];
      const fakeIntake = {
        pullBoard: () => ({
          ok: true,
          warnings: [],
          candidates: [
            { rank: 1, issue: 501, area: 'client', title: 'a' },
            { rank: 2, issue: 502, area: 'client', title: 'b' },
            { rank: 3, issue: 503, area: 'client', title: 'c' },
          ],
        }),
        makeTask: (candidate) => {
          madeFor.push(candidate.issue);
          return { ok: true, skipped: false, file: `000${madeFor.length}-issue-${candidate.issue}.json` };
        },
      };

      // Card #100: no --journal here on purpose -- resolveDirs(opts) falls back to
      // stateJournalRoot(resolveStateRoot()), and SPO_STATE_DIR (withIsolatedStateDir) is what
      // keeps THAT real default pointed at a throwaway dir instead of this machine's own
      // ~/.spo-state/journal, where a live daemon can genuinely hold the lock (see the note on
      // withIsolatedStateDir's own definition for why --journal alone stopped being enough).
      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--limit', '2']);
        await spo.cmdPull(opts, { intake: fakeIntake });
      } finally {
        console_.restore();
      }

      assert.deepEqual(madeFor, [501, 502]);
      assert.equal(process.exitCode, undefined);
      assert.ok(console_.logs.some((l) => l.includes('#501')));
      assert.ok(console_.logs.some((l) => l.includes('#502')));
      assert.ok(!console_.logs.some((l) => l.includes('#503')));
    })
  )
);

test(
  'spo pull: default limit is 5, and a skipped candidate is reported as skipped not written',
  withExitCodeReset(
    withIsolatedStateDir(async () => {
      const fakeIntake = {
        pullBoard: () => ({
          ok: true,
          warnings: ['pullBoard: skipped unrecognized line: ???'],
          candidates: [{ rank: 1, issue: 501, area: 'client', title: 'a' }],
        }),
        makeTask: () => ({ ok: true, skipped: true, id: 'issue-501', reason: 'issue-501 already present in queue/ or journal/' }),
      };

      // Card #100: see the note on the --limit-2 test above.
      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdPull(opts, { intake: fakeIntake });
      } finally {
        console_.restore();
      }

      assert.equal(process.exitCode, undefined);
      assert.ok(console_.errors.some((l) => l.includes('skipped unrecognized line')));
      assert.ok(console_.logs.some((l) => l.includes('#501: skipped')));
    })
  )
);

// ---- cmdPull: daemon-lock guard (card #100, consolidates 79.2) -----------------------------
//
// `cmdPull` used to resolve nothing and call straight into `pullBoard`/`makeTask` -- no lock
// read, no refusal, no `--force`. Now it reads orchestrator/lock.js's daemon.lock at
// resolveDirs(opts).journalRoot (the SAME path daemon.js locks) *and* -- unconditionally -- at
// the real default `stateJournalRoot(resolveStateRoot())` before doing anything else. Modeled on
// test/recette.test.js:328 (refusal), :346 (--force overrides), :361 (dead pid is not a refusal)
// -- `deps.isAlive` is the identical injection point liveDaemonHolder uses.
//
// Every test below isolates the REAL default via SPO_STATE_DIR (withIsolatedStateDir), not
// --journal -- see that helper's own header for why --journal alone can no longer isolate a test
// from this machine's real daemon lock (that is the whole point of the anti-evasion fix these
// tests exist to lock in).

test(
  'spo pull: a live daemon lock refuses -- makeTask is never called, exit 1',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() })
      );
      let makeTaskCalled = false;
      const fakeIntake = {
        pullBoard: () => ({ ok: true, warnings: [], candidates: [{ rank: 1, issue: 501, area: 'client', title: 'a' }] }),
        makeTask: () => {
          makeTaskCalled = true;
          return { ok: true, skipped: false, file: '0001-issue-501.json' };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdPull(opts, { intake: fakeIntake, isAlive: (pid) => pid === 999999 });
      } finally {
        console_.restore();
      }

      assert.equal(makeTaskCalled, false, 'refusal must happen before any downstream call');
      assert.equal(process.exitCode, 1);
      assert.ok(console_.errors.some((l) => l.includes('999999') && l.includes('daemon.lock')));
    })
  )
);

test(
  'spo pull --force: overrides the daemon-lock refusal -- makeTask IS called despite a live lock',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() })
      );
      let makeTaskCalled = false;
      const fakeIntake = {
        pullBoard: () => ({ ok: true, warnings: [], candidates: [{ rank: 1, issue: 501, area: 'client', title: 'a' }] }),
        makeTask: () => {
          makeTaskCalled = true;
          return { ok: true, skipped: false, file: '0001-issue-501.json' };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--force']);
        await spo.cmdPull(opts, { intake: fakeIntake, isAlive: () => true });
      } finally {
        console_.restore();
      }

      assert.equal(makeTaskCalled, true, '--force must let the pull actually run');
    })
  )
);

test(
  'spo pull: a lock file whose pid is dead is not a refusal -- makeTask IS called',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 123456, mode: 'real', startedAt: new Date().toISOString() })
      );
      let makeTaskCalled = false;
      const fakeIntake = {
        pullBoard: () => ({ ok: true, warnings: [], candidates: [{ rank: 1, issue: 501, area: 'client', title: 'a' }] }),
        makeTask: () => {
          makeTaskCalled = true;
          return { ok: true, skipped: false, file: '0001-issue-501.json' };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdPull(opts, { intake: fakeIntake, isAlive: () => false });
      } finally {
        console_.restore();
      }

      assert.equal(makeTaskCalled, true);
      assert.equal(process.exitCode, undefined);
    })
  )
);

test(
  'spo pull: no lock file at all is not a refusal -- makeTask IS called, with the resolved journalRoot/queueDir forwarded',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      let capturedDeps = null;
      const fakeIntake = {
        pullBoard: () => ({ ok: true, warnings: [], candidates: [{ rank: 1, issue: 501, area: 'client', title: 'a' }] }),
        makeTask: (candidate, deps) => {
          capturedDeps = deps;
          return { ok: true, skipped: false, file: '0001-issue-501.json' };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs([]);
        await spo.cmdPull(opts, { intake: fakeIntake });
      } finally {
        console_.restore();
      }

      assert.ok(capturedDeps, 'makeTask must have been called');
      assert.equal(process.exitCode, undefined);
      // Post-verification fix (F1): makeTask must receive the SAME journalRoot/queueDir the guard
      // itself resolved and checked -- {} (the pre-fix shape) let makeTask silently fall back to
      // its own default resolution, independent of this command's own --journal/--queue flags.
      assert.equal(capturedDeps.journalRoot, stateJournalRoot(stateDir));
      assert.equal(capturedDeps.queueDir, stateQueueDir(stateDir));
    })
  )
);

// ---- cmdPull: anti-evasion regressions (post-verification fix, F1) --------------------------
//
// F1 (verification, 2026-09-06): `spo pull --journal <empty-tmp>` walked straight past a REAL
// live daemon lock because the guard checked only the resolved --journal path, while `makeTask`
// (via {} deps) wrote into the real default queue/ regardless -- the guard's checked path and the
// actual write path had already diverged. Reproduced with a real `acquireLock` + a real decoy
// `--journal` before the fix; both are reproduced here as a permanent regression.

test(
  'spo pull: a --journal decoy cannot evade a live lock at the REAL default journal root',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      const realJournalRoot = stateJournalRoot(stateDir);
      fs.mkdirSync(realJournalRoot, { recursive: true });
      fs.writeFileSync(
        lockPath(realJournalRoot),
        JSON.stringify({ host: os.hostname(), pid: 999999, mode: 'real', startedAt: new Date().toISOString() })
      );
      const decoyJournal = mkTmp('spo-pull-decoy-journal-'); // no lock here at all
      const decoyQueue = mkTmp('spo-pull-decoy-queue-');
      let makeTaskCalled = false;
      const fakeIntake = {
        pullBoard: () => ({ ok: true, warnings: [], candidates: [{ rank: 1, issue: 99001, area: 'client', title: 'x' }] }),
        makeTask: () => {
          makeTaskCalled = true;
          return { ok: true, skipped: false, file: '0001-issue-99001.json' };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--journal', decoyJournal, '--queue', decoyQueue]);
        await spo.cmdPull(opts, { intake: fakeIntake, isAlive: (pid) => pid === 999999 });
      } finally {
        console_.restore();
      }

      assert.equal(makeTaskCalled, false, 'a --journal/--queue decoy must not evade the real default lock check');
      assert.equal(process.exitCode, 1);
    })
  )
);

test(
  'spo pull: an explicit --journal pointed at a SECOND live daemon is also refused (belt-and-braces)',
  withExitCodeReset(
    withIsolatedStateDir(async (stateDir) => {
      // The real default (stateJournalRoot(stateDir)) has NO lock here -- only the explicit
      // --journal target does, simulating a maintainer who really did start a second daemon
      // with --journal <secondDaemonJournal>.
      const secondDaemonJournal = mkTmp('spo-pull-second-daemon-journal-');
      fs.writeFileSync(
        lockPath(secondDaemonJournal),
        JSON.stringify({ host: os.hostname(), pid: 888888, mode: 'real', startedAt: new Date().toISOString() })
      );
      let makeTaskCalled = false;
      const fakeIntake = {
        pullBoard: () => ({ ok: true, warnings: [], candidates: [{ rank: 1, issue: 501, area: 'client', title: 'a' }] }),
        makeTask: () => {
          makeTaskCalled = true;
          return { ok: true, skipped: false, file: '0001-issue-501.json' };
        },
      };

      const console_ = captureConsole();
      try {
        const opts = spo.parseArgs(['--journal', secondDaemonJournal]);
        await spo.cmdPull(opts, { intake: fakeIntake, isAlive: (pid) => pid === 888888 });
      } finally {
        console_.restore();
      }

      assert.equal(makeTaskCalled, false, 'an explicit --journal naming a live second daemon must still refuse');
      assert.equal(process.exitCode, 1);
      assert.ok(console_.errors.some((l) => l.includes('888888')));
    })
  )
);

// The triage model is a maintainer decision (2026-08-31: fable/high -> opus/medium) with no
// other pin anywhere -- no doc names it, no other test asserts it -- so a silent revert would be
// invisible until the report pipeline wedged again. It moved for availability as much as for
// quality: fable/high stalled every confirmed report for 12.8 hours on a Fable-specific 429,
// because the account picker neither rotated nor cooled at the time (fixed by plan action 3.6,
// see callIntakeStepWithRotation's own tests above; plan action 3.3, capping the classifier's
// false-positive rate, is still open).
test('triageBugReport: runs on opus at medium effort -- the argv the CLI actually receives', async () => {
  const seenArgs = [];
  const deps = {
    accountsDir: poolDir(),
    spawnSync: (command, args) => {
      seenArgs.push(args);
      return okSpawnResult({ outcome: 'draft', draft: VALID_DRAFT });
    },
  };

  await intake.triageBugReport('/tmp/report.json', 501, deps);

  assert.equal(seenArgs.length, 1);
  const args = seenArgs[0];
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
});

// ---- VERIFIER (action 6.2): intake's lease must be HELD ACROSS the `claude` spawn ------------
//
// intake.js got the same per-step lease wiring as state-machine.js's callLlmStep in action 6.2,
// and shipped with no test of its own for it: deleting its `finally` release, or moving the
// release to before the call, both passed the whole suite. Under C6 this file's callers run
// DISPATCHER-side while workers are mid-step on the same two-account pool, so "the lease covers
// the call" is exactly as load-bearing here as it is in the worker. Assert it from inside the
// spawn, the only place that can tell "held across the call" from "acquired and dropped".
test('draftCard: the account lease is HELD for the whole spawn, and released afterwards', async () => {
  const dir = writePoolDir(mkTmp('spo-intake-lease-held-'), [{ name: 'acct1' }]);
  const leaseFile = path.join(dir, '.lease-acct1.json');

  let leaseHeldDuringSpawn = null;
  let holderDuringSpawn = null;
  const deps = {
    accountsDir: dir,
    spawnSync: fakeSpawnSync((command, args, opts) => {
      assert.ok(opts.env.CLAUDE_CONFIG_DIR.endsWith('acct1'));
      leaseHeldDuringSpawn = fs.existsSync(leaseFile);
      holderDuringSpawn = leaseHeldDuringSpawn ? JSON.parse(fs.readFileSync(leaseFile, 'utf8')) : null;
      return { status: 0, stdout: JSON.stringify(realShapedReply(VALID_DRAFT)), stderr: '', signal: null };
    }),
  };

  const result = await intake.draftCard('the header has no connection badge', deps);

  assert.equal(result.ok, true);
  assert.equal(
    leaseHeldDuringSpawn,
    true,
    "intake's lease must still be on disk while `claude` is running on that account -- a lease released before the spawn protects nothing"
  );
  assert.equal(holderDuringSpawn.pid, process.pid);
  assert.equal(fs.existsSync(leaseFile), false, 'and released the instant the call is done -- per-step, not per-task');
});

test('draftCard: an account leased by another LIVE process is skipped -- the other healthy account is used instead', async () => {
  const dir = twoAccountPoolDir();
  // A sibling (this test process's own, genuinely live pid) mid-step on acct1.
  fs.writeFileSync(path.join(dir, '.lease-acct1.json'), JSON.stringify({ pid: process.pid, startedAt: 'sibling-mid-step' }));

  const seen = [];
  const deps = {
    accountsDir: dir,
    spawnSync: fakeSpawnSync((command, args, opts) => {
      seen.push(path.basename(opts.env.CLAUDE_CONFIG_DIR));
      return { status: 0, stdout: JSON.stringify(realShapedReply(VALID_DRAFT)), stderr: '', signal: null };
    }),
  };

  const result = await intake.draftCard('anything', deps);

  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['acct2'], 'acct1 is leased by a live sibling -- intake must route around it, never call it');
  assert.ok(fs.existsSync(path.join(dir, '.lease-acct1.json')), "the sibling's lease is not ours to release");
  assert.equal(fs.existsSync(path.join(dir, '.lease-acct2.json')), false, 'our own lease is released');
  assert.deepEqual(accounts.readState(dir), {}, 'a leased account is never cooled down -- nothing here was a limit');
});

// ---- SPO-Pipeline#117: intake spend leaves a token record ------------------------------------
//
// Before this, draftCard/reviewCard/triageBugReport computed the token block, returned it, and
// every caller dropped it: journal/daemon.jsonl held ZERO `llm-call` events against 58
// auto-triage cycles, and `spo status` shipped a caveat saying its own number was short by an
// unknown amount. These tests pin the write side; test/tokens.test.js pins the read side.

// modelUsage carrying real counts -- realShapedReply's default only has costUSD, which
// extractTokens reads as `tokensSource: null` (not reported), the one shape that must never be
// mistaken for a genuine zero.
function replyWithTokens(resultObj, usage) {
  return realShapedReply(resultObj, {
    modelUsage: {
      'claude-x': {
        input_tokens: usage.fi,
        cache_creation_input_tokens: usage.cc,
        cache_read_input_tokens: usage.cr,
        output_tokens: usage.out,
      },
    },
  });
}

function readDaemonLlmCalls(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'llm-call');
}

test('draftCard: journals an `llm-call` into daemon.jsonl with the same fields a pipeline step writes', async () => {
  const journalRoot = mkTmp('spo-intake-journal-');
  const deps = {
    accountsDir: poolDir(),
    journalRoot,
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(replyWithTokens(VALID_DRAFT, { fi: 900, cc: 8000, cr: 21000, out: 50 })),
      stderr: '',
      signal: null,
    })),
  };

  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, true);

  const calls = readDaemonLlmCalls(journalRoot);
  assert.equal(calls.length, 1);
  const ev = calls[0];
  // The step name is intake's own, never a pipeline step's -- so one reader summing both
  // journals can still tell where the spend went.
  assert.equal(ev.step, 'DRAFT_CARD');
  assert.equal(ev.model, 'sonnet');
  assert.equal(ev.effort, 'medium');
  assert.equal(ev.account, 'acct1');
  assert.equal(ev.ok, true);
  // `tokensSource` is the marker that distinguishes "reported zero" from "not reported" --
  // without it every reader here has to guess, which is the whole erratum this closes.
  assert.equal(ev.tokensSource, 'modelUsage');
  assert.equal(ev.freshInputTokens, 900);
  assert.equal(ev.cacheCreationTokens, 8000);
  assert.equal(ev.cacheReadTokens, 21000);
  assert.equal(ev.outputTokens, 50);
  assert.equal(ev.billableTokens, 8950); // cache-READ excluded, same rule as tokens.js
  assert.equal(typeof ev.ts, 'string');
});

test('reviewCard and triageBugReport journal their own step names and models, never draftCard\'s', async () => {
  const journalRoot = mkTmp('spo-intake-journal-review-');
  const deps = {
    accountsDir: poolDir(),
    journalRoot,
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(
        replyWithTokens(
          { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' },
          { fi: 10, cc: 20, cr: 30, out: 40 }
        )
      ),
      stderr: '',
      signal: null,
    })),
  };
  const reviewed = await intake.reviewCard(VALID_DRAFT, deps);
  assert.equal(reviewed.ok, true);

  const triageJournalRoot = mkTmp('spo-intake-journal-triage-');
  const triaged = await intake.triageBugReport('/tmp/report.json', 501, {
    accountsDir: poolDir(),
    journalRoot: triageJournalRoot,
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(
        replyWithTokens({ outcome: 'draft', draft: VALID_DRAFT }, { fi: 3, cc: 4, cr: 5, out: 6 })
      ),
      stderr: '',
      signal: null,
    })),
  });
  assert.equal(triaged.ok, true);

  assert.deepEqual(
    readDaemonLlmCalls(journalRoot).map((e) => [e.step, e.model]),
    [['REVIEW_CARD', 'fable']]
  );
  assert.deepEqual(
    readDaemonLlmCalls(triageJournalRoot).map((e) => [e.step, e.model, e.billableTokens]),
    [['TRIAGE_BUG_REPORT', 'opus', 13]]
  );
});

test('a deadline-timeout retry journals TWO llm-call events -- one per call, because each spent its own tokens', async () => {
  // The single most expensive intake shape (a doubled call) must not be the one shape that
  // reports half its cost. auto-triage.js's `report-triage-retry` makes the retry VISIBLE; this
  // makes it COUNTED.
  const journalRoot = mkTmp('spo-intake-journal-retry-');
  let n = 0;
  const deps = {
    accountsDir: poolDir(),
    journalRoot,
    spawnSync: fakeSpawnSync(() => {
      n += 1;
      if (n === 1) return timeoutResult();
      return {
        status: 0,
        stdout: JSON.stringify(replyWithTokens(VALID_DRAFT, { fi: 5, cc: 0, cr: 0, out: 1 })),
        stderr: '',
        signal: null,
      };
    }),
  };

  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, true);
  assert.ok(result.retriedAfterTimeout, 'the retry record is still returned');

  const calls = readDaemonLlmCalls(journalRoot);
  assert.equal(calls.length, 2, 'the timed-out call is journalled too, not only the one that worked');
  // A deadline-killed call never gets a token block: it must read as "not reported" (null), never
  // as a genuine zero -- tokens.js counts it under llmCallsWithoutTokens on exactly that field.
  assert.equal(calls[0].ok, false);
  assert.equal(calls[0].tokensSource, null);
  assert.equal(calls[1].ok, true);
  assert.equal(calls[1].tokensSource, 'modelUsage');
});

test('an account rotation journals one llm-call per account tried -- the cooled account\'s call is not free', async () => {
  const journalRoot = mkTmp('spo-intake-journal-rotate-');
  let n = 0;
  const deps = {
    accountsDir: twoAccountPoolDir(),
    journalRoot,
    spawnSync: fakeSpawnSync(() => {
      n += 1;
      if (n === 1) return limitSpawnResult();
      return {
        status: 0,
        stdout: JSON.stringify(replyWithTokens(VALID_DRAFT, { fi: 7, cc: 0, cr: 0, out: 2 })),
        stderr: '',
        signal: null,
      };
    }),
  };

  const result = await intake.draftCard('anything', deps);
  assert.equal(result.ok, true);
  assert.deepEqual(
    readDaemonLlmCalls(journalRoot).map((e) => [e.account, e.ok]),
    [['acct1', false], ['acct2', true]]
  );
});

test('no journalRoot in deps -> no journal write, and the call still returns normally', () => {
  // Every unit test above this block calls draftCard with no journalRoot at all. A hard
  // requirement would have turned each of them into an ENOENT rather than a test failure with a
  // readable cause -- and `spo pull` and any future caller with no journal must stay callable.
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync(() => ({
      status: 0,
      stdout: JSON.stringify(replyWithTokens(VALID_DRAFT, { fi: 1, cc: 1, cr: 1, out: 1 })),
      stderr: '',
      signal: null,
    })),
  };
  return intake.draftCard('anything', deps).then((result) => {
    assert.equal(result.ok, true);
  });
});

test(
  'spo ask: passes the resolved journalRoot to draftCard AND reviewCard, so an interactive filing lands in the token ledger too',
  withExitCodeReset(async () => {
    // `spo ask` spends two real LLM calls and left no record of them anywhere (SPO-Pipeline#117).
    // The fix is one argument at each call site, and an argument is exactly the kind of thing a
    // refactor drops silently: nothing else in cmdAsk's behaviour changes when it goes missing.
    const journalDir = mkTmp('spo-ask-journal-');
    const seen = [];
    const fakeIntake = {
      draftCard: async (_text, deps) => {
        seen.push(['draftCard', deps && deps.journalRoot]);
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async (_draft, deps) => {
        seen.push(['reviewCard', deps && deps.journalRoot]);
        return { ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } };
      },
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['add', 'a', 'badge', '--dry', '--journal', journalDir]);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: noNetworkProjectBoard() });
    } finally {
      console_.restore();
    }

    assert.deepEqual(seen, [
      ['draftCard', journalDir],
      ['reviewCard', journalDir],
    ]);
  })
);

// ---- spo ask --repo <owner/name> + board placement (action 184/185) --------------------------
//
// `--repo` is NOT a parseArgs flag (bin/spo:227-289 is above test/doc-constant-sweep.test.js's
// line-pinned `bin/spo:1159`/`:1200` citations, and that test forbids inserting or deleting a
// line there) -- cmdAsk pulls it back out of opts._ itself (bin/spo's own extractRepoFlag, right
// above cmdAsk). These tests drive that through parseArgs + cmdAsk exactly like every other
// cmdAsk test in this file, never reimplementing the extraction here.
//
// Board placement goes through `deps.projectBoard` -- the same injection convention as
// `deps.intake` -- so these tests never spawn a real `gh` process; orchestrator/project-board.js
// has its own full gh-argv-level coverage in test/project-board.test.js.

test(
  'spo ask: no --repo resolves the default (Crazz-Org/SPO-WebClient) and makes NO board call',
  withExitCodeReset(async () => {
    let fileCardDeps = null;
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({
        ok: true,
        review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' },
      }),
      fileCard: (draft, review, deps) => {
        fileCardDeps = deps;
        return { ok: true, issueNumber: 42, url: 'https://github.com/Crazz-Org/SPO-WebClient/issues/42' };
      },
    };
    // cmdAsk always CONSULTS the mapping table (so an explicit `--repo config.ghRepo` is also a
    // no-op rather than a special case) -- what must never happen for the default path is an
    // actual board MUTATION, so only placeOnBoard throws here.
    const fakeProjectBoard = {
      projectNumberForRepo: (ghRepo) => {
        assert.equal(ghRepo, 'Crazz-Org/SPO-WebClient');
        return null;
      },
      placeOnBoard: () => {
        throw new Error('placeOnBoard must not be called for the byte-identical default path');
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['some', 'request', 'text']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, undefined);
    assert.deepEqual(fileCardDeps, {});
    assert.ok(console_.logs.some((l) => l.includes('filed #42')));
  })
);

test(
  'spo ask --repo Crazz-Org/SPO-Pipeline: files into SPO-Pipeline and places the card on its board',
  withExitCodeReset(async () => {
    let fileCardDeps = null;
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({
        ok: true,
        review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' },
      }),
      fileCard: (draft, review, deps) => {
        fileCardDeps = deps;
        return { ok: true, issueNumber: 77, url: 'https://github.com/Crazz-Org/SPO-Pipeline/issues/77' };
      },
    };
    let placeOnBoardArgs = null;
    const fakeProjectBoard = {
      projectNumberForRepo: (ghRepo) => (ghRepo === 'Crazz-Org/SPO-Pipeline' ? 2 : null),
      placeOnBoard: (issueNumber, ghRepo, deps) => {
        placeOnBoardArgs = { issueNumber, ghRepo, deps };
        return { ok: true, itemId: 'PVTI_x', statusName: 'Todo' };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo', 'Crazz-Org/SPO-Pipeline', 'some', 'request', 'text']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, undefined);
    // fileCard's own `gh issue create --repo <repo>` argv is intake.js's concern (already
    // covered by "fileCard: FILE_AMENDED applies..." above); this asserts cmdAsk threads the
    // flag's value through to fileCard's deps at all.
    assert.deepEqual(fileCardDeps, { ghRepo: 'Crazz-Org/SPO-Pipeline' });
    assert.ok(placeOnBoardArgs);
    assert.equal(placeOnBoardArgs.issueNumber, 77);
    assert.equal(placeOnBoardArgs.ghRepo, 'Crazz-Org/SPO-Pipeline');
    assert.ok(console_.logs.some((l) => l.includes('filed #77')));
  })
);

test(
  'spo ask --repo <malformed>: refused before any LLM call, non-zero exit',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo', 'not-a-repo-shape', 'some', 'text']);
      await spo.cmdAsk(opts, { intake: fakeIntake });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('--repo requires an "owner/name" value')));
  })
);

test(
  // Renamed from a pre-F3/F4 version of this test that drove `['some', 'text', '--repo']` --
  // under the OLD (splice-anywhere) extractRepoFlag that was "the no-value case, wherever --repo
  // sits"; under the new leading-only design that exact argv is actually the F4 trailing-flag
  // case (covered separately below), not a "no value" case at all -- a genuinely leading `--repo`
  // with nothing after it (argv running out entirely) is the only way to hit "no value" now.
  'spo ask --repo (no value, leading, argv runs out): refused as malformed, not silently treated as "no flag"',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo']);
      await spo.cmdAsk(opts, { intake: fakeIntake });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('--repo requires an "owner/name" value (got null)')));
  })
);

// ---- F1: --repo=VALUE (equals form) -----------------------------------------------------------

test('extractRepoFlag: --repo=VALUE (equals form) is recognized leading, with identical rest/raw shape to the space-separated form', () => {
  const equalsForm = spo.extractRepoFlag(['--repo=Crazz-Org/SPO-Pipeline', 'fix', 'it']);
  assert.deepEqual(equalsForm, { rest: ['fix', 'it'], raw: 'Crazz-Org/SPO-Pipeline', stray: null });

  const spaceForm = spo.extractRepoFlag(['--repo', 'Crazz-Org/SPO-Pipeline', 'fix', 'it']);
  assert.deepEqual(spaceForm, { rest: ['fix', 'it'], raw: 'Crazz-Org/SPO-Pipeline', stray: null });
});

test(
  'spo ask --repo=Crazz-Org/SPO-Pipeline: files into SPO-Pipeline, places on the board, and the flag token never leaks into the drafted request text',
  withExitCodeReset(async () => {
    let draftCardText = null;
    let fileCardDeps = null;
    const fakeIntake = {
      draftCard: async (text) => {
        draftCardText = text;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: (draft, review, deps) => {
        fileCardDeps = deps;
        return { ok: true, issueNumber: 201, url: 'https://github.com/Crazz-Org/SPO-Pipeline/issues/201' };
      },
    };
    let placeOnBoardArgs = null;
    const fakeProjectBoard = {
      projectNumberForRepo: (ghRepo) => (ghRepo === 'Crazz-Org/SPO-Pipeline' ? 2 : null),
      placeOnBoard: (issueNumber, ghRepo, deps) => {
        placeOnBoardArgs = { issueNumber, ghRepo };
        return { ok: true, itemId: 'PVTI_eq', statusName: 'Todo' };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo=Crazz-Org/SPO-Pipeline', 'fix', 'it']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, undefined);
    // The token spent on the LLM draft call must be the request text alone -- not the flag that
    // targeted the filing, which used to leak straight into it and get billed to the drafter.
    assert.equal(draftCardText, 'fix it');
    assert.ok(!draftCardText.includes('--repo'));
    assert.deepEqual(fileCardDeps, { ghRepo: 'Crazz-Org/SPO-Pipeline' });
    assert.ok(placeOnBoardArgs);
    assert.equal(placeOnBoardArgs.issueNumber, 201);
    assert.equal(placeOnBoardArgs.ghRepo, 'Crazz-Org/SPO-Pipeline');
    assert.ok(console_.logs.some((l) => l.includes('filed #201')));
  })
);

// Same value, driven all the way through the real intake.fileCard -- the literal `gh issue
// create` argv the spec asks for, not just the deps object cmdAsk hands to a fake fileCard above.
test('extractRepoFlag + the real intake.fileCard: a --repo=VALUE-extracted raw value becomes the literal `gh issue create --repo <value>` argv', () => {
  const { raw, rest, stray } = spo.extractRepoFlag(['--repo=Crazz-Org/SPO-Pipeline', 'fix', 'it']);
  assert.equal(stray, null);
  assert.equal(raw, 'Crazz-Org/SPO-Pipeline');
  assert.equal(rest.join(' '), 'fix it');

  const spawnCalls = [];
  const deps = {
    ghRepo: raw,
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push(argv);
      if (argv[0] === 'issue' && argv[1] === 'create') {
        return { status: 0, stdout: 'https://github.com/Crazz-Org/SPO-Pipeline/issues/301\n', stderr: '', signal: null };
      }
      return { status: 0, stdout: '', stderr: '', signal: null };
    }),
  };
  const review = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };

  const result = intake.fileCard(VALID_DRAFT, review, deps);
  assert.equal(result.ok, true);

  const create = spawnCalls.find((argv) => argv[0] === 'issue' && argv[1] === 'create');
  assert.ok(create);
  assert.equal(create[create.indexOf('--repo') + 1], 'Crazz-Org/SPO-Pipeline');
  // The literal flag token never appears anywhere in the argv -- only its already-extracted value.
  assert.ok(!create.some((a) => typeof a === 'string' && a.startsWith('--repo=')));
});

// ---- F2: duplicate --repo ----------------------------------------------------------------------

test(
  'spo ask --repo A --repo B: a duplicate --repo is a hard usage error -- exit non-zero, loud, no LLM/draft call',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    let placeOnBoardCalled = false;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };
    const fakeProjectBoard = {
      projectNumberForRepo: () => 2,
      placeOnBoard: () => {
        placeOnBoardCalled = true;
        return { ok: true, itemId: 'x', statusName: 'Todo' };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo', 'Crazz-Org/SPO-Pipeline', '--repo', 'Crazz-Org/SPO-Deploy', 'fix', 'it']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(placeOnBoardCalled, false);
    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('--repo must come first')));
    assert.ok(console_.errors.some((l) => l.includes('--repo')));
  })
);

// ---- F3: --repo embedded in prose (not leading) ------------------------------------------------

test(
  'spo ask document --repo a/b please: a --repo that is not leading is a hard usage error -- no retarget, no mangled request text, no filing, no board call, drafter never invoked',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    let fileCardCalled = false;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => {
        fileCardCalled = true;
        return { ok: true, issueNumber: 1, url: 'x' };
      },
    };
    const fakeProjectBoard = {
      projectNumberForRepo: () => {
        throw new Error('the mapping table must not even be consulted -- cmdAsk must refuse before reaching it');
      },
      placeOnBoard: () => {
        throw new Error('placeOnBoard must not be called');
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['document', '--repo', 'a/b', 'please']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(fileCardCalled, false);
    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('--repo must come first')));
  })
);

// ---- F4: trailing --repo after request text -----------------------------------------------------

test(
  'spo ask fix it --repo Crazz-Org/SPO-Pipeline: the old trailing form is now a hard usage error with "must come first" guidance',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['fix', 'it', '--repo', 'Crazz-Org/SPO-Pipeline']);
      await spo.cmdAsk(opts, { intake: fakeIntake });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(process.exitCode, 1);
    const msg = console_.errors.find((l) => l.includes('--repo must come first'));
    assert.ok(msg, 'expected a "--repo must come first" guidance message');
    // Tells the user exactly what to type instead.
    assert.ok(msg.includes('spo ask --repo <owner/name>') || msg.includes('spo ask --repo=<owner/name>'));
  })
);

test(
  'spo ask fix it --repo=Crazz-Org/SPO-Pipeline: the equals form is refused the same way when trailing',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['fix', 'it', '--repo=Crazz-Org/SPO-Pipeline']);
      await spo.cmdAsk(opts, { intake: fakeIntake });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(process.exitCode, 1);
    assert.ok(console_.errors.some((l) => l.includes('--repo must come first')));
  })
);

// ---- F5: case-insensitive board mapping (the invisible-card defect this card exists to kill) ---

test(
  'spo ask --repo crazz-org/spo-pipeline (lowercase): board placement IS attempted, against project 2, with Status read back -- no invisible card',
  withExitCodeReset(async () => {
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 555, url: 'https://github.com/Crazz-Org/SPO-Pipeline/issues/555' }),
    };

    // Deliberately does NOT override deps.projectBoard -- this drives cmdAsk against the REAL
    // orchestrator/project-board.js, so a case-insensitivity regression in that module's own
    // mapping lookup (not just in a test fixture standing in for it) would be caught here. Every
    // `gh` call placeOnBoard makes is faked via deps.spawnSync instead (the module's own
    // injection convention, armTimeout's `deps.spawnSync`).
    const ghCalls = [];
    const FAKE_PROJECT_ID = 'PVT_lower_9f2c';
    const FAKE_STATUS_FIELD_ID = 'PVTSSF_lower_7a01';
    const FAKE_TODO_OPTION_ID = 'opt_lower_todo_3e91';
    const FAKE_ISSUE_NODE_ID = 'I_lower_c001';
    const FAKE_ITEM_ID = 'PVTI_lower_dead22';
    function graphqlVar(args, name) {
      const prefix = `${name}=`;
      const hit = args.find((a) => typeof a === 'string' && a.startsWith(prefix));
      return hit ? hit.slice(prefix.length) : undefined;
    }
    const spawnSync = fakeSpawnSync((command, args) => {
      ghCalls.push(args);
      if (command !== 'gh') return { status: 1, stdout: '', stderr: 'unexpected command', signal: null };
      if (args[0] === 'project' && args[1] === 'view') {
        assert.equal(args[2], '2', 'the project number resolved for the lowercase repo must be 2, same as the canonical casing');
        return { status: 0, stdout: JSON.stringify({ id: FAKE_PROJECT_ID }), stderr: '', signal: null };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          status: 0,
          stdout: JSON.stringify({
            fields: [
              {
                id: FAKE_STATUS_FIELD_ID,
                name: 'Status',
                options: [{ id: FAKE_TODO_OPTION_ID, name: 'Todo' }],
              },
            ],
          }),
          stderr: '',
          signal: null,
        };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        // The issue is looked up on the repo AS THE USER TYPED IT (lowercase) -- this module
        // resolves the PROJECT case-insensitively, it does not rewrite what goes to `gh`.
        assert.equal(args[args.indexOf('--repo') + 1], 'crazz-org/spo-pipeline');
        return { status: 0, stdout: JSON.stringify({ id: FAKE_ISSUE_NODE_ID }), stderr: '', signal: null };
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = graphqlVar(args, 'query');
        if (query.includes('addProjectV2ItemById')) {
          return { status: 0, stdout: JSON.stringify({ data: { addProjectV2ItemById: { item: { id: FAKE_ITEM_ID } } } }), stderr: '', signal: null };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return { status: 0, stdout: JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: FAKE_ITEM_ID } } } }), stderr: '', signal: null };
        }
        if (query.includes('fieldValueByName')) {
          return { status: 0, stdout: JSON.stringify({ data: { node: { fieldValueByName: { name: 'Todo' } } } }), stderr: '', signal: null };
        }
      }
      return { status: 1, stdout: '', stderr: `unexpected gh args: ${args.join(' ')}`, signal: null };
    });

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo', 'crazz-org/spo-pipeline', 'fix', 'it']);
      await spo.cmdAsk(opts, { intake: fakeIntake, spawnSync });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, undefined, 'a lowercase --repo that DOES map must not be reported as a failure');
    assert.ok(console_.logs.some((l) => l.includes('filed #555')));
    assert.ok(!console_.errors.some((l) => l.includes('board placement failed')));
    // The read-back query actually ran -- board placement was really attempted, not skipped.
    const readBackCalls = ghCalls.filter(
      (a) => a[0] === 'api' && a.some((tok) => typeof tok === 'string' && tok.includes('fieldValueByName'))
    );
    assert.equal(readBackCalls.length, 1);
  })
);

// ---- SHOULD-FIX: an unmapped-but-valid --repo target is filed but explicitly reported as NOT placed ----

test(
  'spo ask --repo Crazz-Org/Unmapped: files, makes no board call, and prints an explicit stderr note (exit stays 0)',
  withExitCodeReset(async () => {
    let placeOnBoardCalled = false;
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 909, url: 'https://github.com/Crazz-Org/Unmapped/issues/909' }),
    };
    const fakeProjectBoard = {
      projectNumberForRepo: (ghRepo) => (ghRepo === 'Crazz-Org/Unmapped' ? null : 2),
      placeOnBoard: () => {
        placeOnBoardCalled = true;
        return { ok: true, itemId: 'x', statusName: 'Todo' };
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo', 'Crazz-Org/Unmapped', 'fix', 'it']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    assert.equal(placeOnBoardCalled, false);
    assert.equal(process.exitCode, undefined, 'filing succeeded -- exit stays 0 even though no board placement was attempted');
    assert.ok(console_.logs.some((l) => l.includes('filed #909')));
    assert.ok(console_.errors.some((l) => l.includes('no board placement') && l.includes('909')));
  })
);

// ---- SHOULD-FIX: --dry says which repo and whether a board placement would be attempted --------

test(
  'spo ask --dry --repo Crazz-Org/SPO-Pipeline: dry output names the target repo and says a board placement would be attempted',
  withExitCodeReset(async () => {
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => {
        throw new Error('--dry must never file');
      },
    };
    const fakeProjectBoard = {
      projectNumberForRepo: (ghRepo) => (ghRepo === 'Crazz-Org/SPO-Pipeline' ? 2 : null),
      placeOnBoard: () => {
        throw new Error('--dry must never place on the board');
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo', 'Crazz-Org/SPO-Pipeline', 'fix', 'it', '--dry']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes('Crazz-Org/SPO-Pipeline') && l.includes('board placement would be attempted')));
  })
);

test(
  'spo ask --dry (no --repo): dry output names the default repo and says no board placement would be attempted',
  withExitCodeReset(async () => {
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => {
        throw new Error('--dry must never file');
      },
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['fix', 'it', '--dry']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: noNetworkProjectBoard() });
    } finally {
      console_.restore();
    }

    assert.equal(process.exitCode, undefined);
    assert.ok(console_.logs.some((l) => l.includes(orchestratorConfig.ghRepo) && l.includes('no board placement would be attempted')));
  })
);

// ---- SHOULD-FIX: `--repo --dry x` message reflects what actually happened -----------------------

test(
  'spo ask --repo --dry x: the malformed-value message notes that --dry was parsed out separately, not left as an unexplained "got x"',
  withExitCodeReset(async () => {
    let draftCardCalled = false;
    const fakeIntake = {
      draftCard: async () => {
        draftCardCalled = true;
        return { ok: true, draft: VALID_DRAFT };
      },
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 1, url: 'x' }),
    };

    const console_ = captureConsole();
    try {
      // parseArgs consumes --dry as its own flag BEFORE extractRepoFlag ever sees opts._, so
      // opts._ is ['--repo', 'x'] here -- 'x' is what extractRepoFlag reads as --repo's value.
      const opts = spo.parseArgs(['--repo', '--dry', 'x']);
      assert.deepEqual(opts._, ['--repo', 'x']);
      assert.equal(opts.dry, true);
      await spo.cmdAsk(opts, { intake: fakeIntake });
    } finally {
      console_.restore();
    }

    assert.equal(draftCardCalled, false);
    assert.equal(process.exitCode, 1);
    const msg = console_.errors.find((l) => l.includes('--repo requires an "owner/name" value'));
    assert.ok(msg, 'expected the malformed-value message');
    assert.ok(msg.includes('got "x"'));
    assert.ok(msg.includes('--dry'), 'the message should explain that --dry was parsed out separately, not silently folded into the value');
  })
);

test(
  'spo ask --repo Crazz-Org/SPO-Pipeline: a failed board placement is filed but reported loudly and non-zero',
  withExitCodeReset(async () => {
    const fakeIntake = {
      draftCard: async () => ({ ok: true, draft: VALID_DRAFT }),
      reviewCard: async () => ({ ok: true, review: { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' } }),
      fileCard: () => ({ ok: true, issueNumber: 88, url: 'https://github.com/Crazz-Org/SPO-Pipeline/issues/88' }),
    };
    const fakeProjectBoard = {
      projectNumberForRepo: () => 2,
      placeOnBoard: () => ({ ok: false, error: 'placeOnBoard: read back Status="(empty)" for item PVTI_x' }),
    };

    const console_ = captureConsole();
    try {
      const opts = spo.parseArgs(['--repo', 'Crazz-Org/SPO-Pipeline', 'some', 'text']);
      await spo.cmdAsk(opts, { intake: fakeIntake, projectBoard: fakeProjectBoard });
    } finally {
      console_.restore();
    }

    // The card exists -- still reported -- but the run is a failure: an invisible card must
    // never look like a silent success.
    assert.equal(process.exitCode, 1);
    assert.ok(console_.logs.some((l) => l.includes('filed #88')));
    assert.ok(console_.errors.some((l) => l.includes('board placement failed')));
    assert.ok(console_.errors.some((l) => l.includes('#88')));
  })
);

// ---- the daemon-untouched pin ------------------------------------------------------------------
//
// Explicitly demanded by action 184/185: this card is NOT "unhardcode ghRepo", and nothing about
// `spo ask --repo` may change what the DAEMON resolves. Recon found no existing test pinning the
// shipped `orchestrator/config.js`'s `ghRepo` value directly -- every daemon fixture hardcodes its
// OWN copy of the string, so a change to config.js's real value could pass the whole suite
// silently. This pins the real, shipped config object, then proves TWO things separately:
//
//   1. (below) intake.fileCard, given deps carrying no ghRepo, still resolves against the real
//      shipped config -- this is the byte-identical INTERACTIVE default path (`spo ask` with no
//      `--repo`, bin/spo's cmdAsk), not a daemon call site: `grep -rn 'fileCard(' orchestrator/
//      bin/` returns exactly one call site, cmdAsk itself. An earlier version of this comment
//      claimed fileCard was called "exactly how state-machine.js/auto-triage.js call it" -- that
//      was false (neither module calls fileCard at all; verified by the same grep) and has been
//      corrected here rather than left standing.
//   2. (further below) a genuine daemon-side call site -- park-loop.js's postParkComment, reached
//      from state-machine.js's finalizePark on every real park, with NO --repo/ghRepo override in
//      sight anywhere on that path -- resolving the SAME shipped config object into its own `gh`
//      argv. This is the actual daemon-resolution guarantee the card asked for.
//
// Neither test relies on "reverting the bin/spo change makes this pass": neither imports bin/spo,
// cmdAsk, or --repo at all.
test('the interactive default path: config.ghRepo is still Crazz-Org/SPO-WebClient, and intake.fileCard (deps carrying no ghRepo -- the byte-identical `spo ask` default path\'s own shape) still resolves it', () => {
  assert.equal(orchestratorConfig.ghRepo, 'Crazz-Org/SPO-WebClient');

  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push(argv);
      if (argv[0] === 'issue' && argv[1] === 'create') {
        return { status: 0, stdout: 'https://github.com/Crazz-Org/SPO-WebClient/issues/999\n', stderr: '', signal: null };
      }
      return { status: 0, stdout: '', stderr: '', signal: null };
    }),
  };
  const review = { verdict: 'FILE', corrections: [], first_comment_markdown: 'ok' };

  const result = intake.fileCard(VALID_DRAFT, review, deps); // deps carries NO ghRepo -- cmdAsk's own no-`--repo` shape
  assert.equal(result.ok, true);

  const create = spawnCalls.find((argv) => argv[0] === 'issue' && argv[1] === 'create');
  assert.ok(create, 'gh issue create was never called');
  assert.equal(create[create.indexOf('--repo') + 1], 'Crazz-Org/SPO-WebClient');
  assert.equal(create[create.indexOf('--repo') + 1], orchestratorConfig.ghRepo);
});

// The genuine daemon-side pin: postParkComment (orchestrator/park-loop.js) is reached from
// state-machine.js's finalizePark on every real park -- no worktree, no `--repo`, no bin/spo
// anywhere on that path -- and it builds its own `gh issue comment --repo <ghRepo> ...` argv off
// `ctx.config.ghRepo`. Passing the REAL, shipped `orchestratorConfig` object as `ctx.config` (not
// a test's own copy of the string) proves the daemon's actual config resolution, not a fixture's
// imitation of it. `ctx.task.worktreePath`/`ctx.config.productRepo` are both left unset on
// purpose: board.js's moveCard (postParkComment's first step) then has no cwd to move from and
// journals a `board-move-skipped` no-op instead of spawning `npm` -- keeping this fixture to
// exactly the one `gh` call under test, same minimal ctx shape as park-loop.test.js's own
// action-2.1b timeout tests (`{ task: { issue }, taskDir, config }`, no worktreePath).
test('the daemon: a real daemon-side call site (park-loop.js\'s postParkComment) resolves the REAL shipped config.ghRepo into its own gh argv', () => {
  assert.equal(orchestratorConfig.ghRepo, 'Crazz-Org/SPO-WebClient');

  const taskDir = mkTmp('spo-daemon-ghrepo-pin-taskdir-');
  const ctx = { task: { issue: 12345 }, taskDir, config: orchestratorConfig };
  const spawnCalls = [];
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      spawnCalls.push({ command, argv });
      if (command === 'gh' && argv[0] === 'issue' && argv[1] === 'comment') {
        return {
          status: 0,
          stdout: 'https://github.com/Crazz-Org/SPO-WebClient/issues/12345#issuecomment-1\n',
          stderr: '',
          signal: null,
        };
      }
      return { status: 0, stdout: '', stderr: '', signal: null };
    }),
  };

  parkLoop.postParkComment(ctx, deps, { reason: 'x', detail: {}, lastState: 'WORKTREE' });

  const commentCall = spawnCalls.find((c) => c.command === 'gh' && c.argv[0] === 'issue' && c.argv[1] === 'comment');
  assert.ok(commentCall, 'gh issue comment was never called');
  assert.equal(commentCall.argv[commentCall.argv.indexOf('--repo') + 1], 'Crazz-Org/SPO-WebClient');
  assert.equal(commentCall.argv[commentCall.argv.indexOf('--repo') + 1], orchestratorConfig.ghRepo);
});
