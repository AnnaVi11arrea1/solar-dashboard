// Shared-secret checks. Runs in both the proxy and Node route handlers, so it
// sticks to Web Crypto.

export function bearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const SESSION_COOKIE = "sd_session";

// Read-only login for the DEV challenge judges (JUDGE_PASSWORD on Vercel). It
// stops working at the end of Nov 3, 2026, Chicago time, 30 days after launch.
export const JUDGE_UNTIL = Date.parse("2026-11-04T06:00:00Z");
const judgePassword = () => (Date.now() < JUDGE_UNTIL ? process.env.JUDGE_PASSWORD || "" : "");

export type Role = "owner" | "judge";

// The session cookie is a hash of the dashboard password, so changing the
// password signs everyone out.
export async function sessionValue(password: string) {
  const data = new TextEncoder().encode(`solar-dashboard:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Which login the session cookie belongs to; null = signed out. With no
// DASHBOARD_PASSWORD the dashboard is open and everyone is the owner.
export async function sessionRole(cookie: string): Promise<Role | null> {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return "owner";
  if (safeEqual(cookie, await sessionValue(password))) return "owner";
  const judge = judgePassword();
  if (judge && safeEqual(cookie, await sessionValue(`judge:${judge}`))) return "judge";
  return null;
}

// The role a typed password unlocks, and the cookie value for it.
export async function login(given: string): Promise<{ role: Role; cookie: string } | null> {
  const password = process.env.DASHBOARD_PASSWORD || "";
  if (password && safeEqual(given, password)) return { role: "owner", cookie: await sessionValue(password) };
  const judge = judgePassword();
  if (judge && safeEqual(given, judge)) return { role: "judge", cookie: await sessionValue(`judge:${judge}`) };
  return null;
}
