'use strict';
// worker-status.js -- action 6.7 (worker observability). Cross-references
// <journalRoot>/live-workers.json (journal.js's writeLiveWorkerIds, published by dispatcher.js on
// every worker spawn/exit -- see that file's own header for the full cross-process design) against
// each candidate task's OWN state.json `owner`, to answer one question honestly: "is this id's
// live-worker entry actually a live worker right now, or something else".
//
// SHARED by bin/spo's cmdStatus (per-row worker detail: account, elapsed duration) and
// console/collect.js's dashboard tile (an aggregate count only) so the two can never
// independently drift on what counts as "live" the way orchestrator/tokens.js's and
// console/collect.js's parking-rate denominators once did before action 5.4 item G pinned them
// together with one shared fixture-driven test. One classification function, two renderers.
//
// THE HAZARD THIS MODULE EXISTS TO NOT REPRODUCE (the C6 driver's own words): bin/spo's cmdStatus
// already counts a task as `active` when its state.json is non-terminal, and under C6 those tasks
// ARE the workers. A worker section that counts independently would double-count every running
// card -- exactly the bug action 5.4 item B already shipped once (a card in auto-retry backoff
// counted both as `active` and in `queue depth`) and had to fix. So this module never returns an
// independent "how many workers" total on its own terms -- every id it classifies is either
// 'live'/'stale' (a task the caller's OWN active-bucket logic already counts once) or 'trailing'
// (a task the caller's own terminal-bucket logic already counts once). The caller cross-
// references, this module never re-derives.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLiveWorkersRaw } = require('./journal');
const { processAlive } = require('./lock');

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// describeLiveWorkers(journalRoot, taskStates, now) -> {
//   present    -- whether live-workers.json exists at all (see journal.js's readLiveWorkersRaw
//                 header: absence means "no dispatcher has ever published here", not "0 workers").
//   updatedAt  -- the file's own ISO timestamp, or null when `present` is false.
//   ageMs      -- now - updatedAt, or null.
//   perId      -- Map<id, {classification, pid, host, elapsedMs, unverifiable, staleReason}>, one
//                 entry per id the file currently lists (never one per task in the journal root -- an id with
//                 no live-worker entry at all is simply absent from this map, which the caller
//                 reads as "no worker for this task right now", not as 'stale').
//   counts     -- {live, stale, trailing}, the SAME partition perId's own classifications sum to
//                 -- provided as a convenience, never as a second count computed a different way.
//
// `taskStates` is an OPTIONAL Map<id, state.json-shaped-object> the caller may already have on
// hand (bin/spo's cmdStatus reads every task's state.json in its own per-id loop already; forcing
// a second read here would be a second disk pass over data the caller already parsed). Absent, or
// missing an id this file lists, falls back to reading that one id's state.json directly -- bounded
// by however many ids live-workers.json actually lists (K workers, not every task in the journal).
//
// classification, one of:
//   'trailing' -- state.json already says DONE/PARKED/ABANDONED for this id. THE TASK'S OWN
//     TERMINAL STATE WINS (the driver's own instruction: "decide which side wins and say why").
//     A worker that wrote DONE and has not yet exited is not lying about the outcome -- it just
//     has not finished tearing down. Counting it as a second, still-active/live task would be
//     exactly the double-count this module's header warns against; 'trailing' exists so the
//     caller can mention it ("N worker(s) still exiting") without folding it into anything that
//     is already counted once, elsewhere.
//   'stale' -- non-terminal, and NOT provably live. Two distinct causes, kept apart by
//     `staleReason` because the renderer would otherwise assert the wrong one (see the fix note
//     at that assignment): 'pid-dead' (the recorded owner pid is provably dead on THIS host) and
//     'no-owner-recorded' (there is no owner pid to probe at all -- a worker still booting, or
//     one that died before its first snapshot; `unverifiable` is true for this one, since no
//     liveness check ran). This is journal.js's own staleness direction one: the file has
//     not caught up to the dispatcher's in-memory state yet, and self-heals within one more
//     spawn/exit publish -- see that module's header for the full reasoning.
//   'live' -- non-terminal, and either the owner pid answers alive on THIS host, or the owner is
//     recorded on a DIFFERENT host and so cannot be probed at all. The latter counts as live
//     rather than stale/unknown -- the same posture orphan-scan.js already takes ("cannot probe a
//     remote host's pid" -- leave it alone rather than guess) -- and is named explicitly via
//     `unverifiable: true` rather than silently agreeing with a check that never ran.
function describeLiveWorkers(journalRoot, taskStates, now = Date.now()) {
  const raw = journalRoot ? readLiveWorkersRaw(journalRoot) : { present: false, ids: new Set(), updatedAt: null };
  const perId = new Map();
  const counts = { live: 0, stale: 0, trailing: 0 };
  const hostname = os.hostname();

  for (const id of raw.ids) {
    const state = (taskStates && taskStates.get(id)) || readJsonSafe(path.join(journalRoot, id, 'state.json'), {});
    const cur = state.state;
    if (cur === 'DONE' || cur === 'PARKED' || cur === 'ABANDONED') {
      perId.set(id, { classification: 'trailing', pid: null, host: null, elapsedMs: null, unverifiable: false, staleReason: null });
      counts.trailing++;
      continue;
    }

    const owner = state.owner;
    const pid = owner && typeof owner.workerPid === 'number' ? owner.workerPid : null;
    const host = (owner && owner.host) || null;
    let classification;
    let unverifiable = false;
    // Verification fix: 'stale' had TWO causes collapsed into one word, and the renderer asserted
    // the wrong one out loud. dispatcher.js publishes live-workers.json inside spawnOne, in the
    // same synchronous turn as the spawn itself -- BEFORE the worker process has booted node, let
    // alone written the state.json snapshot that first records `owner.workerPid` (daemon.js's
    // workerMode owner, ~100ms of node boot at an absolute minimum). So on EVERY spawn there is a
    // window where a perfectly healthy, just-started worker has no owner to probe -- and this
    // branch reported it as "pid ? not alive on this host", asserting a liveness check that never
    // ran. That is precisely the failure this module's own header swears off two paragraphs up
    // ("named explicitly via `unverifiable: true` rather than silently agreeing with a check that
    // never ran"), and the same 0-vs-absent confusion 6.7 fixes for `duration_s`, one field over.
    // `staleReason` lets the renderer tell the two apart; the COUNT deliberately does not move --
    // an unprovable worker still must not be counted live.
    let staleReason = null;
    if (pid === null) {
      staleReason = 'no-owner-recorded';
      unverifiable = true;
      // No owner, or an owner shaped like the pre-6.1 daemon-lock kind ({pid} not {workerPid}) --
      // orphan-scan.js reads `workerPid ?? pid` for exactly this reason, but a live-workers.json
      // entry only ever names a WORKER (never the daemon itself, per dispatcher.js's own header:
      // "TASK-owning workers only, never the scanner"). Either the worker has not booted far
      // enough to write its first snapshot yet (the common case, once per spawn) or it died
      // before it ever could. Both are un-probeable, so neither is counted live -- but the two
      // are not the same fact and the renderer must not pick one.
      classification = 'stale';
    } else if (host === hostname) {
      classification = processAlive(pid) ? 'live' : 'stale';
      if (classification === 'stale') staleReason = 'pid-dead';
    } else {
      classification = 'live';
      unverifiable = true;
    }

    const startedMs = owner && owner.workerStartedAt ? Date.parse(owner.workerStartedAt) : NaN;
    const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null;
    perId.set(id, { classification, pid, host, elapsedMs, unverifiable, staleReason });
    counts[classification]++;
  }

  const ageMsRaw = raw.updatedAt ? now - Date.parse(raw.updatedAt) : null;
  return {
    present: raw.present,
    updatedAt: raw.updatedAt,
    ageMs: Number.isFinite(ageMsRaw) ? ageMsRaw : null,
    perId,
    counts,
  };
}

module.exports = { describeLiveWorkers };
