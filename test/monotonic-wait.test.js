'use strict';
// monotonic-wait.test.js -- pins test/helpers.js's shared monotonic waits (card SPO-Pipeline#252)
// against a STEPPED Date.now(), so every call site in the suite inherits the guarantee from one
// place instead of each copy carrying (or, as #234's verifier found for drain/dispatcher/recette,
// NOT carrying) its own pin.
//
// The first two tests are card #234's regression tests, moved here from
// test/repark-race-demo.test.js when its waitFor became the shared one. The rest extend the same
// two properties -- a forward step must not END a bound early, a backward step must not EXTEND
// one -- to pollUntil, elapsedMs and busyWaitMs.
//
// Every test that patches Date.now restores it in `finally`, whatever the outcome, and node:test
// runs one file's top-level tests one at a time, so no patch overlaps another test.

const test = require('node:test');
const assert = require('node:assert/strict');

// Killswitch before any orchestrator require -- test/no-real-spawn-sweep.test.js's rule.
require('./no-real-spawn');
const { monotonicNowMs } = require('../orchestrator/monotonic-clock');
const { waitFor, pollUntil, elapsedMs, monoNow, busyWaitMs, DEFAULT_WAIT_TIMEOUT_MS } = require('./helpers');

const HOUR_MS = 60 * 60 * 1000;

// A predicate that steps Date.now() one hour ahead on its SECOND call -- not the first: a
// deadline computed lazily, after the first poll, would otherwise already read the stepped clock
// and survive -- and turns true only on its fifth call, so the wait MUST survive three deadline
// checks under the stepped clock (no wall-clock margin involved: the predicate counts polls, it
// never reads a time). A Date.now()-based deadline, eager or lazy, throws on the first of them.
function forwardSteppingPredicate(realDateNow, counter) {
  return () => {
    counter.calls++;
    if (counter.calls === 2) Date.now = () => realDateNow() + HOUR_MS;
    return counter.calls >= 5;
  };
}

// Card #234's first regression test, on the shared helper.
test('waitFor: a forward Date.now() step mid-wait does not expire the deadline early (card #234)', async () => {
  const realDateNow = Date.now;
  const counter = { calls: 0 };
  try {
    await waitFor(forwardSteppingPredicate(realDateNow, counter), {
      timeoutMs: 8000,
      intervalMs: 10,
      message:
        'waitFor gave up although its predicate turned true on its fifth poll -- its deadline follows the wall clock, which a forward step expires early',
    });
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(counter.calls, 5, 'the predicate must be polled until it turns true, and not after');
});

// Card #234's second: the monotonic bound is still a bound. A predicate that stays false past
// timeoutMs fails BY NAME once timeoutMs of monotonic time has passed -- not an opaque node:test
// timeout, and not early. The predicate does turn true at 2000ms, far past the 60ms bound: a
// helper that never gives up then RESOLVES and fails the assert.rejects below, instead of polling
// forever and keeping this file's process (and the whole suite) alive.
test('waitFor: a predicate still false at its timeout fails by name, after its monotonic timeout (card #234)', async () => {
  const startMs = monotonicNowMs();
  await assert.rejects(
    waitFor(() => monotonicNowMs() - startMs >= 2000, { timeoutMs: 60, message: 'predicate still false at the deadline' }),
    { message: 'predicate still false at the deadline' }
  );
  const waited = monotonicNowMs() - startMs;
  assert.ok(waited >= 60, `waitFor gave up after ${waited}ms, before its own 60ms timeout`);
});

// The other direction. Date.now() recedes by an hour on every poll after the first, so a
// Date.now()-based deadline is never reached; the predicate's own 2000ms self-rescue then turns it
// true and the wait RESOLVES, failing assert.rejects -- the "backward step extends a bounded wait"
// shape orchestrator/monotonic-clock.js's header measured on this box (-2515ms in one 10ms interval).
test('waitFor: a backward Date.now() step mid-wait does not extend the deadline', async () => {
  const realDateNow = Date.now;
  const startMs = monotonicNowMs();
  let calls = 0;
  try {
    await assert.rejects(
      waitFor(
        () => {
          calls++;
          if (calls >= 2) Date.now = () => realDateNow() - calls * HOUR_MS;
          return monotonicNowMs() - startMs >= 2000;
        },
        { timeoutMs: 60, intervalMs: 5, message: 'still false at the monotonic deadline' }
      ),
      { message: 'still false at the monotonic deadline' }
    );
  } finally {
    Date.now = realDateNow;
  }
  const waited = monotonicNowMs() - startMs;
  assert.ok(waited < 1500, `waitFor ran ${waited}ms against a 60ms bound while Date.now() receded -- its deadline follows the wall clock`);
});

test('pollUntil: a forward Date.now() step mid-poll does not end it early, and it reports the predicate met', async () => {
  const realDateNow = Date.now;
  const counter = { calls: 0 };
  let met;
  try {
    met = await pollUntil(forwardSteppingPredicate(realDateNow, counter), { timeoutMs: 8000, intervalMs: 10 });
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(met, true, 'pollUntil gave up although its predicate turned true on its fifth poll -- its deadline follows the wall clock');
  assert.equal(counter.calls, 5);
});

test('pollUntil: returns false (never throws) once its monotonic timeout passes', async () => {
  const startMs = monotonicNowMs();
  const met = await pollUntil(() => monotonicNowMs() - startMs >= 2000, { timeoutMs: 60 });
  const waited = monotonicNowMs() - startMs;
  assert.equal(met, false);
  assert.ok(waited >= 60 && waited < 1500, `pollUntil gave up after ${waited}ms against a 60ms bound`);
});

test('waitFor: a predicate that throws counts as "not yet", and the last error rides on the timeout -- in the message AND as its cause', async () => {
  let calls = 0;
  await waitFor(() => {
    calls++;
    if (calls < 3) throw new Error('ENOENT: not there yet');
    return true;
  }, { intervalMs: 1 });
  assert.equal(calls, 3);

  // Throws for 2000ms of monotonic time, then turns true -- the same self-rescue as card #234's
  // timeout test above, so a helper whose bound never fires RESOLVES (and fails the assertion
  // below) instead of polling forever and hanging the suite.
  const startMs = monotonicNowMs();
  const err = await waitFor(
    () => {
      if (monotonicNowMs() - startMs >= 2000) return true;
      throw new Error('ENOENT: never there');
    },
    { timeoutMs: 30, intervalMs: 5, message: 'never appeared' }
  ).then(
    () => null,
    (e) => e
  );
  assert.ok(err, 'a predicate that always throws must time out, not resolve');
  // The message itself carries the predicate's error: Node 22's TAP reporter -- every redirected
  // run, gate.sh logs included -- prints the message and drops `cause`, so a broken predicate
  // would otherwise read as a plain timeout.
  assert.equal(err.message, 'never appeared (last predicate error: ENOENT: never there)');
  assert.equal(err.cause && err.cause.message, 'ENOENT: never there');
});

test('waitFor: the message stays verbatim when the predicate never threw -- a last poll that returned false clears an earlier error', async () => {
  let calls = 0;
  const err = await waitFor(
    () => {
      calls++;
      if (calls === 1) throw new Error('ENOENT: first poll only');
      return false;
    },
    { timeoutMs: 40, intervalMs: 5, message: 'still false' }
  ).then(
    () => null,
    (e) => e
  );
  assert.ok(err && calls > 1);
  assert.equal(err.message, 'still false');
  assert.equal(err.cause, undefined);
});

// An async predicate must be AWAITED: a pending Promise is truthy, so a loop that forgot the
// `await` would "succeed" on the first poll of a predicate whose answer is false.
test('waitFor/pollUntil: an async predicate is awaited, never read as truthy because it is a Promise', async () => {
  let calls = 0;
  const asyncPredicate = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return calls >= 3;
  };
  await waitFor(asyncPredicate, { timeoutMs: 8000, intervalMs: 1 });
  assert.equal(calls, 3, 'waitFor resolved before its async predicate turned true');

  const met = await pollUntil(async () => false, { timeoutMs: 40, intervalMs: 5 });
  assert.equal(met, false, 'pollUntil read a pending Promise(false) as a met condition');
  await assert.rejects(waitFor(async () => false, { timeoutMs: 40, intervalMs: 5, message: 'async false' }), { message: 'async false' });
});

// A bare number is the trap: dispatcher.test.js and drain.test.js keep a POSITIONAL
// waitFor(predicate, timeoutMs) of the same name, and destructuring a number would silently wait
// the 30s default instead of the budget the caller wrote.
test('waitFor/pollUntil: a non-object options argument throws a TypeError at once, never a silent default', async () => {
  for (const bad of [5000, '5000', null, true]) {
    const isOptsTypeError = (err) => err instanceof TypeError && /opts must be an object/.test(err.message);
    await assert.rejects(waitFor(() => true, bad), isOptsTypeError, `waitFor accepted ${String(bad)}`);
    await assert.rejects(pollUntil(() => true, bad), isOptsTypeError, `pollUntil accepted ${String(bad)}`);
  }
  await waitFor(() => true); // no options at all is fine
  assert.equal(await pollUntil(() => true), true);
});

test('waitFor: the default budget is the contention-sized one, not a quiet-box one (card #252 addendum)', () => {
  // 8000ms genuinely ran out at load 20-23 on 8 cores. The default must stay well clear of it.
  assert.ok(DEFAULT_WAIT_TIMEOUT_MS >= 30000, `DEFAULT_WAIT_TIMEOUT_MS is ${DEFAULT_WAIT_TIMEOUT_MS}`);
});

test('elapsedMs: a forward Date.now() step between start and read does not inflate the interval', () => {
  const realDateNow = Date.now;
  const start = monoNow();
  let measured;
  try {
    Date.now = () => realDateNow() + HOUR_MS;
    measured = elapsedMs(start);
  } finally {
    Date.now = realDateNow;
  }
  assert.ok(measured >= 0 && measured < 1000, `elapsedMs read ${measured}ms across a +1h wall-clock step`);
});

test('busyWaitMs: a forward Date.now() step mid-spin does not cut the block short', () => {
  const realDateNow = Date.now;
  let calls = 0;
  const startMs = monotonicNowMs();
  try {
    // Every read after the first is an hour ahead: a Date.now()-bounded spin exits on its first check.
    Date.now = () => realDateNow() + (++calls > 1 ? HOUR_MS : 0);
    busyWaitMs(50);
  } finally {
    Date.now = realDateNow;
  }
  const blocked = monotonicNowMs() - startMs;
  assert.ok(blocked >= 50, `busyWaitMs(50) blocked only ${blocked}ms under a forward wall-clock step`);
});
