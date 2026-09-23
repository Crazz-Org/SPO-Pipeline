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
// Strips the inherited GIT_* env from every real `git` spawn below -- see helpers.js's gitEnv
// for the incident that makes this load-bearing rather than tidy.
const { gitEnv, mkTmp } = require('./helpers');
// The ONE citation-target resolver (resolveCitationTarget/resolveIn/findByBasename/
// trackedFiles/PRODUCT_REPO/DEPLOY_REPO) lives in citation-pins.js -- action 11.1 (#206) moved
// it there so this file and action 11.3's test/-comment-citation sweep call the same function
// instead of each carrying a copy that could drift. resolvePins (the pinned-anchor check) and
// its data (BENCH_PINS/LIVE_RANGE_PINS/BLUNT_PINS/CCA_PINS) live there too.
const {
  PRODUCT_REPO,
  DEPLOY_REPO,
  _trackedCache,
  trackedFiles,
  findByBasename,
  resolveIn,
  resolveCitationTarget,
  shiftedCitation,
  resolvePins,
  // stripFences/normalizeWrap/CITATION_RE/POSSESSIVE_LINE_RE/CHAIN_RE/PROXIMITY_CHARS/
  // extractCitations/isCitationAllowlisted -- moved to citation-pins.js verbatim, action 11.3
  // (#190), so this file and test/test-comment-citation-sweep.test.js call the SAME extractor
  // instead of each carrying a copy that could drift.
  stripFences,
  normalizeWrap,
  CITATION_RE,
  POSSESSIVE_LINE_RE,
  CHAIN_RE,
  PROXIMITY_CHARS,
  extractCitations,
  isCitationAllowlisted,
} = require('./citation-pins');
const { BENCH_PINS, LIVE_RANGE_PINS, BLUNT_PINS, CCA_PINS } = require('./citation-pins-data');

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
      { file: 'orchestrator/config.js', contains: "positiveMsFromEnv('SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS', 5000)" },
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
    name: 'accountLeaseWaitMs derives from MAX_LEASE_AGE_MS (67.2 min), not a flat 5 min', // action 6.2, raised by action A2 (card #239, 2026-09-17)
    checks: [
      {
        file: 'orchestrator/step-contracts.js',
        // MAX_LLM_STEP_OUTER_DEADLINE_MS, not MAX_LLM_STEP_DEADLINE_MS: action A2 (card #239)
        // re-derived the lease bound from the OUTER per-step deadline (inner + margin), because
        // that outer timer stops being permanently inert once card #239's transport swap lands --
        // see step-contracts.js's own MAX_LEASE_AGE_MS comment.
        contains: 'const MAX_LEASE_AGE_MS = 2 * MAX_LLM_STEP_OUTER_DEADLINE_MS + Math.round(MAX_LLM_STEP_OUTER_DEADLINE_MS / 10);',
      },
      {
        file: 'orchestrator/config.js',
        contains: "accountLeaseWaitMs: positiveMsFromEnv('SPO_ACCOUNT_LEASE_WAIT_MS', MAX_LEASE_AGE_MS),",
      },
      { file: 'doc/state-machine-spec.md', contains: '**67.2 min**' },
      {
        file: 'orchestrator/README.md',
        // Extended through the full formula (2026-09-08, verifier's B5 finding): the old string
        // stopped one token before the constant name, which is exactly why "2 x LLM_STEP_DEADLINE_MS
        // plus 10% slack" (arithmetically false: 2 x 900,000 + 10% = 31.5 min, not 63) sat here
        // swept green. Proven load-bearing: reverting this line to the old wording turns this pin
        // red by name (measured 2026-09-08). Re-pinned for action A2 (card #239, 2026-09-17): the
        // figure and the constant name both moved (63 min/MAX_LLM_STEP_DEADLINE_MS -> 67.2
        // min/MAX_LLM_STEP_OUTER_DEADLINE_MS) -- see step-contracts.js's own comment for why.
        contains: '`MAX_LEASE_AGE_MS` (`step-contracts.js`, **67.2 minutes**: 2 ×\n`MAX_LLM_STEP_OUTER_DEADLINE_MS` plus 10% slack',
      },
    ],
  },
  {
    name: 'LLM_STEP_DEADLINE_MS (900000ms / 15min) -- the default, three of the five LLM steps', // action 1.x / 2.1 / 2.2
    checks: [
      { file: 'orchestrator/step-contracts.js', contains: 'const LLM_STEP_DEADLINE_MS = 900000;' },
      { file: 'doc/state-machine-spec.md', contains: '| 900000ms / 15min |' },
    ],
  },
  {
    // PLAN was the one step off the default (2026-09-04). Card #486 (size:L, the only card ever to
    // reach PLAN's `L -> high` row) failed three times, twice on deadline kills at ~825s of measured
    // wall clock, and terminal-parked llm-transport-failed:PLAN -- the pipeline could not plan an
    // L card at all. IMPLEMENT joined it (action 2.2, card #158): 7 of the 9 deadline kills in the
    // whole corpus are IMPLEMENT's own, and its longest completed calls journalled 885-920s against
    // the old 900000ms cap (pre-monotonic-clock figures, see steps/llm.js). This row exists so
    // neither raise can drift from the spec table that states it.
    name: 'LLM_STEP_DEADLINE_MS_BY_STEP: PLAN and IMPLEMENT get 1800000ms / 30min',
    checks: [
      { file: 'orchestrator/step-contracts.js', contains: 'PLAN: 1800000, // 30 min' },
      { file: 'orchestrator/step-contracts.js', contains: 'IMPLEMENT: 1800000, // 30 min' },
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
      { file: 'orchestrator/config.js', contains: "positiveMsFromEnv('SPO_CI_CHECKS_POLL_INTERVAL_MS', 20000)" },
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
      'LLM_STEP_DEADLINE_MS (900000ms / 15min) -- the default, three of the five LLM steps',
      'LLM_STEP_DEADLINE_MS_BY_STEP: PLAN and IMPLEMENT get 1800000ms / 30min',
      'account cooldown: escalation window (2 hours)',
      'account cooldown: overloaded (5 minutes, flat, never escalates)',
      'account cooldown: usage escalated (5 hours)',
      'account cooldown: usage probe (1 hour)',
      'accountLeaseWaitMs derives from MAX_LEASE_AGE_MS (67.2 min), not a flat 5 min',
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
    ['account', 'accounts', 'ask', 'cost', 'dashboard', 'intake', 'nightly', 'parked', 'pull', 'pull-reports', 'recette', 'reports', 'resume', 'status', 'task', 'tokens', 'triage'],
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
// actually defined there. Historical record (action 9.2, 2026-09-03 -- the four file:line
// citations below describe where the STALE text was found at that time, not what those lines say
// today): 3 sites / 2 symbols, both fixed in passing as part of this action (an unambiguous
// rename, per this action's own brief):
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
//   false). blankComments (the suite-wide helper, copied verbatim below and rostered in
//   test/blank-comments-sync.test.js) now runs on the CITED file before the occurrence test, so a name that
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
// Historical record (action 9.2, 2026-09-03 -- the file:line pairs below name where each
// sentence sat AT THAT TIME; none of this is re-checked today, so treat the numbers as archive,
// not as live citations): widening the scan surfaced 3 real matches that are not phantom SYMBOL
// citations at all -- isCodeShapedIdentifier's CONST_CASE heuristic (3+ leading uppercase letters)
// also matches ordinary capitalized prose emphasis, which the possessive shape happens to precede
// in three places (`lock.js`'s `SECOND` idiom -- ordinal "a second, simpler idiom", not a
// constant; `config.js`'s `OWN` -- emphasis on "own", not an identifier; `intake.js`'s `LLM` --
// "the intake LLM steps", not a symbol). Reworded at the source (product-repo-lock.js:28,
// recette.js:125, bin/spo:1891) rather than allowlisted: these were never real symbol citations
// to begin with, so an allowlist entry would misrepresent them as reviewed-and-accepted phantoms
// instead of what they are, three sentences that happened to fall into a regex's blind spot.
function isCodeShapedIdentifier(ident) {
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(ident)) return true; // CONST_CASE
  if (/[a-z][A-Z]/.test(ident) && ident.length >= 5) return true; // camelCase
  return false;
}

// blankComments -- blanks whole-line `//` comments and then `/* */` blocks (in that order, and
// preserving line numbers and column widths), so an identifier that exists ONLY in the file's
// own commentary about code does not count as "present" -- the M15b fix. An inline trailing
// `// comment` on a code line is not blanked (same limitation every copy of this helper has,
// deliberately -- see the whole-line contract in test/blank-comments-sync.test.js) -- harmless
// here since it can only ever make symbolDefinedIn MORE permissive, never hide a real phantom
// that M15b's own mutation (a comment-only mention) already proves this catches.
//
// KEEP IN SYNC. This helper is not a pair, it is a family: SEVEN byte-identical copies live in
// this suite -- test/bin-spo-state-write-sweep.test.js, test/doc-constant-sweep.test.js,
// test/gh-api-argv.test.js, test/no-real-spawn-sweep.test.js, test/park-reason-doc-sweep.test.js,
// test/park-reason-partition.test.js and test/prompt-contract-sweep.test.js. The duplication is
// deliberate (each sweep file stands alone and requires nothing from another test file); the
// drift is not. test/blank-comments-sync.test.js is the authority: it pins that roster, asserts
// the copies are byte-identical, and runs the helper's behavioural contract against every one of
// them. Fixing one copy and not the rest is the trap card #152 sets. The card names two files to
// fix -- test/park-reason-doc-sweep.test.js and test/gh-api-argv.test.js -- but at 41e8d91 all
// SEVEN carried the same block-first ordering (measured: 7 block-first, 0 line-first, and no
// line-first copy anywhere in this repo's history). Following the card literally would have left
// five copies under-detecting without going red.
function blankComments(source) {
  const withoutLineComments = source
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
  return withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
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
// both docs -- it was not. doc/remediation-plan-2026-08.md:188 lists row 5.1's three sub-items in
// one cell, unlettered: pre-worktree board moves, "DIAGNOSE activity surfaced (a 'diagnosing,
// attempt N/3' comment or a dedicated column -- driver decision)" (this one), and dropping the
// redundant IMPLEMENT-retry move. doc/remediation-progress.md:649 names the same referent again,
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
// its call sites rather than allowlisted). Card #212 (Lot 10, SPO-Pipeline, 2026-09-13, fix-pass)
// briefly carried a '10.2' entry here for an "action N.N" banner this lot's own code comments
// used to cite; that banner convention (borrowed from the dated 2026-08 remediation plan's row
// numbering, which this repo has no analogous doc for past lot 9) was itself the defect -- fixed
// by rewording every "action 10.2" mention in code/docs to "card #212" (SPO-Pipeline#212 -- the
// allowlist's own first draft mis-cited it as SPO-WebClient#212) instead of carving out an
// exception for a banner shape that should never have been used for an issue-driven lot to begin
// with. Kept empty, not deleted, for the same reason this suite's other now-empty allowlists are.
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

  assert.ok(checked >= 5, `expected at least 5 "action N.Na" mentions across orchestrator (recursively) and bin/spo, found ${checked} -- has the banner convention changed?`);

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
// THE LESSON ACTION A2 (card #239, 2026-09-17) ADDED TO THIS RECORD, stated once here so a future
// editor hits it before repeating the mistake: touching config.js and step-contracts.js was never
// the only shift risk. A2's own PROSE fixes to orchestrator/daemon.js and orchestrator/intake.js
// (unrelated to any citation -- a CLI help string, a header comment) each added a few lines and
// silently broke 7 more citations INTO those two files from dispatcher.js, orphan-scan.js,
// park-loop.js, steps/llm.js, README.md and doc/state-machine-spec.md, plus two
// citation-pins-resolve-head.test.js "historical drift replay" tests whose expected correction
// targets had moved with them. None of those were found by re-grepping for the files A2 set out
// to change -- they were found by re-running the FULL suite after each edit and reading what went
// red. Any file this corpus cites INTO is a shift risk the moment it is edited for ANY reason, not
// only when the edit's own subject is the thing being cited.
//
// ---- three citation shapes ---------------------------------------------------------------------
//   1. `path/to/file.ext:N` or `:N-M` -- the original shape, CITATION_RE below.
//   2. `path/to/file.ext`'s `thing` (line N) -- prose possessive form, POSSESSIVE_LINE_RE. One
//      live site: orchestrator/bench-queue-wait.js's own header, citing the product's `job.ts`'s
//      `purgeDone`.
//   3. A bare backtick `` `:N` `` (or, in a JS comment, "at :N") immediately after a real
//      citation established the file -- `` `account-lease.js:189` -> `lock.js:352` ... -> `:386`
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
// measured -- not part of what it measured). 68 files: the 65 of doc/accepted-gaps.md §3d's own
// count, plus `orchestrator/retry-channel.js`, added by project-2 card #476 (the unpark scan's
// health rule, factored out of bin/spo when the card gave it a third reader), plus
// `console/dispatcher-status.js`, added by card #186 when computeDispatcherStatus was factored
// out of bin/spo into its own module so bin/spo's `spo status` and console/collect.js's dashboard
// deck could share one derivation instead of each carrying a copy, plus `orchestrator/sdk.js`,
// added by card #239's chantier action A1 (2026-09-17) when the vendored Agent SDK's loader
// module picked up its own `gate.yml:9-12` citation -- see this file's own header comment for
// what it cites, plus `orchestrator/steps/sdk-call.js` (registered by its own action, A5b) and
// `orchestrator/live-progress.js` (card #239 action A9, 2026-09-21): A6 wrote it with a header that
// names four other modules and carries the transport's cross-file claims, it holds zero
// `file:N` citations today (measured), so registering it costs no EXPECTED_CITATIONS row -- and the
// next comment edit that adds one is checked instead of silently trusted. Not every orchestrator
// module is here (19 other `.js`/`.sh` files under orchestrator/, console/ and scripts/ are not,
// measured 2026-09-21 by diffing readdir against this array); a new module earns
// its place by carrying cross-file claims, not by existing. A file added to or removed from this
// scope is a deliberate act -- update this array in the same change, by name, the same way PINS's
// name list above works.
const CORPUS_FILES = [
  'README.md',
  'accounts/spo-test-accounts.yml',
  'bin/spo',
  'console/collect.js',
  'console/dispatcher-status.js',
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
  'orchestrator/live-progress.js',
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
  'orchestrator/sdk.js',
  'orchestrator/state-machine.js',
  'orchestrator/step-contracts.js',
  'orchestrator/steps/llm.js',
  'orchestrator/steps/scripted.js',
  'orchestrator/steps/sdk-call.js',
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

// PRODUCT_REPO/DEPLOY_REPO -- imported from citation-pins.js above (action 11.1, #206). No
// `config.deployRepo` exists (confirmed by doc/comment-corpus-audit-2026-09-03.md §5), which is
// why DEPLOY_REPO is a scanner-local constant rather than something read off `orchestrator/config.js`.

// CITATION_RE/POSSESSIVE_LINE_RE/CHAIN_RE/PROXIMITY_CHARS -- moved to citation-pins.js verbatim,
// action 11.3 (#190), and imported at the top of this file (see that module's own header: `bin/spo`
// is an explicit alternative there, not a generalized "extensionless path" allowance -- it is the
// one extensionless executable this corpus cites by line).

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
  // it now would misrepresent what the audit actually found at measurement time. This is the ONE
  // shape action 11.1 (#206) leaves on this allowlist for these two docs: a deleted file has no
  // line left to pin against. Every OTHER file-tied citation in both docs (41 of them) now has a
  // real content check of its own -- BENCH_PINS, in test/citation-pins-data.js, resolved by
  // test/citation-pins.js's resolvePins (see the tests below part 2.5) -- so "dated 8.1 audit
  // records" here describes only why THESE TWO entries are permanently unfixable, not why the
  // two docs as a whole go unchecked; they no longer do.
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
// isCitationAllowlisted -- moved to citation-pins.js verbatim, action 11.3 (#190), and imported
// at the top of this file.

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
      'orchestrator/invariants.js :: relative/path/to/file.ts:123',
    ],
    'CITATION_ALLOWLIST changed size or membership. Adding an entry here exempts a citation from ' +
      'ever needing to resolve, forever -- it needs its own named, reasoned justification (read ' +
      'from the actual file, not assumed), and this pin needs updating in the same change, by name.'
  );
});

// stripFences -- moved to citation-pins.js verbatim, action 11.3 (#190), and imported at the top
// of this file.

// normalizeWrap(src) -- E18/E15: joins an identifier or citation the source happened to wrap
// across a line break, so CITATION_RE (which never spans a space, deliberately -- spanning one
// would turn ordinary prose into false-positive matches) still reads it as one contiguous string.
// Two cases, in order: (1) the line up to the break ends in `-` or `/` -- a path or hyphenated
// identifier continuation (`doc/state-machine-` + `spec.md:49`) -- joined with NO inserted
// character, after stripping any `//`/`*`/`#` comment leader the continuation line starts with;
// (2) every other line break, collapsed to a single space (safe: a citation never legitimately
// contains a literal space, so this can only ever help a match, never manufacture a false one).
// normalizeWrap -- moved to citation-pins.js verbatim, action 11.3 (#190), and imported at the
// top of this file.

// trackedFiles/findByBasename/resolveIn/resolveCitationTarget -- moved to citation-pins.js
// verbatim, action 11.1 (#206), and imported at the top of this file. See that module's own
// header for the incident this resolver fixes (a nested abandoned worktree under
// `~/SPO-WebClient/.claude/worktrees/<slug>/` shadowing the real product file, `.claude` sorting
// before `src` in a plain readdir walk) -- nothing about the logic changed, only its address, so
// this file and action 11.3's test/-comment-citation sweep call the same function rather than
// each carrying a copy that could drift.

// extractCitations(text) -- the three shapes, merged in document order, chain matches resolved
// against the nearest preceding real citation within PROXIMITY_CHARS. `text` is expected to
// already be fence-stripped (if markdown) and normalizeWrap'd. Exported shape:
// [{ raw, file, start, stop, unanchored }], `file: null` iff `unanchored` is true.
// extractCitations -- moved to citation-pins.js verbatim, action 11.3 (#190), and imported at
// the top of this file.

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
// regex + all 68 files + line-unwrap + chain resolution. Not a floor -- a citation added anywhere
// in the corpus (a real one, or a new narrative aside shaped like one) must be added HERE, by
// name, in the same change, the same way PINS's name list above works. See the test below for
// what happens when this array and the live corpus disagree.
const EXPECTED_CITATIONS = [
  "doc/bench-audit-2026-09-02.md :: (unanchored) :277",
  "doc/bench-audit-2026-09-02.md :: (unanchored) :458",
  "doc/bench-audit-2026-09-02.md :: (unanchored) :65-69",
  "doc/bench-audit-2026-09-02.md :: bin/spo:1284", // re-pinned SEVENTEENTH TIME in card #219's fix pass (Lot 12, 2026-09-14): :1273 -> :1276 -> :1283, when that card's bin/spo cmdStatus injection (monotonicNowMs require plus TWO option lines) landed above `collectAll(sources)` -- net +7 lines once the fix pass expanded the same comment. Re-pinned an EIGHTEENTH time for card #239 chantier action A6 (2026-09-17): :1283 -> :1284, a pure +1-line shift when A6's generateOnce() comment (documenting live-step.js's move off the transcript chain onto a worker-written live-progress.json) grew by one net line, above `collectAll(sources)`. See the mutation-proof test's own EIGHTEENTH-catch paragraph for the empirical re-check.
  "doc/bench-audit-2026-09-02.md :: board-take.sh:109-110", // KEPT as originally written -- action 11.1 (#206) first pass wrongly "corrected" this to :111-112 against d03ea8b7; fix pass D6 found the audit was actually measured against `93528389` (remediation-plan row 1.2, confirmed an ancestor of origin/main), where :109-110 IS the finished_marker/if-guard pair that reads `.finished` -- the :111-112 figure only held two lines later, at the wrong base commit.
  "doc/bench-audit-2026-09-02.md :: cli.ts:179",
  "doc/bench-audit-2026-09-02.md :: cli.ts:221-227",
  "doc/bench-audit-2026-09-02.md :: doc/state-machine-spec.md:389", // re-pinned from :157, then :166, then :207 (card #212 C1), then :270 (card #212 C2), then :315, then :318 -- card #212's fix pass (F1/F2/F3/F6, 45 net lines) landed above the step table, a true pure shift; content byte-identical at :315 (verified: the FINISH row's own "Action B1.4: FINISH now actually keeps the promise this row always made -- fast-forward the main product checkout" opens it). Re-pinned again in card #212's C4/C5 build (Lot, 2026-09-14): :318 -> :387, a pure +69-line shift when doc/state-machine-spec.md gained the `continue` verb's own "Resume at CHECK" subsection above the step table; content byte-identical at :387, verified by re-reading the target line. Closing testimony corrected for card #239 A9 (the value had moved :387 -> :389 without this sentence being told, which the Rule B check in this file found): content byte-identical at :389, verified by re-reading the target line.
  "doc/bench-audit-2026-09-02.md :: finish.sh:275-276",
  "doc/bench-audit-2026-09-02.md :: merge-queue.ts:178-188",
  "doc/bench-audit-2026-09-02.md :: run.ts:109",
  "doc/bench-audit-2026-09-02.md :: sanctuarize.test.ts:151-156",
  "doc/bench-audit-2026-09-02.md :: scripted.js:1347",
  "doc/bench-audit-2026-09-02.md :: scripted.js:1944-1996", // re-pinned from :1944-1994 -- fix pass D7: realFinish genuinely ends at :1996 (the function's own closing brace); :1994 is a blank line two short of that, verified by reading orchestrator/steps/scripted.js at 7902164.
  "doc/bench-audit-2026-09-02.md :: scripted.js:292-293",
  "doc/bench-audit-2026-09-02.md :: scripts/finish.sh:245-247",
  "doc/bench-audit-2026-09-02.md :: scripts/nightly-check.sh:70-73",
  "doc/bench-audit-2026-09-02.md :: src/e2e/bench/paths.ts:143-163",
  "doc/bench-audit-2026-09-02.md :: src/e2e/bench/worker.ts:482",
  "doc/bench-audit-2026-09-02.md :: src/e2e/config.ts:93",
  "doc/bench-audit-2026-09-02.md :: test/helpers.js:65-94", // re-pinned from :65-80 -- fix pass D7: isolatedEnv spans :65-94, and the fact this citation claims (the SPO_BENCH_DIR temp-dir assignment) is at :92, seven lines past where the old range stopped; verified by reading test/helpers.js at 7902164.
  "doc/bench-audit-2026-09-02.md :: verdict.ts:162-183",
  "doc/bench-audit-2026-09-02.md :: verdict.ts:23-67",
  "doc/bench-audit-2026-09-02.md :: worker.ts:106",
  "doc/bench-audit-2026-09-02.md :: worker.ts:302", // re-pinned from :301 -- action 11.1 (#206) corrected the citation to request.fingerprint.head's own `const head =` line, not the comment line above it; verified by reading src/e2e/bench/worker.ts at d03ea8b7.
  "doc/bench-audit-2026-09-02.md :: worker.ts:307-319",
  "doc/bench-audit-2026-09-02.md :: worker.ts:482",
  "doc/bench-audit-2026-09-02.md :: worker.ts:482-486",
  "doc/bench-audit-2026-09-02.md :: worker.ts:487",
  "doc/bench-audit-2026-09-02.md :: worker.ts:495-502",
  "doc/bench-audit-2026-09-02.md :: worker.ts:543-546",
  "doc/bench-audit-2026-09-02.md :: worker.ts:576",
  "doc/bench-audit-2026-09-02.md :: worker.ts:750",
  "doc/bench-audit-2026-09-02.md :: worker.ts:779-780",
  "doc/bench-plan-derived-2026-09-02.md :: bin/spo:1284", // same re-pin, same reason -- see the sibling doc's own EXPECTED_CITATIONS comment above (most recently card #239 chantier action A6, :1283 -> :1284).
  "doc/bench-plan-derived-2026-09-02.md :: board-take.sh:109-110", // same revert, same reason as bench-audit's own entry above (fix pass D6).
  "doc/bench-plan-derived-2026-09-02.md :: cli.ts:88",
  "doc/bench-plan-derived-2026-09-02.md :: doc/state-machine-spec.md:389", // re-pinned from :157, then :166, then :207 (card #212 C1), then :270 (card #212 C2), then :315, then :318, then :387 (card #212 C4/C5, +69 net lines) -- same shift/reason as doc/bench-audit-2026-09-02.md's own entry above
  "doc/bench-plan-derived-2026-09-02.md :: finish.sh:275-276",
  "doc/bench-plan-derived-2026-09-02.md :: orchestrator/steps/scripted.js:292-293",
  "doc/bench-plan-derived-2026-09-02.md :: sanctuarize.test.ts:151-156",
  "doc/bench-plan-derived-2026-09-02.md :: scripts/finish.sh:245-247",
  "doc/bench-plan-derived-2026-09-02.md :: scripts/nightly-check.sh:70-73",
  "doc/bench-plan-derived-2026-09-02.md :: src/e2e/config.ts:93",
  "doc/bench-plan-derived-2026-09-02.md :: test/helpers.js:65-94", // same re-pin, same reason as bench-audit's own entry above (fix pass D7).
  "doc/bench-plan-derived-2026-09-02.md :: worker.ts:302", // same re-pin, same reason as bench-audit's own entry above.
  "doc/board-audit.md :: config.js:1228", // PORT (card #167 onto main, 2026-09-23): :1225 -> :1228, card #167 widened the `workers` K-clamp comment (+2) and the claudeAccountsDir comment (+1), both above reportIntakeColumn, +3 net lines; content byte-identical at :1228, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23, chantier/sdk-transport + main): branch had this at :1104 (action A2/A9 history), main independently re-pinned it to :1156 (card #226, its own INTAKE nightly pre-gate comment above reportIntakeColumn) -- both histories are real and both land in the merged tree, so neither number survives on its own; content byte-identical at :1228 (`reportIntakeColumn: process.env.SPO_REPORT_INTAKE_COLUMN || 'Intake',`), verified by re-reading the target line rather than summed from either side's own arithmetic, per this repo's own convention.
  "doc/board-audit.md :: orchestrator/steps/scripted.js:1410", // MERGE (2026-09-23): branch had :1396 (A5b-2 fix pass history), main independently re-pinned to :1403 (card #226's fix pass, its own classifyNightly/targetSha additions above realWorktree). Both real, both merged; content byte-identical at :1410 (`const claim = spawnStep(ctx, deps, 'WORKTREE', 'npm', ['run', 'board:take', ...`), verified by re-reading the target line.
  "doc/board-audit.md :: report-intake.js:29",
  "doc/state-machine-spec.md :: bin/spo:1242", // unaffected by this merge (identical on both sides) -- re-pinned in card #214 (Lot 9, 2026-09-13): :1202 -> :1232, a pure +30-line shift when that action's `cmdTokens` gained the opt-in `--usage-delta` section (see this file's own EXPECTED_CITATIONS entry for `bin/spo:1284`, the `collectAll` pin shifted by the same edit) landed above `cmdDashboard` in the same file. Re-pinned again in card #219 (2026-09-14): :1232 -> :1235, a pure +3-line shift when that card's bin/spo cmdStatus injection (monotonicNowMs require plus two option lines) landed above `cmdDashboard`. Re-pinned a third time in card #219's OWN fix pass, same day: :1235 -> :1242, a pure +7-line shift when the fix pass expanded that same injected-deps comment (naming `processStartUptimeMs`/`monotonicNowMs()` explicitly) above `cmdDashboard` in the same file; content byte-identical (`function cmdDashboard(opts) {`) at :1242, verified by re-reading the target line.
  "doc/state-machine-spec.md :: dispatcher.js:643-656", // MERGE (2026-09-23, chantier/sdk-transport + main #241): branch's own :643-656 (A5b-2 fix pass, F3) is what the merged orchestrator/dispatcher.js actually holds -- main's independent :635-648 re-pin (dated to the SAME action 11.1 fix pass the branch's history already accounts for, before F3's own +8-line shift) does not apply once F3's edit lands too, and PR #249 (2026-09-23) does not touch dispatcher.js at all; re-verified directly (`if (childrenSignalled && outcome === 'crashed') {` at :643, its own `return;` at :656).
  "doc/state-machine-spec.md :: intake.js:989-991", // PORT (card #167 onto main, 2026-09-23): :969-971 -> :989-991, card #167's INTAKE_MODELS import comment and its rotation-helper header comments land above triageBugReport's header, +20 net lines; content byte-identical at :989-991, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23, chantier/sdk-transport + main #241 + #249): branch had :958-960 (action A2's own +5-line shift), main independently re-pinned to :963-965 (card #240's own +10-line shift, its `./bash-policy` require and header comment) -- ADDITIVE at :968-970 as of the first merge (+5 then +10). PR #249 (2026-09-23) then added one more line (`const { OPUS_5_5 } = require('./step-contracts');`) above this point in intake.js's require block, shifting it one further line to :969-971; content byte-identical at :989-991, verified by re-reading the target lines.
  "orchestrator/README.md :: .claude/hooks/context-router.sh:117",
  "orchestrator/README.md :: SPO-WebClient/.claude/settings.json:109-127", // fix pass R1 (#206): the citation was true all along, it just cites the OTHER repo -- issue-429's PLAN ran with cwd in an SPO-WebClient worktree (base de2039e9), and `.claude/settings.json:109-127` there is the `"hooks": {` block through the third PreToolUse hook's `"timeout": 10` line, byte-identical at de2039e9/93528389/HEAD. Re-spelled with the `SPO-WebClient/` prefix so resolveCitationTarget routes it to the product repo instead of this one's own (109-line-shorter) settings.json.
  "orchestrator/README.md :: account-lease.js:189", // MERGE (2026-09-23, chantier/sdk-transport + main #241): branch had :167 (action A2's own +11-line shift above tryAcquireLease), main's own unmodified base was :156 (no card #239 chantier on that side). Content byte-identical at :189 (`tryAcquireLease`'s own `lock.acquireShortLock(...)` call -- the line the prose's own "-> lock.js:352 acquireShortLock" actually names), verified by re-reading the target line. PR #249 does not touch account-lease.js, so this merge leaves it unchanged.
  "orchestrator/README.md :: config.js:1072", // PORT (card #167 onto main, 2026-09-23): :1069 -> :1072, card #167 widened the `workers` K-clamp comment (+2) and the claudeAccountsDir comment (+1), both above productRepo, +3 net lines; content byte-identical at :1072, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23, chantier/sdk-transport + main #241): branch had :968 (action A2/A9 history), main independently re-pinned to :1000 (card #224's own MERGE_STEP_DEADLINE_MS block above productRepo). Both real, both merged; content byte-identical at :1072 (`productRepo: process.env.SPO_PRODUCT_REPO || path.join(os.homedir(), 'SPO-WebClient'),`), verified by re-reading the target line. PR #249 does not touch config.js, so this merge leaves it unchanged.
  "orchestrator/README.md :: dispatcher.js:643-656", // MERGE (2026-09-23): same fact and same correction as the doc/state-machine-spec.md entry above -- branch's :643-656 is what the merged file holds; main's independent :635-648 predates F3's own shift, and #249 does not touch dispatcher.js.
  "orchestrator/README.md :: doc/state-machine-spec.md:382", // MERGE (2026-09-23): branch had :382 (A9's own closing-testimony correction), main independently re-pinned to :380 (its own history stops one hop earlier, before A9's correction). Content byte-identical at :382 (the CHECK row, "| CHECK | script | invariant substring check first..."), verified by re-reading the target line -- the branch's number, confirmed rather than assumed. #249 does not touch doc/state-machine-spec.md's step table.
  "orchestrator/README.md :: intake.js:989-991", // PORT (card #167 onto main, 2026-09-23): :969-971 -> :989-991, card #167's INTAKE_MODELS import comment and its rotation-helper header comments land above triageBugReport's header, +20 net lines; content byte-identical at :989-991, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23): same fact and same correction as the doc/state-machine-spec.md :: intake.js entry above (A2's +5, card #240's +10, then #249's own +1-line OPUS_5_5 require, additive); content byte-identical at :989-991, verified by re-reading the target lines.
  "orchestrator/README.md :: lock.js:352", // re-pinned from :276, then :328 -- card #219's fix pass added the future-guard and an expanded LINUX_CLK_TCK comment (24 more lines) above acquireShortLock in the same file, a true pure shift; content byte-identical at :352
  "orchestrator/README.md :: lock.js:354-385", // re-pinned from :278-309, then :330-361, same reason as :276 -> :352 immediately above; content byte-identical at :354-385
  "orchestrator/README.md :: lock.js:386", // re-pinned from :310, then :362, same reason; content byte-identical at :386
  "orchestrator/auto-triage.js :: park-loop.js:1569", // re-pinned from :1396 -- card #212 added buildGateFactLine/shortSha and their own header comment (~50 net lines) above this precedent in the same file, a true pure shift; then :1446 -> :1453 in the same card's fix-pass (measured-figures correction + retry-cost rewording, +7 net lines) above the same precedent. Re-pinned again in card #212's C4/C5 build (Lot, 2026-09-14): :1453 -> :1566, a pure +113-line shift when park-loop.js gained RESUMABLE_PARK_REASONS/buildContinueLine/continueEligibility/buildContinueRefusedAck and the `continue` verb's own header/journal-doc comments above this precedent in the same file; content byte-identical at :1566, verified by re-reading the target line. Closing testimony corrected for card #239 A9 (the value had moved :1566 -> :1569 without this sentence being told, which the Rule B check in this file found): content byte-identical at :1569, verified by re-reading the target line.
  "orchestrator/auto-triage.js :: remote-report-pull.js:193",
  "orchestrator/auto-triage.js :: state-machine.js:3620", // PORT (card #167 onto main, 2026-09-23): :3591 -> :3620, card #167's resolveCallModel import comment and callLlmStep's stepModel block land above this point, +29 net lines; content byte-identical at :3620, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23): main's own history (card #231, then card #226's fix pass, +16 then +139) is what applies here -- the branch's :3436 predates both, since neither #231 nor #226 exist on chantier/sdk-transport. Content byte-identical at :3620 (the "Verification fix: appendDaemonEvent itself does an mkdirSync + appendFileSync -- on the" comment line), verified by re-reading the target line.
  "orchestrator/bench-queue-wait.js :: SPO-WebClient/src/e2e/bench/job.ts:361", // re-pinned from :325 -- SPO-WebClient's job.ts drifted independently of this repo (unaffected by this merge); purgeDone's mtime-gated `fs.rmSync(file, { force: true })` call this prose describes now sits at :361 (purgeDone's own declaration is :356), verified by reading SPO-WebClient/src/e2e/bench/job.ts directly, not inferred from a diff offset.
  "orchestrator/config.js :: worker.ts:1636", // re-pinned from :1542 -- SPO-WebClient's worker.ts drifted independently of this repo (unaffected by this merge); the `process.on('SIGTERM', () => process.exit(0))` line this prose describes now sits at :1636, verified by reading SPO-WebClient/src/e2e/bench/worker.ts directly, not inferred from a diff offset.
  "orchestrator/dispatcher.js :: daemon.js:658", // MERGE (2026-09-23): both sides share the identical :607 -> :637 -> :646 prefix; the branch's own history continues through action A2/F3's two further shifts (:646 -> :650 -> :656 -> :658) that main, lacking card #239's chantier, never saw. Content byte-identical at :658 (the "CARD #78: a call made HERE is an ORDINARY `killAllChildren('SIGTERM')`" comment), verified by re-reading the target line.
  "orchestrator/dispatcher.js :: daemon.js:677-678", // MERGE (2026-09-23): same shape as the :658 entry above -- shared prefix, branch's own A2/F3 shifts carry it further than main's :665-666. Content byte-identical at :677-678 (`process.once('exit', () => {` / the `killAllChildren('SIGTERM')` line inside it), verified by re-reading the target lines.
  "orchestrator/invariants.js :: doc/state-machine-spec.md:382", // MERGE (2026-09-23): same fact and same correction as the orchestrator/README.md :: doc/state-machine-spec.md entry above -- :382 is what the merged doc holds (A9's own closing-testimony correction), not main's independent :380.
  "orchestrator/invariants.js :: relative/path/to/file.ts:123",
  "orchestrator/journal.js :: auto-pull.js:58-66",
  "orchestrator/orphan-scan.js :: auto-pull.js:58-66",
  "orchestrator/orphan-scan.js :: daemon.js:963", // re-pinned from :912, then :942, then :955 (action A2, card #239) -- see this file's own prior history at each hop. Re-pinned again for this chantier's own A5b-2 fix pass, F3 (card #239, 2026-09-17): :955 -> :961, the SAME +6-line shift as dispatcher.js's daemon.js:650 -> :656 re-pin above; content byte-identical at :963 (`const recoveredOrphans = await orphanScan(queueDir, journalRoot, config);`), verified by re-reading the target line. PR #249 does not touch daemon.js, so this second merge leaves it unchanged.
  "orchestrator/park-loop.js :: doc/remediation-plan-2026-08.md:221", // re-pinned from :202 -- this action's isLiveStateRoot dry-run/shadow guard fix added 1 net line to the "Chantier gate" bullet above the row table in the same file, a true pure shift; content byte-identical at :203, verified by re-reading the target line. Re-pinned again in card #239's A1 fix pass (2026-09-17, F1): :203 -> :215 -> :219, two pure shifts (+12 then +4 net lines) from execution rule 6's two 2026-09-17 amendments (vendor/ scope, then the F4/F5/F6 correction pass) added above the row table in the same file. MERGE (2026-09-23): main independently re-pinned to :205 from its own history (a shorter path, no card #239 chantier); neither :219 nor :205 holds in the merged doc/remediation-plan-2026-08.md -- row 5.1 now reads at a new line; content byte-identical at :221, verified by re-reading the target line directly rather than summing either side's offset.
  "orchestrator/park-loop.js :: doc/remediation-progress.md:669", // re-pinned from :658 -- token-ledger lot Fix 10 added 6 lines to remediation-progress.md's C5-findings section above this bullet. MERGE (2026-09-23): main's own :669 (one hop further than branch's stale :664) is what the merged doc/remediation-progress.md actually holds; content byte-identical at :669 ("- **DIAGNOSE surfacing**: 6 tasks entered DIAGNOSE, 18 attempts total, 4 of them ending in a park."), verified by re-reading the target line.
  "orchestrator/park-loop.js :: intake.js:989-991", // PORT (card #167 onto main, 2026-09-23): :969-971 -> :989-991, card #167's INTAKE_MODELS import comment and its rotation-helper header comments land above triageBugReport's header, +20 net lines; content byte-identical at :989-991, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23): branch's A2 (+5) and main's card #240 (+10) land additively at :968-970, then PR #249's own +1-line OPUS_5_5 require shifts it one further to :969-971 -- same fact and same correction as the doc/state-machine-spec.md :: intake.js entry above; content byte-identical at :989-991, verified by re-reading the target lines.
  "orchestrator/state-machine.js :: auto-pull.js:58-66",
  "orchestrator/state-machine.js :: auto-pull.js:58-66",
  "orchestrator/state-machine.js :: orchestrator/steps/llm.js:1149", // PORT (card #167 onto main, 2026-09-23): :1116 -> :1149, card #167's resolveCallModel and its header land directly above runLlm, +33 net lines; content byte-identical at :1149, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23): branch's own history (through A9's CI fix pass) reaches :1113; main's card #240 (its own +14-line buildArgv --disallowedTools addition, since main never had A9's chantier) reaches :1063. Neither number is right for the merged tree -- both real edits land. Content byte-identical at :1149 (still `const contract = resolveStepContract(stepName, ctx.task || {});`), verified by re-reading the target line.
  "orchestrator/state-machine.js :: park-loop.js:1457", // action #80: UNDRAINABLE_STATES cites park-loop.js's ABANDONED-retry-unreachable gate; card #119 action 1.2 added 11 lines to reEnqueueTask's own header comment above this gate (:1262 -> :1273), and 1.2's verification repair added 10 more (-> :1283). Re-pinned in card #212 (Lot 10, 2026-09-13): :1283 -> :1334, a pure +51-line shift when park-loop.js gained buildGateFactLine/shortSha and the new buildParkComment tests' worth of header comment above this point in the file; then :1334 -> :1341 in the same card's fix-pass (+7 net lines, measured-figures correction + retry-cost rewording above the same point). Re-pinned again in card #212's C4/C5 build (Lot, 2026-09-14): :1341 -> :1454, a pure +113-line shift when park-loop.js gained RESUMABLE_PARK_REASONS/buildContinueLine/continueEligibility/buildContinueRefusedAck and the `continue` verb's own header/journal-doc comments above this gate in the same file; content byte-identical at :1454, verified by re-reading the target line. Closing testimony corrected for card #239 A9 (the value had moved :1454 -> :1457 without this sentence being told, which the Rule B check in this file found): content byte-identical at :1457, verified by re-reading the target line.
  "orchestrator/state-machine.js :: run.ts:63",
  "orchestrator/state-machine.js :: step-contracts.js:1203", // PORT (card #167 onto main, 2026-09-23): :1175 -> :1203, card #167's INTAKE_MODELS block (after OPUS_5_5) and its DIAGNOSE AVAILABILITY erratum land above this point, +28 net lines; content byte-identical at :1203, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23): branch's own history (through A9's closing-testimony correction) reached :1146; main's card #231 (+25 lines) then PR #249's own Opus-5.5 refactor (the OPUS_5_5 constant, the IMPLEMENT effort-map note, and escalationSignalFires replacing shouldEscalate's inline body, all above this point) reached :1102 on main alone. Neither number is right for the merged tree -- card #240's `./bash-policy`/disallowedTools addition (already in branch's :1146), plus main's #231 and #249 additions, all land; content byte-identical at :1203 (`if (task.touchesRdoMembers === true) return true; // source 3: intake's guess, undeclared plan`), verified by re-reading the target line rather than summed from either side's own arithmetic.
  "orchestrator/steps/llm.js :: intake.js:989-991", // PORT (card #167 onto main, 2026-09-23): :969-971 -> :989-991, card #167's INTAKE_MODELS import comment and its rotation-helper header comments land above triageBugReport's header, +20 net lines; content byte-identical at :989-991, verified by re-reading the target line(s) in the merged tree. Before that: MERGE (2026-09-23): same fact and same correction as the doc/state-machine-spec.md :: intake.js entry above; content byte-identical at :989-991, verified by re-reading the target lines.
  "orchestrator/steps/scripted.js :: run.ts:63",
  "orchestrator/steps/scripted.js :: verify-gate.js:336",
  "orchestrator/steps/scripted.js :: verify-gate.js:342",
  "orchestrator/steps/scripted.js :: worker.ts:1636", // re-pinned from :1542 -- same drift and same target as orchestrator/config.js's own entry above (SPO-WebClient's worker.ts:1636 is the `process.on('SIGTERM', () => process.exit(0))` line), verified by reading SPO-WebClient/src/e2e/bench/worker.ts directly.
  "orchestrator/steps/scripted.js :: worker.ts:751", // card #212: isGateMergeRefusalConfirmed's own comment cites worker.ts:751's refusal-detail literal ("<ref> does not merge cleanly with origin/main (base <sha>)"), confirmed against the real product repo (SPO-WebClient `0b5b5687`+).
  "orchestrator/steps/sdk-call.js :: daemon.js:111", // F8 fix pass: the killswitch header note cites daemon.js:103 (`require('./no-real-spawn-guard').installGuard();`, the first line after that file's own leading comment block) as the measured reason today's real daemon process happens to be safe -- confirmed by reading orchestrator/daemon.js directly. Resolved by basename (no directory prefix); unambiguous, daemon.js exists in this repo only under orchestrator/. Re-pinned for this chantier's own A5b-2 fix pass, F3 (card #239, 2026-09-17): :103 -> :109, a pure +6-line shift when F3's own daemon.js header edit (the --scanner split rationale, "STALE SINCE, NOT RE-VERIFIED") landed above this line; content byte-identical at :111 (`require('./no-real-spawn-guard').installGuard();`), verified by re-reading the target line.
  "orchestrator/steps/sdk-call.js :: llm.js:1096", // PORT (card #167 onto main, 2026-09-23): :1063 -> :1096, card #167's resolveCallModel and its header land above runLlm, +33 net lines; content byte-identical at :1096 (`jsonSchema: override.jsonSchema,`), verified by re-reading the target line in the merged tree. Before that: MERGE (2026-09-23): branch's own history (through the CI fix pass) reached :1060; main's card #240 (disallowedTools additions to runLlm's legacy override branch and to buildContractOptions, auto-merged cleanly into this file, unrelated to the sdk-transport conflict) added lines above this target too. Content byte-identical at :1096 (`jsonSchema: override.jsonSchema,`), verified by re-reading the target line.
  "orchestrator/steps/sdk-call.js :: llm.js:1096", // same target, cited a second time at the jsonSchema-parsing block's own comment further down this same file -- occurrences count separately here, same convention as the orchestrator/README.md:252 pair below. MERGE (2026-09-23) and PORT (card #167): same corrections as the row above.
  "orchestrator/steps/sdk-call.js :: orchestrator/README.md:252", // the module header's mention -- fix pass F7: originally cited a bare "README.md:247", which is genuinely ambiguous (5 tracked README.md files in this repo) and was corrected to the full path rather than allowlisted, since it was a real citation mistake, not a deliberate exception. The extractor counts occurrences, not distinct (file, citation) pairs, so this file's OTHER mention of the same target (normalizeAllowedTools's own comment, already written with the full path) gets its own row immediately below, not a dedup. RE-PINNED (fix pass 2026-09-23): :247 -> :252, the exemption's "confirmed by hand" comment had gone stale -- see the self-checking test next to CITATION_ANCHOR_ALLOWLIST below.
  "orchestrator/steps/sdk-call.js :: orchestrator/README.md:252", // normalizeAllowedTools's own comment -- same target as the row above, cited a second time in this file's prose.
  "prompts/README.md :: plan.md:103",
  "scripts/usage-report.js :: orchestrator/token-recovery.js:10-18",
];

test('every file:line citation in the 70-file corpus resolves, or is on the named allowlist', () => {
  // Immediate, named diagnosis if a file is added to or dropped from CORPUS_FILES without
  // updating this pin -- the EXPECTED_CITATIONS deepEqual below would also catch it (every
  // citation that file held would vanish from `found`), but that failure reads as "which
  // citations changed," not "the corpus scope itself changed." Checked first so the more likely
  // cause is named up front.
  assert.equal(CORPUS_FILES.length, 70, 'CORPUS_FILES gained or lost a file -- update the pinned list (and its own comment) in the same change, by name.');

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
  // a single citation is added, removed, or reworded anywhere in the 70-file corpus.
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
  const root = mkTmp('spo-citation-resolver-');
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  // env: gitEnv() is load-bearing here, not cosmetic -- under the pre-push hook GIT_DIR is
  // inherited, so this `init` would act on THIS repository and this `add -A` would stage into its
  // real index. See helpers.js's gitEnv for the measured incident.
  execFileSync('git', ['-C', root, 'init', '-q'], { env: gitEnv() });
  execFileSync('git', ['-C', root, 'add', '-A'], { env: gitEnv() });
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
//     widening it (see that constant, above) is what let this check find it at all. Fixed here to
//     `:1137`; SPO-WebClient#476 then moved `collectAll`'s call site to `:1102`, and
//     SPO-Pipeline#117's intake-token journalling moved it to `:1129` on 2026-09-04. Neither move
//     was caught by the corpus-wide anchor test (both bench docs sit in ANCHOR_EXCLUDED_FILES) nor
//     by EXPECTED_CITATIONS (which pins the docs' own citation text and never reads bin/spo): each
//     was caught by the mutation-proof canary below, whose second half anchors
//     bench-plan-derived's real citation against the real bin/spo directly, outside that
//     exclusion. The canary's own mutation had to be re-pointed at `:1102` (later `:1129`) when
//     the original `:1090-1093` started anchoring for an accidental reason (see it for the
//     detail). `bin/spo` has grown further since; each later move was caught the same way, and
//     since card #186 also by the collectAll test further below (both bench docs must cite the
//     SAME bin/spo line, and that line must name collectAll), which reads the real bin/spo line
//     both docs cite. Both dated-record sites now read `:1231` (pinned in EXPECTED_CITATIONS
//     above).
//
// Widening the resolver (E1, the fix that made part 2 read the real product tree instead of a
// stale nested worktree) plus THIS check together found nine more real, live drifts while this
// action was measured against the pinned corpus -- none hypothetical, all confirmed by reading
// the current target line and fixed in passing, the same "unambiguous fix, per this action's own
// brief" posture E5/E6/E12 already used in part 1.8/1.75/1.9: `config.js:615` (should be `:658`,
// `productRepo`), `doc/state-machine-spec.md:98`/`:49` (two citations, both should be the CHECK
// row's own "invariant substring check" promise -- `:140` when this note was written, `:150`
// since card #78 added 8 lines above the table), `worker.ts:689`'s chain continuation
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
//      within one un-clipped span -- `account-lease.js:189`, `dispatcher.js:643-656`, and
//      `verify-gate.js:336` on CITATION_ANCHOR_ALLOWLIST below are exactly this: a real, nearby
//      identifier that turned out to belong to a different clause than the one being cited, not a
//      wrong citation. Every one was read by hand and reasoned about below, not assumed.
//   4. Excludes `doc/bench-audit-2026-09-02.md` and `doc/bench-plan-derived-2026-09-02.md` from
//      THIS (identifier-based) anchor layer only (see ANCHOR_PIN_CHECKED_FILES below) -- as of
//      action 11.1 (#206) their own citations get a STRONGER check instead, a literal-text pin
//      (BENCH_PINS, test/citation-pins-data.js), not merely the bounds/dangling check part 2
//      still also runs on them unchanged. "Excluded" describes which CHECK runs, not whether one does.

// PINNED, not merely excluded (action 11.1, #206). These two are DATED, point-in-time audit
// records; the reasoning that first kept them out of THIS identifier-based layer still holds --
// re-measured for this action: anchoring today's product tree against their CURRENT citation
// finds only 6/26 (bench-audit) and 3/9 (bench-plan-derived) of their anchor-checkable
// citations, and anchoring their OWN commit's tree (the honest target for a dated record, and
// what a maintainer would actually want checked) still finds only 14/26 and 4/9 -- most misses
// are the nearest-candidate picker choosing a markdown-table label (`T02`, `W36`, `D11`) over
// the real citation, not a wrong citation. Per-fact allowlisting the gap (~20-26 entries) was
// rejected as disproportionate noise when this section first measured it (22 failures against a
// product tree that kept moving underneath the measurement itself -- `verdict.ts` alone went
// from 167 to 422 lines within one action's working session) and is rejected again here for the
// same reason: allowlisting a heuristic's blind spot one citation at a time does not make the
// heuristic right for this doc's vocabulary, it just hides that it isn't.
//
// So this action does not force these two docs through the identifier heuristic. It gives them
// something the heuristic cannot do at all: a PIN of the literal, trimmed text of the cited
// line(s), read once by hand and compared exactly against the file at the commit the record
// actually describes -- `test/citation-pins-data.js`'s BENCH_PINS, resolved by
// `test/citation-pins.js`'s resolvePins (tests below this exclusion, and below part 2.5's own
// tests). Every one of the 41 file-tied citations these two docs carry, other than the 2
// dangling `sanctuarize.test.ts:151-156` citations (CITATION_ALLOWLIST-only -- a deleted file has
// no line to pin against), now has a real content check for the first time; the `bin/spo`
// `collectAll` call site and `doc/state-machine-spec.md`'s FINISH row -- the two facts hand-
// maintained as true today rather than dated -- are pinned at HEAD instead of frozen. The one
// pre-existing exception this section already fixed in passing, `bin/spo:1090-1093` -> `:1137`
// (now `:1283`, card #219), is exactly that live fact; its catch is additionally proven
// by the mutation-proof canary further below, independent of this constant.
const ANCHOR_PIN_CHECKED_FILES = new Set(['doc/bench-audit-2026-09-02.md', 'doc/bench-plan-derived-2026-09-02.md']);

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
  // "...the same write-tmp-then-`linkSync` `tryCreate` daemon.lock uses too (`account-lease.js:189`
  // -> `lock.js:352` `acquireShortLock` -> `:386` `tryCreate`)": `tryCreate`/`linkSync` describe
  // `lock.js`'s daemon.lock idiom BY ANALOGY, two citations away in the same sentence -- not
  // account-lease.js:189's own content (`tryAcquireLease`'s own `lock.acquireShortLock(...)` call,
  // genuinely unnamed by either word in this prose). Confirmed correct: line 189 is exactly where
  // `tryAcquireLease` (orchestrator/account-lease.js) calls `lock.acquireShortLock` and returns.
  // MERGE (2026-09-23, chantier/sdk-transport + main): re-pinned from :167 -- that number was
  // already stale on the branch alone (unrelated to this merge; the allowlist's own "confirmed by
  // hand" claim was never re-verified after a prior shift moved this call past it), caught only
  // because this merge's own citation audit re-read every target line rather than trusting the
  // existing pin. Re-measured directly against the merged orchestrator/account-lease.js.
  'orchestrator/README.md :: account-lease.js:189':
    "nearest candidate ('tryCreate'/'linkSync') belongs to an earlier analogy about lock.js's " +
    "daemon.lock idiom, not to this citation's own content -- confirmed correct by hand: line " +
    '189 is where tryAcquireLease calls lock.acquireShortLock and returns.',
  // "...a worker killed during the dispatcher's OWN shutdown (... `dispatcher.js:643-656`) and any
  // owning daemon process that simply never comes back to run `handleExit` at all...": `handleExit`
  // is the SECOND clause's subject (the daemon-never-returns case, uncited), not the first
  // (dispatcher.js:643-656, the worker-killed-during-shutdown case this citation actually names).
  // Confirmed correct: lines 643-656 are exactly the `worker-exit-during-shutdown` handling this
  // prose describes (re-measured for card #78; VERIFIER CORRECTION: this is a REPAIR, not a shift
  // -- `main`:485-499 was `killScanner`, never the worker-exit-during-shutdown block, so the old
  // pin was wrong before this lot moved the block at all). Re-pinned again in action 11.1's fix
  // pass (D3, #206): :634-648 -> :635-648, the same one-line correction as doc/state-machine-
  // spec.md's own sibling citation -- :634 is a blank line, :635 is the block's own `if` line.
  // Re-pinned once more for this chantier's own A5b-2 fix pass, F3 (card #239, 2026-09-17):
  // :635-648 -> :643-656, a pure +8-line shift when F3's own dispatcher.js header edit (the
  // auto-triage "BLOCKING spawnSync" paragraph, corrected to "STALE SINCE, NOT RE-VERIFIED")
  // landed above this block; content byte-identical at :643-656, verified by re-reading.
  'orchestrator/README.md :: dispatcher.js:643-656':
    "nearest candidate ('handleExit') is the SUBJECT OF THE NEXT CLAUSE in the same sentence (a " +
    "daemon that never runs handleExit at all), not of this citation -- confirmed correct by " +
    'hand: lines 643-656 are the worker-exit-during-shutdown handling this prose actually names.',
  // "...other BLOCKED -- world lock, rate limit, or `verify-gate.js:336`'s capability-question
  // variant, where `required` can be empty...": the true subject is a PROSE PHRASE
  // ("capability-question variant"), not a code-shaped identifier -- `BLOCKED`/`GATE` are
  // incidental nearby words, not this citation's own content. Confirmed correct (fix pass 11.3
  // round 3, #190 verifier finding 4 -- the earlier "Stage 2/Stage 3 boundary" reading described
  // the STALE :308, not today's :336): line 336 is `artifact.verdict = 'BLOCKED';` itself, four
  // lines below the "capability question... BLOCKED" comment this "capability-question" prose
  // describes.
  'orchestrator/steps/scripted.js :: verify-gate.js:336':
    "no code-shaped candidate names this citation's true subject (a prose phrase, " +
    "'capability-question variant', not an identifier) -- 'BLOCKED'/'GATE' are incidental nearby " +
    "words. Confirmed correct by hand: line 336 is `artifact.verdict = 'BLOCKED';`, the capability-question outcome this prose describes.",
  // card #212: isGateMergeRefusalConfirmed's own comment cites worker.ts:751 for the
  // refusal-detail LITERAL TEXT itself (a template-string interpolation, not a code-shaped
  // identifier) -- the nearby candidates the heuristic finds ('NAME'/const from an unrelated
  // nearby capitalised word, 'jobId'/camel from this file's own surrounding prose) are incidental,
  // same shape as the verify-gate.js:336 entry just above. Confirmed correct by hand: worker.ts:751
  // is the exact `${request.ref} does not merge cleanly with origin/main (base ...)` string
  // isGateMergeRefusalConfirmed's own regex matches against.
  'orchestrator/steps/scripted.js :: worker.ts:751':
    "the citation's true subject is a template-literal STRING, not a code-shaped identifier -- " +
    "'jobId' (from this file's own nearby prose) and 'NAME' are incidental. Confirmed correct by " +
    "hand: line 751 is the exact \"does not merge cleanly with origin/main\" template literal.",
  // Fix pass R1 (#206): "...issue-429's *cites* `SPO-WebClient/.claude/settings.json:109-127` as
  // evidence, never proposing to touch it...": the only candidate this window finds is a 'file'
  // substring match on "settings" itself (the citation's own filename), which the target JSON
  // content -- the `"hooks": {` block through the third PreToolUse hook's `"timeout": 10` line --
  // never contains. A JSON config value has no code-shaped identifier or cross-file mention to
  // anchor on; this is the same "no code-shaped candidate names this citation's true subject"
  // shape as verify-gate.js:336 above, not a wrong citation. Confirmed correct by hand: lines
  // 109-127 at 935283890fa0593c5c5d0b41cceeaec2c1972c6f are exactly that hooks block.
  'orchestrator/README.md :: SPO-WebClient/.claude/settings.json:109-127':
    "the only nearby candidate is a 'file' substring match on \"settings\" (the citation's own " +
    "filename), which the cited JSON content never contains -- a config value has no code-shaped " +
    'identifier to anchor on. Confirmed correct by hand: lines 109-127 (at 93528389) are the ' +
    '`"hooks": {` block through the third PreToolUse hook\'s `"timeout": 10` line.',
  // Action A3 (card #239) cites orchestrator/README.md:252 twice (the module header and
  // normalizeAllowedTools's own comment), both times for the same reason: it is the LEGACY
  // override path's documented `allowedTools: 'Read Grep'` example -- a quoted STRING LITERAL,
  // not a code-shaped identifier, so the heuristic's nearest candidates ('README'/const from the
  // citation's own filename, 'runLlm'/camel from this file's own nearby prose about the override
  // branch) are incidental, the same "no code-shaped candidate names this citation's true
  // subject" shape as the verify-gate.js:336 and SPO-WebClient .claude/settings.json entries above (not
  // repeating that entry's own citation string here -- it is a bare filename:line-number shape that
  // the citation scanner in this very file would extract as a second, unqualified, and therefore
  // wrongly-resolved reference to THIS repo's own, much shorter, settings.json).
  //
  // RE-PINNED (fix pass 2026-09-23): this entry used to say ":247" and claim "confirmed correct by
  // hand: line 247 ... is exactly `allowedTools: 'Read Grep'`". That had gone stale -- the README
  // grew a line above the example at some point after the hand check, and the anchor heuristic
  // that would normally catch a drifted citation cannot fire here (the target is a string literal,
  // not a code-shaped identifier), so nothing noticed until this fix pass re-read the README by
  // hand and found the real line at :252. A by-hand confirmation with no mechanical backstop goes
  // stale silently, so this entry is no longer "confirmed by hand" alone: the
  // 'CITATION_ANCHOR_ALLOWLIST[...] :247 exemption stays true' test below reads this exact README
  // line at test time and asserts it is still the `allowedTools: 'Read Grep'` example, so a future
  // drift fails loudly instead of waiting for the next by-hand audit.
  'orchestrator/steps/sdk-call.js :: orchestrator/README.md:252':
    "the citation's true subject is a quoted string literal ('Read Grep'), not a code-shaped " +
    "identifier -- 'README' (from the citation's own filename) and 'runLlm' (from this file's " +
    'own nearby prose) are incidental. Line 252 is exactly ' +
    "`  allowedTools: 'Read Grep',      // optional` -- kept true by the self-checking test below " +
    "rather than a by-hand confirmation alone, since this target cannot be anchor-checked.",
};

function isAnchorAllowlisted(rel, raw) {
  return isCitationAllowlisted(CITATION_ANCHOR_ALLOWLIST, rel, raw);
}

test('CITATION_ANCHOR_ALLOWLIST holds exactly the entries this action explicitly justified -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(CITATION_ANCHOR_ALLOWLIST).sort(),
    [
      'orchestrator/README.md :: SPO-WebClient/.claude/settings.json:109-127',
      'orchestrator/README.md :: account-lease.js:189',
      'orchestrator/README.md :: dispatcher.js:643-656',
      'orchestrator/steps/scripted.js :: verify-gate.js:336',
      'orchestrator/steps/scripted.js :: worker.ts:751',
      'orchestrator/steps/sdk-call.js :: orchestrator/README.md:252',
    ],
    'CITATION_ANCHOR_ALLOWLIST changed size or membership -- read the new/changed citation by ' +
      'hand against its target before adding an entry; this pin needs updating in the same change, by name.'
  );
});

// The one CITATION_ANCHOR_ALLOWLIST entry whose exemption comment is a hand confirmation with no
// mechanical backstop (its target, orchestrator/README.md:252, is a quoted STRING LITERAL, so the
// anchor heuristic above has no code-shaped candidate to check it against) went stale exactly this
// way: the comment said "confirmed correct by hand: line 247 is exactly `allowedTools: 'Read
// Grep'`" long after the README had drifted to :252, and nothing failed until this fix pass
// re-read the file by hand. Rather than leave the next drift to the next by-hand audit, this test
// reads the real line at test time and asserts it still holds the example the allowlist entry
// names -- the smallest mechanical check this exemption's target admits.
test('the README.md:252 allowlist exemption stays true -- the cited line is still the allowedTools example', () => {
  const lines = read('orchestrator/README.md').split('\n');
  assert.equal(
    lines[251],
    "  allowedTools: 'Read Grep',      // optional",
    'orchestrator/README.md:252 no longer holds the legacy allowedTools string example this ' +
      'CITATION_ANCHOR_ALLOWLIST entry names -- re-pin sdk-call.js\'s two citations, the ' +
      'EXPECTED_CITATIONS rows, and this allowlist entry (key, comment, and membership test) to ' +
      'wherever the example moved, then update this line number.'
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
  const anchorCorpus = CORPUS_FILES.filter((rel) => !ANCHOR_PIN_CHECKED_FILES.has(rel));
  // Named floor, not a silent "no exclusions happened": if a future edit to CORPUS_FILES or
  // ANCHOR_PIN_CHECKED_FILES drops this to 2 or fewer, that is exactly the two dated docs swallowing
  // the whole corpus (or a mis-typed exclusion) and this fails loudly instead of quietly checking nothing.
  assert.equal(anchorCorpus.length, CORPUS_FILES.length - ANCHOR_PIN_CHECKED_FILES.size, 'ANCHOR_PIN_CHECKED_FILES no longer matches exactly two CORPUS_FILES entries by name.');

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

  // Named-first (comment 4 on #206: "a failure does not say which citation broke"): every count
  // assertion below this point (`anchored`, `unanchorable`) is preceded by naming any offender, so
  // a drift is reported BY CITATION before either count assertion gets a chance to just say a
  // number changed -- D1 of the 11.1 fix pass: this used to sit AFTER `assert.equal(anchored, 36,
  // ...)`, so a drift still failed with only "found 35", the exact complaint it was meant to fix.
  assert.deepEqual(offenders, [], `citation(s) whose own prose names something NOT found near the cited line -- a drift this check exists to catch:\n  ${offenders.join('\n  ')}`);

  // Re-measured 2026-09-03 after M17's symbol-citation conversion: 22 verified (was 26), 3
  // unanchorable (unchanged then; 2 since 2026-09-04 -- see the note on the pin itself below). The 4 that left the anchored set are the 4 line-number citations
  // converted to symbol citations in the same change -- `worker.ts:129`/`:997`/`:131`/`:130-131`
  // -- each now checked by part 1.8's symbol check instead, against the symbol its own prose
  // already named. They did not stop being checked; they stopped being checked BY LINE NUMBER.
  //
  // Original measurement, for the shape of the unanchorable set: 26 verified,
  // 3 unanchorable -- `orchestrator/park-loop.js :: intake.js:796-798`, `orchestrator/steps/
  // scripted.js :: verify-gate.js:342`, and `prompts/README.md :: step-contracts.js:99` (deleted
  // by #109, leaving the two still listed here) -- each citing a
  // fact its own surrounding prose never names with a code-shaped identifier or a cross-file
  // mention -- correctly unverifiable, not wrong -- 3 on CITATION_ANCHOR_ALLOWLIST (already
  // excluded above), 0 unexplained offenders after this action's own fixes landed. Both counts
  // pinned by NAME, not by floor -- constraint 2 in this action's own brief: "cannot verify" must
  // never silently grow into an escape hatch, so the unanchorable population is capped here
  // exactly like PINS/EXPECTED_CITATIONS above.
  // Note (2026-09-10): the `intake.js:797-799` half of that first-named citation has since moved
  // twice on the live file -- to :854-856 by issue #196's own label-inventory-filter action, then
  // to :869-871 by this repair round's UNKNOWN-inventory reversal and header rewrite -- see
  // EXPECTED_CITATIONS above for the current string. This paragraph is left naming the citation
  // as it read at the time of the original measurement; the stale string here does not affect
  // what the sweep checks because CORPUS_FILES excludes `test/**` entirely (see ~:629-632 above),
  // not because of this file's own CITATION_ANCHOR_ALLOWLIST membership.
  // card #102 (2026-09-05): +5 citations to auto-pull.js:58-66 (journal.js, orphan-scan.js,
  // state-machine.js x2) and orphan-scan.js :: daemon.js:910 (card #102 pinned it :714), all in
  // the anchor-checked corpus.
  // Re-measured: 27 verified (was 22), 2 unanchorable (unchanged), 0 offenders. All 5 new
  // citations anchor -- each has a real symbol from auto-pull.js:58-66 (computeAutoPullBudget,
  // queued, inFlight) placed close enough in the citing prose to out-rank any other nearby
  // candidate; daemon.js:910 anchors on its own nearby prose. See EXPECTED_CITATIONS above for
  // the exact 5 additions.
  // card #80 (2026-09-06): +1 citation, `orchestrator/state-machine.js :: park-loop.js:1262`
  // (UNDRAINABLE_STATES's own header, explaining why ABANDONED is refused but PARKED is not).
  // Re-measured: 28 verified (was 27), 2 unanchorable (unchanged), 0 offenders. It anchors on
  // 'PARKED' (quoted, const-shaped) and `reconcileExternalClosure` (camelCase) -- either one
  // alone is enough to anchor it, and `reconcileExternalClosure` alone is what still anchors it
  // one line up, at park-loop.js:1261 ("...only reconcileExternalClosure runs for it.") -- see
  // ANCHOR_BLUNT_CITATIONS below for why that also makes it blunt, not merely anchored.
  // rdo-symmetry (2026-09-06): +1 citation, `orchestrator/state-machine.js :: step-contracts.js:326`
  // (resolveRdoDiffTouched's strict-boolean rationale). Re-measured: 29 verified (was 28), 2
  // unanchorable (unchanged), 0 offenders. It anchors on `touchesRdoMembers` (camelCase), present
  // verbatim on step-contracts.js:326 itself (`touchesRdoMembers === true`).
  // card #78 (2026-09-07): no citation added or removed, but this action's own doc/comment fixes
  // (correcting the now-false "crash repark runs in-process" claim across the tree) moved SEVEN
  // already-pinned targets. VERIFIER CORRECTION (same card): the first cut of this note said FIVE
  // and called every one "the SAME logical target, re-measured after this action's own edits added
  // prose above it". Measured against `main`, three of those claims are false and two targets were
  // missed outright, so the honest list is:
  //   - auto-pull.js's read-order paragraph, :49-57 -> :58-66 (cited from journal.js,
  //     orphan-scan.js and twice from state-machine.js -- one un-clipped span, moves together).
  //     A TRUE pure shift: this action added 9 lines above it in the same file.
  //   - doc/state-machine-spec.md's CHECK-table citation, :140 -> :150 (two citing files). NOT a
  //     pure shift: this action's Principle-2 edits moved the table by 8 lines, and the old pin
  //     :140 was the PLAN row, not the CHECK row (`main`:142 was CHECK). A pre-existing off-by-two
  //     was repaired in the same edit; :150 IS the CHECK row today.
  //   - dispatcher.js's worker-exit-during-shutdown block, :634-648, cited from BOTH docs. NOT
  //     "two stale numbers for the same block": `main`:572-586 (doc/state-machine-spec.md's pin)
  //     WAS that block, correctly; `main`:485-499 (orchestrator/README.md's pin) was `killScanner`.
  //     Only the README pin was stale, and the lot's own dispatcher.js commits -- not this
  //     documentation action -- moved the block to 634-648.
  //   - daemon.js's unconditional startup orphanScan call, :714 -> :910 (cited from
  //     orphan-scan.js). NOT a shift of 8: `main`:714 is `shadowMode: !!opts.shadow,` and the call
  //     was already at `main`:902. A 188-line pre-existing drift, repaired here; :910 is the call.
  //   - MISSED BY THE FIRST CUT, re-pinned by the verifier: doc/state-machine-spec.md:128, cited
  //     from doc/bench-audit-2026-09-02.md AND doc/bench-plan-derived-2026-09-02.md. This action's
  //     +8 lines in Principle 2 pushed that content to :136, leaving both pins stale; the bounds
  //     check could not see it (the line still exists) and the anchor check never runs on those
  //     two dated docs (ANCHOR_EXCLUDED_FILES). Both were ALREADY wrong before the shift -- their
  //     prose names FINISH's "fast-forward the main checkout" promise, which is the FINISH row --
  //     so they are re-pinned to :157, the row that actually carries it.
  // Every current pin above was opened at its cited line and read by hand. `anchored` is unchanged
  // at 29 (the two re-pinned bench-doc citations are anchor-excluded and count in neither number).
  // card #161 (2026-09-09): +3 anchored citations, `orchestrator/auto-triage.js :: park-loop.js:1396`,
  // `:: remote-report-pull.js:193` and `:: state-machine.js:2923`, all three to the identical
  // best-effort appendDaemonEvent-try/catch precedent. `appendDaemonEvent` sits inside every one of
  // the three citations' own same-sentence anchor windows, so all three anchor on it directly --
  // no CITATION_ANCHOR_ALLOWLIST entry and no unanchorable bump needed. 29 -> 32.
  // card #162 (2026-09-09, found while gating card #164): action 1 of the lot 162-164/164 pair
  // added two citations to dispatcher.js's own best-effort catch{} around `dispatcher-stopped`'s
  // emit -- `daemon.js:607` and `daemon.js:626` -- without updating EXPECTED_CITATIONS or either
  // count below (the gate for that action was not run to green before this action started).
  // Re-measured by hand: `daemon.js:607` anchors directly -- both nearby candidates
  // (`killAllChildren`/camel, `SIGTERM`/const) appear verbatim on line 607 itself
  // ("a call made HERE is an ORDINARY `killAllChildren('SIGTERM')`"). `daemon.js:626` on its own
  // does NOT -- line 626 is only `process.once('exit', () => {`, and the two candidates the
  // heuristic finds nearby (from the NEXT clause, describing what the hook does once it fires)
  // are not on that single line. NOT put on CITATION_ANCHOR_ALLOWLIST for this: the citation was
  // simply too narrow, not unverifiable -- `killAllChildren('SIGTERM')` IS the very next line, so
  // the fix is widening the citation itself to the range that actually contains what it names,
  // `daemon.js:626-627`, not exempting it from the check. Re-pinned in dispatcher.js and
  // EXPECTED_CITATIONS accordingly. Both now anchor with zero offenders. 32 -> 34.
  // SPO-Pipeline#170 (2026-09-10): +1 citation, `scripts/usage-report.js :: orchestrator/token-
  // recovery.js:10-18`, added to usage-report.js's own header when it started sharing
  // console/usage-scan.js's discovery/dedup logic instead of carrying a diverging copy (the
  // "exactly one reader" argument that range makes). It anchors: `scanFile` (line 12) and
  // `reader` (lines 12, 15, 16) appear verbatim within lines 10-18 (the paragraph the citation
  // targets), so the heuristic finds a candidate in range. 34 -> 35.
  // card #213 action 2 (2026-09-12): `orchestrator/state-machine.js :: step-contracts.js:461`
  // stopped anchoring mid-lot, when action 2's own rewrite of shouldEscalate (STEP_CONTRACTS'
  // IMPLEMENT entry, the vocabulary preamble, and shouldEscalate itself, all ahead of :461 in the
  // file) pushed `touchesRdoMembers === true` down to :527. Re-pinned in both state-machine.js's
  // citing comment and EXPECTED_CITATIONS to :1029 (as of this writing -- see EXPECTED_CITATIONS's own re-pin history above), where it anchors again -- `touchesRdoMembers
  // === true` sat verbatim on that exact line at the time, inside shouldEscalate's rewritten body
  // (`if (task.touchesRdoMembers === true) return true; // source 3: intake's guess, undeclared
  // plan`). That re-pin is COUNT-NEUTRAL, and the note that used to stand here said otherwise:
  // the citation was already counted as `anchored` at :432 on origin/main and is `anchored` again
  // at :527, so it never left the population. The 35 -> 36 comes entirely from a DIFFERENT and
  // brand-new citation this lot added -- `orchestrator/state-machine.js :: orchestrator/steps/
  // llm.js:975`, in action 2's new handleImplement comment. Measured by removing only that
  // citation with the :527 re-pin left in place: anchored falls back to 35. Both edits are
  // load-bearing (reverting either turns 2 tests red); only the attribution was wrong, and it is
  // corrected here because a pin justified by the wrong change is exactly what this by-name
  // mechanism exists to prevent -- the next reader who moves shouldEscalate would otherwise
  // "correct" the count in the wrong direction.
  // MERGE (2026-09-23, chantier/sdk-transport + main): 36 -> 39. The +3 is entirely the SPO-
  // WebClient product-repo drift this file's own header note on job.ts/worker.ts already
  // describes: `orchestrator/bench-queue-wait.js :: SPO-WebClient/src/e2e/bench/job.ts:325` and
  // `orchestrator/config.js :: worker.ts:1542` / `orchestrator/steps/scripted.js :: worker.ts:1542`
  // were OFFENDING on this chantier's own branch tip (788ca0f) -- the one pre-existing failure
  // measured before this merge -- because job.ts/worker.ts had drifted independently in
  // ~/SPO-WebClient. Main's own commit `6c43c05` already re-pinned all three to their real current
  // lines (:361, :1636, :1636) before this merge; bringing that commit in moves all three from
  // OFFENDING to ANCHORED, closing the branch's one known failure rather than adding a new
  // citation. Measured by diffing the anchored-key list against a run on 788ca0f alone: those
  // three keys are the entire delta, nothing else entered or left the anchored population.
  assert.equal(anchored, 39, `expected 39 verified anchor matches, found ${anchored} -- a citation moved between verified/unanchorable/offending; re-measure and update this pin by name.`);
  // 3 -> 2 on 2026-09-04: prompts/README.md's PLAN row cited `step-contracts.js:99` to explain an
  // "Opus 5 fallback" that could never fire (its only trigger, `task.escalate`, was set nowhere).
  // The escalation was deleted, so the row no longer makes the claim and no longer needs the
  // citation. The population SHRANK -- which is the direction this pin is happy to move in; it
  // exists to stop "cannot verify" growing SILENTLY, not to stop it growing at all -- a genuinely
  // unverifiable citation is still added by name, read by hand, and justified here, same as every
  // other pin in this file.
  // card #161 (2026-09-09): +2 citations, `orchestrator/auto-triage.js :: park-loop.js:1396` and
  // `:: remote-report-pull.js:193`, both to the identical best-effort appendDaemonEvent-try/catch
  // precedent (a third, state-machine.js:2923, cites the same precedent). The prose was written so
  // `appendDaemonEvent` itself falls inside each citation's same-sentence anchor window rather than
  // being clipped off by an adjacent citation. Re-measured: 32 anchored (was 29 -- see the pin
  // above), 2 unanchorable (unchanged), 0 offenders -- all three new citations anchor on
  // `appendDaemonEvent` itself, not on an allowlist entry.
  assert.equal(unanchorable, 2, `expected exactly 2 unanchorable citations (no code-shaped candidate named nearby) -- found ${unanchorable}. This count is pinned so "cannot verify" cannot silently grow into a way to dodge this check.`);
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
  // README.md: "`doc/state-machine-spec.md:382` has always promised CHECK runs an invariant
  // substring check". The target is the spec's own step TABLE, where `CHECK` is both a step name
  // and the "next state" cell of the rows above it -- several consecutive lines all contain the
  // bare word, so no identifier-level rule can separate one row from its neighbour when the
  // discriminating token is the table's own column value. Re-measured for card #78, then
  // RE-re-measured by the verifier; re-pinned again in card #211's fix-pass (:150 -> :159);
  // card #212 C1 (:159 -> :200); card #212 C2 (:200 -> :263); card #212's fix pass F1/F2/F3/F6
  // (:263 -> :308, then a further +3-line measured-figures correction -> :311) -- every one a
  // true pure shift, same target, same shape. Re-pinned again in card #212's C4/C5 build (Lot,
  // 2026-09-14): :311 -> :380, a pure +69-line shift when doc/state-machine-spec.md gained the
  // `continue` verb's own "Resume at CHECK" subsection above the step table; content
  // byte-identical -- `grep -n '^| CHECK |' doc/state-machine-spec.md` confirms :380 IS the CHECK
  // row today.
  'orchestrator/README.md :: doc/state-machine-spec.md:382':
    "target is a markdown step TABLE whose 'CHECK' cell is the column value on several consecutive " +
    'rows -- the anchor word is the column value itself, so a neighbouring row anchors just as well. ' +
    'Citation confirmed correct by hand: 380 is the CHECK row.',
  // park-loop.js: "doc/remediation-progress.md:669 confirms the same referent under 'DIAGNOSE
  // surfacing'" (re-pinned from :658 -- token-ledger lot Fix 10 added 6 lines above this bullet in
  // remediation-progress.md, a true pure shift). Line 664 is the bullet's own heading line and 665
  // is its continuation, which opens with the same word ("DIAGNOSE has no column..."). Correct
  // citation, two-line bullet.
  'orchestrator/park-loop.js :: doc/remediation-progress.md:669':
    "target is a two-line prose bullet whose subject word ('DIAGNOSE') opens both 664 and its own " +
    'continuation line 665. Citation confirmed correct by hand: 664 is the bullet heading.',
  // state-machine.js: UNDRAINABLE_STATES's own header cites park-loop.js:1457 (`if
  // (state.state !== 'PARKED') continue;`) for why ABANDONED's retry branch is unreachable. Line
  // 1453, the comment immediately above the cited gate, reads "...not change that; only
  // reconcileExternalClosure runs for it." -- `reconcileExternalClosure` ALONE is on that line
  // ('PARKED' itself is quoted on 1452 and on the cited line 1454, not on 1453), and that one
  // candidate is enough on its own to make the citation anchor a line up too. Citation confirmed
  // correct by hand: 1454 IS the gate line. Re-pinned from :1262 for card #119 action 1.2, which
  // added 11 lines to reEnqueueTask's own header comment (documenting the poolWaitMs/
  // poolWaitAttempts strip) above this gate; then :1262 -> :1273 -> :1283 by that same and a
  // follow-up verification repair, then :1283 -> :1334 -> :1341 by card #212's build and its own
  // fix-pass, then :1341 -> :1454 by card #212's own C4/C5 build (+113 net lines, RESUMABLE_PARK_REASONS/
  // buildContinueLine/continueEligibility/buildContinueRefusedAck and the `continue` verb's own
  // header/journal-doc comments) -- all pure shifts, same target, same shape.
  'orchestrator/state-machine.js :: park-loop.js:1457':
    "target's own preceding comment line (1453) already names 'reconcileExternalClosure' -- that " +
    "one candidate alone anchors it a line up ('PARKED' itself is quoted on 1452 and on the cited " +
    'line 1454, not on 1453). Citation confirmed correct by hand: 1454 is the ' +
    '`if (state.state !== \'PARKED\') continue;` line.',
};
// NOT retired by action 11.1 (#206), even though these same 3 citations also carry a literal-text
// HEAD pin now (BLUNT_PINS, test/citation-pins-data.js) that DOES discriminate a +/-1 drift on all
// three (see this action's own corpus-wide pin mutation-proof test, further below) -- because the
// property this constant/test pins is narrower and still literally true: the IDENTIFIER heuristic
// on its own cannot discriminate these three, regardless of what else now also checks them. The
// corpus-level blind spot these three names is CLOSED (BLUNT_PINS would catch a drift on any of
// them), but the identifier-only property this section measures is unchanged, so the pin is kept
// rather than retired.

test('ANCHOR_BLUNT_CITATIONS holds exactly the citations measured unable to discriminate one line -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(ANCHOR_BLUNT_CITATIONS).sort(),
    [
      'orchestrator/README.md :: doc/state-machine-spec.md:382',
      'orchestrator/park-loop.js :: doc/remediation-progress.md:669',
      'orchestrator/state-machine.js :: park-loop.js:1457',
    ],
    'ANCHOR_BLUNT_CITATIONS changed size or membership -- read the new citation against its target ' +
      'by hand and justify it here before pinning it, exactly as CITATION_ANCHOR_ALLOWLIST requires.'
  );
});

// EXPECTED_DISCRIMINATING_CITATIONS -- action 11.1 (#206), comment 4's own finding ("a failure
// does not say which citation broke"): named by key, same idiom as EXPECTED_CITATIONS/
// CITATION_ALLOWLIST above, so a citation entering or leaving the DISCRIMINATING population
// (below) fails by NAME (assert.deepEqual's own diff) instead of only moving a count. The
// RANGES population is named the same way without a second list: it is, by construction, the
// exact set of citations pinned in LIVE_RANGE_PINS (test/citation-pins-data.js) -- both walks
// enumerate the identical corpus-wide range citations, so re-deriving a second name list here
// would only ever be able to drift from that one, never usefully disagree with it.
// Card #239 chantier, action A5b (2026-09-17): re-measured after the transport cutover, which
// touched orchestrator/steps/llm.js, orchestrator/step-contracts.js, orchestrator/state-machine.js
// and orchestrator/steps/sdk-call.js heavily enough to shift several cited lines (llm.js:1078 ->
// :929, step-contracts.js:1078 -> :1087).
//
// CORRECTION (Opus verifier, fix pass F6): an earlier draft of this note claimed the three
// sdk-call.js citations below (`daemon.js:103` and `llm.js:882`, the latter cited twice, from two
// separate sites in sdk-call.js) "only became discriminating because of VERTICAL SHIFT in that
// file's own surrounding comments" -- false. Re-measured against a clean checkout of this
// chantier's own baseline, 202d2ea (the commit action A5a's own fix pass left behind): the mutation
// proof there ALREADY reports all three as discriminating, under their PRE-A5b numbers
// (`orchestrator/steps/sdk-call.js :: daemon.js:103` -- unchanged by A5b -- and `:: llm.js:1031`
// x2). They were never blunt and never absent from the corpus; A5a's own EXPECTED_DISCRIMINATING_
// CITATIONS list was simply left stale (it never named them, at any line number), and this action's
// row-by-row diff against that stale list makes them read as "new" even though the citations
// themselves are not. A5b's contribution here is exactly the line renumbering already recorded
// above (`llm.js:1031 -> :882`; `daemon.js:103` did not move at all) -- it did not make anything
// newly discriminating, it corrected which line number an already-discriminating citation is
// pinned to. `SPO-WebClient/src/e2e/bench/job.ts:325` and `worker.ts:1542` (two entries, one cited
// from orchestrator/bench-queue-wait.js and orchestrator/config.js, the other ALSO from
// orchestrator/steps/scripted.js) left this population entirely -- they now fail the ANCHOR check
// itself (a pre-existing SPO-WebClient sibling-repo drift, unrelated to this action: `job.ts`/
// `worker.ts` moved independently of this chantier -- see the main anchor test's own failure for
// the two lines' current content) and a citation that fails anchoring is not counted as
// discriminating one-line drift in the first place. This half of the note is accurate and unchanged.
//
// Re-pinned again for action A5b-2's Job 2 fix pass (card #239, 2026-09-17): Job 2 restored
// invokeClaudeReal's session-id minting in llm.js (a ~80-line block, header comment included) above
// BOTH of this file's own targets in llm.js -- `llm.js:929 -> :1009` (the state-machine.js entry)
// and `llm.js:882 -> :962` (the sdk-call.js entries, x2) -- a pure shift, content byte-identical at
// both new line numbers, verified by re-reading each target line (see the EXPECTED_CITATIONS/
// EXPECTED_DISCRIMINATING_CITATIONS rows themselves for the same note). `daemon.js:103` did not
// move at that hop (unaffected by A5b-2's Job 2, same as it was unaffected by A5b).
//
// Re-pinned once more for this chantier's own A5b-2 FIX PASS (F1-F5, card #239, 2026-09-17,
// same day): F2's `deps.query/deps.buildQueryOptions/deps.randomUUID` correction (replacing the
// stale "deps.spawnSync convention" claim) shifted BOTH llm.js targets again -- `llm.js:1009 ->
// :1011` (state-machine.js entry) and `llm.js:962 -> :964` (sdk-call.js entries, x2), a pure
// +2-line shift each. F3's own daemon.js header edit (the --scanner split rationale, "STALE
// SINCE, NOT RE-VERIFIED") shifted every daemon.js target by the same +6 lines: `daemon.js:650 ->
// :656` (dispatcher.js entry), `daemon.js:955 -> :961` (orphan-scan.js entry), and `daemon.js:103
// -> :109` (sdk-call.js entry, which DID move this time, unlike at the Job 2 hop above). All six
// shifts are pure -- content byte-identical at each new line number, verified by re-reading.
const EXPECTED_DISCRIMINATING_CITATIONS = [
  // MERGE (2026-09-23, chantier/sdk-transport + main): every line number below is re-measured
  // directly against the merged tree, matching EXPECTED_CITATIONS's own corrected entries above --
  // see that array's own MERGE-dated comments for the per-citation reasoning (which branch's
  // shift applies, or whether both apply additively).
  'doc/board-audit.md :: config.js:1228',
  'doc/board-audit.md :: orchestrator/steps/scripted.js:1410',
  'doc/board-audit.md :: report-intake.js:29',
  'doc/state-machine-spec.md :: bin/spo:1242',
  'orchestrator/README.md :: config.js:1072',
  'orchestrator/README.md :: lock.js:352',
  'orchestrator/README.md :: lock.js:386',
  'orchestrator/auto-triage.js :: park-loop.js:1569',
  'orchestrator/auto-triage.js :: remote-report-pull.js:193',
  'orchestrator/auto-triage.js :: state-machine.js:3620', // re-pinned from :3574, see EXPECTED_CITATIONS's own entry above for the corrected shift.
  'orchestrator/bench-queue-wait.js :: SPO-WebClient/src/e2e/bench/job.ts:361', // re-pinned from :325, see EXPECTED_CITATIONS's own entry above for the drift.
  'orchestrator/config.js :: worker.ts:1636', // re-pinned from :1542, see EXPECTED_CITATIONS's own entry above for the drift.
  'orchestrator/dispatcher.js :: daemon.js:658',
  'orchestrator/invariants.js :: doc/state-machine-spec.md:382',
  'orchestrator/orphan-scan.js :: daemon.js:963',
  'orchestrator/park-loop.js :: doc/remediation-plan-2026-08.md:221',
  'orchestrator/state-machine.js :: orchestrator/steps/llm.js:1149',
  'orchestrator/state-machine.js :: run.ts:63',
  'orchestrator/state-machine.js :: step-contracts.js:1203',
  'orchestrator/steps/scripted.js :: run.ts:63',
  'orchestrator/steps/scripted.js :: worker.ts:1636',
  'orchestrator/steps/sdk-call.js :: daemon.js:111',
  'orchestrator/steps/sdk-call.js :: llm.js:1096',
  'orchestrator/steps/sdk-call.js :: llm.js:1096',
  'prompts/README.md :: plan.md:103',
];

test('MUTATION PROOF, corpus-wide: every single-line citation the anchor check accepts stops anchoring when its line is shifted by one', () => {
  const anchorCorpus = CORPUS_FILES.filter((rel) => !ANCHOR_PIN_CHECKED_FILES.has(rel));
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
  // card #102 (2026-09-05): re-measured after +5 new citations (see the main anchor test's own
  // note above). 4 of the 5 are ranges (auto-pull.js:58-66, cited from journal.js, orphan-scan.js,
  // and twice from state-machine.js) -- ranges is 5 -> 9. The 5th (orphan-scan.js's own
  // daemon.js:910, pinned :714 at the time) is single-line and discriminates -- discriminating
  // is 15 -> 16. blunt is
  // unchanged (the same two pre-existing entries); no new citation landed in that population.
  // card #80 (2026-09-06): +1 citation, `orchestrator/state-machine.js :: park-loop.js:1262`,
  // single-line and BLUNT (see ANCHOR_BLUNT_CITATIONS above) -- blunt is 2 -> 3; discriminating
  // and ranges are unchanged.
  // card #119 action 1.2 (2026-09-08): no citation added or removed, but this action's own edit to
  // park-loop.js's reEnqueueTask header comment shifted the ABOVE citation's target from :1262 to
  // :1273 (a true pure shift -- see ANCHOR_BLUNT_CITATIONS's own updated entry). Still BLUNT, same
  // shape, same reasoning; blunt/discriminating/ranges counts are unchanged by this.
  // rdo-symmetry (2026-09-06): +1 citation, `orchestrator/state-machine.js :: step-contracts.js:326`
  // -- single-line, anchored on `touchesRdoMembers`, which appears on line 326 only (neither 325
  // nor 327 mentions it), so it discriminates a one-line drift -- discriminating is 16 -> 17.
  // blunt and ranges are unchanged.
  // card #161 (2026-09-09): +3 citations, `orchestrator/auto-triage.js :: park-loop.js:1396`,
  // `:: remote-report-pull.js:193` and `:: state-machine.js:2923`, each single-line and anchored on
  // `appendDaemonEvent` (see the main anchor test's own note above). `appendDaemonEvent` does not
  // appear on any neighbouring line of any of the three targets, so all three discriminate a
  // one-line drift -- discriminating is 17 -> 20. blunt and ranges are unchanged.
  // card #162 (2026-09-09, found while gating card #164): +2, `orchestrator/dispatcher.js ::
  // daemon.js:607` and `:: daemon.js:626-627` (see the main anchor test's own note above for why
  // the second is a range, re-pinned rather than allowlisted). `daemon.js:607` is single-line,
  // anchored on both `killAllChildren` and `SIGTERM` verbatim on line 607 itself; neither survives
  // a shift to 606 (blank comment line) or 608 (`reparking`, neither candidate) --
  // discriminates a one-line drift in both directions. discriminating is 20 -> 21.
  // `daemon.js:626-627` is a genuine RANGE (`c.start !== c.stop`), blunt by construction like every
  // other range in this corpus (see this section's own header) -- ranges is 9 -> 10. blunt is
  // unchanged.
  // SPO-Pipeline#170 (2026-09-10): +1 citation, `scripts/usage-report.js :: orchestrator/token-
  // recovery.js:10-18` (see the main anchor test's own note above) -- a genuine RANGE
  // (`c.start !== c.stop`), blunt by construction like every other range in this corpus. ranges is
  // 10 -> 11. discriminating and blunt are unchanged.
  // card #213 action 2 (2026-09-12): the SAME re-pin as the main anchor test's own note above
  // (`orchestrator/state-machine.js :: step-contracts.js:461` -> `:527`, after shouldEscalate's
  // rewrite). Still single-line and still discriminating -- its neighbours do not mention
  // `touchesRdoMembers`, so a one-line shift in either direction still misses it. But as the main
  // anchor test's own note now records, that re-pin is COUNT-NEUTRAL: the citation was already
  // discriminating at :432 and is discriminating again at :527. The 21 -> 22 comes entirely from
  // the new `orchestrator/steps/llm.js:975` citation, measured the same way (remove only it, with
  // the :527 re-pin in place, and this count falls back to 21). blunt and ranges are unchanged.
  assert.deepEqual(
    blunt.map((b) => b.split(' -- ')[0]).sort(),
    Object.keys(ANCHOR_BLUNT_CITATIONS).sort(),
    `the set of citations that CANNOT discriminate a one-line drift changed. Every entry must be read\n  by hand and justified in ANCHOR_BLUNT_CITATIONS before being pinned -- this population is capped\n  for the same reason "unanchorable" is:\n  ${blunt.join('\n  ')}`
  );
  assert.deepEqual(
    discriminating.slice().sort(),
    EXPECTED_DISCRIMINATING_CITATIONS.slice().sort(),
    `the set of citations proven to discriminate a one-line drift changed -- re-measure and update EXPECTED_DISCRIMINATING_CITATIONS by name:\n  ${discriminating.join('\n  ')}`
  );
  assert.equal(ranges.length, 11, `expected 11 range citations in the ANCHORED population (blunt by construction, see this section's header), found ${ranges.length}.`);
  // fix pass D2/R1: LIVE_RANGE_PINS (14) is a SUPERSET of this ANCHORED-only `ranges` population
  // (11) by design -- it also pins two citations CITATION_ANCHOR_ALLOWLIST skips before this walk
  // ever pushes to `ranges` (`orchestrator/README.md :: dispatcher.js:643-656`, and
  // `orchestrator/README.md :: SPO-WebClient/.claude/settings.json:109-127` -- a JSON config value
  // with no code-shaped candidate, same shape as verify-gate.js:336 above) and one this walk
  // classifies UNANCHORABLE instead (`orchestrator/park-loop.js :: intake.js:989-991` -- this
  // specific occurrence has no code-shaped candidate nearby, unlike its three sibling citations of
  // the same fact, so it never passes the `top.length === 0` guard above to be classified as a
  // range either). Exact equality would be false; every ANCHORED range having a pin is still
  // required, and the completeness test below (part 2.7) separately proves the FULL set --
  // anchored, unanchorable, and allowlisted alike -- is pinned.
  const liveRangePinKeys = new Set(LIVE_RANGE_PINS.map((p) => `${p.file} :: ${p.citation}`));
  const unpinnedRanges = ranges.filter((k) => !liveRangePinKeys.has(k));
  assert.deepEqual(unpinnedRanges, [], `range citation(s) in the ANCHORED population with no LIVE_RANGE_PINS entry -- add one:\n  ${unpinnedRanges.join('\n  ')}`);
  // Ties this measurement to the main test's own pin: the three populations must together be
  // exactly the citations that test counted as `anchored`, or one of the two walks has drifted.
  // MERGE (2026-09-23): 36 -> 39, the SAME job.ts/worker.ts fix (main's `6c43c05`) the main
  // anchor test's own pin above already explains -- those three keys are DISCRIMINATING
  // (single-line SPO-WebClient citations), not ranges or blunt, so they land in `discriminating`.
  assert.equal(discriminating.length + blunt.length + ranges.length, 39, 'the three populations must sum to the main anchor test\'s pinned `anchored` count (39).');
});


// ---- part 2.7: pinned literal-text citation check (action 11.1, #206) --------------------------
//
// Everything above (part 2.5/2.6) verifies a citation by asking whether SOME code-shaped
// identifier named nearby also appears somewhere in the cited line range -- useful, but blind by
// construction to a range citation drifting by one line (a wide window still contains the same
// identifier after a +/-1 shift; see part 2.6's own header), and entirely unusable on the two
// dated bench docs, whose prose is a measurement narrative rather than code (ANCHOR_PIN_CHECKED_FILES
// above). A PIN is the opposite kind of check: the literal, trimmed text of the cited line(s),
// read once by hand, compared EXACTLY (no fuzzy match, no "anywhere in the span") against either
// the real working tree (`at: 'HEAD'`) or a frozen commit (`at: '<sha>'`) -- resolvePins, in
// test/citation-pins.js; the pins themselves, in test/citation-pins-data.js.
//
// Two registries: BENCH_PINS (the 41 file-tied citations in the two dated bench docs, other than
// the 2 dangling `sanctuarize.test.ts:151-156` ones, which stay CITATION_ALLOWLIST-only) and
// LIVE_RANGE_PINS + BLUNT_PINS (13 range citations -- every range in the live corpus, anchored,
// unanchorable, or on CITATION_ANCHOR_ALLOWLIST alike, per fix pass D2 -- and 3
// ANCHOR_BLUNT_CITATIONS entries), given a pin IN ADDITION to (or, for the 2 that the identifier
// layer cannot see at all, INSTEAD of) the existing identifier-based anchor check, since a pin can
// discriminate the +/-1 drift the identifier heuristic structurally cannot on a range.

// EXPECTED_BENCH_PIN_KEYS / EXPECTED_LIVE_PIN_KEYS -- named membership, same idiom as
// EXPECTED_CITATIONS above: typed independently of citation-pins-data.js's own content (these are
// the citation SHAPES this action found and decided to pin, not a re-export of the data file), so
// a pin silently added, removed, or re-keyed there fails this test by name.
const EXPECTED_BENCH_PIN_KEYS = [
  "doc/bench-audit-2026-09-02.md :: bin/spo:1284 @ HEAD",
  "doc/bench-audit-2026-09-02.md :: board-take.sh:109-110 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: cli.ts:179 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: cli.ts:221-227 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: doc/state-machine-spec.md:389 @ HEAD",
  "doc/bench-audit-2026-09-02.md :: finish.sh:275-276 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: merge-queue.ts:178-188 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: run.ts:109 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: scripted.js:1347 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/bench-audit-2026-09-02.md :: scripted.js:1944-1996 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/bench-audit-2026-09-02.md :: scripted.js:292-293 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/bench-audit-2026-09-02.md :: scripts/finish.sh:245-247 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: scripts/nightly-check.sh:70-73 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: src/e2e/bench/paths.ts:143-163 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: src/e2e/bench/worker.ts:482 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: src/e2e/config.ts:93 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: test/helpers.js:65-94 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/bench-audit-2026-09-02.md :: verdict.ts:162-183 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: verdict.ts:23-67 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:106 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:302 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:307-319 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:482 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:482-486 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:487 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:495-502 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:543-546 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:576 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:750 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-audit-2026-09-02.md :: worker.ts:779-780 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-plan-derived-2026-09-02.md :: bin/spo:1284 @ HEAD",
  "doc/bench-plan-derived-2026-09-02.md :: board-take.sh:109-110 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-plan-derived-2026-09-02.md :: cli.ts:88 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-plan-derived-2026-09-02.md :: doc/state-machine-spec.md:389 @ HEAD",
  "doc/bench-plan-derived-2026-09-02.md :: finish.sh:275-276 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-plan-derived-2026-09-02.md :: orchestrator/steps/scripted.js:292-293 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/bench-plan-derived-2026-09-02.md :: scripts/finish.sh:245-247 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-plan-derived-2026-09-02.md :: scripts/nightly-check.sh:70-73 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-plan-derived-2026-09-02.md :: src/e2e/config.ts:93 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "doc/bench-plan-derived-2026-09-02.md :: test/helpers.js:65-94 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/bench-plan-derived-2026-09-02.md :: worker.ts:302 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
];

test('BENCH_PINS holds exactly the 41 file-tied citations this action pinned in the two dated bench docs -- no more, no fewer', () => {
  assert.equal(BENCH_PINS.length, 41, `BENCH_PINS has ${BENCH_PINS.length} entries, expected 41 -- update EXPECTED_BENCH_PIN_KEYS in the same change.`);
  assert.deepEqual(
    BENCH_PINS.map((p) => `${p.file} :: ${p.citation} @ ${p.at}`).sort(),
    EXPECTED_BENCH_PIN_KEYS.slice().sort(),
    'BENCH_PINS (test/citation-pins-data.js) changed membership -- a pin was added, removed, or ' +
      're-keyed. Update EXPECTED_BENCH_PIN_KEYS here in the same change, by name.'
  );
});

test('every BENCH_PINS entry resolves: its pinned commit (or HEAD) names, at the pinned line(s), exactly the text this action read by hand', () => {
  const results = resolvePins(BENCH_PINS);
  const offenders = results.filter((r) => !r.ok).map((r) => r.why);
  assert.deepEqual(offenders, [], `pinned bench-doc citation(s) whose target no longer reads what the pin says (file, citation, expected/actual text, and where it moved to, if unique):\n  ${offenders.join('\n  ')}`);
});

// This is the test that actually closes #206's probe 1 ("a consistent wrong re-pin -- doc text
// and EXPECTED_CITATIONS moved together -- ships green"): BENCH_PINS is a STATIC array, typed
// once and never re-derived from the doc (deliberately -- see this file's own header on why a
// re-derived expectation pins nothing), so on its own it would happily keep checking a citation
// the doc no longer makes if the doc's number moved and BENCH_PINS's did not follow. This test is
// the missing link: the set of citations BENCH_PINS actually pins must equal the set the two
// dated bench docs actually carry TODAY (via the same extractCitations pipeline the corpus-wide
// tests use, filtered to CITATION_ALLOWLIST's two dangling/three-unanchored-chain exemptions,
// which have no line to pin against) -- so a re-pin that moves the doc's own citation without
// moving BENCH_PINS to match now fails HERE, by name, even though EXPECTED_CITATIONS (which only
// ever re-derives from the SAME doc text) would happily follow the doc anywhere.
test('BENCH_PINS pins exactly the citations the two dated bench docs actually carry today -- a re-pin of the doc without a matching re-pin here is caught, by name', () => {
  const BENCH_DOCS = ['doc/bench-audit-2026-09-02.md', 'doc/bench-plan-derived-2026-09-02.md'];
  // ONLY the genuinely unpinnable citations: a deleted file (sanctuarize.test.ts) has no line to
  // pin against, and an unanchored chain has no `file` at all. The two CITATION_ALLOWLIST entries
  // for `verdict.ts:162-183`/`worker.ts:779-780` are NOT in this set -- those files exist and are
  // pinned anyway (frozen at 935283890fa0593c5c5d0b41cceeaec2c1972c6f, where the citation was true); CITATION_ALLOWLIST exempts
  // them only from part 2's HEAD-bounds check, not from being pinnable.
  const BENCH_DANGLING_KEYS = new Set([
    'doc/bench-audit-2026-09-02.md :: sanctuarize.test.ts:151-156',
    'doc/bench-plan-derived-2026-09-02.md :: sanctuarize.test.ts:151-156',
    'doc/bench-audit-2026-09-02.md :: (unanchored) :277',
    'doc/bench-audit-2026-09-02.md :: (unanchored) :458',
    'doc/bench-audit-2026-09-02.md :: (unanchored) :65-69',
  ]);
  const liveBenchKeys = [];
  for (const rel of BENCH_DOCS) {
    const raw = read(rel);
    const normalized = normalizeWrap(stripFences(raw));
    for (const c of extractCitations(normalized)) {
      const key = `${rel} :: ${c.raw}`;
      if (BENCH_DANGLING_KEYS.has(key)) continue;
      liveBenchKeys.push(key);
    }
  }
  assert.deepEqual(
    liveBenchKeys.slice().sort(),
    BENCH_PINS.map((p) => `${p.file} :: ${p.citation}`).sort(),
    'BENCH_PINS (test/citation-pins-data.js) no longer matches the citations the two dated bench ' +
      'docs actually carry -- either a doc citation moved without its pin following, or a pin was ' +
      'added/removed without the doc changing. Update BENCH_PINS in the same change as any edit to ' +
      'either doc.'
  );
});

const EXPECTED_LIVE_PIN_KEYS = [
  "doc/state-machine-spec.md :: dispatcher.js:643-656 @ HEAD",
  "doc/state-machine-spec.md :: intake.js:989-991 @ HEAD",
  "orchestrator/README.md :: SPO-WebClient/.claude/settings.json:109-127 @ 935283890fa0593c5c5d0b41cceeaec2c1972c6f",
  "orchestrator/README.md :: dispatcher.js:643-656 @ HEAD",
  "orchestrator/README.md :: doc/state-machine-spec.md:382 @ HEAD",
  "orchestrator/README.md :: intake.js:989-991 @ HEAD",
  "orchestrator/README.md :: lock.js:354-385 @ HEAD",
  "orchestrator/dispatcher.js :: daemon.js:677-678 @ HEAD",
  "orchestrator/journal.js :: auto-pull.js:58-66 @ HEAD",
  "orchestrator/orphan-scan.js :: auto-pull.js:58-66 @ HEAD",
  "orchestrator/park-loop.js :: doc/remediation-progress.md:669 @ HEAD",
  "orchestrator/park-loop.js :: intake.js:989-991 @ HEAD",
  "orchestrator/state-machine.js :: auto-pull.js:58-66 @ HEAD",
  "orchestrator/state-machine.js :: auto-pull.js:58-66 @ HEAD",
  "orchestrator/state-machine.js :: park-loop.js:1457 @ HEAD",
  "orchestrator/steps/llm.js :: intake.js:989-991 @ HEAD",
  "scripts/usage-report.js :: orchestrator/token-recovery.js:10-18 @ HEAD",
];

test('LIVE_RANGE_PINS + BLUNT_PINS hold exactly the 14 live ranges and 3 ANCHOR_BLUNT_CITATIONS this action pinned -- no more, no fewer', () => {
  assert.equal(LIVE_RANGE_PINS.length, 14, `LIVE_RANGE_PINS has ${LIVE_RANGE_PINS.length} entries, expected 14 (must equal the completeness check's own range population below).`);
  assert.equal(BLUNT_PINS.length, 3, `BLUNT_PINS has ${BLUNT_PINS.length} entries, expected 3 (must equal ANCHOR_BLUNT_CITATIONS's own membership).`);
  assert.deepEqual(
    [...LIVE_RANGE_PINS, ...BLUNT_PINS].map((p) => `${p.file} :: ${p.citation} @ ${p.at}`).sort(),
    EXPECTED_LIVE_PIN_KEYS.slice().sort(),
    'LIVE_RANGE_PINS/BLUNT_PINS (test/citation-pins-data.js) changed membership, commit, or HEAD-vs-frozen split -- update ' +
      'EXPECTED_LIVE_PIN_KEYS here in the same change, by name.'
  );
});

// The completeness check D2 asked for: every RANGE citation ANYWHERE in the live anchor corpus --
// whether the identifier-based walk counts it as anchored, unanchorable, or skips it entirely via
// CITATION_ALLOWLIST/CITATION_ANCHOR_ALLOWLIST -- must have a LIVE_RANGE_PINS entry. Unlike
// forEachAnchorCheckedCitation (which exists to walk the corpus the identifier heuristic can
// usefully judge), this walk deliberately does NOT skip allowlisted citations -- that is exactly
// the gap the first pass's `orchestrator/README.md :: dispatcher.js:634-648` omission fell into: a
// real range fact, invisible to this completeness check only because something ELSE had already
// excused it from a DIFFERENT, narrower check. Fix pass R1 retired the one citation the first
// completeness check (D2) could not pin (`.claude/settings.json:109-127`, wrongly diagnosed as
// unpinnable): it names the PRODUCT repo, not this one, and is pinned like every other product
// citation now that it is spelled that way -- so this walk requires a pin for EVERY range found,
// with no exceptions left to name.
test('every RANGE citation in the live (non-bench) anchor corpus has a pin -- a new unpinned range fails here, by name', () => {
  const anchorCorpus = CORPUS_FILES.filter((rel) => !ANCHOR_PIN_CHECKED_FILES.has(rel));
  const pinnedKeys = new Map(); // key -> count
  for (const p of [...LIVE_RANGE_PINS, ...BLUNT_PINS]) {
    if (p.last === undefined) continue; // BLUNT_PINS are single-line; this check is ranges only
    const key = `${p.file} :: ${p.citation}`;
    pinnedKeys.set(key, (pinnedKeys.get(key) || 0) + 1);
  }
  const foundCounts = new Map();
  for (const rel of anchorCorpus) {
    const raw = read(rel);
    const withoutFences = rel.endsWith('.md') ? stripFences(raw) : raw;
    const normalized = normalizeWrap(withoutFences);
    for (const c of extractCitations(normalized).filter((c) => !c.unanchored && c.start !== c.stop)) {
      const key = `${rel} :: ${c.raw}`;
      foundCounts.set(key, (foundCounts.get(key) || 0) + 1);
    }
  }
  const offenders = [];
  for (const [key, count] of foundCounts) {
    const pinnedCount = pinnedKeys.get(key) || 0;
    if (pinnedCount !== count) {
      offenders.push(`${key} -- ${count} occurrence(s) in the live corpus, ${pinnedCount} pinned`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `range citation(s) in the live anchor corpus with no matching LIVE_RANGE_PINS entry (or a mismatched count):\n  ${offenders.join('\n  ')}`
  );
});

test('every LIVE_RANGE_PINS/BLUNT_PINS entry resolves (HEAD, or the one product citation frozen at 93528389), exactly as read by hand', () => {
  const results = resolvePins([...LIVE_RANGE_PINS, ...BLUNT_PINS]);
  const offenders = results.filter((r) => !r.ok).map((r) => r.why);
  assert.deepEqual(offenders, [], `pinned live citation(s) whose target no longer reads what the pin says:\n  ${offenders.join('\n  ')}`);
});

// The above proves LIVE_RANGE_PINS/BLUNT_PINS's OWN citation text is still true; it does NOT prove
// the CITING file still says the same thing -- a pin, like BENCH_PINS, is a static array that never
// re-reads the doc. This is the #206 comment-4 scenario, generalized: `intake.js:906-908` was
// re-pinned to `:936-938` in FOUR files, and shifting all four to `:935-938`/`:936-939`/`:937-939`
// (a genuine drift, not a consistent-and-correct re-pin) left the corpus-wide identifier check
// 51/51 green, because a RANGE citation is blunt by construction (part 2.6's own header) -- the
// old drifted range still happened to contain the same identifier. So this test closes the same
// loophole BENCH_PINS's own cross-check does, for the live corpus instead of the two dated docs:
// the exact citation TEXT each pin claims must occur, with the same multiplicity, somewhere in the
// live corpus scan every other test in this file already runs -- a citing file's number moving
// without its pin following (or vice versa) is now a NAMED failure here, not a silent pass.
test('LIVE_RANGE_PINS/BLUNT_PINS cite exactly what the live corpus text says today -- a citing file\'s citation drifting without its pin following is caught, by name', () => {
  const liveCounts = new Map();
  for (const rel of CORPUS_FILES) {
    const raw = read(rel);
    const withoutFences = rel.endsWith('.md') ? stripFences(raw) : raw;
    const normalized = normalizeWrap(withoutFences);
    for (const c of extractCitations(normalized)) {
      const key = `${rel} :: ${c.raw}`;
      liveCounts.set(key, (liveCounts.get(key) || 0) + 1);
    }
  }
  const pinnedCounts = new Map();
  for (const p of [...LIVE_RANGE_PINS, ...BLUNT_PINS]) {
    const key = `${p.file} :: ${p.citation}`;
    pinnedCounts.set(key, (pinnedCounts.get(key) || 0) + 1);
  }
  const offenders = [];
  for (const [key, count] of pinnedCounts) {
    const live = liveCounts.get(key) || 0;
    if (live !== count) offenders.push(`${key} -- pinned ${count} time(s), the live corpus scan has ${live} occurrence(s) of this exact citation text`);
  }
  assert.deepEqual(offenders, [], `pinned live citation(s) no longer match the corpus's current text -- a citing file's number moved without LIVE_RANGE_PINS/BLUNT_PINS following, or vice versa:\n  ${offenders.join('\n  ')}`);
});

// ---- part 2.8: pinned literal-text citation check for doc/comment-corpus-audit-2026-09-03.md
// (action 11.2, #206) ------------------------------------------------------------------------
//
// This doc is a THIRD dated record, same posture as the two bench docs part 2.7 pins: it is
// deliberately excluded from CORPUS_FILES ("written AFTER the corpus it measured -- not part of
// what it measured", CORPUS_FILES's own comment above), so none of its 37 file-tied citations
// were ever checked by anything -- part 2's ratchet does not scan it, and the identifier-anchor
// layer (part 2.5/2.6) never gets the chance to either. #206's own comments measured this being
// exploited in practice: two `bin/spo` citations were hand re-pinned to today's tree by card
// #208/#214 (`:2220`/`:1139`) with nothing failing, and three more had already drifted silently
// before that. CCA_PINS (test/citation-pins-data.js) closes the same gap part 2.7 closed for the
// bench docs, for this doc instead: every file-tied citation gets a literal-text pin, frozen at
// the SPO-Pipeline commit this doc's own header names (`7902164309c1766d7b785daab9ba94ff6472bc1d`)
// -- never `d03ea8b7` (the commit the header names for `~/SPO-WebClient`), since nothing in this
// doc cites a product file by line. This doc is NOT added to CORPUS_FILES itself -- its 68-file
// scope and every count pinned on it (EXPECTED_CITATIONS, `checked`, etc.) stay exactly as they
// are; CCA_PINS is a parallel, dedicated walk, the same relationship BENCH_PINS has to the corpus
// walk for the two bench docs.

// CCA_PINS carries all 37 file-tied citations (fix pass 11.2, D1) -- `README.md:34`/`:35`/`:37`
// are pinned below with a `path` field (test/citation-pins.js's resolvePins), not allowlisted:
// see test/citation-pins-data.js's CCA_PINS header comment for why an allowlist could not catch a consistent wrong
// re-pin of an ambiguous citation (probed, shipped green 74/74).

const EXPECTED_CCA_PIN_KEYS = [
  "doc/comment-corpus-audit-2026-09-03.md :: CLAUDE.md:29 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: README.md:34 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: README.md:35 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: README.md:37 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: bin/spo:1654 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: bin/spo:1838 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: bin/spo:407-408 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: bin/spo:715 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: bin/spo:993 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: console/prod-version.js:13 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/board-audit.md:20 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/board-audit.md:20 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/environments.md:32 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/jewels-inventory.md:14 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/permissions.md:114-169 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/setup.md:15 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/state-machine-spec.md:117 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/state-machine-spec.md:121 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/state-machine-spec.md:445 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/state-machine-spec.md:9 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: doc/state-machine-spec.md:98 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/README.md:1062 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/README.md:1062 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/README.md:1180 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/README.md:2056 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/README.md:2371 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/README.md:790 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/config.js:489 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/config.js:704 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/park-loop.js:179 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/park-loop.js:219 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/park-loop.js:755 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/park-loop.js:825 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/park-loop.js:925 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: orchestrator/state-machine.js:1564 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: scripts/daemon-install.sh:103 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
  "doc/comment-corpus-audit-2026-09-03.md :: test/doc-constant-sweep.test.js:352 @ 7902164309c1766d7b785daab9ba94ff6472bc1d",
];

test('CCA_PINS holds exactly the 37 file-tied citations in doc/comment-corpus-audit-2026-09-03.md -- no more, no fewer', () => {
  assert.equal(CCA_PINS.length, 37, `CCA_PINS has ${CCA_PINS.length} entries, expected 37 (every file-tied citation the doc carries -- no allowlist left) -- update EXPECTED_CCA_PIN_KEYS in the same change.`);
  assert.deepEqual(
    CCA_PINS.map((p) => `${p.file} :: ${p.citation} @ ${p.at}`).sort(),
    EXPECTED_CCA_PIN_KEYS.slice().sort(),
    'CCA_PINS (test/citation-pins-data.js) changed membership -- a pin was added, removed, or ' +
      're-keyed. Update EXPECTED_CCA_PIN_KEYS here in the same change, by name.'
  );
});

test('every CCA_PINS entry resolves: its pinned commit (7902164) names, at the pinned line(s), exactly the text this action read by hand', () => {
  const results = resolvePins(CCA_PINS);
  const offenders = results.filter((r) => !r.ok).map((r) => r.why);
  assert.deepEqual(offenders, [], `pinned doc/comment-corpus-audit-2026-09-03.md citation(s) whose target no longer reads what the pin says:\n  ${offenders.join('\n  ')}`);
});

// D6 (fix pass 11.2, driver decision): switching a CCA pin's `at` to `HEAD` while also editing
// EXPECTED_CCA_PIN_KEYS to match ships green -- the membership test above only checks the KEYS
// agree with each other, never that the commit named is the RIGHT one. This doc is a dated
// record; every one of its pins must stay frozen at the SPO-Pipeline commit the doc's OWN header
// names, read from the doc's live text at test time (never hardcoded here, so an edit to the
// doc's header without a matching edit to every pin's `at` is caught too, and vice versa).
test('every CCA_PINS entry is frozen at the SPO-Pipeline commit doc/comment-corpus-audit-2026-09-03.md\'s own header names -- never HEAD, never a different sha', () => {
  const headerText = read('doc/comment-corpus-audit-2026-09-03.md').slice(0, 600);
  const shaMatch = /Measured 2026-09-03 against this worktree at\s*\n?>?\s*`([0-9a-f]{40})`/.exec(headerText);
  assert.ok(shaMatch, "could not find the doc's own \"Measured ... against this worktree at `<sha>`\" header sentence -- has it been reworded?");
  const namedSha = shaMatch[1];
  assert.equal(namedSha, '7902164309c1766d7b785daab9ba94ff6472bc1d', "the doc's own header now names a different commit than this suite assumes -- re-verify every CCA_PINS entry against the new commit before updating this pin.");
  const wrongAt = CCA_PINS.filter((p) => p.at !== namedSha).map((p) => `${p.file} :: ${p.citation} @ ${p.at}`);
  assert.deepEqual(wrongAt, [], `CCA_PINS entry(ies) not frozen at the doc's own header commit (${namedSha}):\n  ${wrongAt.join('\n  ')}`);
});

// Same missing-link BENCH_PINS's own cross-check test closes (this file's part 2.7 header): a
// STATIC pin array never re-reads the doc, so on its own it would happily keep checking a
// citation the doc no longer makes if the doc's own number moved and CCA_PINS did not follow.
// Array equality (`.sort()`), not set equality, on purpose: doc/board-audit.md:20 and
// orchestrator/README.md:1062 are each cited twice in the doc's own prose, so CCA_PINS carries
// each of those twice too, and this comparison must see that multiplicity, not collapse it.
test('CCA_PINS covers exactly the citations doc/comment-corpus-audit-2026-09-03.md actually carries today -- a re-pin of the doc without a matching pin change is caught, by name', () => {
  const CCA_DOC = 'doc/comment-corpus-audit-2026-09-03.md';
  const raw = read(CCA_DOC);
  const normalized = normalizeWrap(stripFences(raw));
  const liveKeys = extractCitations(normalized).map((c) => `${CCA_DOC} :: ${c.raw}`);
  const pinnedKeys = CCA_PINS.map((p) => `${p.file} :: ${p.citation}`);

  assert.deepEqual(
    liveKeys.slice().sort(),
    pinnedKeys.slice().sort(),
    'doc/comment-corpus-audit-2026-09-03.md\'s live citations no longer match CCA_PINS -- either a ' +
      'doc citation moved without its pin following, a pin is now DEAD (no longer cited by the ' +
      'doc), or a new citation appeared unpinned. Update CCA_PINS in the same change as any edit ' +
      'to the doc.'
  );
});

// ---- part 2.9: dated-document citations must never pin `at: 'HEAD'` (chantier action 5) -------
//
// A dated document (a file whose own basename embeds a YYYY-MM-DD date and whose prose is a
// point-in-time measurement narrative, never a living description of current code -- today,
// exactly doc/bench-audit-2026-09-02.md, doc/bench-plan-derived-2026-09-02.md and
// doc/comment-corpus-audit-2026-09-03.md) should NEVER pin a citation `at: 'HEAD'`: `at: '<sha>'`
// is strictly better here -- zero-maintenance forever (a git blob at a fixed commit cannot drift)
// and it preserves exactly what the doc's own audit measured, rather than silently tracking
// whatever the code happens to say today. BENCH_PINS/CCA_PINS already get this right almost
// everywhere (part 2.7/2.8 above); this makes it a STANDING, enforced rule rather than a
// convention someone has to remember, with the two deliberate exceptions BENCH_PINS's own header
// documents ("Two facts are kept LIVE (`at: 'HEAD'`) because they are hand-maintained as true
// today, not dated record" -- test/citation-pins-data.js, above BENCH_PINS): the `bin/spo`
// `collectAll` call site and doc/state-machine-spec.md's FINISH row are current-code facts cited
// FROM inside a dated-named file, not measurements the dated file made of a past state.

// Matches this repo's real dated documents today (proved below against `git ls-files doc`): the
// three named above, and nothing else -- in particular NOT doc/remediation-plan-2026-08.md, whose
// name carries a year-month only (no day), so `-\d{4}-\d{2}-\d{2}\.md$` does not match it.
const DATED_DOCUMENT_PATTERN = /-\d{4}-\d{2}-\d{2}\.md$/;

// The only pins allowed to be BOTH `at: 'HEAD'` AND cited from a dated document, named with the
// reason each is an exception -- matches BENCH_PINS's own "Two facts are kept LIVE" header exactly
// (test/citation-pins-data.js). Anything else is reported by findDatedDocHeadOffenders below, by
// name, never by count.
const DATED_DOC_HEAD_EXCEPTIONS = new Set([
  "doc/bench-audit-2026-09-02.md :: bin/spo:1284", // re-pinned 18+ times as bin/spo grows -- hand-maintained as true today, not dated record (BENCH_PINS header)
  "doc/bench-plan-derived-2026-09-02.md :: bin/spo:1284", // same fact, same reason, cited from the sibling doc
  "doc/bench-audit-2026-09-02.md :: doc/state-machine-spec.md:389", // the FINISH row -- hand-maintained as true today, not dated record (BENCH_PINS header); re-pinned from :166 by main's own card #212 merge, a true pure shift
  "doc/bench-plan-derived-2026-09-02.md :: doc/state-machine-spec.md:389", // same fact, same reason, cited from the sibling doc
]);

// Pure, reusable check: given a flat pin array, return the `file :: citation` keys of every pin
// that is BOTH `at: 'HEAD'` and cited from a file matching DATED_DOCUMENT_PATTERN, and is NOT on
// DATED_DOC_HEAD_EXCEPTIONS. Factored out so the fixture tests below can prove it actually catches
// something, rather than trusting that today's real registries happen to have nothing to catch.
function findDatedDocHeadOffenders(pins) {
  return pins
    .filter((p) => p.at === 'HEAD' && DATED_DOCUMENT_PATTERN.test(p.file))
    .map((p) => `${p.file} :: ${p.citation}`)
    .filter((key) => !DATED_DOC_HEAD_EXCEPTIONS.has(key));
}

test('doc/ carries exactly the three dated documents this rule assumes -- no other doc/ file matches the dated-document filename pattern', () => {
  const files = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', 'doc'], { encoding: 'utf8', env: gitEnv() })
    .split('\n')
    .filter(Boolean);
  const dated = files.filter((f) => DATED_DOCUMENT_PATTERN.test(f)).sort();
  assert.deepEqual(
    dated,
    ['doc/bench-audit-2026-09-02.md', 'doc/bench-plan-derived-2026-09-02.md', 'doc/comment-corpus-audit-2026-09-03.md'],
    'a doc/ file was added, renamed, or removed that changes which files match the dated-document ' +
      'filename pattern -- check whether it is a genuine dated record (see orchestrator/README.md\'s ' +
      '"dated document" citation-pinning rule) and, if so, whether any of its HEAD citations need ' +
      'converting to a frozen sha; then update this list.'
  );
});

test('no BENCH_PINS/LIVE_RANGE_PINS/BLUNT_PINS/CCA_PINS entry pins a dated document\'s citation `at: \'HEAD\'` except the two named, deliberate exceptions', () => {
  const allPins = [...BENCH_PINS, ...LIVE_RANGE_PINS, ...BLUNT_PINS, ...CCA_PINS];
  const offenders = findDatedDocHeadOffenders(allPins);
  assert.deepEqual(
    offenders,
    [],
    'dated-document citation(s) pinned `at: \'HEAD\'` without being on DATED_DOC_HEAD_EXCEPTIONS -- ' +
      'a dated document\'s citation must be pinned `at: \'<sha>\'` (the commit the doc\'s own header ' +
      'names), never HEAD, unless it is a deliberately-kept-live fact (see BENCH_PINS\'s own "Two ' +
      'facts are kept LIVE" header in test/citation-pins-data.js):\n  ' + offenders.join('\n  ')
  );
});

// An exception that stops matching anything (the pin was converted to a sha, removed, or its
// `file`/`citation` changed) should be pruned, not left to rot as a stale, unused entry -- the
// same "named, not counted" discipline as the offender check above, applied to the allowlist
// itself.
test('DATED_DOC_HEAD_EXCEPTIONS names only pins that actually exist as `at: \'HEAD\'` dated-document citations today', () => {
  const allPins = [...BENCH_PINS, ...LIVE_RANGE_PINS, ...BLUNT_PINS, ...CCA_PINS];
  const liveHeadDatedKeys = new Set(
    allPins.filter((p) => p.at === 'HEAD' && DATED_DOCUMENT_PATTERN.test(p.file)).map((p) => `${p.file} :: ${p.citation}`)
  );
  const stale = [...DATED_DOC_HEAD_EXCEPTIONS].filter((key) => !liveHeadDatedKeys.has(key));
  assert.deepEqual(
    stale,
    [],
    `DATED_DOC_HEAD_EXCEPTIONS names key(s) no longer present as an \`at: 'HEAD'\` dated-document pin -- prune:\n  ${stale.join('\n  ')}`
  );
});

// Fixture proof that findDatedDocHeadOffenders is actually sensitive, not vacuously green because
// today's real registries happen to have nothing to catch beyond the two known exceptions (same
// mutation-style discipline as test/citation-pins-resolve-anchor.test.js and
// test/fix-citations.test.js): a synthetic `at: 'HEAD'` pin on a synthetic dated-document filename,
// not on the exception list, must be reported by name.
test('findDatedDocHeadOffenders is sensitive: a synthetic HEAD pin on a synthetic dated-document filename, not on the exception list, is caught', () => {
  const offenders = findDatedDocHeadOffenders([
    { file: 'doc/synthetic-audit-2026-01-01.md', citation: 'made-up.js:1', at: 'HEAD', first: 'x' },
  ]);
  assert.deepEqual(offenders, ['doc/synthetic-audit-2026-01-01.md :: made-up.js:1']);
});

test('findDatedDocHeadOffenders does not flag a sha-frozen pin, a HEAD pin on a non-dated file, or a named exempted dated-document HEAD pin', () => {
  const offenders = findDatedDocHeadOffenders([
    { file: 'doc/synthetic-audit-2026-01-01.md', citation: 'made-up.js:1', at: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', first: 'x' },
    { file: 'orchestrator/README.md', citation: 'made-up.js:1', at: 'HEAD', first: 'x' },
    { file: 'doc/bench-audit-2026-09-02.md', citation: 'bin/spo:1284', at: 'HEAD', first: 'x' },
  ]);
  assert.deepEqual(offenders, []);
});

// ---- fixture tests: the `path` field (fix pass 11.2, D1) ---------------------------------------
//
// Direct, hermetic tests of resolvePins's `path` handling against a small committed fixture repo
// (same rationale as makeCommittedFixtureRepo's other callers below: a mutation to any of these
// three guard clauses must go red HERE, on a small fixture, rather than being inferred from the
// real corpus staying green -- the real corpus only exercises the ACCEPT path for `README.md`,
// never the two REFUSE paths).
test('resolvePins: `path` is accepted when the bare name is genuinely ambiguous, its basename matches, and it contains a "/"', () => {
  const { root, sha } = makeCommittedFixtureRepo({
    'dup.txt': 'one\ntwo\nthree\n',
    'sub/dup.txt': 'aaa\nbbb\nccc\n',
  });
  const pin = { file: 'x.md', citation: 'dup.txt:2', at: sha, path: './dup.txt', first: 'two' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, true, result.why);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: `path` on an already-UNAMBIGUOUS citation is refused', () => {
  const { root, sha } = makeCommittedFixtureRepo({ 'solo.txt': 'one\ntwo\nthree\n' });
  const pin = { file: 'x.md', citation: 'solo.txt:2', at: sha, path: './solo.txt', first: 'two' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false);
  assert.match(result.why, /not ambiguous under the resolver/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: `path` whose basename does not match the cited name is refused', () => {
  const { root, sha } = makeCommittedFixtureRepo({
    'dup.txt': 'one\ntwo\nthree\n',
    'sub/dup.txt': 'aaa\nbbb\nccc\n',
    'other.txt': 'xxx\n',
  });
  const pin = { file: 'x.md', citation: 'dup.txt:2', at: sha, path: './other.txt', first: 'two' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false);
  assert.match(result.why, /basename does not match/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a bare `path` with no "/" is refused -- the exact trap a bare "README.md" would fall back into', () => {
  const { root, sha } = makeCommittedFixtureRepo({
    'dup.txt': 'one\ntwo\nthree\n',
    'sub/dup.txt': 'aaa\nbbb\nccc\n',
  });
  const pin = { file: 'x.md', citation: 'dup.txt:2', at: sha, path: 'dup.txt', first: 'two' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false);
  assert.match(result.why, /has no "\/"/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a +/-1 drift on a `path` pin is caught, same as any other pin', () => {
  const { root, sha } = makeCommittedFixtureRepo({
    'dup.txt': 'one\ntwo\nthree\nfour\n',
    'sub/dup.txt': 'aaa\nbbb\nccc\n',
  });
  const repoRoots = { repo: root, product: root, deploy: root };
  const pin = { file: 'x.md', citation: 'dup.txt:2', at: sha, path: './dup.txt', first: 'two' };
  const base = resolvePins([pin], { repoRoots });
  assert.equal(base[0].ok, true, 'fixture precondition: the base path pin must itself be correct');
  const drifted = { ...pin, citation: shiftedCitation(pin.citation, 1) }; // :2 -> :3 ("three", not "two")
  const driftedResult = resolvePins([drifted], { repoRoots });
  assert.equal(driftedResult[0].ok, false, 'a +1 drift on a `path` pin must be caught, exactly like a plain pin');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- fixture tests: resolvePins error paths (fix pass 11.1, D5) --------------------------------
//
// Direct, hermetic tests of resolvePins itself against a real (but throwaway, git-backed) repo --
// same rationale as makeFixtureRepo's own tests above: a mutation to any of these error paths
// must go red HERE, on a small fixture, rather than being inferred from the real corpus staying
// green (which it would, since none of these shapes exist in the real corpus today).
function makeCommittedFixtureRepo(layout) {
  const root = mkTmp('spo-resolvepins-fixture-');
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync('git', ['-C', root, 'init', '-q'], { env: gitEnv() });
  execFileSync('git', ['-C', root, 'add', '-A'], { env: gitEnv() });
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture'], { env: gitEnv() });
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: gitEnv() }).trim();
  return { root, sha };
}

test('resolvePins: a missing sha (frozen pin, commit does not exist) fails, never a silent pass', () => {
  const { root } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  const pin = { file: 'x.md', citation: 'a.txt:1', at: '0000000000000000000000000000000000000000', first: 'one' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false, 'a pin frozen at a nonexistent commit must fail');
  assert.ok(/missing/.test(result.why), `expected the failure to name the object as missing, got: ${result.why}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a missing path at a VALID sha fails, never a silent pass', () => {
  const { root, sha } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  const pin = { file: 'x.md', citation: 'nonexistent.txt:1', at: sha, first: 'one' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false, 'a pin whose path does not exist at an otherwise-real commit must fail');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: an unresolvable bare basename fails, never a silent pass', () => {
  const { root, sha } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  const pin = { file: 'x.md', citation: 'nowhere.txt:1', at: sha, first: 'one' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false, 'a bare filename that matches nothing tracked anywhere must fail');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: repoRoots.product pointed at a missing directory makes a HEAD product pin fail, never silently read the real product repo (D5/D8b)', () => {
  const { root } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  const bogusProduct = path.join(os.tmpdir(), `spo-resolvepins-absent-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(bogusProduct), false, 'fixture precondition: bogusProduct must not exist');
  // "src/e2e/config.ts" is a REAL path in the REAL product repo -- if repoRoots.product were
  // ignored (the exact bug this proof exists for), this citation would resolve to and read the
  // real ~/SPO-WebClient file, unrelated to anything this fixture set up, and likely pass.
  const pin = { file: 'x.md', citation: 'src/e2e/config.ts:93', at: 'HEAD', first: 'this text cannot appear in the real file' };
  const result = resolvePins([pin], { repoRoots: { repo: root, product: bogusProduct, deploy: root } });
  assert.equal(result[0].ok, false, 'a HEAD pin under an overridden, absent product root must fail, not fall through to this repo or the real product repo');
  assert.match(result[0].why, /product-absent|not on disk/, `expected a product-absent style failure, got: ${result[0].why}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a HEAD pin reads the WORKING TREE, not the committed blob -- an uncommitted edit is seen', () => {
  const { root, sha } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  // Edit the working tree WITHOUT committing -- gitEnv()'d git status confirms the repo now has
  // an uncommitted change, so a HEAD pin reading the committed blob (git show HEAD:a.txt) would
  // still see "two", while the real working tree already says "TWO-EDITED".
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO-EDITED\nthree\n');
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', env: gitEnv() });
  assert.ok(status.includes('a.txt'), 'fixture precondition: the edit must be uncommitted (visible in git status)');

  const committedPin = { file: 'x.md', citation: 'a.txt:2', at: sha, first: 'two' };
  const headPin = { file: 'x.md', citation: 'a.txt:2', at: 'HEAD', first: 'TWO-EDITED' };
  const results = resolvePins([committedPin, headPin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(results[0].ok, true, 'the FROZEN pin (at the real commit sha) must still see the committed text ("two"), unaffected by the later edit');
  assert.equal(results[1].ok, true, 'the HEAD pin must see the UNCOMMITTED working-tree text ("TWO-EDITED"), not the stale committed blob');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a duplicate line means movedTo is null, never a guess', () => {
  const { root, sha } = makeCommittedFixtureRepo({ 'a.txt': 'same\nsame\nsame\n' });
  // pin.first names text that occurs on THREE lines -- a drifted pin's real failure message must
  // not claim a specific "moved to :N", since there is no way to tell which of the three is meant.
  const pin = { file: 'x.md', citation: 'a.txt:5', at: sha, first: 'same' }; // :5 is out of range (file has 3 lines)
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false, 'fixture precondition: citing a line past EOF must fail');
  assert.equal(result.movedTo, null, `a text that occurs on more than one line must never produce a guessed movedTo, got: ${JSON.stringify(result.movedTo)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a RANGE citation (start !== stop) with no `last` fails -- D4 (fix pass R2)', () => {
  const { root, sha } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  const pin = { file: 'x.md', citation: 'a.txt:1-2', at: sha, first: 'one' }; // no `last`
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false, 'a range pin with no `last` must fail, never pass on `first` alone');
  assert.match(result.why, /RANGE.*no `last`|no `last`.*RANGE/i, `expected the failure to name the missing \`last\`, got: ${result.why}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a SINGLE-LINE citation (no "-stop") with a `last` fails -- D4 (fix pass R2)', () => {
  const { root, sha } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  const pin = { file: 'x.md', citation: 'a.txt:1', at: sha, first: 'one', last: 'two' }; // single line, but carries `last`
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false, 'a single-line pin carrying a `last` must fail, never silently ignore it');
  assert.match(result.why, /SINGLE LINE.*last|last.*SINGLE LINE/i, `expected the failure to name the unexpected \`last\`, got: ${result.why}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolvePins: a citation one line PAST EOF with `first: ""` fails -- D8a phantom-trailing-newline fix (fix pass R3)', () => {
  // A 3-line file with a trailing newline: text.split('\n') produces a 4th, PHANTOM empty
  // element ('one\ntwo\nthree\n'.split('\n') is ['one','two','three',''], not 3 real lines).
  // Before D8a, lineCount was 4 here, so a pin citing line 4 with first:"" passed bounds AND
  // matched the phantom empty string -- a citation past the real end of the file "verified".
  const { root, sha } = makeCommittedFixtureRepo({ 'a.txt': 'one\ntwo\nthree\n' });
  const pin = { file: 'x.md', citation: 'a.txt:4', at: sha, first: '' };
  const [result] = resolvePins([pin], { repoRoots: { repo: root, product: root, deploy: root } });
  assert.equal(result.ok, false, 'a citation one line past the real EOF must fail, even when `first` is blank');
  fs.rmSync(root, { recursive: true, force: true });
});

// classifySurvivors(survivors, allowlist) -- splits a mutation proof's own survivor list (each
// entry "<key> -- <detail>") into { allowed, unexpected } by the leading key, same per-fact
// keying idiom as isCitationAllowlisted above. Extracted so the real, corpus-wide mutation-proof
// test below and a small hermetic fixture test (proving this SPLIT itself is correct, since the
// real corpus currently has zero survivors to exercise it against) call the exact same function.
function classifySurvivors(survivors, allowlist) {
  const allowedKeys = new Set(Object.keys(allowlist));
  const allowed = survivors.filter((s) => allowedKeys.has(s.split(' -- ')[0]));
  const unexpected = survivors.filter((s) => !allowedKeys.has(s.split(' -- ')[0]));
  return { allowed, unexpected };
}

// EDGE_TEXT_NOT_DISCRIMINATING -- pins whose adjacent line has identical trimmed text (a lone `}`,
// a blank line next to another blank line) cannot be discriminated by a literal-text pin, the same
// "cannot verify must never silently grow" posture as ANCHOR_BLUNT_CITATIONS/`unanchorable` above.
//
// SCOPED TO SHA-FROZEN PINS ONLY (action 3 of the line-number-as-truth-key migration, #206
// follow-up, 2026-09-14): a frozen commit's blob cannot drift, so "any planted drift is rejected"
// is still the right, unconditional guarantee there -- resolvePins' `at: '<sha>'` branch is
// byte-for-byte untouched by that action. `at: 'HEAD'` pins are the other half of this corpus-wide
// proof now, in the HEAD_CORRECTION_EXCEPTIONS allowlist and its own mutation-proof test right
// after this one's: a HEAD pin's text is truth and its line number is DERIVED (resolveAnchor), so a
// pure shift no longer "survives" undetected -- it resolves `ok: true` with a `correction` naming
// the real, current position instead of being silently missed. The single unified population this
// comment used to describe (95 pins, 346 variants, all rejected) split the day that became true.
//
// Measured (SHA half only, 2026-09-14): planting every start-1/start+1/stop-1/stop+1/shift-1/
// shift+1 drift for every SHA-frozen range pin, and every +/-1 drift for every SHA-frozen
// single-line pin -- 254 planted drifts across 75 SHA-frozen pins (37 of BENCH_PINS' 41 are
// SHA-frozen, the other 4 are HEAD; 1 of LIVE_RANGE_PINS' 14 is SHA-frozen, the other 13 are HEAD;
// 0 of BLUNT_PINS' 3 (all 3 are HEAD); all 37 of CCA_PINS are SHA-frozen) -- ALL 254 are caught.
// Empty is the honest, measured result, not an unproven default; if a future SHA pin lands on an
// edge like this, it is added here BY NAME, with a reason, exactly like every other allowlist in
// this file.
//
// D8d (fix pass 11.1): the mutation-proof test's own final assertion used to be
// `assert.equal(killed, variants.length)` -- a genuine, correctly-allowlisted survivor would still
// fail THAT assertion (killed is one short of variants.length), so this allowlist could never
// actually hold an entry without turning the whole test permanently red. Fixed below: the final
// count now credits an ALLOWED survivor as accounted-for, not merely "not reported as unexpected".
const EDGE_TEXT_NOT_DISCRIMINATING = {};

test('EDGE_TEXT_NOT_DISCRIMINATING holds exactly the SHA-frozen pins this action measured unable to discriminate a neighbouring line -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(EDGE_TEXT_NOT_DISCRIMINATING).sort(),
    [],
    'EDGE_TEXT_NOT_DISCRIMINATING changed -- read the new entry by hand and justify it here before pinning it.'
  );
});

// Hermetic proof that the allowlist mechanism itself works, independent of the real corpus
// currently having zero survivors to exercise it against (D8d): builds a REAL survivor (two
// adjacent lines with identical trimmed text, so a +1 drift genuinely still reads as correct),
// then proves classifySurvivors puts it in `allowed` when the allowlist names it and in
// `unexpected` when it does not -- the exact fork the real mutation-proof test's final assertion
// depends on.
test('classifySurvivors: an allowlisted survivor is credited as accounted-for; the same survivor with no allowlist entry is reported unexpected', () => {
  const dir = mkTmp('spo-edge-text-fixture-');
  // A path WITH a "/" so resolveCitationTarget takes the direct path.join+existsSync branch --
  // the bare-basename branch would shell out to `git -C dir ls-files`, and `dir` is a plain
  // mkTmp directory, not a git repo, so a bare "target.txt" citation would resolve nowhere here.
  fs.mkdirSync(path.join(dir, 'sub'));
  const file = path.join(dir, 'sub', 'target.txt');
  // Lines 4 and 5 are both `}` -- a genuine, unavoidable edge: a pin on either line cannot be
  // told apart from its neighbour by literal text alone.
  fs.writeFileSync(file, ['one', 'two', 'three', '}', '}', 'six'].join(String.fromCharCode(10)));
  const pin = { file: 'fixture.md', citation: 'sub/target.txt:4', at: 'HEAD', first: '}' };
  const repoRoots = { repo: dir, product: dir, deploy: dir };
  const base = resolvePins([pin], { repoRoots });
  assert.equal(base[0].ok, true, 'fixture precondition: the base pin must itself be correct');

  const drifted = { ...pin, citation: shiftedCitation(pin.citation, 1, 1) }; // :4 -> :5, also `}`
  const driftedResult = resolvePins([drifted], { repoRoots });
  assert.equal(driftedResult[0].ok, true, 'fixture precondition: the +1 drift must survive (both lines read `}`), or this proves nothing about the allowlist split');

  const survivors = [`${pin.file} :: ${pin.citation} -- line+1 drift (now "${drifted.citation}") still reads as correct`];

  const withAllowlist = classifySurvivors(survivors, { [`${pin.file} :: ${pin.citation}`]: 'fixture: two adjacent `}` lines, genuinely indistinguishable' });
  assert.deepEqual(withAllowlist.unexpected, [], 'an allowlisted survivor must not be reported as unexpected');
  assert.deepEqual(withAllowlist.allowed, survivors, 'an allowlisted survivor must be credited as accounted-for');

  const withoutAllowlist = classifySurvivors(survivors, {});
  assert.deepEqual(withoutAllowlist.allowed, [], 'the same survivor with no allowlist entry must not be silently credited');
  assert.deepEqual(withoutAllowlist.unexpected, survivors, 'the same survivor with no allowlist entry must be reported unexpected');

  fs.rmSync(dir, { recursive: true, force: true });
});

// plantDriftVariants(pins, base) -- shared by both halves of the corpus-wide mutation proof below
// (action 3 follow-up split this into SHA-half/HEAD-half tests; the planting logic itself is
// unchanged from the single test it replaces). Plants every drift shape this action's spec calls
// for, varied per pin (never a repeating fixture value -- test/park-reason-doc-sweep.test.js's own
// "repeating fixture hides which value is keyed" trap) by deriving each shifted citation from the
// PIN's own real citation string and skipping only a shift that would run off either end of the
// real file (no neighbouring line exists there to be confused with). Returns
// [{ pinIndex, kind, shifted }].
function plantDriftVariants(pins, base) {
  const variants = [];
  pins.forEach((pin, i) => {
    const lineCount = base[i].lineCount;
    const isRange = pin.last !== undefined;
    const plant = (kind, startDelta, stopDelta) => {
      const { start, stop } = (() => {
        const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(pin.citation);
        return { start: Number(m[2]), stop: Number(m[3] || m[2]) };
      })();
      const newStart = start + startDelta;
      const newStop = stop + stopDelta;
      if (newStart < 1 || newStart > lineCount || newStop < 1 || newStop > lineCount) return;
      variants.push({ pinIndex: i, kind, shifted: { ...pin, citation: shiftedCitation(pin.citation, startDelta, stopDelta) } });
    };
    if (isRange) {
      plant('start-1', -1, 0);
      plant('start+1', 1, 0);
      plant('stop-1', 0, -1);
      plant('stop+1', 0, 1);
      plant('shift-1', -1, -1);
      plant('shift+1', 1, 1);
    } else {
      plant('line-1', -1, -1);
      plant('line+1', 1, 1);
    }
  });
  return variants;
}

test('MUTATION PROOF, every SHA-frozen pin: a start-1/start+1/stop-1/stop+1/whole-range-shift drift (or a +/-1 drift for a single line) is caught by resolvePins, for EVERY SHA-frozen pin -- not a sample', () => {
  const allPins = [...BENCH_PINS, ...LIVE_RANGE_PINS, ...BLUNT_PINS, ...CCA_PINS];
  // Scoped to `at: '<sha>'` pins (action 3 of the line-number-as-truth-key migration, #206
  // follow-up): a frozen blob cannot drift, so "any planted drift must be rejected" is still the
  // unconditional guarantee here -- see EDGE_TEXT_NOT_DISCRIMINATING's own header, above, for why
  // `at: 'HEAD'` pins are no longer part of THIS test (they get their own, right below).
  const shaPins = allPins.filter((p) => p.at !== 'HEAD');
  const base = resolvePins(shaPins);
  const offenders = base.filter((r) => !r.ok).map((r) => r.why);
  assert.deepEqual(offenders, [], `a pin used as this mutation proof's own baseline is not itself green -- fix the pin, not the proof:\n  ${offenders.join('\n  ')}`);

  const variants = plantDriftVariants(shaPins, base);

  // D3 (fix pass 11.2, driver decision), re-measured after the SHA/HEAD split (action 3 follow-up,
  // 2026-09-14): a bare `> 200` floor stays green even if a whole registry silently stopped being
  // wired in -- the floor cannot tell "the fourth registry is wired in" from "it silently is not".
  // Assert the exact, measured totals instead: 75 SHA-frozen pins (37 of BENCH_PINS' 41 + 1 of
  // LIVE_RANGE_PINS' 14 + 0 of BLUNT_PINS' 3 + all 37 of CCA_PINS) plant exactly 254 variants.
  assert.equal(shaPins.length, 75, `expected 75 SHA-frozen pins (37 of BENCH_PINS' 41 + 1 of LIVE_RANGE_PINS' 14 + 0 of BLUNT_PINS' 3 + 37 of CCA_PINS' 37), found ${shaPins.length} -- a registry was added, removed, resized, or a pin moved between \`at: 'HEAD'\` and \`at: '<sha>'\`; re-measure and update this pin.`);
  assert.equal(variants.length, 254, `expected exactly 254 planted drifts across 75 SHA-frozen pins, found ${variants.length} -- a pin lost or gained line-count headroom, a registry changed size, or the corpus shrank; re-measure.`);

  const results = resolvePins(variants.map((v) => v.shifted));
  const survivors = [];
  results.forEach((r, idx) => {
    if (r.ok) survivors.push(`${variants[idx].shifted.file} :: ${shaPins[variants[idx].pinIndex].citation} -- ${variants[idx].kind} drift (now "${variants[idx].shifted.citation}") still reads as correct`);
  });
  const killed = results.length - survivors.length;

  const { allowed: allowedSurvivors, unexpected: unexpectedSurvivors } = classifySurvivors(survivors, EDGE_TEXT_NOT_DISCRIMINATING);

  assert.deepEqual(
    unexpectedSurvivors,
    [],
    `planted drift(s) NOT caught by resolvePins and not on EDGE_TEXT_NOT_DISCRIMINATING -- either the ` +
      `resolver loosened, or this pin genuinely cannot discriminate a neighbouring line and belongs on ` +
      `that allowlist with a reason:\n  ${unexpectedSurvivors.join('\n  ')}`
  );
  // D8d (fix pass 11.1): an ALLOWED survivor counts as accounted-for, not as a failure -- the old
  // `assert.equal(killed, variants.length)` could never pass while EDGE_TEXT_NOT_DISCRIMINATING
  // held a real entry, which is exactly why it had to stay empty regardless of what was true.
  assert.equal(
    killed + allowedSurvivors.length,
    variants.length,
    `expected every planted drift to be either caught (${killed}) or explicitly allowlisted ` +
      `(${allowedSurvivors.length}) -- ${variants.length} planted; see the survivor list above for which and why.`
  );
  // And EDGE_TEXT_NOT_DISCRIMINATING itself must never hold a STALE entry -- one that no longer
  // corresponds to any actual survivor -- the same "cannot verify must never silently grow, or
  // silently go unchecked" posture this file applies to every other allowlist.
  const survivorKeysSeen = new Set(survivors.map((s) => s.split(' -- ')[0]));
  const staleAllowlistEntries = Object.keys(EDGE_TEXT_NOT_DISCRIMINATING).filter((k) => !survivorKeysSeen.has(k));
  assert.deepEqual(staleAllowlistEntries, [], `EDGE_TEXT_NOT_DISCRIMINATING entry(ies) that no longer correspond to any actual planted-drift survivor -- remove them:\n  ${staleAllowlistEntries.join('\n  ')}`);
});

// HEAD_CORRECTION_EXCEPTIONS -- the complementary allowlist to EDGE_TEXT_NOT_DISCRIMINATING, for
// the HEAD half of the same corpus-wide proof (action 3 of the line-number-as-truth-key migration,
// #206 follow-up, 2026-09-14): a planted drift on an `at: 'HEAD'` pin is now EXPECTED to resolve
// `ok: true` with a `correction` pointing back at the pin's own true, unshifted position -- that is
// the whole point of the inversion, not a survivor to be caught. But two genuinely different real
// edges keep a handful of variants from reaching that clean "corrected" state, both measured by
// hand against the real corpus, neither a defect in resolvePins:
//   - the `last` anchor is itself ambiguous in its target file (matches 2+ lines there). resolvePins'
//     own safety net for this (test/citation-pins.js: the ambiguous-fallback path) either (a)
//     succeeds because the ORIGINAL cited line still holds the text -- resolving `ok: true` but
//     WITHOUT a `correction`, since a fallback resolution never knows whether the number really
//     moved -- or (b) fails outright when the fallback's own stale-position check also misses,
//     exactly the same "likely stale" hard-fail an ambiguous SHA-style mismatch would produce. Both
//     are the correct, safety-first behavior the spec calls for, not a hole.
//   - a 2-line range pin (daemon.js:677-678, re-pinned from :665-666 for action A2, card #239,
//     2026-09-17, then from :669-670 for this chantier's own A5b-2 fix pass, F3, same day -- a
//     +4-line then a +6-line shift; content byte-identical each time, verified by re-reading the
//     target lines) where a start+1 or stop-1 shift makes the two cited
//     numbers COINCIDE -- shiftedCitation then formats the drifted citation as a SINGLE-LINE
//     string, while the pin still carries `last`. The pre-existing RANGE/`last`-shape guard (D4,
//     unchanged by this action, runs before the HEAD/SHA fork) rejects that combination outright --
//     a plant()-mechanism artifact of this specific citation's own 2-line length, not a property of
//     the correction logic.
// Named by pin (not by variant-kind, same granularity EDGE_TEXT_NOT_DISCRIMINATING already uses),
// since either edge affects some or all of a pin's own planted variants together, never a single
// isolated one. Measured 2026-09-14: 3 pins, 14 of the 92 HEAD-half variants land here.
const HEAD_CORRECTION_EXCEPTIONS = {
  'doc/state-machine-spec.md :: dispatcher.js:643-656':
    "the `last` anchor (\"      return;\") occurs 3 times in orchestrator/dispatcher.js -- ambiguous. " +
    'A start-only shift (start-1/start+1) resolves ok via the ambiguous-fallback path (the original ' +
    'stop, 648, still reads "return;") but reports no correction; a stop-touching shift (stop-1/' +
    'stop+1/shift-1/shift+1) moves off 648 and the fallback\'s own stale-position check also misses, ' +
    'so it hard-fails. All 6 range-variant kinds land here.',
  'orchestrator/README.md :: dispatcher.js:643-656':
    'the same fact, cited a second time from a different file -- identical reasoning and outcome as ' +
    'the doc/state-machine-spec.md entry above (same target, same ambiguous `last` anchor).',
  'orchestrator/dispatcher.js :: daemon.js:677-678':
    'a 2-line range: the start+1 and stop-1 shifts make the two cited numbers coincide (676 and 675 ' +
    'respectively), so the drifted citation string collapses to SINGLE-LINE form while the pin still ' +
    'carries `last` -- rejected by the pre-existing, unchanged RANGE-shape guard before HEAD ' +
    'resolution ever runs. start-1/stop+1/shift-1/shift+1 all correct cleanly. (Re-pinned from ' +
    ':665-666 for action A2, card #239, 2026-09-17, then from :669-670 for this chantier\'s own ' +
    'A5b-2 fix pass, F3, same day -- a +4-line then a +6-line shift; same shape, same reasoning.)',
};

test('HEAD_CORRECTION_EXCEPTIONS holds exactly the HEAD pins this action measured unable to reach a clean corrected state -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(HEAD_CORRECTION_EXCEPTIONS).sort(),
    [
      'doc/state-machine-spec.md :: dispatcher.js:643-656',
      'orchestrator/README.md :: dispatcher.js:643-656',
      'orchestrator/dispatcher.js :: daemon.js:677-678',
    ].sort(),
    'HEAD_CORRECTION_EXCEPTIONS changed -- read the new entry by hand and justify it here before pinning it.'
  );
});

test('MUTATION PROOF, every HEAD pin: the same planted drift resolves ok: true with a `correction` pointing back at the real, unchanged position -- HEAD pins report drift instead of rejecting it (action 3 of the line-number-as-truth-key migration)', () => {
  const allPins = [...BENCH_PINS, ...LIVE_RANGE_PINS, ...BLUNT_PINS, ...CCA_PINS];
  const headPins = allPins.filter((p) => p.at === 'HEAD');
  const base = resolvePins(headPins);
  const offenders = base.filter((r) => !r.ok || r.correction).map((r) => r.why || `${r.pin.file} :: ${r.pin.citation} -- unexpectedly reported a correction: ${JSON.stringify(r.correction)}`);
  assert.deepEqual(offenders, [], `a pin used as this mutation proof's own baseline is not itself green (ok: true, no correction) -- fix the pin, not the proof:\n  ${offenders.join('\n  ')}`);

  const variants = plantDriftVariants(headPins, base);

  // Measured 2026-09-14 (mirrors the SHA-half's own D3 discipline, above): 20 HEAD pins (4 of
  // BENCH_PINS' 41 + 13 of LIVE_RANGE_PINS' 14 + all 3 of BLUNT_PINS + 0 of CCA_PINS' 37, CCA_PINS
  // being entirely SHA-frozen) plant exactly 92 variants.
  assert.equal(headPins.length, 20, `expected 20 HEAD pins (4 of BENCH_PINS' 41 + 13 of LIVE_RANGE_PINS' 14 + 3 of BLUNT_PINS' 3 + 0 of CCA_PINS' 37), found ${headPins.length} -- a registry was added, removed, resized, or a pin moved between \`at: 'HEAD'\` and \`at: '<sha>'\`; re-measure and update this pin.`);
  assert.equal(variants.length, 92, `expected exactly 92 planted drifts across 20 HEAD pins, found ${variants.length} -- a pin lost or gained line-count headroom, a registry changed size, or the corpus shrank; re-measure.`);

  const results = resolvePins(variants.map((v) => v.shifted));
  const notCorrected = [];
  let corrected = 0;
  results.forEach((r, idx) => {
    const v = variants[idx];
    const originalPin = headPins[v.pinIndex];
    const key = `${originalPin.file} :: ${originalPin.citation}`;
    const label = `${key} -- ${v.kind} drift (now "${v.shifted.citation}")`;
    if (!r.ok) {
      notCorrected.push(`${label} was rejected instead of corrected: ${r.why}`);
      return;
    }
    if (!r.correction) {
      notCorrected.push(`${label} resolved ok but reported no correction`);
      return;
    }
    // The correction must point back at the pin's own ORIGINAL (pre-drift) start/stop -- the real
    // text never moved, only this planted guess about where to look did, so every variant of the
    // same pin must agree on the identical real position.
    const orig = /^(.+):(\d+)(?:-(\d+))?$/.exec(originalPin.citation);
    const origStart = Number(orig[2]);
    const origStop = Number(orig[3] || orig[2]);
    const got = /^(.+):(\d+)(?:-(\d+))?$/.exec(r.correction.citation);
    const gotStart = Number(got[2]);
    const gotStop = Number(got[3] || got[2]);
    if (gotStart !== origStart || gotStop !== origStop) {
      notCorrected.push(`${label} reported a correction pointing at "${r.correction.citation}", expected it to point back at start ${origStart}/stop ${origStop}`);
      return;
    }
    corrected += 1;
  });

  const { allowed: allowedExceptions, unexpected: unexpectedNotCorrected } = classifySurvivors(notCorrected, HEAD_CORRECTION_EXCEPTIONS);

  assert.deepEqual(
    unexpectedNotCorrected,
    [],
    `planted drift(s) on a HEAD pin did NOT resolve to a clean correction and are not on ` +
      `HEAD_CORRECTION_EXCEPTIONS -- either the resolver regressed, or this pin genuinely cannot reach ` +
      `a corrected state and belongs on that allowlist with a reason:\n  ${unexpectedNotCorrected.join('\n  ')}`
  );
  assert.equal(
    corrected + allowedExceptions.length,
    variants.length,
    `expected every planted HEAD drift to be either cleanly corrected (${corrected}) or explicitly ` +
      `allowlisted (${allowedExceptions.length}) -- ${variants.length} planted; see the list above for which and why.`
  );
  const notCorrectedKeysSeen = new Set(notCorrected.map((s) => s.split(' -- ')[0]));
  const staleAllowlistEntries = Object.keys(HEAD_CORRECTION_EXCEPTIONS).filter((k) => !notCorrectedKeysSeen.has(k));
  assert.deepEqual(staleAllowlistEntries, [], `HEAD_CORRECTION_EXCEPTIONS entry(ies) that no longer correspond to any actual not-corrected variant -- remove them:\n  ${staleAllowlistEntries.join('\n  ')}`);
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
  const text = '`console/collect.js`, reached from `bin/spo:1141`, reads it by content';
  const idx = text.indexOf('bin/spo:1141');
  const end = idx + 'bin/spo:1141'.length;
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
  const noIdentText = '`console/collect.js`, reached from `bin/spo:1141`, reads it by content';
  const idx1 = noIdentText.indexOf('bin/spo:1141');
  const end1 = idx1 + 'bin/spo:1141'.length;
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
  const dir = mkTmp('spo-anchor-fixture-');
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
  const dir = mkTmp('spo-anchor-fixture-');
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

test('candidateFoundNear: a "file" candidate matches by SUBSTRING, not \\b-bounded -- the exact reason bin/spo:1141 needs it ("collect" inside "collectAll")', () => {
  const dir = mkTmp('spo-anchor-fixture-');
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

test('MUTATION PROOF: reverting bin/spo:1243 back to bin/spo:1129 (the drift this check caught again) makes it red, on the real files', () => {
  const raw = read('doc/bench-plan-derived-2026-09-02.md');
  const withoutFences = stripFences(raw);
  const normalized = normalizeWrap(withoutFences);
  // The mutation is the citation's own PREVIOUS value, `:1129`, not the original historical
  // `:1090-1093`. That first range stopped being a usable canary on 2026-09-04: intake-token
  // journalling (SPO-Pipeline#117) pushed `cmdDashboard`'s header comment down onto lines
  // 1090-1093, and that comment names `console/collect.js` -- so the "wrong" citation now
  // anchors for an accidental reason and proves nothing.
  //
  // FOURTH catch of the same citation, 2026-09-05, and the first where two fixes collided: #117
  // moved `collectAll(sources)` to :1129 and the flight deck (#122) moved it again in the same
  // window, so `main` and the deck branch each landed a DIFFERENT correct answer (:1129 and
  // :1108) and the merge had to recompute a third (:1135). The canary is therefore `:1129` --
  // the value main had just fixed to, which the merge itself invalidated. It lands mid-
  // `cmdDashboard` on a comment line naming neither collect nor a code-shaped candidate, so it
  // fails for the right reason. See the two "canary green for an accidental reason" notes
  // above: a canary that passes for a reason unrelated to what it watches is worse than none.
  //
  // FIFTH catch, same day: moving state out of the repo (orchestrator/state-root.js) added six
  // lines to `resolveDirs` near the top of bin/spo, so `collectAll(sources)` is now :1141. The
  // canary stays `:1129` -- it is still wrong, still for the right reason, and re-pointing it at
  // each new correct value would only ever re-test the value the check just verified. What this
  // repetition is really saying is that a LINE-NUMBER citation into a file under active edit
  // cannot be kept true by discipline; it is a standing tax the symbol-citation conversion
  // (action M17) exists to retire, and this one has now been paid five times.
  //
  // SIXTH catch, 2026-09-06: card #100's daemon-lock guard added lines above `cmdDashboard` (a
  // shared `refuseIfDaemonLockHeld` helper plus wider `pull`/`intake` header comments), pushing
  // `collectAll(sources)` down again, from :1141 to :1150. The canary stays `:1129` -- still
  // wrong for the same reason FOURTH/FIFTH already established (mid-`cmdDashboard`, no `collect`-
  // shaped candidate nearby), still the value that costs nothing to keep re-using. Paid six times.
  //
  // SEVENTH catch, 2026-09-09: card #164's stopped-vs-idle fix (`computeDispatcherStatus`, née
  // `computeDispatcherIdleStatus`, plus its caller, plus the file's own `spo status` inventory
  // documenting the new STOPPED line) added 50 lines above `cmdDashboard`, pushing
  // `collectAll(sources)` down again, from :1150 to :1200. The canary stays `:1129` -- re-checked
  // empirically against the new file rather than assumed: the new line 1129 falls inside
  // `cmdResume`'s own header comment ("under journal/); if that exists, lists every recorded LLM
  // step (journal event..."), nowhere near `cmdDashboard` and containing no "collect"-shaped
  // candidate, so it still fails for the right reason. Paid seven times.
  //
  // EIGHTH catch, 2026-09-11: card #186 moved `computeDispatcherStatus` (with its own header
  // comment) OUT of bin/spo entirely, into console/dispatcher-status.js, so bin/spo's `spo status`
  // and console/collect.js's dashboard deck could share one derivation instead of each carrying a
  // copy. Removing those 47 lines above `cmdDashboard` pulled `collectAll(sources)` back UP this
  // time, from :1200 to :1153. The canary stays `:1129` -- re-checked empirically against the new
  // file: line 1129 now falls at `const { createProdProbe } = require('../console/prod-version');`,
  // inside the `--serve` require block, still no "collect"-shaped candidate nearby, so it still
  // fails for the right reason. Paid eight times.
  //
  // NINTH catch, 2026-09-11 (card #188): the drain-that-dies-inside-the-wait fix added a
  // `DRAINING`/`diedDraining` branch to `spo status`'s own dispatcher-line rendering, plus 5 more
  // lines in this file's own top-of-file subcommand inventory documenting it, both above
  // `cmdDashboard`, pushing `collectAll(sources)` down again, from :1153 to :1192. The canary
  // stays `:1129` -- re-checked empirically against the new file: line 1129 is now a blank line
  // inside `cmdResume` (between `resolveDirs`'s destructure and its `fs.existsSync` check), still
  // no "collect"-shaped candidate nearby, so it still fails for the right reason. Paid nine times.
  //
  // TENTH catch, 2026-09-11, same card: EPERM handling and prose fixes added further lines above
  // `cmdDashboard` (the `pidExists` doc comment, the `DRAINING`/STOPPED header rewording, the
  // `diedDraining` reason/caption rewrite), pushing `collectAll(sources)` down again, from :1192
  // to :1207. The canary stays `:1129` -- re-checked empirically against the new file: line 1129
  // now falls inside `cmdParked`'s reconciled-rows printing (`if (reconciledRows.length) {`),
  // still no "collect"-shaped candidate nearby, so it still fails for the right reason. Paid ten
  // times.
  //
  // ELEVENTH catch, 2026-09-11, same card: the rewording of `cmdStatus`'s `pidExists` comment (5
  // lines -> 6) added one net line above `cmdDashboard`, pushing `collectAll(sources)` from :1207
  // to :1208. The canary stays `:1129` -- re-checked empirically against the new file: line 1129
  // now falls at the closing `}` of `cmdParked`'s `if (abandonedRows.length) {` block, still no
  // "collect"-shaped candidate nearby, so it still fails for the right reason. Paid eleven times.
  //
  // TWELFTH catch, 2026-09-11, same card (the drain-that-reads-DRAINING-forever follow-up): the
  // dispatcher-drain-start age bound (`now`/`killGraceMs` injected into computeDispatcherStatus --
  // card #208 (2026-09-12) later added a third injected option, `hostUptimeNowMs`, to this same
  // bound; not present yet at the time of THIS catch, named here only so this description does not
  // go on describing a two-option bound after a third option exists --
  // plus the matching rewording of `spo status`'s own top-of-file subcommand inventory, the
  // DRAINING-branch comment, and the diedDraining-branch comment) added 21 net lines above
  // `cmdDashboard` (measured at the time: `git diff --stat -- bin/spo` read 35 insertions, 14 deletions),
  // pushing `collectAll(sources)` down again, from :1208 to :1229. The canary stays `:1129` -- re-
  // checked empirically against the new file: line 1129 is now the closing `}` of `cmdParked`'s
  // reconciled-row branch (`if ((state.state === 'PARKED' || state.state === 'ABANDONED') &&
  // state.externallyResolved) { ... continue; }`) — the content that sat at :1108 before this
  // change, 21 lines earlier than the ELEVENTH catch's own :1129 target, since this change's
  // insertions all land above it — still no "collect"-shaped candidate nearby, so it still fails
  // for the right reason. Paid twelve times.
  //
  // THIRTEENTH catch, 2026-09-11, same follow-up (a verification round): the rewording of `spo
  // status`'s top-of-file subcommand inventory (+1 line) and of the diedDraining-branch comment
  // (+1 line) added 2 net lines above `cmdDashboard` -- the caption swap itself and the
  // DRAINING-branch comment are net 0, and this round's `timeoutMs >= 0` guard and dashboard
  // captions live in console/dispatcher-status.js and console/render.js, not bin/spo (measured:
  // `git diff --numstat -- bin/spo` now reads 33 insertions, 10 deletions, 23 net against HEAD =
  // the TWELFTH catch's 21 plus these 2), pushing `collectAll(sources)` down again, from :1229 to
  // :1231.
  // The canary stays `:1129` -- re-checked empirically against the new file: line 1129 is now
  // `      );`, the closing paren of `cmdParked`'s reconciled-row `reconciledRows.push(...)` call
  // -- 2 lines above the TWELFTH catch's own construct, which this round's +2 pushed from :1129 to
  // :1131 (`    }`, the same reconciled-row branch's closing brace) -- still no "collect"-shaped
  // candidate nearby, so it still fails for the right reason. Paid thirteen times.
  //
  // FOURTEENTH catch, 2026-09-12 (card #208, the dispatcher-status drain-bound clock fix pass):
  // threading `hostUptimeAtMs`/`hostUptimeNowMs` through `bin/spo`'s `cmdStatus` (the injected-
  // options comment above `computeDispatcherStatus`'s call, the call itself, and -- a second,
  // later edit in this same fix pass, F8 -- widening the `diedDraining` caption's own comment and
  // adding its `rebooted`-branching `deathNote`) is net +12 lines (19 added, 7 removed -- `git
  // diff --numstat -- bin/spo`), pushing `collectAll(sources)` down again, from :1231 to :1243.
  // The canary stays `:1129` -- re-checked empirically against the new file: line 1129 is now a
  // comment inside `cmdParked` (`// printed under its own heading instead. Measured 2026-09-01: 3
  // of 3 parked-or-abandoned`), pushed there from the THIRTEENTH catch's own `if ((state.state ===
  // 'PARKED' ...` line by this card's own insertions landing above it (inside `cmdStatus`), still
  // no "collect"-shaped candidate nearby, so it still fails for the right reason. Paid fourteen
  // times.
  //
  // FIFTEENTH catch, 2026-09-13 (card #214, per-model journalling / numTurns removal / PLAN
  // delegation): `bin/spo`'s `cmdTokens` gained an opt-in `--usage-delta` section (a `usageDelta`
  // parseArgs flag/branch, plus the async per-step journal-vs-transcript delta print at the end
  // of `cmdTokens` itself, both above `collectAll(sources)`) -- net +30 lines (32 added, 1 removed
  // -- `git diff --numstat -- bin/spo`), pushing `collectAll(sources)` down again, from :1243 to
  // :1273. The canary stays `:1129` -- re-checked empirically against the new file: line 1129 is
  // now inside that same new `--usage-delta` section's own catch block (`console.log(\`note:
  // --usage-delta could not complete...\`)`), still no "collect"-shaped candidate nearby, so it
  // still fails for the right reason. Paid fifteen times.
  //
  // SIXTEENTH catch, 2026-09-14 (card #219, dispatcher-status drain-bound residuals): `bin/spo`
  // gained a `monotonicNowMs` require line plus two option lines (`processStartUptimeMs`,
  // `monotonicNowMs: monotonicNowMs()`) above `cmdDashboard`, a net +3 lines, pushing
  // `collectAll(sources)` down again, from :1273 to :1276. The canary stays `:1129` -- re-checked
  // empirically against the new file: line 1129 is unaffected by this card's edits (which all
  // land well below it, inside `cmdStatus`), so it is still the same THIRTEENTH-catch content,
  // still no "collect"-shaped candidate nearby, so it still fails for the right reason. Paid
  // sixteen times.
  //
  // SEVENTEENTH catch, 2026-09-14, same card's own fix pass (verification round): the injected-
  // deps comment above `cmdStatus`'s `computeDispatcherStatus` call was expanded (naming
  // `processStartUptimeMs`/`monotonicNowMs()` explicitly, TWO option lines, not one) by 4 more net
  // lines, pushing `collectAll(sources)` down again, from :1276 to :1283. The canary stays `:1129`
  // -- re-checked empirically against the new file: still unaffected by edits landing inside
  // `cmdStatus`, well below it, still the same content, still no "collect"-shaped candidate
  // nearby, so it still fails for the right reason. Paid seventeen times.
  //
  // EIGHTEENTH catch, card #239 chantier action A6 (2026-09-17): `generateOnce()`'s own comment
  // (documenting live-step.js's read side moving off the five-link transcript chain onto a
  // worker-written `live-progress.json`) grew by one net line above `collectAll(sources)` (a
  // rewrap, not an addition of new sentences -- `git diff --numstat -- bin/spo` reads 5
  // insertions, 4 deletions), pushing it down again, from :1283 to :1284. The canary stays
  // `:1129` -- re-checked empirically against the new file: unaffected (this action's only edit
  // to bin/spo landed well below line 1129, inside `cmdDashboard`'s static-mode comment), still
  // no "collect"-shaped candidate nearby, so it still fails for the right reason. Paid eighteen
  // times.
  const reverted = normalized.replace('reached from `bin/spo:1284`', 'reached from `bin/spo:1129`');
  assert.notEqual(reverted, normalized, 'fixture precondition: the real file must still contain the fixed text this test reverts');

  const cites = extractCitations(reverted).filter((c) => !c.unanchored && c.file === 'bin/spo');
  assert.equal(cites.length, 1, 'expected exactly one bin/spo citation in this doc');
  const c = cites[0];
  assert.deepEqual([c.start, c.stop], [1129, 1129], 'the revert must have actually changed the parsed line range');

  const resolved = resolveCitationTarget(c.file);
  assert.ok(resolved.target, 'bin/spo must resolve for this proof to mean anything');
  const candidates = mergedCandidates(reverted, c.idx, c.end, null, null, c.file);
  const top = candidates.slice(0, ANCHOR_TOPK);
  const found = top.some((cand) => candidateFoundNear(cand, resolved.target, c.start, c.stop));
  assert.equal(found, false, 'the stale bin/spo:1129 citation must be reported as an anchor failure -- if this assertion fails, the check cannot catch the exact class of bug that motivated it');

  // And the fixed text (:1208, actually on disk) must anchor cleanly, via the SAME substring-
  // matched 'file' candidate ("collect", from `console/collect.js`) -- proving both that the
  // check discriminates the specific drift in both directions AND that the 'file' kind's
  // substring matching (see candidateFoundNear's own fixture test) is what makes it possible at
  // all: "collect" is never a \b-bounded whole word at the real call site, only a substring of
  // `collectAll`.
  const cites1208 = extractCitations(normalized).filter((c2) => !c2.unanchored && c2.file === 'bin/spo');
  const c1208 = cites1208[0];
  const candidates1208 = mergedCandidates(normalized, c1208.idx, c1208.end, null, null, c1208.file);
  assert.equal(candidates1208[0] && candidates1208[0].kind, 'file', 'this proof is only meaningful if the real candidate is the cross-file "file"-kind mention it is meant to exercise');
  const found1208 = candidates1208.slice(0, ANCHOR_TOPK).some((cand) => candidateFoundNear(cand, resolved.target, c1208.start, c1208.stop));
  assert.equal(found1208, true, 'the real, fixed :1208 citation must anchor cleanly');
});

// Card #186 verification, and now ALSO covered by action 11.1 (#206)'s BENCH_PINS: at the time
// this test was written, both doc/bench-audit-2026-09-02.md and doc/bench-plan-derived-2026-09-02.md
// were content-unchecked (ANCHOR_EXCLUDED_FILES kept them off the identifier anchor layer, and
// nothing else read their citations' targets), so a CONSISTENT wrong re-pin (the doc's text and
// EXPECTED_CITATIONS moved together to the same wrong number) would satisfy every existing test in
// this file and still ship green -- exactly #206's own probe 1. This bespoke test and its mutation
// proof closed that gap for ONE fact (the `bin/spo` `collectAll` call site) before BENCH_PINS
// existed, and both docs now ALSO carry a generic LIVE pin for the very same citation
// (`doc/bench-audit-2026-09-02.md :: bin/spo:1284` / `doc/bench-plan-derived-2026-09-02.md ::
// bin/spo:1284` in BENCH_PINS, re-pinned from :1273, then :1276, then :1283), checked by resolvePins and covered by this
// corpus-wide pin mutation-proof test below. NOT folded into the pin and retired, though: the pin
// mechanism verifies EACH doc's own citation independently and does not, by itself, guarantee the
// two docs cite the SAME line -- the cross-doc invariant this test's first assertion checks
// (`auditCite.start === planCite.start`) is not implied by two passing, independent pins. This test
// reads the real bin/spo content at the line each doc cites -- not EXPECTED_CITATIONS, which a
// consistent re-pin would also have changed -- so it cannot be fooled by that move.
// `binSpoLineNamesCollectAll` is shared with its own mutation proof immediately below, so a change
// that made the real check vacuous (e.g. always returning true) would be caught there too.
function binSpoLineNamesCollectAll(lineNumber) {
  const resolved = resolveCitationTarget('bin/spo');
  if (!resolved.target) return { resolved: false, named: false, line: '' };
  const spoLines = fs.readFileSync(resolved.target, 'utf8').split('\n');
  const line = spoLines[lineNumber - 1] || '';
  return { resolved: true, named: line.includes('collectAll'), line };
}

test('bench-audit and bench-plan-derived cite the SAME bin/spo line for "console/collect.js reached from bin/spo:N", and that line actually names collectAll', () => {
  const auditNormalized = normalizeWrap(stripFences(read('doc/bench-audit-2026-09-02.md')));
  const planNormalized = normalizeWrap(stripFences(read('doc/bench-plan-derived-2026-09-02.md')));
  const auditCite = extractCitations(auditNormalized).find((c) => c.file === 'bin/spo');
  const planCite = extractCitations(planNormalized).find((c) => c.file === 'bin/spo');
  assert.ok(auditCite, 'expected a bin/spo:N citation in doc/bench-audit-2026-09-02.md');
  assert.ok(planCite, 'expected a bin/spo:N citation in doc/bench-plan-derived-2026-09-02.md');
  assert.deepEqual(
    [auditCite.start, auditCite.stop],
    [planCite.start, planCite.stop],
    'the two dated bench docs describe the SAME fact (console/collect.js reached from bin/spo) and must cite the SAME line'
  );

  const check = binSpoLineNamesCollectAll(auditCite.start);
  assert.ok(check.resolved, 'bin/spo must resolve for this check to mean anything');
  assert.ok(
    check.named,
    `bin/spo:${auditCite.start} (the line both bench docs cite) must contain "collectAll" -- it does not: "${check.line.trim()}"`
  );
});

test('mutation proof: a CONSISTENT wrong re-pin of the bench-audit citation (moved one line past the real target) is still caught, because that line does not name collectAll', () => {
  const auditRaw = read('doc/bench-audit-2026-09-02.md');
  const realCite = extractCitations(normalizeWrap(stripFences(auditRaw))).find((c) => c.file === 'bin/spo');
  assert.ok(realCite, 'fixture precondition: doc/bench-audit-2026-09-02.md must currently cite a bin/spo:N line');
  // Derived from the REAL cited line, not hand-typed, so a future shift needs no bump here.
  const wrongLine = realCite.start + 1;
  const mutatedRaw = auditRaw.replace(`reached from \`bin/spo:${realCite.start}\``, `reached from \`bin/spo:${wrongLine}\``);
  assert.notEqual(mutatedRaw, auditRaw, 'fixture precondition: the real file must still contain the text this test mutates');

  const mutatedCite = extractCitations(normalizeWrap(stripFences(mutatedRaw))).find((c) => c.file === 'bin/spo');
  assert.equal(mutatedCite.start, wrongLine, 'the mutation must have actually changed the parsed line');

  const check = binSpoLineNamesCollectAll(wrongLine);
  assert.equal(
    check.named,
    false,
    `bin/spo:${wrongLine} must NOT contain "collectAll" for this proof to mean anything -- if it does, this proof needs a different offset`
  );
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

test('every bare "doc/<name>.md" reference in the 70-file corpus resolves here, in the product repo, or is on DANGLING_DOC_REF_ALLOWLIST', () => {
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
// actually names by filename (re-measured: `DEPLOY.md` -- orchestrator/README.md:2169;
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

// ---- Rule B: a pin's closing testimony must name the pin's own line -------------------------
//
// Found in card #239 (SDK transport chantier) by an Opus verifier's mutation round. The citation
// checks above prove a `doc :: target:N` key POINTS at something real; nothing proved that the
// SENTENCE describing the pin is true. Eight entries of EXPECTED_CITATIONS had a correct value and
// a closing "content byte-identical at :M" that named a DIFFERENT line -- every re-pin edits the
// key and (sometimes) forgets the prose, and a reader trusting the prose re-verifies the wrong
// line. Three of the eight predate that chantier entirely (they exist at 41fb081, the merge that
// preceded it): the class is older than the card that found it.
//
// The rule: the LAST `content byte-identical at :N[-M]` clause in an entry's prose must equal the
// key's own line (or range). NOT "no foreign line number anywhere": earlier hop-history in the same
// comment ("... then :1029 -> :1078 ...; content byte-identical at :1078 ...") is legitimate, and
// that naive rule fired on 37 of 48 measured entries, every one a false positive. Rule B measured
// 7 of 48 with zero false positives when first run, and 8 of 96 by the time it shipped.
//
// It reads the registry's own source lines (a `//` comment has no runtime value to read) and
// refuses to run blind: the keys it extracts must deepEqual EXPECTED_CITATIONS, so an entry
// reformatted onto two lines fails loudly here, and so does ANY non-entry line inside the literal
// (a `//` continuation, a comment above an entry): extractPinProse throws instead of skipping it.

// Pure: (source lines of the file) -> [{ key, prose }] for the EXPECTED_CITATIONS literal.
function extractPinProse(lines) {
  const start = lines.findIndex((l) => l.startsWith('const EXPECTED_CITATIONS = ['));
  if (start < 0) throw new Error('const EXPECTED_CITATIONS = [ not found');
  let end = start + 1;
  while (end < lines.length && lines[end] !== '];') end++;
  const out = [];
  for (let i = start + 1; i < end; i++) {
    if (lines[i].trim() === '') continue;
    const m = lines[i].match(/^\s*"([^"]+)",(?:\s*\/\/\s*(.*))?$/);
    // ANY other line inside the literal -- a `//` continuation, a comment above an entry, a
    // reformatted entry -- is prose this check can no longer see, so it is refused, not skipped.
    if (!m) throw new Error(`EXPECTED_CITATIONS line ${i + 1} is not a one-line \`"key", // prose\` entry: ${lines[i].slice(0, 80)}`);
    out.push({ key: m[1], prose: m[2] || '' });
  }
  return out;
}

// `byte-identical` ... `at :N`, tolerating a parenthetical between them (`byte-identical
// (\`function cmdDashboard(opts) {\`) at :1242`, a real entry) and a wording without "content".
const TESTIMONY_CLAUSE_RE = /byte-identical\b[^.;]{0,80}?\bat :(\d+)(?:-(\d+))?/g;

// Pure: [{ key, prose }] -> one offender string per pin whose LAST testimony clause names a
// different line than the key's own. A pin with no testimony clause is not this rule's business.
function pinTestimonyOffenders(entries) {
  const offenders = [];
  for (const { key, prose } of entries) {
    const own = key.match(/:(\d+)(?:-(\d+))?$/);
    const clauses = [...prose.matchAll(TESTIMONY_CLAUSE_RE)];
    if (!own || clauses.length === 0) continue;
    const last = clauses[clauses.length - 1];
    if (last[1] !== own[1] || (last[2] || '') !== (own[2] || '')) {
      offenders.push(`${key} -- closing testimony names ${last[0].replace('content ', '')}, the pin is ${own[0]}`);
    }
  }
  return offenders;
}

const readOwnSource = () => fs.readFileSync(__filename, 'utf8').split('\n');

test('every EXPECTED_CITATIONS pin\'s closing "byte-identical at" clause names the pin\'s own line (Rule B)', () => {
  const entries = extractPinProse(readOwnSource());
  assert.deepEqual(
    entries.map((e) => e.key),
    EXPECTED_CITATIONS,
    'the extractor no longer sees every EXPECTED_CITATIONS entry on its own line -- it would be ' +
      'checking a subset and reporting green. Keep each entry `"key", // prose` on ONE line.'
  );
  // EXACT, not a floor (a floor is a bound: five pins could go blind under `>= 20` against 25):
  // 26 of 96 carry a testimony clause today (measured 2026-09-21 with the wide regex; the narrow
  // `content byte-identical at :` form finds 25 -- the 26th is bin/spo:1242's parenthetical form).
  // A pin gaining or losing a clause is a deliberate act, updated here by name, the way
  // CORPUS_FILES.length is.
  const withTestimony = entries.filter((e) => [...e.prose.matchAll(TESTIMONY_CLAUSE_RE)].length > 0).length;
  assert.equal(withTestimony, 26, `${withTestimony} pins carry a testimony clause, expected 26 -- a clause was reworded past TESTIMONY_CLAUSE_RE (the check is going blind) or one was added/removed; update this pin by name`);
  assert.deepEqual(pinTestimonyOffenders(entries), []);
});

test('Rule B fires on a pin whose closing testimony names a different line, and only on that', () => {
  const key = 'doc/x.md :: config.js:1104';
  // The real shape of the 8 found: a correct key, a stale closing clause.
  assert.deepEqual(
    pinTestimonyOffenders([{ key, prose: 're-pinned from :900; content byte-identical at :1102, verified.' }]),
    [`${key} -- closing testimony names byte-identical at :1102, the pin is :1104`]
  );
  // Legitimate hop-history: an EARLIER foreign clause, the LAST one is the pin's own. Must not fire.
  assert.deepEqual(
    pinTestimonyOffenders([{ key, prose: 'content byte-identical at :900 ... then content byte-identical at :1102 ... content byte-identical at :1104, verified.' }]),
    []
  );
  // Foreign line numbers with no testimony clause at all are ordinary prose, not this rule's business.
  assert.deepEqual(pinTestimonyOffenders([{ key, prose: 're-pinned from :900, then :1035, then :1097.' }]), []);
  // Newest-first prose whose OLDEST hop comes last is exactly the state-machine.js:3436 shape: it fires.
  assert.equal(
    pinTestimonyOffenders([{ key: 'a :: s.js:3436', prose: 'content byte-identical at :3436. Before that content byte-identical at :3392.' }]).length,
    1
  );
  // A range pin needs the range, not just its first line.
  assert.equal(pinTestimonyOffenders([{ key: 'a :: d.js:643-656', prose: 'content byte-identical at :643.' }]).length, 1);
  assert.deepEqual(pinTestimonyOffenders([{ key: 'a :: d.js:643-656', prose: 'content byte-identical at :643-656.' }]), []);
});

test('Rule B is live against the real registry: re-introducing a stale closing clause turns it red', () => {
  const lines = readOwnSource();
  const entries = extractPinProse(lines);
  const target = entries.find((e) => e.key === 'orchestrator/README.md :: config.js:1072');
  assert.ok(target, 'fixture pin moved -- pick another entry that ends in a testimony clause');
  // Mutate a COPY of the real prose the way a careless re-pin does: same key, old line in the clause.
  const mutated = entries.map((e) =>
    e === target ? { key: e.key, prose: e.prose.replace(/content byte-identical at :1072/g, 'content byte-identical at :968') } : e
  );
  assert.notDeepEqual(mutated, entries, 'the mutation did not change the prose -- the fixture is stale');
  assert.equal(pinTestimonyOffenders(mutated).length, 1);
  assert.deepEqual(pinTestimonyOffenders(entries), []);
});

test('Rule B cannot be evaded by moving prose off the entry line, or by rewording the clause', () => {
  const src = (body) => ['const EXPECTED_CITATIONS = [', ...body, '];'];
  const entry = '  "a :: s.js:10", // content byte-identical at :10.';
  assert.deepEqual(extractPinProse(src([entry, '']))[0].key, 'a :: s.js:10');
  // A `//` continuation, a comment line above an entry, and a two-line entry are all refused
  // (a stale clause hidden there was invisible to the key-parity check alone).
  for (const bad of ['  // content byte-identical at :999.', '  "b :: s.js:11",\n', '  // a stray note']) {
    assert.throws(() => extractPinProse(src([entry, bad])), /not a one-line/);
  }
  // The clause forms the narrow regex missed: a parenthetical, and no leading "content".
  const key = 'a :: bin/spo:1242';
  for (const stale of [
    'byte-identical (`function cmdDashboard(opts) {`) at :1200.',
    'the target is byte-identical at :1200, verified.',
  ]) {
    assert.equal(pinTestimonyOffenders([{ key, prose: stale }]).length, 1, stale);
  }
  assert.deepEqual(pinTestimonyOffenders([{ key, prose: 'byte-identical (`function cmdDashboard(opts) {`) at :1242.' }]), []);
});
