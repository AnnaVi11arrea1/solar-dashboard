import { NextResponse } from "next/server";
import { SESSION_COOKIE, safeEqual, sessionValue } from "@/lib/auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const password = process.env.DASHBOARD_PASSWORD || "";
  const given = String(form.get("password") || "");
  const next = String(form.get("next") || "/");
  const target = new URL(next.startsWith("/") && !next.startsWith("//") ? next : "/", req.url);

  if (!password || !safeEqual(given, password)) {
    const back = new URL("/login", req.url);
    back.searchParams.set("error", "1");
    back.searchParams.set("next", target.pathname);
    return NextResponse.redirect(back, 303);
  }
  const res = NextResponse.redirect(target, 303);
  res.cookies.set(SESSION_COOKIE, await sessionValue(password), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return res;
}
