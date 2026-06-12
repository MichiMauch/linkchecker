import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, COOKIE_NAME, sessionToken } from "./app/lib/auth.js";

export async function middleware(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();

  // The login page (and its server action) must stay reachable without a cookie.
  if (req.nextUrl.pathname.startsWith("/login")) return NextResponse.next();

  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  const expected = await sessionToken();
  if (cookie && cookie === expected) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
