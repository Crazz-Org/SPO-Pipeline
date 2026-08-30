'use strict';
// console/system.js -- CPU-per-core/memory sampler. Fully deterministic: readCpus/readMem/now
// are injected, never the real os.* calls.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSystemSampler } = require('../console/system');

function cpu(user, nice, sys, idle, irq = 0) {
  return { model: 'Test CPU', speed: 1000, times: { user, nice, sys, idle, irq } };
}

test('sample() computes busyPct from the delta between two readings', () => {
  let call = 0;
  const readings = [
    [cpu(0, 0, 0, 0), cpu(0, 0, 0, 0)],
    [cpu(50, 0, 0, 50), cpu(25, 0, 0, 75)], // core0: busy=50,total=100 -> 50%; core1: busy=25,total=100 -> 25%
  ];
  const sampler = createSystemSampler({
    readCpus: () => readings[call++],
    readMem: () => ({ total: 1000, free: 400 }),
  });

  const snap = sampler.sample();
  assert.equal(snap.cpu.cores[0].busyPct, 50);
  assert.equal(snap.cpu.cores[1].busyPct, 25);
  assert.equal(snap.cpu.count, 2);
  assert.equal(snap.memory.usedBytes, 600);
  assert.equal(snap.memory.usedPct, 60);
});

test('a zero total delta yields null busyPct instead of dividing by zero', () => {
  const fixed = cpu(10, 0, 0, 10);
  const sampler = createSystemSampler({
    readCpus: () => [fixed],
    readMem: () => ({ total: 100, free: 50 }),
  });
  const snap = sampler.sample();
  assert.equal(snap.cpu.cores[0].busyPct, null);
  assert.equal(snap.cpu.busyPct, null);
});

test('a change in core count between two reads is reported as null, not a throw', () => {
  // readings[0] is consumed by the constructor's initial read; readings[1] by the one sample()
  // call below.
  let call = 0;
  const readings = [[cpu(0, 0, 0, 0), cpu(0, 0, 0, 0)], [cpu(10, 0, 0, 10)]];
  const sampler = createSystemSampler({
    readCpus: () => readings[call++],
    readMem: () => ({ total: 100, free: 50 }),
  });
  let snap;
  assert.doesNotThrow(() => {
    snap = sampler.sample();
  });
  assert.equal(snap.cpu.cores.length, 1);
  assert.equal(snap.cpu.cores[0].busyPct, null);
});

test('sample() reports a fixed memory snapshot exactly', () => {
  const sampler = createSystemSampler({
    readCpus: () => [cpu(0, 0, 0, 0)],
    readMem: () => ({ total: 8000000000, free: 2000000000 }),
    now: () => Date.parse('2026-08-30T12:00:00.000Z'),
  });
  const snap = sampler.sample();
  assert.equal(snap.memory.totalBytes, 8000000000);
  assert.equal(snap.memory.freeBytes, 2000000000);
  assert.equal(snap.memory.usedPct, 75);
  assert.equal(snap.sampledAt, '2026-08-30T12:00:00.000Z');
});
