import ExcelJS from "exceljs";
import type {
  LookupCoreOfferLadder,
  LookupOffersReport,
  LookupUniqueLandingPage,
} from "../types";
import { offerFitsSearchedService, type ServiceFocus } from "../pipeline/offerServiceFocus";
import {
  compareOffersLowToHigh,
  ladderSteps,
  splitLaddersByOffer,
  tierName,
  visibleOfferLadders,
} from "../../components/OfferLadderFlow";

/**
 * Offers dashboard as a workbook to show a client: every ad analysed, the
 * creatives and offers found in them, each competitor's offer ladder from
 * entry to premium, and the landing pages behind them. Uses the same
 * service filter as the dashboard, so the file matches what is on screen.
 */

export type OffersExportPart = "all" | "ads" | "creatives" | "ladders" | "pages";

export type OffersExportAd = {
  competitorName: string;
  platform?: string | null;
  title?: string | null;
  body?: string | null;
  ctaText?: string | null;
  landingPageUrl?: string | null;
  format?: string | null;
  daysRunning?: number | null;
  startDateString?: string | null;
  endDateString?: string | null;
  isActive?: boolean | null;
  country?: string | null;
  adLibraryUrl?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  youtubeUrl?: string | null;
};

export type OffersExportInput = {
  title: string;
  subtitle: string;
  platform: string | null;
  report: LookupOffersReport;
  ads: OffersExportAd[];
  /** Keep only rows for the searched service (search reports). */
  focus: ServiceFocus | null;
  part: OffersExportPart;
};

const BRAND = "FF0F7A6C";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
const BAND_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6F4" } };

function fits(text: string, focus: ServiceFocus | null, requireMatch = true): boolean {
  return !focus || offerFitsSearchedService(text, focus, { requireMatch });
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();
}

function date(value?: string | null): string {
  if (!value) return "";
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : clean(value);
}

function funnel(stage?: string | null): string {
  if (stage === "TOFU") return "Awareness (TOFU)";
  if (stage === "MOFU") return "Consideration (MOFU)";
  if (stage === "BOFU") return "Conversion (BOFU)";
  return "";
}

function link(url?: string | null, text?: string): ExcelJS.CellValue {
  const u = clean(url);
  if (!/^https?:\/\//i.test(u)) return u;
  return { text: text || u, hyperlink: u };
}

/** Header style, filters, frozen header, wrapped long text, banded rows. */
function styleSheet(sheet: ExcelJS.Worksheet, wrapKeys: string[]) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 28;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (sheet.rowCount > 1) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  }
  for (const key of wrapKeys) {
    const col = sheet.getColumn(key);
    col.alignment = { vertical: "top", wrapText: true };
  }
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => {
      if (cell.value && typeof cell.value === "object" && "hyperlink" in cell.value) {
        cell.font = { color: { argb: "FF1D4ED8" }, underline: true };
      }
    });
  });
}

function addAdsSheet(wb: ExcelJS.Workbook, ads: OffersExportAd[]) {
  const sheet = wb.addWorksheet("Ads by competitor");
  sheet.columns = [
    { header: "Competitor", key: "competitor", width: 24 },
    { header: "Ad #", key: "n", width: 7 },
    { header: "Headline", key: "title", width: 34 },
    { header: "Ad copy", key: "body", width: 70 },
    { header: "CTA", key: "cta", width: 16 },
    { header: "Landing page", key: "lp", width: 40 },
    { header: "Format", key: "format", width: 12 },
    { header: "Days running", key: "days", width: 12 },
    { header: "Started", key: "start", width: 12 },
    { header: "Status", key: "status", width: 10 },
    { header: "Country", key: "country", width: 9 },
    { header: "Platform", key: "platform", width: 11 },
    { header: "Ad Library", key: "library", width: 18 },
    { header: "Creative (image / video)", key: "media", width: 22 },
  ];
  // Competitors with the most ads first, their ads newest first.
  const byCompetitor = new Map<string, OffersExportAd[]>();
  for (const ad of ads) {
    const key = clean(ad.competitorName) || "Unknown";
    byCompetitor.set(key, [...(byCompetitor.get(key) || []), ad]);
  }
  const groups = [...byCompetitor.entries()].sort((a, b) => b[1].length - a[1].length);
  let band = false;
  for (const [competitor, list] of groups) {
    band = !band;
    list
      .sort((a, b) => (b.startDateString || "").localeCompare(a.startDateString || ""))
      .forEach((ad, i) => {
        const media = ad.videoUrl || ad.youtubeUrl || ad.imageUrl || "";
        const row = sheet.addRow({
          competitor,
          n: i + 1,
          title: clean(ad.title),
          body: clean(ad.body),
          cta: clean(ad.ctaText),
          lp: link(ad.landingPageUrl),
          format: clean(ad.format),
          days: typeof ad.daysRunning === "number" && ad.daysRunning >= 0 ? ad.daysRunning : "",
          start: date(ad.startDateString),
          status: ad.isActive === false ? "Inactive" : "Active",
          country: clean(ad.country),
          platform: clean(ad.platform),
          library: link(ad.adLibraryUrl, "View ad"),
          media: link(media, ad.videoUrl || ad.youtubeUrl ? "Open video" : "Open image"),
        });
        if (band) row.fill = BAND_FILL;
      });
  }
  styleSheet(sheet, ["title", "body"]);
  return { ads: ads.length, competitors: groups.length };
}

function addCreativesSheets(wb: ExcelJS.Workbook, report: LookupOffersReport, focus: ServiceFocus | null) {
  const creatives = (report.adCopy?.creatives || []).filter((c) =>
    fits(`${c.offer} ${c.hook} ${c.serviceTargeted || ""} ${c.sampleCopy || ""} ${c.cta || ""}`, focus),
  );
  const sheet = wb.addWorksheet("Creatives & offers");
  sheet.columns = [
    { header: "#", key: "n", width: 6 },
    { header: "Hook", key: "hook", width: 40 },
    { header: "Offer", key: "offer", width: 40 },
    { header: "Service", key: "service", width: 20 },
    { header: "Funnel stage", key: "funnel", width: 20 },
    { header: "CTA", key: "cta", width: 16 },
    { header: "Ads using it", key: "ads", width: 11 },
    { header: "Sample copy", key: "copy", width: 70 },
    { header: "Landing page", key: "lp", width: 40 },
  ];
  [...creatives]
    .sort((a, b) => b.adCount - a.adCount)
    .forEach((c, i) =>
      sheet.addRow({
        n: i + 1,
        hook: clean(c.hook),
        offer: clean(c.offer),
        service: clean(c.serviceTargeted),
        funnel: funnel(c.funnelStage),
        cta: clean(c.cta),
        ads: c.adCount,
        copy: clean(c.sampleCopy),
        lp: link(c.landingPageUrl),
      }),
    );
  styleSheet(sheet, ["hook", "offer", "copy"]);

  const offers = [...(report.adCopy?.uniqueOffers || []), ...(report.landingPages?.uniqueOffers || [])].filter((o) =>
    fits(`${o.offer} ${o.pricing || ""} ${o.cta || ""} ${(o.sampleHooks || []).join(" ")}`, focus),
  );
  // One row per distinct offer, merging where it appears in ads and on pages.
  const merged = new Map<string, (typeof offers)[number]>();
  for (const o of offers) {
    const key = clean(o.offer).toLowerCase();
    const prev = merged.get(key);
    if (!prev) merged.set(key, { ...o });
    else
      merged.set(key, {
        ...prev,
        source: prev.source === o.source ? prev.source : "both",
        adCount: Math.max(prev.adCount, o.adCount),
        pricing: prev.pricing || o.pricing,
        cta: prev.cta || o.cta,
        evidence: prev.evidence || o.evidence,
        urls: [...new Set([...(prev.urls || []), ...(o.urls || [])])],
        sampleHooks: [...new Set([...(prev.sampleHooks || []), ...(o.sampleHooks || [])])],
      });
  }
  const offerSheet = wb.addWorksheet("Unique offers");
  offerSheet.columns = [
    { header: "#", key: "n", width: 6 },
    { header: "Offer", key: "offer", width: 44 },
    { header: "Found in", key: "source", width: 18 },
    { header: "Price level", key: "tier", width: 16 },
    { header: "Pricing", key: "pricing", width: 18 },
    { header: "CTA", key: "cta", width: 16 },
    { header: "Funnel stage", key: "funnel", width: 20 },
    { header: "Ads", key: "ads", width: 8 },
    { header: "Evidence", key: "evidence", width: 50 },
    { header: "Sample hooks", key: "hooks", width: 50 },
    { header: "Pages", key: "urls", width: 40 },
  ];
  [...merged.values()]
    .sort((a, b) => b.adCount - a.adCount)
    .forEach((o, i) =>
      offerSheet.addRow({
        n: i + 1,
        offer: clean(o.offer),
        source: o.source === "both" ? "Ads and pages" : o.source === "landing_page" ? "Landing pages" : "Ad copy",
        tier: o.ticketTier ? tierName(o.ticketTier) : "",
        pricing: clean(o.pricing),
        cta: clean(o.cta),
        funnel: funnel(o.funnelStage),
        ads: o.adCount,
        evidence: clean(o.evidence),
        hooks: (o.sampleHooks || []).slice(0, 4).map(clean).join("\n"),
        urls: (o.urls || []).slice(0, 5).join("\n"),
      }),
    );
  styleSheet(offerSheet, ["offer", "evidence", "hooks", "urls"]);
  return { creatives: creatives.length, offers: merged.size };
}

function addLaddersSheet(wb: ExcelJS.Workbook, report: LookupOffersReport, focus: ServiceFocus | null) {
  const raw = report.valueLadder?.ladders || [];
  const ladders: LookupCoreOfferLadder[] = focus ? visibleOfferLadders(raw, focus) : splitLaddersByOffer(raw);
  const sheet = wb.addWorksheet("Offer ladders");
  sheet.columns = [
    { header: "Competitor", key: "competitor", width: 24 },
    { header: "Step", key: "step", width: 7 },
    { header: "Price level", key: "tier", width: 18 },
    { header: "Offer", key: "offer", width: 44 },
    { header: "Pricing", key: "pricing", width: 18 },
    { header: "CTA", key: "cta", width: 16 },
    { header: "Funnel stage", key: "funnel", width: 20 },
    { header: "Ads", key: "ads", width: 8 },
    { header: "Evidence", key: "evidence", width: 50 },
    { header: "Landing page", key: "lp", width: 40 },
  ];
  // Each competitor's offers together, entry → premium, like the ladder strips.
  const byCompetitor = new Map<string, LookupCoreOfferLadder[]>();
  for (const ladder of ladders) {
    const names = ladder.sourceCompetitors?.length ? ladder.sourceCompetitors : ["Other offers"];
    for (const name of names) byCompetitor.set(name, [...(byCompetitor.get(name) || []), ladder]);
  }
  let band = false;
  let rows = 0;
  for (const [competitor, list] of [...byCompetitor.entries()].sort((a, b) => b[1].length - a[1].length)) {
    band = !band;
    [...list].sort(compareOffersLowToHigh).forEach((ladder, i) => {
      const step = ladderSteps(ladder)[0];
      const row = sheet.addRow({
        competitor,
        step: i + 1,
        tier: tierName(ladder.ticketTier),
        offer: clean(ladder.coreOffer),
        pricing: clean(ladder.pricing),
        cta: clean(ladder.cta),
        funnel: funnel(ladder.funnelStage),
        ads: ladder.adCount || ladder.adOffers?.reduce((n, a) => n + a.adCount, 0) || "",
        evidence: clean(step?.evidence),
        lp: link(ladder.landingPageUrl || step?.landingPageUrl),
      });
      if (band) row.fill = BAND_FILL;
      rows += 1;
    });
  }
  styleSheet(sheet, ["offer", "evidence"]);
  return { ladders: ladders.length, rows };
}

function addPagesSheet(wb: ExcelJS.Workbook, report: LookupOffersReport, focus: ServiceFocus | null) {
  const pages = (report.landingPages?.pages || []).filter((p: LookupUniqueLandingPage) =>
    fits(
      `${p.primaryOffer || ""} ${p.headline || ""} ${p.serviceTargeted || ""} ${p.summary || ""} ${p.cta || ""}`,
      focus,
      p.status === "completed" && Boolean(p.primaryOffer),
    ),
  );
  const sheet = wb.addWorksheet("Landing pages");
  sheet.columns = [
    { header: "Landing page", key: "url", width: 42 },
    { header: "Headline", key: "headline", width: 36 },
    { header: "Primary offer", key: "offer", width: 40 },
    { header: "Pricing", key: "pricing", width: 18 },
    { header: "CTA", key: "cta", width: 16 },
    { header: "Service", key: "service", width: 20 },
    { header: "Funnel stage", key: "funnel", width: 20 },
    { header: "Ads pointing here", key: "ads", width: 11 },
    { header: "Value points", key: "uvps", width: 50 },
    { header: "Other offers on the page", key: "more", width: 50 },
    { header: "Summary", key: "summary", width: 60 },
    { header: "Analysis", key: "status", width: 12 },
  ];
  [...pages]
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0) || b.adCount - a.adCount)
    .forEach((p) =>
      sheet.addRow({
        url: link(p.url),
        headline: clean(p.headline),
        offer: clean(p.primaryOffer),
        pricing: clean(p.pricing),
        cta: clean(p.cta),
        service: clean(p.serviceTargeted),
        funnel: funnel(p.funnelStage),
        ads: p.adCount,
        uvps: (p.uniqueValueProps || []).map(clean).join("\n"),
        more: (p.serviceOffers || [])
          .map((o) => [clean(o.offer), o.pricing ? `(${clean(o.pricing)})` : ""].filter(Boolean).join(" "))
          .join("\n"),
        summary: clean(p.summary),
        status: p.status === "completed" ? "Read" : p.status === "failed" ? "Could not read" : "Skipped",
      }),
    );
  styleSheet(sheet, ["headline", "offer", "uvps", "more", "summary"]);
  return { pages: pages.length };
}

export async function buildOffersWorkbook(input: OffersExportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AdRival";
  wb.created = new Date();
  const part = input.part;
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "", key: "k", width: 26 },
    { header: "", key: "v", width: 90 },
  ];

  const counts: Array<[string, string | number]> = [];
  if (part === "all" || part === "ads") {
    const r = addAdsSheet(wb, input.ads);
    counts.push(["Competitors", r.competitors], ["Ads analysed", r.ads]);
  }
  if (part === "all" || part === "creatives") {
    const r = addCreativesSheets(wb, input.report, input.focus);
    counts.push(["Creatives", r.creatives], ["Unique offers", r.offers]);
  }
  if (part === "all" || part === "ladders") {
    const r = addLaddersSheet(wb, input.report, input.focus);
    counts.push(["Offers in ladders", r.ladders]);
  }
  if (part === "all" || part === "pages") {
    const r = addPagesSheet(wb, input.report, input.focus);
    counts.push(["Landing pages", r.pages]);
  }

  const title = summary.addRow({ k: input.title });
  title.font = { bold: true, size: 16, color: { argb: BRAND } };
  if (input.subtitle) summary.addRow({ k: input.subtitle });
  summary.addRow({});
  const rows: Array<[string, string | number]> = [
    ["Platform", input.platform || ""],
    ["Report generated", date(input.report.updatedAt || input.report.createdAt)],
    ["Exported", new Date().toISOString().slice(0, 10)],
    ...counts,
  ];
  for (const [k, v] of rows) {
    const row = summary.addRow({ k, v });
    row.getCell(1).font = { bold: true };
  }
  const narrative = clean(input.report.summary || input.report.valueLadder?.summary);
  if (narrative) {
    summary.addRow({});
    const h = summary.addRow({ k: "Overview" });
    h.font = { bold: true };
    const r = summary.addRow({ v: narrative });
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  // The header row of the summary sheet is not a table header.
  summary.spliceRows(1, 1);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
