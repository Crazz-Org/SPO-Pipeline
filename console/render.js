'use strict';
// console/render.js -- pure HTML rendering for the pipeline dashboard. Given the parsed local
// surfaces (see console/collect.js for how those are gathered), renderDashboard() returns one
// full, self-contained HTML document string: inline CSS, no external requests, a 30s meta
// refresh, light+dark via prefers-color-scheme. Nothing in this file touches fs/network -- the
// same input always produces the same output, which is what makes it unit-testable without
// touching disk.
//
// Input shape (every field optional -- a missing/empty one renders as an empty section, never
// throws):
//
//   {
//     generatedAt: ISO string,
//     journalTasks: [{ id, title, kind, state, reason, lastEventTs, lastEventName,
//                       llmSteps: [{step, model, account, costUsd, sessionId}], totalCostUsd }],
//     queue: { depth, nextIds: [id, ...] },
//     accounts: { rows: [{ name, enabled, cooldownUntil, cooling }] },
//     nightly: { verdict, sha, jobId, finishedAt, detail } | null,
//     verdicts: [{ file, head, verdict, createdAt, jobId, baseMain }],   // newest-first
//     usageSnapshot: { estUsd: {total, byModel}, byPhase_Mtokens: {...} } | null,
//   }
//
// Section titles are French (the operator is French-speaking, README.md "Language"); data
// values (ids, states, model names, reasons) are rendered as-is.

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtUsd(n, digits = 4) {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(digits)}` : '—';
}

function fmtNum(n, digits = 2) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';
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
    --gray-bg: #2a2b33;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 1.5rem;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  line-height: 1.4;
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
.task-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 0.75rem; }
.task-card { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; background: var(--card-bg); }
.task-card > header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; gap: 0.5rem; }
.task-id { font-weight: 600; font-family: ui-monospace, monospace; }
.badge { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; font-weight: 600; white-space: nowrap; }
.state-done { background: var(--green-bg); color: var(--green); }
.state-parked { background: var(--red-bg); color: var(--red); }
.state-active { background: var(--gray-bg); color: var(--accent); }
.title { margin: 0.2rem 0; }
.reason { color: var(--red); margin: 0.2rem 0; }
.total-cost { margin-top: 0.4rem; font-variant-numeric: tabular-nums; }
table.llm-steps th, table.llm-steps td { font-size: 0.8rem; }
`;

function renderNightlyBanner(nightly) {
  if (!nightly) {
    return `<section class="banner verdict-unknown"><strong>Nightly (main) : INCONNU</strong><span class="meta">aucune donnée locale (~/.spo-bench/nightly/latest.json)</span></section>`;
  }
  const cls = verdictClass(nightly.verdict);
  const label = nightly.verdict === 'PASS' ? 'VERT' : nightly.verdict === 'FAIL' ? 'ROUGE' : 'INCONNU';
  return `<section class="banner ${cls}">
    <strong>Nightly (main) : ${escapeHtml(label)}</strong>
    <span class="meta">sha ${escapeHtml(shortSha(nightly.sha))} &middot; ${escapeHtml(nightly.finishedAt || '')} &middot; ${escapeHtml(nightly.detail || '')}</span>
  </section>`;
}

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
      <td class="num">${fmtUsd(s.costUsd)}</td>
      <td>${s.sessionId ? `<code>claude --resume ${escapeHtml(s.sessionId)}</code>` : '—'}</td>
    </tr>`
    )
    .join('');
  return `<table class="llm-steps">
    <thead><tr><th>step</th><th>modèle</th><th>compte</th><th class="num">coût</th><th>reprendre</th></tr></thead>
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
    <p class="total-cost">coût total de la tâche : <strong>${fmtUsd(task.totalCostUsd)}</strong></p>
  </article>`;
}

function renderTasksSection(tasks) {
  if (!tasks || tasks.length === 0) {
    return `<section><h2>Tâches</h2><p class="empty">(aucune tâche dans le journal)</p></section>`;
  }
  return `<section>
    <h2>Tâches</h2>
    <div class="task-grid">
      ${tasks.map(renderTaskCard).join('\n')}
    </div>
  </section>`;
}

function renderQueueSection(queue) {
  const q = queue || { depth: 0, nextIds: [] };
  const next =
    q.nextIds && q.nextIds.length
      ? `<ol>${q.nextIds.map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join('')}</ol>`
      : '<p class="empty">(file vide)</p>';
  return `<section>
    <h2>File d'attente</h2>
    <p>profondeur : <strong>${escapeHtml(q.depth)}</strong></p>
    ${next}
  </section>`;
}

function renderAccountsSection(accounts) {
  const rows = (accounts && accounts.rows) || [];
  if (rows.length === 0) {
    return `<section><h2>Comptes Claude</h2><p class="empty">(aucun registre de comptes local -- claude-accounts/accounts.json absent)</p></section>`;
  }
  const body = rows
    .map(
      (a) => `<tr class="${a.cooling ? 'cooling' : ''}">
      <td>${escapeHtml(a.name)}</td>
      <td>${a.enabled ? 'oui' : 'non'}</td>
      <td>${a.cooldownUntil ? escapeHtml(a.cooldownUntil) : '—'}</td>
    </tr>`
    )
    .join('');
  return `<section>
    <h2>Comptes Claude</h2>
    <table>
      <thead><tr><th>nom</th><th>activé</th><th>refroidissement jusqu'à</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

function renderVerdictsSection(verdicts) {
  if (!verdicts || verdicts.length === 0) {
    return `<section><h2>Verdicts de gate récents</h2><p class="empty">(aucun verdict local -- ~/.spo-bench/verdicts/)</p></section>`;
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
  return `<section>
    <h2>Verdicts de gate récents</h2>
    <table>
      <thead><tr><th>sha</th><th>verdict</th><th>date</th><th>job</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderUsageSection(usage) {
  if (!usage) {
    return `<section><h2>Utilisation (tokens)</h2><p class="empty">(pas de journal/usage-snapshot.json &mdash; générer avec <code>node scripts/usage-report.js &gt; journal/usage-snapshot.json</code>)</p></section>`;
  }
  const estUsd = usage.estUsd || {};
  const byModel = estUsd.byModel || {};
  const modelKeys = Object.keys(byModel);
  const modelRows = modelKeys.length
    ? modelKeys.map((m) => `<tr><td>${escapeHtml(m)}</td><td class="num">$${fmtNum(byModel[m], 2)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="empty">(aucun)</td></tr>`;

  const byPhase = usage.byPhase_Mtokens || {};
  const phaseKeys = Object.keys(byPhase);
  const phaseRows = phaseKeys.length
    ? phaseKeys
        .map((p) => {
          const row = byPhase[p] || {};
          return `<tr>
            <td>${escapeHtml(p)}</td>
            <td class="num">${fmtNum(row.n, 0)}</td>
            <td class="num">${fmtNum(row.cr)}</td>
            <td class="num">${fmtNum(row.cc)}</td>
            <td class="num">${fmtNum(row.out)}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="empty">(aucune)</td></tr>`;

  return `<section>
    <h2>Utilisation (tokens)</h2>
    <p>estimation totale : <strong>$${fmtNum(estUsd.total, 2)}</strong></p>
    <table>
      <thead><tr><th>modèle</th><th class="num">coût estimé</th></tr></thead>
      <tbody>${modelRows}</tbody>
    </table>
    <table>
      <thead><tr><th>phase</th><th class="num">n</th><th class="num">Mtok cache-read</th><th class="num">Mtok cache-write</th><th class="num">Mtok sortie</th></tr></thead>
      <tbody>${phaseRows}</tbody>
    </table>
  </section>`;
}

// The one exported entry point: given the collected data object, return the full HTML
// document as a string. Deterministic for a given input -- no Date.now(), no fs, no network.
function renderDashboard(data) {
  const d = data || {};
  const generatedAt = d.generatedAt || '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SPO Pipeline dashboard</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>SPO Pipeline &mdash; generated ${escapeHtml(generatedAt)} &mdash; spo dashboard</h1>
</header>
<main>
${renderNightlyBanner(d.nightly)}
${renderTasksSection(d.journalTasks)}
${renderQueueSection(d.queue)}
${renderAccountsSection(d.accounts)}
${renderVerdictsSection(d.verdicts)}
${renderUsageSection(d.usageSnapshot)}
</main>
</body>
</html>
`;
}

module.exports = {
  renderDashboard,
  escapeHtml,
};
