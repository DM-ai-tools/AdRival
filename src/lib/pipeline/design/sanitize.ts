import * as cheerio from "cheerio";

const HANDLER = /^(on[a-z]+|javascript:)/i;

/** Keep layout markup. Drop competitor runtime, tracking, and form endpoints. */
export function sanitizeLayoutShell(html: string, competitorHost: string): string {
  const $ = cheerio.load(html);
  $("script, noscript, iframe, object, embed").remove();
  $("link[rel='preconnect'], link[rel='dns-prefetch']").remove();
  $("[class*='cookie'], [id*='cookie'], [class*='consent'], [id*='consent']").remove();
  $("*").each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs || {};
    for (const name of Object.keys(attribs)) {
      if (HANDLER.test(name) || HANDLER.test(attribs[name] || "")) {
        $(el).removeAttr(name);
      }
    }
  });
  const host = competitorHost.replace(/^www\./, "").toLowerCase();
  $("form").each((_, el) => {
    const action = ($(el).attr("action") || "").toLowerCase();
    const competitorAction = !action || action.startsWith("#") || (host && action.includes(host));
    if (competitorAction) {
      $(el).attr("action", "");
      $(el).attr("data-adrival-form", "unconfigured");
      $(el).find("[type='submit'], button").attr("type", "button");
    }
  });
  $("img[src*='pixel'], img[src*='tracking'], img[width='1']").remove();
  return $.html();
}
