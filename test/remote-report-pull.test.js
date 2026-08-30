'use strict';
// Tests for orchestrator/remote-report-pull.js -- stage 0 of the human-first bug-report
// pipeline: shouldPullRemoteReports' pure timer decision, isSafeReportFilename/readPullToken's
// helpers, and runRemoteReportPull's list -> fetch -> land -> ack wiring. Every HTTPS call is
// injected via deps.http = {httpRequest}, the seam orchestrator/http.js itself declares --
// no real socket is ever opened, matching this repo's deps.spawnSync convention one layer up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { mkTmp } = require('./helpers');
const {
  shouldPullRemoteReports,
  runRemoteReportPull,
  isSafeReportFilename,
  readPullToken,
  DEFAULT_REMOTE_PULL_MS,
  DEFAULT_REMOTE_PULL_LIMIT,
} = require('../orchestrator/remote-report-pull');
const { appendDaemonEvent } = require('../orchestrator/journal');

const TOKEN = 'a'.repeat(32);
const FILE_A = '2026-08-24T09-15-00-123Z_desktop_a1b2c3d4.json';
const FILE_B = '2026-08-24T09-16-00-456Z_mobile_e5f6a7b8.json';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fakeHttp(responder) {
  const calls = [];
  return {
    calls,
    httpRequest: async (url, opts) => {
      calls.push({ url, opts });
      return responder(url, opts);
    },
  };
}

function ok(status, bodyObjOrBuf, headers = {}) {
  const body = Buffer.isBuffer(bodyObjOrBuf) ? bodyObjOrBuf : Buffer.from(JSON.stringify(bodyObjOrBuf));
  return { status, headers, body, truncated: false };
}

// ---- shouldPullRemoteReports -----------------------------------------------------------------

test('shouldPullRemoteReports: disabled at 0, due immediately when never run, respects the interval', () => {
  assert.equal(shouldPullRemoteReports(null, Date.now(), 0), false);
  assert.equal(shouldPullRemoteReports(null, 1000, 300000), true);
  assert.equal(shouldPullRemoteReports(1_000_000, 1_050_000, 300000), false);
  assert.equal(shouldPullRemoteReports(1_000_000, 1_300_000, 300000), true);
});

test('defaults: 5 min pull / limit 5', () => {
  assert.equal(DEFAULT_REMOTE_PULL_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_REMOTE_PULL_LIMIT, 5);
});

// ---- isSafeReportFilename / readPullToken ------------------------------------------------------

test('isSafeReportFilename: accepts the exact deposit shape, rejects a traversal/garbage name', () => {
  assert.equal(isSafeReportFilename(FILE_A), true);
  assert.equal(isSafeReportFilename('../../etc/passwd'), false);
  assert.equal(isSafeReportFilename('pulled/x.json'), false);
  assert.equal(isSafeReportFilename(''), false);
  assert.equal(isSafeReportFilename(null), false);
});

test('readPullToken: reads and trims a valid token, null on missing file or a too-short token', () => {
  const dir = mkTmp('spo-pulltoken-');
  const tokenFile = path.join(dir, '.pull-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  assert.equal(readPullToken(tokenFile), TOKEN);
  assert.equal(readPullToken(path.join(dir, 'missing')), null);

  fs.writeFileSync(tokenFile, 'short');
  assert.equal(readPullToken(tokenFile), null);
});

// ---- runRemoteReportPull ------------------------------------------------------------------------

function baseConfig(spoReportsDir, overrides = {}) {
  return { spoReportsDir, remoteReportUrl: 'https://example.test/api/report-pull', ...overrides };
}

test('runRemoteReportPull: no remoteReportUrl -> skipped no-url, no http call', async () => {
  const journalRoot = mkTmp('spo-pull-journal1-');
  const http = fakeHttp(() => { throw new Error('should not be called'); });
  const result = await runRemoteReportPull(journalRoot, { spoReportsDir: mkTmp('spo-pull-q1-'), remoteReportUrl: null }, { http });
  assert.equal(result.skipped, 'no-url');
  assert.equal(http.calls.length, 0);
});

test('runRemoteReportPull: no readable token -> skipped no-token, no http call', async () => {
  const journalRoot = mkTmp('spo-pull-journal2-');
  const http = fakeHttp(() => { throw new Error('should not be called'); });
  const config = baseConfig(mkTmp('spo-pull-q2-'));
  const result = await runRemoteReportPull(journalRoot, config, { http, token: null });
  assert.equal(result.skipped, 'no-token');
  assert.equal(http.calls.length, 0);
});

test('runRemoteReportPull: refuses a non-https URL', async () => {
  const journalRoot = mkTmp('spo-pull-journal3-');
  const config = baseConfig(mkTmp('spo-pull-q3-'), { remoteReportUrl: 'http://example.test' });
  const result = await runRemoteReportPull(journalRoot, config, { http: fakeHttp(() => ok(200, {})), token: TOKEN });
  assert.equal(result.ok, false);
  assert.match(result.error, /https/);
});

test('runRemoteReportPull: queue already at ceiling -> skipped, no http call', async () => {
  const journalRoot = mkTmp('spo-pull-journal4-');
  const spoReportsDir = mkTmp('spo-pull-q4-');
  fs.writeFileSync(path.join(spoReportsDir, 'x.json'), '{}');
  const config = baseConfig(spoReportsDir, { remoteReportQueueCeiling: 1 });
  const http = fakeHttp(() => { throw new Error('should not be called'); });
  const result = await runRemoteReportPull(journalRoot, config, { http, token: TOKEN });
  assert.equal(result.skipped, 'queue-ceiling');
  assert.equal(http.calls.length, 0);
});

test('runRemoteReportPull: happy path -- lists, fetches, verifies sha256, writes atomically, acks, journals', async () => {
  const journalRoot = mkTmp('spo-pull-journal5-');
  const spoReportsDir = mkTmp('spo-pull-q5-');
  const bytes = Buffer.from('{"version":1}');
  const hash = sha256(bytes);

  const http = fakeHttp((url, opts) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: FILE_A, bytes: bytes.length, sha256: hash }] });
    if (url.includes('/fetch')) return ok(200, bytes);
    if (url.endsWith('/ack')) return ok(200, { ok: true });
    throw new Error(`unexpected url ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });

  assert.equal(result.ok, true);
  assert.equal(result.pulled, 1);
  assert.equal(result.acked, 1);
  assert.equal(result.rejected, 0);
  assert.equal(fs.readFileSync(path.join(spoReportsDir, FILE_A), 'utf8'), bytes.toString('utf8'));
  assert.equal(fs.existsSync(path.join(spoReportsDir, `${FILE_A}.part`)), false); // atomic rename, no leftover

  const authHeader = http.calls[0].opts.headers.Authorization;
  assert.equal(authHeader, `Bearer ${TOKEN}`);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"remote-report-pulled"/);
  assert.match(daemonLog, /"event":"remote-report-acked"/);
});

test('runRemoteReportPull: already-acked filename (per daemon.jsonl) is skipped entirely, no fetch', async () => {
  const journalRoot = mkTmp('spo-pull-journal6-');
  const spoReportsDir = mkTmp('spo-pull-q6-');
  appendDaemonEvent(journalRoot, 'remote-report-acked', { file: FILE_A });

  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: FILE_A, bytes: 10, sha256: 'x' }] });
    throw new Error(`should not fetch/ack an already-acked file: ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });
  assert.equal(result.pulled, 0);
  assert.equal(result.acked, 0);
});

test('runRemoteReportPull: unsafe filename from the list reply is rejected, never fetched', async () => {
  const journalRoot = mkTmp('spo-pull-journal7-');
  const spoReportsDir = mkTmp('spo-pull-q7-');
  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: '../evil.json', bytes: 10, sha256: 'x' }] });
    throw new Error(`should not fetch an unsafe filename: ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });
  assert.equal(result.rejected, 1);
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"reason":"unsafe-filename"/);
});

test('runRemoteReportPull: an entry over remoteReportMaxBytes is rejected without ever fetching', async () => {
  const journalRoot = mkTmp('spo-pull-journal8-');
  const spoReportsDir = mkTmp('spo-pull-q8-');
  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: FILE_A, bytes: 999999999, sha256: 'x' }] });
    throw new Error(`should not fetch an oversize entry: ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir, { remoteReportMaxBytes: 100 }), { http, token: TOKEN });
  assert.equal(result.rejected, 1);
});

test('runRemoteReportPull: a sha256 mismatch on fetch is rejected, nothing written, no ack', async () => {
  const journalRoot = mkTmp('spo-pull-journal9-');
  const spoReportsDir = mkTmp('spo-pull-q9-');
  const bytes = Buffer.from('{"tampered":true}');
  let ackCalled = false;

  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: FILE_A, bytes: bytes.length, sha256: 'not-the-real-hash' }] });
    if (url.includes('/fetch')) return ok(200, bytes);
    if (url.endsWith('/ack')) { ackCalled = true; return ok(200, { ok: true }); }
    throw new Error(`unexpected url ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });
  assert.equal(result.rejected, 1);
  assert.equal(ackCalled, false);
  assert.equal(fs.existsSync(path.join(spoReportsDir, FILE_A)), false);
});

test('runRemoteReportPull: an ack failure leaves the file local, journals remote-report-ack-failed, reported in errors', async () => {
  const journalRoot = mkTmp('spo-pull-journal10-');
  const spoReportsDir = mkTmp('spo-pull-q10-');
  const bytes = Buffer.from('{"a":1}');
  const hash = sha256(bytes);

  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: FILE_A, bytes: bytes.length, sha256: hash }] });
    if (url.includes('/fetch')) return ok(200, bytes);
    if (url.endsWith('/ack')) return ok(500, { error: 'boom' });
    throw new Error(`unexpected url ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });
  assert.equal(result.pulled, 1);
  assert.equal(result.acked, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(fs.existsSync(path.join(spoReportsDir, FILE_A)), true); // still local -- not lost
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"remote-report-ack-failed"/);
});

test('runRemoteReportPull: a file already local from a prior failed ack retries the ack ONLY, never re-fetches', async () => {
  const journalRoot = mkTmp('spo-pull-journal11-');
  const spoReportsDir = mkTmp('spo-pull-q11-');
  fs.writeFileSync(path.join(spoReportsDir, FILE_A), '{"a":1}');
  appendDaemonEvent(journalRoot, 'remote-report-pulled', { file: FILE_A, sha256: 'whatever' });
  // no remote-report-acked yet -- simulates the prior cycle's ack failing

  let fetchCalled = false;
  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: FILE_A, bytes: 10, sha256: 'whatever' }] });
    if (url.includes('/fetch')) { fetchCalled = true; return ok(200, Buffer.from('{}')); }
    if (url.endsWith('/ack')) return ok(200, { ok: true, already: true });
    throw new Error(`unexpected url ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });
  assert.equal(fetchCalled, false);
  assert.equal(result.acked, 1);
});

test('runRemoteReportPull: a list reply exceeding remoteReportPullLimit only pulls the top N', async () => {
  const journalRoot = mkTmp('spo-pull-journal12-');
  const spoReportsDir = mkTmp('spo-pull-q12-');
  const reports = [FILE_A, FILE_B].map((f) => ({ file: f, bytes: 2, sha256: sha256(Buffer.from('{}')) }));

  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports });
    if (url.includes('/fetch')) return ok(200, Buffer.from('{}'));
    if (url.endsWith('/ack')) return ok(200, { ok: true });
    throw new Error(`unexpected url ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir, { remoteReportPullLimit: 1 }), { http, token: TOKEN });
  assert.equal(result.pulled, 1);
});
