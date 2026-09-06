# Invariants — issue 487

Facts about the existing code this plan depends on staying true while IMPLEMENT works.

## INV-1
File: src/server/session/profile-finance-handler.ts:347-349
>>> QUOTE
  return {
    tycoonName: profile.name,
    currentLevel: level,
>>> END QUOTE

## INV-2
File: src/shared/types/domain-types.ts:814-816
>>> QUOTE
export interface CurriculumData {
  tycoonName: string;
  currentLevel: number;
>>> END QUOTE

## INV-3
File: src/server/session/profile-finance-handler.test.ts:104-105
>>> QUOTE
function currStat(label: string, value: string, style: string): string {
  return `${T(5)}<div class=label style="${style}">\n`
>>> END QUOTE

## INV-4
File: src/client/components/empire/ProfilePanel.tsx:223-228
>>> QUOTE
      <div className={styles.statGrid}>
        <StatCard label="Fortune" value={data.fortune || formatMoney(data.budget)} />
        <StatCard label="Avg. Profit" value={data.averageProfit || '-'} />
        <StatCard label="Prestige" value={`${data.prestige} pts`} />
        <StatCard label="Nobility" value={`${data.nobPoints} pts`} />
      </div>
>>> END QUOTE

## INV-5
File: src/client/store/profile-store.ts:78
>>> QUOTE
  setCurriculum: (data) => set({ curriculum: data, isLoading: false }),
>>> END QUOTE
