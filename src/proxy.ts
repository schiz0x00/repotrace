import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Route protection:
 *  - authenticated dashboard area (everything except /login, /signup and the
 *    auth API) requires a Better Auth session cookie
 *  - /login and /signup redirect signed-in users to the dashboard
 *  - API and MCP routes handle their own authentication (session OR API key),
 *    so they are excluded here.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = getSessionCookie(request);

  if (
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password"
  ) {
    if (sessionCookie && pathname !== "/forgot-password" && pathname !== "/reset-password") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  const isPublic = pathname.startsWith("/api/") || pathname.startsWith("/mcp");
  if (!isPublic && !sessionCookie) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};