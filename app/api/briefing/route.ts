import { bearer, safeEqual } from "@/lib/auth";
import { briefingFacts, setBriefing } from "@/lib/briefing";

// The home collector GETs the facts, has the local model explain them, and
// POSTs the text back. Same shared secret as /api/ingest.
const authorized = (req: Request) => safeEqual(bearer(req), process.env.INGEST_SECRET || "");

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await briefingFacts());
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { text, model } = (await req.json()) as { text?: unknown; model?: unknown };
  if (typeof text !== "string" || !text.trim() || typeof model !== "string") {
    return Response.json({ error: "bad briefing" }, { status: 400 });
  }
  await setBriefing({ text: text.trim().slice(0, 4000), model: model.slice(0, 80), at: Date.now() });
  return Response.json({ ok: true });
}
