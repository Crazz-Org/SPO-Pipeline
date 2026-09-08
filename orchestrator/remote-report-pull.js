'use strict';
// remote-report-pull.js -- stage 0 of the human-first bug-report pipeline: pulls queued reports
// from a production server's own bug-report store over HTTPS, deposits them into the LOCAL
// config.spoReportsDir, and leaves everything downstream (report-intake.js's runReportIntake)
// completely unchanged -- it never knows or cares whether a report arrived locally or was pulled
// from production. See orchestrator/README.md § Report intake and doc/environments.md's "Flows
// between environments" for the design this implements.
//
// Deliberately a separate driver, not folded into report-intake.js: this is a byte mover with a
// DIFFERENT injection seam (deps.httpRequest, orchestrator/http.js) than every other real-mode
// call in this repo (deps.spawnSync). Keeping it separate means report-intake.js's own tests
// never need to know an HTTP client exists.
//
// "The one rule", worked through concretely: this file never parses report CONTENT. It reads a
// transport envelope (filename, byte count, sha256) from the production `list` route, moves
// bytes it never opens, and verifies only that envelope -- not the report's own schema version,
// which stays exactly where it already was (SPO-WebClient's `npm run report:card`, run later by
// runReportIntake, exits 3 on a mismatch). A malicious or buggy production endpoint is treated as
// hostile input the same way bug-report-endpoint.ts's own MAX_BODY_BYTES already treats an
// inbound POST: capped list size, capped per-file size, no redirects, atomic writes.
//
// Idempotency: the dev machine is authoritative and the ordering is fetch -> land -> ack, so data
// loss is impossible in that order -- the only failure mode is a duplicate fetch, which is cheap.
// "Landed but not yet acked" and "fully done" are both derived from journalRoot/daemon.jsonl's own
// `remote-report-pulled`/`remote-report-acked` events (the same anchor idiom report-intake.js's
// findPendingIntake and auto-triage.js's findConfirmedAwaitingTriage already use) -- no second
// ledger file.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { appendDaemonEvent } = require('./journal');
const { listQueuedReports } = require('./auto-triage');

const DEFAULT_REMOTE_PULL_MS = 5 * 60 * 1000; // inert regardless, until remoteReportUrl+token are both set
const DEFAULT_REMOTE_PULL_LIMIT = 5;
const DEFAULT_REMOTE_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_REMOTE_QUEUE_CEILING = 50;
const LIST_BODY_MAX_BYTES = 64 * 1024;
const HTTP_TIMEOUT_MS = 15000;

// Mirrors report-pull-endpoint.ts's own REPORT_FILENAME_RE exactly -- the pipeline does not
// trust production merely because it holds the bearer token; every filename is re-validated here.
const REPORT_FILENAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(desktop|mobile)_[0-9a-f]+\.json$/;

function isSafeReportFilename(name) {
  return typeof name === 'string' && REPORT_FILENAME_RE.test(name);
}

// Pure decision function, identical shape to shouldAutoPull/shouldAutoIntake/shouldAutoTriage.
function shouldPullRemoteReports(lastAt, nowMs, remoteReportPullMs) {
  if (!(remoteReportPullMs > 0)) return false;
  if (lastAt === null || lastAt === undefined) return true;
  return nowMs - lastAt >= remoteReportPullMs;
}

// readPullToken(tokenFile, deps) -- trimmed file contents, or null if missing/unreadable/empty.
// A short token (<32 chars) is treated as "misconfigured, not set" -- report-pull-endpoint.ts's
// own tokenMatches() applies the identical floor, so a truncated paste fails the same way on
// both ends instead of silently sending a weak credential.
function readPullToken(tokenFile, deps = {}) {
  const fsImpl = deps.fs || fs;
  try {
    const raw = fsImpl.readFileSync(tokenFile, 'utf8').trim();
    return raw.length >= 32 ? raw : null;
  } catch {
    return null;
  }
}

function readDaemonEvents(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
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
}

function ackedFilenames(journalRoot) {
  const acked = new Set();
  for (const e of readDaemonEvents(journalRoot)) {
    if (e.event === 'remote-report-acked' && typeof e.file === 'string') acked.add(e.file);
  }
  return acked;
}

async function httpJson(http, url, headers) {
  const result = await http.httpRequest(url, {
    method: 'GET',
    headers,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxBytes: LIST_BODY_MAX_BYTES,
  });
  if (result.truncated) throw new Error(`remote-report-pull: list response exceeded ${LIST_BODY_MAX_BYTES} bytes`);
  if (result.status !== 200) throw new Error(`remote-report-pull: list answered ${result.status}`);
  return JSON.parse(result.body.toString('utf8'));
}

// runRemoteReportPull(journalRoot, config, deps) -- pulls at most config.remoteReportPullLimit
// reports the production store's `list` route names, that this pipeline has not already fully
// acked (per daemon.jsonl). Inert (returns {ok:true, skipped:'no-url'|'no-token'}) when
// config.remoteReportUrl or the token file is unset -- the safe default this timer relies on.
// Never throws for a recognized failure (network error, bad JSON, hash mismatch, oversize) --
// those are collected in `errors`/`rejected` and retried next cycle.
async function runRemoteReportPull(journalRoot, config, deps = {}) {
  const spoReportsDir = config.spoReportsDir;
  const remoteReportUrl = config.remoteReportUrl;
  if (!remoteReportUrl) return { ok: true, skipped: 'no-url', pulled: 0, acked: 0, rejected: 0, errors: [] };
  if (!/^https:\/\//.test(remoteReportUrl)) {
    return { ok: false, error: `remote-report-pull: remoteReportUrl must be https:// (got "${remoteReportUrl}")` };
  }

  const tokenFile = config.remoteReportTokenFile || path.join(os.homedir(), '.spo-reports', '.pull-token');
  const token = deps.token !== undefined ? deps.token : readPullToken(tokenFile, deps);
  if (!token) return { ok: true, skipped: 'no-token', pulled: 0, acked: 0, rejected: 0, errors: [] };

  const ceiling = config.remoteReportQueueCeiling || DEFAULT_REMOTE_QUEUE_CEILING;
  if (listQueuedReports(spoReportsDir).length >= ceiling) {
    return { ok: true, skipped: 'queue-ceiling', pulled: 0, acked: 0, rejected: 0, errors: [] };
  }

  const http = deps.http || require('./http');
  const headers = { Authorization: `Bearer ${token}` };
  const limit = config.remoteReportPullLimit || DEFAULT_REMOTE_PULL_LIMIT;
  const maxBytes = config.remoteReportMaxBytes || DEFAULT_REMOTE_MAX_BYTES;

  let listed;
  try {
    listed = await httpJson(http, `${remoteReportUrl}/list`, headers);
  } catch (err) {
    return { ok: false, error: `remote-report-pull: ${err.message}` };
  }
  if (!listed || !Array.isArray(listed.reports)) {
    return { ok: false, error: 'remote-report-pull: list reply missing a reports array' };
  }

  const alreadyAcked = ackedFilenames(journalRoot);
  const candidates = listed.reports.filter((r) => !alreadyAcked.has(r && r.file)).slice(0, limit);

  let pulled = 0;
  let acked = 0;
  let rejected = 0;
  const errors = [];

  for (const entry of candidates) {
    const file = entry && entry.file;
    if (!isSafeReportFilename(file)) {
      rejected++;
      appendDaemonEvent(journalRoot, 'remote-report-rejected', { file, reason: 'unsafe-filename' });
      continue;
    }
    if (typeof entry.bytes === 'number' && entry.bytes > maxBytes) {
      rejected++;
      appendDaemonEvent(journalRoot, 'remote-report-rejected', { file, reason: 'oversize', bytes: entry.bytes });
      continue;
    }

    const localPath = path.join(spoReportsDir, file);
    const alreadyLocal = fs.existsSync(localPath);

    if (!alreadyLocal) {
      // card #137 repair round (Lot 3, 3.2b): this catch used to be errors.push + continue with no
      // journal write of its own, matched to look consistent with the write+rename catch below it
      // -- but `errors` has exactly one reader in the whole repo, `bin/spo`'s cmdPullReports (the
      // interactive CLI path). `startRemoteReportPullLoop`'s tick() only ever inspects
      // `result.ok`, which this function returns true regardless of any per-file errors -- so in
      // daemon mode, where this loop actually runs continuously, a fetch failure was exactly as
      // invisible as the land failure below used to be. The closer sibling was never this catch's
      // OWN silence, it was `remote-report-ack-failed` three statements down: an ack failure
      // already journals. Both directions of "this file did not land locally this cycle" now do
      // too, distinguished by `stage` on the SAME event name (see the write+rename catch below for
      // why one event name, not two).
      let fetched;
      try {
        fetched = await http.httpRequest(`${remoteReportUrl}/fetch?file=${encodeURIComponent(file)}`, {
          method: 'GET',
          headers,
          timeoutMs: HTTP_TIMEOUT_MS,
          maxBytes,
        });
      } catch (err) {
        errors.push({ file, error: err.message });
        // Verification precedent (card #137, 3.2a): appendDaemonEvent does its own mkdirSync +
        // appendFileSync, so on the exact filesystem-level failure a NEIGHBORING catch in this
        // same loop exists for, that write can throw too. This catch is reached by a NETWORK
        // failure, not a filesystem one, but the guard costs nothing and keeps every appendDaemonEvent
        // call site in this function held to the same never-let-it-escape standard. Best-effort;
        // never let this escape either way.
        try {
          appendDaemonEvent(journalRoot, 'remote-report-land-failed', { file, error: err.message, stage: 'fetch' });
        } catch {
          // Nothing left to record to -- never let this reach the drain loop either.
        }
        continue; // retried next cycle
      }
      if (fetched.status !== 200 || fetched.truncated) {
        rejected++;
        appendDaemonEvent(journalRoot, 'remote-report-rejected', {
          file,
          reason: fetched.truncated ? 'oversize-body' : `fetch-status-${fetched.status}`,
        });
        continue;
      }
      const gotSha = require('crypto').createHash('sha256').update(fetched.body).digest('hex');
      if (entry.sha256 && gotSha !== entry.sha256) {
        rejected++;
        appendDaemonEvent(journalRoot, 'remote-report-rejected', { file, reason: 'sha256-mismatch' });
        continue;
      }

      // card #137 (Lot 3, 3.2b): this write+rename used to sit outside every try/catch in this
      // loop -- unlike the fetch immediately above, whose own try/catch already treats a failure
      // as one candidate's problem (errors.push + continue), a throw here (EXDEV/EPERM/ENOSPC
      // landing bytes into spoReportsDir) used to escape the whole `for` loop, aborting
      // runRemoteReportPull for every remaining candidate this cycle -- one bad filesystem write
      // costing the entire batch, not just this file. All three statements (mkdirSync,
      // writeFileSync, renameSync) are covered, the same way card #137's own claim guard in
      // state-machine.js covers both of ITS statements: mkdirSync succeeding while renameSync
      // fails is exactly as reachable as the reverse. On failure this now journals
      // `remote-report-land-failed` with `stage: 'land'` -- the SAME event name the fetch catch
      // above uses with `stage: 'fetch'`, one pipeline-stage name (list -> fetch -> land -> ack)
      // rather than two near-duplicate events for "this file did not land locally this cycle". A
      // `.part` file can be left behind on a renameSync failure -- deliberately not cleaned up,
      // same posture as journal.js's writeState leaving its own tmp file on a crash:
      // `listQueuedReports` only ever globs `*.json`, never `*.part`, so it is inert to every
      // reader, and this exact writeFileSync overwrites it outright the next time this same file
      // is retried -- there is nothing here that isn't already handled by the next cycle.
      const partPath = `${localPath}.part`;
      try {
        fs.mkdirSync(spoReportsDir, { recursive: true });
        fs.writeFileSync(partPath, fetched.body);
        fs.renameSync(partPath, localPath); // atomic -- listQueuedReports never sees a half file
      } catch (err) {
        errors.push({ file, error: err.message });
        // Verification fix (card #137, 3.2a's own defect class): appendDaemonEvent does its own
        // mkdirSync + appendFileSync -- on the EXACT filesystem-level failure this catch exists
        // for (ENOSPC/EPERM/EROFS), that write can throw too, and an unwrapped call here would let
        // THAT throw escape the whole `for` loop right back into the failure this catch exists to
        // contain. Best-effort; never let this escape either way.
        try {
          appendDaemonEvent(journalRoot, 'remote-report-land-failed', { file, error: err.message, stage: 'land' });
        } catch {
          // Nothing left to record to -- never let this reach the drain loop either.
        }
        continue; // retried next cycle -- the remaining candidates in THIS cycle are unaffected
      }
      appendDaemonEvent(journalRoot, 'remote-report-pulled', { file, sha256: gotSha });
      pulled++;
    }

    // Ack regardless of whether this cycle just downloaded the file or found it already local
    // from a prior cycle whose ack failed -- production's ack is idempotent (200 {already:true}).
    try {
      const ackResult = await http.httpRequest(`${remoteReportUrl}/ack`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, sha256: entry.sha256 || '' }),
        timeoutMs: HTTP_TIMEOUT_MS,
        maxBytes: LIST_BODY_MAX_BYTES,
      });
      if (ackResult.status !== 200) throw new Error(`ack answered ${ackResult.status}`);
      appendDaemonEvent(journalRoot, 'remote-report-acked', { file });
      acked++;
    } catch (err) {
      errors.push({ file, error: `ack failed: ${err.message}` });
      appendDaemonEvent(journalRoot, 'remote-report-ack-failed', { file, error: err.message });
    }
  }

  return { ok: true, listed: listed.reports.length, pulled, acked, rejected, errors };
}

// startRemoteReportPullLoop(journalRoot, config, deps) -- runs runRemoteReportPull on its OWN
// setTimeout chain, independent of runForever's `for (;;) { await drainQueueOnce(...); ... }`
// loop. Why: that loop only reaches its timer checks once drainQueueOnce resolves, so a single
// long-running task (a gate/bench run, say) starves this pull for as long as the task takes --
// observed live 2026-08-30, a report sitting on production for hours because the daemon's task
// loop never came up for air. Pulling is deliberately cheap and idempotent (see this file's own
// header on ordering/dedup), so the fix leans into that: fire once immediately (also covers the
// post-restart case -- no need to persist lastAt across a restart) and again every
// remoteReportPullMs after, forever, regardless of what the task loop is doing. An extra pull
// racing the task loop's own timer-gated call is harmless (ackedFilenames dedups), so this
// REPLACES that call in runForever rather than running alongside it.
// Never lets a failure (network, bad JSON, misconfiguration) go unlogged -- state-machine.js's
// old call site awaited runRemoteReportPull without ever checking `ok`, so a `{ok:false}` was
// previously silent; this loop journals it every time.
function startRemoteReportPullLoop(journalRoot, config, deps = {}) {
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const result = await runRemoteReportPull(journalRoot, config, deps);
      if (result && result.ok === false) {
        appendDaemonEvent(journalRoot, 'remote-report-pull-failed', { error: result.error });
      }
    } catch (err) {
      appendDaemonEvent(journalRoot, 'remote-report-pull-failed', { error: err.message });
    }
    if (stopped) return;
    const delayMs = config.remoteReportPullMs > 0 ? config.remoteReportPullMs : DEFAULT_REMOTE_PULL_MS;
    timer = setTimeout(tick, delayMs);
    if (typeof timer.unref === 'function') timer.unref(); // never keeps the process alive on its own
  }

  tick(); // fire immediately: the same "due since forever" behavior shouldPullRemoteReports(null, ...) gave on restart

  return function stopRemoteReportPullLoop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = {
  shouldPullRemoteReports,
  runRemoteReportPull,
  startRemoteReportPullLoop,
  isSafeReportFilename,
  readPullToken,
  ackedFilenames,
  DEFAULT_REMOTE_PULL_MS,
  DEFAULT_REMOTE_PULL_LIMIT,
  DEFAULT_REMOTE_MAX_BYTES,
  DEFAULT_REMOTE_QUEUE_CEILING,
};
