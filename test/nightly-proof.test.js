'use strict';
// `spo nightly` / `spo nightly reprove` -- orchestrator/nightly-proof.js, doc/manual-nightly-proof.md.
//
// Three things are pinned here, in decreasing order of what a regression would cost:
//   1. REACHABILITY: nothing the daemon can load requires nightly-proof.js, and no prompt names the
//      command. The whole feature rests on "a human asks, a session cannot" -- a step that could
//      call reprove() would turn "no new card while main is red" into a suggestion.
//   2. The gate: reprove() refuses inside a Claude Code session and without a terminal, and never
//      spawns anything when it refuses. Pinned on the function AND through the real CLI.
//   3. `status` reads the gate the guards read: classifyNightly itself, not a re-derivation.

require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { mkTmp, isolatedEnv, SPO_BIN, REPO_ROOT } = require('./helpers');
const np = require('../orchestrator/nightly-proof');
const { classifyNightly } = require('../orchestrator/steps/scripted');

const TIP = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

// ---- 1. reachability --------------------------------------------------------------------------

function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('reachability: only bin/spo requires nightly-proof.js -- no orchestrator/, console/ or scripts/ module does', () => {
  const REQUIRE = /require\(\s*['"][^'"]*nightly-proof(\.js)?['"]\s*\)/;
  const corpus = [
    ...walkJs(path.join(REPO_ROOT, 'orchestrator')),
    ...walkJs(path.join(REPO_ROOT, 'console')),
    ...walkJs(path.join(REPO_ROOT, 'scripts')),
  ].filter((p) => !p.endsWith(`${path.sep}nightly-proof.js`));
  assert.ok(corpus.length > 50, `corpus suspiciously small (${corpus.length}) -- the walk found nothing to sweep`);
  const offenders = corpus.filter((p) => REQUIRE.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(offenders.map((p) => path.relative(REPO_ROOT, p)), []);
  // Positive control: the pattern does match the one sanctioned requirer, so an empty offender
  // list above means "none", not "the regex matches nothing".
  assert.match(fs.readFileSync(SPO_BIN, 'utf8'), REQUIRE);
});

test('reachability: the WebClient subcommand literal lives only in nightly-proof.js; prompts/ never names the command', () => {
  const corpus = [
    ...walkJs(path.join(REPO_ROOT, 'orchestrator')),
    ...walkJs(path.join(REPO_ROOT, 'console')),
    ...walkJs(path.join(REPO_ROOT, 'scripts')),
  ].filter((p) => !p.endsWith(`${path.sep}nightly-proof.js`));
  const literal = corpus.filter((p) => fs.readFileSync(p, 'utf8').includes(np.WEBCLIENT_SUBCOMMAND));
  assert.deepEqual(literal.map((p) => path.relative(REPO_ROOT, p)), []);

  const prompts = fs.readdirSync(path.join(REPO_ROOT, 'prompts')).map((n) => path.join(REPO_ROOT, 'prompts', n));
  assert.ok(prompts.length > 0);
  const named = prompts.filter((p) => {
    if (!fs.statSync(p).isFile()) return false;
    const text = fs.readFileSync(p, 'utf8');
    return /nightly\s+reprove/.test(text) || text.includes(np.WEBCLIENT_SUBCOMMAND) || text.includes('manual-request.json');
  });
  assert.deepEqual(named.map((p) => path.relative(REPO_ROOT, p)), []);
});

// ---- 2. the gate --------------------------------------------------------------------------------

test('humanGate: CLAUDECODE refuses even on a real terminal; a missing tty on either side refuses; otherwise ok', () => {
  assert.equal(np.humanGate({ env: { CLAUDECODE: '1' }, stdinIsTTY: true, stdoutIsTTY: true }).ok, false);
  assert.equal(np.humanGate({ env: {}, stdinIsTTY: false, stdoutIsTTY: true }).ok, false);
  assert.equal(np.humanGate({ env: {}, stdinIsTTY: true, stdoutIsTTY: false }).ok, false);
  assert.equal(np.humanGate({ env: {}, stdinIsTTY: true, stdoutIsTTY: true }).ok, true);
});

function reproveHarness(overrides = {}, spawnStatus = 0) {
  const calls = [];
  const errs = [];
  const productRepo = overrides.productRepo || '/nonexistent/SPO-WebClient';
  const code = np.reprove(
    {
      reason: 'ETIMEDOUT to the game server, not the code',
      productRepo,
      env: {},
      stdinIsTTY: true,
      stdoutIsTTY: true,
      err: (l) => errs.push(l),
      ...overrides,
    },
    {
      spawnSync: (...args) => {
        calls.push(args);
        return { status: spawnStatus };
      },
      existsSync: overrides.existsSync || (() => true),
    }
  );
  return { code, calls, errs, productRepo };
}

test('reprove: every refusal returns before anything is spawned', () => {
  let r = reproveHarness({ env: { CLAUDECODE: '1' } });
  assert.equal(r.code, np.REPROVE_EXIT.notHuman);
  assert.equal(r.calls.length, 0);

  r = reproveHarness({ stdinIsTTY: false });
  assert.equal(r.code, np.REPROVE_EXIT.notHuman);
  assert.equal(r.calls.length, 0);

  r = reproveHarness({ reason: '   ' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);

  r = reproveHarness({ existsSync: () => false });
  assert.equal(r.code, np.REPROVE_EXIT.companionMissing);
  assert.equal(r.calls.length, 0);
});

test('reprove: runs WebClient\'s request-nightly from the product repo with an inherited terminal, and passes its exit code through', () => {
  for (const status of [0, 2, 3]) {
    const r = reproveHarness({}, status);
    assert.equal(r.code, status);
    assert.equal(r.calls.length, 1);
    const [exe, argv, opts] = r.calls[0];
    assert.equal(exe, process.execPath);
    assert.deepEqual(argv, [
      path.join(r.productRepo, 'dist', 'e2e', 'bench', 'cli.js'),
      'request-nightly',
      '--via=spo',
      '--reason=ETIMEDOUT to the game server, not the code',
    ]);
    assert.equal(opts.cwd, r.productRepo);
    assert.equal(opts.stdio, 'inherit', 'the typed sha confirmation has to reach the human\'s own terminal');
  }
});

test('real CLI: `spo nightly reprove` refuses with exit 5 under CLAUDECODE, and again with it unset but no terminal', () => {
  let failure = null;
  try {
    execFileSync(process.execPath, [SPO_BIN, 'nightly', 'reprove', '--reason', 'x'], {
      encoding: 'utf8',
      env: { ...isolatedEnv(), CLAUDECODE: '1' },
      stdio: 'pipe',
    });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'must not exit 0');
  assert.equal(failure.status, np.REPROVE_EXIT.notHuman);

  failure = null;
  try {
    // CLAUDECODE emptied (the gate tests truthiness): only the missing terminal refuses this one.
    execFileSync(process.execPath, [SPO_BIN, 'nightly', 'reprove', '--reason', 'x'], {
      encoding: 'utf8',
      env: { ...isolatedEnv(), CLAUDECODE: '' },
      stdio: 'pipe',
    });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'must not exit 0');
  assert.equal(failure.status, np.REPROVE_EXIT.notHuman);
});

// ---- 3. status ----------------------------------------------------------------------------------

test('formatNightlyStatus: a red record names the trigger, the parks, and the reprove hint', () => {
  const latest = { verdict: 'FAIL', sha: TIP, finishedAt: '2026-09-13T04:00:47Z', detail: 'live drive exited 1 (FAIL)' };
  const lines = np.formatNightlyStatus({
    latest,
    manualRequest: null,
    manualRecords: [],
    tip: { sha: TIP, source: 'ls-remote' },
    classification: classifyNightly(latest, TIP),
    parks: [{ id: 'issue-1', title: 't' }],
  });
  assert.match(lines[0], /^MAIN: RED/);
  assert.ok(lines.some((l) => /trigger\s+scheduled \(no trigger field\)/.test(l)));
  assert.ok(lines.some((l) => /1 card\(s\) on nightly-main-red \/ nightly-red-holding-intake/.test(l)));
  assert.ok(lines.some((l) => /spo nightly reprove/.test(l)));
});

test('formatNightlyStatus: a manual PASS reads green through classifyNightly, shows who asked and what it superseded; no hint', () => {
  const latest = {
    verdict: 'PASS',
    sha: TIP,
    trigger: 'manual',
    requestedBy: { user: 'crazz', reason: 'game server blip' },
    supersedes: { verdict: 'FAIL', sha: TIP, trigger: 'scheduled', finishedAt: '2026-09-13T04:00:47Z' },
  };
  const lines = np.formatNightlyStatus({
    latest,
    manualRequest: null,
    manualRecords: [],
    tip: { sha: TIP, source: 'ls-remote' },
    classification: classifyNightly(latest, TIP),
    parks: [],
  });
  assert.match(lines[0], /^MAIN: GREEN/);
  assert.ok(lines.some((l) => /manual, requested by crazz -- "game server blip"/.test(l)));
  assert.ok(lines.some((l) => /supersedes\s+FAIL at aaaaaaaa \(scheduled/.test(l)));
  assert.ok(!lines.some((l) => /spo nightly reprove/.test(l)));
});

test('readNightlyState + listNightlyRedParks read the on-disk shapes; only open nightly-red parks are listed -- BOTH reasons (card #226), never one of the two', () => {
  const bench = mkTmp('spo-nightly-proof-bench-');
  writeJson(path.join(bench, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: OLD });
  writeJson(path.join(bench, 'nightly', 'manual-request.json'), { sha: TIP, requestedBy: { user: 'u' } });
  writeJson(path.join(bench, 'nightly', 'manual', 'job-2.json'), { requestedSha: TIP, verdict: 'ENVIRONMENT', attested: false });
  fs.writeFileSync(path.join(bench, 'nightly', 'manual', 'junk.json'), '{not json');
  const state = np.readNightlyState(bench);
  assert.equal(state.latest.sha, OLD);
  assert.equal(state.manualRequest.sha, TIP);
  assert.equal(state.manualRecords.length, 1, 'an unreadable record is skipped, not fatal');

  const journal = mkTmp('spo-nightly-proof-journal-');
  writeJson(path.join(journal, 'issue-1', 'state.json'), { state: 'PARKED', reason: 'nightly-main-red', title: 'one' });
  writeJson(path.join(journal, 'issue-2', 'state.json'), { state: 'PARKED', reason: 'gate-timeout' });
  writeJson(path.join(journal, 'issue-3', 'state.json'), { state: 'DONE', reason: 'nightly-main-red' });
  writeJson(path.join(journal, 'issue-4', 'state.json'), {
    state: 'PARKED',
    reason: 'nightly-main-red',
    externallyResolved: { via: 'closed' },
  });
  // Card #226: the INTAKE pre-gate's own reason. It is TRANSIENT, so a card only reaches PARKED
  // under it once finalizePark's retry budget is spent -- at which point it is exactly as stuck as
  // issue-1 and belongs on the same screen. Pinned here because a filter that knew only
  // 'nightly-main-red' would drop it silently, with nothing going red.
  writeJson(path.join(journal, 'issue-5', 'state.json'), {
    state: 'PARKED',
    reason: 'nightly-red-holding-intake',
    title: 'five',
  });
  // ... and the same two exclusions apply to the new reason as to the old one: not-PARKED, and
  // PARKED-but-externally-resolved, are both still out.
  writeJson(path.join(journal, 'issue-6', 'state.json'), { state: 'DONE', reason: 'nightly-red-holding-intake' });
  writeJson(path.join(journal, 'issue-7', 'state.json'), {
    state: 'PARKED',
    reason: 'nightly-red-holding-intake',
    externallyResolved: { via: 'closed' },
  });
  assert.deepEqual(np.listNightlyRedParks(journal), [
    { id: 'issue-1', title: 'one' },
    { id: 'issue-5', title: 'five' },
  ]);
});

test('resolveOriginMainTip: ls-remote first; the local ref is a LABELLED fallback; nothing resolvable is null', () => {
  const lsRemote = (cmd, args) => {
    if (args.includes('ls-remote')) return `${TIP}\trefs/heads/main\n`;
    throw new Error('unexpected');
  };
  assert.deepEqual(np.resolveOriginMainTip('/r', lsRemote), { sha: TIP, source: 'ls-remote' });

  const localOnly = (cmd, args) => {
    if (args.includes('ls-remote')) throw new Error('network');
    return `${OLD}\n`;
  };
  const fallback = np.resolveOriginMainTip('/r', localOnly);
  assert.equal(fallback.sha, OLD);
  assert.match(fallback.source, /stale/);

  assert.deepEqual(np.resolveOriginMainTip('/r', () => { throw new Error('no git'); }), { sha: null, source: 'unresolved' });
});

test('real CLI: `spo nightly` with no resolvable origin/main exits 2 (unknown), never 0', () => {
  const bench = mkTmp('spo-nightly-proof-cli-bench-');
  writeJson(path.join(bench, 'nightly', 'latest.json'), { verdict: 'PASS', sha: TIP });
  const journal = mkTmp('spo-nightly-proof-cli-journal-');
  const queue = mkTmp('spo-nightly-proof-cli-queue-');
  let failure = null;
  try {
    execFileSync(process.execPath, [SPO_BIN, 'nightly', '--journal', journal, '--queue', queue, '--bench-dir', bench], {
      encoding: 'utf8',
      env: isolatedEnv(),
      stdio: 'pipe',
    });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'a PASS nobody can compare to origin/main must not exit 0');
  assert.equal(failure.status, np.STATUS_EXIT.unknown);
  assert.match(failure.stdout, /^MAIN: UNKNOWN -- could not resolve origin\/main/);
});
