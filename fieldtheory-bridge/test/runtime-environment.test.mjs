import assert from "node:assert/strict";
import test from "node:test";

import { runtimeEnvironment } from "../src/runtime-environment.mjs";

const modulePath =
  String.raw`C:\Program Files\Karakeep Transfer\resources\fieldtheory\bridge\src\runtime-environment.mjs`;
const sqliteDirectory =
  String.raw`C:\Program Files\Karakeep Transfer\resources\sqlite\win-x64`;

test("Windows bridge PATH prefers bundled SQLite and preserves inherited PATH", () => {
  const inherited = String.raw`C:\Windows\System32;C:\Tools`;

  const environment = runtimeEnvironment(
    { PATH: inherited, HOME: String.raw`C:\Users\example` },
    { platform: "win32", modulePath },
  );

  assert.equal(environment.PATH, `${sqliteDirectory};${inherited}`);
  assert.equal(environment.HOME, String.raw`C:\Users\example`);
});

test("Windows bridge PATH contains bundled SQLite without an inherited PATH", () => {
  const environment = runtimeEnvironment(
    {},
    { platform: "win32", modulePath },
  );

  assert.equal(environment.PATH, sqliteDirectory);
});

test("non-Windows bridge environment remains unchanged", () => {
  const original = { PATH: "/usr/local/bin:/usr/bin", HOME: "/Users/example" };

  const environment = runtimeEnvironment(original, {
    platform: "darwin",
    modulePath: "/Applications/Karakeep Transfer.app/resources/fieldtheory/bridge/src/runtime-environment.mjs",
  });

  assert.deepEqual(environment, original);
  assert.notEqual(environment, original);
});
