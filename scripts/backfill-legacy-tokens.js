#!/usr/bin/env node
'use strict';
// backfill-legacy-tokens.js -- card #169: a one-shot operator tool that recovers billable tokens
// for the 92 pre-instrumentation `llm-call` events that ran to completion (ok:true, a real
// sessionId) but were journalled before token instrumentation began
// (2026-09-01T06:24:27.014Z) and so carry NO token field at all -- not even an explicit
// `tokensSource: null`. Every one of those 92 transcripts still exists on disk, so this recovers
// them EXACTLY -- through orchestrator/token-recovery.js's recoverSessionTokens, the same reader
// orchestrator/steps/llm.js's own maybeRecoverTokens uses for a live call's failure path -- never
// a heuristic or an estimate.
//
// DRY-RUN BY DEFAULT. Nothing on disk changes unless `--apply` is passed. A tool that rewrites a
// journal must not do so because someone typed its name.
//
// ---- the target predicate (measured 2026-09-10 at d93266a: exactly 92 events, 17 tasks,
// timestamps 2026-08-29T13:21:55.504Z .. 2026-08-31T08:39:23.895Z) ----------------------------
//   event.event === 'llm-call'
//   AND event.ok === true                                  (a literal top-level boolean, never derived)
//   AND typeof event.sessionId === 'string' && event.sessionId !== ''
//   AND !event.tokensSource                                (falsy: absent OR explicit null)
// This mirrors orchestrator/steps/llm.js's maybeRecoverTokens guard verbatim
// (`if (result.tokensSource || ...) return result;`) -- deliberately a falsy check, never
// `=== null`, for the same reason that file's own header gives: a result that OMITS the field
// entirely must be treated the same as one that explicitly measured nothing. All 92 real target
// events are field-ABSENT, not explicit-null (the 19 explicit-null events in the corpus are all
// ok:false and so never match this predicate); this backfill's own idempotence (see below) relies
// on that same falsy check, not on the absent/null distinction.
//
// ---- where events live, and the one thing explicitly excluded --------------------------------
// `<journalRoot>/<taskId>/journal.jsonl`, one file per task -- the `journal/*/journal.jsonl` glob.
// `journal/daemon.jsonl` sits at the journal ROOT, not inside a task directory. TODAY it is a
// FILE, and TWO independent things already exclude it: findTaskJournalFiles's own
// `entry.isDirectory()` check, and -- even with that check gone -- the fact that this loop only
// ever opens `<entry>/journal.jsonl`, a path a regular file can never provide (measured: deleting
// `isDirectory()` alone still leaves the file-shaped case excluded and every existing test green).
// Neither of those two is load-bearing on its own for the FILE shape. The BY-NAME guard is the one
// that fires for a DIFFERENT shape: if `daemon.jsonl` were ever a directory, `isDirectory()` would
// no longer exclude it, the `<entry>/journal.jsonl` path WOULD resolve, and the by-name check
// would be the only thing left standing between this tool and walking the daemon's own cross-task
// journal as just another task. So the guards are not redundant checks of the same case -- each is
// the one that fires for a different shape `daemon.jsonl` could take. It holds 3 `llm-call` events
// (step REVIEW_CARD), all already `tokensSource: 'modelUsage'`, and 0 target-set members today --
// but it is excluded on principle, not because today's content happens to be harmless.
//
// ---- concurrency: a live daemon, or ANY writer, touching the same file mid-run ----------------
// This tool's own read -> rewrite -> rename cycle has a window: anything appended to a
// journal.jsonl between this tool's readFileSync and its renameSync would be silently discarded
// by the rename (the rewrite was computed from the OLD content). The daemon being stopped and
// disabled today is a decision, not a property this tool can rely on staying true, so two
// independent defenses exist, narrowing this from both ends -- NEITHER of them, alone or
// together, actually CLOSES the race; see (2)'s own caveat below for what would.
//   1. NAMED, up front (main() only, `--apply` only): if `<journalRoot>/daemon.lock` names a
//      process that is both alive and on THIS host, refuse outright before touching anything --
//      liveDaemonLockHolder() below, using orchestrator/lock.js's own exported `lockPath` /
//      `processAlive` (no reaching into that module's internals). Overridable with `--force`,
//      which accepts the risk rather than removing it -- it skips ONLY this named-lock refusal;
//      defense (2) below still runs even under --force (see test/backfill-legacy-tokens.test.js's
//      own pinned property for this, added after a mutation that plumbed --force past both
//      defenses stayed green with no test to catch it). A lock from a different host is treated
//      as not-live the same way acquireLock's own `holderAlive` conjunct does (lock.js:145-147,
//      "foreign host leftover ... stale") -- this tool cannot confirm OR deny a foreign host's
//      liveness, so it does not guess; an unreadable/torn lock file is treated as not-live the
//      same way lock.js's own (unexported) readHolder does (lock.js:112-117, "unreadable or
//      torn -- treated as stale").
//   2. GENERIC, per file, right before the rename: writeFileAtomic() re-stats the file it is
//      about to replace and compares mtimeMs/size against what was recorded right after this
//      tool's own read. A mismatch means SOMETHING wrote to this file in between -- the daemon,
//      a hand-run `spo` command, another copy of this very tool -- and that one file's write is
//      aborted (ConcurrentWriteError, caught in backfillFile, never left to crash the whole run)
//      rather than silently clobbering whatever the other writer just added. This NARROWS the
//      race -- from the whole read-and-recover span down to the microseconds between the stat and
//      the rename -- and DETECTS ANY writer, not only a named one. It does not CLOSE the race: an
//      append landing in that remaining stat-to-rename window would still be lost silently.
//      Nothing short of holding a lock across the ENTIRE read-through-rename span would close it,
//      which this one-shot, no-daemon-dependency tool deliberately does not take on. The
//      mtimeMs+size comparison is also a heuristic, not a proof of no-write: an in-place rewrite
//      that changes neither (rewrites the same byte count at the same instant its mtime
//      resolution can't distinguish) would pass undetected -- but every write this tool actually
//      needs to catch changes size, mtime, or both: the daemon and its worker/repark children
//      only ever APPEND (journal.js's appendEvent is a bare `fs.appendFileSync`), and an append
//      always changes size; another copy of THIS tool does not append at all -- it renames a
//      wholesale rewrite over the file, which changes size and mtime just as visibly. (`spo`
//      never writes a task journal.jsonl; it only reads one.)
// A `journal.jsonl` that is a DIRECTORY (never true today, but not guarded against) makes the
// initial `fs.readFileSync` throw EISDIR and aborts the WHOLE run uncaught, with a stack and exit
// 1, leaving later tasks in the scan unprocessed. Safe to just re-run once fixed: every file this
// tool touches is written atomically and the whole tool is idempotent, so a re-run picks up
// exactly where the aborted one left off.
//
// ---- identity and idempotence -----------------------------------------------------------------
// Keyed on `sessionId` (a global primary key across the whole corpus: of 345 llm-call events, 322
// carry one and all 322 are distinct) -- never on content. Idempotent BECAUSE the target predicate
// itself requires `tokensSource` to be falsy: a call that already carries `tokensSource:
// 'transcript'` (this tool's own prior pass) or `'modelUsage'` (a real live measurement) can never
// match again. That guarantee holds only because every rewritten line is written as ONE atomic
// replacement carrying BOTH the token fields and `tokensSource` together (never patched
// separately), and each journal FILE is replaced atomically (temp file + rename, in the same
// directory) so a crash mid-run can never leave a line, or a file, half-written.
//
// ---- the three-state contract, and what this tool must never do ------------------------------
// tokensSource has exactly three meanings end to end (see console/collect.js:223-232, the one
// place that maps them to the measured/recovered/notMeasured triad the dashboard renders):
//   'modelUsage' -- measured, straight from the CLI's own reply. NEVER overwritten by this tool.
//   'transcript' -- recovered from the session transcript: real, but a LOWER BOUND. What a
//                   successful recovery here writes -- see #107's own three-state contract; the
//                   literal string 'recovered' does NOT appear anywhere in this codebase and must
//                   not be introduced here either.
//   null / absent -- not measured at all. What every event recoverSessionTokens returns null for
//                    must STAY: this tool leaves such an event completely untouched -- no
//                    tokensSource, no zeros, no new keys of any kind. A bare numeric
//                    `billableTokens: 0` with no `tokensSource` is exactly the ambiguity the
//                    three-state contract exists to prevent (see task-summary.js's own header on
//                    why `tokensSource`, never a truthy check on a number, is the marker).
//
// INFORMATIONAL ONLY (#107's A5): this tool changes nothing about control flow. No threshold, no
// park reason, no gate. It only ever adds the eight recovery-owned fields to a line that already
// exists, or leaves that line untouched.
//
// ---- the one known side effect this tool does NOT try to fix ---------------------------------
// A `finished` event (appended once, at FINISH, by orchestrator/steps/scripted.js's
// summarizeTask-backed `sumJournalBillableTokens` call) carries a frozen `billableTokens` roll-up
// that is never recomputed after the fact. No live consumer reads that field back (every reader --
// task-summary.js, tokens.js, console/collect.js, park-loop.js, bin/spo, render-deck.js -- re-
// derives from the llm-call events themselves; the only reader of the `finished` event itself,
// orchestrator/recette.js, checks `prNumber` only) -- it is write-only dead data, and this tool
// deliberately does NOT rewrite it. What it DOES do is name, generically, any task whose frozen
// `finished.billableTokens` no longer agrees with the journal's own derived sum once this backfill
// has run -- so the divergence is on the record rather than silently drifting further from truth.
//
// ---- THE LEDGER RESTATEMENT (measured 2026-09-10, card #169; write this number ONCE, here) ----
//   ledger before backfill : 21,417,992 billable over 219 measured calls
//                            (of 345 llm-call events in per-task journals)
//                            covering 2026-09-01 .. 2026-09-10
//   backfill adds          : 6,759,238 billable across 92 calls
//                            (fresh input 3,046 + cache creation 5,589,528 + output 1,166,664)
//                            plus 108,909,776 cacheRead, reported separately, NEVER merged in
//   ledger after backfill  : 28,177,230 billable over 311 calls
//                            covering 2026-08-29 .. 2026-09-10
//   recovered share        : 23.99% of the completed ledger
//   scope                  : per-task journals only. journal/daemon.jsonl is excluded (see above)
//                            and holds 3 REVIEW_CARD calls / 182,688 billable of its own. Every
//                            existing consumer walks journal/*/journal.jsonl, so this IS what the
//                            tooling means by "the ledger".
//   arithmetic check        : 21,417,992 + 6,759,238 = 28,177,230; 6,759,238 / 28,177,230 = 23.99%.
// These are the corrected figures. The card's own original "1.63x the abnormal-call recovery" and
// "34.8% of a completed ledger" are both WRONG at this commit and must not be restated as fact:
// there are zero `tokensSource: 'transcript'` events in the live journal today (this backfill has
// never run in production), so the 1.63x denominator does not exist, and the 34.8% figure was
// computed against the PRE-recovery ledger while describing itself as "of a completed ledger".
//
// ---- state dir injection -----------------------------------------------------------------------
// Same convention as scripts/replay-plan-span-flags.js: `--journal <dir>` wins outright; failing
// that, the real default `stateJournalRoot(resolveStateRoot())` (orchestrator/state-root.js),
// which itself honours SPO_STATE_DIR. runBackfill() below takes journalRoot as a plain parameter
// -- the injection point every test in this lot uses directly, no subprocess, no env var required.
//
// ---- the recovery call -------------------------------------------------------------------------
// Calls recoverSessionTokens with exactly `{sessionId, accountConfigDir}` -- deliberately NOT
// homeDir/accountsDir/maxFileBytes -- mirroring orchestrator/steps/llm.js's own maybeRecoverTokens
// call verbatim (`recoverFn({sessionId: result.sessionId, accountConfigDir: opts.account &&
// opts.account.configDir})`). This backfill is reconstructing calls that ALREADY happened through
// the exact production code path; passing a different homeDir/accountsDir/maxFileBytes here would
// risk silently recovering against a DIFFERENT search space than production actually used, for no
// benefit -- recoverSessionTokens's own defaults (os.homedir(), config.claudeAccountsDir,
// DEFAULT_MAX_FILE_BYTES) are exactly what a live call falls through to as well. `accountConfigDir`
// is derived from the journal event's own `account` field (the account NAME, a string --
// orchestrator/steps/llm.js journals `account: account && account.name`) the same way
// orchestrator/accounts.js's readRegistry derives it in production: `path.join(poolDir, name)`
// (accounts.js:200). `accountsDir` (the pool directory itself) is this tool's own separate,
// explicit parameter -- defaulting to the same `config.claudeAccountsDir` recoverSessionTokens
// would fall back to if left unset, so the two agree even though only one of them is told about it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../orchestrator/config');
const { resolveStateRoot, stateJournalRoot } = require('../orchestrator/state-root');
const { recoverSessionTokens: recoverSessionTokensDefault } = require('../orchestrator/token-recovery');
const { lockPath, processAlive } = require('../orchestrator/lock');

// Thrown by writeFileAtomic when the file it is about to replace changed on disk (mtimeMs or
// size) since this tool read it -- see the header's "concurrency" section. Caught locally in
// backfillFile (aborts that ONE file, not the whole run); any other error out of writeFileAtomic
// propagates and stops the run, same as before this fix.
class ConcurrentWriteError extends Error {
  constructor(filePath) {
    super(`refusing to overwrite ${filePath}: it changed on disk since it was read (concurrent writer detected)`);
    this.name = 'ConcurrentWriteError';
    this.filePath = filePath;
  }
}

// liveDaemonLockHolder(journalRoot, {isAlive, hostname}) -> the lock's holder object
// ({pid, host, startedAt, mode, ...}) if it names a process that is BOTH alive and on THIS host,
// else null. Two conditions, not one, because `isAlive` (process.kill(pid, 0)) can only ever
// probe a pid on the machine it runs on -- a lock written by a daemon on a DIFFERENT host is
// neither confirmable nor deniable from here, so it is treated as not-live (silently allowed to
// proceed) rather than refused on a guess -- exactly the same call acquireLock's own
// `holderAlive` conjunct makes (orchestrator/lock.js:145-147, "foreign host leftover ... stale").
// A missing or unreadable/torn lock file is null too -- the same "treated as stale" posture as
// orchestrator/lock.js's own (unexported) readHolder (lock.js:112-117, "unreadable or torn --
// treated as stale below"); note readHolder's own contract stops at that torn-file case --
// the foreign-host decision lives in acquireLock, not in readHolder, so both are cited above for
// the sentence they actually each cover. Uses only lock.js's exported `lockPath`/`processAlive`
// -- never reaches into that module's internals. `isAlive`/`hostname` are injectable (default:
// the real processAlive / os.hostname()) so a test never depends on a real pid or a real machine
// name.
function liveDaemonLockHolder(journalRoot, { isAlive = processAlive, hostname = os.hostname() } = {}) {
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath(journalRoot), 'utf8'));
  } catch {
    return null; // no lock file, or unreadable/torn -- not a live-holder signal
  }
  if (!holder || typeof holder.pid !== 'number' || holder.host !== hostname) return null;
  return isAlive(holder.pid) ? holder : null;
}

function isTargetEvent(event) {
  return (
    !!event &&
    typeof event === 'object' &&
    event.event === 'llm-call' &&
    event.ok === true &&
    typeof event.sessionId === 'string' &&
    event.sessionId !== '' &&
    !event.tokensSource // falsy: absent OR explicit null -- mirrors llm.js's own guard, see header
  );
}

// journal/*/journal.jsonl only -- see this file's header ("where events live") for the full
// account of why journal/daemon.jsonl (a FILE, today) is excluded: TWO things already exclude it
// as-is (`isDirectory()` below, and separately the fact that `<entry>/journal.jsonl` can never
// resolve under a regular file), so removing `isDirectory()` alone leaves it excluded regardless.
// The BY-NAME check below is the one guard that is load-bearing for a DIFFERENT shape -- if
// daemon.jsonl were ever a directory instead.
function findTaskJournalFiles(journalRoot) {
  let entries;
  try {
    entries = fs.readdirSync(journalRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // one of two things that excludes daemon.jsonl AS A FILE -- see header above
    if (entry.name === 'daemon.jsonl') continue; // the one guard load-bearing if it were ever a directory instead
    const filePath = path.join(journalRoot, entry.name, 'journal.jsonl');
    if (fs.existsSync(filePath)) files.push({ taskId: entry.name, filePath });
  }
  files.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return files;
}

// Same tmp-then-rename idiom as orchestrator/journal.js's writeState/writeLiveWorkerIds: write to
// a throwaway file in the SAME directory, then rename over the target. A crash or kill -9 mid-
// write leaves (at worst) an orphaned tmp file behind -- target.journal.jsonl itself is always
// either the old complete file or the new complete file, never a torn one.
//
// `mode`, `expectedMtimeMs`/`expectedSize` are both optional, both about NOT losing information
// this tool did not put there itself:
//   `mode` -- chmod the tmp file to the ORIGINAL file's permission bits before the rename. A tmp
//     file is created fresh at 0666 & ~umask, so without this a 0600 journal.jsonl would silently
//     come back looser (typically 0664/0644) after every rewrite, purely as a side effect of going
//     through a temp file. orchestrator/journal.js's own writeState (the same tmp+rename idiom)
//     does NOT do this today -- noted here so the difference reads as a deliberate choice on this
//     tool's part, not an oversight on journal.js's.
//   `expectedMtimeMs`/`expectedSize` -- re-stat `filePath` immediately before the rename and
//     compare against what the caller recorded right after ITS OWN read. A mismatch means some
//     other writer (the daemon, a hand-run command, another copy of this tool) touched this exact
//     file in the window between that read and this rename -- proceeding would silently discard
//     whatever they just wrote. Throws ConcurrentWriteError instead; see this file's header
//     ("concurrency") for the other half of this defense (main()'s live-lock refusal).
function writeFileAtomic(filePath, content, { mode, expectedMtimeMs, expectedSize } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    if (typeof mode === 'number') {
      try {
        fs.chmodSync(tmp, mode);
      } catch {
        // Failing to TIGHTEN permissions is not a reason to abandon a recovery -- this is pure
        // best-effort. A filesystem/mount that refuses chmod (ENOSYS, a read-only bind, some
        // network mounts) must not turn "the rewrite would have come back slightly looser" into
        // "nothing got written at all". Proceeds with the tmp file's own default mode instead.
      }
    }
    if (expectedMtimeMs !== undefined && expectedSize !== undefined) {
      let current;
      try {
        current = fs.statSync(filePath);
      } catch (statErr) {
        if (statErr && statErr.code === 'ENOENT') {
          // The target was DELETED between our read and this rename -- same concurrent-writer
          // family as a mutation (see this file's header, "concurrency"), not a reason to crash
          // the whole run: without this, an ENOENT here propagates as a raw fs error instead of
          // ConcurrentWriteError, backfillFile's catch doesn't recognise it, and it takes down
          // every OTHER file still queued behind it in the same run.
          throw new ConcurrentWriteError(filePath);
        }
        throw statErr;
      }
      if (current.mtimeMs !== expectedMtimeMs || current.size !== expectedSize) {
        throw new ConcurrentWriteError(filePath);
      }
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp was never created, or rename already moved it -- nothing to clean up either way.
    }
    throw err;
  }
}

// Processes ONE task's journal.jsonl. Never re-orders or drops a line: every line this function
// does not rewrite is carried through byte-for-byte, blank and unparsable lines included -- an
// unparsable line is left exactly as it was, never treated as a target (there is nothing safe to
// parse a target predicate out of). The file's trailing-newline convention is preserved exactly:
// split on '\n' with the empty tail (produced only when the raw text itself ends in '\n') popped
// off before processing and re-appended, verbatim, at the end.
//
// Returns per-file counts (see header for the "events scanned / targets found / recovered /
// skipped-null / billable added / cacheRead added" vocabulary this mirrors) plus two numbers used
// only for the stale-roll-up check (component B): `derivedBillableSum`, the sum of every llm-call
// event's own numeric `billableTokens` field AFTER this pass's in-memory rewrites -- the exact
// same one-line reduce orchestrator/task-summary.js's summarizeTask uses (`if (typeof
// event.billableTokens === 'number') billableTokens += event.billableTokens`) -- and
// `frozenFinishedBillableTokens`, the numeric `billableTokens` field on a `finished` event if one
// exists on this file, else null. Recomputed from the IN-MEMORY post-backfill lines rather than by
// calling the real summarizeTask against the file on disk, because that must give the same,
// correct answer under `--dry-run` (nothing written) as it does under `--apply` (file rewritten) --
// see test/backfill-legacy-tokens.test.js's own cross-check against the real summarizeTask after a
// real --apply run, which is what keeps this reduce from silently drifting off that function's.
async function backfillFile(filePath, { apply, recoverFn, accountsDir }) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Stat taken right after the read -- the "what we read" snapshot writeFileAtomic's own
  // concurrency guard compares against immediately before it renames. See this file's header
  // ("concurrency") and writeFileAtomic's own comment for why.
  const readStat = fs.statSync(filePath);
  const trailingNewline = raw.endsWith('\n');
  const rawLines = raw.split('\n');
  if (trailingNewline) rawLines.pop(); // drop the empty tail split() leaves after a trailing '\n'

  const outLines = new Array(rawLines.length);
  let llmCallEventsScanned = 0;
  let targetsFound = 0;
  let recovered = 0;
  let skippedNull = 0;
  let billableAdded = 0;
  let cacheReadAdded = 0;
  let changed = false;
  let derivedBillableSum = 0;
  let frozenFinishedBillableTokens = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    outLines[i] = line; // default: this line is untouched unless rewritten below

    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // malformed/unparsable -- leave it exactly as it was, never a target
    }
    if (!event || typeof event !== 'object') continue;

    if (event.event === 'finished' && typeof event.billableTokens === 'number') {
      frozenFinishedBillableTokens = event.billableTokens;
    }

    if (event.event !== 'llm-call') continue;
    llmCallEventsScanned += 1;

    let effectiveEvent = event; // may be replaced below once recovery succeeds
    if (isTargetEvent(event)) {
      targetsFound += 1;
      const accountConfigDir = event.account ? path.join(accountsDir, event.account) : undefined;
      let result = null;
      try {
        result = await recoverFn({ sessionId: event.sessionId, accountConfigDir });
      } catch {
        // recoverSessionTokens's own contract is "never throw" -- this catch is a backstop
        // against that contract regressing, same posture as llm.js's own maybeRecoverTokens.
        result = null;
      }
      if (!result) {
        skippedNull += 1;
        // Three-state contract: leave this event COMPLETELY untouched. No tokensSource, no
        // zeros, no new keys -- it stays not-measured.
      } else {
        recovered += 1;
        billableAdded += result.billableTokens;
        cacheReadAdded += result.cacheReadTokens;
        effectiveEvent = {
          ...event, // preserves field order; the eight recovery fields are appended, never inserted
          tokensSource: result.tokensSource,
          freshInputTokens: result.freshInputTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          cacheReadTokens: result.cacheReadTokens,
          outputTokens: result.outputTokens,
          billableTokens: result.billableTokens,
          transcriptFilesRead: result.transcriptFilesRead,
          transcriptFilesSkipped: result.transcriptFilesSkipped,
        };
        outLines[i] = JSON.stringify(effectiveEvent);
        changed = true;
      }
    }

    if (typeof effectiveEvent.billableTokens === 'number') derivedBillableSum += effectiveEvent.billableTokens;
  }

  let concurrentWriteAborted = false;
  if (apply && changed) {
    const content = outLines.join('\n') + (trailingNewline ? '\n' : '');
    try {
      writeFileAtomic(filePath, content, {
        mode: readStat.mode,
        expectedMtimeMs: readStat.mtimeMs,
        expectedSize: readStat.size,
      });
    } catch (err) {
      if (err instanceof ConcurrentWriteError) {
        // Abort THIS file only -- everything already recovered above stays in-memory-only (never
        // written), and every OTHER file in the run is unaffected. Safe to just re-run later: the
        // predicate that made these events targets is still true on disk, since nothing here was
        // written.
        concurrentWriteAborted = true;
      } else {
        throw err;
      }
    }
  }

  return {
    llmCallEventsScanned,
    targetsFound,
    recovered,
    skippedNull,
    billableAdded,
    cacheReadAdded,
    changed,
    concurrentWriteAborted,
    written: apply && changed && !concurrentWriteAborted,
    derivedBillableSum,
    frozenFinishedBillableTokens,
  };
}

// runBackfill({journalRoot, apply, accountsDir, recoverFn}) -- the whole run, as a plain object.
// `accountsDir` and `recoverFn` are both injectable so a test never touches a real account pool or
// a real transcript (production defaults: config.claudeAccountsDir and the real
// recoverSessionTokens, wired up by main() below -- never by this function itself, so a caller
// that forgets to pass `recoverFn` gets a loud error rather than a silent real run).
async function runBackfill({ journalRoot, apply = false, accountsDir, recoverFn }) {
  if (typeof recoverFn !== 'function') {
    throw new Error('runBackfill: recoverFn is required (pass the real recoverSessionTokens explicitly, or a fake for tests)');
  }
  const files = findTaskJournalFiles(journalRoot);

  const perTask = [];
  const totals = {
    llmCallEventsScanned: 0,
    targetsFound: 0,
    recovered: 0,
    skippedNull: 0,
    billableAdded: 0,
    cacheReadAdded: 0,
    filesChanged: 0,
    filesWritten: 0,
    filesAborted: 0,
    // Sums restricted to files whose write was aborted -- the portion of billableAdded/
    // cacheReadAdded above that was computed but never landed on disk. See D1: `billableAdded`
    // alone is a "what this run COMPUTED" figure, true under dry-run and under an abort alike;
    // it must never be read as "what this run PERSISTED" without checking these two as well.
    billableAddedNotPersisted: 0,
    cacheReadAddedNotPersisted: 0,
  };
  const staleRollups = [];

  for (const { taskId, filePath } of files) {
    const stats = await backfillFile(filePath, { apply, recoverFn, accountsDir });
    perTask.push({ taskId, ...stats });
    totals.llmCallEventsScanned += stats.llmCallEventsScanned;
    totals.targetsFound += stats.targetsFound;
    totals.recovered += stats.recovered;
    totals.skippedNull += stats.skippedNull;
    totals.billableAdded += stats.billableAdded;
    totals.cacheReadAdded += stats.cacheReadAdded;
    // `changed` means "this file HAS a rewrite computed" -- true under dry-run too, which is what
    // lets printReport still say "files that would be written" with no --apply. `written` (true
    // ONLY when the rewrite was actually persisted -- apply && changed && !aborted) is the
    // strictly narrower, "did this really land on disk" count printReport must use under --apply
    // (D1: printing filesChanged there would count an aborted file as written when it was not).
    if (stats.changed) totals.filesChanged += 1;
    if (stats.written) totals.filesWritten += 1;
    if (stats.concurrentWriteAborted) {
      totals.filesAborted += 1;
      totals.billableAddedNotPersisted += stats.billableAdded;
      totals.cacheReadAddedNotPersisted += stats.cacheReadAdded;
    }

    if (stats.frozenFinishedBillableTokens !== null && stats.frozenFinishedBillableTokens !== stats.derivedBillableSum) {
      staleRollups.push({
        taskId,
        frozen: stats.frozenFinishedBillableTokens,
        derived: stats.derivedBillableSum,
      });
    }
  }

  return { apply, journalRoot, filesScanned: files.length, perTask, totals, staleRollups };
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function printReport(result) {
  const { apply, journalRoot, filesScanned, perTask, totals, staleRollups } = result;
  console.log(`backfill-legacy-tokens: journal root = ${journalRoot}`);
  console.log(`backfill-legacy-tokens: mode = ${apply ? 'APPLY (writing)' : 'DRY-RUN (no writes -- pass --apply to write)'}`);
  console.log(`backfill-legacy-tokens: task journals scanned = ${filesScanned}`);
  console.log('');
  for (const t of perTask) {
    if (t.llmCallEventsScanned === 0 && t.targetsFound === 0) continue; // nothing to say about this task
    let statusTag = '[no change]';
    if (t.concurrentWriteAborted) statusTag = '[ABORTED -- concurrent writer, re-run to retry]';
    else if (t.changed) statusTag = apply ? '[written]' : '[would write]';
    console.log(
      `  ${t.taskId}: llm-call events=${t.llmCallEventsScanned} targets=${t.targetsFound} ` +
        `recovered=${t.recovered} skipped-null=${t.skippedNull} billable+=${formatNumber(t.billableAdded)} ` +
        `cacheRead+=${formatNumber(t.cacheReadAdded)} ${statusTag}`
    );
  }
  console.log('');
  console.log('---- totals ----');
  console.log(`llm-call events scanned : ${formatNumber(totals.llmCallEventsScanned)}`);
  console.log(`targets found           : ${formatNumber(totals.targetsFound)}`);
  console.log(`recovered               : ${formatNumber(totals.recovered)}`);
  console.log(`skipped (null recovery) : ${formatNumber(totals.skippedNull)}`);
  // D1: billableAdded/cacheReadAdded are always "what this run COMPUTED", never "what it
  // PERSISTED" -- true even under --apply, since an aborted file's recovery still counts here
  // (see runBackfill's own comment on why). Annotated with the un-persisted portion whenever any
  // file aborted, so the printed number cannot be read as a claim about disk state it did not
  // verify.
  console.log(
    `billable tokens added   : ${formatNumber(totals.billableAdded)}` +
      (totals.filesAborted > 0 ? ` (of which ${formatNumber(totals.billableAddedNotPersisted)} NOT persisted -- aborted, see below)` : '')
  );
  console.log(
    `cacheRead tokens added  : ${formatNumber(totals.cacheReadAdded)}` +
      (totals.filesAborted > 0 ? ` (of which ${formatNumber(totals.cacheReadAddedNotPersisted)} NOT persisted)` : '') +
      ' (reported separately, never merged into billable)'
  );
  // D1: under --apply this MUST be filesWritten (what actually landed on disk), never
  // filesChanged (what merely had a rewrite computed) -- an aborted file has changed:true but
  // written:false, and printing filesChanged here would state a write that did not happen.
  console.log(`files ${apply ? 'written' : 'that would be written'} : ${apply ? totals.filesWritten : totals.filesChanged}`);
  if (totals.filesAborted > 0) {
    console.log(
      `files ABORTED (concurrent writer): ${totals.filesAborted} -- these were NOT written; a ` +
        'later run will retry them safely (this tool is idempotent -- see the [ABORTED] lines above).'
    );
  }
  console.log('');
  console.log('---- stale roll-up check (the one known side effect this tool does NOT fix) ----');
  if (staleRollups.length === 0) {
    console.log('no task\'s frozen `finished.billableTokens` diverges from its journal-derived sum.');
  } else {
    for (const s of staleRollups) {
      console.log(
        `  ${s.taskId}: finished.billableTokens (frozen) = ${formatNumber(s.frozen)}, ` +
          `journal-derived sum = ${formatNumber(s.derived)} -- DIVERGES. The 'finished' event ` +
          'itself is deliberately NOT rewritten; see this script\'s own header.'
      );
    }
  }
}

function parseArgs(argv) {
  const opts = { apply: false, journal: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--journal' && i + 1 < argv.length) opts.journal = argv[++i];
    else if (a.startsWith('--journal=')) opts.journal = a.slice('--journal='.length);
  }
  return opts;
}

// main(argv, deps) -- the CLI entry point. `deps` is production-shaped (every field optional,
// defaulting to the real thing) purely so a test can drive main() itself -- argv parsing, the
// live-lock refusal, the journal-root-missing check -- without ever reaching a real account pool
// or a real transcript: pass deps.recoverFn / deps.accountsDir to override what runBackfill
// receives, or deps.liveDaemonLockHolderFn to fake the lock check. The CLI guard at the bottom of
// this file calls `main(process.argv.slice(2))` with no second argument, so every default here IS
// what a real run gets.
async function main(argv, deps = {}) {
  const recoverFn = deps.recoverFn || recoverSessionTokensDefault;
  const accountsDir = deps.accountsDir !== undefined ? deps.accountsDir : config.claudeAccountsDir;
  const liveDaemonLockHolderFn = deps.liveDaemonLockHolderFn || liveDaemonLockHolder;

  const args = parseArgs(argv);
  const journalRoot = args.journal || stateJournalRoot(resolveStateRoot());
  if (!fs.existsSync(journalRoot)) {
    console.error(`backfill-legacy-tokens: journal root does not exist: ${journalRoot}`);
    process.exitCode = 1;
    return;
  }

  // Concurrency defense (1) of 2 -- see this file's header. Only gates a real write, and only
  // when --force was not given; a dry-run is always safe to run alongside a live daemon since it
  // never touches disk.
  if (args.apply && !args.force) {
    const holder = liveDaemonLockHolderFn(journalRoot);
    if (holder) {
      console.error(
        `backfill-legacy-tokens: refusing to write -- ${lockPath(journalRoot)} is held by a LIVE ` +
          `daemon (pid ${holder.pid} on ${holder.host}, mode ${holder.mode || '?'}, started ` +
          `${holder.startedAt || '?'}). Writing to the same journal files that daemon may be ` +
          "appending to risks silently losing whatever it appends in this tool's own read-to-" +
          'rename window. Stop the daemon first (see doc/operating.md), or pass --force to ' +
          'proceed anyway -- --force accepts exactly that risk, it does not remove it (the ' +
          'per-file concurrency guard below still applies either way).'
      );
      process.exitCode = 1;
      return;
    }
  }

  const result = await runBackfill({ journalRoot, apply: args.apply, accountsDir, recoverFn });
  printReport(result);
}

module.exports = {
  isTargetEvent,
  findTaskJournalFiles,
  writeFileAtomic,
  backfillFile,
  runBackfill,
  printReport,
  parseArgs,
  main,
  liveDaemonLockHolder,
  ConcurrentWriteError,
};

// Guarded so `require('../scripts/backfill-legacy-tokens')` (every test in this lot) never
// triggers a real run against the real journal/account pool as a require-time side effect -- same
// convention as scripts/usage-report.js's own CLI guard.
if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`backfill-legacy-tokens: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}
