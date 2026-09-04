'use strict';
// retry-channel.js -- one rule, three readers: "according to this parked card's own journal, is
// the unpark (retry/abandon) comment scan working?"
//
// The retry channel is the maintainer's only way back into a parked card: park-loop.js's
// unparkScan reads a `retry` / `abandon` reply on the issue and re-enqueues (or terminates) the
// task. Project-2 card #476 measured what that channel's journal could and could not answer. It
// went down for 33 hours -- 238 consecutive `unpark-scan-failed` events on issue-213 alone,
// first 2026-08-30T10:11:23Z, last 2026-08-31T19:52:07Z -- and during those 33 hours a `retry`
// reply on any parked issue did nothing at all, silently.
//
// The rule below (`summarizeUnparkScanTail`) was written for action 5.4 item F inside bin/spo and
// lives here because THREE readers now need the identical rule and a fourth reading would be a
// fourth chance to drift:
//
//   * bin/spo's cmdStatus -- renders it per PARKED row.
//   * console/collect.js -- aggregates it into the dashboard's `retryChannel` service tile.
//   * orchestrator/park-loop.js -- decides whether this cycle's SUCCESSFUL scan is an outcome
//     CHANGE worth journalling (`unpark-scan-ok`). It has to apply the reader's own rule, not a
//     private approximation of it: the event it writes is what the readers then break on, so any
//     divergence between writer and reader shows up as a permanently wrong health line.
//
// ---- why the walk breaks where it breaks --------------------------------------------------
//
// Both halves were measured against the real outage rather than reasoned about:
//
//   * A backoff-skip does NOT break the streak. It is a CONSEQUENCE of the failures --
//     comment-scan.js backs a failing issue off and then journals the skips -- so treating it as
//     a recovery is exactly backwards. The real tail of journal/issue-213 is
//     `failed, skip, skip, skip, skip, skip, skip, skip, failed, skip x7, failed`. Breaking on a
//     skip reported that 33-hour, 238-failure outage as "FAILING x1 since 19:52:07" -- one
//     minute of trouble instead of a day and a half.
//   * Nor does any other unrelated event. Measured live, an hour after action 5.4 shipped:
//     5.1b's reconciler appended one `reconciled-externally` line to issue-213 and issue-428 on
//     the daemon's first cycle, and the health line went from "238 failure(s), last 14h50m ago"
//     to "no failures recorded". The 238 failures had not gone anywhere -- an unrelated event
//     landed after them, a walk that broke on "anything newer" broke on it, and an outage
//     indicator became an all-clear about a channel nothing had proven healthy. That is why the
//     walk breaks ONLY on the two named sets below and ignores everything else.
//
// ---- what `healthySince` is, and why it can exist at all -----------------------------------
//
// Card #476's second half: before it, a SUCCESSFUL unpark scan journalled NOTHING (park-loop.js's
// unparkScan simply `continue`d), so an old streak in a journal's tail could not distinguish
// "still broken" from "recovered silently" -- and both were true of the live corpus at once. The
// answer is NOT a heartbeat (one was deliberately removed, SPO-WebClient PR #444, and a per-cycle
// event is also what made 46% of the journal corpus unpark-scan noise in the first place): it is
// an EDGE-triggered `unpark-scan-ok`, written by park-loop.js only when the scan's outcome
// CHANGES to healthy -- the first proven-live scan of a park cycle, and once more after each
// outage it recovers from. Bounded at 1 + (number of outages) lines per park cycle.
//
// So `healthySince` is a positive fact with a timestamp on it, and "no failures recorded" is no
// longer the only thing a healthy channel can say.

// A park cycle ENDING or RESTARTING: `parked` is a fresh park, so the previous cycle's failures
// belong to a park that no longer exists (this is why issue-385 correctly reports 8 failures
// where issue-213 reports 238, on the same outage); `unparked-by-maintainer` and
// `abandoned-by-maintainer` are the two ways a human ends one.
const PARK_CYCLE_ENDING_EVENTS = new Set(['parked', 'unparked-by-maintainer', 'abandoned-by-maintainer']);

// POSITIVE EVIDENCE that the scan itself succeeded, i.e. that `gh` answered:
//   * `unpark-scan-ok`             -- card #476's edge-triggered outcome change (see above).
//   * `unpark-scan-truncated`      -- it paginated all the way to its bound.
//   * `unpark-scan-ignored-author` -- it found a comment and rejected the author.
// The last two predate `unpark-scan-ok` and remain in the set: a scan that journals either one
// has demonstrably reached GitHub, so it is a recorded outcome exactly like an `unpark-scan-ok`
// and must not be re-announced as one (park-loop.js checks this set, not just its own event).
const UNPARK_SCAN_SUCCESS_EVENTS = new Set([
  'unpark-scan-ok',
  'unpark-scan-truncated',
  'unpark-scan-ignored-author',
]);

const UNPARK_SCAN_OK_EVENT = 'unpark-scan-ok';

// summarizeUnparkScanTail(lines) -> {count, firstFailedAt, lastFailedAt, healthySince}
//
//   count         -- consecutive `unpark-scan-failed` events back to the last event that ends
//                    the walk (see the two sets above). 0 when the channel is not failing.
//   firstFailedAt -- the EARLIEST ts in that streak: what "failing for N hours" is measured from.
//   lastFailedAt  -- the most recent one: what "last failure N ago" is measured from.
//   healthySince  -- ts of the positive-evidence event the walk stopped on, and ONLY when
//                    `count === 0`. With failures sitting on top of it that timestamp describes a
//                    channel that has since broken again, so reporting it would be an all-clear
//                    over a live outage -- exactly the failure mode the `reconciled-externally`
//                    measurement above records. `null` also when the walk stopped on a park-cycle
//                    boundary or ran off the start of the journal: that is "no scan outcome
//                    recorded yet", which is not the same claim as "healthy" and must not render
//                    as one.
function summarizeUnparkScanTail(lines) {
  let count = 0;
  let firstFailedAt = null;
  let lastFailedAt = null;
  let healthySince = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = lines[i];
    if (!ev) break;
    if (PARK_CYCLE_ENDING_EVENTS.has(ev.event)) break;
    if (UNPARK_SCAN_SUCCESS_EVENTS.has(ev.event)) {
      if (count === 0) healthySince = ev.ts || null;
      break;
    }
    if (ev.event !== 'unpark-scan-failed') continue;
    count += 1;
    if (lastFailedAt === null) lastFailedAt = ev.ts || null;
    firstFailedAt = ev.ts || firstFailedAt;
  }
  return { count, firstFailedAt, lastFailedAt, healthySince };
}

// shouldJournalScanOk(summary) -- the writer's half of the rule above, applied by park-loop.js to
// the journal tail it read BEFORE this cycle's scan. True exactly when a successful scan is an
// outcome CHANGE: either failures are standing (recovery) or nothing positive has been recorded
// since this park cycle began (first proof of life). False when a healthy outcome is already on
// record -- which is what keeps this event edge-triggered rather than a per-cycle heartbeat.
function shouldJournalScanOk(summary) {
  return summary.count > 0 || summary.healthySince === null;
}

module.exports = {
  PARK_CYCLE_ENDING_EVENTS,
  UNPARK_SCAN_SUCCESS_EVENTS,
  UNPARK_SCAN_OK_EVENT,
  summarizeUnparkScanTail,
  shouldJournalScanOk,
};
