import { bearer, safeEqual } from "@/lib/auth";
import { ingest } from "@/lib/store";
import type { Snapshot } from "@/lib/types";

// The home collector posts a snapshot here every minute.
export async function POST(req: Request) {
  if (!safeEqual(bearer(req), process.env.INGEST_SECRET || "")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const snap = (await req.json()) as Snapshot;
  if (typeof snap?.at !== "number") return Response.json({ error: "bad snapshot" }, { status: 400 });
  // Trust the server clock if the home PC's clock has drifted by more than 10 minutes.
  if (Math.abs(snap.at - Date.now()) > 10 * 60 * 1000) snap.at = Date.now();
  const live = await ingest(snap);
  return Response.json({ ok: true, day: live.day });
}
