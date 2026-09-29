import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import type { LookupOffersReport } from "../src/lib/types";

const report = {
  status: "completed",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  summary: "Competitors lead with free audits and sell monthly retainers.",
  adsAnalyzed: 3,
  adCopy: {
    uniqueCreatives: 1,
    creatives: [{ id: "c1", hook: "Is your SEO leaking leads?", offer: "Free SEO audit", sampleCopy: "Book a free SEO audit today.", adCount: 2, sampleAdIds: [], cta: "Book now", serviceTargeted: "SEO", funnelStage: "BOFU" }],
    uniqueOffers: [{ offer: "Free SEO audit", source: "ad_copy", adCount: 2, ticketTier: "low" }],
  },
  landingPages: {
    uniqueUrls: 1,
    analyzed: 1,
    failed: 0,
    pages: [{ url: "https://a.example/seo", matchKey: "a.example/seo", adCount: 2, status: "completed", primaryOffer: "SEO retainer", headline: "SEO that ranks", uniqueValueProps: ["Monthly reports"] }],
    uniqueOffers: [{ offer: "Free SEO audit", source: "landing_page", adCount: 1, evidence: "Get your free audit" }],
  },
  valueLadder: {
    ladders: [
      { id: "l2", rank: 1, coreOffer: "SEO retainer", details: "", cta: null, ticketTier: "high", pricing: "$2,000/month", funnelStage: "BOFU", landingPageUrl: null, adCount: 1, adOffers: [], sourceCompetitors: ["Agency A"] },
      { id: "l1", rank: 2, coreOffer: "Free SEO audit", details: "", cta: "Book", ticketTier: "low", pricing: null, funnelStage: "TOFU", landingPageUrl: "https://a.example/audit", adCount: 2, adOffers: [], sourceCompetitors: ["Agency A"] },
    ],
  },
} as unknown as LookupOffersReport;

const ads = [
  { competitorName: "Agency A", title: "Free SEO audit", body: "We audit your site.", adLibraryUrl: "https://www.facebook.com/ads/library/?id=1", landingPageUrl: "https://a.example/audit", daysRunning: 40 },
  { competitorName: "Agency A", title: "SEO that ranks", body: "Monthly SEO.", adLibraryUrl: "https://www.facebook.com/ads/library/?id=2" },
  { competitorName: "Agency B", title: "Local SEO", body: "Get found locally.", adLibraryUrl: "https://www.facebook.com/ads/library/?id=3" },
];

test("the offers workbook has every sheet, ads grouped by competitor and ladders low to high", async () => {
  const { buildOffersWorkbook } = await import("../src/lib/export/offersExcel");
  const buf = await buildOffersWorkbook({ title: "Competitor offers — SEO", subtitle: "", platform: "facebook", report, ads, focus: null, part: "all" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(
    wb.worksheets.map((s) => s.name),
    ["Summary", "Ads by competitor", "Creatives & offers", "Unique offers", "Offer ladders", "Landing pages"],
  );

  const adsSheet = wb.getWorksheet("Ads by competitor")!;
  assert.equal(adsSheet.rowCount, 4, "header + 3 ads");
  assert.equal(adsSheet.getCell("A2").value, "Agency A", "the competitor with most ads first");
  const library = adsSheet.getCell("M2").value as { hyperlink?: string };
  assert.match(String(library.hyperlink), /ads\/library/, "Ad Library link is clickable");

  const ladder = wb.getWorksheet("Offer ladders")!;
  assert.equal(ladder.getCell("D2").value, "Free SEO audit", "entry offer first");
  assert.equal(ladder.getCell("C2").value, "Entry");
  assert.equal(ladder.getCell("D3").value, "SEO retainer");

  const offers = wb.getWorksheet("Unique offers")!;
  assert.equal(offers.rowCount, 2, "the same offer from ads and pages is one row");
  assert.equal(offers.getCell("C2").value, "Ads and pages");
});

test("a single-tab download holds only that tab plus the summary", async () => {
  const { buildOffersWorkbook } = await import("../src/lib/export/offersExcel");
  const buf = await buildOffersWorkbook({ title: "t", subtitle: "", platform: null, report, ads, focus: null, part: "ads" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["Summary", "Ads by competitor"]);
});
