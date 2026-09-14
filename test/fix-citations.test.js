'use strict';
// Coverage for scripts/fix-citations.js -- action 4 of the citation-verification migration
// (#206). This exercises the REAL script as a child process (execFileSync would throw on the
// non-zero exit codes several of these tests need, so this uses spawnSync directly) against
// scratch, throwaway fixtures -- never against this repo's own real test/citation-pins-data.js,
// which the script must NEVER be pointed at from a test. `--data-file=PATH` and
// `--repo-root=PATH` (documented in the script's own header) exist for exactly this: pointing the
// script at a temp directory instead of the real repo.
//
// Every fixture citation's TARGET path includes a "/" (e.g. "target/foo.js") so
// resolveCitationTarget's direct fs.existsSync branch resolves it -- no git init needed in the
// scratch dir. The CITING file (pin.file, e.g. "citing.md") is resolved directly by the script
// itself (path.resolve(repoRoot, pin.file)), never through resolveCitationTarget, so it needs no
// slash discipline of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { execFileSync } = require('child_process');
const { mkTmp, isolatedEnv, gitEnv } = require('./helpers');

const FIX_CITATIONS = path.join(__dirname, '..', 'scripts', 'fix-citations.js');

function readAll(p) {
  return fs.readFileSync(p, 'utf8');
}

// pinsDataSource -- builds a citation-pins-data.js-SHAPED module source, matching this repo's own
// real convention (test/citation-pins-data.js) of one pin per single-line object literal.
// `extraBenchLines` lets a test plant something ADDITIONAL on its own line(s) inside BENCH_PINS's
// array literal (e.g. a duplicate-looking comment, for the ambiguous-match refusal case) without
// it being a second real pin object.
function pinsDataSource({ benchPinLine, extraBenchLines = '', ccaPinLine = '' }) {
  return `'use strict';
const BENCH_PINS = [
  ${benchPinLine}
${extraBenchLines}
];
const LIVE_RANGE_PINS = [];
const BLUNT_PINS = [];
const CCA_PINS = [
  ${ccaPinLine}
];
module.exports = { BENCH_PINS, LIVE_RANGE_PINS, BLUNT_PINS, CCA_PINS };
`;
}

// setupScratch -- one throwaway repo root: target/foo.js (the cited TARGET file), citing.md (the
// CITING file whose prose holds the literal citation text), and pins-data.js (the data module).
function setupScratch({ targetLines, citingContent, dataSource, extraFiles = {} }) {
  const dir = mkTmp('fix-citations-');
  fs.mkdirSync(path.join(dir, 'target'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'target', 'foo.js'), targetLines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'citing.md'), citingContent, 'utf8');
  const dataFilePath = path.join(dir, 'pins-data.js');
  fs.writeFileSync(dataFilePath, dataSource, 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  }
  return {
    dir,
    dataFilePath,
    citingPath: path.join(dir, 'citing.md'),
    targetPath: path.join(dir, 'target', 'foo.js'),
  };
}

function run(dataFilePath, repoRoot, extraArgs = []) {
  // isolatedEnv() (test/helpers.js), not a bare process.env spread -- test/spawn-isolation-sweep
  // requires every real-spawn call site in test/ to derive its env this way, even though this
  // particular script never itself touches any of the machine-state dirs that helper isolates.
  return spawnSync(
    process.execPath,
    [FIX_CITATIONS, `--data-file=${dataFilePath}`, `--repo-root=${repoRoot}`, ...extraArgs],
    { encoding: 'utf8', env: isolatedEnv() }
  );
}

// Shared fixture shape used by several tests: the real anchor line in target/foo.js is line 4,
// but the pin's own citation names line 2 -- a pure shift, unchanged text, exactly the common
// case this script exists to fix. (Deliberately NOT written here as a "path.ext:N" token: this
// repo's own test-comment-citation-sweep extracts and existence-checks exactly that shape out of
// every comment in test/, and these two numbers name a scratch fixture file that will never
// exist in any real repo.)
const TARGET_LINES = ['padding1', 'padding2', 'padding3', 'TARGET TEXT', 'padding5'];
const OLD_CITATION = 'target/foo.js:2';
const NEW_CITATION = 'target/foo.js:4';
const BENCH_PIN_LINE = `{ file: "citing.md", citation: "${OLD_CITATION}", at: "HEAD", first: "TARGET TEXT" },`;

test('pure shift, dry run: reports the correction, writes nothing to either file', () => {
  const citingContent = `Some prose citing ${OLD_CITATION} for a fact.\nAnother unrelated line.\n`;
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const beforeData = readAll(dataFilePath);
  const beforeCiting = readAll(citingPath);

  const res = run(dataFilePath, dir);

  assert.equal(res.status, 0, `expected clean exit: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /1 correction\(s\) found/);
  assert.match(res.stdout, new RegExp(`${OLD_CITATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -> ${NEW_CITATION}`));
  assert.match(res.stdout, /would rewrite/);
  assert.match(res.stdout, /0 refusals\. Clean/);

  // dry run: byte-identical to before, on BOTH files.
  assert.equal(readAll(dataFilePath), beforeData, 'dry run must not touch the data file');
  assert.equal(readAll(citingPath), beforeCiting, 'dry run must not touch the citing file');
});

test('pure shift, --apply: rewrites both the data file citation field and the citing file prose, nothing else', () => {
  const citingContent = `Some prose citing ${OLD_CITATION} for a fact.\nAnother unrelated line.\n`;
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const beforeData = readAll(dataFilePath);
  const beforeCiting = readAll(citingPath);

  const res = run(dataFilePath, dir, ['--apply']);
  assert.equal(res.status, 0, `expected clean exit: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /rewrote/);

  const expectedData = beforeData.replace(`citation: "${OLD_CITATION}"`, `citation: "${NEW_CITATION}"`);
  const expectedCiting = beforeCiting.replace(OLD_CITATION, NEW_CITATION);

  assert.equal(readAll(dataFilePath), expectedData, 'only the citation: field on the pin line should change');
  assert.equal(readAll(citingPath), expectedCiting, 'only the one citation occurrence in the prose should change');
});

test('idempotency: a second --apply after a real fix makes zero writes and exits 0', () => {
  const citingContent = `Some prose citing ${OLD_CITATION} for a fact.\n`;
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const first = run(dataFilePath, dir, ['--apply']);
  assert.equal(first.status, 0);

  const fixedData = readAll(dataFilePath);
  const fixedCiting = readAll(citingPath);
  const mtimeDataBefore = fs.statSync(dataFilePath).mtimeMs;
  const mtimeCitingBefore = fs.statSync(citingPath).mtimeMs;

  const second = run(dataFilePath, dir, ['--apply']);
  assert.equal(second.status, 0, `second --apply should find nothing to fix: ${second.stdout}`);
  assert.match(second.stdout, /Nothing to fix/);
  assert.match(second.stdout, /0 correction\(s\) found/);

  assert.equal(readAll(dataFilePath), fixedData, 'second run must not change the data file');
  assert.equal(readAll(citingPath), fixedCiting, 'second run must not change the citing file');
  assert.equal(fs.statSync(dataFilePath).mtimeMs, mtimeDataBefore, 'data file must not even be written to (mtime unchanged)');
  assert.equal(fs.statSync(citingPath).mtimeMs, mtimeCitingBefore, 'citing file must not even be written to (mtime unchanged)');
});

test('refusal: data file citation/file pair is ambiguous -- data file untouched, non-zero exit; the citing-file fix is an independent success', () => {
  const citingContent = `Some prose citing ${OLD_CITATION} for a fact.\n`;
  // The extra line below makes the {file, citation} pair match TWO lines of the data file's own
  // source text, even though only one is a real pin object -- exactly the "duplicated ... across
  // two lines" shape the spec calls for, without adding a second real pin to resolvePins' input.
  const dataSource = pinsDataSource({
    benchPinLine: BENCH_PIN_LINE,
    extraBenchLines: `  // duplicate marker: file: "citing.md", citation: "${OLD_CITATION}"`,
  });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const beforeData = readAll(dataFilePath);

  const res = run(dataFilePath, dir, ['--apply']);
  assert.notEqual(res.status, 0, 'a refusal must produce a non-zero exit code');
  assert.match(res.stdout, /data file: REFUSED/);
  assert.match(res.stdout, /ambiguous/);
  assert.match(res.stdout, /1 refusal\(s\)/);

  assert.equal(readAll(dataFilePath), beforeData, 'the refused data-file rewrite must never be partially applied');
  // The citing-file half of this SAME pin is unambiguous and must still succeed independently.
  assert.equal(readAll(citingPath), citingContent.replace(OLD_CITATION, NEW_CITATION), 'the citing file fix is independent of the data file refusal');
});

test('refusal: citing file has the old citation text TWICE -- citing file untouched, non-zero exit; the data-file fix is an independent success', () => {
  const citingContent = `Prose citing ${OLD_CITATION} once, and again right here: ${OLD_CITATION}.\n`;
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const beforeCiting = readAll(citingPath);
  const beforeData = readAll(dataFilePath);

  const res = run(dataFilePath, dir, ['--apply']);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /citing file: REFUSED/);
  assert.match(res.stdout, /occurs 2 times/);
  assert.match(res.stdout, /1 refusal\(s\)/);

  assert.equal(readAll(citingPath), beforeCiting, 'the refused citing-file rewrite must never be partially applied');
  assert.equal(
    readAll(dataFilePath),
    beforeData.replace(`citation: "${OLD_CITATION}"`, `citation: "${NEW_CITATION}"`),
    'the data file fix is independent of the citing file refusal'
  );
});

test('refusal: citing file has ZERO occurrences of the old citation text -- refused, no write, non-zero exit', () => {
  const citingContent = 'Nothing relevant to any citation lives in this file.\n';
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const beforeCiting = readAll(citingPath);

  const res = run(dataFilePath, dir, ['--apply']);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /citing file: REFUSED/);
  assert.match(res.stdout, /does not occur anywhere/);

  assert.equal(readAll(citingPath), beforeCiting, 'a zero-occurrence refusal must never write');
});

// The two tests below pin the TRAILING-boundary rule in scripts/fix-citations.js's
// findCitationOccurrences. Found by measurement during verification of this action, not by review:
// with plain substring counting, a citing file holding ONE unrelated `<OLD_CITATION>3` and no
// standalone OLD_CITATION counted exactly 1 occurrence, passed the "exactly once" gate, and was
// rewritten IN PLACE -- silently turning a correct, unrelated citation into garbage while
// reporting "rewrote 1 occurrence" and exiting 0, i.e. while claiming the run was safe.
const LONGER_CITATION = `${OLD_CITATION}3`; // same path, a DIFFERENT (longer) line number
const RANGE_CITATION = `${OLD_CITATION}-5`; // same path, a DIFFERENT (range) citation

test('the old citation appearing ONLY as the prefix of longer citations is refused, never rewritten inside them', () => {
  const citingContent = `Cites ${LONGER_CITATION} and ${RANGE_CITATION}, neither of which is this pin's citation.\n`;
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const beforeCiting = readAll(citingPath);

  const res = run(dataFilePath, dir, ['--apply']);
  assert.notEqual(res.status, 0, 'a prefix-only citing file is a refusal, not a clean run');
  assert.match(res.stdout, /citing file: REFUSED/);
  assert.match(res.stdout, /does not occur anywhere/);

  assert.equal(
    readAll(citingPath),
    beforeCiting,
    'rewriting a prefix of a longer citation corrupts an unrelated, correct citation -- it must never happen'
  );
});

test('a whole-token occurrence is still fixed even when a longer citation sharing its prefix sits beside it', () => {
  const head = `Real citation: ${OLD_CITATION}. Unrelated, longer: ${LONGER_CITATION}.\n`;
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent: head, dataSource });

  const res = run(dataFilePath, dir, ['--apply']);
  assert.equal(res.status, 0, `the longer citation is a different pin, not an ambiguity: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /rewrote 1 occurrence/);

  assert.equal(
    readAll(citingPath),
    `Real citation: ${NEW_CITATION}. Unrelated, longer: ${LONGER_CITATION}.\n`,
    'only the whole-token occurrence changes; the longer citation beside it is left exactly as it was'
  );
});

// Reproduces the real corruption the external audit found (2026-09-14, second pass), against the
// REAL bug first (proving it existed), then against the fixed script (proving it's closed).
// citation-pins.js's `correction.citation` is built from `m.relPath` -- the repo-root-RESOLVED
// path -- never from the citation's own original path spelling. A bare citation naming only the
// fixture's target basename, resolved via git-tracked-basename lookup to that same file nested
// one directory down, makes `correction.citation` carry the fuller, DIFFERENT path text -- not
// the citation's own original spelling. If the citing prose spells the fact with that fuller
// path already (naming the containing directory too), the bare original citation matches as a
// SUFFIX of that longer text (findCitationOccurrences' own deliberately loose leading side), and
// a naive splice-in of the corrected citation at that match point duplicates the directory
// segment instead of fixing the line number. (Deliberately not spelling either citation as a
// literal `path.ext:N` token in this comment -- see OLD_CITATION's own header note above for why:
// this repo's test-comment-citation-sweep existence-checks exactly that shape out of every
// comment in test/, and a scratch fixture path/line pair the sweep would try to resolve was never
// the point here.)
// gitScratch -- the path-spelling fixtures below need a real git repo: their registry citation is
// BARE (no "/"), so resolveCitationTarget resolves it through findByBasename/`git ls-files`, which
// is the only resolution route whose `m.relPath` can differ from the citation's own text.
function gitScratch(prefix, { targetRel, citingContent, citation }) {
  const dir = mkTmp(prefix);
  fs.mkdirSync(path.join(dir, path.dirname(targetRel)), { recursive: true });
  fs.writeFileSync(path.join(dir, targetRel), TARGET_LINES.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'citing.md'), citingContent, 'utf8');
  const dataFilePath = path.join(dir, 'pins-data.js');
  fs.writeFileSync(
    dataFilePath,
    pinsDataSource({ benchPinLine: `{ file: "citing.md", citation: "${citation}", at: "HEAD", first: "TARGET TEXT" },` })
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'scratch'], { cwd: dir, env: gitEnv() });
  return { dir, dataFilePath, citingPath: path.join(dir, 'citing.md') };
}

// The OTHER half of the same guard, and the reason it is a LEADING-BOUNDARY check rather than a
// flat path-equality refusal (verification of the audit fix, 2026-09-14): when the corrected path
// disagrees with the cited one but the prose spelled the citation BARE -- exactly as the registry
// pin does -- the rewrite is correct, and merely re-spells the citation in the resolved form.
// That is not a corner case. Three of this repo's own four real collateral re-pins have exactly
// this shape (bare in both the registry and the prose, resolving under orchestrator/), so a flat
// refusal would refuse three of the four real drift shapes this script exists to automate -- and,
// since the data-file half succeeds independently, would leave the registry re-spelled while the
// prose still said the old text, a divergence this repo's own live-corpus citation sweep goes RED
// on. Measured, both halves, before this test was written.
test('a corrected citation whose path differs but whose prose occurrence STARTS a path token is still rewritten', () => {
  const { dir, dataFilePath, citingPath } = gitScratch('fix-citations-path-respell-', {
    targetRel: path.join('nested', 'thing.js'),
    // Prose spells the fact bare, exactly as the registry pin does -- nothing precedes it but a space.
    citingContent: 'Prose cites thing.js:2 for the detail.\n',
    citation: 'thing.js:2',
  });

  const res = run(dataFilePath, dir, ['--apply']);

  assert.equal(res.status, 0, `a bare prose occurrence is safe to re-spell, not a refusal: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /citing file .*: rewrote 1 occurrence/);
  assert.equal(
    readAll(citingPath),
    'Prose cites nested/thing.js:4 for the detail.\n',
    'the citation is re-spelled in the resolved form with the corrected line number, and nothing else changes'
  );
  // The registry and the prose must still agree afterwards -- the invariant this repo's own
  // live-corpus citation sweep enforces, and the whole reason a flat refusal was the wrong shape.
  assert.match(readAll(dataFilePath), /citation: "nested\/thing\.js:4"/);
});

// The refusal is keyed on BOTH conditions together -- the paths disagreeing AND the prose
// occurrence being the tail of a longer path. See the sibling test above for the disagreeing-but-
// bare case, which is safe and must still be rewritten.
test('a corrected citation whose path differs AND whose prose occurrence is the tail of a longer path is refused, never spliced in', () => {
  const dir = mkTmp('fix-citations-path-mismatch-');
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'thing.js'), TARGET_LINES.join('\n') + '\n', 'utf8');
  const citingContent = 'Prose cites nested/thing.js:2 for the detail.\n';
  fs.writeFileSync(path.join(dir, 'citing.md'), citingContent, 'utf8');
  const dataFilePath = path.join(dir, 'pins-data.js');
  // Bare citation (no "/"), no `path` field -- resolved via git-tracked-basename lookup, which
  // is exactly the resolution path whose `m.relPath` differs from the citation's own bare text.
  fs.writeFileSync(
    dataFilePath,
    pinsDataSource({ benchPinLine: `{ file: "citing.md", citation: "thing.js:2", at: "HEAD", first: "TARGET TEXT" },` })
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'scratch'], { cwd: dir, env: gitEnv() });

  const beforeCiting = readAll(path.join(dir, 'citing.md'));

  const res = run(dataFilePath, dir, ['--apply']);
  assert.notEqual(res.status, 0, `a path-spelling mismatch must be refused, not guessed at: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /citing file: REFUSED/);
  assert.match(res.stdout, /path.*differently|differently.*path/i);

  assert.equal(
    readAll(path.join(dir, 'citing.md')),
    beforeCiting,
    'the citing file must be byte-identical -- a path-spelling mismatch must never be spliced in, which would ' +
      'have produced "nested/nested/thing.js:4" from "nested/thing.js:2"'
  );
  assert.doesNotMatch(readAll(path.join(dir, 'citing.md')), /nested\/nested/, 'the specific corruption shape must not appear');
});

test('an at:<sha> pin in the same run is completely ignored, regardless of what its own citing file contains', () => {
  const citingContent = `Some prose citing ${OLD_CITATION} for a fact.\n`;
  // Deliberately gives the sha pin's citing file some placeholder text that itself looks like a
  // citation target -- if the sha-filter were broken, the script would try to touch this file.
  const untouchedContent = `This file must never be edited by fix-citations.js. Marker: ${OLD_CITATION}\n`;
  const dataSource = pinsDataSource({
    benchPinLine: BENCH_PIN_LINE,
    ccaPinLine: `{ file: "should-never-be-touched.md", citation: "${OLD_CITATION}", at: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", first: "TARGET TEXT" },`,
  });
  const { dir, dataFilePath, citingPath } = setupScratch({
    targetLines: TARGET_LINES,
    citingContent,
    dataSource,
    extraFiles: { 'should-never-be-touched.md': untouchedContent },
  });
  const untouchedPath = path.join(dir, 'should-never-be-touched.md');

  const res = run(dataFilePath, dir, ['--apply']);
  assert.equal(res.status, 0, `expected clean exit (only the HEAD pin needs fixing): ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /1 at:'HEAD' pin\(s\) checked/, 'the sha pin must never be counted as a HEAD pin');
  assert.match(res.stdout, /1 correction\(s\) found/, 'the sha pin must never contribute a correction');

  assert.equal(readAll(untouchedPath), untouchedContent, 'the sha pin\'s own citing file must be completely untouched');
  assert.equal(
    readAll(citingPath),
    citingContent.replace(OLD_CITATION, NEW_CITATION),
    'the real HEAD pin must still be fixed normally alongside the ignored sha pin'
  );
});

test('dry run (no --apply) never writes, even though this run has a clean, fixable correction available', () => {
  const citingContent = `Some prose citing ${OLD_CITATION} for a fact.\n`;
  const dataSource = pinsDataSource({ benchPinLine: BENCH_PIN_LINE });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const mtimeDataBefore = fs.statSync(dataFilePath).mtimeMs;
  const mtimeCitingBefore = fs.statSync(citingPath).mtimeMs;
  const beforeData = readAll(dataFilePath);
  const beforeCiting = readAll(citingPath);

  // No --apply at all -- the bare/default invocation.
  const res = run(dataFilePath, dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /1 correction\(s\) found/, 'the correction must still be REPORTED');
  assert.match(res.stdout, /would rewrite/, 'dry run must describe what WOULD happen, not claim it happened');

  assert.equal(readAll(dataFilePath), beforeData);
  assert.equal(readAll(citingPath), beforeCiting);
  assert.equal(fs.statSync(dataFilePath).mtimeMs, mtimeDataBefore, 'dry run must never call a write, not even a no-op one (mtime unchanged)');
  assert.equal(fs.statSync(citingPath).mtimeMs, mtimeCitingBefore, 'dry run must never call a write, not even a no-op one (mtime unchanged)');
});

test('nothing to fix: a HEAD pin already at its correct position reports zero corrections and exits 0', () => {
  const citingContent = `Some prose citing ${NEW_CITATION} for a fact.\n`;
  const correctPinLine = `{ file: "citing.md", citation: "${NEW_CITATION}", at: "HEAD", first: "TARGET TEXT" },`;
  const dataSource = pinsDataSource({ benchPinLine: correctPinLine });
  const { dir, dataFilePath, citingPath } = setupScratch({ targetLines: TARGET_LINES, citingContent, dataSource });

  const beforeData = readAll(dataFilePath);
  const beforeCiting = readAll(citingPath);

  const res = run(dataFilePath, dir, ['--apply']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /0 correction\(s\) found/);
  assert.match(res.stdout, /Nothing to fix/);

  assert.equal(readAll(dataFilePath), beforeData);
  assert.equal(readAll(citingPath), beforeCiting);
});
