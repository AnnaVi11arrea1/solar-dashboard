// Home collector: reads the Enphase IQ Gateway on the local network (and later the
// APC UPS) and pushes a compact snapshot to the Vercel dashboard every minute.
//
//   node collector.mjs           run forever
//   node collector.mjs --once    collect + push one snapshot, then exit
//   node collector.mjs --probe   dump raw gateway responses to ./probe/ (no push)
//   node collector.mjs --briefing  write + push one "Dad's briefing" with Ollama, then exit
//
// Config lives in collector/.env (see .env.example). No npm dependencies.

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, ".env"));

const GATEWAY = process.env.GATEWAY_HOST || "envoy.local";
const TOKEN = process.env.GATEWAY_TOKEN;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const INTERVAL_MS = Number(process.env.INTERVAL_SECONDS || 60) * 1000;
// Microinverters only report every ~5-15 min, so poll the heavier endpoints less often.
const SLOW_EVERY = 5;

const args = new Set(process.argv.slice(2));

if (!TOKEN) die("GATEWAY_TOKEN is missing from collector/.env");

// The gateway uses a self-signed certificate, so certificate checks are off for it only.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function gatewayGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: GATEWAY, path: urlPath, agent, timeout: 15000, headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 401) return reject(new Error(`401 from ${urlPath} — gateway token rejected or expired`));
          if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} from ${urlPath}`));
          try { resolve(JSON.parse(body)); } catch { reject(new Error(`non-JSON from ${urlPath}`)); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout on ${urlPath}`)));
    req.on("error", reject);
  });
}

// Optional endpoints (batteries, meters) 404 on systems without that hardware.
async function tryGet(urlPath) {
  try { return await gatewayGet(urlPath); } catch (e) { return { __error: e.message }; }
}

const ENDPOINTS = {
  production: "/production.json?details=1",
  meters: "/ivp/meters",
  readings: "/ivp/meters/readings",
  inverters: "/api/v1/production/inverters",
  inventory: "/inventory.json",
  ensemble: "/ivp/ensemble/inventory",
  livedata: "/ivp/livedata/status",
};

async function probe() {
  const dir = path.join(here, "probe");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, p] of Object.entries(ENDPOINTS)) {
    const data = await tryGet(p);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
    console.log(`${name.padEnd(11)} ${data.__error ? "ERR " + data.__error : "ok"}`);
  }
  console.log(`\nSaved to ${dir}`);
}

// ---- normalisation -------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readMeters(meters, readings) {
  // /ivp/meters says which eid is which; /ivp/meters/readings has the counters.
  const out = {};
  if (!Array.isArray(meters) || !Array.isArray(readings)) return out;
  for (const m of meters) {
    if (m.state !== "enabled") continue;
    const r = readings.find((x) => x.eid === m.eid);
    if (!r) continue;
    const key = m.measurementType === "production" ? "production" : m.measurementType === "net-consumption" ? "net" : m.measurementType;
    out[key] = {
      w: num(r.activePower),
      v: num(r.voltage),
      importedWh: num(r.actEnergyDlvd), // energy delivered *to* the house through this meter
      exportedWh: num(r.actEnergyRcvd),
    };
  }
  return out;
}

function eim(list, type) {
  return Array.isArray(list) ? list.find((x) => x.type === "eim" && x.measurementType === type) : undefined;
}

// whToday is unreliable on firmware D8 (it mirrors whLifetime), so only lifetime
// counters are sent and the server works out "today" from a midnight baseline.
// Without an enabled net-consumption meter, total-consumption just echoes
// production, so home/grid figures are only reported when that meter is on.
function summarise(production, meters) {
  const p = eim(production?.production, "production");
  const inv = production?.production?.find?.((x) => x.type === "inverters");
  const total = eim(production?.consumption, "total-consumption");
  const net = eim(production?.consumption, "net-consumption");
  const hasConsumption = Array.isArray(meters) && meters.some((m) => m.measurementType === "net-consumption" && m.state === "enabled");
  return {
    solarW: num(p?.wNow) ?? num(inv?.wNow),
    solarWhLifetime: num(p?.whLifetime) ?? num(inv?.whLifetime),
    hasConsumption,
    homeW: hasConsumption ? num(total?.wNow) : null,
    homeWhLifetime: hasConsumption ? num(total?.whLifetime) : null,
    gridW: hasConsumption ? num(net?.wNow) : null, // + importing, − exporting
    activeInverters: num(inv?.activeCount),
  };
}

function panels(inverters, inventory) {
  if (!Array.isArray(inverters)) return null;
  const pcu = (Array.isArray(inventory) ? inventory.find((g) => g.type === "PCU")?.devices : null) || [];
  return inverters.map((i) => {
    const d = pcu.find((x) => x.serial_num === i.serialNumber);
    return {
      sn: i.serialNumber,
      w: i.lastReportWatts,
      max: i.maxReportWatts,
      // Dead units read 0 here; the inventory still remembers their last report.
      at: i.lastReportDate || Number(d?.last_rpt_date) || 0,
      producing: d ? d.producing : null,
      communicating: d ? d.communicating : null,
      status: d?.device_status?.filter((s) => !/\.ok$/.test(s)) ?? [],
    };
  });
}

function batteries(ensemble, livedata) {
  const encharge = Array.isArray(ensemble) ? ensemble.find((g) => g.type === "ENCHARGE")?.devices : null;
  if (!encharge?.length) return null;
  return {
    socPct: num(livedata?.meters?.soc) ?? Math.round(encharge.reduce((a, b) => a + (b.percentFull || 0), 0) / encharge.length),
    w: num(livedata?.meters?.storage?.agg_p_mw) != null ? livedata.meters.storage.agg_p_mw / 1000 : null,
    units: encharge.map((b) => ({ sn: b.serial_num, pct: b.percentFull, status: b.led_status, comm: b.communicating })),
  };
}

function tokenExpiry() {
  try {
    const payload = JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

// ---- Home Assistant: per-device power ------------------------------------
// Any HA sensor with device_class "power" (smart plugs, energy monitors) is
// reported with its HA room ("area"), so the dashboard can rank devices and rooms.

const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;
let haRooms = { at: 0, map: {} };

async function ha(path, init) {
  const res = await fetch(HA_URL + path, {
    ...init,
    headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Home Assistant ${path} ${res.status}`);
  return res.json();
}

async function haDevices() {
  if (!HA_URL || !HA_TOKEN) return null;
  const states = await ha("/api/states");
  const power = states.filter((e) => e.attributes?.device_class === "power" && ["W", "kW"].includes(e.attributes.unit_of_measurement));
  // Room lookups change rarely; refresh every 30 minutes or when a new sensor appears.
  if (Date.now() - haRooms.at > 30 * 60_000 || power.some((e) => !(e.entity_id in haRooms.map))) {
    if (power.length) {
      const pairs = power.map((e) => `"${e.entity_id}": [area_name("${e.entity_id}"), device_attr(device_id("${e.entity_id}"), "name")]`);
      haRooms = { at: Date.now(), map: await ha("/api/template", { method: "POST", body: JSON.stringify({ template: `{{ {${pairs.join(",")}} | tojson }}` }) }).catch(() => ({})) };
    } else haRooms = { at: Date.now(), map: {} };
  }
  return power
    .map((e) => {
      const v = Number(e.state);
      const [room, device] = haRooms.map[e.entity_id] || [];
      return {
        id: e.entity_id,
        name: device || e.attributes.friendly_name || e.entity_id,
        room: room || null,
        w: Number.isFinite(v) ? (e.attributes.unit_of_measurement === "kW" ? v * 1000 : v) : null,
      };
    })
    .filter((d) => d.w != null);
}

// ---- Dad's briefing: a local open-weight model explains the numbers ------
// The dashboard hands over a small set of facts; Ollama on this PC turns them
// into a plain-English note. No cloud AI involved, nothing to pay for.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL; // e.g. gemma3:4b; unset = no briefing
const BRIEFING_MS = Number(process.env.BRIEFING_HOURS || 6) * 3600_000;
const BRIEFING_URL = INGEST_URL && new URL("/api/briefing", INGEST_URL).href;

const BRIEFING_PROMPT = `You write a short daily note for a homeowner about his rooftop solar panels and his electric bill. He is not technical. He wants to know: is the solar working, why is the bill what it is, and is there anything he needs to do.

Rules:
- Use ONLY the facts in the JSON you are given. Never invent numbers, causes, or devices. If something is null or missing, don't mention it.
- Plain words. Say "panel" or "microinverter (the small box under each panel)" and explain any term once. No jargon like "kWh" without saying it means units of electricity on the bill.
- Start with one sentence on how things look overall. Then 3 to 5 short lines starting with "- ", most important first: anything that needs action, then the bill, then solar production.
- Problems with severity "critical" or "warning" come first and say what to do. Ignore "info" problems unless nothing else is wrong.
- Under 150 words. Friendly and calm, like a helpful family member. No greeting, no sign-off, no markdown other than the "- " lines.`;

const ollamaChat = async (facts) => {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.3 },
      messages: [
        { role: "system", content: BRIEFING_PROMPT },
        { role: "user", content: JSON.stringify(facts) },
      ],
    }),
    signal: AbortSignal.timeout(5 * 60_000), // first run loads the model into memory
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // Thinking models (qwen3) may wrap their reasoning in <think> tags.
  return (await res.json()).message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
};

async function briefing() {
  const auth = { Authorization: `Bearer ${INGEST_SECRET}` };
  const factsRes = await fetch(BRIEFING_URL, { headers: auth });
  if (!factsRes.ok) throw new Error(`briefing facts ${factsRes.status}`);
  const text = await ollamaChat(await factsRes.json());
  const res = await fetch(BRIEFING_URL, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model: OLLAMA_MODEL }),
  });
  if (!res.ok) throw new Error(`briefing push ${res.status}`);
  return text;
}

// ---- main loop -----------------------------------------------------------

let tick = 0;
let slow = { panels: null, batteries: null };

async function collect() {
  const [production, meters, readings] = await Promise.all([
    gatewayGet(ENDPOINTS.production),
    tryGet(ENDPOINTS.meters),
    tryGet(ENDPOINTS.readings),
  ]);
  if (tick % SLOW_EVERY === 0) {
    const [inverters, inventory, ensemble, livedata] = await Promise.all([
      tryGet(ENDPOINTS.inverters),
      tryGet(ENDPOINTS.inventory),
      tryGet(ENDPOINTS.ensemble),
      tryGet(ENDPOINTS.livedata),
    ]);
    slow = { panels: panels(inverters, inventory), batteries: batteries(ensemble, livedata) };
  }
  tick++;
  let devices = null;
  try { devices = await haDevices(); } catch (e) { console.error(`${new Date().toLocaleString()}  Home Assistant: ${e.message}`); }
  return {
    at: Date.now(),
    ...summarise(production, meters),
    meters: readMeters(meters, readings),
    panels: slow.panels,
    batteries: slow.batteries,
    ups: null, // filled in once the APC USB cable is connected
    devices,
    gatewayTokenExpires: tokenExpiry(),
  };
}

async function push(snapshot) {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function once() {
  const snap = await collect();
  if (args.has("--print") || !INGEST_URL) console.log(JSON.stringify(snap, null, 2));
  if (INGEST_URL) await push(snap);
  return snap;
}

if (args.has("--probe")) {
  await probe();
} else if (args.has("--briefing")) {
  if (!OLLAMA_MODEL || !BRIEFING_URL || !INGEST_SECRET) die("OLLAMA_MODEL, INGEST_URL and INGEST_SECRET are needed for --briefing");
  console.log(await briefing());
} else if (args.has("--once")) {
  await once();
} else {
  if (!INGEST_URL || !INGEST_SECRET) die("INGEST_URL and INGEST_SECRET are needed to run continuously");
  console.log(`collector: gateway ${GATEWAY}, every ${INTERVAL_MS / 1000}s -> ${INGEST_URL}`);
  const run = async () => {
    try {
      const s = await once();
      console.log(`${new Date().toLocaleString()}  solar ${Math.round(s.solarW ?? 0)} W  pushed ok`);
    } catch (e) {
      console.error(`${new Date().toLocaleString()}  ERROR ${e.message}`);
    }
  };
  await run();
  setInterval(run, INTERVAL_MS);
  if (OLLAMA_MODEL) {
    const write = () => briefing()
      .then(() => console.log(`${new Date().toLocaleString()}  briefing written by ${OLLAMA_MODEL}`))
      .catch((e) => console.error(`${new Date().toLocaleString()}  briefing: ${e.message}`));
    write();
    setInterval(write, BRIEFING_MS);
  }
}

// ---- helpers -------------------------------------------------------------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}
