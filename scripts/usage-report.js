#!/usr/bin/env node
// usage-report v1 — token-usage analysis over local Claude Code transcripts.
//
// Streams every *.jsonl under each root's *<FILTER>*/ (default root: ~/.claude/projects,
// default filter: SPO), dedupes assistant messages by message.id (transcripts write one line
// per content block, so a naive sum double-counts), and aggregates usage by (model,
// driver|sidechain), by workflow phase, by session type, plus a cache-rebuild count.
//
// Deliberately streaming: never slurps a file or the corpus. Per-file memory is O(unique message
// ids), not O(lines) -- see the dedup buffer in doFile. A whole-corpus jq slurp took the WSL VM
// down (tmpfs is RAM — ENOSPC under memory pressure, 2026-08-29). Keep it that way — never
// slurp a file or the corpus.
//
// Usage:   node scripts/usage-report.js [filter] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]
//                                        [--top=N] [--roots=dir1,dir2]
// Output:  one JSON document on stdout — totals by model, by phase, by session type,
//          cache-rebuild count, top sessions, date range. NO dollar figure anywhere (maintainer
//          decision, 2026-08-31: the pool is a Claude Max quota, never metered API billing, so a
//          dollar figure never meant money spent -- see orchestrator/tokens.js's header).
//
// Baseline (2026-08-20..28, filter SPO): 273 sessions, 19,474 messages, ~3.84B cache-read
// tokens, 93% carried by Fable/Opus driver turns. (This measurement originally also carried a
// weighted-USD estimate, ≈ $3,190 API-equivalent -- that conversion is retired along with the
// rest of this file's dollar estimate; the token counts above are the historical fact that
// survives it. IMPORTANT: this baseline was measured under the PRE-2026-09-10 semantics --
// top-level transcripts only, first-wins message.id dedup, see the "semantics" paragraph below.
// Both fixes only ever ADD files or move which occurrence of a duplicate id is counted, so the
// TOKEN counts above are understatements. The SESSION count is not strictly comparable either
// way. The fold means subagent discovery no longer adds phantom extra "sessions" (a session with
// N subagent transcripts counts 1, not N+1), so the old count is NOT inflated relative to today's.
// But it can still be an UNDERSTATEMENT: a session visible only through its subagents -- its
// top-level transcript absent, or its own messages outside this baseline's 2026-08-20..28 window
// while a subagent's fall inside -- is counted now and was invisible then. Measured 2026-09-10:
// 170 session directories carry a subagents/ tree and 0 of them lack a top-level <sid>.jsonl, so
// the window edge, not orphaned subagents, is the live mechanism (this count moves as the corpus
// grows -- re-derive with `find ~/.claude/projects -mindepth 3 -maxdepth 3 -type d -name
// subagents | wc -l`; note project dirs begin with `-`, so pass `--` to anything consuming the
// paths). Do not treat 273 as a like-for-like figure. And a windowed
// run like this one can now DROP a message whose duplicate id spans the window's own edge, since
// --since/--until test the winning occurrence's day, not the first's. Do not re-derive a
// corrected version of this baseline; it is a dated historical record, not a formula.)
//
// v1 additions (this file):
//  - --since / --until / --top / --roots CLI flags (--roots also preps per-account
//    aggregation: each Claude account has its own projects root)
//  - per-phase segmentation from tool_use markers (claim/implement/checks/gate/pr-merge/
//    spawn/research/other) — markers are read from EVERY physical line, including
//    message.id duplicates, because a duplicate line often carries the tool_use block the
//    first line lacks; usage itself is still counted once per deduped message
//  - session type: "card" (any Bash command in the file contains board:take) vs "meta"
//  - cache-rebuild detection: a deduped message (after the file's first) whose
//    cache_creation_input_tokens exceeds 30% of (cache_creation + cache_read)
//
// ---- semantics: same reader as console/usage-scan.js, as of 2026-09-10 (SPO-Pipeline#170) -----
//
// This file used to implement its OWN file walk (two levels only: <root>/<dir containing
// FILTER>/*.jsonl, no subagent recursion) and its OWN message.id dedup (keep the FIRST
// occurrence). Both were bugs, not just a difference of scope: the CLI writes a subagent's own
// usage into <projectDir>/<sessionId>/subagents/**/*.jsonl, which this reader never looked at,
// and it rewrites a streaming assistant message on several consecutive lines under the SAME
// message.id with growing output_tokens, so first-wins under-counted every such message.
// console/usage-scan.js's scanFile had already fixed both (subagent walk, last-wins dedup, see
// its own header for why) for the live dashboard; this file now imports that exact fix rather
// than carrying a diverging copy -- discovery via listJsonlFilesRecursive/listCandidateFiles,
// dedup direction via the same last-occurrence-wins buffering scanFile uses. See
// orchestrator/token-recovery.js:10-18 for why "exactly one reader" is the rule this follows,
// not a style preference: a second reader is exactly how the two scripts' dedup direction drifted
// apart in the first place.
//
// Measured on the real corpus, one process per figure set, 2026-09-10 (the corpus is LIVE and
// grows continuously -- including from sessions measuring it -- so treat every count below as a
// dated snapshot, not a constant to requote unchanged):
//   - files:      current (pre-fix) reader saw 764 top-level files; the corrected reader (this
//                 file, as of this fix) sees 1657 (764 top-level + 893 subagent).
//   - billable:   222,805,957 -> 364,232,625 (fresh input + cache-creation + output). Gap
//                 141,426,668 = 38.84% understatement.
//   - cacheRead:  12,334,230,468 -> 15,987,917,680. Gap 3,653,687,212 = 22.86%.
//   - ATTRIBUTION of the billable gap (three-variant probe: A = first-wins/top-level-only,
//     D = first-wins+subagents, C = last-wins+subagents):
//       subagent walk   (D-A) = 122,810,041 = 86.84% of the gap
//       dedup direction (C-D) =  18,616,627 = 13.16% of the gap
//     cacheRead's gap is 100% subagent walk, 0% dedup direction: input/cache-creation/cache-read
//     never varied across occurrences of one id anywhere in the corpus measured -- only
//     output_tokens grows as the CLI streams, so the dedup direction changes output_tokens alone.
//   - Over the 764 TOP-LEVEL files ALONE, first-wins and last-wins agreed TO THE TOKEN (0
//     divergent files out of 764) -- the dedup direction is worth 0 there and 18,616,627 on
//     subagent files. Both of these are true at once and are not in tension: state them together,
//     never one alone, or the missing half reads as false.
//
// ---- what still deliberately differs from console/usage-scan.js, after this fix -------------
//
// The two are not going to become identical -- they have different jobs (this file: a one-shot
// offline CLI producing a JSON report with per-phase/per-session breakdowns, cacheRebuilds
// detection and tool_use markers; usage-scan.js: an incremental mtime+size-cached scanner feeding
// a live dashboard). Differences that remain, each checked for whether it also changes the
// ARITHMETIC (the actual point of this fix):
//   - incremental caching vs one-shot: usage-scan.js never re-reads an unchanged file across
//     calls (mtime+size cache); this file re-reads everything on every run. No arithmetic effect
//     -- a full re-read produces the same totals, just costs more wall-clock on a repeat run.
//   - maxFileBytes cap: usage-scan.js skips (does not read) any file over
//     DEFAULT_MAX_FILE_BYTES (64 MiB), because its incremental scan re-runs every ~5 minutes in a
//     live server process and an unbounded file would cost that repeatedly. This file has NO
//     such cap -- it streams with readline and holds only O(unique message ids in this file) in
//     memory (the last-wins dedup buffer, same shape as console/usage-scan.js's scanFile), never
//     O(lines) and never the file, so there is no memory reason to add one, and it only ever runs
//     once per invocation. Measured
//     on the real corpus, 2026-09-10: 0 of 1,685 *.jsonl files exceed 64 MiB (the largest is
//     ~16.4 MB), so today this difference changes nothing -- if a future single transcript ever
//     exceeds the cap, this file would still read it in full while usage-scan.js would skip it,
//     and the two would diverge by exactly that file's tokens. Deliberately left uncapped rather
//     than "fixed" to match, since a one-shot offline tool has no standing reason to silently drop
//     a file the operator asked it to read.
//   - account attribution: usage-scan.js's roots carry a pool account name and folds usage into
//     a `byAccount` breakdown; this file's roots are plain paths with no account concept -- its
//     nearest equivalent is `byRoot` (only emitted when more than one `--roots=` entry is given).
//     An operator who wants per-account numbers from this file passes one root per account.
//   - default root discovery: usage-scan.js is wired to walk the WHOLE pool automatically
//     (console/usage-scan.js's discoverUsageRoots, one root per registered account plus
//     ~/.claude/projects as 'local'). This file defaults to ~/.claude/projects ONLY -- an
//     ad-hoc, single-operator CLI, not the daemon's own live accounting -- and requires an
//     explicit `--roots=` to widen that, same as it always has. Not unified with
//     discoverUsageRoots in this fix: doing so would change this file's default OUTPUT for every
//     existing caller (console/collect.js's `journal/usage-snapshot.json` fallback included)
//     without being asked to, which is exactly the kind of silent-drift risk this fix exists to
//     close, not add.
//
// ---- other behavior changes THIS fix introduces, undeclared above -- every one flagged for
// whether it changes the ARITHMETIC, not filed as cosmetic --------------------------------------
//
//   - ARITHMETIC: --since/--until now filter on the WINNING (last) occurrence's own day, not the
//     first occurrence's. A message.id whose duplicate spans the window's own edge can now be
//     dropped where it used to be kept, or kept where it used to be dropped -- e.g. an id first
//     seen 2026-09-05T23:59Z and rewritten (same id, later timestamp) 2026-09-06T00:00:30Z:
//     `--until=2026-09-05` used to count it (day of the FIRST occurrence, in-window) and now gives
//     0 (day of the LAST/winning occurrence, out of window); `--since=2026-09-06` used to exclude
//     it and now counts it. This is a direct consequence of last-wins itself (there is normally
//     only one occurrence left to test a window against once the others are folded away). Keeping
//     the FIRST occurrence's day instead is possible (buffer its timestamp alongside the winning
//     snapshot) and was deliberately not done: the day a message is attributed to should be the
//     day of the usage actually counted, which under last-wins is the winning occurrence's.
//   - ARITHMETIC: byPhase_Mtokens now attributes a message to the phase in effect at its WINNING
//     (last) occurrence, not its first -- a tool_use marker between two occurrences of the same id
//     (the exact "duplicate line often carries the tool_use block the first line lacks" case this
//     file's marker comment already describes) can move a message from one phase bucket to
//     another versus the old first-wins attribution.
//   - ARITHMETIC (but measured inert today): a symlinked project directory or a symlinked .jsonl
//     file is now silently skipped, never read -- `fs.Dirent.isDirectory()`/`.isFile()` both
//     return false for a symlink, which is exactly what listCandidateFiles/listJsonlFilesRecursive
//     rely on to skip symlinked directories on purpose (see their own comments) but which also,
//     as a side effect, drops a symlinked FILE that the old two-level `fs.readdirSync` walk (no
//     `withFileTypes`, so it always followed symlinks transparently) would have read. Measured on
//     the real corpus, 2026-09-10: `find ~/.claude/projects -type l` and `-type l -name '*.jsonl'`
//     both report 0 -- this changes nothing today, but is a real behavior change, not a cosmetic
//     one, if a symlink is ever introduced.
//   - ARITHMETIC (fixed, not merely documented): subagent transcripts are now FOLDED onto their
//     parent session (one `sessions` entry, one `topSessions` row per real session, matching
//     console/usage-scan.js's own `bySession` folding) instead of each subagent transcript
//     counting as its own extra "session". Before this fold (i.e. with the subagent walk in place
//     but no grouping), a card with N subagent transcripts inflated `sessions.meta.n`/
//     `sessions.card.n` by N phantom sessions and let `topSessions` rank a subagent transcript
//     against real sessions on equal footing; `files` still counts
//     every file read, `sessionsWithUsage`/`sessions.*.n` now count distinct SESSIONS. See
//     doFile's own "fold subagent transcripts onto their parent session" comment for the
//     mechanism. The fold also ORs `isCard` across a session's whole group of files, not just its
//     main transcript -- new behavior this introduces: a session whose main transcript never ran
//     board:take but whose SUBAGENT did is now typed 'card', where the pre-fold, per-file typing
//     would have left the main file's own entry 'meta' regardless of its subagents.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { listCandidateFiles } = require('../console/usage-scan');

const HOME = process.env.HOME || '/root';

function expandHome(p) {
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

function parseArgs(argv) {
  const opts = { filter: null, since: null, until: null, top: 12, roots: null };
  for (const a of argv) {
    if (a.startsWith('--since=')) opts.since = a.slice('--since='.length);
    else if (a.startsWith('--until=')) opts.until = a.slice('--until='.length);
    else if (a.startsWith('--top=')) opts.top = parseInt(a.slice('--top='.length), 10) || 12;
    else if (a.startsWith('--roots=')) {
      opts.roots = a.slice('--roots='.length).split(',').map(s => expandHome(s.trim())).filter(Boolean);
    } else if (!a.startsWith('--') && opts.filter === null) opts.filter = a;
  }
  if (opts.filter === null) opts.filter = 'SPO';
  if (!opts.roots || opts.roots.length === 0) opts.roots = [path.join(HOME, '.claude', 'projects')];
  return opts;
}

// ---- phase markers -------------------------------------------------------
const CLAIM_PAT = ['board:claim', 'board:take', 'bench:nightly', 'board:status'];
const GATE_PAT = ['npm run gate', 'bench:wait', 'verdict']; // checked before CHECKS_PAT: a
// verdict-wrapped alias command (e.g. "npm run verdict -- lint") would otherwise match a
// checks pattern by coincidence of substring
const CHECKS_PAT = ['npm test', 'typecheck', 'lint', 'coverage'];
const PRMERGE_PAT = ['gh pr create', 'gh pr merge', 'pr:wait', 'board:move', 'git push'];

function bashPhase(cmd) {
  if (CLAIM_PAT.some(p => cmd.includes(p))) return 'claim';
  if (GATE_PAT.some(p => cmd.includes(p))) return 'gate';
  if (CHECKS_PAT.some(p => cmd.includes(p))) return 'checks';
  if (PRMERGE_PAT.some(p => cmd.includes(p))) return 'pr-merge';
  return null;
}

function markerPhase(name, input) {
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'implement';
  if (name === 'Task' || name === 'Agent') return 'spawn';
  if (name === 'WebSearch' || name === 'WebFetch') return 'research';
  if (name === 'Bash') {
    const cmd = input && typeof input.command === 'string' ? input.command : '';
    if (cmd) return bashPhase(cmd);
  }
  return null;
}

// collect(argv) -- runs the same discovery + doFile pipeline `run` below prints, but returns the
// RAW (unrounded) accumulators instead of the Mtok-rounded report object. `run`'s own JSON output
// only ever carries values rounded to 2 decimal places at the millions scale (a 10,000-token
// resolution), which is fine for a human reading a report but useless for a test that needs to
// assert an EXACT token count -- e.g. proving last-wins dedup contributes exactly 300, not 1 or
// 351, or that this reader and console/usage-scan.js's scanFile agree "to the token" on a shared
// fixture (this file's own TESTS section explains why that agreement is the card's actual "done
// means"). Exported for exactly that: test/usage-report.test.js is the only caller. `run` itself
// is unchanged in shape -- it calls this, then rounds -- so the CLI's printed JSON is unaffected.
async function collect(argv) {
  const ARGS = parseArgs(argv);
  const FILTER = ARGS.filter;
  const SINCE = ARGS.since; // 'YYYY-MM-DD' or null
  const UNTIL = ARGS.until;
  const TOP = ARGS.top;
  const ROOTS = ARGS.roots; // array of absolute paths

  // ---- accumulators, scoped to this run ------------------------------------
  const byModel = {}; // model -> side -> sums   (unchanged from v0)
  const byPhase = {}; // phase -> {n, cr, cc, out}
  const sessions = { card: { n: 0, cr: 0, cc: 0, out: 0 }, meta: { n: 0, cr: 0, cc: 0, out: 0 } };
  const cacheRebuilds = { events: 0, ccSum: 0 };
  const perFile = [];
  const rootStats = {}; // rootPath -> {files, sessionsWithUsage, msgs, dupes}
  let files = 0,
    msgs = 0,
    dupes = 0,
    minTs = null,
    maxTs = null;

  function acc(model, side, u) {
    const m = (byModel[model] = byModel[model] || {});
    const s = (m[side] = m[side] || { n: 0, inp: 0, cc: 0, cc5m: 0, cc1h: 0, cr: 0, out: 0, think: 0 });
    s.n += 1;
    s.inp += u.input_tokens || 0;
    s.cc += u.cache_creation_input_tokens || 0;
    s.cc5m += (u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0;
    s.cc1h += (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    s.cr += u.cache_read_input_tokens || 0;
    s.out += u.output_tokens || 0;
    s.think += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
  }

  async function doFile(fp, rootPath) {
    const rs = rootStats[rootPath];
    let currentPhase = 'other';
    let isCard = false;
    const f = {
      file: fp.replace(rootPath + '/', ''),
      root: ROOTS.length > 1 ? rootPath : undefined,
      msgs: 0,
      inp: 0,
      cc: 0,
      cr: 0,
      out: 0,
      lastTs: null,
      type: 'meta',
    };
    // sessionId: RE-RESOLVED on every usage-carrying line, exactly like console/usage-scan.js's
    // scanFile (`const sid = o.sessionId || sessionId; if (sid) agg.sessionId = sid;`) -- a line's
    // own `o.sessionId` wins when present, and a line with none falls BACK to this file's basename
    // rather than keeping whatever the previous line resolved to. This must not be sticky: a file
    // whose first usage line happens to carry a DIFFERENT session's id and whose second line
    // carries none would otherwise merge two real sessions into one below. A subagent
    // transcript's lines all carry the PARENT session's id on every line (see console/usage-scan.js's
    // listCandidateFiles comment for why), so in practice this resolves to the parent's id
    // throughout a subagent file and to the file's own id throughout a main transcript -- but it
    // is recomputed per line, not assumed constant. Used below (see "fold subagent transcripts
    // onto their parent session") to group this file's totals with its session's other files, not
    // to affect anything counted inside this function.
    let sid = path.basename(fp, '.jsonl');

    // Buffers one {model, side, u, timestamp, phase} snapshot per message.id, overwritten by
    // every later occurrence -- LAST wins, matching console/usage-scan.js's scanFile (see this
    // file's own header, "semantics" section, for why). An id-less line has nothing to dedup
    // against, so it gets its own unique Map key instead of being applied immediately mid-stream:
    // a Map never reorders an EXISTING key on a later .set(), so every key here -- id-bearing or
    // not -- keeps its true first-encountered position, and iterating pending.values() below
    // after the whole file has streamed replays every counted message in the same order it would
    // have applied in a single first-wins pass, just carrying each id's FINAL usage snapshot
    // instead of its first.
    const pending = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
    for await (const line of rl) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.timestamp) {
        if (!minTs || o.timestamp < minTs) minTs = o.timestamp;
        if (!maxTs || o.timestamp > maxTs) maxTs = o.timestamp;
      }

      // Markers (phase + card-session detection) are read from EVERY line, including
      // message.id duplicates: a duplicate line often carries the tool_use block the first
      // line lacks. This must run before the usage-dedupe buffering below, unconditionally.
      const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
      if (content) {
        for (const c of content) {
          if (c.type !== 'tool_use') continue;
          if (c.name === 'Bash' && c.input && typeof c.input.command === 'string' && c.input.command.includes('board:take')) {
            isCard = true;
          }
          const ph = markerPhase(c.name, c.input);
          if (ph) currentPhase = ph;
        }
      }

      const u = o.message && o.message.usage;
      if (!u) continue;
      sid = o.sessionId || path.basename(fp, '.jsonl');
      const id = (o.message && o.message.id) || o.uuid;
      const model = (o.message && o.message.model) || 'unknown';
      const side = o.isSidechain ? 'sidechain' : 'driver';
      const snapshot = { model, side, u, timestamp: o.timestamp, phase: currentPhase };

      if (id) {
        if (pending.has(id)) {
          dupes++;
          if (rs) rs.dupes++;
        }
        // Overwrite the whole snapshot as one atomic unit -- never pair a later usage object
        // with an earlier model/phase, or vice versa (mirrors scanFile's own "buffered together"
        // rule).
        pending.set(id, snapshot);
      } else {
        // Nothing to dedup an id-less line against -- give it a unique slot so it is still
        // applied exactly once, in its own true stream position (see this function's own header
        // comment).
        pending.set(Symbol('idless'), snapshot);
      }
    }

    let firstCounted = false;
    for (const { model, side, u, timestamp, phase } of pending.values()) {
      const day = (timestamp || '').slice(0, 10);
      const inWindow = (!SINCE || day >= SINCE) && (!UNTIL || day <= UNTIL);
      if (!inWindow) continue;

      msgs++;
      if (rs) rs.msgs++;
      f.lastTs = timestamp;
      acc(model, side, u);

      const cc = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const out = u.output_tokens || 0;

      const ph = (byPhase[phase] = byPhase[phase] || { n: 0, cr: 0, cc: 0, out: 0 });
      ph.n += 1;
      ph.cr += cr;
      ph.cc += cc;
      ph.out += out;

      if (!firstCounted) {
        firstCounted = true; // a file's first counted usage message never counts as a rebuild
      } else {
        const denom = cc + cr;
        if (denom > 0 && cc > 0.3 * denom) {
          cacheRebuilds.events++;
          cacheRebuilds.ccSum += cc;
        }
      }

      f.msgs++;
      f.inp += u.input_tokens || 0;
      f.cc += cc;
      f.cr += cr;
      f.out += out;
    }
    f.type = isCard ? 'card' : 'meta';
    f.sessionId = sid;
    f.rootPath = rootPath; // internal only -- used by the session fold below, never surfaces in output
    // NOTE: this is still a per-FILE result (msgs/sessions/`sessions.card|meta` counts are NOT
    // updated here). Multiple files can belong to the same session (a main transcript plus its
    // subagent transcripts) -- folding raw per-file entries like `f` into one entry per session,
    // and counting/typing/ranking AFTER that fold, is what "fold subagent transcripts onto their
    // parent session" (below, after the discovery loop) does. Counting per file here, the way v1
    // originally did, is exactly the bug that fold fixes: it would make a session's own subagent
    // transcripts each look like a separate session.
    if (f.msgs > 0) perFile.push(f);
    files++;
    if (rs) rs.files++;
  }

  // ---- discovery --------------------------------------------------------
  // Shared with console/usage-scan.js's live scanner (SPO-Pipeline#170) -- see this file's own
  // header, "semantics" section. `account` on each candidate is repurposed here to carry the
  // ORIGINATING root path (usage-report.js has no pool-account concept of its own; a `root` per
  // entry is the closest analogue -- see "what still deliberately differs" above), so doFile's
  // existing (fp, rootPath) signature and rootStats keying need no change.
  for (const rootPath of ROOTS) rootStats[rootPath] = { files: 0, sessionsWithUsage: 0, msgs: 0, dupes: 0 };
  const rootsForDiscovery = ROOTS.map((r) => ({ path: r, account: r }));
  const candidates = listCandidateFiles({ roots: rootsForDiscovery, filter: FILTER });
  for (const { absPath, account } of candidates) {
    await doFile(absPath, account);
  }

  // ---- fold subagent transcripts onto their parent session ----------------------------------
  // Every subagent transcript's lines carry `sessionId` set to the PARENT session's id (each raw
  // `f` above already resolved that into `f.sessionId` -- see doFile's own comment), the same way
  // console/usage-scan.js's scanFile folds them via `agg.sessionId = sid` -- guarded by name in
  // test/dashboard-usage-scan.test.js's "the session-count trap" test. Before this fold (i.e.
  // with the subagent walk in place but no grouping), a card with N subagent transcripts inflated
  // `sessions.meta.n`/`sessions.card.n` by N extra "sessions"
  // that were really the SAME session's own subagent activity, and `topSessions` ranked those
  // subagent transcripts as if they were independent sessions. Only the GROUPING folds here --
  // every token doFile counted is still counted exactly once, from wherever it landed;
  // cacheRebuilds/byPhase/byModel are untouched by this fold, since those are already accumulated
  // across ALL files project-wide, independent of session grouping.
  const bySession = new Map(); // sessionId -> merged entry
  for (const f of perFile) {
    const isMainFile = path.basename(f.file, '.jsonl') === f.sessionId;
    let entry = bySession.get(f.sessionId);
    if (!entry) {
      entry = { file: f.file, root: f.root, rootPath: f.rootPath, isMainFile, isCard: false, msgs: 0, inp: 0, cc: 0, cr: 0, out: 0, lastTs: null };
      bySession.set(f.sessionId, entry);
    } else if (isMainFile && !entry.isMainFile) {
      // A group's DISPLAY name prefers the main transcript's own filename over a subagent's,
      // regardless of which file discovery happened to visit first (discovery order between a
      // project directory's `<sessionId>.jsonl` file entry and its `<sessionId>/` directory entry
      // is not guaranteed).
      entry.file = f.file;
      entry.root = f.root;
      entry.rootPath = f.rootPath;
      entry.isMainFile = true;
    }
    entry.isCard = entry.isCard || f.type === 'card';
    entry.msgs += f.msgs;
    entry.inp += f.inp;
    entry.cc += f.cc;
    entry.cr += f.cr;
    entry.out += f.out;
    if (f.lastTs && (!entry.lastTs || f.lastTs > entry.lastTs)) entry.lastTs = f.lastTs;
  }
  const sessionsList = [];
  for (const entry of bySession.values()) {
    const type = entry.isCard ? 'card' : 'meta';
    const b = sessions[type];
    b.n += 1;
    b.cr += entry.cr;
    b.cc += entry.cc;
    b.out += entry.out;
    if (entry.rootPath && rootStats[entry.rootPath]) rootStats[entry.rootPath].sessionsWithUsage++;
    sessionsList.push({ file: entry.file, root: entry.root, type, msgs: entry.msgs, inp: entry.inp, cc: entry.cc, cr: entry.cr, out: entry.out, lastTs: entry.lastTs });
  }

  return { FILTER, SINCE, UNTIL, TOP, ROOTS, byModel, byPhase, sessions, cacheRebuilds, perFile: sessionsList, rootStats, files, msgs, dupes, minTs, maxTs };
}

// formatReport(raw) -- pure, sync. Turns collect()'s raw accumulators into the exact Mtok-rounded
// JSON shape this CLI has always printed. Split out from `run` purely so `collect` can be called
// on its own by a test that needs the unrounded totals (see collect's own header).
function formatReport(raw) {
  const { FILTER, SINCE, UNTIL, TOP, ROOTS, byModel, byPhase, sessions, cacheRebuilds, perFile, rootStats, files, msgs, dupes, minTs, maxTs } = raw;

  // rank sessions by a rough weight: full-price input + cache writes + 5x output + 0.1x cache reads
  perFile.sort((a, b) => b.inp + b.cc + 5 * b.out + 0.1 * b.cr - (a.inp + a.cc + 5 * a.out + 0.1 * a.cr));
  const top = perFile.slice(0, TOP).map(f => ({
    file: f.file,
    ...(f.root ? { root: f.root } : {}),
    type: f.type,
    msgs: f.msgs,
    Minp: +(f.inp / 1e6).toFixed(2),
    Mcc: +(f.cc / 1e6).toFixed(1),
    Mcr: +(f.cr / 1e6).toFixed(0),
    Mout: +(f.out / 1e6).toFixed(2),
    last: (f.lastTs || '').slice(0, 10),
  }));

  const round = o => {
    const r = {};
    for (const k in o) r[k] = typeof o[k] === 'number' ? (k === 'n' ? o[k] : +(o[k] / 1e6).toFixed(2)) : o[k];
    return r;
  };
  const bm = {};
  for (const m in byModel) {
    bm[m] = {};
    for (const s in byModel[m]) bm[m][s] = round(byModel[m][s]);
  }

  const bp = {};
  for (const p in byPhase) bp[p] = round(byPhase[p]);

  const sessionsOut = { card: round(sessions.card), meta: round(sessions.meta) };

  const out = {
    filter: FILTER,
    since: SINCE,
    until: UNTIL,
    top: TOP,
    roots: ROOTS,
    files,
    sessionsWithUsage: perFile.length,
    msgs,
    dupes,
    range: [minTs && minTs.slice(0, 10), maxTs && maxTs.slice(0, 10)],
    byModel_Mtokens: bm,
    byPhase_Mtokens: bp,
    sessions: sessionsOut,
    cacheRebuilds: { events: cacheRebuilds.events, Mcc_in_rebuilds: +(cacheRebuilds.ccSum / 1e6).toFixed(2) },
    topSessions: top,
  };

  if (ROOTS.length > 1) {
    out.byRoot = {};
    for (const rootPath of ROOTS) {
      const rs = rootStats[rootPath];
      out.byRoot[rootPath] = {
        files: rs.files,
        sessionsWithUsage: rs.sessionsWithUsage,
        msgs: rs.msgs,
        dupes: rs.dupes,
      };
    }
  }

  return out;
}

// run(argv) -- the whole report, as a plain object (never printed directly by this function --
// see the CLI wrapper at the bottom of this file for the one place that happens). Exported so a
// test can drive the exact same code path the CLI uses (same parseArgs, same discovery, same
// doFile) in-process against a fixture --roots, instead of shelling out or re-deriving the logic.
async function run(argv) {
  const raw = await collect(argv);
  return formatReport(raw);
}

module.exports = { run, collect, parseArgs };

// CLI entry point -- unchanged behavior: parse process.argv, print one JSON document to stdout.
// Guarded so `require('../scripts/usage-report')` (every test in this lot) never triggers a real
// run against the real corpus as a require-time side effect -- the old top-level-script version of
// this file had no such guard, which is exactly what made it untestable in-process.
if (require.main === module) {
  run(process.argv.slice(2)).then((out) => {
    console.log(JSON.stringify(out, null, 1));
  });
}
