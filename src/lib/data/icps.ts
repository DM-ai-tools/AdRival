import type { IcpRecord, ProjectKind } from "../types";
import { getDb, withTx, type Queryable } from "./client";

/* ICPs, one per source (search or lookup run) and awareness stage; ported from db.ts. */

export async function getIcps(kind: ProjectKind, id: string): Promise<IcpRecord[]> {
  const { rows } = await getDb().query<{ data: IcpRecord }>(
    `select data from icps where source_kind = $1 and source_id = $2
      order by (data->>'createdAt') desc nulls last, id desc`,
    [kind, id],
  );
  return rows.map((r) => r.data);
}

export async function getIcp(icpId: string): Promise<IcpRecord | null> {
  const { rows } = await getDb().query<{ data: IcpRecord }>("select data from icps where id = $1", [icpId]);
  return rows[0]?.data ?? null;
}

/** One ICP per source + stage; a new one replaces the old (and its id). */
export async function upsertIcp(icp: IcpRecord): Promise<IcpRecord> {
  await withTx((tx) => upsertIcpRow(tx, icp));
  return icp;
}

/** upsertIcp inside the caller's transaction. */
export async function upsertIcpRow(tx: Queryable, icp: IcpRecord): Promise<void> {
  // The same id under another source/stage moves here (db.ts dropped it too).
  await tx.query(
    `delete from icps
      where id = $1 and (source_kind, source_id, stage) is distinct from ($2, $3, $4)`,
    [icp.id, icp.source.kind, icp.source.id, icp.stage],
  );
  await tx.query(
    `insert into icps (id, source_kind, source_id, stage, data)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (source_kind, source_id, stage) do update set id = excluded.id, data = excluded.data`,
    [icp.id, icp.source.kind, icp.source.id, icp.stage, JSON.stringify(icp)],
  );
}
