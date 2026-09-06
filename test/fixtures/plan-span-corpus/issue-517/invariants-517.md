# Invariants for plan 517

Facts about the existing code the plan relies on. Each must still hold after IMPLEMENT: the plan adds beside them, never rewrites them.

## INV-1
File: src/server/search-menu-service.ts:55
>>> QUOTE
  private async fetchPage(path: string): Promise<string> {
>>> END QUOTE

## INV-2
File: src/server/search-menu-service.ts:215-221
>>> QUOTE
  async getBanks(): Promise<unknown[]> {
    const path = `/five/0/visual/voyager/new%20directory/Banks.asp?WorldName=${encodeURIComponent(this.worldName)}&RIWS=`;

    await this.fetchPage(path);
    // Banks page is usually empty, return empty array
    return [];
  }
>>> END QUOTE

## INV-3
File: src/server/ws-handlers/search-handlers.ts:103-115
>>> QUOTE
export async function handleSearchMenuBanks(ctx: WsHandlerContext, msg: WsMessage): Promise<void> {
  if (!ctx.searchMenuService) {
    sendError(ctx.ws, msg.wsRequestId, 'Search menu not available. Please log in first.', ErrorCodes.ERROR_AccessDenied);
    return;
  }
  const banks = await ctx.searchMenuService.getBanks();
  const response: WsRespSearchMenuBanks = {
    type: WsMessageType.RESP_SEARCH_MENU_BANKS,
    wsRequestId: msg.wsRequestId,
    banks,
  };
  sendResponse(ctx.ws, response);
}
>>> END QUOTE

## INV-4
File: src/server/session/newspaper-handler.ts:159-165
>>> QUOTE
export interface NewspaperTarget {
  paperName: string;
  townName: string;
  isCapitol: boolean;
  buildingX: number;
  buildingY: number;
}
>>> END QUOTE

## INV-5
File: src/server/session/newspaper-handler.ts:181-185
>>> QUOTE
    TownName: target.isCapitol ? '' : target.townName,
    PaperName: target.paperName,
    Capitol: target.isCapitol ? 'YES' : '',
    x: target.isCapitol ? String(target.buildingX) : '',
    y: target.isCapitol ? String(target.buildingY) : '',
>>> END QUOTE

## INV-6
File: src/client/store/newspaper-store.ts:83-90
>>> QUOTE
  openFor: (context, view = 'board') => set((state) =>
    state.context
      && state.context.paperName === context.paperName
      && state.context.buildingX === context.buildingX
      && state.context.buildingY === context.buildingY
      ? { context, view }
      : { ...EMPTY, context, view }
  ),
>>> END QUOTE

## INV-7
File: src/client/components/modals/NewspaperModal.tsx:50-51
>>> QUOTE
  const isOpen = modal === 'newspaper';
  const hasPaper = context !== null && context.paperName !== '';
>>> END QUOTE

## INV-8
File: src/client/components/politics/OverviewSection.tsx:44-54
>>> QUOTE
  const openNewspaper = useCallback((view: NewspaperView) => {
    useNewspaperStore.getState().openFor({
      paperName: newspaperName,
      townName,
      isCapitol,
      buildingX,
      buildingY,
    }, view);
    // Single-slot modal, like Voyager: `TownHallSheet.pas:352` closes the object
    // inspector when it opens the board.
    useUiStore.getState().openModal('newspaper');
>>> END QUOTE

## INV-9
File: src/client/client.ts:519-520
>>> QUOTE
      onRequestNewspaperBoard: (path) => {
        const context = useNewspaperStore.getState().context;
>>> END QUOTE

## INV-10
File: src/client/components/search/SearchPanel.tsx:36-38
>>> QUOTE
  if (towns.length === 0) {
    return <div className={styles.emptyState}>No towns found.</div>;
  }
>>> END QUOTE

## INV-11
File: src/mock-server/http-mock.ts:89
>>> QUOTE
    return { pathname: pathname.toLowerCase(), queryParams };
>>> END QUOTE

## INV-12
File: src/mock-server/http-mock.ts:106-107
>>> QUOTE
    // Partial path match (request ends with pattern)
    if (requestPath.endsWith(normalizedPattern)) return true;
>>> END QUOTE

## INV-13
File: src/mock-server/scenarios/newspaper-scenario.ts:37-40
>>> QUOTE
export const NEWS_PATH = '/Five/0/Visual/News';

/** The paper the Town Hall of the building-details scenario names (`:503`). */
export const MOCK_PAPER_NAME = 'Shamba Daily';
>>> END QUOTE

## INV-14
File: src/mock-server/scenarios/scenario-registry.ts:49-50
>>> QUOTE
  'newspaper',
];
>>> END QUOTE

## INV-15
File: src/client/__tests__/setup/render-helpers.tsx:19-28
>>> QUOTE
export function createMockClientCallbacks(): ClientCallbacks {
  return new Proxy({} as ClientCallbacks, {
    get: (_target, prop) => {
      if (typeof prop === 'string') {
        return (..._args: unknown[]) => { /* no-op */ };
      }
      return undefined;
    },
  });
}
>>> END QUOTE