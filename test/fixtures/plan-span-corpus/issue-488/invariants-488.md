# Invariants — issue 488

Facts about the existing code this plan depends on. All paths are relative to `/home/crazz/SPO-Pipeline/worktrees/issue-488`.

The description regex must stay byte-identical: the condition parser is anchored on its match, and the criterion asserts the description is unchanged.

## INV-1
File: src/server/session/profile-finance-handler.ts:253
>>> QUOTE
  const levelDescMatch = /<td[^>]*valign="top"[^>]*align="left"[^>]*width=190>[\s\S]*?<div\s+class=label>\s*([\s\S]*?)\s*<\/div>/i.exec(html);
>>> END QUOTE

The parser signature the new fields are computed inside, with `baseUrl` available for the badge URL.

## INV-2
File: src/server/session/profile-finance-handler.ts:221-228
>>> QUOTE
function parseCurriculumDetails(
  ctx: SessionContext,
  html: string,
  profile: TycoonProfileFull,
  level: number,
  levelNames: string[],
  baseUrl: string
): CurriculumData {
>>> END QUOTE

The avatar's proxy form, which the badge reuses.

## INV-3
File: src/server/session/profile-finance-handler.ts:111
>>> QUOTE
        profile.photoUrl = `/proxy-image?url=${encodeURIComponent(fullUrl)}`;
>>> END QUOTE

The fixture already emits the LevelCond div and the maroon banner in the page's own shape; the four-combination test drives these two options.

## INV-4
File: src/server/session/profile-finance-handler.test.ts:285-290
>>> QUOTE
      + `${T(7)}<div class=label>\n${T(8)}${o.levelDesc}\n${T(7)}</div>\n`
      + (o.levelCond ? `${T(8)}<div class=label>\n${T(9)}${o.levelCond}\n${T(8)}</div>\n` : '')
      + (advanceBox ? `${advanceBox}\n` : '')
      + (o.levelReqStatus
        ? `${T(8)}<div class=label style="color: white; margin-top: 7px; text-align: center; padding: 7px; background-color: maroon; font-weight: bold">\n${T(9)}${o.levelReqStatus}.\n${T(8)}</div>\n`
        : '')
>>> END QUOTE

The mocked page URL the badge resolves against.

## INV-5
File: src/server/session/profile-finance-handler.test.ts:79
>>> QUOTE
    .mockImplementation((aspPath: string) => `http://158.69.153.134/Five/0/Visual/Voyager/${aspPath}?RIWS=`);
>>> END QUOTE

The existing description field stays on the shared type; the new fields sit beside it.

## INV-6
File: src/shared/types/domain-types.ts:817-818
>>> QUOTE
  currentLevelName: string;
  currentLevelDescription: string;
>>> END QUOTE

The card the badge, condition and banner attach to.

## INV-7
File: src/client/components/empire/ProfilePanel.tsx:294-299
>>> QUOTE
        <div className={styles.levelCard}>
          <div className={styles.levelHeader}>Current Level</div>
          <div className={styles.levelName}>{data.currentLevelName}</div>
          {data.currentLevelDescription && (
            <div className={styles.levelDesc}>{data.currentLevelDescription}</div>
          )}
>>> END QUOTE
