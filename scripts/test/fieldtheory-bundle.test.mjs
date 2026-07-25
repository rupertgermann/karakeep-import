import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";

import {
  readBundleManifest,
  selectRuntimeTargets,
  verifyVendoredPackage,
} from "../lib/fieldtheory-bundle.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("the vendored package matches the accepted upstream source pin", async () => {
  const manifest = await readBundleManifest(repositoryRoot);

  assert.equal(manifest.fieldTheory.version, "1.3.22");
  assert.equal(
    manifest.fieldTheory.commit,
    "4b4a0f677e7077ac76848408b22091fc34330391",
  );
  assert.equal(
    manifest.fieldTheory.sourceSha256,
    "1ebb91f6f20bd23f6a18a6222d3a207f044ae8437be55fe86146732f0b4c2f87",
  );
  await assert.doesNotReject(verifyVendoredPackage(repositoryRoot, manifest));
});

test("local release preparation selects only the accepted runtime matrix", () => {
  assert.deepEqual(selectRuntimeTargets("darwin", "arm64"), [
    "darwin-arm64",
    "darwin-x64",
  ]);
  assert.deepEqual(selectRuntimeTargets("win32", "x64"), ["win-x64"]);
  assert.throws(
    () => selectRuntimeTargets("linux", "x64"),
    /Unsupported Field Theory runtime target/,
  );
});

test("fails closed when the vendored package checksum changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "karakeep-bundle-pin-"));
  await mkdir(path.join(root, "vendor"), { recursive: true });
  await writeFile(path.join(root, "vendor", "fieldtheory.tgz"), "changed");

  await assert.rejects(
    verifyVendoredPackage(root, {
      fieldTheory: {
        packageFile: "vendor/fieldtheory.tgz",
        packageSha256: "0".repeat(64),
      },
    }),
    /Vendored Field Theory package checksum mismatch/,
  );
});
