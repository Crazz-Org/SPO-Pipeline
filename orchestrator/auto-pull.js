'use strict';
// auto-pull.js -- the daemon's own periodic pull-and-enqueue, real mode only (state-machine.js's
// runForever calls this between drain passes). Wraps orchestrator/intake.js's existing
// pullBoard/makeTask -- the exact same read-only `npm run board:claim` scan and per-candidate
// `gh api` issue fetch `spo pull` already runs by hand -- on a config.autoPullMs timer instead
// of a human running `spo pull`.
//
// GraphQL cost: `npm run board:claim` is the same ~2-4 point cheap pool read
// doc/kanban-workflow.md § GitHub API discipline already documents for `spo pull` (see
// orchestrator/README.md § Kanban piloting) -- this timer does not add a new kind of GitHub
// read, it just runs the existing one on a schedule instead of only on request.

const intake = require('./intake');
const { appendDaemonEvent } = require('./journal');

const DEFAULT_AUTO_PULL_MS = 5 * 60 * 1000;
const DEFAULT_AUTO_PULL_LIMIT = 3;

// Pure decision function -- no Date.now() call baked in, so a test drives it with any
// (lastPullAt, nowMs) pair (the "injectable clock"). autoPullMs <= 0 disables the timer
// entirely regardless of lastPullAt (config.js's SPO_AUTO_PULL_MS=0 override).
function shouldAutoPull(lastPullAt, nowMs, autoPullMs) {
  if (!(autoPullMs > 0)) return false;
  if (lastPullAt === null || lastPullAt === undefined) return true;
  return nowMs - lastPullAt >= autoPullMs;
}

// runAutoPull(queueDir, journalRoot, config, deps) -- pullBoard + makeTask for the top
// config.autoPullLimit (default 3) claimable candidates, same dedup rules as `spo pull`
// (intake.makeTask skips one already in queue/ or journal/). Journals exactly one `auto-pull`
// event to journalRoot's own daemon.jsonl per call, and only when at least one candidate was
// actually written -- never for a cycle that found nothing new. Returns {ok, enqueued, issues,
// warnings, errors}.
async function runAutoPull(queueDir, journalRoot, config, deps = {}) {
  const limit = (config && config.autoPullLimit) || DEFAULT_AUTO_PULL_LIMIT;
  const pullDeps = { productRepo: config && config.productRepo, ...deps };

  const pulled = intake.pullBoard(pullDeps);
  if (!pulled.ok) {
    return { ok: false, error: pulled.error, enqueued: 0, issues: [], warnings: [], errors: [] };
  }

  const top = pulled.candidates.slice(0, limit);
  const enqueuedIssues = [];
  const errors = [];

  for (const candidate of top) {
    const made = intake.makeTask(candidate, { ...deps, queueDir, journalRoot });
    if (!made.ok) {
      errors.push({ issue: candidate.issue, error: made.error });
      continue;
    }
    if (!made.skipped) enqueuedIssues.push(candidate.issue);
  }

  if (enqueuedIssues.length > 0) {
    appendDaemonEvent(journalRoot, 'auto-pull', { enqueued: enqueuedIssues.length, issues: enqueuedIssues });
  }

  return { ok: true, enqueued: enqueuedIssues.length, issues: enqueuedIssues, warnings: pulled.warnings, errors };
}

module.exports = { shouldAutoPull, runAutoPull, DEFAULT_AUTO_PULL_MS, DEFAULT_AUTO_PULL_LIMIT };
