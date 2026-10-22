import type { IcpContent } from "../../types";
import type { AbPage } from "./abPages";

function list(title: string, items: string[]): string[] {
  const clean = items.map((s) => s.trim()).filter(Boolean);
  return clean.length ? [title, ...clean.map((s) => `- ${s}`), ""] : [];
}

/** Plain-text version of an ICP for the Copy button. */
export function icpToText(icp: IcpContent, stageLabel?: string): string {
  const d = icp.demographics;
  const demo = (
    [
      ["Age", d.ageRange],
      ["Role", d.role],
      ["Budget", d.budget],
      ["Location", d.location],
      ["Other", d.other],
    ] as const
  )
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}: ${v!.trim()}`);
  const out: string[] = [];
  if (stageLabel) out.push(`Ideal customer profile: ${stageLabel}`, "");
  out.push(...list("Pain points", icp.painPoints));
  if (demo.length) out.push("Demographics", ...demo.map((s) => `- ${s}`), "");
  out.push(...list("Psychographics", icp.psychographics));
  out.push(...list("What they say out loud", icp.saysOutLoud));
  out.push(...list("Interests", icp.interests));
  out.push(...list("Hopes & desires", icp.hopesAndDesires));
  if (icp.stageNotes?.trim()) out.push("What this reader knows", icp.stageNotes.trim(), "");
  if (icp.suggestedAngle?.trim()) out.push("Suggested angle", icp.suggestedAngle.trim(), "");
  return out.join("\n").trim();
}

/** Base page shown in the drawer: the user's pick if still a completed page, else the default. */
export function pickDisplayedBase(
  defaultBase: AbPage | null | undefined,
  pages: AbPage[],
  overrideId: string | null | undefined,
): AbPage | null {
  if (overrideId) {
    const hit = pages.find((p) => p.id === overrideId && p.status === "completed");
    if (hit) return hit;
  }
  return defaultBase ?? null;
}
