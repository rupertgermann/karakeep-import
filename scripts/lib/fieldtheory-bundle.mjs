import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function fileDigest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function sha256(file) {
  return fileDigest(file, "sha256");
}

export async function sha3_256(file) {
  return fileDigest(file, "sha3-256");
}

export async function readBundleManifest(repositoryRoot) {
  return JSON.parse(
    await readFile(
      path.join(repositoryRoot, "vendor", "fieldtheory", "manifest.json"),
      "utf8",
    ),
  );
}

export async function verifyVendoredPackage(repositoryRoot, manifest) {
  const packagePath = path.join(
    repositoryRoot,
    manifest.fieldTheory.packageFile,
  );
  const actual = await sha256(packagePath);
  if (actual !== manifest.fieldTheory.packageSha256) {
    throw new Error(
      `Vendored Field Theory package checksum mismatch: expected ${manifest.fieldTheory.packageSha256}, received ${actual}.`,
    );
  }
}

export function selectRuntimeTargets(platform, architecture) {
  if (platform === "darwin" && architecture === "arm64") {
    return ["darwin-arm64"];
  }
  if (platform === "win32" && architecture === "x64") {
    return ["win-x64"];
  }
  throw new Error(
    `Unsupported Field Theory runtime target: ${platform}-${architecture}.`,
  );
}
