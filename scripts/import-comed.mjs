// Imports a ComEd Green Button *billing* CSV into the dashboard's Redis.
//
//   node --env-file=.env.local scripts/import-comed.mjs path/to/billing.csv
//
// Only the "Electric billing" rows are read (dates, net kWh, cost). The header
// rows with name, address and account number are skipped and never stored.
// Re-running with a newer download merges by period start date.

import fs from "node:fs";
import { Redis } from "@upstash/redis";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --env-file=.env.local scripts/import-comed.mjs <billing.csv>");
  process.exit(1);
}

const periods = [];
for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  // TYPE,START DATE,END DATE,USAGE (kWh),COST,NOTES  — usage may be quoted with commas
  const m = line.match(/^Electric billing,(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2}),"?(-?[\d,]+(?:\.\d+)?)"?,"?\$?(-?[\d,]+(?:\.\d+)?)"?/);
  if (!m) continue;
  periods.push({
    start: m[1],
    end: m[2],
    netKwh: Number(m[3].replace(/,/g, "")),
    cost: Number(m[4].replace(/,/g, "")),
  });
}
if (!periods.length) {
  console.error("No 'Electric billing' rows found — is this the billing CSV?");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
const existing = (await redis.get("comed:billing")) ?? [];
const merged = new Map(existing.map((p) => [p.start, p]));
for (const p of periods) merged.set(p.start, p);
const all = [...merged.values()].sort((a, b) => a.start.localeCompare(b.start));
await redis.set("comed:billing", all);
console.log(`Stored ${all.length} billing periods (${all[0].start} → ${all[all.length - 1].end}); ${periods.length} from this file.`);
