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
  },
  {
    name: "windows-x64",
    inputOption: "windows-input",
    artifactOption: "windows-artifact",
    evidenceOption: "windows-evidence",
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
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
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

function validateEvidence(evidence, expected) {
  rejectUnsupportedProperties(
    evidence,
    ["schemaVersion", "target", "commit", "product", "artifact", "gates"],
    `${expected.target} evidence root`,
  );
  if (evidence.schemaVersion !== 1) {
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
  rejectUnsupportedProperties(
    evidence.artifact,
    ["sha256"],
    `${expected.target} evidence artifact`,
  );
  if (evidence.artifact?.sha256 !== expected.artifactSha256) {
    throw new Error(`${expected.target} evidence artifact SHA-256 does not match.`);
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
    if (evidence.gates[gate] !== "PASS") {
      throw new Error(`${expected.target} evidence gate is not PASS: ${gate}`);
    }
  }
}

async function validateTarget(options, target, commit) {
  const input = requireOption(options, target.inputOption);
  await verifyStagingChecksums(input, target.name);
  const metadata = await readJson(
    path.join(input, "RELEASE-METADATA.json"),
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
  validateProduct(metadata.product);

  const artifact = requireOption(options, target.artifactOption);
  await requireFile(artifact, `${target.name} signed artifact`);
  const artifactSha256 = await sha256(artifact);
  const evidenceFile = requireOption(options, target.evidenceOption);
  await requireFile(evidenceFile, `${target.name} acceptance evidence`);
  const evidence = await readJson(
    evidenceFile,
    `${target.name} acceptance evidence`,
  );
  validateEvidence(evidence, {
    target: target.name,
    commit,
    product: metadata.product,
    artifactSha256,
  });

  return {
    target: target.name,
    input,
    metadata,
    artifact,
    artifactSha256,
    evidenceFile,
    evidenceSha256: await sha256(evidenceFile),
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
      const evidencePath = path.posix.join(
        "acceptance-evidence",
        `${candidate.target}.json`,
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
      for (const relative of [
        artifactPath,
        evidencePath,
        inventoryPath,
        noticesPath,
      ]) {
        await mkdir(path.dirname(path.join(staging, relative)), {
          recursive: true,
        });
      }
      await cp(candidate.artifact, path.join(staging, artifactPath));
      await cp(candidate.evidenceFile, path.join(staging, evidencePath));
      await cp(
        path.join(candidate.input, "DEPENDENCY-INVENTORY.json"),
        path.join(staging, inventoryPath),
      );
      await cp(
        path.join(candidate.input, "THIRD-PARTY-NOTICES.md"),
        path.join(staging, noticesPath),
      );
      finalTargets[candidate.target] = {
        artifact: {
          path: artifactPath,
          sha256: candidate.artifactSha256,
        },
        acceptanceEvidence: {
          path: evidencePath,
          sha256: candidate.evidenceSha256,
        },
        dependencyInventory: inventoryPath,
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
