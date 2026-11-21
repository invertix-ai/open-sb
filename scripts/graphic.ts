// Draws assets/providers.svg, the provider overview at the top of the README: pnpm run graphic
// The capability marks come from the providers themselves, so the picture cannot drift from the code.
import { readFileSync, writeFileSync } from "node:fs";
import { CAPABILITIES, type AnyProvider } from "../src/types.ts";
import { agent37 } from "../src/providers/agent37.ts";
import { beam } from "../src/providers/beam.ts";
import { blaxel } from "../src/providers/blaxel.ts";
import { boat } from "../src/providers/boat.ts";
import { codesandbox } from "../src/providers/codesandbox.ts";
import { daytona } from "../src/providers/daytona.ts";
import { docker } from "../src/providers/docker.ts";
import { e2b } from "../src/providers/e2b.ts";
import { fly } from "../src/providers/fly.ts";
import { freestyle } from "../src/providers/freestyle.ts";
import { hopx } from "../src/providers/hopx.ts";
import { modal } from "../src/providers/modal.ts";
import { morph } from "../src/providers/morph.ts";
import { runloop } from "../src/providers/runloop.ts";
import { sprites } from "../src/providers/sprites.ts";
import { upstash } from "../src/providers/upstash.ts";
import { vercel } from "../src/providers/vercel.ts";

// Constructing a provider makes no network calls; the keys are placeholders.
const key = "unused";
// Logos in assets/logos/<module>.(svg|png) come from the simple-icons package (Vercel, Modal, Fly, Upstash,
// CodeSandbox, Docker) or the icon each provider's own website serves. They are the providers' trademarks,
// used only to identify each provider. They are embedded as data URIs because GitHub blocks external loads.
const logo = (module: string) => {
  for (const [ext, mime] of [["svg", "image/svg+xml"], ["png", "image/png"]]) {
    try {
      return `data:${mime};base64,${readFileSync(new URL(`../assets/logos/${module}.${ext}`, import.meta.url)).toString("base64")}`;
    } catch {}
  }
  throw new Error(`No logo for ${module} in assets/logos`);
};

const rows: { title: string; kind: string; module: string; provider: AnyProvider }[] = [
  { title: "E2B", kind: "Firecracker microVMs", module: "e2b", provider: e2b({ apiKey: key }) },
  { title: "Daytona", kind: "Fast dev sandboxes", module: "daytona", provider: daytona({ apiKey: key }) },
  { title: "Vercel Sandbox", kind: "Ephemeral microVMs", module: "vercel", provider: vercel({ token: key, teamId: key, projectId: key }) },
  { title: "Modal", kind: "Serverless containers", module: "modal", provider: modal({ tokenId: key, tokenSecret: key }) },
  { title: "Fly Sprites", kind: "Persistent agent computers", module: "sprites", provider: sprites({ token: key }) },
  { title: "Fly Machines", kind: "Fast-launching VMs", module: "fly", provider: fly({ apiToken: key, app: key }) },
  { title: "Runloop", kind: "Devboxes for coding agents", module: "runloop", provider: runloop({ apiKey: key }) },
  { title: "CodeSandbox", kind: "MicroVMs that hibernate", module: "codesandbox", provider: codesandbox({ apiKey: key }) },
  { title: "Morph Cloud", kind: "VMs with instant snapshots", module: "morph", provider: morph({ apiKey: key }) },
  { title: "Blaxel", kind: "Perpetual agent sandboxes", module: "blaxel", provider: blaxel({ apiKey: key, workspace: key }) },
  { title: "Upstash Box", kind: "Boxes for coding agents", module: "upstash", provider: upstash({ apiKey: key }) },
  { title: "Freestyle", kind: "VMs that fork and pause", module: "freestyle", provider: freestyle({ apiKey: key }) },
  { title: "HOPX", kind: "Firecracker sandboxes", module: "hopx", provider: hopx({ apiKey: key }) },
  { title: "Beam", kind: "Agent workspaces", module: "beam", provider: beam({ token: key }) },
  { title: "Boat", kind: "Full cloud VMs", module: "boat", provider: boat({ apiKey: key }) },
  { title: "Agent37", kind: "VMs that sleep when idle", module: "agent37", provider: agent37({ apiKey: key }) },
  { title: "Docker", kind: "Containers on your machine", module: "docker", provider: docker() },
];

const W = 1000, LEFT = 30, NAME_W = 236, COL_W = (W - 2 * LEFT - NAME_W) / CAPABILITIES.length;
const HEAD_Y = 176, ROW_H = 40, TOP = HEAD_Y + 18;
const OWN_Y = TOP + rows.length * ROW_H + 10, COUNT_Y = OWN_Y + ROW_H + 30, H = COUNT_Y + 46;
const colX = (i: number) => LEFT + NAME_W + i * COL_W + COL_W / 2;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// camelCase names break into two lines so neighbouring headers never touch.
const header = CAPABILITIES.map((capability, i) => {
  const [first, second] = capability.replace(/([a-z])([A-Z])/, "$1 $2").toLowerCase().split(" ");
  return second
    ? `    <text class="muted mono" x="${colX(i)}" y="${HEAD_Y - 14}" font-size="11.5" text-anchor="middle">${first}</text>\n` +
      `    <text class="muted mono" x="${colX(i)}" y="${HEAD_Y}" font-size="11.5" text-anchor="middle">${second}</text>`
    : `    <text class="muted mono" x="${colX(i)}" y="${HEAD_Y}" font-size="11.5" text-anchor="middle">${first}</text>`;
}).join("\n");

const body = rows.map((row, r) => {
  const y = TOP + r * ROW_H;
  const marks = CAPABILITIES.map((capability, i) => row.provider.capabilities.includes(capability)
    ? `<circle class="on" cx="${colX(i)}" cy="${y + ROW_H / 2}" r="9"/><path class="tick" d="M${colX(i) - 4} ${y + ROW_H / 2} l3 3 l5.5 -6"/>`
    : `<circle class="off" cx="${colX(i)}" cy="${y + ROW_H / 2}" r="3"/>`).join("");
  return `  <g>
    ${r % 2 === 0 ? `<rect class="stripe" x="${LEFT}" y="${y}" width="${W - 2 * LEFT}" height="${ROW_H}" rx="8"/>` : ""}
    <rect class="tile" x="${LEFT + 10}" y="${y + 7}" width="26" height="26" rx="6"/>
    <image x="${LEFT + 13}" y="${y + 10}" width="20" height="20" href="${logo(row.module)}"/>
    <text class="text" x="${LEFT + 46}" y="${y + 19}" font-size="15" font-weight="650">${escape(row.title)}</text>
    <text class="muted" x="${LEFT + 46}" y="${y + 33}" font-size="11">${escape(row.kind)}</text>
    ${marks}
  </g>`;
}).join("\n");

const counts = CAPABILITIES.map((capability, i) => {
  const n = rows.filter(row => row.provider.capabilities.includes(capability)).length;
  return `    <text class="text" x="${colX(i)}" y="${COUNT_Y}" font-size="15" font-weight="650" text-anchor="middle">${n}</text>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">open-sb providers and capabilities</title>
  <desc id="desc">One interface, open-sb, over ${rows.length} sandbox providers: ${rows.map(row => row.title).join(", ")}. A mark shows each optional capability a provider supports.</desc>
  <style>
    .bg { fill: #ffffff; }
    .hub { fill: #111827; }
    .hub-text { fill: #ffffff; }
    .hub-muted { fill: #9ca3af; }
    .stripe { fill: #f6f8fa; }
    .tile { fill: #ffffff; stroke: #e5e7eb; stroke-width: 1; }
    .own { fill: none; stroke: #9ca3af; stroke-width: 1.5; stroke-dasharray: 6 5; }
    .text { fill: #111827; }
    .muted { fill: #6b7280; }
    .rule { stroke: #e5e7eb; stroke-width: 1; }
    .on { fill: #10b981; }
    .tick { fill: none; stroke: #ffffff; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .off { fill: #d1d5db; }
    .code { fill: #374151; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; }
      .hub { fill: #f9fafb; }
      .hub-text { fill: #0d1117; }
      .hub-muted { fill: #4b5563; }
      .stripe { fill: #161b22; }
      .tile { stroke: #30363d; }
      .own { stroke: #6e7681; }
      .text { fill: #f0f6fc; }
      .muted { fill: #8b949e; }
      .rule { stroke: #30363d; }
      .on { fill: #2ea043; }
      .tick { stroke: #0d1117; }
      .off { fill: #30363d; }
      .code { fill: #c9d1d9; }
    }
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>

  <rect class="bg" width="${W}" height="${H}" rx="20"/>
  <rect class="hub" x="250" y="32" width="500" height="92" rx="18"/>
  <text class="hub-text mono" x="500" y="78" font-size="30" font-weight="700" text-anchor="middle">open-sb</text>
  <text class="hub-muted" x="500" y="106" font-size="13.5" text-anchor="middle">one interface · ${rows.length} sandbox providers · one config file</text>

${header}
${body}
  <g>
    <rect class="own" x="${LEFT}" y="${OWN_Y}" width="${W - 2 * LEFT}" height="${ROW_H}" rx="8"/>
    <text class="text" x="${LEFT + 46}" y="${OWN_Y + 19}" font-size="15" font-weight="650">Your provider</text>
    <text class="muted" x="${LEFT + 46}" y="${OWN_Y + 33}" font-size="11">Any sandbox with an API</text>
    <text class="code mono" x="${LEFT + NAME_W + 12}" y="${OWN_Y + 25}" font-size="12.5">defineProvider({ name, capabilities, ...methods })  +  conformance(provider)</text>
  </g>
  <line class="rule" x1="${LEFT}" x2="${W - LEFT}" y1="${COUNT_Y - 22}" y2="${COUNT_Y - 22}"/>
  <text class="muted" x="${LEFT + 46}" y="${COUNT_Y}" font-size="12.5">Providers with it</text>
${counts}
  <text class="muted" x="${W - LEFT}" y="${H - 18}" font-size="12" text-anchor="end">Every provider also has create, get, list, destroy, exec, readFile and writeFile</text>
</svg>
`;

writeFileSync(new URL("../assets/providers.svg", import.meta.url), svg);
for (const row of rows) console.log(row.title.padEnd(16), row.provider.capabilities.join(", "));
