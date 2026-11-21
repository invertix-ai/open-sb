// Draws assets/providers.svg, the provider overview at the top of the README: node scripts/graphic.ts
// The capability lists come from the providers themselves, so the picture cannot drift from the code.
import { writeFileSync } from "node:fs";
import { CAPABILITIES } from "../src/types.ts";
import { agent37 } from "../src/providers/agent37.ts";
import { boat } from "../src/providers/boat.ts";
import { daytona } from "../src/providers/daytona.ts";
import { docker } from "../src/providers/docker.ts";
import { e2b } from "../src/providers/e2b.ts";
import { modal } from "../src/providers/modal.ts";
import { vercel } from "../src/providers/vercel.ts";

const providers = [
  { title: "E2B", kind: "Firecracker microVMs", provider: e2b({ apiKey: "unused" }) },
  { title: "Daytona", kind: "Fast dev sandboxes", provider: daytona({ apiKey: "unused" }) },
  { title: "Vercel Sandbox", kind: "Ephemeral microVMs", provider: vercel({ token: "unused", teamId: "unused", projectId: "unused" }) },
  { title: "Modal", kind: "Serverless containers", provider: modal({ tokenId: "unused", tokenSecret: "unused" }) },
  { title: "Boat", kind: "Full cloud VMs", provider: boat({ apiKey: "unused" }) },
  { title: "Agent37", kind: "VMs that sleep when idle", provider: agent37({ apiKey: "unused" }) },
  { title: "Docker", kind: "Containers on your machine", provider: docker() },
];

const W = 1000, CARD_W = 220, CARD_H = 222, GAP = 20, LEFT = 30, ROW1 = 208, ROW2 = ROW1 + CARD_H + 28;
const H = ROW2 + CARD_H + 58;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function card(index: number, body: string, dashed = false) {
  const x = LEFT + (index % 4) * (CARD_W + GAP), y = index < 4 ? ROW1 : ROW2;
  return `  <g transform="translate(${x} ${y})">
    <rect class="${dashed ? "card-new" : "card"}" width="${CARD_W}" height="${CARD_H}" rx="14"/>
${body}  </g>\n`;
}

function providerCard(index: number, title: string, kind: string, has: readonly string[]) {
  const chips = CAPABILITIES.map((capability, i) => {
    const x = i % 2 === 0 ? 14 : 112, y = 80 + Math.floor(i / 2) * 32, on = has.includes(capability);
    return `      <rect class="${on ? "on" : "off"}" x="${x}" y="${y}" width="94" height="24" rx="12"/>` +
      `<text class="${on ? "on-text" : "off-text"}" x="${x + 47}" y="${y + 16}">${capability}</text>`;
  }).join("\n");
  return card(index, `    <text class="text" x="18" y="38" font-size="22" font-weight="700">${escape(title)}</text>
    <text class="muted" x="18" y="60" font-size="13">${escape(kind)}</text>
    <g class="mono" font-size="10.5" text-anchor="middle">
${chips}
    </g>
`);
}

const own = card(7, `    <text class="text" x="18" y="38" font-size="22" font-weight="700">Your provider</text>
    <text class="muted" x="18" y="60" font-size="13">Any sandbox with an API</text>
    <g class="mono code" font-size="12" xml:space="preserve">
      <text x="18" y="102">defineProvider({</text>
      <text x="18" y="122">  name, capabilities,</text>
      <text x="18" y="142">  ...methods })</text>
      <text x="18" y="178">conformance(provider)</text>
    </g>
    <text class="muted" x="18" y="204" font-size="12">Passes the suite, joins the list</text>
`, true);

const wires = [0, 1, 2, 3].map(i => {
  const x = LEFT + i * (CARD_W + GAP) + CARD_W / 2;
  return `  <path class="wire" d="M500 124 C500 170, ${x} 160, ${x} ${ROW1}"/>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">open-sb providers</title>
  <desc id="desc">One interface, open-sb, over ${providers.map(p => p.title).join(", ")} and your own provider, with the capabilities each one supports.</desc>
  <style>
    .bg { fill: #ffffff; }
    .hub { fill: #111827; }
    .hub-text { fill: #ffffff; }
    .hub-muted { fill: #9ca3af; }
    .card { fill: #f9fafb; stroke: #e5e7eb; stroke-width: 1.5; }
    .card-new { fill: none; stroke: #9ca3af; stroke-width: 1.5; stroke-dasharray: 6 5; }
    .text { fill: #111827; }
    .muted { fill: #6b7280; }
    .wire { fill: none; stroke: #d1d5db; stroke-width: 2; }
    .on { fill: #10b981; }
    .on-text { fill: #ffffff; }
    .off { fill: none; stroke: #d1d5db; stroke-width: 1.2; }
    .off-text { fill: #9ca3af; }
    .code { fill: #374151; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; }
      .hub { fill: #f9fafb; }
      .hub-text { fill: #0d1117; }
      .hub-muted { fill: #4b5563; }
      .card { fill: #161b22; stroke: #30363d; }
      .card-new { stroke: #6e7681; }
      .text { fill: #f0f6fc; }
      .muted { fill: #8b949e; }
      .wire { stroke: #30363d; }
      .on { fill: #2ea043; }
      .off { stroke: #30363d; }
      .off-text { fill: #6e7681; }
      .code { fill: #c9d1d9; }
    }
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>

  <rect class="bg" width="${W}" height="${H}" rx="20"/>
${wires}
  <rect class="hub" x="290" y="32" width="420" height="92" rx="18"/>
  <text class="hub-text mono" x="500" y="78" font-size="30" font-weight="700" text-anchor="middle">open-sb</text>
  <text class="hub-muted" x="500" y="106" font-size="13.5" text-anchor="middle">one interface for every sandbox provider</text>

${providers.map((p, i) => providerCard(i, p.title, p.kind, p.provider.capabilities)).join("")}${own}
  <g transform="translate(30 ${H - 28})" font-size="12.5">
    <rect class="on" width="26" height="14" rx="7"/>
    <text class="muted" x="34" y="11.5">supported</text>
    <rect class="off" x="112" width="26" height="14" rx="7"/>
    <text class="muted" x="146" y="11.5">not available</text>
    <text class="muted" x="940" y="11.5" text-anchor="end">Every provider also has create, get, list, destroy, exec, readFile and writeFile</text>
  </g>
</svg>
`;

writeFileSync(new URL("../assets/providers.svg", import.meta.url), svg);
for (const p of providers) console.log(p.title.padEnd(16), p.provider.capabilities.join(", "));
