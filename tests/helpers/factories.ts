import { createUser, saveCompetitor, saveJob, saveLookupJob } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { initializeUserCredits } from "@/lib/accounting/service";
import { creditsToSubunits } from "@/lib/accounting/units";
import type {
  AppUser,
  CompetitorRecord,
  LookupJob,
  SearchJob,
  UserRole,
} from "@/lib/types";

let seq = 0;

export async function makeUser(options?: {
  username?: string;
  role?: UserRole;
  credits?: number;
  password?: string;
  status?: "active" | "suspended";
}): Promise<AppUser> {
  seq += 1;
  const username = options?.username ?? `user${seq}_${Date.now() % 100000}`;
  const user = createUser({
    username,
    displayName: username,
    passwordHash: await hashPassword(options?.password ?? "correct-horse-battery"),
    role: options?.role ?? "user",
    status: options?.status ?? "active",
  });
  initializeUserCredits(user.id, {
    allowanceSubunits: creditsToSubunits(options?.credits ?? 0),
    resetCadence: "none",
    reason: "test fixture",
  });
  return user;
}

export function makeSearchProject(options?: {
  id?: string;
  ownerUserId?: string | null;
  keyword?: string;
}): SearchJob {
  seq += 1;
  const now = new Date().toISOString();
  const job: SearchJob = {
    id: options?.id ?? `search-${seq}-${Date.now()}`,
    keyword: options?.keyword ?? `keyword ${seq}`,
    keywords: [options?.keyword ?? `keyword ${seq}`],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: {
      stage: "done",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: 0,
      rejected: 0,
      message: "test fixture",
    },
    competitorIds: [],
    ownerUserId: options?.ownerUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  saveJob(job);
  return job;
}

/** A competitor row belonging to a search run, so routes that look one up work. */
export function makeCompetitor(options: {
  runId: string;
  id?: string;
  pageName?: string;
}): CompetitorRecord {
  seq += 1;
  const competitor: CompetitorRecord = {
    id: options.id ?? `competitor-${seq}-${Date.now()}`,
    runId: options.runId,
    pageId: `page-${seq}`,
    pageName: options.pageName ?? `Competitor ${seq}`,
    country: "AU",
    platform: "facebook",
    activeAdsCount: 7,
    services: [],
    sampleAd: {
      adArchiveId: `ad-${seq}`,
      title: "Sample ad",
      body: "Sample ad body",
      daysRunning: -1,
      adLibraryUrl: "https://example.invalid/ad",
      landingPageUrl: "https://example.invalid/landing",
    },
    brand: { website: "https://example.invalid" },
    createdAt: new Date().toISOString(),
  };
  saveCompetitor(competitor);
  return competitor;
}

export function makeLookupProject(options?: {
  id?: string;
  ownerUserId?: string | null;
  queryName?: string;
}): LookupJob {
  seq += 1;
  const now = new Date().toISOString();
  const job: LookupJob = {
    id: options?.id ?? `lookup-${seq}-${Date.now()}`,
    queryName: options?.queryName ?? `brand ${seq}`,
    platform: "facebook",
    status: "completed",
    progress: {
      stage: "done",
      message: "test fixture",
      candidatesFound: 0,
      adsFetched: 0,
      pagesScanned: 0,
    },
    candidates: [],
    adIds: [],
    ownerUserId: options?.ownerUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  saveLookupJob(job);
  return job;
}
