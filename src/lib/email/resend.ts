/*
 * Sends mail through Resend's HTTP API (no SDK). Configure with RESEND_API_KEY
 * and EMAIL_FROM (an address on a domain verified in Resend, e.g.
 * "AdRival <invites@yourdomain.com>").
 */

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());
}

export async function sendEmail(input: { to: string; subject: string; html: string; text: string }): Promise<void> {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!key || !from) throw new Error("Email is not set up (RESEND_API_KEY and EMAIL_FROM).");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html, text: input.text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Resend refused the email (${res.status})`);
  }
}
