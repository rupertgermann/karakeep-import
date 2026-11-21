import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  readBundleManifest,
  selectRuntimeTargets,
  sha256,
  sha3_256,
  verifyVendoredPackage,
} from "./lib/fieldtheory-bundle.mjs";
import { npmInvocation } from "./lib/npm-invocation.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const resources = path.join(repositoryRoot, "src-tauri", "resources");
const cache = path.join(os.tmpdir(), "karakeep-transfer-runtime-cache");

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download pinned runtime artifact (${response.status}).`);
  }
  const temporary = `${destination}.partial`;
  await pipeline(response.body, createWriteStream(temporary));
  await rename(temporary, destination);
}

function requireSha256(value, description) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) {
    throw new Error(`${description} is not pinned with SHA-256.`);
  }
}

async function verifiedArchive(artifact, url, description) {
  requireSha256(artifact.sha256, `${description} archive`);
  const archive = path.join(cache, artifact.file);
  await mkdir(cache, { recursive: true });
  let valid = false;
  try {
    valid = (await sha256(archive)) === artifact.sha256;
  } catch {
    valid = false;
  }
  if (!valid) {
    await rm(archive, { force: true });
    await download(url, archive);
  }
  if ((await sha256(archive)) !== artifact.sha256) {
    throw new Error(`${description} archive checksum mismatch.`);
  }
  if (
    artifact.sha3_256 &&
    (await sha3_256(archive)) !== artifact.sha3_256
  ) {
    throw new Error(`${description} archive SHA3-256 mismatch.`);
  }
  return archive;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Runtime preparation command failed: ${command}.`);
  }
}

async function extractNode(manifest, target, archive) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "karakeep-node-"));
  const destination = path.join(resources, "node", target);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  if (target.startsWith("darwin-")) {
    run("tar", ["-xJf", archive, "-C", temporary], repositoryRoot);
  } else {
    run(
      "powershell.exe",
      [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archive,
        "-DestinationPath",
        temporary,
      ],
      repositoryRoot,
    );
  }

  const extractedRoot = path.join(
    temporary,
    `node-v${manifest.node.version}-${target}`,
  );
  const executable = target === "win-x64" ? "node.exe" : path.join("bin", "node");
  const sourceExecutable = path.join(extractedRoot, executable);
  const artifact = manifest.node.artifacts[target];
  requireSha256(
    artifact.executableSha256,
    `Node runtime ${target} executable`,
  );
  try {
    if ((await sha256(sourceExecutable)) !== artifact.executableSha256) {
      throw new Error(
        `Node runtime ${target} executable checksum mismatch after extraction.`,
      );
    }
    await copyFile(
      sourceExecutable,
      path.join(destination, path.basename(executable)),
    );
    if (target !== "win-x64") {
      await chmod(path.join(destination, "node"), 0o755);
    }
    await mkdir(path.join(resources, "node"), { recursive: true });
    await copyFile(
      path.join(extractedRoot, "LICENSE"),
      path.join(resources, "node", "LICENSE"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function extractSqlite(manifest, target, archive) {
  const artifact = manifest.sqlite.artifacts[target];
  requireSha256(
    artifact.executableSha256,
    `SQLite runtime ${target} executable`,
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "karakeep-sqlite-"));
  const destination = path.join(resources, "sqlite", target);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  try {
    run(
      "powershell.exe",
      [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archive,
        "-DestinationPath",
        temporary,
      ],
      repositoryRoot,
    );
    const sourceExecutable = path.join(temporary, "sqlite3.exe");
    if ((await sha256(sourceExecutable)) !== artifact.executableSha256) {
      throw new Error(
        `SQLite runtime ${target} executable checksum mismatch after extraction.`,
      );
    }
    await copyFile(sourceExecutable, path.join(destination, "sqlite3.exe"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function prepareBridge() {
  const destination = path.join(resources, "fieldtheory");
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, "bridge"), { recursive: true });
  await mkdir(path.join(destination, "vendor"), { recursive: true });

  for (const file of ["package.json", "package-lock.json"]) {
    await copyFile(
      path.join(repositoryRoot, "fieldtheory-bridge", file),
      path.join(destination, "bridge", file),
    );
  }
  await cp(
    path.join(repositoryRoot, "fieldtheory-bridge", "src"),
    path.join(destination, "bridge", "src"),
    { recursive: true },
  );
  await cp(
    path.join(repositoryRoot, "vendor", "fieldtheory"),
    path.join(destination, "vendor", "fieldtheory"),
    { recursive: true },
  );

  run(
    ...npmInvocation([
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--cache",
      path.join(cache, "npm"),
    ]),
    path.join(destination, "bridge"),
  );
  await rm(path.join(destination, "bridge", "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
}

const runtimeTargets = selectRuntimeTargets(process.platform, process.arch);
const manifest = await readBundleManifest(repositoryRoot);
await verifyVendoredPackage(repositoryRoot, manifest);
await mkdir(resources, { recursive: true });
await rm(path.join(resources, "node"), { recursive: true, force: true });
await rm(path.join(resources, "sqlite"), { recursive: true, force: true });
await prepareBridge();
for (const target of runtimeTargets) {
  const artifact = manifest.node.artifacts[target];
  await extractNode(
    manifest,
    target,
    await verifiedArchive(
      artifact,
      `https://nodejs.org/dist/v${manifest.node.version}/${artifact.file}`,
      `Node runtime ${target}`,
    ),
  );
}
if (runtimeTargets.includes("win-x64")) {
  const target = "win-x64";
  const artifact = manifest.sqlite.artifacts[target];
  await extractSqlite(
    manifest,
    target,
    await verifiedArchive(
      artifact,
      manifest.sqlite.sourceUrl,
      `SQLite runtime ${target}`,
    ),
  );
}
await copyFile(
  path.join(repositoryRoot, "vendor", "fieldtheory", "manifest.json"),
  path.join(resources, "fieldtheory-manifest.json"),
);
await copyFile(
  path.join(repositoryRoot, "vendor", "fieldtheory", "THIRD_PARTY_NOTICES.md"),
  path.join(resources, "THIRD_PARTY_NOTICES.md"),
);

const preparedManifest = JSON.parse(
  await readFile(path.join(resources, "fieldtheory-manifest.json"), "utf8"),
);
process.stdout.write(
  `Prepared Field Theory ${preparedManifest.fieldTheory.version} with private Node ${preparedManifest.node.version}${runtimeTargets.includes("win-x64") ? ` and SQLite ${preparedManifest.sqlite.version}` : ""}.\n`,
);
