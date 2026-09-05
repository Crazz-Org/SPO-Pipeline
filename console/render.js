'use strict';
// console/render.js -- pure HTML rendering for the pipeline dashboard. Given the parsed local
// surfaces (see console/collect.js for how those are gathered) plus the live-only
// system/prod/tokens objects console/serve.js merges in, renderDashboard() returns one full,
// self-contained HTML document string: inline CSS, no external requests. Nothing in this file
// touches fs/network/Date.now() -- the same input always produces the same output, which is
// what makes it unit-testable without touching disk.
//
// Two render modes, both from the SAME data shape:
//   renderDashboard(data)                 -- static mode (default): a 30s <meta refresh>, no
//                                             client script. Used by `spo dashboard` (no
//                                             --serve) and --watch. system/prod/tokens are
//                                             expected to be null and render as "not monitored".
//   renderDashboard(data, {live: true})   -- live mode: no meta refresh; a small inline script
//                                             polls /api/system (1s) and /api/data (30s) and
//                                             swaps section fragments in place. Used by
//                                             console/serve.js.
//
// Fragment convention: every section has a renderXxxInner(data) -> string (content only, no
// wrapping element) and is wrapped by frag(id, inner) into <section id="frag-ID">. `/api/data`'s
// JSON response serves the *Inner strings directly (renderDataFragments) -- NEVER the
// frag()-wrapped string -- so the client's `el.innerHTML = fragments[id]` never nests a second
// <section id="frag-ID"> inside the first. IDs are a client<->server contract: services, system,
// accounts, daemon, reports, tokens, secondary, stamp. `prod` is folded into the `services` tile
// row (renderProdTile) rather than being its own fragment -- see § 1 below.
//
// Input shape (every field optional -- a missing/empty one renders as an empty section, never
// throws):
//
//   {
//     generatedAt: ISO string,
//     journalTasks: [{ id, title, kind, state, reason, updatedAt, lastEventTs, lastEventName,
//                       llmSteps: [{step, model, account, sessionId, durationS}] }],
//                    -- collected for other consumers (daemonStats, token-usage session
//                       attribution) but NOT rendered here: per-task detail duplicates the
//                       GitHub Projects board (Kanban), which is the source of truth for task
//                       state. No dollar figure is ever carried here -- see "NEVER a dollar
//                       figure" below; `orchestrator/tokens.js` / `spo tokens` own that view.
//     queue: { depth, nextIds: [id, ...] },
//     accounts: { rows: [{ name, email, plan, enabled, cooldownUntil, cooling, hasToken,
//                           hasCredentials }] },
//     nightly: { verdict, sha, jobId, finishedAt, detail } | null,
//     verdicts: [{ file, head, verdict, createdAt, jobId, baseMain }],   // newest-first
//     usageSnapshot: { byModel_Mtokens, byPhase_Mtokens, range, since, until } | null, // static-mode fallback
//     usageSnapshotMeta: { rangeStart, rangeEnd, source, ageMs, stale } | null, // console/collect.js's
//                                                          // usageSnapshotFreshness -- action 5.5, item B
//     trend: { series, lastRecordedDate, todayLocalDate, stale, staleDays, kpis } | null,
//                                                          // console/usage-scan.js buildTrendViews,
//                                                          // from <journalRoot>/usage-rollups.json -- populated
//                                                          // in BOTH static and live mode (a cheap read of
//                                                          // an already-computed file, not a live scan)
//     services: { daemon, queue, benchWorker, nightly, verdicts, workers, retryChannel },
//                    -- `workers` added action 6.7: C6's dispatcher.js live-worker count
//                       (present/count/staleCount/trailingCount/updatedAt/ageMs), an aggregate
//                       ONLY -- see console/collect.js's own header on why no per-task rows
//                    -- `retryChannel` added by project-2 card #476: the unpark (retry/abandon)
//                       scan's own health (status/parkedCards/failingCards/healthyCards/
//                       unprovenCards/worstFailures/lastFailedAgeMs), aggregate only for the
//                       same reason, and absent entirely before the card
//     daemonStats: { total, done, parked, abandoned, week, today, active, imported, inFlight,
//                     parkingRatePct },   // abandoned added action 4.5 -- see console/collect.js
//     reports: { queuedIntake, pendingConfirm, confirmedAwaitingTriage, lastIntakeCycle,
//                 last24h, pull },
//     system: SystemSnapshot | null,        // console/system.js, live server only
//     prod: ProdSnapshot | null,             // console/prod-version.js, live server only
//     tokens: TokenViews | null,             // console/usage-scan.js, live server only
//   }
//
// UI text is English (repo content is English regardless of what language the maintainer
// converses in -- README.md "Language"); data values (ids, states, model names, reasons) are
// rendered as-is. NEVER a dollar figure -- this build carries no cost/$ fields anywhere; token
// accounting is rendered nowhere in this file either (`spo tokens` / orchestrator/tokens.js own
// that view instead).

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Token counts, formatted the way the rest of the project already formats them: 12.3M / 215.4k /
// a plain integer. Delegates to orchestrator/tokens.js's formatTokenCount -- the SAME function
// `spo tokens`, `spo resume` and the Done/park comments use -- rather than a second local copy,
// per the console's own "reader, never a second source of truth" rule.
//
// `raw` is the unrounded integer console/usage-scan.js now carries beside each M* field;
// `mFallback` is that M* field, used only when a row predates the raw counts (a persisted rollup,
// or a hand-built test fixture). The fallback is honest about its resolution: an M* value has
// already been rounded to two decimals, so a 4,321-token row reads "0" there and cannot be
// recovered -- which is exactly why the raw counts were added.
function fmtTokens(raw, mFallback) {
  const { formatTokenCount } = require('../orchestrator/tokens');
  if (typeof raw === 'number' && Number.isFinite(raw)) return formatTokenCount(raw);
  if (typeof mFallback === 'number' && Number.isFinite(mFallback)) return formatTokenCount(mFallback * 1e6);
  return '—';
}

function fmtNum(n, digits = 2) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtInt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : '—';
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 10) : '?';
}

function verdictClass(v) {
  if (v === 'PASS') return 'verdict-pass';
  if (v === 'FAIL') return 'verdict-fail';
  return 'verdict-unknown';
}

function fmtAgeMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').slice(0, 16);
}

function tileClass(status) {
  if (status === 'up' || status === 'ok' || status === 'pass') return 'tile-green';
  if (status === 'busy' || status === 'stale' || status === 'warn') return 'tile-orange';
  if (status === 'down' || status === 'fail') return 'tile-red';
  return 'tile-gray';
}

function frag(id, inner) {
  return `<section id="frag-${id}" class="frag">${inner}</section>`;
}

const CSS = `
:root {
  color-scheme: dark light;
  --bg: #0e0f16;
  --bg-grad: radial-gradient(1200px 600px at 10% -10%, #201a42 0%, transparent 55%), #0e0f16;
  --card-bg: #171923;
  --surface-2: #1f2230;
  --surface-hover: #20222f;
  --border: #2a2d3c;
  --border-soft: #23262f;
  --fg: #eceefc;
  --muted: #9599b0;
  --faint: #6b6f85;
  --accent: #9b8cff;
  --accent-strong: #b3a6ff;
  --accent-soft: #241f47;
  --teal: #4fd9d4;
  --green: #4ade80;
  --green-bg: #123322;
  --red: #ff7a7a;
  --red-bg: #3a1a1a;
  --orange: #fbbf59;
  --orange-bg: #3a2a10;
  --gray-bg: #23263355;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.4);
  --shadow-glow: 0 0 0 1px rgba(155,140,255,0.15), 0 8px 24px rgba(155,140,255,0.12);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --font-display: "SF Pro Display", -apple-system, "Segoe UI Variable Display", "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  --font-text: -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace;
}
/* Dark is the default regardless of OS preference -- only an explicit light system setting
   switches the palette. See doc/setup.md-adjacent decision: operators mostly check this at
   night/on a phone. */
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f4f5f8;
    --bg-grad: radial-gradient(1200px 600px at 10% -10%, #ece8ff 0%, transparent 55%), #f4f5f8;
    --card-bg: #ffffff;
    --surface-2: #eceef3;
    --surface-hover: #f8f8fc;
    --border: #dfe2ea;
    --border-soft: #eaecf2;
    --fg: #161822;
    --muted: #5b6072;
    --faint: #8b90a2;
    --accent: #5b45e6;
    --accent-strong: #4633c9;
    --accent-soft: #efebff;
    --teal: #0ea5a3;
    --green: #16a34a;
    --green-bg: #e7f7ec;
    --red: #dc2626;
    --red-bg: #fde8e7;
    --orange: #d97706;
    --orange-bg: #fdf1de;
    --gray-bg: #eceef3;
    --shadow-sm: 0 1px 2px rgba(20,20,45,0.05), 0 1px 1px rgba(20,20,45,0.03);
    --shadow-md: 0 4px 14px rgba(20,20,45,0.08), 0 1px 3px rgba(20,20,45,0.05);
    --shadow-glow: 0 0 0 1px rgba(91,69,230,0.08), 0 8px 24px rgba(91,69,230,0.10);
  }
}
/* Explicit override from the topbar toggle (LIVE_SCRIPT/THEME_SCRIPT sets data-theme + persists
   it in localStorage) -- higher specificity than the plain :root/@media rules above, so it wins
   over the OS preference in either direction once the operator has picked one by hand. */
:root[data-theme="light"] {
  --bg: #f4f5f8;
  --bg-grad: radial-gradient(1200px 600px at 10% -10%, #ece8ff 0%, transparent 55%), #f4f5f8;
  --card-bg: #ffffff;
  --surface-2: #eceef3;
  --surface-hover: #f8f8fc;
  --border: #dfe2ea;
  --border-soft: #eaecf2;
  --fg: #161822;
  --muted: #5b6072;
  --faint: #8b90a2;
  --accent: #5b45e6;
  --accent-strong: #4633c9;
  --accent-soft: #efebff;
  --teal: #0ea5a3;
  --green: #16a34a;
  --green-bg: #e7f7ec;
  --red: #dc2626;
  --red-bg: #fde8e7;
  --orange: #d97706;
  --orange-bg: #fdf1de;
  --gray-bg: #eceef3;
  --shadow-sm: 0 1px 2px rgba(20,20,45,0.05), 0 1px 1px rgba(20,20,45,0.03);
  --shadow-md: 0 4px 14px rgba(20,20,45,0.08), 0 1px 3px rgba(20,20,45,0.05);
  --shadow-glow: 0 0 0 1px rgba(91,69,230,0.08), 0 8px 24px rgba(91,69,230,0.10);
}
:root[data-theme="dark"] {
  --bg: #0e0f16;
  --bg-grad: radial-gradient(1200px 600px at 10% -10%, #201a42 0%, transparent 55%), #0e0f16;
  --card-bg: #171923;
  --surface-2: #1f2230;
  --surface-hover: #20222f;
  --border: #2a2d3c;
  --border-soft: #23262f;
  --fg: #eceefc;
  --muted: #9599b0;
  --faint: #6b6f85;
  --accent: #9b8cff;
  --accent-strong: #b3a6ff;
  --accent-soft: #241f47;
  --teal: #4fd9d4;
  --green: #4ade80;
  --green-bg: #123322;
  --red: #ff7a7a;
  --red-bg: #3a1a1a;
  --orange: #fbbf59;
  --orange-bg: #3a2a10;
  --gray-bg: #23263355;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.4);
  --shadow-glow: 0 0 0 1px rgba(155,140,255,0.15), 0 8px 24px rgba(155,140,255,0.12);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0.85rem;
  background: var(--bg-grad);
  color: var(--fg);
  font-family: var(--font-text);
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
@media (min-width: 720px) { body { padding: 1.75rem 2rem 3rem; } }
@media (min-width: 1200px) { body { padding: 2rem 3rem 3.5rem; max-width: 1400px; margin: 0 auto; } }

h1 { font-family: var(--font-display); font-size: 1.1rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 1.1rem; word-break: break-word; }
h2 {
  font-family: var(--font-display);
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--faint); margin: 0 0 0.65rem; border-bottom: none; padding-bottom: 0;
}
.meta { color: var(--muted); font-size: 0.85rem; }
.empty { color: var(--faint); font-style: italic; }
section { margin-bottom: 1.6rem; }
.banner { padding: 0.6rem 1rem; border-radius: var(--radius-md); margin-bottom: 1rem; font-size: 0.95rem; }
.banner .meta { display: block; margin-top: 0.15rem; }
.alert-banner {
  display: flex; align-items: center; gap: 0.6rem;
  background: var(--red-bg); color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent);
  border-radius: var(--radius-md); padding: 0.65rem 1rem; margin-bottom: 1rem;
  font-size: 0.88rem; font-weight: 600;
}
.alert-banner .dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; background: var(--red); flex-shrink: 0; margin: 0; }
.verdict-pass { background: var(--green-bg); color: var(--green); }
.verdict-fail { background: var(--red-bg); color: var(--red); }
.verdict-unknown { background: var(--gray-bg); color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 0.4rem 0 0.6rem; font-size: 0.85rem; }
th { text-align: left; padding: 0.4rem 0.5rem; color: var(--faint); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid var(--border); }
td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border-soft); }
tbody tr { transition: background 0.12s ease; }
tbody tr:hover { background: var(--surface-hover); }
td.num, th.num { font-variant-numeric: tabular-nums; text-align: right; }
tr.cooling { background: var(--red-bg); }
tr.cooling:hover { background: var(--red-bg); }
code {
  font-family: var(--font-mono);
  background: var(--surface-2);
  padding: 0.1rem 0.35rem;
  border-radius: 5px;
  font-size: 0.85em;
}
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); padding: 1rem 1.1rem; }
.grid-2 { display: grid; grid-template-columns: 1fr; gap: 1rem; }
@media (min-width: 860px) { .grid-2 { grid-template-columns: 1fr 1fr; } }

.dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 999px; margin-right: 0.35rem; vertical-align: middle; position: relative; background: currentColor; }
.dot.pulse::after {
  content: ""; position: absolute; inset: -3px; border-radius: 999px;
  background: currentColor; opacity: 0.35; animation: pulse 2.2s ease-out infinite;
}
@keyframes pulse { 0% { transform: scale(0.6); opacity: 0.5; } 100% { transform: scale(2.1); opacity: 0; } }
.dot-green { color: var(--green); background: var(--green); }
.dot-orange { color: var(--orange); background: var(--orange); }
.dot-red { color: var(--red); background: var(--red); }
.dot-gray { color: var(--muted); background: var(--muted); }

.svc-tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.7rem; }
@media (min-width: 640px) { .svc-tiles { grid-template-columns: repeat(3, 1fr); } }
/* 7 tiles since action 6.7 added Workers (Daemon, Queue, Workers, Bench worker, Nightly,
   Verdicts, Prod) -- this was still repeat(6), which dropped Prod alone onto a second row. */
@media (min-width: 960px) { .svc-tiles { grid-template-columns: repeat(7, 1fr); } }
.svc-tile {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md); padding: 0.85rem 0.9rem;
  display: flex; flex-direction: column; gap: 0.35rem;
  position: relative; overflow: hidden;
}
.svc-tile::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--tile-color, var(--muted)); }
.svc-tile .svc-name { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--faint); }
.svc-tile .svc-status {
  display: inline-flex; align-items: center; gap: 0.35rem;
  font-size: 0.78rem; font-weight: 700; color: var(--tile-color, var(--muted));
  text-transform: uppercase; letter-spacing: 0.02em;
}
.svc-tile.tile-green { --tile-color: var(--green); }
.svc-tile.tile-orange { --tile-color: var(--orange); }
.svc-tile.tile-red { --tile-color: var(--red); }
.svc-tile.tile-gray { --tile-color: var(--muted); }
.svc-tile .svc-big { font-family: var(--font-display); font-size: 1.55rem; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; line-height: 1.1; margin-top: 0.1rem; }
.svc-tile .svc-big-unit { font-size: 0.85rem; font-weight: 600; color: var(--muted); margin-left: 0.15rem; }
.svc-tile .svc-caption { color: var(--faint); font-size: 0.72rem; }
.svc-tile .svc-timestamp { font-family: var(--font-mono); font-size: 1.02rem; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; color: var(--fg); margin-top: 0.1rem; }

.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 0.75rem; margin: 0.5rem 0 1rem; }
.kpi { border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: 0.85rem 1rem; background: var(--card-bg); }
.kpi.accent { background: linear-gradient(155deg, var(--accent-soft), var(--card-bg) 70%); box-shadow: var(--shadow-glow); }
.kpi.accent strong { color: var(--accent-strong); }
.kpi strong { display: block; font-family: var(--font-display); font-size: 1.8rem; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.kpi span { color: var(--muted); font-size: 0.78rem; }
.trend-warn { color: var(--red); font-weight: 700; }
.trend-good { color: var(--green); font-weight: 700; }

.spark { display: block; width: 100%; height: 34px; }
.spark polyline.line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.spark polyline.area { fill: var(--accent); opacity: 0.12; stroke: none; }
.spark-teal polyline.line { stroke: var(--teal); }
.spark-teal polyline.area { fill: var(--teal); }

.bar-row { display: grid; grid-template-columns: 3rem 1fr 2.6rem; align-items: center; gap: 0.5rem; margin: 0.22rem 0; font-size: 0.78rem; }
.bar { height: 0.5rem; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.bar > span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--teal)); transition: width 0.5s cubic-bezier(.4,0,.2,1); }
.gauge { height: 0.7rem; background: var(--surface-2); border-radius: 999px; overflow: hidden; margin: 0.3rem 0; }
.gauge > span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--teal)); transition: width 0.6s cubic-bezier(.4,0,.2,1); }
.gauge-warn > span { background: linear-gradient(90deg, var(--orange), #f0b429); }
.gauge-crit > span { background: linear-gradient(90deg, var(--red), #ff8f7a); }

details {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-md);
  margin-bottom: 0.6rem; overflow: hidden;
}
details summary {
  cursor: pointer; padding: 0.7rem 1rem; font-weight: 600; font-size: 0.86rem;
  list-style: none; display: flex; align-items: center; justify-content: space-between; color: var(--fg);
}
details summary::-webkit-details-marker { display: none; }
details summary::after { content: "▾"; color: var(--faint); transition: transform 0.15s ease; }
details[open] summary::after { transform: rotate(180deg); }
details > *:not(summary) { padding: 0 1rem 0.9rem; }
details summary:hover { background: var(--surface-hover); }
.section-divider { border: none; border-top: 1px solid var(--border-soft); margin: 1.8rem 0 1.4rem; }

body[data-stale="1"] .frag { opacity: 0.55; }
#offline-banner { display: none; }
body[data-stale="1"] #offline-banner { display: block; }

.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.1rem; flex-wrap: wrap; }
.brand { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
.brand h1 { margin: 0; }
.brand .stamp { color: var(--faint); font-size: 0.78rem; font-variant-numeric: tabular-nums; }
.topbar-right { display: flex; align-items: center; gap: 0.6rem; }
.theme-toggle {
  display: inline-flex; align-items: center; gap: 0.4rem;
  border: 1px solid var(--border); background: var(--card-bg);
  border-radius: 999px; padding: 0.32rem 0.7rem 0.32rem 0.5rem;
  font-size: 0.78rem; font-weight: 600; color: var(--muted);
  cursor: pointer; box-shadow: var(--shadow-sm);
  transition: background 0.15s ease, transform 0.1s ease;
}
.theme-toggle:hover { background: var(--surface-hover); }
.theme-toggle:active { transform: scale(0.97); }
.theme-toggle .icon { font-size: 0.95rem; }

.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.65rem; flex-wrap: wrap; gap: 0.4rem; }
.subgrid-note { color: var(--faint); font-size: 0.78rem; margin-top: 0.4rem; }

@media (max-width: 720px) {
  table { display: block; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }
}

/* ============================================================================================
   FLIGHT DECK (console/render-deck.js). Same tokens as everything above -- the deck introduces
   no colour of its own, only new shapes. Chunky tiles get their weight from a solid offset
   shadow rather than a gradient, so they read as objects in both themes without a second
   palette.
   ============================================================================================ */
.deck { display: flex; flex-direction: column; gap: 1.1rem; }
.deck-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-lg);
  overflow: hidden; box-shadow: var(--shadow-md);
}
.deck-card.deck-stale { opacity: 0.72; }
.deck-card.deck-finished { border-color: var(--border); }

.deck-head {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 1.5rem;
  flex-wrap: wrap; padding: 1rem 1.2rem 0.85rem; border-bottom: 1px solid var(--border-soft);
}
.deck-id { min-width: 0; display: flex; flex-direction: column; gap: 0.45rem; }
.deck-idline { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; font-family: var(--font-mono); font-size: 0.72rem; }
.deck-idline .mono { color: var(--muted); letter-spacing: 0.03em; }
.deck-idline .sep { color: var(--faint); }
.run-pill {
  background: var(--accent); color: var(--bg); font-weight: 700; letter-spacing: 0.09em;
  padding: 0.12rem 0.42rem; border-radius: 5px; font-size: 0.68rem;
}
.deck-title {
  font-family: var(--font-display); font-size: 1.02rem; font-weight: 600; line-height: 1.35;
  letter-spacing: -0.006em; margin: 0; max-width: 58ch; color: var(--fg);
}
.deck-timer { display: flex; flex-direction: column; align-items: flex-end; gap: 0.35rem; flex-shrink: 0; }
.timer-big {
  font-family: var(--font-mono); font-size: 2.3rem; font-weight: 600; letter-spacing: -0.045em;
  line-height: 1; font-variant-numeric: tabular-nums; color: var(--fg);
}
.timer-delta { font-family: var(--font-mono); font-size: 0.72rem; display: inline-flex; align-items: center; gap: 0.3rem; }
.pill {
  display: inline-flex; align-items: center; gap: 0.4rem; font-family: var(--font-mono);
  font-size: 0.66rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase;
  padding: 0.2rem 0.55rem; border-radius: 999px;
}
.pill-live { background: color-mix(in srgb, var(--teal) 16%, transparent); color: var(--teal); }
.pill-done { background: var(--green-bg); color: var(--green); }
.pill-parked { background: var(--red-bg); color: var(--red); }
.pill-stale { background: var(--gray-bg); color: var(--faint); text-transform: none; letter-spacing: 0.02em; }
.pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.pace-under { color: var(--green); }
.pace-over { color: var(--orange); }
.pace-bad { color: var(--red); }
.pace-none { color: var(--faint); }

/* ---- track ---- */
.deck-track { padding: 1.15rem 1.1rem 0.2rem; overflow-x: auto; }
.deck-track svg { display: block; width: 100%; min-width: 980px; height: auto; }
.track-bed { fill: var(--border); }
.track-lit { fill: var(--accent); }
.arrow-head { fill: var(--orange); }
.tile .tile-face { fill: var(--surface-2); stroke: var(--border); stroke-width: 1.6; }
.tile .tile-icon { color: var(--faint); }
.tile .tile-label {
  font-family: var(--font-mono); font-size: 10px; text-anchor: middle; fill: var(--faint);
}
.tile-done .tile-face { fill: var(--green-bg); stroke: var(--green); }
.tile-done .tile-icon { color: var(--green); }
.tile-done .tile-label { fill: var(--muted); }
.tile-stale .tile-face { fill: var(--gray-bg); stroke: var(--border); }
.tile-stale .tile-icon { color: var(--faint); }
.tile-current .tile-face { fill: color-mix(in srgb, var(--teal) 22%, var(--card-bg)); stroke: var(--teal); stroke-width: 2.4; }
.tile-current .tile-icon { color: var(--teal); }
.tile-current .tile-label { fill: var(--teal); font-weight: 700; font-size: 11px; }
.tile-current .tile-ring { fill: none; stroke: var(--teal); stroke-width: 1.4; opacity: 0.32; }
.tile-locked .tile-face { fill: none; stroke: var(--border); stroke-dasharray: 5 4; }
.tile-detour .tile-face { fill: var(--orange-bg); stroke: var(--orange); stroke-width: 1.8; }
.tile-detour .tile-icon { color: var(--orange); }
.tile-detour .tile-label { fill: var(--orange); }
.detour-arc { fill: none; stroke: var(--orange); stroke-width: 1.8; stroke-dasharray: 6 4; }
.tile-attempts circle { fill: var(--orange); }
.tile-attempts text { font-family: var(--font-mono); font-size: 10px; font-weight: 700; text-anchor: middle; fill: var(--bg); }
.runner-body { fill: var(--teal); }
.runner-tip { fill: var(--teal); }
.runner-label { font-family: var(--font-mono); font-size: 13px; font-weight: 700; text-anchor: middle; fill: var(--bg); }

/* ---- lives ---- */
.deck-lives {
  display: flex; align-items: center; gap: 1.6rem; flex-wrap: wrap;
  padding: 0.35rem 1.2rem 0.9rem; border-bottom: 1px solid var(--border);
}
.life { display: flex; align-items: center; gap: 0.45rem; }
.life-label {
  font-family: var(--font-mono); font-size: 0.63rem; letter-spacing: 0.13em;
  text-transform: uppercase; color: var(--faint);
}
.lives-out .life-label { color: var(--red); }
.pips { display: flex; gap: 3px; }
.pip-full { color: var(--red); }
.pip-spent { color: var(--border); }
.ic { vertical-align: middle; }

/* ---- now ---- */
.deck-now {
  padding: 1.05rem 1.2rem 1.1rem; border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--teal) 10%, transparent), transparent 82%);
}
.now-kicker {
  display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.7rem;
  font-family: var(--font-mono); font-size: 0.63rem; letter-spacing: 0.17em;
  text-transform: uppercase; color: var(--teal); font-weight: 600;
}
.now-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--teal); box-shadow: 0 0 0 4px color-mix(in srgb, var(--teal) 18%, transparent); }
.now-body { display: flex; gap: 1.1rem; align-items: flex-start; flex-wrap: wrap; }
.now-icon {
  width: 62px; height: 62px; border-radius: 18px; flex-shrink: 0;
  background: color-mix(in srgb, var(--teal) 18%, var(--card-bg)); border: 2px solid var(--teal);
  color: var(--teal); display: flex; align-items: center; justify-content: center;
}
.now-main { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.55rem; }
.now-head { display: flex; align-items: baseline; gap: 0.85rem; flex-wrap: wrap; }
.now-what { font-family: var(--font-display); font-size: 1.5rem; font-weight: 640; letter-spacing: -0.02em; margin: 0; line-height: 1.12; }
.now-clock { font-family: var(--font-mono); font-size: 1.05rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.now-plain { margin: 0; font-size: 0.92rem; line-height: 1.55; color: var(--fg); max-width: 66ch; }
.now-quote {
  margin: 0; font-size: 0.83rem; font-style: italic; line-height: 1.5; color: var(--muted);
  border-left: 2px solid var(--teal); padding-left: 0.75rem; max-width: 68ch;
}
.now-meter { display: flex; flex-direction: column; gap: 0.28rem; max-width: 540px; }
.now-bar { position: relative; height: 11px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); overflow: hidden; }
.now-bar span { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px; background: linear-gradient(90deg, var(--teal), var(--orange)); }
.now-bar em { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--fg); opacity: 0.5; }
.now-scale { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.05em; color: var(--faint); }

.chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.chip {
  font-family: var(--font-mono); font-size: 0.7rem; padding: 0.18rem 0.5rem; border-radius: 7px;
  background: var(--surface-2); border: 1px solid var(--border); color: var(--muted);
}
.chip b { color: var(--fg); font-weight: 600; }
.chip-warn { border-color: var(--orange); color: var(--orange); }
.chip-warn b { color: var(--orange); }
.chip-next { border-color: var(--accent); color: var(--accent); }
.chip-next b { color: var(--accent); }
.chip-dim { color: var(--faint); }
.chip-dim-all { color: var(--faint); border-style: dashed; }

/* ---- splits ---- */
.splits-head {
  display: flex; justify-content: space-between; padding: 0.8rem 1.2rem 0.35rem;
  font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--faint);
}
.split {
  display: grid; grid-template-columns: 22px 1fr 80px 78px; gap: 0.7rem; align-items: center;
  padding: 0.35rem 1.2rem; border-top: 1px solid var(--border-soft); font-size: 0.79rem;
}
.split-icon { color: var(--green); display: flex; }
.split-name { font-family: var(--font-mono); font-size: 0.74rem; color: var(--fg); min-width: 0; overflow-wrap: anywhere; }
.split-name small { color: var(--faint); font-size: 0.68rem; margin-left: 0.3rem; }
.split-attempt { color: var(--orange); font-weight: 700; }
.split-time, .split-delta { font-family: var(--font-mono); font-size: 0.74rem; text-align: right; font-variant-numeric: tabular-nums; }
.split-time { color: var(--muted); }
.split-back { background: var(--orange-bg); box-shadow: inset 3px 0 0 var(--orange); }
.split-back .split-icon, .split-back .split-name { color: var(--orange); }
.split-live { background: color-mix(in srgb, var(--teal) 10%, transparent); box-shadow: inset 3px 0 0 var(--teal); }
.split-live .split-icon, .split-live .split-name { color: var(--teal); font-weight: 700; }
.split-live .split-time { color: var(--fg); }

/* ---- outcome ---- */
.deck-outcome {
  padding: 1.5rem 1.2rem 1.35rem; display: flex; flex-direction: column; align-items: center;
  gap: 0.5rem; text-align: center; border-bottom: 1px solid var(--border);
}
.outcome-icon {
  width: 66px; height: 66px; border-radius: 20px; display: flex; align-items: center;
  justify-content: center; border: 2px solid currentColor;
}
.outcome-parked { background: radial-gradient(420px 160px at 50% 0%, color-mix(in srgb, var(--red) 11%, transparent), transparent 72%); }
.outcome-parked .outcome-icon { color: var(--red); background: var(--red-bg); }
.outcome-done { background: radial-gradient(420px 160px at 50% 0%, color-mix(in srgb, var(--green) 11%, transparent), transparent 72%); }
.outcome-done .outcome-icon { color: var(--green); background: var(--green-bg); }
.outcome-title { font-family: var(--font-display); font-size: 1.5rem; font-weight: 720; letter-spacing: 0.015em; margin: 0.2rem 0 0; }
.outcome-parked .outcome-title { color: var(--red); }
.outcome-done .outcome-title { color: var(--green); }
.outcome-why { margin: 0; font-size: 0.95rem; line-height: 1.5; color: var(--fg); max-width: 56ch; }
.outcome-fix { margin: 0.25rem 0 0; font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); }
.outcome-slug { color: var(--faint); }

/* ---- foot / idle ---- */
.deck-foot { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0.8rem 1.2rem; border-top: 1px solid var(--border); background: var(--surface-2); }
.deck-foot-center { justify-content: center; }
.deck-idle .idle-body { padding: 2.6rem 1.2rem 2.2rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; text-align: center; }
.idle-track { width: 240px; height: 56px; opacity: 0.5; margin-bottom: 0.4rem; }
.idle-tile { fill: none; stroke: var(--border); stroke-width: 1.5; stroke-dasharray: 4 3; }
.idle-kicker { margin: 0; font-family: var(--font-mono); font-size: 0.63rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--faint); }
.idle-headline { margin: 0; font-family: var(--font-display); font-size: 1.35rem; font-weight: 660; letter-spacing: -0.018em; }
.idle-body-text { margin: 0; font-size: 0.88rem; line-height: 1.55; color: var(--muted); max-width: 52ch; }

.deck-nav { display: flex; gap: 0.5rem; align-items: center; }
.deck-nav a {
  font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); text-decoration: none;
  border: 1px solid var(--border); border-radius: 7px; padding: 0.24rem 0.6rem; background: var(--card-bg);
}
.deck-nav a:hover { color: var(--fg); border-color: var(--accent); }
.deck-nav a.degraded { color: var(--orange); border-color: var(--orange); }

@media (prefers-reduced-motion: no-preference) {
  .pill-live .pill-dot, .now-dot { animation: deck-pulse 2.1s ease-out infinite; }
  @keyframes deck-pulse {
    0% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
    70% { box-shadow: 0 0 0 7px transparent; opacity: 0.6; }
    100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
  }
}
@media (max-width: 720px) {
  .split { grid-template-columns: 20px 1fr 74px; }
  .split-delta { grid-column: 2 / 4; text-align: left; }
  .timer-big { font-size: 1.8rem; }
}
`;

// ---- 1. services --------------------------------------------------------------------------

const STATUS_WORD = { up: 'UP', ok: 'OK', busy: 'BUSY', warn: 'BACKED UP', stale: 'STALE', down: 'DOWN', unknown: 'UNKNOWN' };

function svcTile({ name, status, cls, big, bigUnit, caption, timestamp }) {
  const pulse = cls === 'tile-green' ? ' pulse' : '';
  const bigHtml = timestamp
    ? `<span class="svc-timestamp">${escapeHtml(timestamp)}</span>`
    : `<span class="svc-big">${escapeHtml(big)}${bigUnit ? `<span class="svc-big-unit">${escapeHtml(bigUnit)}</span>` : ''}</span>`;
  return `<div class="svc-tile ${cls}">
    <span class="svc-name">${escapeHtml(name)}</span>
    <span class="svc-status"><span class="dot${pulse}"></span>${escapeHtml(status)}</span>
    ${bigHtml}
    ${caption ? `<span class="svc-caption">${escapeHtml(caption)}</span>` : ''}
  </div>`;
}

// Only a cooling account is worth an at-a-glance banner -- a PARKED count would just repeat the
// Kanban board, and everything else that could be "wrong" already has its own status color in
// the tiles below it, so surfacing it twice here would just be noise.
function renderAlertBanner(accounts) {
  const cooling = ((accounts && accounts.rows) || []).filter((a) => a.cooling);
  if (cooling.length === 0) return '';
  return `<div class="alert-banner"><span class="dot"></span>${escapeHtml(cooling.length)} account${cooling.length > 1 ? 's' : ''} cooling down</div>`;
}

// Production version, folded into a services tile rather than its own section further down the
// page -- the tile format only has room for a status word, one headline value and a short
// caption, so drift/latency detail that used to live in a dedicated card is compressed into the
// caption line.
function renderProdTile(prod) {
  if (!prod) {
    return svcTile({ name: 'Prod', status: 'UNKNOWN', cls: 'tile-gray', big: '—', caption: 'not monitored (static mode)' });
  }
  const site = prod.site || {};
  const deployed = prod.deployed || {};
  const expected = prod.expected || {};
  const statusLabel = site.status === 'up' ? 'UP' : site.status === 'down' ? 'DOWN' : 'UNKNOWN';
  const version = deployed.exposed && deployed.version ? deployed.version : expected.version ? `~${expected.version}` : '—';
  let caption;
  if (prod.drift === 'diverged') caption = 'diverged from expected';
  else if (deployed.exposed) caption = typeof site.latencyMs === 'number' ? `${site.latencyMs} ms` : 'deployed version';
  else caption = expected.version ? 'expected (not exposed)' : 'no data yet';
  return svcTile({ name: 'Prod', status: statusLabel, cls: tileClass(site.status), big: version, caption });
}

function renderServicesInner(services, accounts, prod) {
  const s = services || {};
  const daemon = s.daemon || {};
  const queue = s.queue || {};
  const bench = s.benchWorker || {};
  const nightly = s.nightly || {};
  const verdicts = s.verdicts || {};
  const workers = s.workers || {};
  const retry = s.retryChannel || {};

  // action 5.5, item B audit: `nightly.status`/`verdicts.status` (console/collect.js's
  // collectServices) already compute a 'stale' value on a 36h clock (STALE_BENCH_AGE_MS there) --
  // BUT this function used to re-derive its own status label from `nightly.verdict`/
  // `verdicts.status === 'pass'/'fail'` alone, which never checked age at all, so a nightly run
  // (or a verdict) from days ago rendered as a confident GREEN/STABLE with only its raw timestamp
  // (visible, but not called out) as the one clue it was old. Fixed by branching on the
  // ALREADY-COMPUTED status (which folds staleness in), 'stale' first, instead of re-deriving a
  // narrower pass/fail-only label here that has no room for it.
  const NIGHTLY_WORD = { pass: 'GREEN', fail: 'RED', stale: 'STALE', unknown: 'UNKNOWN' };
  const nightlyStatus = NIGHTLY_WORD[nightly.status] || 'UNKNOWN';
  const nightlyCls = tileClass(nightly.status);
  const nightlyCaption = nightly.finishedAt
    ? `verdict ${nightly.verdict || '?'}, ${fmtAgeMs(nightly.ageMs)} ago${nightly.status === 'stale' ? ' — STALE (>36h)' : ''}`
    : 'no data yet';
  const passRate = verdicts.recentTotal ? Math.round((verdicts.recentPass / verdicts.recentTotal) * 100) : null;
  const VERDICTS_WORD = { pass: 'STABLE', fail: 'UNSTABLE', stale: 'STALE', unknown: 'UNKNOWN' };
  const verdictsStatus = VERDICTS_WORD[verdicts.status] || 'UNKNOWN';
  const verdictsCaption = verdicts.recentTotal
    ? `${verdicts.recentPass}/${verdicts.recentTotal} PASS${verdicts.status === 'stale' ? ` — STALE, last ${fmtAgeMs(verdicts.ageMs)} ago` : ''}`
    : 'no data';

  // Project-2 card #476: the maintainer's retry/abandon channel had NO dashboard surface at all
  // -- not a tile, not a reader, nothing -- while it was dead for 33 hours. Four words, and the
  // two non-green ones carry the card's whole point (console/collect.js's applyRetryChannelStats
  // owns which is which): IDLE means nothing is parked, so the scan did not run and has nothing
  // to be healthy about; UNPROVEN means cards ARE parked and not one has a recorded scan outcome,
  // which is exactly what a dead scanner looks like and must not render as a reassuring green.
  const RETRY_WORD = { ok: 'ALIVE', fail: 'FAILING', idle: 'IDLE', unknown: 'UNPROVEN' };
  const retryStatus = RETRY_WORD[retry.status] || 'UNPROVEN';
  const retryBig =
    retry.status === 'fail' ? fmtInt(retry.failingCards)
      : retry.status === 'ok' ? fmtInt(retry.healthyCards)
        : '—';
  const retryCaption =
    retry.status === 'idle' ? 'nothing parked — nothing to scan'
      : retry.status === 'fail'
        ? `of ${retry.parkedCards} parked failing — worst streak ${retry.worstFailures}, last ${fmtAgeMs(retry.lastFailedAgeMs)} ago`
        : retry.status === 'ok'
          ? `of ${retry.parkedCards} parked confirmed reaching GitHub${retry.unprovenCards ? `, ${retry.unprovenCards} unproven` : ''}`
          : `${retry.parkedCards} parked, no scan outcome recorded yet`;

  const tiles = [
    svcTile({
      name: 'Daemon',
      status: STATUS_WORD[daemon.status] || 'UNKNOWN',
      cls: tileClass(daemon.status),
      big: fmtAgeMs(daemon.uptimeMs),
      caption: 'uptime',
    }),
    svcTile({
      name: 'Queue',
      status: STATUS_WORD[queue.status] || 'OK',
      cls: tileClass(queue.status),
      big: fmtInt(queue.depth),
      caption: 'tasks queued',
    }),
    // action 6.7: C6's dispatcher.js live-worker count -- an AGGREGATE only (see this module's
    // own header, "per-task detail duplicates the GitHub Projects board", for why there is no
    // per-task worker list here the way bin/spo's `spo status` has one). `count` is a SUBSET of
    // the daemon tile's own in-flight picture, not a second total -- see
    // orchestrator/worker-status.js's header for the double-count hazard this avoids. `present:
    // false` (no live-workers.json at all -- no dispatcher has ever published here, or none is
    // running) renders UNKNOWN, never a reassuring "0" that would be indistinguishable from a
    // dispatcher that is up and genuinely idle.
    svcTile({
      name: 'Workers',
      status: STATUS_WORD[workers.status] || 'UNKNOWN',
      cls: tileClass(workers.status),
      big: workers.present ? fmtInt(workers.count) : '—',
      caption: workers.present
        ? `live${workers.staleCount ? `, ${workers.staleCount} stale` : ''}${workers.trailingCount ? `, ${workers.trailingCount} exiting` : ''} — published ${fmtAgeMs(workers.ageMs)} ago`
        : 'no live-workers.json published',
    }),
    svcTile({
      name: 'Retry channel',
      status: retryStatus,
      cls: tileClass(retry.status),
      big: retryBig,
      caption: retryCaption,
    }),
    svcTile({
      name: 'Bench worker',
      status: STATUS_WORD[bench.status] || 'UNKNOWN',
      cls: tileClass(bench.status),
      big: fmtAgeMs(bench.heartbeatAgeMs),
      caption: 'since last heartbeat',
    }),
    svcTile({
      name: 'Nightly',
      status: nightlyStatus,
      cls: nightlyCls,
      timestamp: fmtDateTime(nightly.finishedAt),
      caption: nightlyCaption,
    }),
    svcTile({
      name: 'Verdicts',
      status: verdictsStatus,
      cls: tileClass(verdicts.status),
      big: passRate !== null ? String(passRate) : '—',
      bigUnit: passRate !== null ? '%' : '',
      caption: verdictsCaption,
    }),
    renderProdTile(prod),
  ].join('');

  return `${renderAlertBanner(accounts)}<h2>Services status</h2><div class="svc-tiles">${tiles}</div>`;
}

// ---- 2. system (live CPU/memory) ----------------------------------------------------------

// Renders a tiny inline SVG trend line from a rolling window of 0-100 values (console/system.js's
// history.cpu/history.mem) -- a plain <polyline>, not a smooth curve, to keep this a pure string
// template with no charting math beyond a linear x/y mapping.
// opts.auto: scale to the series' own min/max instead of the default 0-100 clamp (CPU/memory
// history, this function's original callers, are already 0-100 percentages and keep passing
// nothing). The tokens trend's avgWeightPerSession series has no natural upper bound, so it
// needs auto-scaling to show a step-change at all -- clamped to 0-100 it would render as a flat
// line pinned to the top.
function renderSparkline(values, extraClass, opts = {}) {
  const vals = (values || []).filter((v) => typeof v === 'number');
  if (vals.length < 2) return '<p class="empty">(not enough history yet)</p>';
  const w = 300;
  const h = 34;
  const step = w / (vals.length - 1);
  let lo = 0;
  let hi = 100;
  if (opts.auto) {
    lo = Math.min(...vals);
    hi = Math.max(...vals);
    if (hi === lo) hi = lo + 1; // flat series -- avoid a divide-by-zero
  }
  const points = vals
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * h).toFixed(1)}`)
    .join(' ');
  return `<svg class="spark${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline class="area" points="0,${h} ${points} ${w},${h}"></polyline>
    <polyline class="line" points="${points}"></polyline>
  </svg>`;
}

function renderSystemInner(system) {
  if (!system) {
    return `<h2>CPU / Memory</h2><p class="empty">not monitored (static mode &mdash; restart with <code>spo dashboard --serve</code>)</p>`;
  }
  const cpu = system.cpu || {};
  const mem = system.memory || {};
  const hist = system.history || {};
  const cores = (cpu.cores || [])
    .map((c) => {
      const pct = typeof c.busyPct === 'number' ? c.busyPct : 0;
      const label = typeof c.busyPct === 'number' ? `${c.busyPct}%` : '—';
      return `<div class="bar-row"><span>core ${escapeHtml(c.i)}</span><span class="bar"><span style="width:${pct}%"></span></span><span>${label}</span></div>`;
    })
    .join('');

  const memPct = typeof mem.usedPct === 'number' ? mem.usedPct : 0;
  const memClass = memPct >= 90 ? 'gauge-crit' : memPct >= 75 ? 'gauge-warn' : '';
  const memGb = (n) => (typeof n === 'number' ? (n / 1024 / 1024 / 1024).toFixed(1) : '—');

  return `<h2>CPU / Memory</h2>
    <div class="grid-2">
      <div class="card">
        <p class="meta" style="margin:0 0 0.6rem">${escapeHtml(cpu.count)} cores${cpu.model ? ' · ' + escapeHtml(cpu.model) : ''} &middot; load average ${(system.loadavg || []).map((n) => n.toFixed(2)).join(' / ')}</p>
        ${cores}
        <p class="meta" style="margin-top:0.7rem">memory: ${memGb(mem.usedBytes)} / ${memGb(mem.totalBytes)} GB (${escapeHtml(mem.usedPct)}%)</p>
        <div class="gauge ${memClass}"><span style="width:${memPct}%"></span></div>
      </div>
      <div class="card">
        <p class="meta" style="margin:0 0 0.3rem">overall CPU trend (~5 min)</p>
        ${renderSparkline(hist.cpu)}
        <p class="meta" style="margin:0.9rem 0 0.3rem">memory trend (~5 min)</p>
        ${renderSparkline(hist.mem, 'spark-teal')}
      </div>
    </div>`;
}

function renderSystemFragment(system) {
  return renderSystemInner(system);
}

// ---- 3. Claude accounts ----------------------------------------------------------------------

// Per-account token detail lives in the Tokens section's "by account" table (renderTokensBreakdownInner)
// -- NOT duplicated here as a nested subtable, to avoid showing the same numbers twice.
function renderAccountsInner(accounts, tokens) {
  const rows = (accounts && accounts.rows) || [];
  if (rows.length === 0) {
    return `<h2>Claude accounts</h2><p class="empty">(no account registered in the pool &mdash; see doc/setup.md § Accounts)</p>`;
  }
  const anyLabeled = rows.some((a) => a.email || a.plan);
  const body = rows
    .map(
      (a) => `<tr class="${a.cooling ? 'cooling' : ''}">
      <td>${escapeHtml(a.name)}</td>
      <td>${a.email ? escapeHtml(a.email) : '—'}</td>
      <td>${a.plan ? escapeHtml(a.plan) : '—'}</td>
      <td>${a.enabled ? 'yes' : 'no'}</td>
      <td>${a.cooldownUntil ? escapeHtml(a.cooldownUntil) : '—'}</td>
      <td>${a.hasToken ? 'yes' : 'no'}</td>
      <td>${a.hasCredentials ? 'yes' : 'no'}</td>
    </tr>`
    )
    .join('');
  const tokensNote = tokens
    ? '<p class="subgrid-note">per-account token detail is available in the "Tokens" section below</p>'
    : '<p class="meta">tokens not measured (static mode)</p>';
  const labelNote = anyLabeled
    ? ''
    : `<p class="subgrid-note">email / plan can't be read from the account pool &mdash; Claude Code stores no such
      info there, only a hashed user id. To show them, add <code>&lt;pool dir&gt;/labels.json</code>, e.g.
      <code>{"pool1": {"email": "you@example.com", "plan": "Max 20x"}}</code> (see orchestrator/accounts.js
      readLabels).</p>`;
  return `<h2>Claude accounts</h2>
    <div class="card">
      <table>
        <thead><tr><th>name</th><th>email</th><th>plan</th><th>enabled</th><th>cooling until</th><th>token</th><th>credentials</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${tokensNote}
      ${labelNote}
    </div>`;
}

// ---- 4. daemon stats -------------------------------------------------------------------------

function kpi(label, value, sub, accent) {
  return `<div class="kpi${accent ? ' accent' : ''}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}${sub ? ` &middot; ${sub}` : ''}</span></div>`;
}

// action 4.5: `abandoned` only prints when non-zero (`abandonedSuffix`, applied at all three
// grain levels) -- every existing daemonStats fixture and every day before this action shipped
// has `abandoned: 0` (or the field missing entirely, `d.abandoned` then reading undefined and
// falling back to 0 via `|| 0`), and appending "/ 0 abandoned" to every KPI line forever would be
// noise for a pipeline that has never actually abandoned anything. Once it does, the count is
// rendered explicitly rather than silently folded into `parked` or dropped -- see
// console/collect.js's own header on why abandoned is its own bucket, never absorbed into parked.
function abandonedSuffix(n) {
  return n ? ` / ${escapeHtml(n)} abandoned` : '';
}

function renderDaemonStatsInner(daemonStats) {
  const d = daemonStats || {};
  const week = d.week || {};
  const today = d.today || {};
  return `<h2>Daemon stats</h2>
    <div class="kpi-grid">
      ${kpi('processed total', fmtInt(d.total), `${escapeHtml(d.done)} done / ${escapeHtml(d.parked)} parked${abandonedSuffix(d.abandoned)}${d.parkingRatePct !== null && d.parkingRatePct !== undefined ? ` · ${escapeHtml(d.parkingRatePct)}% parked` : ''}`, true)}
      ${kpi('this week (Mon→today)', fmtInt(week.total), `${escapeHtml(week.done)} done / ${escapeHtml(week.parked)} parked${abandonedSuffix(week.abandoned)}`)}
      ${kpi('today', fmtInt(today.total), `${escapeHtml(today.done)} done / ${escapeHtml(today.parked)} parked${abandonedSuffix(today.abandoned)}`)}
      ${kpi('active + imported', fmtInt(d.inFlight), `${escapeHtml(d.active)} active · ${escapeHtml(d.imported)} imported`)}
    </div>`;
}

// ---- 5. bug reports -------------------------------------------------------------------------

function renderReportsInner(reports) {
  const r = reports || {};
  const cycle = r.lastIntakeCycle;
  const w = r.last24h || {};
  const pull = r.pull || {};

  const cycleLine = cycle
    ? `<p class="meta">last intake cycle (${escapeHtml(cycle.ts || '?')}): ${escapeHtml(cycle.processed)} processed, ${escapeHtml(cycle.filed)} filed, ${escapeHtml(cycle.duplicates)} duplicates${cycle.errors ? `, <strong>${escapeHtml(cycle.errors)} errors</strong>` : ''}</p>`
    : `<p class="empty">(no intake cycle recorded)</p>`;

  const pullLine = pull.configured
    ? `<p class="meta">remote pull: last pull ${escapeHtml(pull.lastPulledAt || '?')} &middot; 24h: ${escapeHtml(pull.pulled24h)} pulled / ${escapeHtml(pull.acked24h)} acked${pull.ackFailed24h ? ` / <strong>${escapeHtml(pull.ackFailed24h)} ack failures</strong>` : ''}${pull.rejected24h ? ` / ${escapeHtml(pull.rejected24h)} rejected${pull.lastRejectReason ? ` (${escapeHtml(pull.lastRejectReason)})` : ''}` : ''}</p>`
    : `<p class="empty">remote pull not configured</p>`;

  return `<h2>Bug reports</h2>
    <div class="kpi-grid">
      ${kpi('queued for intake', fmtInt(r.queuedIntake))}
      ${kpi('pending confirmation', fmtInt(r.pendingConfirm))}
      ${kpi('confirmed, untriaged', fmtInt(r.confirmedAwaitingTriage))}
    </div>
    <div class="card">
      ${cycleLine}
      <p class="meta">24h: ${escapeHtml(w.triagedFiled || 0)} filed &middot; ${escapeHtml(w.held || 0)} held &middot; ${escapeHtml(w.triagedDuplicate || 0)} duplicates &middot; ${escapeHtml(w.discarded || 0)} discarded</p>
      ${pullLine}
    </div>`;
}

// ---- 6. tokens / usage trend -----------------------------------------------------------------

// Renders a percentage delta with a color only when it crosses a threshold worth flagging --
// deliberately fixed, legible thresholds (not a fitted statistical model): a solo operator
// eyeballing a dashboard needs a number they can sanity-check by reading it, not a black box.
// `warnAt` colors an increase past it red (consumption got worse); the mirrored negative
// (a comparably large DECREASE) colors green -- a real efficiency win is exactly as worth
// noticing as a regression.
function deltaSpan(pct, { warnAt }) {
  if (pct === null || pct === undefined) return 'not enough sessions to compare';
  const sign = pct > 0 ? '+' : '';
  const text = `${sign}${pct}% vs prior`;
  if (pct >= warnAt) return `<span class="trend-warn">${escapeHtml(text)}</span>`;
  if (pct <= -warnAt) return `<span class="trend-good">${escapeHtml(text)}</span>`;
  return escapeHtml(text);
}

// The primary tokens view: an operating-cost trend meant to answer "did something I changed
// make this worse (or better)" at a glance -- see console/usage-scan.js's buildTrendViews for
// the WEIGHT-based averaging and the cache-write-ratio change signal this renders.
function renderTokensTrendInner(trend) {
  const k = trend.kpis || {};
  const series = trend.series || [];
  const last14 = series.slice(-14);
  const maxBar = Math.max(1, ...last14.map((d) => d.avgWeightPerSession));

  const barRows = last14
    .map((d) => {
      const pct = maxBar ? Math.round((d.avgWeightPerSession / maxBar) * 100) : 0;
      const flag = d.cacheChangeFlag
        ? ` <span title="cache-write ratio spike on this day -- a likely sign a prompt or config changed">&#9888;</span>`
        : '';
      const label = escapeHtml(d.date.slice(5)) + (d.partial ? '*' : ''); // MM-DD; * = still accumulating
      return `<div class="bar-row"><span>${label}</span><span class="bar"><span style="width:${pct}%"></span></span><span>${fmtTokens(null, d.avgWeightPerSession)}${flag}</span></div>`;
    })
    .join('');

  // action 5.5, item B audit of journal/usage-rollups.json: `trend.stale` (usage-scan.js's
  // buildTrendViews, action 5.5) is true when the last recorded rollup day isn't literally
  // today -- meaning the "today (partial)" KPI just below is actually showing a PREVIOUS day's
  // numbers under that label. Called out here rather than silently trusting the KPI title.
  const staleLine = trend.stale
    ? `<p class="meta"><span class="trend-warn">STALE &mdash; no rollup recorded for today yet (last recorded day:
        ${escapeHtml(trend.lastRecordedDate || '?')}, ${escapeHtml(trend.staleDays)} day${trend.staleDays === 1 ? '' : 's'}
        behind) &mdash; is <code>spo dashboard --serve</code> running?</span></p>`
    : `<p class="meta">recorded through <strong>${escapeHtml(trend.lastRecordedDate || '?')}</strong></p>`;

  return `<h2>Tokens</h2>
    <div class="section-head"><span class="meta">operating-cost trend, weighted per session (excludes the "local"
      account) &mdash; &#9888; marks a day where the cache-write ratio spiked, a likely sign a prompt or config
      changed that day</span></div>
    ${staleLine}
    <div class="kpi-grid">
      ${kpi('today (partial)', fmtTokens(null, k.todayAvgWeightPerSession), deltaSpan(k.todayVsLast7Pct, { warnAt: 40 }), true)}
      ${kpi('last 7 days', fmtTokens(null, k.last7AvgWeightPerSession), deltaSpan(k.last7VsPrev7Pct, { warnAt: 25 }))}
      ${kpi('last 30 days', fmtTokens(null, k.last30AvgWeightPerSession), 'baseline, no comparison')}
      ${kpi('out per session, today', fmtTokens(null, k.todayAvgMoutPerSession), 'plain token count, not weighted')}
    </div>
    <div class="card">
      <p class="meta" style="margin:0 0 0.3rem">weighted token-equivalent per session, last ${series.length} days
        <span class="subgrid-note" style="display:inline">(rollups are stored rounded to 0.01M, so these read to the nearest 10k)</span></p>
      ${renderSparkline(series.map((d) => d.avgWeightPerSession), '', { auto: true })}
      <p class="meta" style="margin:0.9rem 0 0.3rem">last 14 days</p>
      ${barRows || '<p class="empty">(not enough history yet)</p>'}
    </div>`;
}

function renderTokensBreakdownInner(tokens) {
  const taskRows = (tokens.byTask || [])
    .map(
      (t) => `<tr>
      <td><code>${escapeHtml(t.taskId)}</code></td>
      <td>${escapeHtml(t.state || '?')}</td>
      <td class="num">${escapeHtml(t.msgs)}</td>
      <td class="num">${fmtTokens(t.rawInp, t.Minp)}</td>
      <td class="num">${fmtTokens(t.rawCc, t.Mcc)}</td>
      <td class="num">${fmtTokens(t.rawCr, t.Mcr)}</td>
      <td class="num">${fmtTokens(t.rawOut, t.Mout)}</td>
    </tr>`
    )
    .join('');

  const modelRows = (tokens.byModel || [])
    .map(
      (m) => `<tr>
      <td>${escapeHtml(m.model)}</td>
      <td class="num">${escapeHtml(m.msgs)}</td>
      <td class="num">${fmtTokens(m.rawInp, m.Minp)}</td>
      <td class="num">${fmtTokens(m.rawCc, m.Mcc)}</td>
      <td class="num">${fmtTokens(m.rawCr, m.Mcr)}</td>
      <td class="num">${fmtTokens(m.rawOut, m.Mout)}</td>
    </tr>`
    )
    .join('');

  const acctRows = (tokens.byAccountModel || [])
    .map(
      (r) => `<tr>
      <td>${escapeHtml(r.account)}</td>
      <td>${escapeHtml(r.model)}</td>
      <td class="num">${fmtTokens(r.rawCr, r.Mcr)}</td>
      <td class="num">${fmtTokens(r.rawCc, r.Mcc)}</td>
      <td class="num">${fmtTokens(r.rawOut, r.Mout)}</td>
    </tr>`
    )
    .join('');

  const u = tokens.unattributed || {};
  const hasLocal = (tokens.byAccountModel || []).some((r) => r.account === 'local');
  const localNote = hasLocal
    ? `<p class="subgrid-note">"local" = usage from Claude Code sessions run directly on this machine, outside
      the account pool (e.g. an operator's own ad-hoc <code>claude</code> session) &mdash; not part of the
      pipeline's account rotation.</p>`
    : '';

  return `<details id="det-token-breakdown"><summary>Task / model / account breakdown</summary>
    <div class="grid-2">
      <div class="card">
        <p class="meta" style="margin:0 0 0.3rem">by task (sorted by volume)</p>
        <table>
          <thead><tr><th>task</th><th>state</th><th class="num">msgs</th><th class="num">in</th><th class="num">cache-write</th><th class="num">cache-read</th><th class="num">out</th></tr></thead>
          <tbody>${taskRows || '<tr><td colspan="7" class="empty">(none)</td></tr>'}</tbody>
        </table>
      </div>
      <div class="card">
        <p class="meta" style="margin:0 0 0.3rem">by model</p>
        <table>
          <thead><tr><th>model</th><th class="num">msgs</th><th class="num">in</th><th class="num">cache-write</th><th class="num">cache-read</th><th class="num">out</th></tr></thead>
          <tbody>${modelRows || '<tr><td colspan="6" class="empty">(none)</td></tr>'}</tbody>
        </table>
        <p class="subgrid-note">unattributed (sessions with no known task): ${escapeHtml(u.sessions || 0)} sessions, ${fmtTokens(u.rawOut, u.Mout)} out</p>
      </div>
    </div>
    <div class="card" style="margin-top:0.75rem">
      <p class="meta" style="margin:0 0 0.3rem">by account</p>
      <table>
        <thead><tr><th>account</th><th>model</th><th class="num">cache-read</th><th class="num">cache-write</th><th class="num">out</th></tr></thead>
        <tbody>${acctRows || '<tr><td colspan="5" class="empty">(none)</td></tr>'}</tbody>
      </table>
      ${localNote}
    </div>
  </details>`;
}

// action 5.5, item B: this table renders a MANUALLY-produced, point-in-time snapshot (`node
// scripts/usage-report.js > journal/usage-snapshot.json`) that nothing regenerates on its own --
// measured live 2026-09-01, its `range` read ["2026-08-20","2026-08-29"] while the page header
// above it said `generated` today, with nothing in this table saying the two dates disagree.
// `meta` (console/collect.js's usageSnapshotFreshness) carries the window + age this function
// renders; `meta` itself can be null (no journalRoot to judge against) or have `source:
// 'unknown'` (no range/since/until AND no readable mtime) -- both handled without inventing a
// date, per that function's own header.
function renderTokensSnapshotFallback(usageSnapshot, meta) {
  const byModel = usageSnapshot.byModel_Mtokens || {};
  const modelKeys = Object.keys(byModel);
  const rows = modelKeys.length
    ? modelKeys
        .map((m) => {
          const driver = byModel[m].driver || {};
          return `<tr>
            <td>${escapeHtml(m)}</td>
            <td class="num">${fmtTokens(null, driver.inp)}</td>
            <td class="num">${fmtTokens(null, driver.cc)}</td>
            <td class="num">${fmtTokens(null, driver.cr)}</td>
            <td class="num">${fmtTokens(null, driver.out)}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="empty">(none)</td></tr>`;

  const m = meta || {};
  let windowLine;
  if (m.rangeStart || m.rangeEnd) {
    windowLine = `<p class="meta">covers <strong>${escapeHtml(m.rangeStart || '?')}</strong> to
      <strong>${escapeHtml(m.rangeEnd || '?')}</strong>${m.ageMs !== null && m.ageMs !== undefined ? ` &mdash; ${fmtAgeMs(m.ageMs)} old` : ''}</p>`;
  } else if (m.source === 'mtime') {
    windowLine = `<p class="meta">no date range recorded in the file &mdash; using its write time instead:
      ${fmtAgeMs(m.ageMs)} old</p>`;
  } else {
    windowLine = `<p class="meta">freshness unknown &mdash; no range/since/until recorded and no readable file
      write time</p>`;
  }
  const staleBanner = m.stale
    ? `<p class="meta"><span class="trend-warn">STALE snapshot (&gt; 24h old) &mdash; regenerate with
        <code>node scripts/usage-report.js &gt; journal/usage-snapshot.json</code></span></p>`
    : '';

  return `<details id="det-token-breakdown"><summary>Tokens by model (snapshot)</summary>
    <p class="meta">snapshot (journal/usage-snapshot.json) &mdash; no per-task view outside live mode</p>
    ${windowLine}
    ${staleBanner}
    <table>
      <thead><tr><th>model</th><th class="num">in</th><th class="num">cache-write</th><th class="num">cache-read</th><th class="num">out</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </details>`;
}

// Trend (renderTokensTrendInner) is the primary view -- see console/usage-scan.js's
// buildTrendViews header for why: it's the only part of this section that can answer "did
// something I changed make this worse (or better)", which today/prior static tables cannot.
// byTask/byModel/byAccountModel detail is demoted into a <details>, not deleted -- it still
// answers a real, different question ("what's expensive right now"), just not the drift one.
function renderTokensInner(tokens, usageSnapshot, trend, usageSnapshotMeta) {
  const hasTrend = !!(trend && Array.isArray(trend.series) && trend.series.length > 0);
  const parts = [];

  if (hasTrend) {
    parts.push(renderTokensTrendInner(trend));
  } else {
    parts.push(`<h2>Tokens</h2><p class="empty">(no trend history yet &mdash; <code>spo dashboard --serve</code>
      records a daily rollup every ~5 min once it's running; none found yet)</p>`);
  }

  if (tokens) {
    parts.push(renderTokensBreakdownInner(tokens));
  } else if (usageSnapshot) {
    parts.push(renderTokensSnapshotFallback(usageSnapshot, usageSnapshotMeta));
  } else if (!hasTrend) {
    parts.push(`<p class="empty">in static mode, generate a one-shot snapshot with
      <code>node scripts/usage-report.js &gt; journal/usage-snapshot.json</code></p>`);
  }

  return parts.join('\n');
}

// ---- 7. secondary / collapsible ---------------------------------------------------------------

function renderQueueDetails(queue) {
  const q = queue || { depth: 0, nextIds: [] };
  const next =
    q.nextIds && q.nextIds.length
      ? `<ol>${q.nextIds.map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join('')}</ol>`
      : '<p class="empty">(queue empty)</p>';
  return `<p>depth: <strong>${escapeHtml(q.depth)}</strong></p>${next}`;
}

function renderVerdictsDetails(verdicts) {
  if (!verdicts || verdicts.length === 0) {
    return `<p class="empty">(no local verdict &mdash; ~/.spo-bench/verdicts/)</p>`;
  }
  const rows = verdicts
    .map(
      (v) => `<tr class="${verdictClass(v.verdict)}">
      <td><code>${escapeHtml(shortSha(v.head || v.sha))}</code></td>
      <td>${escapeHtml(v.verdict || '?')}</td>
      <td>${escapeHtml(v.createdAt || v.finishedAt || '')}</td>
      <td>${escapeHtml(v.jobId || '')}</td>
    </tr>`
    )
    .join('');
  return `<table>
    <thead><tr><th>sha</th><th>verdict</th><th>date</th><th>job</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderSecondaryInner(d) {
  return `<details id="det-verdicts"><summary>Recent gate verdicts</summary>${renderVerdictsDetails(d.verdicts)}</details>
    <details id="det-queue"><summary>Queue</summary>${renderQueueDetails(d.queue)}</details>`;
}

// ---- assembly -------------------------------------------------------------------------------

function renderDataFragments(data) {
  const d = data || {};
  return {
    services: renderServicesInner(d.services, d.accounts, d.prod),
    daemon: renderDaemonStatsInner(d.daemonStats),
    reports: renderReportsInner(d.reports),
    accounts: renderAccountsInner(d.accounts, d.tokens),
    tokens: renderTokensInner(d.tokens, d.usageSnapshot, d.trend, d.usageSnapshotMeta),
    secondary: renderSecondaryInner(d),
    // The flight deck rides /api/data too, so a browser sitting on `/` refreshes at the 30s
    // cadence even when the faster /api/live poll is unavailable (static mode, or a client that
    // never started the fast timer). /api/live serves this same string on its own 2s timer.
    live: renderLiveInner(d),
    stamp: escapeHtml(d.generatedAt || ''),
  };
}

// Always included (static AND live mode) -- a manual light/dark override on top of the
// dark-by-default / prefers-color-scheme:light CSS rule above. Remembers the operator's last
// choice in localStorage; with nothing stored, leaves data-theme unset so the pure-CSS default
// (dark unless the OS prefers light) keeps deciding.
const THEME_SCRIPT = `
<script>
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;
  var icon = document.getElementById('theme-icon');
  var label = document.getElementById('theme-label');
  var stored = null;
  try { stored = localStorage.getItem('spo-dashboard-theme'); } catch (e) {}

  function isLight(theme) {
    if (theme === 'light') return true;
    if (theme === 'dark') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }
  function apply(theme) {
    if (theme) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    var light = isLight(theme);
    icon.textContent = light ? '\\u{1F319}' : '\\u{2600}\\u{FE0F}';
    label.textContent = light ? 'dark' : 'light';
  }
  var current = stored;
  apply(current);
  btn.addEventListener('click', function () {
    current = isLight(current) ? 'dark' : 'light';
    apply(current);
    try { localStorage.setItem('spo-dashboard-theme', current); } catch (e) {}
  });
})();
</script>`;

const LIVE_SCRIPT = `
<script>
(function () {
  var fails = 0;
  var sysBusy = false;
  var dataBusy = false;
  var liveBusy = false;
  // The deck only exists on '/', the system tile only on '/health'. Each tick no-ops when its
  // fragment is not on this page, so one script serves both views without branching on the URL.
  var hasDeck = !!document.getElementById('frag-live');

  function markStale(bad) {
    if (bad) { fails++; if (fails >= 3) document.body.dataset.stale = '1'; }
    else { fails = 0; delete document.body.dataset.stale; }
  }

  function tickSystem() {
    if (document.hidden || sysBusy) return;
    sysBusy = true;
    fetch('/api/system', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var el = document.getElementById('frag-system');
        if (el && j && j.html) el.innerHTML = j.html;
        markStale(false);
      })
      .catch(function () { markStale(true); })
      .finally(function () { sysBusy = false; });
  }

  // The flight deck's own poll. Two seconds, because it renders a card that moves -- see
  // serve.js's DEFAULT_DECK_TTL_MS for why that is cheap. Swaps one fragment and nothing else,
  // so it never fights the 30s tickData over the same node.
  function tickLive() {
    if (document.hidden || liveBusy || !hasDeck) return;
    liveBusy = true;
    fetch('/api/live', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.fragments || !j.fragments.live) return;
        var el = document.getElementById('frag-live');
        if (el) el.innerHTML = j.fragments.live;
        var stamp = document.getElementById('frag-stamp');
        if (stamp && j.generatedAt) stamp.textContent = j.generatedAt;
        markStale(false);
      })
      .catch(function () { markStale(true); })
      .finally(function () { liveBusy = false; });
  }

  function tickData() {
    if (document.hidden || dataBusy) return;
    dataBusy = true;
    fetch('/api/data', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.fragments) return;
        var openState = {};
        document.querySelectorAll('details[id]').forEach(function (el) { openState[el.id] = el.open; });
        Object.keys(j.fragments).forEach(function (k) {
          // Skip 'live' when the fast poll owns it: /api/data is 30s behind, and letting it
          // write the deck would make the clock jump backwards twice a minute.
          if (k === 'live' && hasDeck) return;
          var el = document.getElementById('frag-' + k);
          if (el) el.innerHTML = j.fragments[k];
        });
        Object.keys(openState).forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.open = openState[id];
        });
        markStale(false);
      })
      .catch(function () { markStale(true); })
      .finally(function () { dataBusy = false; });
  }

  if (!hasDeck) setInterval(tickSystem, 1000);
  setInterval(tickLive, 2000);
  setInterval(tickData, 30000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { tickSystem(); tickLive(); tickData(); }
  });
  if (!hasDeck) tickSystem();
  tickLive();
  tickData();
})();
</script>`;

// The one exported entry point: given the collected data object, return the full HTML
// document as a string. Deterministic for a given input -- no Date.now(), no fs, no network.
// opts.live: true removes the meta refresh and adds the client polling script (see header).
// The page shell both views share. `title` names the browser tab, `nav` is the link across to
// the other view, `body` the fragments. Extracted when the root page became the flight deck and
// health moved to /health (project-2 card: "the dashboard requires you to know what you're
// looking for") -- both pages carry the same chrome, theme toggle and offline banner, so a
// single shell is the only way they cannot drift apart.
function pageShell({ title, generatedAt, stampNote, nav, body, live }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${live ? '' : '<meta http-equiv="refresh" content="30">'}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="offline-banner" class="banner verdict-unknown">connection to the server lost &mdash; data frozen</div>
<div class="topbar">
  <div class="brand">
    <h1>SPO Pipeline</h1>
    <span class="stamp">generated <span id="frag-stamp">${escapeHtml(generatedAt)}</span> &middot; ${escapeHtml(stampNote)}</span>
  </div>
  <div class="topbar-right">
    <div class="deck-nav">${nav}</div>
    <button class="theme-toggle" id="theme-toggle" type="button">
      <span class="icon" id="theme-icon">&#9728;&#65039;</span>
      <span id="theme-label">light</span>
    </button>
  </div>
</div>
<main>
${body}
</main>
${THEME_SCRIPT}
${live ? LIVE_SCRIPT : ''}
</body>
</html>
`;
}

// healthSummary(d) -> {degraded, text} for the deck's link across to /health. Reads the same
// `services` object the health page renders, so the link can say WHAT is wrong rather than just
// that something is -- an unlabelled warning light sends you to the other page to find out, which
// is exactly the "you have to know what you're looking for" problem this redesign exists to fix.
function healthSummary(d) {
  const s = (d && d.services) || {};
  const bad = [];
  for (const [name, svc] of Object.entries(s)) {
    if (!svc || typeof svc !== 'object') continue;
    if (['down', 'fail', 'stale', 'warn'].includes(svc.status)) bad.push(name);
  }
  const cooling = ((d && d.accounts && d.accounts.rows) || []).filter((a) => a.cooling).length;
  if (cooling) bad.push(`${cooling} account${cooling === 1 ? '' : 's'} cooling`);
  return bad.length
    ? { degraded: true, text: `health: ${bad.slice(0, 3).join(', ')}` }
    : { degraded: false, text: 'health' };
}

// The flight deck -- the root page. One card per running or just-finished run; the standing-by
// panel when there are none. Health is one click away and says what is wrong before you click.
function renderDeckPage(data, opts = {}) {
  const d = data || {};
  const h = healthSummary(d);
  return pageShell({
    title: 'SPO Pipeline — flight deck',
    generatedAt: d.generatedAt || '',
    stampNote: opts.live ? 'live' : 'spo dashboard',
    nav: `<a href="/health" class="${h.degraded ? 'degraded' : ''}">${escapeHtml(h.text)}</a>`,
    body: frag('live', renderLiveInner(d)),
    live: !!opts.live,
  });
}

// The health page -- every section the root page used to carry, MOVED rather than rewritten:
// the same renderXxxInner functions, in the same order, with the same fragment ids, so
// /api/data's payload and every existing test of those functions are unaffected.
function renderHealthPage(data, opts = {}) {
  const d = data || {};
  return pageShell({
    title: 'SPO Pipeline — health',
    generatedAt: d.generatedAt || '',
    stampNote: opts.live ? 'live' : 'spo dashboard',
    nav: '<a href="/">&larr; flight deck</a>',
    body: `${frag('services', renderServicesInner(d.services, d.accounts, d.prod))}
${frag('daemon', renderDaemonStatsInner(d.daemonStats))}
${frag('system', renderSystemInner(d.system))}
${frag('reports', renderReportsInner(d.reports))}
${frag('accounts', renderAccountsInner(d.accounts, d.tokens))}
<hr class="section-divider">
${frag('tokens', renderTokensInner(d.tokens, d.usageSnapshot, d.trend, d.usageSnapshotMeta))}
${frag('secondary', renderSecondaryInner(d))}`,
    live: !!opts.live,
  });
}

// renderDashboard stays the name every existing caller and test uses, and now renders the deck
// -- the root page's new content. `opts.view: 'health'` selects the old page.
function renderDashboard(data, opts = {}) {
  return opts.view === 'health' ? renderHealthPage(data, opts) : renderDeckPage(data, opts);
}

// Re-exported from console/render-deck.js so callers keep one import for "the renderer".
const { renderLiveInner } = require('./render-deck');

module.exports = {
  renderDashboard,
  renderDeckPage,
  renderHealthPage,
  renderLiveInner,
  healthSummary,
  escapeHtml,
  fmtAgeMs,
  fmtTokens,
  renderDataFragments,
  renderSystemFragment,
  renderServicesInner,
  renderSystemInner,
  renderAccountsInner,
  renderDaemonStatsInner,
  renderReportsInner,
  renderTokensInner,
  renderSecondaryInner,
};
