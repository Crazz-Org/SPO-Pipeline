#!/usr/bin/env node
// replay-plan-span-flags.js -- issue #112's full-corpus replay of orchestrator/plan-span-guard.js's
// detectSpanConflicts, over every real card in the daemon's journal that still has a PLAN-time
// scratch/plan-<n>.md + scratch/invariants-<n>.md pair.
//
// This is a REPORTING tool, not a gate: it always exits 0 once it completes, even when the
// detector disagrees with a prior measurement -- a disagreement here is a finding to look at, not
// a test failure. It exits non-zero only on a real error: the journal root does not exist, or a
// file this script itself discovered (a plan/invariants file it found via a directory listing)
// could not be read.
//
// The journal this reads from (~/.spo-state/journal/ by default, orchestrator/state-root.js's own
// default) is NOT tracked by git and only goes back to 2026-08-29 -- see
// test/fixtures/plan-span-corpus/README.md, the committed slice of this same corpus that survives
// after the live journal is gone. This script's numbers are reproducible only for as long as that
// journal state exists on a machine that ran the daemon; the fixture corpus is what is left once
// it doesn't.
//
// ---- CHECK-failure-avoided semantics: all-or-nothing, matching the real gate ---------------------
// A `{"state":"CHECK","event":"invariants-checked"}` record with a non-empty `broken` array is one
// real CHECK failure. It counts as "avoided" by this detector ONLY when EVERY id in that event's
// `broken` array was flagged for that card -- never a partial match. That is the shipped CHECK
// semantics (checkRegressions in orchestrator/invariants.js fails the whole CHECK on ANY broken
// id, not per-id), so an approximation that credited a partial catch would overstate what this
// detector actually would have prevented.
//
// ---- span provenance: declaredSpan only, exactly like test/plan-span-replay.test.js -------------
// The product worktree each PLAN saw is long gone by the time this script runs (the daemon reaps
// it once a card leaves CHECK), so there is no resolved span to re-derive -- every invariant row
// built below carries `span: null` and only `declaredSpan`, PLAN's own `File: path:start-end`
// claim. See that test file's header for the same note in more detail.

'use strict';
const fs = require('fs');
const path = require('path');

const { parseInvariantsMarkdown } = require('../orchestrator/invariants');
const { detectSpanConflicts } = require('../orchestrator/plan-span-guard');
const { resolveStateRoot, stateJournalRoot } = require('../orchestrator/state-root');

function parseArgs(argv) {
  const opts = { journal: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--journal' && i + 1 < argv.length) {
      opts.journal = argv[++i];
    } else if (argv[i].startsWith('--journal=')) {
      opts.journal = argv[i].slice('--journal='.length);
    }
  }
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));
const JOURNAL_ROOT = ARGS.journal || stateJournalRoot(resolveStateRoot());

function fail(message) {
  console.error(`replay-plan-span-flags: ${message}`);
  process.exit(1);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Every non-empty `broken` array from a {"state":"CHECK","event":"invariants-checked"} record in
// this card's journal.jsonl, as a list of events (not a union) -- CHECK-failure counting below
// needs each occurrence, not the deduplicated set test/plan-span-replay.test.js's meta.json uses
// for brokenIds. Never throws: a missing or unreadable journal.jsonl yields no events.
function readCheckFailureEvents(journalJsonlPath) {
  let text;
  try {
    text = fs.readFileSync(journalJsonlPath, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && rec.state === 'CHECK' && rec.event === 'invariants-checked' && Array.isArray(rec.broken) && rec.broken.length > 0) {
      events.push(rec.broken.map((b) => b && b.id).filter(Boolean));
    }
  }
  return events;
}

function unionBrokenIds(checkFailureEvents) {
  const ids = new Set();
  for (const ev of checkFailureEvents) for (const id of ev) ids.add(id);
  return [...ids].sort();
}

function outcomeBucket(stateJson) {
  if (!stateJson || typeof stateJson.state !== 'string') return 'UNKNOWN';
  const via = stateJson.externallyResolved && stateJson.externallyResolved.via;
  return via ? `${stateJson.state} (externallyResolved: ${via})` : stateJson.state;
}

function baselineRowsFromMarkdown(invariantsMarkdown) {
  const { invariants } = parseInvariantsMarkdown(invariantsMarkdown);
  return invariants.map((inv) => ({
    id: inv.id,
    file: inv.file,
    resolved: true,
    mode: 'exact',
    lineSpec: inv.lineSpec,
    declaredSpan: inv.declaredSpan,
    span: null,
  }));
}

function findCards(journalRoot) {
  let entries;
  try {
    entries = fs.readdirSync(journalRoot, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read journal root ${journalRoot}: ${err.message}`);
  }
  const cards = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^issue-(\d+)$/);
    if (!m) continue;
    const dir = path.join(journalRoot, e.name);
    const scratch = path.join(dir, 'scratch');
    const planPath = path.join(scratch, `plan-${m[1]}.md`);
    const invPath = path.join(scratch, `invariants-${m[1]}.md`);
    if (fs.existsSync(planPath) && fs.existsSync(invPath)) {
      cards.push({ issue: m[1], dir, planPath, invPath });
    }
  }
  cards.sort((a, b) => Number(a.issue) - Number(b.issue));
  return cards;
}

function journalMtime(dir) {
  try {
    return fs.statSync(path.join(dir, 'journal.jsonl')).mtime;
  } catch {
    return null;
  }
}

function main() {
  if (!fs.existsSync(JOURNAL_ROOT)) {
    fail(
      `journal root does not exist: ${JOURNAL_ROOT}. This corpus is a live daemon's untracked ` +
        'state (see orchestrator/state-root.js) -- pass --journal <dir> to point at one, or run ' +
        'this on a machine that has run the daemon.'
    );
    return;
  }

  const cards = findCards(JOURNAL_ROOT);

  let totalFlaggedPairs = 0;
  let cardsWithFlag = 0;
  const flaggedAndBroke = [];
  const brokeButNotFlagged = [];
  let checkFailureEventsTotal = 0;
  let checkFailureEventsAvoided = 0;

  let cleanCardsCount = 0;
  let cleanCardsFlaggedTotal = 0;
  let cleanCardsWithFlag = 0;

  let oldestMtime = null;
  let newestMtime = null;

  for (const card of cards) {
    let planMarkdown, invariantsMarkdown;
    try {
      planMarkdown = fs.readFileSync(card.planPath, 'utf8');
      invariantsMarkdown = fs.readFileSync(card.invPath, 'utf8');
    } catch (err) {
      fail(`issue-${card.issue}: found but could not read plan/invariants file: ${err.message}`);
      return;
    }

    const rows = baselineRowsFromMarkdown(invariantsMarkdown);
    const findings = detectSpanConflicts({ planMarkdown, invariants: rows });
    const flagged = [...new Set(findings.map((f) => f.id))].sort();

    const stateJson = readJsonSafe(path.join(card.dir, 'state.json'));
    const outcome = outcomeBucket(stateJson);
    const checkFailureEvents = readCheckFailureEvents(path.join(card.dir, 'journal.jsonl'));
    const brokenIds = unionBrokenIds(checkFailureEvents);

    const mtime = journalMtime(card.dir);
    if (mtime) {
      if (!oldestMtime || mtime < oldestMtime) oldestMtime = mtime;
      if (!newestMtime || mtime > newestMtime) newestMtime = mtime;
    }

    console.log(
      `issue-${card.issue}: invariants=${rows.length} flagged=${JSON.stringify(flagged)} ` +
        `brokenIds=${JSON.stringify(brokenIds)} outcome=${outcome}`
    );

    totalFlaggedPairs += flagged.length;
    if (flagged.length > 0) cardsWithFlag++;

    for (const id of flagged) {
      if (brokenIds.includes(id)) flaggedAndBroke.push(`${card.issue}/${id}`);
    }
    for (const id of brokenIds) {
      if (!flagged.includes(id)) brokeButNotFlagged.push(`${card.issue}/${id}`);
    }

    if (brokenIds.length === 0) {
      cleanCardsCount++;
      cleanCardsFlaggedTotal += flagged.length;
      if (flagged.length > 0) cleanCardsWithFlag++;
    }

    for (const ev of checkFailureEvents) {
      checkFailureEventsTotal++;
      if (ev.every((id) => flagged.includes(id))) checkFailureEventsAvoided++;
    }
  }

  console.log('');
  console.log('---- totals ----');
  console.log(`cards analysed: ${cards.length}`);
  console.log(`invariants flagged (total flagged id occurrences across all cards): ${totalFlaggedPairs}`);
  console.log(`cards with >=1 flag: ${cardsWithFlag}`);
  console.log(`flagged AND broke (${flaggedAndBroke.length}): ${JSON.stringify(flaggedAndBroke)}`);
  console.log(`broke but NOT flagged (${brokeButNotFlagged.length}): ${JSON.stringify(brokeButNotFlagged)}`);
  console.log(
    `CHECK failures that would have been avoided (all broken ids in the event flagged): ` +
      `${checkFailureEventsAvoided} of ${checkFailureEventsTotal}`
  );
  console.log('');
  console.log('---- clean cards (brokenIds: [], never broke) ----');
  console.log(`clean cards: ${cleanCardsCount}`);
  console.log(`flags on clean cards: ${cleanCardsFlaggedTotal}`);
  console.log(`clean cards with >=1 flag: ${cleanCardsWithFlag}`);
  console.log('');
  console.log('---- corpus window ----');
  console.log(
    `journal.jsonl mtimes range from ${oldestMtime ? oldestMtime.toISOString() : 'n/a'} to ` +
      `${newestMtime ? newestMtime.toISOString() : 'n/a'} across the ${cards.length} analysed cards.`
  );
  console.log(
    `This journal root (${JOURNAL_ROOT}) is NOT tracked by git and (per project history) only ` +
      'goes back to 2026-08-29 -- these numbers are reproducible only on a machine where that ' +
      'window of daemon state still exists. See test/fixtures/plan-span-corpus/README.md for the ' +
      'committed slice that survives after it does not.'
  );

  process.exit(0);
}

main();
