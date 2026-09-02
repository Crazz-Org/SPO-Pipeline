'use strict';
// accounts.js -- the Claude Max account pool: discovery-based registry + runtime cooldown
// state. doc/state-machine-spec.md § Account pool.
//
// ONE place holds account information (maintainer decision, 2026-08-29): the pool directory
// itself. Every SUBDIRECTORY of the pool is one account -- there is no separate accounts.json
// to keep in sync, and no implicit fallback to whatever `claude` login happens to be active on
// this machine. A fresh checkout with an empty (or missing) pool directory registers zero
// accounts; NoAccountsRegisteredError below is what callers see for that -- see
// doc/setup.md § Accounts for how an operator adds the first one (`spo account add <name>`).
//
//   <poolDir>/<name>/              one directory per account, name = the account's name. This
//                                  IS the account's CLAUDE_CONFIG_DIR.
//     oauth-token                  optional: the long-lived token `claude setup-token` prints,
//                                  pasted here by the operator. Its ABSENCE is not an error --
//                                  an account can also carry credentials a plain `claude` login
//                                  already wrote into this same directory, with no separate
//                                  token file.
//     disabled                     optional marker file (content ignored) -- its presence
//                                  disables the account, same effect as `enabled: false` used
//                                  to have in the old accounts.json.
//   <poolDir>/state.json           runtime-written cooldowns -- {accountName: {cooldownUntil:
//                                  epochMs, lastUsageLimitAt?: epochMs, usageLimitStreak?:
//                                  int}}. The latter two (action 3.5) exist only to decide
//                                  whether the NEXT usage limit escalates -- see markLimit's own
//                                  comment; an 'overloaded' cooldown never writes them, and an
//                                  entry from before 3.5 (bare {cooldownUntil}) simply lacks them,
//                                  which reads as "no prior usage hit on record". Machine-owned,
//                                  disposable: deleting it clears every cooldown (and every
//                                  escalation streak with it). Lives next to the accounts on
//                                  purpose -- one directory, one source of truth for the whole
//                                  pool.
//
// Every function here takes the pool directory as an explicit first argument -- this is what
// lets the test suite point at a fs.mkdtempSync(os.tmpdir()) directory instead of the real
// pool (default ~/.claude-accounts, see orchestrator/config.js's claudeAccountsDir / the
// SPO_ACCOUNTS_DIR env override).
//
// This module never journals anything itself (same separation as scripted.js/llm.js) -- it
// returns event payloads (markLimit's return value) for the caller to append.

const fs = require('fs');
const path = require('path');

// action 6.2: markLimit's own .state.lock reuses lock.js's short-lock primitive (see that
// module's own header for why it's a deliberately simpler idiom than daemon.lock's tmp+link
// dance) rather than re-implementing the same wx-create + pid-liveness-stale-sweep +
// release-only-if-ours idiom a third time. config.js has no require() on this module (or on
// anything that transitively requires it), so this is not a cycle -- see config.js itself.
const lock = require('./lock');
const config = require('./config');
const { monotonicNowMs } = require('./monotonic-clock');

const OAUTH_TOKEN_FILENAME = 'oauth-token';
const DISABLED_MARKER_FILENAME = 'disabled';
const LABELS_FILENAME = 'labels.json';
// The account directory IS a CLAUDE_CONFIG_DIR, so a settings.json inside it is that account's
// user-settings tier -- see syncSettings() below for why the pool needs one at all.
const SETTINGS_FILENAME = 'settings.json';

// Action 3.5 R1 (2026-08-31 redesign) -- replacing this action's own first cut, a flat 5-hour
// usage cooldown. The verifier measured the real pool: 2 accounts
// (~/.claude-accounts/pool1, pool2). At maxAttempts = pool size, two usage limits landing in one
// window took the WHOLE pool down for up to 5 hours, with no pool-health gate anywhere in
// daemon.js to notice -- every card the daemon pulled during that window parked at its first LLM
// step. And the 5h figure over-waits by construction: the Claude Max session window resets 5h
// after the SESSION's first message, not after the limit hit, so `now + 5h` sleeps for (5h - the
// true remaining wait) longer than necessary -- often 4h+.
//
// The problem the flat 5h was solving is real but small: at a 1-hour cooldown, an account that
// comes back gets picked, immediately re-limits (the window hasn't actually rolled), and pays one
// wasted call. That is not worth a 5-hour outage across the whole pool to avoid.
//
// So: an escalating PROBE instead of one flat number, decided here in markLimit (this module owns
// the pool state, including the history the escalation decision needs -- see markLimit's own
// comment for why that ruled out keeping this as a standalone pure function of limitKind alone).
//
//   USAGE_PROBE_COOLDOWN_MS     -- 1 hour. The FIRST usage limit seen for an account, or one that
//                                   lands outside ESCALATION_WINDOW_MS of the account's last one.
//                                   A probe, not a claim that the window is over: if it comes back
//                                   too early, the cost is one wasted call, same as the old 1h
//                                   default this replaces.
//   USAGE_ESCALATED_COOLDOWN_MS -- 5 hours. A usage limit landing again WITHIN
//                                   ESCALATION_WINDOW_MS of the account's last one -- the probe
//                                   just proved the session window really is still open, so wait
//                                   out the real observed Claude Max session window instead of
//                                   probing hourly into a wall.
//   OVERLOADED_COOLDOWN_MS      -- 5 minutes, flat, never escalates (kept from this action's first
//                                   cut). A busy SERVER (529 / overloaded_error) says nothing
//                                   about THIS account's quota, so nothing about it should
//                                   compound -- applying the usage tiers to it would take the
//                                   whole pool out for hours over a transient blip.
const USAGE_PROBE_COOLDOWN_MS = 60 * 60 * 1000;
const USAGE_ESCALATED_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const OVERLOADED_COOLDOWN_MS = 5 * 60 * 1000;

// How recently the account's PREVIOUS usage-limit hit (state.json's lastUsageLimitAt) must have
// landed for a new one to count as "the same still-open window" rather than a fresh occurrence.
// Chosen as 2x the probe cooldown (2 hours), not 1x: the earliest a probe can possibly be
// re-picked and re-limited is right at the 1-hour probe's own expiry (daemon.js's default
// pollIntervalMs is 5s, negligible on its own) -- but a busy pool can delay the account's actual
// next turn well past the moment it becomes merely eligible again (other queued cards ahead of
// it, step deadlines, timeout retries). The extra hour of slack absorbs that scheduling delay.
// Two hours is still comfortably inside a single ~5h Claude Max session window, so it will not
// mistake a hit on a genuinely fresh session (e.g. the same account limiting again the next day)
// for a continuation of the same exhausted one -- that case is exactly what falling back to a
// fresh 1h probe is for.
const ESCALATION_WINDOW_MS = 2 * 60 * 60 * 1000;

// Thrown by pick() (readRegistry() itself just returns an empty array -- this is the "someone
// tried to actually use the pool" signal) when the pool directory has zero subdirectories: a
// fresh checkout, or a pool directory that was never created. Distinct from
// AllAccountsCoolingError (which means "some accounts exist, none are usable right now") --
// this one means "there is nothing to try at all." state-machine.js maps both to PARKED the
// same way; daemon.js additionally refuses to START in --real mode on this one.
class NoAccountsRegisteredError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'NoAccountsRegisteredError';
    this.reason = reason;
    this.detail = detail;
  }
}

// Thrown by pick() when no enabled account has a cooldownUntil that is absent or already past.
// The state machine catches this and maps it straight to PARKED, reusing `reason` and `detail`
// verbatim -- reason names the earliest cooldownUntil so the parked report says when to retry
// without anyone needing to open state.json.
class AllAccountsCoolingError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'AllAccountsCoolingError';
    this.reason = reason;
    this.detail = detail;
  }
}

// Thrown by pick() (action 6.2) when opts.excludeAccounts is supplied and every account that
// would otherwise be pick()-able (enabled, not cooling) is in that set -- i.e. every HEALTHY
// account is currently leased by another live worker, as opposed to AllAccountsCoolingError
// (every enabled account has a cooldownUntil in the future). The distinction matters because the
// two park differently: a cooling account is never worth waiting on (state-machine.js/intake.js
// never even construct this error's caller with a wait loop for that case), but a leased account
// legitimately might free up within the bound orchestrator/account-lease.js's leaseHealthyAccount
// waits -- see that module's own header and doc/remediation-progress.md's C6 decision record for
// why per-step leasing makes waiting the right default instead of parking immediately the way
// AllAccountsCoolingError does.
class AllAccountsLeasedError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'AllAccountsLeasedError';
    this.reason = reason;
    this.detail = detail;
  }
}

function stateJsonPath(poolDir) {
  return path.join(poolDir, 'state.json');
}

// action 6.2: markLimit's short bounded lock around its read-modify-write. A plain file (never a
// directory, same reasoning as the per-account lease files in account-lease.js) so readRegistry's
// "every subdirectory is an account, no dot-prefix exclusion" scan can never mistake it for one --
// it lives alongside state.json/labels.json, dot-prefixed so it reads unambiguously as
// machine-owned bookkeeping to anyone browsing the pool directory by hand.
function stateLockPath(poolDir) {
  return path.join(poolDir, '.state.lock');
}

// The registry, discovered fresh from disk every call -- one entry per subdirectory of
// poolDir, sorted by name for a deterministic pick() order. A missing poolDir is not an
// error, just "nothing registered yet" -- same as an empty pool directory (both return []).
function readRegistry(poolDir) {
  if (!fs.existsSync(poolDir)) return [];
  return fs
    .readdirSync(poolDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const configDir = path.join(poolDir, name);
      const oauthTokenFile = path.join(configDir, OAUTH_TOKEN_FILENAME);
      return {
        name,
        configDir,
        oauthTokenFile: fs.existsSync(oauthTokenFile) ? oauthTokenFile : null,
        enabled: !fs.existsSync(path.join(configDir, DISABLED_MARKER_FILENAME)),
      };
    });
}

// Whether `configDir` holds anything besides the three files this module itself manages
// (oauth-token, disabled, settings.json) -- i.e. real credentials, written there by `claude
// setup-token`'s underlying login flow (or a plain `claude` login pointed at this
// CLAUDE_CONFIG_DIR). Used by `spo accounts` and the dashboard's accounts section to show
// "credentials: yes/no" without hardcoding the exact filename(s) Claude Code itself writes
// there. settings.json belongs in this exclusion list for the same reason the other two do:
// syncSettings() writes it, so counting it as credentials would make every synced account
// report "credentials: yes" the moment the pool is synced, whether or not it can authenticate.
const MANAGED_FILENAMES = new Set([OAUTH_TOKEN_FILENAME, DISABLED_MARKER_FILENAME, SETTINGS_FILENAME]);

function hasCredentials(configDir) {
  if (!configDir || !fs.existsSync(configDir)) return false;
  return fs.readdirSync(configDir).some((entry) => !MANAGED_FILENAMES.has(entry));
}

// Optional, hand-maintained accountName -> {email, plan} map the operator fills in once, at
// <poolDir>/labels.json. WHY this has to be hand-maintained: nothing Claude Code itself writes
// into an account's CLAUDE_CONFIG_DIR carries an email address or subscription tier -- .claude.json
// holds only a hashed userID (confirmed by inspecting a real pool directory, 2026-08-30), and
// there is no `claude whoami`-style command to ask for one headlessly. The dashboard's accounts
// table (console/render.js renderAccountsInner) reads this through collectAccounts to show
// "email"/"plan" columns instead of just the pool's arbitrary directory name. A missing or
// unparsable file is not an error, just "nothing labeled yet" -- same posture as readState.
function readLabels(poolDir) {
  const p = path.join(poolDir, LABELS_FILENAME);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

// Installs one permission policy as the USER-tier settings of every account in the pool.
//
// WHY this exists: steps/llm.js spawns `claude -p` with CLAUDE_CONFIG_DIR set to the account's
// own directory, so the machine's ~/.claude/settings.json is never read by a pipeline step --
// an account directory IS its own user-settings tier, and an unsynced one has no rules at all.
// Today every step happens to land in a directory that carries a project policy (the pipeline
// root or a product worktree), which masks the gap; a step whose cwd has no .claude/settings.json
// would run with nothing. Syncing gives every account the same floor regardless of cwd, and
// regardless of which account the rotation picks.
//
// `settingsText` is written verbatim so the repo's own .claude/settings.json stays the single
// source of truth -- callers read it and pass it here rather than this module carrying a second
// copy of the rules that could drift from the one git reviews.
//
// Overwrites unconditionally: the file is machine-owned (the marker key below says so in the
// file itself). Never touches an account's credentials, its oauth-token, or its disabled marker.
// A missing pool directory syncs nothing and is not an error -- same posture as readRegistry.
function syncSettings(poolDir, settingsText, { dryRun = false } = {}) {
  const results = [];
  for (const account of readRegistry(poolDir)) {
    const target = path.join(account.configDir, SETTINGS_FILENAME);
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const action = before === null ? 'created' : before === settingsText ? 'unchanged' : 'updated';
    if (!dryRun && action !== 'unchanged') {
      fs.writeFileSync(target, settingsText);
    }
    results.push({ name: account.name, path: target, action });
  }
  return results;
}

// Stamps the policy with a machine-owned marker before it is written into an account directory,
// so anyone opening ~/.claude-accounts/<name>/settings.json sees why it is there and that hand
// edits do not survive. The key is a comment-shaped no-op: Claude Code's settings schema allows
// additional top-level properties, so it is carried without being interpreted.
function stampManagedSettings(settingsText, source) {
  const parsed = JSON.parse(settingsText);
  const stamped = {
    '//': `machine-owned -- written by \`spo account sync-settings\` from ${source}. Edits here are overwritten; change the source instead.`,
    ...parsed,
  };
  return `${JSON.stringify(stamped, null, 2)}\n`;
}

// Runtime cooldown state. A missing or unparsable state.json is just "nobody has ever hit a
// limit yet" -- never an error.
function readState(poolDir) {
  const p = stateJsonPath(poolDir);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

// Atomic, for the same reason journal.js's writeState is -- but the consequence here is worse.
// readState above treats an unparsable file as "nobody has ever hit a limit yet" and returns {},
// so a kill -9 between open and write does not fail loudly: it SILENTLY WIPES every cooldown in
// the pool. The next pick then hands work straight back to a rate-limited account, which is
// exactly the loop action 3.6 was written to end, and it would resurface as an unexplained
// rate-limit park with nothing in the journal to explain it (lock.js's own header names this
// failure). tmp + rename means a reader sees either the whole previous state or the whole new
// one, never a truncated file. The tmp sits in poolDir itself because rename is only atomic
// within a filesystem.
function writeState(poolDir, state) {
  fs.mkdirSync(poolDir, { recursive: true });
  const target = stateJsonPath(poolDir);
  const tmp = path.join(poolDir, `.state.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp was never created, or rename already moved it -- nothing to clean up either way.
    }
    throw err;
  }
}

// First enabled account (registry order = pick order -- no round robin, no load balancing;
// spreading calls across K healthy accounts is a scheduler-level concern, not this module's)
// whose cooldownUntil is absent or already past `now`. `now` is a parameter, not always
// Date.now(), so tests can assert cooldown/recovery behaviour without sleeping.
//
// action 6.2: `opts.excludeAccounts` (a Set<string> of account names, e.g. every account
// currently held by another live process's per-step lease -- see orchestrator/account-lease.js's
// leasedAccountNames) is OPT-IN and additive to the cooldown filter above, never a replacement
// for it: an excluded-but-cooling account was never going to be returned anyway. With no opts (or
// opts.excludeAccounts omitted/empty), this function is BYTE-FOR-BYTE what it was before this
// action -- bin/spo and every pre-6.2 test call it bare, and the early `return account` below
// fires on the very first healthy account exactly as it always did, so the exclusion machinery
// costs nothing when unused.
//
// Distinguishing WHY nothing was returned matters to the two callers (state-machine.js's
// callLlmStep, intake.js's callIntakeStepWithRotation, both via account-lease.js's
// leaseHealthyAccount): every enabled account cooling is the existing AllAccountsCoolingError
// (never worth waiting out); at least one enabled account is healthy but every healthy one is in
// excludeAccounts is the NEW AllAccountsLeasedError (worth a bounded wait -- a sibling's lease is
// released in seconds to a couple of minutes, not hours). The two can't be conflated: a pool
// where one account is cooling and the other is leased must report "leased" (the cooling one was
// never pick()-able either way, so there IS a healthy candidate, just not an available one),
// which is why healthyCount is tracked independently of the early return below rather than
// inferred from whether the loop reached the end.
function pick(poolDir, now = Date.now(), opts = {}) {
  const registry = readRegistry(poolDir);
  if (registry.length === 0) {
    throw new NoAccountsRegisteredError('no-accounts-registered', { poolDir });
  }

  const state = readState(poolDir);
  const excludeAccounts = opts.excludeAccounts;

  let earliestCooldown = null;
  let healthyCount = 0;
  for (const account of registry) {
    if (!account.enabled) continue;
    const entry = state[account.name];
    const cooldownUntil = entry && entry.cooldownUntil;
    const healthy = !cooldownUntil || cooldownUntil <= now;
    if (!healthy) {
      if (earliestCooldown === null || cooldownUntil < earliestCooldown) {
        earliestCooldown = cooldownUntil;
      }
      continue;
    }
    healthyCount += 1;
    // The default (no excludeAccounts) path returns HERE, on the very first healthy account --
    // identical to the pre-6.2 loop, never reaching the healthyCount bookkeeping's consumers below.
    if (!excludeAccounts || !excludeAccounts.has(account.name)) return account;
  }

  if (healthyCount > 0) {
    // Every healthy account was excluded (leased by a live sibling) -- distinct from "none were
    // ever healthy" below. Only reachable when excludeAccounts was actually supplied and non-empty.
    throw new AllAccountsLeasedError('all-accounts-leased', {
      checkedAccounts: registry.map((a) => a.name),
      excludedAccounts: Array.from(excludeAccounts),
    });
  }

  const reason =
    earliestCooldown === null
      ? 'all-accounts-cooling-unknown' // every account disabled, or the registry is empty of enabled entries
      : `all-accounts-cooling-until-${new Date(earliestCooldown).toISOString()}`;
  throw new AllAccountsCoolingError(reason, {
    earliestCooldownUntil: earliestCooldown,
    checkedAccounts: registry.map((a) => a.name),
  });
}

// countHealthyAccounts(poolDir, now) -> the number of ENABLED accounts whose cooldownUntil is
// absent or already past `now` -- the exact same "healthy" test pick()'s own loop applies above,
// without picking one or throwing when the answer is zero. Action 6.3: the dispatcher clamps K
// (its worker count) to this number before EVERY spawn (the plan's own "K <= healthy accounts"
// row, deferred from 6.2 -- 6.2 only ever had one caller in flight at a time, so there was
// nothing to clamp yet; the dispatcher is the first thing that can actually run K of them).
//
// Deliberately blind to account-lease.js's per-step LEASES (as opposed to cooldowns): a lease is
// a seconds-to-minutes hold around one LLM call, not a fact about the POOL's capacity the way an
// hours-long cooldown is -- clamping K on lease state too would make K flap on every single LLM
// call across every worker instead of settling once per cooldown/recovery event, which is not
// what "K workers" is supposed to mean (K is a concurrency budget, not "accounts idle right now").
function countHealthyAccounts(poolDir, now = Date.now()) {
  const registry = readRegistry(poolDir);
  if (registry.length === 0) return 0;
  const state = readState(poolDir);
  let healthy = 0;
  for (const account of registry) {
    if (!account.enabled) continue;
    const entry = state[account.name];
    const cooldownUntil = entry && entry.cooldownUntil;
    if (!cooldownUntil || cooldownUntil <= now) healthy += 1;
  }
  return healthy;
}

// Records a limit hit for `name` and decides how long to cool it down for -- unlike the flat
// tier this replaced, that decision now needs the account's OWN history (its last usage-limit
// timestamp, to know whether this hit is inside the same escalation window), which only a read
// of state.json can supply. That is why the old `cooldownMsForLimitKind(limitKind)` pure
// function is gone rather than kept alongside this: it could not see history, so keeping it
// would mean every caller still has to remember to call it AND pass the result in, for no benefit
// now that there is exactly one place (here) that needs the mapping. Both real call sites
// simplified accordingly, straight to `accounts.markLimit(accountsDir, account.name,
// result.limitKind)`.
//
// `limitKind`:
//   'overloaded' -- flat OVERLOADED_COOLDOWN_MS (5 min). Never escalates, and never touches (or
//                   even reads) the usage-escalation fields below -- a busy server says nothing
//                   about this account's own quota.
//   'usage', or anything else (undefined/null/an unrecognised string -- fail-safe, see below) --
//                   USAGE_ESCALATED_COOLDOWN_MS (5h) if `state[name].lastUsageLimitAt` is within
//                   ESCALATION_WINDOW_MS of `now`, otherwise USAGE_PROBE_COOLDOWN_MS (1h).
//                   `usageLimitStreak` counts consecutive escalated hits; the decision above
//                   doesn't consult it, it exists so a maintainer reading state.json by hand can
//                   see how long an account has been stuck without doing the arithmetic.
//
// `defaulted` means exactly what R2 (F2) needed it to mean again: no *recognised* limitKind
// ('usage' or 'overloaded') was supplied, and the usage fail-safe applied anyway. Before this
// change cooldownMsForLimitKind returned a positive number for every JS value, so `defaulted`
// was structurally always false in production, and the journalled event carried no limitKind at
// all -- the one case the fallback exists for (a limit shape classifyFailure recognizes but that
// isn't in a limitKind bucket) was indistinguishable from a genuine 429/529 in the journal. Both
// are fixed here: `limitKind` is always on the returned event (`null` when absent), and
// `defaulted` is true exactly when that value wasn't 'usage' or 'overloaded'.
//
// An entry written by pre-3.5 code (bare `{cooldownUntil}`, no lastUsageLimitAt/usageLimitStreak)
// reads back fine: both fields are simply absent, which this function reads as "no prior usage
// hit on record" -- it probes at 1h, exactly like a genuine first-ever hit would.
//
// Pulled out of markLimit itself (action 6.2) so the lock-acquire/read/merge/write/release
// wrapper below has one pure function to call on EITHER side of "did we get the lock" -- the
// computation (and the state.json shape it produces) must be identical whether or not the lock
// was acquired; only whether a concurrent writer could interleave with it differs. Returns
// {nextState, event}; never touches disk itself.
function computeLimitUpdate(state, name, limitKind, now) {
  const entry = state[name] || {};

  const overloaded = limitKind === 'overloaded';
  const defaulted = !overloaded && limitKind !== 'usage';

  let ms;
  let escalated = false;
  if (overloaded) {
    ms = OVERLOADED_COOLDOWN_MS;
  } else {
    const last = typeof entry.lastUsageLimitAt === 'number' ? entry.lastUsageLimitAt : null;
    escalated = last !== null && now - last <= ESCALATION_WINDOW_MS;
    ms = escalated ? USAGE_ESCALATED_COOLDOWN_MS : USAGE_PROBE_COOLDOWN_MS;
  }
  const cooldownUntil = now + ms;

  const nextState = { ...state };
  if (overloaded) {
    nextState[name] = { ...entry, cooldownUntil };
  } else {
    const prevStreak = typeof entry.usageLimitStreak === 'number' ? entry.usageLimitStreak : 0;
    nextState[name] = {
      ...entry,
      cooldownUntil,
      lastUsageLimitAt: now,
      usageLimitStreak: escalated ? prevStreak + 1 : 1,
    };
  }

  const event = {
    account: name,
    limitKind: limitKind ?? null,
    cooldownMs: ms,
    cooldownUntil,
    cooldownUntilIso: new Date(cooldownUntil).toISOString(),
    escalated,
    defaulted,
  };
  return { nextState, event };
}

// Blocking sleep of at most `ms`, used ONLY by markLimit's short lock-wait retry below. A real
// (non-Promise) sleep, not async: markLimit has been a synchronous function since action 3.5 and
// every real call site (state-machine.js's callLlmStep, intake.js's callIntakeStepWithRotation)
// calls it without awaiting -- turning it async here would ripple into both. Atomics.wait on a
// scratch SharedArrayBuffer is the standard Node idiom for a synchronous, non-busy-spinning sleep
// on the main thread (it actually blocks the thread rather than burning CPU polling Date.now());
// it is no more "blocking" than the spawnSync calls this same codebase already makes throughout
// steps/llm.js and steps/scripted.js for every real gh/npm/claude invocation, and the bound this
// guards (accountStateLockWaitMs, 2s default) is short enough that blocking here costs nothing
// next to the 90s+ step that just failed and is about to retry.
function sleepSyncMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Records a limit hit for `name` and decides how long to cool it down for -- unlike the flat
// tier this replaced, that decision now needs the account's OWN history (its last usage-limit
// timestamp, to know whether this hit is inside the same escalation window), which only a read
// of state.json can supply. That is why the old `cooldownMsForLimitKind(limitKind)` pure
// function is gone rather than kept alongside this: it could not see history, so keeping it
// would mean every caller still has to remember to call it AND pass the result in, for no benefit
// now that there is exactly one place (here) that needs the mapping. Both real call sites
// simplified accordingly, straight to `accounts.markLimit(accountsDir, account.name,
// result.limitKind)`.
//
// `limitKind`:
//   'overloaded' -- flat OVERLOADED_COOLDOWN_MS (5 min). Never escalates, and never touches (or
//                   even reads) the usage-escalation fields below -- a busy server says nothing
//                   about this account's own quota.
//   'usage', or anything else (undefined/null/an unrecognised string -- fail-safe, see below) --
//                   USAGE_ESCALATED_COOLDOWN_MS (5h) if `state[name].lastUsageLimitAt` is within
//                   ESCALATION_WINDOW_MS of `now`, otherwise USAGE_PROBE_COOLDOWN_MS (1h).
//                   `usageLimitStreak` counts consecutive escalated hits; the decision above
//                   doesn't consult it, it exists so a maintainer reading state.json by hand can
//                   see how long an account has been stuck without doing the arithmetic.
//
// `defaulted` means exactly what R2 (F2) needed it to mean again: no *recognised* limitKind
// ('usage' or 'overloaded') was supplied, and the usage fail-safe applied anyway. Before this
// change cooldownMsForLimitKind returned a positive number for every JS value, so `defaulted`
// was structurally always false in production, and the journalled event carried no limitKind at
// all -- the one case the fallback exists for (a limit shape classifyFailure recognizes but that
// isn't in a limitKind bucket) was indistinguishable from a genuine 429/529 in the journal. Both
// are fixed here: `limitKind` is always on the returned event (`null` when absent), and
// `defaulted` is true exactly when that value wasn't 'usage' or 'overloaded'.
//
// action 6.2: the read-modify-write above used to run completely unlocked -- two processes each
// reading state.json, each computing their own account's new entry off that same snapshot, each
// writing back, and whichever write lands second silently discards the first process's update
// (still atomic per-write thanks to writeState's tmp+rename, just each write is a full
// replacement of the WHOLE state object, not a merge). Two workers hitting a limit on two
// DIFFERENT accounts at close to the same instant now loses one of their cooldowns entirely --
// exactly the live pool's `pool1: {usageLimitStreak: 2}` escalation history this could clobber.
// Wrapped here in a short, bounded lock (accountStateLockWaitMs, default 2s) around the
// read-modify-write: acquire, re-read state INSIDE the lock (a snapshot taken before acquiring
// could already be stale), compute, write, release. `opts.lockWaitMs`/`opts.lockPollMs`/
// `opts.isAlive` let tests shrink the bound or force a specific liveness outcome without waiting
// on config.js's real defaults.
//
// Degrade, never fail: if the lock can't be acquired within its bound (another live process holds
// it past accountStateLockWaitMs -- plausible only under real concurrency, since the critical
// section itself is microseconds), this falls through to exactly the OLD unlocked behaviour
// (read, compute, write, no lock) rather than throwing -- losing a cooldown update is a wasted
// call; failing an LLM step's own error-handling path over pool bookkeeping would turn a rate
// limit into a parked card. `degraded: true` is stamped on the returned event so the caller's
// journalled `account-cooldown` payload records that this happened, instead of the fallback being
// silently indistinguishable from a normal locked write.
// `now` (positional, defaults to Date.now()) is a WALL-CLOCK snapshot -- it flows into
// computeLimitUpdate's cooldownUntil/lastUsageLimitAt, which land on disk and get compared
// across processes, so it stays Date.now()-based, unconditionally, exactly as before.
//
// The WAIT LOOP below is a different question -- "how long have I been retrying for THIS lock" --
// and answering it with Date.now() was a bug, not a simplification: this box's wall clock jumps
// BACKWARD (measured, monotonic-clock.js's own header has the numbers), and a backward jump in
// `deadline - Date.now()` can only ever ENLARGE `remaining`, silently extending a bounded wait
// past its configured budget. `monotonicNowMs()` (opts.monotonicNowMs, defaulting to the real
// one) is immune to that by construction -- see monotonic-clock.js's header for exactly why this
// must never become a source of TIMESTAMPS, only of ELAPSED-TIME ARITHMETIC.
// `opts.sleepSyncMs` is the matching test-only override for the loop's own sleep (defaulting to
// the real, blocking `sleepSyncMs` above) -- a test driving `opts.monotonicNowMs` with a fake,
// always-advancing counter needs its `sleepSyncMs` to advance that SAME counter, or the loop
// would spin at real-hrtime granularity waiting for fake time to pass.
function markLimit(poolDir, name, limitKind, now = Date.now(), opts = {}) {
  const waitMs = opts.lockWaitMs !== undefined ? opts.lockWaitMs : config.accountStateLockWaitMs;
  const pollMs = opts.lockPollMs !== undefined ? opts.lockPollMs : config.accountStateLockPollMs;
  const isAlive = opts.isAlive || lock.processAlive;
  const lockFile = stateLockPath(poolDir);
  const elapsedNowMs = opts.monotonicNowMs || monotonicNowMs;
  const doSleepSyncMs = opts.sleepSyncMs || sleepSyncMs;

  const start = elapsedNowMs();
  let held = lock.acquireShortLock(lockFile, { isAlive });
  while (!held) {
    const remaining = waitMs - (elapsedNowMs() - start);
    if (remaining <= 0) break;
    doSleepSyncMs(Math.min(pollMs, remaining));
    held = lock.acquireShortLock(lockFile, { isAlive });
  }
  const degraded = !held;

  try {
    const state = readState(poolDir);
    const { nextState, event } = computeLimitUpdate(state, name, limitKind, now);
    writeState(poolDir, nextState);
    return { ...event, degraded };
  } finally {
    if (held) lock.releaseShortLock(lockFile, held);
  }
}

module.exports = {
  pick,
  countHealthyAccounts,
  markLimit,
  readRegistry,
  readState,
  writeState,
  hasCredentials,
  readLabels,
  syncSettings,
  stampManagedSettings,
  AllAccountsCoolingError,
  AllAccountsLeasedError,
  NoAccountsRegisteredError,
  USAGE_PROBE_COOLDOWN_MS,
  USAGE_ESCALATED_COOLDOWN_MS,
  OVERLOADED_COOLDOWN_MS,
  ESCALATION_WINDOW_MS,
  OAUTH_TOKEN_FILENAME,
  DISABLED_MARKER_FILENAME,
  LABELS_FILENAME,
  SETTINGS_FILENAME,
  stateLockPath,
};
