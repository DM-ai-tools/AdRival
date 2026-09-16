import { countActiveAdmins, createUser, listUsers, updateUser } from "@/lib/db";
import { recordAudit } from "@/lib/accounting/records";
import { hashPassword } from "./password";
import { normalizeUsername } from "./validation";

/**
 * First-admin bootstrap.
 *
 * No credentials are hardcoded. The operator sets two environment variables on
 * the server and calls POST /api/admin/bootstrap once with the token:
 *
 *   ADMIN_BOOTSTRAP_TOKEN     one-time shared secret for the request
 *   ADMIN_BOOTSTRAP_USERNAME  username to promote or create
 *
 * The endpoint refuses to do anything once an active admin exists, so the
 * token cannot be replayed to mint further admins. See docs/MULTI_USER.md.
 */

export interface BootstrapResult {
  ok: boolean;
  action: "promoted" | "created" | "noop";
  message: string;
  /** Only returned when a brand-new account was created. */
  temporaryPassword?: string;
}

export function isBootstrapConfigured(): boolean {
  return Boolean(
    process.env.ADMIN_BOOTSTRAP_TOKEN?.trim() &&
      process.env.ADMIN_BOOTSTRAP_USERNAME?.trim(),
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Random, URL-safe temporary password the operator must change at first login. */
export function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 20);
}

export async function bootstrapFirstAdmin(
  providedToken: string,
): Promise<BootstrapResult> {
  const expected = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();
  const targetUsername = process.env.ADMIN_BOOTSTRAP_USERNAME?.trim();

  if (!expected || !targetUsername) {
    return {
      ok: false,
      action: "noop",
      message:
        "Bootstrap is not configured. Set ADMIN_BOOTSTRAP_TOKEN and ADMIN_BOOTSTRAP_USERNAME.",
    };
  }
  if (!constantTimeEquals(providedToken, expected)) {
    return { ok: false, action: "noop", message: "Invalid bootstrap token." };
  }
  if (countActiveAdmins() > 0) {
    return {
      ok: false,
      action: "noop",
      message:
        "An administrator already exists. Bootstrap is disabled; remove ADMIN_BOOTSTRAP_TOKEN.",
    };
  }

  const username = normalizeUsername(targetUsername);
  const existing = listUsers({ includeDeleted: true }).find(
    (u) => u.username === username,
  );

  if (existing) {
    updateUser(existing.id, {
      role: "admin",
      status: "active",
      deletedAt: null,
      suspendedAt: null,
      // Force a fresh login so the promoted role is reflected in the session.
      bumpSessionEpoch: true,
    });
    recordAudit({
      actorUserId: null,
      actorUsername: "bootstrap",
      action: "admin.bootstrap.promote",
      targetUserId: existing.id,
      details: { username },
    });
    return {
      ok: true,
      action: "promoted",
      message: `Promoted "${username}" to administrator. Sign in again, then remove ADMIN_BOOTSTRAP_TOKEN.`,
    };
  }

  const temporaryPassword = generateTemporaryPassword();
  const user = createUser({
    username,
    displayName: targetUsername,
    passwordHash: await hashPassword(temporaryPassword),
    role: "admin",
    status: "active",
    mustChangePassword: true,
  });
  recordAudit({
    actorUserId: null,
    actorUsername: "bootstrap",
    action: "admin.bootstrap.create",
    targetUserId: user.id,
    details: { username },
  });
  return {
    ok: true,
    action: "created",
    message: `Created administrator "${username}". Sign in with the temporary password, change it, then remove ADMIN_BOOTSTRAP_TOKEN.`,
    temporaryPassword,
  };
}
