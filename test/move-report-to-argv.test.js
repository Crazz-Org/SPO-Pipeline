'use strict';
// A standing guard over `moveReportTo`'s own call-site shape, modelled directly on
// test/gh-api-argv.test.js's pattern: read the SOURCE of every orchestrator/**/*.js file rather
// than trust anyone to remember a convention by hand.
//
// action 3.1 (Lot 3): `moveReportTo` gained a 4th parameter, `journalRoot`, so its own
// swallowed-ENOENT branch (the source report vanished before the rename -- a race this repo has
// always tolerated, see auto-triage.js's own header on the function) can journal a distinct
// `report-move-source-missing` event instead of silently returning a `dest` that is not there, as
// if the move had succeeded. `journalRoot` LOOKS optional -- JavaScript does not enforce arity, so
// a 3-argument call does not crash -- but it is silently WORSE than it looks: `journalRoot` is
// `undefined`, `appendDaemonEvent(undefined, ...)` throws inside the branch's own try/catch (see
// that function's own header for why it must), and the throw is swallowed there, exactly as
// designed for a real journalling failure. The swallow itself still returns `null`, so the
// caller's return-value contract stays safe either way -- what actually goes missing is only the
// journal record, invisibly, and only this sweep can see that: four of this function's five call
// sites discard the return value entirely, so nothing at the call site itself would ever notice.
// This sweep is what turns "every call site passes journalRoot" from a fact about the five sites
// that existed when this action landed into a fact that stays true when a sixth one is added
// tomorrow, in a file that does not exist yet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['orchestrator'];

// Same blanking idiom test/gh-api-argv.test.js uses (independently named/defined here, not a
// shared import -- see that file's own header for why the duplication across this suite's sweep
// files is deliberate: each stands alone). Blanks whole-line `//` comments FIRST, THEN block
// comments -- card #152's fix, not the reverse -- so a `/*`-looking sequence sitting inside a `//`
// comment can never be misread as opening a real block comment that swallows real call sites
// below it. Blanks to spaces, never deletes, so every reported line number still matches the real
// file.
function stripJsComments(source) {
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

// Every occurrence of `moveReportTo(` in a comment-stripped source, EXCLUDING the function's own
// definition (`function moveReportTo(...) {`) -- that is a parameter list, not a call, and its
// arity is the contract this sweep enforces, not another instance of it.
function callSites(source) {
  const out = [];
  const re = /moveReportTo\(/g;
  let m;
  while ((m = re.exec(source))) {
    const before = source.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before)) continue; // the definition itself

    // Balanced-paren span, starting at the `(` right after `moveReportTo`.
    const open = m.index + 'moveReportTo'.length;
    let depth = 0;
    let close = -1;
    let inString = null; // one of ' " ` while scanning inside a string/template literal
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (ch === '\\') {
          i++; // skip the escaped character
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue; // unterminated -- not a real call site, skip rather than crash
    out.push({ index: m.index, text: source.slice(open, close + 1) });
  }
  return out;
}

// Top-level argument count inside a balanced `(...)` span (the text INCLUDES the outer
// parens): commas nested inside (), [], {}, or a string/template literal do not count.
function argCount(parenSpan) {
  const inner = parenSpan.slice(1, -1);
  if (inner.trim() === '') return 0;
  let depth = 0;
  let inString = null;
  let commas = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) commas++;
  }
  return commas + 1;
}

test('every moveReportTo( call site in orchestrator/** passes all four arguments (reportPath, targetDir, dispositionLine, journalRoot)', () => {
  const files = SCAN_DIRS.flatMap(jsFilesUnder);
  const offenders = [];
  let siteCount = 0;

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    const raw = fs.readFileSync(abs, 'utf8');
    const source = stripJsComments(raw);
    if (!source.includes('moveReportTo(')) continue;

    for (const span of callSites(source)) {
      siteCount += 1;
      const n = argCount(span.text);
      if (n !== 4) {
        offenders.push(
          `${rel}:${lineOf(source, span.index)} -- ${n} argument(s), expected 4: ${span.text.replace(/\s+/g, ' ').slice(0, 160)}`
        );
      }
    }
  }

  // If this drops to zero the sweep has stopped finding anything at all (a refactor renamed the
  // function or moved every call site out of orchestrator/), and a green result would mean
  // nothing. Fail loudly instead. Five call sites are known at the time this test was written
  // (report-intake.js x3, auto-triage.js x2); require at least that many so the sweep cannot
  // silently start scanning zero files.
  assert.ok(siteCount >= 5, `expected to find at least 5 moveReportTo( call sites, found ${siteCount} -- has the convention changed?`);
  assert.deepEqual(
    offenders,
    [],
    `moveReportTo( call site(s) missing the journalRoot argument (an omitted-looking-optional 4th ` +
      `parameter silently reverts to the pre-action-3.1 swallow -- see this file's own header):\n  ${offenders.join('\n  ')}`
  );
});

test('argCount/callSites: a call site missing journalRoot is genuinely detected (kills the "always green" mutant)', () => {
  const raw = [
    "'use strict';",
    "function bad() {",
    "  return moveReportTo(reportPath, targetDir, `filed: #${x} — ${today}`);",
    "}",
  ].join('\n');
  const source = stripJsComments(raw);
  const spans = callSites(source);
  assert.equal(spans.length, 1, 'expected to find the one fixture call site');
  assert.equal(argCount(spans[0].text), 3, 'fixture deliberately omits journalRoot -- must be counted as 3, not 4');
});

test('argCount/callSites: a correct 4-argument call site is not flagged', () => {
  const raw = [
    "'use strict';",
    "function good() {",
    "  return moveReportTo(reportPath, targetDir, `filed: #${x} — ${today}`, journalRoot);",
    "}",
  ].join('\n');
  const source = stripJsComments(raw);
  const spans = callSites(source);
  assert.equal(spans.length, 1, 'expected to find the one fixture call site');
  assert.equal(argCount(spans[0].text), 4);
});

test('callSites: the function definition itself is not counted as a call site', () => {
  const raw = [
    "'use strict';",
    "function moveReportTo(reportPath, targetDir, dispositionLine, journalRoot) {",
    "  return null;",
    "}",
  ].join('\n');
  const source = stripJsComments(raw);
  assert.equal(callSites(source).length, 0, 'the definition must be excluded, not miscounted as a 4-argument call');
});
