import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  isAuthEnabled,
  SESSION_COOKIE,
  verifySessionToken,
} from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
  const enabled = isAuthEnabled();
  if (!enabled) {
    return NextResponse.json({ enabled: false, authenticated: true });
  }

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const authenticated = await verifySessionToken(token);

  return NextResponse.json({ enabled: true, authenticated });
}
