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
    name: 'accountLeaseWaitMs derives from MAX_LEASE_AGE_MS (31.5 min), not a flat 5 min', // action 6.2
    checks: [
      {
        file: 'orchestrator/step-contracts.js',
        contains: 'const MAX_LEASE_AGE_MS = 2 * LLM_STEP_DEADLINE_MS + Math.round(LLM_STEP_DEADLINE_MS / 10);',
      },
      {
        file: 'orchestrator/config.js',
        contains: "accountLeaseWaitMs: positiveMsFromEnv('SPO_ACCOUNT_LEASE_WAIT_MS', MAX_LEASE_AGE_MS),",
      },
      { file: 'doc/state-machine-spec.md', contains: '**31.5 min** — `MAX_LEASE_AGE_MS`' },
      { file: 'orchestrator/README.md', contains: '`MAX_LEASE_AGE_MS` (`step-contracts.js`, **31.5 minutes**: 2 ×' },
    ],
  },
  {
    name: 'LLM_STEP_DEADLINE_MS (900000ms / 15min) -- all five LLM steps', // action 1.x / 2.1
    checks: [
      { file: 'orchestrator/step-contracts.js', contains: 'const LLM_STEP_DEADLINE_MS = 900000;' },
      { file: 'doc/state-machine-spec.md', contains: '| 900000ms / 15min |' },
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
      'LLM_STEP_DEADLINE_MS (900000ms / 15min) -- all five LLM steps',
      'account cooldown: escalation window (2 hours)',
      'account cooldown: overloaded (5 minutes, flat, never escalates)',
      'account cooldown: usage escalated (5 hours)',
      'account cooldown: usage probe (1 hour)',
      'accountLeaseWaitMs derives from MAX_LEASE_AGE_MS (31.5 min), not a flat 5 min',
      'autoPullLimit default (1) and the in-flight+queued<=K watermark',
      'ciChecksMaxPolls default (30)',
      'ciChecksPollIntervalMs default (20000ms)',
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

// ---- part 2: file:line citation ratchet -----------------------------------------------------
//
// Deliberately small in LEVERAGE, not in lines: measured 2026-09-02, this check would have
// caught ZERO of gate C7's pass-3 ~52 divergences (none of them were dangling citations) -- it is
// a ratchet against a citation surviving a future rename/move/deletion, not leverage on the class
// of bug this file exists for. The plan (doc/remediation-plan-2026-08.md's action 7bis.3 row,
// historical and excluded from this file's own sweep by name) budgeted this ratchet at "~10 lines
// and no more" -- that claim was never true even at the size measured for the adversarial review
// that flagged it (72 lines / 55 non-comment code lines, a 5.5x overrun), and this action's own
// fixes (the KNOWN_FICTIONAL pin, the corrected checked-count comment) have grown it further.
// Correcting the SIZE claim here, not the code: the plan's "10 lines" was wrong from the start,
// this ratchet has not grown into any leverage the plan denied it, and whether that size is worth
// trimming is a decision for whoever reviews this action, not this comment.
//
// Existence-only by construction, also registered in doc/accepted-gaps.md: a citation repointed
// to the WRONG line within a file that still has enough lines to satisfy the `end > lineCount`
// check below is not detected. Not fixed here -- an existence check cannot become a correctness
// check without actually parsing what each citation claims to be true of the line it names, which
// is a different, much larger mechanism than this ratchet.
const CITATION_DOCS = ['doc/state-machine-spec.md', 'orchestrator/README.md'];
const CITATION_RE = /([A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:js|md|sh|ts)):(\d+)(?:-(\d+))?/g;
// issue-418's plan once asserted this exact path was absent, and orchestrator/README.md quotes
// that assertion verbatim as a worked example ("That file does not exist") -- a real citation to
// a real absence, not a stale one. See orchestrator/README.md's "Why not scan plan_markdown".
const KNOWN_FICTIONAL = new Set(['.claude/hooks/context-router.sh:117']);

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

function findByBasename(name, dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findByBasename(name, full);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

// FINDING 4 (adversarial review, 2026-09-02): KNOWN_FICTIONAL had no ratchet -- adding a second
// entry to hide a genuinely dangling citation survived the whole suite, since the only thing
// read from it anywhere was `.has(full)`, never its full contents. Pinned to the exact single
// entry this file ships with, the same posture as ALLOWLIST in park-reason-doc-sweep.test.js:
// adding an entry here is a deliberate act (a citation to a real, deliberate absence, not a
// stale one -- see the comment above KNOWN_FICTIONAL) that needs its own justification and an
// update to this pin in the same change, not a silent exemption.
test('KNOWN_FICTIONAL holds exactly the one citation this file explicitly justified -- no more, no fewer', () => {
  assert.deepEqual(
    [...KNOWN_FICTIONAL].sort(),
    ['.claude/hooks/context-router.sh:117'],
    'KNOWN_FICTIONAL changed size or membership -- update this pin in the same change, with a ' +
      'named reason next to the new entry, the same way the existing one is justified above.'
  );
});

test('every file:line citation in doc/state-machine-spec.md and orchestrator/README.md resolves', () => {
  let checked = 0;
  const offenders = [];
  for (const docFile of CITATION_DOCS) {
    const stripped = stripFences(read(docFile));
    let m;
    while ((m = CITATION_RE.exec(stripped))) {
      const [full, filePath, startStr, endStr] = m;
      if (KNOWN_FICTIONAL.has(full)) continue;
      checked += 1;
      const target = filePath.includes('/') ? abs(filePath) : findByBasename(filePath, REPO_ROOT);
      if (!target || !fs.existsSync(target)) {
        offenders.push(`${docFile}: ${full} -- no such file`);
        continue;
      }
      const lineCount = fs.readFileSync(target, 'utf8').split('\n').length;
      const end = Number(endStr || startStr);
      if (end > lineCount) {
        offenders.push(`${docFile}: ${full} -- ${target} has only ${lineCount} lines`);
      }
    }
  }

  // FINDING 6 (adversarial review, 2026-09-02): this comment previously claimed 11 real
  // citations, measured wrong -- the actual count at the time was 10 (re-derived, not trusted
  // from the prior comment). This action's own citation fixes changed the true count again:
  // `intake.js:1174` (the [^rdo-wire] footnote) was re-pointed BY NAME, matching how
  // step-contracts.js:93 and steps/scripted.js:1214 already cite `intake.js`'s `makeTask` (no
  // line number at all -- see that footnote), which removes one line-number citation from this
  // regex's count entirely; the drifted `intake.js:744-746` citations (both docs) were corrected
  // to `747-749`, which does not change the count. Re-measured after both fixes: 9. A regex that
  // stopped matching (a reformat, a renamed backtick style) would pass vacuously -- fail loudly
  // instead, same posture as this suite's other siteCount/checked floors. Existence-only by
  // construction (registered in doc/accepted-gaps.md): this cannot detect a citation repointed to
  // a WRONG line within a file that still has enough lines to satisfy it.
  assert.ok(checked >= 8, `expected several file:line citations, found ${checked} -- has the citation style changed?`);
  assert.deepEqual(offenders, [], `dangling citation(s):\n  ${offenders.join('\n  ')}`);
});
