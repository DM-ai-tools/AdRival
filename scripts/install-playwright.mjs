import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "data", "playwright-browsers");
fs.mkdirSync(dir, { recursive: true });
const result = spawnSync("npx", ["playwright", "install", "chromium"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir },
});
process.exit(result.status ?? 1);
