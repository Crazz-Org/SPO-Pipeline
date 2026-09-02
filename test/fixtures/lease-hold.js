'use strict';
// Fixture for test/account-lease.test.js's real-process coverage (item 1: "two processes cannot
// hold the same account's lease"). A standalone node script, spawned via child_process.spawn (NOT
// spawnSync, so test/no-real-spawn.js's guard never sees it) as its own OS process with its own
// real pid -- the one thing an in-process fake can never honestly provide for
// orchestrator/lock.js's processAlive(pid) check.
//
// argv: <poolDir> <accountName> <holdMs> <readyFilePath>
//
//   1. Attempts orchestrator/account-lease.js's tryAcquireLease(poolDir, accountName) directly
//      (not leaseHealthyAccount -- this script's job is to hold ONE named account's lease, not
//      pick one).
//   2. On success, writes `readyFilePath` (content irrelevant) -- the parent test polls for this
//      file's existence as its "the lease now really is held by a live, different pid" signal,
//      rather than racing a fixed setTimeout against however long node takes to boot on this
//      machine.
//   3. Holds the lease for `holdMs` (plain setTimeout -- keeps the event loop, and the process,
//      alive), then releases and exits 0.
//   4. On failure to acquire (already held), writes nothing and exits 3 -- the parent test would
//      fail its own readiness poll rather than silently pass on a fixture bug.

const fs = require('fs');
const path = require('path');

const { tryAcquireLease, releaseLease } = require(path.join(__dirname, '..', '..', 'orchestrator', 'account-lease'));

const [, , poolDir, accountName, holdMsRaw, readyFilePath] = process.argv;
const holdMs = Number(holdMsRaw);

const held = tryAcquireLease(poolDir, accountName);
if (!held) {
  process.exit(3);
}

fs.writeFileSync(readyFilePath, String(process.pid));

setTimeout(() => {
  releaseLease(poolDir, accountName, held);
  process.exit(0);
}, holdMs);
