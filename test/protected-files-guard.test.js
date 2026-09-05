'use strict';
// Unit tests for action 3.2 -- the protected-files guard.
//
// CLAUDE.md documents a hard wall this pipeline cannot get around: '.claude/settings.json' and
// anything under '.claude/hooks/' are refused by the harness as sensitive files, regardless of
// what this repo's own permission rules say. A plan that requires editing either of them cannot
// succeed -- card #428 proved it the expensive way, burning $12.01 across PLAN and IMPLEMENT
// before parking anyway. Two pieces, tested together because they only make sense together:
//
//   - intake.js's detectProtectedFiles(text) -- the detector itself, a pure, deliberately blunt
//     case-insensitive substring scan. See its own header comment in orchestrator/intake.js for
//     the false-positive/false-negative history that led this action to be revised.
//   - state-machine.js's guardDeclaredFiles, reached from BOTH of handlePlan's paths (a fresh
//     reply and action 3.1's reuse of a plan already on disk): source 'files_to_change', scanning
//     PLAN's own structured file-list declaration, never plan_markdown prose.
//
// Two things changed on 2026-09-05 (#118), and most of this file's edits are theirs:
//
//   - The guard had NEVER RUN on a live card. Its shape test was Array.isArray(files_to_change),
//     and 93 of 93 real PLAN replies deliver that field as a JSON-encoded STRING. The scan sat in
//     an else-if nothing reached; 44 journalled 'plan-files-undeclared {receivedType:"string"}'
//     events are the record. It now parses the string shape (through park-loop.js's
//     normalizeFindingsPayload, the parser VALIDATE's identically-shaped 'findings' already
//     needed) and scans what it finds.
//
//   - handleIntake's site 1 -- the prose scan of the card's own criterion and title -- is GONE.
//     It fired exactly once in the whole corpus, on SPO-WebClient#482: the card written to fix
//     the guard, refused by the guard because its criterion QUOTES the protected paths as
//     examples. Prose cannot tell "EDITS this file" from "CITES this file" -- the same
//     measurement (33% precision) that had already retired the plan_markdown scan at site 2. The
//     tests below pin its absence, since that is a deliberate loss, not an oversight.
//
// The plan-reuse path had a third call site once; it was deleted on the argument that a dirty
// plan parks 'plan-requires-protected-files' (a PLAN_INVALIDATING_PARK_REASON) and so can never
// reach reuse. That argument assumed the guard worked. It did not, so the corpus holds 93 plans
// whose declarations were never judged, each one 'retry' away from being reused straight into
// IMPLEMENT -- the site is back, and tested.
//
// Same idioms as test/plan-resume.test.js (real-mode ctx via buildCtx + an injected
// deps.spawnSync, a call-counting spy to prove the LLM step is/isn't invoked) and
// test/intake.test.js (plain node:test + assert/strict, no custom harness). No real
// git/npm/gh/claude process is ever spawned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const intake = require('../orchestrator/intake');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');
const { writePoolDir } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJournal(taskDir) {
  const journalPath = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(journalPath)) return [];
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// =============================================================================================
// ---- detectProtectedFiles: the detector itself -----------------------------------------------
// =============================================================================================

test('detectProtectedFiles: matches .claude/settings.json', () => {
  const matches = intake.detectProtectedFiles('Edit .claude/settings.json to add the npm permission.');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '.claude/settings.json');
  assert.equal(matches[0].line, 'Edit .claude/settings.json to add the npm permission.');
});

test('detectProtectedFiles: matches .claude/settings.local.json', () => {
  const matches = intake.detectProtectedFiles('Edit .claude/settings.local.json for a local override.');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '.claude/settings.local.json');
});

test('detectProtectedFiles: matches .claude/hooks/pre-tool-use.sh', () => {
  const matches = intake.detectProtectedFiles('Patch .claude/hooks/pre-tool-use.sh to allow npm.');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '.claude/hooks/pre-tool-use.sh');
});

test('detectProtectedFiles: matches a path under .claude/hooks/ with no extension', () => {
  const matches = intake.detectProtectedFiles('Also touches .claude/hooks/pre-commit in the plan.');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '.claude/hooks/pre-commit');
});

test('detectProtectedFiles: case-insensitive (.CLAUDE/Settings.json)', () => {
  const matches = intake.detectProtectedFiles('See .CLAUDE/Settings.json for details.');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '.claude/settings.json');
});

test('detectProtectedFiles: matched inside backticks', () => {
  const matches = intake.detectProtectedFiles('- edit `.claude/settings.json` to allow npm');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '.claude/settings.json');
  assert.equal(matches[0].line, '- edit `.claude/settings.json` to allow npm');
});

test('detectProtectedFiles: matched inside a markdown list item -- only that line is reported', () => {
  const text = 'Plan:\n- step one\n- edit `.claude/settings.json` to allow npm\n- step three\n';
  const matches = intake.detectProtectedFiles(text);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, '- edit `.claude/settings.json` to allow npm');
});

test('detectProtectedFiles: matched mid-sentence', () => {
  const matches = intake.detectProtectedFiles('The fix requires touching .claude/hooks/guard.sh as part of the change.');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '.claude/hooks/guard.sh');
});

test('detectProtectedFiles: plain prose returns []', () => {
  assert.deepEqual(intake.detectProtectedFiles('Add a status badge to the header.'), []);
});

test('detectProtectedFiles: a card mentioning ".claude/" alone returns []', () => {
  assert.deepEqual(intake.detectProtectedFiles('Everything under .claude/ is off-limits to an agent.'), []);
});

test('detectProtectedFiles: a card mentioning "settings.json" alone (NOT under .claude/) returns []', () => {
  assert.deepEqual(intake.detectProtectedFiles('Update settings.json in the project root.'), []);
});

// The important negative: product cards for a React codebase mention `hooks/` constantly (a
// custom hook file), and the substring must never match outside '.claude/'.
test('detectProtectedFiles: a card mentioning src/hooks/useThing.ts returns [] (hooks/ outside .claude/ must not match)', () => {
  assert.deepEqual(intake.detectProtectedFiles('Refactor src/hooks/useThing.ts to memoize the selector.'), []);
});

test('detectProtectedFiles: null, undefined, empty string, and a non-string all return [] without throwing', () => {
  assert.deepEqual(intake.detectProtectedFiles(null), []);
  assert.deepEqual(intake.detectProtectedFiles(undefined), []);
  assert.deepEqual(intake.detectProtectedFiles(''), []);
  assert.deepEqual(intake.detectProtectedFiles(42), []);
  assert.deepEqual(intake.detectProtectedFiles({ not: 'a string' }), []);
  assert.deepEqual(intake.detectProtectedFiles(['.claude/settings.json']), []);
});

test('detectProtectedFiles: the match cap holds at 5 on a pathological input with many matches', () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}: .claude/hooks/file-${i}.sh`).join('\n');
  const matches = intake.detectProtectedFiles(text);
  assert.equal(matches.length, 5);
});

test('detectProtectedFiles: the stored line length caps at 200 chars on a pathological input', () => {
  const longSuffix = 'x'.repeat(1000);
  const text = `.claude/settings.json ${longSuffix}`;
  const matches = intake.detectProtectedFiles(text);
  assert.equal(matches.length, 1);
  assert.ok(matches[0].line.length <= 200, `expected line <= 200 chars, got ${matches[0].line.length}`);
});

// R4: match.path must be capped too, not just match.line -- an uncapped path goes verbatim into
// journal.jsonl and, through park-loop.js's park-comment builder, into a GitHub comment body.
// GitHub caps comment bodies at 65536 chars; without this cap a single pathological match could
// blow past that on its own and leave the card parked UNCOMMENTED.
test('detectProtectedFiles: match.path is capped at 200 chars on a pathological .claude/hooks/ path', () => {
  const text = '.claude/hooks/' + 'x'.repeat(1e6);
  const matches = intake.detectProtectedFiles(text);
  assert.equal(matches.length, 1);
  assert.ok(matches[0].path.length <= 200, `expected path <= 200 chars, got ${matches[0].path.length}`);
  assert.ok(matches[0].path.startsWith('.claude/hooks/'));
});

// =============================================================================================
// ---- handleIntake: source 'criterion' ---------------------------------------------------------
// =============================================================================================

// Same call-counting-spy idiom as test/plan-resume.test.js's countingSpawn -- handleIntake never
// spawns anything itself either way, but the point of the assertion is the same one CLAUDE.md and
// this action's own header make: INTAKE's scan must cost literally nothing, proven here by the
// injected spawnSync never being touched.
function countingSpawn(reply = { status: 0, stdout: '', stderr: '', signal: null }) {
  function spy() {
    spy.callCount += 1;
    return reply;
  }
  spy.callCount = 0;
  return spy;
}

function intakeCtx(task, overrides = {}) {
  const taskDir = mkTmp('spo-pfg-intake-');
  const spawnSync = countingSpawn();
  const ctx = buildCtx(task.id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    real: true,
    deps: { spawnSync },
    ...overrides,
  });
  return { ctx, spawnSync };
}

// #118 -- the regression this removal exists for. Crazz-Org/SPO-WebClient#482 is the card that
// reported the dead PLAN guard; its acceptance criterion quotes '.claude/settings.json' and
// '.claude/hooks/*.sh' as the examples a working guard must catch, so site 1 parked it at INTAKE
// and the fix could not be worked by the pipeline at all. One firing in the entire journal
// corpus, zero true positives. A card that merely NAMES a protected path must now walk through
// INTAKE; only PLAN's own machine-readable files_to_change declaration can park it.
test('handleIntake: a card whose CRITERION quotes a protected path is NOT parked -- reaches WORKTREE and journals INTAKE/ok (the SPO-WebClient#482 regression)', async () => {
  const task = {
    id: 'card-1001',
    kind: 'card',
    issue: 1001,
    title: 'The protected-files guard has never once run',
    criterion:
      'a plan declaring .claude/settings.json or .claude/hooks/*.sh parks with plan-requires-protected-files before IMPLEMENT spends anything',
  };
  const { ctx, spawnSync } = intakeCtx(task);

  const next = await HANDLERS.INTAKE(ctx);
  assert.equal(next, 'WORKTREE');
  assert.equal(spawnSync.callCount, 0, 'INTAKE still spawns nothing either way');

  const events = readJournal(ctx.taskDir);
  assert.ok(
    events.some((e) => e.state === 'INTAKE' && e.event === 'ok'),
    'INTAKE/ok must be journalled -- the card was not parked'
  );
  assert.ok(
    !events.some((e) => e.event === 'parked'),
    'no park event of any reason may be journalled for a card that only CITES a protected path'
  );
});

// The other half of the removed scan: the title was scanned too (with its own 'source' value, so
// a title-only hit could be told from a criterion hit). Both halves are gone, and a title naming
// a protected path is now exactly as harmless as one that does not.
test('handleIntake: a card whose TITLE names a protected path is NOT parked either -- reaches WORKTREE', async () => {
  const task = {
    id: 'card-1002',
    kind: 'card',
    issue: 1002,
    title: 'Patch .claude/hooks/pre-tool-use.sh to allow the new command',
    criterion: 'the new command runs without a permission prompt',
  };
  const { ctx } = intakeCtx(task);

  const next = await HANDLERS.INTAKE(ctx);
  assert.equal(next, 'WORKTREE');
});

test('handleIntake: a clean card does not park -- proceeds to WORKTREE', async () => {
  const task = {
    id: 'card-1003',
    kind: 'card',
    issue: 1003,
    title: 'Add a status badge to the header',
    criterion: 'the header shows a status badge reflecting connection state',
  };
  const { ctx } = intakeCtx(task);

  const next = await HANDLERS.INTAKE(ctx);
  assert.equal(next, 'WORKTREE');
});

test('handleIntake: shadow.forceState still short-circuits INTAKE entirely', async () => {
  const task = {
    id: 'card-1005',
    kind: 'card',
    issue: 1005,
    title: 'Edit .claude/settings.json please',
    criterion: 'also edit .claude/hooks/x',
    shadow: { forceState: 'MERGE' },
  };
  const taskDir = mkTmp('spo-pfg-intake-forcestate-');
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });

  const next = await HANDLERS.INTAKE(ctx);
  assert.equal(next, 'MERGE');
});

// Was M31 ("the real-flag gate must win over the protected-files guard when both would fire").
// Only one of the two can fire now, but the gate itself is what M31 was really protecting: a
// real-mode kind:"card" task without config.real must never proceed, whatever its prose says.
test('handleIntake: real-flag-required still parks a real-mode card without config.real, protected-path prose or not', async () => {
  const task = {
    id: 'card-1007',
    kind: 'card',
    issue: 1007,
    title: 'Allow the new build command',
    criterion: 'Edit .claude/settings.json to add the npm permission.',
  };
  const taskDir = mkTmp('spo-pfg-intake-realgate-');
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: false, dryRun: false, real: false });

  await assert.rejects(
    () => HANDLERS.INTAKE(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'real-flag-required');
      return true;
    }
  );
});

// =============================================================================================
// ---- handlePlan: source 'files_to_change' (normal path) ---------------------------------------
// =============================================================================================

// Same envelope/ctx-building idioms as test/plan-resume.test.js.
function planReplyEnvelope(planPayload) {
  return {
    status: 0,
    stdout: JSON.stringify({
      result: JSON.stringify(planPayload),
      is_error: false,
      num_turns: 1,
      session_id: 'sess-protected-files-guard',
      modelUsage: { 'claude-fable-5': { costUSD: 0.001 } },
      terminal_reason: 'success',
      api_error_status: null,
    }),
    stderr: '',
    signal: null,
  };
}

function realPlanCtx({ task, taskDir, worktreePath, spawnSync }) {
  const accountsDir = mkTmp('spo-pfg-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);
  return buildCtx(task.id, { ...task, worktreePath }, taskDir, {
    shadowMode: false,
    dryRun: false,
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
    deps: { spawnSync },
  });
}

function baseTask(overrides = {}) {
  return {
    id: 'card-1100',
    kind: 'card',
    issue: 1100,
    title: 'Some card',
    criterion: 'the thing is done',
    size: 'S',
    ...overrides,
  };
}

test('handlePlan: parks plan-requires-protected-files, source "files_to_change", when a declared file is .claude/settings.json -- plan file WRITTEN and named in the detail, IMPLEMENT never called', async () => {
  const taskDir = mkTmp('spo-pfg-plan-dirty-settings-');
  const worktreePath = mkTmp('spo-pfg-plan-dirty-settings-wt-');
  const dirtyPlan = {
    ok: true,
    plan_markdown: '# Plan\n\nAdd a status badge to the header.\n',
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: ['src/components/Header.tsx', '.claude/settings.json'],
  };
  const spawnSync = countingSpawn(planReplyEnvelope(dirtyPlan));
  const task = baseTask({ id: 'card-1101', issue: 1101 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'plan-requires-protected-files');
      assert.equal(err.detail.source, 'files_to_change');
      assert.equal(err.detail.matches.length, 1);
      assert.equal(err.detail.matches[0].path, '.claude/settings.json');
      assert.deepEqual(err.detail.declaredFiles, dirtyPlan.files_to_change);
      // #118, folded in from SPO-Pipeline#31: the park must NAME the plan file, which is what
      // makes the human handoff ("hand plan-<issue>.md to an interactive session") possible.
      assert.equal(err.detail.planPath, path.join(taskDir, 'scratch', 'plan-1101.md'));
      assert.equal(err.detail.invariantsPath, path.join(taskDir, 'scratch', 'invariants-1101.md'));
      return true;
    }
  );

  // The inversion of the assertion this test used to make. PLAN now writes plan-1101.md BEFORE
  // the guard runs: #31's acceptance criterion was that a human can pick the plan up from disk,
  // and while the park fired first the plan text existed only inside journal.jsonl. Reuse is not
  // opened up by the earlier write -- 'plan-requires-protected-files' is plan-invalidating, so
  // decidePlanReuse condition 6 refuses this very plan on the next retry.
  assert.equal(
    fs.readFileSync(path.join(taskDir, 'scratch', 'plan-1101.md'), 'utf8'),
    dirtyPlan.plan_markdown,
    'the plan a human is told to pick up must actually be on disk, with the text PLAN produced'
  );
  assert.ok(fs.existsSync(path.join(taskDir, 'scratch', 'invariants-1101.md')));
  // ...and the expensive part still does not run for a parking card.
  const parkedEvents = readJournal(taskDir);
  assert.ok(
    !parkedEvents.some((e) => e.state === 'PLAN' && e.event === 'invariants-baseline'),
    'buildBaseline must still happen strictly after the guard -- a parking card never pays for it'
  );
  assert.equal(spawnSync.callCount, 1, 'only the PLAN call itself ran; IMPLEMENT must never have been invoked');
});

test('handlePlan: parks plan-requires-protected-files, source "files_to_change", when a declared file is under .claude/hooks/', async () => {
  const taskDir = mkTmp('spo-pfg-plan-dirty-hooks-');
  const worktreePath = mkTmp('spo-pfg-plan-dirty-hooks-wt-');
  const dirtyPlan = {
    ok: true,
    plan_markdown: '# Plan\n\nAdd a status badge to the header.\n',
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: ['.claude/hooks/pre-tool-use.sh'],
  };
  const spawnSync = countingSpawn(planReplyEnvelope(dirtyPlan));
  const task = baseTask({ id: 'card-1103', issue: 1103 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'plan-requires-protected-files');
      assert.equal(err.detail.source, 'files_to_change');
      assert.equal(err.detail.matches.length, 1);
      assert.equal(err.detail.matches[0].path, '.claude/hooks/pre-tool-use.sh');
      return true;
    }
  );

  assert.ok(fs.existsSync(path.join(taskDir, 'scratch', 'plan-1103.md')));
  assert.equal(spawnSync.callCount, 1);
});

test('handlePlan: a clean files_to_change is not blocked -- the existing happy path still reaches IMPLEMENT with files written', async () => {
  const taskDir = mkTmp('spo-pfg-plan-clean-');
  const worktreePath = mkTmp('spo-pfg-plan-clean-wt-');
  const cleanPlan = {
    ok: true,
    plan_markdown: '# Plan\n\nAdd a status badge to the header.\n',
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: ['src/components/Header.tsx'],
  };
  const spawnSync = () => planReplyEnvelope(cleanPlan);
  const task = baseTask({ id: 'card-1102', issue: 1102 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.ok(fs.existsSync(path.join(taskDir, 'scratch', 'plan-1102.md')), 'the clean plan must still be written to scratch/');

  const events = readJournal(taskDir);
  assert.ok(
    !events.some((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared'),
    'a valid, clean files_to_change array must never journal plan-files-undeclared'
  );
});

// This is THE regression test for the entire revision: the guard must judge files_to_change,
// never plan_markdown prose, even when the prose is full of exactly the shapes that made the
// original prose scan measure 33% precision on the real corpus -- a falsification-sweep line, a
// `! test -e .../.claude/hooks/foo.sh` check command, and a `.claude/settings.json:109-127`
// citation (the real shapes from journal/issue-418 and journal/issue-429). None of that may park
// the task when files_to_change itself names nothing protected.
test('handlePlan: does NOT park when files_to_change is clean but plan_markdown prose is full of protected-path mentions -- reaches IMPLEMENT (the regression test for this revision)', async () => {
  const taskDir = mkTmp('spo-pfg-plan-prose-dirty-');
  const worktreePath = mkTmp('spo-pfg-plan-prose-dirty-wt-');
  const planMarkdown = [
    '# Plan',
    '',
    'Add a status badge to the header. This does not touch pipeline configuration.',
    '',
    '## Falsification sweep',
    '- `grep -rn "statusBadge" .claude/ CLAUDE.md doc/` -- confirms nothing elsewhere documents this behaviour differently.',
    '',
    '## Evidence',
    'The hook referenced by an earlier investigation is confirmed absent:',
    '`.claude/hooks/context-router.sh:117`. That file does not exist.',
    'Check command: `! test -e .claude/hooks/context-router.sh`',
    '',
    'See `.claude/settings.json:109-127` for the permission entry this plan relies on staying',
    'as-is (read-only citation, not a change).',
    '',
  ].join('\n');
  const dirtyProsePlan = {
    ok: true,
    plan_markdown: planMarkdown,
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: ['src/components/Header.tsx'],
  };
  const spawnSync = () => planReplyEnvelope(dirtyProsePlan);
  const task = baseTask({ id: 'card-1104', issue: 1104 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT', 'a plan whose PROSE mentions protected paths but whose files_to_change is clean must reach IMPLEMENT');
  assert.ok(fs.existsSync(path.join(taskDir, 'scratch', 'plan-1104.md')));
});

// =============================================================================================
// ---- handlePlan: 'plan-files-undeclared' journalling -------------------------------------------
// =============================================================================================

function undeclaredPlanCtx(idSuffix, filesToChangeValue) {
  const taskDir = mkTmp(`spo-pfg-undeclared-${idSuffix}-`);
  const worktreePath = mkTmp(`spo-pfg-undeclared-${idSuffix}-wt-`);
  const payload = {
    ok: true,
    plan_markdown: '# Plan\n\nAdd a status badge to the header.\n',
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
  };
  if (filesToChangeValue !== '__omit__') {
    payload.files_to_change = filesToChangeValue;
  }
  const spawnSync = () => planReplyEnvelope(payload);
  const task = baseTask({ id: `card-undecl-${idSuffix}`, issue: 1200 + Number(idSuffix.replace(/\D/g, '')) || 1200 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });
  return { ctx, taskDir };
}

test('handlePlan: files_to_change ABSENT -- journals plan-files-undeclared, does not park, reaches IMPLEMENT', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('1', '__omit__');
  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  const events = readJournal(taskDir);
  const ev = events.find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev, 'expected a plan-files-undeclared event');
  assert.equal(ev.receivedType, 'undefined');
});

test('handlePlan: files_to_change is null -- journals plan-files-undeclared, does not park, reaches IMPLEMENT', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('2', null);
  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  const events = readJournal(taskDir);
  const ev = events.find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev, 'expected a plan-files-undeclared event');
  assert.equal(ev.receivedType, 'object'); // typeof null === 'object'
});

test('handlePlan: files_to_change is a STRING (not an array) -- journals plan-files-undeclared, does not park, reaches IMPLEMENT', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('3', '.claude/settings.json');
  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  const events = readJournal(taskDir);
  const ev = events.find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev, 'expected a plan-files-undeclared event -- a bare string that is not JSON holds no declaration to scan');
  assert.equal(ev.receivedType, 'string');
  // #118: receivedType alone cannot tell this from the JSON-encoded string the wire actually
  // sends (both are typeof 'string'), and telling them apart is the whole evidence base for the
  // eventual promotion of files_to_change to a required key -- so the parser's own verdict is
  // journalled alongside it.
  assert.equal(ev.shape, 'unparsable-string');
});

test('handlePlan: files_to_change contains a NON-STRING entry -- journals plan-files-undeclared, does not park, reaches IMPLEMENT', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('4', ['src/components/Header.tsx', 42]);
  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  const events = readJournal(taskDir);
  const ev = events.find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev, 'expected a plan-files-undeclared event');
  assert.equal(ev.receivedType, 'array-with-non-string-entry');
});

// An empty array IS a real declaration ("this plan changes nothing already on record") -- treated
// as declared/clean, not undeclared. No park, and no plan-files-undeclared event either.
test('handlePlan: files_to_change is an EMPTY array -- treated as a clean declaration, no park, NO plan-files-undeclared event', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('5', []);
  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  const events = readJournal(taskDir);
  assert.ok(
    !events.some((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared'),
    'an empty files_to_change array is a real declaration and must not journal plan-files-undeclared'
  );
});

// =============================================================================================
// ---- handlePlan: receivedSample disambiguates null from absent (D12) ---------------------------
// =============================================================================================
//
// typeof null === 'object', same as typeof {}. receivedType alone cannot tell an absent/`null`
// declaration from a genuine (malformed) object reply -- receivedSample is what disambiguates,
// and it had zero coverage before this.

test('handlePlan: files_to_change ABSENT -- receivedType "undefined", receivedSample "null"', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('6', '__omit__');
  await HANDLERS.PLAN(ctx);
  const events = readJournal(taskDir);
  const ev = events.find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev);
  assert.equal(ev.receivedType, 'undefined');
  assert.equal(ev.receivedSample, 'null');
});

test('handlePlan: files_to_change is null -- receivedType "object" (typeof null) but receivedSample is also the literal "null"', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('7', null);
  await HANDLERS.PLAN(ctx);
  const events = readJournal(taskDir);
  const ev = events.find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev);
  assert.equal(ev.receivedType, 'object');
  assert.equal(ev.receivedSample, 'null');
});

test('handlePlan: files_to_change is a plain object -- receivedType "object", receivedSample is its JSON (distinguishes it from the null case above)', async () => {
  const { ctx, taskDir } = undeclaredPlanCtx('8', { a: 1 });
  await HANDLERS.PLAN(ctx);
  const events = readJournal(taskDir);
  const ev = events.find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev);
  assert.equal(ev.receivedType, 'object');
  assert.equal(ev.receivedSample, '{"a":1}');
});

// =============================================================================================
// ---- handlePlan: park-detail size bound on a pathological files_to_change (D1) -----------------
// =============================================================================================
//
// Before this fix: detectProtectedFiles caps matches per CALL (5), but the site-2 flatMap over
// every declared file made the total N x 5 -- unbounded -- and declaredFiles was filesToChange
// verbatim, uncapped in both element count and element length. Measured pre-fix:
// a single 70000-char entry -> 70,375-char detail; ~550 protected entries -> crosses 65,536.
// Both blow past GitHub's 65536-char comment-body cap, making `gh issue comment` fail and the
// card park UNCOMMENTED (and, via the pre-existing null-anchor bug this brief does not fix,
// retry/abandon-able by any historical comment on the issue thread).

test('handlePlan: D1 -- hundreds of protected declared files still yield a park detail well under the 65536-char GitHub comment cap', async () => {
  const taskDir = mkTmp('spo-pfg-plan-pathological-many-');
  const worktreePath = mkTmp('spo-pfg-plan-pathological-many-wt-');
  const manyFiles = Array.from({ length: 600 }, (_, i) => `.claude/hooks/file-${i}.sh`);
  const dirtyPlan = {
    ok: true,
    plan_markdown: '# Plan\n\nAdd a status badge to the header.\n',
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: manyFiles,
  };
  const spawnSync = countingSpawn(planReplyEnvelope(dirtyPlan));
  const task = baseTask({ id: 'card-pathological-many', issue: 9001 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  let caughtDetail;
  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'plan-requires-protected-files');
      caughtDetail = err.detail;
      return true;
    }
  );

  assert.equal(caughtDetail.declaredFileCount, 600, 'the true count must survive even though the list itself is truncated');
  assert.ok(caughtDetail.declaredFiles.length <= 50, `declaredFiles must be capped at 50 entries, got ${caughtDetail.declaredFiles.length}`);
  assert.ok(caughtDetail.matches.length <= 5, `matches must stay capped at 5 total, got ${caughtDetail.matches.length}`);

  const size = JSON.stringify(caughtDetail, null, 2).length;
  assert.ok(size < 65536, `park detail JSON.stringify size ${size} must stay well under GitHub's 65536-char comment cap`);
});

test('handlePlan: D1 -- a single pathologically long declared-file entry still yields a park detail well under the 65536-char GitHub comment cap', async () => {
  const taskDir = mkTmp('spo-pfg-plan-pathological-long-');
  const worktreePath = mkTmp('spo-pfg-plan-pathological-long-wt-');
  const longEntry = '.claude/hooks/' + 'x'.repeat(70000);
  const dirtyPlan = {
    ok: true,
    plan_markdown: '# Plan\n\nAdd a status badge to the header.\n',
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: [longEntry],
  };
  const spawnSync = countingSpawn(planReplyEnvelope(dirtyPlan));
  const task = baseTask({ id: 'card-pathological-long', issue: 9002 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  let caughtDetail;
  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      caughtDetail = err.detail;
      return true;
    }
  );

  const size = JSON.stringify(caughtDetail, null, 2).length;
  assert.ok(size < 65536, `park detail JSON.stringify size ${size} must stay well under GitHub's 65536-char comment cap`);
});

// =============================================================================================
// ---- prompts/plan.md coverage (D5/D6) -----------------------------------------------------------
// =============================================================================================
//
// prompts/plan.md is the load-bearing half of this feature and had zero coverage: two mutations
// survived the full suite -- deleting files_to_change from the header envelope, and renumbering
// its item 4->5. This also covers D6: 'optional' is read by nothing else, so deleting
// step-contracts.js's `optional: ['files_to_change']` line makes `contract.optional` undefined,
// and `[...contract.optional]` below throws -- failing this same test.

const stepContracts = require('../orchestrator/step-contracts');

test('prompts/plan.md: header envelope declares files_to_change, and its key set matches resolveStepContract(PLAN).outputContract required+optional (kills the "delete files_to_change from envelope" and "delete optional array" mutants)', () => {
  const planMd = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'plan.md'), 'utf8');
  assert.ok(planMd.includes('"files_to_change"'), 'expected the header output envelope to declare files_to_change');

  const headerMatch = planMd.match(/Output.*?:\s*\n\s*\{([\s\S]*?)\}\s*\n-->/);
  assert.ok(headerMatch, 'expected to find the header output envelope JSON block in the leading HTML comment');
  const keys = [...headerMatch[1].matchAll(/"(\w+)":/g)].map((m) => m[1]);

  const contract = stepContracts.resolveStepContract('PLAN').outputContract;
  const expected = [...contract.required, ...contract.optional].sort();

  assert.deepEqual(keys.sort(), expected);
});

test('prompts/plan.md: the files_to_change instruction is numbered item 4 (kills the item 4->5 renumbering mutant)', () => {
  const planMd = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'plan.md'), 'utf8');
  const match = planMd.match(/^(\d+)\.\s+\*\*`files_to_change`\*\*/m);
  assert.ok(match, 'expected a numbered list item introducing files_to_change');
  assert.equal(match[1], '4');
});

// =============================================================================================
// ---- handlePlan: the JSON-encoded string shape -- #118, the defect that made the guard dead ---
// =============================================================================================

// Measured on the real corpus 2026-09-05: 93 of 93 PLAN replies that carry files_to_change send
// it like this -- a JSON-encoded STRING holding an array of ABSOLUTE paths under the card's
// worktree -- and 0 send a real array. Every test above this line that feeds a bare array is
// therefore testing a shape no live card has ever produced; these are the ones that exercise the
// wire.
function jsonStringPlanCtx(idSuffix, filesToChangeJson, extra = {}) {
  const taskDir = mkTmp(`spo-pfg-wire-${idSuffix}-`);
  const worktreePath = mkTmp(`spo-pfg-wire-${idSuffix}-wt-`);
  const payload = {
    ok: true,
    plan_markdown: '# Plan\n\nAdd a status badge to the header.\n',
    invariants_markdown: '# Invariants\n\nINV-1: ...\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: filesToChangeJson,
    ...extra,
  };
  const spawnSync = countingSpawn(planReplyEnvelope(payload));
  const task = baseTask({ id: `card-wire-${idSuffix}`, issue: 1300 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });
  return { ctx, taskDir, spawnSync, payload };
}

// THE regression test for #118. Before the fix this exact input reached IMPLEMENT: Array.isArray
// said false, the guard journalled plan-files-undeclared and fell through to an else-if it could
// not reach. It must now park -- and on the absolute path shape prompts/plan.md actually
// specifies, which is the trap the card flagged as assumed-but-unpinned.
test('handlePlan: files_to_change as a JSON-ENCODED STRING naming .claude/settings.json parks plan-requires-protected-files (the #118 regression -- this is the shape 93/93 real replies send)', async () => {
  const declared = ['/home/crazz/SPO-Pipeline/worktrees/issue-1300/src/components/Header.tsx', '/home/crazz/SPO-Pipeline/worktrees/issue-1300/.claude/settings.json'];
  const { ctx, taskDir, spawnSync } = jsonStringPlanCtx('settings', JSON.stringify(declared));

  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'plan-requires-protected-files');
      assert.equal(err.detail.source, 'files_to_change');
      assert.equal(err.detail.matches.length, 1);
      assert.equal(err.detail.matches[0].path, '.claude/settings.json');
      assert.deepEqual(err.detail.declaredFiles, declared, 'the park reports the paths as declared, absolute');
      assert.equal(err.detail.declaredFileCount, 2);
      return true;
    }
  );

  assert.equal(spawnSync.callCount, 1, 'IMPLEMENT must never have been invoked');
  const events = readJournal(taskDir);
  assert.ok(
    !events.some((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared'),
    'a JSON-encoded array of strings IS a declaration -- journalling it as undeclared is the old bug'
  );
});

test('handlePlan: files_to_change as a JSON-encoded string naming a file under .claude/hooks/ parks too -- absolute path, matched on the substring', async () => {
  const { ctx } = jsonStringPlanCtx('hooks', JSON.stringify(['/home/crazz/SPO-Pipeline/worktrees/issue-1300/.claude/hooks/pre-tool-use.sh']));

  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => {
      assert.equal(err.reason, 'plan-requires-protected-files');
      assert.equal(err.detail.matches[0].path, '.claude/hooks/pre-tool-use.sh');
      return true;
    }
  );
});

// The negative that keeps the fix honest, drawn from the corpus rather than invented: the only
// '.claude/' paths any real plan has ever declared are under .claude/agents/, .claude/commands/
// and .claude/skills/ (12 entries, issues #640 and #671). Those are ordinary editable files --
// detectProtectedFiles deliberately matches only settings.json, settings.local.json and
// .claude/hooks/. A guard that starts firing must not start firing wrongly.
test('handlePlan: a JSON-encoded declaration naming .claude/agents/ and .claude/commands/ files does NOT park -- reaches IMPLEMENT (the real corpus shape from issues #640/#671)', async () => {
  const { ctx, taskDir } = jsonStringPlanCtx(
    'agents',
    JSON.stringify(['/home/crazz/SPO-Pipeline/worktrees/issue-1300/.claude/agents/citation-verifier.md', '/home/crazz/SPO-Pipeline/worktrees/issue-1300/.claude/commands/triage-report.md'])
  );

  assert.equal(await HANDLERS.PLAN(ctx), 'IMPLEMENT');
  const events = readJournal(taskDir);
  assert.ok(!events.some((e) => e.event === 'parked'));
  assert.ok(!events.some((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared'));
});

test('handlePlan: a clean JSON-encoded declaration reaches IMPLEMENT and journals NO plan-files-undeclared -- the 44 fail-open events end here', async () => {
  const { ctx, taskDir } = jsonStringPlanCtx('clean', JSON.stringify(['/home/crazz/SPO-Pipeline/worktrees/issue-1300/src/components/Header.tsx']));

  assert.equal(await HANDLERS.PLAN(ctx), 'IMPLEMENT');
  const events = readJournal(taskDir);
  assert.ok(!events.some((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared'));
  assert.ok(fs.existsSync(path.join(taskDir, 'scratch', 'plan-1300.md')));
});

test('handlePlan: "[]" -- an EMPTY JSON-encoded array is a clean declaration, exactly like the empty array: no park, no plan-files-undeclared', async () => {
  const { ctx, taskDir } = jsonStringPlanCtx('empty', '[]');

  assert.equal(await HANDLERS.PLAN(ctx), 'IMPLEMENT');
  const events = readJournal(taskDir);
  assert.ok(!events.some((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared'));
});

test('handlePlan: a JSON string that parses to an OBJECT is still undeclared -- receivedType "string", shape "json-string-object"', async () => {
  const { ctx, taskDir } = jsonStringPlanCtx('object', '{"files":["a.ts"]}');

  assert.equal(await HANDLERS.PLAN(ctx), 'IMPLEMENT');
  const ev = readJournal(taskDir).find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev);
  assert.equal(ev.receivedType, 'string');
  assert.equal(ev.shape, 'json-string-object');
});

test('handlePlan: a JSON string that parses to an array with a NON-STRING entry is undeclared -- receivedType "json-string-with-non-string-entry"', async () => {
  const { ctx, taskDir } = jsonStringPlanCtx('mixed', JSON.stringify(['/home/crazz/SPO-Pipeline/worktrees/issue-1300/src/a.ts', 42]));

  assert.equal(await HANDLERS.PLAN(ctx), 'IMPLEMENT');
  const ev = readJournal(taskDir).find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev);
  assert.equal(ev.receivedType, 'json-string-with-non-string-entry');
  assert.equal(ev.shape, 'json-string');
});

// =============================================================================================
// ---- handlePlan: the action-3.1 reuse path scans its carried-forward declaration (#118) -------
// =============================================================================================

// The site deleted when this action was first revised, restored because its deletion argument
// assumed a guard that worked. It did not: the corpus holds 93 plans whose files_to_change was
// never judged, and any one of them is a single `retry` away from being reused straight into
// IMPLEMENT. Fixture shape borrowed from test/plan-resume.test.js's priorPlanRun.
function priorPlanRun(taskDir, { baseMainSha, filesToChange }) {
  const dir = path.join(taskDir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan-1400.md');
  const invariantsPath = path.join(dir, 'invariants-1400.md');
  fs.writeFileSync(planPath, '# Plan\n\nDo the thing.\n');
  fs.writeFileSync(invariantsPath, '# Invariants\n\nINV-1: ...\n');
  const payload = {
    ok: true,
    plan_path: planPath,
    invariants_path: invariantsPath,
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: filesToChange,
  };
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha });
  appendEvent(taskDir, 'PLAN', 'result', { payload });
  return { planPath, invariantsPath };
}

test('handlePlan: a REUSED plan whose declaration names a protected file parks instead of reaching IMPLEMENT -- reused:true in the detail, LLM never invoked', async () => {
  const taskDir = mkTmp('spo-pfg-reuse-dirty-');
  const worktreePath = mkTmp('spo-pfg-reuse-dirty-wt-');
  const { planPath } = priorPlanRun(taskDir, {
    baseMainSha: 'sha-X',
    filesToChange: JSON.stringify(['/home/crazz/SPO-Pipeline/worktrees/issue-1300/.claude/settings.json']),
  });
  const spawnSync = countingSpawn(planReplyEnvelope({ ok: true, plan_markdown: 'must not be read', invariants_markdown: 'must not be read' }));
  const task = baseTask({ id: 'card-1400', issue: 1400, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'plan-requires-protected-files');
      assert.equal(err.detail.source, 'files_to_change');
      assert.equal(err.detail.reused, true, 'the detail must say the declaration came from a reused plan');
      assert.equal(err.detail.planPath, planPath);
      return true;
    }
  );
  assert.equal(spawnSync.callCount, 0, 'a reuse never calls the LLM -- not even to park');

  const events = readJournal(taskDir);
  assert.ok(events.some((e) => e.event === 'plan-reused'), 'the run really did take the reuse path');
  assert.ok(
    !events.some((e) => e.state === 'PLAN' && e.event === 'invariants-baseline'),
    'the guard runs before the baseline rebuild on the reuse path too'
  );
});

test('handlePlan: a REUSED plan with a clean declaration still reaches IMPLEMENT -- the restored site does not break reuse', async () => {
  const taskDir = mkTmp('spo-pfg-reuse-clean-');
  const worktreePath = mkTmp('spo-pfg-reuse-clean-wt-');
  priorPlanRun(taskDir, {
    baseMainSha: 'sha-X',
    filesToChange: JSON.stringify(['/home/crazz/SPO-Pipeline/worktrees/issue-1300/src/components/Header.tsx']),
  });
  const spawnSync = countingSpawn(planReplyEnvelope({ ok: true, plan_markdown: 'must not be read', invariants_markdown: 'must not be read' }));
  const task = baseTask({ id: 'card-1401', issue: 1400, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  assert.equal(await HANDLERS.PLAN(ctx), 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0);
});

test('handlePlan: a REUSED plan that declares nothing at all journals plan-files-undeclared with reused:true, and still reaches IMPLEMENT', async () => {
  const taskDir = mkTmp('spo-pfg-reuse-undecl-');
  const worktreePath = mkTmp('spo-pfg-reuse-undecl-wt-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X', filesToChange: undefined });
  const spawnSync = countingSpawn(planReplyEnvelope({ ok: true, plan_markdown: 'x', invariants_markdown: 'y' }));
  const task = baseTask({ id: 'card-1402', issue: 1400, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  assert.equal(await HANDLERS.PLAN(ctx), 'IMPLEMENT');
  const ev = readJournal(taskDir).find((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared');
  assert.ok(ev, 'a plan written before this fix carries no declaration at all -- say so on the record');
  assert.equal(ev.reused, true);
  assert.equal(ev.receivedType, 'undefined');
});
