import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "build-release-candidate.mjs",
);

const sha256 = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

async function fixture(target = "macos-universal") {
  const root = await (await import("node:fs/promises")).mkdtemp(
    path.join(os.tmpdir(), "release-candidate-test-"),
  );
  await writeFile(path.join(root, ".gitignore"), "release-inputs/\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "release-test@example.invalid"],
    ["config", "user.name", "Release Test"],
    ["add", ".gitignore"],
    ["commit", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  const input = path.join(root, "release-inputs", target);
  await mkdir(path.join(input, "frontend"), { recursive: true });
  await mkdir(path.join(input, "resources"), { recursive: true });
  await writeFile(path.join(input, "frontend", "index.html"), "staged frontend\n");
  await writeFile(path.join(input, "resources", "runtime.txt"), "staged resource\n");
  await writeFile(
    path.join(input, "RELEASE-METADATA.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      commit,
      target,
      rustTarget:
        target === "windows-x64" ? "x86_64-pc-windows-msvc" : "universal-apple-darwin",
      bundleFormat: target === "windows-x64" ? "nsis" : "dmg",
    }, null, 2)}\n`,
  );
  const entries = await Promise.all(
    ["frontend/index.html", "resources/runtime.txt", "RELEASE-METADATA.json"].map(
      async (relative) => `${await sha256(path.join(input, relative))}  ${relative}`,
    ),
  );
  await writeFile(path.join(input, "SHA256SUMS"), `${entries.join("\n")}\n`);
  return { root, input, commit };
}

function run(root, input) {
  return spawnSync(process.execPath, [script, "--input", input, "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("verified plan binds Tauri to staged frontend and resources", async () => {
  const { root, input } = await fixture();
  const result = run(root, input);

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.tauri.args.slice(0, 8), [
    "run", "tauri", "--", "build", "--target", "universal-apple-darwin", "--bundles", "dmg",
  ]);
  assert.deepEqual(plan.config.build, {
    beforeBuildCommand: "",
    frontendDist: path.join(input, "frontend"),
  });
  assert.deepEqual(plan.config.bundle.resources, {
    resources: null,
    [path.join(input, "resources")]: "",
  });
});

test("verified plan rejects staged inputs from another checkout commit", async () => {
  const { root, input } = await fixture();
  const metadata = JSON.parse(await readFile(path.join(input, "RELEASE-METADATA.json")));
  metadata.commit = "0".repeat(40);
  await writeFile(path.join(input, "RELEASE-METADATA.json"), `${JSON.stringify(metadata)}\n`);

  const result = run(root, input);
  assert.match(result.stderr, /Staged release commit does not match checkout HEAD/);
});

test("verified plan rejects tampered staged files", async () => {
  const { root, input } = await fixture();
  await writeFile(path.join(input, "resources", "runtime.txt"), "tampered\n");

  const result = run(root, input);
  assert.match(result.stderr, /Staged checksum mismatch: resources\/runtime.txt/);
});

test("verified plan rejects a release target on the wrong native host", async () => {
  const { root, input } = await fixture("windows-x64");
  const result = run(root, input);

  assert.match(result.stderr, /must run on win32/);
});
