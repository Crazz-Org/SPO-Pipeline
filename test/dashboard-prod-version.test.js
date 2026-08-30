'use strict';
// console/prod-version.js -- the starpeace.zz.works probe. `http` is always a fake here: this
// suite makes ZERO real network calls.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProdProbe } = require('../console/prod-version');

function jsonBody(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

test('a healthy site + matching /healthz + matching release => up, exposed, match', async () => {
  const http = {
    httpRequest: async (url) => {
      if (url.includes('api.github.com')) {
        return { status: 200, headers: {}, body: jsonBody({ tag_name: 'v1.2.3', published_at: '2026-08-29T00:00:00Z' }) };
      }
      return { status: 200, headers: {}, body: jsonBody({ version: '1.2.3' }) };
    },
  };
  const probe = createProdProbe({ healthPath: '/healthz', http });
  const snap = await probe.refresh();

  assert.equal(snap.site.status, 'up');
  assert.equal(snap.deployed.exposed, true);
  assert.equal(snap.deployed.version, '1.2.3');
  assert.equal(snap.expected.version, '1.2.3');
  assert.equal(snap.drift, 'match');
});

test('a diverging /healthz version is flagged as diverged', async () => {
  const http = {
    httpRequest: async (url) => {
      if (url.includes('api.github.com')) return { status: 200, headers: {}, body: jsonBody({ tag_name: 'v1.2.3' }) };
      return { status: 200, headers: {}, body: jsonBody({ version: '1.2.2' }) };
    },
  };
  const probe = createProdProbe({ healthPath: '/healthz', http });
  const snap = await probe.refresh();
  assert.equal(snap.drift, 'diverged');
});

test('no healthPath configured => deployed stays unexposed and drift stays unknown', async () => {
  const http = {
    httpRequest: async (url) => {
      if (url.includes('api.github.com')) return { status: 200, headers: {}, body: jsonBody({ tag_name: 'v1.2.3' }) };
      return { status: 200, headers: {}, body: Buffer.from('OK') };
    },
  };
  const probe = createProdProbe({ healthPath: null, http });
  const snap = await probe.refresh();
  assert.equal(snap.deployed.exposed, false);
  assert.equal(snap.drift, 'unknown');
});

test('a rejected site request never throws, maps to down, and never leaks the URL/message', async () => {
  const http = {
    httpRequest: async (url) => {
      if (url.includes('api.github.com')) return { status: 200, headers: {}, body: jsonBody({ tag_name: 'v1.0.0' }) };
      const err = new Error('connect ECONNREFUSED https://starpeace.zz.works:443');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  };
  const probe = createProdProbe({ http });
  const snap = await probe.refresh();

  assert.equal(snap.site.status, 'down');
  assert.equal(snap.site.error, 'refused');
  const dump = JSON.stringify(snap);
  assert.doesNotMatch(dump, /starpeace/);
  assert.doesNotMatch(dump, /ECONNREFUSED/);
});

test('a 403 from the releases API preserves the previously known expected version', async () => {
  let call = 0;
  const http = {
    httpRequest: async (url) => {
      if (url.includes('api.github.com')) {
        call++;
        if (call === 1) return { status: 200, headers: {}, body: jsonBody({ tag_name: 'v2.0.0' }) };
        return { status: 403, headers: {}, body: Buffer.from('') };
      }
      return { status: 200, headers: {}, body: Buffer.from('OK') };
    },
  };
  const probe = createProdProbe({ http });
  await probe.refresh();
  assert.equal(probe.snapshot().expected.version, '2.0.0');

  await probe.refresh();
  assert.equal(probe.snapshot().expected.version, '2.0.0'); // preserved, not wiped by the 403
  assert.equal(probe.snapshot().expected.status, 'rate-limited');
});

test('snapshot() before any refresh() returns a complete object with checkedAt: null', () => {
  const probe = createProdProbe({ http: { httpRequest: async () => ({ status: 200, headers: {}, body: Buffer.from('') }) } });
  const snap = probe.snapshot();
  assert.equal(snap.checkedAt, null);
  assert.equal(snap.site.status, 'unknown');
  assert.equal(snap.drift, 'unknown');
});
