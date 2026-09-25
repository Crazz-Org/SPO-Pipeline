'use strict';
// Unit tests for scripts/model-report.js -- the measuring tool doc/model-experiments.md's audits run.
// Pure: a throwaway journal dir, no spawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const { readTaskEvents, summarize, parseArgs, median } = require('../scripts/model-report');
const { mkTmp } = require('./helpers');

function writeJournal(root, id, events) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

const call = (ts, state, model, effort, extra = {}) => ({
  ts,
  state,
  event: 'llm-call',
  model,
  effort,
  ok: true,
  duration_s: 100,
  billableTokens: 1000,
  numTurns: 10,
  ...extra,
});

function corpus() {
  const root = mkTmp('spo-model-report-');
  // Pre-experiment card: Fable PLAN, two IMPLEMENT calls, one DIAGNOSE, merged.
  writeJournal(root, 'issue-1', [
    call('2026-09-10T10:00:00Z', 'PLAN', 'fable', 'low', { duration_s: 200, billableTokens: 80000 }),
    call('2026-09-10T10:10:00Z', 'IMPLEMENT', 'sonnet', 'medium'),
    call('2026-09-10T10:20:00Z', 'DIAGNOSE', 'opus', 'high'),
    call('2026-09-10T10:30:00Z', 'IMPLEMENT', 'opus', 'medium'),
    { ts: '2026-09-10T11:00:00Z', state: 'DONE', event: 'done' },
  ]);
  // Opus reply invalid -> in-run Fable fallback -> merged with one IMPLEMENT call.
  writeJournal(root, 'issue-2', [
    call('2026-09-14T10:00:00Z', 'PLAN', 'opus', 'medium', { billableTokens: 40000 }),
    { ts: '2026-09-14T10:05:00Z', state: 'PLAN', event: 'plan-model-fallback', cause: 'plan-invalid-reply', missing: ['plan_markdown'] },
    call('2026-09-14T10:06:00Z', 'PLAN', 'fable', 'medium', { billableTokens: 90000 }),
    call('2026-09-14T10:20:00Z', 'IMPLEMENT', 'sonnet', 'medium'),
    { ts: '2026-09-14T11:00:00Z', state: 'DONE', event: 'done' },
  ]);
  // Opus-only PLAN whose call failed, parked at PLAN.
  writeJournal(root, 'issue-3', [
    call('2026-09-15T10:00:00Z', 'PLAN', 'opus', 'high', { ok: false }),
    { ts: '2026-09-15T10:01:00Z', state: 'PLAN', event: 'parked', reason: 'llm-transport-failed:PLAN' },
  ]);
  // Never reached PLAN.
  writeJournal(root, 'issue-4', [{ ts: '2026-09-15T09:00:00Z', state: 'WORKTREE', event: 'parked', reason: 'worktree-failed' }]);
  // A torn last line must not break the reader.
  fs.appendFileSync(path.join(root, 'issue-4', 'journal.jsonl'), '{"ts":"2026-09-15T09:0');
  return root;
}

test('median: odd, even (upper middle), empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([]), null);
});

test('readTaskEvents: one entry per task dir, torn lines skipped, missing journal dir is empty', () => {
  const root = corpus();
  const tasks = readTaskEvents(root);
  assert.deepEqual(tasks.map((t) => t.id).sort(), ['issue-1', 'issue-2', 'issue-3', 'issue-4']);
  assert.equal(tasks.find((t) => t.id === 'issue-4').events.length, 1);
  assert.deepEqual(readTaskEvents(path.join(root, 'nope')), []);
});

test('summarize: calls are one row per step x model x effort with medians and totals', () => {
  const report = summarize(readTaskEvents(corpus()));
  const planRows = report.calls.filter((r) => r.step === 'PLAN');
  assert.deepEqual(
    planRows.map((r) => `${r.model}/${r.effort}`),
    ['fable/low', 'fable/medium', 'opus/high', 'opus/medium']
  );
  const opusHigh = planRows.find((r) => r.model === 'opus' && r.effort === 'high');
  assert.equal(opusHigh.n, 1);
  assert.equal(opusHigh.ok, 0);
  const implementSonnet = report.calls.find((r) => r.step === 'IMPLEMENT' && r.model === 'sonnet');
  assert.equal(implementSonnet.n, 2);
  assert.equal(implementSonnet.totalBillableTokens, 2000);
  assert.equal(report.planFallbacks['plan-invalid-reply'], 1);
});

test('summarize: cards group by how PLAN ran, with downstream cost per DONE card', () => {
  const { cardsByPlanModel } = summarize(readTaskEvents(corpus()));
  assert.deepEqual(cardsByPlanModel.fable, {
    cards: 1,
    done: 1,
    parkedAtPlan: 0,
    implementCallsPerDone: 2,
    diagnoseCallsPerDone: 1,
    medianBillableTokensPerDone: 83000,
  });
  assert.equal(cardsByPlanModel['opus->fable'].done, 1);
  assert.equal(cardsByPlanModel['opus->fable'].implementCallsPerDone, 1);
  assert.deepEqual(cardsByPlanModel.opus, {
    cards: 1,
    done: 0,
    parkedAtPlan: 1,
    implementCallsPerDone: null,
    diagnoseCallsPerDone: null,
    medianBillableTokensPerDone: null,
  });
  assert.equal(cardsByPlanModel.none.cards, 1);
});

test('summarize: --since picks cards by their FIRST PLAN call and calls by their own ts; --step filters calls', () => {
  const report = summarize(readTaskEvents(corpus()), { since: '2026-09-13', step: 'PLAN' });
  assert.ok(report.calls.every((r) => r.step === 'PLAN'));
  assert.ok(!report.calls.some((r) => r.model === 'fable' && r.effort === 'low'), 'the 2026-09-10 call is outside the window');
  assert.equal(report.cardsByPlanModel.fable, undefined, 'issue-1 was first planned before the window');
  assert.equal(report.cardsByPlanModel.none, undefined, 'a card with no PLAN call has no date to window on');
  assert.equal(report.cardsByPlanModel['opus->fable'].cards, 1);
  assert.equal(report.cardsByPlanModel.opus.cards, 1);
});

test('summarize: modelFallbacks and judgeVerdicts separate the Opus 5.5 fallback judge from the base one (SPO-Pipeline#166)', () => {
  const root = mkTmp('spo-model-report-166-');
  writeJournal(root, 'issue-10', [
    call('2026-09-20T09:59:00Z', 'VALIDATE', 'fable', 'high'),
    { ts: '2026-09-20T10:00:00Z', state: 'VALIDATE', event: 'change-validator', verdict: 'PASS' },
    call('2026-09-20T10:59:00Z', 'VALIDATE', 'fable', 'xhigh'),
    { ts: '2026-09-20T11:00:00Z', state: 'VALIDATE', event: 'change-validator', verdict: 'REJECT' },
    call('2026-09-20T11:29:00Z', 'CITATION_VERIFIER', 'fable', 'high'),
    { ts: '2026-09-20T11:30:00Z', state: 'VALIDATE', event: 'citation-verifier', verdict: 'PASS', entries: [] },
  ]);
  writeJournal(root, 'issue-11', [
    call('2026-09-25T08:59:00Z', 'CITATION_VERIFIER', 'fable', 'high', { ok: false }),
    { ts: '2026-09-25T09:00:00Z', state: 'CITATION_VERIFIER', event: 'model-fallback', step: 'CITATION_VERIFIER', from: 'fable', to: 'claude-opus-5-5', cause: 'model-limit', trigger: 'limit-result' },
    call('2026-09-25T09:00:30Z', 'CITATION_VERIFIER', 'claude-opus-5-5', 'high', { quotaFallback: true }),
    { ts: '2026-09-25T09:01:00Z', state: 'VALIDATE', event: 'citation-verifier', verdict: 'PASS', entries: [], quotaFallback: true, judgeModel: 'claude-opus-5-5' },
    { ts: '2026-09-25T09:02:00Z', state: 'VALIDATE', event: 'model-fallback', step: 'VALIDATE', from: 'fable', to: 'claude-opus-5-5', cause: 'model-limit', trigger: 'lease' },
    call('2026-09-25T09:09:00Z', 'VALIDATE', 'claude-opus-5-5', 'xhigh', { quotaFallback: true }),
    { ts: '2026-09-25T09:10:00Z', state: 'VALIDATE', event: 'change-validator', verdict: 'PASS_WITH_FINDINGS', quotaFallback: true, judgeModel: 'claude-opus-5-5' },
    { ts: '2026-09-25T09:20:00Z', state: 'VALIDATE', event: 'citation-verifier', ok: false, kind: 'error' },
  ]);
  // A verdict with no llm-call before it (a shadow-mode journal) files under effort 'unknown'.
  writeJournal(root, 'issue-12', [{ ts: '2026-09-20T12:00:00Z', state: 'VALIDATE', event: 'change-validator', verdict: 'PASS' }]);
  const report = summarize(readTaskEvents(root));
  assert.deepEqual(report.modelFallbacks, {
    'CITATION_VERIFIER fable->claude-opus-5-5 model-limit/limit-result': 1,
    'VALIDATE fable->claude-opus-5-5 model-limit/lease': 1,
  });
  assert.deepEqual(report.judgeVerdicts, {
    VALIDATE: {
      base: { PASS: 2, REJECT: 1 },
      quotaFallback: { PASS_WITH_FINDINGS: 1 },
      byEffort: {
        high: { base: { PASS: 1 }, quotaFallback: {} },
        xhigh: { base: { REJECT: 1 }, quotaFallback: { PASS_WITH_FINDINGS: 1 } },
        unknown: { base: { PASS: 1 }, quotaFallback: {} },
      },
    },
    CITATION_VERIFIER: {
      base: { PASS: 1, none: 1 },
      quotaFallback: { PASS: 1 },
      byEffort: { high: { base: { PASS: 1, none: 1 }, quotaFallback: { PASS: 1 } } },
    },
  });
  const windowed = summarize(readTaskEvents(root), { since: '2026-09-24', step: 'VALIDATE' });
  assert.deepEqual(windowed.judgeVerdicts, {
    VALIDATE: { base: {}, quotaFallback: { PASS_WITH_FINDINGS: 1 }, byEffort: { xhigh: { base: {}, quotaFallback: { PASS_WITH_FINDINGS: 1 } } } },
  });
  assert.equal(Object.keys(windowed.modelFallbacks).length, 2, 'model-fallback events are windowed on ts only');
});

test('parseArgs: known flags only', () => {
  const opts = parseArgs(['--since=2026-09-13', '--step=PLAN', '--journal=/tmp/j']);
  assert.equal(opts.since, '2026-09-13');
  assert.equal(opts.step, 'PLAN');
  assert.equal(opts.journal, '/tmp/j');
  assert.throws(() => parseArgs(['--bogus=1']), /unrecognized argument/);
});
