import { getSociavaultCreditBalance } from "@/lib/sociavault/client";
import { PROVIDER_IDS, type ProviderId } from "@/lib/types";

/**
 * Provider account balances, for admins only.
 *
 * Documented endpoints we actually call:
 *   SociaVault  GET https://api.sociavault.com/v1/credits
 *               https://docs.sociavault.com/api-reference/credits
 *   OpenRouter  GET https://openrouter.ai/api/v1/credits
 *               (management key required)
 *               fallback GET https://openrouter.ai/api/v1/key
 *               https://openrouter.ai/docs/api_reference/limits
 *
 * OpenAI, Anthropic, Firecrawl, Brandfetch and RunwayML have no documented
 * balance API for standard keys. Those return status "unavailable" rather than
 * a fabricated 0, and the dashboard shows tracked application usage instead.
 */

export interface ProviderBalance {
  provider: ProviderId;
  status: "available" | "unavailable" | "error";
  /** Remaining balance in the provider's own unit, when reported. */
  balance: number | null;
  currency: string | null;
  totalPurchased: number | null;
  totalUsed: number | null;
  note: string;
}

const NO_BALANCE_API_NOTE =
  "This provider does not publish a balance API for standard keys — check its own dashboard.";

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

export async function getProviderBalances(): Promise<ProviderBalance[]> {
  const [openrouter, sociavault] = await Promise.all([
    fetchOpenRouterBalance(),
    fetchSociavaultBalance(),
  ]);
  const known: Partial<Record<ProviderId, ProviderBalance>> = {
    openrouter,
    sociavault,
  };
  return PROVIDER_IDS.map(
    (provider) =>
      known[provider] ??
      unavailable(provider, NO_BALANCE_API_NOTE),
  );
}
