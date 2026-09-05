'use strict';
// console/serve.js -- the live dashboard's HTTP routes. Every dependency (systemSampler,
// prodProbe, usageScanner) is a deterministic fake; no real network, no real CPU sampling.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
const { createDashboardServer } = require('../console/serve');
const { loadRollups } = require('../console/usage-rollups');

function fakeSystemSampler() {
  return { sample: () => ({ cpu: { count: 1, cores: [{ i: 0, busyPct: 10 }], busyPct: 10, model: 'Test' }, memory: { totalBytes: 100, freeBytes: 50, usedBytes: 50, usedPct: 50 }, loadavg: [0, 0, 0], uptimeSec: 1, sampledAt: new Date().toISOString() }) };
}

function fakeUsageScanner() {
  return { scan: async () => null, snapshot: () => null, stats: () => ({ cachedFiles: 0 }) };
}

// A fake scanner whose scan() resolves with a byDay-shaped index, as console/usage-scan.js's
// real scan() would -- exercises serve.js's rollups merge+save wiring without any real transcript
// files or timers beyond the server's own fixed initial-scan delay.
function fakeUsageScannerWithByDay(date) {
  const index = { byDay: { [date]: { sessions: 7, msgs: 7, models: { 'claude-sonnet-5': { msgs: 7, inp: 1000, cc: 10, cr: 100, out: 200 } } } } };
  return { scan: async () => index, snapshot: () => null, stats: () => ({ cachedFiles: 0 }) };
}

function startServer(sources, opts) {
  return new Promise((resolve) => {
    const server = createDashboardServer(sources, opts);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET / renders the flight deck (frag-live), not the health sections, and no meta refresh', async (t) => {
  const journalRoot = mkTmp('spo-serve-journal-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner() }
  );
  t.after(() => server.close());

  const res = await get(server, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  // The root page IS the deck now: one fragment, and the health sections are NOT on it.
  assert.match(res.body, /id="frag-live"/);
  assert.doesNotMatch(res.body, /id="frag-services"/);
  assert.doesNotMatch(res.body, /id="frag-tokens"/);
  // ...and it links across to where they went, so the split is discoverable from the page.
  assert.match(res.body, /href="\/health"/);
  assert.doesNotMatch(res.body, /http-equiv="refresh"/);
});

test('GET /health still serves every section the root page used to carry, with the same fragment ids', async (t) => {
  const journalRoot = mkTmp('spo-serve-health-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner() }
  );
  t.after(() => server.close());

  const res = await get(server, '/health');
  assert.equal(res.status, 200);
  for (const id of ['services', 'daemon', 'system', 'reports', 'accounts', 'tokens', 'secondary']) {
    assert.match(res.body, new RegExp(`id="frag-${id}"`), `health page is missing frag-${id}`);
  }
  assert.doesNotMatch(res.body, /id="frag-live"/);
  assert.match(res.body, /href="\/"/); // and back to the deck
});

test('GET /api/live serves the deck fragment alone, so the 2s poll never rewrites the 30s sections', async (t) => {
  const journalRoot = mkTmp('spo-serve-live-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner() }
  );
  t.after(() => server.close());

  const res = await get(server, '/api/live');
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body);
  assert.deepEqual(Object.keys(json.fragments), ['live']);
  assert.ok(json.generatedAt);
  // Same un-nested rule as /api/data: the client assigns this to el.innerHTML.
  assert.ok(!json.fragments.live.startsWith('<section id="frag-'));
});

test('GET /api/system returns a system snapshot + html, and never calls collectAll', async (t) => {
  const journalRoot = mkTmp('spo-serve-journal2-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner() }
  );
  t.after(() => server.close());

  const res = await get(server, '/api/system');
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body);
  assert.ok(json.system.cpu.cores.length > 0);
  assert.ok(json.html.length > 0);
  assert.ok(!('journalTasks' in json)); // guard: this route must not run collectAll
});

test('GET /api/data returns the 8 fragment keys, none nested', async (t) => {
  const journalRoot = mkTmp('spo-serve-journal3-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner() }
  );
  t.after(() => server.close());

  const res = await get(server, '/api/data');
  const json = JSON.parse(res.body);
  const ids = Object.keys(json.fragments).sort();
  // `live` rides here too so a client that never started the fast poll still refreshes the deck
  // at the 30s cadence -- see renderDataFragments' own comment.
  assert.deepEqual(ids, ['accounts', 'daemon', 'live', 'reports', 'secondary', 'services', 'stamp', 'tokens']);
  for (const v of Object.values(json.fragments)) {
    assert.ok(typeof v !== 'string' || !v.startsWith('<section id="frag-'));
  }
});

test('unknown routes 404, non-GET methods 405', async (t) => {
  const journalRoot = mkTmp('spo-serve-journal4-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner() }
  );
  t.after(() => server.close());

  const notFound = await get(server, '/nope');
  assert.equal(notFound.status, 404);

  const notAllowed = await request(server, 'POST', '/');
  assert.equal(notAllowed.status, 405);
});

test('two consecutive /api/data calls within the TTL return the same generatedAt (cache active)', async (t) => {
  const journalRoot = mkTmp('spo-serve-journal5-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner(), dataTtlMs: 60000 }
  );
  t.after(() => server.close());

  const first = JSON.parse((await get(server, '/api/data')).body);
  const second = JSON.parse((await get(server, '/api/data')).body);
  assert.equal(first.generatedAt, second.generatedAt);
});

test('the usage-scan timer merges byDay into journal/usage-rollups.json, and /api/data reflects it in the tokens fragment', async (t) => {
  const journalRoot = mkTmp('spo-serve-journal-rollups-');
  // LOCAL day, not `toISOString().slice(0, 10)` (the UTC one). Action 5.5 item C moved serve.js's
  // own `todayDate` to the local key so the page's two "today"s mean one day; a fixture still
  // keyed by UTC then disagrees with the server for the hours where the two dates differ, and at
  // UTC+14 that is most of the day. This is the cross-module manifestation of the mixed key
  // scheme -- the test was keying one way and the code the other.
  const { localDateKey } = require('../console/usage-scan');
  const today = localDateKey(Date.now());
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScannerWithByDay(today), dataTtlMs: 0 }
  );
  t.after(() => server.close());

  // The server's first scan fires after a fixed internal delay (console/serve.js's
  // USAGE_SCAN_DELAY_MS) -- wait past it rather than polling, this is a one-shot timing test.
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const rollupsPath = path.join(journalRoot, 'usage-rollups.json');
  assert.ok(fs.existsSync(rollupsPath));
  const rollups = loadRollups(rollupsPath);
  assert.equal(rollups[today].sessions, 7);
  assert.equal(rollups[today].partial, true);

  const res = await get(server, '/api/data');
  const json = JSON.parse(res.body);
  assert.match(json.fragments.tokens, /today \(partial\)/);
});
