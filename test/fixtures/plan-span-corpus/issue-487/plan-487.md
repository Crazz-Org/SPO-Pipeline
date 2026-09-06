# Plan — issue 487: show the Ability score and its three components on tournament worlds

## Problem

`TycoonCurriculum.asp` renders an extra "Ability" block when `Obj.TournamentOn = "1"`
(`/home/crazz/SPO-ASP/Five/0/Visual/Voyager/NewTycoon/TycoonCurriculum.asp:162-174`): the total
`RankingPoints + LevelPoints + LoanPoints` followed, in parentheses, by the three components. The
three inputs are coerced from blank to 0 at `:37-53` (`Obj.rkPts` / `Obj.lvPts` / `Obj.bnkPts`).
The legacy captions come from `/home/crazz/SPO-ASP/Five/0/language/eNewTycon.lng`:
`strAbilityPoints="Ability"` (:126), `strAbilityRanking="from the rankings"` (:127),
`strAbilityLevel="for being at the highest level"` (:128), `strAbilityLoans="for having loans"`
(:129), `StrTycoonCurriculum_4="points"` (:72).

The WebClient's curriculum parser
(`/home/crazz/SPO-Pipeline/worktrees/issue-487/src/server/session/profile-finance-handler.ts`,
`parseCurriculumDetails`) never reads this block, so on a tournament world the Ability score is
silently dropped. This is an **additive change, not a rewrite of existing behaviour** — no
existing parse or render path changes meaning; the equivalence/degenerate-input `comm` checks are
therefore omitted.

## What changes

### 1. `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/shared/types/domain-types.ts`

Extend `CurriculumData` (declared at `:814`) with five required fields:

```ts
tournamentOn: boolean;
abilityTotal: number;
abilityRankingPoints: number;
abilityLevelPoints: number;
abilityLoanPoints: number;
```

### 2. `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/server/session/profile-finance-handler.ts`

In `parseCurriculumDetails` (private, currently returns the object literal at `:347-370`), parse
the Ability block and add the five fields to the returned object. The rendered markup (from the
ASP at `:162-174`) is: label `Ability:` then a `<span class=value>` holding
`<total>  points` then `&nbsp(` then `<n>&nbsp<caption>,` for each component — note the ASP emits
the literal string `&nbsp` with **no trailing semicolon**. Prototyped regex (verified against the
rendered shape, including a blank component):

```ts
const abilityMatch = /Ability\s*:\s*(?:<[^>]*>\s*)*(\d+)\s*points[\s\S]*?\(\s*(\d*)(?:&nbsp;?|\s)*from the rankings\s*,\s*(\d*)(?:&nbsp;?|\s)*for being at the highest level\s*,\s*(\d*)(?:&nbsp;?|\s)*for having loans/i.exec(html);
```

- `tournamentOn = abilityMatch !== null` — the block is rendered exactly under
  `Obj.TournamentOn = "1"`, so its presence IS the tournament signal.
- Each of the four numbers: `parseInt(m[i], 10) || 0`. The `(\d*)` component groups accept an
  empty match, satisfying the blank-tolerance criterion (the legacy coerces blanks to 0 at
  `TycoonCurriculum.asp:37-53`; we mirror that at parse time).
- No match → `tournamentOn: false` and all four numbers 0.

Cite `TycoonCurriculum.asp:162-174`, `:37-53` and the `eNewTycon.lng` lines in the comment, in
the file's existing style. No RDO is touched anywhere in this plan — `rdo-members.ts` is not
changed.

### 3. `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/server/session/profile-finance-handler.test.ts`

- Extend `CurriculumOpts` and the `curriculumPage()` fixture builder with
  `tournamentOn?: boolean` (default `false`) and
  `abilityPoints?: [string, string, string]` (rendered verbatim, so a component can be blank).
  When on, insert — between the Nobility `currStat` and the FullAccess button block, matching the
  ASP order at `:142-174` — the Ability block, reusing the existing `currStat` helper shape but
  written out literally so the `&nbsp(`/`&nbsp` markup of `:165-172` is preserved
  byte-for-byte (tabs via `T(n)`, no semicolon after `&nbsp`).
- New test A (tournament world): `curriculumPage({ tournamentOn: true, abilityPoints: ['10', '', '5'] })`
  with a rendered total of `15  points` — assert
  `{ tournamentOn: true, abilityTotal: 15, abilityRankingPoints: 10, abilityLevelPoints: 0, abilityLoanPoints: 5 }`.
  The blank middle component pins the blank-coercion criterion.
- New test B (non-tournament world): already covered by the default `CURRICULUM_HTML` — extend
  the full `toEqual` at `:532` with `tournamentOn: false, abilityTotal: 0,
  abilityRankingPoints: 0, abilityLevelPoints: 0, abilityLoanPoints: 0` (that expect compares the
  whole object, so it fails to compile/pass without them). Add one explicit
  `expect(data.tournamentOn).toBe(false)` line in that test so the criterion's second fixture
  assertion is stated, not implied.

### 4. `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/client/components/empire/ProfilePanel.tsx`

In `CurriculumTab` (Section 1, the `statGrid` at `:223-228`), when `data.tournamentOn`:

- add `<StatCard label="Ability" value={`${data.abilityTotal} points`} />` to the grid
  (caption "Ability" = `strAbilityPoints`, unit "points" = `StrTycoonCurriculum_4`);
- immediately after the grid, render one full-width line with the three components and their
  legacy captions:
  `{data.abilityRankingPoints} from the rankings, {data.abilityLevelPoints} for being at the highest level, {data.abilityLoanPoints} for having loans`
  in a `<div className={styles.abilityBreakdown}>`.

When `data.tournamentOn` is false, render nothing new — no empty card, no zeros (criterion 2).

### 5. `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/client/components/empire/ProfilePanel.module.css`

Add one `.abilityBreakdown` class (small muted text, matching the panel's existing label
styling — copy the font/color values the file already uses for its stat labels).

### 6. Client test fixtures

- `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/client/store/profile-store.test.ts` — the
  `mockCurriculum: CurriculumData` literal at `:9-32` must gain the five new fields
  (`tournamentOn: false`, zeros) or the tests no longer compile.
- `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/client/components/empire/__tests__/profile-panel-sections.test.tsx`
  — two new component tests, following the file's existing pattern (`clickSection('Curriculum')`
  then `act(() => useProfileStore.getState().setCurriculum({...}))`):
  one with `tournamentOn: true` asserting the "Ability" card, the total, and the caption
  "from the rankings" are on screen; one with `tournamentOn: false` asserting
  `screen.queryByText(/from the rankings/)` is null. These cover the new ProfilePanel lines for
  the ≥93 % changed-lines ratchet.

No plumbing is needed between server and client: the ws handler sends the whole `CurriculumData`
(`/home/crazz/SPO-Pipeline/worktrees/issue-487/src/server/ws-handlers/profile-handlers.ts:34-39`)
and the store saves it wholesale
(`/home/crazz/SPO-Pipeline/worktrees/issue-487/src/client/store/profile-store.ts:78`).

## Why this satisfies the criterion

1. Tournament world → the parser matches the `:162-174` block, `tournamentOn: true`, and the
   Curriculum tab shows the total plus the three components under the legacy captions.
2. Non-tournament world → no match, `tournamentOn: false`, `CurriculumTab` renders exactly what
   it renders today.
3. Blank components → `(\d*)` + `parseInt(...) || 0`, mirroring `TycoonCurriculum.asp:37-53`.
4. The two required L0 fixtures live in
   `src/server/session/profile-finance-handler.test.ts` as tests A and B above.

## Check commands

Run all from `/home/crazz/SPO-Pipeline/worktrees/issue-487`; judge every one on its exit code only.

```bash
node -e 'const html=`<div class=label style="margin-left: 20px; margin-top: 5px; margin-bottom: 20px">\n\tAbility:\n\t<span class=value>\n\t\t30  points\n\t\t\t&nbsp(\n\t\t\t\t10&nbspfrom the rankings,\n\t\t\t\t&nbspfor being at the highest level,\n\t\t\t\t5&nbspfor having loans\n\t\t\t)\n\t</span>\n</div>`;const m=/Ability\s*:\s*(?:<[^>]*>\s*)*(\d+)\s*points[\s\S]*?\(\s*(\d*)(?:&nbsp;?|\s)*from the rankings\s*,\s*(\d*)(?:&nbsp;?|\s)*for being at the highest level\s*,\s*(\d*)(?:&nbsp;?|\s)*for having loans/i.exec(html);process.exit(m&&m.slice(1).map(x=>parseInt(x,10)||0).join(",")==="30,10,0,5"?0:1);'
npm run typecheck
npm run lint
npm run coverage:changed
! grep -rniE '\bability (score|points|block)\b|tournamenton|abilitytotal' doc/ CLAUDE.md src/server/CLAUDE.md src/client/CLAUDE.md src/shared/CLAUDE.md
```

The first command proves the parse design executes against the exact rendered shape (blank
middle component included). The last is the falsification sweep: no doc or CLAUDE.md claims
anything about the tournament Ability ground (verified — it currently exits 0), so nothing
documented elsewhere contradicts this change.

Skills used: none (direct tools only).
