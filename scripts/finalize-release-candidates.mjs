import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const targets = [
  {
    name: "macos-universal",
    inputOption: "macos-input",
    artifactOption: "macos-artifact",
    evidenceOption: "macos-evidence",
    platforms: ["macos-arm64", "macos-x86_64-native"],
  },
  {
    name: "windows-x64",
    inputOption: "windows-input",
    artifactOption: "windows-artifact",
    evidenceOption: "windows-evidence",
    platforms: ["windows-10-x64", "windows-11-x64"],
  },
];
const requiredGates = [
  "native baseline",
  "clean install",
  "no system runtime",
  "five-browser matrix",
  "X transfer",
  "File transfer",
  "signature",
  "platform verification",
];
const requiredStagedFiles = [
  "DEPENDENCY-INVENTORY.json",
  "RELEASE-METADATA.json",
  "RELEASE-NOTES.md",
  "THIRD-PARTY-NOTICES.md",
];
const allowedOptions = new Set([
  "root",
  "output",
  ...targets.flatMap(({ inputOption, artifactOption, evidenceOption }) => [
    inputOption,
    artifactOption,
    evidenceOption,
  ]),
]);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received ${key ?? "nothing"}.`);
    }
    const name = key.slice(2);
    if (!allowedOptions.has(name)) {
      throw new Error(`Unknown option: --${name}.`);
    }
    if (options[name] !== undefined) {
      throw new Error(`Option may only be provided once: --${name}.`);
    }
    options[name] = value;
  }
  return options;
}

function requireOption(options, name) {
  if (!options[name]) {
    throw new Error(`--${name} is required.`);
  }
  return path.resolve(options[name]);
}

async function readJson(file, description) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${description} JSON ${file}: ${error.message}`);
  }
}

async function requireFile(file, description) {
  let details;
  try {
    details = await lstat(file);
  } catch {
    throw new Error(`Required ${description} is missing: ${file}`);
  }
  if (!details.isFile() || details.size === 0) {
    throw new Error(
      `Required ${description} is not a non-empty regular file: ${file}`,
    );
  }
  return details;
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function requireArtifactMagic(file, target) {
  const content = await readFile(file);
  const valid =
    target === "macos-universal"
      ? content.length >= 512 &&
        content.subarray(content.length - 512, content.length - 508).equals(
          Buffer.from("koly"),
        )
      : content.length >= 2 &&
        content.subarray(0, 2).equals(Buffer.from("MZ"));
  if (!valid) {
    throw new Error(
      `${target} signed artifact does not have the required native installer format.`,
    );
  }
}

async function regularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(item);
      } else if (entry.isFile()) {
        files.push(item);
      } else {
        throw new Error(`Release staging contains a non-regular file: ${item}`);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function repositoryHead(root) {
  const status = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  if (status.status !== 0) {
    throw new Error(`Could not inspect release checkout: ${status.stderr.trim()}`);
  }
  if (status.stdout.trim()) {
    throw new Error("Release checkout must be clean before finalization.");
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) {
    throw new Error("Could not resolve the current release HEAD.");
  }
  return head.stdout.trim();
}

async function requireLegacyGuiAbsent(root) {
  for (const relative of [
    "karakeep-import-gui.py",
    "tests/test_karakeep_import_gui.py",
  ]) {
    try {
      await stat(path.join(root, relative));
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    throw new Error(`Legacy GUI release blocker is still present: ${relative}`);
  }
}

function safeChecksumPath(relative) {
  if (
    !relative ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.posix.normalize(relative) !== relative ||
    relative === ".." ||
    relative.startsWith("../")
  ) {
    throw new Error(`Unsafe staging checksum path: ${relative}`);
  }
  return relative;
}

async function verifyStagingChecksums(directory, target) {
  const checksumFile = path.join(directory, "SHA256SUMS");
  await requireFile(checksumFile, `${target} SHA256SUMS`);
  const content = await readFile(checksumFile, "utf8");
  const lines = content.trimEnd().split("\n");
  const expected = new Map();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) {
      throw new Error(`Invalid ${target} SHA256SUMS line: ${line}`);
    }
    const relative = safeChecksumPath(match[2]);
    if (relative === "SHA256SUMS" || expected.has(relative)) {
      throw new Error(`Invalid duplicate ${target} checksum path: ${relative}`);
    }
    expected.set(relative, match[1]);
  }
  for (const required of requiredStagedFiles) {
    if (!expected.has(required)) {
      throw new Error(`${target} SHA256SUMS does not cover ${required}.`);
    }
  }

  const stagedFiles = (await regularFiles(directory))
    .map((file) => path.relative(directory, file).split(path.sep).join("/"))
    .filter((relative) => relative !== "SHA256SUMS");
  if (
    expected.size !== stagedFiles.length ||
    stagedFiles.some((relative) => !expected.has(relative))
  ) {
    throw new Error(`${target} SHA256SUMS does not cover the complete staging tree.`);
  }
  for (const [relative, digest] of expected) {
    const actual = await sha256(path.join(directory, relative));
    if (actual !== digest) {
      throw new Error(`${target} staging checksum mismatch: ${relative}`);
    }
  }
}

function validateProduct(product) {
  if (
    !product ||
    typeof product !== "object" ||
    !["name", "identifier", "version"].every(
      (name) => typeof product[name] === "string" && product[name],
    )
  ) {
    throw new Error("Release product name, identifier, and version are required.");
  }
}

function rejectUnsupportedProperties(value, allowed, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const unsupported = Object.keys(value).filter(
    (name) => !allowed.includes(name),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${description} has unsupported properties: ${unsupported.join(", ")}`,
    );
  }
}

function safeArtifactFilename(filename, target) {
  if (
    typeof filename !== "string" ||
    filename.length > 192 ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(filename) ||
    path.posix.basename(filename) !== filename ||
    path.win32.basename(filename) !== filename
  ) {
    throw new Error(`${target} evidence artifact filename is unsafe.`);
  }
  const extension = target === "macos-universal" ? ".dmg" : ".exe";
  if (!filename.toLowerCase().endsWith(extension)) {
    throw new Error(
      `${target} evidence artifact filename does not have the expected extension.`,
    );
  }
  return filename;
}

function safeEvidenceFilename(filename, target) {
  const privateLooking =
    /(?:^|[._-])(?:api[-_]?key|cookie|credential|email|home|password|private|profile|secret|session|temp|tmp|user)(?:[._-]|$)/i;
  const generatedFilenames = new Set(["acceptance-evidence.json"]);
  if (
    typeof filename !== "string" ||
    filename.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) ||
    path.posix.basename(filename) !== filename ||
    path.win32.basename(filename) !== filename ||
    privateLooking.test(filename) ||
    generatedFilenames.has(filename.toLowerCase())
  ) {
    throw new Error(`${target} evidence reference filename is unsafe or private-looking.`);
  }
  return filename;
}

function collectEvidenceReferences(references, target, description, collected) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error(`${target} evidence ${description} requires evidence references.`);
  }
  for (const reference of references) {
    rejectUnsupportedProperties(
      reference,
      ["file", "sha256"],
      `${target} evidence ${description} reference`,
    );
    const filename = safeEvidenceFilename(reference?.file, target);
    if (
      typeof reference.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(reference.sha256)
    ) {
      throw new Error(
        `${target} evidence ${description} reference has an invalid SHA-256.`,
      );
    }
    const previous = collected.get(filename);
    if (previous && previous !== reference.sha256) {
      throw new Error(
        `${target} evidence reference has conflicting SHA-256 values: ${filename}`,
      );
    }
    collected.set(filename, reference.sha256);
  }
}

function validatePassWithEvidence(value, target, description, collected) {
  rejectUnsupportedProperties(
    value,
    ["status", "evidence"],
    `${target} evidence ${description}`,
  );
  if (value?.status !== "PASS") {
    throw new Error(`${target} evidence ${description} is not PASS.`);
  }
  collectEvidenceReferences(
    value.evidence,
    target,
    description,
    collected,
  );
}

function validateSigningIdentity(identity, target, collected) {
  rejectUnsupportedProperties(
    identity,
    [
      "scope",
      "subject",
      "stableIdentifier",
      "certificateSha256",
      "timestampStatus",
      "evidence",
    ],
    `${target} evidence signing identity`,
  );
  if (
    typeof identity?.scope !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,63}$/.test(identity.scope)
  ) {
    throw new Error(`${target} evidence signing identity scope is invalid.`);
  }
  if (
    typeof identity.subject !== "string" ||
    identity.subject.trim() !== identity.subject ||
    identity.subject.length === 0 ||
    identity.subject.length > 256 ||
    /[\r\n]/.test(identity.subject) ||
    /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/i.test(identity.subject)
  ) {
    throw new Error(`${target} evidence signing identity subject is invalid.`);
  }
  if (
    typeof identity.stableIdentifier !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(
      identity.stableIdentifier,
    )
  ) {
    throw new Error(
      `${target} evidence signing identity stable identifier is invalid.`,
    );
  }
  if (
    typeof identity.certificateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.certificateSha256)
  ) {
    throw new Error(
      `${target} evidence signing identity certificate SHA-256 is invalid.`,
    );
  }
  if (identity.timestampStatus !== "PASS") {
    throw new Error(
      `${target} evidence signing identity timestamp status is not PASS.`,
    );
  }
  collectEvidenceReferences(
    identity.evidence,
    target,
    "signing identity",
    collected,
  );
}

function validateSigningIdentities(identities, target, collected) {
  if (!Array.isArray(identities) || identities.length === 0) {
    throw new Error(`${target} evidence requires signing identities.`);
  }
  const scopes = new Set();
  for (const identity of identities) {
    validateSigningIdentity(identity, target, collected);
    if (scopes.has(identity.scope)) {
      throw new Error(
        `${target} evidence has a duplicate signing identity scope: ${identity.scope}`,
      );
    }
    scopes.add(identity.scope);
  }
}

function validateEvidence(evidence, expected) {
  const collected = new Map();
  rejectUnsupportedProperties(
    evidence,
    [
      "schemaVersion",
      "target",
      "commit",
      "product",
      "testedAt",
      "checkout",
      "artifact",
      "signingIdentities",
      "platforms",
      "gates",
    ],
    `${expected.target} evidence root`,
  );
  if (evidence.schemaVersion !== 2) {
    throw new Error(`${expected.target} evidence has an unsupported schema.`);
  }
  if (evidence.target !== expected.target) {
    throw new Error(`${expected.target} evidence target does not match.`);
  }
  if (evidence.commit !== expected.commit) {
    throw new Error(`${expected.target} evidence commit does not match HEAD.`);
  }
  rejectUnsupportedProperties(
    evidence.product,
    ["name", "identifier", "version"],
    `${expected.target} evidence product`,
  );
  if (!isDeepStrictEqual(evidence.product, expected.product)) {
    throw new Error(`${expected.target} evidence product does not match.`);
  }
  if (
    typeof evidence.testedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      evidence.testedAt,
    ) ||
    Number.isNaN(Date.parse(evidence.testedAt))
  ) {
    throw new Error(
      `${expected.target} evidence test timestamp is not a valid UTC date-time.`,
    );
  }
  rejectUnsupportedProperties(
    evidence.artifact,
    ["filename", "size", "sha256"],
    `${expected.target} evidence artifact`,
  );
  const artifactFilename = safeArtifactFilename(
    evidence.artifact?.filename,
    expected.target,
  );
  if (artifactFilename !== expected.artifactFilename) {
    throw new Error(`${expected.target} evidence artifact filename does not match.`);
  }
  if (evidence.artifact?.size !== expected.artifactSize) {
    throw new Error(`${expected.target} evidence artifact size does not match.`);
  }
  if (evidence.artifact?.sha256 !== expected.artifactSha256) {
    throw new Error(`${expected.target} evidence artifact SHA-256 does not match.`);
  }
  validatePassWithEvidence(
    evidence.checkout,
    expected.target,
    "clean checkout",
    collected,
  );
  validateSigningIdentities(
    evidence.signingIdentities,
    expected.target,
    collected,
  );
  rejectUnsupportedProperties(
    evidence.platforms,
    expected.platforms,
    `${expected.target} evidence platforms`,
  );
  const platformNames = Object.keys(evidence.platforms ?? {});
  if (
    platformNames.length !== expected.platforms.length ||
    expected.platforms.some((platform) => !platformNames.includes(platform))
  ) {
    throw new Error(
      `${expected.target} evidence platforms do not match the required native set.`,
    );
  }
  for (const platform of expected.platforms) {
    validatePassWithEvidence(
      evidence.platforms[platform],
      expected.target,
      `platform ${platform}`,
      collected,
    );
  }
  rejectUnsupportedProperties(
    evidence.gates,
    requiredGates,
    `${expected.target} evidence gates`,
  );
  const names = Object.keys(evidence.gates ?? {});
  if (
    names.length !== requiredGates.length ||
    requiredGates.some((gate) => !names.includes(gate))
  ) {
    throw new Error(`${expected.target} evidence gates do not match the required set.`);
  }
  for (const gate of requiredGates) {
    validatePassWithEvidence(
      evidence.gates[gate],
      expected.target,
      `gate ${gate}`,
      collected,
    );
  }
  return collected;
}

async function verifyEvidenceFiles(evidenceFile, target, references) {
  const verified = [];
  for (const [filename, digest] of references) {
    const file = path.join(path.dirname(evidenceFile), filename);
    await requireFile(file, `${target} referenced evidence ${filename}`);
    const actual = await sha256(file);
    if (actual !== digest) {
      throw new Error(`${target} referenced evidence SHA-256 mismatch: ${filename}`);
    }
    verified.push({ filename, file, sha256: digest });
  }
  return verified;
}

async function validateTarget(options, target, commit) {
  const input = requireOption(options, target.inputOption);
  await verifyStagingChecksums(input, target.name);
  const metadataFile = path.join(input, "RELEASE-METADATA.json");
  const metadata = await readJson(
    metadataFile,
    `${target.name} release metadata`,
  );
  if (metadata.schemaVersion !== 1) {
    throw new Error(`${target.name} release metadata has an unsupported schema.`);
  }
  if (metadata.target !== target.name) {
    throw new Error(`${target.name} release metadata target does not match.`);
  }
  if (metadata.commit !== commit) {
    throw new Error(`${target.name} release metadata commit does not match HEAD.`);
  }
  if (
    !Number.isSafeInteger(metadata.sourceDateEpoch) ||
    metadata.sourceDateEpoch <= 0
  ) {
    throw new Error(
      `${target.name} release metadata source date epoch is invalid.`,
    );
  }
  validateProduct(metadata.product);

  const artifact = requireOption(options, target.artifactOption);
  const artifactDetails = await requireFile(
    artifact,
    `${target.name} signed artifact`,
  );
  await requireArtifactMagic(artifact, target.name);
  const artifactSha256 = await sha256(artifact);
  const evidenceFile = requireOption(options, target.evidenceOption);
  await requireFile(evidenceFile, `${target.name} acceptance evidence`);
  const evidence = await readJson(
    evidenceFile,
    `${target.name} acceptance evidence`,
  );
  const references = validateEvidence(evidence, {
    target: target.name,
    commit,
    product: metadata.product,
    artifactFilename: path.basename(artifact),
    artifactSize: artifactDetails.size,
    artifactSha256,
    platforms: target.platforms,
  });
  const evidenceFiles = await verifyEvidenceFiles(
    evidenceFile,
    target.name,
    references,
  );

  return {
    target: target.name,
    input,
    metadata,
    metadataFile,
    metadataSha256: await sha256(metadataFile),
    artifact,
    artifactSha256,
    evidenceFile,
    evidenceSha256: await sha256(evidenceFile),
    evidenceFiles,
  };
}

async function ensureOutputDoesNotExist(output) {
  try {
    await stat(output);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Release output already exists: ${output}`);
}

async function writeChecksums(output) {
  const files = (await regularFiles(output)).filter(
    (file) => path.basename(file) !== "SHA256SUMS",
  );
  const lines = [];
  for (const file of files) {
    const relative = path.relative(output, file).split(path.sep).join("/");
    lines.push(`${await sha256(file)}  ${relative}`);
  }
  await writeFile(path.join(output, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function assemble(output, commit, product, candidates, releaseNotes) {
  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(`${output}.staging-`);
  try {
    const finalTargets = {};
    for (const candidate of candidates) {
      const artifactPath = path.posix.join(
        "artifacts",
        candidate.target,
        path.basename(candidate.artifact),
      );
      const evidenceDirectory = path.posix.join(
        "acceptance-evidence",
        candidate.target,
      );
      const evidencePath = path.posix.join(
        evidenceDirectory,
        "acceptance-evidence.json",
      );
      const inventoryPath = path.posix.join(
        "targets",
        candidate.target,
        "DEPENDENCY-INVENTORY.json",
      );
      const noticesPath = path.posix.join(
        "targets",
        candidate.target,
        "THIRD-PARTY-NOTICES.md",
      );
      const releaseMetadataPath = path.posix.join(
        "targets",
        candidate.target,
        "RELEASE-METADATA.json",
      );
      for (const relative of [
        artifactPath,
        evidencePath,
        inventoryPath,
        noticesPath,
        releaseMetadataPath,
      ]) {
        await mkdir(path.dirname(path.join(staging, relative)), {
          recursive: true,
        });
      }
      await cp(candidate.artifact, path.join(staging, artifactPath));
      await cp(candidate.evidenceFile, path.join(staging, evidencePath));
      const finalEvidenceFiles = [];
      for (const evidence of candidate.evidenceFiles) {
        const relative = path.posix.join(
          evidenceDirectory,
          evidence.filename,
        );
        await cp(evidence.file, path.join(staging, relative));
        finalEvidenceFiles.push({
          path: relative,
          sha256: evidence.sha256,
        });
      }
      await cp(
        path.join(candidate.input, "DEPENDENCY-INVENTORY.json"),
        path.join(staging, inventoryPath),
      );
      await cp(
        path.join(candidate.input, "THIRD-PARTY-NOTICES.md"),
        path.join(staging, noticesPath),
      );
      await cp(candidate.metadataFile, path.join(staging, releaseMetadataPath));
      finalTargets[candidate.target] = {
        artifact: {
          path: artifactPath,
          sha256: candidate.artifactSha256,
        },
        acceptanceEvidence: {
          path: evidencePath,
          sha256: candidate.evidenceSha256,
          files: finalEvidenceFiles,
        },
        dependencyInventory: inventoryPath,
        releaseMetadata: {
          path: releaseMetadataPath,
          sha256: candidate.metadataSha256,
        },
        thirdPartyNotices: noticesPath,
      };
    }
    await writeFile(path.join(staging, "RELEASE-NOTES.md"), releaseNotes);
    await writeFile(
      path.join(staging, "RELEASE-METADATA.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product,
          commit,
          sourceDateEpoch: candidates[0].metadata.sourceDateEpoch,
          releaseNotes: {
            path: "RELEASE-NOTES.md",
            sha256: createHash("sha256").update(releaseNotes).digest("hex"),
          },
          targets: finalTargets,
        },
        null,
        2,
      )}\n`,
    );
    await writeChecksums(staging);
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function finalize(options) {
  const root = path.resolve(options.root ?? scriptRoot);
  const output = requireOption(options, "output");
  await ensureOutputDoesNotExist(output);
  const commit = repositoryHead(root);
  await requireLegacyGuiAbsent(root);

  const candidates = [];
  for (const target of targets) {
    candidates.push(await validateTarget(options, target, commit));
  }
  const [macos, windows] = candidates;
  if (!isDeepStrictEqual(macos.metadata.product, windows.metadata.product)) {
    throw new Error("Staged release product or version does not match across targets.");
  }
  if (macos.metadata.sourceDateEpoch !== windows.metadata.sourceDateEpoch) {
    throw new Error("Staged release source date epoch does not match across targets.");
  }
  const macosNotes = await readFile(path.join(macos.input, "RELEASE-NOTES.md"));
  const windowsNotes = await readFile(
    path.join(windows.input, "RELEASE-NOTES.md"),
  );
  if (!macosNotes.equals(windowsNotes)) {
    throw new Error("Staged release notes are not byte-identical.");
  }

  await assemble(
    output,
    commit,
    macos.metadata.product,
    candidates,
    macosNotes,
  );
  process.stdout.write(
    `Finalized ${macos.metadata.product.name} ${macos.metadata.product.version} at ${output}\n`,
  );
}

try {
  await finalize(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
