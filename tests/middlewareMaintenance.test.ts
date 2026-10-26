import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

/*
 * MAINTENANCE_MODE=1 (the cutover's quiet window): every request except
 * /api/health gets 503 with Retry-After; API calls get JSON, page loads a
 * small HTML page. Static assets never reach the middleware (its matcher).
 */

process.env.SESSION_SECRET ??= "middleware-maintenance-test-secret";

const { middleware, config } = await import("../src/middleware");

const saved = process.env.MAINTENANCE_MODE;
afterEach(() => {
  if (saved === undefined) delete process.env.MAINTENANCE_MODE;
  else process.env.MAINTENANCE_MODE = saved;
});

const req = (path: string, method = "GET") => new NextRequest(`http://localhost${path}`, { method });
/** NextResponse.next() marks the response with this header. */
const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

test("maintenance on: API calls get 503 JSON { error: 'maintenance' } with Retry-After 600", async () => {
  process.env.MAINTENANCE_MODE = "1";
  for (const [path, method] of [
    ["/api/history", "GET"],
    ["/api/search/start", "POST"],
    ["/api/auth/login", "POST"],
    ["/api/admin/import-history", "POST"],
  ] as const) {
    const res = await middleware(req(path, method));
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("retry-after"), "600", path);
    assert.deepEqual(await res.json(), { error: "maintenance" }, path);
  }
});

test("maintenance on: page loads get a 503 HTML page", async () => {
  process.env.MAINTENANCE_MODE = "1";
  for (const path of ["/", "/login", "/admin", "/history/abc"]) {
    const res = await middleware(req(path));
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("retry-after"), "600", path);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
    assert.match(await res.text(), /maintenance/i, path);
  }
});

test("maintenance on: /api/health still answers (deploy health check)", async () => {
  process.env.MAINTENANCE_MODE = "1";
  assert.ok(passedThrough(await middleware(req("/api/health"))));
});

test("maintenance off (unset, 0, empty): normal gating", async () => {
  for (const value of [undefined, "0", "", "false"]) {
    if (value === undefined) delete process.env.MAINTENANCE_MODE;
    else process.env.MAINTENANCE_MODE = value;
    const api = await middleware(req("/api/history"));
    assert.equal(api.status, 401, `MAINTENANCE_MODE=${value}`);
    assert.ok(passedThrough(await middleware(req("/login"))), `MAINTENANCE_MODE=${value}`);
  }
});

test("'true' also switches it on", async () => {
  process.env.MAINTENANCE_MODE = "true";
  assert.equal((await middleware(req("/api/history"))).status, 503);
});

test("static assets stay outside the middleware matcher", () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  assert.equal(matcher.test("/_next/static/chunks/app.js"), false);
  assert.equal(matcher.test("/favicon.ico"), false);
  assert.equal(matcher.test("/logo.png"), false);
  assert.equal(matcher.test("/api/history"), true);
});
