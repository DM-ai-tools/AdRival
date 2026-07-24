import { NextRequest, NextResponse } from "next/server";
import { getStoreStats, mergeStore, replaceStore } from "@/lib/db";
import type { DatabaseShape } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.HISTORY_IMPORT_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = req.headers.get("x-import-secret")?.trim() || "";
  return bearer === secret || alt === secret;
}

export async function GET() {
  if (!process.env.HISTORY_IMPORT_SECRET?.trim()) {
    return NextResponse.json(
      { error: "HISTORY_IMPORT_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }
  try {
    return NextResponse.json({
      ok: true,
      stats: getStoreStats(),
      modes: ["replace", "merge"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to read store", detail: message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const modeParam = (req.nextUrl.searchParams.get("mode") || "replace").toLowerCase();
  const mode = modeParam === "merge" ? "merge" : "replace";

  let payload: Partial<DatabaseShape>;
  try {
    payload = (await req.json()) as Partial<DatabaseShape>;
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON matching data/store.json" },
      { status: 400 },
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "Invalid store payload" }, { status: 400 });
  }

  try {
    const result = mode === "merge" ? mergeStore(payload) : replaceStore(payload);
    return NextResponse.json({
      ok: true,
      mode,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to write store", detail: message },
      { status: 500 },
    );
  }
}
