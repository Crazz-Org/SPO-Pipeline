'use strict';
// console/usage-scan.js -- incremental, streaming token-usage scanner for the live dashboard's
// "tokens per task/model" section, and (as of 2026-09-10, SPO-Pipeline#170) the ONE place the
// corpus-wide candidate walk is implemented: listJsonlFilesRecursive and listCandidateFiles below
// are exported and imported by scripts/usage-report.js (the offline analysis tool) rather than
// re-walked there a second time. (orchestrator/token-recovery.js's locate-one-session-by-id walk
// deliberately mirrors listJsonlFilesRecursive rather than importing it -- see its own comment;
// this fix does not touch that.) The message.id dedup direction is ALSO now shared -- both
// scripts keep the LAST occurrence of an id (see scanFile's header for why) -- so the two no
// longer diverge on that axis; scripts/usage-report.js's own header carries the measured, dated
// attribution of what that fix changed and enumerates what still deliberately differs between the
// two tools (incremental caching vs one-shot, the maxFileBytes cap, account attribution, default
// root scope). They used to diverge (first-wins vs last-wins, and usage-report.js never walked
// subagent transcripts at all) -- that history, and the numbers it produced, are what
// SPO-Pipeline#170 fixed.
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
// A `subagents` directory nests further for workflow-spawned agents
// (`subagents/workflows/<wf_id>/agent-<hash>.jsonl`) -- this caps how deep listSubagentFiles
// below will follow that nesting. Deep enough for any layout seen on this machine (2 levels)
// with headroom to spare; shallow enough that a pathological or cyclic layout can't make one
// scan() call walk forever.
const MAX_SUBAGENT_WALK_DEPTH = 8;

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

// Recursively collects every *.jsonl at any depth under `dir` (a session's `subagents`
// directory), so a deeper layout -- e.g. `subagents/workflows/<wf_id>/agent-<hash>.jsonl` from a
// workflow-spawned agent, not just the flat `subagents/agent-<hash>.jsonl` -- is not silently
// skipped. Never follows a symlinked directory (avoids a cycle turning this into an infinite
// walk) and stops at MAX_SUBAGENT_WALK_DEPTH regardless. Guarded by try/catch at every
// readdirSync so a missing/unreadable directory anywhere in the tree is skipped silently, same as
// the rest of this module.
//
// Module-scope (not a closure inside createUsageScanner) because it closes over nothing but the
// MAX_SUBAGENT_WALK_DEPTH constant above -- there was never a reason this needed roots/filter, and
// keeping it free-standing is what lets it be exported and reused by scripts/usage-report.js (see
// this file's own header) without a second, drifting copy.
function listJsonlFilesRecursive(dir, depth, out) {
  if (depth > MAX_SUBAGENT_WALK_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(path.join(dir, e.name));
    } else if (e.isDirectory() && !e.isSymbolicLink()) {
      listJsonlFilesRecursive(path.join(dir, e.name), depth + 1, out);
    }
  }
}

// listCandidateFiles({roots, filter}) -- roots: [{path, account}]. filter: an optional substring
// a project directory name must contain (null/falsy = every directory). Returns every *.jsonl
// candidate across all roots: top-level `<root>/<projectDir>/*.jsonl` plus, for every session
// directory found alongside those files, its `subagents` subtree (any depth, via
// listJsonlFilesRecursive above). Pure -- no cache, no mtime/size comparison, just the walk --
// which is exactly what makes it the one shared discovery primitive both createUsageScanner below
// (the live, incremental scanner) and scripts/usage-report.js (the offline, one-shot CLI) can
// call without either re-deriving the walk. See this file's own header for why there is exactly
// one of these.
function listCandidateFiles({ roots = [], filter = null } = {}) {
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
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          files.push({ absPath: path.join(dir, e.name), account: root.account });
        } else if (e.isDirectory()) {
          // <projectDir>/<parentSessionId>/subagents/agent-<hash>.jsonl -- a subagent's own
          // transcript, and it can nest deeper still: a workflow-spawned agent lands at
          // <projectDir>/<parentSessionId>/subagents/workflows/<wf_id>/agent-<hash>.jsonl. Every
          // line in either layout carries `sessionId` set to the PARENT session's id (scanFile
          // already folds that onto the parent via `agg.sessionId = sid`), so walking the whole
          // `subagents` subtree is the whole fix -- no new attribution logic needed.
          const subagentsDir = path.join(dir, e.name, 'subagents');
          const subFiles = [];
          listJsonlFilesRecursive(subagentsDir, 0, subFiles);
          for (const absPath of subFiles) files.push({ absPath, account: root.account });
        }
      }
    }
  }
  return files;
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
//
// Dedup keeps the LAST occurrence of an id, not the first. In a SUBAGENT transcript the CLI
// rewrites an assistant message as it streams, so the same message.id appears on several
// consecutive lines with a growing `output_tokens`; input/cache-creation/cache-read never vary
// across occurrences of the same id (measured on the real corpus), and output_tokens is
// monotonically non-decreasing, so last == max. In a MAIN session transcript this does not
// happen: duplicate ids occur, but their usage is identical, so first-wins and last-wins agree
// to the token there (measured 2026-09-08: 662 top-level SPO transcripts, billable 199,294,970
// and output 38,088,746 under BOTH dedup directions). The direction therefore only matters for
// the subagent files this module now reads -- on the control session whose pre-fix figure was
// 48.2% under, the dedup accounts for 15.8% of the gap (42,953 of 271,089) and the subagent walk
// for the other 84.2%. So each id's {model, usage} pair is buffered and OVERWRITTEN by every
// later occurrence, and only applied to the aggregate once, after the file has finished
// streaming -- still O(unique ids in this file) memory, not O(lines).
async function scanFile(filePath, account) {
  const sessionId = path.basename(filePath, '.jsonl');
  const agg = { sessionId, account, lastTs: null, models: {}, msgs: 0, dupes: 0 };
  const lastById = new Map(); // id -> {model, usage} of its LAST occurrence seen so far

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

      const sid = o.sessionId || sessionId;
      if (sid) agg.sessionId = sid;
      if (o.timestamp) agg.lastTs = o.timestamp;

      const id = (o.message && o.message.id) || o.uuid;
      const model = (o.message && o.message.model) || 'unknown';

      if (id) {
        if (lastById.has(id)) agg.dupes++;
        // Overwrite model+usage together, as one unit, so the pair applied at the end is
        // always the one actual occurrence they came from together -- never a later usage
        // paired with an earlier model.
        lastById.set(id, { model, usage: u });
      } else {
        // Nothing to dedup an id-less line against -- apply it immediately, same as before.
        const m = (agg.models[model] = agg.models[model] || emptyModelAgg());
        addAgg(m, u);
        agg.msgs++;
      }
    }
  } catch {
    /* stream error mid-file -- keep whatever was accumulated so far */
  }

  for (const { model, usage } of lastById.values()) {
    const m = (agg.models[model] = agg.models[model] || emptyModelAgg());
    addAgg(m, usage);
    agg.msgs++;
  }

  return agg;
}

// createUsageScanner({roots, filter, maxFileBytes}) -- roots: [{path, account}]. filter: an
// optional substring a project directory name must contain (null = every directory). Keeps a
// Map<absFilePath, {mtimeMs, size, agg}> cache; scan() only re-reads a file whose stat changed,
// and recomposes the global aggregates from the cache every call (never accumulates
// incrementally, to avoid drift on file removal/edit). Discovery itself (listCandidateFiles) is
// the module-scope function above, not a closure here -- see this file's own header for why.
function createUsageScanner({ roots = [], filter = null, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const cache = new Map(); // absPath -> {mtimeMs, size, agg}
  let lastIndex = null;
  let stats = { cachedFiles: 0, lastScanMs: null, lastScanAt: null, filesScanned: 0, filesReused: 0 };

  async function scan() {
    const t0 = Date.now();
    const files = listCandidateFiles({ roots, filter });
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
    // byDay: a re-key by the calendar day of each SESSION's last message -- zero extra I/O
    // beyond what bySession already built, this is the console/usage-rollups.js persistence
    // layer's raw material (see that module's header for why a day needs a durable copy at
    // all). A session straddling midnight is attributed whole to its end day -- an accepted
    // approximation, orchestrator steps run minutes, not days. 'local' (ambient, non-pooled
    // usage -- see discoverUsageRoots below) is excluded: the trend this feeds is about the
    // daemon's own operating cost, and ad-hoc sessions on this machine aren't part of that.
    //
    // Keyed on the SESSION, deliberately not on the cached FILE: a session that used subagents
    // has one file per subagent (`<project>/<sessionId>/subagents/agent-*.jsonl`) plus its own
    // main file, all of which fold into ONE bySession entry above (every subagent line already
    // carries its PARENT session's id -- see scanFile's header). `sessions` here is this
    // block's own denominator for buildTrendViews's avgWeightPerSession; counting cached files
    // instead of distinct sessions would silently turn that into a file count and corrupt every
    // trend figure and durable rollup built on it. So this walks bySession -- already exactly
    // one entry per session id -- not cache.values().
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
    }

    for (const sEntry of Object.values(bySession)) {
      // LOCAL calendar day, not a UTC slice -- see this file's "the ONE 'today' rule" header.
      const date = sEntry.lastTs ? localDateKey(sEntry.lastTs) : null;
      if (!date || sEntry.account === 'local') continue;
      const dEntry = (byDay[date] = byDay[date] || { sessions: 0, msgs: 0, models: {} });
      dEntry.sessions++;
      for (const [model, m] of Object.entries(sEntry.models)) {
        dEntry.msgs += m.msgs;
        const dModel = (dEntry.models[model] = dEntry.models[model] || emptyModelAgg());
        mergeAgg(dModel, m);
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
  // unattributed.sessions++ below does NOT have the byDay file-vs-session trap: it walks
  // usageIndex.bySession, which scan() already builds as one entry per distinct session id
  // (a session's main file and any subagent files are merged into that single entry before
  // this function ever sees the index), so this counts sessions correctly with no change needed.
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

// ---- per-step journal-vs-transcript delta (card #214, action 4) -------------------------------
//
// Measured motivation: PLAN's contract resolved to `fable`, but 6 of 42 PLAN calls, measured
// 2026-09-10..12 while PLAN was Fable-only (PR #222 changes PLAN to Opus-first with a Fable
// fallback), spawned Opus subagents this table's own `model` field never named -- see
// step-contracts.js's own comment on PLAN's `allowedTools` for the corrected, fuller-corpus
// measurement, which also found IMPLEMENT can delegate, not only PLAN. A journal-only reader
// had no way to notice, and the only way this was actually caught in the first place was a
// hand-rolled, one-off join of 139 journalled calls against their transcripts (walking the
// `subagents/` subtree that scanFile above already walks for every OTHER caller). This is that
// join, promoted from a one-off script into a standing feature of this reader, so the next
// divergence shows up without a hand-rolled measurement: rejoining the same 139 calls this way,
// every step landed within 3.5% of the journal once the subagent walk was included (PLAN: $225.70
// journalled vs $217.83 reconstructed) -- so a healthy corpus prints a SMALL delta, not zero; a
// large one is the signal worth investigating, the same way finding 1 (the undeclared PLAN
// subagents) was found in the first place.
//
// This DOES replace `numTurns` (removed from the journalled event by this same card, see
// steps/llm.js's own comment) with a real request-count figure: `requestCount` below, the
// deduplicated API request count `numTurns` never reliably was. It is NOT `callsMatched`/
// `callsUnmatched` (those count CALLS -- one `llm-call` event -- not requests; a single call can
// itself spend many requests, deduplicated across its own transcript and every subagent's own).
// `requestCount`
// sums `sessionRequestCount` (below) over every matched call's session: scanFile's own per-model
// `msgs` counter, already deduplicated by `message.id` (last-occurrence-wins -- see scanFile's own
// header) and already folded across a session's main transcript AND its `subagents/` subtree by
// this module's own walk (listCandidateFiles). So a message rewritten several times in one
// streamed line counts once, and a subagent's own requests are counted, never silently dropped --
// exactly the two properties `numTurns` never had (see the fix pass that added this: fixture
// coverage in test/dashboard-usage-scan.test.js proves both through the real scanFile/
// listCandidateFiles pipeline, not just by summing pre-built numbers).

// emptyStepDelta() -- the zero-value shape computeStepDeltas accumulates into, one per step name
// encountered in the journal side of the join.
function emptyStepDelta() {
  return { journalBillableTokens: 0, transcriptBillableTokens: 0, requestCount: 0, callsMatched: 0, callsUnmatched: 0 };
}

// sessionBillableTokens(sessionEntry) -- sessionEntry: one value out of a `bySession` map (this
// file's own `{models: {model: {inp, cc, cr, out, msgs}}}` shape, already deduplicated by
// message.id and already folded across a session's main file AND its `subagents/` subtree by
// scanFile/listCandidateFiles -- see this file's own header for why walking that subtree is the
// whole fix for a session that delegates). Same billable formula as everywhere else in this repo
// (fresh input + cache-creation + output, cache-read excluded -- see orchestrator/tokens.js's own
// header for why), summed across every model the session touched.
function sessionBillableTokens(sessionEntry) {
  if (!sessionEntry || !sessionEntry.models) return 0;
  let total = 0;
  for (const m of Object.values(sessionEntry.models)) {
    total += (m.inp || 0) + (m.cc || 0) + (m.out || 0);
  }
  return total;
}

// sessionRequestCount(sessionEntry) -- the deduplicated API request count for a session: sum of
// each model's own `msgs` counter. `msgs` is scanFile's per-model count of messages that survived
// its message.id dedup (last occurrence wins -- see scanFile's own header on why: a subagent
// transcript rewrites the same assistant message across several consecutive lines as it streams,
// growing output_tokens, and only the last one is counted), and by the time a model's `msgs`
// reaches `bySession` it has already been folded (via mergeAgg) across every file scanFile found
// for this session -- the main transcript AND every file under its `subagents/` subtree
// (listCandidateFiles' own walk, reused here rather than re-derived). So this total already
// reflects both properties `numTurns` never had: a message rewritten several times in one
// streamed line counts once, and a subagent's own requests are counted, never silently dropped.
// This is the deduplicated per-step request count `numTurns` used to stand in for badly (card
// #214, item 3) -- it replaces that removed field; it is NOT `callsMatched`/`callsUnmatched`
// above (a count of llm-call EVENTS, not of the requests each one can spend many of).
//
// LATENT CROSS-FILE OVER-COUNT (recorded, not fixed): `scanFile`'s `message.id` dedup is
// PER FILE (its `lastById` map is scoped to one call) -- a `message.id` that repeats ACROSS two
// files folded into the same `bySession` entry (main transcript + a `subagents/` file, or two
// files that independently name the same session) would be counted once per file, not once
// overall, over-counting this total. Measured 2026-09-13: 4 of 1,799 sessions carried 980
// cross-file id repeats out of 109,874 total ids -- all four in resumed or interactive sessions
// (a `claude --resume` re-opening a transcript the CLI itself re-wrote lines into), and NONE
// joined to a pipeline `llm-call` event, so `requestCount` and the journal-vs-transcript delta
// are unaffected by this today. Not fixed here: fixing it would mean deduplicating by
// `message.id` GLOBALLY across every file in a session rather than per file, a real change to
// `scanFile` itself (shared with every other caller of this module), not a one-line addition,
// and nothing measured yet needs it.
function sessionRequestCount(sessionEntry) {
  if (!sessionEntry || !sessionEntry.models) return 0;
  let total = 0;
  for (const m of Object.values(sessionEntry.models)) {
    total += m.msgs || 0;
  }
  return total;
}

// computeStepDeltas(usageIndex, journalCalls) -- usageIndex: an object carrying `bySession`
// (either a real scan()/buildStepDeltaReport result, or a hand-built fixture in a test).
// journalCalls: [{step, sessionId, billableTokens}], one entry per journalled `llm-call` event
// that names a step. A call with no `sessionId` at all (an event that predates sessionId
// journalling, or a spawn that never started -- see steps/llm.js's own header on when sessionId
// is null) cannot be joined to anything and is silently skipped, not counted as unmatched: there
// is nothing on the transcript side for either total to disagree with. A call whose sessionId
// IS present but absent from `bySession` (the transcript was rotated/deleted, or ran on an
// account/root this scan never covered) counts toward that step's `callsUnmatched` instead --
// its journalled billableTokens is deliberately NOT added to the step's journal total either,
// so an unmatched call can never masquerade as a transcript that measured exactly 0. Same rule
// for `requestCount` (sessionRequestCount's own deduplicated-request total, see that function's
// header): an unmatched call contributes 0 requests, never a false "this step made no requests".
function computeStepDeltas(usageIndex, journalCalls) {
  const bySession = (usageIndex && usageIndex.bySession) || {};
  const steps = {};
  for (const call of journalCalls || []) {
    if (!call || typeof call.step !== 'string' || !call.step) continue;
    if (typeof call.sessionId !== 'string' || !call.sessionId) continue;
    const entry = (steps[call.step] = steps[call.step] || emptyStepDelta());
    const sessionEntry = bySession[call.sessionId];
    if (!sessionEntry) {
      entry.callsUnmatched += 1;
      continue;
    }
    entry.callsMatched += 1;
    entry.journalBillableTokens += typeof call.billableTokens === 'number' ? call.billableTokens : 0;
    entry.transcriptBillableTokens += sessionBillableTokens(sessionEntry);
    entry.requestCount += sessionRequestCount(sessionEntry);
  }
  for (const entry of Object.values(steps)) {
    entry.delta = entry.journalBillableTokens - entry.transcriptBillableTokens;
    entry.deltaPct = entry.transcriptBillableTokens > 0 ? (entry.delta / entry.transcriptBillableTokens) * 100 : null;
  }
  return steps;
}

// collectJournalCallsForStepDelta(journalRoot) -- the journal side of the join: every task
// directory's own `journal.jsonl` PLUS the daemon-scoped `journal/daemon.jsonl` (intake's
// DRAFT_CARD/REVIEW_CARD/TRIAGE_BUG_REPORT calls -- orchestrator/intake.js's
// journalIntakeLlmCall writes the exact same `llm-call` event shape there, see that function's
// own header), collecting {step, sessionId, billableTokens} for every `llm-call` event found.
// Never throws: an unreadable directory, an unreadable file, or a torn/corrupt journal line (the
// daemon may be appending to either file while this reads it) is skipped, the same convention
// every other reader in this repo already uses.
function collectJournalCallsForStepDelta(journalRoot) {
  const calls = [];
  if (!journalRoot) return calls;

  function collectFromFile(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event !== 'llm-call') continue;
      calls.push({
        step: event.step,
        sessionId: event.sessionId,
        billableTokens: typeof event.billableTokens === 'number' ? event.billableTokens : 0,
      });
    }
  }

  let taskDirs = [];
  try {
    taskDirs = fs
      .readdirSync(journalRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    taskDirs = [];
  }
  for (const id of taskDirs) {
    collectFromFile(path.join(journalRoot, id, 'journal.jsonl'));
  }
  collectFromFile(path.join(journalRoot, 'daemon.jsonl'));

  return calls;
}

// buildStepDeltaReport({journalRoot, roots, filter, maxFileBytes}) -- ties the two halves
// together: collectJournalCallsForStepDelta above for the journal side, a ONE-SHOT transcript
// scan for the other -- reusing listCandidateFiles' subagent walk and scanFile's message.id
// dedup exactly as createUsageScanner's own scan() does (this is deliberately NOT a second
// implementation of that walk, per this card's own instruction not to build a new reconciliation
// reader), just without createUsageScanner's mtime/size cache: a one-off report has no repeat
// caller to amortize a cache for. Returns {steps: computeStepDeltas' own return shape,
// scannedSessions: how many distinct sessions the transcript side found at all, regardless of
// whether the journal side ever names them -- a sanity figure for "did this scan see anything"}.
async function buildStepDeltaReport({ journalRoot, roots = [], filter = null, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const journalCalls = collectJournalCallsForStepDelta(journalRoot);
  const files = listCandidateFiles({ roots, filter });
  const bySession = {};
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f.absPath);
    } catch {
      continue;
    }
    if (st.size > maxFileBytes) continue;
    const agg = await scanFile(f.absPath, f.account);
    if (!agg.sessionId) continue;
    const sEntry = (bySession[agg.sessionId] = bySession[agg.sessionId] || { models: {} });
    for (const [model, m] of Object.entries(agg.models)) {
      const sModel = (sEntry.models[model] = sEntry.models[model] || emptyModelAgg());
      mergeAgg(sModel, m);
    }
  }
  return { steps: computeStepDeltas({ bySession }, journalCalls), scannedSessions: Object.keys(bySession).length };
}

// formatStepDeltaReport(report) -- pure string formatting (no I/O), so any caller (bin/spo's
// `cmdTokens`, a future dashboard panel) can print the result of buildStepDeltaReport/
// computeStepDeltas directly. Returns [] (nothing to print) when no step carries a joinable
// call -- a caller should skip the section entirely rather than print an empty header.
function formatStepDeltaReport(report) {
  const steps = (report && report.steps) || {};
  const names = Object.keys(steps).sort();
  if (names.length === 0) return [];
  const lines = [
    '',
    'per-step journal-vs-transcript delta (card #214, billable-weighted tokens) and deduplicated request count (the numTurns replacement, card #214 fix pass):',
  ];
  for (const step of names) {
    const s = steps[step];
    const pct = s.deltaPct === null ? 'n/a' : `${s.deltaPct >= 0 ? '+' : ''}${s.deltaPct.toFixed(1)}%`;
    const unmatched = s.callsUnmatched ? `, ${s.callsUnmatched} unmatched` : '';
    lines.push(
      `  ${step.padEnd(18)}journal ${formatTokenCountForDelta(s.journalBillableTokens).padStart(8)}  ` +
        `transcript ${formatTokenCountForDelta(s.transcriptBillableTokens).padStart(8)}  ` +
        `delta ${pct.padStart(7)}  requests ${String(s.requestCount).padStart(6)}  (${s.callsMatched} matched${unmatched})`
    );
  }
  return lines;
}

// A local copy of orchestrator/tokens.js's formatTokenCount -- not imported from there on
// purpose: orchestrator/ is this pipeline's state-machine layer and console/ its read-only
// dashboard/reporting layer, and this file already keeps no dependency the other direction (see
// its own header: it is imported BY orchestrator/token-recovery.js, never the reverse). Kept
// byte-identical to tokens.js's version; if the two drift, extend the sibling-grep the next time
// either changes.
function formatTokenCountForDelta(n) {
  const v = typeof n === 'number' ? n : 0;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

module.exports = {
  createUsageScanner,
  buildTokenViews,
  buildTrendViews,
  discoverUsageRoots,
  localDateKey,
  // Card #214, action 4: the per-step journal-vs-transcript delta, and (fix pass, same card) the
  // deduplicated request count replacing `numTurns` -- computeStepDeltas/sessionBillableTokens/
  // sessionRequestCount are pure (test fixtures build `usageIndex`/`journalCalls` by hand, never
  // touching disk); collectJournalCallsForStepDelta and buildStepDeltaReport are the real I/O,
  // exported so bin/spo's `cmdTokens` (or a future dashboard panel) can call them without a
  // second implementation.
  computeStepDeltas,
  sessionBillableTokens,
  sessionRequestCount,
  collectJournalCallsForStepDelta,
  buildStepDeltaReport,
  formatStepDeltaReport,
  DEFAULT_MAX_FILE_BYTES,
  // listJsonlFilesRecursive / listCandidateFiles are exported for scripts/usage-report.js
  // (SPO-Pipeline#170): the offline CLI's own discovery used to be a second, undeclared copy of
  // this walk -- two levels only, no subagent recursion -- which is exactly how it came to
  // silently under-read the corpus (see scripts/usage-report.js's own header for the measured
  // gap that fixed). Sharing the function is the same rationale orchestrator/token-recovery.js's
  // header already gives for sharing scanFile: exactly one implementation of "which files belong
  // to this scan", so the two callers cannot drift on it again the way they just did.
  listJsonlFilesRecursive,
  listCandidateFiles,
  // scanFile is exported for orchestrator/token-recovery.js (token-ledger lot, action 4.3): that
  // module recovers billable tokens for a killed/unparsable `claude` call from the session
  // transcript it left on disk, and it deliberately reuses THIS reader rather than writing a
  // second one -- this repo's token-accounting code is emphatic that there is exactly one ledger
  // and one definition of "billable" (see this file's own header, and orchestrator/tokens.js's),
  // and a second transcript reader would let the two silently drift apart (a dedup-direction fix
  // applied to one and not the other, for instance). Sharing the function makes that structurally
  // impossible: the dashboard's live scan and the recovery path can never disagree about what a
  // given transcript file contains.
  scanFile,
};
