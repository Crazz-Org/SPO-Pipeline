'use strict';
// What scripts/gate.sh runs, pinned.
//
// The gate excludes three test files because they assert agreement with the SIBLING repos --
// SPO-WebClient (the product repo this pipeline drives) and SPO-Deploy -- rather than testing this
// repo's own code. That exclusion is the one place this gate could rot into uselessness: widen it
// by a file and the gate silently stops checking something, with a green tick either way. So it is
// pinned here by name, in both directions, the same ratchet idiom
// test/doc-constant-sweep.test.js's own PINS/EXPECTED_CITATIONS and
// test/park-reason-doc-sweep.test.js's EVENT_ALLOWLIST already use.
//
// This file is itself inside the gate, and reads only local files -- it must never need a sibling
// repo to run, or it could not guard the very property it exists to guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const GATE_SH = path.join(REPO_ROOT, 'scripts', 'gate.sh');

// Measured 2026-09-04, with neither ~/SPO-WebClient nor ~/SPO-Deploy on disk: these three files
// produce 10 failures between them (7 / 2 / 1), and every other test file passes -- 1729 of 1729.
// Each entry names WHAT it asserts about the sibling, so a future reader can re-measure the claim
// rather than trust this list.
const EXPECTED_CROSS_REPO = {
  'doc-constant-sweep.test.js':
    "resolves this repo's citations and pinned constants against the real SPO-WebClient / SPO-Deploy trees",
  'gate-stderr-literal-sweep.test.js':
    "realGate's stderr/stdout literals must still exist in SPO-WebClient's own source",
  'heartbeat-contract-pin.test.js':
    "HEARTBEAT_STALE_MS is pinned to SPO-WebClient/src/e2e/bench/paths.ts's literal",
};

// A test file may MENTION the sibling-repo env vars and still be gate-safe, because it tolerates
// their absence rather than asserting against them. That is not a hole to be closed -- it is a
// genuinely different thing -- but it must be a NAMED decision, so a new file that starts reaching
// for a sibling cannot join this set by accident.
const MENTIONS_BUT_TOLERATES_ABSENCE = {
  'orphan-scan.test.js':
    'reads config.productRepo only to build a worktree path; never resolves anything inside it (measured: passes with the repo absent)',
  'gate-scope.test.js':
    'this file IS the scanner -- it names the two env vars as the pattern it greps for, and never resolves either repo',
};

function readGateSh() {
  return fs.readFileSync(GATE_SH, 'utf8');
}

// Parses gate.sh's CROSS_REPO_FILES=( ... ) array -- the ONE place the exclusion is written.
function parseCrossRepoFiles(src) {
  const m = src.match(/CROSS_REPO_FILES=\(([^)]*)\)/);
  if (!m) return null;
  return m[1]
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

test('gate.sh exists, is executable, and its exclusion list parses', () => {
  const st = fs.statSync(GATE_SH);
  assert.ok(st.mode & 0o111, 'scripts/gate.sh must be executable -- CI and the pre-push hook both exec it directly');
  const parsed = parseCrossRepoFiles(readGateSh());
  assert.ok(parsed, 'CROSS_REPO_FILES=( ... ) no longer parses out of scripts/gate.sh -- this guard has gone blind, fix the parser or the script');
});

test('the gate excludes EXACTLY the three sibling-repo files -- no more (a silent hole), no fewer (a permanently red gate)', () => {
  const parsed = parseCrossRepoFiles(readGateSh());
  assert.deepEqual(
    parsed.slice().sort(),
    Object.keys(EXPECTED_CROSS_REPO).sort(),
    'scripts/gate.sh\'s CROSS_REPO_FILES changed. Widening it stops the gate checking something while still reporting green; ' +
      'narrowing it makes the gate red for a sibling repo\'s state rather than this repo\'s. Either way: re-measure with the ' +
      'siblings absent, then update EXPECTED_CROSS_REPO here by name, with the reason.'
  );
});

test('every excluded file actually exists -- a stale name would exclude nothing and read as if it did', () => {
  for (const base of Object.keys(EXPECTED_CROSS_REPO)) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, 'test', base)),
      `${base} is on the gate's exclusion list but no such test file exists -- rename or remove it in the same change`
    );
  }
});

test('no OTHER test file reaches for a sibling repo without being classified', () => {
  // The ratchet that makes this guard survive new tests: any file naming the sibling-repo env vars
  // must be either excluded from the gate or explicitly recorded as tolerating their absence.
  // A new cross-repo test that is neither fails here -- loudly, at authoring time -- instead of
  // quietly turning the gate red for everyone later.
  const offenders = [];
  for (const base of fs.readdirSync(path.join(REPO_ROOT, 'test')).filter((f) => f.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'test', base), 'utf8');
    if (!/SPO_PRODUCT_REPO|SPO_DEPLOY_REPO/.test(src)) continue;
    if (Object.prototype.hasOwnProperty.call(EXPECTED_CROSS_REPO, base)) continue;
    if (Object.prototype.hasOwnProperty.call(MENTIONS_BUT_TOLERATES_ABSENCE, base)) continue;
    offenders.push(base);
  }
  assert.deepEqual(
    offenders,
    [],
    'test file(s) name a sibling repo but are neither excluded from the gate nor recorded as tolerating its absence. ' +
      'Run them with SPO_PRODUCT_REPO/SPO_DEPLOY_REPO pointed at a nonexistent path: if they fail, add them to ' +
      `EXPECTED_CROSS_REPO (and scripts/gate.sh); if they pass, add them to MENTIONS_BUT_TOLERATES_ABSENCE with that measurement:\n  ${offenders.join('\n  ')}`
  );
});

test('MENTIONS_BUT_TOLERATES_ABSENCE holds exactly what was measured -- it cannot only grow', () => {
  // Same ratchet-down posture as doc-constant-sweep.test.js's own allowlist pins: an entry that is
  // no longer needed (the file stopped naming a sibling, or was deleted) must be removed, or this
  // list becomes a place where exemptions accumulate unread.
  for (const base of Object.keys(MENTIONS_BUT_TOLERATES_ABSENCE)) {
    const p = path.join(REPO_ROOT, 'test', base);
    assert.ok(fs.existsSync(p), `${base} is on MENTIONS_BUT_TOLERATES_ABSENCE but no longer exists -- drop the entry`);
    assert.match(
      fs.readFileSync(p, 'utf8'),
      /SPO_PRODUCT_REPO|SPO_DEPLOY_REPO/,
      `${base} no longer names a sibling repo -- it needs no exemption, drop the entry`
    );
  }
});

test('the gate runs every test file that is not excluded -- a new test file is covered by default', () => {
  // The gate builds its list from the `test/*.test.js` glob MINUS the exclusion, so a file added
  // tomorrow is gated without anyone remembering to register it. This pins that direction: if
  // gate.sh ever switched to an opt-IN allowlist, new tests would silently go ungated.
  const { execFileSync } = require('child_process');
  const listed = execFileSync(GATE_SH, ['--list'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => path.basename(l.trim()))
    .sort();
  const expected = fs
    .readdirSync(path.join(REPO_ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !Object.prototype.hasOwnProperty.call(EXPECTED_CROSS_REPO, f))
    .sort();
  assert.deepEqual(listed, expected, 'gate.sh --list is not "every test file minus the exclusion" -- has it become an opt-in allowlist?');
  assert.ok(listed.includes('gate-scope.test.js'), 'this guard must itself be inside the gate, or it never runs where it matters');
});

test('the CI workflow runs the gate through scripts/gate.sh, never its own copy of the command', () => {
  // Two ways to run the suite is two things to keep in sync, and the one that drifts is always the
  // one nobody reads. CI must exec the same script the pre-push hook and a human do.
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'gate.yml'), 'utf8');
  // YAML comment lines are stripped first: the workflow's own header explains the rule and quotes
  // `node --test` while doing so. The property being guarded is "the workflow does not define its
  // own command", and prose describing that property is not a command. Scanning the raw file
  // instead made this guard fire on its own documentation -- a check that cannot tell a rule from
  // a violation of it fails at exactly the moment someone writes the rule down.
  const body = wf
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.match(body, /run:\s*scripts\/gate\.sh/, '.github/workflows/gate.yml must run scripts/gate.sh as its gate step');
  assert.doesNotMatch(
    body,
    /node\s+--test/,
    'the workflow spells out its own `node --test` invocation -- that is a second, drifting definition of the gate; call scripts/gate.sh'
  );
});

// ---- how the gate REACHES a machine: the pre-push hook, and the scripts that install it --------
//
// The CI half of the gate is pinned above. This is the local half, and it is pinned for a reason
// that has already bitten: on 2026-09-04 the gate commit shipped scripts/git-hooks/pre-push and
// wired it into BOTH install scripts, and yet `.git/hooks/` on the maintainer's box still held
// only `post-merge` -- because the installers had not been re-run since. The hook's absence is
// invisible: pushes simply keep working, ungated, exactly as they did before it existed.
//
// So the wiring is a ratchet now. Nothing here installs anything or touches `.git/hooks` (a test
// that arms a real push hook on the machine running it would be a hostile test); these read the
// two install scripts and the hook, and assert the wiring they claim to perform is still spelled
// out. Removing an `ln -sf` line from either installer is a silent, green regression otherwise --
// the same class the exclusion ratchet at the top of this file guards.
const HOOKS = ['post-merge', 'pre-push'];
const INSTALLERS = ['daemon-install.sh', 'dashboard-install.sh'];

test('both install scripts wire BOTH git hooks -- either script arms a box completely', () => {
  for (const installer of INSTALLERS) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', installer), 'utf8');
    const body = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    for (const hook of HOOKS) {
      // The link must go FROM the tracked hook TO .git/hooks, so the installed hook tracks the
      // repo instead of being a copy that silently ages.
      const wiring = new RegExp(`ln\\s+-sf\\s+"?\\$\\{?REPO\\}?/scripts/git-hooks/${hook}"?\\s+"?\\$\\{?REPO\\}?/\\.git/hooks/${hook}"?`);
      assert.match(
        body,
        wiring,
        `scripts/${installer} no longer symlinks scripts/git-hooks/${hook} into .git/hooks -- a box installed by it would run ungated`
      );
    }
  }
});

test('every hook the installers wire actually exists and is executable -- a dangling symlink is a silently skipped hook', () => {
  // git does not warn when a hook path does not resolve; it just runs nothing. A name that drifts
  // from the file beside it therefore disarms the hook with no signal at all.
  for (const hook of HOOKS) {
    const p = path.join(REPO_ROOT, 'scripts', 'git-hooks', hook);
    assert.ok(fs.existsSync(p), `scripts/git-hooks/${hook} is wired by the install scripts but does not exist`);
    assert.ok(fs.statSync(p).mode & 0o111, `scripts/git-hooks/${hook} must be executable -- git runs it directly`);
  }
});

test('the pre-push hook runs the gate through scripts/gate.sh, never its own copy of the command', () => {
  // Same one-definition rule the CI workflow is held to directly above: a push that passes locally
  // and a PR that passes in CI must not be able to disagree about what "green" means.
  const hook = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'git-hooks', 'pre-push'), 'utf8');
  const body = hook
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.match(body, /\$\{?REPO\}?"?\/scripts\/gate\.sh/, 'scripts/git-hooks/pre-push must exec scripts/gate.sh');
  assert.doesNotMatch(
    body,
    /node\s+--test/,
    'the pre-push hook spells out its own `node --test` invocation -- that is a second, drifting definition of the gate; call scripts/gate.sh'
  );
});
