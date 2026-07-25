import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
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
  if (platform === "darwin" && ["arm64", "x64"].includes(architecture)) {
    return ["darwin-arm64", "darwin-x64"];
  }
  if (platform === "win32" && architecture === "x64") {
    return ["win-x64"];
  }
  throw new Error(
    `Unsupported Field Theory runtime target: ${platform}-${architecture}.`,
  );
}
