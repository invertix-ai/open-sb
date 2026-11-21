# Daytona desktop streaming

The Daytona provider exposes the existing `desktop` capability. The playground can render a real VNC stream,
with mouse and keyboard control, in Desktop, Live stream and Agent views.

## Provider contract

```ts
import { daytona } from "@invertix/open-sb/daytona";

const provider = daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  desktopExpiresInSeconds: 3600, // default; accepts 60–86400
});
const sandbox = await provider.create();
const access = await provider.desktop(sandbox.id);

if ("url" in access) {
  // Send only to a viewer authorized to access this sandbox:
  // access.url          — standalone noVNC viewer, HTTPS
  // access.websocketUrl — RFB stream, WSS, for an embedded noVNC client
  // access.expiresAt    — Date; obtain new access before it expires
}

// When the session is finished:
await provider.destroy(sandbox.id);
```

`DesktopConnection` extends the existing URL-only contract with optional `websocketUrl` and `expiresAt`.
Other providers can keep returning their existing viewer URLs or `{ provisioning: true }`.

Calling `desktop` starts the Computer Use stack (Xvfb, XFCE, x11vnc and noVNC), then signs access to port 6080.
It returns `/vnc.html` for a standalone viewer and `/websockify` for the native RFB client. The standalone viewer
autoconnects, scales to its container, retries disconnections and initially disables input.

The sandbox must be running. The call does not silently resume a stopped sandbox. After `resume`, call
`desktop` again to restart the desktop processes and obtain fresh access.

## Images and authentication

- Daytona's default Linux snapshot includes the desktop packages. Custom images must include them; see the
  [VNC package list](https://www.daytona.io/docs/en/vnc-access/).
- A standard preview URL needs a header token. A browser cannot attach that header to the viewer's assets and
  WebSocket, so this integration uses a **signed preview URL**. Its host carries a credential restricted to port
  6080. The API key and the sandbox-wide preview token are never sent to the browser.
- Signed access defaults to one hour and can be renewed without creating a new sandbox. The playground renews
  it before expiry, on explicit reconnect and after an unexpected disconnect (up to three retries).
- Treat both desktop URLs as credentials. Keep them out of logs, storage and public caches. The playground
  retains them in memory for live event replay and removes them from exported run JSON.
- The Control switch is a client-side input preference, not an authorization boundary. Someone authorized to
  receive desktop access can control that desktop. Apply your application's sandbox ownership checks before
  issuing either URL.

The local playground's reconnect endpoint checks the run, provider and tracked sandbox together. It refuses
requests for other runs' sandboxes and for cancelled/finished runs. Existing localhost Host and Origin checks
also apply. Stopping a session destroys its sandbox; a provider-side TTL bounds the lifetime after a server crash.

## Local verification

```sh
pnpm install
pnpm run playground
# Open http://127.0.0.1:4317/#tab=desktop
```

1. Add the Daytona key with the provider's setup panel, or set `DAYTONA_API_KEY` before starting the server.
2. Select Daytona, keep the live demo enabled, and start a desktop session.
3. Wait for **Live** and check that the remote clock changes. This is a streamed framebuffer, not a screenshot
   polling loop.
4. Click the remote counter while Control is off; it should not change. Enable Control, click again and type
   in the remote input. The counter and echoed text should update.
5. Reconnect. The existing remote page and its input should remain. Refresh the local page and replay the
   active run from History to check that the viewer reconnects to the same sandbox.
6. Enter fullscreen and check that the whole remote screen fits. Stop the session and verify that the sandbox
   disappears from Daytona.

Verified locally on 2026-11-21 with `@daytonaio/sdk` 0.232.0 and noVNC 1.7.0:

- A real sandbox produced an authenticated noVNC page (HTTP 200) and an RFB 003.008 WebSocket greeting.
- The embedded 1024×768 framebuffer changed between samples while the remote clock ran.
- View-only blocked the counter click; enabling control incremented it and delivered keyboard text.
- Manual reconnect issued fresh signed access and retained the remote browser state.
- A deliberately closed WebSocket recovered automatically to the same desktop.
- Fullscreen exit and Stop remained usable after remote input; mouse capture was released on exit and cleanup.
- Sandbox pause rejected desktop access while stopped; resume restored the viewer.
- The probe sandbox was destroyed and a follow-up provider lookup/list confirmed no live probe resources.
- Stopping both playground sessions left no active runs or live sandboxes in the local server, and no live
  Daytona sandboxes with their run labels.

These are functional checks of individual sessions, not a latency benchmark or an availability guarantee.
The complete Daytona conformance suite, including snapshots, is separate (`pnpm run test:daytona`).

## Primary references

- [Daytona VNC Access](https://www.daytona.io/docs/en/vnc-access/): image requirements, desktop lifecycle and resolution.
- [Daytona Computer Use](https://www.daytona.io/docs/en/computer-use/): desktop start/status, input and screenshots.
- [Daytona Preview](https://www.daytona.io/docs/en/preview/): signed URLs, expiry, private preview authentication and revocation.
- [Daytona TypeScript Sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/): `getSignedPreviewUrl`.
- [noVNC RFB API](https://github.com/novnc/noVNC/blob/master/docs/API.md): connection events, scaling and `viewOnly`.
