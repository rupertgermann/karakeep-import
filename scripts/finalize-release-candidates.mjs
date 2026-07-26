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
import os from "node:os";
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
const gateAssertionIds = {
  "native baseline": "gate:native-baseline",
  "clean install": "gate:clean-install",
  "no system runtime": "gate:no-system-runtime",
  "five-browser matrix": "gate:five-browser-matrix",
  "X transfer": "gate:x-transfer",
  "File transfer": "gate:file-transfer",
  signature: "gate:signature",
  "platform verification": "gate:platform-verification",
};
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

function boundedRange(offset, length, boundary) {
  const limit = BigInt(boundary);
  return length > 0n && offset <= limit && length <= limit - offset;
}

function coherentUdifChecksum(content, trailer, offset) {
  const type = content.readUInt32BE(trailer + offset);
  const bits = content.readUInt32BE(trailer + offset + 4);
  return (
    (type === 0 && bits === 0) ||
    (type === 2 && bits === 32) ||
    (type > 0 &&
      type !== 2 &&
      type <= 0xffff &&
      bits > 0 &&
      bits <= 1024 &&
      bits % 8 === 0)
  );
}

function coherentUdif(content) {
  if (content.length < 1024) {
    return false;
  }
  const trailer = content.length - 512;
  if (
    !content.subarray(trailer, trailer + 4).equals(Buffer.from("koly")) ||
    content.readUInt32BE(trailer + 4) !== 4 ||
    content.readUInt32BE(trailer + 8) !== 512
  ) {
    return false;
  }

  const dataOffset = content.readBigUInt64BE(trailer + 24);
  const dataLength = content.readBigUInt64BE(trailer + 32);
  const resourceOffset = content.readBigUInt64BE(trailer + 40);
  const resourceLength = content.readBigUInt64BE(trailer + 48);
  const xmlOffset = content.readBigUInt64BE(trailer + 216);
  const xmlLength = content.readBigUInt64BE(trailer + 224);
  if (
    !boundedRange(dataOffset, dataLength, trailer) ||
    !boundedRange(xmlOffset, xmlLength, trailer) ||
    dataOffset + dataLength > xmlOffset ||
    (resourceLength > 0n &&
      !boundedRange(resourceOffset, resourceLength, trailer))
  ) {
    return false;
  }

  const segmentNumber = content.readUInt32BE(trailer + 56);
  const segmentCount = content.readUInt32BE(trailer + 60);
  if (
    (segmentNumber === 0) !== (segmentCount === 0) ||
    segmentNumber > segmentCount
  ) {
    return false;
  }

  const sectorCount = content.readBigUInt64BE(trailer + 492);
  const codeSignatureOffset = content.readBigUInt64BE(trailer + 296);
  const codeSignatureLength = content.readBigUInt64BE(trailer + 304);
  if (
    sectorCount === 0n ||
    sectorCount > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 512)) ||
    ((codeSignatureOffset === 0n) !== (codeSignatureLength === 0n)) ||
    (codeSignatureLength > 0n &&
      !boundedRange(codeSignatureOffset, codeSignatureLength, trailer)) ||
    !coherentUdifChecksum(content, trailer, 80) ||
    !coherentUdifChecksum(content, trailer, 352)
  ) {
    return false;
  }

  const plist = content.subarray(
    Number(xmlOffset),
    Number(xmlOffset + xmlLength),
  );
  let plistText;
  try {
    plistText = new TextDecoder("utf-8", { fatal: true })
      .decode(plist)
      .trimStart();
  } catch {
    return false;
  }
  return (
    (plistText.startsWith("<?xml") || plistText.startsWith("<plist")) &&
    plistText.includes("<plist") &&
    plistText.includes("<key>resource-fork</key>") &&
    plistText.includes("<key>blkx</key>")
  );
}

function powerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function coherentPeNsis(content) {
  if (
    content.length < 512 ||
    !content.subarray(0, 2).equals(Buffer.from("MZ"))
  ) {
    return false;
  }
  const peOffset = content.readUInt32LE(0x3c);
  if (
    peOffset < 0x40 ||
    peOffset > content.length - 24 ||
    !content.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0"))
  ) {
    return false;
  }

  const coffOffset = peOffset + 4;
  const numberOfSections = content.readUInt16LE(coffOffset + 2);
  const optionalSize = content.readUInt16LE(coffOffset + 16);
  const characteristics = content.readUInt16LE(coffOffset + 18);
  const optionalOffset = coffOffset + 20;
  const sectionTable = optionalOffset + optionalSize;
  if (
    content.readUInt16LE(coffOffset) !== 0x14c ||
    (characteristics & 0x0002) === 0 ||
    numberOfSections === 0 ||
    numberOfSections > 96 ||
    optionalSize < 96 ||
    sectionTable > content.length - numberOfSections * 40 ||
    content.readUInt16LE(optionalOffset) !== 0x10b
  ) {
    return false;
  }

  const sectionAlignment = content.readUInt32LE(optionalOffset + 32);
  const fileAlignment = content.readUInt32LE(optionalOffset + 36);
  const sizeOfImage = content.readUInt32LE(optionalOffset + 56);
  const sizeOfHeaders = content.readUInt32LE(optionalOffset + 60);
  const directoryCount = content.readUInt32LE(optionalOffset + 92);
  if (
    !powerOfTwo(fileAlignment) ||
    fileAlignment < 512 ||
    fileAlignment > 65536 ||
    sectionAlignment < fileAlignment ||
    sizeOfHeaders % fileAlignment !== 0 ||
    sizeOfHeaders < sectionTable + numberOfSections * 40 ||
    sizeOfHeaders > content.length ||
    sizeOfImage <= sizeOfHeaders ||
    directoryCount > 16 ||
    optionalSize < 96 + directoryCount * 8
  ) {
    return false;
  }

  let rawEnd = sizeOfHeaders;
  let previousVirtualAddress = 0;
  for (let index = 0; index < numberOfSections; index += 1) {
    const section = sectionTable + index * 40;
    const virtualSize = content.readUInt32LE(section + 8);
    const virtualAddress = content.readUInt32LE(section + 12);
    const rawSize = content.readUInt32LE(section + 16);
    const rawOffset = content.readUInt32LE(section + 20);
    if (
      virtualSize === 0 ||
      virtualAddress < previousVirtualAddress ||
      virtualAddress % sectionAlignment !== 0 ||
      virtualAddress + Math.max(virtualSize, rawSize) > sizeOfImage ||
      (rawSize > 0 &&
        (rawSize % fileAlignment !== 0 ||
          rawOffset < sizeOfHeaders ||
          rawOffset % fileAlignment !== 0 ||
          rawOffset > content.length - rawSize))
    ) {
      return false;
    }
    previousVirtualAddress = virtualAddress;
    rawEnd = Math.max(rawEnd, rawOffset + rawSize);
  }

  let overlayBoundary = content.length;
  if (directoryCount > 4) {
    const certificateOffset = content.readUInt32LE(optionalOffset + 128);
    const certificateLength = content.readUInt32LE(optionalOffset + 132);
    if (
      (certificateOffset === 0) !== (certificateLength === 0) ||
      (certificateLength > 0 &&
        (certificateOffset < rawEnd + 28 ||
          certificateOffset > content.length - certificateLength))
    ) {
      return false;
    }
    if (certificateLength > 0) {
      overlayBoundary = certificateOffset;
    }
  }
  const headerOffset = rawEnd;
  if (
    headerOffset > overlayBoundary - 28 ||
    content.readUInt32LE(headerOffset + 4) !== 0xdeadbeef ||
    !content
      .subarray(headerOffset + 8, headerOffset + 20)
      .equals(Buffer.from("NullsoftInst"))
  ) {
    return false;
  }
  const flags = content.readUInt32LE(headerOffset);
  const headerLength = content.readUInt32LE(headerOffset + 20);
  const followingLength = content.readUInt32LE(headerOffset + 24);
  return (
    (flags & ~0xf) === 0 &&
    headerLength > 0 &&
    followingLength >= 28 &&
    followingLength <= overlayBoundary - headerOffset
  );
}

function requireArtifactStructure(content, target) {
  const valid =
    target === "macos-universal"
      ? coherentUdif(content)
      : coherentPeNsis(content);
  if (!valid) {
    throw new Error(
      `${target} signed artifact does not have a coherent native installer structure.`,
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
  return expected;
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
    !filename.toLowerCase().endsWith(".json") ||
    path.posix.basename(filename) !== filename ||
    path.win32.basename(filename) !== filename ||
    privateLooking.test(filename) ||
    generatedFilenames.has(filename.toLowerCase())
  ) {
    throw new Error(`${target} evidence reference filename is unsafe or private-looking.`);
  }
  return filename;
}

function collectEvidenceReferences(
  references,
  target,
  description,
  expected,
  collected,
) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error(`${target} evidence ${description} requires evidence references.`);
  }
  const coveredPlatforms = new Set();
  for (const reference of references) {
    rejectUnsupportedProperties(
      reference,
      ["file", "sha256", "assertionId", "platform"],
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
    if (reference.assertionId !== expected.assertionId) {
      throw new Error(
        `${target} evidence ${description} reference assertion does not match.`,
      );
    }
    if (!expected.platforms.includes(reference.platform)) {
      throw new Error(
        `${target} evidence ${description} reference platform does not match.`,
      );
    }
    if (
      [...collected.keys()].some(
        (collectedFilename) =>
          collectedFilename.toLowerCase() === filename.toLowerCase(),
      )
    ) {
      throw new Error(
        `${target} evidence file is reused across assertions: ${filename}`,
      );
    }
    coveredPlatforms.add(reference.platform);
    collected.set(filename, {
      ...reference,
      checkType: expected.checkType,
    });
  }
  if (
    expected.platforms.some((platform) => !coveredPlatforms.has(platform))
  ) {
    throw new Error(
      `${target} evidence ${description} does not cover every required platform.`,
    );
  }
}

function validatePassWithEvidence(
  value,
  target,
  description,
  expected,
  collected,
) {
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
    expected,
    collected,
  );
}

function validateSigningIdentity(identity, target, collected) {
  rejectUnsupportedProperties(
    identity,
    [
      "scope",
      "assertionId",
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
  const assertionId = `signing-identity:${identity.scope}`;
  if (identity.assertionId !== assertionId) {
    throw new Error(
      `${target} evidence signing identity assertion does not match its scope.`,
    );
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
    {
      assertionId,
      platforms: ["target-wide"],
      checkType: "signing-identity",
    },
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
      ...(expected.target === "windows-x64" ? ["applicationPayload"] : []),
    ],
    `${expected.target} evidence root`,
  );
  if (evidence.schemaVersion !== 3) {
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
    {
      assertionId: "checkout:clean",
      platforms: ["target-wide"],
      checkType: "clean-checkout",
    },
    collected,
  );
  validateSigningIdentities(
    evidence.signingIdentities,
    expected.target,
    collected,
  );
  if (expected.target === "windows-x64") {
    validatePassWithEvidence(
      evidence.applicationPayload,
      expected.target,
      "x64 application payload",
      {
        assertionId: "application-payload:windows-x64",
        platforms: ["target-wide"],
        checkType: "x64-application-payload",
      },
      collected,
    );
  }
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
      {
        assertionId: `platform:${platform}`,
        platforms: [platform],
        checkType: "native-platform",
      },
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
    const assertionId = gateAssertionIds[gate];
    validatePassWithEvidence(
      evidence.gates[gate],
      expected.target,
      `gate ${gate}`,
      {
        assertionId,
        platforms: gate === "signature" ? ["target-wide"] : expected.platforms,
        checkType: assertionId.slice("gate:".length),
      },
      collected,
    );
  }
  return collected;
}

function validateTypedEvidenceRecord(record, expected) {
  rejectUnsupportedProperties(
    record,
    [
      "schemaVersion",
      "target",
      "commit",
      "artifact",
      "assertionId",
      "platform",
      "tool",
      "checkType",
      "status",
      "resultSummary",
    ],
    `${expected.target} typed evidence record`,
  );
  if (record?.schemaVersion !== 1) {
    throw new Error(
      `${expected.target} referenced evidence ${expected.filename} is not a typed evidence record.`,
    );
  }
  rejectUnsupportedProperties(
    record.artifact,
    ["filename", "size", "sha256"],
    `${expected.target} typed evidence artifact`,
  );
  if (
    record.target !== expected.target ||
    record.commit !== expected.commit ||
    !isDeepStrictEqual(record.artifact, expected.artifact)
  ) {
    throw new Error(
      `${expected.target} typed evidence record release or artifact binding does not match: ${expected.filename}`,
    );
  }
  if (
    record.assertionId !== expected.assertionId ||
    record.platform !== expected.platform
  ) {
    throw new Error(
      `${expected.target} typed evidence record assertion or platform does not match: ${expected.filename}`,
    );
  }
  if (
    typeof record.tool !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{1,63}$/.test(record.tool) ||
    record.checkType !== expected.checkType ||
    record.status !== "PASS"
  ) {
    throw new Error(
      `${expected.target} typed evidence record check did not PASS: ${expected.filename}`,
    );
  }
  if (
    typeof record.resultSummary !== "string" ||
    record.resultSummary.trim() !== record.resultSummary ||
    record.resultSummary.length === 0 ||
    record.resultSummary.length > 512 ||
    /[\r\n]/.test(record.resultSummary) ||
    /(?:api[-_ ]?key|authorization|bearer|cookie|credential|email|password|private[-_ ]?key|secret|session)/i.test(
      record.resultSummary,
    ) ||
    /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|https?:\/\/|file:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(
      record.resultSummary,
    )
  ) {
    throw new Error(
      `${expected.target} typed evidence record result summary is not sanitized: ${expected.filename}`,
    );
  }
}

async function verifyEvidenceFiles(
  evidenceFile,
  target,
  references,
  binding,
) {
  const verified = [];
  for (const [filename, reference] of references) {
    const file = path.join(path.dirname(evidenceFile), filename);
    await requireFile(file, `${target} referenced evidence ${filename}`);
    const content = await readFile(file);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== reference.sha256) {
      throw new Error(`${target} referenced evidence SHA-256 mismatch: ${filename}`);
    }
    let record;
    try {
      record = JSON.parse(content.toString("utf8"));
    } catch {
      throw new Error(
        `${target} referenced evidence ${filename} is not a typed evidence record.`,
      );
    }
    validateTypedEvidenceRecord(record, {
      target,
      commit: binding.commit,
      artifact: binding.artifact,
      filename,
      assertionId: reference.assertionId,
      platform: reference.platform,
      checkType: reference.checkType,
    });
    verified.push({ filename, file, sha256: reference.sha256 });
  }
  return verified;
}

async function validateTarget(options, target, commit) {
  const input = requireOption(options, target.inputOption);
  const stagingChecksums = await verifyStagingChecksums(input, target.name);
  const metadataFile = path.join(input, "RELEASE-METADATA.json");
  const metadataContent = await readFile(metadataFile);
  const metadataSha256 = createHash("sha256").update(metadataContent).digest("hex");
  if (metadataSha256 !== stagingChecksums.get("RELEASE-METADATA.json")) {
    throw new Error(`${target.name} release metadata changed during validation.`);
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataContent.toString("utf8"));
  } catch (error) {
    throw new Error(`Could not read ${target.name} release metadata JSON ${metadataFile}: ${error.message}`);
  }
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
  const artifactContent = await readFile(artifact);
  if (artifactContent.length !== artifactDetails.size) {
    throw new Error(`${target.name} signed artifact changed during validation.`);
  }
  requireArtifactStructure(artifactContent, target.name);
  const artifactSha256 = createHash("sha256")
    .update(artifactContent)
    .digest("hex");
  const evidenceFile = requireOption(options, target.evidenceOption);
  await requireFile(evidenceFile, `${target.name} acceptance evidence`);
  const evidenceContent = await readFile(evidenceFile);
  const evidenceSha256 = createHash("sha256")
    .update(evidenceContent)
    .digest("hex");
  let evidence;
  try {
    evidence = JSON.parse(evidenceContent.toString("utf8"));
  } catch (error) {
    throw new Error(`Could not read ${target.name} acceptance evidence JSON ${evidenceFile}: ${error.message}`);
  }
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
    {
      commit,
      artifact: {
        filename: path.basename(artifact),
        size: artifactDetails.size,
        sha256: artifactSha256,
      },
    },
  );
  const inventoryFile = path.join(input, "DEPENDENCY-INVENTORY.json");
  const noticesFile = path.join(input, "THIRD-PARTY-NOTICES.md");
  const releaseNotesFile = path.join(input, "RELEASE-NOTES.md");

  return {
    target: target.name,
    input,
    metadata,
    metadataFile,
    metadataSha256,
    inventoryFile,
    inventorySha256: stagingChecksums.get("DEPENDENCY-INVENTORY.json"),
    noticesFile,
    noticesSha256: stagingChecksums.get("THIRD-PARTY-NOTICES.md"),
    releaseNotesFile,
    releaseNotesSha256: stagingChecksums.get("RELEASE-NOTES.md"),
    artifact,
    artifactSha256,
    evidenceFile,
    evidenceSha256,
    evidenceFiles,
  };
}

async function snapshotFile(source, destination, expectedSha256, description) {
  const content = await readFile(source);
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${description} changed after validation.`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
  if ((await sha256(destination)) !== expectedSha256) {
    throw new Error(`${description} snapshot checksum mismatch.`);
  }
}

async function snapshotCandidate(candidate, root) {
  const input = path.join(root, "inputs", candidate.target);
  const artifact = path.join(
    root,
    "artifacts",
    candidate.target,
    path.basename(candidate.artifact),
  );
  const evidenceFile = path.join(
    root,
    "acceptance-evidence",
    candidate.target,
    "acceptance-evidence.json",
  );
  const metadataFile = path.join(input, "RELEASE-METADATA.json");
  const inventoryFile = path.join(input, "DEPENDENCY-INVENTORY.json");
  const noticesFile = path.join(input, "THIRD-PARTY-NOTICES.md");
  const releaseNotesFile = path.join(input, "RELEASE-NOTES.md");
  await Promise.all([
    snapshotFile(candidate.metadataFile, metadataFile, candidate.metadataSha256, `${candidate.target} release metadata`),
    snapshotFile(candidate.inventoryFile, inventoryFile, candidate.inventorySha256, `${candidate.target} dependency inventory`),
    snapshotFile(candidate.noticesFile, noticesFile, candidate.noticesSha256, `${candidate.target} third-party notices`),
    snapshotFile(candidate.releaseNotesFile, releaseNotesFile, candidate.releaseNotesSha256, `${candidate.target} release notes`),
    snapshotFile(candidate.artifact, artifact, candidate.artifactSha256, `${candidate.target} signed artifact`),
    snapshotFile(candidate.evidenceFile, evidenceFile, candidate.evidenceSha256, `${candidate.target} acceptance evidence`),
  ]);
  const evidenceFiles = [];
  for (const evidence of candidate.evidenceFiles) {
    const file = path.join(
      root,
      "acceptance-evidence",
      candidate.target,
      evidence.filename,
    );
    await snapshotFile(
      evidence.file,
      file,
      evidence.sha256,
      `${candidate.target} typed evidence ${evidence.filename}`,
    );
    evidenceFiles.push({ ...evidence, file });
  }
  return {
    ...candidate,
    input,
    metadataFile,
    inventoryFile,
    noticesFile,
    releaseNotesFile,
    artifact,
    evidenceFile,
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
  const snapshots = await mkdtemp(
    path.join(os.tmpdir(), "karakeep-finalizer-inputs-"),
  );
  try {
    const candidates = [];
    for (const target of targets) {
      const candidate = await validateTarget(options, target, commit);
      candidates.push(await snapshotCandidate(candidate, snapshots));
    }
    const [macos, windows] = candidates;
    if (!isDeepStrictEqual(macos.metadata.product, windows.metadata.product)) {
      throw new Error("Staged release product or version does not match across targets.");
    }
    if (macos.metadata.sourceDateEpoch !== windows.metadata.sourceDateEpoch) {
      throw new Error("Staged release source date epoch does not match across targets.");
    }
    const macosNotes = await readFile(macos.releaseNotesFile);
    const windowsNotes = await readFile(windows.releaseNotesFile);
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
  } finally {
    await rm(snapshots, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await finalize(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { assemble, snapshotCandidate, targets, validateTarget };
