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

const { mkTmp, writePoolDir } = require('./helpers');
const intake = require('../orchestrator/intake');
const spo = require('../bin/spo');

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
  const deps = {
    accountsDir: poolDir(),
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
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
  assert.ok(seenArgv[1].includes('the header has no connection badge'));
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
    spawnSync: fakeSpawnSync((command, argv) => {
      seenPrompts.push(argv[1]);
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
      await spo.cmdAsk(opts, { intake: fakeIntake });
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
      await spo.cmdAsk(opts, { intake: fakeIntake });
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
      await spo.cmdAsk(opts, { intake: fakeIntake });
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
      await spo.cmdAsk(opts, { intake: fakeIntake });
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
      await spo.cmdAsk(opts, { intake: fakeIntake });
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
  withExitCodeReset(async () => {
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
);

test(
  'spo pull: default limit is 5, and a skipped candidate is reported as skipped not written',
  withExitCodeReset(async () => {
    const fakeIntake = {
      pullBoard: () => ({
        ok: true,
        warnings: ['pullBoard: skipped unrecognized line: ???'],
        candidates: [{ rank: 1, issue: 501, area: 'client', title: 'a' }],
      }),
      makeTask: () => ({ ok: true, skipped: true, id: 'issue-501', reason: 'issue-501 already present in queue/ or journal/' }),
    };

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
);
