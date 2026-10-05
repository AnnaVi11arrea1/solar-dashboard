import type { Device, DeviceDay } from "@/lib/types";

// Ranks measured devices (Home Assistant power sensors + the UPS) and rooms by
// the energy they use, with an estimated monthly cost at the ComEd rate.

type Row = { id: string; name: string; room: string; w: number | null; todayKwh: number; dailyKwh: number; estimated: boolean };

const NO_ROOM = "No room set";
const money = (v: number) => `$${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString()}`;
const kwh = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} kWh`;
const watts = (w: number | null) => (w == null ? "—" : w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);

export function PowerBreakdown(props: {
  devices: Device[];
  today: DeviceDay;
  history: Record<string, DeviceDay>;
  rate: number;
  typicalDayKwh: number | null;
  dayFraction: number;
  haConfigured: boolean;
  upsConnected: boolean;
}) {
  const { devices, today, history, rate, typicalDayKwh, dayFraction, haConfigured, upsConnected } = props;
  const recentDays = Object.keys(history).sort().slice(-7);

  const ids = new Set([...devices.map((d) => d.id), ...Object.keys(today)]);
  const rows: Row[] = [...ids].map((id) => {
    const live = devices.find((d) => d.id === id);
    const t = today[id];
    const past = recentDays.map((d) => history[d][id]?.wh).filter((v): v is number => v != null);
    const todayKwh = (t?.wh ?? 0) / 1000;
    // Prefer the average of finished days; until there are any, project today's pace.
    const estimated = past.length === 0;
    const dailyKwh = estimated ? todayKwh / Math.max(dayFraction, 0.05) : past.reduce((a, b) => a + b, 0) / past.length / 1000;
    return { id, name: live?.name ?? t?.name ?? id, room: live?.room ?? t?.room ?? NO_ROOM, w: live?.w ?? null, todayKwh, dailyKwh, estimated };
  });
  rows.sort((a, b) => b.dailyKwh - a.dailyKwh || (b.w ?? 0) - (a.w ?? 0));

  if (!rows.length) {
    return (
      <div className="empty-state">
        <p className="empty">
          {haConfigured
            ? "Home Assistant is connected, but none of its devices report watts yet."
            : "No measured devices yet."}{" "}
          Plug the things you suspect into energy-monitoring smart plugs (Shelly Plug US, TP-Link Tapo P110M or Eve Energy), add them to Home Assistant and give each one a room. They’ll show up here automatically, ranked by cost.
        </p>
        {!upsConnected && <p className="empty">The desk UPS joins this list once its APC USB data cable (940-0127) is connected.</p>}
      </div>
    );
  }

  const rooms = new Map<string, { w: number; dailyKwh: number; count: number }>();
  for (const r of rows) {
    const g = rooms.get(r.room) ?? { w: 0, dailyKwh: 0, count: 0 };
    rooms.set(r.room, { w: g.w + (r.w ?? 0), dailyKwh: g.dailyKwh + r.dailyKwh, count: g.count + 1 });
  }
  const roomRows = [...rooms.entries()].sort((a, b) => b[1].dailyKwh - a[1].dailyKwh);

  const nowW = rows.reduce((a, r) => a + (r.w ?? 0), 0);
  const dailyTotal = rows.reduce((a, r) => a + r.dailyKwh, 0);
  const anyEstimated = rows.some((r) => r.estimated);
  const maxDaily = Math.max(...rows.map((r) => r.dailyKwh), 0.001);
  const maxRoom = Math.max(...roomRows.map(([, g]) => g.dailyKwh), 0.001);

  return (
    <>
      <div className="tiles wide">
        <Tile label="Measured now" value={watts(nowW)} />
        <Tile label="Measured today" value={kwh(rows.reduce((a, r) => a + r.todayKwh, 0))} />
        <Tile label={`≈ Cost / month${anyEstimated ? " (est.)" : ""}`} value={money(dailyTotal * 30 * rate)} />
        {typicalDayKwh ? <Tile label="Share of a typical day" value={`${Math.min(100, Math.round((dailyTotal / typicalDayKwh) * 100))}%`} /> : null}
      </div>
      <p className="sub" style={{ marginTop: 14 }}>
        Ranked by energy per day{anyEstimated ? " (projected from today until a full day is recorded)" : ", last 7 days"} · cost at ≈ ${rate.toFixed(2)}/kWh from your ComEd bills
      </p>

      <ul className="hbars">
        {rows.map((r) => (
          <li key={r.id} title={`${r.name}: ${watts(r.w)} now · ${kwh(r.todayKwh)} today`}>
            <div className="hbar-label">
              <strong>{r.name}</strong>
              <span>{r.room}</span>
            </div>
            <div className="hbar-track">
              <div className="hbar-fill" style={{ width: `${(r.dailyKwh / maxDaily) * 100}%` }} />
            </div>
            <div className="hbar-vals">
              <strong>{money(r.dailyKwh * 30 * rate)}/mo</strong>
              <span>{kwh(r.dailyKwh)}/day · {watts(r.w)} now</span>
            </div>
          </li>
        ))}
      </ul>

      {roomRows.length > 1 && (
        <>
          <h3 className="h3">By room</h3>
          <ul className="hbars rooms">
            {roomRows.map(([room, g]) => (
              <li key={room}>
                <div className="hbar-label">
                  <strong>{room}</strong>
                  <span>{g.count} device{g.count === 1 ? "" : "s"}</span>
                </div>
                <div className="hbar-track">
                  <div className="hbar-fill" style={{ width: `${(g.dailyKwh / maxRoom) * 100}%` }} />
                </div>
                <div className="hbar-vals">
                  <strong>{money(g.dailyKwh * 30 * rate)}/mo</strong>
                  <span>{kwh(g.dailyKwh)}/day · {watts(g.w)} now</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {!upsConnected && <p className="sub" style={{ marginTop: 12 }}>The desk UPS joins this list once its APC USB data cable is connected.</p>}
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
