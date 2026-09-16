import { NextResponse } from "next/server";
import { bootstrapFirstAdmin, isBootstrapConfigured } from "@/lib/auth/bootstrap";
import { countActiveAdmins } from "@/lib/db";

export const runtime = "nodejs";

/**
 * One-time first-admin bootstrap. Unauthenticated by necessity — there is no
 * admin yet — but gated by a server-side token and self-disabling once an
 * active admin exists.
 */
export async function GET() {
  return NextResponse.json({
    configured: isBootstrapConfigured(),
    needsBootstrap: countActiveAdmins() === 0,
  });
}

export async function POST(request: Request) {
  let body: { token?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const token = String(body.token ?? "");
  if (!token) {
    return NextResponse.json({ error: "Bootstrap token is required" }, { status: 400 });
  }

  const result = await bootstrapFirstAdmin(token);
  return NextResponse.json(result, { status: result.ok ? 200 : 403 });
}
