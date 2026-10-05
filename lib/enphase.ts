// Enphase cloud API v4 (free "Watt" plan: 1,000 hits/month, 10/min, site-level only).
// Every call goes through call(), which counts hits and refuses past the budget.

import { countHit, getHits, getTokens, setTokens } from "./store";
import type { EnphaseTokens } from "./types";

const API = "https://api.enphaseenergy.com";
export const MONTHLY_BUDGET = 900; // leave headroom under the 1,000 hard limit

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const basicAuth = () => "Basic " + Buffer.from(`${env("ENPHASE_CLIENT_ID")}:${env("ENPHASE_CLIENT_SECRET")}`).toString("base64");

export function authorizeUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: env("ENPHASE_CLIENT_ID"), redirect_uri: redirectUri, state });
  return `${API}/oauth/authorize?${q}`;
}

async function tokenRequest(params: Record<string, string>, prev?: EnphaseTokens) {
  await countHit();
  const res = await fetch(`${API}/oauth/token?${new URLSearchParams(params)}`, { method: "POST", headers: { Authorization: basicAuth() } });
  if (!res.ok) throw new Error(`Enphase token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const now = Date.now();
  const tokens: EnphaseTokens = {
    access: j.access_token,
    refresh: j.refresh_token,
    accessExpires: now + (j.expires_in ?? 86400) * 1000,
    refreshExpires: now + 30 * 86400 * 1000, // refresh tokens last one month and rotate on use
    systemId: prev?.systemId ?? (process.env.ENPHASE_SYSTEM_ID ? Number(process.env.ENPHASE_SYSTEM_ID) : undefined),
  };
  await setTokens(tokens);
  return tokens;
}

export const exchangeCode = (code: string, redirectUri: string) =>
  tokenRequest({ grant_type: "authorization_code", redirect_uri: redirectUri, code });

// Refresh when the access token has under 2h left (the daily cron keeps it alive).
export async function freshTokens() {
  const t = await getTokens();
  if (!t) return null;
  if (t.accessExpires - Date.now() > 2 * 3600 * 1000) return t;
  return tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh }, t);
}

export async function call<T>(path: string, tokens: EnphaseTokens): Promise<T> {
  if ((await getHits()) >= MONTHLY_BUDGET) throw new Error("Enphase monthly API budget reached; skipping call");
  await countHit();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API}/api/v4${path}${sep}key=${env("ENPHASE_API_KEY")}`, {
    headers: { Authorization: `Bearer ${tokens.access}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Enphase ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Looks up the system ID once (if not configured) and remembers it with the tokens.
export async function ensureSystemId(tokens: EnphaseTokens) {
  if (tokens.systemId) return tokens.systemId;
  const j = await call<{ systems?: { system_id: number }[] }>("/systems", tokens);
  const id = j.systems?.[0]?.system_id;
  if (!id) throw new Error("No Enphase systems found on this account");
  await setTokens({ ...tokens, systemId: id });
  return id;
}
