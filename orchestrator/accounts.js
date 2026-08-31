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

function stateJsonPath(poolDir) {
  return path.join(poolDir, 'state.json');
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
function pick(poolDir, now = Date.now()) {
  const registry = readRegistry(poolDir);
  if (registry.length === 0) {
    throw new NoAccountsRegisteredError('no-accounts-registered', { poolDir });
  }

  const state = readState(poolDir);

  let earliestCooldown = null;
  for (const account of registry) {
    if (!account.enabled) continue;
    const entry = state[account.name];
    const cooldownUntil = entry && entry.cooldownUntil;
    if (!cooldownUntil || cooldownUntil <= now) return account;
    if (earliestCooldown === null || cooldownUntil < earliestCooldown) {
      earliestCooldown = cooldownUntil;
    }
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
// hit on record" -- it probes at 1h, exactly like a genuine first-ever hit would. Returns the
// event payload the caller journals -- this module never writes the journal itself, same
// separation of concerns scripted.js/llm.js already use.
function markLimit(poolDir, name, limitKind, now = Date.now()) {
  const state = readState(poolDir);
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

  if (overloaded) {
    state[name] = { ...entry, cooldownUntil };
  } else {
    const prevStreak = typeof entry.usageLimitStreak === 'number' ? entry.usageLimitStreak : 0;
    state[name] = {
      ...entry,
      cooldownUntil,
      lastUsageLimitAt: now,
      usageLimitStreak: escalated ? prevStreak + 1 : 1,
    };
  }
  writeState(poolDir, state);

  return {
    account: name,
    limitKind: limitKind ?? null,
    cooldownMs: ms,
    cooldownUntil,
    cooldownUntilIso: new Date(cooldownUntil).toISOString(),
    escalated,
    defaulted,
  };
}

module.exports = {
  pick,
  markLimit,
  readRegistry,
  readState,
  writeState,
  hasCredentials,
  readLabels,
  syncSettings,
  stampManagedSettings,
  AllAccountsCoolingError,
  NoAccountsRegisteredError,
  USAGE_PROBE_COOLDOWN_MS,
  USAGE_ESCALATED_COOLDOWN_MS,
  OVERLOADED_COOLDOWN_MS,
  ESCALATION_WINDOW_MS,
  OAUTH_TOKEN_FILENAME,
  DISABLED_MARKER_FILENAME,
  LABELS_FILENAME,
  SETTINGS_FILENAME,
};
