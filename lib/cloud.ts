import { call, ensureSystemId, freshTokens } from "./enphase";
import { setLifetime, setSummary } from "./store";
import type { CloudLifetime, CloudSummary } from "./types";

// Pulls the site summary and (optionally) the full daily production history.
// The daily cron runs this with includeLifetime: ~3 hits/day, ~90/month.
export async function refreshCloud({ includeLifetime }: { includeLifetime: boolean }) {
  const tokens = await freshTokens();
  if (!tokens) return { connected: false as const };
  const id = await ensureSystemId(tokens);

  const s = await call<Omit<CloudSummary, "fetchedAt">>(`/systems/${id}/summary`, tokens);
  await setSummary({ ...s, fetchedAt: Date.now() });

  if (includeLifetime) {
    const l = await call<{ start_date: string; production: number[] }>(`/systems/${id}/energy_lifetime`, tokens);
    const lifetime: CloudLifetime = { fetchedAt: Date.now(), start_date: l.start_date, production: l.production ?? [] };
    await setLifetime(lifetime);
  }
  return { connected: true as const };
}
