// The playground's HTTP API and static UI, on Node's built-in http server. Requests must come from this
// machine by name (Host and Origin are checked against localhost to block DNS rebinding), POSTs must be JSON,
// and no response ever carries a credential: provider and key status list variable names only, and every
// run event is redacted against the known secret values (environment and saved) before it is stored. Keys saved
// from the UI (credentials.ts) are merged in on every request, so a new key needs no restart.
import { readFile } from "node:fs/promises";
import http from "node:http";
import { LABEL, errorInfo, liveCount, runAcrossProviders, destroySandbox, type TestFn } from "./harness.ts";
import { byModule, getProvider, logoFile, providerStatuses, secretValues } from "./providers.ts";
import { Run, RunStore } from "./runs.ts";
import { FALLBACK_MODELS, MODELS, EFFORTS, PRICES } from "./agent-loop.ts";
import { TASKS } from "./tasks.ts";
import { CLAUDE, OPENAI, CredentialError, credentialStatuses, isModelKey, mergedEnv, removeValues, saveValues, savedSecretValues, validateValues } from "./credentials.ts";
import { testClaude, testOpenAI, testProvider } from "./connection.ts";
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS, OPENAI_PRICES } from "./openai-loop.ts";
import { agent, agentOptions, backendOf, claudeCredentials, estimateUsd, openaiCredentials } from "./tests/agent.ts";
import { capabilities, CHECKS } from "./tests/capabilities.ts";
import { load, loadOptions, MAX_LOAD } from "./tests/load.ts";
import { speed, speedOptions } from "./tests/speed.ts";
import { stream, streamOptions } from "./tests/stream.ts";
import { FILE_SIZES_MIB, MAX_FORKS, WORKLOAD_SECTIONS, workloads, workloadsOptions } from "./tests/workloads.ts";

type Env = Record<string, string | undefined>;

export const TESTS: Record<string, { run: TestFn; options: (raw: Record<string, unknown>) => object }> = {
  speed: { run: speed, options: speedOptions },
  stream: { run: stream, options: streamOptions },
  agent: { run: agent, options: agentOptions },
  load: { run: load, options: loadOptions },
  workloads: { run: workloads, options: workloadsOptions },
  capabilities: { run: capabilities, options: () => ({}) },
};

/** Runs at the same time; more are refused until one ends. */
export const MAX_ACTIVE_RUNS = 3;

/** The built web UI (playground/web, built by `pnpm run playground` or `pnpm run playground:build`). */
const WEB = new URL("./web/dist/", import.meta.url);
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", woff2: "font/woff2", woff: "font/woff",
};
// Frames: the live desktop viewer and port previews, which providers serve over HTTPS.
const CSP = "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src https:; frame-ancestors 'none'; base-uri 'none'";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface AppOptions {
  env?: Env;
  /** The port the server is reachable on, for the Host and Origin checks. Read lazily: it may be 0 until listening. */
  port: () => number;
}

export function createApp(options: AppOptions) {
  const baseEnv = options.env ?? process.env;
  /** Environment variables with keys saved in the UI on top, read fresh so a saved key needs no restart. */
  const currentEnv = () => mergedEnv(baseEnv);
  const runs = new RunStore();
  const redactor = (env: Env) => {
    const secrets = [...new Set([...secretValues(env), ...savedSecretValues()])].sort((a, b) => b.length - a.length);
    return (text: string) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  };
  const redact = (text: string) => redactor(currentEnv())(text);

  function allowedHost(host: string | undefined): boolean {
    if (!host) return false;
    const port = options.port();
    return ["127.0.0.1", "localhost", "[::1]"].some(name => host === `${name}:${port}`);
  }

  function allowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    const port = options.port();
    return ["127.0.0.1", "localhost", "[::1]"].some(name => origin === `http://${name}:${port}`);
  }

  async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "POST and PUT bodies must be application/json");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 64 * 1024) throw new HttpError(413, "Body too large");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString() || "{}";
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Body must be a JSON object");
    }
  }

  const json = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(value));
  };

  async function startRun(input: Record<string, unknown>) {
    const test = typeof input.test === "string" ? input.test : "";
    const spec = TESTS[test];
    if (!spec) throw new HttpError(400, `Unknown test. Use one of: ${Object.keys(TESTS).join(", ")}`);
    const requested = Array.isArray(input.providers) ? [...new Set(input.providers.filter((name): name is string => typeof name === "string"))] : [];
    if (requested.length === 0) throw new HttpError(400, "Pick at least one provider");
    const env = currentEnv();
    const statuses = await providerStatuses(env);
    for (const name of requested) {
      const status = statuses.find(entry => entry.module === name);
      if (!status) throw new HttpError(400, `Unknown provider ${name}`);
      if (!status.available) throw new HttpError(400, `${status.title} is not available: ${status.howToEnable}`);
    }
    if (test === "agent") {
      const model = agentOptions(typeof input.options === "object" && input.options !== null ? input.options as Record<string, unknown> : {}).model;
      if (backendOf(model) === "openai" && !openaiCredentials(env).available)
        throw new HttpError(400, "No OpenAI credentials: add a key with OpenAI key in the playground, or set OPENAI_API_KEY");
      if (backendOf(model) === "claude" && !(await claudeCredentials(env)).available)
        throw new HttpError(400, "No Claude credentials: add a key with Claude key in the playground, set ANTHROPIC_API_KEY, or run `ant auth login`");
    }
    if (runs.active().length >= MAX_ACTIVE_RUNS) throw new HttpError(429, `At most ${MAX_ACTIVE_RUNS} runs at a time; wait for one to finish or cancel it`);
    const raw = typeof input.options === "object" && input.options !== null && !Array.isArray(input.options) ? input.options as Record<string, unknown> : {};
    const run = new Run(test, requested, spec.options(raw) as Record<string, unknown>, redactor(env));
    runs.add(run);
    const providers = requested.map(module => ({ module, title: byModule.get(module)!.title, provider: getProvider(module, env) }));
    run.emit({ type: "log", level: "info", message: `Run ${run.id}: ${test} on ${requested.join(", ")}` });
    runAcrossProviders(run, providers, spec.run, env)
      .then(() => run.finish(run.signal.aborted ? "cancelled" : "done"))
      .catch(error => { run.emit({ type: "error", ...errorInfo(error) }); run.finish("failed"); });
    return run;
  }

  function events(req: http.IncomingMessage, res: http.ServerResponse, run: Run, url: URL) {
    const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("from") ?? -1);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": open-sb playground\n\n");
    const unsubscribe = run.subscribe((event, index) => {
      if (res.writableEnded) return;
      res.write(`id: ${index}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done") res.end();
    }, Number.isFinite(lastId) ? lastId + 1 : 0);
    if (run.finished && !res.writableEnded) res.end();
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000);
    const close = () => { clearInterval(heartbeat); unsubscribe(); };
    res.once("close", close);
    if (res.writableEnded) close();
  }

  async function cleanup() {
    const env = currentEnv();
    const active = new Set(runs.active().map(run => run.id));
    const statuses = (await providerStatuses(env)).filter(status => status.available);
    const report: Record<string, { destroyed: number; skipped: number; error?: string }> = {};
    await Promise.all(statuses.map(async status => {
      const entry = { destroyed: 0, skipped: 0 } as { destroyed: number; skipped: number; error?: string };
      report[status.module] = entry;
      const provider = getProvider(status.module, env);
      try {
        const sandboxes = (await provider.list({ signal: AbortSignal.timeout(60_000) }))
          .filter(sandbox => sandbox.labels[LABEL] !== undefined && sandbox.state !== "gone");
        for (const sandbox of sandboxes) {
          if (active.has(sandbox.labels[LABEL]!)) { entry.skipped++; continue; }
          await destroySandbox({ module: status.module, provider }, sandbox.id);
          entry.destroyed++;
        }
      } catch (error) {
        entry.error = redact(errorInfo(error).message);
      }
    }));
    return report;
  }

  async function overview() {
    const env = currentEnv();
    const claude = await claudeCredentials(env);
    return {
      providers: await providerStatuses(env),
      claude: {
        available: claude.available, source: claude.source,
        models: MODELS.map(id => ({ id, price: PRICES[id], fallback: FALLBACK_MODELS.has(id), estimatePerTaskUsd: estimateUsd(id, 1) })),
        efforts: EFFORTS,
      },
      openai: {
        ...openaiCredentials(env),
        models: OPENAI_MODELS.map(id => ({ id, price: OPENAI_PRICES[id] ?? null, fallback: false, estimatePerTaskUsd: estimateUsd(id, 1) })),
        defaultModel: OPENAI_DEFAULT_MODEL,
      },
      tasks: TASKS.map(task => ({ id: task.id, title: task.title, heavy: Boolean(task.heavy) })),
      checks: CHECKS,
      limits: { maxLoad: MAX_LOAD, maxActiveRuns: MAX_ACTIVE_RUNS, maxForks: MAX_FORKS },
      workloads: { sections: WORKLOAD_SECTIONS, sizes: FILE_SIZES_MIB },
      liveSandboxes: liveCount(),
    };
  }

  /** Saved values for a module merged with candidate ones, as the environment a test or a run would see. */
  const candidateEnv = (module: string, values: Record<string, string>) => ({ ...currentEnv(), ...values });
  const testWith = (module: string, env: Env) => module === CLAUDE ? testClaude(env) : module === OPENAI ? testOpenAI(env) : testProvider(module, env);

  async function credentials(req: http.IncomingMessage, res: http.ServerResponse, method: string, module: string, test: boolean) {
    if (!isModelKey(module) && !byModule.has(module)) throw new HttpError(404, `Unknown provider ${module}`);
    const status = () => credentialStatuses(baseEnv).find(entry => entry.module === module);
    try {
      if (test && method === "POST") {
        const input = await body(req);
        const values = validateValues(module, input.values ?? {});
        return json(res, 200, { test: await testWith(module, candidateEnv(module, values)) });
      }
      if (!test && method === "PUT") {
        const input = await body(req);
        const values = validateValues(module, input.values ?? {});
        if (Object.keys(values).length === 0) throw new HttpError(400, "Enter at least one value to save");
        const result = await testWith(module, candidateEnv(module, values));
        // A failed test does not save unless the user asked to save anyway.
        if (!result.ok && input.force !== true) return json(res, 200, { saved: false, test: result, credential: status() });
        saveValues(module, values);
        return json(res, 200, { saved: true, test: result, credential: status() });
      }
      if (!test && method === "DELETE") {
        removeValues(module);
        return json(res, 200, { removed: true, credential: status() });
      }
    } catch (error) {
      if (error instanceof CredentialError) throw new HttpError(400, error.message);
      throw error;
    }
    throw new HttpError(405, "Method not allowed");
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!allowedHost(req.headers.host)) throw new HttpError(403, "This server only answers requests for localhost");
    if (!allowedOrigin(req.headers.origin)) throw new HttpError(403, "Cross-origin requests are refused");
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // The UI: index.html for the page, hashed files under /assets/ (names checked, so no path can escape dist).
    const asset = /^\/assets\/([A-Za-z0-9_.-]+\.(js|css|woff2|woff|svg|png))$/.exec(path);
    if (method === "GET" && (path === "/" || path === "/index.html" || asset)) {
      const file = asset ? `assets/${asset[1]}` : "index.html";
      let content: Buffer;
      try { content = await readFile(new URL(file, WEB)); }
      catch { throw new HttpError(asset ? 404 : 503, asset ? "Not found" : "The web UI is not built: run pnpm run playground (it builds it) or pnpm run playground:build"); }
      res.writeHead(200, {
        "Content-Type": TYPES[file.split(".").pop()!]!, "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-cache",
        "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      });
      return res.end(content);
    }
    const logo = /^\/logos\/([a-z0-9]+)\.(svg|png)$/.exec(path);
    if (method === "GET" && logo) {
      const file = logoFile(logo[1]!);
      if (!file || !file.pathname.endsWith(`.${logo[2]}`)) throw new HttpError(404, "No logo");
      res.writeHead(200, { "Content-Type": TYPES[logo[2]!]!, "Cache-Control": "max-age=300", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff" });
      return res.end(await readFile(file));
    }

    if (method === "GET" && path === "/api/providers") return json(res, 200, await overview());
    if (method === "GET" && path === "/api/status") return json(res, 200, { liveSandboxes: liveCount(), activeRuns: runs.active().map(run => run.id) });
    if (method === "GET" && path === "/api/runs") return json(res, 200, { runs: runs.all().map(run => run.summary()) });
    if (method === "POST" && path === "/api/runs") {
      const run = await startRun(await body(req));
      return json(res, 201, { runId: run.id });
    }
    if (method === "POST" && path === "/api/cleanup") {
      await body(req);
      return json(res, 200, { cleanup: await cleanup() });
    }
    if (method === "GET" && path === "/api/credentials")
      return json(res, 200, { path: "~/.config/open-sb/credentials.json", credentials: credentialStatuses(baseEnv) });
    const credential = /^\/api\/credentials\/([a-z0-9]+)(\/test)?$/.exec(path);
    if (credential) return credentials(req, res, method, credential[1]!, Boolean(credential[2]));
    const match = /^\/api\/runs\/([a-z0-9-]+)(?:\/(events|cancel|export))?$/.exec(path);
    if (match) {
      const run = runs.get(match[1]!);
      if (!run) throw new HttpError(404, "No such run");
      const action = match[2];
      if (method === "GET" && !action) return json(res, 200, run.summary());
      if (method === "GET" && action === "events") return events(req, res, run, url);
      if (method === "GET" && action === "export")
        return json(res, 200, { ...run.summary(), events: run.events }, { "Content-Disposition": `attachment; filename="open-sb-${run.test}-${run.id}.json"` });
      if (method === "POST" && action === "cancel") {
        await body(req);
        if (!run.finished) run.controller.abort(new DOMException("Cancelled", "AbortError"));
        return json(res, 202, { status: run.finished ? run.status : "cancelling" });
      }
    }
    throw new HttpError(404, "Not found");
  }

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    route(req, res).catch(error => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : redact(errorInfo(error).message);
      if (status === 500) console.error(`playground: ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    });
  };

  return { handler, runs, redact };
}
