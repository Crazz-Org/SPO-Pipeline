'use strict';
// Fixture for test/product-repo-lock.test.js's real-process coverage (items 1 and 7: "two real
// processes cannot both be inside the critical section" and "setup and teardown contend on the
// SAME lock"). A standalone node script, spawned via child_process.spawn (NOT spawnSync, so
// test/no-real-spawn.js's guard never sees it) as its own OS process with its own real pid -- same
// precedent as test/fixtures/lease-hold.js (account-lease.js's own real-process fixture).
//
// argv: <worktreesDir> <holdMs> <insideMarkerPath> <violationFlagPath> [waitMs] [pollMs]
//
//   1. Attempts orchestrator/product-repo-lock.js's acquireProductRepoLock with a config object
//      whose pipelineWorktreesDir is `worktreesDir` (must already exist -- the parent test creates
//      it), and NO opts.filePath.
//
//      THE ABSENCE OF opts.filePath IS THE POINT, and it is a correction: this fixture used to be
//      handed the lock file path directly, which meant production's own lockFilePath(cfg)
//      derivation was never exercised across two processes anywhere in the suite. Verification of
//      6.4 measured the cost: mutating lockFilePath to append `.<pid>` -- giving every worker its
//      OWN lock file and destroying cross-worker exclusion completely -- passed all 1295 tests,
//      because the only test that compared two phases' paths ran both in ONE process (same pid,
//      same path) and both real-process tests bypassed the derivation entirely. Letting the
//      fixture derive its own path is what makes these tests able to see that.
//   2. On acquire: if `insideMarkerPath` ALREADY EXISTS, mutual exclusion has been broken -- some
//      OTHER process is (or was, without cleaning up) inside the critical section at the same
//      time. That is recorded to `violationFlagPath` (the parent test's actual assertion target --
//      "observe the overlap from inside", per the spec, not "check the lock is gone afterwards").
//      Otherwise this process writes its own pid to `insideMarkerPath`.
//   3. Holds the section for `holdMs` (real wall-clock, via setTimeout -- keeps the process alive)
//      -- long enough that two real processes racing for the lock will reliably overlap in time
//      if exclusion is broken, without the test itself being slow.
//   4. Removes `insideMarkerPath`, releases the lock, and exits 0.
//   5. A timeout / any other failure to acquire writes nothing and exits 3 -- the parent test's own
//      readiness/completion wait would then fail loudly rather than silently pass on a fixture bug
//      or a lock that never frees.

const fs = require('fs');
const path = require('path');

const {
  acquireProductRepoLock,
  releaseProductRepoLock,
} = require(path.join(__dirname, '..', '..', 'orchestrator', 'product-repo-lock'));

const [, , worktreesDir, holdMsRaw, insideMarkerPath, violationFlagPath, waitMsRaw, pollMsRaw] = process.argv;
const holdMs = Number(holdMsRaw);

const cfg = { pipelineWorktreesDir: worktreesDir, workers: 2 };
const opts = {}; // no filePath -- production's own lockFilePath(cfg) must do the deriving
if (waitMsRaw !== undefined) opts.waitMs = Number(waitMsRaw);
if (pollMsRaw !== undefined) opts.pollMs = Number(pollMsRaw);

acquireProductRepoLock(cfg, opts)
  .then((acquired) => {
    if (fs.existsSync(insideMarkerPath)) {
      fs.writeFileSync(
        violationFlagPath,
        `pid ${process.pid} entered the critical section while ${fs.readFileSync(insideMarkerPath, 'utf8')} was still inside`
      );
    }
    fs.writeFileSync(insideMarkerPath, String(process.pid));

    setTimeout(() => {
      fs.unlinkSync(insideMarkerPath);
      releaseProductRepoLock(acquired);
      process.exit(0);
    }, holdMs);
  })
  .catch(() => {
    process.exit(3);
  });
