import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { buildFullReportWorkbook } from "../src/lib/export/fullReportExcel";
import type { CompetitorRecord, SearchJob } from "../src/lib/types";

const now = "2026-10-07T00:00:00.000Z";

const job = {
  id: "run-1",
  keyword: "seo agency",
  keywords: ["seo agency"],
  platform: "facebook",
  geo: "AU",
  businessUrl: "https://client.example",
  businessProfile: {
    url: "https://client.example",
    businessName: "Client Co",
    industry: "Marketing",
    description: "SEO for local firms.",
    offerings: ["SEO", "Google Ads"],
    competitorKeywords: ["seo agency"],
    positioningSummary: "Local SEO specialists.",
    categories: [],
    locations: [{ label: "Melbourne VIC", city: "Melbourne", isPrimary: true }],
    analyzedAt: now,
  },
  status: "completed",
  progress: {
    stage: "done",
    scannedAds: 120,
    scannedPages: 6,
    accepted: 1,
    target: 10,
    rejected: 9,
    message: "Found 1 competitor",
    rejectReasons: { inactive: 0, shortDuration: 2, noServiceSignal: 7, nonEnglish: 0, noLandingPage: 0, llmReject: 0, llmError: 0, lowActiveAds: 0, countError: 0 },
  },
  competitorIds: ["c1"],
  createdAt: now,
  updatedAt: now,
} as unknown as SearchJob;

const competitor = {
  id: "c1",
  runId: "run-1",
  pageId: "p1",
  pageName: "Rival SEO",
  country: "AU",
  platform: "facebook",
  activeAdsCount: 14,
  services: ["SEO"],
  sampleAd: { adArchiveId: "a1", title: "Rank higher", body: "Free SEO audit", daysRunning: 40, adLibraryUrl: "https://facebook.com/ads/library/?id=a1", landingPageUrl: "https://rival.example/seo" },
  brand: { website: "https://rival.example", brandScore: 62 },
  pageAnalysis: {
    status: "completed",
    analyzedUrl: "https://rival.example/seo",
    analyzedAt: now,
    offer: { headline: "Rank higher on Google", primaryOffer: "Free SEO audit", cta: "Get my audit", uniqueValueProps: ["No lock-in"] },
    pageArchitecture: { sections: [{ name: "Hero", purpose: "Offer", summary: "" }] },
  },
  recreatedPage: {
    status: "completed",
    createdAt: now,
    updatedAt: now,
    businessUrl: "https://client.example",
    businessName: "Client Co",
    keyword: "seo agency",
    sourceCompetitorName: "Rival SEO",
    sourceAnalyzedUrl: "https://rival.example/seo",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    publishReady: false,
    publishBlockers: ["Add real reviews."],
    differentiationNotes: "Built by Manus.",
  },
  createdAt: now,
} as unknown as CompetitorRecord;

test("the full report has a sheet per section of the run, from the website analysis to recreated pages", async () => {
  const buf = await buildFullReportWorkbook({
    job,
    competitors: [competitor],
    recreateOnly: [],
    offerAds: [],
    focus: null,
    origin: "https://app.example",
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const names = wb.worksheets.map((s) => s.name);
  // No offers dashboard yet: its sheets are left out.
  assert.deepEqual(names, ["Summary", "Your website", "Search", "Competitors", "Landing page analysis", "Recreated pages"]);

  const text = (sheet: string) =>
    wb
      .getWorksheet(sheet)!
      .getSheetValues()
      .flat()
      .map((v) => (v && typeof v === "object" && "text" in v ? String((v as { text: string }).text) : String(v ?? "")))
      .join(" | ");
  assert.match(text("Summary"), /Full report — Client Co/);
  assert.match(text("Summary"), /Not generated yet/);
  assert.match(text("Your website"), /Local SEO specialists\./);
  assert.match(text("Search"), /Ad copy not about the service: 7/);
  assert.match(text("Competitors"), /Rival SEO/);
  assert.match(text("Landing page analysis"), /Free SEO audit/);
  // Vendor names stay out of client files, and each recreated page links back to the app.
  assert.doesNotMatch(text("Recreated pages"), /Manus/);
  assert.match(text("Recreated pages"), /Open recreated page/);
  const open = wb.getWorksheet("Recreated pages")!.getRow(2).getCell(11).value as { hyperlink: string };
  assert.equal(open.hyperlink, "https://app.example/recreate/c1");
});

test("the landing page analysis sheet shows audience level and awareness stage, and leaves them empty without levels", async () => {
  const withLevels = {
    ...competitor,
    pageAnalysis: {
      ...competitor.pageAnalysis,
      levels: { audienceLevel: "newbie", awarenessStage: "problem_aware", awarenessFocus: "only_problem" },
    },
  } as unknown as CompetitorRecord;
  const unclear = {
    ...competitor,
    id: "c3",
    pageName: "Unclear Co",
    pageAnalysis: { ...competitor.pageAnalysis, levels: { audienceLevel: "unclear", awarenessStage: "unclear", awarenessFocus: null } },
  } as unknown as CompetitorRecord;
  const without = { ...competitor, id: "c2", pageName: "No Levels Co" } as unknown as CompetitorRecord;
  const buf = await buildFullReportWorkbook({
    job,
    competitors: [withLevels, without, unclear],
    recreateOnly: [],
    offerAds: [],
    focus: null,
    origin: "https://app.example",
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheet = wb.getWorksheet("Landing page analysis")!;
  const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
  const aud = headers.indexOf("Audience level");
  const stage = headers.indexOf("Awareness stage");
  assert.ok(aud > 0 && stage > 0, "both headers exist");
  assert.equal(headers.indexOf("Audience"), 12, "existing columns keep their place");
  const cell = (row: number, col: number) => String(sheet.getRow(row).getCell(col).value ?? "");
  assert.equal(cell(2, aud), "Newbie");
  assert.equal(cell(2, stage), "Problem aware (only problem)");
  assert.equal(cell(3, aud), "");
  assert.equal(cell(3, stage), "");
  assert.equal(cell(4, aud), "");
  assert.equal(cell(4, stage), "");
});

test("recreation versions are listed as recreated pages, not again as analysed pages", async () => {
  const dashboardPage = {
    ...competitor,
    id: "dash-1",
    pageName: "Dashboard Page",
    recreatedPage: null,
    recreateOnly: { source: "offers_dashboard" },
  } as unknown as CompetitorRecord;
  const version = {
    ...competitor,
    id: "c1-v2",
    pageName: "Rival SEO",
    recreateOnly: { source: "version", variantOf: "c1" },
  } as unknown as CompetitorRecord;
  const buf = await buildFullReportWorkbook({
    job,
    competitors: [competitor],
    recreateOnly: [dashboardPage, version],
    offerAds: [],
    focus: null,
    origin: "https://app.example",
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const names = (sheet: string) =>
    wb
      .getWorksheet(sheet)!
      .getColumn(1)
      .values.slice(2)
      .map((v) => String(v ?? ""));
  assert.deepEqual(
    names("Landing page analysis"),
    ["Rival SEO", "Dashboard Page (from offers dashboard)"],
    "a version is the same analysed page, so it is not a second analysis row",
  );
  const links = wb
    .getWorksheet("Recreated pages")!
    .getColumn(11)
    .values.slice(2)
    .map((v) => (v as { hyperlink: string }).hyperlink);
  assert.deepEqual(links, ["https://app.example/recreate/c1", "https://app.example/recreate/c1-v2"], "versions stay listed");
});
