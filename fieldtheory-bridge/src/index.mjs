import { createInterface } from "node:readline";

import { handleLine } from "./protocol.mjs";

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of input) {
  process.stdout.write(`${await handleLine(line)}\n`);
}
