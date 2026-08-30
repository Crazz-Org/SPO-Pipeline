'use strict';
// http.js -- the one seam in this repo that opens an outbound HTTPS socket. Every other spawn
// primitive here (steps/llm.js's invokeClaudeReal, steps/scripted.js's spawnStep, intake.js's
// runSync, board.js's runSync) shells out to a process (`claude`, `gh`, `npm`) and lets the OS
// own the network. remote-report-pull.js is the first caller that needs to talk HTTP directly
// (pulling from a production server's bug-report store, orchestrator/README.md § Report intake)
// -- deliberately its own thin wrapper, deliberately dumb, so it can be the test-injection seam
// (`deps.httpRequest`) the same way `spawnSync` already is: this file itself stays untested by
// unit, exactly as node:child_process's own spawnSync is.
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

    const req = https.request(
      parsed,
      { method: opts.method || 'GET', headers: opts.headers || {}, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let received = 0;
        let truncated = false;

        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            truncated = true;
            res.destroy(); // stop receiving -- never buffer past the cap
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated });
        });
        res.on('error', reject);
      }
    );

    req.on('timeout', () => req.destroy(new Error(`http.js: request to ${url} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);

    if (opts.body !== undefined) req.end(opts.body);
    else req.end();
  });
}

module.exports = { httpRequest, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };
