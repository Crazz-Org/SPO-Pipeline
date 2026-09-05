'use strict';
// console/usage-scan.js -- incremental, streaming token-usage scanner for the live dashboard's
// "tokens per task/model" section. A SELECTIVE extraction of scripts/usage-report.js's file
// walk + message.id dedup (that script is untouched -- it stays the offline analysis tool).
// Neither script carries a dollar figure anywhere: usage-report.js's own header records the
// 2026-08-31 maintainer decision retiring its $$$ estimate (the pool is a Claude Max quota, not
// metered API billing, so a dollar figure never meant money spent -- see
// orchestrator/tokens.js's header) -- only raw token counts survive in either place.
//
// Incremental by design: a whole-corpus slurp took a WSL VM down once (see
// scripts/usage-report.js's own header) -- this module never re-reads a file whose mtime+size
// haven't changed since the last scan, and always reads with readline streaming, never
// readFileSync.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- the ONE "today" rule (action 5.5, item C) -------------------------------------------------
//
// Measured live on this machine (UTC+2) 2026-09-01: console/collect.js's collectDaemonStats
// buckets by LOCAL midnight (`startOfDay`'s `d.setHours(0,0,0,0)`), while this module's byDay
// used to key each session by `agg.lastTs.slice(0, 10)` -- the UTC calendar date sliced straight
// off the ISO timestamp. The two disagree for the two hours between 22:00 UTC and local midnight:
// an event at 2026-09-01T23:30Z is UTC-dated "2026-09-01" but is already LOCAL "2026-09-02". Same
// page, same word "today", two different sets of events, for two hours every day.
//
// Resolved by CONVERGING ON LOCAL: `localDateKey` below is the one place a timestamp becomes a
// 'YYYY-MM-DD' day key anywhere in the tokens/trend path (scan()'s byDay here, buildTrendViews's
// `now` below, and console/serve.js's `todayDate` passed into usage-rollups.js's mergeRollups --
// see that call site for a one-line pointer back to this comment, not a second copy of it).
// `Date.prototype.getFullYear/getMonth/getDate` read in the PROCESS's own local timezone, the
// same primitive collect.js's `startOfDay`/`startOfWeek` already build on -- so this is not a new
// rule, it is the existing rule applied where it was missing. orchestrator/tokens.js's
// `todaySpend` was pinned to the same LOCAL midnight for the same reason, action 5.4 -- the
// dashboard must not become a third, dissenting opinion.
function localDateKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyModelAgg() {
  return { msgs: 0, inp: 0, cc: 0, cr: 0, out: 0 };
}

function addAgg(dst, u) {
  dst.msgs += 1;
  dst.inp += u.input_tokens || 0;
  dst.cc += u.cache_creation_input_tokens || 0;
  dst.cr += u.cache_read_input_tokens || 0;
  dst.out += u.output_tokens || 0;
}

function mergeAgg(dst, src) {
  dst.msgs += src.msgs;
  dst.inp += src.inp;
  dst.cc += src.cc;
  dst.cr += src.cr;
  dst.out += src.out;
}

// Streams one .jsonl transcript file, dedups by message.id, returns per-file aggregate:
// {sessionId, account, lastTs, models: {model: agg}}. Never throws -- unreadable files yield an
// empty aggregate.
async function scanFile(filePath, account) {
  const sessionId = path.basename(filePath, '.jsonl');
  const agg = { sessionId, account, lastTs: null, models: {}, msgs: 0, dupes: 0 };
  const seen = new Set();

  let rl;
  try {
    rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  } catch {
    return agg;
  }

  try {
    for await (const line of rl) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const u = o.message && o.message.usage;
      if (!u) continue;
      const id = (o.message && o.message.id) || o.uuid;
      if (id) {
        if (seen.has(id)) {
          agg.dupes++;
          continue;
        }
        seen.add(id);
      }
      const sid = o.sessionId || sessionId;
      if (sid) agg.sessionId = sid;
      if (o.timestamp) agg.lastTs = o.timestamp;

      const model = (o.message && o.message.model) || 'unknown';
      const m = (agg.models[model] = agg.models[model] || emptyModelAgg());
      addAgg(m, u);
      agg.msgs++;
    }
  } catch {
    /* stream error mid-file -- keep whatever was accumulated so far */
  }

  return agg;
}

// createUsageScanner({roots, filter, maxFileBytes}) -- roots: [{path, account}]. filter: an
// optional substring a project directory name must contain (null = every directory). Keeps a
// Map<absFilePath, {mtimeMs, size, agg}> cache; scan() only re-reads a file whose stat changed,
// and recomposes the global aggregates from the cache every call (never accumulates
// incrementally, to avoid drift on file removal/edit).
function createUsageScanner({ roots = [], filter = null, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const cache = new Map(); // absPath -> {mtimeMs, size, agg}
  let lastIndex = null;
  let stats = { cachedFiles: 0, lastScanMs: null, lastScanAt: null, filesScanned: 0, filesReused: 0 };

  function listCandidateFiles() {
    const files = []; // [{absPath, account}]
    for (const root of roots) {
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(root.path, { withFileTypes: true });
      } catch {
        continue;
      }
      const projectDirs = dirEntries
        .filter((d) => d.isDirectory() && (!filter || d.name.includes(filter)))
        .map((d) => path.join(root.path, d.name));
      for (const dir of projectDirs) {
        let entries;
        try {
          entries = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.endsWith('.jsonl')) files.push({ absPath: path.join(dir, e), account: root.account });
        }
      }
    }
    return files;
  }

  async function scan() {
    const t0 = Date.now();
    const files = listCandidateFiles();
    const seenPaths = new Set();
    let filesScanned = 0;
    let filesReused = 0;

    for (const f of files) {
      seenPaths.add(f.absPath);
      let st;
      try {
        st = fs.statSync(f.absPath);
      } catch {
        continue;
      }
      if (st.size > maxFileBytes) continue;

      const cached = cache.get(f.absPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        filesReused++;
        continue;
      }
      const agg = await scanFile(f.absPath, f.account);
      cache.set(f.absPath, { mtimeMs: st.mtimeMs, size: st.size, agg });
      filesScanned++;
    }

    // Purge cache entries for files that no longer exist.
    for (const key of cache.keys()) {
      if (!seenPaths.has(key)) cache.delete(key);
    }

    // Recompose global aggregates from the (now up to date) cache.
    const bySession = {};
    const byModel = {};
    const byAccount = {};
    // byDay: a re-key of the SAME cached aggregates by the calendar day of each file's last
    // message -- zero extra I/O, this is the console/usage-rollups.js persistence layer's raw
    // material (see that module's header for why a day needs a durable copy at all). A session
    // straddling midnight is attributed whole to its end day -- an accepted approximation,
    // orchestrator steps run minutes, not days. 'local' (ambient, non-pooled usage -- see
    // discoverUsageRoots below) is excluded: the trend this feeds is about the daemon's own
    // operating cost, and ad-hoc sessions on this machine aren't part of that.
    const byDay = {};
    let totalMsgs = 0;
    let totalDupes = 0;

    for (const { agg } of cache.values()) {
      totalMsgs += agg.msgs;
      totalDupes += agg.dupes;
      const sEntry = (bySession[agg.sessionId] = bySession[agg.sessionId] || { account: agg.account, lastTs: agg.lastTs, models: {} });
      if (agg.lastTs && (!sEntry.lastTs || agg.lastTs > sEntry.lastTs)) sEntry.lastTs = agg.lastTs;

      for (const [model, m] of Object.entries(agg.models)) {
        const sModel = (sEntry.models[model] = sEntry.models[model] || emptyModelAgg());
        mergeAgg(sModel, m);

        const gModel = (byModel[model] = byModel[model] || emptyModelAgg());
        mergeAgg(gModel, m);

        const aEntry = (byAccount[agg.account] = byAccount[agg.account] || {});
        const aModel = (aEntry[model] = aEntry[model] || emptyModelAgg());
        mergeAgg(aModel, m);
      }

      // LOCAL calendar day, not a UTC slice -- see this file's "the ONE 'today' rule" header.
      const date = agg.lastTs ? localDateKey(agg.lastTs) : null;
      if (date && agg.account !== 'local') {
        const dEntry = (byDay[date] = byDay[date] || { sessions: 0, msgs: 0, models: {} });
        dEntry.sessions++;
        dEntry.msgs += agg.msgs;
        for (const [model, m] of Object.entries(agg.models)) {
          const dModel = (dEntry.models[model] = dEntry.models[model] || emptyModelAgg());
          mergeAgg(dModel, m);
        }
      }
    }

    lastIndex = {
      scannedAt: new Date().toISOString(),
      filesScanned,
      filesReused,
      msgs: totalMsgs,
      dupes: totalDupes,
      bySession,
      byModel,
      byAccount,
      byDay,
    };
    stats = {
      cachedFiles: cache.size,
      lastScanMs: Date.now() - t0,
      lastScanAt: lastIndex.scannedAt,
      filesScanned,
      filesReused,
    };
    return lastIndex;
  }

  function snapshot() {
    return lastIndex;
  }

  return { scan, snapshot, stats: () => stats };
}

const WEIGHT = (a) => a.inp + a.cc + 5 * a.out + 0.1 * a.cr;
// toM ROUNDS AT THE MILLION SCALE, and that is lossy at source: two decimals means a resolution
// of 10,000 tokens, so anything under 5,000 becomes 0.00 and is gone before any renderer sees
// it. The dashboard used to print that 0.00 verbatim; formatting it as "0k" instead would have
// been a prettier lie. So every row that carries an M* figure now carries the RAW integers
// beside it (raw*), and console/render.js formats from those through
// orchestrator/tokens.js's formatTokenCount -- the same function `spo tokens` and the park
// comments already use. The M* fields stay exactly as they were: console/usage-rollups.js
// persists them, buildTrendViews derives from them, and their tests pin them.
const toM = (n) => +(n / 1e6).toFixed(2);
// The raw counterparts of an M* group, so a caller never has to guess which raw field feeds
// which rounded one.
const rawSums = (agg) => ({ rawInp: agg.inp, rawCc: agg.cc, rawCr: agg.cr, rawOut: agg.out });

function emptyMSums() {
  return { msgs: 0, Minp: 0, Mcc: 0, Mcr: 0, Mout: 0 };
}

function addMSums(dst, agg) {
  dst.msgs += agg.msgs;
  dst.Minp += agg.inp;
  dst.Mcc += agg.cc;
  dst.Mcr += agg.cr;
  dst.Mout += agg.out;
}

// buildTokenViews(usageIndex, sessionIndex, opts) -- pure, no I/O. Turns the scanner's raw
// per-session/per-model index into the sorted views render.js's tokens section needs. NO dollar
// figures anywhere in the output. Returns null if usageIndex hasn't been produced yet (server
// just started, first scan still pending).
function buildTokenViews(usageIndex, sessionIndex, { topTasks = 30 } = {}) {
  if (!usageIndex) return null;
  const sIndex = sessionIndex || {};

  const byTaskRaw = {}; // taskId -> {taskId, state, title, models: {model: agg}}
  const unattributed = { sessions: 0, agg: emptyModelAgg() };

  for (const [sessionId, session] of Object.entries(usageIndex.bySession || {})) {
    const mapped = sIndex[sessionId];
    if (!mapped) {
      unattributed.sessions++;
      for (const m of Object.values(session.models)) mergeAgg(unattributed.agg, m);
      continue;
    }
    const entry = (byTaskRaw[mapped.taskId] = byTaskRaw[mapped.taskId] || {
      taskId: mapped.taskId,
      state: mapped.state,
      title: mapped.title,
      models: {},
    });
    for (const [model, m] of Object.entries(session.models)) {
      const dst = (entry.models[model] = entry.models[model] || emptyModelAgg());
      mergeAgg(dst, m);
    }
  }

  const byTask = Object.values(byTaskRaw)
    .map((t) => {
      const totals = emptyMSums();
      let msgs = 0;
      const modelRows = Object.entries(t.models)
        .map(([model, agg]) => {
          msgs += agg.msgs;
          return { model, agg, Mcr: toM(agg.cr), Mcc: toM(agg.cc), Mout: toM(agg.out), ...rawSums(agg) };
        })
        .sort((a, b) => WEIGHT(b.agg) - WEIGHT(a.agg));
      for (const { agg } of modelRows) addMSums(totals, agg);
      const weight = modelRows.reduce((sum, r) => sum + WEIGHT(r.agg), 0);
      return {
        taskId: t.taskId,
        state: t.state,
        title: t.title,
        msgs,
        Minp: toM(totals.Minp),
        Mcc: toM(totals.Mcc),
        Mcr: toM(totals.Mcr),
        Mout: toM(totals.Mout),
        rawInp: totals.Minp,
        rawCc: totals.Mcc,
        rawCr: totals.Mcr,
        rawOut: totals.Mout,
        weight,
        models: modelRows.map((r) => ({
          model: r.model,
          Mcr: r.Mcr,
          Mcc: r.Mcc,
          Mout: r.Mout,
          rawCr: r.rawCr,
          rawCc: r.rawCc,
          rawOut: r.rawOut,
        })),
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, topTasks);

  const byModel = Object.entries(usageIndex.byModel || {})
    .map(([model, agg]) => ({
      model,
      msgs: agg.msgs,
      Minp: toM(agg.inp),
      Mcc: toM(agg.cc),
      Mcr: toM(agg.cr),
      Mout: toM(agg.out),
      ...rawSums(agg),
      weight: WEIGHT(agg),
    }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ weight, ...rest }) => rest);

  const byAccountModel = [];
  for (const [account, models] of Object.entries(usageIndex.byAccount || {})) {
    for (const [model, agg] of Object.entries(models)) {
      byAccountModel.push({
        account,
        model,
        msgs: agg.msgs,
        Mcr: toM(agg.cr),
        Mcc: toM(agg.cc),
        Mout: toM(agg.out),
        ...rawSums(agg),
        weight: WEIGHT(agg),
      });
    }
  }
  byAccountModel.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : b.weight - a.weight));
  byAccountModel.forEach((r) => delete r.weight);

  const totalsAgg = emptyModelAgg();
  for (const agg of Object.values(usageIndex.byModel || {})) mergeAgg(totalsAgg, agg);

  return {
    scannedAt: usageIndex.scannedAt,
    byTask,
    byModel,
    byAccountModel,
    unattributed: {
      sessions: unattributed.sessions,
      Minp: toM(unattributed.agg.inp),
      Mcc: toM(unattributed.agg.cc),
      Mcr: toM(unattributed.agg.cr),
      Mout: toM(unattributed.agg.out),
      ...rawSums(unattributed.agg),
    },
    totals: {
      Minp: toM(totalsAgg.inp),
      Mcc: toM(totalsAgg.cc),
      Mcr: toM(totalsAgg.cr),
      Mout: toM(totalsAgg.out),
      ...rawSums(totalsAgg),
      msgs: totalsAgg.msgs,
    },
  };
}

// buildTrendViews(rollups, opts) -- pure, no I/O. Turns console/usage-rollups.js's persisted
// daily records into the operating-cost trend view console/render.js's renderTokensTrendInner
// needs: a sparkline-ready series plus a few headline KPIs with week-over-week and
// today-vs-recent deltas. `rollups` is `{ 'YYYY-MM-DD': {sessions, msgs, partial, Minp, Mcc,
// Mcr, Mout, byModel} }` (see usage-rollups.js's mergeRollups for the exact shape).
//
// avgWeightPerSession reuses the same WEIGHT() formula byTask/byModel already sort by --
// necessary because cache-read tokens dominate raw counts by orders of magnitude, and an
// unweighted average would be swamped by conversation-length noise rather than reflecting an
// actual per-step cost change. Every rollup field is already in Mtok units, and WEIGHT is
// linear/homogeneous, so summing the Mtok fields with the same weights yields the same relative
// answer without ever converting back to raw token counts.
//
// cacheWriteRatio (Mcc / (Mcc+Mcr)) is a second, independent signal: prompt caching invalidates
// on any change to the cached prefix, so editing a prompt/config file shows up as a same-day
// spike in cache-creation relative to cache-read, regardless of whether the resulting work
// itself got more or less expensive -- a near-deterministic fingerprint of "something changed
// today" that corroborates (or contradicts) the weight trend from a completely different angle.
//
// action 5.5, item B audit of journal/usage-rollups.json: `today` below used to mean "the LAST
// recorded day in the file", silently equated with the actual calendar today -- if the live
// server (console/serve.js) that writes this file hasn't run today (or at all in a while), the
// "today (partial)" KPI would keep showing a PREVIOUS day's numbers under that label with nothing
// on the page saying so. There is no per-day `scannedAt` persisted in the rollups file to check
// instead (usage-scan.js's own `scannedAt` on the live index is never written into rollups.json,
// only `partial` is -- see usage-rollups.js's mergeRollups) -- so freshness here is judged the
// only way the persisted data allows: comparing `lastRecordedDate` against `now`'s OWN local day
// (the same `localDateKey` this file's byDay bucketing uses, per the "ONE 'today' rule" header
// above). `stale: true` whenever the last recorded day isn't literally today -- a day behind
// already means the scanner missed at least one of its ~5-minute cycles for all of today, which
// for a source meant to be near-live is worth flagging immediately (contrast with
// console/collect.js's usageSnapshotFreshness, whose SNAPSHOT_STALE_MS grace period is a full day
// specifically because that source has NO automatic refresh at all).
function buildTrendViews(rollups, { days = 60, minSessionsForCompare = 20, now = Date.now() } = {}) {
  const dates = Object.keys(rollups || {}).sort();
  const series = dates.slice(-days).map((date) => {
    const r = rollups[date] || {};
    const sessions = r.sessions || 0;
    const weightM = (r.Minp || 0) + (r.Mcc || 0) + 5 * (r.Mout || 0) + 0.1 * (r.Mcr || 0);
    const cacheTotal = (r.Mcc || 0) + (r.Mcr || 0);
    return {
      date,
      sessions,
      msgs: r.msgs || 0,
      partial: !!r.partial,
      Minp: r.Minp || 0,
      Mcc: r.Mcc || 0,
      Mcr: r.Mcr || 0,
      Mout: r.Mout || 0,
      avgWeightPerSession: sessions ? weightM / sessions : 0,
      avgMoutPerSession: sessions ? (r.Mout || 0) / sessions : 0,
      cacheWriteRatio: cacheTotal ? (r.Mcc || 0) / cacheTotal : 0,
      cacheChangeFlag: sessions >= 5 && cacheTotal > 0 && (r.Mcc || 0) / cacheTotal > 0.25,
    };
  });

  // Weighted average over a window of daily rows, reconstructed from each day's own average --
  // equivalent to summing raw weight/sessions across the window, without re-deriving weight from
  // Mtok fields a second time. null (not 0) when the window is too thin to compare -- the render
  // layer shows "not enough sessions to compare" rather than a misleadingly precise number.
  function windowAvg(rows) {
    const sessions = rows.reduce((s, d) => s + d.sessions, 0);
    if (sessions < minSessionsForCompare) return null;
    const weight = rows.reduce((s, d) => s + d.avgWeightPerSession * d.sessions, 0);
    return weight / sessions;
  }

  const today = series.length ? series[series.length - 1] : null;
  const last7 = windowAvg(series.slice(-8, -1)); // 7 full days before today, excludes today
  const prev7 = windowAvg(series.slice(-15, -8)); // the 7 days before that
  const last30 = windowAvg(series.slice(-31, -1));

  const pct = (a, b) => (a !== null && a !== undefined && b ? Math.round(((a - b) / b) * 100) : null);

  const lastRecordedDate = dates.length ? dates[dates.length - 1] : null;
  const todayLocalDate = localDateKey(now);
  // Whole-day difference between two 'YYYY-MM-DD' strings, via Date.parse (UTC midnight for
  // both ends -- the offset cancels, only the day COUNT matters here, not either instant).
  const staleDays = lastRecordedDate ? Math.round((Date.parse(todayLocalDate) - Date.parse(lastRecordedDate)) / DAY_MS) : null;

  return {
    series,
    lastRecordedDate,
    todayLocalDate,
    stale: staleDays !== null && staleDays >= 1,
    staleDays,
    kpis: {
      todayAvgWeightPerSession: today ? today.avgWeightPerSession : null,
      todayAvgMoutPerSession: today ? today.avgMoutPerSession : null,
      last7AvgWeightPerSession: last7,
      prev7AvgWeightPerSession: prev7,
      last30AvgWeightPerSession: last30,
      todayVsLast7Pct: pct(today ? today.avgWeightPerSession : null, last7),
      last7VsPrev7Pct: pct(last7, prev7),
    },
  };
}

// discoverUsageRoots(accountsDir) -- one {path, account} per pool account's own
// CLAUDE_CONFIG_DIR/projects, plus ~/.claude/projects as 'local'. Filters by existence; []
// if accountsDir is absent.
function discoverUsageRoots(accountsDir) {
  const os = require('os');
  const roots = [];
  if (accountsDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(accountsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      entries = [];
    }
    for (const d of entries) {
      const p = path.join(accountsDir, d.name, 'projects');
      if (fs.existsSync(p)) roots.push({ path: p, account: d.name });
    }
  }
  const localProjects = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(localProjects)) roots.push({ path: localProjects, account: 'local' });
  return roots;
}

module.exports = { createUsageScanner, buildTokenViews, buildTrendViews, discoverUsageRoots, localDateKey };
