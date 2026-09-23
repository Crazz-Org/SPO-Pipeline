'use strict';
// orchestrator/live-progress.js -- the durable, cross-process handoff for "what is an LLM step
// doing RIGHT NOW", card #239 chantier action A6.
//
// THE PROBLEM THIS REPLACES. Before this action, console/live-step.js chased the `claude` CLI's
// own session transcript through a five-link identity chain (state.json's owner.workerPid -> the
// account's lease file -> config.cwdForStep -> <configDir>/projects/<slug(cwd)>/ -> the session
// file created after the split's enteredAt) because the transcript was the only thing that moved
// while a call was in flight. That chain is now DEAD CODE, not a fallback: since action A5b
// (2026-09-17) invokeClaudeReal drives the vendored Agent SDK's `query()`, an awaited async
// message stream this SAME process (the worker) already reads, one message at a time, to build
// its own return value (orchestrator/steps/sdk-call.js's consumeQueryStream). There is no reason
// left to go looking for a transcript file on disk when the process running the call can just say
// what it saw.
//
// THE NEW SHAPE. The worker (this file's writer half) is handed sdk-call.js's own `ctx.onMessage`
// seam (see that file's "sixth decision" comment) and, once per LLM call, folds the stream into a
// small JSON record at <taskDir>/live-progress.json -- the SAME per-task directory journal.js
// already owns (journal.jsonl, state.json, ledger.md live there too), never a second root. The
// dashboard (this file's reader half, driven by console/live-step.js) reads that file. Writer and
// reader are two different PROCESSES (a worker; the dashboard server) exactly the way
// journal.js's own live-workers.json is -- this module follows that file's established shape on
// purpose: atomic tmp-then-rename writes (readers can never observe a partial write), a tolerant
// read that treats a missing/unparsable file as "nothing to report" rather than throwing, and a
// small, single-writer-per-task record rather than an ever-growing log.
//
// THE SINGLE-WRITER INVARIANT THIS RIDES ON. journal.js's own header documents that a taskDir has
// exactly one live owner at a time (a worker, or -- for the terminal-state exception -- a
// scanner). This module never has to arbitrate between two workers writing live-progress.json for
// the SAME taskDir concurrently, because that situation cannot arise: if it ever did, it would
// already be a violation of the invariant journal.js's every other write in this directory also
// depends on, not a new hazard this file introduces. The atomic tmp-then-rename write below is
// still the right idiom regardless (it is what makes a torn READ impossible even under the
// ordinary single-writer case: a reader must never see a JSON.parse failure just because it
// sampled the file mid-write), it is just not standing in for a lock this module does not need.
//
// THREE RULES CARRIED FORWARD FROM THE MODULE THIS REPLACES, IN SPIRIT (console/live-step.js's
// old header named these for the transcript chain; they apply just as much to a record this
// process writes about its own call):
//   1. Never guess. A record's own `step` field is set once, by the caller that knows which step
//      it is running -- this module never infers which call a record belongs to from timing or
//      heuristics.
//   2. Never slurp. The record is capped by construction: it holds a running tally (turn count, a
//      tool-name histogram, the last narrated sentence), never the transcript itself. There is
//      nothing here for a naive full read to be tempted to slurp in the first place.
//   3. Never re-implement another module's rule. liveProgressPath sits beside journal.js's own
//      liveWorkersPath/reparkClaimPath, and readLiveProgress's tolerant-read posture matches
//      readLiveWorkerIds's exactly (see journal.js's own comments on both) -- deliberately, so a
//      future reader of either file can trust they behave the same way under the same failures.

const fs = require('fs');
const path = require('path');
const { MAX_LLM_STEP_DEADLINE_MS } = require('./step-contracts');

// How long a message-arrival heartbeat may go unwritten before console/live-step.js treats a
// record as belonging to a call that is no longer actually running.
//
// WHAT THIS CONSTANT'S JOB ACTUALLY IS, RE-ARGUED (Opus verifier fix pass, F1, second pass, this
// action). `probeDeck` (console/live-step.js) only ever probes a card whose `deckState` is
// `'running'`, and `deckState` is derived from PID LIVENESS (collect.js's `collectDeck`, via
// worker-status.js's `describeLiveWorkers`) -- a worker that has actually died reads `'stale'` and
// is never probed at all. So the classic "the worker crashed" case this constant's first two
// drafts were reasoned around is ALREADY caught by a stronger, non-timing signal before this
// constant is ever consulted. Its real remaining job is narrower: a worker that is genuinely still
// ALIVE (a real, running process) whose query() stream has gone silent for reasons that never
// touch the message stream at all -- the measured case below (a subagent tool call) -- or, in the
// pathological case, a stream that is truly hung despite the step's own deadline machinery. Either
// way, the call is bounded by `deadlineMsForStep` (steps/llm.js's `invokeClaudeReal` arms a real
// timer and aborts): once that fires, the call ends and `invokeClaudeReal`'s own `finally` clears
// this record outright, so staleness never has anything left to report past the deadline anyway.
// That makes the deadline the natural, ALREADY-MEASURED ceiling to derive this bound from, rather
// than a round number: `MAX_LLM_STEP_DEADLINE_MS` (step-contracts.js) is 1,800,000ms (PLAN and
// IMPLEMENT's own 30-minute deadline, the largest of the four LLM steps' -- this constant is
// shared across all four, console/live-step.js's own LLM_STEPS, so it has to clear the LONGEST
// one). Set to HALF of it, 900,000ms (15 minutes) -- comfortably inside the range that costs zero
// measured false-stale (see below) while still giving an operator a mid-flight "this looks
// suspect" signal ahead of the deadline -- but ONLY for the two steps whose deadline is the
// 1,800,000ms maximum this is derived from. DIAGNOSE, VALIDATE and CITATION_VERIFIER are
// deadlineMsForStep 900,000ms, i.e. EXACTLY this bound, so their records can never read `stale`
// before their own deadline fires and invokeClaudeReal's `finally` clears the record anyway. That
// is a degenerate-but-harmless case, not a second signal: for those three the pid-liveness gate in
// probeDeck (console/collect.js's deckState) remains the only thing that reports a dead worker,
// which it already does for all five steps. Stated rather than left for a reader to derive from
// the arithmetic.
//
// MEASURED (F1 first pass, then corrected by the SAME verifier's own reconciliation): every
// `.jsonl` transcript under `~/.claude-accounts/*/projects/*/` whose sessionId is named on a
// journalled `llm-call` event (cross-referenced from `~/.spo-state/journal/*/journal.jsonl`),
// consecutive-timestamp gaps computed per file, THEN SPLIT by worktree-path layout (the pool
// project directory's own slug names the cwd it was run from) -- the split the first pass missed,
// and the reason its own "2-minute bound" conclusion was wrong for the right constant but the
// wrong reason:
//   - CURRENT layout (`~/.spo-worktrees/issue-N`, the only one the daemon uses since 769eac5 --
//     see CLAUDE.md's own header note): 397 PLAN/IMPLEMENT transcripts, max gap 278.4s (PLAN,
//     issue-558) -- ZERO exceed even a 300s bound, let alone this one.
//   - HISTORICAL layout (`SPO-Pipeline/worktrees/issue-N`, pre-move, no longer how any live worker
//     runs): 190 PLAN/IMPLEMENT transcripts, max gap 686.3s (IMPLEMENT, issue-671) -- traced to
//     its actual cause, not assumed: an assistant turn's `Agent`/Task tool_use immediately
//     followed, 686.3s later, by that SAME tool call's own tool_result -- the PARENT stream
//     genuinely emits nothing while a nested subagent runs, however long that subagent takes. This
//     mechanism is a property of the TOOL, not of the worktree layout, so a recurrence under the
//     current layout is plausible even though none has been observed yet in the smaller (397-deep)
//     current-layout sample -- which is exactly why the bound below is set generously rather than
//     tuned tightly to the 278.4s figure actually observed today.
//   - DIAGNOSE/VALIDATE (repo-root, no worktree): 286 transcripts, max gap 124.8s.
//
// NOT A FREAK: PLAN spawning a subagent is a KNOWN, RECURRING shape, not a one-off this file
// happened to hit -- step-contracts.js's own PLAN entry (card #214, re-measured) records 11 of a
// fuller corpus's PLAN(fable) sessions carrying an Opus subagent, plus one IMPLEMENT session
// (issue-584, a Sonnet subagent), even though `Task` is not declared in either step's
// `allowedTools` -- MEASURED there to mean `allowedTools` is not the authority on what a call can
// spawn. So a `stale` reading on an otherwise-healthy PLAN or IMPLEMENT card is not necessarily a
// hang: check whether its journalled prompt/tool activity shows a subagent dispatch before
// assuming the worker is stuck. Recorded here so a maintainer hits this explanation in the file
// during a live recette, rather than re-deriving it from a transcript under time pressure.
// Reproduced with a script walking `~/.spo-state/journal` + `~/.claude-accounts`, not committed
// (reads two live, machine-local directories outside this repo).
//
// THE RACE THIS ALSO BOUNDS (secondary, not the primary job any more): a worker crashes mid-
// IMPLEMENT, leaving this file's last write behind with `step: 'IMPLEMENT'`; the card is later
// reparked and retried, entering a NEW IMPLEMENT split (same step name); until that new call's own
// first message overwrites this file entirely, the stale record still matches on `step` alone --
// PID liveness does NOT close this one (the crash already made the card unprobed, but the leftover
// FILE persists on disk until either overwritten or this bound expires it). Reparking takes real
// wall-clock time (orphan-scan.js's own cycle), so in practice this window is already stale by the
// time a retry starts long before 15 minutes are up.
const LIVE_PROGRESS_STALE_MS = MAX_LLM_STEP_DEADLINE_MS / 2;

// How often createProgressCallback actually writes, at most.
//
// CORRECTED (Opus verifier fix pass, F5): an earlier draft of this comment justified the throttle
// by claiming "many [messages] are `stream_event` deltas" -- false. `stream_event` messages are
// the vendored SDK's OPT-IN partial-output streaming, gated on `options.includePartialMessages`
// (grepped directly in the vendored source: the option name appears three times, all inside the
// argv/options plumbing, never defaulted true). `buildQueryOptions` (sdk-call.js) never sets it --
// that function's own options object carries exactly `pathToClaudeCodeExecutable`, `settingSources`,
// `env`, `cwd`, and the opts this pipeline's step contracts populate; `includePartialMessages` is
// not among them. So no call this pipeline ever makes receives a `stream_event` message at all --
// every message `onMessage` sees is a full `assistant`/`user`/`system`/`result` message, never a
// token-level delta.
//
// The real reason to throttle is simpler and still real: a turn that makes several rapid tool
// calls (each producing its own `assistant` tool_use message immediately followed by a `user`
// tool_result message once that tool returns) can still produce a burst of several FULL messages
// within a couple of seconds when each tool call is itself fast (a `Read`, a `Grep`, a short
// `Bash`) -- writing a fresh tmp-then-rename pair for every one of them would be pure waste for a
// value the dashboard polls at most every 1.5s anyway (console/serve.js's own
// DEFAULT_DECK_TTL_MS). 2s matches the old transcript-probe's own polling cadence
// (console/live-step.js's deleted TAIL_BYTES comment: "small enough that probing every 2 seconds
// costs nothing") -- carried forward as a push interval instead of a poll interval now, same
// number, same reasoning: a reader never sees a gap wider than this (plus one message-arrival)
// between what it reads and what is actually true.
const LIVE_PROGRESS_THROTTLE_MS = 2000;

function liveProgressPath(taskDir) {
  return path.join(taskDir, 'live-progress.json');
}

// writeLiveProgress(taskDir, record) -- same atomic tmp-then-rename idiom as journal.js's
// writeState/writeLiveWorkerIds/writeReparkClaim: write to a tmp file in the SAME directory, then
// rename over the target. A reader can therefore only ever see the old complete record or the new
// complete one, never a half-written one -- the property this whole module exists to guarantee,
// since the dashboard reads this file from a different process on its own timer, with no
// coordination with whatever the worker is doing at that instant.
function writeLiveProgress(taskDir, record) {
  const target = liveProgressPath(taskDir);
  const tmp = path.join(taskDir, `.live-progress.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(record));
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

// clearLiveProgress(taskDir) -- idempotent unlink, same posture as journal.js's clearReparkClaim:
// "no record to clear" is the common case (most steps are not LLM steps at all, and every LLM
// call that starts also ends), not an error. Called from invokeClaudeReal's own `finally` (see
// steps/llm.js) so a step that finished -- successfully, by failure, or by deadline -- never
// leaves a record a reader could mistake for still-live work. This is the property card #239's
// Done means names explicitly: "a card that finished must not leave a record that reads as live."
// A crash (kill -9) is the one path this cannot cover, by construction -- that is what
// LIVE_PROGRESS_STALE_MS above is for.
function clearLiveProgress(taskDir) {
  try {
    fs.unlinkSync(liveProgressPath(taskDir));
  } catch {
    // Missing already, or some other race -- either way the caller's intent ("no live record for
    // this task any more") is satisfied by its absence, not by this call succeeding.
  }
}

// readLiveProgress(taskDir) -> the parsed record, or null. Tolerant of a missing file (no call has
// ever run against this taskDir, or the last one already cleared itself) and of an unparsable one
// (impossible mid-rename thanks to the atomic write above, but a reader that does not own this
// file should never throw regardless -- same posture readLiveWorkerIds/readReparkClaim already
// apply to their own files, journal.js).
function readLiveProgress(taskDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(liveProgressPath(taskDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

// createProgressCallback({taskDir, step, account, now}) -> a function suitable for sdk-call.js's
// `ctx.onMessage` -- called once per message, in stream order, by consumeQueryStream (see that
// file's own "sixth decision" comment for the exact contract: wrapped in ITS OWN try/catch, so a
// bug in here can never be misreported as the query() stream itself failing).
//
// WHAT IT ACCUMULATES, AND WHY THERE IS NO TAIL WINDOW ANY MORE. The deleted transcript probe
// (console/live-step.js) read at most TAIL_BYTES from the END of a file it did not write, because
// re-reading the WHOLE transcript on every 2-second poll would have meant repeatedly slurping a
// file that measures 174 KB at the median and 1.6 MB at the max (that module's own deleted
// header). This function has no such problem: it is handed each message exactly once, as the
// stream produces it, and only ever needs to keep a small running summary in memory (a turn
// count, a tool-name histogram, the last narrated sentence) -- there is no file to re-read, tail
// or otherwise, because nothing is written to disk except this summary itself.
//
// WHAT IT DOES NOT WRITE. A `result` message (the stream's terminal message) is never written as
// a progress record -- see this function's own body for why: writing it would risk a reader
// catching a "live" snapshot of a call that has, by the time the write lands, already returned.
// invokeClaudeReal's own `finally` clears the record outright once the call settles (success or
// failure), which is the stronger property this function's own restraint here only reinforces.
function createProgressCallback({ taskDir, step, account, now = Date.now } = {}) {
  let turns = 0;
  const toolCounts = {};
  let lastText = null;
  let lastTurnAt = null;
  let lastWriteMs = null; // null = "never written yet" -- distinct from 0, a legitimate epoch ms

  return function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'result') return; // the terminal message -- see this function's own header

    let isFirstAssistantTurn = false;
    if (message.type === 'assistant') {
      turns += 1;
      isFirstAssistantTurn = turns === 1;
      const ts = Date.parse(message.timestamp);
      if (Number.isFinite(ts)) lastTurnAt = new Date(ts).toISOString();
      const content = message.message && Array.isArray(message.message.content) ? message.message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lastText = block.text.trim();
        }
      }
    }

    // Every non-result message is a heartbeat opportunity, not only assistant turns -- a `user`
    // (tool_result) or `system` message arriving mid-tool-call is still evidence the call is
    // alive, even though it carries no narration of its own. Throttled, with TWO exceptions that
    // bypass the window and write immediately:
    //   - the very first message of a call (`lastWriteMs === null`) -- a cold deck should not sit
    //     blank for LIVE_PROGRESS_THROTTLE_MS while a fast call already has something to say.
    //   - the first ASSISTANT turn specifically, even when it is not the call's first message.
    //     CORRECTED (Opus verifier fix pass, F6): an earlier draft of this comment claimed this
    //     was "MEASURED... against a real query() stream" -- overstated. What was actually run is
    //     test/llm-real-live-progress.test.js, which drives the REAL vendored SDK's `query()`
    //     (not a mock of the SDK) but over a HAND-WRITTEN fixture stream (test/helpers.js's
    //     `fakeSpawnDeps`) whose message order this file's own tests choose -- it proves the
    //     BYPASS MECHANISM behaves correctly given that ordering (the second write is not
    //     silently suppressed), not that the ordering itself is what a live model produces; this
    //     action has no network access and cannot spawn a real `claude` process to observe that
    //     independently -- not proven here, only argued: sdk-call.js's own consumeQueryStream
    //     header treats a `system`/init message's `session_id` as "the first evidence a session
    //     exists at all" (its own words, same uncertainty this comment now carries rather than
    //     hides), and its `apiKeySource`/tool-list handshake is a once-per-session announcement
    //     that has no reason to follow, rather than precede, the model's own first turn. That is a
    //     reasoned expectation, not a source-verified guarantee -- this action found no explicit
    //     ordering promise in the vendored SDK's own (minified, undocumented) source to cite. THIS
    //     EXCEPTION DOES NOT DEPEND ON THE ORDERING HOLDING, by construction: whichever message
    //     type happens to arrive first still claims the cold-start write (`lastWriteMs === null`)
    //     above, and `isFirstAssistantTurn` fires on the first ASSISTANT message regardless of
    //     what, if anything, preceded it -- so even if a future CLI build reordered or dropped the
    //     init message, the bypass this exception exists for still fires exactly where it needs
    //     to. The scenario this paragraph explains is only the common one worth naming: an init
    //     message arrives, claims the cold-start write with nothing to narrate, and the real first
    //     assistant turn -- which usually follows within the same throttle window -- would then
    //     sit suppressed until 2s pass or the call ends, meaning a short call could show no
    //     narration at all despite one having arrived. This exception fires exactly once per call
    //     (`isFirstAssistantTurn` is only ever true the turn `turns` becomes 1), so it cannot be
    //     used to defeat the throttle repeatedly.
    const nowMs = now();
    if (lastWriteMs === null || isFirstAssistantTurn || nowMs - lastWriteMs >= LIVE_PROGRESS_THROTTLE_MS) {
      writeLiveProgress(taskDir, {
        step,
        account: account || null,
        turns,
        toolCounts,
        lastText,
        lastTurnAt,
        updatedAt: new Date(nowMs).toISOString(),
      });
      lastWriteMs = nowMs;
    }
  };
}

module.exports = {
  LIVE_PROGRESS_STALE_MS,
  LIVE_PROGRESS_THROTTLE_MS,
  liveProgressPath,
  writeLiveProgress,
  clearLiveProgress,
  readLiveProgress,
  createProgressCallback,
};
