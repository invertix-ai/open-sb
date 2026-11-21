// Desktop access for the browser. A provider's desktop connection may need headers a browser cannot send (an
// E2B sandbox with private traffic needs its traffic token on every request, WebSockets included). Those
// connections stay on this server: the page gets a same-origin relay path with an unguessable token, and the
// upgrade handler opens the provider WebSocket with the headers added, then pipes bytes both ways. A relay only
// serves its own run while that run is active and still owns the sandbox; it closes when the run ends.
import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { DesktopConnection } from "../src/types.ts";

/** What the page receives: never provider headers. `websocketUrl` may be a same-origin relay path. */
export interface BrowserDesktop {
  url: string;
  websocketUrl?: string;
  expiresAt?: Date;
  password?: string;
}

export interface RelayOwner { runId: string; module: string; sandboxId: string }

interface Relay extends RelayOwner { target: URL; headers: Record<string, string>; sockets: Set<Duplex> }

const relays = new Map<string, Relay>();
const PATH = /^\/api\/desktop-relay\/([A-Za-z0-9_-]{32})$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{1,4096}$/;

/** The connection as the page may see it. Header-bound access is registered for relaying instead of sent. */
export function browserDesktop(connection: DesktopConnection, owner: RelayOwner): BrowserDesktop {
  const { url, websocketUrl, expiresAt, password, headers } = connection;
  const visible = { ...(expiresAt ? { expiresAt } : {}), ...(password ? { password } : {}) };
  if (!headers || Object.keys(headers).length === 0) return { url, ...(websocketUrl ? { websocketUrl } : {}), ...visible };
  const target = websocketUrl ? new URL(websocketUrl) : undefined;
  const valid = Object.entries(headers).every(([name, value]) => HEADER_NAME.test(name) && HEADER_VALUE.test(value));
  // The viewer page itself cannot be relayed (its assets would need the header too), so no `url` either.
  if (!target || target.protocol !== "wss:" || target.username || target.password || !valid)
    throw new Error("This desktop needs credentials the browser cannot send, and it has no WebSocket to relay");
  // One relay per sandbox and run: a reconnect gets the same path, with the newest target and headers.
  for (const [token, relay] of relays)
    if (relay.runId === owner.runId && relay.module === owner.module && relay.sandboxId === owner.sandboxId) {
      relay.target = target; relay.headers = { ...headers };
      return { url: "", websocketUrl: `/api/desktop-relay/${token}`, ...visible };
    }
  const token = randomBytes(24).toString("base64url");
  relays.set(token, { ...owner, target, headers: { ...headers }, sockets: new Set() });
  return { url: "", websocketUrl: `/api/desktop-relay/${token}`, ...visible };
}

/** Ends a run's relays and their open connections. */
export function closeRelays(runId: string): void {
  for (const [token, relay] of relays)
    if (relay.runId === runId) {
      for (const socket of relay.sockets) socket.destroy();
      relays.delete(token);
    }
}

const refuse = (socket: Duplex, status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

/**
 * Handles an HTTP upgrade. Returns false when the path is not a relay path, so other upgrade handlers can run.
 * `allowed` applies the server's request checks (Host, Origin) and whether the relay's run still owns the sandbox.
 */
export function relayUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, allowed: (owner: RelayOwner) => boolean): boolean {
  const token = PATH.exec(new URL(req.url ?? "/", "http://relay").pathname)?.[1];
  if (!token && !(req.url ?? "").startsWith("/api/desktop-relay/")) return false;
  const relay = token ? relays.get(token) : undefined;
  if (!relay || !allowed(relay)) { refuse(socket, "403 Forbidden"); return true; }
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof req.headers["sec-websocket-key"] !== "string") { refuse(socket, "400 Bad Request"); return true; }

  const { target } = relay;
  // Only what a WebSocket handshake needs is forwarded: no cookies, no Origin, nothing else from the page.
  const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, "Upgrade: websocket", "Connection: Upgrade"];
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const value = req.headers[name];
    if (typeof value === "string" && HEADER_VALUE.test(value)) lines.push(`${name}: ${value}`);
  }
  for (const [name, value] of Object.entries(relay.headers)) lines.push(`${name}: ${value}`);

  const upstream = tls.connect({ host: target.hostname, port: Number(target.port || 443), servername: target.hostname, ALPNProtocols: ["http/1.1"] });
  upstream.setTimeout(20_000, () => upstream.destroy());
  relay.sockets.add(socket);
  const close = () => { upstream.destroy(); socket.destroy(); relay.sockets.delete(socket); };
  upstream.on("error", close); upstream.on("close", close);
  socket.on("error", close); socket.on("close", close);
  upstream.once("secureConnect", () => {
    upstream.setTimeout(0);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    // The provider's 101 answer (its Sec-WebSocket-Accept matches the page's key) and every frame pass through.
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  return true;
}
