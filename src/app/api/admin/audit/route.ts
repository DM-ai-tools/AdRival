import { NextResponse } from "next/server";
import { getJob, getLookupJob, getProjectSpacesByIds, getUsersByIds } from "@/lib/db";
import { adminScope, errorResponse, requireAdmin, scopedUserIds } from "@/lib/authz";
import { queryAudit } from "@/lib/accounting/records";
import {
  ROUTINE_AUDIT_ACTIONS,
  auditActionLabel,
  auditDetailsText,
} from "@/lib/admin/auditView";

export const runtime = "nodejs";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function projectTitle(kind?: string | null, id?: string | null): Promise<string | null> {
  if (!kind || !id) return null;
  if (kind === "search") return (await getJob(id))?.keyword ?? id;
  if (kind === "lookup") return (await getLookupJob(id))?.queryName ?? id;
  return id;
}

/** Each distinct run title once (an audit page repeats the same runs). */
async function projectTitles(
  entries: Array<{ projectKind?: string | null; projectId?: string | null }>,
): Promise<Map<string, string | null>> {
  const keys = [...new Set(entries.map((e) => `${e.projectKind ?? ""}:${e.projectId ?? ""}`))];
  const titles = await Promise.all(
    keys.map(async (key) => {
      const [kind, ...rest] = key.split(":");
      return [key, await projectTitle(kind || null, rest.join(":") || null)] as const;
    }),
  );
  return new Map(titles);
}

/**
 * Audit log with names resolved and details in plain text.
 * Query: actor, target (user ids), area (action prefix, e.g. "admin.credits"),
 * from, to (ISO dates), routine=1 to include sign-ins and run views,
 * limit (default 200, max 2000), format=csv.
 */
export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    const url = new URL(request.url);
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 200, 1), 2000);
    const toDate = p.get("to");
    const rows = await queryAudit({
      actorUserId: p.get("actor") || undefined,
      targetUserId: p.get("target") || undefined,
      actionPrefix: p.get("area") || undefined,
      excludeActions: p.get("routine") === "1" ? undefined : ROUTINE_AUDIT_ACTIONS,
      from: p.get("from") || undefined,
      // An end date includes that whole day.
      to: toDate ? (toDate.length === 10 ? `${toDate}T23:59:59.999Z` : toDate) : undefined,
      limit,
      userIds: await scopedUserIds(adminScope(admin)),
    });

    const users = await getUsersByIds(rows.flatMap((e) => [e.targetUserId, e.actorUserId]));
    const spaceIdOf = (e: (typeof rows)[number]) =>
      typeof e.details?.spaceId === "string" ? e.details.spaceId : null;
    const spaces = await getProjectSpacesByIds(rows.map(spaceIdOf));
    const titles = await projectTitles(rows);

    const view = rows.map((e) => {
      const target = e.targetUserId ? users.get(e.targetUserId) ?? null : null;
      const spaceId = spaceIdOf(e);
      return {
        id: e.id,
        createdAt: e.createdAt,
        action: e.action,
        actionLabel: auditActionLabel(e.action),
        actorUserId: e.actorUserId,
        actor: e.actorUsername ?? (e.actorUserId ? users.get(e.actorUserId)?.username : null) ?? "system",
        targetUserId: e.targetUserId ?? null,
        target: target ? target.username : null,
        project: titles.get(`${e.projectKind ?? ""}:${e.projectId ?? ""}`) ?? null,
        projectKind: e.projectKind ?? null,
        projectId: e.projectId ?? null,
        space: spaceId ? spaces.get(spaceId)?.clientName ?? null : null,
        details: auditDetailsText(e),
      };
    });

    if (p.get("format") === "csv") {
      const lines = ["When,Who,Action,User affected,Run,Client space,Details"];
      for (const r of view) {
        lines.push(
          [r.createdAt, r.actor, r.actionLabel, r.target ?? "", r.project ?? "", r.space ?? "", r.details]
            .map(csvCell)
            .join(","),
        );
      }
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }
    return NextResponse.json({ entries: view, limit }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
