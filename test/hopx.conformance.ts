// The conformance suite against real HOPX sandboxes: HOPX_API_KEY=... node --test test/hopx.conformance.ts (creates and deletes sandboxes).
import { conformance } from "../src/conformance.ts";
import { hopx } from "../src/providers/hopx.ts";

const apiKey = process.env.HOPX_API_KEY;
if (!apiKey) throw new Error("Set HOPX_API_KEY to run the HOPX conformance suite");
conformance(hopx({ apiKey, template: process.env.HOPX_TEMPLATE }));
