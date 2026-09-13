'use strict';
// Shared pinned-anchor resolver -- action 11.1 (#206). There is exactly ONE citation-target
// resolver in this repo's test suite: it lived inline in test/doc-constant-sweep.test.js and is
// moved here verbatim (resolveIn/findByBasename/trackedFiles/resolveCitationTarget), so that file
// and action 11.3's test/-comment-citation sweep both call the same function instead of each
// carrying a copy that could drift. See doc-constant-sweep.test.js's own header (part 2) for the
// incident this resolver already fixes (a nested abandoned worktree shadowing the real product
// file) -- nothing about that logic changes here, only its address.
//
// This module ALSO adds the pinned-anchor check itself (resolvePins): part 2.5's own anchor
// check (doc-constant-sweep.test.js) verifies a citation by asking "does SOME code-shaped
// identifier named nearby also appear somewhere in the cited range" -- deliberately loose, and
// blind by construction to a range citation drifting by one line (a 15-line window still contains
// the same identifier after a +/-1 shift). A PIN is the opposite kind of check: it stores the
// literal text of the cited line(s), read once by a human, and compares it EXACTLY (trimmed, no
// fuzzy match, no "anywhere in the span") against either the real working tree (`at: 'HEAD'`) or a
// frozen commit (`at: '<sha>'`). A pin can discriminate a +/-1 drift on a RANGE, which the anchor
// check structurally cannot -- see this action's own mutation-proof tests for the measurement.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { gitEnv: defaultGitEnv } = require('./helpers');

const REPO_ROOT = path.join(__dirname, '..');
const PRODUCT_REPO = process.env.SPO_PRODUCT_REPO || path.join(os.homedir(), 'SPO-WebClient');
const DEPLOY_REPO = process.env.SPO_DEPLOY_REPO || path.join(os.homedir(), 'SPO-Deploy');

// ---- the one path resolver (moved verbatim from doc-constant-sweep.test.js) --------------------

const _trackedCache = new Map();
function trackedFiles(root) {
  if (_trackedCache.has(root)) return _trackedCache.get(root);
  let list = [];
  try {
    list = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: defaultGitEnv() })
      .split('\n')
      .filter(Boolean);
  } catch {
    list = [];
  }
  _trackedCache.set(root, list);
  return list;
}

function findByBasename(name, root) {
  return trackedFiles(root)
    .filter((rel) => path.basename(rel) === name)
    .map((rel) => path.join(root, rel));
}

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

// resolveCitationTarget(filePath, roots?) -- E1, minimally: this repo first, then the product
// repo (with a leading "SPO-WebClient/" stripped), then SPO-Deploy the same way. `roots`
// defaults to this module's own REPO_ROOT/PRODUCT_REPO/DEPLOY_REPO -- resolvePins passes its own
// (possibly overridden) `repoRoots` through here so a hermetic fixture test's `repoRoots.product`
// pointing at a missing directory is actually HONOURED by path resolution, not just by the
// batched git reads further down; fix pass 11.1 (D5/D8b): before this, resolveCitationTarget
// always read the module-level constants regardless of what a caller passed as `repoRoots`, so a
// 'HEAD' product pin under an overridden (missing) product root still silently resolved against
// and read the REAL product repo on disk.  Returns one of:
//   { target, root: 'repo' | 'product' | 'deploy' }
//   { target: null, root: 'product-absent' | 'deploy-absent' }  -- never treated as a pass
//   { target: null, root: null }                                -- resolved nowhere; dangling
function resolveCitationTarget(filePath, roots) {
  const r = roots || { repo: REPO_ROOT, product: PRODUCT_REPO, deploy: DEPLOY_REPO };
  const local = resolveIn(r.repo, filePath);
  if (local && local.ambiguous) return { target: null, root: 'repo', ambiguous: local.ambiguous };
  if (local) return { target: local.target, root: 'repo' };
  const productPath = filePath.replace(/^SPO-WebClient\//, '');
  if (!fs.existsSync(r.product)) return { target: null, root: 'product-absent' };
  const product = resolveIn(r.product, productPath);
  if (product && product.ambiguous) return { target: null, root: 'product', ambiguous: product.ambiguous };
  if (product) return { target: product.target, root: 'product' };
  const deployPath = filePath.replace(/^SPO-Deploy\//, '');
  if (!fs.existsSync(r.deploy)) return { target: null, root: 'deploy-absent' };
  const deploy = resolveIn(r.deploy, deployPath);
  if (deploy && deploy.ambiguous) return { target: null, root: 'deploy', ambiguous: deploy.ambiguous };
  if (deploy) return { target: deploy.target, root: 'deploy' };
  return { target: null, root: null };
}

// ---- the pinned-anchor resolver ------------------------------------------------------------

// parseCitation("path/to/file.ext:12-34") -> { file, start, stop, isRange } (stop === start and
// isRange === false for a single line; isRange is keyed on whether the citation STRING actually
// wrote a "-stop" suffix, never on start !== stop numerically, so a degenerate "foo.js:10-10"
// range still counts as a range for the pin-shape check in resolvePins (D4, fix pass 11.1).
function parseCitation(citation) {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(citation);
  if (!m) throw new Error(`citation-pins: cannot parse citation "${citation}"`);
  return { file: m[1], start: Number(m[2]), stop: Number(m[3] || m[2]), isRange: m[3] !== undefined };
}

// shiftedCitation -- builds a NEW citation string with start/stop each moved by the given delta.
// Exported so a mutation-proof test (this action's own, and action 11.3's) can plant a "the doc's
// line number moved but the pinned text did not" drift without hand-formatting the citation
// string itself. `stopDelta` defaults to `startDelta` (a pure whole-range shift, or the only shift
// a single-line citation can have, since start === stop there by construction).
function shiftedCitation(citation, startDelta, stopDelta = startDelta) {
  const { file, start, stop } = parseCitation(citation);
  const newStart = start + startDelta;
  const newStop = stop + stopDelta;
  return newStart === newStop ? `${file}:${newStart}` : `${file}:${newStart}-${newStop}`;
}

// batchCatFile(rootDir, specs, env) -- ONE `git cat-file --batch` process for every frozen blob
// this call needs from `rootDir`, whatever commit each spec names (a repo with pins frozen at two
// different shas still costs one process, one round trip -- `git cat-file --batch` accepts any
// number of "<object>" lines on stdin and answers each in request order). Measured motivation
// (see this action's own spec): ~12ms for one batched call across a repo's pins vs ~342ms for the
// same count of separate `git show` spawns.
//
// `specs` is an array of "<sha>:<relPath>" strings. Returns a Map from spec to
// `{ content }` or `{ missing: true }`.
function batchCatFile(rootDir, specs, env) {
  const result = new Map();
  if (specs.length === 0) return result;
  const input = Buffer.from(specs.join('\n') + '\n', 'utf8');
  let output;
  try {
    output = execFileSync('git', ['-C', rootDir, 'cat-file', '--batch'], {
      input,
      maxBuffer: 256 * 1024 * 1024,
      env: env,
    });
  } catch (e) {
    // The whole repo/process failed (e.g. not a git repo at all) -- every spec in this batch is
    // unresolvable; never a silent pass (E1 posture, same as resolveCitationTarget's own).
    for (const spec of specs) result.set(spec, { missing: true, error: e.message });
    return result;
  }
  let offset = 0;
  for (const spec of specs) {
    const nl = output.indexOf(10, offset); // '\n'
    if (nl === -1) {
      result.set(spec, { missing: true, error: 'truncated git cat-file --batch output' });
      break;
    }
    const header = output.slice(offset, nl).toString('utf8');
    offset = nl + 1;
    if (header.endsWith(' missing')) {
      result.set(spec, { missing: true });
      continue;
    }
    const parts = header.split(' '); // "<sha> <type> <size>"
    const size = Number(parts[2]);
    const content = output.slice(offset, offset + size).toString('utf8');
    offset += size + 1; // the batch stream appends one more '\n' after the object's own bytes
    result.set(spec, { content });
  }
  return result;
}

function rootDirFor(repoRoots, rootName) {
  if (rootName === 'repo') return repoRoots.repo;
  if (rootName === 'product') return repoRoots.product;
  if (rootName === 'deploy') return repoRoots.deploy;
  return null;
}

// truncateForMessage(text) -- shortens text embedded in a human-facing failure string (D8f, fix
// pass 11.1): a pinned line can be enormous (a markdown table row collapsed onto one physical
// line, e.g. doc/state-machine-spec.md's own ~12KB FINISH row) and a mismatch used to print the
// full text twice, once as "expected" and once as "found". Comparisons never call this -- only
// message-building does.
function truncateForMessage(text, max = 200) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// computeMovedTo -- where `pin.first` (and `pin.last`, for a range) now occur in `lines`, ONLY if
// each occurs exactly once in the file: a non-unique match (a blank line, a lone `}`) cannot say
// where the citation moved TO, so this returns null rather than guessing. Format: "N" for a
// single line, "N-M" for a range whose two texts are now on different lines (or "N" if, oddly,
// both land on the same one).
function computeMovedTo(lines, pin) {
  const wantFirst = pin.first.trim();
  const firstHits = [];
  lines.forEach((l, idx) => { if (l.trim() === wantFirst) firstHits.push(idx + 1); });
  if (pin.last === undefined) {
    return firstHits.length === 1 ? String(firstHits[0]) : null;
  }
  const wantLast = pin.last.trim();
  const lastHits = [];
  lines.forEach((l, idx) => { if (l.trim() === wantLast) lastHits.push(idx + 1); });
  if (firstHits.length !== 1 || lastHits.length !== 1) return null;
  return firstHits[0] === lastHits[0] ? String(firstHits[0]) : `${firstHits[0]}-${lastHits[0]}`;
}

// resolvePins(pins, { repoRoots, gitEnv }) -> [{ pin, ok, actualFirst, actualLast, why, movedTo, lineCount }]
//
// pins: [{ file, citation, at, first, last? }] -- see this action's spec for the shape.
// repoRoots: { repo, product, deploy } absolute paths -- defaults to this module's own
//   REPO_ROOT/PRODUCT_REPO/DEPLOY_REPO; a caller overrides only for a hermetic fixture test.
// gitEnv: () => env object for every git spawn -- defaults to helpers.js's gitEnv (strips
//   inherited GIT_* vars; see helpers.js for the incident that makes this load-bearing).
//
// `lineCount` is not part of this action's own spec'd return shape but is included anyway (a
// pure addition, never a field a caller needs to ignore) -- the corpus-wide mutation-proof tests
// need it to know how far a citation can be shifted before running off either end of the file,
// and computing it a second way (a fresh read per pin) would risk it disagreeing with the read
// this function already did.
function resolvePins(pins, opts = {}) {
  const repoRoots = opts.repoRoots || { repo: REPO_ROOT, product: PRODUCT_REPO, deploy: DEPLOY_REPO };
  const gitEnvFn = opts.gitEnv || defaultGitEnv;

  const meta = new Array(pins.length);
  const frozenByRoot = new Map(); // rootDir -> Set(spec)

  pins.forEach((pin, i) => {
    let parsed;
    try {
      parsed = parseCitation(pin.citation);
    } catch (e) {
      meta[i] = { why: e.message };
      return;
    }
    // D4 (fix pass 11.1): a range pin with no `last` used to pass on `first` alone -- deleting
    // `last` from any range pin in the data file shipped green, and the mutation-proof test then
    // silently treated the pin as a single line (only ever planting a +/-1 drift, never the four
    // range-edge variants). Never let the shape go unchecked: a RANGE citation (the string wrote
    // "-stop") must carry `last`; a SINGLE-LINE citation must not.
    if (parsed.isRange && pin.last === undefined) {
      meta[i] = { why: `${pin.file} :: ${pin.citation} -- this citation is a RANGE but the pin has no \`last\` -- every range pin must pin both the first and last line` };
      return;
    }
    if (!parsed.isRange && pin.last !== undefined) {
      meta[i] = { why: `${pin.file} :: ${pin.citation} -- this citation is a SINGLE LINE but the pin carries a \`last\` -- a single-line pin must not have one` };
      return;
    }
    // D1 (fix pass 11.2, driver decision, #206): an optional `path` field disambiguates a
    // citation whose bare filename is ambiguous under resolveCitationTarget -- e.g. `README.md:34`
    // naming the repo ROOT README when `orchestrator/README.md`, `prompts/README.md` and a test
    // fixture also share that bare basename. Probed: a consistent wrong re-pin of an allowlisted
    // ambiguous citation (`README.md:37` -> `:38`, doc text and CITATION_ALLOWLIST/CCA_ALLOWLIST-
    // style entry moved together) shipped green 74/74 under the old "allowlist it" posture, since
    // an allowlisted citation is never content-checked at all. `path` closes that: it is accepted
    // ONLY when all three hold, checked in this order so a refusal names which one failed:
    //   1. the cited bare name IS ambiguous under the resolver (a `path` on an already-unambiguous
    //      citation is refused -- allowing it would let `path` silently mask a real "this citation
    //      now names a different file" drift instead of failing on it);
    //   2. `path.basename(pin.path)` equals the citation's own bare cited name (a mismatched
    //      basename would let `path` silently repoint a citation at an unrelated file);
    //   3. `pin.path` contains a "/" -- so resolveCitationTarget's own slash branch resolves it
    //      directly against `fs.existsSync`, never re-entering the ambiguous-basename search a
    //      bare `path: 'README.md'` would fall straight back into (the exact trap this field
    //      exists to route around; the fix is `path: './README.md'` or any real relative path).
    let resolved;
    if (pin.path !== undefined) {
      const bareResolved = resolveCitationTarget(parsed.file, repoRoots);
      if (!bareResolved.ambiguous) {
        meta[i] = { why: `${pin.file} :: ${pin.citation} -- has a \`path\` ("${pin.path}") but its bare name "${parsed.file}" is not ambiguous under the resolver; \`path\` may only disambiguate an ambiguous basename` };
        return;
      }
      if (path.basename(pin.path) !== parsed.file) {
        meta[i] = { why: `${pin.file} :: ${pin.citation} -- \`path\` ("${pin.path}") basename does not match the cited name "${parsed.file}"` };
        return;
      }
      if (!pin.path.includes('/')) {
        meta[i] = { why: `${pin.file} :: ${pin.citation} -- \`path\` ("${pin.path}") has no "/" -- a bare basename resolves ambiguously again; use "./${pin.path}" or a real relative path` };
        return;
      }
      resolved = resolveCitationTarget(pin.path, repoRoots);
    } else {
      resolved = resolveCitationTarget(parsed.file, repoRoots);
    }
    if (resolved.root === 'product-absent') {
      meta[i] = { why: `${pin.file} :: ${pin.citation} -- cannot verify, ${repoRoots.product} is not on disk (E1: never a silent pass)` };
      return;
    }
    if (resolved.root === 'deploy-absent') {
      meta[i] = { why: `${pin.file} :: ${pin.citation} -- cannot verify, ${repoRoots.deploy} is not on disk (E1: never a silent pass)` };
      return;
    }
    if (resolved.ambiguous) {
      meta[i] = { why: `${pin.file} :: ${pin.citation} -- ambiguous basename in the ${resolved.root} repo: ${resolved.ambiguous.join(', ')}` };
      return;
    }
    if (!resolved.target) {
      meta[i] = { why: `${pin.file} :: ${pin.citation} -- does not resolve in any known repo` };
      return;
    }
    const rootDir = rootDirFor(repoRoots, resolved.root);
    if (!rootDir) {
      meta[i] = { why: `${pin.file} :: ${pin.citation} -- resolved to unknown root "${resolved.root}"` };
      return;
    }
    const relPath = path.relative(rootDir, resolved.target);
    meta[i] = { parsed, rootDir, relPath, target: resolved.target };
    if (pin.at !== 'HEAD') {
      const spec = `${pin.at}:${relPath}`;
      meta[i].spec = spec;
      if (!frozenByRoot.has(rootDir)) frozenByRoot.set(rootDir, new Set());
      frozenByRoot.get(rootDir).add(spec);
    }
  });

  const blobsByRoot = new Map();
  for (const [rootDir, specSet] of frozenByRoot) {
    blobsByRoot.set(rootDir, batchCatFile(rootDir, [...specSet], gitEnvFn()));
  }

  return pins.map((pin, i) => {
    const m = meta[i];
    if (m.why) return { pin, ok: false, why: m.why };

    let text;
    if (pin.at === 'HEAD') {
      try {
        text = fs.readFileSync(m.target, 'utf8');
      } catch (e) {
        return { pin, ok: false, why: `${pin.file} :: ${pin.citation} -- cannot read working tree file ${m.target}: ${e.message}` };
      }
    } else {
      const entry = blobsByRoot.get(m.rootDir).get(m.spec);
      if (!entry || entry.missing) {
        return {
          pin,
          ok: false,
          why: `${pin.file} :: ${pin.citation} -- ${m.spec} is missing (the frozen commit or the path within it does not exist)${entry && entry.error ? `: ${entry.error}` : ''}`,
        };
      }
      text = entry.content;
    }

    // D8a (fix pass 11.1): text.split('\n') on a file ending with a trailing newline (almost
    // every real file) produces one PHANTOM empty element after the last real line --
    // "a\nb\n".split('\n') is ['a', 'b', ''], not ['a', 'b']. Left uncorrected, `lineCount` was
    // inflated by one, so a citation one line PAST the real end of file (e.g. `verdict.ts:217` on
    // a 216-line file) passed bounds and could even "match" a pin whose `first` is `""`. Popping
    // exactly one trailing empty element, and ONLY when the text actually ends in '\n', restores
    // the same count a real reader (or `wc -l`) would give -- a file that ends "...\n\n" (a real
    // trailing BLANK line) still keeps that blank line; only the phantom split artifact goes.
    const rawLines = text.split('\n');
    if (text.endsWith('\n') && rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    const lines = rawLines;
    const lineCount = lines.length;
    const { start, stop } = m.parsed;
    const actualFirst = (lines[start - 1] !== undefined ? lines[start - 1] : '').trim();
    const wantFirst = pin.first.trim();
    let ok = start >= 1 && start <= lineCount && actualFirst === wantFirst;

    let actualLast;
    if (pin.last !== undefined) {
      actualLast = (lines[stop - 1] !== undefined ? lines[stop - 1] : '').trim();
      const wantLast = pin.last.trim();
      ok = ok && stop >= 1 && stop <= lineCount && actualLast === wantLast;
    }

    if (ok) return { pin, ok: true, actualFirst, actualLast, lineCount };

    const movedTo = computeMovedTo(lines, pin);
    const parts = [`${pin.file} :: ${pin.citation} @ ${pin.at}`];
    // D8f (fix pass 11.1): the MESSAGE truncates long text (a markdown table row can run to ~12KB
    // -- doc/state-machine-spec.md's own FINISH row, pinned live -- and a failure printed it twice,
    // once as "expected" and once as "found"). The COMPARISON above this point is always on the
    // full, untruncated text; only what gets embedded in a human-facing string is shortened.
    parts.push(`expected first line "${truncateForMessage(wantFirst)}", found "${truncateForMessage(actualFirst)}"`);
    if (pin.last !== undefined) parts.push(`expected last line "${truncateForMessage(pin.last.trim())}", found "${truncateForMessage(actualLast)}"`);
    if (movedTo) parts.push(`moved to :${movedTo}`);
    return { pin, ok: false, actualFirst, actualLast, why: parts.join(' -- '), movedTo, lineCount };
  });
}

module.exports = {
  REPO_ROOT,
  PRODUCT_REPO,
  DEPLOY_REPO,
  _trackedCache,
  trackedFiles,
  findByBasename,
  resolveIn,
  resolveCitationTarget,
  parseCitation,
  shiftedCitation,
  batchCatFile,
  resolvePins,
};
