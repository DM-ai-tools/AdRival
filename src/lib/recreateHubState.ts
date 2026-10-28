import type { RecreateListItem } from "./recreateList";

/*
 * How the Recreate tab lays out its list. Pure: no React, no browser.
 */

const time = (iso: string) => Date.parse(iso) || 0;

/**
 * Running items fill the slots, oldest start first. The server runs at most
 * `limit` (normally 3) jobs, but a page being built by the old route shows as
 * running too: those stay visible, so slots can hold more than the limit
 * (the hub then shows no empty slot). Queued items wait oldest first; the rest
 * are recent (newest first), or archived once finished long enough ago.
 */
export function splitItems(items: RecreateListItem[]): {
  slots: RecreateListItem[];
  queue: RecreateListItem[];
  recent: RecreateListItem[];
  archived: RecreateListItem[];
} {
  const oldestFirst = (a: RecreateListItem, b: RecreateListItem) =>
    time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id);
  const newestFirst = (a: RecreateListItem, b: RecreateListItem) => oldestFirst(b, a);
  const slots = items.filter((i) => i.state === "running").sort(oldestFirst);
  const queue = items.filter((i) => i.state === "queued").sort(oldestFirst);
  const rest = items.filter((i) => i.state !== "running" && i.state !== "queued");
  return {
    slots,
    queue,
    recent: rest.filter((i) => !i.archived).sort(newestFirst),
    archived: rest.filter((i) => i.archived).sort(newestFirst),
  };
}
