// Compatibility checks: type errors for missing capabilities (checked by `tsc`), the same checks at runtime,
// and fallback across providers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompatible, checkProvider, defineConfig, defineProvider, failover, IncompatibleProviderError, SandboxError, type Core } from "../src/index.ts";

const core: Core = {
  create: async () => ({ id: "s1", state: "running", labels: {} }),
  get: async () => null, list: async () => [], destroy: async () => {},
  exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  readFile: async () => new Uint8Array(), writeFile: async () => {},
};
const pausing = defineProvider({ ...core, name: "pausing", capabilities: ["pause", "persistentDisk"] as const,
  pause: async () => {}, resume: async () => {} });
const basic = defineProvider({ ...core, name: "basic", capabilities: [] as const });

test("the type checker rejects incompatible configs and providers", () => {
  defineConfig({ requires: ["pause"], providers: [pausing] });
  // @ts-expect-error basic lacks pause
  defineConfig({ requires: ["pause"], providers: [pausing, basic] });
  // @ts-expect-error declaring pause requires pause() and resume()
  defineProvider({ ...core, name: "liar", capabilities: ["pause"] as const });
});

test("assertCompatible reports missing and broken capabilities at runtime", () => {
  assert.doesNotThrow(() => assertCompatible({ requires: ["pause"], providers: [pausing] }));
  assert.throws(() => assertCompatible({ requires: ["pause"], providers: [pausing, basic] }),
    (error: unknown) => error instanceof IncompatibleProviderError && /basic: missing pause/.test(error.message));
  // A JavaScript provider can claim anything; runtime checks catch the missing methods and prerequisites.
  const liar = { ...core, name: "liar", capabilities: ["desktop", "persistentDisk"] } as never;
  assert.deepEqual(checkProvider(liar, []).broken, ["desktop: method desktop()", "persistentDisk: requires pause"]);
  assert.throws(() => assertCompatible({ requires: [], providers: [] }), /at least one provider/);
});

test("failover moves on only when a provider is down", async () => {
  const seen: string[] = [];
  const down = { ...basic, name: "down" }, up = { ...basic, name: "up" };
  const result = await failover({ providers: [down, up] }, async provider => {
    if (provider.name === "down") throw new SandboxError("unavailable", "down", { status: 503 });
    return provider.name;
  }, { onFallback: event => seen.push(`${event.from}->${event.to}`) });
  assert.equal(result.result, "up");
  assert.deepEqual(seen, ["down->up"]);
  // A refusal is not an outage: the next provider is not tried.
  await assert.rejects(failover({ providers: [down, up] }, async provider => {
    seen.push(provider.name);
    throw new SandboxError("rejected", provider.name, { status: 400 });
  }), (error: unknown) => error instanceof SandboxError && error.kind === "rejected");
  assert.deepEqual(seen.slice(1), ["down"]);
});
