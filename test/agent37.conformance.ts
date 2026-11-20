// The conformance suite against real Agent37 instances: AGENT37_API_KEY=... pnpm run test:agent37 (creates and deletes VMs).
import { conformance } from "../src/conformance.ts";
import { agent37 } from "../src/providers/agent37.ts";

const apiKey = process.env.AGENT37_API_KEY;
if (!apiKey) throw new Error("Set AGENT37_API_KEY to run the Agent37 conformance suite");
conformance(agent37({ apiKey }));
