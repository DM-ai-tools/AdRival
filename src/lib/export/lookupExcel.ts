import ExcelJS from "exceljs";
import type { LookupAdRecord, LookupJob } from "../types";

function flattenRaw(raw: Record<string, unknown>, prefix = ""): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v == null) {
      out[key] = "";
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    } else if (typeof v === "object") {
      // Keep nested objects as JSON strings for Excel cells
      out[key] = JSON.stringify(v);
    }
  }
  return out;
}

export async function buildLookupWorkbook(
  job: LookupJob,
  ads: LookupAdRecord[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Competitor Finder — Lookup";
  wb.created = new Date();

  const meta = wb.addWorksheet("Lookup Meta");
  meta.columns = [
    { header: "Field", key: "field", width: 28 },
    { header: "Value", key: "value", width: 70 },
  ];
  meta.getRow(1).font = { bold: true };
  meta.addRows([
    { field: "Platform", value: job.platform ?? "" },
    { field: "Lookup ID", value: job.id },
    { field: "Query name", value: job.queryName },
    { field: "Status", value: job.status },
    { field: "Matched page", value: job.selectedPage?.name ?? "" },
    { field: "Page ID", value: job.selectedPage?.pageId ?? "" },
    { field: "Category", value: job.selectedPage?.category ?? "" },
    { field: "Page likes", value: job.selectedPage?.likes ?? "" },
    { field: "IG handle", value: job.selectedPage?.igUsername ?? "" },
    { field: "LLM confidence", value: job.llmConfidence ?? "" },
    { field: "LLM reason", value: job.llmReason ?? "" },
    { field: "Ads fetched", value: job.progress.adsFetched },
    { field: "Created", value: job.createdAt },
    { field: "Updated", value: job.updatedAt },
  ]);

  const candidates = wb.addWorksheet("Candidates");
  candidates.columns = [
    { header: "Selected", key: "selected", width: 10 },
    { header: "Page name", key: "name", width: 28 },
    { header: "Page ID", key: "pageId", width: 20 },
    { header: "Category", key: "category", width: 22 },
    { header: "Likes", key: "likes", width: 12 },
    { header: "Verification", key: "verification", width: 16 },
    { header: "IG", key: "ig", width: 18 },
    { header: "Alias", key: "alias", width: 18 },
  ];
  candidates.getRow(1).font = { bold: true };
  for (const c of job.candidates) {
    candidates.addRow({
      selected: job.selectedPage?.pageId === c.pageId ? "YES" : "",
      name: c.name,
      pageId: c.pageId,
      category: c.category ?? "",
      likes: c.likes ?? "",
      verification: c.verification ?? "",
      ig: c.igUsername ?? "",
      alias: c.pageAlias ?? "",
    });
  }

  const sheet = wb.addWorksheet("Ads");
  sheet.columns = [
    { header: "Ad Archive ID", key: "adArchiveId", width: 20 },
    { header: "Page name", key: "pageName", width: 24 },
    { header: "Country", key: "country", width: 10 },
    { header: "Active", key: "isActive", width: 10 },
    { header: "Title", key: "title", width: 32 },
    { header: "Body", key: "body", width: 48 },
    { header: "CTA", key: "ctaText", width: 16 },
    { header: "Landing page", key: "landingPageUrl", width: 40 },
    { header: "Format / Ad Type", key: "format", width: 18 },
    { header: "Domain", key: "domain", width: 22 },
    { header: "YouTube URL", key: "youtubeUrl", width: 36 },
    { header: "Impressions", key: "impressions", width: 14 },
    { header: "Days Running", key: "daysRunning", width: 12 },
    { header: "Start", key: "startDateString", width: 16 },
    { header: "End", key: "endDateString", width: 16 },
    { header: "Advertiser Page", key: "advertiserPageUrl", width: 36 },
    { header: "Ad Library URL", key: "adLibraryUrl", width: 40 },
    { header: "Raw JSON", key: "rawJson", width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const ad of ads) {
    sheet.addRow({
      adArchiveId: ad.adArchiveId,
      pageName: ad.pageName,
      country: ad.country,
      isActive: ad.isActive ? "YES" : "NO",
      title: ad.title,
      body: ad.body,
      ctaText: ad.ctaText ?? "",
      landingPageUrl: ad.landingPageUrl ?? "",
      format: ad.format ?? "",
      domain: ad.domain || ad.visibleUrl || "",
      youtubeUrl: ad.youtubeUrl ?? "",
      impressions: ad.impressions ?? "",
      daysRunning: ad.daysRunning != null && ad.daysRunning >= 0 ? ad.daysRunning : "",
      startDateString: ad.startDateString ?? "",
      endDateString: ad.endDateString ?? "",
      advertiserPageUrl: ad.advertiserPageUrl ?? "",
      adLibraryUrl: ad.adLibraryUrl,
      rawJson: JSON.stringify(ad.raw),
    });
  }

  const flat = wb.addWorksheet("Ads Flattened");
  const allKeys = new Set<string>([
    "adArchiveId",
    "country",
    "isActive",
    "title",
    "body",
    "ctaText",
    "landingPageUrl",
    "adLibraryUrl",
  ]);
  for (const ad of ads) {
    for (const k of Object.keys(flattenRaw(ad.raw))) allKeys.add(k);
  }
  const keys = Array.from(allKeys);
  flat.columns = keys.map((k) => ({ header: k, key: k, width: 18 }));
  flat.getRow(1).font = { bold: true };
  for (const ad of ads) {
    flat.addRow({
      adArchiveId: ad.adArchiveId,
      country: ad.country,
      isActive: ad.isActive,
      title: ad.title,
      body: ad.body,
      ctaText: ad.ctaText ?? "",
      landingPageUrl: ad.landingPageUrl ?? "",
      adLibraryUrl: ad.adLibraryUrl,
      ...flattenRaw(ad.raw),
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
