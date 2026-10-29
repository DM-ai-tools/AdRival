import { NextResponse } from "next/server";
import { getUsersByIds } from "@/lib/db";
import { adminScope, errorResponse, requireAdmin, scopedUserIds } from "@/lib/authz";
import { countJobsByOwner } from "@/lib/data/recreateJobs";

export const runtime = "nodejs";

/**
 * How many landing-page recreations each user has done, by outcome. Query:
 * days (only the last N days; default all time). Organisation admins see only
 * their own organisation's users.
 */
export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    const allowed = await scopedUserIds(adminScope(admin));
    const days = Number(new URL(request.url).searchParams.get("days")) || 0;
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;

    const counts = await countJobsByOwner(allowed ? [...allowed] : null, since);
    const users = await getUsersByIds(counts.map((c) => c.ownerUserId));
    const rows = counts.map((c) => ({
      ...c,
      username: users.get(c.ownerUserId)?.username ?? null,
      displayName: users.get(c.ownerUserId)?.displayName ?? null,
    }));
    return NextResponse.json(
      { rows, total: rows.reduce((n, r) => n + r.total, 0) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
