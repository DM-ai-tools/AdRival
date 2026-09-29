import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStoreStats, getUserByUsername, mergeStore, replaceStore } from "@/lib/db";
import { getSessionUser } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import type { DatabaseShape } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(req: NextRequest): boolean {
  const secret = process.env.HISTORY_IMPORT_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = req.headers.get("x-import-secret")?.trim() || "";
  return safeEqual(bearer, secret) || safeEqual(alt, secret);
}

/** Compare without leaking how many leading characters matched. */
function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Deploy-time store import. Accepts either the shared import secret (for CI /
 * one-off migrations, which have no session) or a logged-in admin.
 */
async function authorize(req: NextRequest): Promise<
  | { ok: true; actorUserId: string | null; actorUsername: string | null }
  | { ok: false }
> {
  if (secretMatches(req)) {
    return { ok: true, actorUserId: null, actorUsername: "import-secret" };
  }
  const user = await getSessionUser();
  // Platform administrators only — an organisation admin must never replace the store.
  if (user?.role === "admin" && !user.orgId) {
    return { ok: true, actorUserId: user.id, actorUsername: user.username };
  }
  return { ok: false };
}

export async function GET(req: NextRequest) {
  if (!(await authorize(req)).ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  const auth = await authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const modeParam = (req.nextUrl.searchParams.get("mode") || "replace").toLowerCase();
  const mode = modeParam === "merge" ? "merge" : "replace";
  // Runs whose owner can't be matched on this server go to this account.
  const ownerParam = req.nextUrl.searchParams.get("owner")?.trim() || "";
  const fallbackOwner = ownerParam ? getUserByUsername(ownerParam) : null;
  if (ownerParam && (!fallbackOwner || fallbackOwner.status === "deleted")) {
    return NextResponse.json({ error: `No account named "${ownerParam}" on this server` }, { status: 400 });
  }

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
    const options = { fallbackOwnerUserId: fallbackOwner?.id ?? null };
    const result = mode === "merge" ? mergeStore(payload, options) : replaceStore(payload, options);
    recordAudit({
      actorUserId: auth.actorUserId,
      actorUsername: auth.actorUsername,
      action: "admin.store.import",
      details: {
        mode,
        jobsAfter: result.after.jobs,
        competitorsAfter: result.after.competitors,
        lookupJobsAfter: result.after.lookupJobs,
        owners: result.owners ? JSON.stringify(result.owners) : null,
        fallbackOwner: fallbackOwner?.username ?? null,
      },
    });
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
