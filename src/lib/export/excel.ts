import ExcelJS from "exceljs";
import type { CompetitorRecord, SearchJob } from "../types";

export async function buildCompetitorsWorkbook(
  job: SearchJob,
  competitors: CompetitorRecord[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Competitor Finder";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Competitors");
  sheet.columns = [
    { header: "Company", key: "pageName", width: 28 },
    { header: "Platform", key: "platform", width: 12 },
    { header: "Country", key: "country", width: 10 },
    { header: "Page ID", key: "pageId", width: 20 },
    { header: "Active Ads", key: "activeAdsCount", width: 12 },
    { header: "Services", key: "services", width: 28 },
    { header: "Sample Ad Title", key: "adTitle", width: 32 },
    { header: "Sample Ad Body", key: "adBody", width: 48 },
    { header: "CTA", key: "ctaText", width: 18 },
    { header: "Landing Page URL", key: "landingPageUrl", width: 42 },
    { header: "Format / Ad Type", key: "format", width: 18 },
    { header: "Domain / Visible URL", key: "domain", width: 24 },
    { header: "YouTube URL", key: "youtubeUrl", width: 36 },
    { header: "Impressions", key: "impressions", width: 14 },
    { header: "Start Date", key: "startDate", width: 16 },
    { header: "End Date", key: "endDate", width: 16 },
    { header: "Days Running", key: "daysRunning", width: 14 },
    { header: "Ad Library URL", key: "adLibraryUrl", width: 40 },
    { header: "Advertiser Page", key: "advertiserPageUrl", width: 36 },
    { header: "Facebook URL", key: "facebookUrl", width: 36 },
    { header: "FB Followers", key: "facebookFollowers", width: 14 },
    { header: "FB Likes", key: "facebookLikes", width: 12 },
    { header: "Instagram", key: "instagramHandle", width: 18 },
    { header: "IG Followers", key: "instagramFollowers", width: 14 },
    { header: "Twitter/X", key: "twitterHandle", width: 16 },
    { header: "X Followers", key: "twitterFollowers", width: 12 },
    { header: "YouTube", key: "youtubeHandle", width: 18 },
    { header: "YT Subscribers", key: "youtubeSubscribers", width: 14 },
    { header: "LinkedIn URL", key: "linkedinUrl", width: 36 },
    { header: "LI Employees", key: "linkedinEmployees", width: 14 },
    { header: "LI Followers", key: "linkedinFollowers", width: 14 },
    { header: "Website", key: "website", width: 28 },
    { header: "Category", key: "category", width: 22 },
  ];

  sheet.getRow(1).font = { bold: true };

  for (const c of competitors) {
    const days =
      c.sampleAd.daysRunning >= 0 ? c.sampleAd.daysRunning : "";
    sheet.addRow({
      pageName: c.pageName,
      platform: c.platform ?? "",
      country: c.country ?? "",
      pageId: c.pageId,
      activeAdsCount: c.activeAdsCount,
      services: c.services.join(", "),
      adTitle: c.sampleAd.title,
      adBody: c.sampleAd.body,
      ctaText: c.sampleAd.ctaText ?? "",
      landingPageUrl: c.sampleAd.landingPageUrl ?? "",
      format: c.sampleAd.format ?? "",
      domain: c.sampleAd.domain || c.sampleAd.visibleUrl || "",
      youtubeUrl: c.sampleAd.youtubeUrl ?? "",
      impressions: c.sampleAd.impressions ?? "",
      startDate: c.sampleAd.startDate ?? "",
      endDate: c.sampleAd.endDate ?? "",
      daysRunning: days,
      adLibraryUrl: c.sampleAd.adLibraryUrl,
      advertiserPageUrl: c.sampleAd.advertiserPageUrl ?? "",
      facebookUrl: c.brand.facebookUrl ?? "",
      facebookFollowers: c.brand.facebookFollowers ?? "",
      facebookLikes: c.brand.facebookLikes ?? "",
      instagramHandle: c.brand.instagramHandle ?? "",
      instagramFollowers: c.brand.instagramFollowers ?? "",
      twitterHandle: c.brand.twitterHandle ?? "",
      twitterFollowers: c.brand.twitterFollowers ?? "",
      youtubeHandle: c.brand.youtubeHandle ?? c.brand.youtubeUrl ?? "",
      youtubeSubscribers: c.brand.youtubeSubscribers ?? "",
      linkedinUrl: c.brand.linkedinUrl ?? "",
      linkedinEmployees: c.brand.linkedinEmployees ?? "",
      linkedinFollowers: c.brand.linkedinFollowers ?? "",
      website: c.brand.website ?? "",
      category: c.brand.category ?? "",
    });
  }

  const meta = wb.addWorksheet("Run Meta");
  meta.columns = [
    { header: "Field", key: "field", width: 24 },
    { header: "Value", key: "value", width: 60 },
  ];
  meta.addRows([
    { field: "Run ID", value: job.id },
    { field: "Keyword", value: job.keyword },
    { field: "Status", value: job.status },
    { field: "Accepted", value: job.progress.accepted },
    { field: "Scanned Ads", value: job.progress.scannedAds },
    { field: "Scanned Pages", value: job.progress.scannedPages },
    { field: "Rejected", value: job.progress.rejected },
    { field: "Created", value: job.createdAt },
    { field: "Updated", value: job.updatedAt },
    { field: "Message", value: job.progress.message },
  ]);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
