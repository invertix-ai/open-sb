// Picks the version CI publishes. package.json is the floor: when that version (or a higher one) is
// already on npm, the next patch after the highest published stable version is used instead. Prerelease
// versions on npm are ignored. Run: node scripts/next-version.ts <package name>; prints the version and
// writes it into package.json.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Triple = [number, number, number];

function parse(version: string): Triple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export function nextVersion(floor: string, published: string[]): string {
  const base = parse(floor);
  if (!base) throw new Error(`package.json version ${floor} must be MAJOR.MINOR.PATCH`);
  const stable = published.map(parse).filter((v): v is Triple => v !== undefined).sort(compare);
  const highest = stable.at(-1);
  if (!highest || compare(base, highest) > 0) return floor;
  return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
}

/** Every version of the package on npm; empty when the package does not exist yet. Other errors throw. */
function publishedVersions(name: string): string[] {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const value: unknown = JSON.parse(out || "[]");
    return Array.isArray(value) ? value.map(String) : [String(value)];
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (stderr.includes("E404")) return [];
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };
  const next = nextVersion(pkg.version, publishedVersions(process.argv[2] ?? pkg.name));
  pkg.version = next;
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  console.log(next);
}
