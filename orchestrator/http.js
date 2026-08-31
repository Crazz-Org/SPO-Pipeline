'use strict';
// http.js -- the one seam in this repo that opens an outbound HTTPS socket. Every other spawn
// primitive here (steps/llm.js's invokeClaudeReal, steps/scripted.js's spawnStep, intake.js's
// runSync, board.js's runSync) shells out to a process (`claude`, `gh`, `npm`) and lets the OS
// own the network. remote-report-pull.js is the first caller that needs to talk HTTP directly
// (pulling from a production server's bug-report store, orchestrator/README.md § Report intake)
// -- deliberately its own thin wrapper, deliberately dumb, so it can be the test-injection seam
// (`deps.httpRequest`) the same way `spawnSync` already is: every OTHER file's tests fake this
// one, exactly as they fake `spawnSync`, rather than opening a real socket of their own.
//
// This file's own tests (test/http.test.js) are the one exception, and they earn it: a promise
// that can fail to settle is exactly the class of bug that a mocked `deps.httpRequest` can never
// catch, because the mock always resolves-or-rejects by construction. Those tests run a real
// local HTTPS server (a self-signed cert generated at test time) -- there is no seam to fake the
// https-only check without weakening it in production code, which is worse.
//
// Refuses non-https: URLs outright -- there is no legitimate caller of this function that should
// ever send a bearer token in cleartext.

const https = require('https');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

// httpRequest(url, opts) -- opts: {method, headers, body, timeoutMs, maxBytes}. Resolves
// {status, headers, body: Buffer, truncated: boolean} or rejects on a network-level failure
// (DNS, connect, TLS, timeout). Never follows a redirect -- the caller's token must reach only
// the origin it was configured for, never a Location header's target.
function httpRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error(`http.js: invalid URL: ${err.message}`));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error(`http.js: refusing a non-https URL: ${url}`));
      return;
    }

    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;

    // Every way this promise can settle -- the truncation path, a clean 'end', a stream 'error',
    // a premature 'close' (no 'end' ever came), the request's own 'timeout'/'error' -- goes
    // through here. Without it, a late event firing AFTER the promise already settled (destroy()
    // triggering 'close' after we already resolved on truncation; the request-level 'timeout'
    // racing an already-completed response) would call resolve/reject a second time. A second
    // settle is a silent no-op as far as the Promise itself is concerned, but relying on that
    // accident is exactly how this file's original bug shipped in the first place (a path that
    // settles ZERO times looks identical to "fine" until it hangs a caller forever) -- so make
    // "exactly once" a property the code enforces, not one it happens to have today.
    let settled = false;
    function settleOnce(fn) {
      if (settled) return;
      settled = true;
      fn();
    }

    const req = https.request(
      parsed,
      { method: opts.method || 'GET', headers: opts.headers || {}, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let received = 0;
        let truncated = false;

        res.on('data', (chunk) => {
          if (settled) return; // already resolved/rejected -- stop accumulating regardless of why
          received += chunk.length;
          if (received > maxBytes) {
            truncated = true;
            // Resolve BEFORE destroy(): truncated is a RESULT (see this file's header), not a
            // failure, and settling first means whatever destroy() triggers next -- typically a
            // plain 'close', occasionally an 'error' with no useful message -- lands on an
            // already-settled promise and settleOnce turns it into a no-op instead of a race.
            settleOnce(() =>
              resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated })
            );
            res.destroy(); // stop receiving -- never buffer past the cap
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settleOnce(() =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated })
          );
        });
        res.on('error', (err) => settleOnce(() => reject(err)));
        // Catch-all for the hang this action exists to fix: a 'close' with no preceding 'end'.
        // On the truncation path we've already resolved by the time destroy() gets here, so this
        // is a no-op there (settleOnce). Everywhere else -- server cuts the connection, network
        // drop, any other premature termination Node surfaces as 'close' without 'error' -- this
        // is the only thing standing between that and a promise that never settles.
        res.on('close', () => {
          settleOnce(() => reject(new Error(`http.js: connection closed before the response completed: ${url}`)));
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`http.js: request to ${url} timed out after ${timeoutMs}ms`)));
    req.on('error', (err) => settleOnce(() => reject(err)));

    if (opts.body !== undefined) req.end(opts.body);
    else req.end();
  });
}

module.exports = { httpRequest, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };
