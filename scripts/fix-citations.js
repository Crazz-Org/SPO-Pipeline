#!/usr/bin/env node
'use strict';
// fix-citations -- action 4 of the citation-verification migration (#206). Every time code shifts
// a pinned `at: 'HEAD'` citation's line number, TWO places currently need hand-editing to match:
// (1) test/citation-pins-data.js's own `citation:` field for that pin, and (2) the literal
// citation string inside the CITING file's own prose (see citation-pins-data.js's header comments
// for real examples of this dual edit already having happened by hand, e.g. the lock.js pin).
// Action 3 (test/citation-pins.js's resolvePins) already computes, for a HEAD pin whose anchor
// text still resolves -- uniquely, never on the ambiguous-fallback path -- at a different line than
// cited, a `correction: { file, start, stop, citation }` describing what the citation SHOULD say.
// This script turns that into the two edits, replacing the by-hand ritual with one command.
//
// Usage:
//   node scripts/fix-citations.js           # dry run (default) -- prints, writes nothing
//   node scripts/fix-citations.js --apply   # performs every rewrite this run found safe
//
// Algorithm, per HEAD pin with a `.correction`:
//   1. data file: exactly one line of test/citation-pins-data.js's own SOURCE TEXT must contain
//      both `file: "<pin.file>"` and `citation: "<oldCitation>"` (this repo's convention: one pin
//      per single-line object literal) -- only the `citation: "..."` substring on that line is
//      rewritten. Zero or 2+ matching lines is a REFUSAL: no write, reported, and the exit code
//      goes non-zero.
//   2. citing file: `pin.file`'s own raw text must contain `oldCitation` exactly once as a WHOLE
//      citation token -- a literal substring match that is not merely the PREFIX of a longer
//      citation (see findCitationOccurrences). 0 or 2+ such occurrences is the same kind of refusal.
//      So is that one occurrence being the TAIL of a longer path while the corrected citation's own
//      PATH text differs from the cited one's -- planCitingFileFix's leading-boundary guard, which
//      is where the "corrected path spelled differently" corruption is closed.
// The two rewrites for one pin are independent: one can succeed while the other refuses. Refused
// rewrites are never partially applied, in dry run or --apply.
//
// Exit code: 0 iff there was nothing to fix, or everything that needed fixing was fixed (--apply)
// or would be fixable (dry run) with zero refusals. Non-zero the moment there is at least one
// refusal -- this makes the script usable as a pre-flight check (clean exit => safe to --apply).
//
// --data-file=PATH and --repo-root=PATH are narrow overrides for the test suite ONLY
// (test/fix-citations.test.js): they point this script at a scratch, throwaway
// citation-pins-data.js-shaped module and a scratch repo root instead of this repo's own real
// files, so a test can never accidentally rewrite this repo's own tracked files. The production,
// no-arg path always resolves both against this script's own location -- one level up from
// scripts/, exactly the same convention test/citation-pins.js's own REPO_ROOT uses -- and is
// unaffected by these flags when they are absent.

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { apply: false, dataFile: null, repoRoot: null };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--data-file=')) args.dataFile = arg.slice('--data-file='.length);
    else if (arg.startsWith('--repo-root=')) args.repoRoot = arg.slice('--repo-root='.length);
    else {
      process.stderr.write(`fix-citations: unrecognized argument "${arg}"\n`);
      process.exit(2);
    }
  }
  return args;
}

// countOccurrences -- non-overlapping literal substring count. Its one caller is planDataFileFix's
// defensive same-line re-count, whose needle is the QUOTED `citation: "..."` form: the closing
// quote is itself the token boundary there (`citation: "foo.js:12"` is not a substring of
// `citation: "foo.js:123"`), so plain counting is exact for that needle. Prose citations carry no
// such delimiter and go through findCitationOccurrences below instead -- never through this.
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

// findCitationOccurrences -- indexes of every place `citation` occurs in `haystack` as a WHOLE
// citation token, never as the PREFIX of a longer one.
//
// Why this is not plain substring counting (measured 2026-09-14, verification of this action): a
// citation is `path:N` or `path:N-M`, and `foo.js:2` is a literal substring of `foo.js:23`. With
// plain counting, a citing file holding ONE unrelated `foo.js:23` and no standalone `foo.js:2`
// counts 1 occurrence, passes the "exactly once" gate, and gets rewritten in place -- turning a
// correct, unrelated citation into `foo.js:43` and reporting "rewrote 1 occurrence", exit 0. That
// is a silent corruption of a tracked file by a tool whose clean exit is meant to mean "safe".
//
// Only the TRAILING side is tightened here:
//   - trailing: a match immediately followed by a digit (`foo.js:23` for `foo.js:2`), or by `-`
//     then a digit (`foo.js:2-9` for `foo.js:2`), is a DIFFERENT citation. Rewriting inside it
//     always produces garbage. Excluded.
//   - leading: a match preceded by more path (`src/e2e/bench/worker.ts:482` for `worker.ts:482`)
//     is left alone here -- the SAME fact spelled with a longer path is a legitimate shape, and
//     tightening this side unconditionally would turn every such currently-correct rewrite into a
//     false refusal. The corruption risk that shape creates (a corrected citation's PATH spelled
//     differently from the cited one's own -- external audit, 2026-09-14 second pass: `m.relPath`
//     is the repo-root-relative resolved path, not necessarily how the citing prose itself spelled
//     it, so a bare `worker.ts:2` matching as the TAIL of prose's `sub/deep/worker.ts:2`, corrected
//     to the full `sub/deep/worker.ts:4`, would splice into `sub/deep/sub/deep/worker.ts:4`) is
//     closed one level up, in planCitingFileFix's own leading-boundary guard below -- which
//     applies the leading check ONLY to the case that can actually corrupt (the two citations'
//     path text disagreeing), and so keeps the legitimate longer-path case this comment exists to
//     protect.
//
// Accepted residual on the leading side (measured during verification of the audit fix,
// 2026-09-14 -- named rather than hidden, per doc/accepted-gaps.md's own convention): when the two
// citations' path TEXT agrees, a prose citation that merely ENDS with the pinned text is still
// rewritten, even if its longer path names a DIFFERENT file. Probed: a repo whose only tracked
// `worker.ts` is at the root, pinned as `worker.ts:2`, with prose citing an unrelated
// `vendor/worker.ts:2`, rewrites that unrelated citation's line number. This is the exact same
// mechanism as the legitimate case above -- distinguishing them would mean resolving the PROSE's
// own path against the repo and comparing targets, a larger design than this script has -- and it
// needs the registry pin's own citation text to occur nowhere standalone in the prose, a
// registry/prose divergence this repo's live-corpus citation sweep already fails on by name.
// Unchanged by, and older than, the audit fix below.
//
// Net effect on safety: strictly fewer wrong writes on the trailing side. A file holding both
// `foo.js:2` and `foo.js:23` used to count 2 and refuse; it now counts 1 and fixes the right one,
// which is the same answer a human would give -- `foo.js:23` is a different pin with its own
// registry entry.
function findCitationOccurrences(haystack, citation) {
  if (citation.length === 0) return [];
  const hits = [];
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(citation, idx);
    if (idx === -1) break;
    const after = haystack.slice(idx + citation.length, idx + citation.length + 2);
    const isPrefixOfLonger = /^[0-9]/.test(after) || /^-[0-9]/.test(after);
    if (!isPrefixOfLonger) hits.push(idx);
    idx += citation.length;
  }
  return hits;
}

// planDataFileFix -- finds the ONE line of `dataFilePath`'s current content (which may already
// carry earlier edits from prior pins in this same run, via `currentContent`) naming both
// `pin.file` and `oldCitation`, and rewrites only the `citation: "..."` substring on it.
function planDataFileFix(dataFilePath, currentContent, citingFile, oldCitation, newCitation) {
  const fileLiteral = JSON.stringify(citingFile);
  const oldCitationLiteral = JSON.stringify(oldCitation);
  const fileNeedle = `file: ${fileLiteral}`;
  const citationNeedle = `citation: ${oldCitationLiteral}`;

  const lines = currentContent.split('\n');
  const matchIdxs = [];
  lines.forEach((line, idx) => {
    if (line.includes(fileNeedle) && line.includes(citationNeedle)) matchIdxs.push(idx);
  });

  if (matchIdxs.length !== 1) {
    const reason =
      matchIdxs.length === 0
        ? `no line in ${dataFilePath} contains both ${fileNeedle} and ${citationNeedle}`
        : `${matchIdxs.length} lines in ${dataFilePath} contain both ${fileNeedle} and ${citationNeedle} -- ambiguous, refusing to guess which one`;
    return { refused: true, reason };
  }

  const idx = matchIdxs[0];
  const oldLine = lines[idx];
  // The line-level match already required `citationNeedle` to occur; re-count defensively in case
  // the same citation literal legitimately occurs twice on one matched line (unanticipated by the
  // registries' own one-pin-per-line convention, but never silently guessed at).
  const occurrencesOnLine = countOccurrences(oldLine, citationNeedle);
  if (occurrencesOnLine !== 1) {
    return {
      refused: true,
      reason: `matched line ${idx + 1} of ${dataFilePath} contains ${citationNeedle} ${occurrencesOnLine} times, expected exactly 1`,
    };
  }

  const newCitationLiteral = JSON.stringify(newCitation);
  const newLine = oldLine.replace(citationNeedle, `citation: ${newCitationLiteral}`);
  const newLines = lines.slice();
  newLines[idx] = newLine;
  return { refused: false, lineNumber: idx + 1, oldLine, newLine, newContent: newLines.join('\n') };
}

// citationPathOf -- the path portion of a citation string, with the trailing `:N` or `:N-M`
// stripped. The regex is anchored at the END and non-global, so it only ever strips the citation's
// own trailing line-number suffix: a path that itself carries a colon (`dir:2/file.js:10`) or ends
// in a `:N`-shaped basename (`weird:3.js:10`) keeps every character but that last suffix, matching
// parseCitation's own greedy `^(.+):(\d+)(?:-(\d+))?$` split exactly. Used only by
// planCitingFileFix's leading-boundary guard, immediately below.
function citationPathOf(citation) {
  return citation.replace(/:\d+(?:-\d+)?$/, '');
}

// PATH_CONTINUATION_CHAR -- a character that, sitting immediately before a citation match, means
// the match is the TAIL of a longer path token rather than a citation starting there. `/` and `\`
// are the separators; the rest are ordinary path-segment characters (`myworker.ts:2` must not be
// read as a standalone `worker.ts:2` either). Anything else -- a backtick, space, `(`, quote,
// newline, start of file -- is a delimiter, and the match really does start a whole path.
const PATH_CONTINUATION_CHAR = /[A-Za-z0-9_.~@+\-/\\]/;

// planCitingFileFix -- finds the one literal occurrence of `oldCitation` in `currentContent` (the
// citing file's own prose, possibly already edited earlier in this run) and replaces it.
//
// The leading-boundary guard (external audit, 2026-09-14 second pass -- a real corruption, not a
// theoretical one, reproduced against a scratch repo; then re-measured during verification of that
// fix). `correction.citation` is built from `m.relPath` (citation-pins.js), the repo-root-relative
// RESOLVED path -- NOT necessarily how the citing prose itself spelled the citation. Both halves
// of that matter, and they pull in opposite directions:
//   - When the two paths DISAGREE and the prose's match is the tail of a longer path, splicing
//     `newCitation` in at the match point duplicates path text instead of moving a line number:
//     prose `sub/deep/worker.ts:2`, pin `worker.ts:2`, correction `sub/deep/worker.ts:4` spliced
//     at the tail gives `sub/deep/sub/deep/worker.ts:4` -- a corrupted tracked file, reported as
//     "rewrote 1 occurrence", exit 0. That is the shape this guard refuses.
//   - When the two paths disagree but the prose's match STARTS a whole path token (the prose
//     spelled the citation bare, exactly as the registry pin does), the rewrite is correct -- it
//     just re-spells the citation in the resolved, fully-qualified form. This is not a corner
//     case: measured against this repo's own four real collateral re-pins, THREE of them (the
//     lock.js and intake.js pins in orchestrator/README.md, and the daemon.js pin in
//     orchestrator/dispatcher.js -- deliberately named without their line numbers, which re-pin)
//     are cited by BARE basename in BOTH the registry and the prose while resolving under
//     orchestrator/, so every correction to them changes the path text; only the bin/spo pin
//     (whose citation already carries a "/") keeps it. A flat path-equality refusal would
//     therefore refuse three of the four real drift shapes this script exists to automate -- and,
//     because the data-file half is a deliberately INDEPENDENT success (see this module's header
//     and the two independence tests in test/fix-citations.test.js), it would leave the registry
//     re-spelled while the prose still says the old text: a divergence
//     test-comment-citation-sweep's own "LIVE_RANGE_PINS/BLUNT_PINS cite exactly what the live
//     corpus text says today" check goes RED on (measured 2026-09-14 by re-spelling one real pin
//     and running the suite: 4 failures).
// So the leading side is tightened HERE, and only for the disagreeing-path case: same-path
// corrections keep findCitationOccurrences' deliberately loose leading side untouched.
function planCitingFileFix(citingFilePath, currentContent, oldCitation, newCitation) {
  const hits = findCitationOccurrences(currentContent, oldCitation);
  if (hits.length !== 1) {
    const reason =
      hits.length === 0
        ? `"${oldCitation}" does not occur anywhere in ${citingFilePath} as a whole citation (it may appear only as the prefix of a longer one -- a human needs to look)`
        : `"${oldCitation}" occurs ${hits.length} times in ${citingFilePath} -- ambiguous, refusing to guess which one`;
    return { refused: true, reason };
  }
  const idx = hits[0];
  const oldPath = citationPathOf(oldCitation);
  const newPath = citationPathOf(newCitation);
  if (oldPath !== newPath && idx > 0 && PATH_CONTINUATION_CHAR.test(currentContent[idx - 1])) {
    return {
      refused: true,
      reason:
        `the corrected citation's path ("${newPath}") is spelled differently from the cited ` +
        `one's own path ("${oldPath}"), and the one occurrence of "${oldCitation}" in ` +
        `${citingFilePath} is preceded by path text ("${currentContent[idx - 1]}") -- it is the ` +
        `TAIL of a longer path, so splicing the corrected citation in there would duplicate path ` +
        `segments rather than move a line number; refusing rather than guessing`,
    };
  }
  const newContent = currentContent.slice(0, idx) + newCitation + currentContent.slice(idx + oldCitation.length);
  return { refused: false, newContent };
}

function planForPin(dataFilePath, repoRoot, contentCache, pin, correction) {
  const oldCitation = pin.citation;
  const newCitation = correction.citation;
  const entry = { pinFile: pin.file, oldCitation, newCitation };

  // ---- 1. test/citation-pins-data.js's own `citation:` field ----
  const dataCurrent = contentCache.has(dataFilePath) ? contentCache.get(dataFilePath) : fs.readFileSync(dataFilePath, 'utf8');
  const dataFix = planDataFileFix(dataFilePath, dataCurrent, pin.file, oldCitation, newCitation);
  entry.dataFile = { path: dataFilePath, ...dataFix };
  if (!dataFix.refused) contentCache.set(dataFilePath, dataFix.newContent);

  // ---- 2. the citing file's own prose ----
  // Safety net matching this script's own constraint (never touch anything under .claude/, never
  // anything outside repoRoot): refused up front, same shape as every other refusal, rather than
  // reading/writing a path this script must never touch.
  const relPinFile = pin.file;
  const resolvedCitingPath = path.resolve(repoRoot, relPinFile);
  const withinRepo = resolvedCitingPath === repoRoot || resolvedCitingPath.startsWith(repoRoot + path.sep);
  const underClaudeDir = relPinFile === '.claude' || relPinFile.startsWith('.claude/') || relPinFile.startsWith('.claude' + path.sep);
  if (!withinRepo || underClaudeDir) {
    entry.citingFile = {
      refused: true,
      reason: `refusing to touch ${resolvedCitingPath} -- outside the repo root or under .claude/, never a valid rewrite target`,
    };
    return entry;
  }

  if (!fs.existsSync(resolvedCitingPath)) {
    entry.citingFile = { path: resolvedCitingPath, refused: true, reason: `citing file ${resolvedCitingPath} does not exist` };
    return entry;
  }

  const citingCurrent = contentCache.has(resolvedCitingPath)
    ? contentCache.get(resolvedCitingPath)
    : fs.readFileSync(resolvedCitingPath, 'utf8');
  const citingFix = planCitingFileFix(resolvedCitingPath, citingCurrent, oldCitation, newCitation);
  entry.citingFile = { path: resolvedCitingPath, ...citingFix };
  if (!citingFix.refused) contentCache.set(resolvedCitingPath, citingFix.newContent);

  return entry;
}

function printReport(entries, headPinCount, applied) {
  const lines = [];
  lines.push(`=== fix-citations report (${applied ? '--apply' : 'dry run'}) ===`);
  lines.push(`${headPinCount} at:'HEAD' pin(s) checked, ${entries.length} correction(s) found.`);
  lines.push('');

  let refusalCount = 0;
  entries.forEach((entry, i) => {
    lines.push(`[${i + 1}] ${entry.pinFile} :: ${entry.oldCitation} -> ${entry.newCitation}`);

    if (entry.dataFile.refused) {
      refusalCount++;
      lines.push(`    data file: REFUSED -- ${entry.dataFile.reason}`);
    } else {
      lines.push(
        `    data file (${entry.dataFile.path}): ${applied ? 'rewrote' : 'would rewrite'} line ${entry.dataFile.lineNumber}`
      );
    }

    if (entry.citingFile.refused) {
      refusalCount++;
      lines.push(`    citing file: REFUSED -- ${entry.citingFile.reason}`);
    } else {
      lines.push(`    citing file (${entry.citingFile.path}): ${applied ? 'rewrote' : 'would rewrite'} 1 occurrence`);
    }
    lines.push('');
  });

  if (entries.length === 0) {
    lines.push('Nothing to fix.');
  } else if (refusalCount === 0) {
    lines.push(applied ? 'Done -- 0 refusals.' : '0 refusals. Clean -- safe to run with --apply.');
  } else {
    lines.push(`${refusalCount} refusal(s). A human needs to look at the refused case(s) by hand.`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  return refusalCount;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const scriptRepoRoot = path.join(__dirname, '..');
  const repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : scriptRepoRoot;
  const dataFilePath = args.dataFile ? path.resolve(args.dataFile) : path.join(repoRoot, 'test', 'citation-pins-data.js');
  // resolvePins itself always lives in the real repo (this script's own location), never in a
  // scratch dir -- only the DATA it is fed, and the roots it resolves citations against, vary.
  const citationPinsPath = path.join(scriptRepoRoot, 'test', 'citation-pins.js');

  const { resolvePins } = require(citationPinsPath);
  const dataModule = require(dataFilePath);
  const allPins = [
    ...(dataModule.BENCH_PINS || []),
    ...(dataModule.LIVE_RANGE_PINS || []),
    ...(dataModule.BLUNT_PINS || []),
    ...(dataModule.CCA_PINS || []),
  ];
  const headPins = allPins.filter((p) => p.at === 'HEAD');

  const resolveOpts = {};
  if (args.repoRoot) {
    // A hermetic override: product/deploy point at directories that do not exist -- fine, since
    // every fixture citation resolves in `repo` and resolveCitationTarget never reaches the
    // product/deploy branches once the local (repo) resolution already succeeded (same convention
    // test/citation-pins-resolve-head.test.js's own fixtures use).
    resolveOpts.repoRoots = {
      repo: repoRoot,
      product: path.join(repoRoot, '__fix-citations-no-product__'),
      deploy: path.join(repoRoot, '__fix-citations-no-deploy__'),
    };
  }

  const results = resolvePins(headPins, resolveOpts);
  const withCorrection = results.filter((r) => r.correction);

  const contentCache = new Map(); // absolute path -> current in-memory content, threaded across pins
  const entries = withCorrection.map((r) => planForPin(dataFilePath, repoRoot, contentCache, r.pin, r.correction));

  if (args.apply) {
    for (const entry of entries) {
      if (!entry.dataFile.refused) fs.writeFileSync(entry.dataFile.path, entry.dataFile.newContent);
      if (!entry.citingFile.refused) fs.writeFileSync(entry.citingFile.path, entry.citingFile.newContent);
    }
  }

  const refusalCount = printReport(entries, headPins.length, args.apply);
  process.exitCode = refusalCount > 0 ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, planDataFileFix, planCitingFileFix, countOccurrences, findCitationOccurrences };
