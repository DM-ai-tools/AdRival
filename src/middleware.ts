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

/** Seconds a client is told to wait during maintenance. */
const MAINTENANCE_RETRY_AFTER = "600";

const MAINTENANCE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Down for maintenance</title>
<style>body{font-family:system-ui,sans-serif;background:#f7f7f5;color:#222;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:28rem;text-align:center}</style>
</head><body><main><h1>Down for maintenance</h1><p>We are moving to a new database. The app will be back shortly. Please try again in a few minutes.</p></main></body></html>`;

/**
 * MAINTENANCE_MODE=1 (or "true"): the quiet window of the database cutover.
 * Read on every request (process.env.MAINTENANCE_MODE literally, so Next
 * passes the runtime value to the middleware). Only /api/health still answers,
 * so the platform's health check keeps the deployment up.
 */
function maintenanceResponse(pathname: string): NextResponse | null {
  const flag = (process.env.MAINTENANCE_MODE ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true") return null;
  if (pathname === "/api/health") return null;
  const headers = { "Retry-After": MAINTENANCE_RETRY_AFTER, "Cache-Control": "no-store" };
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "maintenance" }, { status: 503, headers });
  }
  return new NextResponse(MAINTENANCE_HTML, {
    status: 503,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Coarse edge gate: it rejects unauthenticated traffic and non-admins on admin
 * paths using only the signed cookie. The authoritative checks — account still
 * active, session epoch still current, project ownership — run server-side in
 * `src/lib/authz.ts`, because the cookie alone cannot prove any of those.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const maintenance = maintenanceResponse(pathname);
  if (maintenance) return maintenance;

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
