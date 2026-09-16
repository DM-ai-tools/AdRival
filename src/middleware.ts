import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { parseSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/setup",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/status",
  "/api/admin/bootstrap",
  "/api/health",
  // Machine endpoint for deploy-time store import. It carries its own shared
  // secret check and is not reachable with a session cookie alone.
  "/api/admin/import-history",
];

function matches(pathname: string, paths: string[]): boolean {
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Coarse edge gate: it rejects unauthenticated traffic and non-admins on admin
 * paths using only the signed cookie. The authoritative checks — account still
 * active, session epoch still current, project ownership — run server-side in
 * `src/lib/authz.ts`, because the cookie alone cannot prove any of those.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await parseSessionToken(token);
  const valid = session !== null;

  if (pathname === "/login" || pathname === "/register") {
    if (valid) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (matches(pathname, PUBLIC_PATHS)) {
    return NextResponse.next();
  }

  if (!valid) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") {
      loginUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  const isAdminArea =
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/api/admin/");
  if (isAdminArea && session.role !== "admin") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Administrator access required" },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
