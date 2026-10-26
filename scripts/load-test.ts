/*
 * Read-path load test against a running deployment (never part of `npm test`).
 *
 *   LOADTEST_USERS='[{"username":"lt1","password":"..."}, ...]' \
 *     npm run loadtest -- --base https://staging.example.com --users 6 --duration 60 [--job <id>] [--p95-ms 2000]
 *
 * Logs each user in through /api/auth/login (one cookie jar per virtual
 * user), then each virtual user loops for --duration seconds with a random
 * 0.3-1.5 s think time between requests: GET /api/history,
 * GET /api/history/unified, GET /api/search/status?jobId=<--job> (when
 * given), GET /api/credits/summary. Nothing is written: no run is started and
 * no credits are reserved (--reserve is accepted but only prints that).
 *
 * Prints p50/p95/max latency and error counts per endpoint and in total.
 * Exits non-zero when any response is non-2xx other than 401, or when the
 * total p95 is above --p95-ms. Never prints passwords or cookies.
 */
import { pathToFileURL } from "node:url";

export interface LoadArgs {
  base: string;
  users: number;
  durationSec: number;
  job: string | null;
  p95Ms: number;
  reserve: boolean;
}

export function parseLoadArgs(argv: string[]): LoadArgs {
  const args: LoadArgs = { base: "", users: 6, durationSec: 60, job: null, p95Ms: 2000, reserve: false };
  const positive = (flag: string, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got ${raw}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === "--base") args.base = value().replace(/\/+$/, "");
    else if (flag === "--users") args.users = Math.floor(positive(flag, value()));
    else if (flag === "--duration") args.durationSec = positive(flag, value());
    else if (flag === "--job") args.job = value();
    else if (flag === "--p95-ms") args.p95Ms = positive(flag, value());
    else if (flag === "--reserve") args.reserve = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.base) throw new Error("--base <url> is required");
  if (!/^https?:\/\//.test(args.base)) throw new Error("--base must be an http(s) URL");
  return args;
}

/** Nearest-rank percentile of `sorted` (ascending); 0 for no samples. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export interface Sample {
  endpoint: string;
  ms: number;
  /** HTTP status, or 0 for a network error. */
  status: number;
}

export interface EndpointSummary {
  endpoint: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** Non-2xx other than 401, plus network errors. */
  errors: number;
  unauthorized: number;
}

function summarizeGroup(endpoint: string, samples: Sample[]): EndpointSummary {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  return {
    endpoint,
    count: samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    errors: samples.filter((s) => s.status !== 401 && (s.status < 200 || s.status >= 300)).length,
    unauthorized: samples.filter((s) => s.status === 401).length,
  };
}

/** Per-endpoint summaries (sorted by name) and the total. */
export function summarize(samples: Sample[]): { endpoints: EndpointSummary[]; total: EndpointSummary } {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const list = groups.get(s.endpoint) ?? [];
    list.push(s);
    groups.set(s.endpoint, list);
  }
  const endpoints = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => summarizeGroup(name, list));
  return { endpoints, total: summarizeGroup("total", samples) };
}

/** Pass/fail for a summary. */
export function verdict(total: EndpointSummary, p95Ms: number): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (total.errors > 0) reasons.push(`${total.errors} non-2xx (other than 401) or failed request(s)`);
  if (total.p95 > p95Ms) reasons.push(`total p95 ${total.p95} ms is above ${p95Ms} ms`);
  return { ok: reasons.length === 0, reasons };
}

interface Credentials {
  username: string;
  password: string;
}

function readUsers(): Credentials[] {
  const raw = process.env.LOADTEST_USERS;
  if (!raw) throw new Error('set LOADTEST_USERS to a JSON array: [{"username":"...","password":"..."}]');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LOADTEST_USERS is not valid JSON");
  }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("LOADTEST_USERS must be a non-empty JSON array");
  return parsed.map((u, i) => {
    const c = u as Partial<Credentials>;
    if (typeof c.username !== "string" || typeof c.password !== "string") {
      throw new Error(`LOADTEST_USERS[${i}] needs a username and a password`);
    }
    return { username: c.username, password: c.password };
  });
}

/** `name=value` pairs from the Set-Cookie headers (attributes dropped). */
function cookieHeader(res: Response): string {
  const all = res.headers.getSetCookie();
  return all.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function login(base: string, user: Credentials): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: user.password }),
    redirect: "manual",
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`login as ${user.username} failed: HTTP ${res.status}`);
  const cookie = cookieHeader(res);
  if (!cookie) throw new Error(`login as ${user.username} returned no session cookie`);
  return cookie;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const think = () => sleep(300 + Math.random() * 1200);

async function timedGet(base: string, endpoint: string, url: string, cookie: string, samples: Sample[]): Promise<void> {
  const started = performance.now();
  let status = 0;
  try {
    const res = await fetch(`${base}${url}`, { headers: { cookie }, redirect: "manual" });
    await res.arrayBuffer();
    status = res.status;
  } catch {
    status = 0;
  }
  samples.push({ endpoint, ms: Math.round(performance.now() - started), status });
}

async function virtualUser(args: LoadArgs, cookie: string, deadline: number, samples: Sample[]): Promise<void> {
  const requests: Array<[string, string]> = [
    ["history", "/api/history"],
    ["history/unified", "/api/history/unified"],
    ...(args.job ? [["search/status", `/api/search/status?jobId=${encodeURIComponent(args.job)}`] as [string, string]] : []),
    ["credits/summary", "/api/credits/summary"],
  ];
  while (Date.now() < deadline) {
    for (const [endpoint, url] of requests) {
      if (Date.now() >= deadline) return;
      await timedGet(args.base, endpoint, url, cookie, samples);
      await think();
    }
  }
}

function printSummary(endpoints: EndpointSummary[], total: EndpointSummary): void {
  const row = (s: EndpointSummary) =>
    `${s.endpoint.padEnd(18)} ${String(s.count).padStart(6)} ${String(s.p50).padStart(7)} ${String(s.p95).padStart(7)} ${String(s.max).padStart(7)} ${String(s.errors).padStart(7)} ${String(s.unauthorized).padStart(5)}`;
  console.log(`${"endpoint".padEnd(18)} ${"count".padStart(6)} ${"p50ms".padStart(7)} ${"p95ms".padStart(7)} ${"maxms".padStart(7)} ${"errors".padStart(7)} ${"401".padStart(5)}`);
  for (const s of endpoints) console.log(row(s));
  console.log(row(total));
}

async function main(): Promise<void> {
  const args = parseLoadArgs(process.argv.slice(2));
  const users = readUsers();
  if (args.reserve) console.log("--reserve: credit reservations are not exercised (the load test only reads)");
  console.log(`load test ${args.base}: ${args.users} virtual users for ${args.durationSec}s`);

  const cookies: string[] = [];
  for (let i = 0; i < args.users; i += 1) {
    const user = users[i % users.length];
    cookies.push(await login(args.base, user));
    console.log(`logged in virtual user ${i + 1} as ${user.username}`);
  }

  const samples: Sample[] = [];
  const deadline = Date.now() + args.durationSec * 1000;
  await Promise.all(cookies.map((cookie) => virtualUser(args, cookie, deadline, samples)));

  const { endpoints, total } = summarize(samples);
  printSummary(endpoints, total);
  const result = verdict(total, args.p95Ms);
  if (!result.ok) {
    console.error(`FAIL: ${result.reasons.join("; ")}`);
    process.exit(1);
  }
  console.log("PASS");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`load test failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
