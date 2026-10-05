import { Redis } from "@upstash/redis";
import type { CloudLifetime, CloudSummary, Device, DeviceDay, EnphaseTokens, Live, SeriesPoint, Snapshot } from "./types";

// The Vercel Marketplace Upstash integration injects KV_REST_API_*; a direct
// Upstash setup uses UPSTASH_REDIS_REST_*. Accept either.
let client: Redis | null = null;
export function redis() {
  if (!client) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error("Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
    client = new Redis({ url, token });
  }
  return client;
}

export const TZ = process.env.HOME_TIMEZONE || "America/Chicago";

export function dayKey(ms: number) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

const K = {
  live: "live",
  series: (day: string) => `series:${day}`,
  daily: "daily:solarWh", // hash day -> Wh produced (from the local gateway)
  deviceDaily: "devices:daily", // hash day -> DeviceDay (written once, when the day rolls over)
  tokens: "enphase:tokens",
  summary: "enphase:summary",
  lifetime: "enphase:lifetime",
  hits: (month: string) => `enphase:hits:${month}`,
  oauthState: "enphase:oauth-state",
};

// ---- live data from the collector ----------------------------------------

// Four commands per ingest keeps a 1-minute collector well inside Upstash's free tier.
export async function ingest(snap: Snapshot) {
  const r = redis();
  const prev = await r.get<Live>(K.live);
  const day = dayKey(snap.at);
  const newDay = !prev || prev.day !== day;
  // Today's energy = lifetime counter minus the last reading from before midnight,
  // so a collector that was off overnight still counts the whole day.
  const live: Live = {
    ...snap,
    day,
    dayBaseSolarWh: newDay ? (prev?.solarWhLifetime ?? snap.solarWhLifetime) : prev.dayBaseSolarWh,
    dayBaseHomeWh: newDay ? (prev?.homeWhLifetime ?? snap.homeWhLifetime) : prev.dayBaseHomeWh,
  };
  live.devices = measuredDevices(snap);
  live.devicesToday = accumulate(newDay ? {} : prev?.devicesToday ?? {}, prev, live.devices, snap.at);

  // Panels/batteries are only sent every few minutes; keep the last known values.
  const prevPanelWh = newDay ? {} : prev?.panelsWhToday ?? {};
  if (snap.panels) {
    live.panelsWhToday = accumulatePanels(prevPanelWh, prev, snap.panels, snap.at);
    live.panelsAt = snap.at;
  } else {
    live.panelsWhToday = prevPanelWh;
    live.panelsAt = newDay ? undefined : prev?.panelsAt;
  }
  if (!snap.panels && prev?.panels) live.panels = prev.panels;
  if (!snap.batteries && prev?.batteries) live.batteries = prev.batteries;

  const point: SeriesPoint = [snap.at, snap.solarW, snap.homeW, snap.gridW, snap.ups?.w ?? null];
  const p = r.pipeline();
  p.set(K.live, live);
  p.rpush(K.series(day), point);
  if (newDay) p.expire(K.series(day), 60 * 60 * 24 * 8);
  if (live.solarWhLifetime != null && live.dayBaseSolarWh != null) p.hset(K.daily, { [day]: Math.round(live.solarWhLifetime - live.dayBaseSolarWh) });
  if (newDay && prev?.devicesToday && Object.keys(prev.devicesToday).length) p.hset(K.deviceDaily, { [prev.day]: prev.devicesToday });
  await p.exec();
  return live;
}

// Home Assistant devices plus the UPS (when its cable is connected) as one list.
function measuredDevices(snap: Snapshot): Device[] {
  const list = [...(snap.devices ?? [])];
  if (snap.ups?.w != null) list.push({ id: "ups", name: "Desk (UPS)", room: process.env.UPS_ROOM || null, w: snap.ups.w });
  return list;
}

// Trapezoid integration between readings; gaps over 5 minutes (collector
// offline) only count 5 minutes so an outage can't inflate the totals.
function accumulate(today: DeviceDay, prev: Live | null, devices: Device[], at: number): DeviceDay {
  const out: DeviceDay = { ...today };
  const dtH = prev ? Math.min(Math.max(at - prev.at, 0), 5 * 60_000) / 3600_000 : 0;
  for (const d of devices) {
    const before = prev?.devices?.find((x) => x.id === d.id)?.w ?? d.w;
    const e = out[d.id] ?? { name: d.name, room: d.room, wh: 0 };
    out[d.id] = { name: d.name, room: d.room, wh: e.wh + ((before + d.w) / 2) * dtH };
  }
  return out;
}

// Same trapezoid idea for microinverters; panel data arrives every ~5 minutes,
// so gaps up to 15 minutes count in full.
function accumulatePanels(today: Record<string, number>, prev: Live | null, panels: NonNullable<Snapshot["panels"]>, at: number) {
  const out = { ...today };
  const since = prev?.panelsAt ? at - prev.panelsAt : 0;
  const dtH = Math.min(Math.max(since, 0), 15 * 60_000) / 3600_000;
  for (const p of panels) {
    const before = prev?.panels?.find((x) => x.sn === p.sn)?.w ?? p.w;
    out[p.sn] = (out[p.sn] ?? 0) + ((before + p.w) / 2) * dtH;
  }
  return out;
}

export async function getDeviceHistory() {
  return (await redis().hgetall<Record<string, DeviceDay>>(K.deviceDaily)) ?? {};
}

// PVWatts expected production (scripts/fetch-pvwatts.mjs).
export type PvBenchmark = { monthlyKwh: number[]; annualKwh: number; params: { kw: number; azimuth: number; tilt: number } };
export const getPvBenchmark = () => redis().get<PvBenchmark>("benchmark:pvwatts");

export async function getLive() {
  return redis().get<Live>(K.live);
}

export async function getSeries(day: string) {
  return (await redis().lrange<SeriesPoint>(K.series(day), 0, -1)) ?? [];
}

export async function getDaily() {
  const h = await redis().hgetall<Record<string, number>>(K.daily);
  return h ?? {};
}

// ---- Enphase cloud --------------------------------------------------------

export const getTokens = () => redis().get<EnphaseTokens>(K.tokens);
export const setTokens = (t: EnphaseTokens) => redis().set(K.tokens, t);
export const getSummary = () => redis().get<CloudSummary>(K.summary);
export const setSummary = (s: CloudSummary) => redis().set(K.summary, s);
export const getLifetime = () => redis().get<CloudLifetime>(K.lifetime);
export const setLifetime = (l: CloudLifetime) => redis().set(K.lifetime, l);
export const setOauthState = (s: string) => redis().set(K.oauthState, s, { ex: 600 });
export const takeOauthState = () => redis().getdel<string>(K.oauthState);

const month = () => dayKey(Date.now()).slice(0, 7);
export async function countHit() {
  const r = redis();
  const n = await r.incr(K.hits(month()));
  if (n === 1) await r.expire(K.hits(month()), 60 * 60 * 24 * 40);
  return n;
}
export async function getHits() {
  return (await redis().get<number>(K.hits(month()))) ?? 0;
}
