// Boat provider details that the live conformance suite cannot pin down; a fake SDK client, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ResponseError, type BoatApi } from "@boatdev/sdk";
import { boat } from "../src/providers/boat.ts";

test("portUrl falls back from the localhost relay and swaps the URL token for its cookie", async () => {
  const asked: boolean[] = [];
  const client = {
    async hostPort({ hostPortRequest }: { hostPortRequest: { localhost: boolean } }) {
      asked.push(hostPortRequest.localhost);
      if (hostPortRequest.localhost)
        throw new ResponseError(Response.json({ code: "localhost_relay_failed" }, { status: 500 }));
      return { url: "https://box-9333.on.boat.dev/?_token=tok", isProtected: true, access: "private" };
    },
  } as unknown as BoatApi;
  const seen: string[] = [];
  const fetch = (async (url: URL | string) => {
    seen.push(String(url));
    return new Response(null, { status: 302, headers: [["location", "/"], ["set-cookie", "_port_auth=c1; Path=/; HttpOnly; Secure"]] });
  }) as typeof globalThis.fetch;
  const provider = boat({ client, fetch });
  assert.deepEqual(await provider.portUrl("bx_1", 9333), { url: "https://box-9333.on.boat.dev/", headers: { cookie: "_port_auth=c1" } });
  assert.deepEqual(asked, [true, false]);
  assert.deepEqual(seen, ["https://box-9333.on.boat.dev/?_token=tok"]);
});
