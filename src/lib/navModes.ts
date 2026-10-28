/** The screens of the app, and which top-level tab each belongs to. */
export type Mode = "search" | "lookup" | "ab" | "recreate" | "history";

/** The screens under the Find tab, in display order. */
export const FIND_MODES = ["search", "lookup", "ab"] as const;

const ALL_MODES: readonly Mode[] = ["search", "lookup", "ab", "recreate", "history"];

export function topTabOf(mode: Mode): "find" | "recreate" | "history" {
  if (mode === "recreate" || mode === "history") return mode;
  return "find";
}

/** A ?mode= value as a Mode; anything unknown opens Keyword search. */
export function parseMode(raw: string | null | undefined): Mode {
  return ALL_MODES.find((m) => m === raw) ?? "search";
}
