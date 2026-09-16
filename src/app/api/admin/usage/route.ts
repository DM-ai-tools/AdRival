import { NextResponse } from "next/server";
import { getUserById, readDb } from "@/lib/db";
import { errorResponse, requireAdmin } from "@/lib/authz";
import {
  queryProviderCalls,
  usageByProvider,
  type UsageQuery,
} from "@/lib/accounting/service";
import { formatCredits, formatUsdMicros } from "@/lib/accounting/units";
import type { ProviderCallStatus, ProviderId, UsageConfidence } from "@/lib/types";

export const runtime = "nodejs";

function parseQuery(url: URL): UsageQuery {
  const value = (key: string) => url.searchParams.get(key)?.trim() || undefined;
  return {
    chargedUserId: value("userId"),
    projectId: value("projectId"),
    runId: value("runId"),
    provider: value("provider") as ProviderId | undefined,
    status: value("status") as ProviderCallStatus | undefined,
    confidence: value("confidence") as UsageConfidence | undefined,
    from: value("from"),
    to: value("to"),
    limit: Number(value("limit") ?? 200),
    offset: Number(value("offset") ?? 0),
  };
}

const CSV_COLUMNS = [
  "started_at",
  "completed_at",
  "charged_username",
  "initiated_by_username",
  "provider",
  "model_or_endpoint",
  "operation",
  "project_kind",
  "project_id",
  "run_id",
  "provider_request_id",
  "input_tokens",
  "output_tokens",
  "requests",
  "images",
  "usage_confidence",
  "credits_charged",
  "estimated_cost_usd",
  "conversion_rule_version",
  "status",
  "error",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const query = parseQuery(url);
    const wantsCsv = url.searchParams.get("format") === "csv";

    if (wantsCsv) {
      const { rows } = queryProviderCalls({
        ...query,
        limit: Number.MAX_SAFE_INTEGER,
        offset: 0,
      });
      const lines = [CSV_COLUMNS.join(",")];
      for (const call of rows) {
        lines.push(
          [
            call.startedAt,
            call.completedAt,
            getUserById(call.chargedUserId)?.username ?? call.chargedUserId,
            getUserById(call.initiatedByUserId)?.username ??
              call.initiatedByUserId,
            call.provider,
            call.model ?? call.endpoint ?? "",
            call.operation,
            call.projectKind ?? "",
            call.projectId ?? "",
            call.runId ?? "",
            call.providerRequestId ?? "",
            call.usage.inputTokens ?? "",
            call.usage.outputTokens ?? "",
            call.usage.requests ?? "",
            call.usage.images ?? "",
            call.usageConfidence,
            formatCredits(call.creditsCharged),
            call.estimatedCostUsdMicros === null
              ? "unavailable"
              : formatUsdMicros(call.estimatedCostUsdMicros).replace("$", ""),
            call.conversionRuleVersion,
            call.status,
            call.errorMessage ?? "",
          ]
            .map(csvCell)
            .join(","),
        );
      }
      // Provider secrets never appear in the export — only ids and usage.
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="usage-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    const { rows, total } = queryProviderCalls(query);
    const reservations = readDb().creditReservations ?? [];
    return NextResponse.json({
      rows: rows.map((call) => ({
        ...call,
        chargedUsername: getUserById(call.chargedUserId)?.username ?? null,
        initiatedByUsername:
          getUserById(call.initiatedByUserId)?.username ?? null,
      })),
      total,
      byProvider: usageByProvider(query),
      reservations: query.runId
        ? reservations.filter((r) => r.runId === query.runId)
        : [],
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
