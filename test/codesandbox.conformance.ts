// The conformance suite against real CodeSandbox sandboxes: CSB_API_KEY=... node --test test/codesandbox.conformance.ts
// (creates and deletes sandboxes and a snapshot fork). CSB_TEMPLATE picks the template to fork.
import { conformance } from "../src/conformance.ts";
import { codesandbox } from "../src/providers/codesandbox.ts";

const apiKey = process.env.CSB_API_KEY;
if (!apiKey) throw new Error("Set CSB_API_KEY to run the CodeSandbox conformance suite");
conformance(codesandbox({ apiKey, template: process.env.CSB_TEMPLATE }));
