'use strict';
// Coverage for action 5.3: routing change-validator's PASS_WITH_FINDINGS findings and
// citation-verifier's DIVERGES entries into a comment a human actually sees, instead of journaled
// and lost (both were, measured across all 19 journals -- see park-loop.js's own action-5.3
// header for the corpus and the erratum A/B write-up this file's fixtures are drawn from
// verbatim). Two layers: the PURE renderer (buildValidateFindingsComment / normalizeFindingsPayload,
// no fs, no spawn, unit-testable on their own) and the end-to-end wiring through
// state-machine.js's handleValidate (HANDLERS.VALIDATE), real mode only. Every spawn here is an
// injected deps.spawnSync; nothing touches a real git/gh/npm/claude process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { buildValidateFindingsComment, normalizeFindingsPayload } = require('../orchestrator/park-loop');
const { appendEvent } = require('../orchestrator/journal');
const { timeoutResult, writePoolDir } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function fail(status) {
  return { status, stdout: '', stderr: 'boom', signal: null };
}
function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ==================================================================================================
// Part 1 -- the pure renderer: normalizeFindingsPayload / buildValidateFindingsComment. No fs, no
// ctx, no spawn -- these are called directly with in-memory values.
// ==================================================================================================

// ---- normalizeFindingsPayload: every shape `result.findings` (or `cv.entries`) has been measured
// or could plausibly arrive as -----------------------------------------------------------------

test('normalizeFindingsPayload: a real array is used as-is, shape "array"', () => {
  const { items, shape } = normalizeFindingsPayload([{ summary: 'x' }]);
  assert.equal(shape, 'array');
  assert.deepEqual(items, [{ summary: 'x' }]);
});

test('normalizeFindingsPayload: a JSON-encoded string (the shape every one of the 8 measured findings actually arrived as) is parsed, shape "json-string"', () => {
  const { items, shape } = normalizeFindingsPayload(JSON.stringify([{ summary: 'x' }, { summary: 'y' }]));
  assert.equal(shape, 'json-string');
  assert.equal(items.length, 2);
});

test('normalizeFindingsPayload: an unparsable string never throws, shape "unparsable-string", empty items', () => {
  const { items, shape } = normalizeFindingsPayload('not json at all {{{');
  assert.equal(shape, 'unparsable-string');
  assert.deepEqual(items, []);
});

test('normalizeFindingsPayload: null / undefined / a bare object / a JSON string that parses to an object all become empty items, never throw', () => {
  assert.deepEqual(normalizeFindingsPayload(null), { items: [], shape: 'null' });
  assert.deepEqual(normalizeFindingsPayload(undefined), { items: [], shape: 'absent' });
  assert.deepEqual(normalizeFindingsPayload({ oops: true }), { items: [], shape: 'object' });
  assert.deepEqual(normalizeFindingsPayload(JSON.stringify({ oops: true })), { items: [], shape: 'json-string-object' });
  assert.deepEqual(normalizeFindingsPayload(JSON.stringify(null)), { items: [], shape: 'json-string-null' });
});

// ---- buildValidateFindingsComment: erratum A -- title XOR summary, and the four measured
// key-sets, verbatim from the corpus -------------------------------------------------------------

test('buildValidateFindingsComment: a summary-only finding (issue-232 shape, 4 keys) renders the summary as the headline, never prints "undefined"', () => {
  const finding = {
    category: 'latent-trap',
    size: 'S',
    area: 'gateway',
    summary:
      'The new `export { server as httpServer }` in src/server/server.ts makes the raw module-level HTTP server public API, letting any embedder bind it directly and bypass the production-configuration refusal checks (SEC-R-2 ...) that startGateway enforces before listening.',
  };
  const body = buildValidateFindingsComment({ findings: [finding] });
  assert.match(body, /export \{ server as httpServer \}/);
  assert.match(body, /category: `latent-trap`/);
  assert.match(body, /area: `gateway`/);
  assert.match(body, /size: `S`/);
  assert.ok(!body.includes('undefined'), 'a summary-only finding must never render "undefined" for the absent title/detail/file/line');
});

test('buildValidateFindingsComment: a title-only finding (issue-418/439 shape, 5 keys) renders the title as the headline and detail as the body, never prints "undefined"', () => {
  const finding = {
    title: "SEC-T-3 (HSTS) moved to SPO-Deploy's policy although it is enforced by product code in this repo",
    detail: 'The rewrite of doc/production-security-policy.md removed SEC-T-1..T-3 wholesale.',
    category: 'doc-infra',
    size: 'S',
    area: 'docs',
  };
  const body = buildValidateFindingsComment({ findings: [finding] });
  assert.match(body, /SEC-T-3 \(HSTS\) moved/);
  assert.match(body, /The rewrite of doc\/production-security-policy\.md/);
  assert.ok(!body.includes('undefined'));
});

test('buildValidateFindingsComment: the 6-key shape (issue-247 -- summary + file/line) renders the location, the 9-key shape (issue-462 -- title + file/line + short_summary + failure_scenario) renders every present key -- all four measured key-sets render without throwing', () => {
  const sixKey = {
    category: 'x',
    size: 'S',
    area: 'y',
    file: 'src/server/proxy-image.ts',
    line: 250,
    summary: 'a six-key finding',
  };
  const bodySix = buildValidateFindingsComment({ findings: [sixKey] });
  assert.match(bodySix, /`src\/server\/proxy-image\.ts:250`/);
  assert.ok(!bodySix.includes('undefined'));

  const nineKey = {
    title: 'rdo-members.ts header still declares that the file encodes no Pascal declaration',
    file: 'src/shared/rdo-members.ts',
    line: 26,
    category: 'doc-infra',
    size: 'S',
    area: 'rdo',
    short_summary: 'Header says file encodes no Pascal declaration',
    detail: 'The file header states "It is not a conformity oracle...".',
    failure_scenario: 'A maintainer adding an entry reads the header and omits the citation.',
  };
  const bodyNine = buildValidateFindingsComment({ findings: [nineKey] });
  assert.match(bodyNine, /`src\/shared\/rdo-members\.ts:26`/);
  assert.match(bodyNine, /rdo-members\.ts header still declares/);
  assert.match(bodyNine, /It is not a conformity oracle/);
  assert.match(bodyNine, /Header says file encodes no Pascal declaration/);
  assert.match(bodyNine, /Failure scenario: A maintainer adding an entry/);
  assert.ok(!bodyNine.includes('undefined'));

  // All four key-sets together, in one comment, none of them throwing.
  const fourKey = { category: 'observation', size: 'S', area: 'gateway', summary: 'a four-key finding' };
  const fiveKey = { title: 'a five-key title', detail: 'a five-key detail', category: 'x', size: 'S', area: 'y' };
  assert.doesNotThrow(() => buildValidateFindingsComment({ findings: [fourKey, fiveKey, sixKey, nineKey] }));
});

test('buildValidateFindingsComment: file present, line absent -> renders the bare file, no ":undefined"; neither present -> no location segment at all', () => {
  const fileOnly = { summary: 'x', file: 'src/a.ts' };
  const bodyFileOnly = buildValidateFindingsComment({ findings: [fileOnly] });
  assert.match(bodyFileOnly, /`src\/a\.ts`/);
  assert.ok(!bodyFileOnly.includes('src/a.ts:undefined'));

  const neither = { summary: 'x' };
  const bodyNeither = buildValidateFindingsComment({ findings: [neither] });
  assert.ok(!bodyNeither.includes('src/a.ts'));
  assert.ok(!bodyNeither.includes('undefined'));
});

// ---- malformed elements: an array of nulls, a bare string, a number -- must render a placeholder,
// never throw ------------------------------------------------------------------------------------

test('buildValidateFindingsComment: an array containing null / a string / a number never throws, renders a placeholder line for each malformed element', () => {
  const findings = [null, 'a bare string', 42, { summary: 'the one real finding' }];
  let body;
  assert.doesNotThrow(() => {
    body = buildValidateFindingsComment({ findings });
  });
  assert.match(body, /malformed finding/);
  assert.match(body, /the one real finding/);
  assert.ok(!body.includes('undefined'));
});

// ---- PASS with an empty findings array: no section at all --------------------------------------

test('buildValidateFindingsComment: an empty findings array with no DIVERGES renders no "Change validator" section', () => {
  const body = buildValidateFindingsComment({ findings: [] });
  assert.ok(!body.includes('Change validator: PASS_WITH_FINDINGS'));
});

// ---- erratum B: DIVERGES entries ----------------------------------------------------------------

test('buildValidateFindingsComment: DIVERGES with entries renders member/citation/finding for each', () => {
  const entries = [
    {
      member: 'RDOOpenSession',
      citation: 'DServer/DirectoryServer.pas:143',
      finding: '0-arg published function, kept as accessor `get` under rule 1.',
    },
  ];
  const body = buildValidateFindingsComment({ diverges: true, divergesEntries: entries });
  assert.match(body, /Citation verifier: DIVERGES/);
  assert.match(body, /RDOOpenSession/);
  assert.match(body, /DServer\/DirectoryServer\.pas:143/);
  assert.match(body, /kept as accessor/);
  assert.ok(!body.includes('undefined'));
});

test('buildValidateFindingsComment: DIVERGES with no entries (issue-462\'s own recorded shape, before this action) still renders the section, "(no entries reported)" instead of nothing', () => {
  const body = buildValidateFindingsComment({ diverges: true, divergesEntries: [] });
  assert.match(body, /Citation verifier: DIVERGES/);
  assert.match(body, /\(no entries reported\)/);
});

test('buildValidateFindingsComment: a malformed entries array (nulls/strings) never throws', () => {
  assert.doesNotThrow(() => buildValidateFindingsComment({ diverges: true, divergesEntries: [null, 'oops', 7] }));
});

// ---- one comment, not two: both findings and DIVERGES in the same body, clearly separated ------

test('buildValidateFindingsComment: DIVERGES entries and PASS_WITH_FINDINGS findings together produce ONE body with two clearly-separated sections, in a stable order', () => {
  const body = buildValidateFindingsComment({
    diverges: true,
    divergesEntries: [{ member: 'M', citation: 'c:1', finding: 'f' }],
    findings: [{ summary: 'a change-validator finding' }],
  });
  const divergesIdx = body.indexOf('Citation verifier: DIVERGES');
  const findingsIdx = body.indexOf('Change validator: PASS_WITH_FINDINGS');
  assert.ok(divergesIdx !== -1 && findingsIdx !== -1 && divergesIdx < findingsIdx);
});

test('buildValidateFindingsComment: prNumber, when given, names the PR so the link is not lost once the PR closes on merge', () => {
  const body = buildValidateFindingsComment({ prNumber: 462, findings: [{ summary: 'x' }] });
  assert.match(body, /#462/);
});

// ---- purity: no filesystem access at all, same discipline as buildParkComment's own test -------

test('buildValidateFindingsComment: stays pure -- no filesystem access, callable with only in-memory values', () => {
  const realRead = fs.readFileSync;
  const realExists = fs.existsSync;
  const reached = [];
  fs.readFileSync = (...args) => {
    reached.push('readFileSync');
    return realRead(...args);
  };
  fs.existsSync = (...args) => {
    reached.push('existsSync');
    return realExists(...args);
  };
  let body;
  try {
    body = buildValidateFindingsComment({
      prNumber: 999,
      diverges: true,
      divergesEntries: [{ member: 'M', citation: 'c:1', finding: 'f' }],
      findings: [{ title: 't', detail: 'd', category: 'c', size: 'S', area: 'a' }],
    });
  } finally {
    fs.readFileSync = realRead;
    fs.existsSync = realExists;
  }
  assert.deepEqual(reached, [], `buildValidateFindingsComment must stay pure; it reached fs.${reached.join(', fs.')}`);
  assert.match(body, /#999/);
});

// ==================================================================================================
// Part 2 -- end-to-end through HANDLERS.VALIDATE (state-machine.js's handleValidate), real mode.
// ==================================================================================================

function realShapedLlmReply(payload, overrides = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({
      result: JSON.stringify(payload),
      is_error: false,
      num_turns: 1,
      session_id: 'sess-vf-1',
      modelUsage: { fable: { costUSD: 0.001 } },
      terminal_reason: 'success',
      api_error_status: null,
      ...overrides,
    }),
    stderr: '',
    signal: null,
  };
}

// Full `kind: "card"` real path (step-contracts.js + prompt-template.js), the only way to reach
// handleValidate with an actual verdict/findings payload -- the legacy ctx.task.llm.<step>
// override (test/diagnose-surface.test.js's own convention) returns invokeClaudeReal's raw shape
// with no JSON-parsing of `result` at all, so it can never carry a `verdict` key; unsuitable here.
function validateCtx({ id, issue, touchesRdoMembers = false, spawnSync, prNumber, configOverrides = {} }) {
  const accountsDir = mkTmp('spo-vf-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  const worktreePath = mkTmp('spo-vf-wt-');
  const task = {
    id,
    kind: 'card',
    issue,
    title: 'x',
    criterion: 'the thing works',
    worktreePath,
    touchesRdoMembers,
    size: 'S',
    citations: touchesRdoMembers ? ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'] : undefined,
  };
  const ctx = buildCtx(id, task, mkTmp('spo-vf-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    real: true,
    stepDeadlineMs: 30000,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    claudeAccountsDir: accountsDir,
    deps: { spawnSync },
    ...configOverrides,
  });
  // VALIDATE's prompt declares invariants_path/invariant_ids, PLAN's own output -- same minimal
  // stand-in test/real-steps.test.js's own judge-input tests use.
  appendEvent(ctx.taskDir, 'PLAN', 'result', {
    payload: { invariants_path: path.join(ctx.taskDir, 'invariants.md'), invariant_ids: ['INV-1'] },
  });
  if (typeof prNumber === 'number') ctx.prNumber = prNumber;
  return ctx;
}

// Standard git/npm plumbing every HANDLERS.VALIDATE call needs (moveCard's board:move,
// prepareJudgeInputs' diff.patch) -- `claudeReplies` is consumed in call order: CITATION_VERIFIER
// first (only when touchesRdoMembers), then VALIDATE. `ghResult` answers every `gh issue comment`
// call (there is at most one per test here).
function makeValidateSpawn({ claudeReplies, ghResult, calls = [] }) {
  let claudeIdx = 0;
  const spawnSync = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'npm') return ok('');
    if (command === 'git') {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('headsha000000000000000000000000000000\n');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('mainsha000000000000000000000000000000\n');
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff')) return ok('diff --git a/z.ts b/z.ts\n+change\n');
      return ok('');
    }
    if (command === 'claude') {
      const reply = claudeReplies[Math.min(claudeIdx, claudeReplies.length - 1)];
      claudeIdx += 1;
      return reply;
    }
    if (command === 'gh') {
      // A FUNCTION ghResult is CALLED, not returned. Without this the hostile-shape test below
      // silently proved nothing: `ghResult: () => { throw ... }` was handed back as a function
      // object, armTimeout happily stamped a property on it, normalizeExit read no status and
      // called it exit 1 -- an ordinary failure, never the throw the test is named for.
      if (typeof ghResult === 'function') return ghResult();
      return ghResult || ok('https://github.com/Crazz-Org/SPO-WebClient/issues/1#issuecomment-1\n');
    }
    return ok('');
  };
  spawnSync.calls = calls;
  return spawnSync;
}

test('HANDLERS.VALIDATE (real mode): PASS_WITH_FINDINGS with real corpus findings (JSON-encoded STRING, issue-232 shape) posts the comment on the ISSUE, names the PR, journals validate-findings-posted with the count, and returns MERGE', async () => {
  const calls = [];
  const findingsPayload = [
    {
      category: 'latent-trap',
      size: 'S',
      area: 'gateway',
      summary: 'The new `export { server as httpServer }` bypasses SEC-R-2.',
    },
  ];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: JSON.stringify(findingsPayload) })],
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-1', issue: 601, spawnSync, prNumber: 601 });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');

  const ghCalls = calls.filter((c) => c.command === 'gh');
  assert.equal(ghCalls.length, 1, 'exactly one comment posted');
  assert.deepEqual(ghCalls[0].args.slice(0, 4), ['issue', 'comment', '601', '--repo']);
  const bodyFile = ghCalls[0].args[ghCalls[0].args.indexOf('--body-file') + 1];
  const body = fs.readFileSync(bodyFile, 'utf8');
  assert.match(body, /export \{ server as httpServer \}/);
  assert.match(body, /#601/);

  const journal = readJournal(ctx.taskDir);
  const shapeEvent = journal.find((e) => e.event === 'validate-findings-shape');
  assert.ok(shapeEvent, 'the received shape must be journalled');
  assert.equal(shapeEvent.shape, 'json-string', 'the corpus shape (findings as a JSON-encoded string) must be recognized as such');
  assert.equal(shapeEvent.count, 1);
  const posted = journal.find((e) => e.event === 'validate-findings-posted');
  assert.ok(posted);
  assert.equal(posted.count, 1);
  assert.equal(posted.commentId, 1);
});

test('HANDLERS.VALIDATE (real mode): plain PASS posts NO comment at all', async () => {
  const calls = [];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'PASS', reasons: [], findings: [] })],
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-2', issue: 602, spawnSync });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');
  assert.ok(!calls.some((c) => c.command === 'gh'), 'a plain PASS must never spawn `gh issue comment`');
});

test('HANDLERS.VALIDATE (real mode): PASS_WITH_FINDINGS with an EMPTY findings array posts NO comment at all', async () => {
  const calls = [];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [] })],
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-3', issue: 603, spawnSync });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');
  assert.ok(!calls.some((c) => c.command === 'gh'), 'an empty findings array must never post a comment');

  const journal = readJournal(ctx.taskDir);
  const shapeEvent = journal.find((e) => e.event === 'validate-findings-shape');
  assert.equal(shapeEvent.count, 0);
});

test('HANDLERS.VALIDATE (real mode): malformed findings (not JSON, null, an array of nulls, an object) never throw and never block the merge', async () => {
  const cases = [
    { label: 'unparsable string', findings: 'this is not JSON {{{' },
    { label: 'null', findings: null },
    { label: 'array of nulls', findings: [null, null] },
    { label: 'a bare object', findings: { oops: true } },
  ];

  for (const [i, c] of cases.entries()) {
    const calls = [];
    const spawnSync = makeValidateSpawn({
      claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: c.findings })],
      calls,
    });
    const ctx = validateCtx({ id: `card-vf-malformed-${i}`, issue: 700 + i, spawnSync });

    let next;
    await assert.doesNotReject(async () => {
      next = await HANDLERS.VALIDATE(ctx);
    }, `case "${c.label}" must never throw`);
    assert.equal(next, 'MERGE', `case "${c.label}" must still merge`);
  }

  // "array of nulls" has two (malformed) elements -- there IS something to render, so it DOES
  // post a comment, of two placeholder lines, never a crash.
  const calls2 = [];
  const spawnSync2 = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [null, null] })],
    calls: calls2,
  });
  const ctx2 = validateCtx({ id: 'card-vf-nulls-render', issue: 710, spawnSync: spawnSync2 });
  await HANDLERS.VALIDATE(ctx2);
  const ghCall = calls2.find((c) => c.command === 'gh');
  assert.ok(ghCall, 'two malformed-but-present array elements are still something to render');
  const bodyFile = ghCall.args[ghCall.args.indexOf('--body-file') + 1];
  const body = fs.readFileSync(bodyFile, 'utf8');
  assert.match(body, /malformed finding/);
  assert.ok(!body.includes('undefined'));
});

test('HANDLERS.VALIDATE (real mode): citation-verifier DIVERGES journals `entries` (erratum B) and routes them into the comment; verdict PASS still returns MERGE', async () => {
  const calls = [];
  const divergesEntries = [
    {
      member: 'RDOOpenSession',
      citation: 'DServer/DirectoryServer.pas:143',
      finding: '0-arg published function, kept as accessor `get` under rule 1.',
    },
  ];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [
      realShapedLlmReply({ verdict: 'DIVERGES', entries: divergesEntries }), // CITATION_VERIFIER
      realShapedLlmReply({ verdict: 'PASS', reasons: [], findings: [] }), // VALIDATE
    ],
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-diverges', issue: 462, touchesRdoMembers: true, spawnSync, prNumber: 470 });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');

  const journal = readJournal(ctx.taskDir);
  const cvEvent = journal.find((e) => e.event === 'citation-verifier');
  assert.ok(cvEvent, 'citation-verifier event must be journalled');
  assert.equal(cvEvent.verdict, 'DIVERGES');
  assert.deepEqual(cvEvent.entries, divergesEntries, 'erratum B: entries must ride along, not just the bare verdict (issue-462\'s own gap)');

  const ghCall = calls.find((c) => c.command === 'gh');
  assert.ok(ghCall, 'DIVERGES must post a comment even with a PASS change-validator verdict');
  const bodyFile = ghCall.args[ghCall.args.indexOf('--body-file') + 1];
  const body = fs.readFileSync(bodyFile, 'utf8');
  assert.match(body, /Citation verifier: DIVERGES/);
  assert.match(body, /RDOOpenSession/);
  assert.match(body, /#470/);
  assert.ok(!body.includes('Change validator: PASS_WITH_FINDINGS'), 'a plain PASS change-validator verdict must not add its own section');
});

test('HANDLERS.VALIDATE (real mode): DIVERGES + PASS_WITH_FINDINGS in the same run produce exactly ONE comment with both sections', async () => {
  const calls = [];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [
      realShapedLlmReply({ verdict: 'DIVERGES', entries: [{ member: 'M', citation: 'c:1', finding: 'f' }] }),
      realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [{ summary: 'a validator finding' }] }),
    ],
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-both', issue: 463, touchesRdoMembers: true, spawnSync });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');

  const ghCalls = calls.filter((c) => c.command === 'gh');
  assert.equal(ghCalls.length, 1, 'both sources must land in exactly one comment, never two');
  const bodyFile = ghCalls[0].args[ghCalls[0].args.indexOf('--body-file') + 1];
  const body = fs.readFileSync(bodyFile, 'utf8');
  assert.match(body, /Citation verifier: DIVERGES/);
  assert.match(body, /Change validator: PASS_WITH_FINDINGS/);
  assert.match(body, /a validator finding/);
});

test('HANDLERS.VALIDATE (real mode): a non-zero `gh` exit never blocks the merge -- journals validate-findings-post-failed, still returns MERGE', async () => {
  const calls = [];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [{ summary: 'x' }] })],
    ghResult: fail(1),
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-ghfail', issue: 604, spawnSync });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'validate-findings-post-failed');
  assert.ok(failed);
  assert.equal(failed.exit, 1);
  assert.ok(!journal.some((e) => e.event === 'validate-findings-posted'));
});

test('HANDLERS.VALIDATE (real mode): a timed-out `gh` spawn never throws -- journalled as validate-findings-post-failed with timedOut: true, still returns MERGE', async () => {
  const calls = [];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [{ summary: 'x' }] })],
    ghResult: timeoutResult(),
    calls,
  });
  const ctx = validateCtx({
    id: 'card-vf-timeout',
    issue: 605,
    spawnSync,
    configOverrides: { commandTimeoutsMs: { gh: 120000 } },
  });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'validate-findings-post-failed');
  assert.ok(failed, 'a hung gh issue comment must still be reported, not silently swallowed');
  assert.equal(failed.timedOut, true);
  assert.notEqual(failed.exit, 1, 'a timeout must never be journalled as a plain exit 1');
});

test('HANDLERS.VALIDATE (real mode): a `gh` spawn that THROWS, or returns undefined/null, never escapes handleValidate', async () => {
  // The guard handleValidate wraps this post in had NO coverage: verification mutated the catch
  // into `throw err`, and then deleted the try/catch outright, and both survived all 1137 tests --
  // because every failure fixture fed a well-formed spawn result that postValidateFindingsComment
  // handles internally and returns from normally. Nothing ever reached the catch. This is the
  // named class ("C3 already shipped exactly that shape once"): a throw here escapes into
  // runTask and kills the daemon over a best-effort comment.
  for (const [label, ghResult] of [
    ['throws', () => { throw new Error('spawn EACCES'); }],
    ['undefined', () => undefined],
    ['null', () => null],
  ]) {
    const calls = [];
    const spawnSync = makeValidateSpawn({
      claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [{ summary: 'x' }] })],
      ghResult,
      calls,
    });
    const ctx = validateCtx({ id: `card-vf-hostile-${label}`, issue: 605, spawnSync });

    let next;
    await assert.doesNotReject(async () => {
      next = await HANDLERS.VALIDATE(ctx);
    }, `a gh spawn that returns ${label} must never escape handleValidate`);
    assert.equal(next, 'MERGE', `the merge proceeds regardless (${label})`);
    assert.ok(
      readJournal(ctx.taskDir).some((e) => e.event === 'validate-findings-post-failed'),
      `the failure is on the record, not swallowed (${label})`
    );
  }
});

test('HANDLERS.VALIDATE (real mode): a REJECT threads its findings onward even when they arrive as a JSON-encoded STRING', () => {
  // The eighth production bug of this class, and it is in this very file. Measured 2026-09-01:
  // all 16 `change-validator` events in the 19-journal corpus carry `findings` as a JSON-encoded
  // STRING, never an array -- the same shape that made 3.2's protected-files guard fail open on
  // every real card. handleValidate's REJECT path tested `Array.isArray(result.findings)`, so
  // action 1.6's whole point (thread a REJECT's findings into the next IMPLEMENT so it cannot
  // rebuild the change VALIDATE just rejected) had never once fired with a finding in it.
  // Nothing was lost yet only because the corpus's single REJECT carried an empty array.
  const raw = JSON.stringify([{ summary: 'the rejected thing', category: 'defect' }]);
  const calls = [];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'REJECT', reasons: ['no'], findings: raw })],
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-reject-string', issue: 607, spawnSync });

  return HANDLERS.VALIDATE(ctx).then((next) => {
    assert.equal(next, 'IMPLEMENT', 'a REJECT within budget goes back to IMPLEMENT');

    const journal = readJournal(ctx.taskDir);
    // No findings comment on a REJECT -- that path has its own threading, and the change is not
    // merging.
    assert.ok(!journal.some((e) => e.event === 'validate-findings-posted'));
    assert.ok(!calls.some((c) => c.command === 'gh'));

    const threaded = journal.find((e) => e.state === 'VALIDATE' && e.event === 'result');
    assert.ok(threaded, "action 1.6's result event is written");
    assert.deepEqual(
      threaded.payload.findings,
      [{ summary: 'the rejected thing', category: 'defect' }],
      'the JSON-encoded string is parsed, not silently dropped to []'
    );
  });
});

test('HANDLERS.VALIDATE (real mode): the change-validator verdict is journalled BEFORE the findings comment is posted', async () => {
  // Ordering, pinned. Verification moved the `change-validator` event to after the post and the
  // whole suite stayed green -- the same unpinned-ordering shape that shipped silently twice
  // earlier in this chantier. It matters because the journal is the ledger: if the post throws,
  // hangs or is killed mid-flight, the verdict must already be on the record.
  const calls = [];
  const spawnSync = makeValidateSpawn({
    claudeReplies: [realShapedLlmReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [{ summary: 'x' }] })],
    calls,
  });
  const ctx = validateCtx({ id: 'card-vf-order', issue: 606, spawnSync });

  assert.equal(await HANDLERS.VALIDATE(ctx), 'MERGE');

  const journal = readJournal(ctx.taskDir);
  const verdictAt = journal.findIndex((e) => e.event === 'change-validator');
  const postedAt = journal.findIndex((e) => e.event === 'validate-findings-posted');
  assert.ok(verdictAt !== -1, 'the verdict is journalled');
  assert.ok(postedAt !== -1, 'the post is journalled');
  assert.ok(verdictAt < postedAt, `change-validator (${verdictAt}) must precede validate-findings-posted (${postedAt})`);
});

test('buildValidateFindingsComment: the WHOLE body is capped, not just each field -- 30 max-length findings would be 11x over GitHub\'s limit', () => {
  // Measured: 30 findings each at the 8000-char field cap render 722,497 characters against
  // GitHub's 65,536 comment limit. `gh` 422s, the post journals validate-findings-post-failed,
  // the merge proceeds -- and the findings are lost again, the exact failure this action ends.
  const findings = Array.from({ length: 30 }, (_, i) => ({
    title: 'T'.repeat(8000),
    detail: 'D'.repeat(8000),
    failure_scenario: 'F'.repeat(8000),
    short_summary: 'S'.repeat(8000),
    category: `c${i}`,
  }));
  const body = buildValidateFindingsComment({ prNumber: 1, findings });
  assert.ok(body.length <= 60200, `body must be capped, got ${body.length}`);
  assert.match(body, /truncated: the rendered findings exceeded/);
});

test('buildValidateFindingsComment: names the PR without claiming it merged -- the comment is posted BEFORE realMerge runs', () => {
  // realMerge can still park four ways after this comment is posted (pr-merge-enqueue-failed,
  // pr-closed-unmerged, merge-queue-not-landing, pr-wait-unrecognized-exit). issue-443 is the
  // corpus proof: it parked `pr-closed-unmerged` at MERGE. An issue permanently carrying
  // "Merged via #427." next to a park comment saying otherwise is the board-vs-reality
  // divergence this chantier exists to end.
  const body = buildValidateFindingsComment({ prNumber: 427, findings: [{ summary: 'x' }] });
  assert.match(body, /PR #427\./);
  assert.ok(!/Merged via/.test(body), 'never assert a merge that has not happened yet');
});

test('HANDLERS.VALIDATE (shadow mode): PASS_WITH_FINDINGS with findings posts NO comment -- real mode only', async () => {
  const spawnSync = () => {
    throw new Error('shadow mode must never spawn anything for the validate-findings comment');
  };
  const task = {
    id: 'card-vf-shadow',
    kind: 'synthetic',
    issue: 606,
    touchesRdoMembers: false,
    shadow: { llm: { VALIDATE: { verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: [{ summary: 'x' }] } } },
  };
  const ctx = buildCtx('card-vf-shadow', task, mkTmp('spo-vf-shadow-taskdir-'), {
    shadowMode: true,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    deps: { spawnSync },
  });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');
  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'validate-findings-posted' || e.event === 'validate-findings-post-failed' || e.event === 'validate-findings-shape'));
});

test('HANDLERS.VALIDATE (--dry-run): PASS_WITH_FINDINGS posts NO comment -- real mode only', async () => {
  const spawnSync = () => {
    throw new Error('--dry-run must never spawn anything for the validate-findings comment');
  };
  const worktreePath = mkTmp('spo-vf-dryrun-wt-');
  const accountsDir = mkTmp('spo-vf-dryrun-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);
  const task = {
    id: 'card-vf-dryrun',
    kind: 'card',
    issue: 607,
    criterion: 'the thing works',
    worktreePath,
    touchesRdoMembers: false,
  };
  const ctx = buildCtx('card-vf-dryrun', task, mkTmp('spo-vf-dryrun-taskdir-'), {
    shadowMode: false,
    dryRun: true,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    claudeAccountsDir: accountsDir,
    deps: { spawnSync },
  });
  appendEvent(ctx.taskDir, 'PLAN', 'result', {
    payload: { invariants_path: '/tmp/invariants-vf-dryrun.md', invariant_ids: ['INV-1'] },
  });

  // --dry-run's cannedDryRunPayload for VALIDATE is {verdict: 'PASS', reasons: [...], findings:
  // []} (steps/llm.js) -- plain PASS, so this also exercises the "nothing to post" path, on top
  // of the real-mode-only gate.
  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');
  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'validate-findings-posted' || e.event === 'validate-findings-post-failed'));
});
