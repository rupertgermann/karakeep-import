import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received ${key ?? "nothing"}.`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON ${file}: ${error.message}`);
  }
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function sha3_256(file) {
  return createHash("sha3-256").update(await readFile(file)).digest("hex");
}

function nativeBuildCommand(targetConfig) {
  for (const [name, value] of [
    ["Rust target", targetConfig.rustTarget],
    ["bundle format", targetConfig.bundleFormat],
  ]) {
    if (!/^[A-Za-z0-9._-]+$/.test(value ?? "")) {
      throw new Error(`${name} is missing or invalid.`);
    }
  }
  return `npm run tauri -- build --target ${targetConfig.rustTarget} --bundles ${targetConfig.bundleFormat}`;
}

function packageVersion(cargoToml) {
  const heading = cargoToml.match(/^\[package\]\s*$/m);
  if (!heading) {
    throw new Error("Cargo package section is missing.");
  }
  const remainder = cargoToml.slice(heading.index + heading[0].length);
  const nextSection = remainder.search(/^\[/m);
  const packageBlock =
    nextSection === -1 ? remainder : remainder.slice(0, nextSection);
  const version = packageBlock?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) {
    throw new Error("Cargo package version is missing.");
  }
  return version;
}

function cargoLockPackages(cargoLock) {
  return cargoLock
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => {
      const value = (name) =>
        block.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"\\s*$`, "m"))?.[1];
      return {
        name: value("name"),
        version: value("version"),
        source: value("source") ?? null,
        checksum: value("checksum") ?? null,
      };
    });
}

function javascriptComponents(packageLock, ecosystem = "javascript") {
  return Object.entries(packageLock.packages ?? {})
    .filter(([location, component]) => location && !component.link)
    .map(([location, component]) => {
      const name = location.replace(/^.*node_modules\//, "");
      if (!component.version || !component.integrity || !component.license) {
        throw new Error(
          `JavaScript dependency ${name} lacks version, integrity, or license metadata.`,
        );
      }
      return {
        ecosystem,
        name,
        version: component.version,
        integrity: component.integrity,
        license: component.license,
      };
    });
}

function rustComponents(cargoLock, rustInventory) {
  const lockedPackages = cargoLockPackages(cargoLock).filter(
    (component) => component.source,
  );
  const locked = new Map(
    lockedPackages.map((component) => [
      `${component.name}@${component.version}`,
      component,
    ]),
  );
  const inventoryPackages = (rustInventory.packages ?? []).filter(
    (component) => component.source,
  );
  const inventoried = new Set(
    inventoryPackages.map(
      (component) => `${component.name}@${component.version}`,
    ),
  );
  for (const component of lockedPackages) {
    const key = `${component.name}@${component.version}`;
    if (!inventoried.has(key)) {
      throw new Error(`Rust dependency inventory is missing locked package ${key}.`);
    }
  }
  return inventoryPackages
    .filter((component) => component.source)
    .map((component) => {
      const key = `${component.name}@${component.version}`;
      const lock = locked.get(key);
      if (!lock) {
        throw new Error(`Rust dependency inventory is not locked: ${key}.`);
      }
      if (component.source !== lock.source) {
        throw new Error(`Rust dependency source does not match the lock: ${key}.`);
      }
      if (!component.license) {
        throw new Error(`Rust dependency ${key} lacks license metadata.`);
      }
      const integrity = lock.checksum
        ? `sha256-${lock.checksum}`
        : lock.source?.startsWith("git+")
          ? lock.source
          : null;
      if (!integrity) {
        throw new Error(`Rust dependency ${key} lacks integrity metadata.`);
      }
      return {
        ecosystem: "rust",
        name: component.name,
        version: component.version,
        integrity,
        license: component.license,
      };
    });
}

function sortComponents(components) {
  return components.sort((left, right) =>
    `${left.ecosystem}\0${left.name}\0${left.version}`.localeCompare(
      `${right.ecosystem}\0${right.name}\0${right.version}`,
    ),
  );
}

function commandVersion(command, args, prefix = "") {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Required build tool is unavailable: ${command}.`);
  }
  return result.stdout.trim().replace(prefix, "").split(/\s+/)[0];
}

function validateBuildToolchains(expected) {
  const installed = {
    node: process.versions.node,
    npm: commandVersion(process.platform === "win32" ? "npm.cmd" : "npm", [
      "--version",
    ]),
    rust: commandVersion("rustc", ["--version"], "rustc "),
  };
  for (const name of ["node", "npm", "rust"]) {
    if (!expected?.[name]) {
      throw new Error(`Release build toolchain is not pinned: ${name}.`);
    }
    if (expected[name] !== installed[name]) {
      throw new Error(
        `Build toolchain mismatch for ${name}: expected ${expected[name]}, found ${installed[name]}.`,
      );
    }
  }
}

async function requireNonempty(file, description = "resource") {
  let details;
  try {
    details = await stat(file);
  } catch {
    throw new Error(`Required ${description} is missing: ${file}`);
  }
  if (!details.isFile() || details.size === 0) {
    throw new Error(`Required ${description} is empty: ${file}`);
  }
}

async function regularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile()) {
        files.push(file);
      } else {
        throw new Error(`Unsupported packaged resource: ${file}`);
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function validateBridgeSources(resources) {
  const sources = path.join(resources, "fieldtheory", "bridge", "src");
  for (const file of await regularFiles(sources)) {
    const content = await readFile(file, "utf8");
    if (
      /nodejs\.org\/dist\/|registry\.npmjs\.org\/|(?:npm|pnpm|yarn)\s+(?:ci|install)\b/i.test(
        content,
      )
    ) {
      throw new Error(
        `Undeclared runtime download code in packaged bridge source: ${file}`,
      );
    }
  }
}

async function validateNoBridgeCliShims(resources) {
  const shims = path.join(
    resources,
    "fieldtheory",
    "bridge",
    "node_modules",
    ".bin",
  );
  try {
    await stat(shims);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Packaged Field Theory CLI shims are forbidden: ${shims}`);
}

function isPlaceholderCredential(value) {
  return /^(?:<[^>]+>|\$\{[^}]+\}|(?:replace|example|sample|dummy|fake|test|canary|your|redacted|not-a-real)(?:[-_ ].*)?)$/i.test(
    value.trim(),
  );
}

async function validateNoSecrets(roots) {
  for (const root of roots) {
    for (const file of await regularFiles(root)) {
      const bytes = await readFile(file);
      const content = bytes.toString("utf8").replaceAll("\0", "");
      const assignments = content.matchAll(
        /\b(?:KARAKEEP_API_KEY|X_AUTH_TOKEN|TWITTER_AUTH_TOKEN|auth_token|ct0)\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi,
      );
      const bearers = content.matchAll(
        /\bBearer\s+([A-Za-z0-9._~+/-]{8,})/gi,
      );
      for (const match of [...assignments, ...bearers]) {
        if (!isPlaceholderCredential(match[1])) {
          throw new Error(
            `Forbidden secret-like value in packaged text: ${file}`,
          );
        }
      }
    }
  }
}

async function extractedArchiveMemberSha256(
  archiveCache,
  artifact,
  member,
  description,
) {
  const archive = path.join(archiveCache, artifact.file);
  await requireNonempty(archive, `pinned ${description} archive`);
  if ((await sha256(archive)) !== artifact.sha256) {
    throw new Error(`Pinned ${description} archive checksum mismatch.`);
  }
  if (
    artifact.sha3_256 &&
    (await sha3_256(archive)) !== artifact.sha3_256
  ) {
    throw new Error(`Pinned ${description} archive SHA3-256 mismatch.`);
  }

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "karakeep-release-runtime-"),
  );
  try {
    const result = spawnSync(
      process.platform === "win32" ? "tar.exe" : "tar",
      ["-xf", archive, "-C", temporary, member],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`Could not inspect pinned ${description} archive.`);
    }
    return await sha256(path.join(temporary, member));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validateNoReleaseWorkflows(root) {
  const workflowDirectory = path.join(root, ".github", "workflows");
  try {
    for (const file of await regularFiles(workflowDirectory)) {
      const content = await readFile(file, "utf8");
      if (
        /\btauri\s+build\b|\bcargo\s+build\b|\bnpm\s+run\s+build\b|\bcodesign\b|\bnotarytool\b|\bsigntool\b|upload-release-asset|action-gh-release/i.test(
          content,
        )
      ) {
        throw new Error(
          `Release build, signing, packaging, or publishing is forbidden in GitHub Actions: ${file}`,
        );
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function validateInputs(
  root,
  target,
  config,
  rustInventoryFile,
  nodeArchiveCache,
) {
  if (config.schemaVersion !== 1) {
    throw new Error("Unsupported release input schema.");
  }
  validateBuildToolchains(config.buildToolchains);
  const targetConfig = config.targets?.[target];
  if (!targetConfig) {
    throw new Error(`Unsupported release target: ${target}.`);
  }

  const packageJson = await readJson(path.join(root, "package.json"));
  const packageLock = await readJson(path.join(root, "package-lock.json"));
  const cargoToml = await readFile(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoLock = await readFile(path.join(root, "src-tauri", "Cargo.lock"), "utf8");
  const tauriConfig = await readJson(
    path.join(root, "src-tauri", "tauri.conf.json"),
  );
  const versions = [
    config.product?.version,
    packageJson.version,
    packageLock.version,
    packageVersion(cargoToml),
    tauriConfig.version,
  ];
  if (new Set(versions).size !== 1 || versions.some((version) => !version)) {
    throw new Error(`App versions do not match: ${versions.join(", ")}.`);
  }
  if (
    config.product.name !== tauriConfig.productName ||
    config.product.identifier !== tauriConfig.identifier
  ) {
    throw new Error("Release product identity does not match Tauri configuration.");
  }

  const vendorManifestFile = path.join(
    root,
    "vendor",
    "fieldtheory",
    "manifest.json",
  );
  const vendorManifest = await readJson(vendorManifestFile);
  if (vendorManifest.schemaVersion !== 1) {
    throw new Error("Unsupported Field Theory bundle schema.");
  }
  const vendoredPackage = path.resolve(
    root,
    vendorManifest.fieldTheory.packageFile,
  );
  await requireNonempty(vendoredPackage, "vendored Field Theory package");
  if ((await sha256(vendoredPackage)) !== vendorManifest.fieldTheory.packageSha256) {
    throw new Error("Vendored Field Theory package checksum mismatch.");
  }

  const resources = path.join(root, "src-tauri", "resources");
  const preparedManifestFile = path.join(resources, "fieldtheory-manifest.json");
  await requireNonempty(preparedManifestFile, "prepared Field Theory manifest");
  const preparedManifest = await readJson(preparedManifestFile);
  if (JSON.stringify(preparedManifest) !== JSON.stringify(vendorManifest)) {
    throw new Error("Prepared Field Theory manifest does not match the pinned manifest.");
  }
  for (const relative of [
    "THIRD_PARTY_NOTICES.md",
    "node/LICENSE",
    "fieldtheory/bridge/src/index.mjs",
    "fieldtheory/bridge/src/runtime-environment.mjs",
    "fieldtheory/bridge/package.json",
    "fieldtheory/bridge/package-lock.json",
    "fieldtheory/bridge/node_modules/fieldtheory/package.json",
    `fieldtheory/vendor/fieldtheory/${path.basename(
      vendorManifest.fieldTheory.packageFile,
    )}`,
    "fieldtheory/vendor/fieldtheory/LICENSE",
  ]) {
    await requireNonempty(path.join(resources, relative), "packaged resource");
  }
  const preparedVendoredPackage = path.join(
    resources,
    "fieldtheory",
    "vendor",
    "fieldtheory",
    path.basename(vendorManifest.fieldTheory.packageFile),
  );
  if (
    (await sha256(preparedVendoredPackage)) !==
    vendorManifest.fieldTheory.packageSha256
  ) {
    throw new Error("Prepared Field Theory package checksum mismatch.");
  }
  const preparedFieldTheoryPackage = await readJson(
    path.join(
      resources,
      "fieldtheory",
      "bridge",
      "node_modules",
      "fieldtheory",
      "package.json",
    ),
  );
  if (preparedFieldTheoryPackage.version !== vendorManifest.fieldTheory.version) {
    throw new Error("Prepared Field Theory dependency version is not pinned.");
  }
  const bridgeLockFile = path.join(root, "fieldtheory-bridge", "package-lock.json");
  const preparedBridgeLockFile = path.join(
    resources,
    "fieldtheory",
    "bridge",
    "package-lock.json",
  );
  await requireNonempty(bridgeLockFile, "Field Theory bridge lockfile");
  if ((await sha256(bridgeLockFile)) !== (await sha256(preparedBridgeLockFile))) {
    throw new Error("Prepared Field Theory bridge lockfile is not current.");
  }
  for (const runtime of targetConfig.nodeRuntimes) {
    const executable = runtime === "win-x64" ? "node.exe" : "node";
    const preparedExecutable = path.join(
      resources,
      "node",
      runtime,
      executable,
    );
    await requireNonempty(
      preparedExecutable,
      "runtime resource",
    );
    const artifact = vendorManifest.node.artifacts[runtime];
    if (!artifact?.file || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
      throw new Error(`Node runtime ${runtime} is not pinned with SHA-256.`);
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.executableSha256 ?? "")) {
      throw new Error(
        `Node runtime ${runtime} executable is not pinned with SHA-256.`,
      );
    }
    const extractedRoot = `node-v${vendorManifest.node.version}-${runtime}`;
    const executableMember = path.posix.join(
      extractedRoot,
      runtime === "win-x64" ? "node.exe" : path.posix.join("bin", "node"),
    );
    const archiveExecutableSha256 = await extractedArchiveMemberSha256(
      nodeArchiveCache,
      artifact,
      executableMember,
      `Node runtime ${runtime}`,
    );
    if (archiveExecutableSha256 !== artifact.executableSha256) {
      throw new Error(
        `Pinned Node runtime ${runtime} archive does not contain its executable pin.`,
      );
    }
    if (
      (await sha256(preparedExecutable)) !== artifact.executableSha256
    ) {
      throw new Error(
        `Prepared Node runtime ${runtime} does not match its executable pin.`,
      );
    }
  }
  const sqliteRuntimes = targetConfig.nodeRuntimes.includes("win-x64")
    ? ["win-x64"]
    : [];
  for (const runtime of sqliteRuntimes) {
    const artifact = vendorManifest.sqlite?.artifacts?.[runtime];
    if (
      !artifact?.file ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(artifact.sha3_256 ?? "")
    ) {
      throw new Error(
        `SQLite runtime ${runtime} archive is not pinned with SHA-256 and SHA3-256.`,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.executableSha256 ?? "")) {
      throw new Error(
        `SQLite runtime ${runtime} executable is not pinned with SHA-256.`,
      );
    }
    const archiveExecutableSha256 = await extractedArchiveMemberSha256(
      nodeArchiveCache,
      artifact,
      "sqlite3.exe",
      `SQLite runtime ${runtime}`,
    );
    if (archiveExecutableSha256 !== artifact.executableSha256) {
      throw new Error(
        `Pinned SQLite runtime ${runtime} archive does not contain its executable pin.`,
      );
    }
    const preparedExecutable = path.join(
      resources,
      "sqlite",
      runtime,
      "sqlite3.exe",
    );
    await requireNonempty(preparedExecutable, "SQLite runtime resource");
    if ((await sha256(preparedExecutable)) !== artifact.executableSha256) {
      throw new Error(
        `Prepared SQLite runtime ${runtime} does not match its executable pin.`,
      );
    }
  }
  await requireNonempty(path.join(root, "dist", "index.html"), "frontend build");
  await validateNoBridgeCliShims(resources);
  await validateBridgeSources(resources);
  await validateNoReleaseWorkflows(root);

  const rustInventory = await readJson(rustInventoryFile);
  const bridgeLock = await readJson(bridgeLockFile);
  const components = sortComponents([
    {
      ecosystem: "bundled",
      name: "fieldtheory-cli",
      version: vendorManifest.fieldTheory.version,
      integrity: `sha256-${vendorManifest.fieldTheory.packageSha256}`,
      license: vendorManifest.fieldTheory.license,
    },
    {
      ecosystem: "bundled",
      name: "node",
      version: vendorManifest.node.version,
      integrity: targetConfig.nodeRuntimes
        .map(
          (runtime) =>
            `sha256-${vendorManifest.node.artifacts[runtime].sha256}`,
        )
        .join(","),
      license: vendorManifest.node.license,
    },
    ...sqliteRuntimes.map((runtime) => ({
      ecosystem: "bundled",
      name: "sqlite3",
      version: vendorManifest.sqlite.version,
      integrity: `sha256-${vendorManifest.sqlite.artifacts[runtime].executableSha256}`,
      license: vendorManifest.sqlite.license,
    })),
    ...javascriptComponents(packageLock),
    ...javascriptComponents(bridgeLock, "fieldtheory-javascript"),
    ...rustComponents(cargoLock, rustInventory),
  ]);
  return {
    targetConfig,
    sqliteRuntimes,
    vendorManifestFile,
    bridgeLockFile,
    resources,
    components,
  };
}

async function copyInputs(
  root,
  output,
  resources,
  runtimeTargets,
  sqliteRuntimes,
) {
  await cp(path.join(root, "dist"), path.join(output, "frontend"), {
    recursive: true,
  });
  await cp(
    path.join(root, "src-tauri", "tauri.conf.json"),
    path.join(output, "tauri.conf.json"),
  );
  await cp(
    path.join(resources, "fieldtheory"),
    path.join(output, "resources", "fieldtheory"),
    { recursive: true, dereference: true },
  );
  await cp(
    path.join(resources, "fieldtheory-manifest.json"),
    path.join(output, "resources", "fieldtheory-manifest.json"),
  );
  await cp(
    path.join(resources, "THIRD_PARTY_NOTICES.md"),
    path.join(output, "resources", "FIELD-THEORY-NOTICES.md"),
  );
  await cp(
    path.join(resources, "node", "LICENSE"),
    path.join(output, "resources", "node", "LICENSE"),
  );
  for (const runtime of runtimeTargets) {
    await cp(
      path.join(resources, "node", runtime),
      path.join(output, "resources", "node", runtime),
      { recursive: true, dereference: true },
    );
  }
  for (const runtime of sqliteRuntimes) {
    await cp(
      path.join(resources, "sqlite", runtime, "sqlite3.exe"),
      path.join(output, "resources", "sqlite", runtime, "sqlite3.exe"),
    );
  }
}

function dependencyNotices(components, upstreamNotices) {
  const rows = components
    .map(
      (component) =>
        `| ${component.ecosystem} | ${component.name} | ${component.version} | ${component.license} | ${component.integrity} |`,
    )
    .join("\n");
  return `# Karakeep Transfer third-party notices

This file is generated from locked, offline release inputs.

| Ecosystem | Component | Version | License | Integrity |
| --- | --- | --- | --- | --- |
${rows}

## Bundled Field Theory notices

${upstreamNotices.trim()}
`;
}

async function inputChecksums(root, files) {
  const checksums = [];
  for (const file of files) {
    checksums.push({
      path: path.relative(root, file).split(path.sep).join("/"),
      sha256: await sha256(file),
    });
  }
  return checksums.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeChecksums(output) {
  const files = (await regularFiles(output)).filter(
    (file) => path.basename(file) !== "SHA256SUMS",
  );
  const lines = [];
  for (const file of files) {
    lines.push(
      `${await sha256(file)}  ${path.relative(output, file).split(path.sep).join("/")}`,
    );
  }
  await writeFile(path.join(output, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function normalizeOutput(output, epoch) {
  const timestamp = new Date(epoch * 1000);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(item);
      } else {
        const executable = /(?:^|\/)(?:node|sqlite3)(?:\.exe)?$/.test(
          item.split(path.sep).join("/"),
        );
        await chmod(item, executable ? 0o755 : 0o644);
        await utimes(item, timestamp, timestamp);
      }
    }
    await chmod(directory, 0o755);
    await utimes(directory, timestamp, timestamp);
  }
  await visit(output);
}

function safeOutput(root, output) {
  const resolved = path.resolve(output);
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Release output must be a dedicated directory inside the checkout.");
  }
  return resolved;
}

function gitState(root) {
  const status = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  if (status.status !== 0) {
    return null;
  }
  if (status.stdout.trim()) {
    throw new Error("Release checkout must be clean before metadata is generated.");
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const epoch = spawnSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (head.status !== 0 || epoch.status !== 0) {
    throw new Error("Could not resolve release commit metadata.");
  }
  return { commit: head.stdout.trim(), sourceDateEpoch: epoch.stdout.trim() };
}

async function prepare(options) {
  const root = path.resolve(options.root ?? scriptRoot);
  const configFile = path.join(root, "release", "release-inputs.json");
  const config = await readJson(configFile);
  const target = options.target;
  if (!target) {
    throw new Error("--target is required.");
  }
  const output = safeOutput(
    root,
    options.output ?? path.join(root, "release-inputs", target),
  );
  const repository = gitState(root);
  const commit = options.commit ?? repository?.commit;
  const sourceDateEpoch = Number(
    options["source-date-epoch"] ?? repository?.sourceDateEpoch,
  );
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Release commit must be a full Git SHA.");
  }
  if (repository && commit !== repository.commit) {
    throw new Error("Release commit must match the checkout HEAD.");
  }
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    throw new Error("Source date epoch must be a positive integer.");
  }
  const rustInventoryFile = path.resolve(
    options["cargo-metadata"] ??
      path.join(root, "release", "rust-dependencies.json"),
  );
  const nodeArchiveCache = path.resolve(
    options["node-archive-cache"] ??
      path.join(os.tmpdir(), "karakeep-transfer-runtime-cache"),
  );
  const validated = await validateInputs(
    root,
    target,
    config,
    rustInventoryFile,
    nodeArchiveCache,
  );

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  try {
    await validateNoSecrets([validated.resources]);
    await copyInputs(
      root,
      output,
      validated.resources,
      validated.targetConfig.nodeRuntimes,
      validated.sqliteRuntimes,
    );
    await validateNoSecrets([
      path.join(output, "resources"),
      path.join(output, "frontend"),
    ]);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  const buildCommand = nativeBuildCommand(validated.targetConfig);
  await writeFile(
    path.join(output, "NATIVE-BUILD-COMMAND.txt"),
    `${buildCommand}\n`,
  );

  const inventory = {
    schemaVersion: 1,
    components: validated.components,
  };
  await writeFile(
    path.join(output, "DEPENDENCY-INVENTORY.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  const upstreamNotices = await readFile(
    path.join(validated.resources, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  await writeFile(
    path.join(output, "THIRD-PARTY-NOTICES.md"),
    dependencyNotices(validated.components, upstreamNotices),
  );
  const metadata = {
    schemaVersion: 1,
    product: config.product,
    commit,
    sourceDateEpoch,
    target,
    rustTarget: validated.targetConfig.rustTarget,
    bundleFormat: validated.targetConfig.bundleFormat,
    nativeBuildCommand: buildCommand,
    nodeRuntimes: validated.targetConfig.nodeRuntimes,
    buildToolchains: config.buildToolchains,
    inputs: await inputChecksums(root, [
      path.join(root, "package.json"),
      path.join(root, "package-lock.json"),
      path.join(root, "fieldtheory-bridge", "package-lock.json"),
      path.join(root, "src-tauri", "Cargo.toml"),
      path.join(root, "src-tauri", "Cargo.lock"),
      path.join(root, "src-tauri", "tauri.conf.json"),
      configFile,
      validated.vendorManifestFile,
      rustInventoryFile,
    ]),
  };
  await writeFile(
    path.join(output, "RELEASE-METADATA.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await writeChecksums(output);
  await normalizeOutput(output, sourceDateEpoch);
  process.stdout.write(
    `Prepared ${config.product.name} ${config.product.version} ${target} inputs at ${output}\n`,
  );
}

try {
  await prepare(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
