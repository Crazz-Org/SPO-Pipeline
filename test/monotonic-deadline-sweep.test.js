'use strict';
// monotonic-deadline-sweep.test.js -- card SPO-Pipeline#252. The standing guard that no file under
// test/ measures a wait deadline, an elapsed interval or a busy-wait on Date.now().
//
// WHY. This box's wall clock steps: systemd-timesyncd polls every ~32s, and the kernel runs
// hv_utils.timesync_implicit=1, which steps the clock forward to the Hyper-V host. A forward step
// expires a `Date.now() + budget` deadline early -- card #234 traced four reds of
// test/repark-race-demo.test.js to an 8000ms wait that gave up after 2.3-4.5s of monotonic time --
// and turns an `elapsed < bound` assertion red; a backward step (orchestrator/monotonic-clock.js's
// header measured -2515ms across one 10ms interval) extends a wait past its bound. #234 fixed six
// copies of one helper, and its verifier found three of them (drain, dispatcher, recette) pinned by
// nothing: reverting any of them to Date.now() left the suite green. Against the tree #234 left,
// this scan flags 24 more lines of the same shape, across 10 files. The fix is
// test/helpers.js's monoNow / elapsedMs / waitFor / pollUntil / busyWaitMs, pinned by
// test/monotonic-wait.test.js. This file is what stops the class regrowing by copy-paste.
//
// WHAT IS FLAGGED. Date.now() is not banned: a cooldownUntil, a notBefore, an updatedAt written
// into a fixture is a WALL-CLOCK VALUE the code under test compares with its own Date.now(), and
// must stay on the wall clock (monotonic-clock.js's header: the one thing never to route through
// it). The defect is Date.now() used as a BOUND on this process's own waiting. The scan finds
// "clock bases" -- any identifier assigned straight from a clock read (`x = Date.now()`,
// `x = Date.now() + budget`, `x = monoNow()`, `x = monotonicNowMs()`) -- and flags, in the
// comment-blanked source:
//
//   wall-arith   Date.now() subtracted from or compared with a clock base
//                (`Date.now() - started`, `Date.now() < deadline`, `deadline - Date.now()`)
//   mixed-clock  a Date.now() base read against the monotonic clock
//                (`monoNow() < deadline`, `elapsedMs(started)`, `elapsedMs(Date.now())`)
//   loop-cond    Date.now() anywhere in a `while (...)` or `for (...)` header -- a busy-wait or a
//                polling loop bounded on the wall clock
//   clock-seam   Date.now() handed to an elapsed-time injection seam
//                (`mono: () => Date.now()`, `monotonicNowMs: Date.now`)
//
// "Date.now()" throughout means any wall-clock millisecond reading: `Date.now()`, `+new Date()`,
// `new Date().getTime()` and `new Date().valueOf()` are all matched -- a respelling is not a fix.
// A `Date.now() + x` that is only ever written into a fixture is not a deadline, and is not
// flagged; the moment ANY of the four uses above reads it as one, it is. Child-process source
// held in string literals is scanned too -- a busy-wait in a spawned script blocks just the same.
//
// THE ALLOWLIST is keyed on file + the flagged line's exact trimmed text + how many times that text
// is flagged in that file, each with its reason. A stale entry fails, and so does a second copy
// of an allowlisted line: it has to be justified on its own.
//
// Comments are blanked with the suite's shared blankComments (byte-identical to the rest of its family,
// pinned by test/blank-comments-sync.test.js), which blanks whole-line `//` comments BEFORE block
// comments, so a `/*` written inside a `//` comment cannot open a phantom block that hides the
// lines after it (card #152). A trailing `// ...` on a code line is not blanked; if one ever quotes
// a flagged shape, the scan errs toward red, and a human reads it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp } = require('./helpers');

const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

// ---- the allowlist --------------------------------------------------------------------------

const ALLOWLIST = [
  {
    file: 'park-loop.test.js',
    text: 'while (Date.now() < until) {',
    count: 1,
    why:
      'the property under test IS the wall clock: this spin exists to make Date.now() itself move ' +
      "between two reEnqueueTask calls (card #43's old Date.now()-keyed file naming). A monotonic spin " +
      'does not guarantee Date.now() advanced -- under a backward step it would not have.',
  },
  {
    file: 'dispatcher.test.js',
    text: "assert.ok(coolUntil > Date.now(), 'test premise: fable was still cooling when the card was admitted');",
    count: 1,
    why:
      'not a wait: coolUntil is the cooldownUntil FIXTURE this test wrote into accounts.json, and the ' +
      "premise is production's own comparison (accounts.js reads cooldownUntil against Date.now()), " +
      'so it must be made on the same wall clock production uses.',
  },
];

// ---- the scanner ----------------------------------------------------------------------------

// KEEP IN SYNC -- one of a pinned family of byte-identical copies; test/blank-comments-sync.test.js
// is the authority (roster + byte identity + behavioural contract). Whole-line `//` comments are
// blanked FIRST, then block comments, every blanked character becoming a space so line numbers
// and widths survive.
function blankComments(source) {
  const withoutLineComments = source
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
  return withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// Every spelling of a wall-clock millisecond reading (see the header): a respelling is not a fix.
const WALL = '(?:Date\\.now\\(\\)|\\+\\s*new Date\\(\\)|new Date\\(\\)\\.(?:getTime|valueOf)\\(\\))';
const MONO = '(?:monoNow|monotonicNowMs)\\(\\)';
const OP = '(?:-|<=?|>=?)';
// Not preceded by an identifier character or a `.`: `x.until > Date.now()` compares a PROPERTY
// (a fixture value), never a clock base this file assigned.
const NOT_PROP = '(?<![\\w$.])';

function escapeRe(s) {
  return s.replace(/[$]/g, '\\$');
}

// Every identifier assigned straight from a clock read: the bare reading (a start) or the reading
// plus a budget (a deadline). `=` must be a plain assignment: not `==`/`===`, not `=>`, not a
// compound operator (a compound one cannot sit between the name and `=` with only whitespace
// between them anyway). `x = Date.now() - y` is NOT a base: it is already a duration or a
// backdated fixture timestamp (`ageMs = Date.now() - stat.mtimeMs`), and treating it as one flags
// every later `new Date(Date.now() - ageMs)` fixture for nothing.
function clockBases(text) {
  const wall = new Set();
  const mono = new Set();
  const re = new RegExp(`${NOT_PROP}([A-Za-z_$][\\w$]*)\\s*=(?![=>])\\s*(${WALL}|${MONO})(?=\\s*(?:[;,)\\n]|\\+))`, 'g');
  let m;
  while ((m = re.exec(text))) (/Date/.test(m[2]) ? wall : mono).add(m[1]); // not startsWith: `+new Date()` starts with `+`
  return { wall, mono };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// The balanced-paren header of every `while (` / `for (` in `text`: [{ index, end }].
function loopHeaders(text) {
  const out = [];
  const re = /\b(?:while|for)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) {
        out.push({ index: open, end: i });
        break;
      }
    }
  }
  return out;
}

// scanSource(raw) -> { hits: [{ line, rule }], wallReads }. `wallReads` counts every Date.now()
// in the blanked source, so the real-tree test can pin a floor on how much the scan engaged with.
function scanSource(raw) {
  const text = blankComments(raw);
  const { wall, mono } = clockBases(text);
  const hits = [];
  const add = (index, rule) => hits.push({ line: lineOf(text, index), rule });
  const all = (re, rule) => {
    let m;
    while ((m = re.exec(text))) add(m.index, rule);
  };

  const bases = [...wall, ...mono].map(escapeRe);
  if (bases.length) {
    const alt = `(?:${bases.join('|')})`;
    all(new RegExp(`${WALL}\\s*${OP}\\s*${alt}(?![\\w$])`, 'g'), 'wall-arith');
    all(new RegExp(`${NOT_PROP}${alt}\\s*${OP}\\s*${WALL}`, 'g'), 'wall-arith');
  }
  const walls = [...wall].map(escapeRe);
  if (walls.length) {
    const alt = `(?:${walls.join('|')})`;
    all(new RegExp(`${MONO}\\s*${OP}\\s*${alt}(?![\\w$])`, 'g'), 'mixed-clock');
    all(new RegExp(`${NOT_PROP}${alt}\\s*${OP}\\s*${MONO}`, 'g'), 'mixed-clock');
    all(new RegExp(`\\belapsedMs\\(\\s*${alt}\\s*\\)`, 'g'), 'mixed-clock');
  }
  all(new RegExp(`\\belapsedMs\\(\\s*${WALL}`, 'g'), 'mixed-clock');
  all(new RegExp(`\\b(?:mono\\w*|monotonicNowMs|elapsed\\w*|clock\\w*)\\s*:\\s*(?:\\(\\s*\\)\\s*=>\\s*${WALL}|Date\\.now\\b)`, 'gi'), 'clock-seam');
  for (const h of loopHeaders(text)) {
    const header = text.slice(h.index, h.end + 1);
    const re = new RegExp(WALL, 'g');
    let m;
    while ((m = re.exec(header))) add(h.index + m.index, 'loop-cond');
  }

  // One entry per line: a line can match several rules (`while (Date.now() < until)` is both).
  const byLine = new Map();
  for (const h of hits) {
    const prev = byLine.get(h.line);
    byLine.set(h.line, prev ? { line: h.line, rule: [...new Set([...prev.rule.split('+'), h.rule])].join('+') } : h);
  }
  const wallReads = (text.match(new RegExp(WALL, 'g')) || []).length;
  return { hits: [...byLine.values()].sort((a, b) => a.line - b.line), wallReads };
}

// Every .js file under test/, fixtures included (a fixture is a spawned child, and blocks the same
// way), this file excluded: its own self-tests hold the flagged shapes as string fixtures.
function sweptFiles(dir = TEST_DIR, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sweptFiles(path.join(dir, entry.name), r));
    else if (entry.name.endsWith('.js') && r !== SELF) out.push(r);
  }
  return out;
}

// sweep({ root, files, allowlist }) -> { offenders, stale, filesScanned, wallReads }. Offenders
// are flagged lines no allowlist entry covers; stale are allowlist entries whose count no longer
// matches. `root`/`files`/`allowlist` default to the real tree; the self-tests pass a scratch one.
function sweep({ root = TEST_DIR, files = sweptFiles(), allowlist = ALLOWLIST } = {}) {
  const flagged = new Map(); // `${file}\n${text}` -> [{ line, rule }]
  let wallReads = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = raw.split('\n');
    const res = scanSource(raw);
    wallReads += res.wallReads;
    for (const h of res.hits) {
      const key = `${file}\n${lines[h.line - 1].trim()}`;
      if (!flagged.has(key)) flagged.set(key, []);
      flagged.get(key).push(h);
    }
  }
  const allowed = new Map(allowlist.map((e) => [`${e.file}\n${e.text}`, e]));
  const offenders = [];
  for (const [key, hs] of flagged) {
    const entry = allowed.get(key);
    if (entry && entry.count === hs.length) continue;
    const [file, text] = key.split('\n');
    for (const h of hs) offenders.push(`test/${file}:${h.line} [${h.rule}] ${text}`);
  }
  const stale = allowlist
    .filter((e) => {
      const hs = flagged.get(`${e.file}\n${e.text}`);
      return !hs || hs.length !== e.count;
    })
    .map((e) => `test/${e.file}: "${e.text}" (expected ${e.count} flagged, found ${(flagged.get(`${e.file}\n${e.text}`) || []).length})`);
  return { offenders, stale, filesScanned: files.length, wallReads };
}

// ---- the real tree ----------------------------------------------------------------------------

test('no file under test/ bounds a wait, an elapsed interval or a busy-wait on Date.now()', () => {
  const { offenders, filesScanned, wallReads } = sweep();
  assert.deepEqual(
    offenders,
    [],
    'Date.now() used as a deadline or elapsed-time base (this box\'s wall clock steps -- see this ' +
      "file's header). Use test/helpers.js's monoNow()/elapsedMs()/waitFor()/pollUntil()/busyWaitMs() " +
      'instead; if the value is genuinely a wall-clock one, allowlist the line with its reason:\n  ' +
      offenders.join('\n  ')
  );
  // Engagement floor: the scan really read the suite, not an empty directory or a blanked file.
  assert.ok(filesScanned >= 150, `only ${filesScanned} files scanned`);
  assert.ok(wallReads >= 250, `only ${wallReads} Date.now() reads seen across test/`);
});

test('every allowlist entry still matches exactly the flagged lines it names -- no stale or widened entry', () => {
  const { stale } = sweep();
  assert.deepEqual(stale, []);
  for (const e of ALLOWLIST) {
    assert.ok(e.why && e.why.length > 40, `allowlist entry for test/${e.file} carries no real reason`);
    assert.ok(Number.isInteger(e.count) && e.count >= 1, `allowlist entry for test/${e.file} has no count`);
  }
});

test('the sweep covers fixtures/ too, and never itself', () => {
  const files = sweptFiles();
  assert.ok(files.includes('fixtures/mark-limit-once.js'), 'test/fixtures/ is not being swept');
  assert.ok(files.includes('helpers.js'));
  assert.ok(!files.includes(SELF));
});

// ---- the scanner's own contract -----------------------------------------------------------------

function rules(src) {
  return scanSource(src).hits.map((h) => `${h.line}:${h.rule}`);
}

test('flags a Date.now() deadline read back by a loop or an if -- #234\'s exact shape', () => {
  assert.deepEqual(
    rules(
      [
        'async function waitFor(p, timeoutMs) {',
        '  const deadline = Date.now() + timeoutMs;',
        '  for (;;) {',
        '    if (p()) return;',
        '    if (Date.now() >= deadline) throw new Error("t");',
        '  }',
        '}',
      ].join('\n')
    ),
    ['5:wall-arith']
  );
  assert.deepEqual(rules('const until = Date.now() + 60;\nwhile (Date.now() < until) {}'), ['2:wall-arith+loop-cond']);
  assert.deepEqual(rules('let d = Date.now() + 5;\nsetTimeout(f, d - Date.now());'), ['2:wall-arith']);
});

test('flags a Date.now() elapsed-time base, however the subtraction is spread over lines', () => {
  assert.deepEqual(rules('const started = Date.now();\nwork();\nassert.ok(Date.now() - started < 5000);'), ['3:wall-arith']);
  assert.deepEqual(rules('const t0 = Date.now();\nconst ms =\n  Date.now()\n  - t0;'), ['3:wall-arith']);
});

test('flags mixing the clocks -- a Date.now() base handed to the monotonic helpers, or the reverse', () => {
  assert.deepEqual(rules('const started = Date.now();\nassert.ok(elapsedMs(started) < 5000);'), ['2:mixed-clock']);
  assert.deepEqual(rules('const deadline = Date.now() + 10;\nwhile (monoNow() < deadline) {}'), ['2:mixed-clock']);
  assert.deepEqual(rules('const started = monoNow();\nconst ms = Date.now() - started;'), ['2:wall-arith']);
  assert.deepEqual(rules('const ms = elapsedMs(Date.now());'), ['1:mixed-clock']);
});

test('flags a Date.now() busy-wait or poll inside a loop header, including in child-process source strings', () => {
  assert.deepEqual(rules('while (!fs.existsSync(p) && Date.now() < end) sleep();'), ['1:loop-cond']);
  assert.deepEqual(rules('for (let i = 0; Date.now() - base < 100; i++) {}'), ['1:loop-cond']);
  assert.deepEqual(
    rules("const src = `const t0 = Date.now();` +\n  `while (Date.now() - t0 < 8000) { spin(); }`;"),
    ['2:wall-arith+loop-cond']
  );
});

test('a respelled wall-clock reading is still a wall-clock reading: +new Date(), new Date().getTime(), .valueOf()', () => {
  assert.deepEqual(rules('const started = +new Date();\nassert.ok(+new Date() - started < 5000);'), ['2:wall-arith']);
  assert.deepEqual(rules('const deadline = new Date().getTime() + 5000;\nwhile (new Date().getTime() < deadline) {}'), ['2:wall-arith+loop-cond']);
  assert.deepEqual(rules('const t0 = new Date().valueOf();\nconst ms = Date.now() - t0;'), ['2:wall-arith']);
  // classed WALL, not monotonic, so handing it to the monotonic helpers is a mixed-clock read
  assert.deepEqual(rules('const started = +new Date();\nassert.ok(elapsedMs(started) < 5000);'), ['2:mixed-clock']);
  assert.deepEqual(rules('const deadline = new Date().getTime() + 10;\nwhile (monoNow() < deadline) {}'), ['2:mixed-clock']);
  assert.deepEqual(rules('runWatchdog({ mono: () => new Date().getTime() });'), ['1:clock-seam']);
  // ...and a wall-clock VALUE in either spelling is still a fixture, not a deadline
  assert.deepEqual(rules('const until = new Date().getTime() + HOUR;\nsubject({ until });'), []);
});

test('flags Date.now() handed to an elapsed-time injection seam', () => {
  assert.deepEqual(rules('runWatchdog({ capMs: 300, mono: () => Date.now() });'), ['1:clock-seam']);
  assert.deepEqual(rules('createDispatcher(q, j, { deps: { monotonicNowMs: Date.now } });'), ['1:clock-seam']);
});

test('does NOT flag wall-clock fixture values the code under test compares with its own Date.now()', () => {
  const fixtures = [
    'const cooldownUntil = Date.now() + 60 * 60 * 1000;',
    "accounts.writeState(dir, { a: { byModel: { fable: { cooldownUntil: Date.now() + HOUR } } } });",
    'const startedAt = new Date(Date.now() - 90 * 1000).toISOString();',
    "accounts.markLimit(dir, 'a', 'usage', Date.now(), { model: 'fable' });",
    "assert.ok(Date.parse(requeued.notBefore) <= Date.now() + 1000, 'eligible now');",
    'assert.ok(state.acct1.cooldownUntil > Date.now());',
    'const ageMs = Date.now() - fs.statSync(p).mtimeMs;',
    'const ageMs = Date.now() - stat.mtimeMs;\nwrite({ claimedAt: new Date(Date.now() - ageMs).toISOString() });',
    'const before = Date.now();\nconst key = run();\nconst after = Date.now();\nassert.ok(key >= before && key <= after);',
    'const deadline = Date.now() + 60000; // a cooldown deadline handed to the code under test\nsubject({ deadline });',
    "const name = `custom-${Date.now()}`;",
    'const started = monoNow();\nassert.ok(elapsedMs(started) < 5000);',
  ];
  for (const src of fixtures) assert.deepEqual(rules(src), [], `false positive on:\n${src}`);
});

test('a `/*` inside a `//` comment does not blank the code after it (card #152)', () => {
  const src = ['// a glob like journal/*/state.json in prose', 'const t0 = Date.now();', 'const ms = Date.now() - t0;', '// closes nothing */'].join('\n');
  assert.deepEqual(rules(src), ['3:wall-arith']);
});

test('comments are not code: prose quoting the flagged shapes is not flagged', () => {
  const src = ['// const deadline = Date.now() + 5000;', '// while (Date.now() < deadline) {}', '/* Date.now() - started */', 'const x = 1;'].join('\n');
  assert.deepEqual(rules(src), []);
});

test('the allowlist is exact: a second copy of an allowlisted line is an offender, and a removed one is stale', () => {
  const root = mkTmp('spo-mono-sweep-');
  const src = 'const until = Date.now() + 5;\nwhile (Date.now() < until) {}\n';
  const allowlist = [{ file: 'a.js', text: 'while (Date.now() < until) {}', count: 1, why: 'x'.repeat(50) }];
  const run = (content) => {
    fs.writeFileSync(path.join(root, 'a.js'), content);
    return sweep({ root, files: ['a.js'], allowlist });
  };
  assert.deepEqual(run(src).offenders, []);
  assert.deepEqual(run(src).stale, []);
  assert.equal(run(src + src).offenders.length, 2, 'a duplicated allowlisted line slipped through');
  assert.equal(run(src + src).stale.length, 1);
  assert.equal(run('const x = 1;\n').stale.length, 1, 'an entry matching nothing must read as stale');
  assert.equal(run(src.replace('< until', '<= until')).offenders.length, 1, 'an edited line is no longer the allowlisted one');
});

module.exports = { scanSource, sweep, ALLOWLIST };
