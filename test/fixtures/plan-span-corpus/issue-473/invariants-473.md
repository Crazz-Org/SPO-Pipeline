# Invariants — issue 473

Facts about the existing code this plan depends on staying true while IMPLEMENT works.

## INV-1
File: src/client/store/ui-store.ts:58
>>> QUOTE
const LEFT_KINDS: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['empire', 'facilities', 'overlays']);
>>> END QUOTE

## INV-2
File: src/client/store/ui-store.ts:267-268
>>> QUOTE
  openLeftPanel: (type) => get().setRootSurface({ kind: type }),
  closeLeftPanel: () => get().clearSurfaces(),
>>> END QUOTE

## INV-3
File: src/client/ui/minimap-ui.ts:39
>>> QUOTE
const DESKTOP_PAD   = 12;   // px — screen-edge gap (desktop)
>>> END QUOTE

## INV-4
File: src/client/components/sheet/Sheet.tsx:7
>>> QUOTE
 * the sheet is pinned. This component replaces RightPanel + LeftPanel on desktop; the mobile
>>> END QUOTE

## INV-5
File: src/client/ui/minimap-ui.ts:41-42
>>> QUOTE
const MIN_SIZE      = 120;  // px — minimum size
const MAX_SIZE      = 500;  // px — maximum size
>>> END QUOTE
