'use strict';
// console/usage-rollups.js -- small, durable daily-rollup store backing the dashboard's tokens
// trend view (console/render.js's renderTokensTrendInner, fed by console/usage-scan.js's
// buildTrendViews). Deliberately NOT a re-read of the full transcript corpus -- usage-scan.js's
// own header describes the WSL VM a naive full slurp took down once. This module only ever
// touches one small JSON file, capped at DEFAULT_RETENTION_DAYS days (a few hundred bytes each),
// written on the same ~5-minute cadence as the live server's usage scan (console/serve.js).
//
// WHY a durable store at all, when usage-scan.js's scanner cache already recomposes a `byDay`
// view from whatever transcripts are currently on disk on every scan: transcript retention or an
// operator cleanup can make old .jsonl files disappear, which would silently erase that day from
// a purely-recomputed view. mergeRollups() lets a fresh scan overwrite/extend what it can still
// see while leaving alone any day whose source files are gone -- the persisted copy is the only
// durable record of those days once they're pruned.

const fs = require('fs');
const path = require('path');

const DEFAULT_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

// A missing or unparsable file is not an error, just "no rollups recorded yet" -- same posture
// as every other readJsonSafe-style reader in this project.
function loadRollups(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

// Merges a scanner's `byDay` (console/usage-scan.js's `scan()` return value) into `persisted`,
// converting each day's raw per-model token sums to the Mtok figures the trend view renders. A
// date present in `freshByDay` always overwrites the persisted copy for that date -- the
// scanner's cache is authoritative for any file still on disk, so "fresh" is never less complete
// than what was recorded before. A date ONLY in `persisted` (its source transcripts have since
// been pruned) is left untouched -- that's the durability this module exists for.
// `todayDate` (an ISO 'YYYY-MM-DD') is marked partial: true so the render layer can label it as
// still accumulating rather than a finished day.
function mergeRollups(persisted, freshByDay, { todayDate, retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
  const out = { ...(persisted || {}) };
  const toM = (n) => +((n || 0) / 1e6).toFixed(2);

  for (const [date, d] of Object.entries(freshByDay || {})) {
    const record = {
      sessions: d.sessions || 0,
      msgs: d.msgs || 0,
      partial: date === todayDate,
      Minp: 0,
      Mcc: 0,
      Mcr: 0,
      Mout: 0,
      byModel: {},
    };
    for (const [model, agg] of Object.entries(d.models || {})) {
      record.Minp += toM(agg.inp);
      record.Mcc += toM(agg.cc);
      record.Mcr += toM(agg.cr);
      record.Mout += toM(agg.out);
      record.byModel[model] = { sessions: agg.msgs, Minp: toM(agg.inp), Mcc: toM(agg.cc), Mcr: toM(agg.cr), Mout: toM(agg.out) };
    }
    out[date] = record;
  }

  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 10);
  for (const date of Object.keys(out)) {
    if (date < cutoff) delete out[date];
  }
  return out;
}

// Atomic write (tmp file + rename) so a concurrent reader -- console/collect.js's static-mode
// fallback, or another process entirely -- never observes a half-written file.
function saveRollups(filePath, rollups) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rollups, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

module.exports = { loadRollups, mergeRollups, saveRollups, DEFAULT_RETENTION_DAYS };
