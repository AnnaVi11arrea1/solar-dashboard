import { bearer, safeEqual } from "@/lib/auth";
import { refreshCloud } from "@/lib/cloud";

// Vercel Cron calls this once a day (vercel.json) with CRON_SECRET as a bearer token.
// It keeps the Enphase refresh token alive and pulls cloud history.
export async function GET(req: Request) {
  if (!safeEqual(bearer(req), process.env.CRON_SECRET || "")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(await refreshCloud({ includeLifetime: true }));
  } catch (e) {
    console.error("daily cloud refresh failed:", e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
