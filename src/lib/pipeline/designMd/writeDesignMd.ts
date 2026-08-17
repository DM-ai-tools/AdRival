import fs from "fs";
import path from "path";

const RECREATE_DIR = path.join(process.cwd(), "data", "recreate");

export function designMdPath(competitorId: string): string {
  const safe = String(competitorId || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  return path.join(RECREATE_DIR, safe, "design.md");
}

/** Write ephemeral per-run design.md; returns absolute path. */
export function writeDesignMd(
  competitorId: string,
  markdown: string,
): string {
  const filePath = designMdPath(competitorId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, markdown, "utf8");
  return filePath;
}

/** Delete ephemeral design.md (and empty parent dir when possible). */
export function deleteDesignMd(competitorId: string): void {
  const filePath = designMdPath(competitorId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
  try {
    const dir = path.dirname(filePath);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore
  }
}

export function readDesignMd(competitorId: string): string | null {
  const filePath = designMdPath(competitorId);
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
