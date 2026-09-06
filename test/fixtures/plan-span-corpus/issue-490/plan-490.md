# Plan — issue 490: every P&L row's history crosses the wire, no chart is drawn from it

## What is wrong today

The gateway already parses each P&L row's `ChartInfo=<count>,<values…>` into `ProfitLossNode.chartData`
(`/home/crazz/SPO-Pipeline/worktrees/issue-490/src/server/session/profile-finance-handler.ts:785-790`, set at `:834`, `:845`, `:860`), and the
shared type carries it (`/home/crazz/SPO-Pipeline/worktrees/issue-490/src/shared/types/domain-types.ts:898-905`). The client renderer
`ProfitLossNode` in `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/empire/ProfilePanel.tsx:640-656` types its prop with a
hand-written structural type that omits `chartData` and draws only `plLabel` + `plAmount`. The values are the account's
money history (`AccountHistory` in `~/SPO-ASP/Five/0/Visual/Voyager/NewTycoon/TycoonProfitAndLoses.asp:101`), so they are dollars.

## Is this a rewrite of existing behaviour?

**No.** This is additive: rows without history keep exactly the same DOM (two spans inside `.plRow`) and the same CSS
rules; only rows with ≥ 2 history points gain one extra child. No `comm` output-equivalence or degenerate-input
commands are therefore listed.

## What changes, and where

### 1. `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/empire/ProfilePanel.tsx` (modify)

- Add `Sparkline` to the existing import from `'../common'` (line 17 currently imports `Skeleton, SkeletonLines, ConfirmDialog, Switch`).
  `Sparkline` is exported at `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/common/index.ts:24`.
- Add `ProfitLossNode as ProfitLossNodeData` to the existing `import type { … } from '@/shared/types'` on line 22
  (it is exported from `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/shared/types/index.ts:82`). The alias avoids clashing with the
  component function that shares the name.
- Replace the hand-written prop type of `ProfitLossNode` (line 640) with `{ node: ProfitLossNodeData }`, and drop the
  `as Parameters<typeof ProfitLossNode>[0]['node']` cast on the child recursion (line 652) — the children are already typed.
- Inside the row `<div className={styles.plRow …}>`, **between** `plLabel` and `plAmount`, render:

  ```tsx
  {history && (
    <span className={styles.plChart} title={historySummary} aria-label={historySummary}>
      <Sparkline data={history} width={64} height={14} />
    </span>
  )}
  ```

  where `const history = node.chartData && node.chartData.length >= 2 ? node.chartData : null;` — the `≥ 2` guard mirrors
  `Sparkline`'s own rule (`/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/common/Sparkline.tsx:38` returns `null` under two
  points), so a one-point "history" produces no wrapper and no gap. The summary string is built with the already-imported
  `formatMoney` (line 25):
  `Latest ${formatMoney(last)} · High ${formatMoney(max)} · Low ${formatMoney(min)}`.
  This satisfies "latest and extreme values legible on hover" via the native `title` tooltip, and the same text is the
  accessible name of the element. `Sparkline`'s own colour auto-detection (`positive`/`negative`/`neutral` from first vs
  last point) answers "up or down" at a glance; no explicit `color` prop.
- `plAmount` stays the **last** child of the row in both cases.
- Change the section comment on line 626 from `// P&L Tab — unchanged` to `// P&L Tab — with inline history series`.

### 2. `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/empire/ProfilePanel.module.css` (modify)

Add one rule after `.plLabel` (line 445-450), before `.plAmount` (line 452):

```css
.plChart {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: var(--space-3);
  display: inline-flex;
  align-items: center;
}
```

Why this keeps alignment: `.plRow` is `display: flex; justify-content: space-between`. With two children (no history)
nothing changes. With three, `margin-left: auto` on the chart absorbs all free space, so chart and amount cluster at the
right edge and the amount's right edge is where it was; `.plLabel` already has `min-width: 0; overflow: hidden` so it
shrinks first. Indentation is unchanged because it is the row's inline `paddingLeft`, untouched.

### 3. `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/empire/__tests__/profile-panel-profitloss.test.tsx` (create)

A jsdom component test (the `component` Jest project matches `**/*.test.tsx`), modelled on
`/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/empire/__tests__/profile-panel-sections.test.tsx`:

- `beforeEach`: `useProfileStore.getState().reset()`.
- Render `<ProfilePanel />` via `renderWithProviders` from
  `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/__tests__/setup/render-helpers.tsx`, click "Profit & Loss" inside the
  `Profile sections` nav (same `clickSection` helper), then `act(() => useProfileStore.getState().setProfitLoss(tree))`.
  `setProfitLoss` clears `isLoading` (`/home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/store/profile-store.ts:80`), so the drawer
  renders `ProfitLossTab`.
- Seed tree: root `{ label: 'Net Profit', level: 0, amount: '1000', chartData: [10, -20, 30], children: [ { label: 'RESIDENTIALS', level: 2, amount: '500', isHeader: true, children: [ { label: 'Rent', level: 3, amount: '500' } ] } ] }`
  — one row with history, two without.
- Assertions (CSS-module mock returns class names verbatim,
  `/home/crazz/SPO-Pipeline/worktrees/issue-490/src/__mocks__/css-module.js`, so `[class*="plRow"]` etc. work):
  1. Exactly one `.plChart` and exactly one `svg` in the tab; it lives inside the row whose text starts with `Net Profit`.
  2. The rows for `RESIDENTIALS` and `Rent` contain no `.plChart`, no `svg`, and have exactly two children.
  3. The `.plChart` element's `title` contains `Latest $30`, `High $30`, `Low -$20` (the `formatMoney` forms).
  4. For **every** `.plRow`, `lastElementChild` has class `plAmount` and its text equals the seeded amount — the
     right-alignment proxy in a layout-less DOM, plus `plRow` still present on each row.
  5. A row whose `chartData` has one point (`[5]`) renders no `.plChart` (guard branch covered).
- Covers every new line and branch in `ProfilePanel.tsx`, keeping the ≥ 93 % changed-line floor.

## Why this satisfies the criterion

- Rows with `chartData` (≥ 2 points) show an inline SVG series; rows without it render exactly the two spans they do today
  — no wrapper, no placeholder.
- Latest and extreme values are legible on hover (`title`) and to assistive tech (`aria-label`); trend direction is
  colour-coded by the existing component.
- Label-left / amount-right / level indentation are unchanged for rows without history (same DOM, same CSS), and preserved
  for rows with it (`margin-left: auto`).
- The L0 render test seeds both cases and asserts presence/absence of the series and the amount's trailing position.

No new dependency. No RDO change. No server change.

## Check commands

Run from `/home/crazz/SPO-Pipeline/worktrees/issue-490`, each judged by its exit code alone:

```bash
grep -q 'export { Sparkline }' /home/crazz/SPO-Pipeline/worktrees/issue-490/src/client/components/common/index.ts && grep -q 'chartData?: number\[\]' /home/crazz/SPO-Pipeline/worktrees/issue-490/src/shared/types/domain-types.ts && grep -q 'ProfitLossNode,' /home/crazz/SPO-Pipeline/worktrees/issue-490/src/shared/types/index.ts
npm run typecheck
npm run lint
npm run verdict -- coverage:changed
! grep -rqn 'chartData' /home/crazz/SPO-Pipeline/worktrees/issue-490/doc/ /home/crazz/SPO-Pipeline/worktrees/issue-490/.claude/ /home/crazz/SPO-Pipeline/worktrees/issue-490/CLAUDE.md
! grep -rqniE 'profit.?(&|and).?loss.*(chart|sparkline|history)' /home/crazz/SPO-Pipeline/worktrees/issue-490/doc/ /home/crazz/SPO-Pipeline/worktrees/issue-490/.claude/ /home/crazz/SPO-Pipeline/worktrees/issue-490/CLAUDE.md
```

- Command 1 proves the design is executable here: the reusable `Sparkline` export, the `chartData` field, and the
  `ProfitLossNode` type re-export all exist (prototyped: exit 0).
- `typecheck` and `lint` were prototyped on this worktree (both exit 0 before the change). `coverage:changed` is the
  precheck's suite pass and enforces the 93 % changed-line floor; it is run through `verdict` so its long log lands in
  `~/.spo-bench/logs/`.
- The two falsification sweeps assert that nothing under `doc/`, `.claude/` or `CLAUDE.md` documents `chartData` or
  describes the P&L tab's chart/history behaviour (both prototyped: no match, exit 0). The only doc mentions of a
  sparkline concern the top info bar and the component library, not this tab.

Skills used: none (direct reads only).
