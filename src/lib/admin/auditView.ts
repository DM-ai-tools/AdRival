import { formatCredits } from "@/lib/accounting/units";
import type { AuditLogEntry } from "@/lib/types";

/**
 * Plain-language names for audit actions. Anything not listed falls back to
 * the code with dots and underscores turned into spaces.
 */
const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.register": "Registered",
  "auth.password_changed": "Changed their password",
  "admin.user.create": "Created a user",
  "admin.user.update": "Updated a user",
  "admin.user.delete": "Deleted a user",
  "admin.user.password_reset": "Reset a password",
  "admin.credits.set_allowance": "Set an allowance",
  "admin.credits.add": "Added credits",
  "admin.credits.adjustment": "Adjusted usage",
  "admin.credits.set_reset_cadence": "Changed a reset schedule",
  "admin.credits.bulk_add": "Added credits to several users",
  "admin.usage.reconcile": "Resolved a billing check",
  "admin.settings.update": "Changed settings",
  "admin.conversion_rules.publish": "Published conversion rules",
  "admin.space.create": "Created a client space",
  "admin.org.create": "Created an organisation",
  "admin.org.rename": "Renamed an organisation",
  "admin.space.rename": "Renamed a client space",
  "admin.space.restore": "Restored a client space",
  "admin.space.delete": "Archived a client space",
  "admin.space.share": "Shared a client space",
  "admin.space.revoke": "Removed access to a client space",
  "admin.space.transfer": "Transferred a client space",
  "admin.space.move_runs": "Moved runs into a client space",
  "admin.project.share_grant": "Shared a run",
  "admin.project.share_revoke": "Removed access to a run",
  "admin.project.view": "Opened another user's run",
  "admin.alert.acknowledge": "Dismissed an alert",
  "admin.store.import": "Imported history",
  "space.create": "Created a client space",
};

export function auditActionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const text = action.replace(/^admin\./, "").replace(/[._]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : action;
}

/** Routine entries hidden from the audit view unless asked for. */
export const ROUTINE_AUDIT_ACTIONS = new Set(["admin.project.view", "auth.login"]);

function prettyKey(key: string): string {
  return key
    .replace(/Subunits$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

/**
 * Details as short readable text. Amounts stored in internal subunits are
 * shown in credits; ids are left out because the view shows names.
 */
export function auditDetailsText(entry: Pick<AuditLogEntry, "details">): string {
  const details = entry.details;
  if (!details) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === "" || value === undefined) continue;
    if (/(Id|Ids)$/.test(key) && typeof value === "string" && value.length > 20) continue;
    if (/Subunits$/.test(key) && typeof value === "number") {
      parts.push(`${prettyKey(key)}: ${formatCredits(value)} credits`);
      continue;
    }
    parts.push(`${prettyKey(key)}: ${value === true ? "yes" : value === false ? "no" : String(value)}`);
  }
  return parts.join(" · ");
}
