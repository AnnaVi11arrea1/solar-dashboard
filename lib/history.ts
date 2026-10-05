import type { CloudLifetime } from "./types";

// Day strings are YYYY-MM-DD in the home timezone; date math happens in UTC on
// those strings so DST never shifts a day.
export function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Wh per day: Enphase cloud history, overridden by local gateway counts where we have them.
export function dailyWh(cloud: CloudLifetime | null, local: Record<string, number>, today: string, todayWh: number | null) {
  const out = new Map<string, number>();
  if (cloud?.start_date) cloud.production.forEach((wh, i) => out.set(addDays(cloud.start_date, i), wh));
  for (const [day, wh] of Object.entries(local)) if (wh > 0 || !out.has(day)) out.set(day, Number(wh));
  if (todayWh != null) out.set(today, todayWh);
  return out;
}

const label = (day: string, opts: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

export function lastNDays(daily: Map<string, number>, today: string, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const day = addDays(today, i - n + 1);
    const d = new Date(`${day}T12:00:00Z`);
    return {
      key: day,
      label: label(day, { weekday: "short", month: "short", day: "numeric" }),
      value: (daily.get(day) ?? 0) / 1000,
      tick: d.getUTCDate() === 1 || i === 0 || i % 7 === (n - 1) % 7 ? label(day, { month: "numeric", day: "numeric" }) : undefined,
      highlight: day === today,
    };
  });
}

export function lastNMonths(daily: Map<string, number>, today: string, n: number) {
  const totals = new Map<string, number>();
  for (const [day, wh] of daily) totals.set(day.slice(0, 7), (totals.get(day.slice(0, 7)) ?? 0) + wh);
  const [y, m] = today.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 15));
    const key = d.toISOString().slice(0, 7);
    return {
      key,
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      value: (totals.get(key) ?? 0) / 1000,
      tick: d.toLocaleDateString("en-US", { month: "narrow", timeZone: "UTC" }),
      highlight: i === n - 1,
    };
  });
}

export function bestDay(daily: Map<string, number>) {
  let best: { day: string; wh: number } | null = null;
  for (const [day, wh] of daily) if (!best || wh > best.wh) best = { day, wh };
  return best && { ...best, label: label(best.day, { month: "short", day: "numeric", year: "numeric" }) };
}
