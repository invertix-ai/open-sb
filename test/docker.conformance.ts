// The conformance suite against local Docker containers: `pnpm run test:docker`.
import { conformance } from "../src/conformance.ts";
import { docker } from "../src/providers/docker.ts";

conformance(docker(), { waitMs: 60_000 });
