import { NextResponse } from "next/server";
import {
  getProject,
  getUserById,
  setProjectArchived,
  setProjectOwner,
} from "@/lib/db";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";

function parseKind(value: unknown): ProjectKind {
  if (value === "search" || value === "lookup") return value;
  throw new HttpError(400, "projectKind must be 'search' or 'lookup'");
}

/**
 * Assign or transfer project ownership.
 *
 * Used both to adopt legacy rows with no owner and to move a project between
 * users. Historical charges are never rewritten: usage already recorded stays
 * attributed to whoever incurred it.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();

    let body: {
      projectKind?: string;
      projectId?: string;
      ownerUserId?: string | null;
      archived?: boolean;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const projectKind = parseKind(body.projectKind);
    const projectId = String(body.projectId ?? "");
    const project = getProject(projectKind, projectId);
    if (!project) throw new HttpError(404, "Project not found", "not_found");

    if (body.archived !== undefined) {
      setProjectArchived(projectKind, projectId, Boolean(body.archived));
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: body.archived
          ? "admin.project.archive"
          : "admin.project.unarchive",
        projectKind,
        projectId,
      });
    }

    if (body.ownerUserId !== undefined) {
      const nextOwnerId = body.ownerUserId;
      if (nextOwnerId !== null) {
        const owner = getUserById(String(nextOwnerId));
        if (!owner || owner.status !== "active") {
          throw new HttpError(400, "Owner must be an active user");
        }
      }
      const previousOwnerId = project.ownerUserId ?? null;
      setProjectOwner(projectKind, projectId, nextOwnerId as string | null);
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: previousOwnerId
          ? "admin.project.transfer_owner"
          : "admin.project.assign_owner",
        projectKind,
        projectId,
        targetUserId: nextOwnerId as string | null,
        details: { previousOwnerUserId: previousOwnerId },
      });
    }

    return NextResponse.json({
      ok: true,
      project: getProject(projectKind, projectId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
