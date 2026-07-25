import { createInterface } from "node:readline";

import { createBridgeSession } from "./protocol.mjs";

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const session = createBridgeSession();

for await (const line of input) {
  session.handleLine(line);
}
