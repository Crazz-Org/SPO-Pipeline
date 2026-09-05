'use strict';
// A standing guard over the class of bug gate C7's own re-read (three passes, ~7 then ~11 then
// ~52 divergences) never had a chance against: a doc STATES A NUMBER, the code OWNS it, and they
// drift apart silently. Reading is sampling -- a human re-reader can miss a changed digit forever.
// Modelled directly on test/gh-api-argv.test.js and test/no-real-spawn-sweep.test.js: read SOURCE
// TEXT (both the code file and the doc file), never `require()` the module and compare it to
// itself. Recomputing the expectation from the constant under test pins nothing -- this project
// shipped exactly that mistake twice (a safety constant cut from 22 to 3 passed 1303 tests because
// every one of them re-derived its expectation from the same live value it was supposed to check).
// Every `contains` string below is therefore a LITERAL, typed independently of the code it checks,
// with a comment naming where the number came from -- the two real incidents that motivated this
// file: the spec said `accountLeaseWaitMs` defaults to 5 minutes when the code said 31.5 (and
// restated the code's own REJECTED rationale as the justification), and orchestrator/README.md
// cited a `SMALL_BUDGET_USD` constant that was never a real export.
//
// Two docs only, matching the plan's action 7bis.3 scope. doc/remediation-plan-2026-08.md is
// excluded by name from BOTH halves of this file: it declares its own numbers historical, and a
// sweep that flagged it would be re-litigating decisions this file has no authority to reopen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const abs = (rel) => path.join(REPO_ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');

// ---- part 1: pinned constants -------------------------------------------------------------
//
// One row per documented-constant claim. `checks` mixes code-file and doc-file literals
// deliberately -- the row passes only when EVERY literal is found in ITS named file, so a
// mismatch on either side (code changed, or doc changed) fails independently of the other. Each
// `contains` string was copied from a real read of the file on 2026-09-02, not derived from
// re-running the code -- see this file's header.
const PINS = [
  {
    name: 'command timeout: git (120000ms / 120s)', // action 2.1, orchestrator/config.js
    checks: [
      { file: 'orchestrator/config.js', contains: "git: timeoutFromEnv('SPO_TIMEOUT_GIT_MS', 120000)," },
      { file: 'doc/state-machine-spec.md', contains: '| `git` | 120s |' },
      { file: 'orchestrator/README.md', contains: '| `git` | 120000 | `SPO_TIMEOUT_GIT_MS` |' },
    ],
  },
  {
    name: 'command timeout: gh (120000ms / 120s)',
    checks: [
      { file: 'orchestrator/config.js', contains: "gh: timeoutFromEnv('SPO_TIMEOUT_GH_MS', 120000)," },
      { file: 'doc/state-machine-spec.md', contains: '| `gh` | 120s |' },
      { file: 'orchestrator/README.md', contains: '| `gh` | 120000 | `SPO_TIMEOUT_GH_MS` |' },
    ],
  },
  {
    name: 'command timeout: npm-ci (600000ms / 10min)',
    checks: [
      { file: 'orchestrator/config.js', contains: "'npm-ci': timeoutFromEnv('SPO_TIMEOUT_NPM_CI_MS', 600000)," },
      { file: 'doc/state-machine-spec.md', contains: '| `npm-ci` | 600s (10 min) |' },
      { file: 'orchestrator/README.md', contains: '| `npm-ci` | 600000 | `SPO_TIMEOUT_NPM_CI_MS` |' },
    ],
  },
  {
    // 7800000ms is derived from the bench's own DEFAULT_WAIT_TIMEOUT_MIN=120 (7200s) plus margin
    // -- that derivation lives in a sibling repo (SPO-WebClient's bench), out of this sweep's
    // reach; only this repo's own literal (7800000 / 7800s) is pinned here.
    name: 'command timeout: npm-gate (7800000ms / 130min)',
    checks: [
      { file: 'orchestrator/config.js', contains: "'npm-gate': timeoutFromEnv('SPO_TIMEOUT_NPM_GATE_MS', 7800000)," },
      { file: 'doc/state-machine-spec.md', contains: '| `npm-gate` | 7800s (130 min), never retried |' },
      { file: 'orchestrator/README.md', contains: '| `npm-gate` | 7800000 | `SPO_TIMEOUT_NPM_GATE_MS` |' },
    ],
  },
  {
    name: 'command timeout: npm-run (660000ms / 11min)',
    checks: [
      { file: 'orchestrator/config.js', contains: "'npm-run': timeoutFromEnv('SPO_TIMEOUT_NPM_RUN_MS', 660000)," },
      { file: 'doc/state-machine-spec.md', contains: '| `npm-run` | 660s (11 min) |' },
      { file: 'orchestrator/README.md', contains: '660000 | `SPO_TIMEOUT_NPM_RUN_MS` |' },
    ],
  },
  {
    name: 'command timeout: bench-install (900000ms / 15min)', // action B1.4, orchestrator/config.js
    checks: [
      { file: 'orchestrator/config.js', contains: "'bench-install': timeoutFromEnv('SPO_TIMEOUT_BENCH_INSTALL_MS', 900000)," },
      { file: 'doc/state-machine-spec.md', contains: '| `bench-install` | 900s (15 min) |' },
      { file: 'orchestrator/README.md', contains: '| `bench-install`' },
    ],
  },
  {
    // R1/R3 (post-verification, third pass): benchIdleWaitMaxPolls/benchIdleWaitPollIntervalMs
    // are the direct model of ciChecksMaxPolls/ciChecksPollIntervalMs below, which ARE already
    // pinned here -- these two were not, and mutations V18/W10 (adversarial verification round 2)
    // proved the consequence empirically: either default can change while 1580+ tests stay green
    // and the spec keeps citing "180 x 5s = 15 minutes".
    name: 'benchIdleWaitMaxPolls default (180) and benchIdleWaitPollIntervalMs default (5000ms)',
    checks: [
      { file: 'orchestrator/config.js', contains: 'process.env.SPO_BENCH_IDLE_WAIT_MAX_POLLS !== undefined ? Number(process.env.SPO_BENCH_IDLE_WAIT_MAX_POLLS) : 180;' },
      { file: 'orchestrator/config.js', contains: '? Number(process.env.SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS)' },
      { file: 'orchestrator/config.js', contains: ': 5000;' },
      { file: 'doc/state-machine-spec.md', contains: 'default 180 × 5s = 15 minutes' },
    ],
  },
  {
    name: 'account cooldown: usage probe (1 hour)', // action 3.5, orchestrator/accounts.js
    checks: [
      { file: 'orchestrator/accounts.js', contains: 'const USAGE_PROBE_COOLDOWN_MS = 60 * 60 * 1000;' },
      { file: 'orchestrator/README.md', contains: '1 hour** (`accounts.USAGE_PROBE_COOLDOWN_MS`)' },
      { file: 'doc/state-machine-spec.md', contains: '**1-hour probe**' },
    ],
  },
  {
    name: 'account cooldown: escalation window (2 hours)',
    checks: [
      { file: 'orchestrator/accounts.js', contains: 'const ESCALATION_WINDOW_MS = 2 * 60 * 60 * 1000;' },
      { file: 'orchestrator/README.md', contains: '`accounts.ESCALATION_WINDOW_MS` (2 hours)' },
      { file: 'doc/state-machine-spec.md', contains: '**2-hour escalation window**' },
    ],
  },
  {
    name: 'account cooldown: usage escalated (5 hours)',
    checks: [
      { file: 'orchestrator/accounts.js', contains: 'const USAGE_ESCALATED_COOLDOWN_MS = 5 * 60 * 60 * 1000;' },
      { file: 'orchestrator/README.md', contains: '5 hours** (`accounts.USAGE_ESCALATED_COOLDOWN_MS`)' },
      { file: 'doc/state-machine-spec.md', contains: '**5-hour** Claude Max session window' },
    ],
  },
  {
    name: 'account cooldown: overloaded (5 minutes, flat, never escalates)',
    checks: [
      { file: 'orchestrator/accounts.js', contains: 'const OVERLOADED_COOLDOWN_MS = 5 * 60 * 1000;' },
      { file: 'orchestrator/README.md', contains: "'overloaded'` → 5 minutes** (`accounts.OVERLOADED_COOLDOWN_MS`)" },
      { file: 'doc/state-machine-spec.md', contains: 'stays a flat **5 minutes** and never escalates' },
    ],
  },
  {
    name: 'autoPullLimit default (1) and the in-flight+queued<=K watermark', // action 6.6
    checks: [
      { file: 'orchestrator/config.js', contains: "autoPullLimit: nonNegativeIntFromEnv('SPO_AUTO_PULL_LIMIT', 1)," },
      { file: 'orchestrator/auto-pull.js', contains: 'const DEFAULT_AUTO_PULL_LIMIT = 1;' },
      { file: 'orchestrator/auto-pull.js', contains: 'const headroom = K - queued - inFlight;' },
      { file: 'orchestrator/auto-pull.js', contains: 'limit: Math.max(0, Math.min(perCycleCap, headroom)),' },
      { file: 'orchestrator/README.md', contains: '`config.autoPullLimit` (default 1) claimable candidates.' },
      { file: 'orchestrator/README.md', contains: 'to `min(autoPullLimit, K - queued - inFlight)`, never negative.' },
    ],
  },
  {
    name: 'mainMovedRegateBudget default (1)', // action 6.5
    checks: [
      { file: 'orchestrator/config.js', contains: 'mainMovedRegateBudget: 1,' },
      { file: 'doc/state-machine-spec.md', contains: 'times per task (default **1**' },
    ],
  },
  {
    // The historical bug this row guards: the spec once said 5 minutes here, restating a
    // REJECTED rationale (an observed max step duration) instead of the ceiling the code
    // actually derives the wait from -- see config.js's own accountLeaseWaitMs comment.
    name: 'accountLeaseWaitMs derives from MAX_LEASE_AGE_MS (63 min), not a flat 5 min', // action 6.2
    checks: [
      {
        file: 'orchestrator/step-contracts.js',
        // MAX_LLM_STEP_DEADLINE_MS, not LLM_STEP_DEADLINE_MS: PLAN carries a longer deadline since
        // 2026-09-04, and the lease bound must follow the LONGEST legitimate hold, not the default.
        contains: 'const MAX_LEASE_AGE_MS = 2 * MAX_LLM_STEP_DEADLINE_MS + Math.round(MAX_LLM_STEP_DEADLINE_MS / 10);',
      },
      {
        file: 'orchestrator/config.js',
        contains: "accountLeaseWaitMs: positiveMsFromEnv('SPO_ACCOUNT_LEASE_WAIT_MS', MAX_LEASE_AGE_MS),",
      },
      { file: 'doc/state-machine-spec.md', contains: '**63 min** — `MAX_LEASE_AGE_MS`' },
      { file: 'orchestrator/README.md', contains: '`MAX_LEASE_AGE_MS` (`step-contracts.js`, **63 minutes**: 2 ×' },
    ],
  },
  {
    name: 'LLM_STEP_DEADLINE_MS (900000ms / 15min) -- the default, four of the five LLM steps', // action 1.x / 2.1
    checks: [
      { file: 'orchestrator/step-contracts.js', contains: 'const LLM_STEP_DEADLINE_MS = 900000;' },
      { file: 'doc/state-machine-spec.md', contains: '| 900000ms / 15min |' },
    ],
  },
  {
    // PLAN is the one step off the default (2026-09-04). Card #486 (size:L, the only card ever to
    // reach PLAN's `L -> high` row) failed three times, twice on deadline kills at ~825s of measured
    // wall clock, and terminal-parked llm-transport-failed:PLAN -- the pipeline could not plan an
    // L card at all. This row exists so the raise cannot drift from the spec table that states it.
    name: 'LLM_STEP_DEADLINE_MS_BY_STEP: PLAN gets 1800000ms / 30min',
    checks: [
      { file: 'orchestrator/step-contracts.js', contains: 'PLAN: 1800000, // 30 min' },
      { file: 'doc/state-machine-spec.md', contains: '| 1800000ms / 30min |' },
    ],
  },
  {
    name: "stepDeadlineMs (120000ms) -- the daemon's scripted-step wall clock, distinct from LLM_STEP_DEADLINE_MS",
    checks: [
      { file: 'orchestrator/config.js', contains: 'const STEP_DEADLINE_MS = 120000;' },
      { file: 'doc/state-machine-spec.md', contains: '`stepDeadlineMs` (120000ms;' },
    ],
  },
  {
    name: 'ciChecksMaxPolls default (30)', // action 1.7
    checks: [
      { file: 'orchestrator/config.js', contains: 'Number(process.env.SPO_CI_CHECKS_MAX_POLLS) : 30;' },
      { file: 'doc/state-machine-spec.md', contains: 'up to `ciChecksMaxPolls` times (default 30)' },
    ],
  },
  {
    name: 'ciChecksPollIntervalMs default (20000ms)',
    checks: [
      { file: 'orchestrator/config.js', contains: '? Number(process.env.SPO_CI_CHECKS_POLL_INTERVAL_MS)' },
      { file: 'orchestrator/config.js', contains: ': 20000;' },
      { file: 'doc/state-machine-spec.md', contains: 'default 20000ms' },
    ],
  },
  {
    // Regression guard for the exact incident named in this file's header: no production path
    // sets a $ cap, and no `SMALL_BUDGET_USD` constant exists to cite. action 3.7.
    name: 'maxBudgetUsd is undefined in the step-contracts table; no SMALL_BUDGET_USD constant exists',
    checks: [
      { file: 'orchestrator/step-contracts.js', contains: 'maxBudgetUsd: undefined,' },
      { file: 'orchestrator/README.md', contains: 'no daemon or intake path sets it' },
    ],
  },
];

test('every pinned documented constant matches a literal in both the code and the doc that states it', () => {
  const offenders = [];
  for (const pin of PINS) {
    for (const { file, contains } of pin.checks) {
      const source = read(file);
      if (!source.includes(contains)) {
        offenders.push(`${pin.name} -- ${file} no longer contains:\n      ${contains}`);
      }
    }
  }

  // Guards against the sweep quietly losing rows (a bad edit truncates PINS) the same way
  // gh-api-argv.test.js's siteCount and no-real-spawn-sweep.test.js's checked both guard against
  // the scanner itself going blind -- a shrunk-to-1 PINS array would stay green forever and mean
  // nothing. 12 is comfortably below the 17 rows this file ships with, so ordinary future growth
  // never trips it, but a large accidental deletion does.
  assert.ok(PINS.length >= 12, `expected at least a dozen pinned constants, found ${PINS.length}`);

  // FINDING 5 (adversarial review, 2026-09-02): the length floor above is a COUNT, and a count
  // cannot say WHICH pin died -- mutation D5 deleted 5 of the 17 rows (29%) and the >=12 floor
  // stayed green, because 12 dropped 5 still clears it. Pinned here to the exact set of names
  // PINS ships with today: deleting a row (or renaming one without updating this list) now fails
  // by naming exactly which pinned constant is missing, not just reporting a smaller number.
  assert.deepEqual(
    PINS.map((p) => p.name).sort(),
    [
      'LLM_STEP_DEADLINE_MS (900000ms / 15min) -- the default, four of the five LLM steps',
      'LLM_STEP_DEADLINE_MS_BY_STEP: PLAN gets 1800000ms / 30min',
      'account cooldown: escalation window (2 hours)',
      'account cooldown: overloaded (5 minutes, flat, never escalates)',
      'account cooldown: usage escalated (5 hours)',
      'account cooldown: usage probe (1 hour)',
      'accountLeaseWaitMs derives from MAX_LEASE_AGE_MS (63 min), not a flat 5 min',
      'autoPullLimit default (1) and the in-flight+queued<=K watermark',
      'benchIdleWaitMaxPolls default (180) and benchIdleWaitPollIntervalMs default (5000ms)',
      'ciChecksMaxPolls default (30)',
      'ciChecksPollIntervalMs default (20000ms)',
      'command timeout: bench-install (900000ms / 15min)',
      'command timeout: gh (120000ms / 120s)',
      'command timeout: git (120000ms / 120s)',
      'command timeout: npm-ci (600000ms / 10min)',
      'command timeout: npm-gate (7800000ms / 130min)',
      'command timeout: npm-run (660000ms / 11min)',
      'mainMovedRegateBudget default (1)',
      'maxBudgetUsd is undefined in the step-contracts table; no SMALL_BUDGET_USD constant exists',
      "stepDeadlineMs (120000ms) -- the daemon's scripted-step wall clock, distinct from LLM_STEP_DEADLINE_MS",
    ],
    'PINS lost or gained a row -- this pin must be updated in the SAME change as any deliberate ' +
      'addition/removal, naming which pinned constant changed, not just letting the count drift.'
  );

  assert.deepEqual(
    offenders,
    [],
    `A documented constant no longer matches its code (or vice versa) -- this is exactly the ` +
      `failure class gate C7's Opus re-read could not close by reading harder:\n  ${offenders.join('\n  ')}`
  );
});

// ---- part 1.5: table-aware constant check (E8, action 9.2) -------------------------------------
//
// doc/comment-corpus-audit-2026-09-03.md's E8 finding: `const-scan.js` "prints 74 rows for a
// human to eyeball; nothing in the sweep compared a doc number to a resolved config value
// programmatically," and it excludes doc/state-machine-spec.md BY FILENAME -- 15 of the 17 PINS
// above have their doc side in that file, so the exclusion was not a small gap. The audit's own
// verification planted `120000 -> 90000` in orchestrator/README.md's command-timeout table AND
// in the spec's mirror row: the README plant was invisible because a bare table cell (`| 90000
// |`) carries no unit word for a regex anchored on "ms"/"minutes" to match; the spec plant was
// invisible because the file was excluded outright. Both gaps are closed here: this check reads
// table CELLS by pipe-delimited position (no unit-word anchor needed) and scans
// doc/state-machine-spec.md explicitly (the whole point of this item -- see the class comment
// above on why this file is otherwise left alone by this action).
//
// This does NOT replace the 17 PINS above -- the audit's own explicit conclusion was that
// retiring them "would silently delete real coverage." It is table-driven, DERIVED from
// config.js's own COMMAND_TIMEOUTS_MS object (a command class added there is picked up
// automatically, the same posture resolveTimedOutClassReasons takes in
// test/park-reason-doc-sweep.test.js), covering exactly the one class of constant (the five
// per-command timeouts) that happens to live in a markdown TABLE in both docs -- narrower in
// scope than PINS, broader in one specific way PINS cannot be without becoming table-driven
// itself.
function extractCommandTimeoutsFromConfig(source) {
  const blockMatch = /COMMAND_TIMEOUTS_MS\s*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (!blockMatch) return null;
  const out = {};
  const entryRe = /(?:'([^']+)'|([A-Za-z_$][\w$-]*))\s*:\s*timeoutFromEnv\('([^']+)',\s*(\d+)\)/g;
  let m;
  while ((m = entryRe.exec(blockMatch[1]))) {
    out[m[1] || m[2]] = { envVar: m[3], ms: Number(m[4]) };
  }
  return out;
}

// Reads the "Class | Default | override" table by CELL POSITION, not by scanning for a unit
// word near a number -- a bare `| 90000 |` cell is read the same as `| 120000 |`.
function extractCommandTimeoutsFromReadmeTable(source) {
  const out = {};
  const lineRe = /^\|\s*`([A-Za-z0-9_-]+)`[^|]*\|\s*([0-9]+)\s*\|\s*`(SPO_TIMEOUT_[A-Z_]+)`\s*\|/gm;
  let m;
  while ((m = lineRe.exec(source))) out[m[1]] = { ms: Number(m[2]), envVar: m[3] };
  return out;
}

// Reads doc/state-machine-spec.md's own mirror table -- values in SECONDS, converted to ms for
// comparison. Same cell-position posture: `| \`git\` | 90s |` is read as 90, no unit-word regex.
function extractCommandTimeoutsFromSpecTable(source) {
  const out = {};
  const lineRe = /^\|\s*`([A-Za-z0-9_-]+)`\s*\|\s*([0-9]+)s\b/gm;
  let m;
  while ((m = lineRe.exec(source))) out[m[1]] = { seconds: Number(m[2]) };
  return out;
}

test('every COMMAND_TIMEOUTS_MS class matches its table row in BOTH orchestrator/README.md and doc/state-machine-spec.md', () => {
  const configSrc = read('orchestrator/config.js');
  const readmeSrc = read('orchestrator/README.md');
  const specSrc = read('doc/state-machine-spec.md');

  const codeMap = extractCommandTimeoutsFromConfig(configSrc);
  assert.ok(codeMap && Object.keys(codeMap).length > 0, 'COMMAND_TIMEOUTS_MS object shape changed -- extractCommandTimeoutsFromConfig stopped matching');

  // Named floor, not a silent count: this is the exact set of classes measured 2026-09-03, re-measured after B1.4 added `bench-install`. A
  // class added to COMMAND_TIMEOUTS_MS tomorrow changes this set, and the assertion below names
  // which table (README, spec, or both) failed to grow with it, rather than passing vacuously.
  assert.deepEqual(
    Object.keys(codeMap).sort(),
    ['bench-install', 'gh', 'git', 'npm-ci', 'npm-gate', 'npm-run'],
    'COMMAND_TIMEOUTS_MS gained or lost a command class -- both doc tables need a matching row in the same change.'
  );

  const readmeMap = extractCommandTimeoutsFromReadmeTable(readmeSrc);
  const specMap = extractCommandTimeoutsFromSpecTable(specSrc);

  const offenders = [];
  for (const [cls, { envVar, ms }] of Object.entries(codeMap)) {
    const readmeRow = readmeMap[cls];
    if (!readmeRow) {
      offenders.push(`${cls}: no row in orchestrator/README.md's command-timeout table`);
    } else {
      if (readmeRow.ms !== ms) {
        offenders.push(`${cls}: orchestrator/README.md's table says ${readmeRow.ms}ms, config.js says ${ms}ms`);
      }
      if (readmeRow.envVar !== envVar) {
        offenders.push(`${cls}: orchestrator/README.md's table names ${readmeRow.envVar}, config.js reads ${envVar}`);
      }
    }
    const specRow = specMap[cls];
    if (!specRow) {
      offenders.push(`${cls}: no row in doc/state-machine-spec.md's timeout table`);
    } else if (specRow.seconds * 1000 !== ms) {
      offenders.push(`${cls}: doc/state-machine-spec.md's table says ${specRow.seconds}s (${specRow.seconds * 1000}ms), config.js says ${ms}ms`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `a command-timeout table cell no longer matches config.js's COMMAND_TIMEOUTS_MS -- this is ` +
      `the exact E8 gap (a bare table cell with no unit word, or doc/state-machine-spec.md ` +
      `excluded outright) doc/comment-corpus-audit-2026-09-03.md found:\n  ${offenders.join('\n  ')}`
  );
});

// ---- fixture tests: extractCommandTimeoutsFrom* against synthetic table text, so this checker
// stays provably correct independent of what the real docs say today, and to prove BY NAME the
// two specific gaps E8 found: a bare-number README cell, and a spec-file table row.

test('extractCommandTimeoutsFromReadmeTable: a bare-number cell with no unit word is still read correctly', () => {
  const fixture = [
    '| Class | Default | `SPO_TIMEOUT_*_MS` override |',
    '|---|---|---|',
    '| `git` | 90000 | `SPO_TIMEOUT_GIT_MS` |',
  ].join('\n');
  assert.deepEqual(extractCommandTimeoutsFromReadmeTable(fixture), { git: { ms: 90000, envVar: 'SPO_TIMEOUT_GIT_MS' } });
});

test('extractCommandTimeoutsFromSpecTable: reads a doc/state-machine-spec.md-shaped row (seconds, not ms)', () => {
  const fixture = '| `git` | 90s | every `git` call |';
  assert.deepEqual(extractCommandTimeoutsFromSpecTable(fixture), { git: { seconds: 90 } });
});

test('the table-aware check catches a planted README mutation the unit-word-anchored PINS regex could not', () => {
  // This is the audit's own verification, replayed as a permanent fixture: `120000 -> 90000` in
  // a bare table cell. PINS's `contains` string for this row (`| \`git\` | 120000 |
  // \`SPO_TIMEOUT_GIT_MS\` |`) would also catch this specific mutation (PINS checks the whole
  // row, not just the number) -- the GAP this test proves closed is that a checker keyed on the
  // CELL VALUE, not a literal string match, generalizes to a table PINS does not enumerate a row
  // for at all.
  const mutatedReadme = '| `git` | 90000 | `SPO_TIMEOUT_GIT_MS` |';
  const codeMap = { git: { envVar: 'SPO_TIMEOUT_GIT_MS', ms: 120000 } };
  const readmeMap = extractCommandTimeoutsFromReadmeTable(mutatedReadme);
  assert.notEqual(readmeMap.git.ms, codeMap.git.ms, 'fixture sanity: the planted mutation must actually differ from the code value');
});

test('the table-aware check reads doc/state-machine-spec.md at all, unlike the excluded-by-filename const-scan.js it replaces', () => {
  // E8's second gap: const-scan.js excluded this file BY NAME. Proven here by actually reading
  // it (not a fixture) and confirming the extractor returns rows from it, rather than an
  // exclusion list silently producing an empty (vacuously "clean") map.
  const specMap = extractCommandTimeoutsFromSpecTable(read('doc/state-machine-spec.md'));
  assert.ok(Object.keys(specMap).length >= 5, `expected at least 5 command-timeout rows read from doc/state-machine-spec.md, found ${Object.keys(specMap).length}`);
});

// ---- part 1.75: derived-list check (E6, action 9.2) ---------------------------------------------
//
// doc/comment-corpus-audit-2026-09-03.md's E6 finding: root README.md:34's own summary of
// `bin/spo`'s subcommands is a DERIVED list (a human-typed digest of bin/spo's real dispatch
// table), and it had drifted -- omitting `tokens`, `cost`, `accounts`, `pull-reports`, and
// `reports` (5 of bin/spo's 16 top-level `cmd === '<x>'` leaves; the audit counted 6 against a
// slightly different baseline). Fixed in passing (README.md:34 now names all 16) as part of this
// action -- an unambiguous fix, a missing README row, per this action's own brief. This check
// ratchets it: reads bin/spo's OWN dispatch table (never a hand-copied enum) and asserts every
// leaf's command name is named in the `bin/spo` ROW ITSELF, so a subcommand added to bin/spo
// tomorrow without a README update fails here, by name, instead of drifting silently again.
//
// Fix round (2026-09-03, adversarial pass): the first cut of this check searched the whole file,
// not the row it exists to ratchet -- restoring the exact drifted row 34 while separately naming
// the 5 missing subcommands anywhere else in the file (a footer sentence, say) left it green,
// because the file as a whole still named them. Anchored to ROW_RE below: the row is located by
// its own leading `| \`bin/spo\` |` cell, and every subcommand must appear inside THAT row's text,
// not merely somewhere in README.md.
function extractTopLevelSubcommands(source) {
  const out = [];
  const re = /if\s*\(cmd\s*===\s*'([a-z-]+)'\)/g;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

test('every bin/spo top-level subcommand is named in README.md', () => {
  const binSpoSrc = read('bin/spo');
  const commands = extractTopLevelSubcommands(binSpoSrc);

  // Named floor: measured 2026-09-03, 16 top-level `cmd === '<x>'` leaves. A regex that stopped
  // matching (a reformatted dispatch table) would pass vacuously -- fail loudly instead, same
  // posture as this file's other siteCount/checked floors.
  assert.deepEqual(
    commands.slice().sort(),
    ['account', 'accounts', 'ask', 'cost', 'dashboard', 'intake', 'parked', 'pull', 'pull-reports', 'recette', 'reports', 'resume', 'status', 'task', 'tokens', 'triage'],
    'bin/spo\'s top-level dispatch table changed -- a subcommand was added, removed, or renamed. ' +
      'Update this pin AND README.md\'s bin/spo row in the same change.'
  );

  const readmeSrc = read('README.md');
  // The `bin/spo` table row itself, located by its own leading cell -- never the whole file (see
  // this test's header comment on the exact 9.1 defect that gap let back in undetected).
  const ROW_RE = /^\|\s*`bin\/spo`\s*\|.*\|\s*$/m;
  const rowMatch = ROW_RE.exec(readmeSrc);
  assert.ok(
    rowMatch,
    "README.md's own `bin/spo` table row (originally line 34) is missing or no longer matches " +
      'the expected `| `bin/spo` | ... |` shape -- has the Repository map table been reformatted?'
  );
  const row = rowMatch[0];
  const missing = commands.filter((cmd) => {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
    return !re.test(row);
  });
  assert.deepEqual(
    missing,
    [],
    `bin/spo subcommand(s) not named in README.md's own \`bin/spo\` table row -- that row is a ` +
      `DERIVED digest of bin/spo's dispatch table and has drifted out of sync:\n  ${missing.join('\n  ')}`
  );
});

test('extractTopLevelSubcommands: reads a synthetic dispatch table, proving the extractor is not vacuous', () => {
  const fixture = [
    "  if (cmd === 'alpha') return cmdAlpha(opts);",
    "  if (cmd === 'beta-two') return cmdBetaTwo(opts);",
  ].join('\n');
  assert.deepEqual(extractTopLevelSubcommands(fixture), ['alpha', 'beta-two']);
});

// ---- part 1.8: phantom symbol check (E5, action 9.2) --------------------------------------------
//
// doc/comment-corpus-audit-2026-09-03.md's E5: a comment reads "`<file>.js`'s `<ident>`" -- a
// possessive naming a specific symbol another file supposedly exports -- and `<ident>` is not
// actually defined there. 3 sites / 2 symbols, both fixed in passing as part of this action (an
// unambiguous rename, per this action's own brief):
//   - bin/spo:407-408 and bin/spo:715 both said "state-machine.js's isEligibleNow"; the real
//     function is `isQueueEntryEligibleNow` (orchestrator/state-machine.js).
//   - orchestrator/state-machine.js:202 and orchestrator/README.md:441 both said "intake.js's
//     pullOne"; the real function is `pullBoard` (orchestrator/intake.js).
// Property: every CODE-SHAPED identifier cited as "`<file>.js`'s `<ident>`" is actually defined
// in that file. "Code-shaped" matters -- a naive scan over this possessive shape also matches
// ordinary prose ("config.js's own", "dispatcher.js's header"), which is never a symbol citation
// at all; restricting to camelCase/CONST_CASE tokens is what makes this check non-vacuous without
// also being noisy.
//
// Fix round (2026-09-03, adversarial pass), two gaps closed together:
//
//   (M15b) symbolDefinedIn used to be a WHOLE-FILE occurrence test, comments included -- planting
//   `// config.js's spawnStep resolves the class` in a citing file left the suite green, because
//   `spawnStep` genuinely appears in config.js, but ONLY inside its own comments (steps/
//   scripted.js's spawnStep, quoted there in prose -- see this file's header on the class of bug
//   this whole suite exists to catch: a doc SAYS something a re-reader would have to notice is
//   false). blankComments (the same idiom test/park-reason-doc-sweep.test.js's own scanners use,
//   copied verbatim below) now runs on the CITED file before the occurrence test, so a name that
//   exists only in that file's own commentary about a DIFFERENT file's symbol no longer counts as
//   "there". Comments in the CITING text are still left alone (unchanged from before) -- the
//   citations themselves live in comments, so blanking those would blank away the thing being
//   checked; normalizeWrap (part 2, reused here) still runs, so a wrapped citation is read whole.
//   This is deliberately a "does this code genuinely reference the symbol" test, not a stricter
//   "is this a top-level function/const/class declaration" parse -- real corpus citations
//   legitimately point at a property key (`config.js`'s `stepDeadlineMs`), a destructured import
//   (`account-lease.js`'s `MAX_LEASE_AGE_MS`), or a bare call (`deadline.js`'s `setTimeout`), none
//   of which is a "definition" in the narrowest sense but all of which are real, checkable code
//   presence -- exactly what distinguishes them from the two genuine E5 fabrications above, which
//   did not appear ANYWHERE in the cited file, comments included.
//
//   (M16) SYMBOL_CITATION_RE only matched the bare-prose shape (`file.js's ident`, no backticks).
//   The corpus's actual markdown convention is backtick-wrapped on both sides (`` `file.js`'s
//   `ident` ``) -- orchestrator/README.md:441's own fixed citation is written that way. The old
//   regex matched that shape ZERO times, so README.md's 72 backtick-possessive sites were
//   invisible to this check entirely (6 of 334 checked citations came from README.md, all via
//   incidental unbacktick'd prose). Backticks are now optional around both the filename and the
//   identifier, so both shapes are read as the same citation.
//
// Widening the scan surfaced 3 real matches that are not phantom SYMBOL citations at all --
// isCodeShapedIdentifier's CONST_CASE heuristic (3+ leading uppercase letters) also matches
// ordinary capitalized prose emphasis, which the possessive shape happens to precede in three
// places (`lock.js`'s `SECOND` idiom -- ordinal "a second, simpler idiom", not a constant;
// `config.js`'s `OWN` -- emphasis on "own", not an identifier; `intake.js`'s `LLM` -- "the intake
// LLM steps", not a symbol). Reworded at the source (product-repo-lock.js:28, recette.js:125,
// bin/spo:1875) rather than allowlisted: these were never real symbol citations to begin with, so
// an allowlist entry would misrepresent them as reviewed-and-accepted phantoms instead of what
// they are, three sentences that happened to fall into a regex's blind spot.
function isCodeShapedIdentifier(ident) {
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(ident)) return true; // CONST_CASE
  if (/[a-z][A-Z]/.test(ident) && ident.length >= 5) return true; // camelCase
  return false;
}

// blankComments -- verbatim copy of gh-api-argv.test.js's / test/park-reason-doc-sweep.test.js's
// idiom: blanks `/* */` blocks and whole-line `//` comments (preserving line numbers/lengths),
// so an identifier that exists ONLY in the file's own commentary about code does not count as
// "present" -- the M15b fix. An inline trailing `// comment` on a code line is not blanked (same
// limitation the copied idiom already has everywhere else it's used in this suite) -- harmless
// here since it can only ever make symbolDefinedIn MORE permissive, never hide a real phantom
// that M15b's own mutation (a comment-only mention) already proves this catches.
function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
}

// The filename group allows internal dots (`[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*`) so a multi-
// segment name like `lock.test.js` is captured whole -- a class without them would instead match
// only its LAST segment ("test.js"), turning a real (out-of-scope, see below) citation to
// test/lock.test.js into a fabricated one to a nonexistent bare "test.js". Backticks around the
// filename and/or the identifier are optional (M16, above) -- both the bare-prose shape
// ("state-machine.js's buildCtx") and the markdown shape ("`intake.js`'s `pullBoard`") match.
//
// M17 (2026-09-03) widened the file group twice, so that this check can carry the citations
// converted away from `file:line` in the same change (see the commit message for the drift
// problem that motivated the conversion):
//
//   - `.ts` as well as `.js`. Every line-number citation this corpus makes into SPO-WebClient
//     points at a TypeScript file, so a `.js`-only regex could not see a single converted
//     citation. This is what makes the conversion a trade of one check for another rather than a
//     trade of a check for nothing.
//   - an optional leading path (`src/e2e/bench/paths.ts`, `SPO-WebClient/src/e2e/bench/paths.ts`).
//     `paths.ts` is an ambiguous basename in the product repo, so its citation MUST spell a path
//     to say which file it means -- and a regex that stopped at the basename would have read
//     `src/e2e/bench/paths.ts`'s citation as a bare, ambiguous `paths.ts`. resolveSymbolFile
//     above consumes the path; see its header for the basename fallback that keeps this corpus's
//     existing repo-relative-ish prose ("steps/scripted.js") resolving exactly as it did before.
const SYMBOL_CITATION_RE = /`?\b((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|ts))`?'s `?([A-Za-z_][A-Za-z0-9_]*)`?/g;

function extractSymbolCitations(text) {
  const out = [];
  let m;
  SYMBOL_CITATION_RE.lastIndex = 0;
  while ((m = SYMBOL_CITATION_RE.exec(text))) {
    const ident = m[2];
    if (!isCodeShapedIdentifier(ident)) continue;
    // test/**.test.js is out of this corpus's scope by the same rule doc/accepted-gaps.md
    // states for the rest of this action (test/** was never part of Gate C7's clause, and
    // CORPUS_FILES above excludes it entirely) -- a symbol cited FROM a test file is a test-
    // maintenance fact, not a documentation-truthfulness one this sweep owns.
    if (m[1].endsWith('.test.js') || m[1].endsWith('.test.ts')) continue;
    out.push({ file: m[1], ident, index: m.index });
  }
  return out;
}

// resolveSymbolFile(fileName) -- M17: the cited file, resolved the SAME way part 2's line-number
// citations already resolve (resolveCitationTarget: this repo, then the product repo, then
// SPO-Deploy), rather than the old basename-in-THIS-repo-only lookup. Two things forced the
// widening, both from converting `file:line` citations to symbol citations (see the M17 header
// above SYMBOL_CITATION_RE):
//
//   - a symbol citation to a PRODUCT file (`worker.ts`'s `MAX_LEASE_MINUTES`) is the whole point
//     of the conversion, and the old lookup could only ever answer 'no-such-file' for it;
//   - `paths.ts` is an AMBIGUOUS basename in the product repo (src/e2e/bench/paths.ts and
//     src/server/paths.ts), so the honest citation spells a path -- which the old basename-only
//     lookup could not consume at all.
//
// Two attempts, in order: the cited text verbatim, then its basename. The basename fallback is
// what keeps every PRE-EXISTING citation working now that SYMBOL_CITATION_RE captures a leading
// path: this corpus's prose writes `steps/scripted.js`, but the file's real path is
// `orchestrator/steps/scripted.js`, and resolveCitationTarget only joins paths, never searches
// for a suffix. Verbatim-first (not basename-first) is deliberate: it is what lets a path-bearing
// citation disambiguate a basename that is ambiguous on its own, which is the entire reason
// `src/e2e/bench/paths.ts` has to be written out.
//
// A missing cross-repo checkout is returned as its own answer ('product-absent'/'deploy-absent'),
// never collapsed into 'no-such-file' -- same E1 posture part 2 already takes: "the repo needed to
// tell isn't on disk" is a setup problem the caller must fail loudly on, not a silent pass. It is
// only returned when NO attempt resolved, so a citation whose basename resolves locally is
// unaffected by whether SPO-Deploy happens to be checked out.
function resolveSymbolFile(fileName) {
  const attempts = fileName.includes('/') ? [fileName, path.basename(fileName)] : [fileName];
  const failures = [];
  for (const attempt of attempts) {
    const r = resolveCitationTarget(attempt);
    if (r.target) return r.target;
    // Ambiguity is its own answer, never a silent first pick -- see findByBasename's header for
    // the stale-worktree resolution that rule replaced.
    if (r.ambiguous) failures.push('ambiguous-file');
    else if (r.root === 'product-absent' || r.root === 'deploy-absent') failures.push(r.root);
    else failures.push('no-such-file');
  }
  const absent = failures.find((f) => f === 'product-absent' || f === 'deploy-absent');
  if (absent) return absent;
  return failures.includes('ambiguous-file') ? 'ambiguous-file' : 'no-such-file';
}

// symbolDefinedIn -- M15b: tests whether `ident` occurs in the CITED file's real code (comments
// blanked first), not merely anywhere in the file's raw text. A whole-file occurrence test (the
// pre-fix shape) cannot distinguish "this file's code genuinely uses/declares this name" from
// "this file's own commentary happens to mention this name while discussing a DIFFERENT file" --
// exactly the gap the config.js/spawnStep plant above proves closed.
function symbolDefinedIn(fileName, ident) {
  const target = resolveSymbolFile(fileName);
  if (target === 'no-such-file' || target === 'ambiguous-file' || target === 'product-absent' || target === 'deploy-absent') {
    return target;
  }
  const src = blankComments(fs.readFileSync(target, 'utf8'));
  return new RegExp(`\\b${ident}\\b`).test(src);
}

// PHANTOM_SYMBOL_ALLOWLIST: per-fact, same posture as CITATION_ALLOWLIST above -- empty today
// (every known phantom, including the 3 CONST_CASE-prose false matches M16's wider scan
// surfaced, was fixed in passing rather than exempted), kept so a future finding this action's
// own judgement should NOT rename (e.g. an intentionally-approximate paraphrase) has somewhere to
// go without becoming a whole-file exemption. Membership pinned below, same as this suite's other
// allowlists -- the one this file previously shipped withOUT a pin.
const PHANTOM_SYMBOL_ALLOWLIST = {};

test('PHANTOM_SYMBOL_ALLOWLIST holds exactly the entries this action explicitly justified -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(PHANTOM_SYMBOL_ALLOWLIST).sort(),
    [],
    'PHANTOM_SYMBOL_ALLOWLIST changed size or membership. Adding an entry here exempts a symbol ' +
      'citation from ever needing to resolve, forever -- it needs its own named, reasoned ' +
      'justification (read from the actual file, not assumed), and this pin needs updating in the ' +
      'same change, by name.'
  );
});

test('every "<file>.js|.ts\'s <CodeShapedIdent>" possessive citation names a symbol that actually exists in that file', () => {
  const SCAN_REL = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'orchestrator'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => path.join('orchestrator', e.name)),
    ...fs.readdirSync(path.join(REPO_ROOT, 'orchestrator', 'steps'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => path.join('orchestrator', 'steps', e.name)),
    'bin/spo',
    'orchestrator/README.md',
  ];

  const offenders = [];
  let checked = 0;
  for (const rel of SCAN_REL) {
    const raw = read(rel);
    const normalized = normalizeWrap(rel.endsWith('.md') ? stripFences(raw) : raw);
    for (const c of extractSymbolCitations(normalized)) {
      checked += 1;
      const key = `${rel} :: ${c.file}'s ${c.ident}`;
      if (Object.prototype.hasOwnProperty.call(PHANTOM_SYMBOL_ALLOWLIST, key)) continue;
      const exists = symbolDefinedIn(c.file, c.ident);
      if (exists !== true) {
        offenders.push(
          `${key} -- ${
            exists === 'no-such-file'
              ? `no such file ${c.file}`
              : exists === 'product-absent'
                ? `${c.file} does not resolve in this repo, and ${PRODUCT_REPO} is not on disk to check further (E1: never a silent pass)`
                : exists === 'deploy-absent'
                  ? `${c.file} does not resolve in this repo or the product repo, and ${DEPLOY_REPO} is not on disk to check further (E1: never a silent pass)`
                  : exists === 'ambiguous-file'
                    ? `ambiguous basename ${c.file}: several tracked files share it, so this citation does not say which file it means -- cite a path`
                    : `no \`${c.ident}\` defined in ${c.file}`
          }`
        );
      }
    }
  }

  // Floor raised from 100 to 400 (M16): widening SYMBOL_CITATION_RE to the backtick-wrapped
  // markdown shape roughly doubled real coverage (measured 2026-09-03: 478 checked, up from ~230
  // under the old regex) -- almost entirely orchestrator/README.md's 72 previously-invisible
  // sites. 400 stays comfortably below the measured figure while still failing loudly if either
  // regex half (bare-prose or backtick-wrapped) stops matching.
  //
  // M17 re-measured 2026-09-03: 513 checked, up from 497 on the pre-M17 tree. (The 478 figure in
  // the M16 paragraph above is the measurement of the day M16 landed and was NOT re-measured
  // since; the corpus grew to 497 in the commits between. Both numbers are kept, each attached to
  // the change that measured it, rather than one being silently restated as the other's.)
  //
  // The +16 is the `.ts` and leading-path widening (see SYMBOL_CITATION_RE's header), and it was
  // measured by dumping both key sets and diffing them, not by subtraction:
  //
  //   - 7 are the symbol citations this change WROTE in place of a `file:line` -- bench-
  //     heartbeat.js's two paths.ts ones, bench-queue-wait.js's purgeDone and DONE_RETENTION_MS,
  //     journal.js's and steps/scripted.js's MAX_LEASE_MINUTES, steps/scripted.js's
  //     DEFAULT_LEASE_MINUTES.
  //   - 9 are cross-repo symbol claims the corpus was ALREADY making in prose and nothing
  //     checked, because a `.js`-only filename group cannot see a `.ts` at all: worker.ts's
  //     NON_ATTESTING (x3 sites) and recoverInterrupted, job.ts's DuplicateJobError and
  //     purgeDone, merge-queue.ts's mayReuseVerdict, run.ts's runLive, and a second
  //     DEFAULT_LEASE_MINUTES in orchestrator/README.md. All 16 resolve and pass.
  //
  // The rest of the diff between the two key sets is rendering, not population: a citation the
  // corpus writes as `steps/scripted.js`'s `realCheck` used to key on the basename alone and now
  // keys on the path it was actually written with. resolveSymbolFile's basename fallback is what
  // keeps those resolving; see its header.
  //
  // bench-heartbeat.js is worth naming separately: part 2 never covered it at all (it is not in
  // CORPUS_FILES), which is exactly how its `paths.ts:52` drifted to a real line 77 unnoticed --
  // the conversion had to fix the fact, not merely the shape.
  //
  // Floor deliberately left at 400: it is a "did the regex stop matching" tripwire, not a second
  // pin on the exact population, which EXPECTED_CITATIONS already is.
  assert.ok(checked >= 400, `expected at least 400 code-shaped "<file>.js's <ident>" citations, found ${checked} -- has the possessive-citation style changed, or did isCodeShapedIdentifier / the backtick-optional SYMBOL_CITATION_RE stop matching?`);
  assert.deepEqual(
    offenders,
    [],
    `phantom symbol citation(s) -- a comment names a symbol that does not exist in the file it ` +
      `cites:\n  ${offenders.join('\n  ')}`
  );
});

// resolveSymbolFile is new in M17 and is the half of the conversion that keeps it a trade of one
// check for ANOTHER check rather than a trade of a check for nothing: a citation that drops its
// `:NNN` is only as good as the resolution behind the symbol. The two cases below are the ones
// the conversion actually rests on, and they pull in opposite directions -- the basename fallback
// has to be permissive enough for the corpus's existing repo-relative-ish prose, while the
// verbatim-first ORDER has to still let a spelled-out path disambiguate a basename that is
// ambiguous on its own. Reversing that order would make the second assertion below pass for the
// wrong reason (ambiguous, then arbitrarily resolved) and is exactly what these pin.
test('resolveSymbolFile: repo-relative-ish prose ("steps/scripted.js") resolves via the basename fallback', () => {
  assert.equal(resolveSymbolFile('steps/scripted.js'), path.join(REPO_ROOT, 'orchestrator', 'steps', 'scripted.js'));
});

test('resolveSymbolFile: a spelled-out path disambiguates a product-repo basename that is ambiguous alone', () => {
  // `paths.ts` is src/e2e/bench/paths.ts AND src/server/paths.ts in the product repo: the bare
  // basename must stay an error, never a silent first pick.
  assert.equal(resolveSymbolFile('paths.ts'), 'ambiguous-file');
  assert.equal(resolveSymbolFile('src/e2e/bench/paths.ts'), path.join(PRODUCT_REPO, 'src/e2e/bench/paths.ts'));
  assert.equal(resolveSymbolFile('SPO-WebClient/src/e2e/bench/paths.ts'), path.join(PRODUCT_REPO, 'src/e2e/bench/paths.ts'));
});

test('extractSymbolCitations: filters prose ("config.js\'s own") from real symbol citations ("state-machine.js\'s buildCtx")', () => {
  const text = "see config.js's own defaults, and state-machine.js's buildCtx for the real shape";
  assert.deepEqual(extractSymbolCitations(text).map((c) => `${c.file}'s ${c.ident}`), ["state-machine.js's buildCtx"]);
});

test('extractSymbolCitations: the backtick-wrapped markdown possessive ("`file.js`\'s `ident`") is read the same as the bare-prose shape (M16)', () => {
  const text = 'between drain passes (`state-machine.js`\'s `runForever`) -- the exact same `pullBoard`';
  assert.deepEqual(extractSymbolCitations(text).map((c) => `${c.file}'s ${c.ident}`), ["state-machine.js's runForever"]);
});

test('symbolDefinedIn: a mutation-proof canary -- a symbol invented for this fixture is correctly reported absent', () => {
  assert.equal(symbolDefinedIn('config.js', 'thisIdentifierDoesNotExistAnywhereInTheRepoXYZ'), false);
});

test('symbolDefinedIn (M15b): a name that exists ONLY inside the cited file\'s own comments is reported absent, not present', () => {
  // config.js genuinely contains the substring "spawnStep" -- but only inside its own comments,
  // quoting steps/scripted.js's real function. The pre-fix whole-file occurrence test could not
  // tell that apart from a real definition/usage; blankComments (above) is what makes it able to.
  assert.equal(symbolDefinedIn('config.js', 'spawnStep'), false);
});

// ---- part 1.9: unanchored action-id check (E12, action 9.2) -------------------------------------
//
// doc/comment-corpus-audit-2026-09-03.md's E12: a comment marks itself "---- action N.Na ----"
// (a section banner naming which plan action the code below implements) and that id does not
// appear in either plan document. 1 id / 3 sites, found 2026-09-03: `action 5.1d`
// (orchestrator/park-loop.js:219, orchestrator/state-machine.js:835,1249).
//
// Fix round (2026-09-03, adversarial pass), S3: the first cut of this allowlist entry claimed
// the referent was "a judgement call about the plan's own history." Re-resolved directly against
// both docs -- it was not. doc/remediation-plan-2026-08.md:186 lists row 5.1's three sub-items in
// one cell, unlettered: pre-worktree board moves, "DIAGNOSE activity surfaced (a 'diagnosing,
// attempt N/3' comment or a dedicated column -- driver decision)" (this one), and dropping the
// redundant IMPLEMENT-retry move. doc/remediation-progress.md:647 names the same referent again,
// under "DIAGNOSE surfacing" ("6 tasks entered DIAGNOSE, 18 attempts total, 4 of them ending in a
// park"). The referent was never ambiguous -- only the letter `d` was invented (the plan does not
// letter row 5.1's sub-items at all; a scatter of OTHER letters -- 5.1a/5.1b/5.1c/5.1e -- exists
// only in code comments too, none of them plan-assigned). Fixed at the three call sites (renamed
// to the plan's real, unlettered id, "action 5.1") rather than allowlisted with a corrected
// reason: an unambiguous referent belongs in the code, not in an exception list. ACTION_ID_ALLOWLIST
// is therefore empty -- kept, not deleted, for the same reason this suite's other now-empty
// allowlists (EVENT_ALLOWLIST, PHANTOM_SYMBOL_ALLOWLIST) are kept: a genuinely ambiguous future
// id has somewhere to go, named and reasoned, without becoming a bulk exemption.
const ACTION_ID_RE = /\baction (\d+(?:bis)?\.\d+[a-z]?)\b/g;
const ACTION_ID_DOCS = ['doc/remediation-plan-2026-08.md', 'doc/remediation-progress.md'];

function actionIdDocumented(id) {
  return ACTION_ID_DOCS.some((rel) => {
    const text = read(rel);
    const re = new RegExp(`\\| ?${id.replace('.', '\\.')} ?\\||\\b${id.replace('.', '\\.')}\\b`);
    return re.test(text);
  });
}

// ACTION_ID_ALLOWLIST: per-id (never per-site), same reasoned-pin posture as this suite's other
// allowlists. Empty since the S3 fix above (see the header comment on why "5.1d" was fixed at
// its call sites rather than allowlisted).
const ACTION_ID_ALLOWLIST = {};

test('ACTION_ID_ALLOWLIST holds exactly the ids this action found genuinely unanchored -- no more, no fewer', () => {
  assert.deepEqual(Object.keys(ACTION_ID_ALLOWLIST).sort(), [], 'ACTION_ID_ALLOWLIST changed -- update this pin in the same change, with a named reason.');
});

test('every "action N.Na" banner comment names an id that appears in one of the two plan docs, or is on ACTION_ID_ALLOWLIST', () => {
  const SCAN_REL = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'orchestrator'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => path.join('orchestrator', e.name)),
    ...fs.readdirSync(path.join(REPO_ROOT, 'orchestrator', 'steps'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => path.join('orchestrator', 'steps', e.name)),
    'bin/spo',
  ];

  const ids = new Set();
  let checked = 0;
  for (const rel of SCAN_REL) {
    const src = read(rel);
    let m;
    const re = new RegExp(ACTION_ID_RE.source, 'g');
    while ((m = re.exec(src))) { ids.add(m[1]); checked += 1; }
  }

  assert.ok(checked >= 5, `expected at least 5 "action N.Na" mentions across orchestrator/**+bin/spo, found ${checked} -- has the banner convention changed?`);

  const offenders = [];
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(ACTION_ID_ALLOWLIST, id)) continue;
    if (!actionIdDocumented(id)) offenders.push(id);
  }
  assert.deepEqual(
    offenders,
    [],
    `action id(s) cited in code but absent from both plan docs, not on ACTION_ID_ALLOWLIST:\n  ${offenders.join('\n  ')}`
  );
});

// ---- part 2: file:line citation ratchet -----------------------------------------------------
//
// Rebuilt for action 9.2 (E18 of doc/comment-corpus-audit-2026-09-03.md): the ratchet used to
// check 2 of the corpus's 65 in-scope files, with a regex that missed `.json` targets, `(line N)`
// prose, and bare `` `:N` `` chain-continuations (` foo.js:10, `:20` ` naming the SAME file
// twice) -- 9 of 63 real citations, 14%, with a `checked >= 8` floor one deletion from vacuous.
// Widened to all 65 corpus files (CORPUS_FILES below, the same exclusions doc/accepted-gaps.md
// §3a/3b/self already made, plus this action's own audit doc -- dated 2026-09-03, written AFTER
// the corpus was measured, so it was never part of what got measured), a regex that also matches
// `.json`, and two more citation shapes resolved by the scanner below rather than left as false
// negatives. `checked` is no longer a floor: EXPECTED_CITATIONS pins the exact sorted set of citation
// strings this corpus holds today, so a citation added, removed, or reworded fails this test by
// NAME (the exact diff), not by a shrinking/growing number -- gate C7's own lesson, restated.
//
// ---- three citation shapes ---------------------------------------------------------------------
//   1. `path/to/file.ext:N` or `:N-M` -- the original shape, CITATION_RE below.
//   2. `path/to/file.ext`'s `thing` (line N) -- prose possessive form, POSSESSIVE_LINE_RE. One
//      live site: orchestrator/bench-queue-wait.js's own header, citing the product's `job.ts`'s
//      `purgeDone`.
//   3. A bare backtick `` `:N` `` (or, in a JS comment, "at :N") immediately after a real
//      citation established the file -- `` `account-lease.js:156` -> `lock.js:255` ... -> `:289`
//      tryCreate `` (orchestrator/README.md) chains three citations to two files without
//      repeating the second filename. CHAIN_RE below, resolved against the nearest PRECEDING
//      real citation within PROXIMITY_CHARS -- far enough to catch a same-sentence chain, close
//      enough that a `.md` file's later, unrelated citation-shaped prose (doc/bench-audit-2026-
//      09-02.md's own "cli.ts ... was cited to `:458`", quoting a DIFFERENT sweep's broken
//      citation as historical evidence, three of them in a row with no filename directly before
//      the colon) is reported as unanchored rather than silently mis-attributed to whatever real
//      citation happened to appear last. An unanchored chain is never treated as a resolvable
//      citation -- it is reported and, where it turns out to be exactly the quoted-elsewhere's-
//      broken-citation shape above, allowlisted BY NAME below, same as any other offender this
//      file cannot fix by editing a dated record.
//
// ---- line-wrap normalisation (E15) ---------------------------------------------------------------
// Sweeps cannot be line-based: 9.1 measured 6 wrapped identifiers in this corpus, one of them a
// real citation (orchestrator/invariants.js:2-3: "doc/state-machine-\n// spec.md:49", the comment
// marker re-starting mid-identifier). normalizeWrap joins a line ending in `-` or `/` directly to
// its continuation (stripping any `//`/`*`/`#` comment leader first, so the join produces
// `state-machine-spec.md`, not `state- // machine-spec.md`) and collapses every other line break
// to a single space, so a citation is read as one contiguous string regardless of where the
// source happened to wrap it. Fenced code blocks in `.md` files are blanked first (stripFences,
// unchanged from before) -- a format TEMPLATE inside a fence was never a real citation.
//
// ---- cross-repo resolution (E1, minimally) -------------------------------------------------------
// A citation that does not resolve in THIS repo is not automatically dangling: 31 of the 65
// corpus files' citations name a `.ts` file, a bare product basename (`worker.ts`, `cli.ts`,
// ...), or a path explicitly prefixed `SPO-WebClient/` -- none of which this repo could ever
// contain (it ships zero `.ts` files). resolveCitationTarget tries this repo, then
// `config.productRepo`'s default (`~/SPO-WebClient`), then a scanner-local `DEPLOY_REPO`
// (`~/SPO-Deploy` -- config.js has no `deployRepo` constant to import; adding one is a
// production-code decision out of this action's scope, left for 9.3, see the report). Per E1's
// own requirement, an ABSENT product or deploy repo is never a silent pass: if a citation cannot
// be resolved locally and the repo that would have to resolve it is missing from disk, that is
// reported as its own offender, distinct from a genuinely dangling citation, so the two failure
// modes are never confused with each other or silently merged into "clean."

// Pinned 2026-09-03 against `git ls-files doc orchestrator bin/spo console scripts accounts
// README.md prompts/README.md`, minus doc/accepted-gaps.md (classified-historical by its own
// text), the three doc/accepted-gaps.md §3b running logs (doc/remediation-progress.md,
// doc/improvisation-analysis.md, doc/remediation-plan-2026-08.md), and
// doc/comment-corpus-audit-2026-09-03.md (9.1's own deliverable, written AFTER the corpus it
// measured -- not part of what it measured). 66 files: the 65 of doc/accepted-gaps.md §3d's own
// count, plus `orchestrator/retry-channel.js`, added by project-2 card #476 (the unpark scan's
// health rule, factored out of bin/spo when the card gave it a third reader). A file added to or
// removed from this scope is a deliberate act -- update this array in the same change, by name,
// the same way PINS's name list above works.
const CORPUS_FILES = [
  'README.md',
  'accounts/spo-test-accounts.yml',
  'bin/spo',
  'console/collect.js',
  'console/prod-version.js',
  'console/render.js',
  'console/serve.js',
  'console/system.js',
  'console/usage-rollups.js',
  'console/usage-scan.js',
  'doc/bench-audit-2026-09-02.md',
  'doc/bench-plan-derived-2026-09-02.md',
  'doc/board-audit.md',
  'doc/environments.md',
  'doc/jewels-inventory.md',
  'doc/permissions.md',
  'doc/setup.md',
  'doc/state-machine-spec.md',
  'orchestrator/README.md',
  'orchestrator/account-lease.js',
  'orchestrator/accounts.js',
  'orchestrator/auto-pull.js',
  'orchestrator/auto-triage.js',
  'orchestrator/bench-queue-wait.js',
  'orchestrator/board.js',
  'orchestrator/ci-cause-table.js',
  'orchestrator/command-timeout.js',
  'orchestrator/comment-scan.js',
  'orchestrator/config.js',
  'orchestrator/daemon.js',
  'orchestrator/deadline.js',
  'orchestrator/dispatcher.js',
  'orchestrator/fixture.js',
  'orchestrator/http.js',
  'orchestrator/intake.js',
  'orchestrator/invariants.js',
  'orchestrator/journal.js',
  'orchestrator/lock.js',
  'orchestrator/main-moved-budget.js',
  'orchestrator/monotonic-clock.js',
  'orchestrator/orphan-scan.js',
  'orchestrator/park-alert.js',
  'orchestrator/park-loop.js',
  'orchestrator/park-signal.js',
  'orchestrator/product-repo-hold.js',
  'orchestrator/product-repo-lock.js',
  'orchestrator/prompt-template.js',
  'orchestrator/recette.js',
  'orchestrator/remote-report-pull.js',
  'orchestrator/report-intake.js',
  'orchestrator/retry-channel.js',
  'orchestrator/state-machine.js',
  'orchestrator/step-contracts.js',
  'orchestrator/steps/llm.js',
  'orchestrator/steps/scripted.js',
  'orchestrator/task-summary.js',
  'orchestrator/task-values.js',
  'orchestrator/tokens.js',
  'orchestrator/worker-status.js',
  'prompts/README.md',
  'scripts/daemon-install.sh',
  'scripts/dashboard-install.sh',
  'scripts/git-hooks/post-merge',
  'scripts/park-alert.sh',
  'scripts/smoke-llm.js',
  'scripts/usage-report.js',
];

const PRODUCT_REPO = process.env.SPO_PRODUCT_REPO || path.join(os.homedir(), 'SPO-WebClient');
// No `config.deployRepo` exists (confirmed by doc/comment-corpus-audit-2026-09-03.md §5) -- this
// constant is scanner-local on purpose; see the header above.
const DEPLOY_REPO = process.env.SPO_DEPLOY_REPO || path.join(os.homedir(), 'SPO-Deploy');

// `bin/spo` is an explicit alternative, not a generalized "extensionless path" allowance: it is
// the one extensionless executable this corpus cites by line (action 9.3 found real citations to
// it -- doc/state-machine-spec.md:448, and two dated-record sites -- invisible to the plain
// `\.ext` shape below, meaning `bin/spo:1090-1093`'s drift to :1137 (see part 2.5) could not even
// be SEEN, let alone bounds- or anchor-checked, before this widening).
const CITATION_RE = /((?:bin\/spo)|(?:[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:js|md|sh|ts|json))):(\d+)(?:-(\d+))?/g;
const POSSESSIVE_LINE_RE = /([A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:js|md|sh|ts|json))'s(?:[^()\n]{0,60})?\(line (\d+)\)/g;
const CHAIN_RE = /`:(\d+)(?:-(\d+))?`|(?<=\bat ):(\d+)(?:-(\d+))?\b/g;
const PROXIMITY_CHARS = 150;

// Per-fact allowlist, exactly the ALLOWLIST/KNOWN_FICTIONAL idiom this suite and
// park-reason-doc-sweep.test.js already use -- keyed `${file} :: ${citation}`, never per-file
// (test/no-real-spawn-sweep.test.js's own header: a whole-file exemption was itself the gap that
// hid a real missing killswitch). Every entry is either a deliberate, real absence (never
// fixable by editing the citing file) or a dated record whose citation was true when written and
// has since drifted -- "rewrite the citation" would misrepresent what the record actually said
// at measurement time, so these are named exceptions, not defects fixed in passing.
const CITATION_ALLOWLIST = {
  // issue-418's plan once asserted this exact path was absent, and orchestrator/README.md quotes
  // that assertion verbatim as a worked example ("That file does not exist") -- a real citation
  // to a real absence, not a stale one. See orchestrator/README.md's "Why not scan plan_markdown".
  'orchestrator/README.md :: .claude/hooks/context-router.sh:117':
    'deliberate worked example of a citation to a file that was asserted, and remains, absent -- ' +
    'not a stale citation.',
  // orchestrator/invariants.js:37's own "File: relative/path/to/file.ts:123" is the INV block
  // format's own documentation example -- a deliberately fake path, the same role a fenced
  // markdown template plays (stripFences already excludes those; this one is a bare `//` comment
  // line, not inside a fence, so stripFences cannot reach it).
  'orchestrator/invariants.js :: relative/path/to/file.ts:123':
    "format-template example in the comment documenting the INV block's `File: <path>:<line>` " +
    'syntax -- never a real citation.',
  // doc/bench-audit-2026-09-02.md and doc/bench-plan-derived-2026-09-02.md are dated 8.1 audit
  // records (measured against a pinned SPO-WebClient commit); 9.1's own re-verification
  // (doc/comment-corpus-audit-2026-09-03.md §1) confirmed sanctuarize.test.ts has since been
  // deleted from the product repo. The citation was true when the record was written -- editing
  // it now would misrepresent what the audit actually found at measurement time.
  'doc/bench-audit-2026-09-02.md :: sanctuarize.test.ts:151-156':
    'product file deleted after this dated record was written (confirmed by 9.1, ' +
    'doc/comment-corpus-audit-2026-09-03.md §1) -- historical citation, not a live one.',
  'doc/bench-plan-derived-2026-09-02.md :: sanctuarize.test.ts:151-156':
    'product file deleted after this dated record was written (confirmed by 9.1, ' +
    'doc/comment-corpus-audit-2026-09-03.md §1) -- historical citation, not a live one.',
  // Same dated-record posture: the product's verdict.ts and worker.ts have both shrunk since
  // 2026-09-02 (measured today at 167 and 759 lines respectively), so citations to :183 and :780
  // now exceed EOF. Re-verified: 2026-09-03.
  'doc/bench-audit-2026-09-02.md :: verdict.ts:162-183':
    "product file has shrunk since this dated record's measurement commit (167 lines today) -- " +
    'historical citation, not a live one.',
  'doc/bench-audit-2026-09-02.md :: worker.ts:779-780':
    "product file has shrunk since this dated record's measurement commit (759 lines today) -- " +
    'historical citation, not a live one.',
  // This repo's own .claude/settings.json has been edited since 2026-09-02 (120 lines today,
  // down from the 109-127 range cited as evidence of a 33%-precision worked example) -- same
  // dated-record posture, this time about THIS repo rather than the product.
  'orchestrator/README.md :: .claude/settings.json:109-127':
    "this repo's .claude/settings.json has been edited since this dated record's measurement " +
    'date -- historical citation (worked-example evidence), not a live one.',
  // doc/bench-audit-2026-09-02.md's own "One sweep's broken references are all in `.ts` files
  // (`cli.ts` is 310 lines and was cited to `:458`; `fingerprint.ts` is 80 and cited to `:277`);
  // the other's are all in shell scripts (`bench-submit.sh` is 15 lines, cited to `:65-69`)"
  // quotes a DIFFERENT sweep's broken citations as historical evidence -- cli.ts/fingerprint.ts/
  // bench-submit.sh are named in prose without a `:N` directly attached, so CHAIN_RE's nearest-
  // preceding-citation resolution correctly finds no anchor within PROXIMITY_CHARS and reports
  // these three as unanchored rather than silently attributing them to whatever real citation
  // happened to appear earlier in the file. Not a defect in the ratchet or in this document.
  'doc/bench-audit-2026-09-02.md :: (unanchored) :458':
    "narrative aside quoting a different, historical sweep's broken citation to cli.ts as " +
    'evidence -- not a live citation chain.',
  'doc/bench-audit-2026-09-02.md :: (unanchored) :277':
    "narrative aside quoting a different, historical sweep's broken citation to fingerprint.ts " +
    'as evidence -- not a live citation chain.',
  'doc/bench-audit-2026-09-02.md :: (unanchored) :65-69':
    "narrative aside quoting a different, historical sweep's broken citation to bench-submit.sh " +
    'as evidence -- not a live citation chain.',
};

// isCitationAllowlisted -- extracted so the per-FACT (never per-file) matching discipline
// CITATION_ALLOWLIST depends on is itself under test below, not merely asserted by its own
// membership pin. Fix round (2026-09-03, adversarial pass), M13: the shipped inline check
// (`Object.prototype.hasOwnProperty.call(CITATION_ALLOWLIST, \`${c.rel} :: ${c.raw}\`)`) was
// already per-fact and correct, but nothing proved it stays that way -- a mutation that degraded
// the match to per-FILE (`Object.keys(CITATION_ALLOWLIST).some((k) => k.startsWith(c.rel))`) plus
// a real dangling `orchestrator/journal.js:999999` planted in an already-allowlisted file passed
// 24/24, because the key pin alone cannot see how the main test's loop actually compares a key --
// only that CITATION_ALLOWLIST's OWN keys look right. This function is that comparison, called by
// the main test below instead of inlining it, so the fixture test right after it is exercising
// the exact same logic the real ratchet runs, not a parallel reimplementation that could drift.
function isCitationAllowlisted(allowlist, rel, raw) {
  return Object.prototype.hasOwnProperty.call(allowlist, `${rel} :: ${raw}`);
}

test('isCitationAllowlisted: matches per FACT (file + citation), never by file alone (M13)', () => {
  const allowlist = { 'orchestrator/README.md :: known-absent.ts:1': 'a real, dated absence' };
  assert.equal(isCitationAllowlisted(allowlist, 'orchestrator/README.md', 'known-absent.ts:1'), true);
  // A DIFFERENT, real dangling citation in the SAME file must NOT be swallowed just because some
  // other citation in that file happens to be allowlisted -- the exact degradation class M13's
  // adversarial mutation (per-file matching + a planted real-dangling orchestrator/journal.js:
  // 999999 in an already-allowlisted file) exploited, and which stayed green under the pre-fix
  // inline check with no test of its own.
  assert.equal(isCitationAllowlisted(allowlist, 'orchestrator/README.md', 'journal.js:999999'), false);
});

test('CITATION_ALLOWLIST holds exactly the entries this action explicitly justified -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(CITATION_ALLOWLIST).sort(),
    [
      'doc/bench-audit-2026-09-02.md :: (unanchored) :277',
      'doc/bench-audit-2026-09-02.md :: (unanchored) :458',
      'doc/bench-audit-2026-09-02.md :: (unanchored) :65-69',
      'doc/bench-audit-2026-09-02.md :: sanctuarize.test.ts:151-156',
      'doc/bench-audit-2026-09-02.md :: verdict.ts:162-183',
      'doc/bench-audit-2026-09-02.md :: worker.ts:779-780',
      'doc/bench-plan-derived-2026-09-02.md :: sanctuarize.test.ts:151-156',
      'orchestrator/README.md :: .claude/hooks/context-router.sh:117',
      'orchestrator/README.md :: .claude/settings.json:109-127',
      'orchestrator/invariants.js :: relative/path/to/file.ts:123',
    ],
    'CITATION_ALLOWLIST changed size or membership. Adding an entry here exempts a citation from ' +
      'ever needing to resolve, forever -- it needs its own named, reasoned justification (read ' +
      'from the actual file, not assumed), and this pin needs updating in the same change, by name.'
  );
});

function stripFences(src) {
  // Fenced code blocks hold format TEMPLATES (e.g. "File: relative/path/to/file.ts:123" in the
  // invariant-block example), never a real citation -- blanked the same way blankComments strips
  // // and /* */ elsewhere in this suite's sweeps, so line numbers of anything real are unaffected.
  let inFence = false;
  return src
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

// normalizeWrap(src) -- E18/E15: joins an identifier or citation the source happened to wrap
// across a line break, so CITATION_RE (which never spans a space, deliberately -- spanning one
// would turn ordinary prose into false-positive matches) still reads it as one contiguous string.
// Two cases, in order: (1) the line up to the break ends in `-` or `/` -- a path or hyphenated
// identifier continuation (`doc/state-machine-` + `spec.md:49`) -- joined with NO inserted
// character, after stripping any `//`/`*`/`#` comment leader the continuation line starts with;
// (2) every other line break, collapsed to a single space (safe: a citation never legitimately
// contains a literal space, so this can only ever help a match, never manufacture a false one).
function normalizeWrap(src) {
  let text = src.replace(/([-/])\r?\n[ \t]*(?:\/\/|\*(?!\/)|#)?[ \t]*/g, '$1');
  text = text.replace(/[ \t]*\r?\n[ \t]*(?:\/\/|\*(?!\/)|#)?[ \t]*/g, ' ');
  return text;
}

// trackedFiles(root) -- the repo's OWN tree, from git, cached per root.
//
// This replaced a recursive readdir walk that skipped only `.git` and `node_modules`, and it is
// not a tidy-up: the walk descended into NESTED GIT WORKTREES. `/home/crazz/SPO-WebClient` holds
// abandoned agent worktrees under `.claude/worktrees/<slug>/`, each a full copy of the product
// tree, and `.claude` sorts before `src`, so a bare-basename citation like `worker.ts:892`
// resolved to a MONTHS-OLD copy and was line-checked against it. That is how four dangling
// cross-repo citations passed 9.1's verification and this ratchet's own green run: the file the
// checker read was not the file the citation meant. Measured 2026-09-03, when `worker.ts:892`
// (a real line in the product's `src/e2e/bench/worker.ts`) was reported dangling because the
// worktree copy it resolved to has only 759 lines.
//
// `git ls-files` is the fix and not merely a filter: a nested worktree is not tracked by the
// parent repo, and neither are `node_modules`, `dist` or any other ignored build output, so the
// exclusion is the repo's own definition of what belongs to it rather than a denylist this file
// would have to keep in step with whatever a future tool drops on disk.
const _trackedCache = new Map();
function trackedFiles(root) {
  if (_trackedCache.has(root)) return _trackedCache.get(root);
  let list = [];
  try {
    list = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch {
    list = [];
  }
  _trackedCache.set(root, list);
  return list;
}

// findByBasename -- every tracked file whose basename matches, never just the first. An
// AMBIGUOUS basename is a defect in the citation (it does not say which file it means) and the
// caller reports it by name; silently taking the first match is what let the stale-worktree copy
// win above, and "pick one and say nothing" is the shape this whole sweep exists to remove.
function findByBasename(name, root) {
  return trackedFiles(root)
    .filter((rel) => path.basename(rel) === name)
    .map((rel) => path.join(root, rel));
}

// resolveIn(root, filePath) -> { target } | { ambiguous: [paths] } | null
function resolveIn(root, filePath) {
  if (filePath.includes('/')) {
    const target = path.join(root, filePath);
    return fs.existsSync(target) ? { target } : null;
  }
  const hits = findByBasename(filePath, root);
  if (hits.length === 0) return null;
  if (hits.length > 1) return { ambiguous: hits };
  return { target: hits[0] };
}

// resolveCitationTarget(filePath) -- E1, minimally: this repo first, then the product repo (with
// a leading "SPO-WebClient/" stripped, since prose sometimes spells the citation out with the
// repo name attached), then SPO-Deploy the same way. Returns one of:
//   { target, root: 'repo' | 'product' | 'deploy' }            -- resolved
//   { target: null, root: 'product-absent' | 'deploy-absent' } -- the repo that would be needed
//                                                                  to tell isn't on disk: this is
//                                                                  NEVER treated as a pass (see
//                                                                  the header's E1 section)
//   { target: null, root: null }                               -- resolved nowhere; dangling
function resolveCitationTarget(filePath) {
  // `ambiguous` is carried out to the caller rather than resolved here: only the caller knows the
  // citation's own text, and the offender line has to name the candidates for the maintainer to
  // pick between them. Never collapse it to a target.
  const local = resolveIn(REPO_ROOT, filePath);
  if (local && local.ambiguous) return { target: null, root: 'repo', ambiguous: local.ambiguous };
  if (local) return { target: local.target, root: 'repo' };
  const productPath = filePath.replace(/^SPO-WebClient\//, '');
  if (!fs.existsSync(PRODUCT_REPO)) return { target: null, root: 'product-absent' };
  const product = resolveIn(PRODUCT_REPO, productPath);
  if (product && product.ambiguous) return { target: null, root: 'product', ambiguous: product.ambiguous };
  if (product) return { target: product.target, root: 'product' };
  const deployPath = filePath.replace(/^SPO-Deploy\//, '');
  if (!fs.existsSync(DEPLOY_REPO)) return { target: null, root: 'deploy-absent' };
  const deploy = resolveIn(DEPLOY_REPO, deployPath);
  if (deploy && deploy.ambiguous) return { target: null, root: 'deploy', ambiguous: deploy.ambiguous };
  if (deploy) return { target: deploy.target, root: 'deploy' };
  return { target: null, root: null };
}

// extractCitations(text) -- the three shapes, merged in document order, chain matches resolved
// against the nearest preceding real citation within PROXIMITY_CHARS. `text` is expected to
// already be fence-stripped (if markdown) and normalizeWrap'd. Exported shape:
// [{ raw, file, start, stop, unanchored }], `file: null` iff `unanchored` is true.
function extractCitations(text) {
  const matches = [];
  let m;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(text))) {
    matches.push({ idx: m.index, end: m.index + m[0].length, kind: 'full', file: m[1], start: Number(m[2]), stop: Number(m[3] || m[2]) });
  }
  POSSESSIVE_LINE_RE.lastIndex = 0;
  while ((m = POSSESSIVE_LINE_RE.exec(text))) {
    matches.push({ idx: m.index, end: m.index + m[0].length, kind: 'full', file: m[1], start: Number(m[2]), stop: Number(m[2]) });
  }
  CHAIN_RE.lastIndex = 0;
  while ((m = CHAIN_RE.exec(text))) {
    const start = Number(m[1] || m[3]);
    const stop = Number(m[2] || m[4] || start);
    matches.push({ idx: m.index, end: m.index + m[0].length, kind: 'chain', start, stop });
  }
  matches.sort((a, b) => a.idx - b.idx);

  // A chain match landing inside a full/possessive match's own span is the ":N" already captured
  // by that match (e.g. the ":49" inside "spec.md:49") -- drop it, it is not a second citation.
  const filtered = matches.filter(
    (mm) => mm.kind !== 'chain' || !matches.some((o) => o.kind !== 'chain' && mm.idx >= o.idx && mm.idx < o.end)
  );

  const out = [];
  let lastFile = null;
  let lastFileEnd = -1;
  for (const mm of filtered) {
    // idx/end (the match's own character span) are carried through for part 2.5's anchor check
    // below, which needs to know WHERE in the citing text a citation sits in order to scan its
    // surrounding prose -- part 2 itself never reads these two fields.
    if (mm.kind === 'chain') {
      if (!lastFile || mm.idx - lastFileEnd > PROXIMITY_CHARS) {
        out.push({ raw: `(unanchored) :${mm.start}${mm.stop !== mm.start ? `-${mm.stop}` : ''}`, file: null, start: mm.start, stop: mm.stop, unanchored: true, idx: mm.idx, end: mm.end });
      } else {
        out.push({ raw: `${lastFile}:${mm.start}${mm.stop !== mm.start ? `-${mm.stop}` : ''}`, file: lastFile, start: mm.start, stop: mm.stop, unanchored: false, idx: mm.idx, end: mm.end });
      }
    } else {
      lastFile = mm.file;
      lastFileEnd = mm.end;
      out.push({ raw: `${mm.file}:${mm.start}${mm.stop !== mm.start ? `-${mm.stop}` : ''}`, file: mm.file, start: mm.start, stop: mm.stop, unanchored: false, idx: mm.idx, end: mm.end });
    }
  }
  return out;
}

// M17 (2026-09-03) removed 4 entries -- `orchestrator/bench-queue-wait.js :: worker.ts:129` and
// `:997`, `orchestrator/journal.js :: worker.ts:131`, `orchestrator/steps/scripted.js ::
// worker.ts:130-131` -- not because those facts stopped being checked, but because each was
// rewritten as a SYMBOL citation (`worker.ts`'s `DONE_RETENTION_MS`) that part 1.8 above now
// verifies instead. A line number is a second database that drifts on every unrelated edit to the
// cited file; the symbol its own prose already named beside the number does not.
//
// Pinned 2026-09-03, re-measured for action 9.3 (adds 3 `bin/spo:N` sites CITATION_RE could not
// see before, and 13 line-number corrections part 2.5's anchor check below found and fixed in
// passing -- see that section's header for the full list, including the two real-drift cases
// that motivated it): the exact sorted set of `${file} :: ${citation}` this corpus holds, widened
// regex + all 65 files + line-unwrap + chain resolution. Not a floor -- a citation added anywhere
// in the corpus (a real one, or a new narrative aside shaped like one) must be added HERE, by
// name, in the same change, the same way PINS's name list above works. See the test below for
// what happens when this array and the live corpus disagree.
const EXPECTED_CITATIONS = [
  "doc/bench-audit-2026-09-02.md :: (unanchored) :277",
  "doc/bench-audit-2026-09-02.md :: (unanchored) :458",
  "doc/bench-audit-2026-09-02.md :: (unanchored) :65-69",
  "doc/bench-audit-2026-09-02.md :: bin/spo:1102",
  "doc/bench-audit-2026-09-02.md :: board-take.sh:109-110",
  "doc/bench-audit-2026-09-02.md :: cli.ts:179",
  "doc/bench-audit-2026-09-02.md :: cli.ts:221-227",
  "doc/bench-audit-2026-09-02.md :: doc/state-machine-spec.md:128",
  "doc/bench-audit-2026-09-02.md :: finish.sh:275-276",
  "doc/bench-audit-2026-09-02.md :: merge-queue.ts:178-188",
  "doc/bench-audit-2026-09-02.md :: run.ts:109",
  "doc/bench-audit-2026-09-02.md :: sanctuarize.test.ts:151-156",
  "doc/bench-audit-2026-09-02.md :: scripted.js:1347",
  "doc/bench-audit-2026-09-02.md :: scripted.js:1944-1994",
  "doc/bench-audit-2026-09-02.md :: scripted.js:292-293",
  "doc/bench-audit-2026-09-02.md :: scripts/finish.sh:245-247",
  "doc/bench-audit-2026-09-02.md :: scripts/nightly-check.sh:70-73",
  "doc/bench-audit-2026-09-02.md :: src/e2e/bench/paths.ts:143-163",
  "doc/bench-audit-2026-09-02.md :: src/e2e/bench/worker.ts:482",
  "doc/bench-audit-2026-09-02.md :: src/e2e/config.ts:93",
  "doc/bench-audit-2026-09-02.md :: test/helpers.js:65-80",
  "doc/bench-audit-2026-09-02.md :: verdict.ts:162-183",
  "doc/bench-audit-2026-09-02.md :: verdict.ts:23-67",
  "doc/bench-audit-2026-09-02.md :: worker.ts:106",
  "doc/bench-audit-2026-09-02.md :: worker.ts:301",
  "doc/bench-audit-2026-09-02.md :: worker.ts:307-319",
  "doc/bench-audit-2026-09-02.md :: worker.ts:482",
  "doc/bench-audit-2026-09-02.md :: worker.ts:482-486",
  "doc/bench-audit-2026-09-02.md :: worker.ts:487",
  "doc/bench-audit-2026-09-02.md :: worker.ts:495-502",
  "doc/bench-audit-2026-09-02.md :: worker.ts:543-546",
  "doc/bench-audit-2026-09-02.md :: worker.ts:576",
  "doc/bench-audit-2026-09-02.md :: worker.ts:750",
  "doc/bench-audit-2026-09-02.md :: worker.ts:779-780",
  "doc/bench-plan-derived-2026-09-02.md :: bin/spo:1102",
  "doc/bench-plan-derived-2026-09-02.md :: board-take.sh:109-110",
  "doc/bench-plan-derived-2026-09-02.md :: cli.ts:88",
  "doc/bench-plan-derived-2026-09-02.md :: doc/state-machine-spec.md:128",
  "doc/bench-plan-derived-2026-09-02.md :: finish.sh:275-276",
  "doc/bench-plan-derived-2026-09-02.md :: orchestrator/steps/scripted.js:292-293",
  "doc/bench-plan-derived-2026-09-02.md :: sanctuarize.test.ts:151-156",
  "doc/bench-plan-derived-2026-09-02.md :: scripts/finish.sh:245-247",
  "doc/bench-plan-derived-2026-09-02.md :: scripts/nightly-check.sh:70-73",
  "doc/bench-plan-derived-2026-09-02.md :: src/e2e/config.ts:93",
  "doc/bench-plan-derived-2026-09-02.md :: test/helpers.js:65-80",
  "doc/bench-plan-derived-2026-09-02.md :: worker.ts:301",
  "doc/board-audit.md :: config.js:764",
  "doc/board-audit.md :: orchestrator/steps/scripted.js:1295",
  "doc/board-audit.md :: report-intake.js:29",
  "doc/state-machine-spec.md :: bin/spo:1067",
  "doc/state-machine-spec.md :: dispatcher.js:485-499",
  "doc/state-machine-spec.md :: intake.js:747-749",
  "orchestrator/README.md :: .claude/hooks/context-router.sh:117",
  "orchestrator/README.md :: .claude/settings.json:109-127",
  "orchestrator/README.md :: account-lease.js:156",
  "orchestrator/README.md :: config.js:658",
  "orchestrator/README.md :: dispatcher.js:485-499",
  "orchestrator/README.md :: doc/state-machine-spec.md:140",
  "orchestrator/README.md :: intake.js:747-749",
  "orchestrator/README.md :: lock.js:255",
  "orchestrator/README.md :: lock.js:257-288",
  "orchestrator/README.md :: lock.js:289",
  "orchestrator/bench-queue-wait.js :: SPO-WebClient/src/e2e/bench/job.ts:325",
  "orchestrator/config.js :: worker.ts:1535",
  "orchestrator/invariants.js :: doc/state-machine-spec.md:140",
  "orchestrator/invariants.js :: relative/path/to/file.ts:123",
  "orchestrator/park-loop.js :: doc/remediation-plan-2026-08.md:202",
  "orchestrator/park-loop.js :: doc/remediation-progress.md:649",
  "orchestrator/park-loop.js :: intake.js:747-749",
  "orchestrator/state-machine.js :: run.ts:63",
  "orchestrator/steps/llm.js :: intake.js:747-749",
  "orchestrator/steps/scripted.js :: run.ts:63",
  "orchestrator/steps/scripted.js :: verify-gate.js:308",
  "orchestrator/steps/scripted.js :: verify-gate.js:342",
  "orchestrator/steps/scripted.js :: worker.ts:1535",
  "prompts/README.md :: plan.md:103",
];

test('every file:line citation in the 65-file corpus resolves, or is on the named allowlist', () => {
  // Immediate, named diagnosis if a file is added to or dropped from CORPUS_FILES without
  // updating this pin -- the EXPECTED_CITATIONS deepEqual below would also catch it (every
  // citation that file held would vanish from `found`), but that failure reads as "which
  // citations changed," not "the corpus scope itself changed." Checked first so the more likely
  // cause is named up front.
  assert.equal(CORPUS_FILES.length, 66, 'CORPUS_FILES gained or lost a file -- update the pinned list (and its own comment) in the same change, by name.');

  const found = [];
  for (const rel of CORPUS_FILES) {
    const raw = read(rel);
    const withoutFences = rel.endsWith('.md') ? stripFences(raw) : raw;
    const normalized = normalizeWrap(withoutFences);
    for (const c of extractCitations(normalized)) {
      found.push({ rel, ...c });
    }
  }

  const foundKeys = found.map((c) => `${c.rel} :: ${c.raw}`).sort();

  // FINDING (this action): a numeric floor cannot say WHICH citation died, added, or drifted --
  // gate C7's own history and this suite's E18 finding are both about exactly that failure mode.
  // deepEqual against the exact pinned set fails by NAME (assert.deepEqual's own diff) the moment
  // a single citation is added, removed, or reworded anywhere in the 65-file corpus.
  assert.deepEqual(
    foundKeys,
    EXPECTED_CITATIONS,
    'the corpus\'s citation set changed -- a citation was added, removed, or reworded. Update ' +
      'EXPECTED_CITATIONS in the same change, by name, after confirming the new/changed citation ' +
      'actually resolves (or belongs on CITATION_ALLOWLIST, with its own reason).'
  );

  const offenders = [];
  const repoAbsentOffenders = [];
  for (const c of found) {
    const key = `${c.rel} :: ${c.raw}`;
    if (isCitationAllowlisted(CITATION_ALLOWLIST, c.rel, c.raw)) continue;
    if (c.unanchored) {
      offenders.push(`${key} -- unanchored chain continuation, no real citation within ${PROXIMITY_CHARS} chars before it`);
      continue;
    }
    const resolved = resolveCitationTarget(c.file);
    if (resolved.root === 'product-absent') {
      repoAbsentOffenders.push(`${key} -- does not resolve in this repo, and ${PRODUCT_REPO} is not on disk to check further (E1: never a silent pass)`);
      continue;
    }
    if (resolved.root === 'deploy-absent') {
      repoAbsentOffenders.push(`${key} -- does not resolve in this repo or the product repo, and ${DEPLOY_REPO} is not on disk to check further (E1: never a silent pass)`);
      continue;
    }
    if (resolved.ambiguous) {
      offenders.push(
        `${key} -- ambiguous basename: ${resolved.ambiguous.length} tracked files in the ` +
          `${resolved.root} repo share it (${resolved.ambiguous.join(', ')}). Cite a path, not a ` +
          `bare filename -- picking one silently is how a citation gets line-checked against the ` +
          `wrong file.`
      );
      continue;
    }
    if (!resolved.target) {
      offenders.push(`${key} -- not found in this repo, ${PRODUCT_REPO}, or ${DEPLOY_REPO}`);
      continue;
    }
    const lineCount = fs.readFileSync(resolved.target, 'utf8').split('\n').length;
    if (c.stop > lineCount) {
      offenders.push(`${key} -- ${resolved.root} file ${resolved.target} has only ${lineCount} lines`);
    }
  }

  assert.deepEqual(
    repoAbsentOffenders,
    [],
    `citation(s) this ratchet could not verify because a cross-repo dependency is missing from ` +
      `disk -- this is a setup problem, never a silent pass (E1):\n  ${repoAbsentOffenders.join('\n  ')}`
  );
  assert.deepEqual(
    offenders,
    [],
    `dangling citation(s), not on CITATION_ALLOWLIST:\n  ${offenders.join('\n  ')}`
  );
});

// ---- fixture tests: normalizeWrap / extractCitations, exercised against synthetic strings so
// this scanner stays provably correct independent of what the real corpus happens to say today.
// Same rationale as no-real-spawn-sweep.test.js's own fixture block.

test('normalizeWrap: a hyphen-wrapped identifier reads as one contiguous string', () => {
  const src = ['// see doc/state-machine-', '// spec.md:49 for the invariant'].join('\n');
  const normalized = normalizeWrap(src);
  assert.match(normalized, /doc\/state-machine-spec\.md:49/);
  // Mutation proof: a no-op normalizeWrap must leave the wrap broken (the citation regex would
  // then only ever see the truncated "spec.md:49", never the real path).
  assert.doesNotMatch(src, /doc\/state-machine-spec\.md:49/);
});

test('normalizeWrap: an ordinary prose wrap (no trailing hyphen/slash) still collapses to a single space, never a false join', () => {
  const src = ['// this sentence wraps normally', '// right here, not at a path'].join('\n');
  const normalized = normalizeWrap(src);
  // The leading "// " on the FIRST line is untouched (only a line break's own comment leader is
  // ever stripped, by design -- normalizeWrap joins wrap points, it does not blank comments).
  assert.equal(normalized, '// this sentence wraps normally right here, not at a path');
});

test('extractCitations: a full citation establishes the file a later bare chain resolves against', () => {
  const text = 'see `account-lease.js:156` -> `lock.js:255` acquireShortLock -> `:289` tryCreate';
  const cites = extractCitations(text);
  const raws = cites.map((c) => c.raw);
  assert.deepEqual(raws, ['account-lease.js:156', 'lock.js:255', 'lock.js:289']);
  assert.equal(cites[2].file, 'lock.js', 'the bare `:289` chain must resolve against the nearest preceding file, lock.js, not account-lease.js');
});

test('extractCitations: a bare chain with no real citation within range is reported unanchored, never mis-attributed', () => {
  const farAway = 'x'.repeat(PROXIMITY_CHARS + 50);
  const text = `\`worker.ts:106\` ${farAway} \`:576\``;
  const cites = extractCitations(text);
  const chain = cites.find((c) => c.raw.includes('576'));
  assert.equal(chain.unanchored, true, 'a chain match beyond PROXIMITY_CHARS must not silently attach to a distant earlier citation');
  assert.equal(chain.file, null);
});

test('extractCitations: the possessive "(line N)" shape is extracted with its filename', () => {
  const text = "SPO-WebClient/src/e2e/bench/job.ts's `purgeDone` (line 217) rmSync's the report";
  const cites = extractCitations(text);
  assert.deepEqual(cites.map((c) => c.raw), ['SPO-WebClient/src/e2e/bench/job.ts:217']);
});

// ---- M-2026-09-03: the resolver used to read the WRONG FILE, silently.
//
// findByBasename walked the tree with readdirSync and returned the first basename match, skipping
// only `.git` and `node_modules`. `/home/crazz/SPO-WebClient` carries abandoned agent worktrees
// under `.claude/worktrees/<slug>/`, each a whole copy of the product tree, and `.claude` sorts
// before `src` -- so `worker.ts:892` resolved to a months-old copy with 759 lines and was
// line-checked against THAT. Four cross-repo citations were stale in the corpus while this sweep
// ran green, including two the sweep's own EXPECTED_CITATIONS had pinned as verified.
//
// These two tests are hermetic (a throwaway git repo in tmpdir), so they pin the resolver's
// contract rather than whatever happens to be on this machine's disk today.
function makeFixtureRepo(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-citation-resolver-'));
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '-A']);
  return root;
}

test('findByBasename: a copy inside a NESTED WORKTREE never shadows the repo\'s own tracked file', () => {
  // The nested copy is present on disk and is NOT tracked -- exactly the shape of an abandoned
  // `.claude/worktrees/<slug>/` checkout. It also sorts first, which is what made the old
  // readdir walk pick it.
  const root = makeFixtureRepo({ 'src/e2e/bench/worker.ts': 'export const real = 1;\n' });
  const shadow = path.join(root, '.claude/worktrees/stale/src/e2e/bench/worker.ts');
  fs.mkdirSync(path.dirname(shadow), { recursive: true });
  fs.writeFileSync(shadow, 'export const stale = 1;\n');
  _trackedCache.delete(root);

  const hits = findByBasename('worker.ts', root);
  assert.deepEqual(
    hits,
    [path.join(root, 'src/e2e/bench/worker.ts')],
    'the untracked nested-worktree copy leaked into resolution -- a citation would be line-checked against the wrong file'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveIn: an ambiguous basename is reported as ambiguous, never silently resolved to the first match', () => {
  const root = makeFixtureRepo({
    'src/e2e/config.ts': 'export const a = 1;\n',
    'src/shared/config.ts': 'export const b = 2;\n',
  });
  _trackedCache.delete(root);

  const resolved = resolveIn(root, 'config.ts');
  assert.ok(resolved && resolved.ambiguous, 'a basename shared by two tracked files must not resolve to one of them');
  assert.deepEqual(resolved.ambiguous.map((f) => path.relative(root, f)).sort(), ['src/e2e/config.ts', 'src/shared/config.ts']);
  assert.equal(resolved.target, undefined, 'ambiguous resolution must carry no target -- a target is what a caller line-checks against');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveCitationTarget: resolves a local repo path before ever trying the product repo', () => {
  const resolved = resolveCitationTarget('orchestrator/config.js');
  assert.equal(resolved.root, 'repo');
});

test('resolveCitationTarget: an absent product repo is reported as product-absent, never as a silent dangling/pass', () => {
  const savedEnv = process.env.SPO_PRODUCT_REPO;
  // Point PRODUCT_REPO-shaped resolution at a path that cannot exist -- re-require the module in
  // isolation is not worth it for one env var; instead exercise resolveIn/fs.existsSync directly
  // via a path guaranteed absent, proving the underlying primitive this function is built from.
  const bogusRoot = path.join(os.tmpdir(), `spo-citation-sweep-absent-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(bogusRoot), false, 'fixture precondition: bogusRoot must not exist');
  assert.equal(resolveIn(bogusRoot, 'anything.ts'), null);
  if (savedEnv === undefined) delete process.env.SPO_PRODUCT_REPO;
  else process.env.SPO_PRODUCT_REPO = savedEnv;
});

// ---- part 2.5: citation ANCHOR check (E18 residual, action 9.3) -------------------------------
//
// Part 2 above only ever asked "does this file have this many lines" -- `c.stop > lineCount`.
// It never asked whether line N *says* what the citation claims. That is invisible-by-design to
// a bounds check: a citation can drift by any number of lines, in any direction, through any
// unrelated edit, and stay "resolved" forever as long as the file is still long enough. Two
// confirmed cases, both silently passed by part 2 the whole time it ran:
//
//   - `run.ts:64` -- SPO-WebClient PR #646 deleted a call above it, so the `status: 'BLOCKED'`
//     assignment this corpus's five citations mean moved to line 63. Fixed here (both pipeline
//     sites now read `:63`) after this check caught it -- see the mutation-proof canary below,
//     which reverts the fix in memory and proves the check reds on the original bug.
//   - `bin/spo:1090-1093` -- drifted to :1137 through unrelated edits over the life of the file.
//     CITATION_RE could not even SEE this one before this action (`bin/spo` has no extension);
//     widening it (see that constant, above) is what let this check find it at all. Fixed here
//     (both dated-record sites now read `:1102` -- `:1137` when this was written; project-2 card
//     #476 moved `collectAll`'s call site again, and the same check caught it again)
//     -- also proven via mutation-proof canary below.
//
// Widening the resolver (E1, the fix that made part 2 read the real product tree instead of a
// stale nested worktree) plus THIS check together found nine more real, live drifts while this
// action was measured against the pinned corpus -- none hypothetical, all confirmed by reading
// the current target line and fixed in passing, the same "unambiguous fix, per this action's own
// brief" posture E5/E6/E12 already used in part 1.8/1.75/1.9: `config.js:615` (should be `:658`,
// `productRepo`), `doc/state-machine-spec.md:98`/`:49` (two citations, both should be `:140`, the
// CHECK row's own "invariant substring check" promise), `worker.ts:689`'s chain continuation
// (should be `:922`, `purgeDone`'s real call site), `worker.ts:892` (should be `:1169`, the real
// `SIGTERM` handler -- cited twice), `worker.ts:108`/`:110`/`:109-110` (each one line short of
// the real `DONE_RETENTION_MS`/`MAX_LEASE_MINUTES`/`DEFAULT_LEASE_MINUTES` declarations),
// `doc/remediation-plan-2026-08.md:186` and `doc/remediation-progress.md:647` (both two lines
// short of the real "DIAGNOSE" row/paragraph they cite), `step-contracts.js:108` (should be
// `:99`, the comment block that actually states the IMPLEMENT/VALIDATE-not-PLAN escalation rule),
// and `doc/board-audit.md`'s own two: `orchestrator/steps/scripted.js:937` (should be `:1295`,
// the real `npm run board:take` spawn site) and `config.js:711` (should be `:764`, the real
// `reportIntakeColumn` default).
//
// ---- the rule -----------------------------------------------------------------------------------
//
// For a citation `<file>:<line>`, extract CANDIDATE IDENTIFIERS from the same prose (a window of
// `ANCHOR_WIN` characters around the citation in the CITING text, clipped at the nearest
// NEIGHBOURING citation that names a DIFFERENT file -- so a dense paragraph citing three files in
// three sentences never lets file A's candidates leak into file B's citation; a neighbour citing
// the SAME file is not a clip point, since a chain continuation like "worker.ts:108, called at
// :922" is one fact about one file, not two). Candidates are ranked by character distance from
// the citation match in the SOURCE text (nearest-in-the-sentence first) and the nearest TWO are
// checked (`ANCHOR_TOPK`) against the RESOLVED file: does the candidate appear within the
// candidate's own tolerance of the cited line range?
//
// That tolerance is ZERO, for every candidate kind: the candidate must appear INSIDE the cited
// line range itself. This is the second answer this section has given to that question, and the
// first one's failure is the reason the rule is now stated as a property instead of a ranking.
//
// The original rule made tolerance PER CANDIDATE KIND -- 0 for 'const'/'file' (a value sitting AT
// the cited line), `ANCHOR_LOOSE_N` (5) lines for 'camel'/'snake' (a DECLARATION near it, allowing
// for a multi-line signature or a leading comment) -- and accepted a citation when EITHER of the
// two nearest candidates matched within ITS OWN tolerance. That `.some()` over mixed tolerances
// let the LOOSEST candidate decide: an 11-line acceptance band, and no way to tell "this line"
// from "the line next to it".
//
// It nevertheless caught the historical `run.ts:64` bug, and the reason it did was an accident of
// somebody else's file layout, not a property of the rule. `BLOCKED` (zero tolerance) sat exactly
// on line 63 while `runLive` sat 12 lines away, outside its own loose band -- so the strict
// candidate was the only one voting, and it discriminated. `runLive` has since MOVED ONTO line 63
// (SPO-WebClient deleted the live-run rate limiter above it) and `BLOCKED` has moved down to 75.
// The same citation now anchors on `runLive` at exactly 63 -- but under a 5-line band, `:64`
// anchors on it just as happily, and the one-line drift this whole section exists to catch went
// invisible. The mutation-proof canary below went red and stayed red: it was not a broken test,
// it was the rule's real granularity finally being reported instead of masked.
//
// So the band was measured rather than re-tuned. Sweeping the loose tolerance 5 -> 0 over the
// whole anchor corpus moved NOTHING: 0 offenders at every value of N from 5 down to 0, with
// `anchored` flat at 22 throughout. Every one of the 22 anchored citations has a top-ranked
// candidate ON a line inside its own cited range; not one of them was living on the slack. The
// tolerance was buying zero anchors and costing the entire one-line discrimination, so it is
// gone. `kindN` is gone with it -- a knob whose only safe value is 0 is a footgun, not a knob.
//
// Measured twice, on two different corpora, because the corpus moved underneath this change while
// it sat unmerged: 22 anchored / 3 unanchorable / 0 offenders at every N on 2026-09-03, and
// 22 anchored / 2 unanchorable / 0 offenders at every N on 2026-09-04, after #109 deleted the
// unfireable `escalateFlag` and with it prompts/README.md's `step-contracts.js:99` citation. The
// `unanchorable` move is #109's, not this change's -- removing a citation cannot alter what a
// tolerance band accepts -- and the sweep's own result is unchanged by it: the band is still
// buying zero anchors. The second measurement is a re-run, not the first one with a digit edited.
//
// What this buys, measured below and not asserted: the check now discriminates a one-line drift
// on the REAL files for the citation that motivated it, via `runLive` itself, with no dependence
// on where SPO-WebClient happens to put `BLOCKED` this week. And the discrimination is no longer
// proven by ONE canary that a product-side edit can silently retire -- the corpus-wide +/-1
// mutation test below re-derives it for every single-line citation in the corpus, every run, and
// pins by name the ones that genuinely cannot discriminate.
//
// A cross-file "'file' mention" candidate exists for exactly one shape this corpus needed: prose
// that names a DIFFERENT file as what the cited line reaches into ("`console/collect.js`, reached
// from `bin/spo:N`") rather than naming a symbol. It is matched by SUBSTRING (not a `\b`-bounded
// identifier match), since the real call site is typically a camelCase name DERIVED from the
// mentioned file's stem (`collect.js` -> `collectAll`), not the stem verbatim -- and it is used
// ONLY as a fallback, when no ordinary identifier candidate exists nearby at all: letting it
// compete on equal footing with real identifiers let an UNRELATED file mentioned in passing
// (`park-loop.js`'s own comment mentions `state-machine.js` while citing a completely different
// fact in `doc/remediation-plan-2026-08.md`) outrank the real, if more distant, identifier -- a
// measured false positive this posture removes.
//
// ---- what this check still cannot see, stated plainly (the chantier's own recurring lesson) ----
//
//   1. A drift is invisible whenever the candidate that anchors the citation ALSO appears on the
//      drifted-to line. Zero tolerance removes the systematic version of this (the old 11-line
//      band, which made every 'camel'/'snake' anchor blind to +/-1 by construction) but not the
//      incidental version: a common identifier that genuinely occurs on two adjacent lines
//      anchors both of them. This is no longer a comment asking to be trusted -- the corpus-wide
//      +/-1 mutation test below MEASURES it every run, classifies each single-line citation as
//      discriminating or blunt, and pins both counts by name, so the blunt population cannot grow
//      in silence any more than `unanchorable` can.
//   1b. Ranges are blunt by construction and are excluded from that measurement: shifting
//      `:257-288` by one line leaves a 32-line window that still contains the same identifier.
//      A range citation is bounds-checked and content-anchored, never line-discriminated.
//   2. Only ONE class of "no identifier named" citation is handled (the cross-file mention). A
//      citation whose true subject is a QUOTED STRING that is not CONST_CASE-shaped, a numeric
//      literal, or a purely structural/prose description (E1's "capability-question variant", a
//      real citation this action leaves on the allowlist below for exactly this reason) has no
//      candidate at all and is reported UNANCHORABLE -- correctly not failed, but also not
//      verified. It passes on trust, same as before this action.
//   3. Two candidates ranked by SOURCE-text proximity can both be wrong for the SAME reason a
//      human skim-reads past this bug class: a paragraph that discusses TWO related functions or
//      files close together can rank the wrong one first. The clip-at-neighbouring-citation rule
//      closes the worst version of this (a citation's own candidates leaking from an ADJACENT
//      citation's sentence), but two candidates for the SAME citation can still be mis-ordered
//      within one un-clipped span -- `account-lease.js:156`, `dispatcher.js:485-499`, and
//      `verify-gate.js:308` on CITATION_ANCHOR_ALLOWLIST below are exactly this: a real, nearby
//      identifier that turned out to belong to a different clause than the one being cited, not a
//      wrong citation. Every one was read by hand and reasoned about below, not assumed.
//   4. Excludes `doc/bench-audit-2026-09-02.md` and `doc/bench-plan-derived-2026-09-02.md` (see
//      ANCHOR_EXCLUDED_FILES below) -- their own citations are still bounds/dangling-checked by
//      part 2, unchanged, just not content-anchored.

// Excluded from the ANCHOR layer only (part 2's bounds/dangling check above still covers them in
// full, unchanged): these two are DATED, point-in-time audit records, already treated specially
// by CITATION_ALLOWLIST's own historical entries above ("product file has shrunk/deleted since
// this dated record's measurement commit"). Measured directly while building this check: the
// product tree is not a fixed target even across this ONE action's own working session --
// `verdict.ts` was 167 lines when this file's CITATION_ALLOWLIST entries were written (hours
// before this section) and 422 lines when this section's own measurement ran, because other work
// landed in SPO-WebClient in between. Anchor-checking these two files' citations against
// "whatever the product tree happens to contain today" measured 22 failures, nearly all of them
// paragraphs of quoted code from a snapshot the product has since been substantially rewritten
// past -- not a wrong citation, a snapshot no longer matching a moving target, which is exactly
// the class of fact this suite's own CITATION_ALLOWLIST entries already recognize and exempt for
// these same two files. Per-fact allowlisting all 22 was rejected as disproportionate noise for a
// property these two files' own header already establishes (dated, not live); a file-level scope
// limit for the ANCHOR layer specifically -- stated here, not silent, and still fully
// bounds/dangling-checked -- was judged the honest choice. The one exception, `bin/spo:1090-1093`
// -> `:1137`, was NOT left on this exemption: it was fixed in passing (see the header above)
// because the underlying fact ("console/collect.js is reached from bin/spo") is still true today,
// just at a different line -- a stale pointer, not a stale snapshot -- and its catch is proven
// directly against the real files by the mutation-proof canary below, independent of this
// exclusion.
const ANCHOR_EXCLUDED_FILES = new Set(['doc/bench-audit-2026-09-02.md', 'doc/bench-plan-derived-2026-09-02.md']);

const ANCHOR_WIN = 150; // chars of citing prose scanned on each side, same order of magnitude as CHAIN_RE's own PROXIMITY_CHARS
const ANCHOR_TOPK = 2; // nearest-ranked candidates checked; see the run.ts:64 discussion above for why 1 is too strict and 3 adds nothing over 2 in this corpus
// No line tolerance constant: a candidate must appear INSIDE the cited range, whatever its kind.
// The old per-kind `ANCHOR_LOOSE_N` (5) was measured to buy 0 of 22 anchors and to cost the whole
// one-line discrimination -- see this section's header.

// Documentation/table-label noise: words that pass the CONST_CASE shape test (isCodeShapedIdentifier,
// part 1.8) but are, in THIS corpus's actual prose, either ordinary capitalized emphasis (MUST,
// NOT, OWN, ONE, DAY, HEAD -- the same class part 1.8's own header already found for the phantom-
// symbol check) or a markdown table's own row-label vocabulary (PLAN/IMPLEMENT/VALIDATE, the step
// names doc/state-machine-spec.md and prompts/README.md both use as literal `| PLAN |` cells --
// measured to sit adjacent to unrelated citations often enough to win the nearest-candidate rank
// without ever being the thing actually being cited) or a documentation category tag this corpus's
// own account-lease comment uses (OBSERVED/ANTICIPATED, `steps/llm.js`'s allowlist-provenance
// labels). SECOND and LLM are part 1.8's own two false-match findings, reused here for the same
// reason. Never a silent blanket -- DIAGNOSE, GATE, BLOCKED etc. are all still live candidates
// where the corpus's prose genuinely means them (see the anchored verdicts in the main test).
const ANCHOR_STOPWORDS = new Set([
  'NOT', 'MUST', 'OWN', 'ONE', 'DAY', 'HEAD', 'PLAN', 'LLM', 'SECOND', 'OBSERVED', 'ANTICIPATED', 'IMPLEMENT', 'VALIDATE',
]);

// Anchor-check-local widening of part 1.8's isCodeShapedIdentifier: also accepts snake_case
// (`api_error_status`) -- real vocabulary this corpus cites (API error codes, env-shaped names)
// that the phantom-symbol check's own CONST_CASE/camelCase pair does not recognize. Deliberately
// NOT folded into isCodeShapedIdentifier itself -- that function's own pinned floor (>=400 checked
// citations, part 1.8) is a property of ITS regex family, not this one, and widening it here would
// risk perturbing a check this action does not otherwise touch.
function isAnchorCandidateIdentifier(ident) {
  if (isCodeShapedIdentifier(ident)) return true;
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(ident);
}

function candidateKind(ident) {
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(ident)) return 'const';
  return /[a-z][A-Z]/.test(ident) ? 'camel' : 'snake';
}

// extractAnchorCandidates -- identifier candidates in a window around one citation's own match
// span, ranked nearest-first by character distance in the CITING text. `clipFrom`/`clipTo` (from
// the caller, the nearest NEIGHBOURING citation naming a different file) bound the window so a
// dense paragraph citing several files never lets one citation's candidates leak from another's
// sentence -- the exact contamination `park-loop.js`'s own "this and its two state-machine.js
// sibling comments" aside caused before this clip existed (see part 2.5's header, finding 3).
function extractAnchorCandidates(normalizedText, idx, end, clipFrom, clipTo) {
  const from = Math.max(0, idx - ANCHOR_WIN, clipFrom == null ? 0 : clipFrom);
  const to = Math.min(normalizedText.length, end + ANCHOR_WIN, clipTo == null ? normalizedText.length : clipTo);
  const window = normalizedText.slice(from, to);
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  const cands = [];
  const seen = new Map();
  while ((m = re.exec(window))) {
    const ident = m[0];
    if (!isAnchorCandidateIdentifier(ident) || ANCHOR_STOPWORDS.has(ident)) continue;
    const absPos = from + m.index;
    // Reject a match glued to a hyphen on either side ("SPO"/"WebClient" out of "SPO-WebClient")
    // -- a real code identifier is never hyphen-adjacent; a proper-noun fragment is not a candidate.
    if (normalizedText[absPos - 1] === '-' || normalizedText[absPos + ident.length] === '-') continue;
    const dist = absPos < idx ? idx - (absPos + ident.length) : absPos >= end ? absPos - end : 0;
    const existing = seen.get(ident);
    if (!existing || dist < existing.dist) seen.set(ident, { ident, dist, kind: candidateKind(ident) });
  }
  return [...seen.values()].sort((a, b) => a.dist - b.dist);
}

// A cross-file mention near the citation ("`console/collect.js`, reached from `bin/spo:N`") --
// FALLBACK ONLY (the main test below only calls this when extractAnchorCandidates found nothing),
// matched by substring against the target window rather than a `\b`-bounded identifier match,
// since the real call site is typically a camelCase name DERIVED from the mentioned file's stem
// (`collect.js` -> `collectAll`), not the stem verbatim. Restricted to a file other than the
// citation's own target -- this must never compete with same-file identifier anchoring, where
// "worker" as a bare substring would trivially match almost anywhere in worker.ts.
const FILE_MENTION_RE = /`?([A-Za-z0-9_-]+)\.(?:js|ts)`?(?!:\d)/g;
function extractFileMentionCandidates(normalizedText, idx, end, clipFrom, clipTo, ownFile) {
  const from = Math.max(0, idx - ANCHOR_WIN, clipFrom == null ? 0 : clipFrom);
  const to = Math.min(normalizedText.length, end + ANCHOR_WIN, clipTo == null ? normalizedText.length : clipTo);
  const window = normalizedText.slice(from, to);
  const ownStem = path.basename(ownFile).replace(/\.(?:js|ts)$/, '');
  FILE_MENTION_RE.lastIndex = 0;
  let m;
  const cands = [];
  const seen = new Set();
  while ((m = FILE_MENTION_RE.exec(window))) {
    const stem = m[1];
    if (stem === ownStem || seen.has(stem)) continue;
    seen.add(stem);
    const absPos = from + m.index;
    const dist = absPos < idx ? idx - (absPos + m[0].length) : absPos >= end ? absPos - end : 0;
    cands.push({ ident: stem, dist, kind: 'file', substring: true });
  }
  return cands.sort((a, b) => a.dist - b.dist);
}

// mergedCandidates -- identifier candidates first; file-mention candidates ONLY as a fallback
// when no identifier was found at all (see extractFileMentionCandidates's own header).
function mergedCandidates(normalizedText, idx, end, clipFrom, clipTo, ownFile) {
  const idents = extractAnchorCandidates(normalizedText, idx, end, clipFrom, clipTo);
  if (idents.length > 0) return idents;
  return extractFileMentionCandidates(normalizedText, idx, end, clipFrom, clipTo, ownFile);
}

// candidateFoundNear -- zero tolerance, every kind: the candidate must appear INSIDE the cited
// line range, never on a neighbouring line. `kind` survives only for the offender message and for
// the substring-vs-word-boundary rule ('file' mentions match by substring); it no longer widens
// the window for anybody. See this section's header for the measurement that removed the band.
function candidateFoundNear(cand, targetPath, startLine, stopLine) {
  const lines = fs.readFileSync(targetPath, 'utf8').split('\n');
  const windowText = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, stopLine)).join('\n');
  return cand.substring ? windowText.includes(cand.ident) : new RegExp(`\\b${cand.ident}\\b`).test(windowText);
}

// CITATION_ANCHOR_ALLOWLIST -- per-fact, same posture and same `${file} :: ${citation}` keying as
// CITATION_ALLOWLIST above (isCitationAllowlisted, reused verbatim). Every entry here is a citation
// this action READ BY HAND and confirmed correct -- the nearest-ranked candidate the heuristic
// picked belongs to a DIFFERENT clause in the same paragraph, not to the cited line, which is
// exactly finding 3 in this section's header ("what this check still cannot see").
const CITATION_ANCHOR_ALLOWLIST = {
  // "...the same write-tmp-then-`linkSync` `tryCreate` daemon.lock uses too (`account-lease.js:156`
  // -> `lock.js:255` `acquireShortLock` -> `:289` `tryCreate`)": `tryCreate`/`linkSync` describe
  // `lock.js`'s daemon.lock idiom BY ANALOGY, two citations away in the same sentence -- not
  // account-lease.js:156's own content (`tryAcquireLease`'s closing brace, genuinely unnamed in
  // this prose). Confirmed correct: line 156 is exactly where `tryAcquireLease`
  // (orchestrator/account-lease.js) calls `lock.acquireShortLock` and closes.
  'orchestrator/README.md :: account-lease.js:156':
    "nearest candidate ('tryCreate'/'linkSync') belongs to an earlier analogy about lock.js's " +
    "daemon.lock idiom, not to this citation's own content -- confirmed correct by hand: line " +
    '156 is where tryAcquireLease calls lock.acquireShortLock and closes.',
  // "...a worker killed during the dispatcher's OWN shutdown (... `dispatcher.js:485-499`) and any
  // owning daemon process that simply never comes back to run `handleExit` at all...": `handleExit`
  // is the SECOND clause's subject (the daemon-never-returns case, uncited), not the first
  // (dispatcher.js:485-499, the worker-killed-during-shutdown case this citation actually names).
  // Confirmed correct: lines 485-499 are exactly the `worker-exit-during-shutdown` handling this
  // prose describes.
  'orchestrator/README.md :: dispatcher.js:485-499':
    "nearest candidate ('handleExit') is the SUBJECT OF THE NEXT CLAUSE in the same sentence (a " +
    "daemon that never runs handleExit at all), not of this citation -- confirmed correct by " +
    'hand: lines 485-499 are the worker-exit-during-shutdown handling this prose actually names.',
  // "...other BLOCKED -- world lock, rate limit, or `verify-gate.js:308`'s capability-question
  // variant, where `required` can be empty...": the true subject is a PROSE PHRASE
  // ("capability-question variant"), not a code-shaped identifier -- `BLOCKED`/`GATE` are
  // incidental nearby words, not this citation's own content. Confirmed correct: line 308 sits at
  // the Stage 2 (capabilities) / Stage 3 (routing) boundary this "capability-question" prose
  // describes.
  'orchestrator/steps/scripted.js :: verify-gate.js:308':
    "no code-shaped candidate names this citation's true subject (a prose phrase, " +
    "'capability-question variant', not an identifier) -- 'BLOCKED'/'GATE' are incidental nearby " +
    'words. Confirmed correct by hand: line 308 sits at the Stage 2/Stage 3 boundary this prose describes.',
};

function isAnchorAllowlisted(rel, raw) {
  return isCitationAllowlisted(CITATION_ANCHOR_ALLOWLIST, rel, raw);
}

test('CITATION_ANCHOR_ALLOWLIST holds exactly the entries this action explicitly justified -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(CITATION_ANCHOR_ALLOWLIST).sort(),
    [
      'orchestrator/README.md :: account-lease.js:156',
      'orchestrator/README.md :: dispatcher.js:485-499',
      'orchestrator/steps/scripted.js :: verify-gate.js:308',
    ],
    'CITATION_ANCHOR_ALLOWLIST changed size or membership -- read the new/changed citation by ' +
      'hand against its target before adding an entry; this pin needs updating in the same change, by name.'
  );
});

// forEachAnchorCheckedCitation -- the ONE walk over the anchor-checked corpus, shared by the main
// anchor test and the corpus-wide +/-1 mutation test below. Deliberately one function and not two
// copies of the same twenty lines: the mutation test's whole claim is "the check discriminates one
// line for EVERY citation the check accepts", and it is only worth anything if both are looking at
// exactly the same citation set. Two hand-maintained copies would drift, and the drift would show
// up as the mutation test quietly measuring a smaller corpus than the one being enforced.
//
// Yields, per citation that survives part 2's own filters (allowlisted, unresolvable, ambiguous
// and out-of-bounds citations are part 2's to report, never this layer's to re-litigate):
//   { rel, key, c, resolved, lineCount, top }   -- `top` is the ANCHOR_TOPK nearest candidates,
// empty iff the citation is UNANCHORABLE (no code-shaped candidate named anywhere nearby).
function forEachAnchorCheckedCitation(anchorCorpus, fn) {
  for (const rel of anchorCorpus) {
    const raw = read(rel);
    const withoutFences = rel.endsWith('.md') ? stripFences(raw) : raw;
    const normalized = normalizeWrap(withoutFences);
    const cites = extractCitations(normalized).filter((c) => !c.unanchored);
    for (let i = 0; i < cites.length; i++) {
      const c = cites[i];
      if (isCitationAllowlisted(CITATION_ALLOWLIST, rel, c.raw)) continue; // part 2's own offenders are not this check's to re-litigate
      const resolved = resolveCitationTarget(c.file);
      if (!resolved.target || resolved.ambiguous) continue; // part 2 already reports these; this check only ever narrows a citation part 2 accepted
      const lineCount = fs.readFileSync(resolved.target, 'utf8').split('\n').length;
      if (c.stop > lineCount) continue; // ditto -- part 2's own bounds offender
      if (isAnchorAllowlisted(rel, c.raw)) continue;

      const prevC = i > 0 ? cites[i - 1] : null;
      const nextC = i < cites.length - 1 ? cites[i + 1] : null;
      const clipFrom = prevC && prevC.file !== c.file ? prevC.end : null;
      const clipTo = nextC && nextC.file !== c.file ? nextC.idx : null;

      const candidates = mergedCandidates(normalized, c.idx, c.end, clipFrom, clipTo, c.file);
      fn({ rel, key: `${rel} :: ${c.raw}`, c, resolved, lineCount, top: candidates.slice(0, ANCHOR_TOPK) });
    }
  }
}

test('every anchorable file:line citation in the anchor-checked corpus points at a line whose own prose names something actually there', () => {
  const anchorCorpus = CORPUS_FILES.filter((rel) => !ANCHOR_EXCLUDED_FILES.has(rel));
  // Named floor, not a silent "no exclusions happened": if a future edit to CORPUS_FILES or
  // ANCHOR_EXCLUDED_FILES drops this to 2 or fewer, that is exactly the two dated docs swallowing
  // the whole corpus (or a mis-typed exclusion) and this fails loudly instead of quietly checking nothing.
  assert.equal(anchorCorpus.length, CORPUS_FILES.length - ANCHOR_EXCLUDED_FILES.size, 'ANCHOR_EXCLUDED_FILES no longer matches exactly two CORPUS_FILES entries by name.');

  const offenders = [];
  let anchored = 0;
  let unanchorable = 0;
  forEachAnchorCheckedCitation(anchorCorpus, ({ key, c, resolved, top }) => {
    if (top.length === 0) { unanchorable += 1; return; }
    if (top.some((cand) => candidateFoundNear(cand, resolved.target, c.start, c.stop))) { anchored += 1; return; }
    offenders.push(
      `${key} -- none of [${top.map((cand) => `${cand.ident}/${cand.kind}`).join(', ')}] found ` +
        `ON ${resolved.target}:${c.start}${c.stop !== c.start ? `-${c.stop}` : ''} itself (zero line tolerance)`
    );
  });

  // Re-measured 2026-09-03 after M17's symbol-citation conversion: 22 verified (was 26), 3
  // unanchorable (unchanged then; 2 since 2026-09-04 -- see the note on the pin itself below). The 4 that left the anchored set are the 4 line-number citations
  // converted to symbol citations in the same change -- `worker.ts:129`/`:997`/`:131`/`:130-131`
  // -- each now checked by part 1.8's symbol check instead, against the symbol its own prose
  // already named. They did not stop being checked; they stopped being checked BY LINE NUMBER.
  //
  // Original measurement, for the shape of the unanchorable set: 26 verified,
  // 3 unanchorable -- `orchestrator/park-loop.js :: intake.js:747-749`, `orchestrator/steps/
  // scripted.js :: verify-gate.js:342`, and `prompts/README.md :: step-contracts.js:99` (deleted
  // by #109, leaving the two still listed here) -- each citing a
  // fact its own surrounding prose never names with a code-shaped identifier or a cross-file
  // mention -- correctly unverifiable, not wrong -- 3 on CITATION_ANCHOR_ALLOWLIST (already
  // excluded above), 0 unexplained offenders after this action's own fixes landed. Both counts
  // pinned by NAME, not by floor -- constraint 2 in this action's own brief: "cannot verify" must
  // never silently grow into an escape hatch, so the unanchorable population is capped here
  // exactly like PINS/EXPECTED_CITATIONS above.
  assert.equal(anchored, 22, `expected 22 verified anchor matches, found ${anchored} -- a citation moved between verified/unanchorable/offending; re-measure and update this pin by name.`);
  // 3 -> 2 on 2026-09-04: prompts/README.md's PLAN row cited `step-contracts.js:99` to explain an
  // "Opus 5 fallback" that could never fire (its only trigger, `task.escalate`, was set nowhere).
  // The escalation was deleted, so the row no longer makes the claim and no longer needs the
  // citation. The population SHRANK -- which is the direction this pin is happy to move in; it
  // exists to stop "cannot verify" growing.
  assert.equal(unanchorable, 2, `expected exactly 2 unanchorable citations (no code-shaped candidate named nearby) -- found ${unanchorable}. This count is pinned so "cannot verify" cannot silently grow into a way to dodge this check.`);
  assert.deepEqual(offenders, [], `citation(s) whose own prose names something NOT found near the cited line -- a drift this check exists to catch:\n  ${offenders.join('\n  ')}`);
});

// ---- part 2.6: corpus-wide +/-1 mutation proof (this action) ------------------------------------
//
// Why this exists, and why it is not just another canary. The two mutation-proof canaries at the
// end of this file each revert ONE historical drift and assert the check goes red. They are worth
// keeping -- they are the real bugs, on the real files. But a canary proves the check catches the
// mutation it names, and nothing else, and this action found out the hard way what that is worth:
// the `run.ts:63` canary went red without a single line of THIS repo changing, because
// SPO-WebClient moved `runLive` onto line 63 and `BLOCKED` off it. The canary had been passing on
// an accident of somebody else's file layout. The property it was believed to prove -- "this check
// discriminates a one-line drift" -- had quietly stopped being true for every OTHER citation in
// the corpus at the same time, and nothing said so.
//
// So the property is measured directly instead, for every citation the anchor check accepts:
// shift the cited line by one in each direction and re-run the SAME anchoring the main test runs.
// If the citation still anchors on a neighbouring line, the check cannot tell those two lines
// apart and says so, by name, here -- rather than in a comment that ages out of true.
//
// Three populations, all three pinned, summing to the main test's own `anchored` pin:
//   - DISCRIMINATING: both neighbours miss. A one-line drift would be caught.
//   - BLUNT (ANCHOR_BLUNT_CITATIONS): a neighbour still anchors. Capped by name for exactly the
//     reason `unanchorable` is capped -- "cannot discriminate" must never become a quiet escape
//     hatch. Both of today's entries are the same shape and neither is a rule defect: the anchor
//     word is genuinely on two adjacent lines of a PROSE target (a markdown table column, a
//     two-line bullet), where no line-level rule can help.
//   - RANGES: blunt by construction, excluded rather than allowlisted. Shifting `:257-288` by one
//     leaves a 32-line window still containing the same identifier; a range citation is
//     bounds-checked and content-anchored, never line-discriminated. Counted, not hidden.
const ANCHOR_BLUNT_CITATIONS = {
  // README.md: "`doc/state-machine-spec.md:140` has always promised CHECK runs an invariant
  // substring check". The target is the spec's own step TABLE, where `CHECK` is both a step name
  // and the "next state" cell of the rows above it -- lines 138, 139, 140 and 142 all contain the
  // bare word. The citation is correct (140 IS the CHECK row); no identifier-level rule can
  // separate row 139 from row 140 when the discriminating token is the table's own column value.
  'orchestrator/README.md :: doc/state-machine-spec.md:140':
    "target is a markdown step TABLE whose 'CHECK' cell spans four consecutive rows (138-140, 142) " +
    '-- the anchor word is the column value itself, so :139 anchors as well as :140. Citation ' +
    'confirmed correct by hand: 140 is the CHECK row.',
  // park-loop.js: "doc/remediation-progress.md:649 confirms the same referent under 'DIAGNOSE
  // surfacing'". Line 649 is the bullet's own heading line and 650 is its continuation, which
  // opens with the same word ("DIAGNOSE has no column..."). Correct citation, two-line bullet.
  'orchestrator/park-loop.js :: doc/remediation-progress.md:649':
    "target is a two-line prose bullet whose subject word ('DIAGNOSE') opens both 649 and its own " +
    'continuation line 650. Citation confirmed correct by hand: 649 is the bullet heading.',
};

test('ANCHOR_BLUNT_CITATIONS holds exactly the citations measured unable to discriminate one line -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(ANCHOR_BLUNT_CITATIONS).sort(),
    [
      'orchestrator/README.md :: doc/state-machine-spec.md:140',
      'orchestrator/park-loop.js :: doc/remediation-progress.md:649',
    ],
    'ANCHOR_BLUNT_CITATIONS changed size or membership -- read the new citation against its target ' +
      'by hand and justify it here before pinning it, exactly as CITATION_ANCHOR_ALLOWLIST requires.'
  );
});

test('MUTATION PROOF, corpus-wide: every single-line citation the anchor check accepts stops anchoring when its line is shifted by one', () => {
  const anchorCorpus = CORPUS_FILES.filter((rel) => !ANCHOR_EXCLUDED_FILES.has(rel));
  const discriminating = [];
  const blunt = [];
  const ranges = [];
  forEachAnchorCheckedCitation(anchorCorpus, ({ key, c, resolved, lineCount, top }) => {
    if (top.length === 0) return; // unanchorable -- the main test's own pinned population
    if (!top.some((cand) => candidateFoundNear(cand, resolved.target, c.start, c.stop))) return; // offender; the main test reports it
    if (c.start !== c.stop) { ranges.push(key); return; }

    const survives = [];
    for (const off of [-1, 1]) {
      const shifted = c.start + off;
      if (shifted < 1 || shifted > lineCount) continue; // no neighbouring line to confuse it with
      if (top.some((cand) => candidateFoundNear(cand, resolved.target, shifted, shifted))) survives.push(off > 0 ? '+1' : '-1');
    }
    if (survives.length === 0) discriminating.push(key);
    else blunt.push(`${key} -- still anchors at ${survives.join(' and ')} on [${top.map((cand) => `${cand.ident}/${cand.kind}`).join(', ')}]`);
  });

  // Measured after zero tolerance replaced the per-kind band: 15 discriminating, 2 blunt, 5 ranges.
  // The SAME measurement re-run against the old 5-line band (restored in a scratch copy, not
  // asserted from memory) reports 5 discriminating, 12 blunt, 5 ranges -- so the band was blinding
  // TEN of the seventeen single-line citations in this corpus to a one-line drift, and the only
  // five it left sharp were the ones anchored by a zero-tolerance 'const'/'file' candidate.
  // Re-run in full on 2026-09-04 against the post-#109 corpus: both halves reproduce digit for
  // digit (15/2/5 and 5/12/5). #109 removed an UNANCHORABLE citation, which never entered these
  // three populations in the first place -- they partition the ANCHORED set, and that stayed 22.
  // `run.ts:63` was among the twelve, from BOTH of its citing files. That is the honest size of
  // what the red canary was reporting: not one stale test, a corpus-wide blindness that one green
  // canary had been covering for. Re-pointing that canary at a bigger mutation would have restored
  // the green and left all ten blind.
  assert.deepEqual(
    blunt.map((b) => b.split(' -- ')[0]).sort(),
    Object.keys(ANCHOR_BLUNT_CITATIONS).sort(),
    `the set of citations that CANNOT discriminate a one-line drift changed. Every entry must be read\n  by hand and justified in ANCHOR_BLUNT_CITATIONS before being pinned -- this population is capped\n  for the same reason "unanchorable" is:\n  ${blunt.join('\n  ')}`
  );
  assert.equal(discriminating.length, 15, `expected 15 single-line citations proven to discriminate a one-line drift, found ${discriminating.length} -- re-measure and update this pin by name.`);
  assert.equal(ranges.length, 5, `expected 5 range citations (blunt by construction, see this section's header), found ${ranges.length}.`);
  // Ties this measurement to the main test's own pin: the three populations must together be
  // exactly the citations that test counted as `anchored`, or one of the two walks has drifted.
  assert.equal(discriminating.length + blunt.length + ranges.length, 22, 'the three populations must sum to the main anchor test\'s pinned `anchored` count (22).');
});

// ---- fixture tests: the anchor primitives, exercised against synthetic strings so this check
// stays provably correct independent of what the real corpus happens to say today.

test('isAnchorCandidateIdentifier: accepts snake_case in addition to isCodeShapedIdentifier\'s CONST_CASE/camelCase', () => {
  assert.equal(isAnchorCandidateIdentifier('api_error_status'), true);
  assert.equal(isAnchorCandidateIdentifier('DONE_RETENTION_MS'), true); // CONST_CASE, via isCodeShapedIdentifier
  assert.equal(isAnchorCandidateIdentifier('runLive'), true); // camelCase, via isCodeShapedIdentifier
  assert.equal(isAnchorCandidateIdentifier('lowercase'), false); // no shape at all
});

test('candidateKind: classifies CONST_CASE, camelCase and snake_case distinctly', () => {
  assert.equal(candidateKind('BLOCKED'), 'const');
  assert.equal(candidateKind('runLive'), 'camel');
  assert.equal(candidateKind('api_error_status'), 'snake');
});

test('extractAnchorCandidates: ranks the nearer identifier first, and rejects a hyphen-adjacent fragment', () => {
  const text = 'see SPO-WebClient run.ts:64 runLive returns BLOCKED soon after';
  const idx = text.indexOf('run.ts:64');
  const end = idx + 'run.ts:64'.length;
  const cands = extractAnchorCandidates(text, idx, end, null, null);
  const idents = cands.map((c) => c.ident);
  assert.ok(idents.includes('runLive'), 'runLive must be a candidate');
  assert.ok(idents.includes('BLOCKED'), 'BLOCKED must be a candidate');
  assert.equal(idents.indexOf('runLive') < idents.indexOf('BLOCKED'), true, 'runLive sits immediately after the citation and must rank nearer than BLOCKED, further away');
  assert.ok(!idents.includes('SPO'), 'SPO is a hyphen-glued fragment of SPO-WebClient, never a real candidate');
  assert.ok(!idents.includes('WebClient'), 'WebClient is a hyphen-glued fragment of SPO-WebClient, never a real candidate');
});

test('extractAnchorCandidates: a neighbouring citation to a DIFFERENT file clips the window; the SAME file does not', () => {
  const text = 'alpha.js:1 nearIdentOne beta.js:2 farIdentTwo';
  // Citing alpha.js:1's own candidate window: clipTo at beta.js:2's start (different file) must
  // exclude farIdentTwo, which belongs to the OTHER citation's own sentence.
  const idxAlpha = text.indexOf('alpha.js:1');
  const endAlpha = idxAlpha + 'alpha.js:1'.length;
  const clipTo = text.indexOf('beta.js:2');
  const candsClipped = extractAnchorCandidates(text, idxAlpha, endAlpha, null, clipTo);
  assert.ok(candsClipped.map((c) => c.ident).includes('nearIdentOne'));
  assert.ok(!candsClipped.map((c) => c.ident).includes('farIdentTwo'), 'a DIFFERENT-file neighbour must clip the window');

  // A same-file chain continuation must NOT clip -- the two mentions are one fact.
  const text2 = 'gamma.js:1 identA, called at gamma.js:2 identB';
  const idx1 = text2.indexOf('gamma.js:1');
  const end1 = idx1 + 'gamma.js:1'.length;
  // gamma.js:2 names the SAME file, so the real main-test loop passes clipTo: null here (no clip)
  const candsUnclipped = extractAnchorCandidates(text2, idx1, end1, null, null);
  assert.ok(candsUnclipped.map((c) => c.ident).includes('identA'));
});

test('extractFileMentionCandidates: matches a cross-file basename mention by substring, never the citation\'s own file', () => {
  const text = '`console/collect.js`, reached from `bin/spo:1102`, reads it by content';
  const idx = text.indexOf('bin/spo:1102');
  const end = idx + 'bin/spo:1102'.length;
  const cands = extractFileMentionCandidates(text, idx, end, null, null, 'bin/spo');
  assert.deepEqual(cands.map((c) => c.ident), ['collect']);
  assert.equal(cands[0].kind, 'file');
  assert.equal(cands[0].substring, true);

  // Own-file mention must never become a candidate for itself -- only a DIFFERENT file's mention
  // counts, since a same-file mention ("collect.js" cited from within collect.js) says nothing a
  // same-file identifier candidate wouldn't already say.
  const selfText = '`console/collect.js`\'s own logic, cited at `console/collect.js:5`';
  const idx2 = selfText.lastIndexOf('console/collect.js:5');
  const end2 = idx2 + 'console/collect.js:5'.length;
  const candsSelf = extractFileMentionCandidates(selfText, idx2, end2, null, null, 'console/collect.js');
  assert.deepEqual(candsSelf, [], 'a mention of the citation\'s own file must never become a candidate for itself');
});

test('mergedCandidates: falls back to a file-mention candidate ONLY when no identifier candidate exists', () => {
  // No identifier at all near the citation -- must fall back to the file mention.
  const noIdentText = '`console/collect.js`, reached from `bin/spo:1102`, reads it by content';
  const idx1 = noIdentText.indexOf('bin/spo:1102');
  const end1 = idx1 + 'bin/spo:1102'.length;
  const fallback = mergedCandidates(noIdentText, idx1, end1, null, null, 'bin/spo');
  assert.deepEqual(fallback.map((c) => c.ident), ['collect']);

  // An identifier candidate present -- the file mention must never compete with it (the
  // park-loop.js/state-machine.js false-positive this posture was built to close). The window
  // here genuinely contains BOTH a file mention ("state-machine.js") and a real identifier
  // ("realThing") -- proving the fallback guard actually suppresses the file mention, not merely
  // that this particular text happens to produce no file-mention candidate at all.
  const withIdentText = 'state-machine.js sibling comments mention realThing near other.md:9';
  const idx2 = withIdentText.indexOf('other.md:9');
  const end2 = idx2 + 'other.md:9'.length;
  assert.ok(
    extractFileMentionCandidates(withIdentText, idx2, end2, null, null, 'other.md').length > 0,
    'fixture precondition: this text must actually contain a would-be file-mention candidate ("state-machine"), or this test cannot prove the fallback guard suppresses it'
  );
  const preferred = mergedCandidates(withIdentText, idx2, end2, null, null, 'other.md');
  assert.ok(preferred.every((c) => c.kind !== 'file'), 'a file-mention candidate must never be returned when a real identifier candidate exists nearby');
  assert.deepEqual(preferred, extractAnchorCandidates(withIdentText, idx2, end2, null, null), 'mergedCandidates must equal the identifier-only result when identifiers exist');
});

test('candidateFoundNear: a "const"/"file" candidate requires the EXACT cited line, never a neighbour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-anchor-fixture-'));
  const file = path.join(dir, 'target.txt');
  fs.writeFileSync(file, ['line one', "status: 'BLOCKED',", 'line three'].join('\n'));
  // BLOCKED is on line 2 (1-indexed).
  assert.equal(candidateFoundNear({ ident: 'BLOCKED', kind: 'const' }, file, 2, 2), true);
  assert.equal(candidateFoundNear({ ident: 'BLOCKED', kind: 'const' }, file, 3, 3), false, 'one line off must still fail a zero-tolerance const candidate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The regression guard on the tolerance band itself. This test used to assert the OPPOSITE -- that
// a 'camel' candidate is found up to ANCHOR_LOOSE_N (5) lines away -- and that band is precisely
// what let `run.ts:64` anchor on `runLive` at 63 once the product file moved, retiring the
// mutation-proof canary below without a single line of THIS repo changing. Zero tolerance now
// applies to every kind; if anyone reintroduces a band, this fails before the canary does.
test('candidateFoundNear: a "camel"/"snake" candidate gets NO line tolerance either -- the neighbouring line must miss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-anchor-fixture-'));
  const file = path.join(dir, 'target.txt');
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(i === 10 ? 'function runLive() {' : `line ${i}`);
  fs.writeFileSync(file, lines.join('\n'));
  // runLive is on line 11 (1-indexed).
  assert.equal(candidateFoundNear({ ident: 'runLive', kind: 'camel' }, file, 11, 11), true, 'the exact declaration line must be found');
  for (const off of [-5, -2, -1, 1, 2, 5]) {
    assert.equal(
      candidateFoundNear({ ident: 'runLive', kind: 'camel' }, file, 11 + off, 11 + off),
      false,
      `a 'camel' candidate ${off} line(s) from the cited line must NOT be found -- this is the exact ` +
        'slack that made the run.ts:63/:64 pair indistinguishable once runLive moved onto line 63'
    );
  }
  // A range citation still matches anywhere INSIDE its own range -- zero tolerance bounds the
  // window to the cited range, it does not shrink it to a single line.
  assert.equal(candidateFoundNear({ ident: 'runLive', kind: 'camel' }, file, 8, 14), true, 'a candidate inside a cited RANGE is still found');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('candidateFoundNear: a "file" candidate matches by SUBSTRING, not \\b-bounded -- the exact reason bin/spo:1102 needs it ("collect" inside "collectAll")', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-anchor-fixture-'));
  const file = path.join(dir, 'target.txt');
  fs.writeFileSync(file, ['line one', 'const data = collectAll(sources);', 'line three'].join('\n'));
  // "collect" never appears as its own whole word here -- only glued inside "collectAll". A
  // \b-bounded match would find nothing; only substring:true finds the real call site.
  assert.equal(candidateFoundNear({ ident: 'collect', kind: 'file', substring: true }, file, 2, 2), true, 'a file-mention candidate must match by substring, finding "collect" inside "collectAll"');
  assert.equal(new RegExp('\\bcollect\\b').test('const data = collectAll(sources);'), false, 'fixture precondition: "collect" must NOT be a whole-word match inside "collectAll", or this test proves nothing about substring vs \\b-bounded matching');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- mutation-proof canaries: the two real drifts that motivated this whole check, reverted IN
// MEMORY against the real, current source and target files, proving this check would have caught
// them before they were fixed above. Neither test touches disk -- the real citing files are read
// once, the fix is undone with a single string replace, and the exact same functions the main
// test above calls are run against that reverted text and the REAL target file.

// This canary spent a while red, and the red was correct. When it was written, the discriminating
// candidate was `BLOCKED` -- zero tolerance, sitting exactly on line 63 while `runLive` sat 12
// lines off, outside its own 5-line band. SPO-WebClient then deleted the live-run rate limiter
// above `runLive`, which moved `runLive` ONTO 63 and `BLOCKED` down to 75, and the 5-line band
// happily anchored `:64` on `runLive` -- one line off, invisible, which is the exact bug this
// whole section exists to catch. The canary was reporting a real loss of granularity, not aging
// out. It discriminates again because the band is gone (part 2.5's header), now via `runLive`
// itself and with no dependence on where the product repo keeps `BLOCKED`; and it is no longer
// the only thing standing behind that claim -- part 2.6 re-derives the same +/-1 property for
// every single-line citation in the corpus on every run.
test('MUTATION PROOF: reverting run.ts:63 back to run.ts:64 (the historical bug) makes this check red, on the real files', () => {
  const raw = read('orchestrator/state-machine.js');
  const normalized = normalizeWrap(raw);
  const reverted = normalized.replace('SPO-WebClient\'s `run.ts:63` `runLive` returns BLOCKED', 'SPO-WebClient\'s `run.ts:64` `runLive` returns BLOCKED');
  assert.notEqual(reverted, normalized, 'fixture precondition: the real file must still contain the fixed text this test reverts');

  const cites = extractCitations(reverted).filter((c) => !c.unanchored && c.file === 'run.ts');
  assert.equal(cites.length, 1, 'expected exactly one run.ts citation in state-machine.js');
  const c = cites[0];
  assert.equal(c.start, 64, 'the revert must have actually changed the parsed line number');

  const resolved = resolveCitationTarget(c.file);
  assert.ok(resolved.target, 'run.ts must resolve against the real product repo for this proof to mean anything');
  const candidates = mergedCandidates(reverted, c.idx, c.end, null, null, c.file);
  const top = candidates.slice(0, ANCHOR_TOPK);
  const found = top.some((cand) => candidateFoundNear(cand, resolved.target, c.start, c.stop));
  assert.equal(found, false, 'the historical run.ts:64 bug must be reported as an anchor failure -- if this assertion fails, the check cannot catch the exact bug that motivated it');

  // And the fixed text (:63, actually on disk) must anchor cleanly -- the check is not simply
  // always-red; it discriminates the specific one-line difference in both directions.
  const cites63 = extractCitations(normalized).filter((c2) => !c2.unanchored && c2.file === 'run.ts');
  const c63 = cites63[0];
  const candidates63 = mergedCandidates(normalized, c63.idx, c63.end, null, null, c63.file);
  const found63 = candidates63.slice(0, ANCHOR_TOPK).some((cand) => candidateFoundNear(cand, resolved.target, c63.start, c63.stop));
  assert.equal(found63, true, 'the real, fixed :63 citation must anchor cleanly');
});

test('MUTATION PROOF: reverting bin/spo:1102 back to bin/spo:1090-1093 (the historical bug) makes this check red, on the real files', () => {
  const raw = read('doc/bench-plan-derived-2026-09-02.md');
  const withoutFences = stripFences(raw);
  const normalized = normalizeWrap(withoutFences);
  const reverted = normalized.replace('reached from `bin/spo:1102`', 'reached from `bin/spo:1090-1093`');
  assert.notEqual(reverted, normalized, 'fixture precondition: the real file must still contain the fixed text this test reverts');

  const cites = extractCitations(reverted).filter((c) => !c.unanchored && c.file === 'bin/spo');
  assert.equal(cites.length, 1, 'expected exactly one bin/spo citation in this doc');
  const c = cites[0];
  assert.deepEqual([c.start, c.stop], [1090, 1093], 'the revert must have actually changed the parsed line range');

  const resolved = resolveCitationTarget(c.file);
  assert.ok(resolved.target, 'bin/spo must resolve for this proof to mean anything');
  const candidates = mergedCandidates(reverted, c.idx, c.end, null, null, c.file);
  const top = candidates.slice(0, ANCHOR_TOPK);
  const found = top.some((cand) => candidateFoundNear(cand, resolved.target, c.start, c.stop));
  assert.equal(found, false, 'the historical bin/spo:1090-1093 bug must be reported as an anchor failure -- if this assertion fails, the check cannot catch the exact bug that motivated it');

  // And the fixed text (:1102, actually on disk) must anchor cleanly, via the SAME substring-
  // matched 'file' candidate ("collect", from `console/collect.js`) -- proving both that the
  // check discriminates the specific drift in both directions AND that the 'file' kind's
  // substring matching (see candidateFoundNear's own fixture test) is what makes it possible at
  // all: "collect" is never a \b-bounded whole word at the real call site, only a substring of
  // `collectAll`.
  const cites1102 = extractCitations(normalized).filter((c2) => !c2.unanchored && c2.file === 'bin/spo');
  const c1102 = cites1102[0];
  const candidates1102 = mergedCandidates(normalized, c1102.idx, c1102.end, null, null, c1102.file);
  assert.equal(candidates1102[0] && candidates1102[0].kind, 'file', 'this proof is only meaningful if the real candidate is the cross-file "file"-kind mention it is meant to exercise');
  const found1102 = candidates1102.slice(0, ANCHOR_TOPK).some((cand) => candidateFoundNear(cand, resolved.target, c1102.start, c1102.stop));
  assert.equal(found1102, true, 'the real, fixed :1102 citation must anchor cleanly');
});

// ---- part 3: dangling doc/*.md path reference check (E3, action 9.2) ---------------------------
//
// doc/comment-corpus-audit-2026-09-03.md's E3: a comment or doc names a `doc/<name>.md` path with
// NO line number (so part 2's citation ratchet never sees it -- that scanner only fires on
// `path:N`) and the path resolves nowhere: not in this repo, not in the product, not runtime-
// generated. Property: every bare `doc/<name>.md` reference resolves in this repo, in the
// product repo (config.js's default `~/SPO-WebClient`, reusing resolveCitationTarget's own
// PRODUCT_REPO/DEPLOY_REPO from part 2), or is on DANGLING_DOC_REF_ALLOWLIST with a reason.
const DOC_REF_RE = /\bdoc\/[A-Za-z0-9_-]+\.md\b/g;

// DANGLING_DOC_REF_ALLOWLIST: per-path, same posture as this file's other allowlists. Three
// shapes, each with its own reason:
//   - genuinely dangling (never existed anywhere) -- doc/daemon-crash-recovery.md and doc/todo-
//     triage-after-hooks-retirement.md. Not fixed here: writing the doc from scratch would mean
//     inventing the incident's content rather than citing it, and deleting the citation is a
//     judgement call about whether the surrounding comment still makes sense without it -- both
//     belong to 9.3, per this action's own brief ("where a fix is a judgement call, allowlist it").
//   - runtime-generated, never committed -- doc/recette-log.md and its per-parallel-index
//     siblings (recette.js's own header explains why: written by a REAL, unattended recette run
//     against `~/.spo-bench/`, never present in a fresh worktree by design).
const DANGLING_DOC_REF_ALLOWLIST = {
  'doc/daemon-crash-recovery.md': 'orchestrator/config.js:489 -- never existed (git log --all has no history for this path); the incident it names is recorded only in the maintainer\'s own memory, not this repo. Deferred to 9.3: write the doc, or drop the citation.',
  'doc/todo-triage-after-hooks-retirement.md': 'orchestrator/state-machine.js:930 -- never existed in this repo (nor the product); the name matches a maintainer memory-file title, not a tracked doc. Deferred to 9.3.',
  'doc/recette-log.md': 'orchestrator/recette.js:229,254,447 -- RECETTE_DOC_FILE, written by a real unattended recette run against `~/.spo-bench/`; absent in a fresh worktree by design, not a broken reference.',
  'doc/recette-log-a.md': 'orchestrator/recette.js:458-459 -- parallel-index sibling of RECETTE_DOC_FILE, same runtime-generated posture.',
  'doc/recette-log-b.md': 'orchestrator/recette.js:458-459 -- parallel-index sibling of RECETTE_DOC_FILE, same runtime-generated posture.',
};

test('DANGLING_DOC_REF_ALLOWLIST holds exactly the paths this action found dangling or runtime-only -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(DANGLING_DOC_REF_ALLOWLIST).sort(),
    ['doc/daemon-crash-recovery.md', 'doc/recette-log-a.md', 'doc/recette-log-b.md', 'doc/recette-log.md', 'doc/todo-triage-after-hooks-retirement.md'],
    'DANGLING_DOC_REF_ALLOWLIST changed -- update this pin in the same change, with a named reason.'
  );
});

test('every bare "doc/<name>.md" reference in the 65-file corpus resolves here, in the product repo, or is on DANGLING_DOC_REF_ALLOWLIST', () => {
  const found = new Map(); // path -> [rel,...]
  for (const rel of CORPUS_FILES) {
    const src = read(rel);
    let m;
    const re = new RegExp(DOC_REF_RE.source, 'g');
    while ((m = re.exec(src))) {
      if (!found.has(m[0])) found.set(m[0], []);
      found.get(m[0]).push(rel);
    }
  }

  assert.ok(found.size >= 10, `expected at least 10 distinct "doc/<name>.md" references across the corpus, found ${found.size} -- has the reference style changed?`);

  const offenders = [];
  const repoAbsentOffenders = [];
  for (const [docPath, sites] of found) {
    if (Object.prototype.hasOwnProperty.call(DANGLING_DOC_REF_ALLOWLIST, docPath)) continue;
    if (fs.existsSync(abs(docPath))) continue;
    const resolved = resolveCitationTarget(docPath);
    if (resolved.root === 'product-absent' || resolved.root === 'deploy-absent') {
      repoAbsentOffenders.push(`${docPath} -- cited from ${[...new Set(sites)].join(', ')}; cannot verify, cross-repo dependency missing from disk`);
      continue;
    }
    if (resolved.ambiguous) {
      offenders.push(`${docPath} -- cited from ${[...new Set(sites)].join(', ')}; ambiguous basename, ${resolved.ambiguous.length} tracked files in the ${resolved.root} repo share it (${resolved.ambiguous.join(', ')})`);
      continue;
    }
    if (!resolved.target) {
      offenders.push(`${docPath} -- cited from ${[...new Set(sites)].join(', ')}; not found in this repo, ${PRODUCT_REPO}, or ${DEPLOY_REPO}`);
    }
  }

  assert.deepEqual(repoAbsentOffenders, [], `path(s) this ratchet could not verify because a cross-repo dependency is missing from disk (E1: never a silent pass):\n  ${repoAbsentOffenders.join('\n  ')}`);
  assert.deepEqual(offenders, [], `dangling "doc/<name>.md" reference(s), not on DANGLING_DOC_REF_ALLOWLIST:\n  ${offenders.join('\n  ')}`);
});

// ---- part 4: SPO-Deploy artifact reference check (E1 residual, fix round S4) -------------------
//
// verify-92.md's Q6 finding (2026-09-03 adversarial pass): DEPLOY_REPO (part 2, above) is wired
// into resolveCitationTarget's fallback chain, but 0 of the 68 pinned file:line citations ever
// reach it -- every citation this corpus makes to a SPO-Deploy file happens to be a BARE filename
// mention with no line number (`` SPO-Deploy's `DEPLOY.md` § 5.5 ``, `cd ~/SPO-Deploy &&
// ./deploy.sh setup dev`), the same shape part 3's DOC_REF_RE exists for `doc/<name>.md` -- so
// `SPO_DEPLOY_REPO=/nonexistent` left the suite green not because SPO-Deploy resolution was
// exercised and passed, but because nothing in the corpus was shaped to reach it at all. That is
// exactly the trap this project keeps hitting: a resolution path that LOOKS like coverage while
// checking nothing.
//
// This closes the specific, checkable subset: the three real SPO-Deploy artifacts this corpus
// actually names by filename (measured 2026-09-03: `DEPLOY.md` -- orchestrator/README.md:1667;
// `deploy.sh` and `setup.conf.example` -- doc/setup.md:11,15), each verified to exist in
// DEPLOY_REPO, or reported as a setup problem (E1 posture, never a silent pass) if DEPLOY_REPO
// itself is absent from disk.
//
// What this does NOT cover, named rather than left to look covered: roughly a dozen more corpus
// lines name "SPO-Deploy" as a bare ENTITY ("owned by SPO-Deploy", "Consumes product releases",
// "a `spo dashboard` + rsync concern owned by SPO-Deploy") with no specific artifact attached --
// there is nothing in those sentences for a scanner to resolve against a file, the same reason
// DOC_REF_RE never fires on a sentence that merely says "see the docs". Those are true prose
// references this sweep does not, and structurally cannot, check without inventing a claim about
// what they mean; SPO-Deploy's own README.md § Setup (doc/setup.md:73's citation) is likewise out
// of scope for the same reason -- a section-heading reference, not a file this sweep can resolve.
const SPO_DEPLOY_ARTIFACTS = ['DEPLOY.md', 'deploy.sh', 'setup.conf.example'];

test('the SPO-Deploy artifact filenames this corpus mentions are exactly SPO_DEPLOY_ARTIFACTS -- no more, no fewer', () => {
  const mentioned = new Set();
  for (const rel of CORPUS_FILES) {
    const src = read(rel);
    for (const name of SPO_DEPLOY_ARTIFACTS) {
      if (src.includes(name)) mentioned.add(name);
    }
  }
  assert.deepEqual(
    [...mentioned].sort(),
    SPO_DEPLOY_ARTIFACTS.slice().sort(),
    'the set of SPO-Deploy artifacts this corpus actually mentions by filename changed -- update ' +
      'SPO_DEPLOY_ARTIFACTS (and verify the new/changed name actually resolves in SPO-Deploy) in ' +
      'the same change, by name, the same way this file\'s other pinned lists work.'
  );
});

test('every SPO_DEPLOY_ARTIFACTS filename actually exists in SPO-Deploy, or its absence is reported as a setup problem (E1)', () => {
  if (!fs.existsSync(DEPLOY_REPO)) {
    assert.fail(
      `SPO-Deploy is not on disk at ${DEPLOY_REPO} -- cannot verify ${SPO_DEPLOY_ARTIFACTS.length} ` +
        'artifact reference(s) this corpus names by filename; this is a setup problem, never a ' +
        'silent pass (E1).'
    );
  }
  const missing = SPO_DEPLOY_ARTIFACTS.filter((name) => !fs.existsSync(path.join(DEPLOY_REPO, name)));
  assert.deepEqual(
    missing,
    [],
    `SPO-Deploy artifact(s) this corpus names by filename but that do not exist at ${DEPLOY_REPO}:\n  ${missing.join('\n  ')}`
  );
});
