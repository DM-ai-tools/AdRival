/**
 * Exact hex/rgb color replacement helpers shared by deterministic brand apply.
 * Kept separate so capture/apply stay free of the older cloneLandingPage coupling.
 */

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function replaceColorEverywhere(
  html: string,
  fromHex: string,
  toHex: string,
): string {
  const from = fromHex.toUpperCase();
  const to = toHex.toUpperCase();
  if (from === to || from.length < 4) return html;

  let out = html;
  out = out.replace(new RegExp(from.replace("#", "#?"), "gi"), to);
  // also bare 6-digit without hash in some SVG fill attrs is rare — skip

  try {
    const r = parseInt(from.slice(1, 3), 16);
    const g = parseInt(from.slice(3, 5), 16);
    const b = parseInt(from.slice(5, 7), 16);
    const tr = parseInt(to.slice(1, 3), 16);
    const tg = parseInt(to.slice(3, 5), 16);
    const tb = parseInt(to.slice(5, 7), 16);
    const rgbRe = new RegExp(
      `rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}(\\s*,\\s*[\\d.]+)?\\s*\\)`,
      "gi",
    );
    out = out.replace(rgbRe, (_m, alpha?: string) => {
      if (alpha) {
        return `rgba(${tr}, ${tg}, ${tb}${alpha})`;
      }
      return `rgb(${tr}, ${tg}, ${tb})`;
    });
  } catch {
    // ignore
  }

  void clampByte;
  return out;
}
