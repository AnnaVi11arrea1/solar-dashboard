import { exchangeCode, ensureSystemId } from "@/lib/enphase";
import { takeOauthState } from "@/lib/store";
import { refreshCloud } from "@/lib/cloud";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = await takeOauthState();
  if (!code || !state || state !== expected) {
    return new Response("Enphase connection failed: missing or stale request. Try Connect again.", { status: 400 });
  }
  const redirectUri = new URL("/api/enphase/callback", req.url).toString();
  const tokens = await exchangeCode(code, redirectUri);
  await ensureSystemId(tokens);
  await refreshCloud({ includeLifetime: true });
  return Response.redirect(new URL("/?connected=1", req.url), 302);
}
