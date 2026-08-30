'use strict';
// console/usage-scan.js -- incremental, streaming token-usage scanner for the live dashboard's
// "tokens per task/model" section. A SELECTIVE extraction of scripts/usage-report.js's file
// walk + message.id dedup (that script is untouched -- it stays the offline analysis tool with
// its own $$$ estimate; this module carries NO dollar figures at all, only raw token counts).
//
// Incremental by design: a whole-corpus slurp took a WSL VM down once (see
// scripts/usage-report.js's own header) -- this module never re-reads a file whose mtime+size
// haven't changed since the last scan, and always reads with readline streaming, never
// readFileSync.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

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
const toM = (n) => +(n / 1e6).toFixed(2);

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
          return { model, agg, Mcr: toM(agg.cr), Mcc: toM(agg.cc), Mout: toM(agg.out) };
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
        weight,
        models: modelRows.map((r) => ({ model: r.model, Mcr: r.Mcr, Mcc: r.Mcc, Mout: r.Mout })),
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
      weight: WEIGHT(agg),
    }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ weight, ...rest }) => rest);

  const byAccountModel = [];
  for (const [account, models] of Object.entries(usageIndex.byAccount || {})) {
    for (const [model, agg] of Object.entries(models)) {
      byAccountModel.push({ account, model, msgs: agg.msgs, Mcr: toM(agg.cr), Mcc: toM(agg.cc), Mout: toM(agg.out), weight: WEIGHT(agg) });
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
    },
    totals: { Minp: toM(totalsAgg.inp), Mcc: toM(totalsAgg.cc), Mcr: toM(totalsAgg.cr), Mout: toM(totalsAgg.out), msgs: totalsAgg.msgs },
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

module.exports = { createUsageScanner, buildTokenViews, discoverUsageRoots };
