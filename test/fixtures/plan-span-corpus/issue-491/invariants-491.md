# Invariants — issue 491

Facts about the existing code the plan relies on. The parser's row and flush discriminators must
stay exactly as they are (the tax markup is compatible with them only because of these exact
patterns), the `ProfitLossNode` shape must keep its current fields, the existing fixture builders
must keep producing today's markup, and the panel's non-tax rendering must keep its two spans.

## INV-1
File: src/server/session/profile-finance-handler.ts:849-853
>>> QUOTE
  const rowRegex = new RegExp(
    String.raw`<div\s+class=labelAccountLevel(\d)\s+style="margin-left:[^>]*>\s*<nobr>([\s\S]*?)<\/nobr>`
    + String.raw`[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?(?:(` + ASP_MONEY_SOURCE + String.raw`)|<\/nobr>)`,
    'gi',
  );
>>> END QUOTE

## INV-2
File: src/server/session/profile-finance-handler.ts:855-858
>>> QUOTE
  const flushRegex = new RegExp(
    String.raw`<div\s+class=labelAccountLevel2\s+style="color:[^>]*>\s*(?:<[^>]*>\s*)*?(` + ASP_MONEY_SOURCE + `)`,
    'gi',
  );
>>> END QUOTE

## INV-3
File: src/server/session/profile-finance-handler.ts:886-893
>>> QUOTE
    if (token.kind === 'flush') {
      if (pendingLevel2) {
        pendingLevel2.amount = parseAspMoney(token.money) ?? '0';
        pendingLevel2.chartData = chartOf(token.index);
        pendingLevel2 = null;
      }
      continue;
    }
>>> END QUOTE

## INV-4
File: src/server/session/profile-finance-handler.ts:44
>>> QUOTE
const ASP_MONEY_SOURCE = String.raw`(\()?\s*(-)?\s*\$\s*(\d[\d,]*(?:\.\d+)?)`;
>>> END QUOTE

## INV-5
File: src/shared/types/domain-types.ts:906-913
>>> QUOTE
export interface ProfitLossNode {
  label: string;
  level: number;
  amount: string;
  chartData?: number[];
  isHeader?: boolean;
  children?: ProfitLossNode[];
}
>>> END QUOTE

## INV-6
File: src/server/session/profile-finance-handler.test.ts:1585-1588
>>> QUOTE
  return `${T(2)}<tr>\n${T(3)}<td>\n`
    + `${T(4)}<div class=labelAccountLevel${level} style="margin-left: ${30 * level}px; margin-right: 5px">\n`
    + `${T(5)}<nobr>\n${nameCell}\n${T(5)}</nobr>\n${T(4)}</div>\n${T(3)}</td>\n`
    + `${T(3)}<td align="right">\n${T(4)}<nobr>\n${valueCell}\n${T(4)}</div>\n${T(4)}</nobr>\n${T(3)}</td>\n${T(2)}</tr>`;
>>> END QUOTE

## INV-7
File: src/server/session/profile-finance-handler.test.ts:1596-1597
>>> QUOTE
    + `${T(5)}<div class=labelAccountLevel2 style="color: ${money.startsWith('-') || money.startsWith('(') ? '#ff7700' : 'white'}">\n`
    + `${T(5)}<nobr>${money}\n`
>>> END QUOTE

## INV-8
File: src/client/components/empire/ProfilePanel.tsx:659-665
>>> QUOTE
        <span className={styles.plLabel}>{node.label}</span>
        {history && (
          <span className={styles.plChart} title={historySummary} aria-label={historySummary}>
            <Sparkline data={history} width={64} height={14} />
          </span>
        )}
        <span className={`${styles.plAmount} ${node.amount.startsWith('-') ? styles.negativeValue : ''}`}>{node.amount}</span>
>>> END QUOTE

## INV-9
File: src/client/components/empire/__tests__/profile-panel-profitloss.test.tsx:84-87
>>> QUOTE
    Array.from(rows).forEach((row) => {
      const last = row.lastElementChild;
      expect(last?.className).toContain('plAmount');
    });
>>> END QUOTE

## INV-10
File: src/client/components/empire/ProfilePanel.module.css:475-479
>>> QUOTE
.plAmount {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  margin-left: var(--space-3);
}
>>> END QUOTE