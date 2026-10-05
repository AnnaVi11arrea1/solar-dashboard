import { authorizeUrl } from "@/lib/enphase";
import { setOauthState } from "@/lib/store";

// Starts the one-time "Connect Enphase" flow. Behind the dashboard password.
export async function GET(req: Request) {
  const state = crypto.randomUUID();
  await setOauthState(state);
  const redirectUri = new URL("/api/enphase/callback", req.url).toString();
  return Response.redirect(authorizeUrl(redirectUri, state), 302);
}
