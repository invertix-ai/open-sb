// The conformance suite against real Runloop devboxes: RUNLOOP_API_KEY=... node --test test/runloop.conformance.ts
// (creates and shuts down devboxes and a disk snapshot). RUNLOOP_BLUEPRINT picks the image by blueprint name.
import { conformance } from "../src/conformance.ts";
import { runloop } from "../src/providers/runloop.ts";

const apiKey = process.env.RUNLOOP_API_KEY;
if (!apiKey) throw new Error("Set RUNLOOP_API_KEY to run the Runloop conformance suite");
conformance(runloop({ apiKey, baseUrl: process.env.RUNLOOP_BASE_URL, blueprint: process.env.RUNLOOP_BLUEPRINT }));
