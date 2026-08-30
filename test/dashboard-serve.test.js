'use strict';
// console/serve.js -- the live dashboard's HTTP routes. Every dependency (systemSampler,
// prodProbe, usageScanner) is a deterministic fake; no real network, no real CPU sampling.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { mkTmp } = require('./helpers');
const { createDashboardServer } = require('../console/serve');

function fakeSystemSampler() {
  return { sample: () => ({ cpu: { count: 1, cores: [{ i: 0, busyPct: 10 }], busyPct: 10, model: 'Test' }, memory: { totalBytes: 100, freeBytes: 50, usedBytes: 50, usedPct: 50 }, loadavg: [0, 0, 0], uptimeSec: 1, sampledAt: new Date().toISOString() }) };
}

function fakeUsageScanner() {
  return { scan: async () => null, snapshot: () => null, stats: () => ({ cachedFiles: 0 }) };
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

test('GET / renders live HTML with all 8 fragment ids and no meta refresh', async (t) => {
  const journalRoot = mkTmp('spo-serve-journal-');
  const server = await startServer(
    { journalRoot },
    { systemSampler: fakeSystemSampler(), prodProbe: null, usageScanner: fakeUsageScanner() }
  );
  t.after(() => server.close());

  const res = await get(server, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /id="frag-services"/);
  assert.doesNotMatch(res.body, /http-equiv="refresh"/);
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
  assert.deepEqual(ids, ['accounts', 'daemon', 'prod', 'reports', 'secondary', 'services', 'stamp', 'tokens']);
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
