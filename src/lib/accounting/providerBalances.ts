import { getSociavaultCreditBalance } from "@/lib/sociavault/client";
import { getManusAvailableCredits, hasManusKey } from "@/lib/manus/client";
import { PROVIDER_IDS, type ProviderId } from "@/lib/types";

/**
 * Provider account balances and provider-reported spend, for admins only.
 *
 * Documented endpoints we call:
 *   SociaVault  GET https://api.sociavault.com/v1/credits
 *   OpenRouter  GET https://openrouter.ai/api/v1/credits (management key),
 *               fallback GET https://openrouter.ai/api/v1/key
 *   Manus       GET https://api.manus.ai/v2/usage.availableCredits
 *   Firecrawl   GET https://api.firecrawl.dev/v2/team/credit-usage
 *   Brandfetch  GET https://api.brandfetch.io/v2/viewer (free; quota and use this period)
 *   Runway      GET https://api.dev.runwayml.com/v1/organization
 *   OpenAI      GET https://api.openai.com/v1/organization/costs (OPENAI_ADMIN_KEY)
 *   Anthropic   GET https://api.anthropic.com/v1/organizations/cost_report (ANTHROPIC_ADMIN_KEY)
 *
 * OpenAI and Anthropic publish no balance, only spend, and only to admin
 * keys. Without one they return "unavailable"; the dashboard always shows the
 * spend this app tracked beside it.
 */

/** Window for provider-reported spend (OpenAI, Anthropic). */
const SPEND_DAYS = 30;

export interface ProviderBalance {
  provider: ProviderId;
  status: "available" | "unavailable" | "error";
  /** Remaining balance in the provider's own unit, when reported. */
  balance: number | null;
  currency: string | null;
  totalPurchased: number | null;
  totalUsed: number | null;
  /** USD the provider reports was spent in the last SPEND_DAYS days, when it reports spend. */
  spentUsd?: number | null;
  note: string;
}


function unavailable(
  provider: ProviderId,
  note: string,
  extras?: Partial<ProviderBalance>,
): ProviderBalance {
  return {
    provider,
    status: "unavailable",
    balance: null,
    currency: extras?.currency ?? null,
    totalPurchased: extras?.totalPurchased ?? null,
    totalUsed: extras?.totalUsed ?? null,
    note,
  };
}

async function fetchSociavaultBalance(): Promise<ProviderBalance> {
  if (!process.env.SOCIAVAULT_API_KEY?.trim()) {
    return unavailable("sociavault", "SOCIAVAULT_API_KEY is not configured.");
  }
  try {
    const data = await getSociavaultCreditBalance();
    return {
      provider: "sociavault",
      status: "available",
      balance: data.credits,
      currency: "credits",
      totalPurchased: null,
      totalUsed: null,
      note: data.subscriptionStatus
        ? `Remaining credits from GET /v1/credits (subscription: ${data.subscriptionStatus}).`
        : "Remaining credits from GET /v1/credits.",
    };
  } catch (err) {
    return {
      provider: "sociavault",
      status: "error",
      balance: null,
      currency: "credits",
      totalPurchased: null,
      totalUsed: null,
      note: `Could not read SociaVault credits: ${(err as Error).message.slice(0, 120)}`,
    };
  }
}

async function fetchOpenRouterKeyRemaining(
  key: string,
): Promise<ProviderBalance> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return {
      provider: "openrouter",
      status: "error",
      balance: null,
      currency: "USD",
      totalPurchased: null,
      totalUsed: null,
      note:
        res.status === 403
          ? "OpenRouter requires a management key to read account credits."
          : `OpenRouter key request failed (${res.status}).`,
    };
  }
  const json = (await res.json()) as {
    data?: {
      limit?: number | null;
      limit_remaining?: number | null;
      usage?: number;
    };
  };
  const remaining = json.data?.limit_remaining;
  const usage = json.data?.usage;
  if (remaining === null || remaining === undefined) {
    return unavailable(
      "openrouter",
      "This API key has no credit cap. Account remaining credits require an OpenRouter management key.",
      {
        currency: "USD",
        totalUsed: typeof usage === "number" ? usage : null,
      },
    );
  }
  return {
    provider: "openrouter",
    status: "available",
    balance: remaining,
    currency: "USD",
    totalPurchased: typeof json.data?.limit === "number" ? json.data.limit : null,
    totalUsed: typeof usage === "number" ? usage : null,
    note: "Per-key remaining credits from GET /api/v1/key (not the full account balance).",
  };
}

async function fetchOpenRouterBalance(): Promise<ProviderBalance> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    return unavailable("openrouter", "OPENROUTER_API_KEY is not configured.", {
      currency: "USD",
    });
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 403) {
      // Standard API keys cannot read account credits. The documented
      // GET /api/v1/key endpoint still reports this key's remaining cap.
      return fetchOpenRouterKeyRemaining(key);
    }
    if (!res.ok) {
      return {
        provider: "openrouter",
        status: "error",
        balance: null,
        currency: "USD",
        totalPurchased: null,
        totalUsed: null,
        note: `OpenRouter credits request failed (${res.status}).`,
      };
    }
    const json = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const purchased = json.data?.total_credits;
    const used = json.data?.total_usage;
    if (typeof purchased !== "number" || typeof used !== "number") {
      return {
        provider: "openrouter",
        status: "error",
        balance: null,
        currency: "USD",
        totalPurchased: null,
        totalUsed: null,
        note: "Unexpected OpenRouter credits response shape.",
      };
    }
    return {
      provider: "openrouter",
      status: "available",
      balance: purchased - used,
      currency: "USD",
      totalPurchased: purchased,
      totalUsed: used,
      note: "total_credits − total_usage, as reported by OpenRouter GET /api/v1/credits.",
    };
  } catch (err) {
    return {
      provider: "openrouter",
      status: "error",
      balance: null,
      currency: "USD",
      totalPurchased: null,
      totalUsed: null,
      note: `Could not reach OpenRouter: ${(err as Error).message.slice(0, 120)}`,
    };
  }
}

function errorBalance(provider: ProviderId, currency: string | null, note: string): ProviderBalance {
  return { provider, status: "error", balance: null, currency, totalPurchased: null, totalUsed: null, note };
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function fetchManusBalance(): Promise<ProviderBalance> {
  if (!hasManusKey()) return unavailable("manus", "MANUS_API_KEY is not configured.", { currency: "credits" });
  try {
    const credits = await getManusAvailableCredits();
    const refresh = credits.nextRefresh
      ? ` Next refresh ${new Date(credits.nextRefresh * 1000).toISOString().slice(0, 10)}.`
      : "";
    return {
      provider: "manus",
      status: "available",
      balance: credits.total,
      currency: "credits",
      totalPurchased: null,
      totalUsed: null,
      note: `Spendable credits from usage.availableCredits.${refresh}`,
    };
  } catch (err) {
    return errorBalance("manus", "credits", `Could not read Manus credits: ${(err as Error).message.slice(0, 120)}`);
  }
}

async function fetchFirecrawlBalance(): Promise<ProviderBalance> {
  const key = process.env.FIRECRAWL_API_KEY?.trim();
  if (!key) return unavailable("firecrawl", "FIRECRAWL_API_KEY is not configured.", { currency: "credits" });
  try {
    const { status, json } = await getJson("https://api.firecrawl.dev/v2/team/credit-usage", {
      Authorization: `Bearer ${key}`,
    });
    const data = (json as { data?: { remainingCredits?: number; planCredits?: number; billingPeriodEnd?: string } } | null)
      ?.data;
    if (status !== 200 || typeof data?.remainingCredits !== "number") {
      return errorBalance("firecrawl", "credits", `Firecrawl credit usage request failed (${status}).`);
    }
    const plan = typeof data.planCredits === "number" ? data.planCredits : null;
    return {
      provider: "firecrawl",
      status: "available",
      balance: data.remainingCredits,
      currency: "credits",
      totalPurchased: plan,
      totalUsed: plan !== null ? Math.max(0, plan - data.remainingCredits) : null,
      note: `Remaining credits from GET /v2/team/credit-usage${
        data.billingPeriodEnd ? ` (period ends ${data.billingPeriodEnd.slice(0, 10)})` : ""
      }.`,
    };
  } catch (err) {
    return errorBalance("firecrawl", "credits", `Could not reach Firecrawl: ${(err as Error).message.slice(0, 120)}`);
  }
}

async function fetchBrandfetchBalance(): Promise<ProviderBalance> {
  const key = process.env.BRANDFETCH_API_KEY?.trim();
  if (!key) return unavailable("brandfetch", "BRANDFETCH_API_KEY is not configured.", { currency: "fetches" });
  try {
    const { status, json } = await getJson("https://api.brandfetch.io/v2/viewer", { Authorization: `Bearer ${key}` });
    const usage = (json as { usage?: { used?: number; quota?: number } } | null)?.usage;
    if (status !== 200 || typeof usage?.quota !== "number") {
      return errorBalance("brandfetch", "fetches", `Brandfetch viewer request failed (${status}).`);
    }
    const used = typeof usage.used === "number" ? usage.used : 0;
    return {
      provider: "brandfetch",
      status: "available",
      balance: Math.max(0, usage.quota - used),
      currency: "fetches",
      totalPurchased: usage.quota,
      totalUsed: used,
      note: `Fetches left this billing period (${used} of ${usage.quota} used), from GET /v2/viewer.`,
    };
  } catch (err) {
    return errorBalance("brandfetch", "fetches", `Could not reach Brandfetch: ${(err as Error).message.slice(0, 120)}`);
  }
}

async function fetchRunwayBalance(): Promise<ProviderBalance> {
  const key = process.env.RUNWAYML_API_SECRET?.trim();
  if (!key) {
    return unavailable("runway", "RUNWAYML_API_SECRET is not configured (the app no longer uses Runway).", {
      currency: "credits",
    });
  }
  try {
    const { status, json } = await getJson("https://api.dev.runwayml.com/v1/organization", {
      Authorization: `Bearer ${key}`,
      "X-Runway-Version": "2024-11-06",
    });
    const balance = (json as { creditBalance?: number } | null)?.creditBalance;
    if (status !== 200 || typeof balance !== "number") {
      return errorBalance("runway", "credits", `Runway organization request failed (${status}).`);
    }
    return {
      provider: "runway",
      status: "available",
      balance,
      currency: "credits",
      totalPurchased: null,
      totalUsed: null,
      note: "creditBalance from GET /v1/organization.",
    };
  } catch (err) {
    return errorBalance("runway", "credits", `Could not reach Runway: ${(err as Error).message.slice(0, 120)}`);
  }
}

/** OpenAI spend over the last SPEND_DAYS days (Costs API, admin key). */
async function fetchOpenAiSpend(): Promise<ProviderBalance> {
  const key = process.env.OPENAI_ADMIN_KEY?.trim();
  if (!key) {
    return unavailable(
      "openai",
      "OpenAI publishes no balance. Set OPENAI_ADMIN_KEY (an organization admin key) to show the spend OpenAI reports; the spend this app tracked is shown alongside.",
      { currency: "USD" },
    );
  }
  try {
    const start = Math.floor(Date.now() / 1000) - SPEND_DAYS * 86_400;
    let total = 0;
    let page: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const url = new URL("https://api.openai.com/v1/organization/costs");
      url.searchParams.set("start_time", String(start));
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", String(SPEND_DAYS + 1));
      if (page) url.searchParams.set("page", page);
      const { status, json } = await getJson(url.toString(), { Authorization: `Bearer ${key}` });
      if (status !== 200) return errorBalance("openai", "USD", `OpenAI costs request failed (${status}).`);
      const body = json as {
        data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>;
        has_more?: boolean;
        next_page?: string;
      };
      for (const bucket of body.data ?? []) {
        for (const r of bucket.results ?? []) total += Number(r.amount?.value ?? 0) || 0;
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return {
      provider: "openai",
      status: "available",
      balance: null,
      currency: "USD",
      totalPurchased: null,
      totalUsed: null,
      spentUsd: total,
      note: `Spend in the last ${SPEND_DAYS} days from the OpenAI Costs API (OpenAI publishes no balance).`,
    };
  } catch (err) {
    return errorBalance("openai", "USD", `Could not reach OpenAI: ${(err as Error).message.slice(0, 120)}`);
  }
}

/** Anthropic spend over the last SPEND_DAYS days (cost report, admin key). Amounts come in cents. */
async function fetchAnthropicSpend(): Promise<ProviderBalance> {
  const key = process.env.ANTHROPIC_ADMIN_KEY?.trim();
  if (!key) {
    return unavailable(
      "anthropic",
      "Anthropic publishes no balance. Set ANTHROPIC_ADMIN_KEY (an Admin API key) to show the spend Anthropic reports; the spend this app tracked is shown alongside.",
      { currency: "USD" },
    );
  }
  try {
    const startingAt = new Date(Date.now() - SPEND_DAYS * 86_400_000).toISOString();
    let cents = 0;
    let page: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
      url.searchParams.set("starting_at", startingAt);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", "31");
      if (page) url.searchParams.set("page", page);
      const { status, json } = await getJson(url.toString(), { "x-api-key": key, "anthropic-version": "2023-06-01" });
      if (status !== 200) return errorBalance("anthropic", "USD", `Anthropic cost report request failed (${status}).`);
      const body = json as {
        data?: Array<{ results?: Array<{ amount?: string | number }> }>;
        has_more?: boolean;
        next_page?: string;
      };
      for (const bucket of body.data ?? []) {
        for (const r of bucket.results ?? []) cents += Number(r.amount ?? 0) || 0;
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return {
      provider: "anthropic",
      status: "available",
      balance: null,
      currency: "USD",
      totalPurchased: null,
      totalUsed: null,
      spentUsd: cents / 100,
      note: `Spend in the last ${SPEND_DAYS} days from the Anthropic cost report (Anthropic publishes no balance).`,
    };
  } catch (err) {
    return errorBalance("anthropic", "USD", `Could not reach Anthropic: ${(err as Error).message.slice(0, 120)}`);
  }
}

/** One fetcher per provider: typed so a new provider can't be left without one. */
const FETCHERS: Record<ProviderId, () => Promise<ProviderBalance>> = {
  sociavault: fetchSociavaultBalance,
  openrouter: fetchOpenRouterBalance,
  openai: fetchOpenAiSpend,
  anthropic: fetchAnthropicSpend,
  firecrawl: fetchFirecrawlBalance,
  brandfetch: fetchBrandfetchBalance,
  runway: fetchRunwayBalance,
  manus: fetchManusBalance,
};

export async function getProviderBalances(): Promise<ProviderBalance[]> {
  return Promise.all(PROVIDER_IDS.map((provider) => FETCHERS[provider]()));
}
