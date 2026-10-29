import { NextResponse } from "next/server";
import {
  createUser,
  getAppSettings,
  getOrganization,
  listOrganizations,
  getUserByUsername,
  listProjectSpaces,
  listProjects,
  listUsers,
  toPublicUser,
} from "@/lib/db";
import { adminScope, errorResponse, requireAdmin, userInScope } from "@/lib/authz";
import { hashPassword } from "@/lib/auth/password";
import { generateTemporaryPassword } from "@/lib/auth/bootstrap";
import { newInvite, sendInvite, usernameFromEmail } from "@/lib/auth/invite";
import { validateDisplayName } from "@/lib/auth/validation";
import { initializeUserCredits, getCreditSummary } from "@/lib/accounting/service";
import { recordAudit } from "@/lib/accounting/records";
import { parseCreditsInput } from "@/lib/accounting/units";
import { isLoginLocked } from "@/lib/auth/rateLimit";
import type { UserRole, UserStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Admin user list with credit and project counts. Never includes hashes. */
export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    const scope = adminScope(admin);
    const orgNames = new Map((await listOrganizations({ includeArchived: true })).map((o) => [o.id, o.name]));
    const url = new URL(request.url);
    const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
    const roleFilter = url.searchParams.get("role") ?? "";
    const statusFilter = url.searchParams.get("status") ?? "";

    const projects = await listProjects();
    const spaces = await listProjectSpaces();
    const orgFilter = url.searchParams.get("org") ?? "";
    const listed = (await listUsers({ includeDeleted: true }))
      .filter((user) => userInScope(scope, user))
      .filter((user) => {
        if (orgFilter === "platform" && user.orgId) return false;
        if (orgFilter && orgFilter !== "platform" && user.orgId !== orgFilter) return false;
        if (
          search &&
          !user.username.includes(search) &&
          !(user.email ?? "").toLowerCase().includes(search) &&
          !user.displayName.toLowerCase().includes(search)
        ) {
          return false;
        }
        if (roleFilter && user.role !== roleFilter) return false;
        if (statusFilter && user.status !== statusFilter) return false;
        return true;
      });
    const rows = await Promise.all(
      listed.map(async (user) => ({
        ...toPublicUser(user),
        email: user.email ?? null,
        invitePending: Boolean(user.invite),
        maxConcurrentRuns: user.maxConcurrentRuns ?? null,
        suspendedAt: user.suspendedAt ?? null,
        deletedAt: user.deletedAt ?? null,
        credits: await getCreditSummary(user.id),
        projectCount: projects.filter((p) => p.ownerUserId === user.id).length,
        spaceCount: spaces.filter((s) => s.ownerUserId === user.id).length,
        lastLoginAt: user.lastLoginAt ?? null,
        loginLocked: (await isLoginLocked(user.username)).locked,
        orgName: user.orgId ? orgNames.get(user.orgId) ?? "Unknown organisation" : null,
      })),
    );

    return NextResponse.json(
      {
        users: rows,
        counts: {
          total: rows.filter((u) => u.status !== "deleted").length,
          active: rows.filter((u) => u.status === "active").length,
          suspended: rows.filter((u) => u.status === "suspended").length,
          deleted: rows.filter((u) => u.status === "deleted").length,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

/**
 * Invite a user by email. They get a link to choose their own password; no
 * password is generated or shown. If the email cannot be sent, the link is
 * returned once so the admin can pass it on.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();

    let body: {
      email?: string;
      displayName?: string;
      role?: UserRole;
      status?: UserStatus;
      allowanceCredits?: string | number;
      /** Platform admins only: put the user in a client organisation. */
      orgId?: string | null;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
    }
    const nameErr = validateDisplayName(String(body.displayName ?? ""));
    if (nameErr) {
      return NextResponse.json({ error: nameErr }, { status: 400 });
    }
    const existing = await listUsers({ includeDeleted: true });
    if (existing.some((u) => u.status !== "deleted" && u.email?.toLowerCase() === email)) {
      return NextResponse.json({ error: "Someone already has that email address" }, { status: 409 });
    }
    const usernames = new Set(existing.map((u) => u.username.toLowerCase()));
    const username = usernameFromEmail(email, (u) => usernames.has(u));

    const role: UserRole = body.role === "admin" ? "admin" : "user";
    // Organisation admins always create users inside their own organisation.
    let orgId: string | null = admin.orgId ?? null;
    if (!admin.orgId && body.orgId) {
      const org = await getOrganization(String(body.orgId));
      if (!org || org.archivedAt) {
        return NextResponse.json({ error: "That organisation does not exist" }, { status: 400 });
      }
      orgId = org.id;
    }
    const settings = await getAppSettings();
    const allowance =
      body.allowanceCredits === undefined || body.allowanceCredits === ""
        ? settings.defaultAllowanceSubunits
        : parseCreditsInput(body.allowanceCredits);
    if (allowance === null || allowance < 0) {
      return NextResponse.json(
        { error: "Allowance must be a non-negative number" },
        { status: 400 },
      );
    }

    // Nobody knows this password: the invited person chooses theirs when they accept.
    const passwordHash = await hashPassword(generateTemporaryPassword());
    const { token, invite } = newInvite();
    let user;
    try {
      user = await createUser({
        username,
        displayName: String(body.displayName ?? "").trim(),
        passwordHash,
        role,
        status: "active",
        mustChangePassword: true,
        createdByUserId: admin.id,
        orgId,
        email,
        invite,
      });
    } catch (err) {
      // Taken between the check above and the insert (checked again under the users lock).
      if (err instanceof Error && err.message === "Username already taken") {
        return NextResponse.json({ error: "Username already taken" }, { status: 409 });
      }
      throw err;
    }
    await initializeUserCredits(user.id, {
      allowanceSubunits: allowance,
      resetCadence: settings.defaultResetCadence,
      reason: `Initial allowance set by ${admin.username}`,
    });
    await recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.user.create",
      targetUserId: user.id,
      details: { username, email, role, allowanceSubunits: allowance, orgId, invited: true },
    });

    const mail = await sendInvite({ request, user, token, invitedBy: admin.displayName || admin.username });
    return NextResponse.json({
      ok: true,
      user: toPublicUser(user),
      emailSent: mail.sent,
      // Only when the email could not be sent: the admin passes the link on.
      inviteLink: mail.sent ? undefined : mail.link,
      emailError: mail.error,
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
