# Invariants — issue 490

Facts about the existing code the plan depends on. Paths are relative to `/home/crazz/SPO-Pipeline/worktrees/issue-490`.

## INV-1
File: src/client/components/empire/ProfilePanel.tsx:214-215
>>> QUOTE
    case 'profitloss':
      return <ProfitLossTab />;
>>> END QUOTE

## INV-2
File: src/client/components/empire/ProfilePanel.tsx:629-638
>>> QUOTE
function ProfitLossTab() {
  const data = useProfileStore((s) => s.profitLoss);
  if (!data) return <EmptyState message="No P&L data" />;

  return (
    <div className={styles.tabBody}>
      <ProfitLossNode node={data.root} />
    </div>
  );
}
>>> END QUOTE

## INV-3
File: src/client/components/common/Sparkline.tsx:38
>>> QUOTE
  if (data.length < 2) return null;
>>> END QUOTE

## INV-4
File: src/client/components/common/index.ts:24
>>> QUOTE
export { Sparkline } from './Sparkline';
>>> END QUOTE

## INV-5
File: src/shared/types/domain-types.ts:898-905
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
File: src/client/store/profile-store.ts:80
>>> QUOTE
  setProfitLoss: (data) => set({ profitLoss: data, isLoading: false }),
>>> END QUOTE

## INV-7
File: src/client/components/empire/ProfilePanel.module.css:452-456
>>> QUOTE
.plAmount {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  margin-left: var(--space-3);
}
>>> END QUOTE

## INV-8
File: src/server/session/profile-finance-handler.ts:845
>>> QUOTE
      chartData: chartOf(token.index),
>>> END QUOTE

## INV-9
File: src/__mocks__/css-module.js:3
>>> QUOTE
  get: (_target, name) => name === '__esModule' ? false : String(name),
>>> END QUOTE

## INV-10
File: src/client/components/empire/ProfilePanel.tsx:25
>>> QUOTE
import { formatMoney } from '../../format-utils';
>>> END QUOTE
