// The conformance suite against real Daytona sandboxes: DAYTONA_API_KEY=... node --test test/daytona.conformance.ts
// (creates and deletes sandboxes and a snapshot). DAYTONA_TARGET picks the region, DAYTONA_SNAPSHOT the image.
import { conformance } from "../src/conformance.ts";
import { daytona } from "../src/providers/daytona.ts";

const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) throw new Error("Set DAYTONA_API_KEY to run the Daytona conformance suite");
conformance(daytona({ apiKey, apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET }), { image: process.env.DAYTONA_SNAPSHOT });
