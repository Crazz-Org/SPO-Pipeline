'use strict';
// console/par-times.js -- the flight deck's "par times": how long each pipeline state usually
// takes, measured over every journal on disk, so the deck can say "4:06, past par" instead of
// "4:06" (which means nothing to a reader who has not watched a hundred runs).
//
// SAME SHAPE AS console/usage-rollups.js, and for the same reason: computing this walks every
// journal/<id>/journal.jsonl (4 MB / ~5,300 lines today, and issue-385 alone is 701 KB), which is
// far too much work to do on a dashboard request. So the expensive pass lives here, the live
// server drives it on a slow timer (console/serve.js, beside the usage scan), the result is
// persisted to <journalRoot>/par-times.json, and console/collect.js only ever READS that file --
// exactly the split collectTrend() already uses for the tokens trend.
//
// WHY p50 AND p90 rather than a mean: the distributions are long-tailed and the tail is the
// interesting part. IMPLEMENT measures p50 3m24s against a max of 19m57s; a mean would sit
// somewhere in between and describe no actual run. The deck uses p50 as "par" and p90 as "this
// is now unusual", which are the two judgements a reader actually wants.
//
// WHAT A "PAR" IS MEASURED OVER: one leg = one continuous occupancy of a state, from the event
// that entered it to the transition that left it. A state entered three times in one run
// contributes three legs, not one -- that is deliberate: the deck compares THIS visit against
// what a visit usually costs, and averaging a card's three IMPLEMENT visits into one number would
// compare a visit against a whole run.
//
// INTAKE IS DELIBERATELY EXCLUDED from byState. Its "duration" is dominated by how long the task
// file sat in the queue before a worker took it (p90 measured 15,878s against a p50 of 0s) -- it
// measures the daemon's idleness, not any work, and a par built from it would be meaningless.
// The whole-run figures below are measured from `taken`, so queue wait is excluded there too.

const fs = require('fs');
const path = require('path');

// A par computed from fewer legs than this is not reported at all -- the deck renders "no par
// yet" rather than a percentile over three samples. Every state in the corpus clears this today
// (the smallest, DIAGNOSE and FINISH, sit at 26); it exists so a fresh install, or a state added
// later, degrades to silence instead of to a confident wrong number.
const MIN_SAMPLES = 8;

// Recompute when the corpus has grown by this many task directories since the cached pass, even
// if the cache is otherwise young. Pars move slowly -- one more card cannot shift a p50 built
// from 74 legs -- so this is about eventually noticing a much larger corpus, not about freshness.
const TASK_COUNT_DRIFT = 5;

// ...and recompute at least this often regardless, so a corpus that keeps the same task count
// while its journals grow (a card looping inside an existing directory) still lands.
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

// The canonical forward order (state-machine.js's lifecycle table). Used by the run builder in
// collect.js to decide whether a transition moved forward or sent the card back, and exported
// from here so the two cannot drift. DIAGNOSE is deliberately absent: it is not a position on
// the track, it is the off-track state a card is sent to when something failed, which is why
// `orderIndex` returns null for it rather than a number to compare.
const TRACK_ORDER = [
  'INTAKE',
  'WORKTREE',
  'PLAN',
  'IMPLEMENT',
  'CHECK',
  'PUSH_PR',
  'GATE',
  'CI_CHECKS',
  'VALIDATE',
  'MERGE',
  'FINISH',
  'DONE',
];

function orderIndex(state) {
  const i = TRACK_ORDER.indexOf(state);
  return i === -1 ? null : i;
}

// A missing or unparsable file is "no pars recorded yet", never an error -- same posture as
// loadRollups and every other reader in console/.
function loadParTimes(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.byState) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveParTimes(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

// shouldRecompute(cached, taskCount, now) -- true when there is no usable cache, when the corpus
// has grown past TASK_COUNT_DRIFT directories, or when the cache is older than MAX_AGE_MS.
function shouldRecompute(cached, taskCount, now = Date.now()) {
  if (!cached || !cached.byState) return true;
  if (typeof cached.taskCount === 'number' && Math.abs(taskCount - cached.taskCount) >= TASK_COUNT_DRIFT) return true;
  const at = Date.parse(cached.computedAt || '');
  if (!Number.isFinite(at)) return true;
  return now - at >= MAX_AGE_MS;
}

// Percentile by nearest-rank on a sorted array. Returns null for an empty array rather than 0 --
// "no samples" and "zero seconds" are different claims, and PUSH_PR genuinely measures 4s, so a
// 0 here would be indistinguishable from a real fast state.
function percentile(sortedMs, p) {
  if (!sortedMs.length) return null;
  const i = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil(p * sortedMs.length) - 1));
  return sortedMs[i];
}

function readJournalLines(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line is skipped, never fatal */
    }
  }
  return out;
}

function listTaskDirs(journalRoot) {
  try {
    return fs
      .readdirSync(journalRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// computeParTimes(journalRoot) -> {computedAt, taskCount, legCount, byState, wholeRun}
//
//   byState[STATE] = {n, p50Ms, p90Ms, maxMs}     -- one entry per state with >= MIN_SAMPLES legs
//   wholeRun.done  = {n, p50Ms, p90Ms}            -- `taken` .. `done`
//   wholeRun.parked= {n, p50Ms, p90Ms}            -- `taken` .. `parked`
//
// Walks every journal once. Legs are cut at `transition` events; the leg still open when a run
// ends (at `done`/`parked`, or at the end of the file for a card running right now) is NOT
// counted -- an unfinished leg has no duration to contribute, and counting the in-flight one
// would let the card currently being measured pull down its own par.
function computeParTimes(journalRoot, { now = Date.now() } = {}) {
  const ids = listTaskDirs(journalRoot);
  const byStateMs = new Map();
  const doneMs = [];
  const parkedMs = [];
  let legCount = 0;

  for (const id of ids) {
    const lines = readJournalLines(path.join(journalRoot, id));
    if (!lines.length) continue;

    let legState = null;
    let legStartedAt = null;
    let runStartedAt = null;

    for (const e of lines) {
      const ts = Date.parse(e.ts || '');
      if (!Number.isFinite(ts)) continue;

      if (e.event === 'taken') {
        runStartedAt = ts;
        legState = e.state || 'INTAKE';
        legStartedAt = ts;
        continue;
      }

      if (e.event === 'transition') {
        if (legState && legStartedAt !== null && ts >= legStartedAt) {
          // INTAKE is excluded: see this file's header -- its duration is queue wait.
          if (legState !== 'INTAKE') {
            if (!byStateMs.has(legState)) byStateMs.set(legState, []);
            byStateMs.get(legState).push(ts - legStartedAt);
            legCount += 1;
          }
        }
        legState = e.to || null;
        legStartedAt = ts;
        continue;
      }

      if (e.event === 'done' || e.event === 'parked') {
        if (runStartedAt !== null && ts >= runStartedAt) {
          (e.event === 'done' ? doneMs : parkedMs).push(ts - runStartedAt);
        }
        // The leg open at the moment a run ends contributes nothing: see the header.
        legState = null;
        legStartedAt = null;
        runStartedAt = null;
      }
    }
  }

  const byState = {};
  for (const [state, arr] of byStateMs) {
    if (arr.length < MIN_SAMPLES) continue;
    arr.sort((a, b) => a - b);
    byState[state] = {
      n: arr.length,
      p50Ms: percentile(arr, 0.5),
      p90Ms: percentile(arr, 0.9),
      maxMs: arr[arr.length - 1],
    };
  }

  const summarize = (arr) => {
    if (arr.length < MIN_SAMPLES) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return { n: s.length, p50Ms: percentile(s, 0.5), p90Ms: percentile(s, 0.9) };
  };

  return {
    computedAt: new Date(now).toISOString(),
    taskCount: ids.length,
    legCount,
    byState,
    wholeRun: { done: summarize(doneMs), parked: summarize(parkedMs) },
  };
}

// refreshParTimes(journalRoot, filePath) -- the one call console/serve.js makes on its timer.
// Loads the cache, recomputes only when shouldRecompute() says so, persists the new pass, and
// returns whatever is current either way. Never throws: a failed write still returns the
// freshly-computed data, which is more useful than nothing.
function refreshParTimes(journalRoot, filePath, { now = Date.now(), force = false } = {}) {
  if (!journalRoot || !filePath) return null;
  const cached = loadParTimes(filePath);
  const taskCount = listTaskDirs(journalRoot).length;
  if (!force && !shouldRecompute(cached, taskCount, now)) return cached;
  const fresh = computeParTimes(journalRoot, { now });
  saveParTimes(filePath, fresh);
  return fresh;
}

module.exports = {
  MIN_SAMPLES,
  TASK_COUNT_DRIFT,
  MAX_AGE_MS,
  TRACK_ORDER,
  orderIndex,
  loadParTimes,
  saveParTimes,
  shouldRecompute,
  percentile,
  computeParTimes,
  refreshParTimes,
};
