'use strict';
// Replays orchestrator/plan-span-guard.js's detectSpanConflicts over the ten real cards fixed in
// test/fixtures/plan-span-corpus/ (see that directory's README for where they came from and why
// these ten). This is issue #112's calibration made reproducible: the PR's numbers were measured
// against the live daemon's journal at ~/.spo-state/journal/, which is NOT tracked by git and
// only goes back to 2026-08-29 -- without a committed fixture set, nobody could ever re-run this
// measurement again. scripts/replay-plan-span-flags.js re-runs the same detector over the FULL,
// live (untracked) corpus when it is available; this file is the part that survives forever.
//
// ---- span provenance: declaredSpan, not a re-resolved span -------------------------------------
// A real resolveAll() row carries a RESOLVED `span` (where the quote actually sits in the file AS
// IT IS NOW) alongside the PLAN-time `declaredSpan` (what PLAN's own `File: path:start-end` line
// claimed). Getting a resolved span here would mean re-checking each invariant's quote against
// the product worktree at the exact commit PLAN saw it -- and those worktrees
// (~/.spo-worktrees/issue-<n>/, ~/SPO-Pipeline/worktrees/issue-<n>/ before the move) are long
// gone; the daemon reaps them once a card leaves CHECK. So every row built below carries `span:
// null` and only `declaredSpan` -- detectSpanConflicts's own fallback (`inv.span ||
// inv.declaredSpan`) picks it up exactly the way it would for a baseline row PLAN could never
// resolve. This is weaker than a real CHECK-time replay (a plan span that only conflicts with
// where the quote moved TO, not where PLAN declared it, cannot be seen here) but it is the only
// span this corpus can still produce.
//
// ---- what "flags" means here ---------------------------------------------------------------
// A flag is not an accusation. The whole design (see plan-span-guard.js's own header) treats a
// flag as free until an invariant actually breaks at CHECK -- and the five cleanly-merged fixture
// cards below exist specifically to prove that: they DO flag, and none of them ever broke.

require('./no-real-spawn');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseInvariantsMarkdown } = require('../orchestrator/invariants');
const { detectSpanConflicts } = require('../orchestrator/plan-span-guard');

const CORPUS_DIR = path.join(__dirname, 'fixtures', 'plan-span-corpus');

// The two groups the corpus README documents: cards whose invariants broke at CHECK, and cards
// that merged cleanly but are known to still produce flags.
const BROKEN_CARDS = ['487', '488', '491', '508', '517'];
const CLEAN_CARDS = ['462', '473', '490', '505', '506'];
const ALL_CARDS = [...BROKEN_CARDS, ...CLEAN_CARDS];

function loadFixture(issue) {
  const dir = path.join(CORPUS_DIR, `issue-${issue}`);
  const planMarkdown = fs.readFileSync(path.join(dir, `plan-${issue}.md`), 'utf8');
  const invariantsMarkdown = fs.readFileSync(path.join(dir, `invariants-${issue}.md`), 'utf8');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  return { planMarkdown, invariantsMarkdown, meta };
}

// Builds resolveAll()-shaped rows from a raw invariants-<n>.md parse -- see the module header:
// `span` is deliberately null (unresolvable, the product worktree is gone); `declaredSpan` is
// parseInvariantsMarkdown's own parse of PLAN's `File: path:start-end` line, unchanged.
function baselineRowsFromMarkdown(invariantsMarkdown) {
  const { invariants } = parseInvariantsMarkdown(invariantsMarkdown);
  return invariants.map((inv) => ({
    id: inv.id,
    file: inv.file,
    resolved: true,
    mode: 'exact',
    lineSpec: inv.lineSpec,
    declaredSpan: inv.declaredSpan,
    span: null,
  }));
}

function flaggedIds(issue) {
  const { planMarkdown, invariantsMarkdown } = loadFixture(issue);
  const invariants = baselineRowsFromMarkdown(invariantsMarkdown);
  const findings = detectSpanConflicts({ planMarkdown, invariants });
  return [...new Set(findings.map((f) => f.id))].sort();
}

// ---- the two mandatory calibration cases, individually -----------------------------------------
// Each gets its own test, by card, so a regression names exactly which calibration case broke
// rather than surfacing as one generic failure somewhere in a loop.

test('plan-span-replay: card 487 flags INV-4 (the calibration case the detector was built for)', () => {
  assert.ok(
    flaggedIds('487').includes('INV-4'),
    'card 487 must flag INV-4 -- this is the mandatory issue #112 calibration case'
  );
});

test('plan-span-replay: card 488 flags INV-7 (the second mandatory calibration case)', () => {
  assert.ok(
    flaggedIds('488').includes('INV-7'),
    'card 488 must flag INV-7 -- this is the mandatory issue #112 calibration case'
  );
});

// ---- extra true positives -----------------------------------------------------------------------

test('plan-span-replay: card 491 flags both INV-5 and INV-6', () => {
  const ids = flaggedIds('491');
  assert.ok(ids.includes('INV-5'), 'card 491 must flag INV-5');
  assert.ok(ids.includes('INV-6'), 'card 491 must flag INV-6');
});

test('plan-span-replay: card 508 flags INV-1', () => {
  assert.ok(flaggedIds('508').includes('INV-1'), 'card 508 must flag INV-1');
});

// ---- the known, honest blind spot ----------------------------------------------------------------
// plan-517.md never names a line number at all for the file INV-13 cites (newspaper-scenario.ts)
// -- it describes the change in prose with no `File:line` or `lines N-M` citation the detector's
// three span syntaxes can see. No span-intersection rule can catch a conflict that names no span.
// This is documented, expected behaviour, NOT a bug: asserted here explicitly so a future change
// that "fixes" this by loosening the detector's syntax rules breaks a named test and forces a
// human to look, rather than silently regressing precision to chase one more recall point.

test('plan-span-replay: card 517 does NOT flag INV-13 (known blind spot: plan-517 names no line number for that file)', () => {
  assert.ok(
    !flaggedIds('517').includes('INV-13'),
    'card 517 must NOT flag INV-13 -- plan-517.md gives the detector no span to intersect against for this file, by design this is a miss, not a false negative to "fix"'
  );
});

// ---- calibration ratchet: the exact flagged-id set, per card, pinned as data --------------------
// Modelled on test/doc-constant-sweep.test.js's pinned-literal approach: each list below is a
// LITERAL derived from an actual run of the detector against the fixture corpus, not recomputed
// from the code under test at run time. Any detector change that alters what it flags on ANY of
// these ten real cards must fail this test by name -- that is the point: a silent widening or
// narrowing of the predicate should never ship without a human looking at exactly which card's
// flags changed and why.
const EXPECTED_FLAGGED_IDS = {
  487: ['INV-1', 'INV-2', 'INV-4', 'INV-5'],
  488: ['INV-4', 'INV-6', 'INV-7'],
  // 491 lost INV-9 when heading attribution was corrected from "nearest EARLIER heading that
  // names a path" to "nearest ANCESTOR heading" (plan-span-guard.js, extractPlanSpans).
  // plan-491.md line 133 sits under `## Why this satisfies the criterion` (line 126), a
  // level-2 SIBLING section, not a subsection of `### 6. ...profile-panel-profitloss.test.tsx`
  // (line 118); its `(:82-107)` is an ASP line range -- the two lines above it cite the same
  // page as `:183`, `:190` -- and was being attributed to the test file purely because that
  // heading happened to be the last path-bearing one seen. INV-9 is not in this card's
  // brokenIds, so dropping a flag it never needed changes no true positive: 491 still flags
  // INV-5 and INV-6, the two that actually broke at CHECK.
  491: ['INV-1', 'INV-2', 'INV-3', 'INV-5', 'INV-6', 'INV-8'],
  508: ['INV-1', 'INV-3', 'INV-4', 'INV-5'],
  517: ['INV-3', 'INV-5', 'INV-8'],
  462: ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6'],
  473: ['INV-1', 'INV-2', 'INV-4'],
  490: ['INV-10', 'INV-3', 'INV-4', 'INV-5', 'INV-6'],
  505: ['INV-1', 'INV-2', 'INV-4', 'INV-5', 'INV-6', 'INV-8'],
  506: ['INV-1', 'INV-2', 'INV-3', 'INV-5', 'INV-6', 'INV-9'],
};

for (const issue of ALL_CARDS) {
  test(`plan-span-replay: calibration ratchet -- card ${issue}'s exact flagged-id set is pinned`, () => {
    assert.deepEqual(
      flaggedIds(issue),
      EXPECTED_FLAGGED_IDS[issue].slice().sort(),
      `card ${issue}'s flagged-id set changed -- this is the calibration ratchet: a detector ` +
        'change that alters what it flags on a real corpus card must be looked at by a human, ' +
        'never silently re-pinned to whatever the new run produces'
    );
  });
}

// ---- the safety property the whole design rests on ----------------------------------------------
// A flag is only ever CONSULTED when CHECK reports that invariant as broken. On a card that never
// broke, a flag is noise nobody looks at -- that is what makes a false flag free. Prove it here:
// for every clean fixture card, the flagged-id set and that card's real brokenIds (from its own
// meta.json, derived from the journal) must not intersect. Since brokenIds is [] for all five
// clean cards (see the corpus README), this reduces to "the intersection with the empty set is
// empty" -- trivially true, but asserted explicitly and per-card so a future clean fixture whose
// brokenIds is NOT [] fails loudly here rather than silently invalidating the premise.
for (const issue of CLEAN_CARDS) {
  test(`plan-span-replay: card ${issue} is clean -- no flagged id is ever a broken id`, () => {
    const { meta } = loadFixture(issue);
    assert.deepEqual(meta.brokenIds, [], `card ${issue}'s fixture must be clean (brokenIds: []) -- if not, this fixture no longer belongs in the clean group`);
    const ids = flaggedIds(issue);
    const intersection = ids.filter((id) => meta.brokenIds.includes(id));
    assert.deepEqual(
      intersection,
      [],
      `card ${issue}: flagged ids must never intersect brokenIds on a clean card -- a flag here is consulted by nobody, so it must never coincide with an actual break`
    );
  });
}
