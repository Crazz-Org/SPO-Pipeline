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
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
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

// ---- card #137 (Lot 3, 3.2b + repair round): the write+rename that lands a fetched report
//      locally used to sit outside every try/catch in this loop -- unlike the fetch immediately
//      above it, whose own try/catch already treats a failure as one candidate's problem. A throw
//      here used to abort the whole `for` loop, costing every remaining candidate in the cycle,
//      not just the one that failed. Repair round: verification measured that in daemon mode
//      (startRemoteReportPullLoop's tick(), the only caller that actually runs continuously) the
//      `errors` array this function returns has no reader at all -- only `bin/spo`'s interactive
//      cmdPullReports prints it -- so BOTH the fetch catch and the write+rename catch now also
//      journal `remote-report-land-failed` (`stage: 'fetch'` | `'land'`), not just errors.push.
//      Every failure below is injected via a real fs.renameSync/fs.mkdirSync/http throw scoped to
//      one candidate, never by calling a guard's own catch block directly. --------------------

test('runRemoteReportPull: a renameSync failure landing one file costs only that file -- the next candidate is still pulled AND acked', async () => {
  const journalRoot = mkTmp('spo-pull-journal13-');
  const spoReportsDir = mkTmp('spo-pull-q13-');
  const bytes = Buffer.from('{}');
  const hash = sha256(bytes);
  const reports = [FILE_A, FILE_B].map((f) => ({ file: f, bytes: bytes.length, sha256: hash }));
  const acked = [];

  // Tracks which file each /ack call was for, from the request body -- runRemoteReportPull's own
  // ack call carries `file` in its JSON body, not the URL.
  const httpWithAckTracking = fakeHttp((url, opts) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports });
    if (url.includes('/fetch')) return ok(200, bytes);
    if (url.endsWith('/ack')) {
      acked.push(JSON.parse(opts.body).file);
      return ok(200, { ok: true });
    }
    throw new Error(`unexpected url ${url}`);
  });

  const realRename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => {
    if (String(to) === path.join(spoReportsDir, FILE_A)) {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    }
    return realRename(from, to, ...rest);
  };
  let result;
  try {
    result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http: httpWithAckTracking, token: TOKEN });
  } finally {
    fs.renameSync = realRename;
  }

  // FILE_A: cost exactly its own candidate -- not pulled, not acked, recorded in errors AND now
  // journalled (repair round -- `errors` alone is invisible in daemon mode).
  assert.equal(fs.existsSync(path.join(spoReportsDir, FILE_A)), false, 'FILE_A never landed -- the write failed exactly as injected');
  assert.equal(fs.existsSync(path.join(spoReportsDir, `${FILE_A}.part`)), true, 'the .part file is deliberately left behind -- see the source comment');
  assert.ok(
    result.errors.some((e) => e.file === FILE_A && /EPERM/.test(e.error)),
    'FILE_A\'s renameSync failure must be recorded in errors -- the throw would otherwise have been silent'
  );
  assert.ok(!acked.includes(FILE_A), 'FILE_A must not be acked -- it never actually landed');

  // FILE_B: the whole point of this test -- a single candidate could not tell `continue` from
  // `break`. FILE_B must still be pulled AND acked despite FILE_A's failure earlier in the loop.
  assert.equal(fs.readFileSync(path.join(spoReportsDir, FILE_B), 'utf8'), bytes.toString('utf8'), 'FILE_B must still have been pulled');
  assert.ok(acked.includes(FILE_B), 'FILE_B must still have been acked');

  assert.equal(result.pulled, 1);
  assert.equal(result.acked, 1);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.doesNotMatch(daemonLog, new RegExp(`"event":"remote-report-pulled","file":"${FILE_A}"`), 'FILE_A must not be journalled as pulled');
  assert.match(daemonLog, new RegExp(`"event":"remote-report-pulled","file":"${FILE_B}"`), 'FILE_B must be journalled as pulled');
  assert.match(
    daemonLog,
    new RegExp(`"event":"remote-report-land-failed","file":"${FILE_A}","error":"[^"]*EPERM[^"]*","stage":"land"`),
    'FILE_A\'s renameSync failure must be journalled as remote-report-land-failed, stage land -- daemon mode has no other reader of `errors`'
  );
});

test('runRemoteReportPull: a mkdirSync failure preparing spoReportsDir is recorded the same way as a renameSync failure', async () => {
  const journalRoot = mkTmp('spo-pull-journal14-');
  const spoReportsDir = mkTmp('spo-pull-q14-');
  const bytes = Buffer.from('{}');
  const hash = sha256(bytes);

  const http = fakeHttp((url) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports: [{ file: FILE_A, bytes: bytes.length, sha256: hash }] });
    if (url.includes('/fetch')) return ok(200, bytes);
    throw new Error(`should not ack when the write never happened: ${url}`);
  });

  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = (p, ...rest) => {
    if (String(p) === spoReportsDir) {
      const err = new Error('EACCES: permission denied, mkdir');
      err.code = 'EACCES';
      throw err;
    }
    return realMkdir(p, ...rest);
  };
  let result;
  try {
    result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });
  } finally {
    fs.mkdirSync = realMkdir;
  }

  assert.equal(fs.existsSync(path.join(spoReportsDir, FILE_A)), false);
  assert.ok(
    result.errors.some((e) => e.file === FILE_A && /EACCES/.test(e.error)),
    'the guard must cover mkdirSync, not just renameSync -- both statements of the write can fail independently'
  );
  assert.equal(result.pulled, 0);
  assert.equal(result.acked, 0);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(
    daemonLog,
    new RegExp(`"event":"remote-report-land-failed","file":"${FILE_A}","error":"[^"]*EACCES[^"]*","stage":"land"`),
    'an mkdirSync failure must be journalled with stage land too, same as renameSync'
  );
});

test('runRemoteReportPull: a fetch failure is journalled as remote-report-land-failed (stage: fetch), and the next candidate is still pulled AND acked', async () => {
  const journalRoot = mkTmp('spo-pull-journal17-');
  const spoReportsDir = mkTmp('spo-pull-q17-');
  const bytes = Buffer.from('{}');
  const hash = sha256(bytes);
  const reports = [FILE_A, FILE_B].map((f) => ({ file: f, bytes: bytes.length, sha256: hash }));
  const acked = [];

  const http = fakeHttp((url, opts) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports });
    if (url.includes('/fetch')) {
      if (url.includes(encodeURIComponent(FILE_A))) {
        const err = new Error('ECONNRESET: socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      return ok(200, bytes);
    }
    if (url.endsWith('/ack')) {
      acked.push(JSON.parse(opts.body).file);
      return ok(200, { ok: true });
    }
    throw new Error(`unexpected url ${url}`);
  });

  const result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });

  // FILE_A: the fetch itself never landed any bytes -- recorded in errors AND journalled, same
  // shape as a land-stage failure, distinguished only by `stage`.
  assert.equal(fs.existsSync(path.join(spoReportsDir, FILE_A)), false);
  assert.ok(
    result.errors.some((e) => e.file === FILE_A && /ECONNRESET/.test(e.error)),
    'FILE_A\'s fetch failure must be recorded in errors'
  );
  assert.ok(!acked.includes(FILE_A));

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(
    daemonLog,
    new RegExp(`"event":"remote-report-land-failed","file":"${FILE_A}","error":"[^"]*ECONNRESET[^"]*","stage":"fetch"`),
    'FILE_A\'s fetch failure must be journalled with stage fetch -- a fetch failure was silent in daemon mode before this repair round'
  );

  // FILE_B: batch survives a fetch failure exactly as it survives a land failure.
  assert.equal(fs.readFileSync(path.join(spoReportsDir, FILE_B), 'utf8'), bytes.toString('utf8'));
  assert.ok(acked.includes(FILE_B));
  assert.equal(result.pulled, 1);
  assert.equal(result.acked, 1);
});

// Verification precedent (card #137, 3.2a's own defect class): appendDaemonEvent does its own
// mkdirSync + appendFileSync, so on the EXACT filesystem-level failure the land catch exists for
// (ENOSPC/EPERM/EROFS), that write can throw too. TWO candidates on purpose -- M2 (verification's
// own mutation) proved a single-candidate version of this test cannot tell `continue` from `break`
// when the guard is defeated: FILE_A's own journal write is made to fail exactly once (the daemon
// log did not exist yet, so this is deterministically its first append), FILE_B's own successful
// `remote-report-pulled`/`remote-report-acked` writes are left alone so the test can tell "FILE_B
// still landed" apart from "the whole log is broken".
test('runRemoteReportPull: a land failure whose OWN journal write also fails does not reject the whole call -- the next candidate is still pulled AND acked', async () => {
  const journalRoot = mkTmp('spo-pull-journal18-');
  const spoReportsDir = mkTmp('spo-pull-q18-');
  const bytes = Buffer.from('{}');
  const hash = sha256(bytes);
  const reports = [FILE_A, FILE_B].map((f) => ({ file: f, bytes: bytes.length, sha256: hash }));
  const acked = [];

  const http = fakeHttp((url, opts) => {
    if (url.endsWith('/list')) return ok(200, { ok: true, reports });
    if (url.includes('/fetch')) return ok(200, bytes);
    if (url.endsWith('/ack')) {
      acked.push(JSON.parse(opts.body).file);
      return ok(200, { ok: true });
    }
    throw new Error(`unexpected url ${url}`);
  });

  const realRename = fs.renameSync;
  const realAppendFile = fs.appendFileSync;
  fs.renameSync = (from, to, ...rest) => {
    if (String(to) === path.join(spoReportsDir, FILE_A)) {
      const err = new Error('ENOSPC: no space left on device, rename');
      err.code = 'ENOSPC';
      throw err;
    }
    return realRename(from, to, ...rest);
  };
  let daemonAppendCalls = 0;
  fs.appendFileSync = (p, ...rest) => {
    if (String(p).endsWith('daemon.jsonl')) {
      daemonAppendCalls += 1;
      // FILE_A is processed first and its renameSync failure is the very first daemon.jsonl
      // append attempted this run -- fail ONLY that one, so FILE_B's own (successful) journal
      // writes are left intact and provable.
      if (daemonAppendCalls === 1) {
        const err = new Error('ENOSPC: no space left on device, write');
        err.code = 'ENOSPC';
        throw err;
      }
    }
    return realAppendFile(p, ...rest);
  };

  let result;
  let threw = null;
  try {
    result = await runRemoteReportPull(journalRoot, baseConfig(spoReportsDir), { http, token: TOKEN });
  } catch (err) {
    threw = err;
  } finally {
    fs.renameSync = realRename;
    fs.appendFileSync = realAppendFile;
  }

  assert.equal(threw, null, `runRemoteReportPull must not reject even when its own journal write also fails: ${threw && threw.message}`);
  // Sanity on the injection itself: FILE_A's land-failed attempt (the one made to fail) plus
  // FILE_B's own pulled+acked writes (left alone) -- 3 total appends attempted against daemon.jsonl.
  assert.equal(daemonAppendCalls, 3, 'sanity: expected exactly 3 daemon.jsonl append attempts (FILE_A land-failed + FILE_B pulled + FILE_B acked)');

  // FILE_A: never landed, never acked -- both its own failures were swallowed, not escaped.
  assert.equal(fs.existsSync(path.join(spoReportsDir, FILE_A)), false);
  assert.ok(!acked.includes(FILE_A));

  // FILE_B: the whole point -- a single-candidate version of this test cannot tell `continue`
  // from `break` when the guard is defeated. FILE_B must still be pulled AND acked, AND its own
  // journal writes (unaffected by the one-shot append failure above) must be present.
  assert.equal(fs.readFileSync(path.join(spoReportsDir, FILE_B), 'utf8'), bytes.toString('utf8'));
  assert.ok(acked.includes(FILE_B));
  assert.equal(result.pulled, 1);
  assert.equal(result.acked, 1);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, new RegExp(`"event":"remote-report-pulled","file":"${FILE_B}"`), 'FILE_B\'s own journal writes must have gone through normally');
  assert.doesNotMatch(daemonLog, new RegExp(`"file":"${FILE_A}"`), 'FILE_A\'s own journal write failed too -- nothing about it landed in daemon.jsonl');
});
