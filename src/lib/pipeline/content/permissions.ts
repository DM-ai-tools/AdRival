const EDIT_ACTIONS = new Set([
  "save_content",
  "approve_content",
  "accept_proposal",
  "discard_proposal",
  "confirm_fact",
  "undo_content",
  "update_intent",
]);

/** Opening and manual edits are free. Model research, drafting, and design builds are runs. */
export function recreationActionPermission(action: string): "edit" | "run" {
  return EDIT_ACTIONS.has(action) ? "edit" : "run";
}
