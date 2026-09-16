import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("run-gating");
after(() => store.cleanup());

const { makeUser, makeSearchProject } = await import("./helpers/factories");
const { runBillable, precheckRun, reportRunCredits, TooManyConcurrentRunsError } =
  await import("@/lib/accounting/run");
const { meterProviderCall, singleRequestUsage } = await import(
  "@/lib/accounting/meter"
);
const {
  InsufficientCreditsError,
  ProviderNotPermittedError,
  SpendAuthorizationRevokedError,
  isCreditError,
} = await import("@/lib/accounting/errors");
const { getCreditSummary, queryProviderCalls } = await import(
  "@/lib/accounting/service"
);
const { creditsToSubunits, subunitsToCredits } = await import(
  "@/lib/accounting/units"
);
const { getUserById, updateUser, updateAppSettings } = await import("@/lib/db");
const { upsertMembership } = await import("@/lib/accounting/records");
const { resolveProjectAccess, canRunInProject } = await import("@/lib/authz");

/** Bodies of every `catch` block in a source file, matched brace for brace. */
function catchBodies(source: string): string[] {
  const bodies: string[] = [];
  const opener = /catch\s*(\([^)]*\))?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    bodies.push(source.slice(start, i - 1).trim());
  }
  return bodies;
}

/** A stand-in for a paid provider call that records whether it was reached. */
function fakeProviderCall(spy: { calls: number }) {
  return meterProviderCall(
    {
      provider: "sociavault",
      endpoint: "/v1/company-ads",
      operation: "sociavault.company-ads",
      extractUsage: () => singleRequestUsage("req_test"),
    },
    async () => {
      spy.calls += 1;
      return { ok: true };
    },
  );
}

describe("hard enforcement before any provider is contacted", () => {
  test("a zero-credit user is rejected and no provider call is made", async () => {
    const user = await makeUser({ credits: 0 });
    const project = makeSearchProject({ ownerUserId: user.id });
    const spy = { calls: 0 };

    await assert.rejects(
      () =>
        runBillable(
          {
            user,
            operation: "search.run",
            projectKind: "search",
            projectId: project.id,
            runId: project.id,
          },
          () => fakeProviderCall(spy),
        ),
      (err: unknown) => {
        assert.ok(err instanceof InsufficientCreditsError);
        assert.equal(isCreditError(err), true);
        assert.match(
          (err as Error).message,
          /do not have enough credits|Contact your administrator/i,
        );
        return true;
      },
    );
    assert.equal(spy.calls, 0, "the provider was never contacted");

    // Nothing was recorded as spend, and the precheck agrees with the outcome.
    assert.equal(getCreditSummary(user.id).consumedSubunits, 0);
    const pre = precheckRun(user);
    assert.equal(pre.ok, false);
    assert.equal(pre.reason, "insufficient_credits");
  });

  test("a suspended user is rejected even with a positive balance", async () => {
    const user = await makeUser({ credits: 100 });
    const project = makeSearchProject({ ownerUserId: user.id });
    updateUser(user.id, { status: "suspended", bumpSessionEpoch: true });
    const suspended = getUserById(user.id)!;
    const spy = { calls: 0 };

    await assert.rejects(
      () =>
        runBillable(
          {
            user: suspended,
            operation: "search.run",
            projectKind: "search",
            projectId: project.id,
            runId: project.id,
          },
          () => fakeProviderCall(spy),
        ),
      SpendAuthorizationRevokedError,
    );
    assert.equal(spy.calls, 0);
    assert.equal(precheckRun(suspended).reason, "suspended");
  });

  test("an unmetered provider call is refused outright", async () => {
    // No billing context means no ledger row, so the wrapper must throw rather
    // than let unbilled spend through on a shared API key.
    await assert.rejects(
      () => fakeProviderCall({ calls: 0 }),
      /without a billing context/i,
    );
  });

  test("a provider disabled by an admin is blocked before the call", async () => {
    const user = await makeUser({ credits: 100 });
    const project = makeSearchProject({ ownerUserId: user.id });
    updateAppSettings({ disabledProviders: ["sociavault"] }, null);
    const spy = { calls: 0 };

    await assert.rejects(
      () =>
        runBillable(
          {
            user,
            operation: "search.run",
            projectKind: "search",
            projectId: project.id,
            runId: project.id,
          },
          () => fakeProviderCall(spy),
        ),
      ProviderNotPermittedError,
    );
    assert.equal(spy.calls, 0);
    updateAppSettings({ disabledProviders: [] }, null);
  });

  test("the concurrency limit is enforced on the server", async () => {
    const user = await makeUser({ credits: 500 });
    const project = makeSearchProject({ ownerUserId: user.id });
    updateAppSettings({ maxConcurrentRunsPerUser: 1 }, null);

    // Hold the first run open while the second one tries to start.
    let releaseFirst: () => void = () => {};
    const firstDone = runBillable(
      {
        user,
        operation: "search.run",
        projectKind: "search",
        projectId: project.id,
        runId: project.id,
      },
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );

    await assert.rejects(
      () =>
        runBillable(
          {
            user,
            operation: "search.run",
            projectKind: "search",
            projectId: project.id,
            runId: `${project.id}-b`,
          },
          async () => undefined,
        ),
      TooManyConcurrentRunsError,
    );

    releaseFirst();
    await firstDone;
    updateAppSettings({ maxConcurrentRunsPerUser: 3 }, null);
  });
});

describe("who pays inside a shared project", () => {
  test("a shared editor is charged against their own allowance, not the owner's", async () => {
    const owner = await makeUser({ credits: 100 });
    const editor = await makeUser({ credits: 100 });
    const admin = await makeUser({ role: "admin" });
    const project = makeSearchProject({ ownerUserId: owner.id });

    upsertMembership({
      projectKind: "search",
      projectId: project.id,
      userId: editor.id,
      role: "editor",
      grantedByUserId: admin.id,
    });

    const access = resolveProjectAccess("search", project.id, editor, "run");
    assert.equal(canRunInProject(access), true);

    const spy = { calls: 0 };
    await runBillable(
      {
        user: editor,
        operation: "search.run",
        projectKind: "search",
        projectId: project.id,
        runId: `${project.id}-editor-run`,
      },
      () => fakeProviderCall(spy),
    );
    assert.equal(spy.calls, 1);

    const editorSummary = getCreditSummary(editor.id);
    const ownerSummary = getCreditSummary(owner.id);
    assert.ok(
      editorSummary.consumedSubunits > 0,
      "the editor who ran the task paid for it",
    );
    assert.equal(
      ownerSummary.consumedSubunits,
      0,
      "the project owner was not charged for someone else's run",
    );
    assert.equal(
      ownerSummary.reservedSubunits,
      0,
      "no hold leaked onto the owner's balance",
    );

    // Both holds are closed out, so available is back to allowance - consumed.
    assert.equal(editorSummary.reservedSubunits, 0);
    assert.equal(
      editorSummary.availableSubunits,
      editorSummary.allowanceSubunits - editorSummary.consumedSubunits,
    );

    // The call is attributed to the editor as both initiator and payer.
    const { rows } = queryProviderCalls({ runId: `${project.id}-editor-run` });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chargedUserId, editor.id);
    assert.equal(rows[0].initiatedByUserId, editor.id);
    assert.equal(rows[0].projectId, project.id);

    // And the run summary the UI shows reports only the editor's own spend.
    const report = reportRunCredits(editor.id, `${project.id}-editor-run`);
    assert.ok(report.runCreditsCharged > 0);
    assert.equal(report.pendingCalls, 0);
    assert.equal(
      reportRunCredits(owner.id, `${project.id}-editor-run`).runCreditsCharged,
      0,
    );
  });

  test("a viewer cannot start a run at all", async () => {
    const owner = await makeUser({ credits: 100 });
    const viewer = await makeUser({ credits: 100 });
    const admin = await makeUser({ role: "admin" });
    const project = makeSearchProject({ ownerUserId: owner.id });

    upsertMembership({
      projectKind: "search",
      projectId: project.id,
      userId: viewer.id,
      role: "viewer",
      grantedByUserId: admin.id,
    });

    // The API resolves access before it ever reaches runBillable.
    assert.throws(
      () => resolveProjectAccess("search", project.id, viewer, "run"),
      /view-only/i,
    );
    assert.equal(
      canRunInProject(
        resolveProjectAccess("search", project.id, viewer, "view"),
      ),
      false,
    );
    assert.equal(getCreditSummary(viewer.id).consumedSubunits, 0);
  });
});

describe("authorization revoked mid-run", () => {
  test("suspending a user stops the next paid step of a running job", async () => {
    const user = await makeUser({ credits: 500 });
    const project = makeSearchProject({ ownerUserId: user.id });
    const spy = { calls: 0 };

    await assert.rejects(
      () =>
        runBillable(
          {
            user,
            operation: "search.run",
            projectKind: "search",
            projectId: project.id,
            runId: `${project.id}-revoked`,
          },
          async () => {
            // First paid step succeeds …
            await fakeProviderCall(spy);
            // … then an admin suspends the account mid-run.
            updateUser(user.id, { status: "suspended", bumpSessionEpoch: true });
            // The next paid step must not reach the provider.
            await fakeProviderCall(spy);
          },
        ),
      SpendAuthorizationRevokedError,
    );

    assert.equal(spy.calls, 1, "only the pre-suspension step ran");

    // The work already done is still charged — we do not hand back credits for
    // provider usage that actually happened.
    const { rows } = queryProviderCalls({ runId: `${project.id}-revoked` });
    const succeeded = rows.filter((r) => r.status === "succeeded");
    assert.equal(succeeded.length, 1);
    assert.ok(succeeded[0].creditsCharged > 0);

    // And the hold from the interrupted run is not left dangling.
    assert.equal(getCreditSummary(user.id).reservedSubunits, 0);
  });
});

describe("credit failures are never swallowed by a pipeline step", () => {
  test("the pipeline's per-step error handling rethrows credit errors", async () => {
    // The discovery loops catch provider errors and move on to the next query.
    // A credit or authorization failure must not be absorbed that way, or the
    // run would report "no competitors found" instead of "out of credits".
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    for (const file of ["finder.ts", "lookup.ts"]) {
      const source = readFileSync(
        join(process.cwd(), "src", "lib", "pipeline", file),
        "utf8",
      );
      const blocks = catchBodies(source);
      assert.ok(blocks.length > 0, `${file} has catch blocks to check`);

      for (const [i, body] of blocks.entries()) {
        // A catch that recovers and carries on must let credit errors out first.
        const recoversAndContinues =
          /\b(continue|break)\b/.test(body) || /activeCount\s*=/.test(body);
        if (!recoversAndContinues) continue;
        assert.match(
          body,
          /isCreditError\(\w*\)\)?\s*throw/,
          `${file} catch block #${i + 1} swallows credit errors:\n${body}`,
        );
      }
    }
  });
});

describe("run reporting", () => {
  test("the post-run line reports this run's spend and the remaining balance", async () => {
    const user = await makeUser({ credits: 200 });
    const project = makeSearchProject({ ownerUserId: user.id });
    const runId = `${project.id}-report`;

    await runBillable(
      {
        user,
        operation: "search.run",
        projectKind: "search",
        projectId: project.id,
        runId,
      },
      async () => {
        await fakeProviderCall({ calls: 0 });
        await fakeProviderCall({ calls: 0 });
      },
    );

    const report = reportRunCredits(user.id, runId);
    const summary = getCreditSummary(user.id);

    // "This run used X credits. You have Y credits available."
    assert.ok(report.runCreditsCharged > 0);
    assert.equal(report.availableSubunits, summary.availableSubunits);
    assert.equal(
      report.availableSubunits,
      creditsToSubunits(200) - summary.consumedSubunits,
    );
    assert.ok(
      subunitsToCredits(summary.consumedSubunits) <= 200,
      "a run cannot consume more than the allowance",
    );
  });
});
