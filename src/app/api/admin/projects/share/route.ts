import { NextResponse } from "next/server";
import { getProject, getUserById } from "@/lib/db";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import {
  recordAudit,
  removeMembership,
  upsertMembership,
} from "@/lib/accounting/records";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";

function parseKind(value: unknown): ProjectKind {
  if (value === "search" || value === "lookup") return value;
  throw new HttpError(400, "projectKind must be 'search' or 'lookup'");
}

/**
 * Grant or change a share. Sharing never changes ownership, and only admins can
 * do it. The recipient is charged for anything they run in the project.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();

    let body: {
      projectKind?: string;
      projectId?: string;
      userId?: string;
      role?: "viewer" | "editor";
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const projectKind = parseKind(body.projectKind);
    const projectId = String(body.projectId ?? "");
    const userId = String(body.userId ?? "");
    const role = body.role === "editor" ? "editor" : "viewer";

    const project = getProject(projectKind, projectId);
    if (!project) throw new HttpError(404, "Project not found", "not_found");
    if (!project.ownerUserId) {
      throw new HttpError(
        409,
        "Assign an owner to this project before sharing it.",
        "unassigned_project",
      );
    }

    const recipient = getUserById(userId);
    if (!recipient || recipient.status !== "active") {
      throw new HttpError(400, "Recipient must be an active user");
    }
    if (recipient.id === project.ownerUserId) {
      throw new HttpError(409, "That user already owns this project");
    }

    upsertMembership({
      projectKind,
      projectId,
      userId,
      role,
      grantedByUserId: admin.id,
    });
    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.project.share_grant",
      projectKind,
      projectId,
      targetUserId: userId,
      details: { role, ownerUserId: project.ownerUserId },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Revoke a share. Takes effect on the next request — no grace period. */
export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin();
    const url = new URL(request.url);
    const projectKind = parseKind(url.searchParams.get("projectKind"));
    const projectId = url.searchParams.get("projectId") ?? "";
    const userId = url.searchParams.get("userId") ?? "";

    const removed = removeMembership(projectKind, projectId, userId);
    if (!removed) throw new HttpError(404, "Share not found", "not_found");

    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.project.share_revoke",
      projectKind,
      projectId,
      targetUserId: userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
