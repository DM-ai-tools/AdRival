import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("accounting");
after(() => store.cleanup());

// Imported after useTempStore so `db.ts` picks up ADRIVAL_DATA_DIR.
const { makeUser, makeSearchProject } = await import("./helpers/factories");
const {
  addCredits,
  availableSubunits,
  creditsForRun,
  getCreditSummary,
  listPendingReconciliation,
  listPeriods,
  recordAdjustment,
  recoverAbandonedReservations,
  releaseReservation,
  reserveCredits,
  resolveReconciliation,
  setAllowance,
  settleProviderCall,
  sweepAbandonedReservations,
} = await import("@/lib/accounting/service");
const { creditsToSubunits, formatCredits, chargeCeil, parseCreditsInput } = await import(
  "@/lib/accounting/units"
);
const { convertUsage, seedConversionRuleSet } = await import(
  "@/lib/accounting/conversion"
);
const { extractSociavaultUsage, extractOpenAiUsage, extractAnthropicUsage } =
  await import("@/lib/accounting/meter");
const { queryLedger } = await import("@/lib/accounting/records");
const { readDb, transaction } = await import("@/lib/db");

function settleOnce(
  overrides: Partial<Parameters<typeof settleProviderCall>[0]> & {
    idempotencyKey: string;
    chargedUserId: string;
  },
) {
  return settleProviderCall({
    initiatedByUserId: overrides.chargedUserId,
    projectKind: null,
    projectId: null,
    runId: null,
    provider: "sociavault",
    model: null,
    endpoint: "/test",
    operation: "test.op",
    providerRequestId: null,
    usage: { requests: 1 },
    usageConfidence: "confirmed",
    creditsCharged: creditsToSubunits(1),
    estimatedCostUsdMicros: null,
    conversionRuleVersion: 1,
    status: "succeeded",
    errorMessage: null,
    reservationId: null,
    startedAt: new Date().toISOString(),
    durationMs: 10,
    releaseSubunits: 0,
    ...overrides,
  });
}

describe("credit arithmetic", () => {
  test("credits round-trip through integer subunits", () => {
    assert.equal(creditsToSubunits(1), 10_000);
    assert.equal(creditsToSubunits(0.0001), 1);
    assert.equal(formatCredits(10_000), "1");
    assert.equal(formatCredits(12_345), "1.2345");
    assert.equal(formatCredits(100_000), "10");
    // 0.1 + 0.2 in floats is 0.30000000000000004; subunits stay exact.
    assert.equal(
      creditsToSubunits(0.1) + creditsToSubunits(0.2),
      creditsToSubunits(0.3),
    );
  });

  test("a non-zero charge never rounds down to free", () => {
    assert.equal(chargeCeil(0.0001), 1);
    assert.equal(chargeCeil(0), 0);
    assert.equal(chargeCeil(1.2), 2);
  });
});

describe("provider usage conversion", () => {
  const rules = seedConversionRuleSet();

  test("SociaVault credits_used is confirmed request-units, not a guess", () => {
    const extracted = extractSociavaultUsage({
      success: true,
      data: {},
      credits_used: 3,
    });
    const converted = convertUsage(rules, "sociavault", "/v1/scrape", extracted.usage);
    assert.equal(converted.usageConfidence, "confirmed");
    assert.equal(converted.usage.requests, 3);
    assert.equal(converted.creditsCharged, creditsToSubunits(3));
  });

  test("a missing SociaVault credits_used field is labeled estimated", () => {
    const extracted = extractSociavaultUsage({ success: true, data: {} });
    assert.equal(extracted.usage, null);
    const converted = convertUsage(rules, "sociavault", "/v1/scrape", extracted.usage);
    assert.equal(converted.usageConfidence, "estimated");
    assert.equal(converted.usage.requests, 1);
  });

  test("a reported zero SociaVault spend is confirmed free, not estimated as one request", () => {
    const extracted = extractSociavaultUsage({ credits_used: 0 });
    const converted = convertUsage(rules, "sociavault", "/v1/scrape", extracted.usage);
    assert.equal(converted.usageConfidence, "confirmed");
    assert.equal(converted.creditsCharged, 0);
  });

  test("OpenAI-compatible token counts are confirmed and not treated as SociaVault units", () => {
    const extracted = extractOpenAiUsage({
      id: "chatcmpl-test",
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    });
    const converted = convertUsage(rules, "openrouter", "perplexity/sonar", extracted.usage);
    assert.equal(converted.usageConfidence, "confirmed");
    assert.equal(converted.usage.inputTokens, 1000);
    assert.equal(converted.usage.outputTokens, 500);
    assert.ok(converted.creditsCharged > 0);
  });

  test("Anthropic input/output tokens are confirmed independently of OpenAI fields", () => {
    const extracted = extractAnthropicUsage({
      id: "msg_test",
      usage: { input_tokens: 2000, output_tokens: 100 },
    });
    const converted = convertUsage(rules, "anthropic", "claude-sonnet-4-5", extracted.usage);
    assert.equal(converted.usageConfidence, "confirmed");
    assert.equal(converted.usage.inputTokens, 2000);
    assert.equal(converted.usage.outputTokens, 100);
  });

  test("monetary cost stays unavailable until a listed or configured price applies", () => {
    const converted = convertUsage(rules, "sociavault", null, { requests: 1 });
    assert.equal(converted.estimatedCostUsdMicros, null);
  });

  test("documented token prices turn stored tokens into micro-USD", async () => {
    const { priceTokenUsage, summarizeTrackedSpend } = await import(
      "@/lib/accounting/priceBook"
    );
    const priced = priceTokenUsage("anthropic", "claude-sonnet-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000,
    });
    // $3 per million input + $15 per million output * 1,000 tokens.
    assert.equal(priced.usdMicros, 3_000_000 + 15_000);

    const summary = summarizeTrackedSpend([
      {
        provider: "openrouter",
        model: "perplexity/sonar",
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
        estimatedCostUsdMicros: null,
        status: "succeeded",
      },
      {
        provider: "sociavault",
        model: null,
        usage: { requests: 1 },
        estimatedCostUsdMicros: null,
        status: "succeeded",
      },
    ]);
    assert.equal(summary.totalUsdMicros, 1_000_000);
    assert.equal(summary.unpricedCalls, 1);
  });
});

describe("hard credit enforcement", () => {
  test("an admin is not blocked by a zero allowance", async () => {
    const admin = await makeUser({ role: "admin", credits: 0 });
    const result = reserveCredits({
      userId: admin.id,
      amountSubunits: creditsToSubunits(25),
      operation: "test.admin-unlimited",
    });
    assert.equal(result.ok, true);
    const summary = getCreditSummary(admin.id);
    assert.equal(summary.unlimited, true);
    assert.equal(summary.lowCredit, false);
  });

  test("a zero-credit user cannot reserve anything", async () => {
    const user = await makeUser({ credits: 0 });
    const result = reserveCredits({
      userId: user.id,
      amountSubunits: 1,
      operation: "test.reserve",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "insufficient_credits");
  });

  test("a suspended user cannot reserve even with a balance", async () => {
    const user = await makeUser({ credits: 100, status: "suspended" });
    const result = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(1),
      operation: "test.reserve",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "account_not_active");
  });

  test("concurrent reservations cannot oversell the same balance", async () => {
    const user = await makeUser({ credits: 10 });
    const hold = creditsToSubunits(4);

    // Fired together; each reservation is one atomic read-modify-write.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        Promise.resolve().then(() =>
          reserveCredits({
            userId: user.id,
            amountSubunits: hold,
            operation: "test.concurrent",
          }),
        ),
      ),
    );

    const granted = results.filter((r) => r.ok);
    assert.equal(granted.length, 2, "only 2 x 4 credits fit inside 10");
    const summary = getCreditSummary(user.id);
    assert.equal(summary.reservedSubunits, hold * 2);
    assert.ok(
      summary.availableSubunits >= 0,
      "available credits never go negative",
    );
  });

  test("available = allowance - consumed - reserved", async () => {
    const user = await makeUser({ credits: 10 });
    const reservation = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(3),
      operation: "test.identity",
    });
    assert.ok(reservation.ok);

    settleOnce({
      idempotencyKey: `identity-${user.id}`,
      chargedUserId: user.id,
      reservationId: reservation.ok ? reservation.reservation.id : null,
      creditsCharged: creditsToSubunits(1),
      releaseSubunits: creditsToSubunits(1),
    });

    const s = getCreditSummary(user.id);
    assert.equal(
      s.availableSubunits,
      s.allowanceSubunits - s.consumedSubunits - s.reservedSubunits,
    );
  });
});

describe("settlement", () => {
  test("duplicate settlements cannot double-charge", async () => {
    const user = await makeUser({ credits: 10 });
    const key = `dupe-${user.id}`;

    const first = settleOnce({ idempotencyKey: key, chargedUserId: user.id });
    const consumedAfterFirst = getCreditSummary(user.id).consumedSubunits;

    const second = settleOnce({ idempotencyKey: key, chargedUserId: user.id });
    const third = settleOnce({ idempotencyKey: key, chargedUserId: user.id });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
    assert.equal(second.call.id, first.call.id);
    assert.equal(
      getCreditSummary(user.id).consumedSubunits,
      consumedAfterFirst,
      "repeat settlements leave the balance untouched",
    );
    assert.equal(
      readDb().providerCalls!.filter((c) => c.idempotencyKey === key).length,
      1,
      "only one provider-call row exists for the key",
    );
  });

  test("a call that never reached the provider is recorded but not charged", async () => {
    const user = await makeUser({ credits: 10 });
    const before = getCreditSummary(user.id).consumedSubunits;

    const result = settleOnce({
      idempotencyKey: `not-billable-${user.id}`,
      chargedUserId: user.id,
      status: "not_billable",
      creditsCharged: 0,
      usage: {},
    });

    assert.equal(result.call.status, "not_billable");
    assert.equal(result.call.creditsCharged, 0);
    assert.equal(getCreditSummary(user.id).consumedSubunits, before);
    // Still auditable: every call produces a row.
    assert.ok(
      readDb().providerCalls!.some((c) => c.id === result.call.id),
      "a non-billable call is still recorded",
    );
  });

  test("a failed call that did reach the provider is still charged", async () => {
    const user = await makeUser({ credits: 10 });
    const before = getCreditSummary(user.id).consumedSubunits;

    settleOnce({
      idempotencyKey: `failed-billed-${user.id}`,
      chargedUserId: user.id,
      status: "failed",
      errorMessage: "provider returned 500 after accepting the request",
      creditsCharged: creditsToSubunits(0.5),
    });

    assert.equal(
      getCreditSummary(user.id).consumedSubunits,
      before + creditsToSubunits(0.5),
      "billable work completed before the failure is charged",
    );
  });

  test("every settlement appends a ledger entry", async () => {
    const user = await makeUser({ credits: 10 });
    settleOnce({
      idempotencyKey: `ledger-${user.id}`,
      chargedUserId: user.id,
    });
    const entries = queryLedger({ userId: user.id });
    const charge = entries.find((e) => e.type === "charge");
    assert.ok(charge, "a charge entry exists for the settled call");
    assert.equal(charge?.provider, "sociavault");
    assert.equal(charge?.conversionRuleVersion, 1);

    // Sequence numbers are unique and gap-free per entry — append-only.
    const seqs = entries.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, "ledger seqs are unique");
  });

  test("charging more than was held is reported as an overage", async () => {
    const user = await makeUser({ credits: 10 });
    const reservation = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(1),
      operation: "test.overage",
    });
    assert.ok(reservation.ok);

    const result = settleOnce({
      idempotencyKey: `overage-${user.id}`,
      chargedUserId: user.id,
      reservationId: reservation.ok ? reservation.reservation.id : null,
      creditsCharged: creditsToSubunits(3),
      releaseSubunits: creditsToSubunits(1),
    });

    assert.ok(
      result.overageSubunits > 0,
      "an unexpected provider overage is surfaced, not hidden",
    );
  });
});

describe("timeouts and reconciliation", () => {
  test("an unknown billing outcome keeps the hold instead of assuming free", async () => {
    const user = await makeUser({ credits: 10 });
    const reservation = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(2),
      operation: "test.timeout",
    });
    assert.ok(reservation.ok);
    const reservationId = reservation.ok ? reservation.reservation.id : "";

    settleOnce({
      idempotencyKey: `timeout-${user.id}`,
      chargedUserId: user.id,
      reservationId,
      status: "timeout",
      usageConfidence: "pending_reconciliation",
      creditsCharged: creditsToSubunits(2),
      errorMessage: "request timed out; billing outcome unknown",
      releaseSubunits: 0,
    });
    releaseReservation(
      reservationId,
      "Billing outcome unknown",
      "pending_reconciliation",
    );

    const summary = getCreditSummary(user.id);
    assert.equal(summary.pendingReconciliationCount, 1);
    assert.equal(summary.reservedSubunits, creditsToSubunits(2));
    assert.equal(
      summary.consumedSubunits,
      0,
      "a pending call is not charged yet",
    );
    assert.ok(
      listPendingReconciliation().some((r) => r.id === reservationId),
      "admins can see the pending item",
    );
  });

  test("resolving a pending item as billed converts the hold to a charge", async () => {
    const user = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin", credits: 0 });
    const reservation = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(2),
      operation: "test.reconcile.billed",
    });
    assert.ok(reservation.ok);
    const reservationId = reservation.ok ? reservation.reservation.id : "";
    releaseReservation(reservationId, "unknown", "pending_reconciliation");

    const ok = resolveReconciliation({
      reservationId,
      actorUserId: admin.id,
      chargeSubunits: creditsToSubunits(2),
      reason: "Provider invoice confirms this call was billed",
    });

    assert.equal(ok, true);
    const summary = getCreditSummary(user.id);
    assert.equal(summary.consumedSubunits, creditsToSubunits(2));
    assert.equal(summary.reservedSubunits, 0);
    assert.equal(summary.pendingReconciliationCount, 0);
  });

  test("resolving a pending item as not billed returns the hold", async () => {
    const user = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin", credits: 0 });
    const reservation = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(2),
      operation: "test.reconcile.free",
    });
    assert.ok(reservation.ok);
    const reservationId = reservation.ok ? reservation.reservation.id : "";
    releaseReservation(reservationId, "unknown", "pending_reconciliation");

    resolveReconciliation({
      reservationId,
      actorUserId: admin.id,
      chargeSubunits: 0,
      reason: "Provider confirmed the request never reached billing",
    });

    const summary = getCreditSummary(user.id);
    assert.equal(summary.consumedSubunits, 0);
    assert.equal(summary.reservedSubunits, 0);
    assert.equal(summary.availableSubunits, creditsToSubunits(10));
  });
});

describe("crash recovery", () => {
  test("an abandoned reservation is recovered and its hold released", async () => {
    const user = await makeUser({ credits: 10 });
    const reservation = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(4),
      operation: "test.crash",
    });
    assert.ok(reservation.ok);
    const reservationId = reservation.ok ? reservation.reservation.id : "";

    assert.equal(
      getCreditSummary(user.id).reservedSubunits,
      creditsToSubunits(4),
    );

    // Simulate a process that died without releasing: expire the heartbeat.
    transaction((db) => {
      const row = db.creditReservations!.find((r) => r.id === reservationId)!;
      row.expiresAt = new Date(Date.now() - 60_000).toISOString();
    });

    const recovered = sweepAbandonedReservations();
    assert.ok(recovered >= 1);

    const summary = getCreditSummary(user.id);
    assert.equal(summary.reservedSubunits, 0, "the hold is returned");
    assert.equal(summary.availableSubunits, creditsToSubunits(10));

    const row = readDb().creditReservations!.find((r) => r.id === reservationId);
    assert.equal(row?.status, "expired");
    assert.ok(
      queryLedger({ userId: user.id }).some(
        (e) =>
          e.reservationId === reservationId && e.type === "reservation_release",
      ),
      "recovery is written to the ledger, not done silently",
    );
  });

  test("recovery is idempotent and never double-releases", async () => {
    const user = await makeUser({ credits: 10 });
    const reservation = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(3),
      operation: "test.crash.twice",
    });
    assert.ok(reservation.ok);
    const reservationId = reservation.ok ? reservation.reservation.id : "";
    transaction((db) => {
      const row = db.creditReservations!.find((r) => r.id === reservationId)!;
      row.expiresAt = new Date(Date.now() - 60_000).toISOString();
    });

    transaction((db) => recoverAbandonedReservations(db));
    transaction((db) => recoverAbandonedReservations(db));
    transaction((db) => recoverAbandonedReservations(db));

    const summary = getCreditSummary(user.id);
    assert.equal(summary.reservedSubunits, 0);
    assert.equal(
      summary.availableSubunits,
      creditsToSubunits(10),
      "repeat recovery does not credit the user more than once",
    );
  });
});

describe("allowances and periods", () => {
  test("changing an allowance appends a ledger entry with the admin reason", async () => {
    const user = await makeUser({ credits: 5 });
    const admin = await makeUser({ role: "admin" });

    setAllowance({
      userId: user.id,
      actorUserId: admin.id,
      reason: "Quarterly top-up approved",
      allowanceSubunits: creditsToSubunits(20),
    });

    assert.equal(
      getCreditSummary(user.id).allowanceSubunits,
      creditsToSubunits(20),
    );
    const entry = queryLedger({ userId: user.id }).find(
      (e) => e.type === "allowance_set" && e.actorUserId === admin.id,
    );
    assert.ok(entry, "the change is in the ledger");
    assert.equal(entry?.reason, "Quarterly top-up approved");
  });

  test("adjustments are new ledger entries, not edits to past charges", async () => {
    const user = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin" });
    const settled = settleOnce({
      idempotencyKey: `adjust-src-${user.id}`,
      chargedUserId: user.id,
      creditsCharged: creditsToSubunits(2),
    });
    const originalCharge = settled.call.creditsCharged;

    recordAdjustment({
      userId: user.id,
      actorUserId: admin.id,
      reason: "Goodwill refund for a provider outage",
      amountSubunits: creditsToSubunits(2),
      providerCallId: settled.call.id,
    });

    const call = readDb().providerCalls!.find((c) => c.id === settled.call.id)!;
    assert.equal(
      call.creditsCharged,
      originalCharge,
      "the historical charge is untouched",
    );
    assert.ok(
      queryLedger({ userId: user.id }).some((e) => e.type === "adjustment"),
      "the refund is a separate adjustment entry",
    );
    assert.equal(getCreditSummary(user.id).consumedSubunits, 0);
  });

  test("a negative adjustment lowers remaining credits and leaves the allowance", async () => {
    const user = await makeUser({ credits: 27 });
    const admin = await makeUser({ role: "admin" });
    const before = getCreditSummary(user.id);

    recordAdjustment({
      userId: user.id,
      actorUserId: admin.id,
      reason: "Manual correction",
      amountSubunits: parseCreditsInput("- 20")!,
    });

    const after = getCreditSummary(user.id);
    assert.equal(after.allowanceSubunits, before.allowanceSubunits);
    assert.equal(
      after.availableSubunits,
      before.availableSubunits - creditsToSubunits(20),
    );
  });

  test("a monthly reset preserves history and does not double-spend open holds", async () => {
    const user = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin" });

    settleOnce({
      idempotencyKey: `reset-history-${user.id}`,
      chargedUserId: user.id,
      creditsCharged: creditsToSubunits(3),
    });
    const openHold = reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(2),
      operation: "test.reset.hold",
    });
    assert.ok(openHold.ok);

    // Force the current period past its reset date, then touch the account.
    transaction((db) => {
      const period = db.creditPeriods!.find(
        (p) => p.userId === user.id && p.status === "current",
      )!;
      period.resetCadence = "monthly";
      period.nextResetAt = new Date(Date.now() - 60_000).toISOString();
    });
    addCredits({
      userId: user.id,
      actorUserId: admin.id,
      reason: "trigger period roll",
      amountSubunits: 1,
    });

    const periods = listPeriods(user.id);
    assert.ok(periods.length >= 2, "the previous period is preserved");
    const closed = periods.find((p) => p.status !== "current")!;
    assert.equal(
      closed.consumedSubunits,
      creditsToSubunits(3),
      "historical usage stays on the closed period",
    );

    const current = periods.find((p) => p.status === "current")!;
    assert.ok(
      availableSubunits(current) >= 0,
      "the new period never starts overdrawn",
    );
    assert.equal(
      creditsForRun("nonexistent-run").creditsCharged,
      0,
      "unrelated runs report no charge",
    );
  });
});

describe("per-user attribution", () => {
  test("run credits are scoped to the payer, not the project owner", async () => {
    const owner = await makeUser({ credits: 10 });
    const collaborator = await makeUser({ credits: 10 });
    const project = makeSearchProject({ ownerUserId: owner.id });

    settleOnce({
      idempotencyKey: `owner-spend-${project.id}`,
      chargedUserId: owner.id,
      runId: project.id,
      projectKind: "search",
      projectId: project.id,
      creditsCharged: creditsToSubunits(5),
    });
    settleOnce({
      idempotencyKey: `collab-spend-${project.id}`,
      chargedUserId: collaborator.id,
      runId: project.id,
      projectKind: "search",
      projectId: project.id,
      creditsCharged: creditsToSubunits(1),
    });

    assert.equal(
      creditsForRun(project.id, collaborator.id).creditsCharged,
      creditsToSubunits(1),
      "a collaborator sees only their own spend on a shared project",
    );
    assert.equal(
      creditsForRun(project.id, owner.id).creditsCharged,
      creditsToSubunits(5),
    );
    assert.equal(
      creditsForRun(project.id).creditsCharged,
      creditsToSubunits(6),
      "the unscoped total is available to admins",
    );
  });
});
