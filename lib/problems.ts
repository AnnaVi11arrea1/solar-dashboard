import type { CloudSummary, EnphaseTokens, Live, Panel } from "./types";
import { MONTHLY_BUDGET } from "./enphase";
import { TZ } from "./store";
import type { HomeUsePeriod } from "./billing";

export type Severity = "critical" | "serious" | "warning" | "info";
export type Problem = { id: string; severity: Severity; title: string; detail: string; action?: string };

const DAY = 86400_000;
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ });
const daysAgo = (ms: number) => Math.round((Date.now() - ms) / DAY);

const CLOUD_STATUS: Record<string, string> = {
  comm: "gateway not communicating",
  power: "production issue",
  meter: "meter issue",
  meter_issue: "meter issue",
  micro: "microinverter fault",
  battery: "battery issue",
  storage_idle: "battery idle",
};

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function isSilent(p: Panel) {
  return p.communicating === false || p.producing === false || !p.at;
}

export function findProblems(opts: {
  live: Live | null;
  tokens: EnphaseTokens | null;
  summary: CloudSummary | null;
  hits: number;
  cloudConfigured: boolean;
  usage?: HomeUsePeriod[];
}): Problem[] {
  const { live, tokens, summary, hits, cloudConfigured, usage } = opts;
  const out: Problem[] = [];
  const now = Date.now();

  // Home collector
  if (!live) {
    out.push({ id: "collector-never", severity: "serious", title: "No live data yet", detail: "The home collector hasn't sent anything to this dashboard.", action: "Start the collector on the home PC (see README)." });
  } else if (now - live.at > 5 * 60_000) {
    out.push({ id: "collector-stale", severity: "serious", title: "Home collector is offline", detail: `Last reading ${Math.round((now - live.at) / 60_000)} minutes ago. Live, per-panel and UPS data are paused.`, action: "Check that the home PC is on and the collector window is running." });
  }

  if (live?.panels?.length) {
    const silent = live.panels.filter(isSilent);
    for (const p of silent) {
      const since = p.at ? `since ${fmtDate(p.at * 1000)} (${daysAgo(p.at * 1000)} days)` : "and has never reported";
      out.push({
        id: `silent-${p.sn}`,
        severity: "critical",
        title: `Microinverter ${p.sn} is not reporting`,
        detail: `Not producing or communicating ${since}.${p.status.length ? ` Gateway flags: ${p.status.map((s) => s.split(".").pop()).join(", ")}.` : ""}`,
        action: "Covered by Enphase's microinverter warranty — contact Enphase support with this serial number.",
      });
    }

    // Underperformers: judged on energy produced today, like the Enphase app,
    // not instant watts (evening shade on a few panels is normal). Needs a
    // decent amount of sun first so a cloudy morning can't trigger it.
    const wh = live.panelsWhToday ?? {};
    const healthy = live.panels.filter((p) => !isSilent(p) && wh[p.sn] != null);
    const med = median(healthy.map((p) => wh[p.sn]));
    if (med >= 600) {
      for (const p of healthy) {
        const share = wh[p.sn] / med;
        if (share < 0.75) {
          out.push({
            id: `low-${p.sn}`,
            severity: "warning",
            title: `Panel ${p.sn} is behind the others today`,
            detail: `≈ ${Math.round(wh[p.sn])} Wh today vs a typical ${Math.round(med)} Wh (${Math.round(share * 100)}%).`,
            action: "One day can be shade or debris. If it keeps showing up on sunny days, have the panel checked.",
          });
        }
      }
    }
  }

  // Gateway token
  if (live?.gatewayTokenExpires) {
    const left = live.gatewayTokenExpires - now;
    if (left < 30 * DAY) {
      out.push({ id: "gateway-token", severity: left < 7 * DAY ? "serious" : "warning", title: "Gateway token expires soon", detail: `The collector's gateway token expires ${fmtDate(live.gatewayTokenExpires)}.`, action: "Create a new token at entrez.enphaseenergy.com (homeowner login) and paste it into collector/.env." });
    }
  }

  // Enphase cloud
  if (cloudConfigured && !tokens) {
    out.push({ id: "cloud-connect", severity: "info", title: "Enphase cloud not connected", detail: "History before this dashboard existed comes from the Enphase cloud.", action: "Use “Connect Enphase” below." });
  } else if (tokens && tokens.refreshExpires - now < 5 * DAY) {
    out.push({ id: "cloud-reconnect", severity: "warning", title: "Enphase connection about to lapse", detail: "The daily refresh hasn't run recently, so the cloud login is close to expiring.", action: "Use “Connect Enphase” to sign in again." });
  }
  if (summary?.status && summary.status !== "normal") {
    const known = CLOUD_STATUS[summary.status];
    const silentCount = live?.panels?.filter(isSilent).length ?? 0;
    // "micro" just echoes the dead microinverters already listed above.
    const echo = summary.status === "micro" && silentCount > 0;
    out.push({
      id: "cloud-status",
      severity: echo ? "info" : "warning",
      title: `Enphase cloud status: ${known ?? summary.status}`,
      detail: echo ? `Enphase's own monitoring sees the same microinverter fault${silentCount > 1 ? "s" : ""} listed above.` : "Enphase's own monitoring flags an issue with the system.",
      action: echo ? undefined : "Open the Enphase app for details.",
    });
  }
  if (hits >= MONTHLY_BUDGET * 0.8) {
    out.push({ id: "budget", severity: "info", title: "Enphase API budget nearly used", detail: `${hits} of ${MONTHLY_BUDGET} calls used this month; cloud refreshes pause at the limit.` });
  }

  // UPS
  if (live?.ups?.onBattery) {
    out.push({ id: "ups-battery", severity: "critical", title: "UPS is running on battery", detail: `Power to the UPS is out${live.ups.batteryPct != null ? `; battery at ${live.ups.batteryPct}%` : ""}.` });
  }

  // Home use jump vs the same billing period last year
  const lastBill = usage?.[usage.length - 1];
  if (lastBill?.lastYear && lastBill.perDay > lastBill.lastYear.perDay * 1.3) {
    const up = Math.round((lastBill.perDay / lastBill.lastYear.perDay - 1) * 100);
    out.push({
      id: "usage-jump",
      severity: "warning",
      title: `Home electricity use is up ${up}% on last year`,
      detail: `${lastBill.perDay.toFixed(0)} kWh/day in the latest bill vs ${lastBill.lastYear.perDay.toFixed(0)} kWh/day a year earlier — $${lastBill.cost.toFixed(2)} vs $${lastBill.lastYear.cost.toFixed(2)}. Solar output is similar, so the house is using more.`,
      action: "Look for something new or running nonstop since early 2026 (space heater, computer rig, EV charging, an appliance that won't cycle off).",
    });
  }

  // Missing hardware (informational)
  if (live && !live.hasConsumption) {
    out.push({ id: "no-consumption", severity: "info", title: "Home usage isn't measured", detail: "The gateway's consumption meter is disabled, so home use and grid import/export can't be shown.", action: "Ask a solar technician to install or enable the consumption CTs." });
  }

  const order: Severity[] = ["critical", "serious", "warning", "info"];
  return out.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}
