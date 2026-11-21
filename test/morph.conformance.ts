// The conformance suite against real Morph Cloud instances: MORPH_API_KEY=... node --test test/morph.conformance.ts (creates and deletes instances and snapshots).
import { conformance } from "../src/conformance.ts";
import { morph } from "../src/providers/morph.ts";

const apiKey = process.env.MORPH_API_KEY;
if (!apiKey) throw new Error("Set MORPH_API_KEY to run the Morph conformance suite");
conformance(morph({ apiKey, snapshot: process.env.MORPH_SNAPSHOT }));
