# Invariants — issue 506

Facts about the existing code the plan composes rather than changes. Each must still hold after IMPLEMENT.

## INV-1
File: src/client/store/mail-store.ts:103-111
>>> QUOTE
  startCompose: (to = '', subject = '', body = '', headers = '') =>
    set({
      currentView: 'compose',
      composeTo: to,
      composeSubject: subject,
      composeBody: body,
      composeHeaders: headers,
      composeDraftId: null,
    }),
>>> END QUOTE

## INV-2
File: src/client/store/ui-store.ts:217-223
>>> QUOTE
  pushSurface: (surface) => {
    const stack = get().stack;
    const top = stack[stack.length - 1];
    if (top && top.kind === surface.kind && JSON.stringify(top.params ?? {}) === JSON.stringify(surface.params ?? {})) return;
    const next = [...stack, surface];
    set({ stack: next, ...legacyView(next) });
  },
>>> END QUOTE

## INV-3
File: src/client/components/sheet/Sheet.tsx:71-72
>>> QUOTE
    case 'mail':
      return <MailPanel />;
>>> END QUOTE

## INV-4
File: src/shared/types/domain-types.ts:704-705
>>> QUOTE
export interface TycoonProfile {
  name: string;
>>> END QUOTE

## INV-5
File: src/client/components/building/InspectorHeader.tsx:85
>>> QUOTE
        {actions && <div className={styles.actions}>{actions}</div>}
>>> END QUOTE

## INV-6
File: src/client/components/building/BuildingInspector.tsx:292
>>> QUOTE
  const ownerTycoon = findPropertyValue(details.groups, 'Creator');
>>> END QUOTE

## INV-7
File: src/client/components/building/civic-subtitle.ts:12
>>> QUOTE
export function findPropertyValue(details: BuildingDetailsResponse, propName: string): string | undefined {
>>> END QUOTE

## INV-8
File: src/client/store/game-store.ts:245
>>> QUOTE
  setWorld: (worldName) => set({ worldName }),
>>> END QUOTE

## INV-9
File: src/client/bridge/client-bridge.ts:508
>>> QUOTE
      const townName = townGroup.find(p => p.name === 'Town')?.value ?? '';
>>> END QUOTE
