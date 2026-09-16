import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { Client, startTestServer, type TestServer } from "./helpers/server";

/**
 * End-to-end acceptance tests against the production build.
 *
 * These go over real HTTP with real cookies, through middleware and the route
 * handlers, which is the only way to prove the "direct API call with a modified
 * id" cases.
 *
 * No live provider is ever contacted: the server gets placeholder provider keys
 * (see helpers/server.ts) and the seeded settings disable every provider, so the
 * metering layer refuses each call before it leaves the process.
 *
 * Run with `npm run test:e2e` (it builds first).
 */

const PASSWORD = "correct-horse-battery-9";

let server: TestServer;
const ids = {
  admin: "",
  alice: "",
  bob: "",
  broke: "",
  /** Only ever used by the suspension test, so it cannot break other cases. */
  suspendable: "",
  /** Only ever used by the login-throttling test. */
  throttled: "",
  aliceSearch: "",
  aliceCompetitor: "",
  aliceLookup: "",
  legacySearch: "",
};

before(async () => {
  server = await startTestServer({
    seed: async () => {
      // Seeded in-process with the app's own libraries, then the server is
      // pointed at the same store — this is the state a real install reaches
      // through bootstrap + admin user creation.
      const { createUser, updateAppSettings } = await import("@/lib/db");
      const { PROVIDER_IDS } = await import("@/lib/types");
      const { hashPassword } = await import("@/lib/auth/password");
      const { initializeUserCredits } = await import("@/lib/accounting/service");
      const { creditsToSubunits } = await import("@/lib/accounting/units");
      const { makeSearchProject, makeLookupProject, makeCompetitor } =
        await import("./helpers/factories");

      const passwordHash = await hashPassword(PASSWORD);
      const make = (
        username: string,
        role: "admin" | "user",
        credits: number,
      ) => {
        const user = createUser({
          username,
          displayName: username,
          passwordHash,
          role,
          status: "active",
        });
        initializeUserCredits(user.id, {
          allowanceSubunits: creditsToSubunits(credits),
          resetCadence: "none",
          reason: "e2e fixture",
        });
        return user.id;
      };

      // Nothing in this suite should reach a provider. Disabling them all means
      // meterProviderCall() refuses before the network is touched, even if a
      // route's own configuration check passes.
      updateAppSettings({ disabledProviders: [...PROVIDER_IDS] }, null);

      ids.admin = make("rootadmin", "admin", 500);
      ids.alice = make("alice", "user", 500);
      ids.bob = make("bob", "user", 500);
      ids.broke = make("broke", "user", 0);
      ids.suspendable = make("suspendme", "user", 500);
      ids.throttled = make("throttled", "user", 500);

      ids.aliceSearch = makeSearchProject({
        ownerUserId: ids.alice,
        keyword: "alice private keyword",
      }).id;
      ids.aliceCompetitor = makeCompetitor({ runId: ids.aliceSearch }).id;
      ids.aliceLookup = makeLookupProject({
        ownerUserId: ids.alice,
        queryName: "alice private brand",
      }).id;
      // A row from before the migration: no owner.
      ids.legacySearch = makeSearchProject({
        ownerUserId: null,
        keyword: "legacy keyword",
      }).id;
    },
  });
});

after(async () => {
  await server?.stop();
});

function client() {
  return new Client(server.baseUrl);
}

async function loggedIn(username: string) {
  const c = client();
  const res = await c.login(username, PASSWORD);
  assert.equal(res.status, 200, `${username} could not sign in`);
  assert.ok(c.hasSession, `${username} received no session cookie`);
  return c;
}

describe("unauthenticated access", () => {
  test("API routes reject anonymous callers", async () => {
    const anon = client();
    for (const path of [
      "/api/auth/me",
      "/api/history/unified",
      "/api/projects",
      "/api/credits/summary",
      `/api/search/status?jobId=${ids.aliceSearch}`,
      `/api/competitors?runId=${ids.aliceSearch}`,
      `/api/export?jobId=${ids.aliceSearch}`,
    ]) {
      const res = await anon.get(path);
      assert.equal(res.status, 401, `${path} should be 401`);
    }
    const post = await anon.post("/api/search", { keyword: "x", geo: "AU" });
    assert.equal(post.status, 401);
  });

  test("pages redirect to the login screen", async () => {
    const anon = client();
    const res = await anon.get("/");
    assert.equal(res.status, 307);
    assert.match(res.headers.get("location") ?? "", /\/login/);
  });

  test("a wrong password does not create a session", async () => {
    const c = client();
    const res = await c.login("alice", "not-the-password");
    assert.equal(res.status, 401);
    assert.equal(c.hasSession, false);
    assert.equal((await c.get("/api/auth/me")).status, 401);
  });

  test("bootstrap refuses to run once an admin exists", async () => {
    const anon = client();
    const status = await anon.get("/api/admin/bootstrap");
    assert.equal(status.status, 200);
    const body = (await status.json()) as { needsBootstrap: boolean };
    assert.equal(body.needsBootstrap, false);

    const attempt = await anon.post("/api/admin/bootstrap", { token: "guess" });
    assert.equal(attempt.status, 403);
  });
});

describe("user A cannot reach user B's resources", () => {
  test("reads, polls, downloads and exports all 404 for a non-owner", async () => {
    const bob = await loggedIn("bob");

    // Every one of these carries a valid, existing id that belongs to alice.
    const cases: Array<[string, string]> = [
      ["status poll", `/api/search/status?jobId=${ids.aliceSearch}`],
      ["competitor read", `/api/competitors?runId=${ids.aliceSearch}`],
      ["xlsx download", `/api/export?jobId=${ids.aliceSearch}`],
      ["lookup poll", `/api/lookup/status?lookupId=${ids.aliceLookup}`],
      ["lookup export", `/api/lookup/export?lookupId=${ids.aliceLookup}`],
    ];
    for (const [label, path] of cases) {
      const res = await bob.get(path);
      assert.equal(res.status, 404, `${label} leaked (${res.status})`);
    }
  });

  test("a non-owner cannot mutate or stop someone else's run", async () => {
    const bob = await loggedIn("bob");

    for (const [label, body] of [
      ["by jobId", { jobId: ids.aliceSearch }],
      ["by lookupId", { lookupId: ids.aliceLookup }],
    ] as const) {
      const stop = await bob.post("/api/stop", body);
      assert.equal(stop.status, 404, `stop ${label} returned ${stop.status}`);
    }

    const stopSearch = await bob.post("/api/search/stop", {
      jobId: ids.aliceSearch,
    });
    assert.equal(stopSearch.status, 404);

    // "Stop everything" means "everything of mine" — alice's run is untouched.
    const stopAll = await bob.post("/api/stop", { all: true });
    assert.equal(stopAll.status, 200);
    const stopped = (await stopAll.json()) as { searchJobIds: string[] };
    assert.deepEqual(stopped.searchJobIds, []);

    // A real competitor id from alice's run — the id is valid, the access is not.
    const recreate = await bob.post("/api/competitors/recreate-page", {
      competitorId: ids.aliceCompetitor,
    });
    assert.equal(recreate.status, 404, `recreate returned ${recreate.status}`);

    const analyze = await bob.post("/api/competitors/analyze-page", {
      competitorId: ids.aliceCompetitor,
    });
    assert.equal(analyze.status, 404);

    // Deleting from someone else's history is refused too.
    const del = await bob.delete(
      `/api/history/unified?kind=search&runId=${ids.aliceSearch}`,
    );
    assert.equal(del.status, 404);
  });

  test("listings are scoped per user", async () => {
    const alice = await loggedIn("alice");
    const bob = await loggedIn("bob");

    const aliceProjects = (await (await alice.get("/api/projects")).json()) as {
      mine: Array<{ id: string }>;
      sharedWithMe: Array<{ id: string }>;
    };
    assert.ok(
      aliceProjects.mine.some((p) => p.id === ids.aliceSearch),
      "alice sees her own project",
    );
    assert.equal(aliceProjects.sharedWithMe.length, 0);

    const bobProjects = (await (await bob.get("/api/projects")).json()) as {
      mine: Array<{ id: string }>;
      sharedWithMe: Array<{ id: string }>;
    };
    assert.equal(bobProjects.mine.length, 0);
    assert.equal(bobProjects.sharedWithMe.length, 0);

    // The unfiltered competitor listing must not fall back to "everything".
    const bobCompetitors = (await (await bob.get("/api/competitors")).json()) as {
      competitors: Array<{ runId: string }>;
    };
    assert.equal(
      bobCompetitors.competitors.filter((c) => c.runId === ids.aliceSearch).length,
      0,
    );

    const bobHistory = (await (
      await bob.get("/api/history/unified")
    ).json()) as { runs: Array<{ id: string }> };
    assert.equal(bobHistory.runs.length, 0, "bob's history is empty");

    const aliceHistory = (await (
      await alice.get("/api/history/unified")
    ).json()) as { runs: Array<{ id: string; accessRole: string }> };
    const own = aliceHistory.runs.find((r) => r.id === ids.aliceSearch);
    assert.equal(own?.accessRole, "owner");
  });

  test("legacy unassigned projects are invisible to everyone but admins", async () => {
    const alice = await loggedIn("alice");
    assert.equal(
      (await alice.get(`/api/search/status?jobId=${ids.legacySearch}`)).status,
      404,
    );
    assert.equal(
      (await alice.get(`/api/competitors?runId=${ids.legacySearch}`)).status,
      404,
    );

    const admin = await loggedIn("rootadmin");
    const res = await admin.get("/api/admin/projects?unassignedOnly=1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { projects: Array<{ id: string }> };
    assert.ok(
      body.projects.some((p) => p.id === ids.legacySearch),
      "the legacy row is listed in the admin assignment area",
    );
  });
});

describe("privilege escalation", () => {
  test("a regular user cannot reach any admin endpoint", async () => {
    const bob = await loggedIn("bob");
    for (const path of [
      "/api/admin/overview",
      "/api/admin/users",
      "/api/admin/usage",
      "/api/admin/projects",
      "/api/admin/settings",
    ]) {
      const res = await bob.get(path);
      assert.equal(res.status, 403, `${path} returned ${res.status}`);
    }
    assert.equal((await bob.get("/admin")).status, 307);
  });

  test("a regular user cannot promote themselves", async () => {
    const bob = await loggedIn("bob");
    const res = await bob.patch(`/api/admin/users/${ids.bob}`, { role: "admin" });
    assert.equal(res.status, 403);

    // Confirm from the admin side that the role really did not change.
    const admin = await loggedIn("rootadmin");
    const check = (await (
      await admin.get(`/api/admin/users/${ids.bob}`)
    ).json()) as { user: { role: string } };
    assert.equal(check.user.role, "user");
  });

  test("public signup cannot request the admin role", async () => {
    const admin = await loggedIn("rootadmin");
    assert.equal(
      (await admin.put("/api/admin/settings", { publicSignupEnabled: true })).status,
      200,
    );

    const c = client();
    const res = await c.post("/api/auth/register", {
      username: "sneaky",
      displayName: "Sneaky",
      password: PASSWORD,
      confirmPassword: PASSWORD,
      // Ignored: the route hardcodes role "user".
      role: "admin",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: { id: string; role: string } };
    assert.equal(body.user.role, "user");

    // The new account has no admin access and, by default, no credits.
    assert.equal((await c.get("/api/admin/users")).status, 403);
    const credits = (await (await c.get("/api/credits/summary")).json()) as {
      credits: { allowanceSubunits: number };
      canStartRun: { ok: boolean; reason?: string };
    };
    assert.equal(credits.credits.allowanceSubunits, 0);
    assert.equal(credits.canStartRun.ok, false);
    assert.equal(credits.canStartRun.reason, "insufficient_credits");

    await admin.put("/api/admin/settings", { publicSignupEnabled: false });
    const closed = await client().post("/api/auth/register", {
      username: "toolate",
      displayName: "Too Late",
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    assert.equal(closed.status, 403, "signup is refused once the admin closes it");
  });
});

describe("credit enforcement over HTTP", () => {
  test("a zero-credit user is refused with 402 before any provider call", async () => {
    const broke = await loggedIn("broke");
    const res = await broke.post("/api/search", {
      keyword: "plumber melbourne",
      geo: "AU",
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "insufficient_credits");
    assert.match(body.error, /Contact your administrator/i);

    const lookup = await broke.post("/api/lookup", { query: "someone" });
    assert.equal(lookup.status, 402);
  });

  test("a funded user clears the credit gate but no provider is ever billed", async () => {
    const alice = await loggedIn("alice");
    const res = await alice.post("/api/search", {
      keyword: "plumber melbourne",
      geo: "AU",
    });
    // The run is accepted, which is the point: the credit gate passed.
    assert.equal(res.status, 200);
    const { jobId } = (await res.json()) as { jobId: string };
    assert.ok(jobId);

    // Every provider is disabled, so the first metered step is refused and the
    // run fails without spending anything.
    let job: { status: string; progress?: { message?: string } } | undefined;
    for (let i = 0; i < 40; i += 1) {
      const poll = await alice.get(`/api/search/status?jobId=${jobId}`);
      assert.equal(poll.status, 200);
      job = ((await poll.json()) as { job: typeof job }).job;
      if (job && job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(job?.status, "failed", "the run stopped instead of spending");
    assert.match(
      job?.progress?.message ?? "",
      /disabled by your administrator/i,
      "the real reason reaches the user rather than a generic 'no results'",
    );

    const summary = (await (await alice.get("/api/credits/summary")).json()) as {
      credits: { consumedSubunits: number; reservedSubunits: number };
    };
    assert.equal(
      summary.credits.consumedSubunits,
      0,
      "a call that never reached a provider is not charged",
    );
    assert.equal(
      summary.credits.reservedSubunits,
      0,
      "the failed run released its hold",
    );

    // The blocked attempt is still visible in usage history, not swallowed.
    const usage = (await (
      await alice.get(`/api/credits/usage?projectId=${jobId}`)
    ).json()) as { rows: Array<{ status: string; creditsCharged: number }> };
    for (const row of usage.rows) {
      assert.equal(row.creditsCharged, 0);
    }
  });

  test("a suspended account is signed out and cannot sign back in", async () => {
    const admin = await loggedIn("rootadmin");
    const victim = await loggedIn("suspendme");
    assert.equal((await victim.get("/api/auth/me")).status, 200);

    assert.equal(
      (
        await admin.patch(`/api/admin/users/${ids.suspendable}`, {
          status: "suspended",
        })
      ).status,
      200,
    );

    // The open session dies on its next request, not at its next login.
    assert.equal((await victim.get("/api/auth/me")).status, 401);
    assert.equal((await victim.post("/api/search", { keyword: "x" })).status, 401);

    // A fresh login is refused with the same generic message as a bad password,
    // so the endpoint does not disclose that the account exists but is locked.
    const retry = client();
    const res = await retry.login("suspendme", PASSWORD);
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { error: string }).error, /Invalid/i);
    assert.equal(retry.hasSession, false);

    // Reactivation restores access.
    await admin.patch(`/api/admin/users/${ids.suspendable}`, { status: "active" });
    assert.equal((await client().login("suspendme", PASSWORD)).status, 200);
  });

  test("repeated failed logins are throttled", async () => {
    const c = client();
    let sawLockout = false;
    for (let i = 0; i < 10; i += 1) {
      const res = await c.login("throttled", `wrong-password-${i}`);
      if (res.status === 429) {
        sawLockout = true;
        break;
      }
      assert.equal(res.status, 401);
    }
    assert.ok(sawLockout, "brute forcing one username is eventually locked out");

    // The lockout holds even once the correct password is supplied.
    const withRealPassword = await c.login("throttled", PASSWORD);
    assert.equal(withRealPassword.status, 429);
    assert.equal(c.hasSession, false);
  });

  test("the credit dashboard only ever shows the caller's own numbers", async () => {
    const alice = await loggedIn("alice");
    const res = await alice.get("/api/credits/summary");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      credits: { allowanceSubunits: number; availableSubunits: number };
      usageByProvider: unknown[];
      recentRuns: Array<{ projectId: string }>;
    };
    // Alice's own allowance, and only runs from projects she can see.
    assert.equal(body.credits.allowanceSubunits, 500 * 10_000);
    assert.ok(
      body.recentRuns.every((r) => r.projectId !== ids.legacySearch),
      "no runs from projects outside her workspace",
    );

    const usage = (await (
      await alice.get(`/api/credits/usage?projectId=${ids.aliceSearch}`)
    ).json()) as { projects: Array<{ id: string }> };
    assert.ok(
      usage.projects.every((p) => p.id !== ids.legacySearch),
      "the project filter list contains only projects alice can see",
    );

    // Filtering by a project she cannot see yields nothing rather than data.
    const foreign = (await (
      await alice.get(`/api/credits/usage?projectId=${ids.legacySearch}`)
    ).json()) as { rows: unknown[]; total: number };
    assert.equal(foreign.rows.length, 0);
    assert.equal(foreign.total, 0);
  });
});

describe("admin-controlled sharing over HTTP", () => {
  test("a viewer can read the shared project but cannot run in it", async () => {
    const admin = await loggedIn("rootadmin");
    const grant = await admin.post("/api/admin/projects/share", {
      projectKind: "search",
      projectId: ids.aliceSearch,
      userId: ids.bob,
      role: "viewer",
    });
    assert.equal(grant.status, 200);

    const bob = await loggedIn("bob");
    const read = await bob.get(`/api/search/status?jobId=${ids.aliceSearch}`);
    assert.equal(read.status, 200);
    const body = (await read.json()) as {
      access: { role: string; ownerIsSelf: boolean };
      credits: { runCreditsCharged: number };
    };
    assert.equal(body.access.role, "viewer");
    assert.equal(body.access.ownerIsSelf, false);

    // The shared project appears under "Shared with me", with the owner named.
    const projects = (await (await bob.get("/api/projects")).json()) as {
      mine: Array<{ id: string }>;
      sharedWithMe: Array<{
        id: string;
        accessRole: string;
        ownerDisplayName: string;
      }>;
    };
    assert.equal(projects.mine.length, 0);
    const shared = projects.sharedWithMe.find((p) => p.id === ids.aliceSearch);
    assert.equal(shared?.accessRole, "viewer");
    assert.equal(shared?.ownerDisplayName, "alice");

    // Read-only: a run attempt is refused with 403 (visible but not permitted),
    // rather than the 404 a non-member gets.
    const run = await bob.post("/api/competitors/recreate-page", {
      competitorId: ids.aliceCompetitor,
    });
    assert.equal(run.status, 403);
    assert.match(
      ((await run.json()) as { error: string }).error,
      /view-only/i,
    );

    // And a viewer cannot stop or delete the project either.
    assert.equal(
      (await bob.post("/api/stop", { jobId: ids.aliceSearch })).status,
      403,
    );
    assert.equal(
      (
        await bob.delete(
          `/api/history/unified?kind=search&runId=${ids.aliceSearch}`,
        )
      ).status,
      403,
    );

    // Sharing one project does not expose alice's other project.
    assert.equal(
      (await bob.get(`/api/lookup/status?lookupId=${ids.aliceLookup}`)).status,
      404,
    );
  });

  test("a share does not expose the owner's balance or credentials", async () => {
    const bob = await loggedIn("bob");
    const raw = await (
      await bob.get(`/api/search/status?jobId=${ids.aliceSearch}`)
    ).text();
    assert.equal(raw.includes("passwordHash"), false);
    assert.equal(raw.includes("allowanceSubunits"), false);

    // The credit figures returned with a shared project are the *viewer's*.
    const body = JSON.parse(raw) as {
      credits: { runCreditsCharged: number; availableSubunits: number };
    };
    const own = (await (await bob.get("/api/credits/summary")).json()) as {
      credits: { availableSubunits: number };
    };
    assert.equal(
      body.credits.availableSubunits,
      own.credits.availableSubunits,
      "the balance shown alongside a shared project is the viewer's own",
    );

    // Bob still cannot see alice's account or her other projects.
    assert.equal((await bob.get(`/api/admin/users/${ids.alice}`)).status, 403);
    const projects = (await (await bob.get("/api/projects")).json()) as {
      sharedWithMe: Array<{ id: string }>;
    };
    assert.deepEqual(
      projects.sharedWithMe.map((p) => p.id),
      [ids.aliceSearch],
      "only the one shared project is visible",
    );
  });

  test("revoking a share cuts access off on the very next request", async () => {
    const admin = await loggedIn("rootadmin");
    const bob = await loggedIn("bob");
    assert.equal(
      (await bob.get(`/api/search/status?jobId=${ids.aliceSearch}`)).status,
      200,
    );

    const revoke = await admin.delete(
      `/api/admin/projects/share?projectKind=search&projectId=${ids.aliceSearch}&userId=${ids.bob}`,
    );
    assert.equal(revoke.status, 200);

    assert.equal(
      (await bob.get(`/api/search/status?jobId=${ids.aliceSearch}`)).status,
      404,
      "access ends immediately, with no grace period",
    );
    const projects = (await (await bob.get("/api/projects")).json()) as {
      sharedWithMe: unknown[];
    };
    assert.equal(projects.sharedWithMe.length, 0);
  });
});

describe("password lifecycle", () => {
  test("an admin reset signs the user out everywhere and forces a change", async () => {
    const admin = await loggedIn("rootadmin");
    const alice = await loggedIn("alice");
    const aliceSecondDevice = await loggedIn("alice");
    assert.equal((await alice.get("/api/auth/me")).status, 200);

    const reset = await admin.post(`/api/admin/users/${ids.alice}/password`);
    assert.equal(reset.status, 200);
    const { temporaryPassword } = (await reset.json()) as {
      temporaryPassword: string;
    };
    assert.ok(temporaryPassword && temporaryPassword.length >= 12);

    // Both of alice's sessions are dead.
    assert.equal((await alice.get("/api/auth/me")).status, 401);
    assert.equal((await aliceSecondDevice.get("/api/auth/me")).status, 401);

    // The old password no longer works.
    assert.equal((await client().login("alice", PASSWORD)).status, 401);

    // The temporary one works but everything else is gated on changing it.
    const fresh = client();
    const login = await fresh.login("alice", temporaryPassword);
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { mustChangePassword: boolean };
    assert.equal(loginBody.mustChangePassword, true);
    assert.equal(
      (await fresh.get("/api/history/unified")).status,
      403,
      "a pending password change blocks normal API use",
    );

    const change = await fresh.post("/api/auth/change-password", {
      currentPassword: temporaryPassword,
      newPassword: PASSWORD,
      confirmPassword: PASSWORD,
    });
    assert.equal(change.status, 200);
    assert.equal((await fresh.get("/api/history/unified")).status, 200);
  });

  test("changing a password invalidates the other sessions of that account", async () => {
    const first = await loggedIn("alice");
    const second = await loggedIn("alice");
    const newPassword = "another-good-password-7";

    const change = await first.post("/api/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword,
      confirmPassword: newPassword,
    });
    assert.equal(change.status, 200);

    assert.equal(
      (await second.get("/api/auth/me")).status,
      401,
      "the other device is signed out",
    );
    // The device that made the change keeps working via its refreshed cookie.
    assert.equal((await first.get("/api/auth/me")).status, 200);

    // Put the fixture password back for any later test.
    await first.post("/api/auth/change-password", {
      currentPassword: newPassword,
      newPassword: PASSWORD,
      confirmPassword: PASSWORD,
    });
  });
});

describe("soft deletion", () => {
  test("a deleted account loses access immediately and its projects are handled", async () => {
    const admin = await loggedIn("rootadmin");

    // A throwaway account with a project of its own.
    const created = await admin.post("/api/admin/users", {
      username: "tempuser",
      displayName: "Temp User",
      allowanceCredits: "10",
    });
    assert.equal(created.status, 200);
    const { user, temporaryPassword } = (await created.json()) as {
      user: { id: string };
      temporaryPassword: string;
    };

    const temp = client();
    assert.equal((await temp.login("tempuser", temporaryPassword)).status, 200);

    // The admin must say what happens to the projects — no silent default.
    const noAction = await admin.delete(`/api/admin/users/${user.id}`);
    assert.equal(noAction.status, 400);
    assert.equal(
      ((await noAction.json()) as { code: string }).code,
      "projects_action_required",
    );
    assert.equal((await temp.get("/api/auth/me")).status, 200, "still active");

    const del = await admin.delete(
      `/api/admin/users/${user.id}?projects=unassign`,
    );
    assert.equal(del.status, 200);

    assert.equal((await temp.get("/api/auth/me")).status, 401);
    const relogin = client();
    assert.equal((await relogin.login("tempuser", temporaryPassword)).status, 401);
    assert.equal(relogin.hasSession, false);

    // The account is retained for billing history rather than erased.
    const list = (await (
      await admin.get("/api/admin/users?status=deleted")
    ).json()) as { users: Array<{ id: string; status: string }> };
    assert.ok(
      list.users.some((u) => u.id === user.id && u.status === "deleted"),
      "the soft-deleted account is still on record",
    );
  });
});

describe("existing functionality still works", () => {
  test("the signed-in app shell, history and health endpoints all respond", async () => {
    const alice = await loggedIn("alice");

    const page = await alice.get("/");
    assert.equal(page.status, 200);

    for (const path of [
      "/api/auth/me",
      "/api/history",
      "/api/history/unified",
      "/api/lookup/history",
      "/api/projects",
      "/api/credits/summary",
      "/api/credits/usage",
    ]) {
      const res = await alice.get(path);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
    }

    // Alice's own project is still fully readable end to end.
    const status = await alice.get(`/api/search/status?jobId=${ids.aliceSearch}`);
    assert.equal(status.status, 200);
    const body = (await status.json()) as {
      job: { keyword: string };
      access: { role: string; ownerIsSelf: boolean };
    };
    assert.equal(body.job.keyword, "alice private keyword");
    assert.equal(body.access.role, "owner");
    assert.equal(body.access.ownerIsSelf, true);

    const health = await client().get("/api/health");
    assert.equal(health.status, 200);
  });

  test("the admin dashboard endpoints all respond for an admin", async () => {
    const admin = await loggedIn("rootadmin");
    for (const path of [
      "/api/admin/overview",
      "/api/admin/users",
      "/api/admin/usage",
      "/api/admin/projects",
      "/api/admin/settings",
    ]) {
      const res = await admin.get(path);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
    }
    assert.equal((await admin.get("/admin")).status, 200);
  });

  test("admin screens report key configuration without revealing secrets", async () => {
    const admin = await loggedIn("rootadmin");
    const raw = await (await admin.get("/api/admin/settings")).text();
    assert.match(raw, /providerKeyConfigured/);
    // Only booleans, never a value.
    const body = JSON.parse(raw) as {
      providerKeyConfigured: Record<string, unknown>;
    };
    for (const [provider, value] of Object.entries(body.providerKeyConfigured)) {
      assert.equal(typeof value, "boolean", `${provider} exposed a non-boolean`);
    }
    assert.equal(raw.includes("SESSION_SECRET"), false);
    assert.equal(raw.includes("e2e-session-secret"), false);
  });
});
