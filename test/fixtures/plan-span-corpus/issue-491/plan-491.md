# Plan — issue 491: tax rows in Profit & Loss carry their Town / IFEL split

## What the page renders and the client drops

`/home/crazz/SPO-ASP/Five/0/Visual/Voyager/NewTycoon/TycoonProfitAndLoses.asp` renders, in
the same `<tr>` as an account row, two extra cells when `Obj.AccountIsTax(i)` is true:

- level 2 (`:167-178`): two caption cells — `<div class=labelAccountLevel2 align="right">` holding
  `StrTycoonSupplies_5` = `"Town"` (`/home/crazz/SPO-ASP/Five/0/language/eNewTycon.lng:104`), then
  `<div class=labelAccountLevel2>` holding the literal `IFEL`;
- level > 2 (`:179-194`): two figure cells, each
  `<div class=labelAccountLevel<N> style="color: white; padding-left: 20px">` — the first is
  `FormatValue(AccountValue - AccountSecValue)` (Town, `:183`), the second `FormatValue(AccountSecValue)`
  (IFEL, `:190`). So Town + IFEL = the row's own `AccountValue`, the figure the parser already
  reads as `amount`.

`AccountIsTax` / `AccountSecValue` are written to the cache by
`~/SPO-Original/Kernel/Accounts.pas:287-289` (`Cache.WriteCurrency('AccountSecValue'…)`,
`Cache.WriteBoolean('AccountIsTax'…, Account.MetaAccount.TaxAccount)`).

`parseProfitLossHtml` (`/home/crazz/SPO-Pipeline/worktrees/issue-491/src/server/session/profile-finance-handler.ts:831-933`)
never looks at those cells, `ProfitLossNode` has no field for them, and `ProfitLossNode` in the
panel renders label + amount only. The existing regexes are NOT broken by tax markup — the caption
divs carry neither `style="margin-left:` (row discriminator) nor `style="color:` on level 2 (flush
discriminator), and the figure divs are level ≥ 3 — so this is an **addition**, not a rewrite of
existing behaviour. No `comm` / degenerate-input commands apply.

## Changes

### 1. `/home/crazz/SPO-Pipeline/worktrees/issue-491/src/shared/types/domain-types.ts` — `ProfitLossNode` (:906-913)

Add two optional fields, documented with the ASP lines:

```ts
  /** Tax account (TycoonProfitAndLoses.asp:167, :179 — Obj.AccountIsTax). On the level-2
   *  header the page renders the Town / IFEL captions; on each row beneath, the split. */
  isTax?: boolean;
  /** The IFEL share of `amount` (:190, FormatValue(AccountSecValue)); Town = amount − secAmount
   *  (:183). Only on a tax row deeper than level 2. Same signed, group-free format as `amount`. */
  secAmount?: string;
```

Nothing else in the data path needs a change: the object goes to the browser as-is
(`message-types.ts:1226`, `profile-store.ts:97`), no schema validates it.

### 2. `/home/crazz/SPO-Pipeline/worktrees/issue-491/src/server/session/profile-finance-handler.ts` — `parseProfitLossHtml`

- Extract the row-scope computation out of `chartOf` into a `rowScope(fromIdx)` helper
  (row start to its `</tr>`, or end of page — same fallback as today so the truncated-row test
  keeps passing) and use it from `chartOf` and from the two new lookups below.
- Two new module-level regexes next to `rowRegex` / `flushRegex`, both with a comment citing the
  ASP lines:
  - `TAX_CAPTION = /<div\s+class=labelAccountLevel2\s+align="right">/i` — `:169`; its presence in
    a level-2 row's scope ⇒ `isTax: true` on the header.
  - `TAX_SPLIT = new RegExp(String.raw`<div\s+class=labelAccountLevel\d\s+style="color:\s*white;\s*padding-left:\s*20px"[^>]*>\s*(` + ASP_MONEY_SOURCE + `)`, 'gi')`
    — `:182-183` and `:189-190`. Two matches in a row's scope ⇒ `isTax: true` and
    `secAmount = parseAspMoney(second match) ?? '0'` (the second cell is `FormatValue(AccountSecValue)`).
    The first cell (Town) is not stored — it is `amount − secAmount` by construction (`:183`).
- In the `row` token branch (after the `node` object is built, `:896-905`): for `token.level === 2`
  test `TAX_CAPTION` on the scope; for `token.level > 2` run `TAX_SPLIT`; set `isTax` and
  `secAmount` only when found, so every non-tax node stays byte-identical to today (no new keys —
  the `toEqual` tests on the default root and on non-tax rows must keep passing).
- Extend the JSDoc of `parseProfitLossHtml` with one paragraph on the tax cells.

### 3. `/home/crazz/SPO-Pipeline/worktrees/issue-491/src/client/components/empire/ProfilePanel.tsx` — `ProfitLossNode` (:647-672)

- Add a second prop `inTaxSection?: boolean`, passed as `node.isTax === true` when rendering a
  level-2 header's children (`:667-669`), and propagated unchanged to deeper children.
- Render, after the existing `plAmount` span and **only** when the row is a tax header or
  `inTaxSection` is true, a `<span className={styles.plSplit}>` holding two `plSplitCell` spans:
  - on the tax header (`node.isTax && node.isHeader`): the captions `Town` and `IFEL`;
  - on a row beneath (`inTaxSection`, `node.secAmount !== undefined`): Town = `String(Number(node.amount) - Number(node.secAmount))`
    and IFEL = `node.secAmount`, each with `negativeValue` when it starts with `-`. Both figures
    are integers (FormatValue renders 0 decimals), well inside Number's safe range.
  - a row inside a tax section with no `secAmount` (should not happen on the real page) renders
    two empty cells so the columns stay aligned.
- Non-tax rows render exactly the same two (or three, with a sparkline) children as today —
  the existing test asserts `row.children.length === 2` and that `plAmount` is the last child on
  those rows, and must keep passing unchanged.

### 4. `/home/crazz/SPO-Pipeline/worktrees/issue-491/src/client/components/empire/ProfilePanel.module.css`

After `.plAmount` (`:475-479`): `.plSplit { display: flex; flex-shrink: 0; margin-left: var(--space-3); }`
and `.plSplitCell { min-width: 6.5em; text-align: right; font-variant-numeric: tabular-nums; }`.
The split sits to the right of the row total, in two fixed-width right-aligned columns, so the
captions on the header line up over the figures beneath — the same column arrangement as the ASP
(`:168-193`: Town cell then IFEL cell, both `align="right"`). Indentation and the two existing
columns of non-tax rows are untouched.

### 5. `/home/crazz/SPO-Pipeline/worktrees/issue-491/src/server/session/profile-finance-handler.test.ts` — L0 (the criterion's test)

- Extend the `plRow` fixture builder (`:1572-1589`) with an optional last parameter
  `tax?: { town: string; ifel: string } | true`, appending, before the closing `</tr>`, the real
  markup: for level 2 the caption cells of `:167-178` (`<td>` / `<div class=labelAccountLevel2 align="right">` /
  `Town` … `<td align="right">` / `<div class=labelAccountLevel2>` / `IFEL`), for level > 2 the
  two figure cells of `:179-194` with the `style="color: white; padding-left: 20px"` divs.
  Leave the no-tax output of `plRow` byte-identical (the parameter defaults to undefined and
  appends nothing).
- New test in `describe('fetchProfitLoss')`: the first test's page (`:1608-1618`) plus, under
  `Expenses`, a tax section: `plRow(2, 'Taxes', '', true)`, `plRow(3, 'Income tax', '-$300,000', { town: '-$200,000', ifel: '-$100,000' })`,
  `plRow(3, 'Sales tax', '-$120,000', { town: '-$90,000', ifel: '-$30,000' })`, `plFlush('-$420,000', 'Taxes')`.
  Assert:
  - `TAXES` header: `isTax: true`, `isHeader: true`, `amount: '-420000'` (the flush is still read),
    no `secAmount` key;
  - the two rows: `isTax: true`, `amount: '-300000'` / `secAmount: '-100000'`, and `amount: '-120000'` / `secAmount: '-30000'`;
    and `Number(amount) - Number(secAmount)` equals the Town cell parsed by the fixture (Town + IFEL = amount);
  - `isTax` is `undefined` on root, `Income`, `Expenses`, `RESIDENTIALS`, `Houses`, `Flats`, `SALARIES`,
    and `secAmount` undefined on all of them;
  - the non-tax part of the tree matches the first test's expectations exactly (same labels in
    the same order, same amounts, same `chartData`, same `isHeader`) — check with `toMatchObject`
    on the same literals the first test uses, and with `toEqual` on `income` (the subtree with no
    tax rows) against the expected object built from the same values, which proves no new key was
    added to non-tax nodes.
- One more small test: a level-3 row inside a tax section whose page lost the second figure cell
  (only one `padding-left: 20px` div) is parsed as a plain row (`isTax` undefined) — covers the
  `< 2 matches` branch.

### 6. `/home/crazz/SPO-Pipeline/worktrees/issue-491/src/client/components/empire/__tests__/profile-panel-profitloss.test.tsx` — component

New test: a tree with a tax header (`isTax: true, isHeader: true, level: 2`) and two children
carrying `secAmount`, plus a non-tax sibling section. Assert the header row's last child contains
exactly the texts `Town` and `IFEL`; each tax row's last child contains the two figures
(`-200000` / `-100000`), with `negativeValue` on the negative ones; the non-tax rows still have
exactly two children with `plAmount` last. Keep the two existing tests untouched.

## Why this satisfies the criterion

- Tax section shows the captions and the split on each row: (3) + (4), fed by (1) + (2).
  Town + IFEL = row total by construction of the ASP (`:183`, `:190`) and by the UI deriving
  Town as `amount − secAmount`.
- Non-tax rows unchanged: the parser adds no key to them, the component renders the split span
  only inside a tax section, CSS touches only the new classes.
- Level-2 flush still read on a page with tax rows: the flush row (`:82-107`) is unchanged by
  `AccountIsTax`, the flush regex is untouched, and the L0 test asserts the tax header's amount
  comes from its flush.
- L0 fixture from the real markup, asserting `isTax` / `amount` / `secAmount`, `isTax` absent
  elsewhere, and the existing tree/amounts unchanged: (5).

## Check commands

```bash
npx jest --selectProjects unit src/server/session/profile-finance-handler.test.ts -t fetchProfitLoss
npm run typecheck
npm run lint
npm run coverage:changed
bash -c '! grep -rniE "isTax|secAmount|AccountIsTax|AccountSecValue|Town / IFEL" doc CLAUDE.md .claude --include=*.md'
bash -c '! grep -rnE "plSplit|inTaxSection" doc CLAUDE.md .claude --include=*.md'
```

The first command proves the Jest unit project resolves this file and the P&L suite passes on
the baseline (prototyped: exit 0, 15 tests). The two sweeps exit 0 only when nothing under
`doc/`, `.claude/` or `CLAUDE.md` already claims the fields or classes this plan introduces
(prototyped: no matches). `doc/civic-roles-reference.md:332` mentions `IFEL's RATING` — a
politics screen, unrelated to the P&L, hence the narrower patterns.

## Not a rewrite

This plan adds optional data and an optional render branch; it does not change any existing
output for a page without tax rows. No output-equivalence or degenerate-input commands are listed.

Skills used: spo-testing, typescript, react-best-practices.