import { NextResponse } from "next/server";
import { errorResponse, HttpError, requirePlatformAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import { archiveOldPages } from "@/lib/data/archive";
import { StorageNotConfiguredError } from "@/lib/data/storageClient";

export const runtime = "nodejs";

/**
 * Archive now: moves recreated page content older than `olderThanDays`
 * (default RECREATED_PAGE_ARCHIVE_DAYS, else 14; 0 takes every page) from the
 * database to Storage. Platform admins only.
 */
export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin();

    let body: { olderThanDays?: unknown } = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text) as { olderThanDays?: unknown };
      } catch {
        throw new HttpError(400, "Invalid request body");
      }
    }
    let olderThanDays: number | undefined;
    if (body.olderThanDays !== undefined && body.olderThanDays !== null) {
      const n = body.olderThanDays;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 3650) {
        throw new HttpError(400, "olderThanDays must be a number of days from 0 to 3650");
      }
      olderThanDays = n;
    }

    let result: { archived: number; failed: number };
    try {
      result = await archiveOldPages(olderThanDays === undefined ? {} : { olderThanDays });
    } catch (err) {
      if (err instanceof StorageNotConfiguredError) throw new HttpError(503, err.message, "storage_not_configured");
      throw err;
    }

    await recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.archive_pages",
      details: { olderThanDays: olderThanDays ?? null, archived: result.archived, failed: result.failed },
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
