// Stores PVWatts (NLR, formerly NREL) expected monthly production in Redis.
//
//   node --env-file=.env.local scripts/fetch-pvwatts.mjs <lat> <lon> [kW=8.05] [azimuth=225] [tilt=25]
//
// Use town-level coordinates (1 decimal place is plenty). They're only sent to
// PVWatts; Redis keeps the monthly kWh and system parameters, not the location.
// PVWATTS_API_KEY (free from developer.nlr.gov) is optional; DEMO_KEY works for occasional use.

import { Redis } from "@upstash/redis";

const [lat, lon, kw = "8.05", azimuth = "225", tilt = "25"] = process.argv.slice(2);
if (!lat || !lon) {
  console.error("usage: node --env-file=.env.local scripts/fetch-pvwatts.mjs <lat> <lon> [kW] [azimuth] [tilt]");
  process.exit(1);
}

const q = new URLSearchParams({
  api_key: process.env.PVWATTS_API_KEY || "DEMO_KEY",
  lat, lon, system_capacity: kw, azimuth, tilt,
  array_type: "1", // fixed roof mount
  module_type: "0", // standard
  losses: "14", // PVWatts default system losses
});
const res = await fetch(`https://developer.nlr.gov/api/pvwatts/v8.json?${q}`);
const j = await res.json();
if (!res.ok || j.errors?.length) {
  console.error("PVWatts error:", j.errors ?? res.status);
  process.exit(1);
}

const benchmark = {
  fetchedAt: Date.now(),
  monthlyKwh: j.outputs.ac_monthly.map((v) => Math.round(v)),
  annualKwh: Math.round(j.outputs.ac_annual),
  params: { kw: Number(kw), azimuth: Number(azimuth), tilt: Number(tilt), losses: 14 },
};
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
await redis.set("benchmark:pvwatts", benchmark);
console.log(`Stored PVWatts expectation: ${benchmark.annualKwh} kWh/yr`, benchmark.monthlyKwh.join(","));
