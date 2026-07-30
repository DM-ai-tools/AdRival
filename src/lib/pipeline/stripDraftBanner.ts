/** Strip AdRival draft banner for publish export (safe for client + server). */
export function stripDraftBanner(html: string): string {
  return html.replace(
    /<div id="adrival-draft-banner"[\s\S]*?<\/div>/i,
    "",
  );
}
