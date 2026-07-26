import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

async function writeChecksums(input) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(file);
    }
  }
  await visit(input);
  const entries = await Promise.all(
    files.sort().map(async (file) =>
      `${await sha256(file)}  ${path.relative(input, file).split(path.sep).join("/")}`,
    ),
  );
  await writeFile(path.join(input, "SHA256SUMS"), `${entries.join("\n")}\n`);
}

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
  await writeFile(path.join(input, "RELEASE-NOTES.md"), "staged notes\n");
  await writeFile(path.join(input, "DEPENDENCY-INVENTORY.json"), "{}\n");
  await writeFile(path.join(input, "THIRD-PARTY-NOTICES.md"), "staged notices\n");
  await writeFile(path.join(input, "NATIVE-BUILD-COMMAND.txt"), "tracked wrapper\n");
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
  await writeChecksums(input);
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
  await writeChecksums(input);

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

test("verified plan rejects an unlisted staged file", async () => {
  const { root, input } = await fixture();
  await writeFile(path.join(input, "frontend", "unlisted.js"), "unlisted\n");

  const result = run(root, input);
  assert.match(result.stderr, /Staged file is missing from SHA256SUMS: frontend\/unlisted\.js/);
});

test("verified plan requires every release-control file", async () => {
  const { root, input } = await fixture();
  await rm(path.join(input, "NATIVE-BUILD-COMMAND.txt"));
  await writeChecksums(input);

  const result = run(root, input);
  assert.match(result.stderr, /Required staged file is missing: NATIVE-BUILD-COMMAND\.txt/);
});

test("verified plan rejects a symlinked staged directory", async () => {
  const { root, input } = await fixture();
  await symlink("resources", path.join(input, "frontend", "linked-resources"));

  const result = run(root, input);
  assert.match(result.stderr, /Staged inputs must not contain symlinks/);
});

test("verified plan rejects a symlinked staged input root", async () => {
  const { root, input } = await fixture();
  const alias = path.join(root, "release-inputs", "alias");
  await symlink(input, alias);

  const result = run(root, alias);
  assert.match(result.stderr, /Staged inputs must not contain symlinks/);
});

test("verified plan rejects a target with a mismatched Tauri target", async () => {
  const { root, input } = await fixture();
  const metadataFile = path.join(input, "RELEASE-METADATA.json");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  metadata.rustTarget = "aarch64-apple-darwin";
  await writeFile(metadataFile, `${JSON.stringify(metadata)}\n`);
  await writeChecksums(input);

  const result = run(root, input);
  assert.match(result.stderr, /does not match staged target macos-universal/);
});
