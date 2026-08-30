'use strict';
// console/prod-version.js -- watches starpeace.zz.works (SPO-WebClient's production
// deployment) for the live dashboard's "version production" card, without SSH: two independent
// HTTPS probes, both read-only, both cached and refreshed on their own timer so the dashboard's
// render path NEVER makes a network call.
//
//   site probe     GET <baseUrl><healthPath|'/'>  -- UP/DOWN + latency. If healthPath is
//                   configured and the body parses as JSON with a version/gitTag/sha field,
//                   that's the "deployed" version. No known /healthz exists yet on production
//                   today (2026-08-30) -- this repo does not own that endpoint (SPO-WebClient +
//                   SPO-Deploy do); until it exists, deployed.exposed stays false.
//   release probe  GET api.github.com/repos/.../releases/latest -- the "expected" version
//                   (SPO-WebClient's own tag -> release -> SPO-Deploy's deploy.sh flow,
//                   doc/environments.md). A proxy for "what should be live", NOT a confirmation
//                   of what actually is -- the UI must keep that distinction visible.
//
// Never stores a raw error message or the production URL in a returned snapshot -- both can
// appear in a caught Error's .message, and this object is rendered straight into the dashboard.

const DEFAULT_BASE_URL = 'https://starpeace.zz.works';
const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/Crazz-Org/SPO-WebClient/releases/latest';
const DEFAULT_HEALTH_TTL_MS = 120000;
const DEFAULT_RELEASE_TTL_MS = 300000;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 256 * 1024;

function normalizeVersion(v) {
  if (v === null || v === undefined) return null;
  return String(v).replace(/^v/i, '').trim();
}

function mapErrorCode(err) {
  const code = err && err.code;
  if (code === 'ETIMEDOUT' || /timed out/i.test((err && err.message) || '')) return 'timeout';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code && String(code).startsWith('CERT_')) return 'tls';
  return 'network';
}

function emptySnapshot() {
  return {
    checkedAt: null,
    site: { status: 'unknown', httpStatus: null, latencyMs: null, error: null },
    deployed: { version: null, exposed: false, source: 'none' },
    expected: { version: null, tag: null, publishedAt: null, status: 'unknown', error: null },
    drift: 'unknown',
  };
}

function computeDrift(deployed, expected) {
  if (!deployed.version || !expected.version) return 'unknown';
  return normalizeVersion(deployed.version) === normalizeVersion(expected.version) ? 'match' : 'diverged';
}

function createProdProbe({
  baseUrl = process.env.SPO_PROD_URL || DEFAULT_BASE_URL,
  healthPath = process.env.SPO_PROD_HEALTH_PATH || null,
  releasesUrl = DEFAULT_RELEASES_URL,
  healthTtlMs = DEFAULT_HEALTH_TTL_MS,
  releaseTtlMs = DEFAULT_RELEASE_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  http = require('../orchestrator/http'),
  now = Date.now,
} = {}) {
  const snap = emptySnapshot();
  let healthTimer = null;
  let releaseTimer = null;

  async function probeSite() {
    const t0 = now();
    try {
      const url = baseUrl + (healthPath || '/');
      const res = await http.httpRequest(url, { method: 'GET', timeoutMs, maxBytes });
      const latencyMs = now() - t0;
      snap.checkedAt = new Date(now()).toISOString();
      snap.site = {
        status: res.status < 400 ? 'up' : 'down',
        httpStatus: res.status,
        latencyMs,
        error: res.status >= 400 ? 'http-error' : null,
      };
      if (healthPath) {
        try {
          const parsed = JSON.parse(res.body.toString('utf8'));
          const version = parsed.version || parsed.gitTag || parsed.sha || null;
          if (version) {
            snap.deployed = { version: String(version), exposed: true, source: 'healthz' };
          } else {
            snap.deployed = { version: null, exposed: false, source: 'none' };
          }
        } catch {
          snap.deployed = { version: null, exposed: false, source: 'none' };
        }
      } else {
        snap.deployed = { version: null, exposed: false, source: 'none' };
      }
    } catch (err) {
      snap.checkedAt = new Date(now()).toISOString();
      snap.site = { status: 'down', httpStatus: null, latencyMs: null, error: mapErrorCode(err) };
    }
    snap.drift = computeDrift(snap.deployed, snap.expected);
  }

  async function probeRelease() {
    try {
      const res = await http.httpRequest(releasesUrl, {
        method: 'GET',
        headers: { 'user-agent': 'spo-dashboard', accept: 'application/vnd.github+json' },
        timeoutMs,
        maxBytes,
      });
      if (res.status === 200) {
        const parsed = JSON.parse(res.body.toString('utf8'));
        snap.expected = {
          version: normalizeVersion(parsed.tag_name),
          tag: parsed.tag_name || null,
          publishedAt: parsed.published_at || null,
          status: 'ok',
          error: null,
        };
      } else if (res.status === 403) {
        // rate-limited -- keep whatever value we already have, just flag the status.
        snap.expected = { ...snap.expected, status: 'rate-limited' };
      } else {
        snap.expected = { ...snap.expected, status: 'unknown' };
      }
    } catch {
      snap.expected = { ...snap.expected, status: snap.expected.version ? snap.expected.status : 'unknown' };
    }
    snap.drift = computeDrift(snap.deployed, snap.expected);
  }

  function snapshot() {
    return snap;
  }

  async function refresh() {
    await Promise.allSettled([probeSite(), probeRelease()]);
    return snap;
  }

  function start() {
    probeSite().catch(() => {});
    probeRelease().catch(() => {});
    healthTimer = setInterval(() => probeSite().catch(() => {}), healthTtlMs);
    releaseTimer = setInterval(() => probeRelease().catch(() => {}), releaseTtlMs);
    if (healthTimer.unref) healthTimer.unref();
    if (releaseTimer.unref) releaseTimer.unref();
  }

  function stop() {
    if (healthTimer) clearInterval(healthTimer);
    if (releaseTimer) clearInterval(releaseTimer);
    healthTimer = null;
    releaseTimer = null;
  }

  return { snapshot, refresh, start, stop };
}

module.exports = { createProdProbe };
