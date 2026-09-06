'use strict';
// orchestrator/plan-span-guard.js -- issue #112's "PLAN freezes a span its own plan orders
// changed" detector. orchestrator/invariants.js gives PLAN a way to freeze a verbatim quote,
// cited as `File: <relative/path>:<start>-<end>`, and CHECK re-resolves it at IMPLEMENT time --
// but neither module has ever asked the one question that actually catches the defect this
// action exists for: does the SAME plan that wrote that freeze also say, somewhere in its own
// prose, that lines in that same range are to change? When it does, no implementation can ever
// satisfy both instructions at once, and the invariant only fails LATER, in CHECK, costing a full
// DIAGNOSE/IMPLEMENT cycle to discover something the plan text already gave away at PLAN time.
//
// This module is the whole of the DETECTOR and nothing else: markdown and a baseline in, findings
// out. It does not read a filesystem, does not spawn, does not decide what handlePlan or CHECK do
// with a finding -- wiring it into either is a separate action. That separation is deliberate: a
// pure function is trivial to fuzz and to reason about, and this module's only job is to be
// right, not to be integrated.
//
// ---- the predicate is plain span overlap -- do not add cleverness ------------------------------
// An exhaustive search over 82,159 candidate conjunctions (verb lists, polarity filters, ratio
// caps, token matching -- every refinement that "should obviously help") against the real
// 58-card journal corpus found that none of them improves the outcome that matters, and several
// degrade it. `detectSpanConflicts` below is therefore exactly `planStart <= invEnd && invStart
// <= planEnd`. Anything smarter than that is a regression, not an improvement, until a fresh
// measurement over a fresh corpus says otherwise.
//
// ---- three span syntaxes, all three required ----------------------------------------------------
// Measured across the 58-card corpus: path-attached citations are 47% of real spans, bare-colon
// (a line range with no path on the citation itself, relying on context) 31%, and prose ("lines
// N-M") 22%. Each of three known real defects is reachable through exactly one syntax alone --
// #487 only through bare-colon, #508 only through prose, #488 through path-attached or prose --
// so a detector that only implements one or two syntaxes catches at most a fraction of the real
// cases. See extractPlanSpans below for the three scanners and the attribution rules that route a
// syntax-less span (bare-colon, prose) back to the file it actually names.
//
// ---- fail-open on parsing, exactly like invariants.js -------------------------------------------
// Nothing in this module throws, for any input -- a malformed plan, an invariant row shaped by an
// older version of buildBaseline (missing `span`/`declaredSpan` entirely), a non-string path, a
// pathological multi-megabyte single-line plan. An input this module cannot make sense of simply
// yields no finding for that piece, never an exception that would escape into handlePlan or CHECK
// and turn a detector into an outage.
//
// ---- bounded output -----------------------------------------------------------------------------
// A finding this module returns is destined, eventually, to flow into a journalled event and from
// there into a GitHub comment capped at 65536 chars (the same limit orchestrator/intake.js's
// PROTECTED_LINE_MAX_LENGTH and state-machine.js's guardDeclaredFiles already exist to respect).
// MAX_FINDINGS and MAX_FIELD_LENGTH below cap this module's own output so that a pathological
// plan (thousands of colon-shaped tokens on one file) cannot, on its own, produce an unbounded
// result -- see the dedicated tests for both caps and for the O(lines) / O(invariants + spans)
// shape that keeps a large plan from becoming quadratic.

const MAX_PLAN_SPANS = 2000;
// Caps how many spans a single call to extractPlanSpans will ever RETURN, and with it how much
// per-invariant work detectSpanConflicts can be handed. Any real plan's own citations are a few
// dozen at most.
//
// It bounds the RESULT, not the scanning work, and the difference is measurable: the cap is
// checked only where a span is pushed, so matches that are DROPPED for want of attribution (a
// bare-colon or prose match with no path on the line and no path-bearing ancestor heading) never
// count against it. A plan made of such matches is still scanned in full -- measured at 31.5 s
// for 3.78 MB of `(:1-2)` repeated 3300 times per line, returning zero spans. Real plans are
// nowhere near this: all 58 cards of the journal corpus parse in 41 ms total, worst 3.45 ms,
// largest plan 27 KB. MAX_SCAN_LINE_LENGTH below is what actually bounds per-line work.
const MAX_SCAN_LINE_LENGTH = 20000;
// Caps how much of a single markdown LINE is fed to the per-line regex scanners. A multi-megabyte
// "plan" that is technically one line (no '\n' at all) must not turn a single regex pass into
// wasted work over the whole file; no real plan line built by PLAN's own prose approaches this.
const MAX_FINDINGS = 200;
// Caps detectSpanConflicts' own return value -- see the module header's "bounded output" note.
const MAX_FIELD_LENGTH = 500;
// Caps any individual string (an id, a file path) copied verbatim into a finding, regardless of
// how long the source value was. Generous for anything real: a normalized repo path or an
// `INV-<n>` id is well under this.

const COLON_SPAN_RE = /([A-Za-z0-9_@%.\/\-\+~]*):(\d+)(?:\s*[-–—]\s*(\d+))?/g;
const PROSE_SPAN_RE = /\b(lines?)\s+(\d+)(?:\s*[-–—]\s*(\d+))?/gi;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const LEGACY_WORKTREE_RE = /^.*\/(?:worktrees|\.spo-worktrees)\/issue-\d+\//;

// normalizePath(p, worktreeRoot) -- turns a citation's raw path text into a comparable,
// worktree-relative form. Never throws; a non-string `p` returns null (the caller's signal to
// drop the citation rather than attribute it to the literal string "null" or "undefined").
//
// Three stripping rules, tried in order, FIRST match wins (not all three applied in sequence):
//   1. `worktreeRoot` given and `p` starts with it (plus a path separator) -> strip that prefix.
//      This is the live-daemon shape: PLAN and CHECK both run with an absolute worktree root in
//      hand, and a citation copy-pasted from a `find`/editor output carries that same root.
//   2. Otherwise, a LEGACY worktree prefix -- `.../worktrees/issue-<n>/...` or
//      `.../.spo-worktrees/issue-<n>/...` -- stripped up to and including the trailing '/'. Both
//      forms are real in the 58-card corpus: it was written while product worktrees still lived
//      inside this repo (`<repo>/worktrees/issue-<n>/`, see this repo's own CLAUDE.md for why
//      that moved), and they now live under `~/.spo-worktrees/issue-<n>/`.
//   3. Otherwise, a leading './' is stripped, if present.
// Surrounding whitespace and a pair of surrounding backticks (the corpus fences the large
// majority of its path citations) are stripped before any of the above.
function normalizePath(p, worktreeRoot) {
  try {
    if (typeof p !== 'string') return null;
    let s = p.trim();
    if (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) {
      s = s.slice(1, -1).trim();
    }
    if (typeof worktreeRoot === 'string' && worktreeRoot !== '') {
      const root = worktreeRoot.endsWith('/') ? worktreeRoot.slice(0, -1) : worktreeRoot;
      if (s === root) return '';
      if (s.startsWith(root + '/')) return s.slice(root.length + 1);
    }
    const legacyMatch = s.match(LEGACY_WORKTREE_RE);
    if (legacyMatch) return s.slice(legacyMatch[0].length);
    if (s.startsWith('./')) return s.slice(2);
    return s;
  } catch {
    return null;
  }
}

// True when `token` (already stripped of any surrounding backticks) is shaped like a path: at
// least one letter (a bare number or dotted-number-quad is never a path -- see the IPv4 note on
// classifyColonToken below, and this is the same rule that keeps a coverage ratio like "0:1" or a
// clock time like "07:44" from ever being mistaken for one here), and either contains a '/' or
// ends in a filename-with-extension shape ("domain-types.ts", no slash needed for a same-directory
// reference).
function looksLikePath(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  // A URL is never a repo path, and letting one count as a path candidate is a FALSE NEGATIVE
  // cause, not merely noise: attribution rule 2 takes the nearest path-looking token earlier on
  // the line, so a plan line like "Per https://github.com/x/y the block at lines 223-228 changes."
  // under a `### 4. `src/foo.ts`` heading attributes that span to the URL and the real file never
  // receives it. The '://' test is deliberately narrow -- it excludes the scheme-bearing shape and
  // nothing else, so a genuine path is never lost to it.
  if (token.indexOf('://') !== -1) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  if (token.indexOf('/') !== -1) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(token);
}

function isIPv4Shaped(token) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(token);
}

// classifyColonToken(token) -- the colon-scan's own per-token verdict, distinct from the more
// general looksLikePath above because the measured rule for THIS scanner is spelled out exactly:
// 'path' only when the token contains a '/' or '.', contains a letter, and is not four
// dot-separated numbers (an IPv4 address, or an IPv4:port citation, would otherwise slip through
// the '.' + digits shape -- the letter requirement alone already excludes a bare IP, this is
// belt-and-braces for the exact shape the corpus measurement called out).
function classifyColonToken(token) {
  if (token === '') return null;
  const hasSlashOrDot = token.indexOf('/') !== -1 || token.indexOf('.') !== -1;
  const hasLetter = /[A-Za-z]/.test(token);
  if (hasSlashOrDot && hasLetter && !isIPv4Shaped(token)) return 'path';
  return null;
}

// extractPathTokens(text) -- every path-looking token in `text`, in left-to-right order, as
// {text, index}. Backtick-quoted spans are tried first (148 of 185 heading paths in the corpus
// are fenced) and bare whitespace-delimited words second, skipping anything already inside a
// backtick span so a path is never double-counted. Common trailing punctuation ("(", ")", ",",
// trailing "." or ":") is stripped off a bare word before the looksLikePath test, since prose
// routinely follows a bare path with a comma or a closing paren.
function extractPathTokens(text) {
  if (typeof text !== 'string') return [];
  const tokens = [];
  const backtickRanges = [];
  const backtickRe = /`([^`]*)`/g;
  let m;
  while ((m = backtickRe.exec(text))) {
    const raw = m[1].trim();
    if (looksLikePath(raw)) tokens.push({ text: raw, index: m.index });
    backtickRanges.push([m.index, m.index + m[0].length]);
  }
  const wordRe = /[^\s`]+/g;
  while ((m = wordRe.exec(text))) {
    const insideBacktick = backtickRanges.some(([s, e]) => m.index >= s && m.index < e);
    if (insideBacktick) continue;
    const stripped = m[0].replace(/^[("',.]+/, '').replace(/[)"',.:;]+$/, '');
    if (looksLikePath(stripped)) tokens.push({ text: stripped, index: m.index });
  }
  tokens.sort((a, b) => a.index - b.index);
  return tokens;
}

// toSafeInt(digits) -- a decimal-digit string to a safe positive integer, or null. Mirrors
// invariants.js's parseLineSpec: parseInt on an absurdly long digit string overflows to Infinity,
// which must be rejected rather than handed to a caller (or round-tripped through JSON, which
// silently turns it into `null`).
function toSafeInt(digits) {
  if (typeof digits !== 'string' || !/^\d+$/.test(digits)) return null;
  const n = parseInt(digits, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

// buildPlanSpan(startDigits, endDigits) -- {start, end} from a scanner's captured digit groups
// (endDigits may be undefined -- a single-number citation means start === end), or null for any
// non-safe-positive-integer or reversed (end < start) range.
function buildPlanSpan(startDigits, endDigits) {
  const start = toSafeInt(startDigits);
  if (start === null) return null;
  const end = endDigits === undefined || endDigits === null ? start : toSafeInt(endDigits);
  if (end === null) return null;
  if (end < start) return null;
  return { start, end };
}

// attributeSpan(line, matchIndex, headingPaths, worktreeRoot) -- which file(s) a syntax-less
// (bare-colon or prose) span on `line` belongs to, per the module's attribution order:
//   2. the nearest path-looking token appearing EARLIER on the same line (attributeSpan's own
//      job for the 'path' syntax never reaches here -- that case is attributed directly by its
//      own attached path), or else
//   3. every path named in the nearest ancestor heading that names at least one, or else
//   4. unattributed (dropped -- returns []).
function attributeSpan(line, matchIndex, headingPaths, worktreeRoot) {
  const before = extractPathTokens(line.slice(0, matchIndex));
  if (before.length > 0) {
    const file = normalizePath(before[before.length - 1].text, worktreeRoot);
    return file !== null && file !== '' ? [file] : [];
  }
  const files = [];
  for (const p of headingPaths) {
    const file = normalizePath(p, worktreeRoot);
    if (file !== null && file !== '' && !files.includes(file)) files.push(file);
  }
  return files;
}

// extractPlanSpans(planMarkdown, worktreeRoot) -- every line-range `planMarkdown` names,
// attributed to a file, as {file, start, end, line, syntax}. `line` is the 1-based line number in
// the plan markdown the span was found on; `syntax` is 'path' (a path attached directly to the
// citation), 'bare' (a bare `:start-end` citation, e.g. inside backticks under a heading), or
// 'prose' ("lines N-M", any case, en/em dash or a plain hyphen, tolerating a bolded "**Lines
// N-M**"). Never throws -- see the module header's fail-open note.
function extractPlanSpans(planMarkdown, worktreeRoot) {
  const spans = [];
  try {
    if (typeof planMarkdown !== 'string' || planMarkdown === '') return spans;

    const lines = planMarkdown.split('\n');
    let headingPaths = [];
    let headingLevel = 0;

    for (let i = 0; i < lines.length; i++) {
      if (spans.length >= MAX_PLAN_SPANS) break;
      const rawLine = lines[i];
      const line = rawLine.length > MAX_SCAN_LINE_LENGTH ? rawLine.slice(0, MAX_SCAN_LINE_LENGTH) : rawLine;
      const lineNumber = i + 1;

      // A heading line can ALSO carry its own span (the #491 shape: a bare `(:906-913)` citation
      // in the same heading that names the file) -- so this line is still scanned below, never
      // skipped.
      //
      // "Nearest ANCESTOR heading that names a path" is meant literally, and markdown heading
      // LEVEL is the only thing that separates an ancestor from a sibling. A path-less heading
      // DEEPER than the one that set the current context (`#### Change A` under `### 1. <file>`)
      // is a subsection of it and inherits its paths; a path-less heading at the SAME or a
      // SHALLOWER level (`### 3. Tests` after `### 2. <file>`) is a new section that ends it, and
      // must clear the context rather than carry it.
      //
      // Carrying across a sibling was measured, over the 58-card journal corpus, to produce
      // exactly two findings -- 509/INV-3 and 491/INV-9 -- and BOTH were attributed to the wrong
      // file: in #509 the `:258-280` under `### 3. Tests` belongs to the test file named two
      // lines above it, not to the `MailPanel.tsx` of `### 2.`; in #491 the `:82-107` under
      // `## Why this satisfies the criterion` is an ASP line range, not the test file of `### 6.`.
      // Clearing on a sibling loses no finding anywhere else in the corpus. A wrong-file flag is
      // the one error this design cannot absorb: a flag is consulted only when its invariant
      // BREAKS at CHECK, so a flag attributed to a file the plan never ordered changed can
      // relieve a break it has no business relieving.
      const headingMatch = line.match(HEADING_RE);
      if (headingMatch) {
        const level = line.match(/^#+/)[0].length;
        const paths = extractPathTokens(headingMatch[1]).map((t) => t.text);
        if (paths.length > 0) {
          headingPaths = paths;
          headingLevel = level;
        } else if (level <= headingLevel) {
          headingPaths = [];
          headingLevel = 0;
        }
      }

      COLON_SPAN_RE.lastIndex = 0;
      let cm;
      while ((cm = COLON_SPAN_RE.exec(line))) {
        if (spans.length >= MAX_PLAN_SPANS) break;
        const token = cm[1];
        const planSpan = buildPlanSpan(cm[2], cm[3]);
        if (!planSpan) continue;

        if (token !== '') {
          if (classifyColonToken(token) !== 'path') continue;
          const file = normalizePath(token, worktreeRoot);
          if (file === null || file === '') continue;
          spans.push({
            file: file.slice(0, MAX_FIELD_LENGTH),
            start: planSpan.start,
            end: planSpan.end,
            line: lineNumber,
            syntax: 'path',
          });
          continue;
        }

        // Empty captured token: a 'bare' candidate only when the character immediately before
        // the colon is neither a digit nor a space -- without this guard, a clock time ("07:44",
        // whose non-empty "07" token is already excluded above by classifyColonToken having
        // nothing to classify it as) or ordinary prose ending "... at :30" would be captured.
        // Since the colon-span regex is greedy on the token, an empty token here means the
        // character right before the colon was never a valid token character at all (typically a
        // backtick or an opening paren), which is exactly the shape a bare `:223-228` citation
        // has in the corpus.
        const prevChar = cm.index > 0 ? line[cm.index - 1] : '';
        if (/[0-9 ]/.test(prevChar)) continue;

        for (const file of attributeSpan(line, cm.index, headingPaths, worktreeRoot)) {
          if (spans.length >= MAX_PLAN_SPANS) break;
          spans.push({
            file: file.slice(0, MAX_FIELD_LENGTH),
            start: planSpan.start,
            end: planSpan.end,
            line: lineNumber,
            syntax: 'bare',
          });
        }
      }

      PROSE_SPAN_RE.lastIndex = 0;
      let pm;
      while ((pm = PROSE_SPAN_RE.exec(line))) {
        if (spans.length >= MAX_PLAN_SPANS) break;
        const planSpan = buildPlanSpan(pm[2], pm[3]);
        if (!planSpan) continue;
        for (const file of attributeSpan(line, pm.index, headingPaths, worktreeRoot)) {
          if (spans.length >= MAX_PLAN_SPANS) break;
          spans.push({
            file: file.slice(0, MAX_FIELD_LENGTH),
            start: planSpan.start,
            end: planSpan.end,
            line: lineNumber,
            syntax: 'prose',
          });
        }
      }
    }
  } catch {
    return spans;
  }
  return spans;
}

// detectSpanConflicts({planMarkdown, invariants, worktreeRoot}) -- the freeze-vs-order-changed
// check itself. `invariants` is buildBaseline's own `.invariants` row shape (or an older,
// span-less shape journalled before this action existed -- see the module header). For each
// invariant with a resolvable span (its RESOLVED `span` when present, else `declaredSpan` -- a
// fact IMPLEMENT already broke is not one PLAN's own prose gets to also excuse), every plan span
// naming the SAME normalized file (strict equality, no basename fallback) is checked for overlap
// (`planStart <= invEnd && invStart <= planEnd`); the first such plan span by ascending line
// number becomes the one finding for that invariant. Never throws.
function detectSpanConflicts(options) {
  const findings = [];
  try {
    const opts = options && typeof options === 'object' ? options : {};
    const invariantList = Array.isArray(opts.invariants) ? opts.invariants : [];
    if (invariantList.length === 0) return findings;

    const planSpans = extractPlanSpans(opts.planMarkdown, opts.worktreeRoot);
    if (planSpans.length === 0) return findings;

    // Grouped by normalized file so the per-invariant scan below only ever walks the plan spans
    // that could possibly match it -- O(invariants + planSpans) rather than O(invariants x
    // planSpans) against every OTHER file's spans too.
    const spansByFile = new Map();
    for (const s of planSpans) {
      if (!spansByFile.has(s.file)) spansByFile.set(s.file, []);
      spansByFile.get(s.file).push(s);
    }

    for (const inv of invariantList) {
      if (findings.length >= MAX_FINDINGS) break;
      if (!inv || typeof inv !== 'object') continue;

      const invSpan = inv.span || inv.declaredSpan;
      if (
        !invSpan ||
        typeof invSpan !== 'object' ||
        !Number.isSafeInteger(invSpan.start) ||
        !Number.isSafeInteger(invSpan.end)
      ) {
        continue;
      }

      const file = normalizePath(inv.file, opts.worktreeRoot);
      if (file === null) continue;
      const candidates = spansByFile.get(file);
      if (!candidates || candidates.length === 0) continue;

      let best = null;
      for (const ps of candidates) {
        if (ps.start <= invSpan.end && invSpan.start <= ps.end) {
          if (best === null || ps.line < best.line) best = ps;
        }
      }
      if (!best) continue;

      findings.push({
        id: typeof inv.id === 'string' ? inv.id.slice(0, MAX_FIELD_LENGTH) : inv.id,
        file,
        invariantSpan: { start: invSpan.start, end: invSpan.end },
        planSpan: { start: best.start, end: best.end },
        planLine: best.line,
        syntax: best.syntax,
      });
    }
  } catch {
    return findings;
  }
  return findings;
}

module.exports = {
  normalizePath,
  extractPlanSpans,
  detectSpanConflicts,
};
