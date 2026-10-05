// Shape of what the home collector posts to /api/ingest (see collector/collector.mjs).

export type Panel = {
  sn: string;
  w: number;
  max: number;
  at: number; // unix seconds of the microinverter's last report (0 = never)
  producing: boolean | null;
  communicating: boolean | null;
  status: string[]; // non-ok gateway status flags
};

// A measured device: a Home Assistant power sensor, or the UPS.
export type Device = { id: string; name: string; room: string | null; w: number };

export type Snapshot = {
  at: number; // ms
  solarW: number | null;
  solarWhLifetime: number | null;
  hasConsumption: boolean;
  homeW: number | null;
  homeWhLifetime: number | null;
  gridW: number | null;
  activeInverters: number | null;
  panels: Panel[] | null;
  batteries: { socPct: number | null; w: number | null; units: { sn: string; pct: number; status: number; comm: boolean }[] } | null;
  ups: { w: number | null; loadPct: number | null; onBattery: boolean; batteryPct: number | null; model?: string } | null;
  gatewayTokenExpires: number | null; // ms
  devices?: Device[] | null; // null = Home Assistant not configured
};

// Energy each device used so far today, integrated from the 1-minute readings.
export type DeviceDay = Record<string, { name: string; room: string | null; wh: number }>;

// What the server keeps as "live": the snapshot plus the midnight counter baseline.
export type Live = Snapshot & {
  day: string; // YYYY-MM-DD in the home timezone
  dayBaseSolarWh: number | null;
  dayBaseHomeWh: number | null;
  devicesToday?: DeviceDay;
  // Per-microinverter energy today (Wh), integrated from the ~5-minute panel reports.
  panelsWhToday?: Record<string, number>;
  panelsAt?: number; // ms of the last snapshot that carried panel data
  // The day's first reading came before sunrise, so panelsWhToday covers the
  // whole day (false on a day the collector started mid-morning).
  dayStartedDark?: boolean;
};

// One point per ingest in today's series: [ms, solarW, homeW, gridW, upsW]
export type SeriesPoint = [number, number | null, number | null, number | null, number | null];

export type EnphaseTokens = {
  access: string;
  refresh: string;
  accessExpires: number; // ms
  refreshExpires: number; // ms
  systemId?: number;
};

export type CloudSummary = {
  fetchedAt: number;
  status?: string;
  energy_today?: number;
  energy_lifetime?: number;
  current_power?: number;
  last_report_at?: number;
  size_w?: number;
  operational_at?: number;
};

export type CloudLifetime = {
  fetchedAt: number;
  start_date: string;
  production: number[]; // Wh per day from start_date
};
