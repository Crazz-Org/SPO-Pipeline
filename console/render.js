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

function frag(id, inner) {
  return `<section id="frag-${id}" class="frag">${inner}</section>`;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f9;
  --fg: #1a1a1e;
  --card-bg: #ffffff;
  --border: #d8d8de;
  --muted: #66666f;
  --accent: #3355cc;
  --green: #1a7f37;
  --green-bg: #e6f4ea;
  --red: #b3261e;
  --red-bg: #fbe9e7;
  --orange: #a35c00;
  --orange-bg: #fdf0dd;
  --gray-bg: #eeeeee;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14151a;
    --fg: #e6e6ec;
    --card-bg: #1e1f26;
    --border: #33343c;
    --muted: #9a9aa8;
    --accent: #86a2ff;
    --green: #5bd18a;
    --green-bg: #16301f;
    --red: #ff8a80;
    --red-bg: #3a1a17;
    --orange: #ffb454;
    --orange-bg: #3a2a10;
    --gray-bg: #2a2b33;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0.75rem;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  line-height: 1.4;
}
@media (min-width: 720px) {
  body { padding: 1.5rem; }
}
h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 1rem; word-break: break-word; }
h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
.meta { color: var(--muted); font-size: 0.85rem; }
.empty { color: var(--muted); font-style: italic; }
section { margin-bottom: 1rem; }
.banner { padding: 0.6rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.95rem; }
.banner .meta { display: block; margin-top: 0.15rem; }
.verdict-pass { background: var(--green-bg); color: var(--green); }
.verdict-fail { background: var(--red-bg); color: var(--red); }
.verdict-unknown { background: var(--gray-bg); color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; font-size: 0.85rem; }
th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); }
td.num, th.num { font-variant-numeric: tabular-nums; text-align: right; }
tr.cooling { background: var(--red-bg); }
code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  background: var(--gray-bg);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  font-size: 0.85em;
}
.task-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 0.75rem; }
.task-card { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; background: var(--card-bg); }
.task-card > header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; gap: 0.5rem; }
.task-id { font-weight: 600; font-family: ui-monospace, monospace; }
.badge { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; font-weight: 600; white-space: nowrap; }
.state-done { background: var(--green-bg); color: var(--green); }
.state-parked { background: var(--red-bg); color: var(--red); }
.state-active { background: var(--gray-bg); color: var(--accent); }
.title { margin: 0.2rem 0; }
.reason { color: var(--red); margin: 0.2rem 0; }
table.llm-steps th, table.llm-steps td { font-size: 0.8rem; }

.dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 999px; margin-right: 0.4rem; vertical-align: middle; }
.dot-green { background: var(--green); }
.dot-orange { background: var(--orange); }
.dot-red { background: var(--red); }
.dot-gray { background: var(--muted); }
.svc-row { display: flex; flex-wrap: wrap; gap: 0.6rem 1.2rem; }
.svc-item { display: flex; align-items: center; }

.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 0.75rem; margin: 0.5rem 0 1rem; }
.kpi { border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.8rem; background: var(--card-bg); }
.kpi strong { display: block; font-size: 1.6rem; font-variant-numeric: tabular-nums; }
.kpi span { color: var(--muted); font-size: 0.8rem; }

.bar-row { display: grid; grid-template-columns: 2.5rem 1fr 3rem; align-items: center; gap: 0.5rem; margin: 0.15rem 0; font-size: 0.8rem; }
.bar { height: 0.55rem; background: var(--gray-bg); border-radius: 3px; overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.gauge { height: 0.8rem; background: var(--gray-bg); border-radius: 4px; overflow: hidden; margin: 0.3rem 0; }
.gauge > span { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
.gauge-warn > span { background: var(--orange); }
.gauge-crit > span { background: var(--red); }

.badge-drift { background: var(--orange-bg); color: var(--orange); }

body[data-stale="1"] .frag { opacity: 0.55; }
#offline-banner { display: none; }
body[data-stale="1"] #offline-banner { display: block; }

@media (max-width: 720px) {
  table { display: block; overflow-x: auto; white-space: nowrap; }
}
`;

// ---- 1. services --------------------------------------------------------------------------

function svcLabel(label, status, detail) {
  return `<span class="svc-item"><span class="dot ${dotClass(status)}"></span>${escapeHtml(label)}${detail ? ` <span class="meta">${detail}</span>` : ''}</span>`;
}

function renderServicesInner(services) {
  const s = services || {};
  const daemon = s.daemon || {};
  const queue = s.queue || {};
  const bench = s.benchWorker || {};
  const nightly = s.nightly || {};
  const verdicts = s.verdicts || {};

  const items = [
    svcLabel(
      'démon',
      daemon.status,
      daemon.status === 'up' ? `pid ${escapeHtml(daemon.pid)} · ${escapeHtml(daemon.mode || '?')} · up ${fmtAgeMs(daemon.uptimeMs)}` : ''
    ),
    svcLabel('file', queue.status, `profondeur ${escapeHtml(queue.depth)}`),
    svcLabel(
      'bench worker',
      bench.status,
      bench.port ? `port ${escapeHtml(bench.port)} · battement il y a ${fmtAgeMs(bench.heartbeatAgeMs)}` : ''
    ),
    svcLabel('nightly', nightly.status, nightly.sha ? `sha ${escapeHtml(shortSha(nightly.sha))}` : ''),
    svcLabel(
      'verdicts',
      verdicts.status,
      verdicts.recentTotal ? `${escapeHtml(verdicts.recentPass)}/${escapeHtml(verdicts.recentTotal)} PASS` : ''
    ),
  ];

  return `<h2>État des services</h2><div class="svc-row">${items.join('')}</div>`;
}

// ---- 2. system (CPU/mémoire live) ----------------------------------------------------------

function renderSystemInner(system) {
  if (!system) {
    return `<h2>CPU / Mémoire</h2><p class="empty">non surveillé (instantané &mdash; relancer avec <code>spo dashboard --serve</code>)</p>`;
  }
  const cpu = system.cpu || {};
  const mem = system.memory || {};
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
    <p class="meta">${escapeHtml(cpu.count)} cœurs${cpu.model ? ' · ' + escapeHtml(cpu.model) : ''} &middot; charge moyenne ${(system.loadavg || []).map((n) => n.toFixed(2)).join(' / ')}</p>
    ${cores}
    <p class="meta" style="margin-top:0.5rem">mémoire : ${memGb(mem.usedBytes)} / ${memGb(mem.totalBytes)} Go (${escapeHtml(mem.usedPct)}%)</p>
    <div class="gauge ${memClass}"><span style="width:${memPct}%"></span></div>`;
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

function kpi(label, value, sub) {
  return `<div class="kpi"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}${sub ? ` &middot; ${sub}` : ''}</span></div>`;
}

function renderDaemonStatsInner(daemonStats) {
  const d = daemonStats || {};
  const week = d.week || {};
  const today = d.today || {};
  return `<h2>Stats du démon</h2>
    <div class="kpi-grid">
      ${kpi('traité au total', fmtInt(d.total), `${escapeHtml(d.done)} done / ${escapeHtml(d.parked)} parked${d.parkingRatePct !== null && d.parkingRatePct !== undefined ? ` · ${escapeHtml(d.parkingRatePct)}% parking` : ''}`)}
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
    services: renderServicesInner(d.services),
    accounts: renderAccountsInner(d.accounts, d.tokens),
    daemon: renderDaemonStatsInner(d.daemonStats),
    reports: renderReportsInner(d.reports),
    prod: renderProdInner(d.prod),
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
${frag('services', renderServicesInner(d.services))}
${frag('system', renderSystemInner(d.system))}
${frag('accounts', renderAccountsInner(d.accounts, d.tokens))}
${frag('daemon', renderDaemonStatsInner(d.daemonStats))}
${frag('reports', renderReportsInner(d.reports))}
${frag('prod', renderProdInner(d.prod))}
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
