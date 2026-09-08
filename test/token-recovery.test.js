'use strict';
// Unit tests for orchestrator/token-recovery.js (token-ledger lot, action 4.3). Every fixture
// below is a REAL temp directory tree (fs.mkdtempSync via test/helpers.js's mkTmp) -- no mocked
// fs, per this action's own test instructions. `scanFile` (console/usage-scan.js) is the one
// reader this module shares with the live dashboard scan; these tests exercise
// recoverSessionTokens end to end, through the real reader, against real files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp } = require('./helpers');

// Repo-wide guard against a real in-process spawnSync -- see test/no-real-spawn.js's own header.
// This file never spawns anything, but every test file in this suite requires it first by
// convention, before any orchestrator require.
require('./no-real-spawn');

const { recoverSessionTokens } = require('../orchestrator/token-recovery');

// One assistant-message usage line, the shape scanFile actually reads
// (message.usage.{input_tokens,cache_creation_input_tokens,cache_read_input_tokens,
// output_tokens}, message.id, message.model, top-level sessionId/timestamp).
function usageLine({
  id,
  model = 'claude-sonnet-4-5',
  input = 0,
  cacheCreation = 0,
  cacheRead = 0,
  output = 0,
  sessionId,
  ts = '2026-09-01T00:00:00.000Z',
}) {
  return JSON.stringify({
    sessionId,
    timestamp: ts,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  });
}

function writeProjectFile(projectsRoot, project, filename, lines) {
  const dir = path.join(projectsRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

// Builds a discovery-based account pool directory (see orchestrator/accounts.js / console/
// usage-scan.js's discoverUsageRoots): one subdirectory per account name, each with its own
// `projects` directory -- the layout discoverUsageRoots itself walks.
function makeAccountsDir(names) {
  const accountsDir = mkTmp('spo-token-recovery-accounts-');
  for (const name of names) {
    fs.mkdirSync(path.join(accountsDir, name, 'projects'), { recursive: true });
  }
  return accountsDir;
}

function projectsDirFor(accountsDir, name) {
  return path.join(accountsDir, name, 'projects');
}

// ---- 1. finds <sessionId>.jsonl under the account's own root -----------------------------------

test('recoverSessionTokens: finds <sessionId>.jsonl in a project dir under the account\'s own root and sums it', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = '22222222-2222-4222-8222-222222222222';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 100, cacheCreation: 50, cacheRead: 20, output: 10, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.deepEqual(result, {
    tokensSource: 'transcript',
    freshInputTokens: 100,
    cacheCreationTokens: 50,
    cacheReadTokens: 20,
    outputTokens: 10,
    billableTokens: 160,
    transcriptFilesRead: 1,
    transcriptFilesSkipped: 0,
  });
});

// ---- 2. the recursive <sessionId>/subagents/** tree, attributed to the same session ------------

test('recoverSessionTokens: includes the recursive <sessionId>/subagents/** tree, folded into the same session', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const projectsDir = projectsDirFor(accountsDir, 'acct-a');
  const project = '-home-crazz-project';

  writeProjectFile(projectsDir, project, `${sessionId}.jsonl`, [
    usageLine({ id: 'main1', input: 100, output: 10, sessionId }),
  ]);
  // A deeper, workflow-spawned layout (subagents/workflows/<wf_id>/agent-<hash>.jsonl), matching
  // console/usage-scan.js's own listJsonlFilesRecursive coverage, not just the flat one-level case.
  const deepSubagentDir = path.join(projectsDir, project, sessionId, 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(deepSubagentDir, { recursive: true });
  fs.writeFileSync(
    path.join(deepSubagentDir, 'agent-abc.jsonl'),
    usageLine({ id: 'sub1', input: 5, output: 2, sessionId }) + '\n'
  );

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.freshInputTokens, 105);
  assert.equal(result.outputTokens, 12);
  assert.equal(result.billableTokens, 117);
  assert.equal(result.transcriptFilesRead, 2);
});

// ---- 3. searches other roots when the account's own root does not hold it ----------------------

test('recoverSessionTokens: searches the other pool accounts, then home, when the account\'s own root does not hold the session', async () => {
  const accountsDir = makeAccountsDir(['acct-a', 'acct-b']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = '44444444-4444-4444-8444-444444444444';
  // acct-a's own root stays empty -- the call ran under acct-a, but the transcript actually
  // landed under acct-b (a real-corpus shape: an account rotation mid-task).
  writeProjectFile(projectsDirFor(accountsDir, 'acct-b'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 7, output: 3, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 10);
  assert.equal(result.transcriptFilesRead, 1);
});

test('recoverSessionTokens: falls all the way back to homeDir/.claude/projects (the "local" root)', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = '55555555-5555-4555-8555-555555555555';
  writeProjectFile(path.join(homeDir, '.claude', 'projects'), '-home-crazz-adhoc', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 1, output: 1, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 2);
});

// ---- 4. returns null (not undefined, not {}) when nothing matches ------------------------------

// Fix 3 (F1, mutation-testing finding): this test used to assert only the absent case, which a
// mutant that throws unconditionally inside the outer try (whose catch returns null) also
// satisfies -- the catch-all manufactures the exact same "null" this test was looking for. The
// positive control below (a second, VALID session in the same tree) means that same mutant now
// fails a real assertion instead of accidentally passing this one: a broken module returns null
// for the valid session too, which the assertion below catches.
test('recoverSessionTokens: returns exactly null, not undefined and not {}, when no file matches anywhere -- and a valid sibling session in the same tree still recovers', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', 'some-other-session.jsonl', [
    usageLine({ id: 'm1', input: 1, output: 1, sessionId: 'some-other-session' }),
  ]);
  // Positive control: a different, real session's transcript in the SAME tree.
  const siblingSessionId = '66666666-aaaa-4aaa-8aaa-666666666601';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${siblingSessionId}.jsonl`, [
    usageLine({ id: 'sib1', input: 9, output: 4, sessionId: siblingSessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId: '66666666-6666-4666-8666-666666666666',
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.equal(result, null);
  assert.notEqual(result, undefined);
  assert.notDeepEqual(result, {});

  const siblingResult = await recoverSessionTokens({
    sessionId: siblingSessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });
  assert.notEqual(siblingResult, null, 'the sibling session must still recover -- a broken module fails HERE, not silently');
  assert.equal(siblingResult.billableTokens, 13);
});

// ---- 5. returns null when files exist but hold no usage row at all -----------------------------

test('recoverSessionTokens: returns null when a matching file exists but carries no usage row at all -- and a valid sibling session in the same tree still recovers', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = '77777777-7777-4777-8777-777777777777';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${sessionId}.jsonl`, [
    JSON.stringify({ sessionId, timestamp: '2026-09-01T00:00:00.000Z', type: 'summary' }),
    JSON.stringify({ sessionId, message: { id: 'no-usage', model: 'x', content: [] } }), // no `usage` key
  ]);
  // Positive control (Fix 3, F1): a different, real session's transcript in the SAME tree.
  const siblingSessionId = '77777777-aaaa-4aaa-8aaa-777777777701';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${siblingSessionId}.jsonl`, [
    usageLine({ id: 'sib1', input: 6, output: 1, sessionId: siblingSessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.equal(result, null);

  const siblingResult = await recoverSessionTokens({
    sessionId: siblingSessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });
  assert.notEqual(siblingResult, null, 'the sibling session must still recover -- a broken module fails HERE, not silently');
  assert.equal(siblingResult.billableTokens, 7);
});

// ---- 6. a genuine all-zero transcript returns a real 0, not null -------------------------------

test('recoverSessionTokens: a usage row whose fields are all 0 returns a real, measured 0 -- not null', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = '88888888-8888-4888-8888-888888888888';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'zero1', input: 0, cacheCreation: 0, cacheRead: 0, output: 0, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.notEqual(result, null);
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 0);
  assert.equal(Object.is(result.billableTokens, -0), false);
  assert.equal(Object.is(result.billableTokens, 0), true);
  assert.equal(result.freshInputTokens, 0);
  assert.equal(result.cacheCreationTokens, 0);
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.outputTokens, 0);
});

// ---- 7. never throws ----------------------------------------------------------------------------

test('recoverSessionTokens: an unreadable project directory does not throw -- other roots still contribute', async () => {
  const accountsDir = makeAccountsDir(['acct-a', 'acct-b']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = '99999999-9999-4999-8999-999999999999';

  const unreadableProject = path.join(projectsDirFor(accountsDir, 'acct-a'), 'unreadable-project');
  fs.mkdirSync(unreadableProject, { recursive: true });
  fs.chmodSync(unreadableProject, 0o000);

  writeProjectFile(projectsDirFor(accountsDir, 'acct-b'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 4, output: 1, sessionId }),
  ]);

  try {
    const result = await recoverSessionTokens({
      sessionId,
      accountConfigDir: path.join(accountsDir, 'acct-a'),
      accountsDir,
      homeDir,
    });
    // Running as root (some CI/sandbox users) makes chmod 0o000 a no-op for readability -- either
    // way this must not throw, and acct-b's file must still be found.
    assert.notEqual(result, null);
    assert.equal(result.billableTokens, 5);
  } finally {
    fs.chmodSync(unreadableProject, 0o755); // restore so mkTmp's exit-time sweep can remove it
  }
});

// Fix 3 (F1): this test used to be WORSE than neutral -- it stayed green under the F1 defect
// (deleting the try/catch around findSessionFilesUnderRoot's statSync), because a directory-typed
// candidate makes fs.statSync succeed (isFile() false) rather than throw ENOENT, so the buggy path
// never fired for THIS fixture's own project directory; the assertion below never got a chance to
// notice the module was broken for every OTHER project directory in the same root. The positive
// control (a second, real session's transcript in a DIFFERENT project directory under the same
// root) closes that: under the F1 defect, iterating past this fixture's directory-typed candidate
// to reach the sibling's real file would throw and abandon the whole root, so the sibling's
// recovery below would silently come back null instead of a real sum.
test('recoverSessionTokens: a "<sessionId>.jsonl" that is actually a directory does not throw and is not read as a file -- and a valid sibling session in another project dir under the same root still recovers', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const projectDir = path.join(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project');
  fs.mkdirSync(path.join(projectDir, `${sessionId}.jsonl`), { recursive: true }); // a directory, not a file
  // Positive control: a different, real session's transcript in ANOTHER project directory under
  // the same root -- alphabetically AFTER '-home-crazz-project', so the walk reaches it only if
  // the directory-typed candidate above did not abort the root.
  const siblingSessionId = 'aaaaaaaa-bbbb-4bbb-8bbb-aaaaaaaaaa02';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-zzz-other-project', `${siblingSessionId}.jsonl`, [
    usageLine({ id: 'sib1', input: 8, output: 3, sessionId: siblingSessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.equal(result, null);

  const siblingResult = await recoverSessionTokens({
    sessionId: siblingSessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });
  assert.notEqual(siblingResult, null, 'the sibling session must still recover -- a broken module fails HERE, not silently');
  assert.equal(siblingResult.billableTokens, 11);
});

test('recoverSessionTokens: a malformed JSON line mid-file does not throw -- the surrounding valid rows still count', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 10, output: 1, sessionId }),
    '{this is not valid json,,,',
    usageLine({ id: 'm2', input: 20, output: 2, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.notEqual(result, null);
  assert.equal(result.freshInputTokens, 30);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.billableTokens, 33);
});

test('recoverSessionTokens: a file over maxFileBytes is skipped, not read, and does not throw -- and a valid sibling session in the same tree still recovers', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 500, output: 500, sessionId }),
  ]);
  // Positive control (Fix 3, F1): a different, real session's transcript in the SAME tree, under
  // the (tiny) cap -- proves the over-cap skip does not abandon the rest of the walk.
  const siblingSessionId = 'cccccccc-aaaa-4aaa-8aaa-cccccccc0001';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${siblingSessionId}.jsonl`, [
    usageLine({ id: 'sib1', input: 2, output: 1, sessionId: siblingSessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
    maxFileBytes: 4, // smaller than any real line -- the file must be skipped, not truncated-read
  });

  assert.equal(result, null);

  const siblingResult = await recoverSessionTokens({
    sessionId: siblingSessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
    maxFileBytes: 4,
  });
  // The sibling's own line is ALSO bigger than 4 bytes, so it is skipped too under this tiny cap --
  // this asserts the skip itself is contained per-file (result is null, not a throw), not that a
  // small cap somehow spares it. See the default-cap assertion below for the cap actually used in
  // production.
  assert.equal(siblingResult, null);

  // Fix 4 (M16), one assertion rather than a whole new test: maybeRecoverTokens
  // (orchestrator/steps/llm.js) never passes maxFileBytes at all, so every PRODUCTION call falls
  // through to token-recovery.js's own default -- only an explicitly-supplied cap (like the tiny
  // one this test already uses above) was ever pinned by this suite, so raising that default to
  // Infinity stayed green. token-recovery.js re-exports the exact identifier it reads its `cap`
  // fallback from, so this is not a coincidental equality -- it is the same binding
  // console/usage-scan.js exports, never a second, independently-chosen number.
  const { DEFAULT_MAX_FILE_BYTES: recoveryDefault } = require('../orchestrator/token-recovery');
  const { DEFAULT_MAX_FILE_BYTES: usageScanDefault } = require('../console/usage-scan');
  assert.equal(recoveryDefault, usageScanDefault);
  assert.equal(recoveryDefault, 64 * 1024 * 1024);
});

// ---- 8. cacheReadTokens reported separately, never folded into billableTokens ------------------

test('recoverSessionTokens: cacheReadTokens is returned but NOT included in billableTokens', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 10, cacheCreation: 20, cacheRead: 999999, output: 5, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.equal(result.cacheReadTokens, 999999);
  // If cache-read were ever folded in, this would be 1000034 -- it must not be.
  assert.equal(result.billableTokens, 35);
  assert.equal(result.freshInputTokens + result.cacheCreationTokens + result.outputTokens, 35);
});

// ---- 9. same-root traversal past a project directory that lacks the transcript (F1, mutation M6b) ----
//
// findSessionFilesUnderRoot's per-project-directory statSync(`<project>/<sessionId>.jsonl`) is
// wrapped in try/catch, but nothing in this suite before Fix 3/here ever put the real transcript
// in anything but the ONLY project directory of its root -- so the ENOENT this try/catch exists to
// contain never actually happened during a test run. Deleting that try/catch still passed every
// test in this file. On the live corpus this is not academic: 434 project directories exist across
// the three roots this module searches, and exactly one holds any given session, so that statSync
// throws ENOENT 433 times on every successful recovery. Without the catch, the FIRST ENOENT would
// reach recoverSessionTokens' per-root `catch { continue; }`, which abandons the ENTIRE root -- then
// the next, then the next -- returning null for every session. Recovery would be 100% dead in
// production with this whole suite green.
test('recoverSessionTokens: traverses past an alphabetically-first project directory with no transcript to find the session in a later one, in the SAME root', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'f1000000-f1f1-4f1f-8f1f-f10000000001';
  const projectsDir = projectsDirFor(accountsDir, 'acct-a');
  // Alphabetically FIRST: a real project directory that does NOT hold this session's transcript.
  fs.mkdirSync(path.join(projectsDir, '-aaa-empty-project'), { recursive: true });
  // Alphabetically LATER: the one that actually holds it.
  writeProjectFile(projectsDir, '-zzz-real-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 40, output: 4, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.notEqual(result, null);
  assert.equal(result.billableTokens, 44);
  assert.equal(result.transcriptFilesRead, 1);
});

test('recoverSessionTokens: a chmod 0o000 alphabetically-first project directory does not abandon the root -- a later project directory still contributes its exact sum', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'f2000000-f2f2-4f2f-8f2f-f20000000002';
  const projectsDir = projectsDirFor(accountsDir, 'acct-a');
  const unreadableProject = path.join(projectsDir, '-aaa-unreadable-project');
  fs.mkdirSync(unreadableProject, { recursive: true });
  fs.chmodSync(unreadableProject, 0o000); // tests run as uid 1000 here -- a real EACCES, not a no-op
  writeProjectFile(projectsDir, '-zzz-real-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 60, output: 6, sessionId }),
  ]);

  try {
    const result = await recoverSessionTokens({
      sessionId,
      accountConfigDir: path.join(accountsDir, 'acct-a'),
      accountsDir,
      homeDir,
    });
    assert.notEqual(result, null);
    assert.equal(result.billableTokens, 66);
    assert.equal(result.transcriptFilesRead, 1);
  } finally {
    fs.chmodSync(unreadableProject, 0o755); // restore so mkTmp's exit-time sweep can remove it
  }
});

// ---- F1 bite-check: both tests above FAIL when the try/catch is removed by hand -----------------
// (verified manually during this action, not asserted in-suite -- see the driver's own report).

// ---- 10. transcriptFilesSkipped is a real, incrementing completeness signal (Fix 7) -------------

test('recoverSessionTokens: an over-cap file increments transcriptFilesSkipped without affecting the sum from a file under the cap', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'f3000000-f3f3-4f3f-8f3f-f30000000003';
  const projectsDir = projectsDirFor(accountsDir, 'acct-a');
  // Two candidates for the SAME session: the main transcript (small, under the cap) plus a
  // subagent file padded well over it.
  writeProjectFile(projectsDir, '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'main1', input: 10, output: 1, sessionId }),
  ]);
  const subagentDir = path.join(projectsDir, '-home-crazz-project', sessionId, 'subagents');
  fs.mkdirSync(subagentDir, { recursive: true });
  const bigLine = usageLine({ id: 'sub-big', input: 5, output: 1, sessionId }) + ' '.repeat(200) + '\n';
  fs.writeFileSync(path.join(subagentDir, 'agent-big.jsonl'), bigLine);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
    maxFileBytes: bigLine.length - 1, // smaller than the padded subagent file, bigger than the main one
  });

  assert.notEqual(result, null);
  assert.equal(result.transcriptFilesRead, 1, 'only the main transcript was actually read');
  assert.equal(result.transcriptFilesSkipped, 1, 'the over-cap subagent file must be counted as skipped, not silently dropped');
  assert.equal(result.billableTokens, 11, 'the skipped file\'s tokens must not be counted');
});

// NOTE on why this is deps-injected rather than a real chmod 0o000 file: measured directly (see
// this action's own driver notes) -- console/usage-scan.js's scanFile does NOT throw on an
// unreadable file, per its own documented contract ("unreadable files yield an empty aggregate");
// the read error surfaces as an empty {msgs: 0} aggregate, which recoverSessionTokens correctly
// counts as `transcriptFilesRead` (a file WAS read, it just had nothing in it) -- genuinely
// indistinguishable, with the current console/usage-scan.js API, from a real empty transcript.
// The scanFileFn try/catch this test exercises is therefore a backstop against scanFile's own
// contract regressing (its own comment says so), not something a real EACCES file reaches today --
// so it is tested the way the module's own header tests every OTHER defensive branch that a real
// fixture cannot reach: a deps.scanFile that fails for exactly one path and delegates to the real
// reader for every other, so this suite still exercises real files everywhere it can.
test('recoverSessionTokens: a scanFile call that throws for one candidate increments transcriptFilesSkipped instead of losing the rest of the sum (backstop against scanFile\'s own "never throw" contract regressing)', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'f4000000-f4f4-4f4f-8f4f-f40000000004';
  const projectsDir = projectsDirFor(accountsDir, 'acct-a');
  writeProjectFile(projectsDir, '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'main1', input: 20, output: 2, sessionId }),
  ]);
  const subagentDir = path.join(projectsDir, '-home-crazz-project', sessionId, 'subagents');
  fs.mkdirSync(subagentDir, { recursive: true });
  const badFile = path.join(subagentDir, 'agent-throws.jsonl');
  fs.writeFileSync(badFile, usageLine({ id: 'sub1', input: 999, output: 999, sessionId }) + '\n');

  const realScanFile = require('../console/usage-scan').scanFile;
  const flakyScanFile = async (filePath, account) => {
    if (path.resolve(filePath) === path.resolve(badFile)) throw new Error('simulated scanFile regression');
    return realScanFile(filePath, account);
  };

  const result = await recoverSessionTokens(
    { sessionId, accountConfigDir: path.join(accountsDir, 'acct-a'), accountsDir, homeDir },
    { scanFile: flakyScanFile }
  );

  assert.notEqual(result, null);
  assert.equal(result.transcriptFilesRead, 1, 'only the main transcript was actually read');
  assert.equal(result.transcriptFilesSkipped, 1, 'the throwing subagent file must be counted as skipped');
  assert.equal(result.billableTokens, 22, 'the skipped file\'s tokens must not be counted');
});

test('recoverSessionTokens: no skip route fired -- transcriptFilesSkipped is a real 0, not merely absent', async () => {
  const accountsDir = makeAccountsDir(['acct-a']);
  const homeDir = mkTmp('spo-token-recovery-home-');
  const sessionId = 'f5000000-f5f5-4f5f-8f5f-f50000000005';
  writeProjectFile(projectsDirFor(accountsDir, 'acct-a'), '-home-crazz-project', `${sessionId}.jsonl`, [
    usageLine({ id: 'm1', input: 3, output: 1, sessionId }),
  ]);

  const result = await recoverSessionTokens({
    sessionId,
    accountConfigDir: path.join(accountsDir, 'acct-a'),
    accountsDir,
    homeDir,
  });

  assert.notEqual(result, null);
  assert.equal(result.transcriptFilesSkipped, 0);
  assert.equal(Object.is(result.transcriptFilesSkipped, 0), true);
});

// ---- misc: an invalid/absent sessionId is a clean null, never a throw --------------------------

test('recoverSessionTokens: an absent/empty sessionId returns null without touching the filesystem', async () => {
  assert.equal(await recoverSessionTokens({}), null);
  assert.equal(await recoverSessionTokens({ sessionId: '' }), null);
  assert.equal(await recoverSessionTokens({ sessionId: null }), null);
  assert.equal(await recoverSessionTokens(), null);
});
