'use strict';
// bench-heartbeat.js -- action B5.3's single staleness contract for ~/.spo-bench/heartbeat,
// mirrored on this side of the repo boundary.
//
// THE BUG THIS CLOSES: two readers of the same file, two different contracts. SPO-WebClient's
// src/e2e/bench/paths.ts (heartbeatAgeMs, read by cli.ts and workerStatus) used to read the
// heartbeat by MTIME with a 20s bound; console/collect.js (reached from bin/spo's `spo status`/
// `spo dashboard`) has always read it by CONTENT -- the epoch ms the worker actually wrote --
// but with its own, unrelated, hardcoded 120s bound. Two contracts, six times apart, on one file.
//
// THE CHOSEN CONTRACT, and why: CONTENT, bound 20_000ms. The worker (SPO-WebClient's worker.ts)
// writes the heartbeat on its own setInterval every HEARTBEAT_PERIOD_MS = 5_000ms, riding a timer
// independent of the work loop specifically so a long build or live drive cannot stall it -- see
// worker.ts's own comment at the call site. A 20s bound is 4 missed beats before a submitter or
// this dashboard calls the worker dead; that is the PRODUCT's own existing bound
// (HEARTBEAT_STALE_MS, unchanged by this action) and is tight enough to catch a wedged worker
// inside the pre-submit check that gates every job deposit. The 120s bound this file used to
// have (24 missed beats) was the one that was WRONG relative to the 5s write interval: it let a
// dashboard read a worker that has been dead for up to two minutes as green. mtime loses to
// content on correctness, not just on convention: a `cp -p`-preserved copy of the heartbeat file
// keeps its old mtime with fresh-looking content, and an unrelated `touch` (a backup job, a
// filesystem re-sync) can bump mtime with no write at all -- see paths.ts's own updated
// heartbeatAgeMs and its paths.test.ts coverage of both directions. Content, by contrast, is the
// one signal the writer actually controls: touchHeartbeat writes a fresh epoch ms on every single
// beat, so it can never go stale while looking fresh the way mtime can.
//
// CROSS-REPO, NOT IMPORTABLE: this repo cannot `require()` a TypeScript file in a sibling repo,
// so HEARTBEAT_STALE_MS below is a hand-restated copy of SPO-WebClient's own
// src/e2e/bench/paths.ts:52 literal, not a shared module. test/heartbeat-contract-pin.test.js
// pins the two literals against each other by reading the product repo's real source text (via
// `git ls-files`, so a typo'd path fails loudly) -- see that file's own header for the pattern,
// modelled on test/doc-constant-sweep.test.js's house rule: LITERAL strings, typed independently,
// never re-derived from the value under test. If B5.2 ever changes HEARTBEAT_STALE_MS's own
// value on the product side, that pin reds here until this file's copy is updated to match.
//
// B5.2 (not built, not this action): will make the heartbeat carry `{currentJob, startedAt}` so
// a client can tell ALIVE from PROGRESSING. That changes what the file's content MEANS, not how
// stale it is allowed to get -- HEARTBEAT_STALE_MS is unaffected. It DOES mean whatever parses
// the content (this file's heartbeatAgeMs, and the product's own) will need updating for the new
// shape; that update is a single edit here (this is the one place collect.js reads the file),
// not a second copy to keep in sync twice over.

const fs = require('fs');

/**
 * Heartbeat older than this = the worker is not running, whatever else looks alive. Mirrors
 * SPO-WebClient/src/e2e/bench/paths.ts:52's HEARTBEAT_STALE_MS -- see this file's header for the
 * derivation (4 missed beats of the worker's 5s HEARTBEAT_PERIOD_MS) and
 * test/heartbeat-contract-pin.test.js for how the two literals are kept from drifting apart.
 */
const HEARTBEAT_STALE_MS = 20_000;

/**
 * Milliseconds since the worker last wrote the heartbeat, or null when the file is absent or its
 * content isn't a parseable timestamp. Reads by CONTENT -- the epoch ms touchHeartbeat wrote --
 * never by mtime; see this file's header for why that side of the contract matters as much as
 * the bound does.
 *
 * TWO on-disk shapes, and both must keep working:
 *
 *   legacy  `1788436013067`                       -- a bare epoch, every heartbeat before B5.2
 *   B5.2    `{"writtenAt":178...,"currentJob":..}` -- the tick PLUS which job is in flight
 *
 * B5.2 (SPO-WebClient) makes the worker carry `{currentJob, startedAt}` so a client can tell a
 * worker that is ALIVE from one that is PROGRESSING -- today an idle worker and one wedged
 * mid-job look identical here, because the beat rides its own timer and says nothing about the
 * loop. This reader lands FIRST and on purpose: JSON-then-fallback reads both shapes, whereas
 * the worker shipping JSON against a `Number(raw)` reader turns every heartbeat into `unknown`
 * and regresses `spo status` / `spo dashboard` from an accurate up/stale answer to none at all.
 *
 * `JSON.parse('123')` SUCCEEDS and yields a number, so a bare try/catch is not enough to tell the
 * two shapes apart -- the object check is what does it, and dropping it misreads every legacy
 * heartbeat as corrupt. (The same trap bit B5.2's own first implementation on the WebClient side.)
 */
function heartbeatAgeMs(heartbeatFile, nowMs = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(heartbeatFile, 'utf8').trim();
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const writtenAt = Number(parsed.writtenAt);
    if (!Number.isFinite(writtenAt)) return null;
    return nowMs - writtenAt;
  }

  const writtenMs = Number(raw);
  if (!Number.isFinite(writtenMs)) return null;
  return nowMs - writtenMs;
}

module.exports = { HEARTBEAT_STALE_MS, heartbeatAgeMs };
