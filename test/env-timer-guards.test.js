'use strict';
// Regression coverage for the *_MS timer env-var guards in orchestrator/config.js.
//
// Before this file existed, 15 of config.js's `*_MS` env-var reads were bare `Number(process.env.X)`
// with no validation: "abc" -> NaN, "" -> 0, "-5" -> -5 all passed straight through into the
// exported config object. Consumers that guard with `if (!(x > 0)) return false` turned a typo
// into a silently DISABLED subsystem; the one consumer with no guard at all (lockWatchMs) turned
// a typo into a `setInterval` firing at 1ms.
//
// The fix routes every one of these 15 through one of two module-local helpers (both defined in
// config.js, neither exported -- tested here only through the config object's resolved fields):
//   - nonNegativeMsFromEnv: for the 11 vars where 0 is a documented, load-bearing SENTINEL (an
//     on/off switch, or a zero-length settling window) -- 0 must pass through unchanged.
//   - positiveMsFromEnv: for the 4 vars where 0 is NOT a sentinel and today causes unthrottled
//     polling -- 0 must fall back to the default, same as any other malformed override.
//
// config.js reads process.env at REQUIRE time (every value below is computed once, at module
// load, into a plain object), so a normal in-process `require()` only ever sees whatever the env
// was the first time this process loaded the module. `load()` below works around that by
// deleting the module from require.cache and re-requiring it with the env mutated first -- this
// forces config.js's top-level code (including every *FromEnv call) to re-run against the new
// env, the same effect a subprocess would have, without paying for one 90-ish times over.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = require.resolve('../orchestrator/config.js');
const CONFIG_SRC = fs.readFileSync(CONFIG_PATH, 'utf8');

// Shared with the regression-guard test below and its own non-vacuous fixture test, so the
// pattern is defined in exactly one place -- see that test's header for why matching it against a
// known bare-read fixture (and a known helper-body non-match) matters as much as the config.js
// scan itself.
const BARE_MS_READ_RE = /process\.env\.[A-Za-z0-9_]*_MS\b/g;

// Loads orchestrator/config.js with a given override for ONE env var, restoring the previous
// value (or absence of it) afterward regardless of outcome.
function loadConfigWith(name, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
    delete require.cache[CONFIG_PATH];
  }
}

// One row per routed timer. `field` is the exported config.js property; `zeroIsSentinel: true`
// means '0' must resolve to the number 0 (nonNegativeMsFromEnv); `false` means '0' must resolve
// to `defaultMs` (positiveMsFromEnv) because these four are plain poll-interval-shaped durations
// where 0 has never meant anything but "misconfigured" and would otherwise busy-loop.
//
// A future *_MS timer is one more row here, not new test code -- see the regression-guard test
// below for what keeps a bare, unrouted read of a *new* timer from ever landing unnoticed again.
const TIMERS = [
  // ---- nonNegativeMsFromEnv: 0 is a documented sentinel (11) ----
  { env: 'SPO_DRAIN_KILL_GRACE_MS', field: 'drainKillGraceMs', defaultMs: 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_DRAIN_TIMEOUT_MS', field: 'drainTimeoutMs', defaultMs: 45 * 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_ORPHAN_SCAN_MS', field: 'orphanScanMs', defaultMs: 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_UNPARK_SCAN_MS', field: 'unparkScanMs', defaultMs: 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_AUTO_TRIAGE_MS', field: 'autoTriageMs', defaultMs: 0, zeroIsSentinel: true },
  { env: 'SPO_ORPHAN_GRACE_MS', field: 'orphanGraceMs', defaultMs: 4 * 60 * 1000, zeroIsSentinel: true },
  // PRODUCTION CASE: the live systemd drop-in zz-auto-pull-off.conf sets SPO_AUTO_PULL_MS=0 to
  // keep the daemon from claiming cards. If '0' ever stopped resolving to 0 here, the production
  // daemon would silently start claiming cards again on its next restart.
  { env: 'SPO_AUTO_PULL_MS', field: 'autoPullMs', defaultMs: 5 * 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_AUTO_INTAKE_MS', field: 'autoIntakeMs', defaultMs: 15 * 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_REPORT_CONFIRM_SCAN_MS', field: 'reportConfirmScanMs', defaultMs: 5 * 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_TRIAGE_CLAIM_GRACE_MS', field: 'triageClaimGraceMs', defaultMs: 4 * 60 * 1000, zeroIsSentinel: true },
  { env: 'SPO_REMOTE_REPORT_PULL_MS', field: 'remoteReportPullMs', defaultMs: 5 * 60 * 1000, zeroIsSentinel: true },

  // ---- positiveMsFromEnv: 0 is NOT a sentinel, it means "unthrottled polling" (4) ----
  { env: 'SPO_CI_CHECKS_POLL_INTERVAL_MS', field: 'ciChecksPollIntervalMs', defaultMs: 20000, zeroIsSentinel: false },
  {
    env: 'SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS',
    field: 'benchIdleWaitPollIntervalMs',
    defaultMs: 5000,
    zeroIsSentinel: false,
  },
  { env: 'SPO_LOCK_WATCH_MS', field: 'lockWatchMs', defaultMs: 15 * 1000, zeroIsSentinel: false },
  { env: 'SPO_CACHE_TTL_MS', field: 'cacheTtlMs', defaultMs: 60 * 60 * 1000, zeroIsSentinel: false },
];

for (const { env, field, defaultMs, zeroIsSentinel } of TIMERS) {
  test(`config.${field} (${env}): unset -> default, valid override -> parsed, malformed -> default`, () => {
    assert.equal(loadConfigWith(env, undefined)[field], defaultMs, `${env} unset must resolve to the default`);

    assert.equal(loadConfigWith(env, '77000')[field], 77000, `${env}=77000 must resolve to 77000`);

    // The actual defect this file exists to catch: today (pre-fix) this yields NaN.
    assert.equal(
      loadConfigWith(env, 'abc')[field],
      defaultMs,
      `${env}=abc (non-numeric) must fall back to the default, not NaN`
    );

    // Today (pre-fix): Number('') is 0, so an empty override silently disables the subsystem
    // rather than being treated as the operator mistake it is.
    assert.equal(loadConfigWith(env, '')[field], defaultMs, `${env}="" must fall back to the default, not 0`);

    // Today (pre-fix): a negative value passes straight through.
    assert.equal(loadConfigWith(env, '-1')[field], defaultMs, `${env}=-1 must fall back to the default`);

    // Infinity is finite-rejected by both helpers on purpose: an Infinity timer makes every
    // `nowMs - lastAt >= x` guard false forever (the subsystem is off, silently), which is the
    // same defect as NaN arriving by a different route. Covered here for all 15 because
    // Number.isNaN alone would let it through.
    assert.equal(loadConfigWith(env, 'Infinity')[field], defaultMs, `${env}=Infinity must fall back to the default`);

    // The split this whole change exists to preserve: '0' is a live sentinel for 11 of these 15
    // vars (an off-switch, or "no settling wait") and must resolve to the number 0; for the other
    // 4 (plain poll-interval-shaped durations) 0 has never meant anything but "misconfigured" and
    // must fall back to the default, the same as any other malformed value above.
    assert.equal(
      loadConfigWith(env, '0')[field],
      zeroIsSentinel ? 0 : defaultMs,
      zeroIsSentinel
        ? `${env}=0 is a documented sentinel and must resolve to 0`
        : `${env}=0 is not a sentinel for this timer and must fall back to the default`
    );
  });
}

test('every TIMERS row is exercised (15 vars: 11 zero-sentinel + 4 strictly-positive)', () => {
  assert.equal(TIMERS.length, 15);
  assert.equal(TIMERS.filter((t) => t.zeroIsSentinel).length, 11);
  assert.equal(TIMERS.filter((t) => !t.zeroIsSentinel).length, 4);
});

// Regression guard (CLAUDE.md-adjacent, but purely mechanical): a future *_MS env var read
// directly off `process.env.SPO_..._MS` in config.js, bypassing both helpers, silently
// reintroduces the exact class of bug this file exists to close. This scans config.js's SOURCE
// TEXT rather than requiring the module and inspecting values, because the defect is in HOW the
// value is parsed, not what it resolves to for any one input -- see test/doc-constant-sweep.test.js's
// own header for why a source-text pin, not a re-derived expectation, is the only thing that can
// catch this class at all.
//
// Deliberately narrow: matches `process.env.<NAME>_MS` (dot notation, a literal identifier ending
// in `_MS`) -- the only shape a bare, unguarded read can take in this file. It does NOT match:
//   - the helpers' own bodies (`process.env[name]`, bracket notation with a variable, never a
//     literal `_MS`-suffixed property name)
//   - any *_MS var already routed through timeoutFromEnv/positiveMsFromEnv/nonNegativeMsFromEnv/
//     nonNegativeIntFromEnv/positiveIntFromEnv (those call the helper by name, they never repeat
//     `process.env.X` themselves)
//   - non-MS vars (SPO_COMMENT_SCAN_MAX_PAGES, SPO_AUTO_PULL_LIMIT, etc.), which this guard is not
//     about
test('orchestrator/config.js has no bare `process.env.*_MS` read outside the *FromEnv helpers', () => {
  const offenders = CONFIG_SRC.match(BARE_MS_READ_RE) || [];
  assert.deepEqual(
    offenders,
    [],
    `found ${offenders.length} bare process.env.*_MS read(s) in orchestrator/config.js: ` +
      `${offenders.join(', ')} -- route each through timeoutFromEnv, positiveMsFromEnv, or ` +
      `nonNegativeMsFromEnv (pick nonNegativeMsFromEnv if 0 is a meaningful value for this timer, ` +
      `positiveMsFromEnv otherwise) instead of a bare Number(process.env.X)`
  );
});

test('the bare-read scan pattern is not vacuous: it matches a bare read and never the helpers own bracket access', () => {
  assert.deepEqual(
    'const X = process.env.SPO_FAKE_MS !== undefined ? Number(process.env.SPO_FAKE_MS) : 1;'.match(BARE_MS_READ_RE),
    ['process.env.SPO_FAKE_MS', 'process.env.SPO_FAKE_MS'],
    'the guard pattern stopped matching a bare `process.env.<NAME>_MS` read -- it is now vacuous and the guard above checks nothing'
  );
  assert.equal('const raw = process.env[name];'.match(BARE_MS_READ_RE), null,
    'the guard pattern must never match the helpers own bracket access, or every helper body becomes an offender');
});
