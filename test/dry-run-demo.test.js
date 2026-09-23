'use strict';
// The --dry-run demo: a synthetic card-shaped task walked end to end with `--dry-run --once`
// against a temp queue/journal, zero real `claude` CLI calls, zero spawned commands. Exercises
// step-contracts.js + prompt-template.js + task-values.js wired all the way through
// orchestrator/daemon.js -- not just the unit-level pieces the other new test files cover.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below (this
// file's own orchestrator require is inline, inside a single test body further down).
require('./no-real-spawn');

const { mkTmp, writeTask, runDaemonDryRun, readJournal, readState } = require('./helpers');

test('dry-run demo: a card task reaches DONE with dryrun-<STATE>.md for every LLM step it hits, no llm-call events', () => {
  const queueDir = mkTmp('spo-queue-dryrun-');
  const journalDir = mkTmp('spo-journal-dryrun-');
  const worktreePath = mkTmp('spo-dryrun-worktree-');

  writeTask(queueDir, '001-card.json', {
    id: 'card-dryrun-001',
    title: 'Add a status badge to the header',
    kind: 'card',
    issue: 123,
    criterion: 'the header shows a status badge reflecting connection state',
    worktreePath,
    size: 'S',
    touchesRdoMembers: false,
  });

  const out = runDaemonDryRun(queueDir, journalDir);
  assert.match(out, /card-dryrun-001\s+DONE/);

  const state = readState(journalDir, 'card-dryrun-001');
  assert.equal(state.state, 'DONE');

  const taskDir = path.join(journalDir, 'card-dryrun-001');

  // Every LLM step this happy path reaches (PLAN, IMPLEMENT, VALIDATE -- DIAGNOSE and
  // CITATION_VERIFIER are never reached) gets its own dryrun-<STATE>.md.
  for (const step of ['PLAN', 'IMPLEMENT', 'VALIDATE']) {
    assert.ok(fs.existsSync(path.join(taskDir, `dryrun-${step}.md`)), `expected dryrun-${step}.md`);
  }
  assert.ok(!fs.existsSync(path.join(taskDir, 'dryrun-DIAGNOSE.md')));
  assert.ok(!fs.existsSync(path.join(taskDir, 'dryrun-CITATION_VERIFIER.md')));

  // handlePlan (state-machine.js) writes PLAN's two documents itself -- even under --dry-run,
  // from the canned plan_markdown/invariants_markdown steps/llm.js's cannedDryRunPayload
  // supplies -- at the same scratch_dir/plan-<issue>.md convention a real PLAN reply would use.
  assert.ok(fs.existsSync(path.join(taskDir, 'scratch', 'plan-123.md')), 'expected scratch/plan-123.md to be written');
  assert.ok(
    fs.existsSync(path.join(taskDir, 'scratch', 'invariants-123.md')),
    'expected scratch/invariants-123.md to be written'
  );

  const events = readJournal(journalDir, 'card-dryrun-001');
  assert.ok(events.some((e) => e.event === 'dry-run' && e.state === 'PLAN'));
  assert.ok(events.some((e) => e.event === 'dry-run' && e.state === 'IMPLEMENT'));
  assert.ok(events.some((e) => e.event === 'dry-run' && e.state === 'VALIDATE'));
  assert.ok(!events.some((e) => e.event === 'llm-call'), 'dry-run must never produce a real llm-call event');

  // Order still runs the full lifecycle -- --dry-run does not skip any state, it only skips the
  // spawn inside the LLM/scripted steps.
  const order = [];
  for (const e of events) {
    if (order[order.length - 1] !== e.state) order.push(e.state);
  }
  assert.deepEqual(order, [
    'INTAKE',
    'WORKTREE',
    'PLAN',
    'IMPLEMENT',
    'CHECK',
    'PUSH_PR',
    'GATE',
    'CI_CHECKS',
    'VALIDATE',
    'MERGE',
    'FINISH',
    'DONE',
  ]);
});

test('dry-run demo: dryrun-PLAN.md shows the query() options (model/effort/json-schema/sessionId) and the filled prompt -- sessionId carries the stable placeholder, never a fabricated real id, since a dry run never calls query()', () => {
  // Action A5b (card #239 chantier, the cutover): this test used to assert against the old
  // transport's argv array (`"--model","opus"`, etc, written under a `## argv` heading).
  // steps/llm.js's writeDryRunArtifact now shows buildQueryOptions's own `options` object as
  // JSON under a `## query() options` heading instead (see that function's own header for why:
  // there is no argv any more, and the artifact's whole point is to show what would actually be
  // sent). Rewritten to parse that JSON and assert on its fields directly, rather than pattern-
  // matching a serialized array shape that no longer exists.
  const queueDir = mkTmp('spo-queue-dryrun-argv-');
  const journalDir = mkTmp('spo-journal-dryrun-argv-');
  const worktreePath = mkTmp('spo-dryrun-argv-worktree-');

  writeTask(queueDir, '001-card.json', {
    id: 'card-dryrun-argv',
    title: 'Add a status badge',
    kind: 'card',
    issue: 456,
    criterion: 'a badge appears',
    worktreePath,
    size: 'M',
    touchesRdoMembers: false,
  });

  runDaemonDryRun(queueDir, journalDir);

  const planFile = path.join(journalDir, 'card-dryrun-argv', 'dryrun-PLAN.md');
  const content = fs.readFileSync(planFile, 'utf8');

  assert.match(content, /## query\(\) options/);
  const jsonMatch = content.match(/## query\(\) options\n```json\n([\s\S]*?)\n```/);
  assert.ok(jsonMatch, 'expected a fenced ```json block under "## query() options"');
  const options = JSON.parse(jsonMatch[1]);

  // EXP-PLAN-OPUS (doc/model-experiments.md), superseded 2026-09-23 by EXP-IMPLEMENT-OPUS-5-5's
  // repo-wide OPUS_5_5 switch: no planInvalidRetry -> PLAN's base model, now Opus 5.5.
  assert.equal(options.model, 'claude-opus-5-5');
  assert.equal(options.effort, 'high'); // size "M" -> effort "high" (PLAN_EFFORT_BY_SIZE)
  assert.equal(options.outputFormat.type, 'json_schema');
  assert.ok('plan_markdown' in options.outputFormat.schema.properties, 'expected PLAN\'s output contract inside the json schema');

  // A dry run never calls query(), so no real session id exists to show -- steps/llm.js's runLlm
  // overlays the stable literal placeholder '<generated-at-spawn>' onto the DISPLAY copy of
  // options instead (never a generated UUID, which would fabricate a real, joinable id for a call
  // that never happened -- see writeDryRunArtifact's own call site comment). Previously
  // --session-id was omitted from this artifact entirely, which an earlier version of this test
  // did not catch even though its own name claimed to show "the real argv".
  assert.equal(options.sessionId, '<generated-at-spawn>');

  // env/abortController/spawnClaudeCodeProcess are deliberately EXCLUDED from the artifact (see
  // writeDryRunArtifact's own header: env can carry a live CLAUDE_CODE_OAUTH_TOKEN, and the other
  // two are call machinery, not information about what would be sent).
  assert.equal('env' in options, false, 'the dry-run artifact must never carry env (it can hold a live credential)');
  assert.equal('abortController' in options, false);
  assert.equal('spawnClaudeCodeProcess' in options, false);

  assert.match(content, /## filled prompt/);
  assert.match(content, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(content, /Add a status badge/);
});

test('dry-run demo: a card task with no pre-set worktreePath (as makeTask produces it) still reaches DONE, not PARKED', () => {
  // Mirrors orchestrator/intake.js's makeTask() task shape exactly -- no worktreePath, no branch,
  // since those are only ever set by a real `git worktree add` (realWorktree). --dry-run's
  // generic scripted-WORKTREE path must synthesize them itself, or PLAN's prompt template is
  // left with an unfilled `worktree` placeholder and the task PARKs instead of reaching DONE.
  const queueDir = mkTmp('spo-queue-dryrun-notree-');
  const journalDir = mkTmp('spo-journal-dryrun-notree-');

  writeTask(queueDir, '001-issue-789.json', {
    id: 'issue-789',
    kind: 'card',
    issue: 789,
    title: 'Add a status badge to the header',
    criterion: 'the header shows a status badge reflecting connection state',
    size: 'S',
    area: 'client',
    touchesRdoMembers: false,
  });

  const out = runDaemonDryRun(queueDir, journalDir);
  assert.match(out, /issue-789\s+DONE/);

  const state = readState(journalDir, 'issue-789');
  assert.equal(state.state, 'DONE');

  const planFile = path.join(journalDir, 'issue-789', 'dryrun-PLAN.md');
  assert.ok(fs.existsSync(planFile), 'expected dryrun-PLAN.md to be written (task must not PARK at PLAN)');

  const content = fs.readFileSync(planFile, 'utf8');
  assert.match(content, /## filled prompt/);
  assert.match(content, /worktree:\s*\S/, 'expected the worktree: placeholder to be filled, not left blank');
});

test('dry-run demo: WORKTREE-side steps (PLAN, IMPLEMENT) never spawn -- deps.spawnSync would fail the test if called', () => {
  // Exercised end to end through the daemon subprocess in the tests above (no injection point
  // reaches into a spawned subprocess); this test asserts the same guarantee at the runLlm
  // level, where a spawnSync call IS observable.
  const { runLlm } = require('../orchestrator/steps/llm');
  const taskDir = mkTmp('spo-dryrun-nospawn-');
  const worktreePath = mkTmp('spo-dryrun-nospawn-worktree-');

  const ctx = {
    shadowMode: false,
    dryRun: true,
    taskDir,
    task: { kind: 'card', issue: 1, title: 't', criterion: 'c', worktreePath, size: 'S' },
    account: { name: 'default', configDir: null },
    config: { stepDeadlineMs: 30000 },
  };

  let spawned = false;
  const deps = { spawnSync: () => { spawned = true; return { status: 0, stdout: '{}', stderr: '', signal: null }; } };

  return runLlm(ctx, 'PLAN', 'llm.PLAN', deps).then((result) => {
    assert.equal(spawned, false, '--dry-run must never call spawnSync');
    assert.equal(result.dryRun, true);
    assert.equal(result.ok, true);
    assert.deepEqual(
      Object.keys(result).sort(),
      ['check_commands', 'dryRun', 'files_to_change', 'invariant_ids', 'invariants_markdown', 'ok', 'plan_markdown'].sort()
    );
  });
});
