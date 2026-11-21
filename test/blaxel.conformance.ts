// The conformance suite against real Blaxel sandboxes: BL_API_KEY=... BL_WORKSPACE=... node --test test/blaxel.conformance.ts (creates and deletes sandboxes).
import { conformance } from "../src/conformance.ts";
import { blaxel } from "../src/providers/blaxel.ts";

const apiKey = process.env.BL_API_KEY;
const workspace = process.env.BL_WORKSPACE;
if (!apiKey || !workspace) throw new Error("Set BL_API_KEY and BL_WORKSPACE to run the Blaxel conformance suite");
conformance(blaxel({ apiKey, workspace, region: process.env.BL_REGION, image: process.env.BLAXEL_IMAGE }));
