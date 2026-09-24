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

### EXP-IMPLEMENT-OPUS-5-5 — IMPLEMENT on Opus 5.5 at low/medium; every `opus` step moves to Opus 5.5

- **Started:** 2026-09-23 (deploy = the `git pull` in `~/SPO-Pipeline` that brings this change in).
  The first IMPLEMENT `llm-call` with `model: "claude-opus-5-5"` in the journal is the real start.
- **Decided by:** the maintainer: "Opus 5.5 for the coding agent in place of Sonnet 5", "try Opus
  5.5 at low or medium effort on a few real tasks", "replace also all Opus 5 for Opus 5.5 with same
  level of effort". Sonnet stays for high-volume mechanical work (DRAFT_CARD is unchanged).
- **What changed** (`orchestrator/step-contracts.js`):
  - A constant `OPUS_5_5 = 'claude-opus-5-5'`, the full model id. The `opus` alias is **not**
    used: all 372 `opus` calls in the journal up to 2026-09-22 resolved to `claude-opus-5`.
  - **IMPLEMENT:** `baseModel` `sonnet` → `OPUS_5_5`; the model escalation (`escalatedModel:
    'opus'`) is gone, since Opus 5.5 → Opus 5 would be a downgrade. The four triggers
    (`planDeclaresRdoMembers` with its three sources, `lSize`, `diagnoseOrValidateRetry`) now raise
    **effort** to `medium` instead (`escalatedEffort`/`escalatesEffortOn`, resolved by the same
    `escalationSignalFires` that `shouldEscalate` uses). `IMPLEMENT_EFFORT_BY_SIZE` = S/M/L →
    **low/medium/medium**, so `low` only runs on a plain S card with no signal.
  - **PLAN, DIAGNOSE, triage-bug-report:** `opus` → `OPUS_5_5`, efforts unchanged (PLAN
    medium/high/high, DIAGNOSE high, triage medium). PLAN's Fable fallback is unchanged.
- **Confound for EXP-PLAN-OPUS:** its Opus arm changes model version mid-experiment. Compare the
  `cardsByPlanModel.opus` rows (Opus 5) and `cardsByPlanModel["claude-opus-5-5"]` separately.
- **Baseline** (IMPLEMENT, `node scripts/model-report.js --step=IMPLEMENT --since=2026-09-13
  --until=2026-09-23`, medians over all calls, measured 2026-09-23):

  | IMPLEMENT cell | calls | ok | duration | billable tokens |
  |---|---|---|---|---|
  | sonnet/medium | 84 | 74 | 544s | 121,319 |
  | opus/medium (escalated) | 36 | 35 | 451s | 89,957 |
  | opus/high (escalated, L) | 5 | 5 | 1,338s | 245,751 |

  Cards planned on Opus 5 over the same window: 56 cards, 49 done, **1.76 IMPLEMENT calls and 0.29
  DIAGNOSE calls per done card**, median 337,076 billable per done card.
- **Metrics that settle it** (`--since=<start>`): IMPLEMENT ok rate per cell; IMPLEMENT and
  DIAGNOSE calls per done card; median billable per done card; IMPLEMENT duration against its
  1,800,000ms deadline. Tokens are not comparable across models as quota cost — read that from the
  account usage dashboards.
- **Minimum sample:** "a few real tasks" (maintainer) — 5 done cards for a first look, 10 to adopt.
- **Revert criterion.** Back to Sonnet 5 base with the old escalation when either holds:
  IMPLEMENT calls per done card above **2.1**, or DIAGNOSE calls per done card above **0.45**
  (about +20 % and +50 % on the baseline). If quality holds but the S/`low` cell alone is worse,
  raise S to `medium` before touching the model.
- **Verdict log:**
  - **2026-09-24 — not yet (0 of 5 done cards; the experiment has not started).** The change is
    deployed since 2026-09-23T08:49Z (`6f35e10`, the first release containing `5f96690`), but the
    journal holds no `llm-call` with `model: "claude-opus-5-5"`: the last `llm-call` of any kind
    is 2026-09-22T08:58Z, and no card journal has moved since 2026-09-22 (last event 11:32Z, an
    unpark scan). The daemon queue is empty: project 1 has had no card outside Done since. The baseline re-derives unchanged
    (`--step=IMPLEMENT --since=2026-09-13 --until=2026-09-23`: sonnet/medium 84/74, opus/medium
    36/35, opus/high 5/5; `cardsByPlanModel.opus` 56 cards / 49 done, 1.76 / 0.29, 337,076).
  - **For the next audit:** `cardsByPlanModel` groups a card by the model of its *last* PLAN call
    and windows it on its *first*. A card implemented on Opus 5.5 but planned on Opus 5 (its plan
    reused on a re-run, `decidePlanReuse`) lands in the `opus` group, and a card first planned
    before the deploy falls outside a `--since=<deploy>` window entirely, whatever model re-planned
    it; split those by the IMPLEMENT call's own `model` in the journal. IMPLEMENT max durations,
    for the deadline metric, also need the journal: the script prints medians only.

### EXP-PLAN-OPUS — PLAN on Opus first, Fable as fallback, one effort rung up

> **Adopted 2026-09-24 on its Opus 5 arm** (see *Verdict log* and *Settled decisions*). Its numbers
> stay as the Opus 5 record. The Opus 5.5 arm has 0 PLAN calls and no criterion of its own yet:
> EXP-IMPLEMENT-OPUS-5-5 moved PLAN to Opus 5.5 but measures IMPLEMENT only.

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
  PLAN — as originally written, "because a Fable limit cools the whole account (#483)".
  **That stated mechanism no longer holds** (card #167, 2026-09-22): a limit now cools only the
  `(account, model)` pair it fired on, so a Fable limit leaves that account's Opus quota intact.
  The second effect itself survives, on the narrower and still-true reason it always really had:
  a PLAN that does not call Fable at all is unaffected by Fable being exhausted **pool-wide**,
  which is the case a per-model cooldown cannot help with (SPO-Pipeline#166). The verdict below
  must not be read as evidence for the retired mechanism.
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
- **Verdict log:**
  - **2026-09-24 — adopt, on the Opus 5 arm.** `node scripts/model-report.js --since=2026-09-13`;
    no card journal has moved since 2026-09-22 (last `llm-call` 08:58Z, last event 11:32Z).
    Sample: **49 done cards** planned on Opus 5 (minimum 10). Each criterion:
    - **Fallback rate: 0 of 76** Opus PLAN calls. `planFallbacks` is empty: no
      `plan-invalid-reply`, no `prior-plan-invalid-park` (threshold 20 %).
    - **Downstream quality:** `cardsByPlanModel.opus` = 56 cards, 49 done, 0 parked at PLAN,
      **1.76 IMPLEMENT and 0.29 DIAGNOSE calls per done card** (thresholds 2.1 / 0.6; Fable
      baseline 1.71 / 0.40), median 337,076 billable per done card.
    - **Deadline kills: 0.** 76 of 76 Opus PLAN calls `ok`; no `llm-transport-failed:PLAN` in the
      journal since 2026-09-05 (threshold: more than one).
    - **Duration** against 1,800,000ms: opus/medium (S) n=48, median 326s, max 781s; opus/high
      (M+L) n=28, median 1,023s, max 1,505s (#752, 84 % of the deadline).
    - **Robustness:** 4 of the 56 cards were first planned on Fable on the deploy day, then
      re-planned on Opus (#593, #596, #598, #601); `cardsByPlanModel` files a card under its
      *last* PLAN model. Without them: 52 cards, 45 done, 1.49 / 0.11. Same verdict.
    - **Confound:** IMPLEMENT's escalation changed on 2026-09-12 (card #213), so 1.76 / 0.29
      against the Fable baseline is not a same-conditions comparison. The criterion is the revert
      threshold, not the baseline, and both numbers sit under it.
    - **Opus 5.5 arm: 0 PLAN calls** on `claude-opus-5-5` — nothing ran after the 2026-09-23
      deploy. Nothing to judge, and no criterion of its own yet: EXP-IMPLEMENT-OPUS-5-5 moved PLAN
      to Opus 5.5 but measures IMPLEMENT only.
    - **Watch-for (not a criterion):** opus/high (M+L)'s 1,023s median against Fable M/medium's 473s
      (486,636 against 164,428 median billable, not comparable across models as quota cost). No
      criterion fails, so M → medium stays an option, not a remedy.

### EXP-IMPLEMENT-S-MEDIUM — IMPLEMENT's S cards at `medium` instead of `low`

> **Closed without a verdict, 2026-09-23.** It was measured on Sonnet 5, and IMPLEMENT no longer
> runs Sonnet (EXP-IMPLEMENT-OPUS-5-5, above, puts S back at `low` on Opus 5.5). Its numbers stay
> as the Sonnet-era record; do not judge it against Opus 5.5 calls.

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
| PLAN | Opus 5.5 first (Opus 5 until 2026-09-23), **Fable 5** fallback on a plan-invalid reply or a prior plan-invalid park; S/M/L → medium/high/high | 2026-09-13 (was Fable 5, low/medium/high) | EXP-PLAN-OPUS, adopted 2026-09-24 on its Opus 5 arm: 0 of 76 calls fell back, 0 deadline kills, 1.76 IMPLEMENT / 0.29 DIAGNOSE calls per done card over 49 done cards (revert thresholds 2.1 / 0.6). Opus 5.5 is unmeasured for PLAN (0 calls, no criterion yet) |
| IMPLEMENT (history) | Sonnet 5, **Opus 5** on RDO catalogue signals, L size, or a retry after DIAGNOSE/VALIDATE reject | card #213, 2026-09-12 → 2026-09-22 | escalate on evidence (diff, plan declaration, observed difficulty), not on the intake guess. Superseded by EXP-IMPLEMENT-OPUS-5-5; the same triggers now raise effort |
| DIAGNOSE | Opus 5.5, high (Opus 5 until 2026-09-23) | 2026-09-04 (was Fable 5) | half the token price, and fewer steps sharing Fable's quota; 8/8 after the switch |
| VALIDATE change-validator | Fable 5, high; **xhigh** when the real diff touched the RDO catalogue | 2026-09-04 / card #213 | the judge must never be the executor's model or a weaker one; escalate effort, not model (card #462) |
| VALIDATE citation-verifier | Fable 5, high | — | runs only when the real diff touched the RDO catalogue |
| triage-bug-report (intake) | Opus 5.5, medium (Opus 5 until 2026-09-23) | 2026-08-31 (was Fable 5) | maintainer decision |
| draft-card / review-card (intake) | Sonnet 5 medium drafts, Fable 5 high reviews | — | the reviewer is deliberately a different model from the drafter |
| Driver sessions (chantiers) | Opus 5.5 builder (low/medium), Sonnet 5 or Haiku only for high-volume mechanical work; Opus 5.5 verifier (high); audits are a Fable 5.1 sweep with every finding re-probed by Opus 5.5 | 2026-09-23 (Sonnet builder until then) | `CLAUDE.md` § Working a chantier |

A settled decision can still be re-opened by an audit. Doing so moves it back up as an open entry,
with a baseline, before anything changes.
