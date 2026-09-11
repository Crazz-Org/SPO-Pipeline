'use strict';
// spawn-isolation-sweep.test.js -- a standing guard over the class of bug SPO-Pipeline#82 exists
// to close.
//
// ---- the incident ------------------------------------------------------------------------------
//
// test/no-real-spawn.js's killswitch patches child_process.spawnSync IN THE PARENT test process
// ONLY -- it exists because a first cut once posted 140 fabricated park comments to a live GitHub
// issue (see that file's own header). During a later chantier, a mutation routed a pre-existing
// test through a REAL worker CHILD process instead. That child created a real git worktree
// registered in the maintainer's actual ~/SPO-WebClient, on a real branch, and ran `npm ci` --
// while the live `--real` daemon was running against that same repo. Nothing was pushed, but no
// guard stopped it, and none would have: the in-process killswitch cannot see inside a child, and
// test/helpers.js's isolatedEnv() is a CONVENTION every call site is supposed to use, not
// something enforced.
//
// ---- what this file enforces --------------------------------------------------------------------
//
// Every real `process.execPath` child a test spawns must derive its `env` from
// test/helpers.js's isolatedEnv() and never pass `--real`. Three properties, each checked
// independently over the SAME corpus:
//   1. an `env` option is present at all;
//   2. that env is actually isolatedEnv()-derived -- a hand-rolled `{ ...process.env, FOO }`
//      passes a naive "env: is present" check while isolating nothing;
//   3. no spawned argv ever contains the literal flag `--real`.
//
// ---- design, rewritten after a verified rejection (2026-09-06) ---------------------------------
//
// The first cut classified "is this the daemon/spo" by requiring the literal token `DAEMON` or
// `SPO_BIN` within a fixed line window around the call, and separately checked isolation within a
// second, wider line window. Verification broke both:
//
//   - the isolation window let a NEIGHBOURING call site's `isolatedEnv()` shield an unrelated,
//     genuinely broken site a few lines away (7 of 28 measured sites were shielded this way,
//     including two sites this same action had just "fixed" -- they could be silently un-fixed by
//     a one-line edit and the sweep would not notice);
//   - the DAEMON/SPO_BIN scope filter failed OPEN: padding a call with a couple of comment lines
//     pushed the token outside the window and dropped the site from the corpus entirely (the floor
//     absorbed it silently), and a call built from `path.join(__dirname, '..', 'orchestrator',
//     'daemon.js')` instead of importing the DAEMON constant carried no token at all -- so a
//     `--real`, no-`env:` call built that way was invisible from the start, not merely unlucky.
//
// Both defects share one root cause: matching text within an arbitrary *line* window instead of
// the call's own, precisely-bounded *expression*. The fix below never uses a line window for
// either purpose:
//
//   - SCOPE is no longer positively determined by hunting for a DAEMON/SPO_BIN token near the
//     call at all. Every spawn whose EXECUTABLE is confirmed to be `process.execPath`, a local
//     alias of it, the literal `'node'`, or `DAEMON`/`SPO_BIN` used directly (see EXEC_CANDIDATE
//     below) is IN the corpus by default and checked against all three properties. A site is
//     excluded only by an explicit, named, per-call-site-scoped ALLOWLIST entry (mirroring
//     test/no-real-spawn-sweep.test.js's own pattern-scoped design) -- never by a filter deciding
//     silently that a site "doesn't look like the daemon". A call this sweep cannot even parse, OR
//     whose argv/opts is an unresolvable bare identifier despite a recognised executable, is its
//     own, separate, always-failing assertion below, never a silent drop. A SECOND verified
//     rejection (2026-09-06, same day) found the executable-recognition itself still fail-open --
//     `process.execPath` held in a variable, the literal `'node'`, and `SPO_BIN` used AS the
//     executable (bypassing `node` entirely) were all invisible to a check that only recognised
//     the one literal spelling. Fixed by widening recognition to the bounded set EXEC_CANDIDATE
//     enumerates, PLUS a second, unfiltered pass (collectUnclassifiableExecutableSites) that scans
//     every spawn call with no executable filter at all and flags any whose ARGV independently
//     proves a DAEMON/SPO_BIN reference despite an executable that pass did not recognise --
//     the failsafe for an executable-obscuring shape nobody has enumerated yet.
//   - ISOLATION is checked against the call's own, balanced argument-list text -- extracted by
//     matching parentheses/brackets/strings, not counting lines -- plus, when that argument list
//     is itself a bare identifier (`spawnOpts`, `args`, a shorthand `{ env, stdio }`), the text of
//     THAT identifier's own nearest preceding declaration in the same file, resolved by NAME, not
//     by proximity. A neighbouring, unrelated site's `isolatedEnv()` call is never in scope for
//     this resolution because it is never that identifier's declaration.
//
// ---- what is legitimately out of scope, and how that is proven, not assumed --------------------
//
// This suite spawns real `process.execPath` children for reasons that have nothing to do with
// daemon.js/bin/spo: a `-e` one-liner that runs `process.exit(code)` after a delay to stand in for
// a worker/scanner in a dispatcher unit test, a handful of tiny named fixture scripts
// (LEASE_HOLD_FIXTURE, MARK_LIMIT_ONCE_FIXTURE, CONSTANTS_FIXTURE, a synthetic `probe.js` written
// into a throwaway release tree), and two read-only probes that spawn `-e 'require(argv[1])...'`
// against orchestrator/config.js's OWN path to check an exported constant. None of the last group
// spawns another command, writes anything, or touches a product-repo/worktrees/accounts/bench/
// reports/state path -- reading a plain exported number back over stdout is the whole of it.
// (Correction: an earlier draft of this paragraph claimed these `-e` children "never load
// orchestrator/config.js" -- untrue of tokens.test.js's own autoPullLimit/cacheTtlMs probes, which
// load it by design to read the very constant they assert on. Verified by grepping this file's own
// corpus for `require(process.argv` rather than re-asserting it from memory.)
//
// Each such call earns its exemption through a NAMED, PATTERN-SCOPED entry in ALLOWLIST below --
// matched against that specific call's own resolved argument text, never the whole file -- so a
// NEW call added to an allowlisted file (daemon or not) is still fully checked unless it also
// matches a declared pattern. The `--real` check applies to every site regardless of exemption:
// nothing this suite spawns legitimately needs that flag, allowlisted or not.
//
// helpers.js and test/no-real-spawn-guard.test.js (a sibling action's file, not edited here) are
// excluded from this per-call sweep entirely, not merely pattern-exempted: both have a real
// launcher whose `args`/`env` arrive as a bare FUNCTION PARAMETER, supplied by a caller in a
// different function (sometimes a different file's test body) -- there is no in-file declaration
// to resolve by name at all, only cross-function data flow this sweep does not attempt to trace.
// helpers.js is instead checked by a dedicated test below that reads its own four launchers
// directly; no-real-spawn-guard.test.js's one call site is verified by direct reading (both of its
// two call sites build `{ ...isolatedEnv() }`) and is not mine to edit.
//
// Known, accepted gap (not claimed to be closed): a `--real` value assembled at runtime from a
// variable (`args.push(realFlagVar)`) is invisible to this textual check, the same way it would be
// invisible to any string-literal scan. No call site in this suite does that today; if one ever
// does, it needs a different kind of guard than this file.
//
// A second known, accepted gap, found by the verifier attacking the failsafe (2026-09-06): a
// module-level `const __DP = path.join(__dirname, '..', 'orchestrator', 'daemon.js')`, with the
// argv passed as a SEPARATE local variable (`const a = [__DP, '--shadow', '--real']`), behind an
// unrecognised executable, escapes every check here. The cause is not the DAEMON_PATH_LITERAL key
// above -- it is that resolveIdentifierValue only recurses into a value when the WHOLE resolved
// text is itself a bare identifier; it never looks INSIDE an array literal's own elements, so a
// path built this way and then embedded as one element of a separately-declared argv array never
// reaches argvText at all. It takes three ordinary choices at once (an obscured executable, the
// path built as its own variable rather than inline, AND that variable's own name never reaching
// the daemon/spo binary literal), and the recognised-executable half of each of those three is
// already fully covered on its own -- which is why this was accepted rather than blocked. The fix
// direction, for whoever takes it later: recurse resolveIdentifierValue one level into array
// literal ELEMENTS, not only into a value that is itself a single bare identifier. A deliberately
// obfuscated leaf (string concatenation building the filename piecewise) escapes it too, and that
// one is not worth chasing -- the same posture the `--real`-from-a-variable gap above already
// takes.
//
// The per-file EXPECTED_SITE_COUNT_PER_FILE pin (below) and this failsafe are NOT redundant with
// each other, also found by the verifier: converting one real site's executable to something
// unrecognised while ADDING a fresh checked site in the SAME file leaves that file's total count
// unchanged, so the pin alone passes -- it was the failsafe, keyed on the argv's own daemon/spo
// reference, that caught the loss. Each layer catches what the other misses; the residual gap
// immediately above is precisely the shape that would need to defeat both at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp } = require('./helpers');

const TEST_DIR = __dirname;

// Any spawner this suite uses to launch a real `node <path> ...` child: `execFileSync`/`execFile`/
// `spawnSync`/`spawn` (destructured directly off child_process), or the local alias several
// integration-test files bind async `spawn` to (`const { spawn: realSpawn } = require(...)`) so it
// reads distinctly from a `spawn` used as a local variable name elsewhere in the same file.
//
// The FIRST argument is checked for one of a bounded set of shapes that all mean "this launches
// node, or the daemon/spo binary directly" -- `process.execPath` itself, the literal `'node'` (a
// verified rejection on 2026-09-06 built this exact fixture), a local alias of `process.execPath`
// (`const __NODE = process.execPath; ...(__NODE, ...)`, the same rejection's other fixture), or
// the bare identifiers `DAEMON`/`SPO_BIN` used AS the executable (invoking the binary directly,
// with no `node` in between at all -- the third fixture). Deliberately NOT "any bare identifier":
// a name that is none of the above (`cmd`, `command`, `spawnSync` DI parameters this suite's own
// `deps.spawn`/`deps.spawnSync` injection convention uses throughout, e.g. ci-cause-step.test.js,
// auto-triage.test.js, dispatcher.test.js's own `spawnIsolated` helper) never gets a `const X =
// process.execPath` declaration anywhere -- so it is provably NOT one of these shapes rather than
// merely unexamined, and this candidate set correctly never matches it. See
// collectUnclassifiableExecutableSites() below for the failsafe over shapes not enumerated here.
const EXEC_CANDIDATE = /(?:execFileSync|execFile|spawnSync|spawn|realSpawn)\(\s*((?:process\.execPath)|(?:'node')|(?:"node")|(?:[A-Za-z_$][\w$]*))\s*,/g;

const BARE_IDENT = /^[A-Za-z_$][\w$]*$/;
const NODE_LITERAL = /^(?:'node'|"node")$/;

// Every `const/let/var NAME = process.execPath` declaration in `src` -- local aliases a call site
// might use as its executable instead of writing `process.execPath` out each time. Discovered PER
// FILE, by the same exact-declaration shape resolveIdentifierValue already looks for elsewhere in
// this file, so an alias is only recognised when it can be proven, never guessed from a name.
function findNodeAliases(src) {
  const aliases = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.execPath\b/g;
  let m;
  while ((m = re.exec(src))) aliases.add(m[1]);
  return aliases;
}

function isNodeLikeExec(execExpr, nodeAliases) {
  return execExpr === 'process.execPath' || NODE_LITERAL.test(execExpr) || nodeAliases.has(execExpr);
}

function isDaemonBinDirectExec(execExpr) {
  return execExpr === 'DAEMON' || execExpr === 'SPO_BIN';
}

// ---- text-safe balanced-bracket scanning --------------------------------------------------------
//
// A naive character count of `(`/`)` breaks the moment a spawned argv contains a STRING with
// parens in it -- and several of this suite's `-e` fixtures do exactly that (a template literal
// building a child script's own source, e.g. `` `setTimeout(() => process.exit(0), 60000)` ``).
// Every helper below skips over string/template literals and comments wholesale before counting
// brackets, so what is INSIDE a string never perturbs the count of what is OUTSIDE it.

// If `src[i]` opens a string, template literal, or comment, returns the index just past its close;
// otherwise returns `i` unchanged so the caller processes `src[i]` normally. Template literals are
// treated as opaque all the way to their next un-escaped backtick -- this suite's own `${...}`
// interpolations are simple identifiers/calls, never a NESTED backtick, so that is exact for this
// corpus without needing to parse what is inside the interpolation at all.
function skipStringOrComment(src, i) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) {
      j += src[j] === '\\' ? 2 : 1;
    }
    return j + 1;
  }
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl + 1;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  return i;
}

// Index of the bracket matching `src[openIdx] === openCh`, or -1 if the source runs out before it
// balances (an unparseable call -- see the dedicated "parses cleanly" test below for what happens
// to those, which is never silence).
function matchBalanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const skipped = skipStringOrComment(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (src[i] === openCh) depth += 1;
    else if (src[i] === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// Splits `text` on its TOP-LEVEL commas (depth 0 across `(`/`[`/`{`, strings/comments skipped),
// e.g. the interior of a call's argument list into its individual arguments.
function splitTopLevelArgs(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const skipped = skipStringOrComment(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

// Resolves a bare identifier (`name`) to the text of its own `const/let/var name = ...`
// declaration in the SAME file -- found by exact name match, never by line proximity. Refuses
// (returns null) unless EXACTLY ONE such declaration exists anywhere in the file, regardless of
// where relative to `beforeIndex`. A verified rejection (2026-09-06) found this resolving the
// LAST declaration textually before the call with no scope awareness at all: a same-named
// `const opts = {...}` earlier in the file (an unrelated declaration) combined with the CALL's
// own genuine, unisolated `const opts = {...}` declared AFTER it (legal JS -- the function runs
// later, after both have been parsed) made the site read as isolated. The fix is NOT scope
// tracking (deliberately not attempted: a textual sweep has no reliable notion of "this
// declaration's enclosing function is the one that runs before this call") -- it is refusing to
// guess at all once the name is not unique in the file. A caller with more than one legitimate,
// non-conflicting use of the same name (test/drain.test.js had four functions each declaring
// `const env = {...isolatedEnv(), ...}`) must give each one a distinct name instead; that is a
// cheap, one-time fix in the TEST file, not a reason to weaken this check.
function resolveIdentifierValue(src, name, beforeIndex, depth) {
  if (depth <= 0) return null;
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*`, 'g');
  const all = [...src.matchAll(declRe)];
  if (all.length !== 1) return null; // zero declarations, or more than one anywhere in the file -- refuse to guess
  const last = all[0];
  if (last.index >= beforeIndex) return null; // its one declaration runs AFTER this call -- cannot have supplied it

  const valStart = last.index + last[0].length;
  const c = src[valStart];
  let valEnd;
  if (c === '{') valEnd = matchBalanced(src, valStart, '{', '}') + 1;
  else if (c === '[') valEnd = matchBalanced(src, valStart, '[', ']') + 1;
  else if (c === '(') valEnd = matchBalanced(src, valStart, '(', ')') + 1;
  else {
    // A scalar/expression value -- read to the next top-level `;`.
    let i = valStart;
    let d = 0;
    while (i < src.length) {
      const skipped = skipStringOrComment(src, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
      const ch = src[i];
      if (ch === '(' || ch === '[' || ch === '{') d += 1;
      else if (ch === ')' || ch === ']' || ch === '}') d -= 1;
      else if (ch === ';' && d === 0) break;
      i += 1;
    }
    valEnd = i;
  }
  if (valEnd <= valStart) return null; // unbalanced -- give up rather than mis-slice

  const valueText = src.slice(valStart, valEnd);
  const trimmed = valueText.trim();
  if (BARE_IDENT.test(trimmed) && trimmed !== name) {
    const deeper = resolveIdentifierValue(src, trimmed, last.index, depth - 1);
    if (deeper !== null) return `${valueText}\n${deeper}`;
  }
  return valueText;
}

// Builds the effective text used for every property check on one call: the argv expression and
// the options expression, each expanded with the text of its own declaration when it is a bare
// identifier (`args`, `spawnOpts`, ...), plus -- when the options text carries its `env` as a
// reference to some OTHER identifier rather than declaring it inline -- the text THAT identifier
// resolves to. Two shapes: the shorthand `{ env, stdio }` (the identifier IS literally named
// `env`), and an explicit `{ env: someName, stdio }` (the identifier is whatever follows the
// colon -- drain.test.js's own `envDrainReal`/`envDrainEsc`/etc, each named uniquely per site
// specifically so resolveIdentifierValue's one-declaration-only rule can resolve each without
// guessing). Extracting the ACTUAL name after `env:` here, rather than assuming it is always
// spelled `env`, is what makes that per-site renaming resolve at all.
function effectiveTexts(src, argvExprRaw, optsExprRaw, beforeIndex) {
  const argvExpr = (argvExprRaw || '').trim();
  const optsExpr = (optsExprRaw || '').trim();

  let argvText = argvExpr;
  if (BARE_IDENT.test(argvExpr)) {
    const resolved = resolveIdentifierValue(src, argvExpr, beforeIndex, 3);
    if (resolved !== null) argvText = `${argvExpr}\n${resolved}`;
  }

  let optsText = optsExpr;
  if (BARE_IDENT.test(optsExpr)) {
    const resolved = resolveIdentifierValue(src, optsExpr, beforeIndex, 3);
    if (resolved !== null) optsText = `${optsExpr}\n${resolved}`;
  }
  if (!/isolatedEnv\(\)/.test(optsText)) {
    const explicitEnv = /\benv\s*:\s*([A-Za-z_$][\w$]*)\b/.exec(optsText);
    const envName = explicitEnv ? explicitEnv[1] : /\benv\b\s*[,}]/.test(optsText) ? 'env' : null;
    if (envName) {
      const resolvedEnv = resolveIdentifierValue(src, envName, beforeIndex, 3);
      if (resolvedEnv !== null) optsText += `\n${resolvedEnv}`;
    }
  }

  return { argvText, optsText };
}

// ---- explicit, named, pattern-scoped exclusions -------------------------------------------------
//
// Mirrors test/no-real-spawn-sweep.test.js's own ALLOWLIST shape exactly: `{ reason, patterns }`
// per file, and a pattern only exempts the SPECIFIC call site whose own resolved argv/opts text
// contains it -- never the rest of that file. A pattern here is never merely "quieting a false
// positive"; each is the textual property that makes that exact call provably not the daemon/spo
// (a distinct fixture constant name, or the literal `-e` flag that makes it an inline one-liner
// rather than an invocation of a named file at all). No entry here has ever matched a genuine
// daemon/spo call in this corpus -- verified by the "would still catch a real offender" tests
// below, one per allowlisted shape.
//
// One deliberate gap against the committed test/no-real-spawn-sweep.test.js's own ALLOWLIST,
// noted rather than closed: that sweep's `patternIsTooBroad` STRUCTURALLY rejects a pattern that
// does not extend one of its own detection prefixes (a forward-extension rule enforced on every
// entry, always, by construction). This file's `validateAllowlist` instead rejects only a short
// list of literal forbidden tokens (`'env'`, `'isolatedEnv()'`, `'--real'`) plus a length floor --
// a SNAPSHOT check against patterns that exist today, not a structural guarantee that a FUTURE
// pattern of some other overly-broad shape would be caught. Two regression tests below substitute
// for the missing structural rule (one per allowlisted shape, proving a pattern still catches a
// genuinely broken call planted next to it) and were judged empirically sufficient by
// verification on 2026-09-06 -- but they are empirical, not structural. If this file gains many
// more allowlist entries, port the forward-extension rule instead of adding more snapshot tests.
const ALLOWLIST = new Map([
  [
    'account-lease.test.js',
    { reason: 'spawns LEASE_HOLD_FIXTURE, a tiny lock-holding fixture script -- not daemon.js/bin/spo.', patterns: ['LEASE_HOLD_FIXTURE'] },
  ],
  [
    'accounts.test.js',
    { reason: 'spawns MARK_LIMIT_ONCE_FIXTURE, a tiny fixture script -- not daemon.js/bin/spo.', patterns: ['MARK_LIMIT_ONCE_FIXTURE'] },
  ],
  [
    'dispatcher.test.js',
    {
      reason:
        'every non-corpus spawn here is a `-e` inline one-liner standing in for a worker/scanner ' +
        '(exit after a delay, an orphan self-exit loop, a hard CPU block) -- an argv whose first ' +
        "element is the literal `-e` flag never names daemon.js/bin/spo at all, so it cannot be " +
        'the incident this sweep exists to catch regardless of its env.',
      patterns: ["'-e',"],
    },
  ],
  [
    'drain.test.js',
    {
      reason: 'same `-e` one-liner shape as dispatcher.test.js above, standing in for a straggler worker in drain scenarios.',
      patterns: ["'-e',"],
    },
  ],
  [
    'journal-concurrent-append.test.js',
    { reason: 'a single `-e` one-liner writing to a journal file directly -- not daemon.js/bin/spo.', patterns: ["'-e',"] },
  ],
  [
    'no-real-spawn-guard-env.test.js',
    {
      reason:
        "two occurrences: one is text INSIDE a template-literal string being written out as a " +
        "child probe script's own source (never executed by this file itself as code -- it is " +
        "the `-e` argv of that CHILD's own eventual grandchild, hence the same `'-e',` pattern as " +
        "every other one-liner stand-in below covers its resolved text too), and the other spawns " +
        "a locally-written probe.js fixture, not daemon.js/bin/spo.",
      patterns: ["'-e',", '[probePath]'],
    },
  ],
  [
    'pipeline-version.test.js',
    { reason: 'a `-e` orphan-self-exit one-liner standing in for a worker -- not daemon.js/bin/spo.', patterns: ["'-e',"] },
  ],
  [
    'product-repo-lock.test.js',
    {
      reason:
        'HOLD_FIXTURE is a tiny lock-holding fixture script and CONSTANTS_FIXTURE reads a plain ' +
        'exported config constant back over stdout -- neither is daemon.js/bin/spo.',
      patterns: ['HOLD_FIXTURE', 'CONSTANTS_FIXTURE'],
    },
  ],
  [
    'recette.test.js',
    { reason: 'same `-e` one-liner shape as dispatcher.test.js above (orphan-exit / dump stand-ins for a scanner).', patterns: ["'-e',"] },
  ],
  [
    'release-script.test.js',
    {
      reason:
        "spawns a synthetic `probe.js` this test itself writes into a throwaway release tree -- " +
        "a DIFFERENT filename from daemon.js, distinguishable from the counter-example this " +
        "sweep's own rewrite was rejected for (a path.join(...,'daemon.js') built without " +
        'importing the DAEMON constant): if a future call instead built a path ending in ' +
        "'daemon.js' this way, it would NOT match this pattern and would be checked in full.",
      patterns: ["'probe.js'"],
    },
  ],
  [
    'repark-claim-publish-order.test.js',
    {
      reason:
        'all three sites are `-e` inline one-liners standing in for a worker (writes a real ' +
        'state.json, then exits a crash code), a repark-task child (a bare setTimeout -- this ' +
        'file pins the PARENT\'s statement ordering, never the child\'s own work) and a scanner ' +
        'stand-in (a long setTimeout, so the dispatcher\'s unconditional single scanner spawn and ' +
        'its respawn/breaker loop stay out of the way) -- the same shape dispatcher.test.js\'s and ' +
        'repark-race-demo.test.js\'s own worker/scanner stand-ins already take, and each derives ' +
        'its env from isolatedEnv(). No daemon.js/bin/spo child is spawned by this file at all.',
      patterns: ["'-e',"],
    },
  ],
  [
    'repark-race-demo.test.js',
    {
      reason:
        'the crashed "worker" and the held/unheld repark-child launcher are both `-e` inline ' +
        'one-liners standing in for a worker/repark-task child (writing a real state.json then ' +
        'exiting a crash code; waiting on a release file then calling the real, exported ' +
        'reparkCrashedTask) -- same shape as dispatcher.test.js\'s own worker/scanner stand-ins ' +
        "above. The one genuinely production-shaped child this file spawns -- the real scanner, " +
        "via spawnRealScannerFast -- forwards its executable as a bare `cmd` parameter (never a " +
        "literal process.execPath/'node'/DAEMON/SPO_BIN token), the same shape dispatcher.test.js's " +
        'own `spawnIsolated` helper already takes, so it is not a corpus site this sweep recognises ' +
        'as an executable candidate at all -- it still derives its env from isolatedEnv() regardless.',
      patterns: ["'-e',"],
    },
  ],
  [
    'status-6.7.test.js',
    { reason: 'a trivial `-e` one-liner used only to mint a guaranteed-dead pid -- not daemon.js/bin/spo.', patterns: ["'-e',"] },
  ],
  [
    'temp-dir-registry.test.js',
    {
      reason:
        "both sites spawn a NESTED `node --test` over a fixture test file that file itself just " +
        'wrote into an mkTmp directory -- the only way to observe a per-file exit handler, which ' +
        'by definition runs after this process\'s own last assertion. The argv is ' +
        "`['--test', <fixture>]`: it never names daemon.js/bin/spo, and the fixture it runs " +
        'requires nothing but node:test and test/helpers.js. Its env is gitEnv() with ' +
        'NODE_TEST_CONTEXT deleted rather than isolatedEnv(), deliberately: isolatedEnv() would ' +
        'mint six more throwaway directories per call to isolate a child that reads none of them, ' +
        'and the one variable that actually matters to a nested test runner is the one gitEnv() ' +
        'does not touch.',
      patterns: ["'--test',"],
    },
  ],
  [
    'tokens.test.js',
    {
      reason:
        "two read-only `-e` probes (autoPullLimit/cacheTtlMs) that `require()` orchestrator/" +
        'config.js by its own path and print one exported constant back over stdout -- never ' +
        'spawn another command, never write anything, never touch a product-repo/worktrees/' +
        'accounts/bench/reports/state path. The corpus\'s other 9 sites in this same file (real ' +
        '`spo tokens`/`spo cost` spawns) are NOT covered by this pattern and remain fully checked.',
      patterns: ["'-e',"],
    },
  ],
]);

// Files verified by a DEDICATED, separate mechanism instead of this per-call sweep -- see this
// file's header ("helpers.js and test/no-real-spawn-guard.test.js are excluded ...").
const FILE_ALLOWLIST = new Set(['helpers.js', 'no-real-spawn-guard.test.js']);

function isAllowlisted(file, combinedText) {
  const entry = ALLOWLIST.get(file);
  if (!entry) return false;
  return entry.patterns.some((pattern) => combinedText.includes(pattern));
}

function validateAllowlist(allowlist) {
  for (const [file, entry] of allowlist) {
    if (!entry || typeof entry.reason !== 'string' || entry.reason.length === 0) {
      throw new Error(`ALLOWLIST entry for "${file}" must carry a non-empty reason string`);
    }
    if (!Array.isArray(entry.patterns) || entry.patterns.length === 0) {
      throw new Error(`ALLOWLIST entry for "${file}" must declare at least one pattern`);
    }
    for (const pattern of entry.patterns) {
      // A pattern must be specific enough to name a real, distinguishing shape (a fixture
      // constant, the `-e` flag itself) -- not a bare token this sweep's own checks look for,
      // which would silently exempt everything those checks exist to catch.
      if (typeof pattern !== 'string' || pattern.length < 4) {
        throw new Error(`ALLOWLIST entry for "${file}" has a pattern too short to be specific: ${JSON.stringify(pattern)}`);
      }
      const FORBIDDEN = ['env', 'isolatedEnv()', '--real'];
      if (FORBIDDEN.includes(pattern)) {
        throw new Error(`ALLOWLIST entry for "${file}" has a pattern equal to one of this sweep's own detection tokens: ${JSON.stringify(pattern)}`);
      }
    }
  }
}

// Every `process.execPath` spawn call site in test/, classified but not yet judged: `unparseable`
// sites (brackets never balance) carry no text at all and are reported by their own dedicated
// test, never silently absorbed into the others.
function collectSites() {
  validateAllowlist(ALLOWLIST);
  const out = [];
  for (const file of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js')).sort()) {
    if (file === path.basename(__filename)) continue; // this file's own regex/pattern literals
    if (FILE_ALLOWLIST.has(file)) continue; // verified separately -- see this file's header
    const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    const lines = src.split('\n');
    const nodeAliases = findNodeAliases(src);
    for (const m of src.matchAll(EXEC_CANDIDATE)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      const line = lines[lineNo - 1].trimStart();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

      const execExpr = m[1];
      const daemonBinDirect = isDaemonBinDirectExec(execExpr);
      if (!isNodeLikeExec(execExpr, nodeAliases) && !daemonBinDirect) continue; // not one of the recognised shapes -- see collectUnclassifiableExecutableSites() for the failsafe

      const openIdx = m.index + m[0].lastIndexOf('(');
      const closeIdx = matchBalanced(src, openIdx, '(', ')');
      if (closeIdx === -1) {
        out.push({ file, lineNo, unparseable: true });
        continue;
      }
      const argsText = src.slice(openIdx + 1, closeIdx);
      const parts = splitTopLevelArgs(argsText); // parts[0] is the executable itself (matched above)
      const { argvText, optsText } = effectiveTexts(src, parts[1], parts[2], m.index);

      // A call whose executable IS the daemon/spo binary directly, or whose argv/opts is an
      // unresolvable bare identifier despite a node-like executable (helpers.js's own shape,
      // reached here only if it were ever duplicated OUTSIDE that already-excluded file) --
      // either way, this sweep cannot see enough of the actual argv/opts to certify anything.
      // Fail closed rather than silently pass three checks against text that never resolved.
      const argvExprRaw = (parts[1] || '').trim();
      const optsExprRaw = (parts[2] || '').trim();
      const argvUnresolved = BARE_IDENT.test(argvExprRaw) && !argvText.includes('\n') && resolveIdentifierValue(src, argvExprRaw, m.index, 3) === null;
      const optsUnresolved = BARE_IDENT.test(optsExprRaw) && !optsText.includes('\n') && resolveIdentifierValue(src, optsExprRaw, m.index, 3) === null;
      if (argvUnresolved || optsUnresolved) {
        out.push({ file, lineNo, unparseable: true });
        continue;
      }

      const combined = `${argvText}\n${optsText}`;
      out.push({ file, lineNo, argvText, optsText, combined, allowlisted: isAllowlisted(file, combined) });
    }
  }
  return out;
}

// Failsafe over executable shapes the candidate regex/classification above does not enumerate:
// scans EVERY spawn call in test/ (no executable filter at all) and flags any whose ARGV
// independently proves it references DAEMON/SPO_BIN while its executable was NOT recognised as
// process.execPath/'node'/an alias/DAEMON/SPO_BIN by the check above. A call with no such argv
// reference (the DI-mock convention's `deps.spawn(command, args)`/`deps.spawnSync(command, args,
// opts)`, `spawnIsolated(cmd, args, opts)`) never trips this: its `command`/`cmd` parameter never
// carries a `const NAME = process.execPath` declaration to find, so it was never a candidate for
// "launches node" in the first place, and its own text never names the daemon/spo binary either --
// there is no signal here to fail closed ON. helpers.js and no-real-spawn-guard.test.js are
// excluded for the same reason as the main sweep: their argv is itself an opaque parameter with
// nothing in this file to independently resolve.
const ANY_SPAWN_CALL = /(?:execFileSync|execFile|spawnSync|spawn|realSpawn)\(/g;

// A third verified rejection (same day) found the failsafe's own key too narrow: `DAEMON`/
// `SPO_BIN` name the IMPORTED constants, but an argv naming the daemon by an INLINE path literal
// (`path.join(__dirname, '..', 'orchestrator', 'daemon.js')`, never going through the constant at
// all) carries neither token -- so a call combining that with an ALSO-unrecognised executable
// (`const { execPath } = process` -- an entirely ordinary destructuring idiom, not a contrivance)
// vanished from every check. This key catches the daemon/spo binary named as a path literal
// instead of as the constant: `daemon.js` by name, or a `'bin'`/`'spo'` pair the way
// `path.join(..., 'bin', 'spo')` writes it.
const DAEMON_PATH_LITERAL = /daemon\.js|(['"])bin\1\s*,\s*(['"])spo\2|\bbin\/spo\b/;

function collectUnclassifiableExecutableSites() {
  const out = [];
  for (const file of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js')).sort()) {
    if (file === path.basename(__filename)) continue;
    if (FILE_ALLOWLIST.has(file)) continue;
    const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    const lines = src.split('\n');
    const nodeAliases = findNodeAliases(src);
    for (const m of src.matchAll(ANY_SPAWN_CALL)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      const line = lines[lineNo - 1].trimStart();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

      const openIdx = m.index + m[0].lastIndexOf('(');
      const closeIdx = matchBalanced(src, openIdx, '(', ')');
      if (closeIdx === -1) continue; // already reported by the "parses cleanly" test

      const argsText = src.slice(openIdx + 1, closeIdx);
      const parts = splitTopLevelArgs(argsText);
      const execExpr = (parts[0] || '').trim();
      if (isNodeLikeExec(execExpr, nodeAliases) || isDaemonBinDirectExec(execExpr)) continue; // handled by the main sweep already

      const { argvText } = effectiveTexts(src, parts[1], parts[2], m.index);
      if (/\bDAEMON\b|\bSPO_BIN\b/.test(argvText) || DAEMON_PATH_LITERAL.test(argvText)) {
        out.push(`${file}:${lineNo}`);
      }
    }
  }
  return out;
}

test('the ALLOWLIST and FILE_ALLOWLIST are pinned by name', () => {
  assert.deepEqual(
    [...ALLOWLIST.keys()].sort(),
    [
      'account-lease.test.js',
      'accounts.test.js',
      'dispatcher.test.js',
      'drain.test.js',
      'journal-concurrent-append.test.js',
      'no-real-spawn-guard-env.test.js',
      'pipeline-version.test.js',
      'product-repo-lock.test.js',
      'recette.test.js',
      'release-script.test.js',
      'repark-claim-publish-order.test.js',
      'repark-race-demo.test.js',
      'status-6.7.test.js',
      'temp-dir-registry.test.js',
      'tokens.test.js',
    ].sort(),
    'ALLOWLIST gained or lost an entry without this pin being updated'
  );
  assert.deepEqual([...FILE_ALLOWLIST].sort(), ['helpers.js', 'no-real-spawn-guard.test.js']);
});

test('every real-spawn call site in test/ parses cleanly enough to classify', () => {
  const offenders = collectSites()
    .filter((s) => s.unparseable)
    .map((s) => `${s.file}:${s.lineNo}`);
  assert.deepEqual(
    offenders,
    [],
    "call site(s) this sweep could not balance-match (brackets never closed within the file) or " +
      "whose argv/opts is an unresolvable bare identifier despite a node-like/daemon-direct " +
      "executable -- unparseable is never silently skipped; it must be made parseable or the " +
      `sweep's own scanner fixed:\n  ${offenders.join('\n  ')}`
  );
});

test('no spawn call site in test/ references DAEMON/SPO_BIN in its argv through an executable this sweep cannot otherwise confirm launches node or the binary directly', () => {
  // The failsafe over executable shapes EXEC_CANDIDATE does not enumerate (a rejected earlier cut
  // of this sweep matched executables by literal `process.execPath` text ONLY -- verified to miss
  // a local alias, the literal `'node'`, and `SPO_BIN` used as the executable directly, all three
  // proven as real fixtures below). This scans every spawn call with NO executable filter at all,
  // so a shape nobody has enumerated yet still gets caught as long as its own argv names the
  // daemon/spo binary.
  const offenders = collectUnclassifiableExecutableSites();
  assert.deepEqual(
    offenders,
    [],
    "spawn(s) in test/ whose argv names DAEMON/SPO_BIN but whose executable is not confirmed to be " +
      "process.execPath, a local alias of it, the literal 'node', or DAEMON/SPO_BIN itself -- an " +
      "executable this sweep cannot identify is exactly how a real daemon/spo launch could evade " +
      `every check above. Never silently drop it -- name the executable's true shape instead:\n  ` +
      offenders.join('\n  ')
  );
});

test('every real-spawn call site in test/ carries an `env:` option', () => {
  const sites = collectSites().filter((s) => !s.unparseable);
  // Measured 2026-09-06: 60 real call sites total (excluding this file itself and the two
  // separately-verified files), across 16 files ranging from 1 to 14 sites each. Floor set to 58
  // (margin 2) rather than a looser round number: verified by mutation (simulating `readdirSync`
  // silently dropping one file at a time) that this floor goes red for the loss of ANY file
  // contributing 3 or more sites -- including cli.test.js (3) and product-repo-lock.test.js (3),
  // the smallest such files, not just the largest ones. The honest remaining gap, stated rather
  // than hidden: losing one of the nine 1-or-2-site files (account-lease.test.js,
  // accounts.test.js, journal-concurrent-append.test.js, no-real-spawn-guard-env.test.js,
  // park-alert.test.js, pipeline-version.test.js, release-script.test.js, status-6.7.test.js,
  // worker-mode.test.js) still clears this floor -- the floor counts, it does not identify, the
  // same caveat test/no-real-spawn-sweep.test.js's own floor states about itself.
  assert.ok(sites.length >= 58, `expected close to the measured 60 real-spawn call sites, found ${sites.length}`);

  // The global floor above COUNTS but does not IDENTIFY: dropping cli.test.js (3 sites) reddens
  // at 57, but dropping park-alert.test.js (1 site) alone, or park-alert.test.js AND
  // worker-mode.test.js TOGETHER, both stay at or above 58 -- any combination of losses summing
  // to <=2 slips through silently, not just any single small file. Pinned per file instead, over
  // the eight files this ledger currently pins from the CHECKED (non-allowlisted) corpus --
  // losing any one of them, however small, now reddens by name instead of only nudging a total.
  // Not every contributing file is pinned here: daemon-repark-mode.test.js (2 sites) and
  // usage-report.test.js (1 site) are real, checked, audited corpus files (see
  // auditedRealCorpusFiles below) that are not pinned in this ledger; both were added to that
  // audited set alone, before this ledger's dispatcher-status-deck.test.js entry, and no record
  // says why they were not also pinned here.
  //
  // MAINTENANCE COST, stated rather than hidden: adding or removing a legitimate real-spawn call
  // site in any of these eight files means editing the matching count below, not just the global
  // floor above -- that edit is deliberate by design (a count that silently drifted would defeat
  // the point), but the next author needs to know where: this object, by filename.
  const EXPECTED_SITE_COUNT_PER_FILE = {
    'cli.test.js': 3,
    // Card #186/#188: deadPid()'s own `realSpawn(process.execPath, ['-e', ''], { stdio: 'ignore',
    // env: isolatedEnv() })` -- the one real-spawn site in this file, minting a guaranteed-dead
    // pid for the drain-liveness tests below it.
    'dispatcher-status-deck.test.js': 1,
    'dispatcher.test.js': 6,
    // Card #188 (section 17): two real daemon.js children joined this file's corpus -- the
    // SIGKILL-inside-the-drain-wait test's own launch (`{ env: envDrainDied, ... }`) and the
    // second-SIGTERM variant's launch (`{ env: envDrainDied2, ... }`), each with its env built as
    // `{ ...isolatedEnv(), ... }`. Audited before this count moved: both were already
    // isolatedEnv()-derived, so nothing but this ledger needed to change for them.
    'drain.test.js': 6,
    'lock.test.js': 4,
    'park-alert.test.js': 1,
    'tokens.test.js': 9,
    'worker-mode.test.js': 1,
  };
  const actualSitesPerFile = {};
  for (const s of sites) {
    if (s.allowlisted) continue;
    actualSitesPerFile[s.file] = (actualSitesPerFile[s.file] || 0) + 1;
  }
  for (const [file, expected] of Object.entries(EXPECTED_SITE_COUNT_PER_FILE)) {
    assert.equal(
      actualSitesPerFile[file] || 0,
      expected,
      `${file}: expected ${expected} checked real-spawn site(s), found ${actualSitesPerFile[file] || 0} -- ` +
        'a site was added, removed, or newly allowlisted in this file without updating ' +
        'EXPECTED_SITE_COUNT_PER_FILE above'
    );
  }

  const offenders = sites
    .filter((s) => !s.allowlisted)
    .filter((s) => !/\benv\b\s*[:,}]/.test(s.optsText))
    .map((s) => `${s.file}:${s.lineNo}`);

  assert.deepEqual(
    offenders,
    [],
    'real spawn(s) in test/ with no `env:` option at all -- these inherit this test process\'s OWN ' +
      "environment. Pass `env: isolatedEnv()` (test/helpers.js), or if this call genuinely does " +
      "not spawn daemon.js/bin/spo, add a narrow ALLOWLIST entry above:\n  " +
      offenders.join('\n  ')
  );
});

test('every real-spawn call site in test/ derives its env from isolatedEnv(), not a bare process.env spread', () => {
  const offenders = collectSites()
    .filter((s) => !s.unparseable && !s.allowlisted)
    .filter((s) => !/isolatedEnv\(\)/.test(s.optsText))
    .map((s) => `${s.file}:${s.lineNo}`);

  assert.deepEqual(
    offenders,
    [],
    'real spawn(s) in test/ whose `env:` does not derive from isolatedEnv() -- an `env: ' +
      '{ ...process.env, FOO: 1 }` passes a naive "env: is present" check while leaving ' +
      'SPO_PRODUCT_REPO/SPO_WORKTREES_DIR/SPO_ACCOUNTS_DIR/SPO_BENCH_DIR/SPO_REPORTS_DIR/' +
      "SPO_STATE_DIR pointed at the maintainer's real, shared machine state. Spread isolatedEnv() " +
      `instead (\`{ ...isolatedEnv(), FOO: 1 }\`):\n  ${offenders.join('\n  ')}`
  );
});

test('no real-spawn call site in test/ ever passes --real, allowlisted or not', () => {
  // Deliberately NOT filtered by `allowlisted` -- nothing this suite spawns, daemon/spo or
  // otherwise, legitimately needs that flag. See this file's header for the one known, accepted
  // gap in this specific check (a `--real` assembled at runtime from a variable).
  const offenders = collectSites()
    .filter((s) => !s.unparseable)
    .filter((s) => /(['"])--real\1/.test(s.combined))
    .map((s) => `${s.file}:${s.lineNo}`);

  assert.deepEqual(
    offenders,
    [],
    "real spawn(s) in test/ whose argv contains the literal '--real' flag -- this IS the incident " +
      "this file exists to close. A test that needs real-mode SEMANTICS uses helpers.js's " +
      `runDaemonDryRun (--dry-run), never --real:\n  ${offenders.join('\n  ')}`
  );
});

test('helpers.js: every real daemon.js/bin-spo launcher derives its env from isolatedEnv() (checked directly, not by the sweep above)', () => {
  const src = fs.readFileSync(path.join(TEST_DIR, 'helpers.js'), 'utf8');
  const calls = [...src.matchAll(/execFileSync\(\s*process\.execPath\b/g)];
  assert.equal(calls.length, 4, `expected exactly 4 execFileSync(process.execPath, ...) launchers in helpers.js, found ${calls.length}`);

  const offenders = [];
  for (const m of calls) {
    const lineNo = src.slice(0, m.index).split('\n').length;
    const openIdx = m.index + m[0].lastIndexOf('(');
    const closeIdx = matchBalanced(src, openIdx, '(', ')');
    if (closeIdx === -1) {
      offenders.push(`${lineNo} (unparseable)`);
      continue;
    }
    const argsText = src.slice(openIdx + 1, closeIdx);
    const parts = splitTopLevelArgs(argsText);
    const { optsText } = effectiveTexts(src, parts[1], parts[2], m.index);
    if (!/isolatedEnv\(\)/.test(optsText)) offenders.push(String(lineNo));
  }
  assert.deepEqual(offenders, [], `helpers.js execFileSync launcher(s) at line(s) ${offenders.join(', ')} do not derive env from isolatedEnv()`);
});

test('helpers.isolatedEnv() isolates SPO_REPORTS_DIR to a fresh temp directory, never the shared ~/.spo-reports default', () => {
  const os = require('os');
  const { isolatedEnv } = require('./helpers');
  const env = isolatedEnv();
  const realDefault = path.join(os.homedir(), '.spo-reports');

  assert.ok(env.SPO_REPORTS_DIR, 'isolatedEnv() must set SPO_REPORTS_DIR');
  assert.notEqual(env.SPO_REPORTS_DIR, realDefault, 'isolatedEnv() must not leave SPO_REPORTS_DIR pointed at the real, shared ~/.spo-reports');
  assert.equal(path.dirname(env.SPO_REPORTS_DIR), os.tmpdir(), 'SPO_REPORTS_DIR should be a fresh fs.mkdtempSync(os.tmpdir()) directory, like isolatedEnv()\'s other paths');
  assert.ok(fs.existsSync(env.SPO_REPORTS_DIR), 'the SPO_REPORTS_DIR isolatedEnv() names must actually exist');
});

test('helpers.isolatedEnv() isolates SPO_STATE_DIR to a fresh temp directory, never the shared ~/.spo-state default', () => {
  const os = require('os');
  const { isolatedEnv } = require('./helpers');
  const env = isolatedEnv();
  const realDefault = path.join(os.homedir(), '.spo-state');

  assert.ok(env.SPO_STATE_DIR, 'isolatedEnv() must set SPO_STATE_DIR');
  assert.notEqual(env.SPO_STATE_DIR, realDefault, 'isolatedEnv() must not leave SPO_STATE_DIR pointed at the real, shared ~/.spo-state');
  assert.equal(path.dirname(env.SPO_STATE_DIR), os.tmpdir(), 'SPO_STATE_DIR should be a fresh fs.mkdtempSync(os.tmpdir()) directory, like isolatedEnv()\'s other paths');
  assert.ok(fs.existsSync(env.SPO_STATE_DIR), 'the SPO_STATE_DIR isolatedEnv() names must actually exist');
});

// ---- allowlist-shape regression tests: each pattern's shape would still catch a REAL offender ---
// Proves an allowlist pattern exempts only ITS OWN shape, not a genuine daemon/spo call that
// happens to sit in the same file -- synthetic fixtures in a temp dir, never a real env var.

function fixtureDir(prefix) {
  const os = require('os');
  return mkTmp(prefix);
}

// Embeds `pattern` verbatim into a syntactically valid argv literal, so a fixture "ok" call's own
// text contains it exactly the way a real allowlisted site's resolved text would.
function buildOkArgv(pattern) {
  if (pattern.startsWith('[')) return pattern; // already a full argv literal, e.g. "[probePath]"
  if (pattern.endsWith(',')) return `[${pattern} 'rest']`; // e.g. "'-e'," -> "['-e', 'rest']"
  return `[${pattern}, 'rest']`; // a bare token or quoted literal, e.g. LEASE_HOLD_FIXTURE, 'probe.js'
}

// Re-implements collectSites()'s read+classify step against an arbitrary directory/file (that
// function is hard-wired to TEST_DIR by design, so the real sweep above can never be pointed
// anywhere else by a mutation) -- shared by both loops below.
function classifyFixtureFile(dir, file) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const nodeAliases = findNodeAliases(src);
  const sites = [];
  for (const m of src.matchAll(EXEC_CANDIDATE)) {
    if (!isNodeLikeExec(m[1], nodeAliases) && !isDaemonBinDirectExec(m[1])) continue;
    const openIdx = m.index + m[0].lastIndexOf('(');
    const closeIdx = matchBalanced(src, openIdx, '(', ')');
    const parts = splitTopLevelArgs(src.slice(openIdx + 1, closeIdx));
    const { argvText, optsText } = effectiveTexts(src, parts[1], parts[2], m.index);
    sites.push({ combined: `${argvText}\n${optsText}`, optsText });
  }
  return sites;
}

test("every ALLOWLIST entry's own pattern(s) exempt only their own shape -- never an unrelated, genuinely broken call in the same file", () => {
  // Loops EVERY entry and every pattern within each, not one hardcoded file: a rejected
  // earlier cut of this test exercised dispatcher.test.js alone, so an allowlisted file outside
  // that one hardcoded name could have its pattern silently widened with nothing here to notice.
  for (const [file, entry] of ALLOWLIST) {
    for (const pattern of entry.patterns) {
      const dir = fixtureDir('spo-sweep-scoped-');
      fs.writeFileSync(
        path.join(dir, file),
        [
          "'use strict';",
          "const { spawn: realSpawn, execFileSync } = require('child_process');",
          "const { DAEMON, SPO_BIN } = require('./helpers');",
          `function ok() { return execFileSync(process.execPath, ${buildOkArgv(pattern)}, { stdio: 'ignore' }); }`,
          "function broken() { return realSpawn(process.execPath, [DAEMON, '--shadow'], { stdio: 'ignore' }); }",
          '',
        ].join('\n')
      );
      const sites = classifyFixtureFile(dir, file);
      assert.equal(sites.length, 2, `sanity: both calls found for ${file} / pattern ${JSON.stringify(pattern)}`);
      const classified = sites.map((s) => entry.patterns.some((p) => s.combined.includes(p)));
      assert.deepEqual(
        classified,
        [true, false],
        `${file}'s pattern ${JSON.stringify(pattern)} must recognise its own "ok" shape and must NOT exempt the unrelated, genuinely broken DAEMON call in the same file`
      );
      assert.equal(/isolatedEnv\(\)/.test(sites[1].optsText), false, `sanity: the "broken" call in ${file}'s fixture really has no isolatedEnv()`);
    }
  }
});

test("no ALLOWLIST entry's pattern(s) accidentally cover a REAL corpus site's resolved text today, for EVERY entry", () => {
  // A different angle on the same property, over the FULL allowlist and the FULL real corpus (not
  // seven hardcoded filenames and a duplicated literal regex -- a rejected earlier cut of this
  // test named exactly seven files and re-typed each pattern into a regex by hand; an allowlisted
  // file outside that list, or a new pattern added without updating the regex, would slip both).
  const sites = collectSites().filter((s) => !s.unparseable && !s.allowlisted);
  const wronglyAllowlisted = collectSites()
    .filter((s) => !s.unparseable && s.allowlisted)
    .filter((s) => {
      const entry = ALLOWLIST.get(s.file);
      return !entry || !entry.patterns.some((p) => s.combined.includes(p));
    });
  assert.deepEqual(
    wronglyAllowlisted.map((s) => `${s.file}:${s.lineNo}`),
    [],
    "isAllowlisted() marked a site exempt for a reason this test cannot attribute back to that file's own ALLOWLIST pattern(s) -- investigate before trusting the exemption"
  );
  // And the converse sanity: every REAL (checked) site must be one of the files this action's
  // audit actually measured -- catches a genuinely new, unaudited daemon spawn silently joining
  // the corpus without anyone having looked at it.
  // Card #78 verification: daemon-repark-mode.test.js joined this corpus with the `--repark-task`
  // mode. Its one spawning helper (runReparkRaw) was audited against this sweep's own four
  // properties before being added here -- `env: { ...isolatedEnv(), ...envOverrides }`, so the
  // env is present, derived from isolatedEnv() rather than a bare process.env, and every
  // override a test layers on top is a fresh mkTmp dir (the empty account pool), never a real one.
  // SPO-Pipeline#170 (2026-09-10): usage-report.test.js's CLI smoke test spawns
  // `node scripts/usage-report.js --roots=<fixture>` via execFileSync -- not daemon.js or bin/spo,
  // so it touches none of helpers.js's isolated per-test paths regardless of what they resolve
  // to, but it still carries `env: isolatedEnv()` (the simpler of "isolate" or "justify an
  // allowlist entry" here) so it passes this sweep's own four properties the same way every
  // other audited site does.
  // Card #186/#188: dispatcher-status-deck.test.js's own deadPid() spawns a trivial
  // `realSpawn(process.execPath, ['-e', ''], ...)` one-liner -- the same "mint a guaranteed-dead
  // pid" shape status-6.7.test.js's ALLOWLIST entry already covers, but left here as a fully
  // checked corpus site (env: isolatedEnv()) rather than a new allowlist pattern: isolating it
  // costs six throwaway (exit-swept) temp directories per call (test/helpers.js:106-142, the same
  // cost the temp-dir-registry ALLOWLIST entry above cites for skipping it elsewhere), and this
  // keeps the file with no allowlist entry of its own.
  const auditedRealCorpusFiles = new Set(['cli.test.js', 'daemon-repark-mode.test.js', 'dispatcher-status-deck.test.js', 'dispatcher.test.js', 'drain.test.js', 'lock.test.js', 'park-alert.test.js', 'tokens.test.js', 'usage-report.test.js', 'worker-mode.test.js']);
  const unaudited = sites.filter((s) => !auditedRealCorpusFiles.has(s.file)).map((s) => `${s.file}:${s.lineNo}`);
  assert.deepEqual(unaudited, [], 'a real, checked (non-allowlisted) corpus site appeared in a file this action never audited -- look at it before trusting it silently');
});
