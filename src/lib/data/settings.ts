import type { AdminAlert, AppSettings, BackupFailedAdminAlert, ProviderCreditAdminAlert } from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { jsonText } from "./jsonText";
import { defaultAppSettings } from "./legacyStore";
import { isoOrNull } from "./runs";

/* App settings (one row) and admin alerts, ported from db.ts. */

/* ── app settings ── */

/** Pass the transaction handle to read the settings inside a transaction. */
export async function getAppSettings(q: Queryable = getDb()): Promise<AppSettings> {
  const { rows } = await q.query<{ data: AppSettings }>("select data from app_settings where id = 'singleton'");
  return rows[0]?.data ?? defaultAppSettings();
}

/**
 * Locks the settings row for the rest of the transaction and returns it,
 * creating it from the defaults first when the store has none (db.ts always
 * had settings: the store was normalized with defaultAppSettings()).
 */
export async function lockAppSettings(tx: Queryable): Promise<AppSettings> {
  await tx.query(
    `insert into app_settings (id, data) values ('singleton', $1::jsonb)
     on conflict (id) do nothing`,
    [jsonText(defaultAppSettings())],
  );
  const { rows } = await tx.query<{ data: AppSettings }>(
    "select data from app_settings where id = 'singleton' for update",
  );
  return rows[0]?.data ?? defaultAppSettings();
}

export async function saveAppSettings(tx: Queryable, settings: AppSettings): Promise<void> {
  await tx.query(
    `insert into app_settings (id, data) values ('singleton', $1::jsonb)
     on conflict (id) do update set data = excluded.data`,
    [jsonText(settings)],
  );
}

export async function updateAppSettings(
  patch: Partial<AppSettings>,
  actorUserId: string | null,
): Promise<AppSettings> {
  return withTx(async (tx) => {
    const current = await lockAppSettings(tx);
    const next: AppSettings = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
      updatedByUserId: actorUserId,
    };
    await saveAppSettings(tx, next);
    return next;
  });
}

/* ── admin alerts ── */

const PROVIDER_ALERT_DEDUPE_MS = 15 * 60 * 1000;
const MAX_ADMIN_ALERTS = 300;

/** Record that a provider account is out of credits. Deduped per user+provider. */
export async function recordProviderCreditAlert(input: {
  userId: string;
  username: string;
  displayName: string;
  provider: ProviderCreditAdminAlert["provider"];
  runId: string | null;
}): Promise<void> {
  await withTx(async (tx) => {
    // Two calls for the same user+provider must not both pass the dedupe check.
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `admin-alert:${input.userId}:${input.provider}`,
    ]);
    const cutoff = new Date(Date.now() - PROVIDER_ALERT_DEDUPE_MS).toISOString();
    const { rows } = await tx.query(
      `select 1 from admin_alerts
        where data->>'kind' = 'provider_credits_exhausted'
          and data->>'userId' = $1
          and data->>'provider' = $2
          and created_at >= $3::timestamptz
        limit 1`,
      [input.userId, input.provider, cutoff],
    );
    if (rows.length) return;
    const alert: AdminAlert = {
      id: crypto.randomUUID(),
      kind: "provider_credits_exhausted",
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      provider: input.provider,
      runId: input.runId,
      createdAt: new Date().toISOString(),
    };
    await upsertAdminAlertRow(tx, alert);
    // Keep the newest MAX_ADMIN_ALERTS, as db.ts did.
    await tx.query(
      `delete from admin_alerts
        where id in (select id from admin_alerts order by created_at desc, id desc offset $1)`,
      [MAX_ADMIN_ALERTS],
    );
  });
}

/** Records a failed nightly backup (after its retry failed too) as an admin alert. */
export async function recordBackupFailure(message: string): Promise<void> {
  const alert: BackupFailedAdminAlert = {
    id: crypto.randomUUID(),
    kind: "backup_failed",
    message: message.slice(0, 300),
    createdAt: new Date().toISOString(),
  };
  await withTx(async (tx) => {
    await upsertAdminAlertRow(tx, alert);
    await tx.query(
      `delete from admin_alerts
        where id in (select id from admin_alerts order by created_at desc, id desc offset $1)`,
      [MAX_ADMIN_ALERTS],
    );
  });
}

/** The newest backup-failure alert (dismissed or not), or null. */
export async function latestBackupFailure(): Promise<BackupFailedAdminAlert | null> {
  const { rows } = await getDb().query<{ data: BackupFailedAdminAlert }>(
    `select data from admin_alerts where data->>'kind' = 'backup_failed' order by created_at desc, id desc limit 1`,
  );
  return rows[0]?.data ?? null;
}

/** Inserts or replaces one alert; created_at is the alert's createdAt (the dedupe window reads it). */
export async function upsertAdminAlertRow(tx: Queryable, alert: AdminAlert): Promise<void> {
  await tx.query(
    `insert into admin_alerts (id, created_at, data) values ($1, coalesce($2::timestamptz, now()), $3::jsonb)
     on conflict (id) do update set created_at = excluded.created_at, data = excluded.data`,
    [alert.id, isoOrNull(alert.createdAt), jsonText(alert)],
  );
}

export async function listAdminAlerts(): Promise<AdminAlert[]> {
  const { rows } = await getDb().query<{ data: AdminAlert }>("select data from admin_alerts");
  return rows.map((r) => r.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Mark provider alerts as handled so they leave the open list. */
export async function acknowledgeAdminAlerts(ids: string[], actorUserId: string): Promise<number> {
  if (!ids.length) return 0;
  const now = new Date().toISOString();
  const result = await getDb().query(
    `update admin_alerts
        set data = data || jsonb_build_object('acknowledgedAt', $2::text, 'acknowledgedByUserId', $3::text)
      where id = any($1::text[])
        and coalesce(data->>'acknowledgedAt', '') = ''`,
    [[...new Set(ids)], now, actorUserId],
  );
  return result.rowCount;
}
