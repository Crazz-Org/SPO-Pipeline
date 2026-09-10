'use strict';
// token-recovery.js -- token-ledger lot, action 4.3: recovers billable tokens for an `llm-call`
// that really ran (a `sessionId` was minted and `claude` was spawned) but reported no `modelUsage`
// block, so orchestrator/steps/llm.js's extractTokens returned ZERO_TOKENS (`tokensSource: null,
// billableTokens: 0`) even though the call spent real tokens. Measured on the real corpus (action
// 4.2): 20 such calls hold 4,144,490 billable tokens recorded as zero; the ledger reads
// 19,434,656 and should read 23,579,146.
//
// The fix is not a second accounting path: `claude` itself writes every call's usage into the
// session's own JSONL transcript on disk (the same file console/usage-scan.js streams for the
// live dashboard's tokens view), so this module locates that transcript by session id and reads
// it back through the EXACT SAME reader, console/usage-scan.js's scanFile -- exported from that
// module for this purpose (see its own export comment). There is exactly one definition of
// "billable" (fresh input + cache-creation + output, cache-read reported separately -- see
// orchestrator/steps/llm.js's own header) and exactly one reader of a transcript file; a second
// reader here would let the two silently drift apart the way console/usage-scan.js and
// scripts/usage-report.js once did, until SPO-Pipeline#170 made them share one reader.
//
// ---- locate by session id, never by slugifying cwd --------------------------------------------
//
// A session id is a UUID-v4 minted (or supplied) once per call and is globally unique, so a
// filename match (`<sessionId>.jsonl`) is unambiguous. The alternative -- deriving the CLI's own
// project-directory name from the call's cwd -- depends on a slug rule this repo does not control
// and has already observed drift on: both `-home-crazz-SPO-Pipeline-worktrees-issue-N` and
// `-home-crazz--spo-worktrees-issue-N` shapes exist in the real corpus for what should be the same
// kind of path. Searching by filename sidesteps that rule entirely.
//
// Also NOT by a time-window match ("the session that started closest to this call's own
// timestamp"): that happened to be unique across every corpus call measured, but is a property of
// that corpus, not a guarantee -- two kills close enough together collapse into ambiguous
// candidates under a loose-enough window. This module works only because
// orchestrator/steps/llm.js's invokeClaudeReal mints `sessionId` BEFORE spawning `claude`, so a
// killed call still has an id to be found by. See orchestrator/README.md's Tokens section for the
// measured numbers behind this.
//
// ---- roots searched, in order -------------------------------------------------------------------
//
//   1. accountConfigDir's own `projects` directory -- the account the call actually ran under
//      (CLAUDE_CONFIG_DIR), checked first. In production this root is always a DUPLICATE of one
//      already reachable from `accountsDir` below (`account.configDir` is `path.join(poolDir,
//      name)`, and `accountsDir` defaults to that same `poolDir` -- see buildRoots' own dedup by
//      resolved path), so today it never contributes a file the pool walk wouldn't have found
//      anyway. Kept as an explicit, separately-checked root anyway: it is the one root that still
//      works when `CLAUDE_CONFIG_DIR` points OUTSIDE the pool (a `claude setup-token` account run
//      from a directory `accountsDir` does not enumerate), a deliberate redundancy against that
//      case, not an ordering benefit this build can actually observe on the live corpus.
//   2. every OTHER pool account's `projects` directory (accountsDir's subdirectories, via
//      console/usage-scan.js's discoverUsageRoots -- same root layout, reused rather than
//      re-derived).
//   3. homeDir/.claude/projects -- the ambient, non-pooled location (`discoverUsageRoots`'s
//      'local' root), searched last.
//
// Deduplicated by resolved path (accountConfigDir can coincide with a pool root) and filtered to
// roots that actually exist on this machine -- a missing root is silently skipped, not an error.
//
// ---- null vs. a measured zero -------------------------------------------------------------------
//
// Returns null when nothing recoverable was found: no file matched `sessionId` anywhere, or one or
// more files matched but not a single usage row was parsed out of any of them. Returns a real
// object -- `billableTokens` genuinely 0 included -- the moment at least one usage row was parsed,
// even if every field on it is 0. That is not a hypothetical: 4 of the 20 corpus calls this action
// exists for recover exactly 0, because their transcript holds one assistant message with an
// all-zero usage block -- a real measurement, not an absence. Distinguishing "found rows summing
// to 0" from "found no rows" is the reason this module exists at all; a truthy test on the total
// would silently erase that distinction (see the header on orchestrator/steps/llm.js's
// extractTokens for the sibling rule this mirrors: `tokensSource` is the marker, never a truthy
// check on a number).
//
// ---- never throws ---------------------------------------------------------------------------
//
// This runs on a call's FAILURE path (a deadline kill, an external signal, unparsable stdout, an
// is_error/non-zero-exit reply) as well as its success path -- a throw here would turn a
// recoverable failure into a crash. Every
// fs operation below is individually try/caught and degrades to "skip this candidate", so the
// walk keeps going past an unreadable directory, a path that is actually a directory where a file
// was expected, or a file over the size cap. The one outer try/catch exists only as a backstop
// against a failure this module did not anticipate; when it fires, any tokens already summed in
// that call are discarded and the whole call returns null rather than asserting a partial,
// unaudited total -- every OTHER error path in this module (an unreadable directory, a bad file, a
// malformed line) is already contained locally and does NOT discard sums accumulated from other,
// good files in the same call.

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const { scanFile, discoverUsageRoots, DEFAULT_MAX_FILE_BYTES } = require('../console/usage-scan');

// Matches console/usage-scan.js's own MAX_SUBAGENT_WALK_DEPTH -- deep enough for any layout seen
// on this machine, shallow enough that a pathological/cyclic layout can't walk forever. Not
// imported from there (not exported, and a directory-walk depth cap is not the ledger this
// module's header promises not to duplicate -- scanFile, the actual reader, is).
const MAX_SUBAGENT_WALK_DEPTH = 8;

// Recursively collects every *.jsonl under `dir` (a session's `subagents` directory), skipping
// symlinked directories (no cycles) and stopping at MAX_SUBAGENT_WALK_DEPTH regardless. Never
// throws: an unreadable directory anywhere in the tree, or a single bad entry, is skipped, not
// fatal to the rest of the walk -- same convention as console/usage-scan.js's own
// listJsonlFilesRecursive, which this mirrors rather than imports (see this file's header).
function listJsonlFilesRecursive(dir, depth, out) {
  if (depth > MAX_SUBAGENT_WALK_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    try {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(path.join(dir, e.name));
      } else if (e.isDirectory() && !e.isSymbolicLink()) {
        listJsonlFilesRecursive(path.join(dir, e.name), depth + 1, out);
      }
    } catch {
      /* one bad entry (permission, a race with something removing it) does not abort the walk */
    }
  }
}

// Every *.jsonl candidate for `sessionId` directly under one projects root:
// `<root>/<project>/<sessionId>.jsonl` (the main transcript) plus the recursive
// `<root>/<project>/<sessionId>/subagents/**` tree (every line in there already carries the
// PARENT session's id -- see console/usage-scan.js's own comment on why that walk needs no extra
// attribution logic). Never throws: an unreadable root or project directory is skipped, matching
// console/usage-scan.js's listCandidateFiles' own convention.
function findSessionFilesUnderRoot(rootPath, sessionId) {
  const files = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(rootPath, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return files;
  }
  for (const d of projectDirs) {
    const projectDir = path.join(rootPath, d.name);
    const mainFile = path.join(projectDir, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(mainFile).isFile()) files.push(mainFile);
    } catch {
      /* no main transcript for this session under this project -- subagents may still exist */
    }
    listJsonlFilesRecursive(path.join(projectDir, sessionId, 'subagents'), 0, files);
  }
  return files;
}

// Ordered, deduplicated, existence-filtered root list -- see this file's header for the ordering
// rationale. `discoverUsageRootsFn` is injected (defaults to console/usage-scan.js's real
// discoverUsageRoots) purely so a caller could substitute it; production and every test in this
// lot use the real one against a real, throwaway temp directory tree (per this action's own test
// instructions: build real directories, do not mock fs).
function buildRoots({ accountConfigDir, accountsDir, homeDir, discoverUsageRootsFn }) {
  const roots = [];
  const seen = new Set();

  function addRoot(candidate) {
    if (!candidate) return;
    let resolved;
    try {
      resolved = path.resolve(candidate);
    } catch {
      return;
    }
    if (seen.has(resolved)) return;
    let exists = false;
    try {
      exists = fs.existsSync(resolved);
    } catch {
      exists = false;
    }
    if (!exists) return;
    seen.add(resolved);
    roots.push(resolved);
  }

  // 1. the account the call actually ran under.
  if (accountConfigDir) addRoot(path.join(accountConfigDir, 'projects'));

  // 2. every other pool account -- discoverUsageRoots' own 'local' entry is skipped here and
  //    added explicitly, last, from `homeDir` below: discoverUsageRoots always reads the REAL
  //    os.homedir() for that entry, which this module must not depend on (homeDir is this
  //    function's own injection point, so a test never touches the real machine's ~/.claude).
  let poolRoots = [];
  try {
    poolRoots = discoverUsageRootsFn(accountsDir) || [];
  } catch {
    poolRoots = [];
  }
  for (const r of poolRoots) {
    if (r && r.account !== 'local' && r.path) addRoot(r.path);
  }

  // 3. the ambient, non-pooled location, searched last.
  addRoot(path.join(homeDir, '.claude', 'projects'));

  return roots;
}

// recoverSessionTokens({sessionId, accountConfigDir, homeDir, maxFileBytes, accountsDir}, deps)
//   -> Promise<null | {tokensSource: 'transcript', freshInputTokens, cacheCreationTokens,
//      cacheReadTokens, outputTokens, billableTokens, transcriptFilesRead, transcriptFilesSkipped}>
//
// `transcriptFilesRead` alone cannot distinguish "1 file, the whole story" from "1-of-100, the
// other 99 lost to an error" -- both journal the same number. `transcriptFilesSkipped` is the
// completeness signal that closes that gap: incremented on every candidate this function itself
// KNOWS it dropped without reading -- a resolved-path failure, a stat failure (gone since the
// directory listing, or a permission race), a file over `maxFileBytes`, a `scanFile` call that
// threw (its own contract is "never throw"; this is the backstop, not the expected path), or a
// falsy aggregate back from an injected `deps.scanFile`. An abandoned root (findSessionFilesUnderRoot
// itself throwing, caught below) counts as one skip too, though the true number of files under
// that root is unknowable from here. What this counter CANNOT see: a mid-stream truncation inside
// scanFile itself ("stream error mid-file -- keep whatever was accumulated so far", scanFile's own
// comment) still counts as a normal, non-skipped `transcriptFilesRead` -- scanFile's contract
// returns a partial aggregate, not an error, so there is no signal here to count. That route stays
// silently short by design of the reader this module deliberately does not duplicate (see this
// file's header).
//
// `accountsDir` is not in the parameter list the action's spec wrote out verbatim, but the same
// spec asks for it to be "a parameter or read from config, but injectable" -- adding it as an
// optional field on the same options object satisfies both: it defaults to
// config.claudeAccountsDir (env SPO_ACCOUNTS_DIR) when omitted, exactly like every other reader
// of the pool in this codebase, and a caller (including every test in this lot) can override it
// directly with no deps-object indirection needed.
//
// `deps` follows this repo's existing deps.spawnSync/deps.randomUUID convention
// (orchestrator/steps/llm.js) for the two functions this module calls out to --
// deps.scanFile and deps.discoverUsageRoots -- though no test in this lot needs to override
// either: the test plan builds real temp directory trees and reads them with the real functions,
// the same way production does.
//
// `maxFileBytes` caps bytes read PER FILE, not per session -- nothing here bounds the aggregate a
// session with an unusually deep or wide subagent fan-out could present. Fine on every real
// session measured so far (see orchestrator/README.md's Tokens section for the worst one on
// record); not a guarantee for one that hasn't happened yet.
async function recoverSessionTokens(opts = {}, deps = {}) {
  const { sessionId, accountConfigDir, maxFileBytes } = opts;
  if (typeof sessionId !== 'string' || sessionId === '') return null;

  const scanFileFn = deps.scanFile || scanFile;
  const discoverUsageRootsFn = deps.discoverUsageRoots || discoverUsageRoots;
  const accountsDir = opts.accountsDir !== undefined ? opts.accountsDir : config.claudeAccountsDir;
  const homeDir = opts.homeDir || os.homedir();
  const cap = typeof maxFileBytes === 'number' && maxFileBytes > 0 ? maxFileBytes : DEFAULT_MAX_FILE_BYTES;

  try {
    const roots = buildRoots({ accountConfigDir, accountsDir, homeDir, discoverUsageRootsFn });

    let transcriptFilesRead = 0;
    let transcriptFilesSkipped = 0; // see this function's own header for exactly which routes count
    let anyUsageRow = false; // distinct from "any file found" -- see this file's header
    let freshInputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;

    const seenFiles = new Set();
    for (const rootPath of roots) {
      let candidates;
      try {
        candidates = findSessionFilesUnderRoot(rootPath, sessionId);
      } catch {
        // Contained: this root contributes nothing, the walk continues -- but it may have held
        // candidates we never got to see, so it counts as (at least) one skip even though the
        // true number lost here is unknowable from this catch alone.
        transcriptFilesSkipped += 1;
        continue;
      }

      for (const filePath of candidates) {
        let resolved;
        try {
          resolved = path.resolve(filePath);
        } catch {
          transcriptFilesSkipped += 1;
          continue;
        }
        if (seenFiles.has(resolved)) continue; // a root and an override can name the same file
        seenFiles.add(resolved);

        let st;
        try {
          st = fs.statSync(resolved);
        } catch {
          // gone since the directory listing, or a permission race -- skip it
          transcriptFilesSkipped += 1;
          continue;
        }
        if (!st.isFile()) continue; // a directory posing as "<sessionId>.jsonl" -- not a skip, never a file to begin with
        if (st.size > cap) {
          transcriptFilesSkipped += 1;
          continue;
        }

        let fileAgg;
        try {
          fileAgg = await scanFileFn(resolved, null);
        } catch {
          // scanFile's own contract is "never throw" (unreadable files yield an empty
          // aggregate) -- this catch is a backstop against that contract regressing, not an
          // expected path.
          transcriptFilesSkipped += 1;
          continue;
        }
        if (!fileAgg) {
          transcriptFilesSkipped += 1;
          continue;
        }

        transcriptFilesRead += 1;
        // fileAgg.msgs is scanFile's own count of usage rows actually applied to its aggregate
        // (after dedup) -- the exact signal for "at least one usage row was parsed", independent
        // of whether every field on those rows happened to be 0. See this file's header on why
        // this must never be a truthy check on a token total.
        if (fileAgg.msgs > 0) anyUsageRow = true;
        for (const m of Object.values(fileAgg.models || {})) {
          freshInputTokens += m.inp || 0;
          cacheCreationTokens += m.cc || 0;
          cacheReadTokens += m.cr || 0;
          outputTokens += m.out || 0;
        }
      }
    }

    if (!anyUsageRow) return null;

    return {
      tokensSource: 'transcript',
      freshInputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      outputTokens,
      billableTokens: freshInputTokens + cacheCreationTokens + outputTokens,
      transcriptFilesRead,
      transcriptFilesSkipped,
    };
  } catch {
    // Backstop only -- every anticipated failure above is already contained locally and does
    // NOT reach here (see this file's header on why an unexpected failure here discards any
    // partial sums rather than asserting them, transcriptFilesSkipped included).
    return null;
  }
}

module.exports = {
  recoverSessionTokens,
  // Re-exported so a test can pin that the cap actually in force in production (maybeRecoverTokens
  // in orchestrator/steps/llm.js never passes maxFileBytes, so every real call falls through to
  // this same default) is console/usage-scan.js's own DEFAULT_MAX_FILE_BYTES, not a second,
  // independently-chosen number -- see this module's own `cap` line above, which reads the
  // identifier imported at the top of this file, never a local copy.
  DEFAULT_MAX_FILE_BYTES,
};
