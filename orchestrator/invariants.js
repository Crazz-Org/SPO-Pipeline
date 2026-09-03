'use strict';
// orchestrator/invariants.js -- action 1.8: the "invariant substring check" doc/state-machine-
// spec.md:140 has always promised (and prompts/plan.md has always told PLAN a downstream check
// would run) but that, until this action, never existed. This module is the whole of it: parse
// the invariants-<issue>.md file PLAN writes (per the block format prompts/plan.md now
// specifies), resolve each invariant's quote against a worktree via a substring test, and expose
// two entry points -- buildBaseline (called from handlePlan, PLAN time) and checkRegressions
// (called from steps/scripted.js's realCheck, CHECK time). Neither handler re-implements any of
// this; both just call in here.
//
// Pure `fs`, no spawning (requirement (d)) -- safe to unit-test without a daemon, a worktree, or
// even a real git repo, and safe to run from a *statelessly re-invoked* CHECK: verification
// re-reads the SAME invariants-<issue>.md file PLAN wrote (under journal/<id>/scratch, untouched
// by anything after PLAN) rather than needing the quote text threaded through the journal a
// second time -- the file itself is the one durable source for it, exactly the same "never a
// second source of truth" rule task-values.js's own header already documents for plan_path et al.
// Only the *resolved/mode* verdict per invariant id is journaled as the baseline (small, and
// enough for CHECK to know which ids it must not regress).
//
// ---- design: fail-open on parse, fail-closed only on a proven regression -----------------------
// - A PLAN-time invariant that does not resolve is a journalled warning, never a park -- PLAN is
//   not re-run over it, and it is simply excluded from the baseline (see buildBaseline), so CHECK
//   can never fail on it. This is the design's whole point: a PLAN that misquotes, or cites a
//   line it cannot actually resolve, must not cost a real DIAGNOSE/IMPLEMENT remediation cycle.
// - CHECK fails ONLY for an id that resolved at PLAN time and does not resolve now -- that is the
//   one and only regression this module reports: a fact IMPLEMENT was told to preserve has been
//   broken (cited file deleted, or the quote no longer present).
// - A missing/unparsable invariants file, at either PLAN or CHECK time, is journalled and treated
//   as "nothing to check" -- never accused, because we cannot know.
// - A cited path outside the worktree -- absolute, `../`-escaping, or reached through a symlink
//   that lives inside the worktree but points outside it -- is never read; treated as unresolved.
//
// ---- format (see prompts/plan.md's own "Invariant block format" section, which must describe
// exactly this) -----------------------------------------------------------------------------
//
//   ## INV-1
//   File: relative/path/to/file.ts:123
//   >>> QUOTE
//   exact verbatim text, any length, possibly multi-line, ``` backticks ``` included safely
//   >>> END QUOTE
//
// - `## INV-<n>` is the block's id line.
// - The next non-blank line is `File: <path>:<line>` or `File: <path>:<start>-<end>` -- the line
//   spec is citation metadata only, never used for matching (the check is a substring test over
//   the whole cited file's contents, not line-anchored -- IMPLEMENT is free to move a line within
//   a file without that alone counting as breaking the invariant).
// - Everything between a literal `>>> QUOTE` line and the next literal `>>> END QUOTE` line is
//   the quote, byte-for-byte (no trimming, no reflow) -- a delimiter that tolerates multi-line
//   content and a quote containing ``` backtick fences ```, which a triple-backtick-fenced quote
//   could not (a quote containing its own closing fence would truncate early).
// A block missing its `File:` line or its `>>> END QUOTE` marker is skipped -- reported in
// `issues`, never thrown -- and the rest of the file is still parsed. Zero recognized blocks is
// valid (a task with no invariants), not a parse error.

const fs = require('fs');
const path = require('path');

const HEADER_RE = /^##\s+(INV-\d+)\s*$/;
const FILE_RE = /^File:\s*(.+)$/;
const QUOTE_START = '>>> QUOTE';
const QUOTE_END = '>>> END QUOTE';

// Caps what a single cited file read will ever load into memory, regardless of how large the
// file on disk actually is (requirement (d): "a very large ... file must not blow up"). Generous
// for any real source file this pipeline touches; a file bigger than this that still doesn't
// contain the quote within its first slice is reported unresolved, not crashed on.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function normalizeWhitespace(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Splits "path:123" or "path:120-135" into {file, lineSpec} on the LAST ':' -- a repo-relative
// path is never expected to contain one, but splitting on the last occurrence rather than the
// first costs nothing and assumes less.
function splitFileLineSpec(spec) {
  const idx = spec.lastIndexOf(':');
  if (idx === -1) return { file: spec.trim(), lineSpec: null };
  return { file: spec.slice(0, idx).trim(), lineSpec: spec.slice(idx + 1).trim() };
}

// Parses `markdown` into {invariants: [{id, file, lineSpec, quote}], issues: [{id, reason}]}.
// Never throws. A malformed block (missing File: line, missing quote markers, or a repeated id)
// is skipped and named in `issues` rather than aborting the whole parse -- fail-open, per the
// module header. `invariants: []` with `issues: []` is the valid zero-invariants case.
function parseInvariantsMarkdown(markdown) {
  const lines = (markdown || '').split('\n');
  const invariants = [];
  const issues = [];
  const seenIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(HEADER_RE);
    if (!headerMatch) continue;
    const id = headerMatch[1];

    if (seenIds.has(id)) {
      issues.push({ id, reason: 'duplicate-id' });
      continue;
    }

    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    // `.trim()` before matching, for the same reason the two quote markers below are compared
    // trimmed: a CRLF-terminated invariants file leaves a trailing `\r` on every line, and
    // FILE_RE's `(.+)$` can never match it (`.` excludes \r, and `$` is not in multiline mode).
    // Without this, EVERY invariant in a CRLF file is silently dropped as 'missing-file-line'.
    const fileMatch = j < lines.length ? lines[j].trim().match(FILE_RE) : null;
    if (!fileMatch) {
      issues.push({ id, reason: 'missing-file-line' });
      seenIds.add(id);
      continue;
    }
    const { file, lineSpec } = splitFileLineSpec(fileMatch[1].trim());

    let k = j + 1;
    while (k < lines.length && lines[k].trim() === '') k++;
    if (k >= lines.length || lines[k].trim() !== QUOTE_START) {
      issues.push({ id, reason: 'missing-quote-start' });
      seenIds.add(id);
      continue;
    }

    let endIdx = -1;
    for (let m = k + 1; m < lines.length; m++) {
      if (lines[m].trim() === QUOTE_END) {
        endIdx = m;
        break;
      }
    }
    if (endIdx === -1) {
      issues.push({ id, reason: 'missing-quote-end' });
      seenIds.add(id);
      continue;
    }

    seenIds.add(id);
    const quote = lines.slice(k + 1, endIdx).join('\n');
    invariants.push({ id, file, lineSpec, quote });
    i = endIdx; // resume scanning right after this block
  }

  return { invariants, issues };
}

// True when repo-relative `relFile` stays inside `worktreeRoot` once resolved -- rejects an
// absolute path and any `../` that would escape the root. Requirement (d): "do not read [a file
// outside the worktree] ... do not let a plan point the reader at arbitrary filesystem paths."
function contains(root, candidate) {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(rootWithSep);
}

function isInsideWorktree(worktreeRoot, relFile) {
  if (!relFile || typeof relFile !== 'string' || path.isAbsolute(relFile)) return false;
  const resolvedRoot = path.resolve(worktreeRoot);
  const resolved = path.resolve(resolvedRoot, relFile);
  if (!contains(resolvedRoot, resolved)) return false;

  // `path.resolve` is purely lexical -- it does not follow symlinks -- so a symlink that lives
  // INSIDE the worktree but points outside it passes the lexical test above and would otherwise
  // be read. Re-check against the real paths. Both sides are realpath'd (the worktree root may
  // itself sit under a symlinked directory; comparing a real file path against a lexical root
  // would then reject every legitimate citation). If either side cannot be realpath'd -- the
  // cited file does not exist, a broken link, a permission error -- the lexical verdict stands
  // and the read that follows simply fails with 'file-unreadable'.
  try {
    return contains(fs.realpathSync(resolvedRoot), fs.realpathSync(resolved));
  } catch {
    return true;
  }
}

// Reads at most MAX_FILE_BYTES of `absFile` via a bounded fd read (not `fs.readFileSync` then
// slice, which still allocates the whole file first) -- caps memory regardless of the file's
// real size on disk. Returns null on any failure (missing, not a regular file, permission
// denied, ...); the caller treats null the same as "does not resolve", never as a thrown error.
function readCapped(absFile) {
  let fd;
  try {
    // O_NONBLOCK, not plain 'r': opening a FIFO for reading BLOCKS until a writer appears, and
    // this call is synchronous -- it would freeze the event loop, which means callWithDeadline's
    // own setTimeout can never fire either, hanging the daemon in CHECK with no park and no
    // recovery. With O_NONBLOCK the open returns at once and the isFile() guard below rejects it.
    fd = fs.openSync(absFile, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close -- a failure here must not shadow whatever the read already decided
      }
    }
  }
}

// Resolves one {file, quote} pair against `worktreeRoot`. Two match modes, tried in order
// (requirement (c)): (1) an exact substring of the file's contents; (2) a whitespace-normalized
// fallback (collapse whitespace runs on both sides) so indentation/reflow drift alone never
// produces a false regression. Returns {resolved, mode: 'exact'|'normalized'|null, reason?} --
// `reason` is set on every non-resolved outcome, for journaling.
function resolveInvariant(worktreeRoot, invariant) {
  const quote = (invariant && invariant.quote) || '';
  if (quote.trim() === '') return { resolved: false, mode: null, reason: 'empty-quote' };

  const file = invariant && invariant.file;
  if (!isInsideWorktree(worktreeRoot, file)) {
    return { resolved: false, mode: null, reason: 'outside-worktree' };
  }

  const content = readCapped(path.resolve(worktreeRoot, file));
  if (content === null) return { resolved: false, mode: null, reason: 'file-unreadable' };

  if (content.includes(quote)) return { resolved: true, mode: 'exact' };

  const normalizedQuote = normalizeWhitespace(quote);
  if (normalizedQuote !== '' && normalizeWhitespace(content).includes(normalizedQuote)) {
    return { resolved: true, mode: 'normalized' };
  }

  return { resolved: false, mode: null, reason: 'not-found' };
}

function readInvariantsFile(invariantsPath) {
  try {
    return fs.readFileSync(invariantsPath, 'utf8');
  } catch {
    return null;
  }
}

// Shared by buildBaseline (PLAN) and checkRegressions (CHECK) -- same read -> parse -> resolve
// pipeline, run at two different times against what may by then be two different worktree
// states. Never throws: a missing/unreadable invariants file reports `parseError` instead of an
// empty result silently pretending "zero invariants" (which IS a valid, different, outcome).
function resolveAll(worktreeRoot, invariantsPath) {
  const markdown = readInvariantsFile(invariantsPath);
  if (markdown === null) {
    return { parseError: 'invariants-file-unreadable', invariants: [], issues: [] };
  }

  const { invariants, issues } = parseInvariantsMarkdown(markdown);
  const resolved = invariants.map((inv) => {
    const r = resolveInvariant(worktreeRoot, inv);
    const row = { id: inv.id, file: inv.file, resolved: r.resolved, mode: r.mode };
    if (!r.resolved) row.reason = r.reason;
    return row;
  });

  return { parseError: null, invariants: resolved, issues };
}

// buildBaseline(worktreeRoot, invariantsPath) -- PLAN time. handlePlan calls this immediately
// after writing invariants-<issue>.md, in real mode, and journals the return value verbatim as
// the 'invariants-baseline' event. An invariant that does not resolve here is NOT an error --
// it is recorded with `resolved: false` and excluded from what checkRegressions will ever look
// at (requirement (a): "excluded from the baseline", never parked, never re-running PLAN).
function buildBaseline(worktreeRoot, invariantsPath) {
  return resolveAll(worktreeRoot, invariantsPath);
}

// checkRegressions(worktreeRoot, invariantsPath, baselineInvariants) -- CHECK time.
// `baselineInvariants` is PLAN's own `invariants-baseline` event's `.invariants` array (any
// shape is accepted defensively; only entries with `resolved === true` are ever re-checked, so a
// caller passing the raw, unfiltered array is safe). Re-parses the SAME invariants file (it is
// never rewritten after PLAN) and re-resolves each baseline id against the worktree as it stands
// now. Returns {parseError, broken: [{id, file}], checkedIds: [...]} -- `broken` is the complete
// and only list of regressions: an id that resolved at PLAN time and does not resolve now
// (requirement (b)). A missing/unparsable invariants file at CHECK time is the same fail-open
// rule as at PLAN time -- reported via `parseError`, `broken` always `[]` in that case, never a
// manufactured regression.
function checkRegressions(worktreeRoot, invariantsPath, baselineInvariants) {
  const now = resolveAll(worktreeRoot, invariantsPath);
  if (now.parseError) {
    return { parseError: now.parseError, broken: [], checkedIds: [] };
  }

  const nowById = new Map(now.invariants.map((inv) => [inv.id, inv]));
  const broken = [];
  const checkedIds = [];

  for (const base of baselineInvariants || []) {
    if (!base || base.resolved !== true) continue; // never part of the baseline in the first place
    checkedIds.push(base.id);
    const current = nowById.get(base.id);
    // Not resolving now, or the id no longer even parsing out of the (unchanged) invariants
    // file -- either way this is "cannot re-confirm what PLAN vouched for", the one regression
    // this module reports.
    if (!current || !current.resolved) {
      broken.push({ id: base.id, file: base.file });
    }
  }

  return { parseError: null, broken, checkedIds };
}

module.exports = {
  parseInvariantsMarkdown,
  isInsideWorktree,
  resolveInvariant,
  buildBaseline,
  checkRegressions,
};
