'use strict';
// Tests for action 4.5's other half: making an ABANDONED card actually visible once
// orchestrator/park-loop.js's abandon cleanup (see test/park-loop.test.js) marks one terminal.
// Before this action `bin/spo`'s cmdStatus bucketed ABANDONED into "active" forever (it never
// re-enters runTask's loop, so it never left), cmdParked couldn't see it at all (its filter was
// `state.state === 'PARKED'`, verbatim), and console/collect.js's `terminal` predicate didn't
// know the state existed -- so the dashboard counted it as active AND in-flight, forever, and
// never folded it into done/parked/the parking rate. Measured on the live install: journal/
// issue-443/state.json has been ABANDONED since 2026-08-30 and was invisible on all three
// surfaces until this action.
//
// `bin/spo` surfaces are exercised as the real CLI (execFileSync via test/helpers.js's runSpo --
// same convention as test/cli.test.js) against a throwaway journal dir; console/collect.js's
// collectDaemonStats is exercised directly as a pure function, same convention as
// test/dashboard.test.js's own collectDaemonStats tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, runSpo } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { appendEvent, writeState } = require('../orchestrator/journal');
const { collectDaemonStats } = require('../console/collect');
const { renderDaemonStatsInner } = require('../console/render');

function makeTaskDir(journalRoot, id, { state, reason, title, lastEvent }) {
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', title, criterion: 'y', size: 'S' }));
  writeState(taskDir, { id, state, reason, title });
  if (lastEvent) appendEvent(taskDir, state, lastEvent, {});
  return taskDir;
}

// ---- `spo status`: abandoned gets its own counter, never falls into `active` -------------------

test('spo status: prints a non-zero `abandoned:` count on the summary line and does NOT fold it into `active`', () => {
  const journalDir = mkTmp('spo-abandoned-status-journal-');

  makeTaskDir(journalDir, 'issue-443', {
    state: 'ABANDONED',
    reason: 'abandoned-by-maintainer',
    title: 'leaked worktree card',
    lastEvent: 'abandoned-by-maintainer',
  });
  makeTaskDir(journalDir, 'issue-500', { state: 'IMPLEMENT', title: 'still moving', lastEvent: 'files-written' });

  // `--queue` pointed at an empty tmp dir, not the default (the real repo's own `queue/`) --
  // same isolation discipline test/helpers.js's own header documents for every other CLI test.
  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-abandoned-status-queue-')]);

  // Exactly one still-moving task -> active: 1. If ABANDONED were still falling into the `else
  // active` bucket (the pre-4.5 bug) this would read `active: 2`.
  assert.match(out, /active: 1\s+parked: 0\s+abandoned: 1\s+done: 0/);
  assert.match(out, /issue-443\s+ABANDONED/);
});

test('spo status: an install with no abandoned cards at all still prints `abandoned: 0`, not a missing field', () => {
  const journalDir = mkTmp('spo-abandoned-status-zero-journal-');
  makeTaskDir(journalDir, 'issue-501', { state: 'DONE', title: 'shipped', lastEvent: 'merged' });

  // `--queue` pointed at an empty tmp dir, not the default (the real repo's own `queue/`) --
  // same isolation discipline test/helpers.js's own header documents for every other CLI test.
  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-abandoned-status-queue-')]);
  assert.match(out, /active: 0\s+parked: 0\s+abandoned: 0\s+done: 1/);
});

// ---- `spo parked`: abandoned cards get their own heading, separate from the parked rows --------

test('spo parked: lists an ABANDONED card under its own "abandoned:" heading, separate from the parked rows', () => {
  const journalDir = mkTmp('spo-abandoned-parked-journal-');

  makeTaskDir(journalDir, 'issue-443', {
    state: 'ABANDONED',
    reason: 'abandoned-by-maintainer',
    title: 'leaked worktree card',
  });
  makeTaskDir(journalDir, 'issue-502', { state: 'PARKED', reason: 'worktree-npm-ci-failed', title: 'still waiting on a reply' });

  const out = runSpo(['parked', '--journal', journalDir]);

  assert.match(out, /^issue-502\s+reason=worktree-npm-ci-failed/m);
  assert.match(out, /^abandoned:$/m);
  assert.match(out, /^issue-443\s+reason=abandoned-by-maintainer/m);

  // The abandoned heading/row must come AFTER the parked section, and issue-443 (ABANDONED) must
  // never be printed on a bare row indistinguishable from a PARKED one.
  const abandonedHeadingIdx = out.indexOf('abandoned:');
  const parkedRowIdx = out.indexOf('issue-502');
  assert.ok(parkedRowIdx >= 0 && abandonedHeadingIdx > parkedRowIdx);
});

test('spo parked: with only abandoned cards (no PARKED ones), the parked section still prints its own "(no parked tasks)" line, and the abandoned heading still appears', () => {
  const journalDir = mkTmp('spo-abandoned-parked-only-journal-');
  makeTaskDir(journalDir, 'issue-443', { state: 'ABANDONED', reason: 'abandoned-by-maintainer', title: 'x' });

  const out = runSpo(['parked', '--journal', journalDir]);

  assert.match(out, /\(no parked tasks\)/);
  assert.match(out, /^abandoned:$/m);
  assert.match(out, /^issue-443\s+reason=abandoned-by-maintainer/m);
});

test('spo parked: with neither PARKED nor ABANDONED cards, only "(no parked tasks)" prints -- no empty "abandoned:" heading', () => {
  const journalDir = mkTmp('spo-abandoned-parked-none-journal-');
  makeTaskDir(journalDir, 'issue-503', { state: 'DONE', title: 'x' });

  const out = runSpo(['parked', '--journal', journalDir]);

  assert.match(out, /\(no parked tasks\)/);
  assert.ok(!out.includes('abandoned:'), 'no cards abandoned -- the heading must not print at all');
});

// ---- console/collect.js's collectDaemonStats: abandoned is terminal, not active/in-flight -----

test('collectDaemonStats: an ABANDONED task counts as terminal (stats.total, stats.abandoned), never stats.active/stats.inFlight', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const journalTasks = [
    { state: 'ABANDONED', updatedAt: '2026-08-30T08:00:00.000Z' }, // issue-443's own shape
    { state: 'DONE', updatedAt: '2026-08-31T08:00:00.000Z' },
    { state: 'PARKED', updatedAt: '2026-08-31T08:00:00.000Z' },
    { state: 'IMPLEMENT', updatedAt: '2026-08-31T08:00:00.000Z' }, // still active, non-terminal
  ];

  const stats = collectDaemonStats(journalTasks, 0, { now });

  assert.equal(stats.abandoned, 1);
  assert.equal(stats.total, 3, 'done + parked + abandoned');
  assert.equal(stats.active, 1, 'only the IMPLEMENT task is active');
  assert.equal(stats.inFlight, 1, 'imported is 0 here -- inFlight tracks active + imported, never abandoned');

  // Parking rate: numerator stays `parked` (1), denominator is the three-way terminal total (3).
  assert.equal(stats.parkingRatePct, 33);
});

test('collectDaemonStats: the abandoned task is also folded into week/today, mirroring done/parked exactly', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z'); // a Monday
  const journalTasks = [{ state: 'ABANDONED', updatedAt: '2026-08-31T08:00:00.000Z' }]; // today AND this week

  const stats = collectDaemonStats(journalTasks, 0, { now });

  assert.equal(stats.today.abandoned, 1);
  assert.equal(stats.today.total, 1);
  assert.equal(stats.week.abandoned, 1);
  assert.equal(stats.week.total, 1);
});

test('collectDaemonStats: abandoned never leaks into stats.parked', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const journalTasks = [{ state: 'ABANDONED', updatedAt: '2026-08-31T08:00:00.000Z' }];

  const stats = collectDaemonStats(journalTasks, 0, { now });

  assert.equal(stats.parked, 0);
  assert.equal(stats.abandoned, 1);
});

// ---- console/render.js: the new counter is rendered, not silently dropped ----------------------

test('renderDaemonStatsInner: a non-zero abandoned count is rendered at all three grains', () => {
  // The spec's own rule for this action: "do not leave a renderer that silently drops it".
  // collectDaemonStats now emits `abandoned` at top level and inside week/today, and the KPI
  // strip is the only consumer -- if it dropped the field the dashboard would show a `total`
  // that its own done/parked breakdown no longer adds up to.
  const html = renderDaemonStatsInner({
    total: 10,
    done: 6,
    parked: 3,
    abandoned: 1,
    parkingRatePct: 30,
    week: { total: 4, done: 2, parked: 1, abandoned: 1 },
    today: { total: 2, done: 1, parked: 0, abandoned: 1 },
    active: 2,
    imported: 1,
    inFlight: 3,
  });

  // Three grains -> three "abandoned" mentions, one per KPI tile.
  assert.equal(html.match(/1 abandoned/g).length, 3);
  assert.match(html, /6 done \/ 3 parked \/ 1 abandoned/);
});

test('renderDaemonStatsInner: a zero (or absent) abandoned count adds no noise -- the pre-4.5 line is unchanged', () => {
  const html = renderDaemonStatsInner({
    total: 9,
    done: 6,
    parked: 3,
    abandoned: 0,
    parkingRatePct: 33,
    week: { total: 4, done: 3, parked: 1, abandoned: 0 },
    today: { total: 0, done: 0, parked: 0 }, // no `abandoned` key at all -- an older snapshot.json
    active: 2,
    imported: 1,
    inFlight: 3,
  });

  assert.ok(!html.includes('abandoned'), 'nothing abandoned -> the suffix never prints');
  assert.match(html, /6 done \/ 3 parked/);
});
