import { connection } from "next/server";
import { AutoRefresh } from "./components/AutoRefresh";
import { Bars, DayLine } from "./components/charts";
import { getPvBenchmark, getDeviceHistory, getDaily, getHits, getLifetime, getLive, getSeries, getSummary, getTokens, dayKey, TZ } from "@/lib/store";
import { bestDay, dailyWh, lastNDays, lastNMonths } from "@/lib/history";
import { findProblems, isSilent, type Severity } from "@/lib/problems";
import { MONTHLY_BUDGET } from "@/lib/enphase";
import type { Panel } from "@/lib/types";
import { placePanels } from "@/lib/layout";
import { effectiveRate, getBilling, homeUse, type HomeUsePeriod } from "@/lib/billing";
import { PowerBreakdown } from "./components/PowerBreakdown";

const CO2_KG_PER_KWH = 0.39; // approximate US grid average

const kw = (w: number | null | undefined) => (w == null ? "—" : w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);
const kwh = (wh: number | null | undefined, d = 1) => (wh == null ? "—" : `${(wh / 1000).toLocaleString("en-US", { maximumFractionDigits: d })} kWh`);

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function midnight(day: string) {
  // Offset of the home timezone on that day, e.g. "GMT-05:00".
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${day}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "Z";
  return Date.parse(`${day}T00:00:00${off === "" ? "Z" : off}`);
}

async function load() {
  await connection();
  const now = Date.now();
  const today = dayKey(now);
  const [live, series, local, lifetime, summary, tokens, hits, billing, deviceHistory, pv] = await Promise.all([
    getLive(), getSeries(today), getDaily(), getLifetime(), getSummary(), getTokens(), getHits(), getBilling(), getDeviceHistory(), getPvBenchmark(),
  ]);
  return { now, today, live, series, local, lifetime, summary, tokens, hits, billing, deviceHistory, pv };
}

const ICON: Record<Severity, string> = { critical: "✕", serious: "!", warning: "▲", info: "i" };

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const { now, today, live, series, local, lifetime, summary, tokens, hits, billing, deviceHistory, pv } = await load();
  const cloudConfigured = !!(process.env.ENPHASE_CLIENT_ID && process.env.ENPHASE_API_KEY);

  const fresh = live && now - live.at < 5 * 60_000 && live.day === today;
  // The local count only covers time since the collector first ran today, so
  // take the Enphase cloud figure when it is from today and larger.
  const localToday = live && live.day === today && live.solarWhLifetime != null && live.dayBaseSolarWh != null
    ? live.solarWhLifetime - live.dayBaseSolarWh
    : null;
  const cloudToday = summary && dayKey(summary.fetchedAt) === today ? summary.energy_today ?? null : null;
  const todayWh = localToday == null ? cloudToday : Math.max(localToday, cloudToday ?? 0);
  const daily = dailyWh(lifetime, local, today, todayWh);
  const days = lastNDays(daily, today, 30);
  // Expected production per month (PVWatts); the current month is prorated to today.
  const [ty, tm, td] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const months = lastNMonths(daily, today, 12).map((m, i, all) => {
    const exp = pv?.monthlyKwh[Number(m.key.slice(5, 7)) - 1];
    return exp == null ? m : { ...m, marker: i === all.length - 1 ? (exp * td) / daysInMonth : exp };
  });
  // Last 12 *complete* months vs expectation.
  const fullYear = lastNMonths(daily, today, 13).slice(0, 12);
  const vsExpected = pv ? fullYear.reduce((a, m) => a + m.value, 0) / fullYear.reduce((a, m) => a + pv.monthlyKwh[Number(m.key.slice(5, 7)) - 1], 0) : null;
  const monthWh = months[months.length - 1].value * 1000;
  const lifetimeWh = live?.solarWhLifetime ?? summary?.energy_lifetime ?? null;
  const best = bestDay(daily);
  const solarNow = fresh ? live.solarW : summary?.current_power ?? null;

  const panels = live?.panels ?? [];
  const working = panels.filter((p) => !isSilent(p)).length;
  const usage = homeUse(billing, daily);
  const problems = findProblems({ live, tokens, summary, hits, cloudConfigured, usage });
  const dayStart = midnight(today);
  const points = series.filter((p) => p[1] != null).map((p) => [p[0], p[1] as number] as [number, number]);

  return (
    <main className="page">
      <AutoRefresh />
      <header className="top">
        <h1>SOLAR<span className="h1-accent">{"//GRID"}</span></h1>
        <p className="muted">
          {live ? (
            <>
              <span className={`live-dot ${fresh ? "on" : "off"}`} aria-hidden /> {fresh ? "Live from the gateway" : "Gateway offline"} · updated {ago(live.at)}
            </>
          ) : summary ? `From Enphase cloud · updated ${ago(summary.fetchedAt)}` : "Waiting for the first reading"}
        </p>
      </header>
      {params.connected && <p className="notice">Enphase cloud connected — history loaded.</p>}

      <section className="hero card">
        <div className="hero-main">
          <span className="label">Producing now</span>
          <span className="hero-value">{kw(solarNow)}</span>
        </div>
        <div className="tiles">
          <Tile label="Today" value={kwh(todayWh)} />
          <Tile label="This month" value={kwh(monthWh, 0)} />
          <Tile label="Lifetime" value={lifetimeWh == null ? "—" : `${(lifetimeWh / 1e6).toFixed(1)} MWh`} />
          <Tile label="Panels working" value={panels.length ? `${working} of ${panels.length}` : "—"} />
        </div>
      </section>

      <section className="card">
        <h2>Problems {problems.length > 0 && <span className="count">{problems.length}</span>}</h2>
        {problems.length === 0 ? (
          <p className="ok"><span className="status-icon good" aria-hidden>✓</span> Everything looks normal.</p>
        ) : (
          <ul className="problems">
            {problems.map((p) => (
              <li key={p.id} className={`problem ${p.severity}`}>
                <span className={`status-icon ${p.severity}`} aria-hidden>{ICON[p.severity]}</span>
                <div>
                  <strong>{p.title}</strong> <span className="sev">{p.severity}</span>
                  <p>{p.detail}</p>
                  {p.action && <p className="action">{p.action}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {panels.length > 0 && (
        <section className="card">
          <h2>Panels</h2>
          <p className="sub">Roof layout · energy today per microinverter (like the Enphase app) with watts right now · brighter = producing closer to its best right now</p>
          <PanelGrid panels={panels} whToday={live?.day === today ? live.panelsWhToday ?? {} : {}} />
        </section>
      )}

      <section className="card">
        <h2>Today’s production</h2>
        <p className="sub">Solar output in watts, every minute from the gateway</p>
        {points.length ? <DayLine points={points} startMs={dayStart} endMs={dayStart + 86400_000} /> : <p className="empty">No readings yet today.</p>}
      </section>

      <section className="card">
        <h2>Last 30 days</h2>
        <p className="sub">Energy produced per day, kWh{best ? ` · best day ${(best.wh / 1000).toFixed(1)} kWh on ${best.label}` : ""}</p>
        <Bars bars={days} unit="kWh" />
        <details>
          <summary>Show as table</summary>
          <table>
            <thead><tr><th>Day</th><th>kWh</th></tr></thead>
            <tbody>{[...days].reverse().map((d) => <tr key={d.key}><td>{d.label}</td><td>{d.value.toFixed(1)}</td></tr>)}</tbody>
          </table>
        </details>
      </section>

      <div className="two">
        <section className="card">
          <h2>Last 12 months</h2>
          <p className="sub">Energy produced per month, kWh</p>
          <Bars bars={months} unit="kWh" digits={0} height={180} markerLabel={pv ? "Expected (PVWatts)" : undefined} />
        </section>
        <section className="card">
          <h2>Impact</h2>
          <div className="tiles stacked">
            <Tile label="CO₂ avoided (≈ US grid average)" value={lifetimeWh == null ? "—" : `${((lifetimeWh / 1000) * CO2_KG_PER_KWH / 1000).toFixed(1)} t`} />
            <Tile label="Average day, last 30" value={kwh((days.reduce((a, d) => a + d.value, 0) / days.length) * 1000)} />
            {vsExpected != null && <Tile label="Last 12 months vs expected" value={`${Math.round(vsExpected * 100)}%`} />}
            {summary?.size_w ? <Tile label="System size" value={`${(summary.size_w / 1000).toFixed(2)} kW`} /> : null}
          </div>
        </section>
      </div>

      <section className="card">
        <h2>Home use &amp; grid</h2>
        {live?.hasConsumption ? (
          <div className="tiles">
            <Tile label="Home using" value={kw(live.homeW)} />
            <Tile label={live.gridW != null && live.gridW < 0 ? "Exporting to grid" : "Importing from grid"} value={kw(live.gridW == null ? null : Math.abs(live.gridW))} />
          </div>
        ) : (
          <p className="sub">Live home use needs consumption CTs (currently disabled). Below: ComEd bills + your solar, per billing period.</p>
        )}
        {usage.length > 0 && <HomeUse usage={usage} />}
      </section>

      <section className="card">
        <h2>Where the power goes</h2>
        <PowerBreakdown
          devices={fresh ? live.devices ?? [] : []}
          today={live?.day === today ? live.devicesToday ?? {} : {}}
          history={deviceHistory}
          rate={effectiveRate(billing)}
          typicalDayKwh={usage.length ? usage[usage.length - 1].perDay : null}
          dayFraction={(now - dayStart) / 86400_000}
          haConfigured={live?.devices != null}
          upsConnected={!!live?.ups}
        />
      </section>

      {live?.batteries && (
        <section className="card">
          <h2>Battery</h2>
          <Tile label="Charge" value={`${live.batteries.socPct ?? "—"}%`} />
        </section>
      )}

      <footer className="foot muted">
        {cloudConfigured ? (
          tokens ? (
            <>Enphase cloud connected · {hits}/{MONTHLY_BUDGET} API calls this month{summary ? ` · synced ${ago(summary.fetchedAt)}` : ""} · <a href="/api/enphase/connect">reconnect</a></>
          ) : (
            <a className="button" href="/api/enphase/connect">Connect Enphase</a>
          )
        ) : (
          <>Enphase cloud keys not set</>
        )}
      </footer>
    </main>
  );
}

// EIA 2024: average Illinois residential customer used 693 kWh/month.
const IL_AVG_KWH_PER_DAY = (693 * 12) / 365;

const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthYear = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
const pct = (a: number, b: number) => `${a >= b ? "+" : "−"}${Math.abs(Math.round((a / b - 1) * 100))}%`;

// Home use per ComEd billing period = grid net (import − export) + solar produced.
function HomeUse({ usage }: { usage: HomeUsePeriod[] }) {
  const last = usage[usage.length - 1];
  const bars = usage.map((u, i) => ({
    key: u.start,
    label: `${shortDate(u.start)} – ${shortDate(u.end)}: ${Math.round(u.homeKwh).toLocaleString()} kWh total = solar ${Math.round(u.solarKwh).toLocaleString()} + grid ${Math.round(u.netKwh).toLocaleString()} kWh · $${u.cost.toFixed(2)}`,
    value: u.perDay,
    tick: i % 6 === 0 || i === usage.length - 1 ? monthYear(u.end) : undefined,
    highlight: i === usage.length - 1,
  }));
  return (
    <>
      <p className="sub">Latest bill: {shortDate(last.start)} – {shortDate(last.end)}, {last.end.slice(0, 4)}</p>
      <div className="tiles wide">
        <Tile label="Bill" value={`$${last.cost.toFixed(2)}`} />
        <Tile label="Home used" value={`${Math.round(last.homeKwh).toLocaleString()} kWh`} />
        <Tile label="Per day" value={`${last.perDay.toFixed(0)} kWh`} />
        <Tile label="vs avg Illinois home" value={`${(last.perDay / IL_AVG_KWH_PER_DAY).toFixed(1)}×`} />
        {last.lastYear && <Tile label="vs last year" value={pct(last.perDay, last.lastYear.perDay)} />}
        <Tile label="Covered by solar" value={`${Math.round((last.solarKwh / last.homeKwh) * 100)}%`} />
      </div>
      <p className="sub" style={{ marginTop: 16 }}>Home use per day in each billing period, kWh · latest highlighted · hover for totals and cost</p>
      <Bars bars={bars} unit="kWh/day" digits={0} reference={{ value: IL_AVG_KWH_PER_DAY, label: `Avg Illinois home (${IL_AVG_KWH_PER_DAY.toFixed(0)} kWh/day)` }} />
      <details>
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>Period</th><th>Solar kWh</th><th>Grid net kWh</th><th>Home kWh</th><th>vs last year</th><th>Bill</th></tr></thead>
          <tbody>
            {[...usage].reverse().map((u) => (
              <tr key={u.start}>
                <td>{shortDate(u.start)} – {shortDate(u.end)} {u.end.slice(0, 4)}</td>
                <td>{Math.round(u.solarKwh).toLocaleString()}</td>
                <td>{Math.round(u.netKwh).toLocaleString()}</td>
                <td>{Math.round(u.homeKwh).toLocaleString()}</td>
                <td>{u.lastYear ? pct(u.perDay, u.lastYear.perDay) : "—"}</td>
                <td>${u.cost.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}

// Roof layout (lib/layout.ts). Brightness of each panel's glow = output relative
// to that microinverter's own best report today.
function PanelGrid({ panels, whToday }: { panels: Panel[]; whToday: Record<string, number> }) {
  const rows = placePanels(panels);
  const cols = Math.max(...rows.map((r) => r.length));
  return (
    <div className="array-scroll">
      <div className="array" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} role="list" aria-label="Solar array, roof layout">
        {rows.flatMap((row, r) =>
          row.map((p, c) => {
            if (!p) return <div key={`empty-${r}-${c}`} className="panel empty" aria-hidden />;
            const silent = isSilent(p);
            const lvl = silent || p.max <= 0 ? 0 : Math.min(1, p.w / p.max);
            const title = silent
              ? `${p.sn} — not reporting${p.at ? ` since ${new Date(p.at * 1000).toLocaleDateString("en-US", { timeZone: TZ })}` : ""}`
              : `${p.sn} — ≈ ${Math.round(whToday[p.sn] ?? 0)} Wh today · ${p.w} W now (best ${p.max} W), reported ${new Date(p.at * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ })}`;
            return (
              <div key={p.sn} role="listitem" className={silent ? "panel dead" : "panel"} title={title} style={{ ["--lvl" as string]: lvl.toFixed(2) }}>
                {silent ? (
                  <span className="panel-alert" aria-label="not reporting">!</span>
                ) : (
                  <>
                    <span className="panel-w">
                      {whToday[p.sn] != null ? <>{Math.round(whToday[p.sn])}<small>Wh</small></> : <>{p.w}<small>W</small></>}
                    </span>
                    {whToday[p.sn] != null && <span className="panel-now">{p.w} W now</span>}
                  </>
                )}
                <span className="panel-tag">IQ7+</span>
                <span className="panel-sn">{p.sn.slice(-4)}</span>
              </div>
            );
          }),
        )}
      </div>
    </div>
  );
}
