import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test, { describe } from "node:test";

/**
 * A structural guard rather than a behavioural test: it walks every API route
 * and fails when one neither authorizes its caller nor is on the explicit
 * public allowlist. Adding a route without authorization breaks the build here
 * instead of silently shipping an open endpoint.
 */

const API_ROOT = join(process.cwd(), "src", "app", "api");

/** Endpoints that are unauthenticated by design. */
const PUBLIC_ROUTES = new Set([
  "auth/login", // issues the session
  "auth/logout", // clears the cookie; nothing to authorize
  "auth/register", // gated by the publicSignupEnabled setting instead
  "auth/status", // advertises whether signup/bootstrap are open
  "admin/bootstrap", // gated by ADMIN_BOOTSTRAP_TOKEN, only works with 0 admins
  "health", // liveness probe, returns no user data
]);

/** Routes that must require an admin, not merely a signed-in user. */
const ADMIN_PREFIX = "admin/";

/** Admin routes with a documented non-session credential path. */
const ADMIN_ROUTES_WITH_SECRET = new Set([
  "admin/import-history", // HISTORY_IMPORT_SECRET for deploy tooling
]);

const AUTH_CALLS = [
  "requireUser(",
  "requireAdmin(",
  "getSessionUser(",
  "resolveProjectAccess(",
];

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findRouteFiles(full));
    } else if (entry === "route.ts" || entry === "route.tsx") {
      out.push(full);
    }
  }
  return out;
}

/** "src/app/api/search/stop/route.ts" -> "search/stop" */
function routeName(file: string): string {
  return relative(API_ROOT, file)
    .split(sep)
    .slice(0, -1)
    .join("/");
}

const routes = findRouteFiles(API_ROOT).map((file) => ({
  name: routeName(file),
  source: readFileSync(file, "utf8"),
}));

describe("API surface", () => {
  test("the route inventory was actually discovered", () => {
    assert.ok(routes.length > 20, `found only ${routes.length} routes`);
    for (const name of PUBLIC_ROUTES) {
      assert.ok(
        routes.some((r) => r.name === name),
        `allowlisted route ${name} no longer exists — prune the allowlist`,
      );
    }
  });

  test("every non-public route authorizes its caller", () => {
    const unguarded = routes
      .filter((r) => !PUBLIC_ROUTES.has(r.name))
      .filter((r) => !AUTH_CALLS.some((call) => r.source.includes(call)))
      .map((r) => r.name);

    assert.deepEqual(
      unguarded,
      [],
      `these routes never authorize the caller: ${unguarded.join(", ")}`,
    );
  });

  test("every admin route requires an admin", () => {
    const weak = routes
      .filter((r) => r.name.startsWith(ADMIN_PREFIX))
      .filter((r) => !PUBLIC_ROUTES.has(r.name))
      .filter((r) => !ADMIN_ROUTES_WITH_SECRET.has(r.name))
      .filter((r) => !r.source.includes("requireAdmin("))
      .map((r) => r.name);

    assert.deepEqual(
      weak,
      [],
      `these admin routes do not call requireAdmin: ${weak.join(", ")}`,
    );
  });

  test("routes that read a project id from the request scope it to the caller", () => {
    // A route that takes an id out of the request but never resolves access on
    // it is the classic "change the URL and read someone else's data" bug.
    // Routes that mint their own id with uuidv4() are not affected, so match
    // only ids that arrive from the client.
    const READS_ID_FROM_REQUEST =
      /(searchParams\.get\(\s*["'](runId|lookupId|jobId|projectId|id|competitorId|adId)["']|body\.(runId|lookupId|jobId|projectId|competitorId|adId)|params\)?\.(runId|lookupId|jobId|projectId))/;

    const SCOPING_CALLS = [
      "resolveProjectAccess(",
      // These filter by the caller's whole visible set instead of one id.
      "visibleProjectKeys(",
      "visibleRunIds(",
      "listVisibleProjects(",
    ];

    const unscoped = routes
      .filter((r) => !PUBLIC_ROUTES.has(r.name))
      .filter((r) => !r.name.startsWith(ADMIN_PREFIX))
      .filter((r) => READS_ID_FROM_REQUEST.test(r.source))
      .filter((r) => !SCOPING_CALLS.some((call) => r.source.includes(call)))
      .map((r) => r.name);

    assert.deepEqual(
      unscoped,
      [],
      `these routes accept an id from the client without scoping it: ${unscoped.join(", ")}`,
    );
  });

  test("routes only ever test provider secrets for presence, never return them", () => {
    // Reading a key to decide whether a capability is configured is fine.
    // Putting its value anywhere near a response body is not.
    const SECRET_REF = /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN)\b/;
    const PRESENCE_CHECK = [
      /Boolean\(\s*process\.env\./, // configured?: Boolean(process.env.X)
      /!process\.env\./, // if (!process.env.X) return 503
      /^\s*const \w+ = process\.env\.[A-Z_]+\?\.trim\(\);?\s*$/, // compared below
    ];

    const offenders: string[] = [];
    for (const route of routes) {
      for (const [i, line] of route.source.split("\n").entries()) {
        if (!SECRET_REF.test(line)) continue;
        if (PRESENCE_CHECK.some((re) => re.test(line))) continue;
        offenders.push(`${route.name}:${i + 1} — ${line.trim()}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `secret values used outside a presence check:\n${offenders.join("\n")}`,
    );
  });
});
