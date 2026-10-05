import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, safeEqual, sessionValue } from "@/lib/auth";

// Password gate for the dashboard (only when DASHBOARD_PASSWORD is set).
// The collector and the cron job authenticate with their own bearer secrets.
export async function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();
  const cookie = req.cookies.get(SESSION_COOKIE)?.value || "";
  if (safeEqual(cookie, await sessionValue(password))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL("/login", req.url);
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/login|api/ingest|api/cron|_next/static|_next/image|favicon.ico|icon).*)"],
};
