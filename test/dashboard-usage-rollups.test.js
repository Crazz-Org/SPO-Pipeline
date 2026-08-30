'use strict';
// console/usage-rollups.js -- the tokens trend's durable daily-rollup store. Every fixture lives
// under mkTmp(); never touches the repo's real journal/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
const { loadRollups, mergeRollups, saveRollups } = require('../console/usage-rollups');

test('loadRollups returns {} when the file is missing or corrupt, never throws', () => {
  const dir = mkTmp('spo-rollups-missing-');
  assert.deepEqual(loadRollups(path.join(dir, 'nope.json')), {});

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, 'not json');
  assert.deepEqual(loadRollups(corrupt), {});
});

test('saveRollups then loadRollups round-trips, and writes atomically (no leftover .tmp file)', () => {
  const dir = mkTmp('spo-rollups-roundtrip-');
  const filePath = path.join(dir, 'usage-rollups.json');
  const rollups = { '2026-08-29': { sessions: 3, msgs: 3, partial: false, Minp: 1, Mcc: 0, Mcr: 2, Mout: 0.5, byModel: {} } };

  saveRollups(filePath, rollups);
  assert.deepEqual(loadRollups(filePath), rollups);
  assert.ok(!fs.existsSync(`${filePath}.tmp`));
});

test('mergeRollups converts raw byDay aggregates to Mtok figures and marks the current day partial', () => {
  const freshByDay = {
    '2026-08-30': { sessions: 2, msgs: 5, models: { 'claude-sonnet-5': { msgs: 5, inp: 2_000_000, cc: 100_000, cr: 500_000, out: 300_000 } } },
  };
  const merged = mergeRollups({}, freshByDay, { todayDate: '2026-08-30' });

  assert.equal(merged['2026-08-30'].sessions, 2);
  assert.equal(merged['2026-08-30'].partial, true);
  assert.equal(merged['2026-08-30'].Minp, 2);
  assert.equal(merged['2026-08-30'].Mcc, 0.1);
  assert.equal(merged['2026-08-30'].Mcr, 0.5);
  assert.equal(merged['2026-08-30'].Mout, 0.3);
  assert.ok(merged['2026-08-30'].byModel['claude-sonnet-5']);
});

test('mergeRollups overwrites a persisted day with fresh data, and marks a past day non-partial', () => {
  const persisted = { '2026-08-29': { sessions: 1, msgs: 1, partial: true, Minp: 0.1, Mcc: 0, Mcr: 0, Mout: 0, byModel: {} } };
  const freshByDay = {
    '2026-08-29': { sessions: 9, msgs: 9, models: { m: { msgs: 9, inp: 9_000_000, cc: 0, cr: 0, out: 0 } } },
  };
  const merged = mergeRollups(persisted, freshByDay, { todayDate: '2026-08-30' }); // today is the 30th now

  assert.equal(merged['2026-08-29'].sessions, 9); // fresh wins
  assert.equal(merged['2026-08-29'].partial, false); // no longer "today"
});

test('mergeRollups leaves a persisted day alone when its source transcripts are gone (not in freshByDay)', () => {
  const persisted = { '2026-08-01': { sessions: 4, msgs: 4, partial: false, Minp: 1, Mcc: 0, Mcr: 0, Mout: 0, byModel: {} } };
  const merged = mergeRollups(persisted, {}, { todayDate: '2026-08-30' });
  assert.deepEqual(merged['2026-08-01'], persisted['2026-08-01']);
});

test('mergeRollups prunes days older than retentionDays', () => {
  const now = Date.parse('2026-08-30T00:00:00.000Z');
  const persisted = {
    '2026-01-01': { sessions: 1, msgs: 1, partial: false, Minp: 0, Mcc: 0, Mcr: 0, Mout: 0, byModel: {} },
    '2026-08-29': { sessions: 1, msgs: 1, partial: false, Minp: 0, Mcc: 0, Mcr: 0, Mout: 0, byModel: {} },
  };
  const merged = mergeRollups(persisted, {}, { todayDate: '2026-08-30', retentionDays: 30, now });
  assert.ok(!('2026-01-01' in merged));
  assert.ok('2026-08-29' in merged);
});
