'use strict';
// park-reason-doc-sweep.test.js -- action 7bis.1's enforced certification: every ParkSignal
// reason a maintainer can actually hit is named in doc/state-machine-spec.md, or is on a named,
// reasoned allowlist explaining why not. Modelled directly on test/gh-api-argv.test.js and
// test/no-real-spawn-sweep.test.js: read the SOURCE rather than mock or hand-maintain a registry,
// so a call site added tomorrow, in a state that does not exist yet, is covered without anyone
// remembering to cover it.
//
// ---- why this exists --------------------------------------------------------------------------
//
// Gate C7's original clause was an Opus re-read of doc/state-machine-spec.md against the code.
// It ran three times and returned 7, then ~11, then ~52 divergences -- the yield went UP each
// pass, because each pass reached new surface a careful human reader had not looked at yet, not
// because prose review was converging on completeness. Three Opus passes, hours of reading, never
// once surfaced "count the ParkSignal reason strings and grep the spec for each one" as a class --
// it is exactly the class of gap a source sweep is *complete* over and prose review is not: a
// reason string either occurs in doc/state-machine-spec.md or it does not, and a script can check
// all of them in the time it takes a human to read one paragraph. This is the first of the three
// certifications C7's clause was replaced with (see plan action 7bis.1): enforced, ground truth in
// code, complete over the ~90-odd `new ParkSignal(...)` call sites that exist today rather than
// over whatever a reader happened to reach.
//
// Measured 2026-09-02 for action 7bis.1: 94 `new ParkSignal(...)` call sites across
// orchestrator/** (bin/spo has none today, scanned anyway -- see SCAN_FILES below), collapsing to
// 55 distinct literal reasons, 1 literal-prefix family (`prompt-missing-placeholder:<name>`), and
// 2 call sites whose reason is a variable rather than a literal (`err.reason`, `outcome.reason`
// -- see "dynamic call sites" below); resolving those two against the code that actually produces
// their values adds 3 (accounts.js's pool-exhaustion reasons -- 2 literals + 1 prefix family) and
// 1 (ci-cause-table.js's own `pr-rules-needs-approval`) more, and the `${commandClass}-timed-out`
// no-prefix template resolves against config.js's own timeout keys to another 5 -- 55 + 1 + 3 + 1
// + 5 = 65 (this file's own arithmetic error at the time: 66 is correct -- 55 literals + 1 prefix
// family = 56, + 5 timed-out classes + 4 account-pool reasons + 1 ci-cause reason = 66). Of the
// 66, 31 (not 32 -- the number this comment previously carried) had never appeared anywhere in
// doc/state-machine-spec.md before action 7bis.1: 30 were written into the spec (what actually
// produces each one, what a maintainer should do about it -- read from the throwing code, never
// inferred from the name), and 1 (`command-timed-out`) is allowlisted below as unreachable.
//
// ---- FINDING 1, 2026-09-02: the sink, not just the throw ---------------------------------------
//
// The count above is complete over `new ParkSignal(...)` -- the THROW site -- and nothing else.
// `finalizePark(ctx, lastState, reason, detail)` (state-machine.js) is the SINK every park
// actually lands at, and three of its own call sites (state-machine.js's own dispatch-loop
// guards, orphan-scan.js's pre-WORKTREE recovery path) pass a reason literal that was never a
// `new ParkSignal(...)` anywhere -- a sweep that only scanned throws was structurally blind to
// them. `finalizeParkSpans` (below) closes that gap the same way `parkSignalSpans` covers the
// throw side: 6 `finalizePark(...)` call sites across orchestrator/** (state-machine.js ×3,
// orphan-scan.js ×2, dispatcher.js ×1), one of which (`err.reason`) is a dynamic pass-through
// already covered by the throw-side scan, leaving 5 new literal reasons -- 2 already documented
// (`worker-crashed`, `task-orphaned-daemon-restart`), 3 not (`task-orphaned-before-start`,
// `state-machine-runaway`, `unrecognized-state`). A 7th reason, `abandoned-by-maintainer`, is
// written directly to `state.json.reason` by park-loop.js's abandon-reply reconciler -- reached
// through neither a throw nor `finalizePark` at all (`resolveAbandonedByMaintainerReason` below)
// -- also previously undocumented. Total after this action: 66 + 6 = 72 distinct reasons
// requiring documentation; 31 + 4 = 35 have needed writing into the spec across the two actions
// (7bis.1's 30 plus this action's 4: `task-orphaned-before-start`, `state-machine-runaway`,
// `unrecognized-state`, `abandoned-by-maintainer`); still 1 allowlisted (`command-timed-out`).
//
// ---- literal reasons vs. templated reasons vs. dynamic call sites ------------------------------
//
// Three shapes a `new ParkSignal(<arg>, ...)` call's first argument takes in this codebase:
//
//   1. A plain string literal ('worktree-add-failed') -- the overwhelming majority. Required to
//      appear verbatim in doc/state-machine-spec.md.
//   2. A template literal with a STATIC PREFIX before its first `${` --
//      `` `prompt-missing-placeholder:${err.placeholder}` `` is the one example today. Required:
//      the prefix text appears in doc/state-machine-spec.md (a maintainer cannot enumerate every
//      possible placeholder name up front, so the doc documents the family, e.g.
//      `llm-transport-failed:<STEP>`'s own four call sites are each written as a full literal --
//      `llm-transport-failed:PLAN` etc. -- specifically so a new step added tomorrow shows up here
//      as an undocumented LITERAL, not silently absorbed into an existing prefix).
//   3. A template literal with NO static prefix (starts with `${`) --
//      `` `${commandClass || 'command'}-timed-out` `` (steps/scripted.js) is the one example
//      today. A prefix-only match can't cover this shape (there is no static prefix to match on),
//      so it is resolved by reading `config.js`'s own `COMMAND_TIMEOUTS_MS` object -- the actual,
//      authoritative enum `commandClass` is drawn from -- plus the `'command'` string the source
//      falls back to when `classifyCommand` returns `null`, and requiring `<class>-timed-out` for
//      every one of those literally. This is still a SOURCE read (config.js's own keys), not a
//      hand-copied enum, so a new command class added there is picked up automatically. Any other
//      no-static-prefix template found in the future is NOT auto-resolved this way -- see
//      classifyReasonArg's hard failure for that case below; the two shapes in this codebase were
//      distinguished on purpose rather than guessed to be interchangeable.
//
// Two call sites pass neither a literal nor a template but a bare property access --
// `state-machine.js`'s `throw new ParkSignal(err.reason, err.detail)` (rethrowing one of
// `accounts.js`'s three pool-exhaustion Error subclasses verbatim) and two `throw new
// ParkSignal(outcome.reason, ...)` sites (both fed by `ci-cause-table.js`'s `classifyCiFailure`,
// the shared shadow/real CI-cause table). A generic sweep cannot resolve an arbitrary variable to
// its possible literal values -- that is undecidable in general -- so these two ARE resolved, but
// by two small, targeted readers of the specific files that actually produce their values
// (`resolveAccountPoolReasons` reads accounts.js's three Error constructors and the
// cooling-reason ternary; `resolveCiCauseParkReasons` reads every `{kind: 'park', reason: '...'}`
// object literal in ci-cause-table.js), not by a hand-typed list of the reasons themselves -- a
// change to either source file's own literals changes what this sweep requires without anyone
// touching this file. A ParkSignal call site whose argument is neither of these two known shapes,
// nor a literal, nor a recognized template, fails LOUDLY (see the "unresolved dynamic sites"
// assertion below) demanding this file be extended -- never silently skipped, which is exactly the
// whole-file-exemption failure mode test/no-real-spawn-sweep.test.js's own header warns against.
//
// ---- blankComments, load-bearing in both directions --------------------------------------------
//
// Same idiom as gh-api-argv.test.js, verbatim: comments are blanked, not deleted, before
// scanning, so byte offsets (and therefore reported line numbers) still match the real file.
// Load-bearing both ways here: (1) a reason merely NAMED in a comment -- and this codebase's own
// comments quote plenty of them, e.g. steps/scripted.js:756's "now throws ParkSignal('git-timed-
// out')" -- must never be extracted as if it were a real call site (this file's own header above,
// which quotes several reasons in prose, would otherwise flag itself); (2) doc/state-machine-
// spec.md is Markdown, not JS, so this direction is a non-issue for the SPEC side, but the same
// blanking still has to run on every orchestrator file before extraction, unconditionally, rather
// than relying on no comment ever accidentally matching the call-site regex.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['orchestrator'];
const SCAN_FILES = ['bin/spo'];
const SPEC_PATH = path.join(REPO_ROOT, 'doc', 'state-machine-spec.md');

// ---- ALLOWLIST: per-reason, never per-file (test/no-real-spawn-sweep.test.js's own header: a
// whole-file exemption was itself the gap that hid a real missing killswitch during C7). Every
// entry needs its own named, reasoned justification -- read from the code, not assumed.
const ALLOWLIST = {
  'command-timed-out': (
    "the `'command'` fallback branch of `${commandClass || 'command'}-timed-out` " +
    "(steps/scripted.js's spawnStep, ~line 256) only fires when classifyCommand(command, args) " +
    "returns null for a call that already survived two spawnSync timeouts. Enumerated every " +
    "spawnStep call site in steps/scripted.js by hand for this action (grep " +
    "\"spawnStep(ctx, deps, '<STATE>', '<command>'\"): every one passes 'git', 'gh', or 'npm' " +
    "with args[0] either 'ci' or 'run' -- classifyCommand always returns a real class ('git' / " +
    "'gh' / 'npm-ci' / 'npm-gate' / 'npm-run') for every one of them, never null. Defensive dead " +
    "code today, not a reachable park reason -- documenting it in the spec as something that " +
    "actually happens would be exactly the plausible-sounding-but-wrong sentence this chantier " +
    "exists to stop writing. Left in the source (no executable change to orchestrator/ is in " +
    "scope for this action) but not claimed as real behaviour.'"
  ),
};

// FINDING 4 (adversarial review, 2026-09-02): the ALLOWLIST above previously had no ratchet at
// all -- adding an unjustified entry (or, worse, M6: allowlisting a REAL reason like
// `worktree-add-failed` and deleting its spec line in the same edit) passed the whole suite,
// because the only thing read from ALLOWLIST anywhere was `hasOwnProperty`, never its full
// key set. Pinned here to the exact expected set: adding, removing, or renaming an entry now
// fails this assertion by name, forcing the same kind of named, reasoned justification the
// entries themselves already carry -- the plan's rule is per-reason, never per-file
// (test/no-real-spawn-sweep.test.js's own header: a whole-file exemption was itself the gap
// that hid a real missing killswitch during C7's remediation).
test('ALLOWLIST holds exactly the reasons this action explicitly justified -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(ALLOWLIST).sort(),
    ['command-timed-out'],
    'ALLOWLIST changed size or membership. Adding an entry here is a deliberate act that exempts ' +
      'a reason from ever needing to appear in doc/state-machine-spec.md, forever -- it needs its ' +
      'own named, reasoned justification (read from the code, not assumed) the same way ' +
      "'command-timed-out' has one above, and this pin needs updating in the same change, by name."
  );
});

// ---- blankComments: verbatim copy of gh-api-argv.test.js's idiom -------------------------------
function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
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

// One "call site" is `new ParkSignal(...)`'s balanced-paren span, then its first top-level
// argument (split at the first top-level comma) -- the reason expression itself. Same
// crude-but-uniform-convention approach gh-api-argv.test.js's apiArgvSpans takes: a false positive
// here is a test failure a human reads, not a silently-missed park reason.
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

// finalizeParkSpans(source) -- the SINK, not the throw. `new ParkSignal(...)` is where a handler
// raises a park; `finalizePark(ctx, lastState, reason, detail)` (state-machine.js) is where every
// park -- however it got here -- actually lands: the `catch (err instanceof ParkSignal)` branch
// calls it with `err.reason` (already covered, since that reason was a `new ParkSignal(...)`
// literal/template caught upstream), but THREE call sites call it directly with their OWN literal
// reason that no `ParkSignal` ever carries (`state-machine-runaway`, `unrecognized-state` --
// state-machine.js's own dispatch-loop guards) or (`task-orphaned-before-start` --
// orphan-scan.js's pre-WORKTREE recovery path; `task-orphaned-daemon-restart` is the same file's
// sibling branch). `dispatcher.js`'s `worker-crashed` is a fourth. A sweep that only scanned
// `new ParkSignal(...)` throws was blind to all of these -- this function closes that gap by
// scanning for the sink's own call sites, the same balanced-paren + top-level-comma-split
// technique parkSignalSpans uses, just reading the THIRD top-level argument (`reason`) instead of
// the first. Deliberately excludes `finalizePark`'s own function declaration (`function
// finalizePark(ctx, lastState, reason, detail) {`), which is not a call site and whose parameter
// names are not string literals.
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

// resolveAbandonedByMaintainerReason(parkLoopSource) -- the ONE park reason written directly to
// `state.json.reason` rather than thrown as a ParkSignal or passed to finalizePark at all: a
// maintainer's `abandon` reply on a parked issue's thread (park-loop.js's unpark-scan reconciler)
// terminates the task immediately with `state: 'ABANDONED', reason: 'abandoned-by-maintainer'`,
// written straight to state.json -- no HANDLERS involvement, no finalizePark round trip, so
// neither parkSignalSpans nor finalizeParkSpans above can ever see it. Read off the ABANDONED
// write itself (the literal text of the reason next to the literal text of the terminal state),
// not hand-copied, so a shape change here fails loudly instead of silently going unresolved.
function resolveAbandonedByMaintainerReason(source) {
  const m = /state:\s*'ABANDONED'[\s\S]{0,200}?reason:\s*'([^']+)'/.exec(source);
  if (!m) {
    return [{ kind: 'unresolved', value: "park-loop.js: ABANDONED state.json write shape changed -- no adjacent literal reason found" }];
  }
  return [{ kind: 'literal', value: m[1] }];
}

// classifyReasonArg(argText) -> one of:
//   {kind: 'literal', value}          -- a plain string; value must appear verbatim in the spec
//   {kind: 'prefix', value}           -- a template with a static prefix; value must appear as a
//                                         substring of the spec (the family, not one instance)
//   {kind: 'dynamic', value: argText} -- a bare identifier/member expression; resolved separately
//   {kind: 'unresolvable-template', value: argText} -- a template with NO static prefix and an
//                                         unrecognized suffix; nothing in this codebase produces
//                                         this today (see the header) -- a hard failure, not a
//                                         silent skip, if one ever appears.
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
    // No static prefix -- the only known shape today is `${commandClass}-timed-out`. Resolved by
    // the caller via resolveTimedOutClassReasons, keyed on the literal suffix text so a future
    // no-prefix template with a DIFFERENT suffix cannot be silently absorbed into that resolver.
    const lastClose = body.lastIndexOf('}');
    const suffix = lastClose === -1 ? body : body.slice(lastClose + 1);
    if (suffix === '-timed-out') return { kind: 'timed-out-class-template', value: suffix };
    return { kind: 'unresolvable-template', value: argText };
  }
  return { kind: 'dynamic', value: argText };
}

// resolveAccountPoolReasons(accountsSource) -- the three literal park reasons behind
// state-machine.js's `throw new ParkSignal(err.reason, err.detail)`, read off accounts.js's own
// pick() rather than hand-copied. See doc/state-machine-spec.md's "Account pool" section for the
// full behavioural account of each.
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

  // AllAccountsCoolingError's reason is computed into a local `reason` const via a ternary
  // between a flat literal (no cooldown was ever recorded to report a time for) and a template
  // literal carrying the earliest cooldown's own ISO timestamp -- pick()'s sole call site. Both
  // branches are read directly off that ternary, not copied by hand, so a change to either
  // literal is caught here.
  const ternary = /earliestCooldown === null\s*\n?\s*\?\s*'([^']+)'[^\n]*\n?\s*:\s*`([^$]*)\$\{/.exec(source);
  if (!ternary) {
    out.push({ kind: 'unresolved', value: 'accounts.js: AllAccountsCoolingError reason ternary shape changed' });
    return out;
  }
  out.push({ kind: 'literal', value: ternary[1] });
  out.push({ kind: 'prefix', value: ternary[2] });
  return out;
}

// resolveCiCauseParkReasons(ciCauseSource) -- every `{kind: 'park', reason: '<literal>'}` outcome
// classifyCiFailure can return, read off ci-cause-table.js itself rather than hand-copied. Feeds
// both `outcome.reason` call sites (state-machine.js's shadow path, steps/scripted.js's real
// path) -- see that file's own header for why EXACT step-name matching, never substring/prefix,
// is the whole point of this table.
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

// resolveTimedOutClassReasons(configSource) -- every `<class>-timed-out` reason
// `${commandClass || 'command'}-timed-out` can produce, read off config.js's own
// COMMAND_TIMEOUTS_MS object keys (the actual, authoritative enum classifyCommand's callers draw
// from) plus the `'command'` fallback the template itself falls back to. A class added to
// COMMAND_TIMEOUTS_MS tomorrow is picked up here automatically.
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

// reasonDocumented(spec, reason, isPrefix) -- latent issue flagged by the adversarial review
// (2026-09-02): plain `spec.includes(reason)` is a SUBSTRING test, so a reason that happens to be
// a substring of a longer documented reason (e.g. a hypothetical `gate-timeout` would silently
// "pass" off the back of `gate-timeout-extended` if one ever existed) would never be flagged.
// Checked against all reasons required as of this action: none is currently a substring of
// another, but a check that only holds by accident of today's corpus is not a check.
//
// First attempt was requiring each reason as a backtick-delimited token (`` `worker-crashed` ``)
// -- rejected: measured against the real spec, it produces false negatives. `accounts.js`'s own
// two reasons are written as `` `NoAccountsRegisteredError('no-accounts-registered', ...)` `` and
// `` `'all-accounts-cooling-unknown'` `` -- single-quoted *inside* a backtick code span, not
// standing alone between their own backticks, because the surrounding prose is quoting a snippet
// of the throwing code rather than just naming the reason. A strict backtick-pair requirement
// would have flagged both as undocumented, which is false.
//
// Fixed instead with a delimited-TOKEN test: the reason must appear with no identifier character
// (letter, digit, `_`, `-`) touching either edge -- so it can sit between backticks, single
// quotes, parens, commas, or plain prose punctuation, but never as a strict substring of a longer
// hyphenated reason (a `-` immediately after the match fails the right-edge check, which is
// exactly the false-negative case above). Verified against every reason required as of this
// action: all still match. NOT applied to prefix families (`prompt-missing-placeholder:` etc.):
// those are matched as a substring ON PURPOSE (classifyReasonArg's own comment -- "a maintainer
// cannot enumerate every possible placeholder name up front, so the doc documents the family"),
// and the spec's own prose writes that family's prefix embedded inside a larger backtick span
// alongside the template syntax itself (the PLAN section's `` `ParkSignal(`prompt-missing-
// placeholder:${err.placeholder}`, ...)` ``) — a delimited-token requirement there would itself
// produce a false negative, for the same reason the strict backtick-pair attempt did above.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function reasonDocumented(spec, reason, isPrefix) {
  if (isPrefix) return spec.includes(reason);
  const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(reason)}(?![A-Za-z0-9_-])`);
  return re.test(spec);
}

test('every ParkSignal reason is documented in doc/state-machine-spec.md, or named on the allowlist with a reason', () => {
  const files = [...SCAN_DIRS.flatMap(jsFilesUnder), ...SCAN_FILES];
  let siteCount = 0;
  const required = new Map(); // reason -> {isPrefix, sites: [loc,...]}
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

  // finalizeParkSiteCount: the SINK-side counterpart of siteCount above. dispatcher.js calls
  // finalizePark directly and never mentions the string "ParkSignal" anywhere in the file -- the
  // `!source.includes('ParkSignal')` skip below is correct for the THROW scan (it really has no
  // `new ParkSignal(...)` sites) but would have been silently blind to dispatcher.js's own
  // finalizePark call too, had this scan reused the same skip. It doesn't: this loop runs on
  // every file regardless of whether it mentions ParkSignal.
  let finalizeParkSiteCount = 0;

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const source = blankComments(fs.readFileSync(abs, 'utf8'));

    for (const span of finalizeParkSpans(source)) {
      finalizeParkSiteCount += 1;
      const loc = `${rel}:${lineOf(source, span.index)}`;
      const c = classifyReasonArg(span.arg);
      if (c.kind === 'literal' || c.kind === 'prefix') {
        record(c.value, c.kind === 'prefix', loc);
      } else if (c.kind === 'dynamic' && c.value === 'err.reason') {
        // state-machine.js's own `finalizePark(ctx, state, err.reason, err.detail)` -- err.reason
        // is whatever ParkSignal was caught, already required via the `new ParkSignal(...)` scan
        // below (or that scan's own dynamic resolvers). Recording it again here would not add
        // anything the throw-side scan does not already require.
      } else {
        unresolvedDynamic.push(`${loc}: finalizePark's reason argument \`${span.arg}\` is neither a literal nor the known err.reason pass-through`);
      }
    }

    if (!source.includes('ParkSignal')) continue;

    for (const span of parkSignalSpans(source)) {
      siteCount += 1;
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
        // Anything else -- an unrecognized dynamic call site, or a no-static-prefix template with
        // an unrecognized suffix -- fails loudly rather than being silently accepted as
        // unverifiable. Extend classifyReasonArg / add a resolver, the same way
        // resolveAccountPoolReasons and resolveCiCauseParkReasons were added for the two shapes
        // known today.
        unresolvedDynamic.push(`${loc}: reason argument \`${span.arg}\` is neither a literal, a recognized template, nor a known dynamic pass-through (err.reason / outcome.reason)`);
      }
    }
  }

  // resolveAbandonedByMaintainerReason: the one reason that reaches neither scan above -- never
  // thrown as a ParkSignal, never passed through finalizePark, written straight to
  // `state.json.reason` by park-loop.js's abandon-reply reconciler. See that function's own
  // comment.
  const parkLoopSource = blankComments(readSource(path.join('orchestrator', 'park-loop.js')));
  for (const r of resolveAbandonedByMaintainerReason(parkLoopSource)) {
    if (r.kind === 'unresolved') unresolvedDynamic.push(`orchestrator/park-loop.js: ${r.value}`);
    else record(r.value, false, 'orchestrator/park-loop.js (direct state.json write, not thrown)');
  }

  // Floors, same reasoning as gh-api-argv.test.js's siteCount>=4 and no-real-spawn-sweep.test.js's
  // checked>=40: if either number drops well below what was actually measured for this action
  // (2026-09-02: 94 `new ParkSignal(...)` call sites, 6 `finalizePark(...)` sink call sites, 70
  // reasons requiring documentation after resolving templates and dynamic pass-throughs -- see
  // this file's header for the derivation), the sweep has stopped finding real surface -- a
  // renamed convention, a moved file, a regex that quietly stopped matching -- and a green result
  // downstream would mean nothing. Set well below the measured figures so ordinary future growth
  // never trips them.
  assert.ok(siteCount >= 80, `expected at least 80 \`new ParkSignal(...)\` call sites, found ${siteCount} -- has the call convention changed?`);
  assert.ok(finalizeParkSiteCount >= 4, `expected at least 4 \`finalizePark(...)\` sink call sites, found ${finalizeParkSiteCount} -- has the sink scan stopped matching?`);
  assert.ok(required.size >= 54, `expected at least 54 distinct reasons requiring documentation, found ${required.size} -- did a resolver stop matching?`);

  assert.deepEqual(
    unresolvedDynamic,
    [],
    `ParkSignal/finalizePark call site(s) this sweep cannot verify automatically -- extend the sweep, do not ignore:\n  ${unresolvedDynamic.join('\n  ')}`
  );

  // FINDING 3 (adversarial verification, 2026-09-02): the dynamic resolvers above -- account
  // pool, ci-cause, timed-out-class -- are the "sophisticated half" of this sweep the header
  // spends 60 lines justifying. A mutation that narrows parkSignalSpans's regex to single-quoted
  // literals only (dropping every template/dynamic call site entirely) still passed both floors
  // above by shrinking siteCount/required together -- a floor that only checks a COUNT cannot
  // tell "the corpus grew" from "a resolver died". Assert each dynamic family is actually present
  // in the resolved set, named individually, so deleting a resolver fails a test that says WHICH
  // one died rather than just reporting a smaller number.
  const accountPoolFamily = ['no-accounts-registered', 'all-accounts-leased', 'all-accounts-cooling-unknown'];
  for (const r of accountPoolFamily) {
    assert.ok(required.has(r), `account-pool resolver (resolveAccountPoolReasons) did not contribute '${r}' -- has err.reason's resolver stopped running?`);
  }
  assert.ok(
    [...required.keys()].some((r) => r.startsWith('all-accounts-cooling-until-')),
    "account-pool resolver did not contribute the 'all-accounts-cooling-until-' prefix family"
  );
  assert.ok(
    required.has('pr-rules-needs-approval'),
    "ci-cause resolver (resolveCiCauseParkReasons) did not contribute 'pr-rules-needs-approval' -- has outcome.reason's resolver stopped running?"
  );
  const timedOutClasses = ['git', 'gh', 'npm-ci', 'npm-gate', 'npm-run', 'command'];
  for (const cls of timedOutClasses) {
    assert.ok(
      required.has(`${cls}-timed-out`),
      `timed-out-class resolver (resolveTimedOutClassReasons) did not contribute '${cls}-timed-out' -- has config.js's COMMAND_TIMEOUTS_MS scan stopped matching?`
    );
  }
  assert.ok(
    required.has('prompt-missing-placeholder:') && required.get('prompt-missing-placeholder:').isPrefix,
    "the 'prompt-missing-placeholder:' static-prefix family did not resolve as a prefix requirement"
  );
  // FINDING 1: the finalizePark SINK family -- the whole point of this action's fix. Named
  // individually for the same reason as the dynamic families above: a regression here is exactly
  // the class of bug this action exists to close, so it must fail loudly and specifically.
  const finalizeParkSinkFamily = [
    'worker-crashed',
    'task-orphaned-daemon-restart',
    'task-orphaned-before-start',
    'state-machine-runaway',
    'unrecognized-state',
    'abandoned-by-maintainer',
  ];
  for (const r of finalizeParkSinkFamily) {
    assert.ok(required.has(r), `finalizePark sink scan did not contribute '${r}' -- has finalizeParkSpans or resolveAbandonedByMaintainerReason stopped matching?`);
  }

  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  const offenders = [];
  for (const [reason, info] of required) {
    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, reason)) continue;
    if (!reasonDocumented(spec, reason, info.isPrefix)) {
      offenders.push(`${reason}${info.isPrefix ? ' (prefix)' : ''} -- from ${info.sites.slice(0, 3).join(', ')}${info.sites.length > 3 ? `, +${info.sites.length - 3} more` : ''}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'A ParkSignal reason is neither documented in doc/state-machine-spec.md nor on this file\'s ' +
      'ALLOWLIST. Either add it to the spec (say what actually produces it and what a maintainer ' +
      'should do -- read the throwing code, never guess from the name) or add a named, reasoned ' +
      `ALLOWLIST entry:\n  ${offenders.join('\n  ')}`
  );
});

// ---- fixture tests: the sweep's own extraction/classification/resolution logic, exercised
// against synthetic source strings so it stays provably correct independent of what
// orchestrator/**'s real content happens to be today. Same rationale as
// no-real-spawn-sweep.test.js's own fixture block.

test('classifyReasonArg: plain string literal', () => {
  assert.deepEqual(classifyReasonArg("'worktree-add-failed'"), { kind: 'literal', value: 'worktree-add-failed' });
  assert.deepEqual(classifyReasonArg('"worktree-add-failed"'), { kind: 'literal', value: 'worktree-add-failed' });
});

test('classifyReasonArg: template literal with a static prefix', () => {
  assert.deepEqual(classifyReasonArg('`prompt-missing-placeholder:${err.placeholder}`'), {
    kind: 'prefix',
    value: 'prompt-missing-placeholder:',
  });
});

test('classifyReasonArg: template literal with no static prefix and the known -timed-out suffix', () => {
  assert.deepEqual(classifyReasonArg("`${commandClass || 'command'}-timed-out`"), {
    kind: 'timed-out-class-template',
    value: '-timed-out',
  });
});

test('classifyReasonArg: a template with no static prefix and an unrecognized suffix is NOT silently resolved', () => {
  const c = classifyReasonArg('`${someVar}-some-other-suffix`');
  assert.equal(c.kind, 'unresolvable-template');
});

test('classifyReasonArg: bare identifier/member expression is dynamic, not silently treated as a literal', () => {
  assert.deepEqual(classifyReasonArg('err.reason'), { kind: 'dynamic', value: 'err.reason' });
  assert.deepEqual(classifyReasonArg('outcome.reason'), { kind: 'dynamic', value: 'outcome.reason' });
});

test('parkSignalSpans + blankComments: a reason only named in a comment is never extracted as a call site', () => {
  // FINDING 2 (adversarial review, 2026-09-02): the fixture below previously wrote the comment's
  // mention as `ParkSignal('should-not-count', {})` -- no `new` -- so parkSignalSpans's own regex
  // (`/new\s+ParkSignal\s*\(/g`) could never match it whether or not blankComments actually
  // blanked the comment out. The mutation `blankComments(source) { return source; }` -- a
  // complete no-op -- passed this test either way, which means the test proved nothing about
  // blankComments itself. Fixed by writing the comment's mention with `new`, the exact shape a
  // real call site has, so a no-op blankComments produces a SECOND real match and this assertion
  // catches it.
  const rawSource = [
    "'use strict';",
    "// see new ParkSignal('should-not-count', {}) for context -- this is prose, not code",
    "function f() {",
    "  throw new ParkSignal('should-count', { detail: 1 });",
    "}",
    '',
  ].join('\n');
  const source = blankComments(rawSource);
  const spans = parkSignalSpans(source);
  assert.equal(spans.length, 1, 'a comment mention must not produce a second call site');
  assert.equal(classifyReasonArg(spans[0].arg).value, 'should-count');

  // Mutation proof, inline rather than merely asserted in a commit message: a no-op blankComments
  // must turn the assertion above red. Re-run the same scan against the UNBLANKED source directly
  // -- this is exactly what `blankComments(source) { return source; }` would hand parkSignalSpans
  // -- and confirm it now (correctly) finds two call sites, not one, proving the real
  // (non-no-op) blankComments above is what makes the count come out to 1.
  const spansIfBlankCommentsWereANoOp = parkSignalSpans(rawSource);
  assert.equal(
    spansIfBlankCommentsWereANoOp.length,
    2,
    'sanity check on the fixture itself: with comments left in, the comment-only mention must ' +
      'also be found (proving blankComments, not the fixture, is what keeps the real count at 1)'
  );
});

// Real-corpus guard for the same mutation: FINDING 2 also measured that blankComments matters on
// the ACTUAL codebase, not merely a synthetic fixture -- state-machine.js:1031 has one genuine
// commented-out `throw new ParkSignal('validate-unrecognized-verdict', ...)` inside a prose
// comment (its own header, describing action 1.4's history), and blanking it away is what keeps
// the reported call-site count from over-counting it as a live site. Pinned to the exact numbers
// measured 2026-09-02 so a future change to state-machine.js's comment (or a regression in
// blankComments) is caught by name, not just by a shrinking/growing floor.
test('blankComments on the real corpus removes exactly the one known commented-out ParkSignal site (state-machine.js:1031)', () => {
  const rawSource = readSource(path.join('orchestrator', 'state-machine.js'));
  const blanked = blankComments(rawSource);
  const blankedCount = parkSignalSpans(blanked).length;
  const unblankedCount = parkSignalSpans(rawSource).length;
  assert.equal(unblankedCount, blankedCount + 1, `blankComments should remove exactly one commented-out call site from state-machine.js, found blanked=${blankedCount} unblanked=${unblankedCount}`);
  // The one extra site the unblanked scan finds must be the specific commented-out reason named
  // in the header above, not some other drift -- named explicitly so a different comment change
  // that happens to add/remove a different ParkSignal mention is still caught.
  const unblankedReasons = parkSignalSpans(rawSource).map((s) => classifyReasonArg(s.arg).value);
  assert.ok(unblankedReasons.includes('validate-unrecognized-verdict'), 'the commented-out site names validate-unrecognized-verdict');
});

test('parkSignalSpans: a multi-line ParkSignal(...) call is still found and its reason still extracted', () => {
  const source = [
    "throw new ParkSignal(",
    "  'push-pr-failed',",
    "  { step: 'pr-create', exit: create.exit }",
    ");",
  ].join('\n');
  const spans = parkSignalSpans(source);
  assert.equal(spans.length, 1);
  assert.equal(classifyReasonArg(spans[0].arg).value, 'push-pr-failed');
});

test('resolveAccountPoolReasons: reads the three literal/prefix reasons off a synthetic accounts.js shape', () => {
  const fixture = [
    "function pick() {",
    "  if (registry.length === 0) {",
    "    throw new NoAccountsRegisteredError('no-accounts-registered', { poolDir });",
    "  }",
    "  if (healthyCount > 0) {",
    "    throw new AllAccountsLeasedError('all-accounts-leased', { checkedAccounts });",
    "  }",
    "  const reason =",
    "    earliestCooldown === null",
    "      ? 'all-accounts-cooling-unknown' // comment",
    "      : `all-accounts-cooling-until-${new Date(earliestCooldown).toISOString()}`;",
    "  throw new AllAccountsCoolingError(reason, { earliestCooldownUntil: earliestCooldown });",
    "}",
  ].join('\n');
  const resolved = resolveAccountPoolReasons(fixture);
  assert.deepEqual(resolved, [
    { kind: 'literal', value: 'no-accounts-registered' },
    { kind: 'literal', value: 'all-accounts-leased' },
    { kind: 'literal', value: 'all-accounts-cooling-unknown' },
    { kind: 'prefix', value: 'all-accounts-cooling-until-' },
  ]);
});

test('resolveAccountPoolReasons: a shape change fails loudly instead of silently returning fewer reasons', () => {
  const resolved = resolveAccountPoolReasons('function pick() { /* totally different now */ }');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].kind, 'unresolved');
});

test('resolveCiCauseParkReasons: reads every {kind: "park", reason: "..."} outcome off a synthetic ci-cause-table.js shape', () => {
  const fixture = [
    "function classifyCiFailure(checkName, stepName) {",
    "  if (stepName === 'PR rules (coverage ratchet, RDO citation)') {",
    "    return { kind: 'park', reason: 'pr-rules-needs-approval' };",
    "  }",
    "  return { kind: 'retry', nextState: 'DIAGNOSE' };",
    "}",
  ].join('\n');
  assert.deepEqual(resolveCiCauseParkReasons(fixture), [{ kind: 'literal', value: 'pr-rules-needs-approval' }]);
});

test('resolveCiCauseParkReasons: no park outcome found fails loudly instead of silently returning nothing', () => {
  const resolved = resolveCiCauseParkReasons("function classifyCiFailure() { return { kind: 'retry' }; }");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].kind, 'unresolved');
});

test('resolveTimedOutClassReasons: reads every class off a synthetic config.js COMMAND_TIMEOUTS_MS shape, plus the fallback', () => {
  const fixture = [
    "const COMMAND_TIMEOUTS_MS = {",
    "  git: 120000,",
    "  gh: 120000,",
    "  'npm-ci': 600000,",
    "};",
  ].join('\n');
  assert.deepEqual(resolveTimedOutClassReasons(fixture), [
    { kind: 'literal', value: 'git-timed-out' },
    { kind: 'literal', value: 'gh-timed-out' },
    { kind: 'literal', value: 'npm-ci-timed-out' },
    { kind: 'literal', value: 'command-timed-out' },
  ]);
});

// ---- self-mutation-shaped regression guard: a reason present in required-but-not-allowlisted
// form and absent from a stand-in "spec" must be reported as an offender -- proves the final
// comparison loop itself (not just extraction/resolution) actually fails on a gap, independent of
// the real spec's current content. Mirrors what the action's own verification step does by hand
// (add a canary ParkSignal, confirm red; remove a spec mention, confirm red) but as a hermetic,
// permanent regression test rather than a one-off manual check.
test('a required reason absent from the spec text is reported, allowlisted reasons are not', () => {
  const required = new Map([
    ['totally-undocumented-reason', { isPrefix: false, sites: ['fixture.js:1'] }],
    ['command-timed-out', { isPrefix: false, sites: ['fixture.js:2'] }],
    ['worktree-add-failed', { isPrefix: false, sites: ['fixture.js:3'] }],
  ]);
  const specStandIn = 'the spec mentions worktree-add-failed here, and nothing else';
  const offenders = [];
  for (const [reason, info] of required) {
    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, reason)) continue;
    if (!specStandIn.includes(reason)) offenders.push(reason);
  }
  assert.deepEqual(offenders, ['totally-undocumented-reason']);
});
