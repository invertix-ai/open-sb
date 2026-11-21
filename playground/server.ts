// Starts the playground: `pnpm run playground`. Listens on 127.0.0.1 only (PORT overrides the default 4317).
// On Ctrl-C it cancels active runs and waits for their sandboxes to be destroyed before exiting.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`PORT must be a port number, got ${process.env.PORT}`);

const server = http.createServer();
const app = createApp({ port: () => (server.address() as AddressInfo | null)?.port ?? port });
server.on("request", app.handler);
server.on("upgrade", app.upgrade);
server.listen(port, "127.0.0.1", () => {
  console.log(`open-sb playground: http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
});

let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) process.exit(1);
  stopping = true;
  const active = app.runs.active();
  if (active.length) console.log(`Cancelling ${active.length} run(s) and destroying their sandboxes (Ctrl-C again to quit now)`);
  for (const run of active) run.controller.abort(new DOMException("Cancelled", "AbortError"));
  const deadline = Date.now() + 60_000;
  while (app.runs.active().length && Date.now() < deadline) await new Promise(done => setTimeout(done, 200));
  process.exit(0);
});
