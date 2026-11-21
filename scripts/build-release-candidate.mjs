import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root = path.resolve(process.cwd());

function argumentsFrom(argv) {
  const options = { dryRun: false, noSign: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") options.dryRun = true;
    else if (value === "--no-sign") options.noSign = true;
    else if (value === "--input" && argv[index + 1]) options.input = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${value}`);
  }
  if (!options.input) throw new Error("--input is required.");
  return options;
}

const sha256 = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

function cleanHead() {
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  if (status.status !== 0) throw new Error("Could not inspect release checkout status.");
  if (status.stdout.trim()) throw new Error("Release checkout must be clean.");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) throw new Error("Could not resolve release checkout HEAD.");
  return head.stdout.trim();
}

function stagedPath(input, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid staged checksum path: ${relative}`);
  }
  return path.join(input, relative);
}

const targetConfigurations = {
  "macos-arm64": {
    host: "darwin",
    rustTarget: "aarch64-apple-darwin",
    bundleFormat: "dmg",
  },
  "windows-x64": {
    host: "win32",
    rustTarget: "x86_64-pc-windows-msvc",
    bundleFormat: "nsis",
  },
};

async function stagedFiles(input) {
  if ((await lstat(input)).isSymbolicLink()) {
    throw new Error("Staged inputs must not contain symlinks: .");
  }
  const files = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const details = await lstat(file);
      if (details.isSymbolicLink()) {
        throw new Error(`Staged inputs must not contain symlinks: ${path.relative(input, file)}`);
      }
      if (details.isDirectory()) await visit(file);
      else if (details.isFile()) {
        files.set(path.relative(input, file).split(path.sep).join("/"), {
          file,
          mode: details.mode & 0o777,
        });
      }
      else throw new Error(`Unsupported staged input: ${path.relative(input, file)}`);
    }
  }
  await visit(input);
  return files;
}

async function verifyChecksums(input) {
  const files = await stagedFiles(input);
  const required = [
    "RELEASE-METADATA.json",
    "RELEASE-NOTES.md",
    "DEPENDENCY-INVENTORY.json",
    "THIRD-PARTY-NOTICES.md",
    "NATIVE-BUILD-COMMAND.txt",
  ];
  for (const relative of required) {
    if (!files.has(relative)) throw new Error(`Required staged file is missing: ${relative}`);
  }
  for (const root of ["frontend/", "resources/"]) {
    if (![...files.keys()].some((relative) => relative.startsWith(root))) {
      throw new Error(`Required staged ${root.slice(0, -1)} file is missing.`);
    }
  }
  const sums = await readFile(path.join(input, "SHA256SUMS"), "utf8");
  const seen = new Set();
  for (const line of sums.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match || seen.has(match?.[2])) throw new Error("SHA256SUMS is malformed.");
    seen.add(match[2]);
    const file = stagedPath(input, match[2]);
    if (files.get(match[2])?.file !== file || (await sha256(file)) !== match[1]) {
      throw new Error(`Staged checksum mismatch: ${match[2]}`);
    }
  }
  if (!seen.size) throw new Error("SHA256SUMS is empty.");
  for (const relative of files.keys()) {
    if (relative !== "SHA256SUMS" && !seen.has(relative)) {
      throw new Error(`Staged file is missing from SHA256SUMS: ${relative}`);
    }
  }
}

function canonicalDifference(relative) {
  throw new Error(`Canonical staging differs: ${relative}`);
}

async function requireCanonicalMatch(suppliedInput, canonicalInput) {
  const supplied = await stagedTree(suppliedInput);
  const canonical = await stagedTree(canonicalInput);
  const paths = [...new Set([...supplied.keys(), ...canonical.keys()])].sort(
    (left, right) => {
      if (left === "SHA256SUMS") return 1;
      if (right === "SHA256SUMS") return -1;
      return left.localeCompare(right);
    },
  );
  for (const relative of paths) {
    const actual = supplied.get(relative);
    const expected = canonical.get(relative);
    if (!actual || !expected) canonicalDifference(relative);
    if (actual.type !== expected.type) canonicalDifference(relative);
    if (
      actual.type === "file" &&
      (await sha256(actual.file)) !== (await sha256(expected.file))
    ) {
      canonicalDifference(relative);
    }
    if (process.platform !== "win32" && actual.mode !== expected.mode) {
      canonicalDifference(relative);
    }
  }
}

async function stagedTree(input) {
  if ((await lstat(input)).isSymbolicLink()) {
    throw new Error("Staged inputs must not contain symlinks: .");
  }
  const entries = new Map();
  async function visit(directory, relative = ".") {
    const details = await lstat(directory);
    entries.set(relative, { type: "directory", mode: details.mode & 0o777 });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      const childDetails = await lstat(file);
      if (childDetails.isSymbolicLink()) {
        throw new Error(`Staged inputs must not contain symlinks: ${child}`);
      }
      if (childDetails.isDirectory()) await visit(file, child);
      else if (childDetails.isFile()) {
        entries.set(child, {
          type: "file",
          file,
          mode: childDetails.mode & 0o777,
        });
      } else throw new Error(`Unsupported staged input: ${child}`);
    }
  }
  await visit(input);
  return entries;
}

function verificationOutput() {
  return path.join(root, "release-inputs", `.verify-${randomUUID()}`);
}

function safeVerificationOutput(output) {
  const parent = path.join(root, "release-inputs");
  return (
    path.dirname(output) === parent &&
    /^\.verify-[0-9a-f-]{36}$/.test(path.basename(output))
  );
}

async function removeCanonicalSnapshot(output) {
  if (!safeVerificationOutput(output)) {
    throw new Error("Canonical staging output is invalid.");
  }
  await rm(output, { recursive: true, force: true });
}

function rebuildFrontend() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["run", "build"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Could not rebuild frontend for canonical staging: ${result.stderr.trim()}`,
    );
  }
}

async function canonicalStaging(metadata, output) {
  if (!safeVerificationOutput(output)) {
    throw new Error("Canonical staging output is invalid.");
  }
  rebuildFrontend();
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "prepare-release-inputs.mjs"),
      "--target",
      metadata.target,
      "--output",
      output,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not prepare canonical release inputs: ${result.stderr.trim()}`);
  }
  return output;
}

function nativeHost(target) {
  const configuration = targetConfigurations[target];
  if (!configuration) throw new Error(`Unsupported staged release target: ${target}`);
  return configuration.host;
}

function planFor(input, metadata, noSign) {
  const frontend = path.join(input, "frontend");
  const resources = path.join(input, "resources");
  const config = {
    build: { beforeBuildCommand: "", frontendDist: frontend },
    bundle: { resources: { resources: null, [resources]: "" } },
  };
  const args = ["run", "tauri", "--", "build", "--target", metadata.rustTarget, "--bundles", metadata.bundleFormat];
  if (noSign) args.push("--no-sign");
  return { input, target: metadata.target, tauri: { command: process.platform === "win32" ? "npm.cmd" : "npm", args }, config };
}

async function verifiedPlan(options) {
  const input = path.resolve(root, options.input);
  await verifyChecksums(input);
  const metadata = JSON.parse(await readFile(path.join(input, "RELEASE-METADATA.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(metadata.commit ?? "")) throw new Error("Staged release commit is invalid.");
  if (metadata.commit !== cleanHead()) throw new Error("Staged release commit does not match checkout HEAD.");
  const expected = targetConfigurations[metadata.target];
  if (!expected) throw new Error(`Unsupported staged release target: ${metadata.target}`);
  if (
    metadata.rustTarget !== expected.rustTarget ||
    metadata.bundleFormat !== expected.bundleFormat
  ) {
    throw new Error(`Staged metadata does not match staged target ${metadata.target}.`);
  }
  const expectedHost = nativeHost(metadata.target);
  if (process.platform !== expectedHost) throw new Error(`Staged ${metadata.target} release must run on ${expectedHost}.`);
  const canonical = verificationOutput();
  try {
    await canonicalStaging(metadata, canonical);
    await requireCanonicalMatch(input, canonical);
    return { canonical, plan: planFor(canonical, metadata, options.noSign) };
  } catch (error) {
    await removeCanonicalSnapshot(canonical);
    throw error;
  }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const { canonical, plan } = await verifiedPlan(options);
  try {
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }
    const temporary = await mkdtemp(path.join(os.tmpdir(), "karakeep-tauri-config-"));
    try {
      const config = path.join(temporary, "tauri.release-inputs.json");
      await writeFile(config, `${JSON.stringify(plan.config)}\n`);
      const result = spawnSync(plan.tauri.command, [...plan.tauri.args, "--config", config], { cwd: root, stdio: "inherit" });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } finally {
    await removeCanonicalSnapshot(canonical);
  }
}

try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
