import { createHash, randomBytes } from "node:crypto";
import { emailConfigured, sendEmail } from "@/lib/email/resend";
import type { AppUser } from "@/lib/types";

export const INVITE_DAYS = 7;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newInvite(): { token: string; invite: NonNullable<AppUser["invite"]> } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  return {
    token,
    invite: {
      tokenHash: hashInviteToken(token),
      sentAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_DAYS * 86_400_000).toISOString(),
    },
  };
}

/** The app's public address (behind Railway's proxy too). */
export function siteOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) return configured;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Emails the invitation link. Returns the link and whether the mail went out;
 * when email is not set up or fails, the admin gets the link to pass on.
 */
export async function sendInvite(input: {
  request: Request;
  user: Pick<AppUser, "displayName" | "username" | "email">;
  token: string;
  invitedBy: string;
}): Promise<{ link: string; sent: boolean; error?: string }> {
  const link = `${siteOrigin(input.request)}/accept-invite?token=${encodeURIComponent(input.token)}`;
  if (!input.user.email) return { link, sent: false, error: "No email address on file." };
  if (!emailConfigured()) return { link, sent: false, error: "Email is not set up on the server yet." };
  const name = esc(input.user.displayName);
  const by = esc(input.invitedBy);
  try {
    await sendEmail({
      to: input.user.email,
      subject: "You're invited to AdRival",
      text:
        `Hi ${input.user.displayName},\n\n${input.invitedBy} invited you to AdRival.\n` +
        `Your username is ${input.user.username}.\n\nAccept the invitation and choose your password:\n${link}\n\n` +
        `This link works for ${INVITE_DAYS} days.`,
      html:
        `<p>Hi ${name},</p><p>${by} invited you to AdRival. Your username is <strong>${esc(input.user.username)}</strong>.</p>` +
        `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0f6b57;color:#fff;border-radius:8px;text-decoration:none">Accept invitation</a></p>` +
        `<p>Or paste this link into your browser:<br>${link}</p><p>This link works for ${INVITE_DAYS} days.</p>`,
    });
    return { link, sent: true };
  } catch (err) {
    return { link, sent: false, error: (err as Error).message };
  }
}

/** A username from the email's local part: lowercase letters, digits, underscores, 3-32 long. */
export function usernameFromEmail(email: string, taken: (u: string) => boolean): string {
  let base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28);
  if (base.length < 3) base = `${base}user`.slice(0, 28);
  let name = base;
  for (let i = 2; taken(name); i++) name = `${base}${i}`;
  return name;
}
