import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_SESSION_SECRET = "e2e-session-secret-not-for-production";

/**
 * `next start` loads `.env.local`, which on a developer machine holds real
 * provider keys. Overriding each one with a placeholder keeps the test server
 * from ever authenticating against a live provider.
 *
 * The values must be non-empty: `@next/env` treats an empty string as unset and
 * would fall back to `.env.local`. Belt and braces — the seeded app settings
 * also disable every provider, so metering refuses the call first.
 */
const NEUTRALIZED_PROVIDER_ENV: Record<string, string> = {
  SOCIAVAULT_API_KEY: "e2e-placeholder-not-a-real-key",
  OPENAI_API_KEY: "e2e-placeholder-not-a-real-key",
  OPENROUTER_API_KEY: "e2e-placeholder-not-a-real-key",
  ANTHROPIC_API_KEY: "e2e-placeholder-not-a-real-key",
  FIRECRAWL_API_KEY: "e2e-placeholder-not-a-real-key",
  BRANDFETCH_API_KEY: "e2e-placeholder-not-a-real-key",
  RUNWAYML_API_SECRET: "e2e-placeholder-not-a-real-key",
};

/**
 * Boots the production build against a throwaway data directory so tests can
 * make real HTTP requests through middleware, cookies and route handlers.
 *
 * Requires `next build` to have run first; `npm run test:e2e` does that.
 */
export interface TestServer {
  baseUrl: string;
  dataDir: string;
  stop: () => Promise<void>;
}

async function waitForReady(baseUrl: string, timeoutMs: number, child: ChildProcess) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became ready: ${String(lastError)}`);
}

export async function startTestServer(options?: {
  /** Runs before the server boots, with ADRIVAL_DATA_DIR already pointing at the temp dir. */
  seed?: (dataDir: string) => Promise<void> | void;
  port?: number;
  env?: Record<string, string>;
}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "adrival-e2e-"));
  process.env.ADRIVAL_DATA_DIR = dataDir;
  process.env.SESSION_SECRET = E2E_SESSION_SECRET;
  await options?.seed?.(dataDir);

  const port = options?.port ?? 3987;
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(
    process.execPath,
    [join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        ADRIVAL_DATA_DIR: dataDir,
        SESSION_SECRET: E2E_SESSION_SECRET,
        ...NEUTRALIZED_PROVIDER_ENV,
        ...options?.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let log = "";
  child.stdout?.on("data", (d) => (log += String(d)));
  child.stderr?.on("data", (d) => (log += String(d)));

  try {
    await waitForReady(baseUrl, 60_000, child);
  } catch (err) {
    child.kill();
    throw new Error(`${(err as Error).message}\n--- server output ---\n${log}`);
  }

  return {
    baseUrl,
    dataDir,
    stop: async () => {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A cookie-retaining client, so each identity behaves like a separate browser. */
export class Client {
  private cookie: string | null = null;

  constructor(private readonly baseUrl: string) {}

  get hasSession(): boolean {
    return this.cookie !== null;
  }

  clearCookie() {
    this.cookie = null;
  }

  async request(
    path: string,
    init?: RequestInit & { json?: unknown },
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    let body = init?.body;
    if (init?.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      body,
      headers,
      redirect: "manual",
    });

    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const [pair] = raw.split(";");
      if (pair?.startsWith("adrival_session=")) {
        this.cookie = pair.endsWith("=") ? null : pair;
      }
    }
    return res;
  }

  get(path: string) {
    return this.request(path);
  }

  post(path: string, json?: unknown) {
    return this.request(path, { method: "POST", json: json ?? {} });
  }

  patch(path: string, json?: unknown) {
    return this.request(path, { method: "PATCH", json: json ?? {} });
  }

  put(path: string, json?: unknown) {
    return this.request(path, { method: "PUT", json: json ?? {} });
  }

  delete(path: string, json?: unknown) {
    return this.request(path, { method: "DELETE", json: json ?? {} });
  }

  async login(username: string, password: string): Promise<Response> {
    return this.post("/api/auth/login", { username, password });
  }
}
