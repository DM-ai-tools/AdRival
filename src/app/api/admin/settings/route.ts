import { NextResponse } from "next/server";
import { getAppSettings, updateAppSettings } from "@/lib/db";
import { errorResponse, HttpError, requirePlatformAdmin } from "@/lib/authz";
import {
  getActiveConversionRuleSet,
  listConversionRuleSets,
  publishConversionRuleSet,
  recordAudit,
} from "@/lib/accounting/records";
import { parseCreditsInput } from "@/lib/accounting/units";
import { PROVIDER_IDS, type ProviderId, type ResetCadence } from "@/lib/types";
import { validateConversionRules } from "@/lib/accounting/conversionValidation";

/** The env var holding each provider's key; typed so a new provider can't be missed. */
const PROVIDER_KEY_ENV: Record<ProviderId, string> = {
  sociavault: "SOCIAVAULT_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  brandfetch: "BRANDFETCH_API_KEY",
  runway: "RUNWAYML_API_SECRET",
};

export const runtime = "nodejs";

export async function GET() {
  try {
    await requirePlatformAdmin();
    return NextResponse.json({
      settings: getAppSettings(),
      conversionRuleSets: listConversionRuleSets(),
      // The version new charges really use (falls back to the newest when the
      // setting names a version that does not exist).
      effectiveConversionRuleVersion: getActiveConversionRuleSet().version,
      providers: PROVIDER_IDS,
      // Credentials stay server-side: only whether each key is present.
      providerKeyConfigured: Object.fromEntries(
        PROVIDER_IDS.map((id) => [id, Boolean(process.env[PROVIDER_KEY_ENV[id]]?.trim())]),
      ),
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

export async function PUT(request: Request) {
  try {
    const admin = await requirePlatformAdmin();

    let body: {
      publicSignupEnabled?: boolean;
      defaultAllowanceCredits?: string | number;
      defaultResetCadence?: ResetCadence;
      lowCreditWarningCredits?: string | number;
      maxConcurrentRunsPerUser?: number;
      maxRunReservationCredits?: string | number;
      disabledProviders?: string[];
      disabledModels?: string[];
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const patch: Parameters<typeof updateAppSettings>[0] = {};

    if (body.publicSignupEnabled !== undefined) {
      patch.publicSignupEnabled = Boolean(body.publicSignupEnabled);
    }
    if (body.defaultAllowanceCredits !== undefined) {
      const value = parseCreditsInput(body.defaultAllowanceCredits);
      if (value === null || value < 0) {
        throw new HttpError(400, "Default allowance must be a non-negative number");
      }
      patch.defaultAllowanceSubunits = value;
    }
    if (body.defaultResetCadence !== undefined) {
      patch.defaultResetCadence =
        body.defaultResetCadence === "monthly" ? "monthly" : "none";
    }
    if (body.lowCreditWarningCredits !== undefined) {
      const value = parseCreditsInput(body.lowCreditWarningCredits);
      if (value === null || value < 0) {
        throw new HttpError(400, "Warning threshold must be a non-negative number");
      }
      patch.lowCreditWarningSubunits = value;
    }
    if (body.maxConcurrentRunsPerUser !== undefined) {
      const value = Number(body.maxConcurrentRunsPerUser);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new HttpError(400, "Concurrent run limit must be between 1 and 50");
      }
      patch.maxConcurrentRunsPerUser = value;
    }
    if (body.maxRunReservationCredits !== undefined) {
      const value = parseCreditsInput(body.maxRunReservationCredits);
      if (value === null || value <= 0) {
        throw new HttpError(400, "Per-run cap must be greater than zero");
      }
      patch.maxRunReservationSubunits = value;
    }
    if (body.disabledProviders !== undefined) {
      const invalid = body.disabledProviders.filter(
        (p) => !PROVIDER_IDS.includes(p as ProviderId),
      );
      if (invalid.length) {
        throw new HttpError(400, `Unknown provider(s): ${invalid.join(", ")}`);
      }
      patch.disabledProviders = body.disabledProviders as ProviderId[];
    }
    if (body.disabledModels !== undefined) {
      patch.disabledModels = body.disabledModels
        .map((m) => String(m).trim())
        .filter(Boolean);
    }

    const settings = updateAppSettings(patch, admin.id);
    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.settings.update",
      details: Object.fromEntries(
        Object.entries(patch).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(",") || null : (v as string | number | boolean),
        ]),
      ),
    });
    return NextResponse.json({ ok: true, settings });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

/** Publish a new conversion rule version. Existing charges keep their version. */
export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin();

    let body: {
      rates?: Record<string, Record<string, Record<string, number>>>;
      perCallReservationCeiling?: Record<string, number>;
      note?: string;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!body.rates || typeof body.rates !== "object") {
      throw new HttpError(400, "rates is required");
    }
    if (
      !body.perCallReservationCeiling ||
      typeof body.perCallReservationCeiling !== "object"
    ) {
      throw new HttpError(400, "perCallReservationCeiling is required");
    }
    // These become the live billing rules at once, so reject anything malformed.
    const problems = validateConversionRules({
      rates: body.rates,
      perCallReservationCeiling: body.perCallReservationCeiling,
    });
    if (problems.length) {
      throw new HttpError(400, `Conversion rules not published: ${problems.slice(0, 5).join(" ")}`);
    }

    const created = publishConversionRuleSet({
      rates: body.rates as never,
      perCallReservationCeiling: body.perCallReservationCeiling,
      note: String(body.note ?? "").trim() || null,
      actorUserId: admin.id,
    });
    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.conversion_rules.publish",
      details: { version: created.version },
    });
    return NextResponse.json({ ok: true, ruleSet: created });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
