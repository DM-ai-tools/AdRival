import type {
  BrandColors,
  BusinessProfile,
  CompetitorRecord,
  LandingContentBlock,
  LandingContentDocument,
  RecreatedLandingPage,
  SearchJob,
} from "../types";
import { getCompetitor, getJob, updateCompetitor, updateJob } from "../db";
import { randomUUID } from "node:crypto";
import { CONSTRUCT_RENDERER_VERSION, constructLandingPage, isStaleDesignWrite } from "./design/constructPage";
import { captureLayoutEvidence } from "./design/captureLayout";
import { alignLayoutEvidence, evidenceCoversSections } from "./design/layoutEvidence";
import { resolveBrandBundle } from "./resolveBrandBundle";
import { normalizeEditedContentDraft } from "./contentDraft";
import { syncDocumentIntoBlocks } from "./markdownContentDraft";
import {
  extractBrandLinksWithFirecrawl,
  mergeFirecrawlIntoBrandAssets,
} from "./firecrawlBrandLinks";
import {
  regenerateLandingImage,
  replaceGeneratedImageInHtml,
} from "./generateLandingImages";
import { extractBrandTokens } from "./archive/brandTokens";
import {
  buildBrandDesignSpec,
  serializeDesignMd,
  writeDesignMd,
} from "./designMd";
import { resolveBrandDisplayName } from "./brandDisplayName";
import { assertCanDraft, canonicalPageUrl, researchClientSite } from "./content/research";
import {
  competitorReferenceFromAnalysis,
  competitorReferenceFromInventory,
  draftInBatches,
  draftPrompt,
  completeWithEitherModel,
  draftFromProviderOutput,
} from "./content/generate";
import { captureRenderedInventory } from "./content/captureInventory";
import { collectStampedCidNodes } from "./archive/rewriteTextByCid";
import {
  hasUsableRenderedSource,
  inventoryFromAnalysisSummaries,
  inventoryFromCapturedNodes,
  sameCapturedPage,
} from "./content/inventory";
import { draftIsCurrent, inferPageIntent, reviseIntent, serviceTokens, withClientMatch } from "./content/pageIntent";
import { canonicalToDraft } from "./content/legacyDraft";
import type { CanonicalContent, ContentPack } from "./content/model";
import {
  acceptProposal,
  approveSnapshot,
  confirmClaim,
  ContentRevisionError,
  proposeSection,
  saveCanonical,
  stampDraft,
  undoCanonical,
} from "./content/revisions";
import {
  assertDesignFeedbackIsLayoutOnly,
  requireApprovedSnapshot,
} from "./content/designGate";

function resolveBusinessUrl(job: SearchJob): string | null {
  const fromJob = (job.businessUrl || "").trim();
  const fromProfile = (job.businessProfile?.url || "").trim();
  const url = fromJob || fromProfile;
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function setRecreationProgress(
  competitorId: string,
  page: RecreatedLandingPage,
  progress: { phase: string; message: string; pct: number },
): RecreatedLandingPage {
  const next: RecreatedLandingPage = {
    ...page,
    progress,
    updatedAt: new Date().toISOString(),
  };
  updateCompetitor(competitorId, { recreatedPage: next });
  return next;
}

function resolveContext(competitorId: string) {
  const competitor = getCompetitor(competitorId);
  if (!competitor) throw new Error("Competitor not found");

  if (competitor.pageAnalysis?.status !== "completed") {
    throw new Error(
      "Analyze the competitor landing page first (Get offer & page details).",
    );
  }

  const job = getJob(competitor.runId);
  if (!job) throw new Error("Search job not found for this competitor");

  const businessUrl = resolveBusinessUrl(job);
  if (!businessUrl) {
    throw new Error(
      "This search has no business website URL. Re-run search with a business URL so recreation can use your brand.",
    );
  }

  const keyword =
    job.keywords?.[0] ||
    job.keyword.split(",")[0]?.trim() ||
    job.keyword;

  const sourceUrl = competitor.pageAnalysis.analyzedUrl;
  const brandName = resolveBrandDisplayName({
    businessUrl,
    siteName: job.businessProfile?.brandAssets?.siteName,
    profileName: job.businessProfile?.businessName,
    competitorName: competitor.pageName,
  });

  return { competitor, job, businessUrl, keyword, sourceUrl, brandName };
}

function basePageFields(input: {
  competitor: CompetitorRecord;
  job: SearchJob;
  businessUrl: string;
  keyword: string;
  sourceUrl: string;
}): Omit<RecreatedLandingPage, "status" | "updatedAt" | "error"> {
  return {
    createdAt:
      input.competitor.recreatedPage?.createdAt || new Date().toISOString(),
    businessUrl: input.businessUrl,
    businessName: resolveBrandDisplayName({
      businessUrl: input.businessUrl,
      siteName: input.job.businessProfile?.brandAssets?.siteName,
      profileName: input.job.businessProfile?.businessName,
      competitorName: input.competitor.pageName,
    }),
    keyword: input.keyword,
    sourceCompetitorName: input.competitor.pageName,
    sourceAnalyzedUrl: input.sourceUrl,
    brandColors:
      input.job.businessProfile?.brandColors ||
      input.competitor.recreatedPage?.brandColors || {
        primary: "#0F7A6C",
        secondary: "#134E4A",
        accent: "#F59E0B",
        background: "#FFFFFF",
        text: "#0F172A",
        muted: "#64748B",
        source: "pending",
      },
    contentDraft: input.competitor.recreatedPage?.contentDraft || null,
    sourceArchive: input.competitor.recreatedPage?.sourceArchive || null,
    html: input.competitor.recreatedPage?.html || null,
    differentiationNotes:
      input.competitor.recreatedPage?.differentiationNotes || null,
    userFeedback: input.competitor.recreatedPage?.userFeedback || null,
  };
}

/**
 * Phase 1 — analyze structure + generate full content pack (OpenAI).
 * Does not build HTML yet; waits for user approval.
 */
export async function generateRecreationContent(
  competitorId: string,
  options?: { force?: boolean; userFeedback?: string },
): Promise<CompetitorRecord> {
  const ctx = resolveContext(competitorId);
  const userFeedback = (options?.userFeedback || "").trim().slice(0, 4000);
  const existing = ctx.competitor.recreatedPage;

  if (
    !options?.force &&
    !userFeedback &&
    existing?.contentPack &&
    !existing.contentPack.legacy &&
    existing.contentPack.canonical.sections.length > 0 &&
    existing.contentPack.evidence.canonicalUrl === canonicalPageUrl(ctx.businessUrl) &&
    draftIsCurrent(existing.contentPack)
  ) {
    const incomplete = existing.contentPack.canonical.sections.some(
      (section) => section.decision !== "omit" && !section.paragraphs.some((paragraph) => paragraph.trim()) && section.items.length === 0
        && !(section.fields || []).some((field) => field.disposition === "omit" || field.text.trim() || field.items.length),
    );
    if (!incomplete) return ctx.competitor;
  }

  let pending: RecreatedLandingPage = {
    ...basePageFields(ctx),
    status: "pending",
    updatedAt: new Date().toISOString(),
    html: options?.force ? null : existing?.html || null,
    contentDraft: {
      status: "pending",
      createdAt: existing?.contentDraft?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: "",
      blocks: [],
      userFeedback: userFeedback || null,
      error: null,
    },
    userFeedback: userFeedback || null,
    progress: {
      phase: "starting",
      message: "Starting content creation…",
      pct: 4,
    },
    error: null,
  };
  updateCompetitor(competitorId, { recreatedPage: pending });

  try {
    // Resolve brand colors + link inventory for content pack
    pending = setRecreationProgress(competitorId, pending, {
      phase: "brand",
      message: "Analyzing your brand colors & assets…",
      pct: 12,
    });
    let colors: BrandColors = pending.brandColors;
    let siteAssets = ctx.job.businessProfile?.brandAssets || null;
    const linkNotes: string[] = [];
    try {
      const brand = await resolveBrandBundle({
        businessUrl: ctx.businessUrl,
        profile: ctx.job.businessProfile || null,
      });
      colors = brand.colors;
      siteAssets = brand.assets || siteAssets;
    } catch {
      // keep pending colors / profile assets
    }

    // Firecrawl first: real nav / footer / social / service URLs (not homepage-collapsed)
    pending = setRecreationProgress(competitorId, pending, {
      phase: "links",
      message: "Collecting brand nav, footer & service links…",
      pct: 28,
    });
    let servicePages: Array<{ label: string; href: string }> = [];
    try {
      const pack = await extractBrandLinksWithFirecrawl(ctx.businessUrl);
      linkNotes.push(...pack.warnings);
      siteAssets = mergeFirecrawlIntoBrandAssets(
        siteAssets,
        pack,
        ctx.businessUrl,
      );
      servicePages = pack.servicePages;
      linkNotes.push(
        `Brand links: nav×${pack.navLinks.length}, footer×${pack.footerLinks.length}, social×${pack.socialLinks.length}, services×${pack.servicePages.length}`,
      );
    } catch (err) {
      linkNotes.push(
        `Brand link scrape skipped: ${(err as Error).message || String(err)}`,
      );
    }

    pending = setRecreationProgress(competitorId, pending, {
      phase: "research",
      message: "Reading the competitor page’s service before the client site…",
      pct: 36,
    });
    const analysisInventory = inventoryFromAnalysisSummaries({
      sourceUrl: ctx.sourceUrl,
      sections: ctx.competitor.pageAnalysis?.pageArchitecture?.sections || [],
    });
    let inventory = analysisInventory;
    try {
      const rendered = await captureRenderedInventory(ctx.sourceUrl);
      if (hasUsableRenderedSource(rendered)) inventory = rendered;
      else {
        inventory = {
          ...analysisInventory,
          gaps: [...analysisInventory.gaps, ...rendered.gaps, "Rendered capture did not produce usable page text."],
        };
      }
    } catch (err) {
      inventory = {
        ...analysisInventory,
        gaps: [...analysisInventory.gaps, `Rendered capture failed: ${(err as Error).message}`],
      };
    }
    if (!hasUsableRenderedSource(inventory) && existing?.sourceArchive?.html && sameCapturedPage(existing.sourceArchive.finalUrl, ctx.sourceUrl)) {
      const fromArchive = inventoryFromCapturedNodes({
        sourceUrl: ctx.sourceUrl,
        title: existing.sourceArchive.title,
        nodes: collectStampedCidNodes(existing.sourceArchive.html).nodes,
      });
      if (hasUsableRenderedSource(fromArchive)) inventory = fromArchive;
    }
    if (!hasUsableRenderedSource(inventory)) {
      const message = inventory.gaps.filter(Boolean).join(" ") || "Rendered competitor text was not captured.";
      const saved = updateCompetitor(competitorId, {
        recreatedPage: {
          ...pending,
          status: existing?.contentPack ? "content_ready" : "failed",
          error: `SOURCE_INCOMPLETE: ${message}`,
          contentPack: existing?.contentPack,
          contentDraft: existing?.contentDraft || pending.contentDraft,
          progress: {
            phase: "failed",
            message: "Source capture is incomplete. Retry capture. Generation was not run from the analysis summary.",
            pct: 40,
          },
          updatedAt: new Date().toISOString(),
        },
      });
      if (!saved) throw new Error("Failed to save the incomplete-capture state");
      return saved;
    }
    const competitorRef = inventory.sections.some((section) => section.textKind === "rendered")
      ? competitorReferenceFromInventory(inventory, ctx.competitor.pageName)
      : competitorReferenceFromAnalysis({
          name: ctx.competitor.pageName,
          url: ctx.sourceUrl,
          analysis: ctx.competitor.pageAnalysis!,
        });
    const pageIntent = inferPageIntent(competitorRef);
    if (!pageIntent.primaryService.trim()) {
      const saved = updateCompetitor(competitorId, {
        recreatedPage: {
          ...pending,
          status: existing?.contentPack ? "content_ready" : "failed",
          error: "SOURCE_INCOMPLETE: The captured page did not establish a service. Generation was not run from section-purpose labels.",
          contentPack: existing?.contentPack,
          contentDraft: existing?.contentDraft || pending.contentDraft,
          progress: {
            phase: "failed",
            message: "Service is unconfirmed. Correct the brief after a usable capture. No replacement draft was generated.",
            pct: 48,
          },
          updatedAt: new Date().toISOString(),
        },
      });
      if (!saved) throw new Error("Failed to save the unconfirmed-service state");
      return saved;
    }
    pending = setRecreationProgress(competitorId, pending, {
      phase: "research",
      message: `Looking for client evidence about ${pageIntent.primaryService}…`,
      pct: 48,
    });
    const evidence = await researchClientSite({
      enteredUrl: ctx.businessUrl,
      ownerUserId: ctx.job.ownerUserId || "unassigned",
      spaceId: ctx.job.spaceId || null,
      focusTerms: serviceTokens(pageIntent),
      knownBusinessName:
        ctx.job.businessProfile?.businessName ||
        pending.businessName ||
        null,
    });
    const intent = withClientMatch(pageIntent, evidence);
    assertCanDraft(evidence);
    pending = setRecreationProgress(competitorId, pending, {
      phase: "drafting",
      message: "Writing client copy one section at a time…",
      pct: 68,
    });
    const urlChanged = Boolean(
      existing?.contentPack && existing.contentPack.evidence.canonicalUrl !== canonicalPageUrl(ctx.businessUrl),
    );
    const briefChanged = !existing?.contentPack || !draftIsCurrent(existing.contentPack);
    const lockedIds = (existing?.contentPack?.canonical.sections || [])
      .filter((section) => section.locked && section.competitorSectionId)
      .map((section) => section.competitorSectionId as string);
    const doneIds = [...lockedIds, ...(urlChanged || options?.force || briefChanged
      ? []
      : (existing?.contentPack?.canonical.sections || [])
      .filter((section) =>
        section.competitorSectionId
        && section.decision !== "omit"
        && (section.paragraphs.some((paragraph) => paragraph.trim()) || section.items.length > 0)
        && !(section.fields || []).some((field) => field.disposition !== "omit" && !field.text.trim() && field.items.length === 0),
      )
      .map((section) => section.competitorSectionId as string))];
    const keepCompleted = (partial: CanonicalContent): CanonicalContent => {
      if (!existing?.contentPack || urlChanged) return partial;
      return {
        ...partial,
        sections: partial.sections.map((section) => {
          if (!section.competitorSectionId || !doneIds.includes(section.competitorSectionId)) return section;
          const prior = existing.contentPack?.canonical.sections.find((item) => item.id === section.id || item.competitorSectionId === section.competitorSectionId);
          return prior ? { ...prior, id: section.id } : section;
        }),
      };
    };
    const completion = await draftInBatches({
      evidence,
      competitor: competitorRef,
      skipCompetitorSectionIds: doneIds,
      feedback: userFeedback || null,
      intent,
      onSection: (partial) => {
        const current = getCompetitor(competitorId)?.recreatedPage;
        if (!current) return;
        updateCompetitor(competitorId, {
          recreatedPage: {
            ...current,
            contentPack: {
              evidence,
              competitor: competitorRef,
              canonical: keepCompleted(partial),
              approvedSnapshot: null,
              proposal: null,
              previous: existing?.contentPack?.canonical || null,
              inventory,
              intent,
              intentOutdated: false,
              legacy: false,
            },
            progress: { phase: "drafting", message: "Saving a completed section…", pct: 80 },
          },
        });
      },
    });
    const canonical = keepCompleted(completion.canonical);
    const contentPack: ContentPack = {
      evidence,
      competitor: competitorRef,
      canonical,
      approvedSnapshot: null,
      proposal: null,
      previous: existing?.contentPack?.canonical || null,
      inventory,
      intent,
      intentOutdated: false,
      legacy: false,
    };
    const draft = canonicalToDraft(canonical, completion.model);
    const critical = canonical.issues.filter((item) => item.severity === "critical").length;

    const ready: RecreatedLandingPage = {
      ...pending,
      status: "content_ready",
      updatedAt: new Date().toISOString(),
      brandColors: colors,
      contentDraft: draft,
      contentPack,
      sourceArchive: options?.force ? existing?.sourceArchive || null : existing?.sourceArchive || null,
      differentiationNotes: [
        critical
          ? `Content drafted with ${critical} critical evidence issue(s). Generation is not treated as successful until they are resolved.`
          : "Content drafted from client evidence. Competitor page supplied section purpose only.",
        servicePages.length ? `${servicePages.length} service destination(s) recorded.` : null,
        ...linkNotes.slice(0, 2),
      ].filter(Boolean).join(" "),
      userFeedback: userFeedback || null,
      progress: {
        phase: critical ? "needs_review" : "done",
        message: critical
          ? `${critical} critical issue(s) — review before approval`
          : "Content ready for review",
        pct: 100,
      },
      error: draft.error,
    };

    const updated = updateCompetitor(competitorId, { recreatedPage: ready });
    if (!updated) throw new Error("Failed to save content draft");
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateCompetitor(competitorId, {
      recreatedPage: {
        ...pending,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: message,
        progress: {
          phase: "failed",
          message,
          pct: progressPctSafe(pending.progress?.pct),
        },
        contentDraft: {
          status: "failed",
          createdAt: pending.contentDraft?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: pending.contentDraft?.model || "",
          blocks: [],
          error: message,
        },
      },
    });
    throw err;
  }
}

function progressPctSafe(pct?: number | null): number {
  return typeof pct === "number" && Number.isFinite(pct) ? pct : 0;
}

/** Persist manual edits. Saving does not confirm facts or call a model. */
export function saveRecreationContentEdits(
  competitorId: string,
  blocks: LandingContentBlock[],
  document?: LandingContentDocument | null,
  canonical?: CanonicalContent | null,
  expectedRevision?: number | null,
): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  if (!competitor?.recreatedPage) {
    throw new Error("No content draft to save. Generate content first.");
  }
  if (competitor.recreatedPage.contentPack && canonical && expectedRevision != null) {
    const pack = saveCanonical(competitor.recreatedPage.contentPack, canonical, expectedRevision);
    const draft = canonicalToDraft(pack.canonical, competitor.recreatedPage.contentDraft?.model || "edited");
    const updated = updateCompetitor(competitorId, {
      recreatedPage: {
        ...competitor.recreatedPage,
        status: "content_ready",
        updatedAt: new Date().toISOString(),
        contentPack: pack,
        contentDraft: { ...draft, createdAt: competitor.recreatedPage.contentDraft?.createdAt || draft.createdAt },
        error: draft.error,
      },
    });
    if (!updated) throw new Error("Failed to save content edits");
    return updated;
  }
  if (competitor.recreatedPage.contentPack) {
    throw new ContentRevisionError("Save the canonical content revision. The older block form is not the source of truth.");
  }
  if (!competitor.recreatedPage.contentDraft) {
    throw new Error("No content draft to save. Generate content first.");
  }

  let nextBlocks = blocks;
  let nextDocument =
    document ?? competitor.recreatedPage.contentDraft.document ?? null;
  if (document) {
    nextDocument = document;
    nextBlocks = syncDocumentIntoBlocks(
      document,
      blocks.length
        ? blocks
        : competitor.recreatedPage.contentDraft.blocks,
    );
  }

  const draft = normalizeEditedContentDraft(
    competitor.recreatedPage.contentDraft,
    nextBlocks,
  );
  draft.document = nextDocument;
  draft.status = "ready";
  draft.differentiationSummary =
    "Legacy draft. It is not evidence-checked and cannot be built until content is regenerated.";

  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage,
      status: "content_ready",
      updatedAt: new Date().toISOString(),
      contentDraft: draft,
      contentPack: {
        evidence: emptyLegacyEvidence(competitor.recreatedPage.businessUrl),
        competitor: {
          sourceUrl: competitor.recreatedPage.sourceAnalyzedUrl,
          retrievedAt: competitor.recreatedPage.createdAt,
          name: competitor.recreatedPage.sourceCompetitorName,
          host: "",
          sections: [],
        },
        canonical: {
          draftId: "",
          revision: 0,
          evidenceVersion: 0,
          clientUrl: competitor.recreatedPage.businessUrl,
          clientName: competitor.recreatedPage.businessName || "",
          competitorUrl: competitor.recreatedPage.sourceAnalyzedUrl,
          competitorName: competitor.recreatedPage.sourceCompetitorName,
          serviceContext: null,
          audienceContext: null,
          meta: { title: "", description: "" },
          sections: [],
          issues: [],
          approved: false,
          approvedAt: null,
          approvedRevision: null,
        },
        approvedSnapshot: null,
        proposal: null,
        previous: null,
        legacy: true,
      },
      error: null,
    },
  });
  if (!updated) throw new Error("Failed to save content edits");
  return updated;
}

function emptyLegacyEvidence(url: string): ContentPack["evidence"] {
  return {
    version: 0,
    ownerUserId: "",
    spaceId: null,
    enteredUrl: url,
    canonicalUrl: url,
    pageKind: "other",
    businessName: null,
    facts: [],
    pagesRead: [],
    unavailable: ["Legacy draft has no client evidence record."],
    retrievedAt: new Date().toISOString(),
    incomplete: true,
    missingEssential: ["regenerated client evidence"],
  };
}

export function updateRecreationIntent(
  competitorId: string,
  edit: { primaryService?: string; offerConcept?: string; confirmedTerms?: string[] },
  expectedRevision: number,
): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  const pack = competitor?.recreatedPage?.contentPack;
  if (!competitor?.recreatedPage || !pack?.intent) {
    throw new ContentRevisionError("Generate content before changing the service brief.");
  }
  if (expectedRevision !== pack.canonical.revision) {
    throw new ContentRevisionError("Reload the latest revision before changing the service brief.");
  }
  const intent = reviseIntent(pack.intent, edit);
  const canonical = stampDraft(
    { ...pack.canonical, revision: pack.canonical.revision + 1, approved: false, approvedAt: null, approvedRevision: null },
    pack.evidence,
    pack.competitor,
    intent,
  );
  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage,
      updatedAt: new Date().toISOString(),
      contentPack: { ...pack, intent, canonical, approvedSnapshot: null, intentOutdated: true, previous: pack.canonical },
    },
  });
  if (!updated) throw new Error("Failed to update the service brief");
  return updated;
}

/** Freeze the saved content revision for the later design stage. */
export function approveRecreationContent(
  competitorId: string,
  expectedRevision: number,
): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  const pack = competitor?.recreatedPage?.contentPack;
  if (!competitor?.recreatedPage || !pack) {
    throw new ContentRevisionError("Generate content from client evidence before approving.");
  }
  const next = approveSnapshot(pack, expectedRevision);
  const draft = canonicalToDraft(next.canonical, competitor.recreatedPage.contentDraft?.model || "approved");
  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage,
      status: "content_ready",
      updatedAt: new Date().toISOString(),
      contentPack: next,
      contentDraft: { ...draft, status: "approved", approvedAt: next.canonical.approvedAt },
      error: null,
    },
  });
  if (!updated) throw new Error("Failed to approve content");
  return updated;
}

export async function regenerateContentSection(
  competitorId: string,
  sectionId: string,
  feedback: string,
  expectedRevision: number,
): Promise<CompetitorRecord> {
  const competitor = getCompetitor(competitorId);
  const pack = competitor?.recreatedPage?.contentPack;
  if (!competitor?.recreatedPage || !pack || pack.legacy) {
    throw new ContentRevisionError("Regenerate the full draft before regenerating a section.");
  }
  if (expectedRevision !== pack.canonical.revision) {
    throw new ContentRevisionError("A newer edit landed. Reload before regenerating this section.");
  }
  const current = pack.canonical.sections.find((section) => section.id === sectionId);
  if (!current) throw new ContentRevisionError("That section is not on this page.");
  if (current.locked) throw new ContentRevisionError("That section is locked. Unlock it before regenerating.");
  const completion = await completeWithEitherModel(
    draftPrompt({
      evidence: pack.evidence,
      competitor: pack.competitor,
      intent: pack.intent,
      feedback: `Rewrite only competitor section ${current.competitorSectionId}. Keep the locked service ${pack.intent?.primaryService || pack.canonical.serviceContext || ""}. ${feedback}`,
    }),
  );
  const fresh = getCompetitor(competitorId)?.recreatedPage?.contentPack;
  if (!fresh || fresh.canonical.revision !== expectedRevision) {
    throw new ContentRevisionError(
      "A newer edit landed while this section was regenerating. The proposal was not applied.",
    );
  }
  const drafted = draftFromProviderOutput({
    raw: completion.raw,
    evidence: fresh.evidence,
    competitor: fresh.competitor,
    modelName: completion.model,
    intent: fresh.intent,
  });
  const replacement = drafted.sections.find((section) => section.competitorSectionId === current.competitorSectionId);
  if (!replacement) {
    throw new ContentRevisionError("The model did not return this section. Other sections were left unchanged.");
  }
  const proposed = proposeSection(fresh, {
    sectionId,
    basedOnRevision: expectedRevision,
    section: { ...replacement, id: current.id, locked: false },
  });
  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage,
      contentPack: proposed,
      updatedAt: new Date().toISOString(),
    },
  });
  if (!updated) throw new Error("Failed to store the section proposal");
  return updated;
}

export function acceptContentProposal(competitorId: string): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  const pack = competitor?.recreatedPage?.contentPack;
  if (!pack) throw new ContentRevisionError("There is no proposed section to accept.");
  const next = acceptProposal(pack);
  const draft = canonicalToDraft(next.canonical, competitor.recreatedPage?.contentDraft?.model || "edited");
  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage!,
      contentPack: next,
      contentDraft: draft,
      updatedAt: new Date().toISOString(),
      error: draft.error,
    },
  });
  if (!updated) throw new Error("Failed to accept the section");
  return updated;
}

export function discardContentProposal(competitorId: string): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  const pack = competitor?.recreatedPage?.contentPack;
  if (!pack) throw new ContentRevisionError("There is no proposal to discard.");
  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage!,
      contentPack: { ...pack, proposal: null },
      updatedAt: new Date().toISOString(),
    },
  });
  if (!updated) throw new Error("Failed to discard the proposal");
  return updated;
}

export function confirmContentClaim(
  competitorId: string,
  sectionId: string,
  value: string,
  confirmedBy: string,
): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  const pack = competitor?.recreatedPage?.contentPack;
  if (!pack) throw new ContentRevisionError("Generate content before confirming a claim.");
  const next = confirmClaim(pack, { sectionId, value, confirmedBy });
  const draft = canonicalToDraft(next.canonical, competitor.recreatedPage?.contentDraft?.model || "edited");
  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage!,
      contentPack: next,
      contentDraft: draft,
      updatedAt: new Date().toISOString(),
    },
  });
  if (!updated) throw new Error("Failed to record the confirmation");
  return updated;
}

export function undoContentRevision(competitorId: string, expectedRevision: number): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  const pack = competitor?.recreatedPage?.contentPack;
  if (!pack) throw new ContentRevisionError("There is no revision to undo.");
  const next = undoCanonical(pack, expectedRevision);
  const draft = canonicalToDraft(next.canonical, competitor.recreatedPage?.contentDraft?.model || "edited");
  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage!,
      contentPack: next,
      contentDraft: draft,
      updatedAt: new Date().toISOString(),
      error: draft.error,
    },
  });
  if (!updated) throw new Error("Failed to undo");
  return updated;
}

class StaleDesignBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleDesignBuildError";
  }
}

/**
 * Design stage — construct a new page from the approved revision.
 * Competitor HTML is reference only and is not the output shell.
 */
export async function buildRecreationDesign(
  competitorId: string,
  options?: {
    userFeedback?: string;
  },
): Promise<CompetitorRecord> {
  const ctx = resolveContext(competitorId);
  const existing = ctx.competitor.recreatedPage;
  const snapshot = requireApprovedSnapshot(existing?.contentPack?.approvedSnapshot);
  const competitorRef = existing?.contentPack?.competitor;
  if (!existing?.contentPack || !competitorRef) {
    throw new Error("Approve a content revision before building a design.");
  }
  if (
    existing.contentPack.intent?.usingSummaryOnly
    || (existing.contentPack.intent && !existing.contentPack.intent.primaryService.trim())
    || competitorRef.sections.every((section) => section.textKind !== "source")
  ) {
    throw new Error("Design is blocked because the competitor page was not captured. Retry capture and approve a revision from that source.");
  }
  const userFeedback = (options?.userFeedback || "").trim().slice(0, 4000);
  assertDesignFeedbackIsLayoutOnly(userFeedback);
  const draft = canonicalToDraft(snapshot, existing.contentDraft?.model || "approved");
  const previousHtml = existing.html || null;
  const previousStatus = existing.status;
  const buildToken = randomUUID();
  const fontFamily = ctx.job.businessProfile?.brandDesign?.typography?.fontFamilies?.heading
    || ctx.job.businessProfile?.brandDesign?.fonts?.[0]
    || null;
  const bodyFont = ctx.job.businessProfile?.brandDesign?.typography?.fontFamilies?.primary
    || fontFamily;
  const radius = ctx.job.businessProfile?.brandDesign?.components?.buttonPrimary?.borderRadius
    || ctx.job.businessProfile?.brandDesign?.spacing?.borderRadius
    || null;

  const pending: RecreatedLandingPage = {
    ...existing,
    status: "design_pending",
    updatedAt: new Date().toISOString(),
    html: previousHtml,
    userFeedback: userFeedback || existing.userFeedback || null,
    designBuildId: buildToken,
    designRendererVersion: CONSTRUCT_RENDERER_VERSION,
    progress: {
      phase: "design",
      message: "Constructing a new page from the approved revision…",
      pct: 20,
    },
    error: null,
  };
  updateCompetitor(competitorId, { recreatedPage: pending });

  try {
    const includedIds = snapshot.sections
      .filter((section) => section.decision !== "omit" && section.decision !== "needs_input")
      .map((section) => section.competitorSectionId)
      .filter((id): id is string => Boolean(id));
    let layoutEvidence = existing.contentPack.inventory?.layout || null;
    if (!evidenceCoversSections(layoutEvidence, includedIds)) {
      const measured = await captureLayoutEvidence(competitorRef.sourceUrl);
      const hints = [
        ...(existing.contentPack.inventory?.sections || []).map((section) => ({
          id: section.id,
          heading: section.sourceHeading,
        })),
        ...competitorRef.sections.map((section) => ({ id: section.id, heading: section.heading })),
      ];
      layoutEvidence = alignLayoutEvidence(measured, includedIds, hints);
      if (existing.contentPack.inventory) {
        existing.contentPack.inventory = { ...existing.contentPack.inventory, layout: layoutEvidence };
      }
    }
    if (!layoutEvidence || layoutEvidence.incomplete || layoutEvidence.sections.length === 0) {
      const reason = layoutEvidence?.gaps?.slice(-3).join(" ") || "No visual bands were measured.";
      throw new Error(`Design is blocked because the competitor layout was not measured. ${reason}`);
    }
    const constructed = await constructLandingPage({
      snapshot,
      competitor: competitorRef,
      inventory: existing.contentPack.inventory,
      layoutEvidence,
      colors: ctx.job.businessProfile?.brandColors || existing.brandColors,
      assets: ctx.job.businessProfile?.brandAssets || null,
      competitorId,
      keyword: existing.contentPack.intent?.primaryService || ctx.keyword || snapshot.serviceContext || "",
      previousImages: existing.generatedImages || [],
      fontFamily,
      bodyFont,
      radius,
      browserValidate: true,
    });
    if (constructed.blockers.length && !constructed.html) {
      const ready = constructed.images.filter((image) => image.slotState === "ready" || image.slotState === "reused");
      const kept = (existing.generatedImages || []).filter((image) => !ready.some((next) => next.id === image.id));
      const current = getCompetitor(competitorId);
      if (!isStaleDesignWrite(current?.recreatedPage?.designBuildId, buildToken)) {
        updateCompetitor(competitorId, {
          recreatedPage: {
            ...existing,
            status: previousHtml ? previousStatus : "failed",
            html: previousHtml,
            generatedImages: [...kept, ...ready],
            contentPack: existing.contentPack,
            error: `Design construction blocked. The last successful design was kept. ${constructed.blockers.slice(0, 6).join(" ")}`,
            updatedAt: new Date().toISOString(),
            progress: { phase: "failed", message: "Design was not exported.", pct: 0 },
          },
        });
      }
      throw new Error(
        `Design construction blocked. The last successful design was kept. ${constructed.blockers.slice(0, 8).join(" ")}`,
      );
    }
    if (constructed.blockers.length && constructed.html) {
      const current = getCompetitor(competitorId);
      if (isStaleDesignWrite(current?.recreatedPage?.designBuildId, buildToken)) {
        throw new StaleDesignBuildError("A newer design build replaced this one. This result was discarded.");
      }
      const preview = updateCompetitor(competitorId, {
        recreatedPage: {
          ...pending,
          status: "completed",
          updatedAt: new Date().toISOString(),
          html: constructed.html,
          generatedImages: constructed.images,
          contentPack: existing.contentPack,
          differentiationNotes: constructed.notes.join(" "),
          designBuildId: buildToken,
          designRendererVersion: CONSTRUCT_RENDERER_VERSION,
          publishReady: false,
          publishBlockers: constructed.blockers,
          error: null,
          progress: { phase: "done", message: "Preview ready. Export is blocked until the listed issues are resolved.", pct: 100 },
        },
      });
      if (!preview) throw new Error("Failed to save design preview");
      return preview;
    }
    const html = constructed.html;
    const completed: RecreatedLandingPage = {
      ...pending,
      status: "completed",
      updatedAt: new Date().toISOString(),
      brandColors: ctx.job.businessProfile?.brandColors || existing.brandColors,
      contentDraft: {
        ...draft,
        status: "approved",
        approvedAt: snapshot.approvedAt,
        cidCoverage: null,
        unmatchedCidCount: null,
      },
      contentPack: existing.contentPack,
      sourceArchive: existing.sourceArchive || null,
      html,
      generatedImages: constructed.images,
      differentiationNotes: `Constructed page from approved revision ${snapshot.approvedRevision}. ${constructed.notes.join(" ")}`,
      designMd: existing.designMd || null,
      designContentRevision: snapshot.approvedRevision,
      designBuildId: buildToken,
      designRendererVersion: CONSTRUCT_RENDERER_VERSION,
      publishReady: true,
      publishBlockers: [],
      progress: { phase: "done", message: "Design complete", pct: 100 },
      error: null,
    };
    const current = getCompetitor(competitorId);
    if (isStaleDesignWrite(current?.recreatedPage?.designBuildId, buildToken)) {
      throw new StaleDesignBuildError("A newer design build replaced this one. This result was discarded.");
    }
    const updated = updateCompetitor(competitorId, { recreatedPage: completed });
    if (!updated) throw new Error("Failed to save recreated page");
    return updated;
  } catch (err) {
    if (err instanceof StaleDesignBuildError) throw err;
    const current = getCompetitor(competitorId);
    if (isStaleDesignWrite(current?.recreatedPage?.designBuildId, buildToken)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    updateCompetitor(competitorId, {
      recreatedPage: {
        ...existing,
        status: previousHtml ? previousStatus : "failed",
        html: previousHtml,
        updatedAt: new Date().toISOString(),
        error: message,
        progress: { phase: "failed", message, pct: 0 },
      },
    });
    throw err;
  }
}

/**
 * Regenerate a single Runway image and swap it into the stored HTML in place.
 */
export async function regenerateGeneratedImageForRecreation(
  competitorId: string,
  imageId: string,
  feedback?: string,
): Promise<CompetitorRecord> {
  const ctx = resolveContext(competitorId);
  const page = ctx.competitor.recreatedPage;
  if (!page?.html) {
    throw new Error("No completed design to update");
  }
  const images = page.generatedImages || [];
  const existing = images.find((img) => img.id === imageId);
  if (!existing) {
    throw new Error(`Generated image "${imageId}" not found`);
  }

  const nextImage = await regenerateLandingImage({
    image: existing,
    competitorId,
    feedback: feedback || null,
    logoUrl:
      (ctx.job as { businessProfile?: { brandAssets?: { logoUrl?: string } } })
        .businessProfile?.brandAssets?.logoUrl || null,
  });
  const html = replaceGeneratedImageInHtml(page.html, nextImage);
  const nextImages = images.map((img) =>
    img.id === imageId ? nextImage : img,
  );

  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...page,
      html,
      generatedImages: nextImages,
      updatedAt: new Date().toISOString(),
    },
  });
  if (!updated) throw new Error("Failed to save regenerated image");
  return updated;
}

/**
 * Re-run Firecrawl branding for the job's business URL and store the latest
 * colors / assets / design tokens on the job profile + recreated page.
 * Does not rebuild HTML — call buildRecreationDesign afterward to apply.
 */
export async function refreshBrandColorsForRecreation(
  competitorId: string,
): Promise<{
  competitor: CompetitorRecord;
  warnings: string[];
}> {
  const ctx = resolveContext(competitorId);
  const brand = await resolveBrandBundle({
    businessUrl: ctx.businessUrl,
    profile: ctx.job.businessProfile || null,
  });

  const nextProfile: BusinessProfile = {
    ...(ctx.job.businessProfile || {
      url: ctx.businessUrl,
      businessName: ctx.brandName,
      industry: "",
      description: "",
      offerings: [],
      competitorKeywords: [],
      positioningSummary: "",
    }),
    url: ctx.job.businessProfile?.url || ctx.businessUrl,
    brandColors: brand.colors,
    brandAssets: brand.assets || ctx.job.businessProfile?.brandAssets || null,
    brandDesign: brand.design || ctx.job.businessProfile?.brandDesign || null,
    analyzedAt: new Date().toISOString(),
  };

  updateJob(ctx.job.id, {
    businessProfile: nextProfile,
    businessUrl: ctx.job.businessUrl || brand.finalUrl || ctx.businessUrl,
  });

  let designMd: string | null = null;
  try {
    const tokens = await extractBrandTokens({
      businessUrl: brand.finalUrl || ctx.businessUrl,
      profileName: ctx.brandName,
      profile: nextProfile,
      preferredColors: brand.colors,
    });
    const spec = buildBrandDesignSpec({
      tokens,
      brandName: ctx.brandName,
      businessUrl: brand.finalUrl || ctx.businessUrl,
      competitorName: ctx.competitor.pageName,
    });
    designMd = serializeDesignMd(spec);
    writeDesignMd(competitorId, designMd);
  } catch (err) {
    console.warn("[refreshBrandColors] design.md generation failed", err);
  }

  const existing = ctx.competitor.recreatedPage;
  const nextPage: RecreatedLandingPage = existing
    ? {
        ...existing,
        brandColors: brand.colors,
        businessUrl: brand.finalUrl || existing.businessUrl || ctx.businessUrl,
        businessName:
          nextProfile.businessName || existing.businessName || ctx.brandName,
        designMd: designMd || existing.designMd || null,
        updatedAt: new Date().toISOString(),
      }
    : {
        ...basePageFields({
          competitor: ctx.competitor,
          job: { ...ctx.job, businessProfile: nextProfile },
          businessUrl: brand.finalUrl || ctx.businessUrl,
          keyword: ctx.keyword,
          sourceUrl: ctx.sourceUrl,
        }),
        status: "content_ready",
        updatedAt: new Date().toISOString(),
        brandColors: brand.colors,
        designMd,
        error: null,
      };

  const updated = updateCompetitor(competitorId, { recreatedPage: nextPage });
  if (!updated) throw new Error("Failed to save refreshed brand colors");

  return { competitor: updated, warnings: brand.warnings };
}

/**
 * @deprecated Prefer generateRecreationContent + buildRecreationDesign.
 * Kept for callers that still expect a one-shot path — now starts at content phase.
 */
export async function recreateCompetitorLandingPage(
  competitorId: string,
  options?: { force?: boolean; userFeedback?: string },
): Promise<CompetitorRecord> {
  return generateRecreationContent(competitorId, options);
}
