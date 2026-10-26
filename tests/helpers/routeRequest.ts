import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

import { createSessionToken, SESSION_COOKIE } from "../../src/lib/auth/session";
import { toPublicUser } from "../../src/lib/data/identity";
import type { AppUser } from "../../src/lib/types";

/*
 * Calls Next route handlers directly, in-process, as a signed-in user.
 *
 * `cookies()` from next/headers only works inside Next's request scope, so this
 * opens the two async-local stores it reads (the same CommonJS instances
 * next/headers uses) with a request whose cookie jar holds a real session
 * token. Everything else in the handler — authz, the database, the response —
 * runs exactly as in production. Needs SESSION_SECRET set.
 */

// The Next server installs this global before loading its async-local stores;
// without it they are inert fakes.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external") as {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external") as {
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies") as {
  RequestCookies: new (headers: Headers) => unknown;
};

/** Run `fn` inside a Next request scope whose cookies are `cookieHeader`. */
export function inRequestScope<T>(cookieHeader: string | null, fn: () => Promise<T>): Promise<T> {
  const headers = new Headers(cookieHeader ? { cookie: cookieHeader } : {});
  const workStore = { route: "/test", forceStatic: false, dynamicShouldError: false };
  const requestStore = { type: "request", phase: "render", cookies: new RequestCookies(headers) };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

export async function sessionCookieFor(user: AppUser): Promise<string> {
  const token = await createSessionToken({ ...toPublicUser(user), sessionEpoch: user.sessionEpoch });
  return `${SESSION_COOKIE}=${token}`;
}

/** Run `fn` as `user` (null: no session). */
export async function asUser<T>(user: AppUser | null, fn: () => Promise<T>): Promise<T> {
  const cookie = user ? await sessionCookieFor(user) : null;
  return inRequestScope(cookie, fn);
}

export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Route `params` as Next 15 passes them (a Promise). */
export function routeParams<P extends Record<string, string>>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

export async function readJson(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
