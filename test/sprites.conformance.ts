// The conformance suite against real Fly.io Sprites: SPRITES_TOKEN=... node --test test/sprites.conformance.ts
// (creates and deletes sprites; Node 24 or later). SPRITES_API_URL overrides the API address.
import { conformance } from "../src/conformance.ts";
import { sprites } from "../src/providers/sprites.ts";

const token = process.env.SPRITES_TOKEN;
if (!token) throw new Error("Set SPRITES_TOKEN to run the Sprites conformance suite");
conformance(sprites({ token, baseURL: process.env.SPRITES_API_URL }));
