'use strict';
// console/system.js -- CPU-per-core and memory sampling for the live dashboard. os.cpus()
// returns CUMULATIVE counters since boot, so an instantaneous load is only a DELTA between two
// reads -- this sampler carries the previous reading between calls. Zero disk I/O, zero
// network. Only console/serve.js's `/api/system` route calls this (never console/collect.js --
// see its own header for why the split matters for `spo dashboard` without --serve).

const os = require('os');

function cpuTimesTotal(times) {
  return times.user + times.nice + times.sys + times.idle + times.irq;
}

function cpuTimesBusy(times) {
  return times.user + times.nice + times.sys + times.irq;
}

// createSystemSampler({readCpus, readMem, now}) -- deps are injectable for deterministic tests;
// production code omits them and gets the real os.* calls.
function createSystemSampler({
  readCpus = () => os.cpus(),
  readMem = () => ({ total: os.totalmem(), free: os.freemem() }),
  now = Date.now,
} = {}) {
  let prev = readCpus();

  function sample() {
    const cur = readCpus();
    let cores = [];
    let busyPct = null;

    if (cur.length === prev.length && cur.length > 0) {
      let sumBusyDelta = 0;
      let sumTotalDelta = 0;
      cores = cur.map((c, i) => {
        const p = prev[i];
        const totalDelta = cpuTimesTotal(c.times) - cpuTimesTotal(p.times);
        const busyDelta = cpuTimesBusy(c.times) - cpuTimesBusy(p.times);
        sumBusyDelta += Math.max(0, busyDelta);
        sumTotalDelta += Math.max(0, totalDelta);
        const pct = totalDelta > 0 ? Math.round((busyDelta / totalDelta) * 100) : null;
        return { i, busyPct: pct };
      });
      busyPct = sumTotalDelta > 0 ? Math.round((sumBusyDelta / sumTotalDelta) * 100) : null;
    } else {
      // Core count changed (hotplug / WSL2 quirk) -- report unknown rather than a bogus delta.
      cores = cur.map((_, i) => ({ i, busyPct: null }));
    }

    prev = cur;

    const mem = readMem();
    const usedBytes = mem.total - mem.free;

    return {
      sampledAt: new Date(now()).toISOString(),
      cpu: {
        count: cur.length,
        cores,
        busyPct,
        model: cur.length ? String(cur[0].model || '').slice(0, 48) : null,
      },
      memory: {
        totalBytes: mem.total,
        freeBytes: mem.free,
        usedBytes,
        usedPct: mem.total > 0 ? Math.round((usedBytes / mem.total) * 100) : null,
      },
      loadavg: os.loadavg(),
      uptimeSec: Math.round(os.uptime()),
    };
  }

  function reset() {
    prev = readCpus();
  }

  return { sample, reset };
}

module.exports = { createSystemSampler };
