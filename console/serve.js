'use strict';
// serve.js -- a small stateful HTTP server for the live dashboard. `/` renders the full page
// (live mode: client-side polling, no meta refresh); `/api/system` (CPU/mem, meant to be polled
// every 1s) and `/api/data` (everything else, meant to be polled every 30s) return JSON. State
// lives here, not in console/collect.js or console/render.js, which both stay pure/sync:
//   - systemSampler carries the previous os.cpus() reading (see console/system.js).
//   - prodProbe runs its own two timers and caches the last result (see console/prod-version.js).
//   - usageScanner incrementally re-scans ~/.claude*/projects on its own timer, way slower than
//     any request cadence -- 410 MB / ~1k files makes a per-request scan a non-starter (see
//     console/usage-scan.js's own header on the WSL VM that a naive slurp took down).
// A short-lived `buildData()` cache (dataTtlMs) protects against multiple browser tabs each
// polling /api/data every 30s from re-walking the whole journal on every single request.
//
// This serves on the LAN / to whatever can reach this machine's port. The externally hosted
// copy (nginx + basic auth on the dedicated server) is a `spo dashboard` + rsync concern owned
// by SPO-Deploy -- this server is the local/immediate tier, not the public one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { collectAll, buildSessionIndex } = require('./collect');
const { renderDashboard, renderDataFragments, renderSystemFragment, renderLiveInner } = require('./render');
const { probeDeck } = require('./live-step');
const { refreshParTimes } = require('./par-times');
const { createSystemSampler } = require('./system');
const { createUsageScanner, buildTokenViews, buildTrendViews, localDateKey } = require('./usage-scan');
const { loadRollups, mergeRollups, saveRollups } = require('./usage-rollups');

const DEFAULT_DATA_TTL_MS = 5000;
// The flight deck's own cache. Far shorter than the 30s data cache because `/` is a live view of
// a card that moves: a two-second-old split time is fine, a thirty-second-old one is a stopped
// clock. The whole deck build is one journal walk over at most a couple of task directories plus
// one 64 KB transcript tail (see collect.js's DECK_LINGER_MS gate and live-step.js's rules), so
// this cadence costs a rounding error even with several browser tabs open.
const DEFAULT_DECK_TTL_MS = 1500;
// Par times are recomputed on the same slow timer as the usage scan -- the pass walks every
// journal on disk, which is exactly the work console/par-times.js exists to keep off the request
// path. refreshParTimes() no-ops unless the corpus has actually moved.
const DEFAULT_PAR_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_SCAN_MS = 5 * 60 * 1000;
const USAGE_SCAN_DELAY_MS = 2000;

// discoverUsageRoots(accountsDir) -- one {path, account} per pool account's own
// CLAUDE_CONFIG_DIR/projects, plus ~/.claude/projects as 'local'. Filters by existence; []
// if accountsDir is absent. Re-exported here (also lives in usage-scan.js) for callers that
// only need the discovery, not the scanner itself -- e.g. bin/spo wiring it into
// createUsageScanner's `roots` option.
function discoverUsageRoots(accountsDir) {
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

function createDashboardServer(sources, opts = {}) {
  const systemSampler = opts.systemSampler || createSystemSampler();
  const prodProbe = opts.prodProbe === undefined ? null : opts.prodProbe; // null = disabled
  const usageScanner = opts.usageScanner || createUsageScanner({ roots: discoverUsageRoots(sources.accountsDir) });
  const dataTtlMs = opts.dataTtlMs || DEFAULT_DATA_TTL_MS;
  const deckTtlMs = opts.deckTtlMs === undefined ? DEFAULT_DECK_TTL_MS : opts.deckTtlMs;
  const usageScanMs = opts.usageScanMs || DEFAULT_USAGE_SCAN_MS;
  const parRefreshMs = opts.parRefreshMs || DEFAULT_PAR_REFRESH_MS;
  const parTimesPath = sources.journalRoot ? path.join(sources.journalRoot, 'par-times.json') : null;
  // The tokens trend's durable store (console/usage-rollups.js) -- co-located with the static
  // fallback's journal/usage-snapshot.json. No journalRoot (some test setups) means no trend.
  const rollupsPath = sources.journalRoot ? path.join(sources.journalRoot, 'usage-rollups.json') : null;
  let rollups = rollupsPath ? loadRollups(rollupsPath) : {};

  let cache = null; // {at, data}
  let deckCache = null; // {at, data} -- the fast path behind `/` and /api/live
  let usageScanTimer = null;
  let usageScanDelayTimer = null;
  let parTimer = null;

  function buildData() {
    const now = Date.now();
    if (cache && now - cache.at <= dataTtlMs) return cache.data;
    const base = collectAll(sources);
    base.system = systemSampler.sample();
    base.prod = prodProbe ? prodProbe.snapshot() : null;
    const usageIndex = usageScanner.snapshot();
    base.tokens = usageIndex ? buildTokenViews(usageIndex, buildSessionIndex(base.journalTasks)) : null;
    base.trend = Object.keys(rollups).length ? buildTrendViews(rollups) : null;
    cache = { at: now, data: base };
    return base;
  }

  // buildDeckData() -- everything `/` needs, on its own short cache. Deliberately NOT
  // buildData(): the deck does not want the usage scan, the prod probe or the CPU sample, and
  // waiting 30 s behind their cache is exactly the stopped clock this view exists to avoid. The
  // live-step probe runs here rather than in collect.js so that module stays sync and disk-local
  // -- the same split system/prod/tokens already use.
  function buildDeckData() {
    const now = Date.now();
    if (deckCache && now - deckCache.at <= deckTtlMs) return deckCache.data;
    const data = collectAll(sources);
    data.liveSteps = probeDeck(data.deck, { accountsDir: sources.accountsDir });
    deckCache = { at: now, data };
    return data;
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  // The keys the deck build owns. Everything else on `/` comes from the ordinary (30 s) data
  // object, so the two caches compose instead of one shadowing the other -- and `generatedAt`
  // comes from the DECK build, because that is the clock the deck's own elapsed times are
  // measured against (render-deck.js is a pure function of it).
  function deckSlice(deckData) {
    return {
      generatedAt: deckData.generatedAt,
      deck: deckData.deck,
      parTimes: deckData.parTimes,
      liveSteps: deckData.liveSteps,
      queue: deckData.queue,
      daemonStats: deckData.daemonStats,
    };
  }

  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('method not allowed');
        return;
      }

      const url = req.url.split('?')[0];

      const sendHtml = (html) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(html);
      };

      // `/` is the flight deck. It needs the deck build (fast, 1.5 s) plus the health summary
      // that labels the link across, which lives in the ordinary data object -- merged rather
      // than re-collected so the page costs one journal walk, not two.
      if (url === '/') {
        sendHtml(renderDashboard({ ...buildData(), ...deckSlice(buildDeckData()) }, { live: true }));
        return;
      }

      // /health is every section the root page used to carry, unchanged.
      if (url === '/health') {
        sendHtml(renderDashboard(buildData(), { live: true, view: 'health' }));
        return;
      }

      // The deck's own fast poll. One fragment, one id -- the client swaps `frag-live` and
      // leaves the 30 s /api/data cadence to everything else.
      if (url === '/api/live') {
        const data = { ...buildData(), ...deckSlice(buildDeckData()) };
        sendJson(res, 200, { generatedAt: data.generatedAt, fragments: { live: renderLiveInner(data) } });
        return;
      }

      if (url === '/api/system') {
        const system = systemSampler.sample();
        sendJson(res, 200, { system, html: renderSystemFragment(system) });
        return;
      }

      if (url === '/api/data') {
        const data = buildData();
        sendJson(res, 200, { generatedAt: data.generatedAt, fragments: renderDataFragments(data) });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`dashboard error: ${err.message}`);
    }
  });

  server.on('listening', () => {
    if (prodProbe) prodProbe.start();
    if (parTimesPath) {
      const runPar = () => {
        try {
          refreshParTimes(sources.journalRoot, parTimesPath);
        } catch {
          /* pars are an enhancement: the deck renders times without a comparison rather than 500 */
        }
      };
      runPar();
      parTimer = setInterval(runPar, parRefreshMs);
      if (parTimer.unref) parTimer.unref();
    }
    const runScan = () =>
      usageScanner
        .scan()
        .then((idx) => {
          if (!rollupsPath || !idx || !idx.byDay) return;
          // LOCAL calendar day, not UTC -- see console/usage-scan.js's "the ONE 'today' rule"
          // header (action 5.5, item C) for why: this used to be `new
          // Date().toISOString().slice(0, 10)` (UTC), which disagreed with collect.js's
          // LOCAL-midnight daemon-stats bucketing for two hours a day on a UTC+2 host.
          rollups = mergeRollups(rollups, idx.byDay, { todayDate: localDateKey(Date.now()) });
          saveRollups(rollupsPath, rollups);
        })
        .catch(() => {});
    usageScanDelayTimer = setTimeout(() => {
      runScan();
      usageScanTimer = setInterval(runScan, usageScanMs);
      if (usageScanTimer.unref) usageScanTimer.unref();
    }, USAGE_SCAN_DELAY_MS);
    if (usageScanDelayTimer.unref) usageScanDelayTimer.unref();
  });

  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    if (prodProbe) prodProbe.stop();
    if (usageScanTimer) clearInterval(usageScanTimer);
    if (usageScanDelayTimer) clearTimeout(usageScanDelayTimer);
    if (parTimer) clearInterval(parTimer);
    return originalClose(cb);
  };

  return server;
}

module.exports = { createDashboardServer, discoverUsageRoots };
