# Plan 473 — Docked minimap must stop sliding right for a left panel that no longer exists

## Why the code is wrong today

The universal Sheet replaced the desktop LeftPanel: `/home/crazz/SPO-Pipeline/worktrees/issue-473/src/client/components/sheet/Sheet.tsx:7` states "This component replaces RightPanel + LeftPanel on desktop", and `LeftPanel` is no longer mounted anywhere except its own component test (`/home/crazz/SPO-Pipeline/worktrees/issue-473/src/client/components/panels/panel-components.test.tsx`). Every `LEFT_KINDS` surface (`empire`, `facilities`, `overlays` — `/home/crazz/SPO-Pipeline/worktrees/issue-473/src/client/store/ui-store.ts:58`) now opens in the Sheet on the **right** edge, but `MinimapUI.applyPositioning()` (`/home/crazz/SPO-Pipeline/worktrees/issue-473/src/client/ui/minimap-ui.ts:193-207`) still reads `useUiStore.getState().leftPanel` and, when non-null, offsets the wrapper to `calc(var(--panel-width-desktop) + 12px)` — sliding the minimap right to clear a panel that is not there.

## What changes

**This is NOT a rewrite of existing behaviour** — it is a deliberate behaviour change mandated by the card (the shift is removed, not re-implemented), so no `comm` output-equivalence or degenerate-input commands apply.

### 1. `/home/crazz/SPO-Pipeline/worktrees/issue-473/src/client/ui/minimap-ui.ts`

- **`applyPositioning()`** (currently lines 193-207): remove the `panelOpen` branch, the `useUiStore.getState().leftPanel` read, and the `getComputedStyle(...)` `--panel-width-desktop` lookup. The method unconditionally sets `bottom = ''`, `top = `${DESKTOP_PAD}px``, `left = `${DESKTOP_PAD}px`` (`DESKTOP_PAD` is 12, line 39). Update the method's comment (lines 195-196) — it currently says "pushed right by an open left panel". Keep the method itself and its call sites (`applyDockedStyle()` end, and `onUiStateChange()` line 327): `onUiStateChange` re-anchoring to a static position is harmless and keeps the change minimal.
- **`applyDockedStyle()`** (lines 216-243): delete the `transition: left 250ms cubic-bezier(0.16,1,0.3,1), bottom 250ms cubic-bezier(0.16,1,0.3,1);` declaration from the wrapper's `cssText` (lines 230-231) — it existed only to animate the now-dead shift (`bottom` is always cleared to `''` on this path).
- **Header comment** line 15: change `Desktop (≥ 768 px): docked top-left, shifts right when the left panel is open` to state the docked minimap is anchored top-left at a fixed 12 px inset (keep the rest of the Layout block untouched; note the ≥ 768 claim is stale too — `MOBILE_BP` is 1024 — so word it without a breakpoint number or with 1024, e.g. `Desktop (≥ 1024 px): docked top-left, fixed 12 px inset — never moves for an open surface (surfaces live in the right-edge Sheet)`).
- The `useUiStore` import stays — `isMenuOpen()`, `onUiStateChange()`, fullscreen handling still use it.

### 2. `/home/crazz/SPO-Pipeline/worktrees/issue-473/src/client/ui/minimap-ui.test.ts`

- Replace the test `shifts right when the desktop left panel opens` (lines 798-810) with a test of the new rule, e.g. `stays anchored at left: 12px when a left surface opens and closes`: `installWindow(1024)`, create `MinimapUI`, `setRenderer(createMockRenderer())`, capture the wrapper (`allElements.find(el => el.id === 'minimap-wrapper')`), then `useUiStore.getState().openLeftPanel('empire')` and assert `wrapper.style.left === '12px'`, then `useUiStore.getState().closeLeftPanel()` and assert `wrapper.style.left === '12px'` again. (`openLeftPanel` / `closeLeftPanel` exist: `/home/crazz/SPO-Pipeline/worktrees/issue-473/src/client/store/ui-store.ts:267-268`. `applyDockedStyle` writes `cssText` with `left: 12px` and `applyPositioning` then writes `style.left`, so in the mock-element model `style.left` is the surface `applyPositioning` writes — the exact property the old test asserted on.) Optionally loop the three `LEFT_KINDS` (`empire`, `facilities`, `overlays`) to cover the criterion's "any surface in LEFT_KINDS" literally — cheap and closer to the card's wording; do it.
- Remove the now-unused `getComputedStyle` mock in `beforeEach` (lines 212-214) — nothing in `minimap-ui.ts` calls it after this change.
- Do not touch the other tests; `docks again — without the fullscreen scrim` asserts `top: 12px` and remains valid.

## Why this satisfies the criterion

1. *Left-surface open leaves `#minimap-wrapper` at `left: 12px`*: `applyPositioning()` becomes unconditional, so `onUiStateChange` (fired by the store subscription on `openLeftPanel`) rewrites the same `12px`.
2. *Dead offset, transition, and comment removed*: points 1-3 of §1 above.
3. *Test asserts the new rule*: §2 above.
4. *No Sheet overlap on the right edge at 1024 px and 3200 px*: structural — the minimap is anchored at the **left** edge (`left: 12px`, wrapper width ≤ `MAX_SIZE` 500 px → right edge ≤ 512 px) while the Sheet is right-anchored at `--panel-width-desktop` (420 px at 1024-1399 px → sheet's left edge at 604 px > 512; `clamp(472px, 30vw, 1000px)` ≥ 1400 px → at 3200 px the sheet's left edge is ≥ 2200 px). Removing the shift only moves the minimap *further* from the Sheet than before; no new overlap is possible. No code is needed for this point.

## Check commands

```bash
grep -q 'panel-width-desktop' src/client/ui/minimap-ui.ts
npm run typecheck
npm run lint
npm run coverage:changed
! grep -rn 'panel-width-desktop' src/client/ui
! grep -rn 'shifts right when the left panel is open' src/client/ui doc CLAUDE.md
! grep -rn 'shifts right when the desktop left panel opens' src/client/ui doc CLAUDE.md
```

All commands run from `/home/crazz/SPO-Pipeline/worktrees/issue-473`. The first (run by the driver before IMPLEMENT) exits 0 today, proving the dead offset this plan removes is present. The three negated greps are the falsification sweep: after the change nothing in the minimap code or the docs may still claim the shift or reference `--panel-width-desktop` from the minimap (a `doc/`-wide search for minimap-shift claims was performed during planning and found none — the only two occurrences of the claim are `minimap-ui.ts:15` and the test name, both changed by this plan; `--panel-width-desktop` itself legitimately remains in `design-tokens.css`, Sheet/HUD CSS, and their tests, which is why the negated grep is scoped to `src/client/ui`).
