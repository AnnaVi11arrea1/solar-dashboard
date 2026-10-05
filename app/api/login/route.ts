import { NextResponse } from "next/server";
import { JUDGE_UNTIL, SESSION_COOKIE, login } from "@/lib/auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const given = String(form.get("password") || "");
  const next = String(form.get("next") || "/");
  const target = new URL(next.startsWith("/") && !next.startsWith("//") ? next : "/", req.url);

  const session = await login(given);
  if (!session) {
    const back = new URL("/login", req.url);
    back.searchParams.set("error", "1");
    back.searchParams.set("next", target.pathname);
    return NextResponse.redirect(back, 303);
  }
  const res = NextResponse.redirect(target, 303);
  res.cookies.set(SESSION_COOKIE, session.cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    // Judge sessions end when judge access does.
    maxAge: session.role === "judge" ? Math.max(0, Math.floor((JUDGE_UNTIL - Date.now()) / 1000)) : 60 * 60 * 24 * 90,
  });
  return res;
}
