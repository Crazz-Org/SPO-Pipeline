#!/usr/bin/env node
// usage-report v0 — token-usage baseline over local Claude Code transcripts.
//
// Streams every *.jsonl under ~/.claude/projects/*<FILTER>*/ (default filter: SPO), dedupes
// assistant messages by message.id (transcripts write one line per content block, so a naive
// sum double-counts), and aggregates usage by (model, driver|sidechain).
//
// Deliberately streaming with O(1) memory per file: a whole-corpus jq slurp took the WSL VM
// down (tmpfs is RAM — ENOSPC under memory pressure, 2026-08-29). Keep it that way.
//
// Usage:   node scripts/usage-report.js [filter]
// Output:  one JSON document on stdout — totals by model, top sessions, date range.
//
// Baseline (2026-08-20..28, filter SPO): 273 sessions, 19,474 messages, ~3.84B cache-read
// tokens, ≈ $3,190 API-equivalent, 93% carried by Fable/Opus driver turns.
//
// TODO (phase 0): per-account aggregation (one CLAUDE_CONFIG_DIR per account → distinct
// transcript roots), per-phase segmentation via tool-call markers, cache-expiry detection
// (cache_creation ≈ context size mid-session), card-vs-meta session classification.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILTER = process.argv[2] || 'SPO';
const ROOT = path.join(process.env.HOME || '/root', '.claude', 'projects');
const dirs = fs.readdirSync(ROOT).filter(d => d.includes(FILTER)).map(d => path.join(ROOT, d));

const byModel = {}; // model -> side -> sums
const perFile = [];
let files = 0, msgs = 0, dupes = 0, minTs = null, maxTs = null;

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

async function doFile(fp) {
  const seen = new Set();
  const f = { file: fp.replace(ROOT + '/', ''), msgs: 0, inp: 0, cc: 0, cr: 0, out: 0, lastTs: null };
  const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
  for await (const line of rl) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) {
      if (!minTs || o.timestamp < minTs) minTs = o.timestamp;
      if (!maxTs || o.timestamp > maxTs) maxTs = o.timestamp;
      f.lastTs = o.timestamp;
    }
    const u = o.message && o.message.usage;
    if (!u) continue;
    const id = (o.message && o.message.id) || o.uuid;
    if (id && seen.has(id)) { dupes++; continue; }
    if (id) seen.add(id);
    msgs++;
    const model = (o.message && o.message.model) || 'unknown';
    const side = o.isSidechain ? 'sidechain' : 'driver';
    acc(model, side, u);
    f.msgs++; f.inp += u.input_tokens || 0; f.cc += u.cache_creation_input_tokens || 0;
    f.cr += u.cache_read_input_tokens || 0; f.out += u.output_tokens || 0;
  }
  if (f.msgs > 0) perFile.push(f);
  files++;
}

(async () => {
  for (const d of dirs) {
    let entries; try { entries = fs.readdirSync(d); } catch { continue; }
    for (const e of entries) if (e.endsWith('.jsonl')) await doFile(path.join(d, e));
  }
  // rank sessions by a rough weight: full-price input + cache writes + 5x output + 0.1x cache reads
  perFile.sort((a, b) => (b.inp + b.cc + 5 * b.out + 0.1 * b.cr) - (a.inp + a.cc + 5 * a.out + 0.1 * a.cr));
  const top = perFile.slice(0, 12).map(f => ({
    file: f.file, msgs: f.msgs, Minp: +(f.inp / 1e6).toFixed(2), Mcc: +(f.cc / 1e6).toFixed(1),
    Mcr: +(f.cr / 1e6).toFixed(0), Mout: +(f.out / 1e6).toFixed(2), last: (f.lastTs || '').slice(0, 10)
  }));
  const round = o => { const r = {}; for (const k in o) r[k] = typeof o[k] === 'number' ? (k === 'n' ? o[k] : +(o[k] / 1e6).toFixed(2)) : o[k]; return r; };
  const bm = {};
  for (const m in byModel) { bm[m] = {}; for (const s in byModel[m]) bm[m][s] = round(byModel[m][s]); }
  console.log(JSON.stringify({
    filter: FILTER, files, sessionsWithUsage: perFile.length, msgs, dupes,
    range: [minTs && minTs.slice(0, 10), maxTs && maxTs.slice(0, 10)],
    byModel_Mtokens: bm, topSessions: top
  }, null, 1));
})();
