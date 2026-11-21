// The conformance suite against real Upstash boxes: UPSTASH_BOX_API_KEY=... node --test test/upstash.conformance.ts (creates and deletes boxes).
import { conformance } from "../src/conformance.ts";
import { upstash } from "../src/providers/upstash.ts";

const apiKey = process.env.UPSTASH_BOX_API_KEY;
if (!apiKey) throw new Error("Set UPSTASH_BOX_API_KEY to run the Upstash Box conformance suite");
// The `python` runtime has python3 for the ports test's `python3 -m http.server`.
conformance(upstash({ apiKey, runtime: "python" }));
