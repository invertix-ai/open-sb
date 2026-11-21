// The conformance suite against real Freestyle VMs: FREESTYLE_API_KEY=... node --test test/freestyle.conformance.ts (creates and deletes VMs).
import { conformance } from "../src/conformance.ts";
import { freestyle } from "../src/providers/freestyle.ts";

const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Set FREESTYLE_API_KEY to run the Freestyle conformance suite");
conformance(freestyle({ apiKey, image: process.env.FREESTYLE_IMAGE }));
