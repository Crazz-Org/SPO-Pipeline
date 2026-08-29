'use strict';
// The --dry-run demo: a synthetic card-shaped task walked end to end with `--dry-run --once`
// against a temp queue/journal, zero real `claude` CLI calls, zero spawned commands. Exercises
// step-contracts.js + prompt-template.js + task-values.js wired all the way through
// orchestrator/daemon.js -- not just the unit-level pieces the other new test files cover.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

test('dry-run demo: dryrun-PLAN.md shows the real argv (--model/--effort/--json-schema) and the filled prompt', () => {
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

  assert.match(content, /## argv/);
  assert.match(content, /--model/);
  assert.match(content, /fable/); // no escalation flags set -> base model
  assert.match(content, /--effort/);
  assert.match(content, /medium/); // size "M" -> effort "medium"
  assert.match(content, /--json-schema/);
  assert.match(content, /plan_markdown/); // PLAN's output contract, inside the json-schema

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
      ['check_commands', 'dryRun', 'invariant_ids', 'invariants_markdown', 'ok', 'plan_markdown'].sort()
    );
  });
});
