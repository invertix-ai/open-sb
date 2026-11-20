// The conformance suite against real Boat sandboxes: BOAT_API_KEY=... pnpm run test:boat (creates and deletes VMs).
import { conformance } from "../src/conformance.ts";
import { boat } from "../src/providers/boat.ts";

const apiKey = process.env.BOAT_API_KEY;
if (!apiKey) throw new Error("Set BOAT_API_KEY to run the Boat conformance suite");
conformance(boat({ apiKey }), { image: process.env.BOAT_IMAGE });
