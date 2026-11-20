# sandbox-kit

One TypeScript interface over sandbox and VM providers. Pick providers in a config file, declare the
capabilities your application needs, and sandbox-kit checks that every provider has them:

- **when you type-check**: a provider without a required capability is a type error;
- **at startup**: `assertCompatible(config)` checks the same thing for JavaScript and dynamically loaded providers;
- **in CI**: a shared conformance suite runs against real sandboxes, so a provider cannot claim a capability it does not have.

Providers are tried in the order you list them, so the second one is the fallback when the first is down.

## Example

```ts
// sandbox.config.ts
import { defineConfig } from "@invertix/sandbox-kit";
import { boat } from "@invertix/sandbox-kit/boat";
import { agent37 } from "@invertix/sandbox-kit/agent37";

export default defineConfig({
  requires: ["pause", "background", "persistentDisk"],
  providers: [
    boat({ apiKey: process.env.BOAT_API_KEY }),
    agent37({ apiKey: process.env.AGENT37_API_KEY! }),
  ],
});
```

```ts
import { assertCompatible, failover } from "@invertix/sandbox-kit";
import config from "./sandbox.config.ts";

assertCompatible(config);
const { provider, result: sandbox } = await failover(config, provider => provider.create({ labels: { agent: "a1" } }),
  { onFallback: ({ from, to }) => console.warn(`${from} is down, using ${to}`) });
await provider.exec(sandbox.id, "echo hello");
await provider.pause(sandbox.id); // typed: every provider in the config has `pause`
```

`npx sandbox-kit check` loads `sandbox.config.ts` and prints which provider has which capability.

## The interface

Every provider implements the core: `create`, `get`, `list` (by labels), `destroy`, `exec`, `readFile`, `writeFile`.

Optional capabilities:

| Capability | Methods | Meaning |
| --- | --- | --- |
| `pause` | `pause`, `resume` | Sleep and wake; the sandbox keeps its identity |
| `persistentDisk` | (none) | Files survive pause and resume (requires `pause`) |
| `snapshot` | `snapshot`, `listSnapshots`, `deleteSnapshot` | Save a sandbox as a named image; `create({ image: name })` starts from it |
| `ttl` | `setTtl` | The provider stops the sandbox on its own; `get()` reports `expiresAt` |
| `ports` | `portUrl` | HTTPS address of a port inside the sandbox |
| `ssh` | `ssh` | SSH endpoint with the host key, for a public key you supply |
| `desktop` | `desktop` | A viewer URL for a graphical desktop |
| `background` | `startBackground` | A process that keeps running after the call returns |

Errors are `SandboxError` with a `kind`: `unavailable` (an outage: fallback moves on), `not_found`, `rejected` or `timeout`.

## Providers

| Provider | Entry point | Capabilities | Conformance |
| --- | --- | --- | --- |
| Boat | `@invertix/sandbox-kit/boat` | all | needs a key with file, port, snapshot and delete permissions |
| Agent37 | `@invertix/sandbox-kit/agent37` | pause, persistentDisk, ports, background | passes |
| Docker | `@invertix/sandbox-kit/docker` | pause, persistentDisk, snapshot, background | passes (runs in CI) |

### Adding a provider

Write a function returning `defineProvider({ name, capabilities: [...] as const, ...methods })`; the type checker
requires the methods of every capability you list. Then add a test file:

```ts
import { conformance } from "@invertix/sandbox-kit/conformance";
conformance(myProvider({ apiKey: process.env.MY_KEY! }));
```

and run it with `node --test`. It creates real sandboxes and deletes them afterwards.

## Development

Node 22.18 or later (TypeScript runs directly). `pnpm install`, then `pnpm run check` (types), `pnpm test` (unit
tests) and `pnpm run test:docker` (conformance against local Docker). `pnpm run test:boat` and `pnpm run test:agent37`
need `BOAT_API_KEY` or `AGENT37_API_KEY` and create real VMs.
