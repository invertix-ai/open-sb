// Builds the web UI (playground/web) when playground/web/dist is missing or older than any of its sources.
// Runs before the server in `pnpm run playground`, so the first start and every UI change need no extra step.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("./web/", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

function newest(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(stat.mtimeMs, ...readdirSync(path).map(name => newest(join(path, name))));
}

let built = 0;
try { built = statSync(join(web, "dist", "index.html")).mtimeMs; } catch { /* not built yet */ }
const sources = Math.max(...["src", "index.html", "vite.config.ts", "components.json"].map(name => newest(join(web, name))), statSync(join(root, "pnpm-lock.yaml")).mtimeMs);

if (built >= sources) process.exit(0);
console.log(built ? "Web UI sources changed: rebuilding" : "Building the web UI (first run)");
const result = spawnSync(join(root, "node_modules", ".bin", "vite"), ["build", "--config", join(web, "vite.config.ts"), "--logLevel", "warn"], { stdio: "inherit" });
process.exit(result.status ?? 1);
