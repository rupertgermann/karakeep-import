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

test("all extracted runtime executables have independent accepted pins", async () => {
  const manifest = await readBundleManifest(repositoryRoot);

  assert.equal(manifest.node.version, "26.13.1");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.node.artifacts).map(([target, artifact]) => [
        target,
        artifact.executableSha256,
      ]),
    ),
    {
      "darwin-arm64":
        "266dec4dce3a6cdcf5cdc38722a00cf5ae6a12cc51068d2a227655bbb75751ec",
      "win-x64":
        "f5109dc868ec38703ad8f305e0aceece717cb60d4889873f434017af4e96cccb",
    },
  );
});

test("Windows SQLite is pinned to the accepted official archive and executable", async () => {
  const manifest = await readBundleManifest(repositoryRoot);

  assert.deepEqual(manifest.sqlite, {
    version: "3.53.4",
    license: "Public-Domain",
    sourceUrl:
      "https://www.sqlite.org/2026/sqlite-tools-win-x64-3530400.zip",
    artifacts: {
      "win-x64": {
        file: "sqlite-tools-win-x64-3530400.zip",
        sha256:
          "f46ee2475de4cbe287e6e5f7d43c838796b14e7379cd216bdbb28d391429f9fc",
        sha3_256:
          "88b4659fe747896b853af10157316b4ade143553efb89c1c8ca7423a278dcc8b",
        executableSha256:
          "5da2398d4913b893bd1ea578d85403b3a83a06fabf9d2303ca9f63ef0849fc6f",
      },
    },
  });
});

test("local release preparation selects only the accepted runtime matrix", () => {
  assert.deepEqual(selectRuntimeTargets("darwin", "arm64"), ["darwin-arm64"]);
  assert.deepEqual(selectRuntimeTargets("win32", "x64"), ["win-x64"]);
  assert.throws(
    () => selectRuntimeTargets("darwin", "x64"),
    /Unsupported Field Theory runtime target: darwin-x64/,
  );
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
