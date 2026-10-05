# Solar dashboard

Private dashboard for the home Enphase system: https://solar-dashboard-coral.vercel.app

```
Home PC ── collector/collector.mjs (every 60 s)
   ├─ Ollama (gemma3:4b, local) ── Dad's briefing every 6 h
   ├─ IQ Gateway (192.168.1.166, local API, owner token)
   └─ APC UPS (not yet — needs APC USB cable 940-0127)
        │ POST /api/ingest  (Bearer INGEST_SECRET)
        ▼
Vercel (Next.js 16) ── Upstash Redis ── dashboard page (DASHBOARD_PASSWORD)
        ▲
        └─ /api/cron/daily (Vercel Cron, 11:00 UTC) → Enphase cloud API v4
           summary + daily history, ~3 calls/day of the free 1,000/month
```

## Collector

Runs from the Windows scheduled task **Solar Dashboard Collector** (starts at logon, hidden,
logs to `collector/collector.log`).

```sh
node collector/collector.mjs --once --print   # one reading, printed and pushed
node collector/collector.mjs --probe          # dump raw gateway JSON to collector/probe/
```

Config is `collector/.env` (template: `collector/.env.example`). The gateway token expires
yearly — the dashboard's Problems list warns 30 days ahead. Renew at
https://entrez.enphaseenergy.com using the **homeowner** login (not the developer account).

## Vercel environment variables

| Name | What |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Added by the Upstash integration |
| `INGEST_SECRET` | Shared with `collector/.env` |
| `CRON_SECRET` | Sent by Vercel Cron to `/api/cron/daily` |
| `DASHBOARD_PASSWORD` | Login for the dashboard |
| `JUDGE_PASSWORD` | Read-only judge login (bill amounts hidden, no Enphase controls); stops working after Nov 3, 2026 (`JUDGE_UNTIL` in `lib/auth.ts`) |
| `ENPHASE_API_KEY`, `ENPHASE_CLIENT_ID`, `ENPHASE_CLIENT_SECRET` | Developer portal app |
| `ENPHASE_SYSTEM_ID` | Optional; looked up automatically after connecting |
| `HOME_TIMEZONE` | `America/Chicago` — when "today" starts |

After deploying, open the dashboard and click **Connect Enphase** once to authorize the cloud API.

## Known hardware gaps

- Consumption meter is disabled on the gateway → no home-use / grid data until CTs are installed or enabled.
- Two microinverters (202015011110, 202101033131) have stopped reporting — warranty claim with Enphase.

## ComEd billing data

Download the **billing** CSV from ComEd (Green Button → Download My Data), then:

```sh
node --env-file=.env.local scripts/import-comed.mjs path/to/billing.csv
```

Only the billing rows (dates, net kWh, cost) are stored, in Redis key `comed:billing`; the
name/address/account header is ignored. Re-run with newer downloads — periods merge by start date.
Home use per period = ComEd net kWh + solar produced.

## Where the power goes (per device / room)

The collector reads every Home Assistant sensor with `device_class: power` (W or kW) from
`HA_URL` using `HA_TOKEN` (in `collector/.env`), along with its HA area as the room. The UPS
joins the list once connected (`UPS_ROOM` env var on Vercel sets its room). Daily energy per
device is integrated on ingest (`live.devicesToday`) and rolled into Redis hash `devices:daily`
at midnight; the card ranks devices and rooms by kWh/day and ≈ $/month at the ComEd rate.

## Dad's briefing (local AI)

Every `BRIEFING_HOURS` (default 6) the collector GETs a small set of facts from
`/api/briefing` (solar today/month vs expected, latest bill, problems), has a local
open-weight model explain them in plain English through Ollama on the home PC, and
POSTs the text back (Redis key `briefing`). No cloud AI: the household's data only
goes to the model on this PC, and it costs nothing to run.

```sh
ollama pull gemma3:4b                          # once
node collector/collector.mjs --briefing        # write one now and print it
```

Set `OLLAMA_MODEL` in `collector/.env` to turn it on (`OLLAMA_URL` defaults to
`http://localhost:11434`). Any Ollama model works; swap it by changing that one line.

## Benchmarks

- **Expected solar** — PVWatts v8 (NLR, formerly NREL; API moved to developer.nlr.gov in 2026):
  `node --env-file=.env.local scripts/fetch-pvwatts.mjs <lat> <lon> 8.05 225 25` (town-level
  coordinates; southwest roof, ~25° tilt assumed). Stored in Redis `benchmark:pvwatts`; drawn as
  white markers on the 12-month chart.
- **Average Illinois home** — EIA 2024: 693 kWh/month (≈ 23 kWh/day), constant in `app/page.tsx`.
