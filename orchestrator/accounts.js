'use strict';
// accounts.js -- the Claude Max account pool: registry + runtime cooldown state.
// doc/state-machine-spec.md § Account pool.
//
// Two files, two owners, same directory (default claude-accounts/, git-ignored -- see
// .gitignore and config.js's claudeAccountsDir):
//
//   accounts.json  the registry -- hand-authored, one entry per Claude Max account:
//                  [{name, configDir (absolute path | null = the ambient default login),
//                    enabled}]. Missing file or an empty array both fall back to one implicit
//                  account, {name: "default", configDir: null} -- so a fresh checkout with no
//                  registry still runs real mode against whatever `claude` is already logged
//                  into.
//   state.json     runtime-written cooldowns -- {accountName: {cooldownUntil: epochMs}}. Not
//                  part of the registry on purpose: the registry is who exists and where their
//                  login lives (authored), state.json is who is currently rate-limited
//                  (machine-written, disposable -- deleting it just clears every cooldown).
//
// Every function here takes the claude-accounts directory as an explicit first argument, same
// convention as journal.js taking taskDir -- this is what lets the test suite point at a
// fs.mkdtempSync(os.tmpdir()) directory instead of the real claude-accounts/.
//
// This module never journals anything itself (same separation as scripted.js/llm.js) -- it
// returns event payloads (markLimit's return value) for the caller to append.

const fs = require('fs');
const path = require('path');

const DEFAULT_ACCOUNT = Object.freeze({ name: 'default', configDir: null, enabled: true });

// Used when a limit error carries no retry-after hint of its own -- a Claude Max 5h window is
// the shortest real reset this can be hitting, so an hour is a conservative "come back later"
// rather than a guess at the true reset time.
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

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

function accountsJsonPath(claudeAccountsDir) {
  return path.join(claudeAccountsDir, 'accounts.json');
}

function stateJsonPath(claudeAccountsDir) {
  return path.join(claudeAccountsDir, 'state.json');
}

// The registry, normalized. Never writes anything -- a missing/empty registry is not an error,
// it is "this checkout hasn't set up extra accounts yet."
function readRegistry(claudeAccountsDir) {
  const p = accountsJsonPath(claudeAccountsDir);
  if (!fs.existsSync(p)) return [DEFAULT_ACCOUNT];

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`accounts.js: ${p} is not valid JSON (${err.message})`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [DEFAULT_ACCOUNT];

  return parsed.map((a) => ({
    name: a.name,
    configDir: a.configDir === undefined ? null : a.configDir,
    enabled: a.enabled !== false,
  }));
}

// Runtime cooldown state. A missing or unparsable state.json is just "nobody has ever hit a
// limit yet" -- never an error (unlike a malformed registry, which is an authoring mistake).
function readState(claudeAccountsDir) {
  const p = stateJsonPath(claudeAccountsDir);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(claudeAccountsDir, state) {
  fs.mkdirSync(claudeAccountsDir, { recursive: true });
  fs.writeFileSync(stateJsonPath(claudeAccountsDir), JSON.stringify(state, null, 2) + '\n');
}

// First enabled account (registry order = pick order -- no round robin, no load balancing;
// spreading calls across K healthy accounts is a scheduler-level concern, not this module's)
// whose cooldownUntil is absent or already past `now`. `now` is a parameter, not always
// Date.now(), so tests can assert cooldown/recovery behaviour without sleeping.
function pick(claudeAccountsDir, now = Date.now()) {
  const registry = readRegistry(claudeAccountsDir);
  const state = readState(claudeAccountsDir);

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
function markLimit(claudeAccountsDir, name, retryAfterMs, now = Date.now()) {
  const usedDefault = !(typeof retryAfterMs === 'number' && retryAfterMs > 0);
  const ms = usedDefault ? DEFAULT_COOLDOWN_MS : retryAfterMs;
  const cooldownUntil = now + ms;

  const state = readState(claudeAccountsDir);
  state[name] = { cooldownUntil };
  writeState(claudeAccountsDir, state);

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
  AllAccountsCoolingError,
  DEFAULT_ACCOUNT,
  DEFAULT_COOLDOWN_MS,
};
