'use strict';
// console/collect.js -- reads the local, on-disk runtime surfaces the dashboard renders, and
// hands back one plain data object. Every read here is defensive: a missing file or directory
// produces an empty/undefined result, never a throw -- console/render.js then renders that as
// an empty section (same philosophy as bin/spo: "the console is a reader, never a second
// source of truth", orchestrator/README.md § Observability). This module does all the
// filesystem work so render.js can stay a pure function of already-parsed data.

const fs = require('fs');
const path = require('path');

const QUEUE_PREVIEW_LIMIT = 25;
const VERDICTS_LIMIT = 5;

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function listTaskDirs(dir) {
  if (!dir) return [];
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readJournalLines(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  try {
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// One card's worth of data per journal/<id>/ directory. Reads state.json (current
// state/reason), task.json (title/kind fallback, in case state.json predates a field), and
// journal.jsonl (last event, and every recorded `llm-call` event -- see
// orchestrator/steps/llm.js's appendEvent call for the exact shape: {step, model, effort,
// account, sessionId, costUsd, numTurns, ok}).
function collectJournalTasks(journalRoot) {
  const ids = listTaskDirs(journalRoot);
  return ids.map((id) => {
    const dir = path.join(journalRoot, id);
    const state = readJsonSafe(path.join(dir, 'state.json'), {});
    const task = readJsonSafe(path.join(dir, 'task.json'), {});
    const lines = readJournalLines(dir);
    const last = lines.length ? lines[lines.length - 1] : null;

    const llmSteps = lines
      .filter((e) => e.event === 'llm-call')
      .map((e) => ({
        step: e.step,
        model: e.model,
        account: e.account,
        costUsd: typeof e.costUsd === 'number' ? e.costUsd : null,
        sessionId: e.sessionId || null,
      }));

    const totalCostUsd = llmSteps.reduce((sum, s) => sum + (typeof s.costUsd === 'number' ? s.costUsd : 0), 0);

    return {
      id,
      title: state.title || task.title || '',
      kind: state.kind || task.kind || '',
      state: state.state || 'UNKNOWN',
      reason: state.reason || null,
      lastEventTs: last ? last.ts : null,
      lastEventName: last ? last.event : null,
      llmSteps,
      totalCostUsd,
    };
  });
}

// Queue depth + a bounded preview of the next task ids, in filename order (= intake order --
// see orchestrator/README.md "Task-file format"). Prefers a task's own `id` field over the
// filename, same fallback intake itself uses.
function collectQueue(queueDir) {
  if (!queueDir) return { depth: 0, nextIds: [] };
  let files;
  try {
    if (!fs.existsSync(queueDir)) return { depth: 0, nextIds: [] };
    files = fs
      .readdirSync(queueDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return { depth: 0, nextIds: [] };
  }
  const nextIds = files.slice(0, QUEUE_PREVIEW_LIMIT).map((f) => {
    const parsed = readJsonSafe(path.join(queueDir, f), null);
    return (parsed && parsed.id) || f.replace(/\.json$/, '');
  });
  return { depth: files.length, nextIds };
}

// Account health, from claude-accounts/accounts.json (registry) + state.json (runtime
// cooldowns) -- see orchestrator/accounts.js for the authoritative shapes. Deliberately does
// NOT fall back to the implicit {name: "default"} account accounts.js itself uses when the
// registry is absent: that fallback is a *runtime* behaviour (real mode still works with no
// registry), but the dashboard only ever shows what is actually on disk -- an absent registry
// is an empty section, not a synthesized row.
function collectAccounts(accountsDir) {
  if (!accountsDir) return { rows: [] };
  const registryPath = path.join(accountsDir, 'accounts.json');
  if (!fs.existsSync(registryPath)) return { rows: [] };

  const registryRaw = readJsonSafe(registryPath, []);
  const registry = Array.isArray(registryRaw) ? registryRaw : [];
  const state = readJsonSafe(path.join(accountsDir, 'state.json'), {});
  const now = Date.now();

  const rows = registry.map((a) => {
    const entry = state[a.name];
    const cooldownUntil = entry && typeof entry.cooldownUntil === 'number' ? entry.cooldownUntil : null;
    const cooling = typeof cooldownUntil === 'number' && cooldownUntil > now;
    return {
      name: a.name,
      enabled: a.enabled !== false,
      cooldownUntil: cooling ? new Date(cooldownUntil).toISOString() : null,
      cooling,
    };
  });

  return { rows };
}

// ~/.spo-bench/nightly/latest.json -- the main-branch nightly verdict. Read-only, never probed
// live (doc/E2E-POLICY.md / CLAUDE.md "Live server logs" apply to the product repo, not here,
// but the same read-only discipline holds for this shared local surface).
function collectNightly(nightlyPath) {
  return readJsonSafe(nightlyPath, null);
}

// ~/.spo-bench/verdicts/*.json, newest 5 by mtime -- one gate attestation per pushed sha.
function collectVerdicts(verdictsDir, limit = VERDICTS_LIMIT) {
  if (!verdictsDir) return [];
  let files;
  try {
    if (!fs.existsSync(verdictsDir)) return [];
    files = fs.readdirSync(verdictsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const withStat = files.map((f) => {
    const p = path.join(verdictsDir, f);
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      /* file removed between readdir and stat -- sorts last, harmless */
    }
    return { f, p, mtime };
  });
  withStat.sort((a, b) => b.mtime - a.mtime);
  return withStat.slice(0, limit).map(({ f, p }) => ({ file: f, ...readJsonSafe(p, {}) }));
}

// journal/usage-snapshot.json -- an optional, operator-produced snapshot: `node
// scripts/usage-report.js > journal/usage-snapshot.json`. Absent by default; see
// scripts/usage-report.js for the output shape (estUsd, byPhase_Mtokens, ...).
function collectUsageSnapshot(journalRoot) {
  if (!journalRoot) return null;
  return readJsonSafe(path.join(journalRoot, 'usage-snapshot.json'), null);
}

// Gathers every source into the one data object console/render.js's renderDashboard() expects.
// `benchRoot` defaults to ~/.spo-bench, resolved by the caller (bin/spo) so this module never
// has to import `os` just to find the home directory.
function collectAll({ journalRoot, queueDir, accountsDir, benchRoot } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    journalTasks: collectJournalTasks(journalRoot),
    queue: collectQueue(queueDir),
    accounts: collectAccounts(accountsDir),
    nightly: benchRoot ? collectNightly(path.join(benchRoot, 'nightly', 'latest.json')) : null,
    verdicts: benchRoot ? collectVerdicts(path.join(benchRoot, 'verdicts')) : [],
    usageSnapshot: collectUsageSnapshot(journalRoot),
  };
}

module.exports = {
  collectAll,
  collectJournalTasks,
  collectQueue,
  collectAccounts,
  collectNightly,
  collectVerdicts,
  collectUsageSnapshot,
};
