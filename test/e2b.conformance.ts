// The conformance suite against real E2B sandboxes: E2B_API_KEY=... node --test test/e2b.conformance.ts (creates and deletes sandboxes).
// E2B declares `desktop`, which needs a template with the desktop stack, so the suite defaults to E2B's `desktop` template.
import { conformance } from "../src/conformance.ts";
import { e2b } from "../src/providers/e2b.ts";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("Set E2B_API_KEY to run the E2B conformance suite");
conformance(e2b({ apiKey, template: process.env.E2B_TEMPLATE ?? "desktop" }));
