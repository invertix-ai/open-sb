<p align="center">
  <img src="assets/providers.svg" alt="open-sb: one interface over E2B, Daytona, Vercel Sandbox, Modal, Boat, Agent37, Docker and your own provider" width="100%">
</p>

<h1 align="center">open-sb</h1>

<p align="center">
  <b>One TypeScript interface for agent sandboxes.</b><br>
  Pick your providers in a config file, say which features you need, and know before production whether they all have them.
</p>

<p align="center">
  <a href="https://github.com/invertix-ai/open-sb/actions/workflows/ci.yml"><img src="https://github.com/invertix-ai/open-sb/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-339933.svg" alt="Node 22.18 or later">
</p>

---

AI agents need somewhere to run code: a VM or container they can start, run commands in, pause, and come back to.
Every provider has its own API, its own words for the same things, and its own gaps. Switching providers, or
keeping a second one ready for when the first is down, means rewriting the glue each time.

open-sb is that glue, written once. Think of it as OpenTofu for agent sandboxes: a config file lists the
providers, and every provider speaks the same interface. It ships with **E2B, Daytona, Vercel Sandbox, Modal,
Boat, Agent37 and Docker**, and every integration makes the next switch cheaper.

- **One interface.** `create`, `exec`, `readFile`, `writeFile` and friends work the same on every provider.
- **Capabilities you can check.** Pause, snapshots, SSH, port URLs and more are declared per provider, and a
  missing one is caught at three points: when you type-check, when your app starts, and in CI.
- **Failover built in.** List providers in order. When the first has an outage, work moves to the next.
- **Honest providers.** A shared conformance suite runs against real sandboxes, so a provider cannot claim a
  capability it does not have.

## Quick start

```ts
// sandbox.config.ts
import { defineConfig } from "@invertix/open-sb";
import { e2b } from "@invertix/open-sb/e2b";
import { daytona } from "@invertix/open-sb/daytona";

export default defineConfig({
  // What your application needs from every provider.
  requires: ["pause", "persistentDisk", "background"],
  // Tried in order: Daytona takes over when E2B is down.
  providers: [
    e2b({ apiKey: process.env.E2B_API_KEY }),
    daytona({ apiKey: process.env.DAYTONA_API_KEY }),
  ],
});
```

```ts
import { assertCompatible, failover } from "@invertix/open-sb";
import config from "./sandbox.config.ts";

assertCompatible(config); // throws at startup if a provider lacks a required capability

const { provider, result: sandbox } = await failover(
  config,
  provider => provider.create({ labels: { agent: "a1" } }),
  { onFallback: ({ from, to }) => console.warn(`${from} is down, using ${to}`) },
);

const { stdout } = await provider.exec(sandbox.id, "echo hello");
await provider.writeFile(sandbox.id, "/home/user/notes.txt", "remember this");
await provider.pause(sandbox.id); // typed: every provider in this config has `pause`
```

Add Modal (no `pause`) to that config and `tsc` fails before anything runs.

## Three checks, one source of truth

| When | How | Catches |
| --- | --- | --- |
| Type-check | `defineConfig` and `defineProvider` | A provider missing a required capability, or declaring one without its methods |
| Startup | `assertCompatible(config)` | The same, for JavaScript and providers loaded at runtime |
| CI | `conformance(provider)` | A provider whose capability does not actually work against the real service |

From the command line:

```sh
pnpm exec open-sb check
```

```
capability       e2b  daytona
pause*           yes  yes
snapshot         yes  yes
ttl              yes  -
ports            yes  yes
ssh              -    -
desktop          -    -
background*      yes  yes
persistentDisk*  yes  yes
(* required)
```

It exits with code 1 and names the gap when a provider is missing a required capability, so it can gate CI.

## The interface

Every provider implements the core:

| Method | Does |
| --- | --- |
| `create({ image?, labels?, idempotencyKey? })` | Starts a sandbox |
| `get(id)` / `list({ labels })` | Finds sandboxes, by ID or by labels |
| `destroy(id)` | Deletes it; deleting twice is fine |
| `exec(id, command, { cwd?, env?, timeoutMs? })` | Runs a shell command, returns exit code, stdout and stderr |
| `readFile(id, path)` / `writeFile(id, path, data)` | Moves text or binary files in and out |

Optional capabilities:

| Capability | Methods | Meaning |
| --- | --- | --- |
| `pause` | `pause`, `resume` | Sleep and wake; the sandbox keeps its identity |
| `persistentDisk` | | Files survive pause and resume (requires `pause`) |
| `snapshot` | `snapshot`, `listSnapshots`, `deleteSnapshot` | Save a sandbox as a named image; `create({ image })` starts from it |
| `ttl` | `setTtl` | The provider stops the sandbox on its own; `get()` reports `expiresAt` |
| `ports` | `portUrl` | A private HTTPS address for a port inside the sandbox |
| `ssh` | `ssh` | An SSH endpoint and host key for a public key you supply |
| `desktop` | `desktop` | A viewer URL for a graphical desktop |
| `background` | `startBackground` | A process that keeps running after the call returns |

Every failure is a `SandboxError` with a `kind`: `unavailable` (an outage, so failover moves on), `not_found`,
`rejected` or `timeout`. Provider error bodies never leak into messages.

## Providers

| Provider | Import | Install | Capabilities | Conformance |
| --- | --- | --- | --- | --- |
| [E2B](https://e2b.dev) | `@invertix/open-sb/e2b` | `e2b` | pause, persistentDisk, snapshot, ttl, ports, background | needs a run with a key |
| [Daytona](https://daytona.io) | `@invertix/open-sb/daytona` | `@daytonaio/sdk` | pause, persistentDisk, snapshot, ports, background | needs a run with a key |
| [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) | `@invertix/open-sb/vercel` | `@vercel/sandbox` | pause, persistentDisk, ttl, ports, background | needs a run with a key |
| [Modal](https://modal.com) | `@invertix/open-sb/modal` | `modal` | snapshot, ports, background | needs a run with a key |
| [Boat](https://boat.dev) | `@invertix/open-sb/boat` | `@boatdev/sdk` | all eight | 7 of 11 pass; files, ports, snapshot and delete need a key with more permissions |
| [Agent37](https://agent37.com) | `@invertix/open-sb/agent37` | nothing | pause, persistentDisk, ports, background | passes |
| [Docker](https://www.docker.com) | `@invertix/open-sb/docker` | nothing; needs Docker running | pause, persistentDisk, snapshot, background | passes, in every CI run |

Each provider's SDK is an optional peer dependency: install only the ones you use. Docker is handy for local
development and tests: no account, no cost, same interface.

Why a capability is missing is written at the top of each provider file. Two examples: Daytona's TTL deletes the
sandbox and its disk rather than stopping it, so open-sb does not call it `ttl`; Modal tunnels and Vercel
ports must be declared when the sandbox is created, so both take a `ports` option.

### Add your own

A provider is a function that returns `defineProvider(...)`. List the capabilities it has, and the type checker
insists on their methods:

```ts
import { defineProvider } from "@invertix/open-sb";

export function myCloud(options: { apiKey: string }) {
  return defineProvider({
    name: "my-cloud",
    capabilities: ["pause"] as const,
    async create(opts) { /* ... */ },
    async get(id) { /* ... */ },
    async list(filter) { /* ... */ },
    async destroy(id) { /* ... */ },
    async exec(id, command, opts) { /* ... */ },
    async readFile(id, path) { /* ... */ },
    async writeFile(id, path, data) { /* ... */ },
    async pause(id) { /* ... */ },   // required because of "pause"
    async resume(id) { /* ... */ },
  });
}
```

Then prove it works against the real service:

```ts
// my-cloud.conformance.ts, run with `node --test`
import { conformance } from "@invertix/open-sb/conformance";
import { myCloud } from "./my-cloud.ts";

conformance(myCloud({ apiKey: process.env.MY_CLOUD_KEY! }));
```

The suite creates real sandboxes, tests the core and every capability you declared, and deletes what it made.
Pull requests for new providers are welcome; include a passing conformance run.

## How it compares

Other projects wrap many sandbox providers too, notably [Sandbox SDK](https://github.com/opencoredev/sandbox-sdk)
and [ComputeSDK](https://github.com/computesdk/computesdk). They focus on a rich API for one sandbox at a
time. open-sb focuses on running a fleet across providers:

- **A config with requirements.** Your app states which capabilities it needs, and open-sb proves every
  listed provider has them, at type-check, at startup and with `open-sb check` in CI.
- **Failover.** Providers are tried in order and only outages move on, so a second provider is a real backup.
- **One bar for every provider.** The same conformance suite runs against each real service, so claims are tested, not trusted.

## Status

Early. The interface may still change before 1.0. Docker and Agent37 pass the conformance suite against the
real services, and Boat passes 7 of 11 tests (the rest need a key with more permissions). E2B, Daytona, Vercel Sandbox and Modal are built against their official SDKs and
unit-tested, and their first live conformance runs are next.
The package is not on npm yet: it ships TypeScript sources, and a JavaScript build comes with the first release.

## Development

Node 22.18 or later runs the TypeScript directly.

```sh
pnpm install
pnpm run check         # types
pnpm test              # unit tests, no services needed
pnpm run test:docker   # conformance against local Docker
pnpm run test:boat     # needs BOAT_API_KEY, creates real VMs
pnpm run test:agent37  # needs AGENT37_API_KEY, creates real VMs
pnpm run test:e2b      # needs E2B_API_KEY
pnpm run test:daytona  # needs DAYTONA_API_KEY
pnpm run test:vercel   # needs VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID
pnpm run test:modal    # needs MODAL_TOKEN_ID and MODAL_TOKEN_SECRET
node scripts/graphic.ts  # redraws assets/providers.svg from the providers' capabilities
```

## License

[MIT](LICENSE), by [Invertix](https://invertix.ai).
