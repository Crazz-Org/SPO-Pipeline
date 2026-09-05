'use strict';
// console/render-deck.js -- the flight deck: the one card that is running right now, drawn as a
// run along a twelve-checkpoint track.
//
// WHY THIS REPLACED THE TILE GRID. The old dashboard root answered "is the machine healthy" and
// could not answer "what is the machine doing" -- console/render.js's own header used to say
// per-task detail was deliberately omitted because it "duplicates the GitHub Projects board".
// That was true of a card's COLUMN and false of everything else: the board cannot say which of
// eleven states a card sits in, how many times it has been sent back, which model is spending
// tokens on it right now, or how this visit compares with every previous one. Health moved to
// /health; this is the root.
//
// EVERY GAME ELEMENT IS A REAL MECHANIC, not decoration:
//
//   lives      -- config.js's diagnoseBudget / validateRejectBudget / ciRetryBudget /
//                 mainMovedRegateBudget. Spending them all IS how a card parks.
//   par times  -- console/par-times.js's p50 per state, measured over every journal on disk.
//   sent back  -- collect.js's buildRun marks a split sentBack when the transition out of it
//                 moved to an earlier position on the track, or to DIAGNOSE.
//   judges     -- GATE and VALIDATE, the two steps that can send a passing card backwards.
//                 Taken from console/plain-language.js's table, which takes it from board.js.
//   attempts   -- a split's `attempt`: this state's Nth visit in this run.
//
// PURITY, unchanged from render.js: nothing here reads a clock or the filesystem. "How long has
// this been running" is measured against `data.generatedAt`, which collect.js stamps at the
// moment it read the journal -- so the same input always produces the same output, and the
// function stays unit-testable without touching disk.
//
// UNTRUSTED CONTENT. `lastText` is the model's own narration and `rootCause` is its diagnosis;
// both are escaped and rendered as quotations. They are never treated as instructions.

const { TRACK_ORDER, orderIndex } = require('./par-times');
const { stateInfo, reasonText } = require('./plain-language');
const { formatTokenCount } = require('../orchestrator/tokens');

// Budgets, mirrored from orchestrator/config.js for display only. NOT a second source of truth:
// resolveBudgets() below prefers the live config when it can be loaded, and falls back to these
// so a test constructing data by hand still renders a sensible number of pips.
const FALLBACK_BUDGETS = { diagnose: 3, validate: 3, ci: 3, mainMoved: 1 };

function resolveBudgets() {
  try {
    const c = require('../orchestrator/config');
    return {
      diagnose: c.diagnoseBudget ?? FALLBACK_BUDGETS.diagnose,
      validate: c.validateRejectBudget ?? FALLBACK_BUDGETS.validate,
      ci: c.ciRetryBudget ?? FALLBACK_BUDGETS.ci,
      mainMoved: c.mainMovedRegateBudget ?? FALLBACK_BUDGETS.mainMoved,
    };
  } catch {
    return { ...FALLBACK_BUDGETS };
  }
}

function esc(v) {
  return require('./render').escapeHtml(v);
}

// ---- time --------------------------------------------------------------------------------

// m:ss under an hour, h:mm:ss beyond. Deliberately not fmtAgeMs's "3min" rounding: a run tracker
// that rounds away the seconds cannot show a split moving.
function clock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function signedClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  if (Math.abs(ms) < 1000) return '±0:00';
  return (ms > 0 ? '+' : '−') + clock(Math.abs(ms));
}

// A split's standing against its par. Three bands, and the names are the ones the deck prints:
// under par, over par (past p50, still inside p90), and well over (past p90 -- unusual, and the
// point at which a reader should start wondering).
function pace(ms, par) {
  if (!par || typeof par.p50Ms !== 'number') return { band: 'unknown', deltaMs: null };
  const deltaMs = ms - par.p50Ms;
  if (typeof par.p90Ms === 'number' && ms > par.p90Ms) return { band: 'well-over', deltaMs };
  return { band: deltaMs > 0 ? 'over' : 'under', deltaMs };
}

const PACE_CLASS = { under: 'pace-under', over: 'pace-over', 'well-over': 'pace-bad', unknown: 'pace-none' };

// ---- icons -------------------------------------------------------------------------------
//
// Stroke-based, 24px grid, one consistent style, `currentColor` throughout so a tile's state
// colours its icon without a second definition. Emitted once at the top of the fragment: the
// live client replaces the fragment wholesale, so the sprite travels with the content it serves
// and can never be left behind by a swap.
const ICON_SPRITE = `<svg width="0" height="0" style="position:absolute;overflow:hidden" aria-hidden="true"><defs>
<g id="deck-icons">
<symbol id="ic-claim" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11.5l-2.6 4.2L16.5 13H5"/></g></symbol>
<symbol id="ic-setup" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8l8.6 4.6v9.2L12 21.2 3.4 16.6V7.4z"/><path d="M3.4 7.4L12 12l8.6-4.6M12 12v9.2"/></g></symbol>
<symbol id="ic-plan" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3.6L3 5.8v14.6l6-2.2 6 2.2 6-2.2V3.6l-6 2.2z"/><path d="M9 3.6v14.6M15 5.8v14.6"/></g></symbol>
<symbol id="ic-code" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 6.5L3.2 12l5.3 5.5M15.5 6.5L20.8 12l-5.3 5.5M13.4 3.6l-2.8 16.8"/></g></symbol>
<symbol id="ic-test" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 2.8h5.6M10.2 2.8v6.4L4.9 18.4a2 2 0 001.7 3h10.8a2 2 0 001.7-3L13.8 9.2V2.8"/><path d="M7.4 15.4h9.2"/></g></symbol>
<symbol id="ic-pr" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.2" cy="5.6" r="2.6"/><circle cx="6.2" cy="18.4" r="2.6"/><circle cx="17.8" cy="18.4" r="2.6"/><path d="M6.2 8.2v7.6"/><path d="M17.8 15.8V10a3.4 3.4 0 00-3.4-3.4h-3.6"/><path d="M13.4 4.2l-2.6 2.4 2.6 2.4"/></g></symbol>
<symbol id="ic-gate" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6l8.2 3v6.2c0 5-3.6 8.7-8.2 9.6-4.6-.9-8.2-4.6-8.2-9.6V5.6z"/><path d="M8.6 11.8l2.4 2.4 4.4-4.6"/></g></symbol>
<symbol id="ic-ci" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6.8 19.2h10.4a3.6 3.6 0 100-7.2 5.7 5.7 0 00-11-1.7 3.2 3.2 0 00.6 8.9z"/><path d="M9.4 14.6l2 2 3.4-3.6"/></g></symbol>
<symbol id="ic-review" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 12S5.9 5.4 12 5.4 21.8 12 21.8 12 18.1 18.6 12 18.6 2.2 12 2.2 12z"/><circle cx="12" cy="12" r="2.9"/></g></symbol>
<symbol id="ic-merge" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.4" cy="5.2" r="2.5"/><circle cx="6.4" cy="18.8" r="2.5"/><circle cx="17.6" cy="12" r="2.5"/><path d="M6.4 7.7v8.6"/><path d="M6.4 12h8.7"/><path d="M12.4 8.6L15.6 12l-3.2 3.4"/></g></symbol>
<symbol id="ic-clean" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 3.2l-7.6 7.6"/><path d="M13.6 9l1.6 1.6-6.6 6.6-4.2 2.6 2.6-4.2 6.6-6.6z"/><path d="M6.6 15.2l2.4 2.4"/></g></symbol>
<symbol id="ic-ship" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.8 3.4h8.4v5.2a4.2 4.2 0 01-8.4 0z"/><path d="M7.8 4.8H4.6v1.9a3.2 3.2 0 003.2 3.2M16.2 4.8h3.2v1.9a3.2 3.2 0 01-3.2 3.2"/><path d="M12 12.8v3.4"/><path d="M9.4 20.6h5.2l-.5-4.4h-4.2z"/></g></symbol>
<symbol id="ic-diagnose" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.4" cy="10.4" r="6.2"/><path d="M14.9 14.9l5 5"/><path d="M10.4 7.4v3.4M10.4 13.4v.1"/></g></symbol>
<symbol id="ic-heart" viewBox="0 0 24 24"><path d="M12 20.8S3.2 15 3.2 9.1A4.8 4.8 0 0112 6.6a4.8 4.8 0 018.8 2.5c0 5.9-8.8 11.7-8.8 11.7z" fill="currentColor"/></symbol>
<symbol id="ic-bolt" viewBox="0 0 24 24"><path d="M13.6 2.4L4.8 13.6h5.4l-.8 8 8.8-11.2h-5.4z" fill="currentColor"/></symbol>
</g></defs><use href="#deck-icons"></use></svg>`;

function icon(id, size, cls = '') {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

// ---- the track ----------------------------------------------------------------------------
//
// One tile per TRACK_ORDER position, plus a DIAGNOSE badge below when the card has been sent
// there. Tile status, all derived from the run rather than assumed:
//
//   done    -- visited, and the card is still ahead of it
//   stale   -- visited, but the card has since been sent back BEFORE it: it will have to be
//              redone, so it is drawn dimmed rather than as an achievement
//   current -- the split running now (oversized, ringed)
//   locked  -- never visited on this run
const TILE_W = 52;
const CUR_W = 66;
const STEP_X = 95;
const TRACK_Y = 96;

function trackGeometry() {
  return TRACK_ORDER.map((state, i) => ({ state, cx: 46 + i * STEP_X + TILE_W / 2 }));
}

function renderTrack(card, nowMs) {
  const run = card.run;
  const splits = (run && run.splits) || [];
  const current = run && run.current;
  const visits = new Map();
  for (const s of splits) visits.set(s.state, (visits.get(s.state) || 0) + 1);
  if (current) visits.set(current.state, (visits.get(current.state) || 0) + 1);

  // Where the card stands. A card inside DIAGNOSE has no track position of its own -- it is off
  // the track -- so the marker sits on the last on-track state it occupied.
  const currentState = current ? current.state : null;
  let posIndex = currentState ? orderIndex(currentState) : null;
  if (posIndex === null) {
    for (let i = splits.length - 1; i >= 0; i--) {
      const oi = orderIndex(splits[i].state);
      if (oi !== null) {
        posIndex = oi;
        break;
      }
    }
  }
  if (posIndex === null) posIndex = 0;

  const geo = trackGeometry();
  const litTo = geo[Math.min(posIndex, geo.length - 1)].cx;
  const lastCx = geo[geo.length - 1].cx;
  const diagnoseVisits = visits.get('DIAGNOSE') || 0;
  const height = diagnoseVisits ? 236 : 190;

  const tiles = geo
    .map(({ state, cx }, i) => {
      const info = stateInfo(state);
      const n = visits.get(state) || 0;
      const isCurrent = state === currentState;
      const isVisited = n > 0;
      const isStale = isVisited && !isCurrent && i > posIndex;
      const status = isCurrent ? 'current' : isStale ? 'stale' : isVisited ? 'done' : 'locked';
      const w = isCurrent ? CUR_W : TILE_W;
      const x = cx - w / 2;
      const y = TRACK_Y - w / 2;
      const iconSize = isCurrent ? 32 : 26;
      const shape = info.judge
        ? `<path class="tile-face" d="M${cx},${y - 4} L${x + w + 4},${y + w * 0.28} L${x + w + 4},${y + w * 0.72} L${cx},${y + w + 4} L${x - 4},${y + w * 0.72} L${x - 4},${y + w * 0.28} Z"/>`
        : `<rect class="tile-face" x="${x}" y="${y}" width="${w}" height="${w}" rx="${isCurrent ? 18 : 14}"/>`;
      const ring = isCurrent
        ? `<rect class="tile-ring" x="${x - 7}" y="${y - 7}" width="${w + 14}" height="${w + 14}" rx="24"/>`
        : '';
      const attemptBadge =
        n > 1
          ? `<g class="tile-attempts" transform="translate(${cx + w / 2 - 4},${y + 2})"><circle r="9"/><text y="3.5">${n}</text></g>`
          : '';
      return `<g class="tile tile-${status}${info.judge ? ' tile-judge' : ''}">
        ${ring}${shape}
        <svg class="tile-icon" x="${cx - iconSize / 2}" y="${TRACK_Y - iconSize / 2}" width="${iconSize}" height="${iconSize}"><use href="#${info.icon}"></use></svg>
        ${attemptBadge}
        <text class="tile-label" x="${cx}" y="${TRACK_Y + w / 2 + 20}">${esc(info.label)}</text>
      </g>`;
    })
    .join('');

  const diagnose = diagnoseVisits
    ? (() => {
        const dInfo = stateInfo('DIAGNOSE');
        const dx = geo[3].cx; // under IMPLEMENT, which is where every diagnose returns to
        return `<g class="tile tile-detour">
          <path class="detour-arc" d="M${dx + 30},${TRACK_Y + 34} C${dx + 30},${TRACK_Y + 78} ${dx - 4},${TRACK_Y + 78} ${dx - 4},${TRACK_Y + 44}" marker-end="url(#deck-arrow)"/>
          <circle class="tile-face" cx="${dx + 46}" cy="${TRACK_Y + 62}" r="21"/>
          <svg class="tile-icon" x="${dx + 33}" y="${TRACK_Y + 49}" width="26" height="26"><use href="#${dInfo.icon}"></use></svg>
          <text class="tile-label" x="${dx + 46}" y="${TRACK_Y + 100}">${esc(dInfo.label)}${diagnoseVisits > 1 ? ` &times;${diagnoseVisits}` : ''}</text>
        </g>`;
      })()
    : '';

  const runner = current
    ? `<g class="runner" transform="translate(${litTo},34)">
        <rect class="runner-body" x="-34" y="-15" width="68" height="30" rx="12"/>
        <text class="runner-label" y="5">${esc(shortId(card.id))}</text>
        <path class="runner-tip" d="M0,15 L8,26 L-8,26 Z"/>
      </g>`
    : '';

  return `<div class="deck-track"><svg viewBox="0 0 ${lastCx + 60} ${height}" role="img" aria-label="${esc(trackAria(card, visits, currentState))}">
    <defs><marker id="deck-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" class="arrow-head"/></marker></defs>
    <rect class="track-bed" x="46" y="${TRACK_Y - 4}" width="${lastCx - 46}" height="8" rx="4"/>
    <rect class="track-lit" x="46" y="${TRACK_Y - 4}" width="${Math.max(0, litTo - 46)}" height="8" rx="4"/>
    ${diagnose}${tiles}${runner}
  </svg></div>`;
}

function trackAria(card, visits, currentState) {
  const cleared = [...visits.keys()].filter((s) => s !== currentState).length;
  const info = currentState ? stateInfo(currentState) : null;
  return info
    ? `${cleared} checkpoints cleared, now at ${info.label}`
    : `${cleared} checkpoints cleared, run finished`;
}

function shortId(id) {
  return String(id || '').replace(/^issue-/, '#');
}

// ---- lives --------------------------------------------------------------------------------
//
// Four counters, each drawn as its budget in pips. A spent pip is hollowed rather than removed,
// so the budget stays legible at a glance -- "1 of 3 gone" reads instantly, "2 hearts" does not.
function renderLives(counters, budgets) {
  const c = counters || {};
  const rows = [
    ['Diagnose', c.diagnoseAttempts || 0, budgets.diagnose],
    ['Review rejects', c.validateRejects || 0, budgets.validate],
    ['CI retries', c.ciImplementRetries || 0, budgets.ci],
    ['Rebases', c.mainMoveUsed || 0, budgets.mainMoved],
  ];
  return `<div class="deck-lives">${rows
    .map(([label, spent, budget]) => {
      const pips = Array.from({ length: budget }, (_, i) =>
        icon('ic-heart', 17, i < spent ? 'pip-spent' : 'pip-full')
      ).join('');
      const out = spent >= budget ? ' lives-out' : spent > 0 ? ' lives-hurt' : '';
      return `<div class="life${out}"><span class="life-label">${esc(label)}</span><span class="pips">${pips}</span></div>`;
    })
    .join('')}</div>`;
}

// ---- the NOW panel -------------------------------------------------------------------------
//
// The plain-language half of the deck. Says what is happening in words a reader who has never
// seen the state machine can act on, then backs it with the live transcript when there is one.
//
// THE BAR IS ELAPSED AGAINST PAR, NOT COMPLETION. There is no completion signal inside a step --
// see live-step.js. The scale is labelled with the three real numbers (zero, par, the deadline)
// precisely so it cannot be misread as "44% done".
function renderNow(card, parTimes, live, nowMs) {
  const cur = card.run && card.run.current;
  if (!cur) return '';
  const info = stateInfo(cur.state);
  const elapsed = nowMs - Date.parse(cur.enteredAt);
  const par = (parTimes && parTimes.byState && parTimes.byState[cur.state]) || null;
  const p = pace(elapsed, par);

  const attemptLine =
    cur.attempt > 1
      ? ` This is attempt <b>${cur.attempt}</b> — ${describeWhyAgain(card, cur)}.`
      : '';
  const parLine = par
    ? ` Usually this takes <b>${clock(par.p50Ms)}</b>.`
    : ' There is no measured par for this step yet.';

  // THE METER. Its window is not always the deadline: WORKTREE's is 2h33m against a par of 20
  // seconds, so scaling to it puts par at 0.2% and the bar tells you nothing. The window is
  // therefore the deadline OR a readable multiple of what this step actually costs, whichever is
  // smaller -- while the right-hand label always states the real deadline, so nothing is hidden,
  // only made legible. Once elapsed passes the window the bar pins full and the label is what
  // carries the remaining truth.
  const deadlineMs = stepDeadlineMs(cur.state);
  const readableMax = par ? Math.max((par.p90Ms || par.p50Ms) * 1.6, par.p50Ms * 3) : null;
  const windowMs = deadlineMs && readableMax ? Math.min(deadlineMs, readableMax) : deadlineMs || readableMax;
  const pct = windowMs ? Math.min(100, Math.max(0, (elapsed / windowMs) * 100)) : 0;
  const parPct = windowMs && par ? Math.min(100, (par.p50Ms / windowMs) * 100) : null;

  const quote =
    live && live.lastText
      ? `<p class="now-quote">&ldquo;${esc(trimNarration(live.lastText))}&rdquo;</p>`
      : '';

  const chips = [];
  if (live && live.toolCounts) {
    const total = Object.values(live.toolCounts).reduce((a, b) => a + b, 0);
    const parts = Object.entries(live.toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, k]) => `${esc(n)} &times;${k}`)
      .join(', ');
    chips.push(chip(`${total} recent actions &middot; <b>${parts}</b>`));
  }
  if (live && live.lastTurnAt) {
    chips.push(chip(`last activity <b>${clock(nowMs - Date.parse(live.lastTurnAt))} ago</b>`));
  }
  if (live && live.account) chips.push(chip(`running on <b>${esc(live.account)}</b>`));
  else if (cur.detail && cur.detail.account) chips.push(chip(`running on <b>${esc(cur.detail.account)}</b>`));
  if (cur.detail && cur.detail.model) {
    chips.push(chip(`${esc(cur.detail.model)}${cur.detail.effort ? ` &middot; ${esc(cur.detail.effort)}` : ''}`));
  }
  if (cur.detail && cur.detail.failedCalls) {
    chips.push(chip(`<b>${cur.detail.failedCalls}</b> call${cur.detail.failedCalls === 1 ? '' : 's'} failed first`, 'chip-warn'));
  }
  const next = nextLabel(card, cur);
  if (next) chips.push(chip(`next up <b>${esc(next)}</b>`, 'chip-next'));

  return `<div class="deck-now">
    <p class="now-kicker"><span class="now-dot"></span> Happening right now</p>
    <div class="now-body">
      <div class="now-icon">${icon(info.icon, 34)}</div>
      <div class="now-main">
        <div class="now-head">
          <h3 class="now-what">${esc(info.label)}</h3>
          <span class="now-clock ${PACE_CLASS[p.band]}">${clock(elapsed)}</span>
        </div>
        <p class="now-plain">${esc(info.sentence)}${attemptLine}${parLine}</p>
        ${quote}
        ${
          windowMs
            ? `<div class="now-meter"><div class="now-bar"><span style="width:${pct.toFixed(1)}%"></span>${
                parPct === null ? '' : `<em style="left:${parPct.toFixed(1)}%"></em>`
              }</div>
        <div class="now-scale"><span>0:00</span><span>${par ? `usual ${clock(par.p50Ms)}` : 'no par yet'}</span><span>${
                deadlineMs ? `gives up ${clock(deadlineMs)}` : 'no deadline'
              }</span></div></div>`
            : ''
        }
        <div class="chips">${chips.join('')}</div>
      </div>
    </div>
  </div>`;
}

// Why is this state being attempted again? Read off the run rather than guessed: the split
// immediately before this one is the thing that sent it back.
function describeWhyAgain(card, cur) {
  const splits = (card.run && card.run.splits) || [];
  const prev = splits[splits.length - 1];
  if (!prev) return 'it has been here before';
  if (prev.state === 'DIAGNOSE') return 'the last version broke something that had to be diagnosed';
  if (prev.state === 'VALIDATE' && prev.detail && prev.detail.verdict === 'REJECT') return 'the reviewer rejected the last version';
  if (prev.sentBack) return `it was sent back from ${stateInfo(prev.state).label.toLowerCase()}`;
  return 'it has been here before';
}

// The next state on the track, for the "next up" chip. Only offered when the card is moving
// forward: from DIAGNOSE, or on a repeat attempt, what comes next is genuinely not knowable.
function nextLabel(card, cur) {
  const i = orderIndex(cur.state);
  if (i === null || i >= TRACK_ORDER.length - 1) return null;
  return stateInfo(TRACK_ORDER[i + 1]).label.toLowerCase();
}

// The wall-clock ceiling the orchestrator arms for this step, so the meter's full width is a
// real number rather than a guess. Scripted steps carry per-state deadlines in config; LLM
// steps carry step-contracts.js's own (PLAN has a 30-minute override, everything else 15).
function stepDeadlineMs(state) {
  try {
    const { deadlineMsForStep } = require('../orchestrator/step-contracts');
    const config = require('../orchestrator/config');
    if (['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE'].includes(state)) return deadlineMsForStep(state);
    const d = config.stepDeadlineMsByState || {};
    return d[state] || null;
  } catch {
    return null;
  }
}

// The model's narration can be several paragraphs. The deck wants the last thing it said it was
// doing, so this keeps the tail -- the most recent sentence or two -- not the head.
function trimNarration(text, max = 200) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const tail = flat.slice(-max);
  const cut = tail.search(/[.!?]\s+\S/);
  return (cut === -1 ? tail : tail.slice(cut + 2)).trim();
}

function chip(inner, cls = '') {
  return `<span class="chip ${cls}">${inner}</span>`;
}

// ---- splits --------------------------------------------------------------------------------

function renderSplits(card, parTimes, nowMs) {
  const run = card.run;
  if (!run) return '';
  const rows = run.splits
    .filter((s) => s.state !== 'INTAKE' || s.ms > 1000) // a 0s claim is noise, not a split
    .map((s) => splitRow(s, parTimes, false, nowMs));
  if (run.current) {
    rows.push(
      splitRow(
        { ...run.current, ms: nowMs - Date.parse(run.current.enteredAt), sentBack: false },
        parTimes,
        true,
        nowMs
      )
    );
  }
  if (!rows.length) return '';
  return `<div class="deck-splits">
    <div class="splits-head"><span>Checkpoint splits</span><span>time &middot; vs par</span></div>
    ${rows.join('')}
  </div>`;
}

function splitRow(s, parTimes, isLive, nowMs) {
  const info = stateInfo(s.state);
  const par = (parTimes && parTimes.byState && parTimes.byState[s.state]) || null;
  // A step that was reused rather than run has no time to compare: scoring a skipped step
  // against par credits it with minutes it never spent.
  let p = s.detail && s.detail.reused ? { band: 'unknown', deltaMs: null } : pace(s.ms, par);
  // A split still running is not "2 minutes under par" -- it has not finished, and a negative
  // delta on a live row reads as an achievement it has not earned. Stay silent while it is
  // inside par; start showing the overrun the moment it is late, which is when the number
  // actually means something.
  if (isLive && p.deltaMs !== null && p.deltaMs <= 0) p = { band: 'unknown', deltaMs: null };
  const cls = isLive ? 'split-live' : s.sentBack ? 'split-back' : 'split-done';
  const attempt = s.attempt > 1 ? ` <span class="split-attempt">#${s.attempt}</span>` : '';
  const note = splitNote(s, isLive);
  return `<div class="split ${cls}">
    <span class="split-icon">${icon(info.icon, 16)}</span>
    <span class="split-name">${esc(info.label)}${attempt}${note ? ` <small>${note}</small>` : ''}</span>
    <span class="split-time">${clock(s.ms)}</span>
    <span class="split-delta ${PACE_CLASS[p.band]}">${p.deltaMs === null ? '—' : signedClock(p.deltaMs)}</span>
  </div>`;
}

// What this split produced, off the detail buildRun already attached. Every branch names a fact
// the orchestrator journalled; nothing is inferred from the state name.
function splitNote(s, isLive) {
  if (isLive) return 'running now';
  const d = s.detail || {};
  if (d.reused) return 'reused from the previous run — not re-run';
  const bits = [];
  if (d.verdict === 'REJECT') bits.push('rejected it — sent back');
  else if (d.verdict) bits.push(esc(String(d.verdict).toLowerCase().replace(/_/g, ' ')));
  if (typeof d.invariantsChecked === 'number') {
    bits.push(`${d.invariantsChecked} invariants, ${d.invariantsBroken || 0} broken`);
  }
  if (typeof d.checksGreen === 'number') bits.push(`${d.checksGreen} checks green`);
  if (d.prNumber) bits.push(`PR #${esc(d.prNumber)}`);
  if (d.rootCause) bits.push(`&ldquo;${esc(trimNarration(d.rootCause, 90))}&rdquo;`);
  if (typeof d.numTurns === 'number') bits.push(`${d.numTurns} turns`);
  if (typeof d.billableTokens === 'number' && d.billableTokens > 0) bits.push(esc(formatTokenCount(d.billableTokens)));
  if (!bits.length && s.sentBack) bits.push('sent back');
  return bits.join(' &middot; ');
}

// ---- outcome panels ---------------------------------------------------------------------------

function renderOutcome(card) {
  const outcome = card.run && card.run.outcome;
  if (!outcome) return '';
  if (outcome.kind === 'done') {
    return `<div class="deck-outcome outcome-done">
      <div class="outcome-icon">${icon('ic-ship', 38)}</div>
      <p class="outcome-title">SHIPPED</p>
      <p class="outcome-why">Merged into main${card.prNumber ? ` as PR #${esc(card.prNumber)}` : ''}.</p>
    </div>`;
  }
  const r = reasonText(outcome.reason);
  const outOfLives = /budget-exhausted|duplicate-root-cause/.test(outcome.reason || '');
  return `<div class="deck-outcome outcome-parked">
    <div class="outcome-icon">${icon('ic-diagnose', 38)}</div>
    <p class="outcome-title">${outOfLives ? 'OUT OF LIVES' : 'HANDED BACK'}</p>
    <p class="outcome-why">${esc(r.text)}</p>
    <p class="outcome-fix"><span class="outcome-slug">${esc(outcome.reason || 'no reason recorded')}</span>${
      r.selfRetrying
        ? ' &middot; it will start again on its own'
        : ' &middot; comment <b>retry</b> on the issue to run it again'
    }</p>
  </div>`;
}

// ---- one card ----------------------------------------------------------------------------------

function renderCard(card, data, nowMs) {
  const budgets = resolveBudgets();
  const run = card.run;
  const parTimes = data.parTimes || null;
  const live = (data.liveSteps && data.liveSteps[card.id]) || null;
  const liveOk = live && !live.miss ? live : null;

  const startedMs = run && run.startedAt ? Date.parse(run.startedAt) : null;
  const endedMs = run && run.outcome ? Date.parse(run.outcome.at) : null;
  const runMs = startedMs ? (endedMs || nowMs) - startedMs : null;
  const wholePar =
    parTimes && parTimes.wholeRun
      ? card.deckState === 'finished' && run && run.outcome && run.outcome.kind === 'parked'
        ? parTimes.wholeRun.parked
        : parTimes.wholeRun.done
      : null;
  const runPace = wholePar && runMs !== null ? pace(runMs, wholePar) : { band: 'unknown', deltaMs: null };

  // On-track states only: DIAGNOSE is a detour, not a checkpoint, and counting it produced
  // "13 of 12 checkpoints" on a card that had been sent back once.
  const cleared = run ? new Set(run.splits.map((s) => s.state).filter((s) => orderIndex(s) !== null)).size : 0;
  const spentTokens = run
    ? run.splits.reduce((sum, s) => sum + ((s.detail && s.detail.billableTokens) || 0), 0)
    : 0;
  const liveCallPending = !!(run && run.current && ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE'].includes(run.current.state));

  const statusPill =
    card.deckState === 'running'
      ? `<span class="pill pill-live"><span class="pill-dot"></span>${esc(stateInfo(card.state).label)}</span>`
      : card.deckState === 'stale'
        ? `<span class="pill pill-stale">no worker holds this card</span>`
        : run && run.outcome && run.outcome.kind === 'done'
          ? `<span class="pill pill-done">Shipped</span>`
          : `<span class="pill pill-parked">Handed back</span>`;

  const foot = [];
  if (spentTokens > 0) {
    foot.push(
      chip(
        `spent this run <b>${esc(formatTokenCount(spentTokens))}</b>${liveCallPending ? ' <span class="chip-dim">+ live call unreported</span>' : ''}`
      )
    );
  }
  if (card.workerPid) {
    foot.push(
      chip(
        `worker <b>pid ${esc(card.workerPid)}</b> &middot; ${card.deckState === 'running' ? 'confirmed alive' : 'gone'}`,
        card.deckState === 'stale' ? 'chip-warn' : ''
      )
    );
  }
  if (parTimes && parTimes.legCount) foot.push(chip(`par times from <b>${esc(parTimes.legCount)}</b> measured steps`));
  if (live && live.miss) foot.push(chip(`live detail unavailable <span class="chip-dim">(${esc(live.miss)})</span>`, 'chip-dim-all'));

  return `<article class="deck-card deck-${card.deckState}">
    <header class="deck-head">
      <div class="deck-id">
        <div class="deck-idline">
          <span class="run-pill">RUN ${esc(run ? run.runIndex : 1)}</span>
          <span class="mono">${esc(card.id)}</span>
          ${card.prNumber ? `<span class="sep">/</span><span class="mono">PR #${esc(card.prNumber)}</span>` : ''}
          <span class="sep">/</span><span class="mono">${esc(cleared)} of ${TRACK_ORDER.length} checkpoints</span>
        </div>
        <h2 class="deck-title">${esc(card.title || card.id)}</h2>
      </div>
      <div class="deck-timer">
        ${statusPill}
        <div class="timer-big">${clock(runMs)}</div>
        ${
          wholePar
            ? card.deckState === 'running'
              ? // A run in progress is not "22 minutes under par" -- it has not finished. Show the
                // target it is running against; the delta becomes meaningful only at the end.
                `<div class="timer-delta pace-none">${icon('ic-bolt', 12)} a run usually takes ${clock(wholePar.p50Ms)}</div>`
              : `<div class="timer-delta ${PACE_CLASS[runPace.band]}">${icon('ic-bolt', 12)} ${signedClock(runPace.deltaMs)} vs par ${clock(wholePar.p50Ms)}</div>`
            : ''
        }
      </div>
    </header>
    ${renderTrack(card, nowMs)}
    ${renderLives(card.counters, budgets)}
    ${card.deckState === 'running' ? renderNow(card, parTimes, liveOk, nowMs) : renderOutcome(card)}
    ${renderSplits(card, parTimes, nowMs)}
    ${foot.length ? `<footer class="deck-foot">${foot.join('')}</footer>` : ''}
  </article>`;
}

// ---- the empty state -----------------------------------------------------------------------------
//
// The state you will see most: the pipeline works 12.4% of the time (20.9 of 168 hours, measured
// over a week) and SPO_WORKERS is 1. So this is designed, not left blank -- it answers the two
// questions an empty deck otherwise raises: did something just finish, and is anything stuck.
// The queue count is the one that matters: without it, "nothing to do" and "work waiting and the
// daemon is wedged" look identical, and the second is the one worth catching.
function renderIdle(data) {
  const stats = data.daemonStats || {};
  const services = data.services || {};
  const queue = data.queue || {};
  const daemon = services.daemon || {};

  const chips = [];
  chips.push(
    chip(
      daemon.status === 'up'
        ? `daemon <b>up ${clock(daemon.uptimeMs)}</b>`
        : `daemon <b>${esc(daemon.status || 'unknown')}</b>`,
      daemon.status === 'up' ? '' : 'chip-warn'
    )
  );
  chips.push(chip(`waiting to start <b>${esc(queue.depth || 0)}</b>`, queue.depth ? 'chip-next' : ''));
  if (stats.today) {
    chips.push(
      chip(`today <b>${esc(stats.today.done || 0)} shipped</b> &middot; <b>${esc(stats.today.parked || 0)} handed back</b>`)
    );
  }
  const cooling = ((data.accounts && data.accounts.rows) || []).filter((a) => a.cooling);
  for (const a of cooling) chips.push(chip(`${esc(a.name)} <b>out of quota</b>`, 'chip-warn'));

  return `<div class="deck-card deck-idle">
    <div class="idle-body">
      <svg class="idle-track" viewBox="0 0 240 56" aria-hidden="true">
        <rect class="track-bed" x="10" y="26" width="220" height="6" rx="3"/>
        ${[0, 1, 2, 3, 4]
          .map((i) => `<rect class="idle-tile" x="${10 + i * 46}" y="${15}" width="28" height="28" rx="9"/>`)
          .join('')}
      </svg>
      <p class="idle-kicker">Standing by</p>
      <p class="idle-headline">Nothing is running.</p>
      <p class="idle-body-text">${esc(idleSentence(data))}</p>
    </div>
    <footer class="deck-foot deck-foot-center">${chips.join('')}</footer>
  </div>`;
}

function idleSentence(data) {
  const q = (data.queue && data.queue.depth) || 0;
  if (q > 0) return `${q} card${q === 1 ? ' is' : 's are'} waiting to start. If this does not change in a few minutes, the daemon is stuck.`;
  return 'There is nothing on the queue. The deck will fill in as soon as a card is claimed.';
}

// ---- the fragment ---------------------------------------------------------------------------------

// renderLiveInner(data) -> the `live` fragment's content. One card per running or
// just-finished run, newest first; the idle panel when there are none. `data.generatedAt` is the
// clock -- see this file's header on why nothing here calls Date.now().
function renderLiveInner(data) {
  const d = data || {};
  const nowMs = Date.parse(d.generatedAt) || 0;
  const deck = Array.isArray(d.deck) ? d.deck : [];
  const body = deck.length ? deck.map((c) => renderCard(c, d, nowMs)).join('') : renderIdle(d);
  return `${ICON_SPRITE}<div class="deck">${body}</div>`;
}

module.exports = {
  renderLiveInner,
  renderIdle,
  renderCard,
  renderTrack,
  renderNow,
  renderSplits,
  renderLives,
  renderOutcome,
  clock,
  signedClock,
  pace,
  trimNarration,
  shortId,
  stepDeadlineMs,
  ICON_SPRITE,
};
