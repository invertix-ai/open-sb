#!/usr/bin/env node
// `open-sb check [config]`: loads the config file and fails unless every provider implements every
// required capability. Prints a capability matrix. Default config: ./sandbox.config.ts (or .js/.mjs).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CAPABILITIES, checkConfig, type Config } from "./index.ts";

const [command = "check", file] = process.argv.slice(2);
if (command !== "check" || file === "--help") {
  console.log("Usage: open-sb check [config file]");
  process.exit(command === "help" || file === "--help" ? 0 : 2);
}
const path = file ?? ["sandbox.config.ts", "sandbox.config.mjs", "sandbox.config.js"].find(candidate => existsSync(candidate));
if (!path) { console.error("No sandbox.config.ts, .mjs or .js here; pass the config file."); process.exit(2); }
const config = (await import(pathToFileURL(resolve(path)).href)).default as Config;
if (!config?.providers || !config.requires) { console.error(`${path} must default-export defineConfig({ requires, providers })`); process.exit(2); }

const reports = checkConfig(config);
const width = Math.max(10, ...CAPABILITIES.map(capability => capability.length + 1));
console.log(["capability".padEnd(width), ...config.providers.map(provider => provider.name)].join("  "));
for (const capability of CAPABILITIES) {
  const required = config.requires.includes(capability);
  console.log([`${capability}${required ? "*" : ""}`.padEnd(width),
    ...config.providers.map(provider => (provider.capabilities.includes(capability) ? "yes" : required ? "MISSING" : "-").padEnd(provider.name.length))].join("  "));
}
console.log("(* required)");
const failed = reports.filter(report => report.missing.length || report.broken.length);
for (const report of failed)
  console.error(`${report.provider}: ${[...report.missing.map(capability => `missing ${capability}`), ...report.broken].join(", ")}`);
process.exit(failed.length ? 1 : 0);
