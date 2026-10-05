import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionRole } from "@/lib/auth";

// Password gate for the dashboard (only when DASHBOARD_PASSWORD is set), with
// a read-only judge login (lib/auth.ts).
// The collector (ingest, briefing) and the cron job authenticate with their own bearer secrets.
export async function proxy(req: NextRequest) {
  const role = await sessionRole(req.cookies.get(SESSION_COOKIE)?.value || "");
  const api = req.nextUrl.pathname.startsWith("/api/");
  // Judges get the dashboard page only, not the Enphase connect routes.
  if (role === "owner" || (role === "judge" && !api)) return NextResponse.next();
  if (api) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL("/login", req.url);
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/login|api/ingest|api/briefing|api/cron|_next/static|_next/image|favicon.ico|icon).*)"],
};
