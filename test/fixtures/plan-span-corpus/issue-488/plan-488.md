# Plan — issue 488: level badge, past-Legend condition, missed-requirement banner

Skills used: none (direct reads only).

## What is wrong

The Curriculum section's current-level card (`/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/ProfilePanel.tsx:293-311`) renders only the header, the level name, the description and the upgrade checkbox. The reference page `~/SPO-ASP/Five/0/Visual/Voyager/NewTycoon/TycoonCurriculum.asp` renders three more things inside the same `<td>` that the gateway never parses and the client never shows:

- `:228-236` — the level badge image, `images/level<Name>.gif` at tier ≤ 5 and `images/levelLegendX.gif` past it (both 80×80).
- `:245-249` — a second bare `<div class=label>` holding `Obj.LevelCond`, rendered **only when `Obj.CurrLevel > 5`**, directly after the description div.
- `:262-266` — a `<div class=label style="… background-color: maroon; font-weight: bold">` holding `Obj.LevelReqStatus` followed by a literal `.`, rendered only when that string is non-empty.

`CurriculumData` (`/home/crazz/SPO-Pipeline/worktrees/issue-488/src/shared/types/domain-types.ts:814-842`) has no field for any of them.

**This is not a rewrite of existing behaviour.** Every existing field keeps its parser and its value; three fields are added beside them. The description regex at `profile-finance-handler.ts:253` is not touched.

## Changes

### 1. `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/shared/types/domain-types.ts`

Add three required fields to `CurriculumData`, right after `currentLevelDescription`:

```ts
  /** Proxied URL of the level badge (TycoonCurriculum.asp:228-236), '' when the page has none. */
  currentLevelBadgeUrl: string;
  /** Obj.LevelCond — rendered only past level 5 (TycoonCurriculum.asp:245-249), '' otherwise. */
  currentLevelCondition: string;
  /** Obj.LevelReqStatus — the maroon banner (TycoonCurriculum.asp:262-266), '' when absent. */
  levelReqStatus: string;
```

Required (not optional) so that every fixture literal of `CurriculumData` is forced by `npm run typecheck` to carry them — the three existing literals are listed under "fixtures" below.

### 2. `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/server/session/profile-finance-handler.ts` — `parseCurriculumDetails`

Insert after the `levelDescMatch` block (after line 260) and before the "Next level name" block; add the three fields to the returned object next to `currentLevelDescription` (line 364).

**Badge.** Reuse the same `images/level(\w+)\.gif` shape `parseCurriculumHtml` uses at line 152 (the first match on the page is the current level's image: the next-level column emits `level<Name>Disabled.gif`, which appears later). Resolve it against the page URL with the WHATWG `URL` class, which handles the `?RIWS=` query and the file name correctly (prototyped: `new URL('images/levelParadigm.gif', 'http://158.69.153.134/Five/0/Visual/Voyager/NewTycoon/TycoonCurriculum.asp?RIWS=').href` is `http://158.69.153.134/Five/0/Visual/Voyager/NewTycoon/images/levelParadigm.gif`). Serve it through the existing `/proxy-image?url=` route exactly as `fetchTycoonProfile` does for the avatar at line 111 (`/home/crazz/SPO-Pipeline/worktrees/issue-488/src/server/proxy-image.ts` already allows the world host). When `baseUrl` is empty (the re-fetch threw) or there is no image match, the field is `''`. Wrap the `new URL(...)` in a try so a malformed `baseUrl` yields `''` rather than throwing.

```ts
  let currentLevelBadgeUrl = '';
  const badgeMatch = /images\/level(\w+)\.gif/i.exec(html);
  if (badgeMatch && baseUrl) {
    try {
      currentLevelBadgeUrl = `/proxy-image?url=${encodeURIComponent(new URL(badgeMatch[0], baseUrl).href)}`;
    } catch { /* unusable page URL — no badge */ }
  }
```

**Condition.** Anchor on the description match instead of writing a second free search: the LevelCond div is the very next tag after the description's closing `</div>` (`:245-249`) and is the only *bare* `<div class=label>` that can follow it — the upgrade box (`:250-260`) and the banner (`:262-266`) both carry a `style=` attribute. So, from `levelDescMatch.index + levelDescMatch[0].length`, match `^\s*<div\s+class=label>\s*([\s\S]*?)\s*<\/div>` on the remainder; strip tags and collapse whitespace as the description does. No match → `''`. This is where the "past tier 5 / at or below tier 5" rule comes from: the page decides (`Obj.CurrLevel > 5`), the parser reports what is present, and the client shows it when non-empty. The parser does not consult `currentLevel` itself.

**Banner.** Match the maroon div anywhere in the page (there is exactly one, `:263`):
`/<div\s+class=label\s+style="[^"]*background-color:\s*maroon[^"]*">\s*([\s\S]*?)\s*<\/div>/i`. Strip tags, collapse whitespace, trim. Keep the trailing `.` the ASP appends at `:264` — it is what the reference client shows. No match → `''`.

### 3. `/home/crazz/SPO-Pipeline/worktrides/issue-488` — correction: the client file is `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/ProfilePanel.tsx`

In the current-level card (lines 293-311):

- Before `levelName`, when `data.currentLevelBadgeUrl` is non-empty: `<img className={styles.levelBadge} src={data.currentLevelBadgeUrl} alt={`${data.currentLevelName} level badge`} width={80} height={80} />`.
- After the description div, when `data.currentLevelCondition` is non-empty: `<div className={styles.levelCondition}>{data.currentLevelCondition}</div>`.
- After the closing `</div>` of the current-level card (still inside `.levelSection`, before the next-level card), when `data.levelReqStatus` is non-empty: `<div className={styles.levelReqStatus} role="alert">{data.levelReqStatus}</div>`. All three are conditional on a non-empty string, so an absent value produces no element and no empty space.

### 4. `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/ProfilePanel.module.css`

Add next to `.levelDesc` (line 857):

```css
.levelBadge {
  display: block;
  width: 80px;
  height: 80px;
  margin-bottom: var(--space-2);
}

.levelCondition {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: var(--space-2);
}

/* Obj.LevelReqStatus — TycoonCurriculum.asp:263 renders it white on maroon, bold, centred. */
.levelReqStatus {
  background: maroon;
  color: #fff;
  font-weight: var(--font-bold);
  font-size: var(--text-xs);
  text-align: center;
  padding: var(--space-2);
  border-radius: var(--radius-md);
}
```

### 5. Tests

**L0 server — `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/server/session/profile-finance-handler.test.ts`.** The `curriculumPage()` fixture already emits the `:245-249` div when `levelCond` is non-empty (line 286) and the `:262-266` maroon div when `levelReqStatus` is non-empty (lines 288-290), and the badge `<img>` at line 282. Add, inside `describe('fetchCurriculumData')`, one test driven by a four-entry table `[levelCond, levelReqStatus] ∈ {'', 'Keep 10 wonders.'} × {'', 'Prestige is falling'}` (use `currLevel: 6` when `levelCond` is set, so the fixture is the page's own shape). For each combination assert:

- `currentLevelDescription === 'You are a paradigm of industry.'` (unchanged in all four);
- `currentLevelCondition === 'Keep 10 wonders.'` or `''`;
- `levelReqStatus === 'Prestige is falling.'` or `''` (note the ASP's appended period);
- `currentLevelBadgeUrl === '/proxy-image?url=' + encodeURIComponent('http://158.69.153.134/Five/0/Visual/Voyager/NewTycoon/images/levelLegendX.gif')` at level 6, `…/levelParadigm.gif` at the default level 4.

Also assert the "with sections absent" case (existing test at line 738) yields `''` for all three, and that a page whose re-fetch failed (existing test at line 801) yields `currentLevelBadgeUrl === ''`. Update the `toEqual` literal at lines 564-600 with the three new fields (`currentLevelBadgeUrl` for `levelParadigm.gif`, the other two `''`). The existing test at line 673 stays as it is.

**Component — `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/__tests__/profile-panel-sections.test.tsx`.** Add the three fields to `CURRICULUM_BASE` (badge `'/proxy-image?url=x'`, the other two `''`). Add tests, on the pattern of the Ability ones at lines 165-197: the badge `<img>` is present with the given `src` (`getByAltText(/level badge/)`), and absent when the URL is `''`; the condition text shows when set and not otherwise; the banner (`getByRole('alert')`) shows when `levelReqStatus` is set and `queryByRole('alert')` is `null` otherwise.

**Fixtures** that must gain the three fields for `npm run typecheck`: `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/store/profile-store.test.ts` (`mockCurriculum`, line 9) and the two files above.

## Why this satisfies the criterion

- Badge: parsed from the page's own `<img>` and shown through the proxy already used for the avatar.
- Condition: present exactly when the page rendered `:245-249`, which the page does only past level 5; hidden otherwise because the string is empty and the element is conditional.
- Banner: present exactly when `:262-266` rendered; distinct through the maroon/white style the reference page uses; absent → no element.
- L0 unit: the four-combination test in the named file asserts both new fields and the untouched description.

## Files to change

- `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/shared/types/domain-types.ts`
- `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/server/session/profile-finance-handler.ts`
- `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/server/session/profile-finance-handler.test.ts`
- `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/ProfilePanel.tsx`
- `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/ProfilePanel.module.css`
- `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/__tests__/profile-panel-sections.test.tsx`
- `/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/store/profile-store.test.ts`

## Check commands

Run from `/home/crazz/SPO-Pipeline/worktrees/issue-488`, each read by exit code only:

```bash
node -e "const u=new URL('images/levelParadigm.gif','http://158.69.153.134/Five/0/Visual/Voyager/NewTycoon/TycoonCurriculum.asp?RIWS=');process.exit(u.href==='http://158.69.153.134/Five/0/Visual/Voyager/NewTycoon/images/levelParadigm.gif'?0:1)"
npm run verdict -- typecheck
npm run verdict -- lint
npm run verdict -- coverage:changed
! grep -rqE "LevelReqStatus|levelReqStatus|currentLevelCondition|currentLevelBadgeUrl|levelBadge" doc/ .claude/ CLAUDE.md
! grep -rqE "level badge|maroon" doc/ CLAUDE.md
```

The first proves the badge-URL resolution the design relies on. The last two are the falsification sweep: nothing in `doc/`, `.claude/` or `CLAUDE.md` claims the badge, condition or banner already work or work differently (both prototyped: exit 0 today).
