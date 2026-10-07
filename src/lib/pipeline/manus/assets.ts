import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Images the user supplies before a build (stats, product photos, team or
 * certificate images) that the page must use. Kept on disk next to the store
 * so a later "Regenerate page" still includes them.
 */
export type UserAsset = {
  /** File name the agent sees, e.g. "asset-1.png". */
  name: string;
  /** What the image shows / where it belongs, as the user wrote it. */
  caption: string;
  dataUrl: string;
};

export const MAX_ASSETS = 10;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

function assetsDir(competitorId: string): string {
  const dataDir = process.env.ADRIVAL_DATA_DIR?.trim() || path.join(process.cwd(), "data");
  return path.join(dataDir, "recreate-assets", competitorId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Keeps only PNG/JPEG/WebP data URLs within the size limit, at most MAX_ASSETS, with a short caption each. */
export function cleanAssets(raw: unknown): UserAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: UserAsset[] = [];
  for (const item of raw) {
    const dataUrl = String((item as { dataUrl?: unknown })?.dataUrl || "");
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) continue;
    if (Math.floor((m[2].length * 3) / 4) > MAX_ASSET_BYTES) continue;
    const caption = String((item as { caption?: unknown })?.caption || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    out.push({ name: `asset-${out.length + 1}.${ext}`, caption, dataUrl });
    if (out.length >= MAX_ASSETS) break;
  }
  return out;
}

/** Replaces the saved images for this page. */
export function saveAssets(competitorId: string, assets: UserAsset[]): void {
  const dir = assetsDir(competitorId);
  rmSync(dir, { recursive: true, force: true });
  if (!assets.length) return;
  mkdirSync(dir, { recursive: true });
  for (const a of assets) {
    writeFileSync(path.join(dir, a.name), Buffer.from(a.dataUrl.slice(a.dataUrl.indexOf(",") + 1), "base64"));
  }
  writeFileSync(
    path.join(dir, "index.json"),
    JSON.stringify(assets.map((a) => ({ name: a.name, caption: a.caption, type: a.dataUrl.slice(5, a.dataUrl.indexOf(";")) }))),
  );
}

/** The images saved for this page, or none. */
export function loadAssets(competitorId: string): UserAsset[] {
  const dir = assetsDir(competitorId);
  const index = path.join(dir, "index.json");
  if (!existsSync(index)) return [];
  try {
    const rows = JSON.parse(readFileSync(index, "utf8")) as Array<{ name: string; caption: string; type: string }>;
    return rows
      .filter((r) => existsSync(path.join(dir, r.name)))
      .map((r) => ({
        name: r.name,
        caption: r.caption || "",
        dataUrl: `data:${r.type};base64,${readFileSync(path.join(dir, r.name)).toString("base64")}`,
      }));
  } catch {
    return [];
  }
}
