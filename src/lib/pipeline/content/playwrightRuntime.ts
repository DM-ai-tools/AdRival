import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser } from "playwright";

/** Browsers live in the project data dir, not a Cursor sandbox temp path. */
export function playwrightBrowsersPath(): string {
  return path.join(process.cwd(), "data", "playwright-browsers");
}

function chromiumInstalled(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name.startsWith("chromium"));
  } catch {
    return false;
  }
}

export function configurePlaywrightBrowsers(): string {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH || "";
  const ephemeral = /cursor|sandbox|\\temp\\|\/tmp\/|appdata\\local\\temp/i.test(explicit);
  const candidates = [
    !ephemeral && explicit ? explicit : "",
    playwrightBrowsersPath(),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);
  const chosen = candidates.find((dir) => chromiumInstalled(dir)) || playwrightBrowsersPath();
  process.env.PLAYWRIGHT_BROWSERS_PATH = chosen;
  return chosen;
}

/** Shared launch options so local and container Chromium use the installed browser. */
export function chromiumLaunchOptions(extraArgs: string[] = []): { headless: true; args: string[] } {
  configurePlaywrightBrowsers();
  const args = [...extraArgs];
  if (process.platform === "linux") {
    args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
  }
  return { headless: true, args };
}

export async function launchChromium(): Promise<Browser> {
  const { chromium } = await import("playwright");
  try {
    return await chromium.launch(chromiumLaunchOptions());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/i.test(msg)) {
      throw new Error(
        `Playwright Chromium is not installed for this app. From the project folder run: npx playwright install chromium. Browser directory: ${playwrightBrowsersPath()}`,
      );
    }
    throw err;
  }
}

/** Proves the installed browser can render, read text, and save a screenshot. */
export async function preflightCapture(): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let browser: Browser | null = null;
  try {
    browser = await launchChromium();
    const page = await browser.newPage();
    await page.setContent("<main><h1>Capture preflight</h1><p>Rendered text check.</p></main>");
    const text = await page.locator("main").innerText();
    if (!/Rendered text check/.test(text)) {
      return { ok: false, error: "Capture preflight opened Chromium but could not read the test page." };
    }
    const shot = await page.screenshot({ type: "png" });
    if (shot.length < 100) return { ok: false, error: "Capture preflight did not produce a screenshot." };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
