import { redis } from "./store";
import { addDays } from "./history";

// ComEd billing periods (scripts/import-comed.mjs). netKwh is grid import minus
// export over the period, so home use = net + solar produced.
export type BillPeriod = { start: string; end: string; netKwh: number; cost: number };

export type HomeUsePeriod = BillPeriod & {
  solarKwh: number;
  homeKwh: number;
  days: number;
  perDay: number;
  lastYear?: { homeKwh: number; perDay: number; cost: number };
};

export const getBilling = async () => (await redis().get<BillPeriod[]>("comed:billing")) ?? [];

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);

export function homeUse(periods: BillPeriod[], dailyWh: Map<string, number>): HomeUsePeriod[] {
  const rows = periods.map((p) => {
    let wh = 0;
    for (let d = p.start; d <= p.end; d = addDays(d, 1)) wh += dailyWh.get(d) ?? 0;
    const solarKwh = wh / 1000;
    const homeKwh = p.netKwh + solarKwh;
    const days = dayDiff(p.start, p.end) + 1;
    return { ...p, solarKwh, homeKwh, days, perDay: homeKwh / days } as HomeUsePeriod;
  });
  // Same billing period a year earlier: closest start date to 365 days before.
  for (const r of rows) {
    const target = addDays(r.start, -365);
    const prev = rows.find((x) => Math.abs(dayDiff(x.start, target)) <= 15);
    if (prev) r.lastYear = { homeKwh: prev.homeKwh, perDay: prev.perDay, cost: prev.cost };
  }
  return rows;
}

// Rough all-in $/kWh from bills where the house actually bought power
// (net-export months are mostly fixed fees and would skew it).
export function effectiveRate(periods: BillPeriod[]) {
  const buying = periods.filter((p) => p.netKwh > 300).slice(-12);
  const kwh = buying.reduce((a, p) => a + p.netKwh, 0);
  return kwh > 0 ? buying.reduce((a, p) => a + p.cost, 0) / kwh : 0.17;
}
