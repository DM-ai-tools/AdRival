import { NextResponse } from "next/server";
import {
  createUser,
  getAppSettings,
  getUserByUsername,
  listProjects,
  listUsers,
  toPublicUser,
} from "@/lib/db";
import { errorResponse, requireAdmin } from "@/lib/authz";
import { hashPassword } from "@/lib/auth/password";
import { generateTemporaryPassword } from "@/lib/auth/bootstrap";
import {
  normalizeUsername,
  validateDisplayName,
  validateUsername,
} from "@/lib/auth/validation";
import { initializeUserCredits, getCreditSummary } from "@/lib/accounting/service";
import { recordAudit } from "@/lib/accounting/records";
import { parseCreditsInput } from "@/lib/accounting/units";
import type { UserRole, UserStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Admin user list with credit and project counts. Never includes hashes. */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
    const roleFilter = url.searchParams.get("role") ?? "";
    const statusFilter = url.searchParams.get("status") ?? "";

    const projects = listProjects();
    const rows = listUsers({ includeDeleted: true })
      .filter((user) => {
        if (
          search &&
          !user.username.includes(search) &&
          !user.displayName.toLowerCase().includes(search)
        ) {
          return false;
        }
        if (roleFilter && user.role !== roleFilter) return false;
        if (statusFilter && user.status !== statusFilter) return false;
        return true;
      })
      .map((user) => ({
        ...toPublicUser(user),
        maxConcurrentRuns: user.maxConcurrentRuns ?? null,
        suspendedAt: user.suspendedAt ?? null,
        deletedAt: user.deletedAt ?? null,
        credits: getCreditSummary(user.id),
        projectCount: projects.filter((p) => p.ownerUserId === user.id).length,
      }));

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
 * Create a user. The generated temporary password is returned once, in this
 * response only, and is never stored in plaintext or written to the audit log.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();

    let body: {
      username?: string;
      displayName?: string;
      role?: UserRole;
      status?: UserStatus;
      allowanceCredits?: string | number;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const usernameErr = validateUsername(String(body.username ?? ""));
    if (usernameErr) {
      return NextResponse.json({ error: usernameErr }, { status: 400 });
    }
    const nameErr = validateDisplayName(String(body.displayName ?? ""));
    if (nameErr) {
      return NextResponse.json({ error: nameErr }, { status: 400 });
    }

    const username = normalizeUsername(String(body.username ?? ""));
    if (getUserByUsername(username)) {
      return NextResponse.json({ error: "Username already taken" }, { status: 409 });
    }

    const role: UserRole = body.role === "admin" ? "admin" : "user";
    const settings = getAppSettings();
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

    const temporaryPassword = generateTemporaryPassword();
    const user = createUser({
      username,
      displayName: String(body.displayName ?? "").trim(),
      passwordHash: await hashPassword(temporaryPassword),
      role,
      status: "active",
      mustChangePassword: true,
      createdByUserId: admin.id,
    });
    initializeUserCredits(user.id, {
      allowanceSubunits: allowance,
      resetCadence: settings.defaultResetCadence,
      reason: `Initial allowance set by ${admin.username}`,
    });
    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.user.create",
      targetUserId: user.id,
      details: { username, role, allowanceSubunits: allowance },
    });

    return NextResponse.json({
      ok: true,
      user: toPublicUser(user),
      temporaryPassword,
      notice:
        "Share this temporary password with the user now — it is not stored and cannot be shown again.",
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
