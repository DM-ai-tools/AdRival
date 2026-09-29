import { NextResponse } from "next/server";
import {
  createOrganization,
  createUser,
  getAppSettings,
  getOrganization,
  getUserByUsername,
  listOrganizations,
  listProjects,
  listUsers,
  renameOrganization,
  toPublicUser,
} from "@/lib/db";
import { errorResponse, HttpError, requirePlatformAdmin } from "@/lib/authz";
import { hashPassword } from "@/lib/auth/password";
import { generateTemporaryPassword } from "@/lib/auth/bootstrap";
import { normalizeUsername, validateDisplayName, validateUsername } from "@/lib/auth/validation";
import { initializeUserCredits } from "@/lib/accounting/service";
import { recordAudit } from "@/lib/accounting/records";

export const runtime = "nodejs";

/**
 * Client organisations on this deployment (platform administrators only).
 * Each organisation's admins manage only its own users, runs and usage.
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const users = listUsers({ includeDeleted: true });
    const projects = listProjects();
    const orgs = listOrganizations({ includeArchived: true }).map((org) => {
      const members = users.filter((u) => u.orgId === org.id && u.status !== "deleted");
      const ids = new Set(members.map((u) => u.id));
      const runs = projects.filter((p) => p.ownerUserId && ids.has(p.ownerUserId));
      const lastLogin = members
        .map((u) => u.lastLoginAt || "")
        .filter(Boolean)
        .sort()
        .pop() || null;
      return {
        ...org,
        userCount: members.length,
        adminCount: members.filter((u) => u.role === "admin" && u.status === "active").length,
        admins: members
          .filter((u) => u.role === "admin")
          .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, status: u.status })),
        runCount: runs.length,
        lastLoginAt: lastLogin,
      };
    });
    return NextResponse.json({ organizations: orgs }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

/**
 * Create an organisation with its first administrator, or rename one.
 * The first admin's temporary password is returned once and never stored in plain text.
 */
export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin();
    let body: {
      action?: "create" | "rename";
      orgId?: string;
      name?: string;
      adminUsername?: string;
      adminDisplayName?: string;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (body.action === "rename") {
      const org = getOrganization(String(body.orgId ?? ""));
      if (!org) throw new HttpError(404, "Organisation not found", "not_found");
      const renamed = renameOrganization(org.id, String(body.name ?? ""));
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.org.rename",
        details: { orgId: org.id, from: org.name, to: renamed?.name ?? null },
      });
      return NextResponse.json({ ok: true, organization: renamed });
    }

    const name = String(body.name ?? "").trim();
    if (name.length < 2) throw new HttpError(400, "Enter the organisation's name");
    const usernameErr = validateUsername(String(body.adminUsername ?? ""));
    if (usernameErr) throw new HttpError(400, usernameErr);
    const displayErr = validateDisplayName(String(body.adminDisplayName ?? ""));
    if (displayErr) throw new HttpError(400, displayErr);
    const username = normalizeUsername(String(body.adminUsername ?? ""));
    if (getUserByUsername(username)) throw new HttpError(409, "Username already taken");

    let org;
    try {
      org = createOrganization({ name, createdByUserId: admin.id });
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : "Could not create the organisation");
    }
    const temporaryPassword = generateTemporaryPassword();
    const user = createUser({
      username,
      displayName: String(body.adminDisplayName ?? "").trim(),
      passwordHash: await hashPassword(temporaryPassword),
      role: "admin",
      status: "active",
      mustChangePassword: true,
      createdByUserId: admin.id,
      orgId: org.id,
    });
    const settings = getAppSettings();
    initializeUserCredits(user.id, {
      allowanceSubunits: settings.defaultAllowanceSubunits,
      resetCadence: settings.defaultResetCadence,
      reason: `Initial allowance set by ${admin.username}`,
    });
    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.org.create",
      targetUserId: user.id,
      details: { orgId: org.id, name: org.name, adminUsername: username },
    });
    return NextResponse.json({
      ok: true,
      organization: org,
      admin: toPublicUser(user),
      temporaryPassword,
      notice: "Share this temporary password with the organisation's admin now — it is not stored and cannot be shown again.",
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
