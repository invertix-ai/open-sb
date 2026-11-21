// The conformance suite against real Vercel sandboxes (creates and deletes microVMs):
// VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... pnpm run test:vercel
// Without VERCEL_TOKEN the SDK falls back to VERCEL_OIDC_TOKEN (from `vercel env pull`).
import { conformance } from "../src/conformance.ts";
import { vercel } from "../src/providers/vercel.ts";

const token = process.env.VERCEL_TOKEN, teamId = process.env.VERCEL_TEAM_ID, projectId = process.env.VERCEL_PROJECT_ID;
if (token && !(teamId && projectId)) throw new Error("VERCEL_TOKEN needs VERCEL_TEAM_ID and VERCEL_PROJECT_ID");
if (!token && !process.env.VERCEL_OIDC_TOKEN) throw new Error("Set VERCEL_TOKEN (with team and project) or VERCEL_OIDC_TOKEN to run the Vercel conformance suite");
// The ports test listens on 8765, declared up front as Vercel expects.
conformance(vercel({ token, teamId, projectId, ports: [8765] }), { image: process.env.VERCEL_IMAGE, port: 8765 });
