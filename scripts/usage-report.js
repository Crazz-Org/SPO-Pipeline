#!/usr/bin/env node
// usage-report v1 — token-usage analysis over local Claude Code transcripts.
//
// Streams every *.jsonl under each root's *<FILTER>*/ (default root: ~/.claude/projects,
// default filter: SPO), dedupes assistant messages by message.id (transcripts write one line
// per content block, so a naive sum double-counts), and aggregates usage by (model,
// driver|sidechain), by workflow phase, by session type, plus a cache-rebuild count and a
// weighted USD cost estimate.
//
// Deliberately streaming with O(1) memory per file: a whole-corpus jq slurp took the WSL VM
// down (tmpfs is RAM — ENOSPC under memory pressure, 2026-08-29). Keep it that way — never
// slurp a file or the corpus.
//
// Usage:   node scripts/usage-report.js [filter] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]
//                                        [--top=N] [--roots=dir1,dir2]
// Output:  one JSON document on stdout — totals by model, by phase, by session type,
//          cache-rebuild count, USD estimate, top sessions, date range.
//
// Baseline (2026-08-20..28, filter SPO): 273 sessions, 19,474 messages, ~3.84B cache-read
// tokens, ≈ $3,190 API-equivalent, 93% carried by Fable/Opus driver turns.
//
// v1 additions (this file):
//  - --since / --until / --top / --roots CLI flags (--roots also preps per-account
//    aggregation: each Claude account has its own projects root)
//  - per-phase segmentation from tool_use markers (claim/implement/checks/gate/pr-merge/
//    spawn/research/other) — markers are read from EVERY physical line, including
//    message.id duplicates, because a duplicate line often carries the tool_use block the
//    first line lacks; usage itself is still counted once per deduped message
//  - session type: "card" (any Bash command in the file contains board:take) vs "meta"
//  - cache-rebuild detection: a deduped message (after the file's first) whose
//    cache_creation_input_tokens exceeds 30% of (cache_creation + cache_read)
//  - a weighted USD cost estimate from a per-model API-price proxy table; an unmapped model
//    falls back to the opus rate and is flagged in estUsd.unknownModels
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HOME = process.env.HOME || '/root';

function expandHome(p) {
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

function parseArgs(argv) {
  const opts = { filter: null, since: null, until: null, top: 12, roots: null };
  for (const a of argv) {
    if (a.startsWith('--since=')) opts.since = a.slice('--since='.length);
    else if (a.startsWith('--until=')) opts.until = a.slice('--until='.length);
    else if (a.startsWith('--top=')) opts.top = parseInt(a.slice('--top='.length), 10) || 12;
    else if (a.startsWith('--roots=')) {
      opts.roots = a.slice('--roots='.length).split(',').map(s => expandHome(s.trim())).filter(Boolean);
    } else if (!a.startsWith('--') && opts.filter === null) opts.filter = a;
  }
  if (opts.filter === null) opts.filter = 'SPO';
  if (!opts.roots || opts.roots.length === 0) opts.roots = [path.join(HOME, '.claude', 'projects')];
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));
const FILTER = ARGS.filter;
const SINCE = ARGS.since; // 'YYYY-MM-DD' or null
const UNTIL = ARGS.until;
const TOP = ARGS.top;
const ROOTS = ARGS.roots; // array of absolute paths

// ---- phase markers -------------------------------------------------------
const CLAIM_PAT = ['board:claim', 'board:take', 'bench:nightly', 'board:status'];
const GATE_PAT = ['npm run gate', 'bench:wait', 'verdict']; // checked before CHECKS_PAT: a
// verdict-wrapped alias command (e.g. "npm run verdict -- lint") would otherwise match a
// checks pattern by coincidence of substring
const CHECKS_PAT = ['npm test', 'typecheck', 'lint', 'coverage'];
const PRMERGE_PAT = ['gh pr create', 'gh pr merge', 'pr:wait', 'board:move', 'git push'];

function bashPhase(cmd) {
  if (CLAIM_PAT.some(p => cmd.includes(p))) return 'claim';
  if (GATE_PAT.some(p => cmd.includes(p))) return 'gate';
  if (CHECKS_PAT.some(p => cmd.includes(p))) return 'checks';
  if (PRMERGE_PAT.some(p => cmd.includes(p))) return 'pr-merge';
  return null;
}

function markerPhase(name, input) {
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'implement';
  if (name === 'Task' || name === 'Agent') return 'spawn';
  if (name === 'WebSearch' || name === 'WebFetch') return 'research';
  if (name === 'Bash') {
    const cmd = input && typeof input.command === 'string' ? input.command : '';
    if (cmd) return bashPhase(cmd);
  }
  return null;
}

// ---- API-price proxy (USD per MTok) --------------------------------------
const RATES = {
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5], // wildcard base; matches any claude-haiku-4-5* (e.g. dated ids)
};

function rateFor(model) {
  if (RATES[model]) return { rIn: RATES[model][0], rOut: RATES[model][1], known: true };
  if (model.startsWith('claude-haiku-4-5')) {
    return { rIn: RATES['claude-haiku-4-5'][0], rOut: RATES['claude-haiku-4-5'][1], known: true };
  }
  return { rIn: RATES['claude-opus-5'][0], rOut: RATES['claude-opus-5'][1], known: false };
}

function usdForUsage(model, u) {
  const { rIn, rOut } = rateFor(model);
  return (
    ((u.input_tokens || 0) * rIn +
      (u.cache_read_input_tokens || 0) * 0.1 * rIn +
      (u.cache_creation_input_tokens || 0) * 2 * rIn +
      (u.output_tokens || 0) * rOut) /
    1e6
  );
}

// ---- global accumulators --------------------------------------------------
const byModel = {}; // model -> side -> sums   (unchanged from v0)
const byPhase = {}; // phase -> {n, cr, cc, out}
const sessions = { card: { n: 0, cr: 0, cc: 0, out: 0 }, meta: { n: 0, cr: 0, cc: 0, out: 0 } };
const cacheRebuilds = { events: 0, ccSum: 0 };
const costAcc = {}; // model -> {inp, cr, cc, out}  (drives estUsd.byModel)
const perFile = [];
const rootStats = {}; // rootPath -> {files, sessionsWithUsage, msgs, dupes, costUsd}
let files = 0,
  msgs = 0,
  dupes = 0,
  minTs = null,
  maxTs = null;

function acc(model, side, u) {
  const m = (byModel[model] = byModel[model] || {});
  const s = (m[side] = m[side] || { n: 0, inp: 0, cc: 0, cc5m: 0, cc1h: 0, cr: 0, out: 0, think: 0 });
  s.n += 1;
  s.inp += u.input_tokens || 0;
  s.cc += u.cache_creation_input_tokens || 0;
  s.cc5m += (u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0;
  s.cc1h += (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  s.cr += u.cache_read_input_tokens || 0;
  s.out += u.output_tokens || 0;
  s.think += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
}

async function doFile(fp, rootPath) {
  const rs = rootStats[rootPath];
  const seen = new Set();
  let currentPhase = 'other';
  let isCard = false;
  let firstCounted = false;
  const f = {
    file: fp.replace(rootPath + '/', ''),
    root: ROOTS.length > 1 ? rootPath : undefined,
    msgs: 0,
    inp: 0,
    cc: 0,
    cr: 0,
    out: 0,
    lastTs: null,
    type: 'meta',
  };
  const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
  for await (const line of rl) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      if (!minTs || o.timestamp < minTs) minTs = o.timestamp;
      if (!maxTs || o.timestamp > maxTs) maxTs = o.timestamp;
    }

    // Markers (phase + card-session detection) are read from EVERY line, including
    // message.id duplicates: a duplicate line often carries the tool_use block the first
    // line lacks. This must run before the usage-dedupe gate below, unconditionally.
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (content) {
      for (const c of content) {
        if (c.type !== 'tool_use') continue;
        if (c.name === 'Bash' && c.input && typeof c.input.command === 'string' && c.input.command.includes('board:take')) {
          isCard = true;
        }
        const ph = markerPhase(c.name, c.input);
        if (ph) currentPhase = ph;
      }
    }

    const u = o.message && o.message.usage;
    if (!u) continue;
    const id = (o.message && o.message.id) || o.uuid;
    if (id && seen.has(id)) {
      dupes++;
      if (rs) rs.dupes++;
      continue;
    }
    if (id) seen.add(id);

    const day = (o.timestamp || '').slice(0, 10);
    const inWindow = (!SINCE || day >= SINCE) && (!UNTIL || day <= UNTIL);
    if (!inWindow) continue;

    msgs++;
    if (rs) rs.msgs++;
    f.lastTs = o.timestamp;
    const model = (o.message && o.message.model) || 'unknown';
    const side = o.isSidechain ? 'sidechain' : 'driver';
    acc(model, side, u);

    const cc = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const out = u.output_tokens || 0;

    const ph = (byPhase[currentPhase] = byPhase[currentPhase] || { n: 0, cr: 0, cc: 0, out: 0 });
    ph.n += 1;
    ph.cr += cr;
    ph.cc += cc;
    ph.out += out;

    const ca = (costAcc[model] = costAcc[model] || { inp: 0, cr: 0, cc: 0, out: 0 });
    ca.inp += u.input_tokens || 0;
    ca.cr += cr;
    ca.cc += cc;
    ca.out += out;
    const usd = usdForUsage(model, u);
    if (rs) rs.costUsd += usd;

    if (!firstCounted) {
      firstCounted = true; // a file's first counted usage message never counts as a rebuild
    } else {
      const denom = cc + cr;
      if (denom > 0 && cc > 0.3 * denom) {
        cacheRebuilds.events++;
        cacheRebuilds.ccSum += cc;
      }
    }

    f.msgs++;
    f.inp += u.input_tokens || 0;
    f.cc += cc;
    f.cr += cr;
    f.out += out;
  }
  f.type = isCard ? 'card' : 'meta';
  if (f.msgs > 0) {
    perFile.push(f);
    if (rs) rs.sessionsWithUsage++;
    const b = sessions[f.type];
    b.n += 1;
    b.cr += f.cr;
    b.cc += f.cc;
    b.out += f.out;
  }
  files++;
  if (rs) rs.files++;
}

(async () => {
  for (const rootPath of ROOTS) {
    rootStats[rootPath] = { files: 0, sessionsWithUsage: 0, msgs: 0, dupes: 0, costUsd: 0 };
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(rootPath);
    } catch {
      continue;
    }
    const dirs = dirEntries.filter(d => d.includes(FILTER)).map(d => path.join(rootPath, d));
    for (const d of dirs) {
      let entries;
      try {
        entries = fs.readdirSync(d);
      } catch {
        continue;
      }
      for (const e of entries) if (e.endsWith('.jsonl')) await doFile(path.join(d, e), rootPath);
    }
  }

  // rank sessions by a rough weight: full-price input + cache writes + 5x output + 0.1x cache reads
  perFile.sort((a, b) => b.inp + b.cc + 5 * b.out + 0.1 * b.cr - (a.inp + a.cc + 5 * a.out + 0.1 * a.cr));
  const top = perFile.slice(0, TOP).map(f => ({
    file: f.file,
    ...(f.root ? { root: f.root } : {}),
    type: f.type,
    msgs: f.msgs,
    Minp: +(f.inp / 1e6).toFixed(2),
    Mcc: +(f.cc / 1e6).toFixed(1),
    Mcr: +(f.cr / 1e6).toFixed(0),
    Mout: +(f.out / 1e6).toFixed(2),
    last: (f.lastTs || '').slice(0, 10),
  }));

  const round = o => {
    const r = {};
    for (const k in o) r[k] = typeof o[k] === 'number' ? (k === 'n' ? o[k] : +(o[k] / 1e6).toFixed(2)) : o[k];
    return r;
  };
  const bm = {};
  for (const m in byModel) {
    bm[m] = {};
    for (const s in byModel[m]) bm[m][s] = round(byModel[m][s]);
  }

  const bp = {};
  for (const p in byPhase) bp[p] = round(byPhase[p]);

  const sessionsOut = { card: round(sessions.card), meta: round(sessions.meta) };

  const estByModel = {};
  const unknownModels = [];
  let estTotal = 0;
  for (const m in costAcc) {
    const c = costAcc[m];
    const { rIn, rOut, known } = rateFor(m);
    if (!known) unknownModels.push(m);
    const usd = (c.inp * rIn + c.cr * 0.1 * rIn + c.cc * 2 * rIn + c.out * rOut) / 1e6;
    estByModel[m] = +usd.toFixed(2);
    estTotal += usd;
  }
  const estUsd = { total: +estTotal.toFixed(2), byModel: estByModel, unknownModels };

  const out = {
    filter: FILTER,
    since: SINCE,
    until: UNTIL,
    top: TOP,
    roots: ROOTS,
    files,
    sessionsWithUsage: perFile.length,
    msgs,
    dupes,
    range: [minTs && minTs.slice(0, 10), maxTs && maxTs.slice(0, 10)],
    byModel_Mtokens: bm,
    byPhase_Mtokens: bp,
    sessions: sessionsOut,
    cacheRebuilds: { events: cacheRebuilds.events, Mcc_in_rebuilds: +(cacheRebuilds.ccSum / 1e6).toFixed(2) },
    estUsd,
    topSessions: top,
  };

  if (ROOTS.length > 1) {
    out.byRoot = {};
    for (const rootPath of ROOTS) {
      const rs = rootStats[rootPath];
      out.byRoot[rootPath] = {
        files: rs.files,
        sessionsWithUsage: rs.sessionsWithUsage,
        msgs: rs.msgs,
        dupes: rs.dupes,
        estUsd: +rs.costUsd.toFixed(2),
      };
    }
  }

  console.log(JSON.stringify(out, null, 1));
})();
