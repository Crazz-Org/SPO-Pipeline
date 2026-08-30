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
//                                  epochMs}}. Machine-owned, disposable: deleting it clears
//                                  every cooldown. Lives next to the accounts on purpose -- one
//                                  directory, one source of truth for the whole pool.
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

// Used when a limit error carries no retry-after hint of its own -- a Claude Max 5h window is
// the shortest real reset this can be hitting, so an hour is a conservative "come back later"
// rather than a guess at the true reset time.
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

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

function writeState(poolDir, state) {
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(stateJsonPath(poolDir), JSON.stringify(state, null, 2) + '\n');
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

// Records a limit hit for `name`: sets cooldownUntil = now + retryAfterMs (falls back to
// DEFAULT_COOLDOWN_MS when retryAfterMs is not a positive number, i.e. the limit error carried
// no usable reset hint). Returns the event payload the caller journals -- this module never
// writes the journal itself, same separation of concerns scripted.js/llm.js already use.
function markLimit(poolDir, name, retryAfterMs, now = Date.now()) {
  const usedDefault = !(typeof retryAfterMs === 'number' && retryAfterMs > 0);
  const ms = usedDefault ? DEFAULT_COOLDOWN_MS : retryAfterMs;
  const cooldownUntil = now + ms;

  const state = readState(poolDir);
  state[name] = { cooldownUntil };
  writeState(poolDir, state);

  return {
    account: name,
    cooldownUntil,
    cooldownUntilIso: new Date(cooldownUntil).toISOString(),
    retryAfterMsUsed: ms,
    defaulted: usedDefault,
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
  DEFAULT_COOLDOWN_MS,
  OAUTH_TOKEN_FILENAME,
  DISABLED_MARKER_FILENAME,
  LABELS_FILENAME,
  SETTINGS_FILENAME,
};
