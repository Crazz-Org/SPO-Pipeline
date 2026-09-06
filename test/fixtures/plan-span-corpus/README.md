# plan-span-corpus fixtures

Ten real cards' `plan-<n>.md` and `invariants-<n>.md`, copied byte-for-byte from the live
daemon's journal at `~/.spo-state/journal/issue-<n>/scratch/`, plus a derived `meta.json` per
card. This is the reproducibility half of issue #112's calibration: the numbers quoted in that
PR were measured against this same journal, which is **not tracked by git** (see
`orchestrator/state-root.js`) and only goes back to **2026-08-29** — nothing before that date
survived. Without a committed copy, nobody could re-derive the calibration; these fixtures are
that copy, frozen.

## Why these ten

Two groups, chosen for what each half of `test/plan-span-replay.test.js` needs to prove:

- **487, 488, 491, 508, 517** — the five cards (of the corpus measured for issue #112) whose
  invariants actually broke at CHECK. These are the detector's true positives (and, for 517, its
  one known false negative — see that card's own note below). Without them there is nothing to
  calibrate against.
- **462, 473, 490, 505, 506** — five cards that merged cleanly (no invariant ever broke) and are
  known to still produce span-conflict flags. These prove the design's safety property: a flag on
  a clean card is harmless noise, not a false accusation, because nothing ever consulted it. A
  fixture set with only the five broken cards could not show that a flag is not itself proof of a
  problem.

`issue-517` is a special case worth calling out: its card was ultimately `PARKED` and externally
resolved by the GitHub issue being closed, not merged — see its `meta.json`. It is still one of
the "broke at CHECK" five because `INV-13` genuinely failed re-resolution during that run; the
resolution path afterwards doesn't change what CHECK saw.

## What's in each `issue-<n>/`

- `plan-<n>.md` — PLAN's own output for that card, verbatim.
- `invariants-<n>.md` — PLAN's invariants file for that card, verbatim, in the block format
  `orchestrator/invariants.js`'s `parseInvariantsMarkdown` parses.
- `meta.json` — derived from that card's own `~/.spo-state/journal/issue-<n>/journal.jsonl` and
  `state.json`, not written by hand:
  - `brokenIds` — the union of every invariant `id` appearing in a non-empty `broken` array of
    any `{"state":"CHECK","event":"invariants-checked"}` journal record for that card. `[]` for
    all five clean cards — if a "clean" card had ever produced a non-empty union here, that would
    contradict the whole premise of the corpus and the fixture would not have been included.
  - `outcome` — `state.json`'s top-level `state` field, with `externallyResolved.via` appended in
    parentheses when present (only issue-517 has one).
  - `prNumber` — `state.json`'s `prNumber` (`null` for 517, which never had one).
  - `source` — the original journal path this fixture was copied from, for anyone who still has
    (or can rebuild) a journal old enough to check it against.

## How to refresh / extend this corpus

There is no automation for this — the source directory is a live, unversioned daemon state
directory, not something a script should reach into unattended. To add or refresh a card by hand:

1. Confirm `~/.spo-state/journal/issue-<n>/scratch/plan-<n>.md` and `invariants-<n>.md` both
   exist (a card that never reached PLAN, or whose scratch dir was already reaped, has neither).
2. Copy both files verbatim — `cp`, not an editor, so no reformatting or line-ending
   normalization sneaks in.
3. Derive `meta.json` from that same card's `journal.jsonl` and `state.json` following the rules
   above. Do not hand-write `brokenIds`: grep `journal.jsonl` for
   `"event":"invariants-checked"` and union the `id`s of every non-empty `broken` entry.
4. Re-run `node --test test/plan-span-replay.test.js` — a new or changed fixture will need its
   pinned flagged-id list (the calibration ratchet) updated deliberately, by hand, with the
   reason recorded in the commit, never auto-regenerated.

Because the journal only goes back to 2026-08-29, any card resolved before that date can never be
added this way again — this fixture set is as complete as it will ever get for cards from before
that window.
