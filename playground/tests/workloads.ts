// Workloads: what agents do with sandboxes besides running a command, checked without a model. Four sections,
// each in its own labelled sandbox (destroyed at the end of the section, and by the run's sweep on failure):
// - files: write and read back 1, 10 and 50 MiB of random bytes, compare sha256 outside and inside, MB/s each way;
// - persistence: a file and a background counter across pause and resume (losing the process is reported, not
//   failed: some providers stop processes on pause by design);
// - fork: snapshot a sandbox with a marker file and start N sandboxes from it in parallel;
// - isolation: outbound internet, whether this machine's playground answers from inside, whether an environment
//   variable inside equals a known secret (sha256 compared here, on the server; only the variable NAME is ever
//   reported), and the user it runs as. Informational, never a failure.
// Every step streams as a `workload` event for the live terminal; each section ends with a `result` event.
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { secretValues } from "../providers.ts";
import { createSandbox, destroySandbox, elapsed, errorInfo, has, intOption, method, sleep, waitForState, type TestContext } from "../harness.ts";
import { mbPerSecond, summarize } from "../stats.ts";

export const WORKLOAD_SECTIONS = ["files", "persistence", "fork", "isolation"] as const;
export type Section = (typeof WORKLOAD_SECTIONS)[number];
export const FILE_SIZES_MIB = [1, 10, 50];
export const MAX_FORKS = 5;

export interface WorkloadsOptions {
  sections: Section[];
  sizes: number[];
  forks: number;
}

export function workloadsOptions(raw: Record<string, unknown>): WorkloadsOptions {
  const sections = Array.isArray(raw.sections) ? WORKLOAD_SECTIONS.filter(section => (raw.sections as unknown[]).includes(section)) : [];
  const sizes = Array.isArray(raw.sizes) ? FILE_SIZES_MIB.filter(size => (raw.sizes as unknown[]).includes(size)) : [];
  return { sections: sections.length ? sections : [...WORKLOAD_SECTIONS], sizes: sizes.length ? sizes : FILE_SIZES_MIB, forks: intOption(raw.forks, 3, 1, MAX_FORKS) };
}

export type Verdict = "pass" | "fail" | "info" | "skip";
export interface SectionResult { verdict: Verdict; summary: string; data?: Record<string, unknown> }

const DIR = "/tmp/open-sb-playground";
const MiB = 1024 * 1024;
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Where the playground listens, for the isolation probe. Tests replace it. */
export let hostTargets = () => ({
  ips: Object.values(networkInterfaces()).flat().filter(entry => entry && entry.family === "IPv4" && !entry.internal).map(entry => entry!.address).slice(0, 3),
  port: Number(process.env.PORT ?? 4317),
});
export const setHostTargets = (fn: typeof hostTargets) => { hostTargets = fn; };

interface Tools {
  emit: (event: Record<string, unknown>) => void;
  /** Runs `fn` as one terminal line: a spinner while it runs, then ok / failed / info with a detail. */
  step<T>(text: string, fn: () => Promise<T>, describe?: (value: T) => { ok?: boolean | null; detail?: string }): Promise<T>;
}

function tools(ctx: TestContext, section: Section): Tools {
  let count = 0;
  const emit = (event: Record<string, unknown>) => ctx.emit({ type: "workload", section, ...event });
  return {
    emit,
    async step(text, fn, describe) {
      const id = `${section}-${++count}`;
      emit({ kind: "step", id, text });
      const started = performance.now();
      try {
        const value = await fn();
        const shown = describe?.(value) ?? {};
        emit({ kind: "step_done", id, ok: shown.ok === undefined ? true : shown.ok, detail: shown.detail, ms: elapsed(started) });
        return value;
      } catch (error) {
        emit({ kind: "step_done", id, ok: false, detail: errorInfo(error).message, ms: elapsed(started) });
        throw error;
      }
    },
  };
}

/** A sandbox for one section: created and waited on as steps, always destroyed afterwards. */
async function withSandbox<T>(ctx: TestContext, t: Tools, fn: (id: string) => Promise<T>): Promise<T> {
  const id = await t.step("create sandbox", async () => { const id = await createSandbox(ctx); await waitForState(ctx, id, "running"); return id; }, id => ({ detail: id }));
  try {
    return await fn(id);
  } finally {
    await t.step("destroy sandbox", () => destroySandbox(ctx, id)).catch(() => undefined);
  }
}

/** Runs a shell command, failing the step on a non-zero exit. Returns trimmed stdout. */
async function sh(ctx: TestContext, id: string, command: string, timeoutMs = 60_000): Promise<string> {
  const result = await ctx.provider.exec(id, command, { timeoutMs, signal: ctx.signal });
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  return result.stdout.trim();
}

const startBackground = (ctx: TestContext, id: string, script: string) => has(ctx.provider, "background")
  ? method<(id: string, command: string, o?: object) => Promise<void>>(ctx.provider, "startBackground")(id, `sh ${script}`, { signal: ctx.signal })
  : sh(ctx, id, `nohup sh ${script} >/dev/null 2>&1 &`).then(() => undefined);

/** Waits until a command works again after resume ("running" is not always ready). */
async function untilExecWorks(ctx: TestContext, id: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const result = await ctx.provider.exec(id, "true", { signal: ctx.signal }).catch(() => null);
    if (result?.exitCode === 0) return;
    if (tries > 120) throw new Error("exec still fails a minute after resume");
    await sleep(500, ctx.signal);
  }
}

// ---------------------------------------------------------------- files

/** sha256 and size of a file inside the sandbox, with whichever tool the image has. */
const HASH = (path: string) => `(sha256sum ${path} 2>/dev/null || shasum -a 256 ${path} 2>/dev/null || openssl dgst -sha256 -r ${path}) | cut -c1-64; wc -c < ${path}`;

async function files(ctx: TestContext, t: Tools, sizes: number[]): Promise<SectionResult> {
  return withSandbox(ctx, t, async id => {
    await sh(ctx, id, `mkdir -p ${DIR}`);
    const rows: Record<string, unknown>[] = [];
    const problems: string[] = [];
    for (const mib of sizes) {
      const bytes = new Uint8Array(randomBytes(mib * MiB));
      const expected = sha256(bytes);
      const path = `${DIR}/blob-${mib}.bin`;
      const row: Record<string, unknown> = { mib, bytes: bytes.length };
      rows.push(row);
      try {
        let started = performance.now();
        await t.step(`write ${mib} MiB`, () => ctx.provider.writeFile(id, path, bytes, { signal: ctx.signal }), () => ({ detail: `${Math.round(mbPerSecond(bytes.length, elapsed(started)))} MB/s` }));
        row.writeMbps = round(mbPerSecond(bytes.length, elapsed(started)));
        const [inside = "", size = ""] = (await t.step(`sha256 of ${mib} MiB inside the sandbox`, () => sh(ctx, id, HASH(path), 120_000), output => {
          const [hash, length] = output.split("\n").map(line => line.trim());
          const ok = hash === expected && Number(length) === bytes.length;
          return { ok: /^[0-9a-f]{64}$/.test(hash ?? "") ? ok : null, detail: /^[0-9a-f]{64}$/.test(hash ?? "") ? (ok ? "matches" : `${length} bytes, sha256 ${hash!.slice(0, 12)}... differs`) : "no sha256 tool in the image" };
        })).split("\n").map(line => line.trim());
        row.insideOk = /^[0-9a-f]{64}$/.test(inside) ? inside === expected && Number(size) === bytes.length : null;
        row.insideBytes = Number(size);
        if (row.insideOk === false) problems.push(`${mib} MiB: the sandbox holds ${size} bytes that differ from the ${bytes.length} written`);
        started = performance.now();
        const back = await t.step(`read ${mib} MiB back`, () => ctx.provider.readFile(id, path, { signal: ctx.signal }), back => {
          const same = back.length === bytes.length && sha256(back) === expected;
          return { ok: same, detail: same ? `${Math.round(mbPerSecond(back.length, elapsed(started)))} MB/s, sha256 matches` : `readFile returned ${back.length} bytes that differ from the ${bytes.length} written` };
        });
        row.readMbps = round(mbPerSecond(back.length, elapsed(started)));
        row.readBytes = back.length;
        row.readOk = back.length === bytes.length && sha256(back) === expected;
        if (!row.readOk) problems.push(`${mib} MiB: readFile returned ${back.length} bytes that differ from the ${bytes.length} written`);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        row.error = errorInfo(error).message;
        problems.push(`${mib} MiB: ${row.error as string}`);
      }
    }
    return problems.length
      ? { verdict: "fail", summary: problems.join("; "), data: { sizes: rows } }
      : { verdict: "pass", summary: sizes.map(mib => `${mib} MiB ok`).join(", "), data: { sizes: rows } };
  });
}

// ---------------------------------------------------------------- persistence

async function persistence(ctx: TestContext, t: Tools): Promise<SectionResult> {
  if (!has(ctx.provider, "pause")) return { verdict: "skip", summary: `${ctx.title} has no pause capability` };
  const pause = method<(id: string, o: object) => Promise<void>>(ctx.provider, "pause");
  const resume = method<(id: string, o: object) => Promise<void>>(ctx.provider, "resume");
  return withSandbox(ctx, t, async id => {
    const token = randomBytes(8).toString("hex");
    await t.step("write a file", () => ctx.provider.writeFile(id, `${DIR}/persist.txt`, token, { signal: ctx.signal }));
    await ctx.provider.writeFile(id, `${DIR}/counter.sh`, `echo $$ > ${DIR}/counter.pid; i=0; while true; do i=$((i+1)); echo $i > ${DIR}/counter; sleep 1; done\n`, { signal: ctx.signal });
    await t.step("start a background counter (+1 a second)", () => startBackground(ctx, id, `${DIR}/counter.sh`));
    await sleep(3_000, ctx.signal);
    const before = Number(await t.step("read the counter", () => sh(ctx, id, `cat ${DIR}/counter`), value => ({ detail: value })));
    let started = performance.now();
    await t.step("pause", async () => { await pause(id, { signal: ctx.signal }); await waitForState(ctx, id, "stopped", 180_000); });
    const pauseMs = elapsed(started);
    started = performance.now();
    await t.step("resume", async () => { await resume(id, { signal: ctx.signal }); await waitForState(ctx, id, "running", 180_000); await untilExecWorks(ctx, id); });
    const resumeMs = elapsed(started);
    const content = await t.step("check the file", () => sh(ctx, id, `cat ${DIR}/persist.txt 2>/dev/null || true`), value => ({ ok: value === token, detail: value === token ? "still there" : "lost or changed" }));
    const fileKept = content === token;
    const after = Number(await sh(ctx, id, `cat ${DIR}/counter 2>/dev/null || echo 0`));
    await sleep(2_500, ctx.signal);
    const later = Number(await sh(ctx, id, `cat ${DIR}/counter 2>/dev/null || echo 0`));
    const alive = await sh(ctx, id, `kill -0 "$(cat ${DIR}/counter.pid 2>/dev/null)" 2>/dev/null && echo alive || echo gone`);
    const survived = alive === "alive" && later > after;
    await t.step("check the counter process", async () => survived, () => ({ ok: survived ? true : null, detail: survived ? `survived (counter ${before} -> ${after} -> ${later})` : `stopped by pause (counter ${before} -> ${after} -> ${later})` }));
    const data = { fileKept, processSurvived: survived, counter: { before, after, later }, pauseMs, resumeMs };
    return fileKept
      ? { verdict: "pass", summary: `File kept; background process ${survived ? "survived" : "did not survive"} pause and resume`, data }
      : { verdict: "fail", summary: "The file written before pause was gone after resume", data };
  });
}

// ---------------------------------------------------------------- fork

async function fork(ctx: TestContext, t: Tools, count: number): Promise<SectionResult> {
  if (!has(ctx.provider, "snapshot")) return { verdict: "skip", summary: `${ctx.title} has no snapshot capability` };
  const snapshot = method<(id: string, name: string, o: object) => Promise<void>>(ctx.provider, "snapshot");
  const deleteSnapshot = method<(name: string, o: object) => Promise<void>>(ctx.provider, "deleteSnapshot");
  const name = `osb-${ctx.runId}`;
  const token = randomBytes(8).toString("hex");
  let snapshotMs = 0, taken = false;
  const forks: { ms?: number; ok: boolean; error?: string }[] = [];
  try {
    await withSandbox(ctx, t, async id => {
      await t.step("write a marker file", () => ctx.provider.writeFile(id, `${DIR}/marker`, token, { signal: ctx.signal }));
      const started = performance.now();
      await t.step(`snapshot as ${name}`, () => snapshot(id, name, { signal: ctx.signal }));
      snapshotMs = elapsed(started);
      taken = true;
    });
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const started = performance.now();
      let id: string | undefined;
      try {
        await t.step(`fork ${index + 1}: create from the snapshot and read the marker`, async () => {
          id = await createSandbox(ctx, {}, name);
          await waitForState(ctx, id, "running");
          const marker = await sh(ctx, id, `cat ${DIR}/marker 2>/dev/null || true`);
          if (marker !== token) throw new Error("the marker file is missing or different");
        }, () => ({ detail: `ready with the marker in ${Math.round(elapsed(started))} ms` }));
        forks[index] = { ms: elapsed(started), ok: true };
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        forks[index] = { ok: false, error: errorInfo(error).message };
      } finally {
        if (id) await destroySandbox(ctx, id).catch(() => undefined);
      }
    }));
  } finally {
    if (taken) await t.step(`delete snapshot ${name}`, () => deleteSnapshot(name, { signal: AbortSignal.timeout(120_000) })).catch(() => undefined);
  }
  const ok = forks.filter(entry => entry.ok);
  const times = summarize(ok.map(entry => entry.ms!));
  const data = { snapshotMs, forks, forkMs: times };
  return ok.length === count
    ? { verdict: "pass", summary: `${count} fork${count === 1 ? "" : "s"} had the marker; ready in ${Math.round(times.p50)} ms (p50), snapshot took ${Math.round(snapshotMs)} ms`, data }
    : { verdict: "fail", summary: `${count - ok.length} of ${count} forks failed: ${forks.find(entry => !entry.ok)?.error ?? ""}`, data };
}

// ---------------------------------------------------------------- isolation

const INTERNET_URL = "https://example.com/";

/** Prints "<tool> <exit code> <http code>" for a GET with a timeout, using whatever client the image has. */
const probe = (url: string, seconds: number) => `if command -v curl >/dev/null 2>&1; then code=$(curl -sS -o /dev/null -m ${seconds} -w '%{http_code}' ${url} 2>/dev/null); echo "curl $? $code"
elif command -v wget >/dev/null 2>&1; then wget -q -T ${seconds} -O /dev/null ${url} 2>/dev/null; echo "wget $? -"
elif command -v python3 >/dev/null 2>&1; then python3 -c "
import sys, urllib.request, urllib.error
try: print('python3 0', urllib.request.urlopen('${url}', timeout=${seconds}).status)
except urllib.error.HTTPError as e: print('python3 0', e.code)
except Exception as e: print('python3 1 -')"
else echo "none - -"; fi`;

/** Whether a probe got an HTTP answer, from its output. curl's exit 7 is a refused connection, 28 a timeout. */
export function probeResult(output: string): { reached: boolean | null; detail: string } {
  const [tool = "none", code = "", status = "-"] = output.trim().split(/\s+/);
  if (tool === "none") return { reached: null, detail: "no curl, wget or python3 in the image" };
  if (code === "0" && status !== "-" && status !== "000") return { reached: true, detail: `HTTP ${status} (${tool})` };
  if (code === "0" && tool === "wget") return { reached: true, detail: "answered (wget)" };
  if (tool === "curl" && code === "7") return { reached: false, detail: "connection refused" };
  if (tool === "curl" && code === "28") return { reached: false, detail: "timed out" };
  if (tool === "curl" && code === "6") return { reached: false, detail: "name not resolved" };
  return { reached: false, detail: `no answer (${tool} exit ${code})` };
}

/** Names of environment variables whose value equals a known secret. Compares sha256 digests only. */
export function leakedNames(envOutput: string, secrets: string[]): string[] {
  const known = new Set(secrets.map(secret => sha256(secret)));
  const names: string[] = [];
  for (const line of envOutput.split("\n")) {
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const name = line.slice(0, equals);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && known.has(sha256(line.slice(equals + 1)))) names.push(name);
  }
  return [...new Set(names)];
}

async function isolation(ctx: TestContext, t: Tools): Promise<SectionResult> {
  return withSandbox(ctx, t, async id => {
    const [uid = "", user = ""] = (await t.step("who does it run as", () => sh(ctx, id, "id -u; id -un 2>/dev/null || whoami 2>/dev/null || echo unknown"),
      output => { const [uid, name] = output.split("\n"); return { ok: null, detail: `${name?.trim()} (uid ${uid?.trim()})${uid?.trim() === "0" ? ", root" : ", not root"}` }; })).split("\n").map(line => line.trim());
    const internet = probeResult(await t.step(`outbound internet: GET ${INTERNET_URL}`, () => sh(ctx, id, probe(INTERNET_URL, 8), 30_000),
      output => { const result = probeResult(output); return { ok: null, detail: result.reached === null ? result.detail : `${result.reached ? "reachable" : "unreachable"}: ${result.detail}` }; }));
    const { ips, port } = hostTargets();
    const host: { ip: string; reached: boolean | null; detail: string }[] = [];
    for (const ip of ips) {
      const url = `http://${ip}:${port}/api/status`;
      const result = probeResult(await t.step(`this machine's playground: GET ${url}`, () => sh(ctx, id, probe(url, 4), 30_000),
        output => { const result = probeResult(output); return { ok: null, detail: result.reached === null ? result.detail : `${result.reached ? "REACHABLE" : "unreachable"}: ${result.detail}` }; }));
      host.push({ ip, ...result });
    }
    // The environment's values never leave this function: only digests are compared, only names are reported.
    const leaked = await t.step("secrets in the environment (sha256 compared on this server)", async () => {
      const result = await ctx.provider.exec(id, "env", { signal: ctx.signal });
      return leakedNames(result.stdout, secretValues(ctx.env));
    }, names => ({ ok: names.length === 0, detail: names.length ? `a known secret is in: ${names.join(", ")}` : "no secrets leaked" }));
    const reachable = host.some(entry => entry.reached);
    return {
      verdict: "info",
      summary: [
        internet.reached === null ? "internet unknown (no HTTP client)" : `internet ${internet.reached ? "reachable" : "unreachable"}`,
        ips.length === 0 ? "no LAN address to probe" : `this machine ${reachable ? "REACHABLE" : "unreachable"}`,
        leaked.length ? `secret value in ${leaked.join(", ")}` : "no secrets leaked",
        uid === "0" ? "runs as root" : `runs as ${user || "uid " + uid} (not root)`,
      ].join("; "),
      data: { internet, host, leaked, uid: Number(uid), user, root: uid === "0" },
    };
  });
}

// ---------------------------------------------------------------- the test

const TITLES: Record<Section, string> = {
  files: "Files: write, read back and compare", persistence: "Persistence across pause and resume",
  fork: "Fork from a snapshot", isolation: "Isolation",
};

export async function workloads(ctx: TestContext) {
  const options = workloadsOptions(ctx.options);
  const sections: Partial<Record<Section, SectionResult>> = {};
  for (const section of options.sections) {
    const t = tools(ctx, section);
    t.emit({ kind: "section", title: TITLES[section] });
    let result: SectionResult;
    try {
      result = section === "files" ? await files(ctx, t, options.sizes)
        : section === "persistence" ? await persistence(ctx, t)
        : section === "fork" ? await fork(ctx, t, options.forks)
        : await isolation(ctx, t);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      result = { verdict: "fail", summary: errorInfo(error).message };
    }
    sections[section] = result;
    t.emit({ kind: "result", ...result });
  }
  return { sections };
}

const round = (value: number) => Math.round(value * 10) / 10;
