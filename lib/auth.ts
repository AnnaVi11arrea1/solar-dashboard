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

// The session cookie is a hash of the dashboard password, so changing the
// password signs everyone out.
export async function sessionValue(password: string) {
  const data = new TextEncoder().encode(`solar-dashboard:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
