import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "build-release-candidate.mjs",
);
const nativeTarget = process.platform === "win32" ? "windows-x64" : "macos-arm64";
const nativeRustTarget = nativeTarget === "windows-x64"
  ? "x86_64-pc-windows-msvc"
  : "aarch64-apple-darwin";
const nativeBundle = nativeTarget === "windows-x64" ? "nsis" : "dmg";

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

async function fixture(target = nativeTarget) {
  const root = await (await import("node:fs/promises")).mkdtemp(
    path.join(os.tmpdir(), "release-candidate-test-"),
  );
  await writeFile(path.join(root, ".gitignore"), "release-inputs/\ncanonical/\ndist/\npackage-result.json\ntauri-fail\n");
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ type: "module", scripts: { build: "node build.mjs", tauri: "node tauri.mjs" } })}\n`,
  );
  await writeFile(
    path.join(root, "build.mjs"),
    'import { mkdir, writeFile } from "node:fs/promises";\nawait mkdir("dist", { recursive: true });\nawait writeFile("dist/index.html", "built\\n");\n',
  );
  await writeFile(
    path.join(root, "tauri.mjs"),
    `import { readFile, writeFile } from "node:fs/promises";\nimport path from "node:path";\nconst config = process.argv[process.argv.indexOf("--config") + 1];\nawait writeFile(path.join("release-inputs", ${JSON.stringify(target)}, "frontend", "index.html"), "attacker replacement\\n");\nif (await readFile("tauri-fail", "utf8").catch(() => null)) process.exit(7);\nconst value = JSON.parse(await readFile(config, "utf8"));\nconst resources = Object.keys(value.bundle.resources).find((key) => key !== "resources");\nawait writeFile("package-result.json", JSON.stringify({ frontend: await readFile(path.join(value.build.frontendDist, "index.html"), "utf8"), resource: await readFile(path.join(resources, "runtime.txt"), "utf8"), frontendDist: value.build.frontendDist, resources, windows: value.bundle.windows, noSign: process.argv.includes("--no-sign") }));\n`,
  );
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "scripts", "prepare-release-inputs.mjs"),
    'import { cp, mkdir } from "node:fs/promises";\nimport path from "node:path";\nconst args = new Map(process.argv.slice(2).reduce((pairs, value, index, values) => index % 2 ? pairs : [...pairs, [value, values[index + 1]]], []));\nconst target = args.get("--target");\nconst output = args.get("--output");\nawait mkdir(path.dirname(output), { recursive: true });\nawait cp(path.join(process.cwd(), "canonical", target), output, { recursive: true });\n',
  );
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "release-test@example.invalid"],
    ["config", "user.name", "Release Test"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  const canonical = path.join(root, "canonical", target);
  const input = path.join(root, "release-inputs", target);
  await mkdir(path.join(canonical, "frontend"), { recursive: true });
  await mkdir(path.join(canonical, "resources"), { recursive: true });
  await writeFile(path.join(canonical, "frontend", "index.html"), "staged frontend\n");
  await writeFile(path.join(canonical, "resources", "runtime.txt"), "staged resource\n");
  await writeFile(path.join(canonical, "RELEASE-NOTES.md"), "staged notes\n");
  await writeFile(path.join(canonical, "DEPENDENCY-INVENTORY.json"), "{}\n");
  await writeFile(path.join(canonical, "THIRD-PARTY-NOTICES.md"), "staged notices\n");
  await writeFile(path.join(canonical, "NATIVE-BUILD-COMMAND.txt"), "tracked wrapper\n");
  await writeFile(
    path.join(canonical, "RELEASE-METADATA.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      commit,
      target,
      rustTarget:
        target === "windows-x64" ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin",
      bundleFormat: target === "windows-x64" ? "nsis" : "dmg",
    }, null, 2)}\n`,
  );
  await writeChecksums(canonical);
  await cp(canonical, input, { recursive: true });
  return { root, input, commit };
}

function run(root, input, {
  dryRun = true,
  noSign = false,
  env = process.env,
  windowsHost = false,
} = {}) {
  const args = [];
  if (windowsHost && process.platform !== "win32") {
    const override = 'import "node:path"; Object.defineProperty(process, "platform", { value: "win32" });';
    args.push("--import", "data:text/javascript," + encodeURIComponent(override));
    env = { ...env, TEMP: os.tmpdir() };
    // A simulated Windows process needs the real npm CLI path for npmInvocation.
    if (!env.npm_execpath) {
      const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
      assert.equal(npmRoot.status, 0, npmRoot.stderr);
      env = { ...env, npm_execpath: path.join(npmRoot.stdout.trim(), "npm", "bin", "npm-cli.js") };
    }
  }
  args.push(script, "--input", input);
  if (dryRun) args.push("--dry-run");
  if (noSign) args.push("--no-sign");
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

test("Windows packaging requires signing settings unless explicitly unsigned", async () => {
  const { root, input } = await fixture("windows-x64");
  const options = {
    windowsHost: true,
    env: { ...process.env, KARAKEEP_WINDOWS_SIGNING_THUMBPRINT: "", KARAKEEP_WINDOWS_TIMESTAMP_URL: "" },
  };
  const result = run(root, input, { ...options, dryRun: false });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /KARAKEEP_WINDOWS_SIGNING_THUMBPRINT/);

  const dryRun = run(root, input, options);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).config.bundle.windows, undefined);

  const unsigned = run(root, input, { ...options, dryRun: false, noSign: true });
  assert.equal(unsigned.status, 0, unsigned.stderr);
  const packaged = JSON.parse(await readFile(path.join(root, "package-result.json"), "utf8"));
  assert.equal(packaged.noSign, true);
  assert.equal(packaged.windows, undefined);
});

test("Windows packaging selects the certificate and applies an RFC 3161 SHA-256 timestamp", async () => {
  const { root, input } = await fixture("windows-x64");
  const thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  const timestampUrl = "https://timestamp.example.invalid/rfc3161";
  const result = run(root, input, {
    dryRun: false,
    windowsHost: true,
    env: {
      ...process.env,
      KARAKEEP_WINDOWS_SIGNING_THUMBPRINT: thumbprint,
      KARAKEEP_WINDOWS_TIMESTAMP_URL: timestampUrl,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const packaged = JSON.parse(await readFile(path.join(root, "package-result.json"), "utf8"));
  assert.equal(packaged.noSign, false);
  assert.deepEqual(packaged.windows, {
    certificateThumbprint: thumbprint,
    digestAlgorithm: "sha256",
    timestampUrl,
    tsp: true,
  });
});

test("Windows packaging rejects invalid signing settings without echoing their values", async () => {
  const { root, input } = await fixture("windows-x64");
  const thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  const timestampUrl = "https://timestamp.example.invalid/rfc3161";
  for (const [name, value] of [
    ["KARAKEEP_WINDOWS_SIGNING_THUMBPRINT", "invalid-thumbprint"],
    ["KARAKEEP_WINDOWS_TIMESTAMP_URL", ""],
    ["KARAKEEP_WINDOWS_TIMESTAMP_URL", "file:///timestamp"],
    ["KARAKEEP_WINDOWS_TIMESTAMP_URL", "https://account:test-value@timestamp.example.invalid/rfc3161"],
    ["KARAKEEP_WINDOWS_TIMESTAMP_URL", "https://timestamp.example.invalid/rfc3161?key=test-value"],
  ]) {
    const result = run(root, input, {
      dryRun: false,
      windowsHost: true,
      env: {
        ...process.env,
        KARAKEEP_WINDOWS_SIGNING_THUMBPRINT: thumbprint,
        KARAKEEP_WINDOWS_TIMESTAMP_URL: timestampUrl,
        [name]: value,
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(name));
    if (value) assert.ok(!result.stderr.includes(value), result.stderr);
  }
});

test("verified plan binds Tauri to a canonical frontend and resources snapshot", async () => {
  const { root, input } = await fixture();
  const result = run(root, input);

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.tauri.args.slice(-8), [
    "run", "tauri", "--", "build", "--target", nativeRustTarget, "--bundles", nativeBundle,
  ]);
  assert.equal(plan.config.build.beforeBuildCommand, "");
  assert.match(
    plan.config.build.frontendDist.replaceAll(path.sep, "/"),
    /release-inputs\/\.verify-[0-9a-f-]{36}\/frontend$/,
  );
  assert.deepEqual(plan.config.bundle.resources.resources, null);
  const resources = Object.keys(plan.config.bundle.resources).find(
    (key) => key !== "resources",
  );
  assert.match(resources.replaceAll(path.sep, "/"), /release-inputs\/\.verify-[0-9a-f-]{36}\/resources$/);
  assert.equal(plan.config.bundle.resources[resources], "");
  assert.notEqual(plan.config.build.frontendDist, path.join(input, "frontend"));
  assert.deepEqual(
    (await readdir(path.join(root, "release-inputs"))).filter((name) => name.startsWith(".verify-")),
    [],
  );
});

test("frontend rebuild uses the invoking npm CLI even when its path has spaces", async () => {
  const { root, input } = await fixture();
  const npmCli = path.join(root, "canonical", "npm entry.mjs");
  await writeFile(npmCli, 'console.error("fixture npm reached"); process.exit(9);\n');

  const result = run(root, input, { env: { ...process.env, npm_execpath: npmCli } });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Could not rebuild frontend for canonical staging: fixture npm reached/);
});

test("package consumes the canonical snapshot after supplied staging is mutated", async () => {
  const { root, input } = await fixture();
  const result = run(root, input, { dryRun: false, noSign: nativeTarget === "windows-x64" });

  assert.equal(result.status, 0, result.stderr);
  const packaged = JSON.parse(await readFile(path.join(root, "package-result.json"), "utf8"));
  assert.equal(packaged.frontend, "staged frontend\n");
  assert.equal(packaged.resource, "staged resource\n");
  assert.notEqual(packaged.frontendDist, path.join(input, "frontend"));
  assert.match(packaged.resources.replaceAll(path.sep, "/"), /release-inputs\/\.verify-[0-9a-f-]{36}\/resources$/);
  assert.equal(
    await readFile(path.join(input, "frontend", "index.html"), "utf8"),
    "attacker replacement\n",
  );
  assert.deepEqual(
    (await readdir(path.join(root, "release-inputs"))).filter((name) => name.startsWith(".verify-")),
    [],
  );
});

test("failed package removes the canonical snapshot", async () => {
  const { root, input } = await fixture();
  await writeFile(path.join(root, "tauri-fail"), "yes\n");

  const result = run(root, input, { dryRun: false, noSign: nativeTarget === "windows-x64" });

  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(
    (await readdir(path.join(root, "release-inputs"))).filter((name) => name.startsWith(".verify-")),
    [],
  );
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

test("verified plan rejects a stage whose attacker rewrites SHA256SUMS", async () => {
  const { root, input } = await fixture();
  await writeFile(path.join(input, "resources", "runtime.txt"), "attacker replacement\n");
  await writeChecksums(input);

  const result = run(root, input);
  assert.match(result.stderr, /Canonical staging differs: resources\/runtime\.txt/);
});

test("verified plan rejects a release target on the wrong native host", async () => {
  const wrongTarget = nativeTarget === "windows-x64" ? "macos-arm64" : "windows-x64";
  const { root, input } = await fixture(wrongTarget);
  const result = run(root, input);

  assert.match(result.stderr, /must run on (?:darwin|win32)/);
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
  await symlink(path.join(input, "resources"), path.join(input, "frontend", "linked-resources"), "junction");

  const result = run(root, input);
  assert.match(result.stderr, /Staged inputs must not contain symlinks/);
});

test("verified plan rejects a symlinked staged input root", async () => {
  const { root, input } = await fixture();
  const alias = path.join(root, "release-inputs", "alias");
  await symlink(input, alias, "junction");

  const result = run(root, alias);
  assert.match(result.stderr, /Staged inputs must not contain symlinks/);
});

test("verified plan rejects a target with a mismatched Tauri target", async () => {
  const { root, input } = await fixture();
  const metadataFile = path.join(input, "RELEASE-METADATA.json");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  metadata.rustTarget = "universal-apple-darwin";
  await writeFile(metadataFile, `${JSON.stringify(metadata)}\n`);
  await writeChecksums(input);

  const result = run(root, input);
  assert.ok(result.stderr.includes(`does not match staged target ${nativeTarget}`), result.stderr);
});
