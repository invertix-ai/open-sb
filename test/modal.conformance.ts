// The conformance suite against real Modal sandboxes: MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... node --test
// test/modal.conformance.ts (creates and terminates sandboxes in the `open-sb` app, publishes one snapshot).
import { after } from "node:test";
import { ModalClient } from "modal";
import { conformance } from "../src/conformance.ts";
import { modal } from "../src/providers/modal.ts";

const tokenId = process.env.MODAL_TOKEN_ID, tokenSecret = process.env.MODAL_TOKEN_SECRET;
if (!tokenId || !tokenSecret) throw new Error("Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET to run the Modal conformance suite");
// The SDK keeps gRPC channels open; closing the client lets the test process exit.
const client = new ModalClient({ tokenId, tokenSecret });
after(() => client.close());
conformance(modal({ client }), { image: process.env.MODAL_IMAGE });
