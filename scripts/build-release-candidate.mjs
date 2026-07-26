import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  "macos-universal": {
    host: "darwin",
    rustTarget: "universal-apple-darwin",
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
      else if (details.isFile()) files.set(path.relative(input, file).split(path.sep).join("/"), file);
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
    if (files.get(match[2]) !== file || (await sha256(file)) !== match[1]) {
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
  return planFor(input, metadata, options.noSign);
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const plan = await verifiedPlan(options);
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
}

try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
