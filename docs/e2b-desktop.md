# E2B desktop streaming

The E2B provider implements the `desktop` capability. The playground shows a live VNC stream of an E2B sandbox,
with mouse and keyboard control, in the Desktop and Agent views.

## Provider contract

```ts
import { e2b } from "@invertix/open-sb/e2b";

const provider = e2b({
  apiKey: process.env.E2B_API_KEY,
  desktopResolution: [1280, 800], // default [1024, 768]
  // publicTraffic: false,        // private port URLs; see "Private traffic" below
});
const sandbox = await provider.create({ image: "desktop" }); // E2B's desktop template
const access = await provider.desktop(sandbox.id);

if ("url" in access) {
  // Send only to a viewer authorized to access this sandbox:
  // access.url          — E2B's noVNC page; the password is in the URL fragment (#password=…)
  // access.websocketUrl — RFB stream (wss://6080-<id>.e2b.app/websockify) for an embedded noVNC client
  // access.password     — the VNC password that stream asks for (noVNC `credentials.password`)
  // access.headers      — only on private sandboxes: relay the connection server-side
}

await provider.destroy(sandbox.id);
```

`DesktopConnection` gains two optional fields, used by E2B and available to any provider:

- `password`: the RFB password `websocketUrl` asks for.
- `headers`: headers every request to `url` and `websocketUrl` needs. A browser cannot add headers to a page
  load or a WebSocket, so a server has to relay the connection.

E2B access has no `expiresAt`. It lasts as long as the sandbox, and `SandboxInfo.expiresAt` already reports that.

## What `desktop()` does

E2B's `desktop` template ships Xvfb, XFCE, x11vnc, noVNC/websockify and Google Chrome, but a fresh sandbox runs
none of them. E2B's own Desktop SDK starts them from the client when it creates a sandbox, and keeps the stream's
password in that client object, so another process cannot recover it. open-sb starts the stack from inside the
sandbox instead, with one idempotent script:

1. Checks for Xvfb, x11vnc and `/opt/noVNC`. If any is missing it fails with `rejected` /
   `desktop_not_in_template`, and the message names the `desktop` template.
2. Starts Xvfb on `:0` at the configured resolution if no display answers, then XFCE if it is not running.
3. Creates an 8-character VNC password once per sandbox, in `~/.config/open-sb/` (mode 0600). RFB's VNC
   authentication uses at most 8 characters.
4. Starts x11vnc on `localhost:5900` with that password if our x11vnc is not running. If another x11vnc already
   runs (for example one from E2B's Desktop SDK), it fails with `desktop_vnc_in_use` instead of disturbing it.
5. Starts noVNC's websockify on port 6080 if nothing listens there, and waits for both ports.

Every process is started with `setsid` and no inherited output; an inherited stdout would keep the command from
returning. Because the script only starts what is missing, calling `desktop()` again is cheap (about 0.25 s) and
returns the same password, so connected viewers keep working. That covers reconnects, other server processes, and
recovery: if noVNC dies, the next `desktop()` call restarts it.

The sandbox must be running. `desktop()` does not resume a paused sandbox; it fails with
`desktop_requires_running_sandbox`. Pause keeps memory, so the whole stack (and the password) survives
pause and resume; viewers are disconnected by the pause and reconnect afterwards.

## Private traffic

E2B projects created since October 30, 2026 make sandbox URLs private by default: every request, WebSockets
included, needs an `e2b-traffic-access-token` header. Without it E2B answers 403, and a query parameter does not
work instead. `publicTraffic` sets it per provider (`true` or `false`); omitted, the project's setting applies.

On a private sandbox `desktop()` returns `headers: { "e2b-traffic-access-token": … }`. The playground then keeps the
connection server-side and gives the page a same-origin relay path, `/api/desktop-relay/<random token>`
([playground/desktop-relay.ts](../playground/desktop-relay.ts)). The relay:

- forwards only the WebSocket handshake headers plus the provider's headers, and nothing else from the page
  (no cookies, no Origin);
- applies the playground's Host and Origin checks, and serves only while its run is active and still owns the sandbox;
- closes when the run ends;
- passes bytes through unchanged after the handshake, so the VNC password is still checked end to end.

The standalone `url` cannot be relayed (its assets would need the header too), so private desktops have no
"open in a new tab" link.

## Security notes

- The VNC password is a credential. On a public sandbox it is the only thing protecting the stream, and anyone
  holding it can control the desktop. Do not log or persist it. The playground keeps it in memory and strips
  `url`, `websocketUrl` and `password` from run exports.
- The password sits in `url`'s fragment, which browsers do not send to the server, rather than its query.
- The viewer's Control switch is a client-side preference, not an authorization boundary.

## Cost and limits

- E2B's `desktop` template runs with 8 vCPU and 8 GiB by default (observed with `Sandbox.getInfo`). For lower
  cost, build a custom template from it with fewer resources and pass its name as the image
  (`E2B_DESKTOP_TEMPLATE` in the playground).
- Sandbox lifetime is capped by plan (1 h continuous on Hobby, 24 h on Pro). The playground's Desktop test sets the
  TTL to the session length plus three minutes.

## Fixed along the way: background processes

The E2B SDK applies a command's `timeoutMs` (default 60 s) to background commands as well, so processes started
with `startBackground` were killed after a minute. `startBackground` now passes `timeoutMs: 0`. The live
conformance suite only waited 2.5 s, so it did not catch this. The playground's desktop demo did: its browser
vanished after a minute.

## Local verification

```sh
pnpm install
pnpm run playground   # http://127.0.0.1:4317/#tab=desktop
```

Verified on 2026-11-21 with `e2b` 2.64.0 and E2B's `desktop` template (noVNC 1.6.0-beta fork), through the
playground UI in a browser:

| Check | Result |
| --- | --- |
| Create + `desktop()` | Sandbox in ~0.7 s, desktop ready in ~3.8–5.1 s; repeat calls ~0.25 s, same password |
| Live stream | 1024×768 noVNC canvas changed between every sample while the remote clock ran |
| View-only | A click on the remote counter did not register |
| Control | Two clicks made the counter 2; typed text reached the remote input and was echoed |
| Background demo | The remote browser was still running after 80 s (it died at 60 s before the fix) |
| Manual reconnect | Back to Live in ~2.2 s, remote state kept |
| noVNC killed in the sandbox | Viewer reconnected by itself in ~3.4 s; `desktop()` restarted websockify, x11vnc kept running |
| Fullscreen | The whole screen fit; exit worked and the stream stayed live |
| Standalone viewer | `url` connected with the fragment password, showing the same shared session |
| Pause / resume | `desktop()` refused while paused; after resume the same stream answered again |
| Private traffic | Direct URL 403; the relay connected and streamed; foreign Origin, unknown token and ended runs refused |
| Credentials | Page events carried no traffic token; exports carried no URL or password |
| Cleanup | Stop destroyed the sandbox; no E2B sandboxes left |
| Conformance | `pnpm run test:e2b`: 10 passed, 1 skipped (`ssh`, not declared) |

These are functional checks of single sessions, not a latency benchmark. The Agent view uses the same viewer and
creates E2B sandboxes from the `desktop` template too. It was not run live here because no model key was set.

## Primary references

- [E2B Desktop template](https://docs.e2b.dev/template/examples/desktop) and the
  [Desktop SDK source](https://github.com/e2b-dev/E2B/tree/main/packages/desktop-js), whose stream startup this follows.
- [E2B restricting public access](https://docs.e2b.dev/network/restrict-public-access): private traffic and the token header.
- [E2B persistence](https://docs.e2b.dev/sandbox/persistence): what pause keeps and that clients must reconnect.
- [noVNC RFB API](https://github.com/novnc/noVNC/blob/master/docs/API.md): `credentials`, `viewOnly`, scaling.
