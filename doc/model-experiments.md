# Model & effort experiments — the register

Every model or effort choice in the pipeline that is **a bet rather than a measurement** is listed
here, with its baseline, what settles it, and when to revert. Settled decisions stay listed below
the open ones, so an audit can tell a deliberate choice from a default nobody questioned.

The code carries the same facts next to each value (`orchestrator/step-contracts.js`), and the
per-step tables restate them (`doc/state-machine-spec.md` § Step contracts, `prompts/README.md`).
**This file is the one place that says whether a choice is still on trial.** Change a model or an
effort map without updating it and the next audit will judge the wrong thing.

## Running a model-performance audit

When the maintainer asks for an audit of model performance (any step, any model, any effort):

1. **Measure.** Run `node scripts/model-report.js --since=<experiment start>` for each open entry
   below, plus a run with no window for the overall picture. The script reads the daemon's own
   journal (`~/.spo-state/journal`) and prints three parts: `calls` (step × model × effort cells),
   `planFallbacks`, and `cardsByPlanModel` (downstream cost per merged card, grouped by how PLAN
   ran). Use `--until=<start date>` to re-derive a baseline.
2. **Judge every open entry against its own criterion,** not against a fresh opinion. If the sample
   is still below the entry's minimum, the verdict is "not yet", and it says so with the count.
3. **Record the verdict** in that entry's *Verdict log*, dated, with the numbers. A reverted or
   adopted experiment moves to *Settled decisions* with a one-line outcome.
4. **Look for choices missing from this file.** A model/effort value in `step-contracts.js` or
   `orchestrator/intake.js` that is neither an open entry nor a settled decision gets added.

Caveats that apply to every entry:

- **Effort is a pure function of size** for PLAN and IMPLEMENT, so a cell compares two card
  populations as much as two settings. Where possible, compare the same size before and after.
- **Tokens are not comparable across models** as quota cost. Compare a model's cells with that
  same model's cells, and read cross-model cost from the account usage dashboards. There is no
  dollar figure anywhere (maintainer decision, 2026-08-31).
- The journal keeps growing, so every number below is dated.

## Open experiments

### EXP-PLAN-OPUS — PLAN on Opus first, Fable as fallback, one effort rung up

- **Started:** 2026-09-13 (deploy = the `git pull` in `~/SPO-Pipeline` that brings this change in).
  The first PLAN `llm-call` with `model: "opus"` in the journal is the real start date.
- **Decided by:** the maintainer, for cost ("Opus first, Fable as fall back. It will be more cost
  efficient"). Until then PLAN was Fable-only, a default inherited from the spec, never measured
  against Opus. DIAGNOSE had already moved Fable → Opus on 2026-09-04 with no quality loss.
- **What changed:**
  - `STEP_CONTRACTS.PLAN` changed from `baseModel: 'fable'` with no escalation to
    `baseModel: 'opus'`, `escalatedModel: 'fable'`, `escalatesOn: ['planInvalidRetry']`.
  - `PLAN_EFFORT_BY_SIZE` = S/M/L → **medium/high/high**, one rung above the old low/medium/high.
    L stays `high`, not `xhigh`, because of PLAN's 30-minute deadline: Fable L/high ran a 825s
    median, and a fallback can add a second full call.
  - `handlePlan` sets `task.planInvalidRetry` in two cases (real mode only):
    - **in-run:** after an Opus reply that would park `plan-invalid`, it makes one more call, on
      Fable, and journals `plan-model-fallback` with `cause: "plan-invalid-reply"`;
    - **cross-run:** when the card's most recent park was `plan-invalid`, it starts on Fable and
      journals `plan-model-fallback` with `cause: "prior-plan-invalid-park"`.
  - Transport failures and deadline kills never fall back.
- **Hypothesis:** Opus plans well enough that downstream cost per merged card does not rise, and
  PLAN's own quota cost drops. A second effect: Fable-quota exhaustion stops blocking cards at
  PLAN, because a Fable limit cools the whole account (#483).
- **Baseline** (Fable, all PLAN calls up to 2026-09-13,
  `node scripts/model-report.js --until=2026-09-13`; medians over all calls, failed ones included):

  | PLAN cell | calls | ok | duration | billable tokens | turns |
  |---|---|---|---|---|---|
  | fable/low (S) | 103 | 98 | 217s | 83,596 | 26 |
  | fable/medium (M) | 66 | 57 | 473s | 164,428 | 49 |
  | fable/high (L) | 8 | 3 | 825s | 311,387 | 64 |

  The fable/high `ok` count includes #486's pre-raise deadline kills. `turns` is the CLI's
  `num_turns` (agentic-loop turns, not API requests). Card #214 stops journalling it: once that is
  deployed, `medianTurns` covers only the calls that still carry the field, a subset of the cell's
  `n`, and is null for a cell made entirely after the deploy. Do not compare this column across it.

  | Cards planned on Fable | cards | done | parked at PLAN | IMPLEMENT calls / done | DIAGNOSE calls / done | median billable / done |
  |---|---|---|---|---|---|---|
  | up to 2026-09-13 | 129 | 101 | 2 | 1.71 | 0.40 | 300,668 |

- **Metrics that settle it** (`--since=<start>`):
  1. **Fallback rate** = `planFallbacks["plan-invalid-reply"]` ÷ Opus PLAN calls.
  2. **Downstream quality** = IMPLEMENT calls and DIAGNOSE calls per done card in
     `cardsByPlanModel.opus`, compared with the baseline row above.
  3. **PLAN parks:** `parkedAtPlan` share, and any `llm-transport-failed:PLAN` with `timedOut` on
     an Opus call (this would mean the deadline no longer fits the raised effort).
  4. **PLAN duration** per cell against the 1,800,000ms deadline, L especially.
- **Minimum sample:** 10 done cards planned on Opus, or 3 weeks from the start, whichever comes first.
- **Revert criterion.** Revert to Fable-only at low/medium/high, or keep Opus and restore the old
  effort map if only the duration criterion fails, when any of these holds:
  - the fallback rate is above **20 %**: the double call eats the saving;
  - IMPLEMENT calls per done card rise above **2.1**, or DIAGNOSE calls per done card above **0.6**
    (about +25 % and +50 % on the baseline; DIAGNOSE is noisier at this n);
  - more than **one** Opus PLAN call is killed by the deadline.

  Otherwise **adopt**, and move this entry to *Settled decisions*.
- **Watch for:** Opus planning M cards at `high` costing more than Fable did at `medium`. The cell
  comparison in `calls` shows it in billable tokens and duration (not turns, see the baseline note).
  `spo tokens --usage-delta` counts requests per step, but over all models and all dates, so it
  cannot split Opus from Fable. It is a reason to try M → medium before reverting the model.
- **Verdict log:** *(none yet)*

### EXP-IMPLEMENT-S-MEDIUM — IMPLEMENT's S cards at `medium` instead of `low`

- **Started:** 2026-09-04. `IMPLEMENT_EFFORT_BY_SIZE` = S/M/L → medium/medium/high.
- **Why:** `low` is below the CLI's own default for agentic coding, and IMPLEMENT is the only step
  that writes code. This is a reason to try it, not evidence that it wins. Full reasoning is in the
  comment on that map.
- **Baseline:** S → low, 4 merged cards, 11 IMPLEMENT calls (2.75 per card), mean 436,445 billable.
- **Settles when:** about 8 S-sized merged cards at `medium`. **Revert** to S → low if IMPLEMENT calls
  per merged card do not fall below about 2.0.
- **Verdict log:** *(none yet)*. This is the first entry an audit should close, since it has had
  the longest time to collect a sample.

## Settled decisions (context for audits, not on trial)

| Step | Choice | Since | Why, in one line |
|---|---|---|---|
| IMPLEMENT | Sonnet 5, **Opus 5** on RDO catalogue signals, L size, or a retry after DIAGNOSE/VALIDATE reject | card #213, 2026-09-12 | escalate on evidence (diff, plan declaration, observed difficulty), not on the intake guess |
| DIAGNOSE | Opus 5, high | 2026-09-04 (was Fable 5) | half the token price, and fewer steps sharing Fable's quota; 8/8 after the switch |
| VALIDATE change-validator | Fable 5, high; **xhigh** when the real diff touched the RDO catalogue | 2026-09-04 / card #213 | the judge must never be the executor's model or a weaker one; escalate effort, not model (card #462) |
| VALIDATE citation-verifier | Fable 5, high | — | runs only when the real diff touched the RDO catalogue |
| triage-bug-report (intake) | Opus 5, medium | 2026-08-31 (was Fable 5) | maintainer decision |
| draft-card / review-card (intake) | Sonnet 5 medium drafts, Fable 5 high reviews | — | the reviewer is deliberately a different model from the drafter |
| Driver sessions (chantiers) | Sonnet builder (medium), Opus verifier (high); audits are a Fable 5.1 sweep with every finding re-probed by Opus | — | `CLAUDE.md` § Working a chantier |

A settled decision can still be re-opened by an audit. Doing so moves it back up as an open entry,
with a baseline, before anything changes.
