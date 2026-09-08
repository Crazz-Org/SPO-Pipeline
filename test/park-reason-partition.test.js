'use strict';
// park-reason-partition.test.js -- the guard for the documented rename trap: TRANSIENT_RETRY_
// REASONS (orchestrator/state-machine.js) keys retry eligibility on the EXACT reason STRING, so
// renaming or splitting a park reason -- action B3.4 round 1 did exactly this to
// `gate-non-attesting` -- silently makes the new name TERMINAL, and nothing failed. "Terminal"
// had never been anything other than "absent from the transient Set". This file makes the third
// bucket ("nobody decided") a test failure instead of silence, by scanning the SOURCE for every
// reason the code can actually produce and requiring each one to land in exactly one of:
//   - orchestrator/state-machine.js's TRANSIENT_RETRY_REASONS (auto-retried)
//   - orchestrator/state-machine.js's TERMINAL_PARK_REASONS, a TERMINAL_PARK_REASON_PREFIXES
//     rule, or -- for the `all-accounts-*` account-pool reasons -- a member of
//     ACCOUNT_POOL_PARK_REASON_FAMILY (all human-only, no automatic retry)
//
// ---- why this duplicates test/park-reason-doc-sweep.test.js's scanning code, rather than
// importing it -------------------------------------------------------------------------------
//
// test/park-reason-doc-sweep.test.js already contains a complete, working source sweep over
// every `new ParkSignal(...)` throw site and every `finalizePark(...)` sink call, including the
// three dynamic-reason resolvers (account-pool, ci-cause, timed-out-class) and the one
// direct-to-state.json write (park-loop.js's abandon-reply reconciler). This file is deliberately
// modelled on it line-for-line for that scanning core (blankComments, parkSignalSpans,
// finalizeParkSpans, classifyReasonArg, the three resolvers, jsFilesUnder/lineOf/readSource) --
// see that file's own header for the fuller rationale of each piece. It is NOT required from
// there and NOT refactored into a shared module: that file exports nothing (it is itself a test
// file, run for its own `test(...)` registrations), and this lot's file-ownership boundary for
// this change does not include editing it to add exports. Reusing the APPROACH while accepting
// the duplication is the documented trade-off; if the two ever drift, the fix is to extract a
// shared module in a later action, not to quietly diverge the regexes.
//
// What this file checks that the doc-sweep does NOT: the doc-sweep's completeness property is
// "every reason appears in doc/state-machine-spec.md, or is named on an allowlist" -- documentation
// coverage. This file's property is orthogonal: "every reason is classified as transient or
// terminal in code" -- retry-policy coverage. A reason can be perfectly documented in the spec's
// prose and still be silently unclassified here (that is precisely what happened to the four
// reasons B3.4 round 1 split out of `gate-non-attesting`, until B3.4 round 2 fixed it by hand).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials (see test/real-steps.test.js's own header for the incident this backstops) -- must
// land before the orchestrator requires directly below, same convention every real-mode test file
// in this suite follows.
require('./no-real-spawn');

const {
  TRANSIENT_RETRY_REASONS,
  TERMINAL_PARK_REASONS,
  TERMINAL_PARK_REASON_PREFIXES,
  ACCOUNT_POOL_PARK_REASON_FAMILY,
  isAccountPoolParkReason,
  classifyParkReason,
} = require('../orchestrator/state-machine');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['orchestrator'];
const SCAN_FILES = ['bin/spo'];

// ---- scanning core, mirrored from test/park-reason-doc-sweep.test.js (see this file's own
// header for why it is duplicated rather than imported) ---------------------------------------
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

function jsFilesUnder(dir) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function parkSignalSpans(source) {
  const spans = [];
  const re = /new\s+ParkSignal\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const openParen = source.indexOf('(', m.index);
    let depth = 0;
    let close = -1;
    for (let i = openParen; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    const inner = source.slice(openParen + 1, close);
    let depth2 = 0;
    let argEnd = -1;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '(' || c === '[' || c === '{') depth2++;
      else if (c === ')' || c === ']' || c === '}') depth2--;
      else if (c === ',' && depth2 === 0) {
        argEnd = i;
        break;
      }
    }
    const arg = (argEnd === -1 ? inner : inner.slice(0, argEnd)).trim();
    spans.push({ index: m.index, arg });
  }
  return spans;
}

function finalizeParkSpans(source) {
  const spans = [];
  const re = /finalizePark\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const precedingText = source.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*$/.test(precedingText)) continue; // the declaration itself, not a call site
    const openParen = source.indexOf('(', m.index);
    let depth = 0;
    let close = -1;
    for (let i = openParen; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    const inner = source.slice(openParen + 1, close);
    const args = [];
    let depth2 = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '(' || c === '[' || c === '{') depth2++;
      else if (c === ')' || c === ']' || c === '}') depth2--;
      else if (c === ',' && depth2 === 0) {
        args.push(inner.slice(start, i).trim());
        start = i + 1;
      }
    }
    args.push(inner.slice(start).trim());
    if (args.length < 3) continue; // not a 4-arg finalizePark(ctx, lastState, reason, detail) call
    spans.push({ index: m.index, arg: args[2] });
  }
  return spans;
}

function resolveAbandonedByMaintainerReason(source) {
  const m = /state:\s*'ABANDONED'[\s\S]{0,200}?reason:\s*'([^']+)'/.exec(source);
  if (!m) {
    return [{ kind: 'unresolved', value: 'park-loop.js: ABANDONED state.json write shape changed -- no adjacent literal reason found' }];
  }
  return [{ kind: 'literal', value: m[1] }];
}

function classifyReasonArg(argText) {
  let m;
  if ((m = /^'((?:[^'\\]|\\.)*)'$/.exec(argText)) || (m = /^"((?:[^"\\]|\\.)*)"$/.exec(argText))) {
    return { kind: 'literal', value: m[1] };
  }
  if (argText.startsWith('`') && argText.endsWith('`')) {
    const body = argText.slice(1, -1);
    const idx = body.indexOf('${');
    if (idx === -1) return { kind: 'literal', value: body };
    if (idx > 0) return { kind: 'prefix', value: body.slice(0, idx) };
    const lastClose = body.lastIndexOf('}');
    const suffix = lastClose === -1 ? body : body.slice(lastClose + 1);
    if (suffix === '-timed-out') return { kind: 'timed-out-class-template', value: suffix };
    return { kind: 'unresolvable-template', value: argText };
  }
  return { kind: 'dynamic', value: argText };
}

function resolveAccountPoolReasons(source) {
  const out = [];
  const noAccounts = /new\s+NoAccountsRegisteredError\(\s*'([^']+)'/.exec(source);
  const allLeased = /new\s+AllAccountsLeasedError\(\s*'([^']+)'/.exec(source);
  if (!noAccounts || !allLeased) {
    out.push({ kind: 'unresolved', value: 'accounts.js: NoAccountsRegisteredError/AllAccountsLeasedError construction shape changed' });
    return out;
  }
  out.push({ kind: 'literal', value: noAccounts[1] });
  out.push({ kind: 'literal', value: allLeased[1] });
  const ternary = /earliestCooldown === null\s*\n?\s*\?\s*'([^']+)'[^\n]*\n?\s*:\s*`([^$]*)\$\{/.exec(source);
  if (!ternary) {
    out.push({ kind: 'unresolved', value: 'accounts.js: AllAccountsCoolingError reason ternary shape changed' });
    return out;
  }
  out.push({ kind: 'literal', value: ternary[1] });
  out.push({ kind: 'prefix', value: ternary[2] });
  return out;
}

function resolveCiCauseParkReasons(source) {
  const out = [];
  const re = /kind:\s*'park'\s*,\s*reason:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(source))) out.push({ kind: 'literal', value: m[1] });
  if (out.length === 0) {
    out.push({ kind: 'unresolved', value: "ci-cause-table.js: no {kind: 'park', reason: '...'} outcome found -- shape changed" });
  }
  return out;
}

function resolveTimedOutClassReasons(configSource) {
  const out = [];
  const m = /COMMAND_TIMEOUTS_MS\s*=\s*\{([\s\S]*?)\n\};/.exec(configSource);
  if (!m) {
    out.push({ kind: 'unresolved', value: 'config.js: COMMAND_TIMEOUTS_MS object shape changed' });
    return out;
  }
  const keyRe = /(?:^|\n)\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/g;
  let km;
  const classes = [];
  while ((km = keyRe.exec(m[1]))) classes.push(km[1] || km[2]);
  if (classes.length === 0) {
    out.push({ kind: 'unresolved', value: 'config.js: COMMAND_TIMEOUTS_MS has no keys -- shape changed' });
    return out;
  }
  for (const cls of [...classes, 'command']) out.push({ kind: 'literal', value: `${cls}-timed-out` });
  return out;
}

function readSource(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// collectRequiredReasons() -- the same traversal park-reason-doc-sweep.test.js's own
// 'every ParkSignal reason is documented...' test performs, stripped of the spec/allowlist half
// (this file is not about documentation) and returning a Map<reason, {isPrefix, sites}> plus any
// call site this scan cannot resolve at all -- an unresolved site is a bug in THIS sweep, not a
// classification question, so it fails its own assertion rather than being silently dropped.
function collectRequiredReasons() {
  const files = [...SCAN_DIRS.flatMap(jsFilesUnder), ...SCAN_FILES];
  const required = new Map();
  const unresolvedDynamic = [];

  function record(reason, isPrefix, loc) {
    const existing = required.get(reason);
    if (existing) {
      existing.sites.push(loc);
      existing.isPrefix = existing.isPrefix || isPrefix;
    } else {
      required.set(reason, { isPrefix, sites: [loc] });
    }
  }

  const accountsSource = blankComments(readSource(path.join('orchestrator', 'accounts.js')));
  const ciCauseSource = blankComments(readSource(path.join('orchestrator', 'ci-cause-table.js')));
  const configSource = blankComments(readSource(path.join('orchestrator', 'config.js')));

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const source = blankComments(fs.readFileSync(abs, 'utf8'));

    for (const span of finalizeParkSpans(source)) {
      const loc = `${rel}:${lineOf(source, span.index)}`;
      const c = classifyReasonArg(span.arg);
      if (c.kind === 'literal' || c.kind === 'prefix') {
        record(c.value, c.kind === 'prefix', loc);
      } else if (c.kind === 'dynamic' && c.value === 'err.reason') {
        // Already required via the throw-side scan below (or its own resolvers).
      } else {
        unresolvedDynamic.push(`${loc}: finalizePark's reason argument \`${span.arg}\` is neither a literal nor the known err.reason pass-through`);
      }
    }

    if (!source.includes('ParkSignal')) continue;

    for (const span of parkSignalSpans(source)) {
      const loc = `${rel}:${lineOf(source, span.index)}`;
      const c = classifyReasonArg(span.arg);

      if (c.kind === 'literal' || c.kind === 'prefix') {
        record(c.value, c.kind === 'prefix', loc);
      } else if (c.kind === 'timed-out-class-template') {
        for (const r of resolveTimedOutClassReasons(configSource)) {
          if (r.kind === 'unresolved') unresolvedDynamic.push(`${loc}: ${r.value}`);
          else record(r.value, false, loc);
        }
      } else if (c.kind === 'dynamic' && c.value === 'err.reason') {
        for (const r of resolveAccountPoolReasons(accountsSource)) {
          if (r.kind === 'unresolved') unresolvedDynamic.push(`${loc}: ${r.value}`);
          else record(r.value, r.kind === 'prefix', loc);
        }
      } else if (c.kind === 'dynamic' && c.value === 'outcome.reason') {
        for (const r of resolveCiCauseParkReasons(ciCauseSource)) {
          if (r.kind === 'unresolved') unresolvedDynamic.push(`${loc}: ${r.value}`);
          else record(r.value, false, loc);
        }
      } else {
        unresolvedDynamic.push(`${loc}: reason argument \`${span.arg}\` is neither a literal, a recognized template, nor a known dynamic pass-through (err.reason / outcome.reason)`);
      }
    }
  }

  const parkLoopSource = blankComments(readSource(path.join('orchestrator', 'park-loop.js')));
  for (const r of resolveAbandonedByMaintainerReason(parkLoopSource)) {
    if (r.kind === 'unresolved') unresolvedDynamic.push(`orchestrator/park-loop.js: ${r.value}`);
    else record(r.value, false, 'orchestrator/park-loop.js (direct state.json write, not thrown)');
  }

  return { required, unresolvedDynamic };
}

// ---- tests --------------------------------------------------------------------------------

test('collectRequiredReasons resolves every call site -- an unresolved dynamic site is a bug in this sweep, not a classification question', () => {
  const { required, unresolvedDynamic } = collectRequiredReasons();
  assert.deepEqual(
    unresolvedDynamic,
    [],
    `park reason call site(s) this sweep cannot resolve automatically -- extend the sweep (mirroring test/park-reason-doc-sweep.test.js's own resolvers), do not ignore:\n  ${unresolvedDynamic.join('\n  ')}`
  );
  // Same floor rationale as park-reason-doc-sweep.test.js's own siteCount/required.size floors: if
  // this drops well below what was actually measured (2026-09-06: 90 distinct reasons -- 88
  // literal + 2 prefix families), the sweep has stopped finding real surface, and every assertion
  // below would pass vacuously.
  assert.ok(required.size >= 80, `expected at least 80 distinct reasons requiring classification, found ${required.size} -- has a resolver stopped matching?`);
});

test('COVERAGE: every park reason the code can produce is classified transient or terminal -- an unclassified reason is exactly the rename trap this file exists to catch', () => {
  const { required } = collectRequiredReasons();
  const offenders = [];
  for (const [reason, info] of required) {
    if (classifyParkReason(reason) === 'unclassified') {
      offenders.push(
        `'${reason}'${info.isPrefix ? ' (prefix family)' : ''} -- produced at ${info.sites.slice(0, 3).join(', ')}` +
          `${info.sites.length > 3 ? `, +${info.sites.length - 3} more` : ''}: ` +
          'decide explicitly whether it retries: add it to TRANSIENT_RETRY_REASONS, TERMINAL_PARK_REASONS, ' +
          'TERMINAL_PARK_REASON_PREFIXES, or -- for an `all-accounts-*` reason -- ACCOUNT_POOL_PARK_REASON_FAMILY'
      );
    }
  }
  assert.deepEqual(offenders, [], `unclassified park reason(s):\n  ${offenders.join('\n  ')}`);
});

test('DISJOINTNESS: TRANSIENT_RETRY_REASONS and TERMINAL_PARK_REASONS share no member', () => {
  const overlap = [...TRANSIENT_RETRY_REASONS].filter((r) => TERMINAL_PARK_REASONS.has(r));
  assert.deepEqual(
    overlap,
    [],
    `reason(s) claimed by BOTH TRANSIENT_RETRY_REASONS and TERMINAL_PARK_REASONS -- a reason must ` +
      `retry XOR be terminal, never both:\n  ${overlap.join('\n  ')}`
  );
});

test('NO DEAD ENTRIES: every literal in TERMINAL_PARK_REASONS is actually producible by the code', () => {
  const { required } = collectRequiredReasons();
  // A tiny, named allowlist for a terminal reason that is legitimately unscannable by
  // collectRequiredReasons (e.g. reachable only through a resolver this sweep does not model).
  // Empty today: every entry in TERMINAL_PARK_REASONS was read directly off a real call site (see
  // orchestrator/state-machine.js's own TERMINAL_PARK_REASONS header for the derivation), so
  // nothing needs an exemption. Keep it this way unless a specific entry needs one, with a
  // comment saying why, right here.
  const UNSCANNABLE_BUT_REAL = new Set([]);

  const dead = [];
  for (const reason of TERMINAL_PARK_REASONS) {
    if (UNSCANNABLE_BUT_REAL.has(reason)) continue;
    const producedAsLiteral = required.has(reason) && !required.get(reason).isPrefix;
    if (!producedAsLiteral) {
      dead.push(`'${reason}' -- not produced as a literal reason by any scanned call site`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `dead entry/entries in TERMINAL_PARK_REASONS (present in the list but no longer, or never, ` +
      `producible by the code -- remove them, or add a named, reasoned UNSCANNABLE_BUT_REAL entry ` +
      `above if the reason is real but structurally unscannable):\n  ${dead.join('\n  ')}`
  );

  // Symmetric check for the two prefix families: each declared TERMINAL_PARK_REASON_PREFIXES
  // entry must correspond to at least one prefix family the scan actually found, or the prefix
  // rule itself has gone dead (the code stopped producing that shape).
  const requiredPrefixValues = [...required.entries()].filter(([, info]) => info.isPrefix).map(([reason]) => reason);
  const deadPrefixes = TERMINAL_PARK_REASON_PREFIXES.filter(
    ({ prefix }) => !requiredPrefixValues.includes(prefix)
  );
  assert.deepEqual(
    deadPrefixes.map((p) => p.prefix),
    [],
    `dead entry/entries in TERMINAL_PARK_REASON_PREFIXES (no scanned call site produces this prefix ` +
      `family any more): ${deadPrefixes.map((p) => p.prefix).join(', ')}`
  );
});

// ---- ACCOUNT_POOL_PARK_REASON_FAMILY (card #119 action 1.1) -------------------------------------
//
// orchestrator/state-machine.js used to scatter the account pool's four terminal reasons across
// three places (three literals on TERMINAL_PARK_REASONS, one prefix on
// TERMINAL_PARK_REASON_PREFIXES). Action 1.1 collapsed them into ACCOUNT_POOL_PARK_REASON_FAMILY,
// a single declared list, and isAccountPoolParkReason(reason), the predicate classifyParkReason
// now consults as its own step. These tests pin the two directions of the rename-safety property
// that collapse is supposed to buy: every `all-accounts-*` reason the source can actually produce
// is matched by the family (nothing slipped through the refactor uncovered), and every declared
// family member corresponds to something the source still produces (no dead member left behind).
// `no-accounts-registered` is deliberately excluded throughout -- it is not `all-accounts-*` and
// is not a member of this family (see ACCOUNT_POOL_PARK_REASON_FAMILY's own header).

test('ACCOUNT POOL FAMILY -- COMPLETENESS: every all-accounts-* reason the code can produce is matched by isAccountPoolParkReason', () => {
  const { required } = collectRequiredReasons();
  const scannedAccountPoolReasons = [...required.keys()].filter((r) => r.startsWith('all-accounts-'));

  assert.ok(
    scannedAccountPoolReasons.length >= 4,
    `expected at least 4 distinct all-accounts-* reasons/prefixes in the source scan, found ${scannedAccountPoolReasons.length} -- has a resolver stopped matching accounts.js/state-machine.js?`
  );

  // collectRequiredReasons() alone is NOT complete for this family, and the gap was measured
  // rather than guessed: it keys off `new ParkSignal(...)` call sites, and orchestrator/
  // account-lease.js contains none -- yet it is a SECOND producer of `all-accounts-leased`, via
  // `new accountsModule.AllAccountsLeasedError('all-accounts-leased', detail)`. That call is also
  // invisible to park-reason-doc-sweep's resolveAccountPoolReasons, whose regex requires an
  // UNQUALIFIED `new AllAccountsLeasedError(`. Renaming that one call site left this whole file
  // green (14/14) during this action's verification. So scan account-lease.js directly, allowing
  // an optional `<ident>.` qualifier on the constructor.
  //
  // Comments are skipped line-wise (the same `trimStart().startsWith('//')` idiom the deck's own
  // sweep uses) because this file discusses the family in prose -- it writes the bare shorthand
  // `all-accounts-cooling`, which is NOT a reason any code produces. A scan fooled by that would
  // demand a family member that does not exist.
  const leaseSrc = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'account-lease.js'), 'utf8');
  const leaseProduced = new Set();
  for (const line of leaseSrc.split('\n')) {
    if (line.trimStart().startsWith('//')) continue;
    for (const m of line.matchAll(/new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?[A-Za-z_$][\w$]*Error\(\s*'(all-accounts-[a-z0-9-]*)'/g)) {
      leaseProduced.add(m[1]);
    }
  }
  assert.ok(
    leaseProduced.size >= 1,
    'expected account-lease.js to still produce at least one all-accounts-* reason -- if it no longer does, ' +
      'this scan has gone dead and should be removed on purpose rather than left passing vacuously'
  );

  const unmatched = [...scannedAccountPoolReasons, ...leaseProduced].filter((r) => !isAccountPoolParkReason(r));
  assert.deepEqual(
    unmatched,
    [],
    `all-accounts-* reason(s) produced by the code but NOT matched by isAccountPoolParkReason -- ` +
      `update ACCOUNT_POOL_PARK_REASON_FAMILY in orchestrator/state-machine.js:\n  ${unmatched.join('\n  ')}`
  );
});

test('ACCOUNT POOL FAMILY -- NO DEAD MEMBERS: every declared family member is still producible by the code', () => {
  const { required } = collectRequiredReasons();
  const scannedAccountPoolReasons = [...required.keys()].filter((r) => r.startsWith('all-accounts-'));

  // For a literal member, the scan records the member's own string. For the prefix member, the
  // scan records the bare prefix itself (resolveAccountPoolReasons resolves the ternary's dynamic
  // branch to `{kind: 'prefix', value: 'all-accounts-cooling-until-'}`, not a timestamped
  // instance) -- so `match` is what to look for either way.
  const dead = ACCOUNT_POOL_PARK_REASON_FAMILY.filter((member) => !scannedAccountPoolReasons.includes(member.match));
  assert.deepEqual(
    dead.map((m) => m.match),
    [],
    `dead entry/entries in ACCOUNT_POOL_PARK_REASON_FAMILY (declared but no longer, or never, ` +
      `producible by the code -- remove them from orchestrator/state-machine.js): ${dead.map((m) => m.match).join(', ')}`
  );
});

test('ACCOUNT POOL FAMILY -- rename-safety, positive: all four members classify terminal via the family, none is transient', () => {
  const representative = {
    'all-accounts-leased': 'all-accounts-leased',
    'all-accounts-cooling-unknown': 'all-accounts-cooling-unknown',
    'all-accounts-cooling-until-': 'all-accounts-cooling-until-2026-09-04T20:33:05.932Z',
    'all-accounts-cooling-after-retry': 'all-accounts-cooling-after-retry',
  };
  for (const member of ACCOUNT_POOL_PARK_REASON_FAMILY) {
    const sample = representative[member.match];
    assert.ok(sample, `no representative sample wired up for family member '${member.match}' -- add one to this test`);
    assert.equal(isAccountPoolParkReason(sample), true, `isAccountPoolParkReason('${sample}') should be true`);
    assert.equal(classifyParkReason(sample), 'terminal', `classifyParkReason('${sample}') should be 'terminal'`);
    assert.equal(TRANSIENT_RETRY_REASONS.has(sample), false, `'${sample}' must not be on TRANSIENT_RETRY_REASONS`);
  }
});

test('ACCOUNT POOL FAMILY -- absorption guard, negative: a brand-new all-accounts-* reason is NOT absorbed', () => {
  assert.equal(isAccountPoolParkReason('all-accounts-brand-new-thing'), false);
  assert.equal(classifyParkReason('all-accounts-brand-new-thing'), 'unclassified');
});

// The `kind` field is the whole point of the family list: a `literal` member matches by EXACT
// equality, only the `prefix` member matches by startsWith. Nothing above pins that -- the guard
// immediately above uses 'all-accounts-brand-new-thing', which shares no member's prefix, so it
// stays green even if every member were matched with startsWith. That mutation was introduced
// deliberately during this action's verification and SURVIVED the whole suite (2326/0), silently
// absorbing 'all-accounts-leased-extra' & co. as `terminal` -- exactly the failure mode
// isAccountPoolParkReason's own header forbids. These are the assertions that kill it: for every
// literal member, the member's own string PLUS a suffix must NOT match.
test('ACCOUNT POOL FAMILY -- a literal member matches by exact equality, never by prefix: a suffixed variant is not absorbed', () => {
  const literals = ACCOUNT_POOL_PARK_REASON_FAMILY.filter((m) => m.kind === 'literal');
  assert.ok(literals.length >= 3, `expected the family's literal members, found ${literals.length}`);
  for (const member of literals) {
    const suffixed = `${member.match}-extra`;
    assert.equal(
      isAccountPoolParkReason(suffixed),
      false,
      `'${suffixed}' must NOT match: '${member.match}' is a \`literal\` member and literals match by exact ` +
        `equality. If this fails, isAccountPoolParkReason has started matching literals with startsWith, ` +
        `which silently absorbs any longer reason built on a member's name as terminal.`
    );
    assert.equal(classifyParkReason(suffixed), 'unclassified', `classifyParkReason('${suffixed}') should be 'unclassified'`);
  }
});

test("ACCOUNT POOL FAMILY -- no-accounts-registered is excluded: it is not all-accounts-*, and stays a plain TERMINAL_PARK_REASONS literal", () => {
  assert.equal(isAccountPoolParkReason('no-accounts-registered'), false);
  assert.equal(TERMINAL_PARK_REASONS.has('no-accounts-registered'), true);
  assert.equal(classifyParkReason('no-accounts-registered'), 'terminal');
});

// ---- the rename trap, directly --------------------------------------------------------------
//
// Pins the exact failure mode this file exists to catch: a reason produced by code but present in
// NEITHER TRANSIENT_RETRY_REASONS nor TERMINAL_PARK_REASONS classifies as 'unclassified', not as
// a silent default to either bucket. This is what action B3.4 round 1 got wrong for
// `gate-environment`/`gate-interrupted`/`gate-abandoned`/`gate-stale`: each was a BRAND NEW
// literal (split out of `gate-non-attesting`) that landed in neither set, and nothing failed --
// they were simply, silently, terminal by omission. classifyParkReason makes that state
// observable instead of indistinguishable from "deliberately terminal".
test('the rename trap, pinned: a reason absent from both tables classifies as unclassified, not as a silent default', () => {
  const brandNewReasonNobodyDecided = 'totally-new-reason-nobody-decided-yet';
  assert.equal(TRANSIENT_RETRY_REASONS.has(brandNewReasonNobodyDecided), false);
  assert.equal(TERMINAL_PARK_REASONS.has(brandNewReasonNobodyDecided), false);
  assert.equal(
    classifyParkReason(brandNewReasonNobodyDecided),
    'unclassified',
    'THE RENAME TRAP: a reason string that is new to the code -- because it was just introduced, ' +
      'or because an existing reason was renamed/split -- and appears in neither ' +
      'TRANSIENT_RETRY_REASONS nor TERMINAL_PARK_REASONS must classify as "unclassified", exactly ' +
      "the state the COVERAGE test above fails the build on. If this assertion ever reports " +
      "anything other than 'unclassified', classifyParkReason has started guessing instead of " +
      'demanding an explicit decision, which is the whole bug this file exists to prevent.'
  );
});

test('classifyParkReason: a reason on TRANSIENT_RETRY_REASONS classifies as transient, never terminal or unclassified', () => {
  for (const reason of TRANSIENT_RETRY_REASONS) {
    assert.equal(classifyParkReason(reason), 'transient', `'${reason}' is on TRANSIENT_RETRY_REASONS but did not classify as transient`);
  }
});

test('classifyParkReason: a reason on TERMINAL_PARK_REASONS classifies as terminal, never transient or unclassified', () => {
  for (const reason of TERMINAL_PARK_REASONS) {
    assert.equal(classifyParkReason(reason), 'terminal', `'${reason}' is on TERMINAL_PARK_REASONS but did not classify as terminal`);
  }
});

test('classifyParkReason: the two dynamic terminal prefix families (one on ACCOUNT_POOL_PARK_REASON_FAMILY, one on TERMINAL_PARK_REASON_PREFIXES) classify as terminal for a representative instance, not just the bare prefix', () => {
  assert.equal(classifyParkReason('all-accounts-cooling-until-2026-09-05T19:32:33.350Z'), 'terminal'); // ACCOUNT_POOL_PARK_REASON_FAMILY, since action 1.1 (card #119)
  assert.equal(classifyParkReason('prompt-missing-placeholder:files_to_change'), 'terminal'); // still TERMINAL_PARK_REASON_PREFIXES
  // A string that merely CONTAINS a prefix without starting with it must not match (substring vs.
  // startsWith -- both ACCOUNT_POOL_PARK_REASON_FAMILY's and TERMINAL_PARK_REASON_PREFIXES's own
  // headers state this is a startsWith test).
  assert.equal(classifyParkReason('should-not-match-all-accounts-cooling-until-2026'), 'unclassified');
});

// SPO-Pipeline#85's five merge-cause reasons (orchestrator/merge-cause.js's MERGE_CAUSE_REASONS,
// thrown as literals by steps/scripted.js's parkFromMergeCause) -- a driver decision, already
// made: all five are terminal, none is added to TRANSIENT_RETRY_REASONS. Pinned individually so a
// future edit re-litigating that decision for one of the five fails here by name.
test("SPO-Pipeline#85's five merge-cause reasons are all terminal, none transient", () => {
  const mergeCauseReasons = ['merge-conflict', 'merge-blocked', 'merge-behind-base', 'merge-pr-draft', 'merge-checks-failing'];
  for (const reason of mergeCauseReasons) {
    assert.equal(TRANSIENT_RETRY_REASONS.has(reason), false, `'${reason}' must not be on TRANSIENT_RETRY_REASONS -- this was a deliberate driver decision, not an oversight`);
    assert.equal(TERMINAL_PARK_REASONS.has(reason), true, `'${reason}' must be on TERMINAL_PARK_REASONS`);
    assert.equal(classifyParkReason(reason), 'terminal');
  }
});
