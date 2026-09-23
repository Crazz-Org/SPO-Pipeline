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
//   <poolDir>/state.json           runtime-written cooldowns -- {accountName: {byModel:
//                                  {<model>: {cooldownUntil: epochMs, lastUsageLimitAt?: epochMs,
//                                  usageLimitStreak?: int}}}}. The latter two (action 3.5) exist
//                                  only to decide whether the NEXT usage limit escalates -- see
//                                  markLimit's own comment; an 'overloaded' cooldown never writes
//                                  them, and a per-model record that lacks them simply reads as
//                                  "no prior usage hit on record for this model". Machine-owned,
//                                  disposable: deleting it clears every cooldown (and every
//                                  escalation streak with it). Lives next to the accounts on
//                                  purpose -- one directory, one source of truth for the whole
//                                  pool.
//
// COOLDOWN IS PER (ACCOUNT, MODEL), NOT PER ACCOUNT -- card #167. The Anthropic usage quota this
// module models is per MODEL, and the pool's own corpus said so unambiguously: every `kind:'limit'`
// classification ever observed was on Fable (186 calls / 12 limited; sonnet 107 / 0; opus 30 / 0),
// and on one real account `IMPLEMENT/sonnet ok=true` at 07:55:26 sat seven minutes before
// `VALIDATE/fable` hit a limit at 08:02:42 -- Sonnet was demonstrably usable on an account the
// old whole-account cooldown was about to mark unavailable. Cooling the whole account therefore
// threw away IMPLEMENT (sonnet) capacity that provably existed, for the whole 1h-or-5h window,
// on every routine Fable limit.
//
// WHAT THIS DOES NOT FIX, stated here because it is the obvious next question: pool-wide
// exhaustion of ONE model. All seven historical `all-accounts-*` parks were at PLAN or VALIDATE,
// both `baseModel: 'fable'` (step-contracts.js) -- when Fable itself is what is exhausted across
// the whole pool, a per-model cooldown cannot conjure a Fable account, and this change is neutral
// on every one of those parks by construction (test/accounts-per-model-cooldown.test.js proves
// it). The structural answer to that is model fallback, which is a separate DECISION card,
// SPO-Pipeline#166 -- deliberately not attempted here.
//
// LEGACY (pre-#167) FLAT ENTRIES: an entry with no `byModel` key carries no per-model information
// at all, so there is no honest way to attribute its cooldown to a model. It is read as "no
// cooldown recorded for any model" -- see byModelOf() below, which is the single place that
// decision is made. The cost is one stale flat cooldown lost per account on the upgrade, which
// this same header already declares acceptable two paragraphs up: the file is machine-owned and
// disposable, and `rm state.json` has always been a supported way to clear every cooldown in the
// pool. A fancier migration would have to invent the missing attribution.
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
const { STEP_CONTRACTS, INTAKE_MODELS } = require('./step-contracts');
const { monotonicNowMs } = require('./monotonic-clock');

// The model vocabulary this module's per-(account, model) state is keyed by -- DERIVED from
// step-contracts.js's own table (every step's baseModel/escalatedModel) plus its INTAKE_MODELS
// (intake.js's three steps), never restated as a literal list, so a step that introduces another
// model moves this with it instead of leaving a silent gap. INTAKE_MODELS is not optional here:
// since IMPLEMENT moved to OPUS_5_5 (2026-09-23), DRAFT_CARD is the only `sonnet` spender, and a
// STEP_CONTRACTS-only derivation would drop `sonnet` from the fail-safe below. Not a cycle:
// step-contracts.js requires only `path` and ./bash-policy, and this module already reaches it
// transitively through config.js. Today it resolves to claude-opus-5-5/fable/sonnet.
//
// Used for exactly ONE thing -- markLimit's fail-safe when no model is named (see its own
// comment). Every other function here treats the model as an opaque string key and never consults
// this set, so a model string that is not in it (a test's 'haiku', a future step's) still cools
// and still reads back correctly.
const KNOWN_MODELS = Object.freeze(
  Array.from(
    new Set(
      Object.values(STEP_CONTRACTS)
        .flatMap((def) => [def.baseModel, def.escalatedModel])
        .concat(Object.values(INTAKE_MODELS))
        .filter((m) => typeof m === 'string')
    )
  ).sort()
);

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
// two park differently: a cooling account is never worth a BLOCKING, in-process wait
// (state-machine.js/intake.js never construct this error's caller with a wait LOOP for that case
// -- a 1h or 5h cooldown would pin the process for hours, doing nothing), but a leased account
// legitimately might free up within the bound orchestrator/account-lease.js's leaseHealthyAccount
// waits -- see that module's own header and doc/remediation-progress.md's C6 decision record for
// why per-step leasing makes waiting the right default instead of parking immediately the way
// AllAccountsCoolingError does. Since card #119 action 1.2, a cooling park IS worth a DEFERRED
// wait when its deadline is recoverable -- see doc/state-machine-spec.md's Account pool section
// -- but that mechanism lives entirely in state-machine.js's finalizePark, downstream of the
// ParkSignal this error becomes; nothing in THIS module, or in leaseHealthyAccount's own blocking
// loop, changed.
class AllAccountsLeasedError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'AllAccountsLeasedError';
    this.reason = reason;
    this.detail = detail;
  }
}

// Thrown by clearCooldown() (below) when `name` names no subdirectory of poolDir -- i.e. no
// account this pool actually knows about. Exists to stop a typo'd `spo account clear-cooldown`
// from silently writing an orphan entry into state.json: nothing ever scans state.json for
// entries with no matching pool directory, so a mis-typed name would sit there forever, inert
// but confusing to anyone reading the file by hand.
class UnknownAccountError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'UnknownAccountError';
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
// WHY this exists: steps/llm.js's invokeClaudeReal calls the vendored Agent SDK's `query()` with
// `options.env.CLAUDE_CONFIG_DIR` set to the account's own directory (sdk-call.js's buildEnv --
// the OLD transport set the same variable on a spawned `claude -p` child's env; the cutover moved
// the plumbing, not the effect), so the machine's ~/.claude/settings.json is never read by a
// pipeline step --
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

// ---- per-(account, model) cooldown reads (card #167) ----------------------------------------
//
// byModelOf(entry) -- one account's per-model cooldown records, or {} when there are none. The
// SINGLE place the legacy-flat-entry decision documented in this file's header is made: an entry
// written before #167 has no `byModel` key, carries no attribution of its cooldown to any model,
// and is therefore read as "nothing on record" -- {} -- rather than guessed at. Also the place
// that absorbs a torn/hand-edited entry (a string, null, a byModel that isn't an object): every
// reader below goes through here, so none of them has to re-check the shape, and none of them can
// throw on a state.json a human edited badly.
function byModelOf(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const byModel = entry.byModel;
  if (!byModel || typeof byModel !== 'object') return {};
  return byModel;
}

// activeCooldownUntil(entry, model, now) -- when this account becomes usable again for the
// request described by `model`, or null if it already is. This is THE health test; pick(),
// countHealthyAccounts() and the CLI/dashboard readers all derive from it, so "healthy" has one
// definition in this codebase rather than four.
//
//   `model` a string  -- exactly that model's own cooldownUntil. Cooling on a DIFFERENT model is
//                        invisible here, which is the whole point of card #167: a Fable limit
//                        must not remove this account's Opus 5.5 (IMPLEMENT) capacity.
//   `model` omitted   -- the UNION: the account counts as cooling while ANY model's cooldown is
//     (or null)        still in the future, so it becomes healthy again only once the LAST of
//                      them expires -- hence `max`, not `min`. That is the honest answer to the
//                      question a caller with no model in hand is really asking ("is this account
//                      cooling at all"), and it keeps every pre-#167 caller (bin/spo's bare
//                      pick(), the dashboard) behaving exactly as it did.
function activeCooldownUntil(entry, model, now) {
  const byModel = byModelOf(entry);
  if (typeof model === 'string') {
    const until = byModel[model] && byModel[model].cooldownUntil;
    return typeof until === 'number' && until > now ? until : null;
  }
  let latest = null;
  for (const key of Object.keys(byModel)) {
    const until = byModel[key] && byModel[key].cooldownUntil;
    if (typeof until === 'number' && until > now && (latest === null || until > latest)) latest = until;
  }
  return latest;
}

// coolingSummary(entry, now) -- the read the CLI (`spo accounts`, `spo status`) and the dashboard
// (console/collect.js) share, so a maintainer can tell a FABLE-ONLY cooldown from a real
// whole-account outage instead of seeing one undifferentiated "cooling: yes". Exported for that
// reason: those two are the places card #167's issue text calls out as currently misreporting,
// and re-deriving the new shape in each of them would be the "second source of truth" this
// module's own header forbids.
//
//   cooling        -- any model cooling right now (activeCooldownUntil's union answer, negated).
//   coolingModels  -- [{model, cooldownUntil, cooldownUntilIso}] for the models actually cooling,
//                     sorted by model name so the rendered line is stable between reads.
//   cooldownUntil  -- the LATEST of those (when the account is usable for every model again), or
//                     null. Same number the union pick() reports, for the same reason.
function coolingSummary(entry, now = Date.now()) {
  const byModel = byModelOf(entry);
  const coolingModels = Object.keys(byModel)
    .sort()
    .map((model) => ({ model, cooldownUntil: byModel[model] && byModel[model].cooldownUntil }))
    .filter((m) => typeof m.cooldownUntil === 'number' && m.cooldownUntil > now)
    .map((m) => ({ ...m, cooldownUntilIso: new Date(m.cooldownUntil).toISOString() }));
  const cooldownUntil = coolingModels.reduce((max, m) => (max === null || m.cooldownUntil > max ? m.cooldownUntil : max), null);
  return { cooling: coolingModels.length > 0, coolingModels, cooldownUntil };
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
//
// card #167: `opts.model` (optional: the model the caller's call will send -- a step contract's
// baseModel/escalatedModel, a step-contracts.js INTAKE_MODELS entry, or a legacy
// ctx.task.llm.<step> override's own model) scopes the cooldown filter to the model the caller is
// about to actually spend -- an account
// cooling on 'fable' is still returned for a 'sonnet' request. OMITTING it keeps the union
// behaviour byte-for-byte (see activeCooldownUntil): bin/spo and every pre-#167 test call this
// bare and must keep getting "is this account cooling at all". Deliberately additive in the same
// way opts.excludeAccounts is -- neither the returned account shape nor either error's `reason`
// and `detail` changed, because park-loop.js's countRepeatedParks fingerprints a park as
// `reason + JSON.stringify(detail)` and #119/PR #156's wait behaviour is pinned on exactly those
// bytes. A per-model pick that found nothing parks EXACTLY as a whole-account one did.
function pick(poolDir, now = Date.now(), opts = {}) {
  const registry = readRegistry(poolDir);
  if (registry.length === 0) {
    throw new NoAccountsRegisteredError('no-accounts-registered', { poolDir });
  }

  const state = readState(poolDir);
  const excludeAccounts = opts.excludeAccounts;
  const model = opts.model;

  let earliestCooldown = null;
  let healthyCount = 0;
  for (const account of registry) {
    if (!account.enabled) continue;
    const cooldownUntil = activeCooldownUntil(state[account.name], model, now);
    if (cooldownUntil !== null) {
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
//
// card #167: the optional third argument scopes the count to accounts healthy FOR THAT MODEL,
// with exactly pick(opts.model)'s semantics -- this is the card's "the concurrency clamp is
// derived from accounts healthy for the requested model" bullet, and an account cooling only on
// 'fable' still counts toward 'sonnet' capacity.
//
// SCOPE BOUNDARY, deliberate: dispatcher.js's fillSlots still calls this BARE (no model), and
// that is not an oversight -- see the comment at that call site. A worker slot is not bound to
// one model at spawn time (a card runs INTAKE -> WORKTREE -> PLAN/claude-opus-5-5 (fable on
// fallback) -> IMPLEMENT/claude-opus-5-5 -> VALIDATE/fable over its life), so "the requested model" has no single answer there; the bare
// union count is the honest one. The capability lives here, tested here, for the callers that DO
// have one model in hand.
function countHealthyAccounts(poolDir, now = Date.now(), model = undefined) {
  const registry = readRegistry(poolDir);
  if (registry.length === 0) return 0;
  const state = readState(poolDir);
  let healthy = 0;
  for (const account of registry) {
    if (!account.enabled) continue;
    if (activeCooldownUntil(state[account.name], model, now) === null) healthy += 1;
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
// card #167: `model` names WHICH model hit the limit, and the cooldown lands under
// `byModel[model]` -- the escalation history (lastUsageLimitAt/usageLimitStreak) is per-model too,
// because the quota it models is. Real callers always name it (state-machine.js's callLlmStep
// through steps/llm.js's resolveCallModel -- a legacy ctx.task.llm.<step> override's model, else
// the step contract's -- and intake.js from step-contracts.js's INTAKE_MODELS entry for the step).
//
// WHEN NO MODEL IS NAMED this cools EVERY model in KNOWN_MODELS -- i.e. exactly the pre-#167
// whole-account behaviour. That is the fail-safe direction on purpose: the alternative (cool
// nothing, or cool one sentinel pseudo-model) would turn a caller that forgot the argument into a
// SILENT no-op, handing work straight back to a rate-limited account -- the loop action 3.6 was
// written to end. Over-cooling costs capacity for one window and is visible in `spo accounts`;
// under-cooling costs a burn loop and is invisible. Each model still escalates off its OWN
// history, so an account that only ever limits on fable does not accumulate a streak on sonnet.
//
// On the multi-model (no model named) path the returned event's `cooldownMs`/`cooldownUntil`
// report the LATEST of the per-model cooldowns (when the account is usable for every model
// again), and `escalated` is true if ANY of them escalated -- the same union answer
// activeCooldownUntil gives for a caller with no model in hand. On the single-model path, which
// is every real call site, all three are exact.
function computeLimitUpdate(state, name, limitKind, now, model = undefined) {
  const entry = state[name] || {};
  const byModel = byModelOf(entry);
  const targets = typeof model === 'string' ? [model] : KNOWN_MODELS;

  const overloaded = limitKind === 'overloaded';
  const defaulted = !overloaded && limitKind !== 'usage';

  const nextByModel = { ...byModel };
  let ms = null;
  let cooldownUntil = null;
  let escalated = false;

  for (const target of targets) {
    const prev = byModel[target] && typeof byModel[target] === 'object' ? byModel[target] : {};

    let targetMs;
    let targetEscalated = false;
    if (overloaded) {
      targetMs = OVERLOADED_COOLDOWN_MS;
    } else {
      const last = typeof prev.lastUsageLimitAt === 'number' ? prev.lastUsageLimitAt : null;
      targetEscalated = last !== null && now - last <= ESCALATION_WINDOW_MS;
      targetMs = targetEscalated ? USAGE_ESCALATED_COOLDOWN_MS : USAGE_PROBE_COOLDOWN_MS;
    }
    const targetUntil = now + targetMs;

    if (overloaded) {
      nextByModel[target] = { ...prev, cooldownUntil: targetUntil };
    } else {
      const prevStreak = typeof prev.usageLimitStreak === 'number' ? prev.usageLimitStreak : 0;
      nextByModel[target] = {
        ...prev,
        cooldownUntil: targetUntil,
        lastUsageLimitAt: now,
        usageLimitStreak: targetEscalated ? prevStreak + 1 : 1,
      };
    }

    if (cooldownUntil === null || targetUntil > cooldownUntil) {
      cooldownUntil = targetUntil;
      ms = targetMs;
    }
    escalated = escalated || targetEscalated;
  }

  // The rewritten entry is `{byModel}` ALONE, not `{...entry, byModel}` -- writing a limit is
  // where a surviving legacy flat entry (pre-#167 `{cooldownUntil, lastUsageLimitAt,
  // usageLimitStreak}` at the top level) is finally dropped. byModelOf already reads those fields
  // as nothing; carrying them forward would leave a number in state.json that looks like a
  // cooldown, is displayed by nothing, and is honoured by nothing.
  const nextState = { ...state, [name]: { byModel: nextByModel } };

  const event = {
    account: name,
    limitKind: limitKind ?? null,
    // card #167: WHICH model was cooled. `model` is what the caller named (null when it named
    // nothing), `models` is what was actually written -- the two differ only on the fail-safe
    // path above, and the journalled `account-cooldown` event needs both to stay readable.
    model: typeof model === 'string' ? model : null,
    models: targets,
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
// result.limitKind, Date.now(), {model})`.
//
// `limitKind`:
//   'overloaded' -- flat OVERLOADED_COOLDOWN_MS (5 min). Never escalates, and never touches (or
//                   even reads) the usage-escalation fields below -- a busy server says nothing
//                   about this account's own quota.
//   'usage', or anything else (undefined/null/an unrecognised string -- fail-safe, see below) --
//                   USAGE_ESCALATED_COOLDOWN_MS (5h) if this account's record FOR THIS MODEL
//                   (`state[name].byModel[model].lastUsageLimitAt`) is within
//                   ESCALATION_WINDOW_MS of `now`, otherwise USAGE_PROBE_COOLDOWN_MS (1h).
//                   `usageLimitStreak` counts consecutive escalated hits; the decision above
//                   doesn't consult it, it exists so a maintainer reading state.json by hand can
//                   see how long an account has been stuck without doing the arithmetic.
//
// `opts.model` (card #167) -- WHICH model hit the limit, so the cooldown lands on that model's
// quota alone instead of taking the account's other models down with it. See computeLimitUpdate
// above for the semantics, including what happens when it is omitted (cool every known model --
// the pre-#167 behaviour, kept as the fail-safe). Real callers resolve it the way the call itself
// does -- state-machine.js through steps/llm.js's resolveCallModel (override model, else step
// contract), intake.js from step-contracts.js's INTAKE_MODELS -- never guess it from
// `limitKind`, which says what KIND of limit fired, not which quota it was drawn against.
//
// `defaulted` means exactly what R2 (F2) needed it to mean again: no *recognised* limitKind
// ('usage' or 'overloaded') was supplied, and the usage fail-safe applied anyway. Before this
// change cooldownMsForLimitKind returned a positive number for every JS value, so `defaulted`
// was structurally always false in production, and the journalled event carried no limitKind at
// all -- the one case the fallback exists for (a limit shape classifyFailure recognizes but that
// isn't in a limitKind bucket) was indistinguishable from a genuine 429/529 in the journal. Both
// are fixed here: `limitKind` is always on the returned event (`null` when absent), and
// `defaulted` is true exactly when that value wasn't 'usage' or 'overloaded'. It is about
// `limitKind` ONLY, and says nothing about whether `opts.model` was supplied -- the event's own
// `model`/`models` pair answers that.
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
    const { nextState, event } = computeLimitUpdate(state, name, limitKind, now, opts.model);
    writeState(poolDir, nextState);
    return { ...event, degraded };
  } finally {
    if (held) lock.releaseShortLock(lockFile, held);
  }
}

// clearCooldown(poolDir, name, now = Date.now(), opts = {}) -- the CLI escape hatch this action
// exists to build: `spo account clear-cooldown <name>`. There was previously no way to clear a
// cooldown without hand-editing state.json OUTSIDE markLimit's own lock (see this module's own
// header for why that lock exists) -- a hand `jq`/editor read-modify-write races a live
// markLimit call exactly the way this function is built not to.
//
// THE PART THAT MATTERS: this clears cooldownUntil, lastUsageLimitAt AND usageLimitStreak
// together -- never cooldownUntil alone. computeLimitUpdate's `escalated` check above reads
// straight off lastUsageLimitAt; clearing only cooldownUntil leaves it armed, so the very next
// 'usage' limit on this account within ESCALATION_WINDOW_MS (2h) of the OLD lastUsageLimitAt
// jumps straight to the 5h escalated tier, as if the account had already burned a probe cooldown
// it never actually served. An account is usually cleared BECAUSE it just cooled -- the
// maintainer is unblocking it right after a rate limit -- so lastUsageLimitAt is almost always
// still inside that window at clear time. That is not a corner case, it is the expected one, and
// it is believed to be exactly what turned the two manual state.json edits on 2026-09-02 into an
// account that re-limited straight into the 5h tier instead of a fresh 1h probe.
//
// Implemented as one entry DELETION, not three field deletions: state.json's own header
// documents an account's per-model record as having ONLY these three fields (cooldownUntil,
// lastUsageLimitAt?, usageLimitStreak?), so removing the whole key is equivalent to zeroing all
// three, and there is nothing left for a future field to accidentally survive a clear that only
// named the three fields explicitly. readState/pick/markLimit already treat "no entry for this
// account" as "nothing on record" -- the same posture a missing state.json gets.
//
// card #167 -- CLEARS EVERY MODEL, and takes no `--model` flag. Decided, not defaulted into:
// this is the maintainer's manual escape hatch, its documented UX is "fully reset this account",
// and the situation it exists for is "the server would have let this through, unblock it". A
// per-model clear would be a second thing to get right at 3am for a saving (keeping an unrelated
// model's cooldown armed) that nobody has asked for. Entry deletion gives the whole-account reset
// for free under the new shape exactly as it did under the old one; if a per-model clear is ever
// wanted, `--model` is a strictly additive argument to add then. The report below names
// `clearedModels`/`coolingModels` so the maintainer sees exactly what the clear covered.
//
// Same lock idiom as markLimit above (see that function's own comment for the full reasoning):
// acquire stateLockPath(poolDir) via lock.acquireShortLock, poll with a bounded wait keyed off a
// MONOTONIC clock (never Date.now() -- this box's wall clock has been measured jumping
// backward), degrade to the unlocked read-modify-write rather than throw if the bound is
// exceeded (`degraded: true` on the return), release in a `finally`. A hand edit to the SAME
// file is exactly the unlocked read-modify-write this function exists to make unnecessary --
// doing the same thing here, just without ever taking the lock at all, would not be progress.
//
// Refuses an unknown `name` (no matching subdirectory in poolDir) by throwing
// UnknownAccountError BEFORE ever taking the lock -- there is nothing to lock for a name that
// cannot legitimately have a state.json entry. Checked against readRegistry(poolDir) (every
// subdirectory, enabled or disabled -- clearing a disabled account's cooldown is harmless, and
// arguably useful ahead of a re-enable, so this does not also require `enabled`).
//
// Returns (never throws for the "nothing to do" cases below -- those are honest, common
// outcomes, not errors):
//   { name, hadEntry, wasCooling, cooldownUntil, cooldownUntilIso, escalationWasArmed, cleared,
//     degraded }
// `hadEntry`   -- state.json had ANY entry for this account (even one whose cooldownUntil had
//                 already passed).
// `wasCooling` -- that entry's cooldownUntil was still in the future at `now` (pick()'s own
//                 "healthy" test, negated).
// `cooldownUntil`/`cooldownUntilIso` -- what it WAS (null if there was no entry, or the entry
//                 had no cooldownUntil at all -- both read the same as "not cooling").
// `escalationWasArmed` -- computeLimitUpdate's own escalation test, evaluated against the entry
//                 being cleared: would a 'usage' markLimit call made right now (at `now`) have
//                 landed on the escalated 5h tier because of this entry's lastUsageLimitAt. This
//                 is the number that answers "did clearing this actually matter beyond the
//                 visible cooldown" -- the test suite proves the CONSEQUENCE of this field by
//                 calling the real markLimit afterwards and asserting the resulting tier, not by
//                 trusting this flag alone.
// `cleared`    -- true iff state.json was actually rewritten (i.e. `hadEntry` was true). A no-op
//                 call (nothing on record for this account) never touches state.json -- a
//                 maintainer clearing an account that was never cooling must not fabricate an
//                 entry that was never there.
function clearCooldown(poolDir, name, now = Date.now(), opts = {}) {
  const known = readRegistry(poolDir).some((a) => a.name === name);
  if (!known) {
    throw new UnknownAccountError(`unknown-account-${name}`, { poolDir, name });
  }

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
    const entry = state[name];
    const hadEntry = Boolean(entry);

    // card #167: the three report numbers are now derived across EVERY model this account has a
    // record for, because the deletion below clears every model (see this function's header).
    // `cooldownUntil` is the LATEST one on record whether or not it has expired -- the caller
    // prints it either as "was cooling until X" or as "had a stale cooldownUntil X (already
    // past)", and both of those need the value, not just the active ones.
    const records = byModelOf(entry);
    const clearedModels = Object.keys(records).sort();
    let cooldownUntil = null;
    let escalationWasArmed = false;
    for (const model of clearedModels) {
      const record = records[model] || {};
      if (typeof record.cooldownUntil === 'number' && (cooldownUntil === null || record.cooldownUntil > cooldownUntil)) {
        cooldownUntil = record.cooldownUntil;
      }
      const lastUsageLimitAt = typeof record.lastUsageLimitAt === 'number' ? record.lastUsageLimitAt : null;
      if (lastUsageLimitAt !== null && now - lastUsageLimitAt <= ESCALATION_WINDOW_MS) escalationWasArmed = true;
    }
    const wasCooling = cooldownUntil !== null && cooldownUntil > now;
    const coolingModels = coolingSummary(entry, now).coolingModels.map((m) => m.model);

    let cleared = false;
    if (hadEntry) {
      const nextState = { ...state };
      delete nextState[name];
      writeState(poolDir, nextState);
      cleared = true;
    }

    return {
      name,
      hadEntry,
      wasCooling,
      cooldownUntil,
      cooldownUntilIso: cooldownUntil !== null ? new Date(cooldownUntil).toISOString() : null,
      escalationWasArmed,
      // card #167: which models had a record at all (all of them are cleared), and which of
      // those were still cooling at `now`. The CLI prints the second so a maintainer sees that
      // clearing a fable-only cooldown did not also "unblock" a sonnet that was never blocked.
      clearedModels,
      coolingModels,
      cleared,
      degraded,
    };
  } finally {
    if (held) lock.releaseShortLock(lockFile, held);
  }
}

module.exports = {
  pick,
  countHealthyAccounts,
  markLimit,
  clearCooldown,
  readRegistry,
  readState,
  writeState,
  // card #167 -- the per-(account, model) cooldown reads. Exported so the CLI (bin/spo) and the
  // dashboard (console/collect.js) share this module's definition of "cooling" instead of each
  // re-deriving the state.json shape, which is what let them both go stale on it before.
  byModelOf,
  activeCooldownUntil,
  coolingSummary,
  KNOWN_MODELS,
  hasCredentials,
  readLabels,
  syncSettings,
  stampManagedSettings,
  AllAccountsCoolingError,
  AllAccountsLeasedError,
  NoAccountsRegisteredError,
  UnknownAccountError,
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
