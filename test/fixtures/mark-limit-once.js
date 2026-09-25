'use strict';
// Fixture for test/accounts.test.js's markLimit concurrency test (action 6.2, item 7 of the
// action's own test list: "spawn >= 4 actual child processes each calling markLimit for a
// different account ... a REAL test, not a simulated one"). A standalone script, spawned via
// child_process.spawn as its own OS process, so the read-modify-write race inside markLimit is a
// REAL race between REAL processes -- not something an in-process mock of fs.readFileSync/
// writeFileSync could honestly reproduce (a mock never actually interleaves two independent
// event loops the way two OS processes hitting the same file at once do).
//
// argv: <poolDir> <accountName> <limitKind> [<barrierFile>] [<model>]
//
// card #167: `model` names which model's quota the limit is drawn against. Passing it here
// keeps this fixture on the REAL production call shape (every real call site names a model);
// omitting it exercises markLimit's cool-every-known-model fail-safe instead.
//
// The optional barrier is what makes this a real race rather than a lucky one. Node takes tens of
// milliseconds to boot and markLimit's critical section is microseconds long, so four children
// spawned back to back almost never overlap on their own -- measured: with the state lock's
// mutual exclusion removed, the parent test caught the regression in only 5 of 8 standalone runs
// and 1 of 6 full-suite runs. Each child now blocks until the parent has spawned all of them and
// created the barrier file, so they enter markLimit together and the lost-update window is
// actually exercised. Atomics.wait, not a polling setTimeout: it keeps the spin off the CPU and
// out of the very filesystem this test is measuring contention on.

const fs = require('fs');
const path = require('path');

const accounts = require(path.join(__dirname, '..', '..', 'orchestrator', 'accounts'));
const { monoNow, elapsedMs } = require(path.join(__dirname, '..', 'helpers'));

const [, , poolDir, accountName, limitKind, barrierFile, model] = process.argv;

if (barrierFile) {
  const spin = new Int32Array(new SharedArrayBuffer(4));
  // never hang the suite on a parent that died before writing it. The 10s bound is monotonic
  // (test/helpers.js, card #252): a Date.now() deadline ends early on a forward wall-clock step.
  const waitStart = monoNow();
  while (!fs.existsSync(barrierFile) && elapsedMs(waitStart) < 10000) Atomics.wait(spin, 0, 0, 1);
}

accounts.markLimit(poolDir, accountName, limitKind, Date.now(), { model });
