import ExcelJS from "exceljs";
import type { CompetitorRecord, SearchJob } from "../types";
import type { ServiceFocus } from "../pipeline/offerServiceFocus";
import { maskClientFacingText } from "../clientFacing";
import { BRAND, addOffersSheets, clean, date, link, styleSheet, type OffersExportAd } from "./offersExcel";

/**
 * Everything a search run holds, in the order the app shows it: the client's
 * website analysis, the search, the competitors found, their landing pages,
 * the offers dashboard and the recreated pages. One sheet per section.
 */

export type FullReportInput = {
  job: SearchJob;
  /** Competitors the search found (not pages held only for recreation). */
  competitors: CompetitorRecord[];
  /** Landing pages from the offers dashboard held for recreation. */
  recreateOnly: CompetitorRecord[];
  /** The ads the offers dashboard shows (chosen competitors, searched service). */
  offerAds: OffersExportAd[];
  focus: ServiceFocus | null;
  /** Site address for links to recreated pages, e.g. https://app.example.com */
  origin: string;
};

const SECTION_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6F4" } };

const GEO_MODE: Record<string, string> = {
  countrywide: "Country-wide",
  company_locations: "Around the business (city/suburb)",
  keyword_location: "Place named in the keywords",
};

const REJECT_LABEL: Record<string, string> = {
  inactive: "Ad no longer running",
  shortDuration: "Ads running too briefly",
  noServiceSignal: "Ad copy not about the service",
  nonEnglish: "Not in English",
  noLandingPage: "No landing page",
  llmReject: "Not a direct competitor (AI review)",
  llmError: "Could not be reviewed",
  lowActiveAds: "Too few live ads",
  countError: "Ad count unavailable",
  guardrailReject: "Wrong kind of business",
  noReadableCopy: "Ads had no readable text",
  noAdsInRegion: "No ads in the chosen country",
  notCompetitorSite: "Directory, publisher or non-competitor site",
};

const LOCATION_STATUS: Record<string, string> = {
  matched: "In the target area",
  mismatch: "Outside the target area",
  unknown: "Unknown",
};

const PAGE_STATUS: Record<string, string> = {
  pending: "Building",
  design_pending: "Building",
  content_ready: "Draft ready",
  completed: "Ready",
  failed: "Failed",
};

/** A two-column sheet of labelled values, with bold section headings. */
function keyValueSheet(wb: ExcelJS.Workbook, name: string, rows: Array<[string, unknown] | string>) {
  const sheet = wb.addWorksheet(name);
  sheet.columns = [
    { header: "", key: "k", width: 30 },
    { header: "", key: "v", width: 100 },
  ];
  for (const row of rows) {
    if (typeof row === "string") {
      sheet.addRow({});
      const h = sheet.addRow({ k: row });
      h.font = { bold: true, color: { argb: BRAND } };
      h.fill = SECTION_FILL;
      continue;
    }
    const [k, v] = row;
    const value = Array.isArray(v) ? v.map(clean).filter(Boolean).join("\n") : v;
    if (value === undefined || value === null || value === "") continue;
    const r = sheet.addRow({ k, v: typeof value === "string" && /^https?:\/\//i.test(value) ? link(value) : value });
    r.getCell(1).font = { bold: true };
    r.alignment = { vertical: "top", wrapText: true };
  }
  // The header row of a key/value sheet is not a table header.
  sheet.spliceRows(1, 1);
  return sheet;
}

function websiteSheet(wb: ExcelJS.Workbook, job: SearchJob): number {
  const p = job.businessProfile;
  if (!p) {
    keyValueSheet(wb, "Your website", [
      ["Website", job.businessUrl || ""],
      ["Note", "This search was run without analysing a website."],
    ]);
    return 0;
  }
  const area = p.serviceArea;
  const assets = p.brandAssets;
  const c = p.brandColors;
  keyValueSheet(wb, "Your website", [
    "Business",
    ["Business name", p.businessName],
    ["Website", p.url || job.businessUrl || ""],
    ["Industry", [p.industry, p.subIndustry].filter(Boolean).join(" / ")],
    ["What they do", p.description],
    ["Positioning", p.positioningSummary],
    ["Target audience", p.targetAudience],
    ["Business model", p.businessModel],
    ["Service delivery", p.serviceDelivery],
    ["Main market", p.primaryMarketCountry],
    "Offerings",
    ["Services / products", p.offerings],
    ["Categories", (p.categories || []).map((cat) => `${cat.label}${cat.type ? ` (${cat.type})` : ""}`)],
    ["Suggested search keywords", p.competitorKeywords],
    "Location",
    ["Locations", (p.locations || []).map((l) => `${l.label || [l.suburb, l.city, l.region, l.countryCode].filter(Boolean).join(", ")}${l.isPrimary ? " (main)" : ""}`)],
    ["Suggested search area", p.recommendedGeoScope === "local" ? "City / suburb" : p.recommendedGeoScope === "countrywide" ? "Country-wide" : ""],
    ["Why", p.geoScopeReason],
    ["Customers travel up to", area?.radiusKm ? `${area.radiusKm} km` : ""],
    ["Nearby areas", area?.nearbyAreas],
    ["Wider areas", area?.widerAreas],
    ["Outer areas", area?.outerAreas || []],
    ["Metro / region", [area?.metro, area?.region].filter(Boolean).join(" / ")],
    "Brand",
    ["Site name", assets?.siteName],
    ["Logo", assets?.logoUrl || ""],
    ["Brand colours", c ? `Primary ${c.primary} · Secondary ${c.secondary} · Accent ${c.accent} · Background ${c.background} · Text ${c.text}` : ""],
    ["Phones", assets?.phones || []],
    ["Emails", assets?.emails || []],
    ["Social links", (assets?.socialLinks || []).map((l) => `${l.label}: ${l.href}`)],
    ["Menu links", (assets?.navLinks || []).map((l) => `${l.label}: ${l.href}`)],
    ["Analysed", date(p.analyzedAt)],
  ]);
  return 1;
}

function searchSheet(wb: ExcelJS.Workbook, job: SearchJob) {
  const reasons = Object.entries(job.progress.rejectReasons || {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([k, n]) => `${REJECT_LABEL[k] || k}: ${n}`);
  keyValueSheet(wb, "Search", [
    "What was searched",
    ["Keywords", job.keywords?.length ? job.keywords : [job.keyword]],
    ["Category", job.selectedCategory?.label || ""],
    ["Platform", job.platform || ""],
    ["Country", job.geo || (job.countries || []).join(", ")],
    ["Search area", GEO_MODE[job.geoMode || ""] || job.geoMode || ""],
    ["Target places", (job.targetLocations || []).map((l) => l.label || l.city)],
    ["Competitor rules", job.skipGuardrails ? "Off" : job.guardrailOverride?.enabled ? `Custom: ${job.guardrailOverride.seekCompetitors || ""}` : "Standard"],
    "Result",
    ["Status", job.status],
    ["Competitors found", job.progress.accepted],
    ["Ads scanned", job.progress.scannedAds],
    ["Result pages read", job.progress.scannedPages],
    ["Advertisers rejected", job.progress.rejected],
    ["Why advertisers were rejected", reasons],
    ["Last message", maskClientFacingText(job.progress.message) || ""],
    ["Started", job.createdAt],
    ["Finished / updated", job.updatedAt],
  ]);
}

function competitorsSheet(wb: ExcelJS.Workbook, competitors: CompetitorRecord[]) {
  const sheet = wb.addWorksheet("Competitors");
  sheet.columns = [
    { header: "#", key: "n", width: 5 },
    { header: "Company", key: "name", width: 28 },
    { header: "Website", key: "website", width: 30 },
    { header: "Platform", key: "platform", width: 11 },
    { header: "Country", key: "country", width: 9 },
    { header: "Location", key: "location", width: 26 },
    { header: "Target area", key: "locStatus", width: 18 },
    { header: "Live ads", key: "ads", width: 9 },
    { header: "Services", key: "services", width: 30 },
    { header: "Sample ad headline", key: "title", width: 34 },
    { header: "Sample ad text", key: "body", width: 50 },
    { header: "CTA", key: "cta", width: 16 },
    { header: "Landing page", key: "lp", width: 40 },
    { header: "Ad running (days)", key: "days", width: 11 },
    { header: "Ad library", key: "lib", width: 30 },
    { header: "Brand size score", key: "score", width: 11 },
    { header: "Brand size note", key: "scoreNote", width: 40 },
    { header: "Revenue estimate", key: "revenue", width: 16 },
    { header: "Address", key: "address", width: 30 },
    { header: "Facebook", key: "fb", width: 30 },
    { header: "FB followers", key: "fbF", width: 12 },
    { header: "Instagram", key: "ig", width: 18 },
    { header: "IG followers", key: "igF", width: 12 },
    { header: "LinkedIn", key: "li", width: 30 },
    { header: "LI followers", key: "liF", width: 12 },
    { header: "LI employees", key: "liE", width: 12 },
    { header: "YouTube", key: "yt", width: 22 },
    { header: "YT subscribers", key: "ytS", width: 12 },
    { header: "X / Twitter", key: "x", width: 16 },
    { header: "X followers", key: "xF", width: 12 },
    { header: "Page analysed", key: "analysed", width: 12 },
    { header: "Recreated page", key: "recreated", width: 14 },
  ];
  competitors.forEach((c, i) => {
    const b = c.brand || {};
    sheet.addRow({
      n: i + 1,
      name: clean(c.pageName),
      website: link(b.website),
      platform: c.platform || "",
      country: c.country || "",
      location: clean(c.locationLabel || [c.locationSuburb, c.locationCity, c.locationCountry].filter(Boolean).join(", ")),
      locStatus: LOCATION_STATUS[c.locationStatus || ""] || "",
      ads: c.activeAdsCount,
      services: (c.services || []).join(", "),
      title: clean(c.sampleAd?.title),
      body: clean(c.sampleAd?.body),
      cta: clean(c.sampleAd?.ctaText),
      lp: link(c.sampleAd?.landingPageUrl),
      days: c.sampleAd?.daysRunning >= 0 ? c.sampleAd.daysRunning : "",
      lib: link(c.sampleAd?.adLibraryUrl),
      score: b.brandScore ?? "",
      scoreNote: clean(b.brandScoreSummary),
      revenue: clean(b.companyRevenue),
      address: clean(b.address),
      fb: link(b.facebookUrl),
      fbF: b.facebookFollowers ?? "",
      ig: clean(b.instagramHandle),
      igF: b.instagramFollowers ?? "",
      li: link(b.linkedinUrl),
      liF: b.linkedinFollowers ?? "",
      liE: b.linkedinEmployees ?? "",
      yt: b.youtubeUrl ? link(b.youtubeUrl) : clean(b.youtubeHandle),
      ytS: b.youtubeSubscribers ?? "",
      x: clean(b.twitterHandle),
      xF: b.twitterFollowers ?? "",
      analysed: c.pageAnalysis?.status === "completed" ? "Yes" : "",
      recreated: c.recreatedPage ? PAGE_STATUS[c.recreatedPage.status] || c.recreatedPage.status : "",
    });
  });
  styleSheet(sheet, ["services", "title", "body", "scoreNote"]);
}

function pageAnalysisSheet(wb: ExcelJS.Workbook, records: CompetitorRecord[]): number {
  const analysed = records.filter((c) => c.pageAnalysis);
  const sheet = wb.addWorksheet("Landing page analysis");
  sheet.columns = [
    { header: "Competitor", key: "name", width: 24 },
    { header: "Landing page", key: "url", width: 40 },
    { header: "Analysis", key: "status", width: 12 },
    { header: "Page type", key: "type", width: 16 },
    { header: "Headline", key: "headline", width: 36 },
    { header: "Primary offer", key: "offer", width: 40 },
    { header: "Pricing", key: "pricing", width: 18 },
    { header: "CTA", key: "cta", width: 18 },
    { header: "Guarantees", key: "guarantees", width: 30 },
    { header: "Urgency", key: "urgency", width: 22 },
    { header: "Value points", key: "uvps", width: 44 },
    { header: "Audience", key: "audience", width: 30 },
    { header: "Trust signals", key: "trust", width: 36 },
    { header: "Conversion elements", key: "conversion", width: 36 },
    { header: "Page sections", key: "sections", width: 50 },
    { header: "Summary", key: "summary", width: 60 },
    { header: "Ads using this page", key: "adsHere", width: 11 },
    { header: "Ad hooks and offers", key: "hooks", width: 60 },
  ];
  for (const c of analysed) {
    const a = c.pageAnalysis!;
    const same = a.sameLandingPageAds;
    sheet.addRow({
      name: clean(c.recreateOnly ? `${c.pageName} (from offers dashboard)` : c.pageName),
      url: link(a.analyzedUrl),
      status: a.status === "completed" ? "Done" : a.status === "failed" ? "Failed" : "Running",
      type: clean(a.pageArchitecture?.pageType),
      headline: clean(a.offer?.headline),
      offer: clean(a.offer?.primaryOffer),
      pricing: clean(a.offer?.pricing),
      cta: clean(a.offer?.cta),
      guarantees: (a.offer?.guarantees || []).map(clean).join("\n"),
      urgency: clean(a.offer?.urgency),
      uvps: (a.offer?.uniqueValueProps || []).map(clean).join("\n"),
      audience: clean(a.audience),
      trust: (a.trustSignals || []).map(clean).join("\n"),
      conversion: (a.conversionElements || []).map(clean).join("\n"),
      sections: (a.pageArchitecture?.sections || []).map((s, i) => `${i + 1}. ${clean(s.name)}: ${clean(s.purpose)}`).join("\n"),
      summary: clean(a.summary),
      adsHere: same ? same.matchingAds : "",
      hooks: (same?.ads || [])
        .slice(0, 6)
        .map((ad) => `${clean(ad.hook)}${ad.offer ? ` → ${clean(ad.offer)}` : ""}`)
        .join("\n"),
    });
  }
  styleSheet(sheet, ["headline", "offer", "guarantees", "uvps", "trust", "conversion", "sections", "summary", "hooks"]);
  return analysed.length;
}

function recreatedSheet(wb: ExcelJS.Workbook, records: CompetitorRecord[], origin: string): number {
  const built = records.filter((c) => c.recreatedPage);
  const sheet = wb.addWorksheet("Recreated pages");
  sheet.columns = [
    { header: "Competitor page", key: "name", width: 26 },
    { header: "Copied from", key: "source", width: 40 },
    { header: "Built for", key: "for", width: 30 },
    { header: "Status", key: "status", width: 12 },
    { header: "Look", key: "style", width: 14 },
    { header: "Ready to publish", key: "ready", width: 12 },
    { header: "Notes to review", key: "notes", width: 60 },
    { header: "About the build", key: "about", width: 60 },
    { header: "Last change", key: "change", width: 40 },
    { header: "Updated", key: "updated", width: 12 },
    { header: "Open in the app", key: "open", width: 40 },
  ];
  for (const c of built) {
    const p = c.recreatedPage!;
    sheet.addRow({
      name: clean(c.pageName),
      source: link(p.sourceAnalyzedUrl),
      for: clean(p.businessName || p.businessUrl),
      status: PAGE_STATUS[p.status] || p.status,
      style: p.styleDirection || "brand",
      ready: p.status === "completed" ? (p.publishReady ? "Yes" : "Review first") : "",
      notes: (p.publishBlockers || []).map((n) => maskClientFacingText(n) || "").join("\n"),
      about: maskClientFacingText(p.differentiationNotes) || "",
      change: maskClientFacingText(p.lastEdit?.summary) || "",
      updated: date(p.updatedAt),
      open: link(`${origin}/recreate/${encodeURIComponent(c.id)}`, "Open recreated page"),
    });
  }
  styleSheet(sheet, ["notes", "about", "change"]);
  return built.length;
}

export async function buildFullReportWorkbook(input: FullReportInput): Promise<Buffer> {
  const { job } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = "AdRival";
  wb.created = new Date();
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "", key: "k", width: 30 },
    { header: "", key: "v", width: 90 },
  ];

  websiteSheet(wb, job);
  searchSheet(wb, job);
  competitorsSheet(wb, input.competitors);
  const analysed = pageAnalysisSheet(wb, [...input.competitors, ...input.recreateOnly]);
  const report = job.offersReport?.status === "completed" ? job.offersReport : null;
  const offerCounts = report ? addOffersSheets(wb, { report, ads: input.offerAds, focus: input.focus }) : [];
  const recreated = recreatedSheet(wb, [...input.competitors, ...input.recreateOnly], input.origin);

  const client = job.businessProfile?.businessName || job.businessUrl || "";
  const title = summary.addRow({ k: `Full report${client ? ` — ${client}` : ""}` });
  title.font = { bold: true, size: 16, color: { argb: BRAND } };
  summary.addRow({ k: [job.keyword, job.platform, job.geo].filter(Boolean).join(" · ") });
  summary.addRow({});
  const rows: Array<[string, string | number]> = [
    ["Client website", job.businessProfile?.url || job.businessUrl || "Not analysed"],
    ["Keywords", (job.keywords?.length ? job.keywords : [job.keyword]).join(", ")],
    ["Search run", date(job.createdAt)],
    ["Exported", new Date().toISOString().slice(0, 10)],
    ["Competitors found", input.competitors.length],
    ["Landing pages analysed", analysed],
    ["Offers dashboard", report ? `Ready (${date(report.updatedAt || report.createdAt)})` : "Not generated yet"],
    ...offerCounts.map(([k, v]) => [`  ${k}`, v] as [string, string | number]),
    ["Recreated pages", recreated],
  ];
  for (const [k, v] of rows) {
    const row = summary.addRow({ k, v });
    row.getCell(1).font = { bold: true };
  }
  summary.addRow({});
  const sheetsHead = summary.addRow({ k: "Sheets in this file" });
  sheetsHead.font = { bold: true, color: { argb: BRAND } };
  const guide: Array<[string, string]> = [
    ["Your website", "The client's website analysis: business, offerings, locations, brand."],
    ["Search", "What was searched and why advertisers were rejected."],
    ["Competitors", "Every competitor found, with its ad, location, brand size and socials."],
    ["Landing page analysis", "Offer, CTA, value points and sections of each analysed landing page."],
    ...(report
      ? ([
          ["Ads by competitor", "Every ad the offers dashboard analysed."],
          ["Creatives & offers", "The hooks and offers found in the ads."],
          ["Unique offers", "Each distinct offer, merged across ads and pages."],
          ["Offer ladders", "Each competitor's offers from entry to premium."],
          ["Landing pages", "The landing pages behind the offers."],
        ] as Array<[string, string]>)
      : []),
    ["Recreated pages", "Pages rebuilt for the client and what to review before publishing."],
  ];
  for (const [k, v] of guide) summary.addRow({ k, v });
  const narrative = clean(report?.summary || report?.valueLadder?.summary);
  if (narrative) {
    summary.addRow({});
    const h = summary.addRow({ k: "Offers overview" });
    h.font = { bold: true, color: { argb: BRAND } };
    const r = summary.addRow({ v: narrative });
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  summary.spliceRows(1, 1);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
