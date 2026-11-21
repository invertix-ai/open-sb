// The conformance suite against real Beam VMs: BEAM_TOKEN=... node --test test/beam.conformance.ts (creates and deletes VMs
// and a snapshot). BEAM_WORKSPACE_ID is optional (default: the token's current workspace).
import { conformance } from "../src/conformance.ts";
import { beam } from "../src/providers/beam.ts";

const token = process.env.BEAM_TOKEN;
if (!token) throw new Error("Set BEAM_TOKEN to run the Beam conformance suite");
conformance(beam({ token, workspaceId: process.env.BEAM_WORKSPACE_ID, cpu: 1, memory: "2Gi" }));
