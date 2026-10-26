import { NextResponse } from "next/server";
import { errorResponse, HttpError, requirePlatformAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import { BackupBusyError, listBackups, runBackupNow, type BackupResult } from "@/lib/data/backup";
import { getStorage, StorageNotConfiguredError, storageConfigured } from "@/lib/data/storageClient";

export const runtime = "nodejs";

function requireStorage(): void {
  if (!storageConfigured()) {
    const err = new StorageNotConfiguredError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    throw new HttpError(503, err.message, "storage_not_configured");
  }
}

/** Back up the database to Storage now (db-backups). Platform admins only. */
export async function POST() {
  try {
    const admin = await requirePlatformAdmin();
    requireStorage();

    let result: BackupResult;
    try {
      result = await runBackupNow();
    } catch (err) {
      if (err instanceof StorageNotConfiguredError) throw new HttpError(503, err.message, "storage_not_configured");
      if (err instanceof BackupBusyError) throw new HttpError(409, err.message, "backup_running");
      throw err;
    }

    await recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.backup",
      details: { date: result.date, tables: result.tables, rows: result.rows, bytes: result.bytes },
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

/** Complete backups in Storage, newest first (date, tables, rows, bytes). Platform admins only. */
export async function GET() {
  try {
    await requirePlatformAdmin();
    requireStorage();
    const backups = await listBackups(getStorage());
    return NextResponse.json({ backups });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
