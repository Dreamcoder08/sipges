const MONTH = /^\d{4}-\d{2}$/;
const MAX_MONTHS = 120;

const nextMonth = (month: string) => {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * Counts per month (YYYY-MM) of ISO dates over their continuous span, oldest first with gaps as
 * zero, capped to the latest ten years so a stray date cannot explode a chart.
 */
export const monthlySeries = (dates: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const date of dates) {
    const month = date.slice(0, 7);
    if (MONTH.test(month)) counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  const months = [...counts.keys()].sort();
  const first = months[0];
  const last = months.at(-1);
  if (!first || !last) return [];
  const series: { month: string; count: number }[] = [];
  for (let month = first; month <= last; month = nextMonth(month))
    series.push({ month, count: counts.get(month) ?? 0 });
  return series.slice(-MAX_MONTHS);
};
