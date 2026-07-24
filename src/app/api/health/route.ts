import { NextResponse } from "next/server";

/** Lightweight readiness probe for Railway / container health checks. */
export async function GET() {
  return NextResponse.json(
    { ok: true, service: "adrival" },
    { status: 200 },
  );
}
