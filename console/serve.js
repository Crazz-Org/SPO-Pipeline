'use strict';
// serve.js -- a minimal HTTP server for the dashboard: every GET re-collects the local
// surfaces and renders fresh HTML, so the page is always current with no interval and no
// stale file on disk. Node built-ins only, same read-only stance as the rest of console/.
//
// This serves on the LAN / to whatever can reach this machine's port. The externally hosted
// copy (nginx + basic auth on the dedicated server) is a `spo dashboard` + rsync concern
// owned by SPO-Deploy -- this server is the local/immediate tier, not the public one.

const http = require('http');
const { collectAll } = require('./collect');
const { renderDashboard } = require('./render');

function createDashboardServer(sources) {
  return http.createServer((req, res) => {
    try {
      const html = renderDashboard(collectAll(sources));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dashboard error: ${err.message}`);
    }
  });
}

module.exports = { createDashboardServer };
