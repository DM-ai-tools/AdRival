import { NextResponse } from "next/server";

import { checkHealth } from "@/lib/data/health";

export const dynamic = "force-dynamic";

/** Readiness probe for Railway / container health checks: 503 when the database is down. */
export async function GET() {
  const { status, body } = await checkHealth();
  return NextResponse.json(body, { status });
}
