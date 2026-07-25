import { createInterface } from "node:readline";

import { runtimeEnvironment } from "./runtime-environment.mjs";

Object.assign(process.env, runtimeEnvironment());

const { createBridgeSession } = await import("./protocol.mjs");

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const session = createBridgeSession();

for await (const line of input) {
  session.handleLine(line);
}
