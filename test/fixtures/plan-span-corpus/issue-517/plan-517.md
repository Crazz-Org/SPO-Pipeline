# Plan 517 — Media section in the directory: every newspaper in the world, one row per paper

## What is wrong today

The directory panel (`/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/components/search/SearchPanel.tsx`) offers Towns, People, Rankings and Banks — a client-side literal at `:21-26` — and nothing that lists newspapers. The only way to a paper is the Town Hall inspector's Overview tab (`/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/components/politics/OverviewSection.tsx:44-54`), which needs the player to focus that town's hall on the map. The legacy client had a "Media" page, `~/SPO-ASP/Five/0/Visual/Voyager/New Directory/Newspapers.asp`: IIS browses the world's `Newspapers\` cache folder (`:62`, `Browse.inc:17-30`) and renders one `<tr … dirHref="../../news/newsreader.asp?…&TownName=<town>&PaperName=<paper>…">` per paper (`:12-24`), the paper name in a `<div class=listItem>` (`:19-21`). That browse is IIS-side file iteration, not an RDO call — so the WebClient reaches it the same way it reaches Towns.asp and Banks.asp: an HTTP scrape by `SearchMenuService`.

**This is not a rewrite of existing behaviour.** Everything here is new ground added beside the existing directory pages and the existing newspaper reader; nothing existing changes its output. The two rewrite-only checks (output equivalence, degenerate inputs) are therefore omitted.

## Design (in plain words)

1. The gateway learns one more directory page. `SearchMenuService.getNewspapers()` fetches `New Directory/Newspapers.asp` exactly like `getBanks()` fetches `Banks.asp`, and a new parser turns each row into `{ paperName, townName }`.
2. One new request/response pair on the WebSocket, `REQ_SEARCH_MENU_NEWSPAPERS` → `RESP_SEARCH_MENU_NEWSPAPERS`, wired the same way as the Banks pair at every layer (enum, interfaces, gateway handler, registry, client callback, bridge dispatch, event routing, search store).
3. The search panel gets a fifth category card, **Media**, and a `media` page: one row per paper, showing the paper name and its town. Clicking a row opens the existing `NewspaperModal` on its **paper** view by calling `useNewspaperStore.getState().openFor({ paperName, townName, isCapitol: false, buildingX: 0, buildingY: 0 }, 'paper')` then `useUiStore.getState().openModal('newspaper')` — the same two calls `OverviewSection` makes. The reader already ignores `buildingX/Y` for a non-capitol town (`/home/crazz/SPO-Pipeline/worktrees/issue-517/src/server/session/newspaper-handler.ts:181-185`), so a directory-launched read needs nothing the row does not carry. The paper view is chosen because #516 (the daily reader) is merged and the legacy row navigated to `newsreader.asp` (`Newspapers.asp:16`); the card text says "opens the board with the right `NewspaperTarget`" — the target is what the L0 unit asserts, and the modal's board tab is one click away on the same context.
4. A world with no papers shows the existing `styles.emptyState` div with the text `No newspapers in this world yet.`, the pattern of `SearchPanel.tsx:36-38`.
5. The L1 substrate: the existing `newspaper` HTTP scenario (`/home/crazz/SPO-Pipeline/worktrees/issue-517/src/mock-server/scenarios/newspaper-scenario.ts`) gains the directory listing page, and its suite drives the real `SearchMenuService.getNewspapers()` through `HttpMock`. No new scenario name, so `SCENARIO_NAMES` stays at 11 and `scenarios.test.ts:601-602` is untouched.

## Files and exact changes

### Shared types

- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/shared/types/domain-types.ts` — after `TownInfo` (`:688-699`) add:
  ```ts
  /** One row of the directory's Media page (New Directory/Newspapers.asp:12-24). */
  export interface NewspaperListing {
    paperName: string;
    townName: string;
  }
  ```
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/shared/types/message-types.ts` — enum: `REQ_SEARCH_MENU_NEWSPAPERS = 'REQ_SEARCH_MENU_NEWSPAPERS'` after `REQ_SEARCH_MENU_BANKS` (`:185`) and `RESP_SEARCH_MENU_NEWSPAPERS` after `RESP_SEARCH_MENU_BANKS` (`:193`). Interfaces after `WsRespSearchMenuBanks` (`:982-985`): `WsReqSearchMenuNewspapers { type: REQ_SEARCH_MENU_NEWSPAPERS }` and `WsRespSearchMenuNewspapers { type: RESP_SEARCH_MENU_NEWSPAPERS; newspapers: NewspaperListing[] }` (import `NewspaperListing` in the domain-types import block at the top).
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/shared/types/index.ts` — export `NewspaperListing` beside `SearchMenuCategory` (`:63`) and the two message interfaces beside `WsReqSearchMenuBanks` / `WsRespSearchMenuBanks` (`:209-210`).

### Gateway

- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/server/search-menu-parser.ts` — add `parseNewspapersPage(html: string): NewspaperListing[]`. Cheerio, rows `tr[dirhref]` (attribute lookup `$row.attr('dirhref') || $row.attr('dirHref')`, as `parseRankingsPage` does at `:204`). `paperName` = `$row.find('.listItem').text()` with ` ` (the `&nbsp;` at `Newspapers.asp:21`) replaced by a space, then trimmed; `townName` = the `TownName=` query value of `dirHref` (`/[?&]TownName=([^&]*)/`; the ASP interpolates it raw at `:16`, so keep the raw value, apply `decodeURIComponent` inside a `try` and fall back to the raw string). Skip a row whose `paperName` is empty. Cite `Newspapers.asp:12-24` in the JSDoc.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/server/search-menu-service.ts` — add after `getBanks()`:
  ```ts
  /** Get every newspaper in the world — New Directory/Newspapers.asp (`:4` reads WorldName only). */
  async getNewspapers(): Promise<NewspaperListing[]> {
    const path = `/five/0/visual/voyager/new%20directory/Newspapers.asp?WorldName=${encodeURIComponent(this.worldName)}&RIWS=`;
    return parseNewspapersPage(await this.fetchPage(path));
  }
  ```
  (import `NewspaperListing` and `parseNewspapersPage`). Same host, port and `fetchPage` as every other directory page — nothing new on the wire.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/server/ws-handlers/search-handlers.ts` — `handleSearchMenuNewspapers`, a copy of `handleSearchMenuBanks` (`:103-115`) calling `ctx.searchMenuService.getNewspapers()` and answering `{ type: RESP_SEARCH_MENU_NEWSPAPERS, wsRequestId, newspapers }`; same `sendError(…, ErrorCodes.ERROR_AccessDenied)` guard when the service is null.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/server/ws-handlers/index.ts` — import it and add `[WsMessageType.REQ_SEARCH_MENU_NEWSPAPERS]: handleSearchMenuNewspapers` after the Banks line (`:125`).

### Client

- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/bridge/client-bridge.ts` — `onSearchMenuNewspapers: () => void;` after `onSearchMenuBanks` (`:229`); import `WsRespSearchMenuNewspapers`; in `handleSearchMenuResponse` add `case WsMessageType.RESP_SEARCH_MENU_NEWSPAPERS: search.setNewspapersData(msg as WsRespSearchMenuNewspapers); break;` after the Banks case (`:766-768`).
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/client.ts` — `onSearchMenuNewspapers: () => this.sendMessage({ type: WsMessageType.REQ_SEARCH_MENU_NEWSPAPERS }),` after `onSearchMenuBanks` (`:434`).
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/handlers/event-handler.ts` — add `case WsMessageType.RESP_SEARCH_MENU_NEWSPAPERS:` to the fall-through group that ends at `:314` (`RESP_SEARCH_MENU_BANKS`) so it reaches `ClientBridge.handleSearchMenuResponse`.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/store/search-store.ts` — `SearchPage` gains `'media'`; state gains `newspapersData: WsRespSearchMenuNewspapers | null` (initial `null`), action `setNewspapersData: (data) => set({ newspapersData: data, isLoading: false })`, and `reset()` clears it. Update the header comment's page list.
- **New** `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/components/search/MediaPage.tsx` — `export function MediaPage()`: `const papers = useSearchStore((s) => s.newspapersData?.newspapers) ?? [];` If empty → `<div className={styles.emptyState}>No newspapers in this world yet.</div>`. Otherwise `styles.listContainer` of `GlassCard light` rows (`key={`${paper.townName}/${paper.paperName}`}`), header with lucide `Newspaper` icon (`size={16}`, `styles.listItemIcon`) and `styles.listItemTitle` = paper name, `styles.listItemDetails` with `<span>{paper.townName}</span>`; `onClick` runs the two calls from design step 3. Imports: `useSearchStore`, `useNewspaperStore`, `useUiStore`, `GlassCard` from `../common`, `styles` from `./SearchPanel.module.css`, `NewspaperListing` type. Keep it in its own file so the L0 unit renders it alone.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/components/search/SearchPanel.tsx` — import `Newspaper` from `lucide-react` and `MediaPage`; add `{ id: 'media', label: 'Media', icon: <Newspaper size={20} /> }` to `CATEGORIES` after Banks; `media: MediaPage` in `PAGE_COMPONENTS`; `media: 'Media'` in `PAGE_LABELS`; `media: () => client.onSearchMenuNewspapers()` in the fetchers map (`:277-285`). Update the header comment (`:4`).

### L1 substrate

- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/mock-server/scenarios/newspaper-scenario.ts` — export `DIRECTORY_PATH = '/Five/0/Visual/Voyager/New%20Directory'` (percent-escaped on purpose: `HttpMock.pathMatches` lowercases and never decodes, and the service requests `new%20directory` — same reasoning as the `home.asp` comment at `:244-247`) and `MOCK_DIRECTORY_PAPERS: NewspaperListing[] = [{ paperName: MOCK_PAPER_NAME, townName: 'Shamba' }, { paperName: 'Helartia Herald', townName: 'Helartia' }]`. Add `newspapersPage(papers)` rendering `Newspapers.asp:40-64` as IIS emits it: `<div class=header2>Media</div>` (`strMedia`, `New Directory.lng:14`), then a `<table>` with, per paper, the `<tr onMouseOver="onItemMouseOver()" onMouseOut="onItemMouseOut()" onClick="onItemMouseClick()" dirHref="../../news/newsreader.asp?RIWS=&Tycoon={{username}}&WorldName={{worldName}}&TownName=<town>&PaperName=<paper>&DAAddr=127.0.0.1&DAPort=7001&frame_Id=NewsView&frame_Class=HTMLView&frame_Align=client&frame_NoBorder=yes::local.asp?frame_Id=DirectoryView&frame_Close=yes" textId="text_<n>">` row holding `<td width="*" style="padding-left: 15px"><div id=text_<n> class=listItem><paper>&nbsp;</div></td>`, followed by the gradient row (`:25-27`). `papers: []` renders the heading and an empty table — the world with no papers. Extend `createNewspaperScenario(overrides, opts: { issues?: string[]; papers?: NewspaperListing[] })` and `buildHttpExchanges` so the bundle also carries `{ id: 'newspaper-http-directory', method: 'GET', urlPattern: `${DIRECTORY_PATH}/Newspapers.asp`, queryPatterns: { WorldName: '{{worldName}}' }, status: 200, contentType: 'text/html', body: newspapersPage(papers) }` (placed before the trailing 404 catch-all). Update the file header: the scenario now serves three pages.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/mock-server/CLAUDE.md` — extend the `newspaper` paragraph (`:33-37`) with one sentence: it also serves the directory's `New Directory/Newspapers.asp` listing, `papers: []` being the world with no paper.

### Tests (new/modified lines must reach ≥ 93 %)

- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/server/__tests__/search-menu-parser.test.ts` — `describe('parseNewspapersPage')`: a two-row fixture shaped like `Newspapers.asp:12-28` → two `{ paperName, townName }` entries in page order with the `&nbsp;` gone; a row without `.listItem` text is skipped; a page with the heading and an empty table → `[]`.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/mock-server/scenarios/newspaper-scenario.test.ts` — new `describe('newspaper scenario — the directory Media listing')`: (a) `httpMock.match('GET', `${DIRECTORY_PATH}/Newspapers.asp?WorldName=Shamba&RIWS=`)` answers 200 and `parseNewspapersPage(body)` equals `MOCK_DIRECTORY_PAPERS`; (b) the real service: `jest.spyOn(http, 'request')` (`import http from 'http'`, the same default-import object the service calls `http.request` on at call time) returning a fake request whose `end()` invokes the callback with an `EventEmitter` response (`statusCode: 200`) that emits `'data'` with the `HttpMock` body and then `'end'`; `new SearchMenuService('158.69.153.134', 8000, 'Shamba', 'SPO_test3', 'Co', '158.69.153.134', 7001).getNewspapers()` resolves to one entry per paper with its town name; (c) `createNewspaperScenario(undefined, { papers: [] })` → `getNewspapers()` resolves to `[]`. Restore the spy in `afterEach`.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/server/ws-handlers/__tests__/search-handlers.test.ts` — `handleSearchMenuNewspapers`: with a ctx whose `searchMenuService.getNewspapers` resolves two listings, one `RESP_SEARCH_MENU_NEWSPAPERS` is sent carrying them and the `wsRequestId`; with `searchMenuService: null` an error frame is sent (match on what `sendError` in `ws-utils.ts` emits — read it first).
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/store/search-store.test.ts` — `setNewspapersData` stores the payload and clears `isLoading`; `reset()` nulls it (add `newspapersData: null` to the file's `resetStore()` helper).
- **New** `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/components/search/MediaPage.test.tsx` (jsdom `component` project, `renderWithProviders` + `resetStores` from `src/client/__tests__/setup/render-helpers.tsx`, pattern of `TycoonProfileView.test.tsx`): rows show the paper and its town; clicking the "Helartia Herald" row leaves `useNewspaperStore.getState().context` equal to `{ paperName: 'Helartia Herald', townName: 'Helartia', isCapitol: false, buildingX: 0, buildingY: 0 }`, `view === 'paper'`, and `useUiStore.getState().modal === 'newspaper'` — **this is the L0 unit the card asks for**; with `newspapersData: { newspapers: [] }` the text `No newspapers in this world yet.` is shown and no row exists. Reset `useNewspaperStore` and `useSearchStore` in `beforeEach`.
- `/home/crazz/SPO-Pipeline/worktrees/issue-517/src/client/bridge/client-bridge.test.ts` — one case: `ClientBridge.handleSearchMenuResponse({ type: RESP_SEARCH_MENU_NEWSPAPERS, newspapers: [...] })` lands in `useSearchStore.getState().newspapersData`.

## Why this meets the criterion

- *Lists every newspaper, each row naming paper and town* — `Newspapers.asp` iterates the whole `Newspapers\` folder (`Browse.inc:19-28`), one row per paper; the parser keeps both names; `MediaPage` renders both.
- *Opening a row opens the paper from anywhere* — the row builds the same `NewspaperContext` the Town Hall path builds, without a building, and the gateway's board/issue reads only need `paperName` + `townName` for a town paper.
- *Empty world → empty state* — `MediaPage` renders the shared `emptyState` div when the list is empty, never a blank section.
- *L1 scenario + L0 unit* — the `newspaper` scenario serves the listing and its suite drives `getNewspapers()` through it; `MediaPage.test.tsx` asserts the click produces the exact target.

## Rules to respect while implementing

- No RDO member is added; `rdo-members.ts` is untouched. No new dependency (cheerio and lucide-react are already used; `Newspaper` exists in the installed lucide-react).
- Never modify `scenarios.test.ts`, `registry.test.ts`, or the `SCENARIO_NAMES` count.
- Read `ws-utils.ts` before asserting the error frame shape; read `render-helpers.tsx` before writing the component test.
- Keep LF line endings; format only what you touch.

## Check commands

```bash
npx jest src/mock-server/scenarios/newspaper-scenario.test.ts src/server/__tests__/search-menu-parser.test.ts
npm run typecheck
npm run lint
npm run coverage:changed
! grep -rn "Newspapers\.asp" doc .claude CLAUDE.md
! grep -rn -i "no list of newspapers\|Media section" doc .claude CLAUDE.md
! grep -rn "REQ_SEARCH_MENU_NEWSPAPERS\|getNewspapers\|parseNewspapersPage" doc .claude CLAUDE.md
```

The first command proves the two substrates the plan extends (the newspaper HTTP scenario and the cheerio directory parser) run in this worktree. The three `!`-negated searches exit 0 only when no document already claims a Newspapers.asp path, a Media section, or the new identifiers — nothing in `doc/`, `.claude/` or `CLAUDE.md` describes this ground, so `src/mock-server/CLAUDE.md` is the only documentation the change touches.

Skills used: none beyond the project's CLAUDE.md conventions (read-only planning).