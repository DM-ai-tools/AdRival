import { listManusProjects } from "./client";

/** Manus projects (cloud folders) looked up by name, shared by recreation and the sponsored-ads search. */

/** Letters and digits only, lower case: "Redesign  Pipeline" → "redesignpipeline". */
export function projectKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Edit distance, for project names typed with a small slip ("redeisgn" / "redesign"). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** Picks the project for a name: exact match, then one containing it, then one a typo away. */
export function matchManusProject<T extends { id: string; name: string }>(projects: T[], name: string): T | null {
  const want = projectKey(name);
  if (!want) return null;
  const exact = projects.filter((p) => projectKey(p.name) === want);
  if (exact.length) return exact[0];
  const containing = projects.filter((p) => projectKey(p.name).includes(want) || want.includes(projectKey(p.name)));
  if (containing.length === 1) return containing[0];
  const close = projects
    .map((p) => ({ p, d: editDistance(projectKey(p.name), want) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(want.length / 6)))
    .sort((a, b) => a.d - b.d);
  return close.length && (close.length === 1 || close[0].d < close[1].d) ? close[0].p : null;
}


const cache = new Map<string, { id: string; name: string }>();

/**
 * The project for a name (matched as matchManusProject does), cached per name.
 * When none matches, `missing` lists the account's project names.
 */
export async function findManusProject(name: string): Promise<{ id: string; name: string } | { missing: string }> {
  const hit = cache.get(name);
  if (hit) return hit;
  const projects = await listManusProjects();
  const match = matchManusProject(projects, name);
  if (!match) return { missing: projects.map((p) => `"${p.name}"`).join(", ") || "none" };
  const found = { id: match.id, name: match.name };
  cache.set(name, found);
  return found;
}
