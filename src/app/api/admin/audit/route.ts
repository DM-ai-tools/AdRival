import { NextResponse } from "next/server";
import { getJob, getLookupJob, getProjectSpace, getUserById } from "@/lib/db";
import { errorResponse, requireAdmin } from "@/lib/authz";
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

function projectTitle(kind?: string | null, id?: string | null): string | null {
  if (!kind || !id) return null;
  if (kind === "search") return getJob(id)?.keyword ?? id;
  if (kind === "lookup") return getLookupJob(id)?.queryName ?? id;
  return id;
}

/**
 * Audit log with names resolved and details in plain text.
 * Query: actor, target (user ids), area (action prefix, e.g. "admin.credits"),
 * from, to (ISO dates), routine=1 to include sign-ins and run views,
 * limit (default 200, max 2000), format=csv.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 200, 1), 2000);
    const toDate = p.get("to");
    const rows = queryAudit({
      actorUserId: p.get("actor") || undefined,
      targetUserId: p.get("target") || undefined,
      actionPrefix: p.get("area") || undefined,
      excludeActions: p.get("routine") === "1" ? undefined : ROUTINE_AUDIT_ACTIONS,
      from: p.get("from") || undefined,
      // An end date includes that whole day.
      to: toDate ? (toDate.length === 10 ? `${toDate}T23:59:59.999Z` : toDate) : undefined,
      limit,
    });

    const view = rows.map((e) => {
      const target = e.targetUserId ? getUserById(e.targetUserId) : null;
      const spaceId = typeof e.details?.spaceId === "string" ? e.details.spaceId : null;
      return {
        id: e.id,
        createdAt: e.createdAt,
        action: e.action,
        actionLabel: auditActionLabel(e.action),
        actorUserId: e.actorUserId,
        actor: e.actorUsername ?? (e.actorUserId ? getUserById(e.actorUserId)?.username : null) ?? "system",
        targetUserId: e.targetUserId ?? null,
        target: target ? target.username : null,
        project: projectTitle(e.projectKind, e.projectId),
        projectKind: e.projectKind ?? null,
        projectId: e.projectId ?? null,
        space: spaceId ? getProjectSpace(spaceId)?.clientName ?? null : null,
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
