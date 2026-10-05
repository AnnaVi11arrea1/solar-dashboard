import { getDaily, getLifetime, getLive, getPvBenchmark, getSummary, getTokens, getHits, redis, dayKey } from "./store";
import { dailyWh, lastNMonths, todaySolarWh } from "./history";
import { findProblems, isSilent } from "./problems";
import { effectiveRate, getBilling, homeUse, IL_AVG_KWH_PER_DAY } from "./billing";

// "Dad's briefing": the home collector asks a local open-weight model (Ollama)
// to explain these facts in plain English, then posts the text back. Only the
// numbers below leave Vercel, and the model never sees anything else.

export type Briefing = { text: string; model: string; at: number };

export const getBriefing = () => redis().get<Briefing>("briefing");
export const setBriefing = (b: Briefing) => redis().set("briefing", b);

const r1 = (n: number) => Math.round(n * 10) / 10;

export async function briefingFacts() {
  const now = Date.now();
  const today = dayKey(now);
  const [live, local, lifetime, summary, tokens, hits, billing, pv] = await Promise.all([
    getLive(), getDaily(), getLifetime(), getSummary(), getTokens(), getHits(), getBilling(), getPvBenchmark(),
  ]);
  const todayWh = todaySolarWh(live, summary, today);
  const daily = dailyWh(lifetime, local, today, todayWh);
  const usage = homeUse(billing, daily);
  const cloudConfigured = !!(process.env.ENPHASE_CLIENT_ID && process.env.ENPHASE_API_KEY);
  const problems = findProblems({ live, tokens, summary, hits, cloudConfigured, usage });

  const [ty, tm, td] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const month = lastNMonths(daily, today, 1)[0];
  const monthExpected = pv ? (pv.monthlyKwh[tm - 1] * td) / daysInMonth : null;
  const fullYear = lastNMonths(daily, today, 13).slice(0, 12);
  const yearExpected = pv ? fullYear.reduce((a, m) => a + pv.monthlyKwh[Number(m.key.slice(5, 7)) - 1], 0) : null;
  const yearKwh = fullYear.reduce((a, m) => a + m.value, 0);

  const panels = live?.panels ?? [];
  const last = usage[usage.length - 1];
  const devices = Object.values(live?.day === today ? live.devicesToday ?? {} : {})
    .sort((a, b) => b.wh - a.wh)
    .slice(0, 5)
    .map((d) => ({ name: d.name, room: d.room, kwhToday: r1(d.wh / 1000) }));

  return {
    date: today,
    solar: {
      todayKwh: todayWh == null ? null : r1(todayWh / 1000),
      thisMonthKwh: Math.round(month.value),
      thisMonthExpectedSoFarKwh: monthExpected == null ? null : Math.round(monthExpected),
      last12MonthsPercentOfExpected: yearExpected ? Math.round((yearKwh / yearExpected) * 100) : null,
      panelsWorking: panels.length ? `${panels.filter((p) => !isSilent(p, live?.panelsAt ?? now)).length} of ${panels.length}` : null,
    },
    latestBill: last && {
      period: `${last.start} to ${last.end}`,
      cost: `$${last.cost.toFixed(2)}`,
      homeKwhPerDay: Math.round(last.perDay),
      averageIllinoisHomeKwhPerDay: Math.round(IL_AVG_KWH_PER_DAY),
      percentCoveredBySolar: Math.round((last.solarKwh / last.homeKwh) * 100),
      sameBillLastYear: last.lastYear && { cost: `$${last.lastYear.cost.toFixed(2)}`, homeKwhPerDay: Math.round(last.lastYear.perDay) },
    },
    pricePerKwh: `$${effectiveRate(billing).toFixed(3)}`,
    biggestDevicesToday: devices,
    problems: problems.map((p) => ({ severity: p.severity, title: p.title, detail: p.detail, action: p.action })),
  };
}
