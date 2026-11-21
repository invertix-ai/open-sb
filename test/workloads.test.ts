// The Workloads test and the new agent tasks' verify commands, without the network or a cloud provider. A fake
// provider runs each sandbox's commands in a real local shell, with /tmp/ mapped into a temporary directory, so
// the shell the sections and verify commands send is executed for real. Probes that would leave this machine
// (the internet, the LAN address) and `env` are answered by the fake.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defineProvider, type SandboxInfo } from "../src/index.ts";
import { Run } from "../playground/runs.ts";
import { runAcrossProviders } from "../playground/harness.ts";
import { BROWSER_VALUE, SALES_REGIONS, taskById } from "../playground/tasks.ts";
import { leakedNames, probeResult, setHostTargets, workloads, type SectionResult } from "../playground/tests/workloads.ts";

function shellProvider(behaviour: { truncateReads?: number; env?: Record<string, string>; snapshot?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "osb-shell-"));
  const boxes = new Map<string, { dir: string; info: SandboxInfo; procs: ChildProcess[] }>();
  const snapshots = new Map<string, string>();
  let next = 0;
  const box = (id: string) => { const entry = boxes.get(id); if (!entry) throw new Error(`no sandbox ${id}`); return entry; };
  const map = (id: string, text: string) => text.replaceAll("/tmp/", `${box(id).dir}/tmp/`);
  const core = {
    async create(options: { labels?: Record<string, string>; image?: string } = {}) {
      const id = `shell-${++next}`, dir = join(root, id);
      if (options.image) cpSync(snapshots.get(options.image)!, dir, { recursive: true });
      mkdirSync(join(dir, "tmp"), { recursive: true });
      const info: SandboxInfo = { id, state: "running", labels: options.labels ?? {} };
      boxes.set(id, { dir, info, procs: [] });
      return info;
    },
    get: async (id: string) => boxes.get(id)?.info ?? null,
    list: async (filter: { labels?: Record<string, string> } = {}) => [...boxes.values()].map(entry => entry.info).filter(info => Object.entries(filter.labels ?? {}).every(([k, v]) => info.labels[k] === v)),
    async destroy(id: string) { const entry = boxes.get(id); if (!entry) return; for (const proc of entry.procs) proc.kill(); rmSync(entry.dir, { recursive: true, force: true }); boxes.delete(id); },
    exec: (id: string, command: string) => new Promise<{ exitCode: number; stdout: string; stderr: string }>(done => {
      if (command === "env") return done({ exitCode: 0, stdout: Object.entries(behaviour.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", stderr: "" });
      if (command.includes("example.com")) return done({ exitCode: 0, stdout: "curl 0 200\n", stderr: "" });
      if (command.includes("/api/status")) return done({ exitCode: 0, stdout: "curl 7 000\n", stderr: "" });
      execFile("sh", ["-c", map(id, command)], { encoding: "utf8" }, (error, stdout, stderr) =>
        done({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
    }),
    async readFile(id: string, path: string) {
      const data = new Uint8Array(readFileSync(map(id, path)));
      return behaviour.truncateReads ? data.slice(0, behaviour.truncateReads) : data;
    },
    async writeFile(id: string, path: string, data: Uint8Array | string) {
      const target = map(id, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, typeof data === "string" ? map(id, data) : data);
    },
    async pause(id: string) { box(id).info.state = "stopped"; },
    async resume(id: string) { box(id).info.state = "running"; },
    async startBackground(id: string, command: string) { box(id).procs.push(spawn("sh", ["-c", map(id, command)], { stdio: "ignore" })); },
    async snapshot(id: string, name: string) { const copy = join(root, `snap-${name}`); cpSync(box(id).dir, copy, { recursive: true }); snapshots.set(name, copy); },
    listSnapshots: async () => [...snapshots.keys()],
    async deleteSnapshot(name: string) { rmSync(snapshots.get(name)!, { recursive: true, force: true }); snapshots.delete(name); },
  };
  const provider = behaviour.snapshot === false
    ? defineProvider({ ...core, name: "shell", capabilities: ["pause", "background"] as const })
    : defineProvider({ ...core, name: "shell", capabilities: ["pause", "snapshot", "background"] as const });
  return { provider, boxes, snapshots, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function runWorkloads(provider: ReturnType<typeof shellProvider>["provider"], options: Record<string, unknown>, env: Record<string, string> = {}) {
  const run = new Run("workloads", ["shell"], options);
  await runAcrossProviders(run, [{ module: "shell", title: "Shell", provider }], workloads, env);
  const result = run.results.shell as { ok: boolean; sections: Record<string, SectionResult> };
  return { run, result, events: run.events.filter(event => event.type === "workload") };
}

test("workloads: files round-trip with matching sha256, persistence keeps the file and the counter, forks see the marker", async () => {
  const shell = shellProvider();
  try {
    const { result, events } = await runWorkloads(shell.provider, { sections: ["files", "persistence", "fork"], sizes: [1], forks: 2 });
    assert.equal(result.sections.files!.verdict, "pass", result.sections.files!.summary);
    const size = (result.sections.files!.data!.sizes as Record<string, unknown>[])[0]!;
    assert.deepEqual([size.insideOk, size.readOk, size.readBytes], [true, true, 1048576]);
    assert.equal(result.sections.persistence!.verdict, "pass");
    assert.deepEqual([result.sections.persistence!.data!.fileKept, result.sections.persistence!.data!.processSurvived], [true, true]);
    assert.equal(result.sections.fork!.verdict, "pass", result.sections.fork!.summary);
    assert.equal(shell.boxes.size, 0, "every sandbox is destroyed");
    assert.equal(shell.snapshots.size, 0, "the snapshot is deleted");
    // Every step that started also finished, so no spinner is left running in the terminal.
    const started = events.filter(event => event.kind === "step").map(event => event.id), done = events.filter(event => event.kind === "step_done").map(event => event.id);
    assert.deepEqual(done.sort(), started.sort());
  } finally { shell.cleanup(); }
});

test("workloads: a short read back is a failure that names both sizes, and missing capabilities skip with a reason", async () => {
  const shell = shellProvider({ truncateReads: 393229, snapshot: false });
  try {
    const { result } = await runWorkloads(shell.provider, { sections: ["files", "fork"], sizes: [1] });
    assert.equal(result.sections.files!.verdict, "fail");
    assert.match(result.sections.files!.summary, /readFile returned 393229 bytes that differ from the 1048576 written/);
    assert.deepEqual(result.sections.fork, { verdict: "skip", summary: "Shell has no snapshot capability" });
  } finally { shell.cleanup(); }
});

test("workloads: isolation reports a leaked secret by name only, never its value", async () => {
  setHostTargets(() => ({ ips: ["192.0.2.10"], port: 4317 }));
  const shell = shellProvider({ env: { HOME: "/root", LEAKY_TOKEN: "sk-saved-secret-123456" } });
  try {
    const { run, result } = await runWorkloads(shell.provider, { sections: ["isolation"] }, { E2B_API_KEY: "sk-saved-secret-123456" });
    const data = result.sections.isolation!.data!;
    assert.equal(result.sections.isolation!.verdict, "info");
    assert.deepEqual(data.leaked, ["LEAKY_TOKEN"]);
    assert.deepEqual([(data.internet as { reached: boolean }).reached, (data.host as { reached: boolean }[])[0]!.reached], [true, false]);
    assert.ok(!JSON.stringify(run.events).includes("sk-saved-secret-123456"), "the value never appears in an event");
  } finally { shell.cleanup(); }
  assert.deepEqual(leakedNames("A=x\nB=secret-value\nC=secret-value-2\nnot a line", ["secret-value"]), ["B"]);
  assert.deepEqual(probeResult("curl 28 000"), { reached: false, detail: "timed out" });
  assert.deepEqual(probeResult("none - -").reached, null);
});

// ---------------------------------------------------------------- task verify commands

/** Runs a task's script in a local shell with /tmp/ mapped into `dir` (and the given extra replacements). */
function sh(dir: string, script: string, replace: [string, string][] = [], env: NodeJS.ProcessEnv = process.env) {
  let text = script.replaceAll("/tmp/", `${dir}/`);
  for (const [from, to] of replace) text = text.replaceAll(from, to);
  return spawnSync("sh", ["-c", text], { encoding: "utf8", env });
}

function png(width: number, height: number, size = 3000) {
  const data = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(data);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

test("the data task's verify recomputes the totals from the generator, not from the CSV", () => {
  const dir = mkdtempSync(join(tmpdir(), "osb-task-"));
  try {
    const task = taskById.get("data")!;
    assert.equal(sh(dir, task.setup![0]!.command).status, 0);
    const totals: Record<string, number> = {};
    for (const line of readFileSync(join(dir, "data/sales.csv"), "utf8").trim().split("\n").slice(1)) {
      const [, region, , units, cents] = line.split(",");
      totals[region!] = (totals[region!] ?? 0) + Number(units) * Number(cents);
    }
    assert.deepEqual(Object.keys(totals).sort(), [...SALES_REGIONS].sort());
    writeFileSync(join(dir, "answer.json"), JSON.stringify(totals, null, 2));
    assert.equal(sh(dir, task.verify).status, 0);
    // Editing the CSV does not move the expected numbers.
    writeFileSync(join(dir, "data/sales.csv"), "id,region,product,units,price_cents\n1,north,apple,1,1\n");
    assert.equal(sh(dir, task.verify).status, 0);
    writeFileSync(join(dir, "answer.json"), JSON.stringify({ ...totals, north: totals.north! + 1 }));
    assert.equal(sh(dir, task.verify).status, 1);
    writeFileSync(join(dir, "answer.json"), JSON.stringify({ ...totals, extra: 1 }));
    assert.equal(sh(dir, task.verify).status, 1, "an extra key fails");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the browser and report verifies check the rendered value, PNG magic and size, and the PDF marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "osb-task-"));
  try {
    const browser = taskById.get("browser")!;
    writeFileSync(join(dir, "answer.txt"), `${BROWSER_VALUE}\n`);
    writeFileSync(join(dir, "shot.png"), png(800, 600));
    assert.equal(sh(dir, browser.verify).status, 0, sh(dir, browser.verify).stdout);
    assert.ok(browser.files![0]!.content.includes('"xq7v"'), "the page computes the value the verify expects");
    writeFileSync(join(dir, "answer.txt"), "loading\n");
    assert.equal(sh(dir, browser.verify).status, 1);
    writeFileSync(join(dir, "answer.txt"), `${BROWSER_VALUE}\n`);
    writeFileSync(join(dir, "shot.png"), Buffer.alloc(3000, 1));
    assert.equal(sh(dir, browser.verify).status, 1, "not a PNG");

    // Without pdftotext on PATH, the title marker in the raw bytes is required.
    const report = taskById.get("report")!;
    const env = { ...process.env, PATH: "/usr/bin:/bin" };
    mkdirSync(join(dir, "report"));
    writeFileSync(join(dir, "report/report.pdf"), `%PDF-1.4\n${"x".repeat(2000)}\n/Title (OSB-REPORT-7341)\n%%EOF\n`);
    writeFileSync(join(dir, "report/chart.png"), png(640, 480));
    assert.equal(sh(dir, report.verify, [], env).status, 0, sh(dir, report.verify, [], env).stdout);
    writeFileSync(join(dir, "report/chart.png"), png(200, 100));
    assert.equal(sh(dir, report.verify, [], env).status, 1, "a chart smaller than 400x300 fails");
    writeFileSync(join(dir, "report/chart.png"), png(640, 480));
    writeFileSync(join(dir, "report/report.pdf"), `%PDF-1.4\n${"x".repeat(2000)}\n`);
    assert.equal(sh(dir, report.verify, [], env).status, 1, "no marker fails");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the webhook verify posts fresh nonces and finds both in the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osb-task-"));
  let status = 200;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/hook") writeFileSync(join(dir, "hooks.log"), JSON.stringify(JSON.parse(body)) + "\n", { flag: "a" });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = String((server.address() as AddressInfo).port);
  const run = () => new Promise<number>(done => {
    const text = taskById.get("webhook")!.verify.replaceAll("/tmp/", `${dir}/`).replaceAll("8095", port);
    execFile("sh", ["-c", text], error => done(error ? (typeof error.code === "number" ? error.code : 1) : 0));
  });
  try {
    assert.equal(await run(), 0);
    status = 500;
    assert.equal(await run(), 1, "a service that answers 500 fails");
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});

const hasFfmpeg = spawnSync("sh", ["-c", "command -v ffmpeg && command -v ffprobe"]).status === 0;
test("the ffmpeg verify measures codec and duration with ffprobe", { skip: hasFfmpeg ? false : "ffmpeg is not installed here" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "osb-task-"));
  try {
    const make = (seconds: number) => spawnSync("sh", ["-c", `mkdir -p ${dir}/media && ffmpeg -v error -y -f lavfi -i testsrc=duration=${seconds}:size=320x240:rate=25 -c:v libx264 -pix_fmt yuv420p ${dir}/media/test.mp4 && ffmpeg -v error -y -i ${dir}/media/test.mp4 -c:v libvpx-vp9 -b:v 200k ${dir}/media/test.webm`]).status;
    const verify = taskById.get("ffmpeg")!.verify;
    assert.equal(make(2), 0);
    const ok = sh(dir, verify);
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /test\.webm: vp9/);
    assert.equal(make(1), 0);
    assert.equal(sh(dir, verify).status, 1, "a 1 s video fails");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
