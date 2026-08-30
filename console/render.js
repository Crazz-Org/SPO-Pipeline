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
// accounts, daemon, reports, prod, tokens, secondary, stamp.
//
// Input shape (every field optional -- a missing/empty one renders as an empty section, never
// throws):
//
//   {
//     generatedAt: ISO string,
//     journalTasks: [{ id, title, kind, state, reason, updatedAt, lastEventTs, lastEventName,
//                       llmSteps: [{step, model, account, costUsd, sessionId}], totalCostUsd }],
//     queue: { depth, nextIds: [id, ...] },
//     accounts: { rows: [{ name, enabled, cooldownUntil, cooling, hasToken, hasCredentials }] },
//     nightly: { verdict, sha, jobId, finishedAt, detail } | null,
//     verdicts: [{ file, head, verdict, createdAt, jobId, baseMain }],   // newest-first
//     usageSnapshot: { byModel_Mtokens, byPhase_Mtokens } | null,       // static-mode fallback
//     services: { daemon, queue, benchWorker, nightly, verdicts },       // console/collect.js
//     daemonStats: { total, done, parked, week, today, active, imported, inFlight,
//                     parkingRatePct },
//     reports: { queuedIntake, pendingConfirm, confirmedAwaitingTriage, lastIntakeCycle,
//                 last24h, pull },
//     system: SystemSnapshot | null,        // console/system.js, live server only
//     prod: ProdSnapshot | null,             // console/prod-version.js, live server only
//     tokens: TokenViews | null,             // console/usage-scan.js, live server only
//   }
//
// Section titles are French (the operator is French-speaking, README.md "Language"); data
// values (ids, states, model names, reasons) are rendered as-is. NEVER a dollar figure -- costs
// are rendered nowhere in this file (spo cost / orchestrator/cost.js own that view instead).

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function stateClass(state) {
  if (state === 'DONE') return 'state-done';
  if (state === 'PARKED') return 'state-parked';
  return 'state-active';
}

function verdictClass(v) {
  if (v === 'PASS') return 'verdict-pass';
  if (v === 'FAIL') return 'verdict-fail';
  return 'verdict-unknown';
}

function dotClass(status) {
  if (status === 'up' || status === 'ok' || status === 'pass') return 'dot-green';
  if (status === 'busy' || status === 'stale' || status === 'warn') return 'dot-orange';
  if (status === 'down' || status === 'fail') return 'dot-red';
  return 'dot-gray';
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
  return `${d}j`;
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

.task-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 0.7rem; }
.task-card { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0.75rem; background: var(--card-bg); box-shadow: var(--shadow-sm); }
.task-card > header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; gap: 0.5rem; }
.task-id { font-weight: 700; font-family: var(--font-mono); font-size: 0.85rem; }
.badge {
  display: inline-flex; align-items: center; gap: 0.3rem;
  font-size: 0.72rem; padding: 0.15rem 0.55rem; border-radius: 999px; font-weight: 700;
  letter-spacing: 0.01em; white-space: nowrap;
}
.badge::before { content: ""; width: 0.4rem; height: 0.4rem; border-radius: 999px; background: currentColor; }
.state-done { background: var(--green-bg); color: var(--green); }
.state-parked { background: var(--red-bg); color: var(--red); }
.state-active { background: var(--accent-soft); color: var(--accent); }
.title { margin: 0.25rem 0; font-size: 0.86rem; }
.reason { color: var(--red); margin: 0.2rem 0; font-size: 0.82rem; }
table.llm-steps th, table.llm-steps td { font-size: 0.8rem; }

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
@media (min-width: 640px) { .svc-tiles { grid-template-columns: repeat(5, 1fr); } }
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

.badge-drift { background: var(--orange-bg); color: var(--orange); }
.badge-up { background: var(--green-bg); color: var(--green); }
.badge-down { background: var(--red-bg); color: var(--red); }

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

@media (max-width: 720px) {
  table { display: block; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }
}
`;

// ---- 1. services --------------------------------------------------------------------------

const STATUS_WORD = { up: 'UP', ok: 'OK', busy: 'BUSY', warn: 'CHARGÉE', stale: 'STALE', down: 'DOWN', unknown: 'INCONNU' };

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

// Only a live PARKED task or a cooling account is worth an at-a-glance banner -- everything
// else that could be "wrong" already has its own status color in the tiles below it, so
// surfacing it twice here would just be noise.
function renderAlertBanner(journalTasks, accounts) {
  const parked = (journalTasks || []).filter((t) => t.state === 'PARKED');
  const cooling = ((accounts && accounts.rows) || []).filter((a) => a.cooling);
  if (parked.length === 0 && cooling.length === 0) return '';
  const parts = [];
  if (parked.length) parts.push(`${escapeHtml(parked.length)} tâche${parked.length > 1 ? 's' : ''} PARKED`);
  if (cooling.length) parts.push(`${escapeHtml(cooling.length)} compte${cooling.length > 1 ? 's' : ''} en refroidissement`);
  return `<div class="alert-banner"><span class="dot"></span>${parts.join(' &middot; ')}</div>`;
}

function renderServicesInner(services, journalTasks, accounts) {
  const s = services || {};
  const daemon = s.daemon || {};
  const queue = s.queue || {};
  const bench = s.benchWorker || {};
  const nightly = s.nightly || {};
  const verdicts = s.verdicts || {};

  const nightlyStatus = nightly.verdict === 'PASS' ? 'GREEN' : nightly.verdict === 'FAIL' ? 'RED' : 'INCONNU';
  const nightlyCls = nightlyStatus === 'GREEN' ? 'tile-green' : nightlyStatus === 'RED' ? 'tile-red' : 'tile-gray';
  const passRate = verdicts.recentTotal ? Math.round((verdicts.recentPass / verdicts.recentTotal) * 100) : null;
  const verdictsStatus = verdicts.status === 'pass' ? 'STABLE' : verdicts.status === 'fail' ? 'INSTABLE' : 'INCONNU';

  const tiles = [
    svcTile({
      name: 'Démon',
      status: STATUS_WORD[daemon.status] || 'INCONNU',
      cls: tileClass(daemon.status),
      big: fmtAgeMs(daemon.uptimeMs),
      caption: 'en service',
    }),
    svcTile({
      name: 'File',
      status: STATUS_WORD[queue.status] || 'OK',
      cls: tileClass(queue.status),
      big: fmtInt(queue.depth),
      caption: 'tâches en attente',
    }),
    svcTile({
      name: 'Bench worker',
      status: STATUS_WORD[bench.status] || 'INCONNU',
      cls: tileClass(bench.status),
      big: fmtAgeMs(bench.heartbeatAgeMs),
      caption: 'depuis le dernier battement',
    }),
    svcTile({
      name: 'Nightly',
      status: nightlyStatus,
      cls: nightlyCls,
      timestamp: fmtDateTime(nightly.finishedAt),
    }),
    svcTile({
      name: 'Verdicts',
      status: verdictsStatus,
      cls: tileClass(verdicts.status),
      big: passRate !== null ? String(passRate) : '—',
      bigUnit: passRate !== null ? '%' : '',
      caption: verdicts.recentTotal ? `${verdicts.recentPass}/${verdicts.recentTotal} PASS` : 'aucune donnée',
    }),
  ].join('');

  return `${renderAlertBanner(journalTasks, accounts)}<h2>État des services</h2><div class="svc-tiles">${tiles}</div>`;
}

// ---- 2. system (CPU/mémoire live) ----------------------------------------------------------

// Renders a tiny inline SVG trend line from a rolling window of 0-100 values (console/system.js's
// history.cpu/history.mem) -- a plain <polyline>, not a smooth curve, to keep this a pure string
// template with no charting math beyond a linear x/y mapping.
function renderSparkline(values, extraClass) {
  const vals = (values || []).filter((v) => typeof v === 'number');
  if (vals.length < 2) return '<p class="empty">(historique insuffisant)</p>';
  const w = 300;
  const h = 34;
  const step = w / (vals.length - 1);
  const points = vals
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.max(0, Math.min(100, v)) / 100) * h).toFixed(1)}`)
    .join(' ');
  return `<svg class="spark${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline class="area" points="0,${h} ${points} ${w},${h}"></polyline>
    <polyline class="line" points="${points}"></polyline>
  </svg>`;
}

function renderSystemInner(system) {
  if (!system) {
    return `<h2>CPU / Mémoire</h2><p class="empty">non surveillé (instantané &mdash; relancer avec <code>spo dashboard --serve</code>)</p>`;
  }
  const cpu = system.cpu || {};
  const mem = system.memory || {};
  const hist = system.history || {};
  const cores = (cpu.cores || [])
    .map((c) => {
      const pct = typeof c.busyPct === 'number' ? c.busyPct : 0;
      const label = typeof c.busyPct === 'number' ? `${c.busyPct}%` : '—';
      return `<div class="bar-row"><span>cœur ${escapeHtml(c.i)}</span><span class="bar"><span style="width:${pct}%"></span></span><span>${label}</span></div>`;
    })
    .join('');

  const memPct = typeof mem.usedPct === 'number' ? mem.usedPct : 0;
  const memClass = memPct >= 90 ? 'gauge-crit' : memPct >= 75 ? 'gauge-warn' : '';
  const memGb = (n) => (typeof n === 'number' ? (n / 1024 / 1024 / 1024).toFixed(1) : '—');

  return `<h2>CPU / Mémoire</h2>
    <div class="grid-2">
      <div class="card">
        <p class="meta" style="margin:0 0 0.6rem">${escapeHtml(cpu.count)} cœurs${cpu.model ? ' · ' + escapeHtml(cpu.model) : ''} &middot; charge moyenne ${(system.loadavg || []).map((n) => n.toFixed(2)).join(' / ')}</p>
        ${cores}
        <p class="meta" style="margin-top:0.7rem">mémoire : ${memGb(mem.usedBytes)} / ${memGb(mem.totalBytes)} Go (${escapeHtml(mem.usedPct)}%)</p>
        <div class="gauge ${memClass}"><span style="width:${memPct}%"></span></div>
      </div>
      <div class="card">
        <p class="meta" style="margin:0 0 0.3rem">tendance CPU globale (~5 min)</p>
        ${renderSparkline(hist.cpu)}
        <p class="meta" style="margin:0.9rem 0 0.3rem">tendance mémoire (~5 min)</p>
        ${renderSparkline(hist.mem, 'spark-teal')}
      </div>
    </div>`;
}

function renderSystemFragment(system) {
  return renderSystemInner(system);
}

// ---- 3. comptes Claude ----------------------------------------------------------------------

function accountTokenRows(accountName, tokens) {
  if (!tokens || !tokens.byAccountModel) return '';
  const rows = tokens.byAccountModel.filter((r) => r.account === accountName);
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (r) => `<tr>
      <td>${escapeHtml(r.model)}</td>
      <td class="num">${fmtNum(r.Mcr)}</td>
      <td class="num">${fmtNum(r.Mcc)}</td>
      <td class="num">${fmtNum(r.Mout)}</td>
    </tr>`
    )
    .join('');
  return `<table>
    <thead><tr><th>modèle</th><th class="num">Mtok cache-read</th><th class="num">Mtok cache-write</th><th class="num">Mtok sortie</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderAccountsInner(accounts, tokens) {
  const rows = (accounts && accounts.rows) || [];
  if (rows.length === 0) {
    return `<h2>Comptes Claude</h2><p class="empty">(aucun compte enregistré dans le pool &mdash; voir doc/setup.md § Accounts)</p>`;
  }
  const body = rows
    .map(
      (a) => `<tr class="${a.cooling ? 'cooling' : ''}">
      <td>${escapeHtml(a.name)}</td>
      <td>${a.enabled ? 'oui' : 'non'}</td>
      <td>${a.cooldownUntil ? escapeHtml(a.cooldownUntil) : '—'}</td>
      <td>${a.hasToken ? 'oui' : 'non'}</td>
      <td>${a.hasCredentials ? 'oui' : 'non'}</td>
    </tr>${accountTokenRows(a.name, tokens) ? `<tr><td colspan="5">${accountTokenRows(a.name, tokens)}</td></tr>` : ''}`
    )
    .join('');
  const tokensNote = tokens ? '' : '<p class="meta">tokens non mesurés (mode instantané)</p>';
  return `<h2>Comptes Claude</h2>
    <table>
      <thead><tr><th>nom</th><th>activé</th><th>refroidissement jusqu'à</th><th>jeton</th><th>identifiants</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${tokensNote}`;
}

// ---- 4. stats démon -------------------------------------------------------------------------

function kpi(label, value, sub, accent) {
  return `<div class="kpi${accent ? ' accent' : ''}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}${sub ? ` &middot; ${sub}` : ''}</span></div>`;
}

function renderDaemonStatsInner(daemonStats) {
  const d = daemonStats || {};
  const week = d.week || {};
  const today = d.today || {};
  return `<h2>Stats du démon</h2>
    <div class="kpi-grid">
      ${kpi('traité au total', fmtInt(d.total), `${escapeHtml(d.done)} done / ${escapeHtml(d.parked)} parked${d.parkingRatePct !== null && d.parkingRatePct !== undefined ? ` · ${escapeHtml(d.parkingRatePct)}% parking` : ''}`, true)}
      ${kpi('cette semaine (lun→ven)', fmtInt(week.total), `${escapeHtml(week.done)} done / ${escapeHtml(week.parked)} parked`)}
      ${kpi("aujourd'hui", fmtInt(today.total), `${escapeHtml(today.done)} done / ${escapeHtml(today.parked)} parked`)}
      ${kpi('en cours + importées', fmtInt(d.inFlight), `${escapeHtml(d.active)} en cours · ${escapeHtml(d.imported)} importées`)}
    </div>`;
}

// ---- 5. bug reports -------------------------------------------------------------------------

function renderReportsInner(reports) {
  const r = reports || {};
  const cycle = r.lastIntakeCycle;
  const w = r.last24h || {};
  const pull = r.pull || {};

  const cycleLine = cycle
    ? `<p class="meta">dernier cycle d'intake (${escapeHtml(cycle.ts || '?')}) : ${escapeHtml(cycle.processed)} traités, ${escapeHtml(cycle.filed)} filés, ${escapeHtml(cycle.duplicates)} doublons${cycle.errors ? `, <strong>${escapeHtml(cycle.errors)} erreurs</strong>` : ''}</p>`
    : `<p class="empty">(aucun cycle d'intake enregistré)</p>`;

  const pullLine = pull.configured
    ? `<p class="meta">pull distant : dernier pull ${escapeHtml(pull.lastPulledAt || '?')} &middot; 24h : ${escapeHtml(pull.pulled24h)} récupérés / ${escapeHtml(pull.acked24h)} accusés${pull.ackFailed24h ? ` / <strong>${escapeHtml(pull.ackFailed24h)} échecs d'accusé</strong>` : ''}${pull.rejected24h ? ` / ${escapeHtml(pull.rejected24h)} rejetés${pull.lastRejectReason ? ` (${escapeHtml(pull.lastRejectReason)})` : ''}` : ''}</p>`
    : `<p class="empty">pull distant non configuré</p>`;

  return `<h2>Bug reports</h2>
    <div class="kpi-grid">
      ${kpi("en attente d'intake", fmtInt(r.queuedIntake))}
      ${kpi('en attente de confirmation', fmtInt(r.pendingConfirm))}
      ${kpi('confirmés non triés', fmtInt(r.confirmedAwaitingTriage))}
    </div>
    ${cycleLine}
    <p class="meta">24 h : ${escapeHtml(w.triagedFiled || 0)} filés &middot; ${escapeHtml(w.held || 0)} tenus &middot; ${escapeHtml(w.triagedDuplicate || 0)} doublons &middot; ${escapeHtml(w.discarded || 0)} rejetés</p>
    ${pullLine}`;
}

// ---- 6. version production ------------------------------------------------------------------

function renderProdInner(prod) {
  if (!prod) {
    return `<h2>Version production</h2><p class="empty">non surveillée (mode instantané)</p>`;
  }
  const site = prod.site || {};
  const deployed = prod.deployed || {};
  const expected = prod.expected || {};
  const statusLabel = site.status === 'up' ? 'UP' : site.status === 'down' ? 'DOWN' : 'INCONNU';
  const driftBadge = prod.drift === 'diverged' ? '<span class="badge badge-drift">écart</span>' : '';

  return `<h2>Version production</h2>
    <p><span class="dot ${dotClass(site.status)}"></span><strong>${escapeHtml(statusLabel)}</strong>${site.latencyMs !== null ? ` &middot; ${escapeHtml(site.latencyMs)} ms` : ''} ${driftBadge}</p>
    <p class="meta">version attendue (dernière release) : ${expected.version ? `<code>v${escapeHtml(expected.version)}</code>` : '—'}</p>
    <p class="meta">version déployée : ${deployed.exposed ? `<code>${escapeHtml(deployed.version)}</code>` : 'non exposée'}</p>
    <p class="meta">dernier contrôle : ${escapeHtml(prod.checkedAt || '—')}</p>`;
}

// ---- 7. tokens par tâche/modèle ---------------------------------------------------------------

function renderTokensLive(tokens) {
  const taskRows = (tokens.byTask || [])
    .map(
      (t) => `<tr>
      <td><code>${escapeHtml(t.taskId)}</code></td>
      <td>${escapeHtml(t.state || '?')}</td>
      <td class="num">${escapeHtml(t.msgs)}</td>
      <td class="num">${fmtNum(t.Minp)}</td>
      <td class="num">${fmtNum(t.Mcc)}</td>
      <td class="num">${fmtNum(t.Mcr)}</td>
      <td class="num">${fmtNum(t.Mout)}</td>
    </tr>`
    )
    .join('');

  const modelRows = (tokens.byModel || [])
    .map(
      (m) => `<tr>
      <td>${escapeHtml(m.model)}</td>
      <td class="num">${escapeHtml(m.msgs)}</td>
      <td class="num">${fmtNum(m.Minp)}</td>
      <td class="num">${fmtNum(m.Mcc)}</td>
      <td class="num">${fmtNum(m.Mcr)}</td>
      <td class="num">${fmtNum(m.Mout)}</td>
    </tr>`
    )
    .join('');

  const u = tokens.unattributed || {};

  return `<h2>Tokens par tâche</h2>
    <table>
      <thead><tr><th>tâche</th><th>état</th><th class="num">msgs</th><th class="num">Mtok in</th><th class="num">Mtok cache-write</th><th class="num">Mtok cache-read</th><th class="num">Mtok sortie</th></tr></thead>
      <tbody>${taskRows || '<tr><td colspan="7" class="empty">(aucune)</td></tr>'}</tbody>
    </table>
    <p class="meta">non attribué (sessions sans tâche connue) : ${escapeHtml(u.sessions || 0)} sessions, ${fmtNum(u.Mout)} Mtok sortie</p>
    <h2>Tokens par modèle</h2>
    <table>
      <thead><tr><th>modèle</th><th class="num">msgs</th><th class="num">Mtok in</th><th class="num">Mtok cache-write</th><th class="num">Mtok cache-read</th><th class="num">Mtok sortie</th></tr></thead>
      <tbody>${modelRows || '<tr><td colspan="6" class="empty">(aucun)</td></tr>'}</tbody>
    </table>`;
}

function renderTokensSnapshotFallback(usageSnapshot) {
  const byModel = usageSnapshot.byModel_Mtokens || {};
  const modelKeys = Object.keys(byModel);
  const rows = modelKeys.length
    ? modelKeys
        .map((m) => {
          const driver = byModel[m].driver || {};
          return `<tr>
            <td>${escapeHtml(m)}</td>
            <td class="num">${fmtNum(driver.inp)}</td>
            <td class="num">${fmtNum(driver.cc)}</td>
            <td class="num">${fmtNum(driver.cr)}</td>
            <td class="num">${fmtNum(driver.out)}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="empty">(aucun)</td></tr>`;

  return `<h2>Tokens par modèle</h2>
    <p class="meta">instantané (journal/usage-snapshot.json) &mdash; pas de vue par tâche hors mode live</p>
    <table>
      <thead><tr><th>modèle</th><th class="num">Mtok in</th><th class="num">Mtok cache-write</th><th class="num">Mtok cache-read</th><th class="num">Mtok sortie</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTokensInner(tokens, usageSnapshot) {
  if (tokens) return renderTokensLive(tokens);
  if (usageSnapshot) return renderTokensSnapshotFallback(usageSnapshot);
  return `<h2>Tokens</h2><p class="empty">(pas de données &mdash; en mode live, laisser tourner le serveur quelques minutes ; en mode statique, générer avec <code>node scripts/usage-report.js &gt; journal/usage-snapshot.json</code>)</p>`;
}

// ---- 8. secondaire / repliable ---------------------------------------------------------------

function renderLlmStepsTable(steps) {
  if (!steps || steps.length === 0) {
    return '<p class="empty">(aucun step LLM enregistré)</p>';
  }
  const rows = steps
    .map(
      (s) => `<tr>
      <td>${escapeHtml(s.step)}</td>
      <td>${escapeHtml(s.model)}</td>
      <td>${escapeHtml(s.account)}</td>
      <td>${s.sessionId ? `<code>claude --resume ${escapeHtml(s.sessionId)}</code>` : '—'}</td>
    </tr>`
    )
    .join('');
  return `<table class="llm-steps">
    <thead><tr><th>step</th><th>modèle</th><th>compte</th><th>reprendre</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderTaskCard(task) {
  const reasonLine =
    task.state === 'PARKED'
      ? `<p class="reason">raison : <strong>${escapeHtml(task.reason || 'unknown')}</strong></p>`
      : '';
  return `<article class="task-card">
    <header>
      <span class="task-id">${escapeHtml(task.id)}</span>
      <span class="badge ${stateClass(task.state)}">${escapeHtml(task.state)}</span>
    </header>
    <p class="title">${escapeHtml(task.title || '(sans titre)')}</p>
    <p class="meta">kind : ${escapeHtml(task.kind || '?')} &middot; dernier événement : ${escapeHtml(task.lastEventName || '?')} @ ${escapeHtml(task.lastEventTs || '?')}</p>
    ${reasonLine}
    ${renderLlmStepsTable(task.llmSteps)}
  </article>`;
}

function renderTasksDetails(tasks) {
  if (!tasks || tasks.length === 0) {
    return `<p class="empty">(aucune tâche dans le journal)</p>`;
  }
  return `<div class="task-grid">${tasks.map(renderTaskCard).join('\n')}</div>`;
}

function renderQueueDetails(queue) {
  const q = queue || { depth: 0, nextIds: [] };
  const next =
    q.nextIds && q.nextIds.length
      ? `<ol>${q.nextIds.map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join('')}</ol>`
      : '<p class="empty">(file vide)</p>';
  return `<p>profondeur : <strong>${escapeHtml(q.depth)}</strong></p>${next}`;
}

function renderVerdictsDetails(verdicts) {
  if (!verdicts || verdicts.length === 0) {
    return `<p class="empty">(aucun verdict local &mdash; ~/.spo-bench/verdicts/)</p>`;
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
  return `<details id="det-verdicts"><summary>Verdicts de gate récents</summary>${renderVerdictsDetails(d.verdicts)}</details>
    <details id="det-queue"><summary>File d'attente</summary>${renderQueueDetails(d.queue)}</details>
    <details id="det-tasks"><summary>Tâches</summary>${renderTasksDetails(d.journalTasks)}</details>`;
}

// ---- assembly -------------------------------------------------------------------------------

function renderDataFragments(data) {
  const d = data || {};
  return {
    services: renderServicesInner(d.services, d.journalTasks, d.accounts),
    daemon: renderDaemonStatsInner(d.daemonStats),
    prod: renderProdInner(d.prod),
    reports: renderReportsInner(d.reports),
    accounts: renderAccountsInner(d.accounts, d.tokens),
    tokens: renderTokensInner(d.tokens, d.usageSnapshot),
    secondary: renderSecondaryInner(d),
    stamp: escapeHtml(d.generatedAt || ''),
  };
}

const LIVE_SCRIPT = `
<script>
(function () {
  var fails = 0;
  var sysBusy = false;
  var dataBusy = false;

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

  setInterval(tickSystem, 1000);
  setInterval(tickData, 30000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { tickSystem(); tickData(); }
  });
  tickSystem();
  tickData();
})();
</script>`;

// The one exported entry point: given the collected data object, return the full HTML
// document as a string. Deterministic for a given input -- no Date.now(), no fs, no network.
// opts.live: true removes the meta refresh and adds the client polling script (see header).
function renderDashboard(data, opts = {}) {
  const d = data || {};
  const live = !!opts.live;
  const generatedAt = d.generatedAt || '';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
${live ? '' : '<meta http-equiv="refresh" content="30">'}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SPO Pipeline dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div id="offline-banner" class="banner verdict-unknown">connexion au serveur perdue &mdash; données figées</div>
<header>
  <h1>SPO Pipeline &mdash; generated <span id="frag-stamp">${escapeHtml(generatedAt)}</span> &mdash; spo dashboard</h1>
</header>
<main>
${frag('services', renderServicesInner(d.services, d.journalTasks, d.accounts))}
${frag('daemon', renderDaemonStatsInner(d.daemonStats))}
${frag('system', renderSystemInner(d.system))}
${frag('prod', renderProdInner(d.prod))}
${frag('reports', renderReportsInner(d.reports))}
${frag('accounts', renderAccountsInner(d.accounts, d.tokens))}
<hr class="section-divider">
${frag('tokens', renderTokensInner(d.tokens, d.usageSnapshot))}
${frag('secondary', renderSecondaryInner(d))}
</main>
${live ? LIVE_SCRIPT : ''}
</body>
</html>
`;
}

module.exports = {
  renderDashboard,
  escapeHtml,
  renderDataFragments,
  renderSystemFragment,
  renderServicesInner,
  renderSystemInner,
  renderAccountsInner,
  renderDaemonStatsInner,
  renderReportsInner,
  renderProdInner,
  renderTokensInner,
  renderSecondaryInner,
};
