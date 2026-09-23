/**
 * Industry SOPs used by the guardrail agent.
 * Heuristic patterns are intentionally strict and cheap so most rejects
 * never need an LLM round-trip.
 */

export type IndustrySopId =
  | "digital_marketing_agency"
  | "saas_b2b"
  | "ecommerce"
  | "local_services"
  | "professional_services"
  | "healthcare"
  | "real_estate"
  | "education"
  | "finance"
  | "hospitality"
  | "general";

export interface IndustrySop {
  id: IndustrySopId;
  label: string;
  /** Substrings matched against industry / offerings / description */
  matchTerms: string[];
  /** What a valid competitor looks like */
  includeCompetitorTypes: string[];
  /** Competitor types to reject */
  excludeCompetitorTypes: string[];
  /** Offer / ladder types to reject */
  excludeOfferTypes: string[];
  /** Cheap ad-copy / name reject patterns (case-insensitive) */
  competitorRejectPatterns: string[];
  /** Cheap offer-ladder reject patterns */
  offerRejectPatterns: string[];
  /** Soft guidance for optional LLM borderline checks */
  llmGuidance: string;
}

export function detectAgencySopRejectReason(text: string): string | null {
  const toolSignals = [
    /alternative to .{0,40}(ad |marketing )?agency/i,
    /replace(s| your)? .{0,20}(ad |marketing )?agency/i,
    /smarter alternative to/i,
    /\bAI\b.{0,60}\b(tool|platform|software|app|automation|suite)\b/i,
    /\b(ad|ads|advertising)\s+(tool|software|platform|app)\b/i,
    /\b(self[- ]?serve|self[- ]?service)\b/i,
    /\b(free trial|start (a )?free trial)\b/i,
    /\b(chrome|browser)\s+extension\b/i,
    /\bdiy\b/i,
  ];
  const eduSignals = [
    /\b(workshop|webinar|masterclass|bootcamp|cohort)\b/i,
    /\b(online )?course\b/i,
    /\b(training (day|program|session)|academy)\b/i,
    /\bcoaching (program|community|group|call)\b/i,
  ];
  for (const re of toolSignals) {
    if (re.test(text)) return `tool/product signal /${re.source}/`;
  }
  for (const re of eduSignals) {
    if (re.test(text)) return `education/workshop signal /${re.source}/`;
  }
  return null;
}

export const INDUSTRY_SOPS: IndustrySop[] = [
  {
    id: "digital_marketing_agency",
    label: "Digital marketing / PPC agency",
    matchTerms: [
      "digital marketing",
      "ppc",
      "google ads",
      "paid media",
      "performance marketing",
      "marketing agency",
      "advertising agency",
      "media agency",
      "seo agency",
      "growth agency",
    ],
    includeCompetitorTypes: [
      "full-service or specialized marketing agencies",
      "PPC / Google Ads / Meta Ads agencies",
      "SEO / content / social agencies selling done-for-you services",
    ],
    excludeCompetitorTypes: [
      "SaaS tools / software platforms",
      "AI ad tools / automation products that replace agencies",
      "white-label / reseller platforms",
      "ad tech / automation tools",
      "courses, academies, coaching, workshops, webinars",
      "podcasts / media brands",
      "freelancers posing as productized tools",
      "DIY / self-serve ad platforms",
    ],
    excludeOfferTypes: [
      "online courses / masterclasses / workshops / webinars",
      "podcasts / newsletters as the offer",
      "SaaS free trials for tools (not agency services)",
      "white-label partner programs",
      "job listings / hiring creatives",
      "info-product / coaching funnels that are not agency retainers",
    ],
    competitorRejectPatterns: [
      "white[- ]?label",
      "whitelabel",
      "saas",
      "software platform",
      "software (tool|product|app)",
      "ad[- ]?tech",
      "ad tool",
      "ads? (tool|software|platform|app)",
      "automation tool",
      "ai[- ]?(powered[- ]?)?(ad|ads|advertising)?[- ]?(tool|platform|software|app|suite)",
      "\\bai[- ]powered\\b",
      "alternative to .{0,40}(ad |marketing )?agency",
      "replace(s| your)? .{0,20}(ad |marketing )?agency",
      "smarter alternative to",
      "chrome extension",
      "browser extension",
      "free trial.*(tool|software|platform|app)",
      "self[- ]?serve",
      "self[- ]?service (ads?|platform|tool)",
      "diy (ad|ads|marketing|setup)",
      "podcast",
      "masterclass",
      "online course",
      "\\bcourse\\b",
      "workshop",
      "webinar",
      "bootcamp",
      "cohort",
      "certification program",
      "training (day|program|session|course)",
      "coaching (program|community|group)",
      "affiliate dashboard",
      "partner portal",
    ],
    offerRejectPatterns: [
      "podcast",
      "masterclass",
      "online course",
      "\\bcourse\\b",
      "workshop",
      "webinar",
      "course enrollment",
      "join (our|the) (course|workshop|webinar|cohort)",
      "bootcamp",
      "white[- ]?label",
      "become a partner",
      "reseller",
      "free (saas|software) trial",
      "download (our )?app",
      "subscribe to (our )?newsletter",
      "diy (ad|ads|marketing)",
      "self[- ]?serve",
      "alternative to .{0,40}agency",
    ],
    llmGuidance:
      "Accept only agencies that sell marketing services to businesses (done-for-you retainers / managed ads). Reject AI/SaaS ad tools, white-label platforms, workshops/webinars/courses/coaching, DIY self-serve products, and podcast/media brands — even if they mention Google Ads or Meta Ads.",
  },
  {
    id: "saas_b2b",
    label: "B2B SaaS / software",
    matchTerms: [
      "saas",
      "software",
      "platform",
      "b2b software",
      "cloud software",
      "subscription software",
    ],
    includeCompetitorTypes: [
      "competing SaaS products",
      "software platforms in the same category",
    ],
    excludeCompetitorTypes: [
      "marketing agencies (unless product is agency software)",
      "generic IT consultancies",
      "courses teaching how to use software",
      "freelance marketplaces",
    ],
    excludeOfferTypes: [
      "agency retainers",
      "courses / certifications",
      "podcasts",
      "hardware",
    ],
    competitorRejectPatterns: [
      "marketing agency",
      "ppc agency",
      "done[- ]?for[- ]?you",
      "freelancer marketplace",
      "podcast",
      "masterclass",
      "bootcamp",
    ],
    offerRejectPatterns: [
      "podcast",
      "masterclass",
      "online course",
      "agency retainer",
      "done[- ]?for[- ]?you service",
    ],
    llmGuidance:
      "Accept productized software competitors. Reject agencies selling services and education brands.",
  },
  {
    id: "ecommerce",
    label: "Ecommerce / retail brand",
    matchTerms: [
      "ecommerce",
      "e-commerce",
      "online store",
      "dtc",
      "direct to consumer",
      "retail brand",
      "shopify",
    ],
    includeCompetitorTypes: [
      "product brands selling similar goods",
      "DTC / ecommerce retailers",
    ],
    excludeCompetitorTypes: [
      "marketing agencies",
      "Shopify app tools",
      "dropshipping courses",
      "podcasts / influencers as the brand",
    ],
    excludeOfferTypes: [
      "agency services",
      "courses on how to sell online",
      "podcast sponsorships as core offer",
      "SaaS tools",
    ],
    competitorRejectPatterns: [
      "marketing agency",
      "shopify (app|expert|agency)",
      "dropship(ping)? (course|academy)",
      "make money online",
      "podcast",
      "masterclass",
    ],
    offerRejectPatterns: [
      "marketing agency",
      "online course",
      "masterclass",
      "podcast",
      "white[- ]?label",
      "become an affiliate",
    ],
    llmGuidance:
      "Accept product ecommerce brands. Reject agencies, Shopify tooling, and education offers.",
  },
  {
    id: "local_services",
    label: "Local services (home, trades, cleaning)",
    matchTerms: [
      "plumber",
      "electrician",
      "hvac",
      "cleaning",
      "roofing",
      "landscaping",
      "pest control",
      "moving",
      "local service",
      "home service",
    ],
    includeCompetitorTypes: [
      "local service businesses in the same trade",
      "regional operators serving the same customers",
    ],
    excludeCompetitorTypes: [
      "national SaaS marketplaces only",
      "lead-gen platforms selling leads",
      "courses / franchises pitched as training",
      "marketing agencies",
    ],
    excludeOfferTypes: [
      "lead marketplace subscriptions",
      "franchise opportunity pitches",
      "courses",
      "podcasts",
    ],
    competitorRejectPatterns: [
      "lead gen(eration)? platform",
      "buy leads",
      "marketing agency",
      "franchise opportunity",
      "online course",
      "podcast",
    ],
    offerRejectPatterns: [
      "buy leads",
      "lead marketplace",
      "franchise opportunity",
      "online course",
      "podcast",
      "masterclass",
    ],
    llmGuidance:
      "Accept real local service providers. Reject lead platforms, agencies, and franchise/course funnels.",
  },
  {
    id: "professional_services",
    label: "Professional services (legal, accounting, consulting)",
    matchTerms: [
      "law firm",
      "lawyer",
      "attorney",
      "accounting",
      "cpa",
      "bookkeeping",
      "consulting",
      "advisory",
      "professional services",
    ],
    includeCompetitorTypes: [
      "firms offering the same professional service",
    ],
    excludeCompetitorTypes: [
      "DIY legal/accounting SaaS tools (unless client is a tool)",
      "marketing agencies",
      "courses / certifications",
    ],
    excludeOfferTypes: [
      "SaaS free trials for tools",
      "courses",
      "podcasts",
      "lead marketplaces",
    ],
    competitorRejectPatterns: [
      "legalzoom|rocket lawyer",
      "diy (legal|tax)",
      "marketing agency",
      "online course",
      "podcast",
      "masterclass",
    ],
    offerRejectPatterns: [
      "online course",
      "podcast",
      "masterclass",
      "diy software",
      "free (legal|tax) template pack",
    ],
    llmGuidance:
      "Accept professional service firms. Reject DIY tools and education brands unless the client is itself a tool.",
  },
  {
    id: "healthcare",
    label: "Healthcare / clinics",
    matchTerms: [
      "clinic",
      "dental",
      "dentist",
      "medical",
      "healthcare",
      "physio",
      "chiropractic",
      "dermatology",
      "hospital",
    ],
    includeCompetitorTypes: ["clinics and healthcare providers in category"],
    excludeCompetitorTypes: [
      "telehealth SaaS platforms",
      "supplement brands (unless client is supplements)",
      "courses / wellness podcasts",
      "marketing agencies",
    ],
    excludeOfferTypes: ["courses", "podcasts", "SaaS trials", "agency retainers"],
    competitorRejectPatterns: [
      "marketing agency",
      "online course",
      "podcast",
      "masterclass",
      "telehealth (platform|software)",
    ],
    offerRejectPatterns: ["online course", "podcast", "masterclass", "saas trial"],
    llmGuidance:
      "Accept healthcare providers. Reject platforms, agencies, and education media.",
  },
  {
    id: "real_estate",
    label: "Real estate",
    matchTerms: [
      "real estate",
      "realtor",
      "property",
      "brokerage",
      "mortgage broker",
    ],
    includeCompetitorTypes: ["brokerages, agents, property firms"],
    excludeCompetitorTypes: [
      "iBuying platforms / proptech tools",
      "agent coaching courses",
      "podcasts",
      "marketing agencies",
    ],
    excludeOfferTypes: ["courses", "podcasts", "SaaS CRMs as the offer"],
    competitorRejectPatterns: [
      "agent (academy|bootcamp|coaching)",
      "proptech",
      "online course",
      "podcast",
      "marketing agency",
    ],
    offerRejectPatterns: [
      "agent coaching",
      "online course",
      "podcast",
      "masterclass",
      "crm free trial",
    ],
    llmGuidance:
      "Accept real-estate service businesses. Reject proptech tools and coaching academies.",
  },
  {
    id: "education",
    label: "Education / training",
    matchTerms: [
      "education",
      "school",
      "university",
      "tutoring",
      "training",
      "academy",
      "edtech",
    ],
    includeCompetitorTypes: [
      "schools, tutoring, training providers in category",
    ],
    excludeCompetitorTypes: [
      "unrelated marketing agencies",
      "generic productivity SaaS",
    ],
    excludeOfferTypes: [
      "unrelated agency retainers",
      "hardware",
    ],
    competitorRejectPatterns: ["marketing agency", "ppc agency"],
    offerRejectPatterns: ["marketing retainer", "google ads management"],
    llmGuidance:
      "Accept education providers. Courses/podcasts may be valid here if they are the core product.",
  },
  {
    id: "finance",
    label: "Finance / insurance",
    matchTerms: [
      "finance",
      "insurance",
      "wealth",
      "financial advisor",
      "fintech",
      "banking",
    ],
    includeCompetitorTypes: ["financial / insurance providers"],
    excludeCompetitorTypes: [
      "get-rich courses",
      "trading signal groups",
      "podcasts",
      "marketing agencies",
    ],
    excludeOfferTypes: ["get-rich courses", "signal groups", "podcasts"],
    competitorRejectPatterns: [
      "make money (online|trading)",
      "signal group",
      "online course",
      "podcast",
      "marketing agency",
    ],
    offerRejectPatterns: [
      "make money",
      "signal group",
      "online course",
      "podcast",
      "masterclass",
    ],
    llmGuidance:
      "Accept regulated finance/insurance competitors. Reject get-rich education and media brands.",
  },
  {
    id: "hospitality",
    label: "Hospitality / travel",
    matchTerms: [
      "hotel",
      "hospitality",
      "restaurant",
      "travel",
      "tourism",
      "resort",
    ],
    includeCompetitorTypes: ["hotels, restaurants, travel operators"],
    excludeCompetitorTypes: [
      "booking SaaS tools",
      "marketing agencies",
      "courses",
      "podcasts",
    ],
    excludeOfferTypes: ["SaaS tools", "courses", "podcasts", "agency retainers"],
    competitorRejectPatterns: [
      "booking (software|platform|saas)",
      "marketing agency",
      "online course",
      "podcast",
    ],
    offerRejectPatterns: ["saas", "online course", "podcast", "masterclass"],
    llmGuidance:
      "Accept hospitality operators. Reject booking tools and agencies.",
  },
  {
    id: "general",
    label: "General business",
    matchTerms: [],
    includeCompetitorTypes: ["direct competitors selling similar offerings"],
    excludeCompetitorTypes: [
      "unrelated tools",
      "courses / podcasts as primary business",
      "job boards",
    ],
    excludeOfferTypes: ["unrelated courses", "podcasts", "job listings"],
    competitorRejectPatterns: [
      "podcast",
      "online course",
      "masterclass",
      "we are hiring",
    ],
    offerRejectPatterns: ["podcast", "online course", "masterclass", "we are hiring"],
    llmGuidance:
      "Accept direct competitors. Reject media/education funnels unrelated to the client's offer.",
  },
];

export function resolveIndustrySop(input: {
  industry?: string | null;
  subIndustry?: string | null;
  offerings?: string[] | null;
  description?: string | null;
  selectedCategory?: string | null;
}): IndustrySop {
  const hay = [
    input.industry,
    input.subIndustry,
    input.selectedCategory,
    ...(input.offerings || []),
    input.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let best: IndustrySop = INDUSTRY_SOPS[INDUSTRY_SOPS.length - 1];
  let bestScore = -1;
  for (const sop of INDUSTRY_SOPS) {
    if (sop.id === "general") continue;
    let score = 0;
    for (const term of sop.matchTerms) {
      if (hay.includes(term.toLowerCase())) score += term.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = sop;
    }
  }
  return bestScore > 0 ? best : INDUSTRY_SOPS.find((s) => s.id === "general")!;
}
