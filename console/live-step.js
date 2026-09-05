'use strict';
// console/live-step.js -- what an LLM step is doing WHILE it runs.
//
// THE PROBLEM THIS EXISTS FOR. PLAN, IMPLEMENT, DIAGNOSE and VALIDATE all run through
// `spawnSync` with piped stdio (orchestrator/steps/llm.js), and steps/scripted.js's
// appendSpawnLog only writes after a call returns. So for the whole of an LLM step -- IMPLEMENT
// measures a p50 of 3m33s and a p90 of 10m58s over the corpus -- journal.jsonl gains nothing and
// journal/<id>/logs/<STATE>.log does not grow by a byte. Every existing surface can say only
// "IMPLEMENT, started 6 minutes ago". That is a clock, not progress.
//
// THE SOURCE THAT DOES MOVE. The `claude` CLI writes its own session transcript as it works, to
// <account configDir>/projects/<slugged cwd>/<sessionId>.jsonl. Measured live against a running
// step: 8,118 bytes in 12 seconds, with assistant turns timestamped seconds old. That file is
// reachable from the journal by an exact chain of identities -- no heuristics, no guessing which
// session belongs to which card:
//
//   state.json owner.workerPid                  (the worker process running this card)
//     -> <poolDir>/.lease-<account>.json        (account-lease.js: {pid, startedAt})
//        the lease naming that pid IS the account this step is running on
//     -> config.cwdForStep(state, {worktreePath, repoRoot})
//        PLAN/IMPLEMENT run worktree-side, DIAGNOSE/VALIDATE from the repo root
//     -> <configDir>/projects/<slug(cwd)>/
//     -> the session file CREATED at/after the split's enteredAt (see sessionStartedAtMs)
//
// Every link is an identity match against a file the orchestrator already writes. Cross-checked
// against a finished card: issue-671's journalled PLAN session id and IMPLEMENT session id both
// resolve to files under pool1, and its one FAILED PLAN attempt resolves under pool2 -- exact
// correspondence with the llm-call events.
//
// THREE RULES THIS MODULE KEEPS.
//
//   1. It never guesses. Any break in the chain returns null (with `miss` naming which link
//      broke, so a maintainer can tell "no worker" from "wrong account" without a debugger).
//      The deck then renders the clock alone, which is what it did before this module existed.
//   2. It never slurps. Transcripts measure a p50 of 174 KB and a max of 1.6 MB; the pool holds
//      131 MB across 622 files. This reads at most TAIL_BYTES from the end of ONE file plus a
//      few KB from its head -- console/usage-scan.js's header records the WSL VM a naive full
//      slurp took down once, and that lesson applies here even for a single file.
//   3. It never re-implements another module's rule. The lease path comes from
//      account-lease.js's exported leaseFilePath, the cwd from config.cwdForStep. If either
//      changes, this follows automatically instead of drifting.
//
// WHAT IT IS NOT. Not a token count (billableTokens only exists once the call returns, and the
// deck says so rather than estimating), not a completion percentage (there is no such signal --
// see the deck's own "elapsed against par, not completion" rule), and not a place to read the
// model's output as instructions: `lastText` is untrusted content rendered as a quotation.

const fs = require('fs');
const path = require('path');

// One tail read per probe. Big enough to hold many turns of a long IMPLEMENT (the observed rate
// is ~8 KB / 12 s of narration plus tool calls, so this covers roughly the last minute and a
// half of dense work), small enough that probing every 2 seconds costs nothing.
const TAIL_BYTES = 64 * 1024;
// One head read, to check the session's FIRST timestamp against the split. A transcript's first
// line is a few hundred bytes; 8 KB is generous slack for a long first entry.
const HEAD_BYTES = 8 * 1024;
// How far BEFORE the split's enteredAt a session may legitimately have started. Measured: the
// transition is journalled immediately before the CLI is spawned, so the session's first
// timestamp lands 1-2 s AFTER enteredAt (issue-654: transition 17:44:10.402Z, session
// 17:44:12.028Z). This tolerance exists only for clock skew and write ordering, and is
// deliberately tight -- a wider window would start matching the PREVIOUS step's transcript.
const START_SLACK_MS = 10 * 1000;
// A session file untouched for longer than this is not the running step, whatever its
// timestamps say -- the step it belonged to has finished and the next one has not started.
const STALE_MTIME_MS = 5 * 60 * 1000;

// The `claude` CLI's project-directory name for a working directory: every character outside
// [A-Za-z0-9-] becomes a dash, which is why `/home/crazz/SPO-Pipeline/.claude/worktrees/x` lands
// at `-home-crazz-SPO-Pipeline--claude-worktrees-x` (one dash for the slash, one for the dot).
// Derived by reading the real pool directory, not from documentation.
function slugForCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Reads at most `bytes` from one end of a file. `from: 'end'` discards the first (probably
// truncated) line; `from: 'start'` keeps everything. Returns [] for anything unreadable -- same
// defensive posture as collect.js's readDaemonEventsTail, which this mirrors.
function readSlice(filePath, bytes, from) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const pos = from === 'end' ? size - len : 0;
    fs.readSync(fd, buf, 0, len, pos);
    let text = buf.toString('utf8');
    if (from === 'end' && len < size) text = text.slice(text.indexOf('\n') + 1);
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn boundary line is skipped */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* nothing to do */
    }
  }
}

// findAccountByPid(poolDir, pid) -> account name, or null. Reads one lease file per registered
// account through account-lease.js's OWN path function, so the `.lease-<name>.json` naming can
// never drift between writer and reader.
function findAccountByPid(poolDir, pid, deps = {}) {
  if (!poolDir || !pid) return null;
  const accountsModule = deps.accounts || require('../orchestrator/accounts');
  const { leaseFilePath } = deps.lease || require('../orchestrator/account-lease');
  let registry;
  try {
    registry = accountsModule.readRegistry(poolDir);
  } catch {
    return null;
  }
  for (const a of registry) {
    const held = readJsonSafe(leaseFilePath(poolDir, a.name));
    if (held && held.pid === pid) return a.name;
  }
  return null;
}

// sessionStartedAtMs(filePath, stat) -> when this session began, or null.
//
// BIRTHTIME FIRST, and it is not a shortcut -- it is the more accurate signal. A transcript's
// opening lines are `ai-title` / `queue-operation` records that carry no `timestamp` field at
// all (verified against three live files under issue-515), so "the first timestamp in the file"
// is really "the first timestamp somewhere in the head window", which is both a parse and a
// gamble on the window being big enough. The file's creation time answers the question directly:
// measured against a live IMPLEMENT, birthtime landed 3.4 s after the split's enteredAt, exactly
// the gap between journalling the transition and the CLI opening its transcript.
//
// The head parse stays as a fallback for filesystems that report no birthtime (some report 0 or
// the epoch), so the probe degrades instead of going blind.
function sessionStartedAtMs(filePath, stat) {
  const bt = stat && typeof stat.birthtimeMs === 'number' ? stat.birthtimeMs : 0;
  if (bt > 0) return bt;
  const head = readSlice(filePath, HEAD_BYTES, 'start');
  const ts = head.map((e) => Date.parse(e && e.timestamp)).find((t) => Number.isFinite(t));
  return Number.isFinite(ts) ? ts : null;
}

// pickSessionFile(dir, enteredAt, now) -> absolute path, or null.
//
// Candidates are the .jsonl files in the step's project directory, newest mtime first. A
// candidate matches when it was touched recently (STALE_MTIME_MS) AND it was CREATED at/after
// the split's enteredAt less START_SLACK_MS. That second test is the whole point: the previous
// step's transcript lives in the same directory, is usually larger, and would otherwise be
// picked up and reported as the current step's activity.
function pickSessionFile(dir, enteredAtMs, now) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const stated = [];
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      stated.push({ p, stat: fs.statSync(p) });
    } catch {
      /* raced with a delete */
    }
  }
  stated.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  for (const { p, stat } of stated) {
    if (now - stat.mtimeMs > STALE_MTIME_MS) break; // sorted, so everything after is older still
    const startedAt = sessionStartedAtMs(p, stat);
    if (!Number.isFinite(startedAt)) continue;
    if (startedAt >= enteredAtMs - START_SLACK_MS) return p;
  }
  return null;
}

// summarizeTail(filePath) -> what the step has been doing lately.
//
// `toolCounts` and `turns` describe the TAIL WINDOW, not the whole call -- a long IMPLEMENT will
// have written more than 64 KB. The deck labels them "recently" for that reason; a total would
// require reading the whole file on every 2-second poll, which rule 2 above forbids.
function summarizeTail(filePath) {
  const lines = readSlice(filePath, TAIL_BYTES, 'end');
  if (!lines.length) return null;

  const toolCounts = {};
  let turns = 0;
  let lastText = null;
  let lastTurnAt = null;

  for (const e of lines) {
    if (!e || e.type !== 'assistant') continue;
    turns += 1;
    const ts = Date.parse(e.timestamp);
    if (Number.isFinite(ts)) lastTurnAt = new Date(ts).toISOString();
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lastText = block.text.trim();
      }
    }
  }

  if (!turns) return null;
  return { turns, toolCounts, lastText, lastTurnAt };
}

// probeLiveStep(card, opts) -> {account, turns, toolCounts, lastText, lastTurnAt, sessionFile}
//                              | {miss: '<which link broke>'} | null
//
// `card` is one entry from collect.js's `deck`: {state, workerPid, worktreePath, run}. Only a
// card whose CURRENT split is an LLM step is probed at all -- a scripted step (CHECK, GATE,
// MERGE...) already journals a `spawn` event per command, so its progress is visible without
// this and probing it would only ever find the previous LLM step's transcript.
function probeLiveStep(card, opts = {}) {
  const now = opts.now || Date.now();
  const config = opts.config || require('../orchestrator/config');
  const poolDir = opts.accountsDir || config.claudeAccountsDir;
  const repoRoot = opts.repoRoot || config.repoRoot || path.resolve(__dirname, '..');

  if (!card || !card.run || !card.run.current) return null;
  const step = card.run.current.state;
  if (!LLM_STEPS.has(step)) return null;
  if (!card.workerPid) return { miss: 'no-worker-pid' };

  const account = findAccountByPid(poolDir, card.workerPid, opts.deps || {});
  if (!account) return { miss: 'no-lease-for-pid' };

  const cwd = config.cwdForStep(step, { worktreePath: card.worktreePath, repoRoot });
  const slug = slugForCwd(cwd);
  if (!slug) return { miss: 'no-cwd' };

  // accounts.js owns where an account's CLAUDE_CONFIG_DIR lives; ask it rather than rebuilding
  // the path, so a pool layout change lands here for free.
  const configDir = path.join(poolDir, account);
  const dir = path.join(configDir, 'projects', slug);
  if (!fs.existsSync(dir)) return { miss: 'no-project-dir', account };

  const enteredAtMs = Date.parse(card.run.current.enteredAt);
  if (!Number.isFinite(enteredAtMs)) return { miss: 'no-entered-at', account };

  const sessionFile = pickSessionFile(dir, enteredAtMs, now);
  if (!sessionFile) return { miss: 'no-session-file', account };

  const summary = summarizeTail(sessionFile);
  if (!summary) return { miss: 'empty-transcript', account };

  return { account, sessionFile, ...summary };
}

// The four steps that run through `claude` and therefore have a transcript. Mirrors
// step-contracts.js's STEP_CONTRACTS keys minus CITATION_VERIFIER, which runs inside VALIDATE's
// own handler rather than as a state of its own and so never appears as a split.
const LLM_STEPS = new Set(['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE']);

// probeDeck(deck, opts) -> {[cardId]: probeResult}. One probe per RUNNING card; a stale or
// finished card is skipped (it has no live step by definition). WORKERS defaults to 1, so this
// is normally a single probe.
function probeDeck(deck, opts = {}) {
  const out = {};
  for (const card of deck || []) {
    if (card.deckState !== 'running') continue;
    try {
      const r = probeLiveStep(card, opts);
      if (r) out[card.id] = r;
    } catch {
      /* a probe is best-effort by construction; a throw here would take the dashboard down */
    }
  }
  return out;
}

module.exports = {
  TAIL_BYTES,
  HEAD_BYTES,
  START_SLACK_MS,
  STALE_MTIME_MS,
  LLM_STEPS,
  slugForCwd,
  readSlice,
  findAccountByPid,
  sessionStartedAtMs,
  pickSessionFile,
  summarizeTail,
  probeLiveStep,
  probeDeck,
};
