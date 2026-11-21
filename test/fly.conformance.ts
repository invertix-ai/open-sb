// The conformance suite against real Fly Machines: FLY_API_TOKEN=... FLY_APP=... node --test test/fly.conformance.ts
// (creates and deletes machines in that app; FLY_REGION optionally pins a region).
import { conformance } from "../src/conformance.ts";
import { fly } from "../src/providers/fly.ts";

const apiToken = process.env.FLY_API_TOKEN;
const app = process.env.FLY_APP;
if (!apiToken || !app) throw new Error("Set FLY_API_TOKEN and FLY_APP to run the Fly conformance suite");
conformance(fly({ apiToken, app, region: process.env.FLY_REGION || undefined }));
