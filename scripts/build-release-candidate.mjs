import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
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

async function verifyChecksums(input) {
  const sums = await readFile(path.join(input, "SHA256SUMS"), "utf8");
  const seen = new Set();
  for (const line of sums.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match || seen.has(match?.[2])) throw new Error("SHA256SUMS is malformed.");
    seen.add(match[2]);
    const file = stagedPath(input, match[2]);
    if (!(await stat(file)).isFile() || (await sha256(file)) !== match[1]) {
      throw new Error(`Staged checksum mismatch: ${match[2]}`);
    }
  }
  if (!seen.size) throw new Error("SHA256SUMS is empty.");
}

function nativeHost(target) {
  if (target === "macos-universal") return "darwin";
  if (target === "windows-x64") return "win32";
  throw new Error(`Unsupported staged release target: ${target}`);
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
  const metadata = JSON.parse(await readFile(path.join(input, "RELEASE-METADATA.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(metadata.commit ?? "")) throw new Error("Staged release commit is invalid.");
  if (metadata.commit !== cleanHead()) throw new Error("Staged release commit does not match checkout HEAD.");
  await verifyChecksums(input);
  for (const key of ["target", "rustTarget", "bundleFormat"]) {
    if (!/^[A-Za-z0-9._-]+$/.test(metadata[key] ?? "")) throw new Error(`Staged release metadata ${key} is invalid.`);
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
