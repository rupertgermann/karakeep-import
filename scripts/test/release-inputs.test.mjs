import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prepare-release-inputs.mjs",
);
const rustInventoryScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "generate-rust-dependency-inventory.mjs",
);
const releaseNotes = `# Karakeep Transfer 0.1.0

## Status

Karakeep Transfer is an unofficial community application. It is not affiliated
with Karakeep, X, or Field Theory.

## Platform support

- macOS 12 Monterey or newer on Apple Silicon and Intel
- Windows 10 version 1803 or newer and Windows 11 on x86-64

## Browser support

Browser-cookie acquisition supports:

- Google Chrome
- Microsoft Edge
- Brave
- Chromium
- Firefox

## X compatibility

Bookmark acquisition from X is best-effort because it relies on private X
interfaces through Field Theory. Changes by X can temporarily interrupt new
acquisitions. Previously retained snapshots remain available when new
acquisition is unavailable.

## Upgrading

Updates are manual. Quit Karakeep Transfer, download the new installer from the
GitHub Releases page, compare its SHA-256 checksum with the value published for
that release, and run the installer.
`;

function commandVersion(command, args, prefix = "") {
  return spawnSync(command, args, { encoding: "utf8" })
    .stdout.trim()
    .replace(prefix, "")
    .split(/\s+/)[0];
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function sha3_256(file) {
  return createHash("sha3-256").update(await readFile(file)).digest("hex");
}

async function createRuntimeArchive(cache, version, target, executableContent) {
  const archiveRoot = path.join(cache, "sources");
  const extractedRoot = path.join(archiveRoot, `node-v${version}-${target}`);
  const executable =
    target === "win-x64" ? "node.exe" : path.join("bin", "node");
  const executablePath = path.join(extractedRoot, executable);
  const file =
    target === "win-x64"
      ? `node-v${version}-${target}.zip`
      : `node-v${version}-${target}.tar.xz`;
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(executablePath, executableContent);
  await writeFile(path.join(extractedRoot, "LICENSE"), "Node MIT\n");
  const result = spawnSync(
    "tar",
    ["-cf", path.join(cache, file), path.basename(extractedRoot)],
    { cwd: archiveRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return {
    file,
    sha256: await sha256(path.join(cache, file)),
    executableSha256: await sha256(executablePath),
  };
}

async function createSqliteArchive(cache, executableContent) {
  const archiveRoot = path.join(cache, "sqlite-source");
  const executable = path.join(archiveRoot, "sqlite3.exe");
  const file = "sqlite-tools-win-x64-3530400.zip";
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(executable, executableContent);
  await writeFile(path.join(archiveRoot, "sqldiff.exe"), "must not ship\n");
  const result = spawnSync(
    "tar",
    ["-cf", path.join(cache, file), "sqlite3.exe", "sqldiff.exe"],
    { cwd: archiveRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return {
    file,
    sha256: await sha256(path.join(cache, file)),
    sha3_256: await sha3_256(path.join(cache, file)),
    executableSha256: await sha256(executable),
  };
}

async function createRepositoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-inputs-test-"));
  const nodeArchiveCache = path.join(root, "node-archive-cache");
  await mkdir(nodeArchiveCache, { recursive: true });
  const nodeVersion = "22.20.0";
  const runtimeContents = {
    "darwin-arm64": "arm64 node\n",
    "darwin-x64": "x64 node\n",
    "win-x64": "windows node\n",
  };
  const sqliteContent = "official sqlite3 executable\n";
  const nodeArtifacts = {};
  for (const [target, content] of Object.entries(runtimeContents)) {
    nodeArtifacts[target] = await createRuntimeArchive(
      nodeArchiveCache,
      nodeVersion,
      target,
      content,
    );
  }
  const sqliteArtifact = await createSqliteArchive(
    nodeArchiveCache,
    sqliteContent,
  );
  const vendoredPackage = path.join(
    root,
    "vendor",
    "fieldtheory",
    "fieldtheory-1.3.22.tgz",
  );
  await mkdir(path.dirname(vendoredPackage), { recursive: true });
  await writeFile(vendoredPackage, "pinned field theory package\n");

  const manifest = {
    schemaVersion: 1,
    fieldTheory: {
      repository: "https://github.com/afar1/fieldtheory-cli",
      version: "1.3.22",
      commit: "4b4a0f677e7077ac76848408b22091fc34330391",
      sourceUrl:
        "https://github.com/afar1/fieldtheory-cli/archive/4b4a0f677e7077ac76848408b22091fc34330391.tar.gz",
      sourceSha256:
        "1ebb91f6f20bd23f6a18a6222d3a207f044ae8437be55fe86146732f0b4c2f87",
      packageFile: "vendor/fieldtheory/fieldtheory-1.3.22.tgz",
      packageSha256: await sha256(vendoredPackage),
      license: "MIT",
    },
    node: {
      version: nodeVersion,
      license: "MIT",
      artifacts: nodeArtifacts,
    },
    sqlite: {
      version: "3.53.4",
      license: "Public-Domain",
      sourceUrl:
        "https://www.sqlite.org/2026/sqlite-tools-win-x64-3530400.zip",
      artifacts: {
        "win-x64": sqliteArtifact,
      },
    },
  };

  await writeJson(path.join(root, "vendor", "fieldtheory", "manifest.json"), manifest);
  await writeFile(path.join(root, "vendor", "fieldtheory", "LICENSE"), "MIT\n");
  await writeFile(
    path.join(root, "vendor", "fieldtheory", "THIRD_PARTY_NOTICES.md"),
    "# Field Theory notices\n",
  );
  await writeJson(path.join(root, "package.json"), {
    name: "karakeep-transfer",
    version: "0.1.0",
    dependencies: { react: "19.2.8" },
  });
  await writeJson(path.join(root, "package-lock.json"), {
    name: "karakeep-transfer",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "karakeep-transfer",
        version: "0.1.0",
        dependencies: { react: "19.2.8" },
      },
      "node_modules/react": {
        version: "19.2.8",
        resolved: "https://registry.npmjs.org/react/-/react-19.2.8.tgz",
        integrity: "sha512-react-integrity",
        license: "MIT",
      },
    },
  });
  await mkdir(path.join(root, "src-tauri"), { recursive: true });
  await writeFile(
    path.join(root, "src-tauri", "Cargo.toml"),
    '[package]\nname = "karakeep-transfer"\nversion = "0.1.0"\nlicense = "MIT"\n',
  );
  await writeFile(
    path.join(root, "src-tauri", "Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.229"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "serde-checksum"\n',
  );
  await writeJson(path.join(root, "src-tauri", "tauri.conf.json"), {
    productName: "Karakeep Transfer",
    version: "0.1.0",
    identifier: "io.github.rupertgermann.karakeeptransfer",
  });
  await writeJson(path.join(root, "release", "release-inputs.json"), {
    schemaVersion: 1,
    product: {
      name: "Karakeep Transfer",
      identifier: "io.github.rupertgermann.karakeeptransfer",
      version: "0.1.0",
    },
    buildToolchains: {
      node: process.versions.node,
      npm: commandVersion(process.platform === "win32" ? "npm.cmd" : "npm", [
        "--version",
      ]),
      rust: commandVersion("rustc", ["--version"], "rustc "),
    },
    targets: {
      "macos-universal": {
        rustTarget: "universal-apple-darwin",
        bundleFormat: "dmg",
        nodeRuntimes: ["darwin-arm64", "darwin-x64"],
      },
      "windows-x64": {
        rustTarget: "x86_64-pc-windows-msvc",
        bundleFormat: "nsis",
        nodeRuntimes: ["win-x64"],
      },
    },
  });
  await writeFile(path.join(root, "release", "release-notes.md"), releaseNotes);
  await writeJson(path.join(root, "cargo-metadata.json"), {
    packages: [
      {
        name: "karakeep-transfer",
        version: "0.1.0",
        license: "MIT",
        source: null,
      },
      {
        name: "serde",
        version: "1.0.229",
        license: "MIT OR Apache-2.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
    ],
  });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<!doctype html>\n");

  const resources = path.join(root, "src-tauri", "resources");
  await mkdir(path.join(resources, "node", "darwin-arm64"), { recursive: true });
  await mkdir(path.join(resources, "node", "darwin-x64"), { recursive: true });
  await mkdir(path.join(resources, "node", "win-x64"), { recursive: true });
  await writeFile(
    path.join(resources, "node", "darwin-arm64", "node"),
    runtimeContents["darwin-arm64"],
  );
  await writeFile(
    path.join(resources, "node", "darwin-x64", "node"),
    runtimeContents["darwin-x64"],
  );
  await writeFile(
    path.join(resources, "node", "win-x64", "node.exe"),
    runtimeContents["win-x64"],
  );
  await chmod(path.join(resources, "node", "darwin-arm64", "node"), 0o755);
  await chmod(path.join(resources, "node", "darwin-x64", "node"), 0o755);
  await writeFile(path.join(resources, "node", "LICENSE"), "Node MIT\n");
  await mkdir(path.join(resources, "sqlite", "win-x64"), { recursive: true });
  await writeFile(
    path.join(resources, "sqlite", "win-x64", "sqlite3.exe"),
    sqliteContent,
  );
  await mkdir(path.join(resources, "fieldtheory", "bridge", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(resources, "fieldtheory", "bridge", "src", "index.mjs"),
    'process.stdout.write("ready\\n");\n',
  );
  await writeFile(
    path.join(
      resources,
      "fieldtheory",
      "bridge",
      "src",
      "runtime-environment.mjs",
    ),
    "export const runtimeEnvironment = (environment) => environment;\n",
  );
  await writeJson(path.join(resources, "fieldtheory", "bridge", "package.json"), {
    name: "karakeep-fieldtheory-bridge",
    version: "1.0.0",
  });
  const bridgeLock = {
    name: "karakeep-fieldtheory-bridge",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {},
  };
  await writeJson(
    path.join(resources, "fieldtheory", "bridge", "package-lock.json"),
    bridgeLock,
  );
  await writeJson(
    path.join(root, "fieldtheory-bridge", "package-lock.json"),
    bridgeLock,
  );
  await writeJson(
    path.join(
      resources,
      "fieldtheory",
      "bridge",
      "node_modules",
      "fieldtheory",
      "package.json",
    ),
    { name: "fieldtheory", version: "1.3.22", license: "MIT" },
  );
  await cp(
    path.join(root, "vendor", "fieldtheory"),
    path.join(resources, "fieldtheory", "vendor", "fieldtheory"),
    { recursive: true },
  );
  await writeJson(path.join(resources, "fieldtheory-manifest.json"), manifest);
  await writeFile(
    path.join(resources, "THIRD_PARTY_NOTICES.md"),
    "# Field Theory notices\n",
  );
  return root;
}

function run(root, target, output) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--root",
      root,
      "--target",
      target,
      "--output",
      output,
      "--cargo-metadata",
      path.join(root, "cargo-metadata.json"),
      "--commit",
      "0123456789abcdef0123456789abcdef01234567",
      "--source-date-epoch",
      "1750000000",
      "--node-archive-cache",
      path.join(root, "node-archive-cache"),
    ],
    { encoding: "utf8" },
  );
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relative);
      } else {
        hash.update(relative);
        hash.update("\0");
        hash.update(await readFile(path.join(directory, entry.name)));
        hash.update("\0");
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

test("same pinned macOS inputs produce byte-identical release metadata", async () => {
  const root = await createRepositoryFixture();
  const first = path.join(root, "out-first");
  const second = path.join(root, "out-second");

  const firstRun = run(root, "macos-universal", first);
  const secondRun = run(root, "macos-universal", second);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.equal(secondRun.status, 0, secondRun.stderr);

  assert.deepEqual(
    {
      firstStatus: firstRun.status,
      secondStatus: secondRun.status,
      firstDigest: await treeDigest(first),
      secondDigest: await treeDigest(second),
    },
    {
      firstStatus: 0,
      secondStatus: 0,
      firstDigest: await treeDigest(first),
      secondDigest: await treeDigest(first),
    },
  );
});

test("release notes are staged, checksummed, and bound to release metadata", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "out");
  const source = path.join(root, "release", "release-notes.md");

  const result = run(root, "macos-universal", output);
  assert.equal(result.status, 0, result.stderr);

  const staged = path.join(output, "RELEASE-NOTES.md");
  assert.equal(await readFile(staged, "utf8"), releaseNotes);

  const metadata = JSON.parse(
    await readFile(path.join(output, "RELEASE-METADATA.json"), "utf8"),
  );
  assert.deepEqual(
    metadata.inputs.find(({ path: inputPath }) =>
      inputPath === "release/release-notes.md"
    ),
    {
      path: "release/release-notes.md",
      sha256: await sha256(source),
    },
  );

  assert.match(
    await readFile(path.join(output, "SHA256SUMS"), "utf8"),
    new RegExp(`^${await sha256(staged)}  RELEASE-NOTES\\.md$`, "m"),
  );
});

test("release notes must name the exact configured product and version", async () => {
  const root = await createRepositoryFixture();
  const notes = path.join(root, "release", "release-notes.md");
  await writeFile(notes, releaseNotes.replace("0.1.0", "0.2.0"));

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(
    result.stderr,
    /Release notes heading must be exactly: # Karakeep Transfer 0\.1\.0/,
  );
});

test("release notes reject a missing required disclosure", async () => {
  for (const [disclosure, omitted] of [
    ["unofficial status", "unofficial"],
    ["macOS support", "macOS"],
    ["Windows support", "Windows"],
    ["Google Chrome support", "Google Chrome"],
    ["Microsoft Edge support", "Microsoft Edge"],
    ["Brave support", "Brave"],
    ["Chromium support", "Chromium"],
    ["Firefox support", "Firefox"],
    ["best-effort X compatibility", "best-effort"],
    ["manual upgrade instructions", "Updates are manual."],
  ]) {
    const root = await createRepositoryFixture();
    const notes = path.join(root, "release", "release-notes.md");
    await writeFile(notes, releaseNotes.replaceAll(omitted, ""));

    const result = run(root, "macos-universal", path.join(root, "out"));

    assert.match(
      result.stderr,
      new RegExp(`Release notes are missing required disclosure: ${disclosure}`),
      disclosure,
    );
  }
});

test("release note disclosures must be affirmative, sectioned, and actionable", async () => {
  for (const [disclosure, invalidNotes] of [
    [
      "Windows support",
      releaseNotes.replace(
        "- Windows 10 version 1803 or newer and Windows 11 on x86-64",
        "- Windows is unsupported",
      ),
    ],
    [
      "Firefox support",
      releaseNotes.replace("- Firefox", "- Firefox is unsupported"),
    ],
    [
      "best-effort X compatibility",
      releaseNotes
        .replace("Bookmark acquisition from X is best-effort", "X may change")
        .replace("Updates are manual.", "Updates are manual and best-effort."),
    ],
    [
      "manual upgrade instructions",
      releaseNotes.replace(
        "download the new installer from the\nGitHub Releases page, ",
        "",
      ),
    ],
  ]) {
    const root = await createRepositoryFixture();
    await writeFile(
      path.join(root, "release", "release-notes.md"),
      invalidNotes,
    );

    const result = run(root, "macos-universal", path.join(root, "out"));

    assert.match(
      result.stderr,
      new RegExp(`Release notes are missing required disclosure: ${disclosure}`),
      disclosure,
    );
  }
});

test("secret-like values in release notes are rejected before staging", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "out");
  await writeFile(
    path.join(root, "release", "release-notes.md"),
    `${releaseNotes}\nAuthorization: Bearer live-secret-that-must-not-ship\n`,
  );

  const result = run(root, "macos-universal", output);

  assert.match(result.stderr, /Forbidden secret-like value/);
  await assert.rejects(
    readFile(path.join(output, "RELEASE-NOTES.md")),
    { code: "ENOENT" },
  );
});

test("Windows staging contains only the declared Windows runtime", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "out");

  const result = run(root, "windows-x64", output);
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(
    await readdir(path.join(output, "resources", "node")),
    ["LICENSE", "win-x64"],
    result.stderr,
  );
  assert.deepEqual(
    await readdir(path.join(output, "resources", "sqlite", "win-x64")),
    ["sqlite3.exe"],
    result.stderr,
  );
});

test("macOS staging does not contain the Windows-only SQLite runtime", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "out");

  const result = run(root, "macos-universal", output);
  assert.equal(result.status, 0, result.stderr);

  await assert.rejects(
    readFile(path.join(output, "resources", "sqlite", "win-x64", "sqlite3.exe")),
    { code: "ENOENT" },
  );
});

for (const [target, expected] of [
  [
    "macos-universal",
    "npm run tauri -- build --target universal-apple-darwin --bundles dmg\n",
  ],
  [
    "windows-x64",
    "npm run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis\n",
  ],
]) {
  test(`${target} staging produces its exact local native build command`, async () => {
    const root = await createRepositoryFixture();
    const output = path.join(root, "out");

    const result = run(root, target, output);
    assert.equal(result.status, 0, result.stderr);

    assert.equal(
      await readFile(path.join(output, "NATIVE-BUILD-COMMAND.txt"), "utf8"),
      expected,
    );
  });
}

test("missing a required pinned runtime fails before staging", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(root, "src-tauri", "resources", "node", "darwin-x64", "node"),
    "",
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Required runtime resource is empty: .*darwin-x64.*node/);
});

test("runtime download code in packaged bridge sources is rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "src",
      "download.mjs",
    ),
    'await fetch("https://nodejs.org/dist/v99/node.tar.xz");\n',
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Undeclared runtime download code/);
});

test("prepared Field Theory CLI shims are rejected from packaged resources", async () => {
  const root = await createRepositoryFixture();
  await mkdir(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "node_modules",
      ".bin",
    ),
    { recursive: true },
  );
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "node_modules",
      ".bin",
      "fieldtheory",
    ),
    "../fieldtheory/bin/ft.mjs\n",
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Packaged Field Theory CLI shims are forbidden/);
});

test("a modified prepared Field Theory package is rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "vendor",
      "fieldtheory",
      "fieldtheory-1.3.22.tgz",
    ),
    "modified after verification\n",
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Prepared Field Theory package checksum mismatch/);
});

test("a prepared Node executable modified after extraction is rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(root, "src-tauri", "resources", "node", "darwin-arm64", "node"),
    "modified after extraction\n",
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Prepared Node runtime darwin-arm64 does not match/);
});

test("a Node executable without an independent manifest pin is rejected", async () => {
  const root = await createRepositoryFixture();
  const manifestFile = path.join(root, "vendor", "fieldtheory", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.node.artifacts["darwin-arm64"].executableSha256;
  await writeJson(manifestFile, manifest);
  await writeJson(
    path.join(root, "src-tauri", "resources", "fieldtheory-manifest.json"),
    manifest,
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(
    result.stderr,
    /Node runtime darwin-arm64 executable is not pinned with SHA-256/,
  );
});

test("a repinned Node archive cannot replace the independent executable pin", async () => {
  const root = await createRepositoryFixture();
  const manifestFile = path.join(root, "vendor", "fieldtheory", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const replacement = await createRuntimeArchive(
    path.join(root, "node-archive-cache"),
    manifest.node.version,
    "darwin-arm64",
    "different archive executable\n",
  );
  manifest.node.artifacts["darwin-arm64"].sha256 = replacement.sha256;
  await writeJson(manifestFile, manifest);
  await writeJson(
    path.join(root, "src-tauri", "resources", "fieldtheory-manifest.json"),
    manifest,
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(
    result.stderr,
    /Pinned Node runtime darwin-arm64 archive does not contain its executable pin/,
  );
});

test("a prepared SQLite executable modified after extraction is rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "sqlite",
      "win-x64",
      "sqlite3.exe",
    ),
    "modified after extraction\n",
  );

  const result = run(root, "windows-x64", path.join(root, "out"));

  assert.match(
    result.stderr,
    /Prepared SQLite runtime win-x64 does not match its executable pin/,
  );
});

test("password-equivalent values in packaged text are rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "src",
      "leak.mjs",
    ),
    'const KARAKEEP_API_KEY = "secret-value-that-must-not-ship";\n',
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Forbidden secret-like value/);
});

test("password-equivalent values in packaged node_modules are rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "node_modules",
      "fieldtheory",
      "leak.mjs",
    ),
    'const X_AUTH_TOKEN = "live-secret-value-that-must-not-ship";\n',
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Forbidden secret-like value/);
});

test("password-equivalent values in NUL-containing packaged resources are rejected", async () => {
  const root = await createRepositoryFixture();
  const secret = Buffer.from(
    'KARAKEEP_API_KEY = "live-secret-value-that-must-not-ship"',
    "utf16le",
  );
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "node_modules",
      "fieldtheory",
      "leak.bin",
    ),
    secret,
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Forbidden secret-like value/);
});

test("X cookie-header values in packaged resources are rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "node_modules",
      "fieldtheory",
      "cookie-canary.js",
    ),
    'const cookie = "auth_token=live-auth-cookie-value; ct0=live-csrf-cookie-value";\n',
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Forbidden secret-like value/);
  await assert.rejects(
    readFile(
      path.join(
        root,
        "out",
        "resources",
        "fieldtheory",
        "bridge",
        "node_modules",
        "fieldtheory",
        "cookie-canary.js",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("dynamic X cookie-header construction in packaged source is allowed", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "node_modules",
      "fieldtheory",
      "cookie-builder.js",
    ),
    "const cookie = `ct0=${cleanCt0}; auth_token=${sanitizeCookieValue('auth_token', authToken)}`;\n",
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.equal(result.status, 0, result.stderr);
});

test("password-equivalent values in unstaged Tauri resources are rejected", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "node",
      "win-x64",
      "stale-secret.txt",
    ),
    'const KARAKEEP_API_KEY = "stale-secret-value-that-must-not-ship";\n',
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Forbidden secret-like value/);
});

test("placeholder credentials in packaged dependency documentation are allowed", async () => {
  const root = await createRepositoryFixture();
  await writeFile(
    path.join(
      root,
      "src-tauri",
      "resources",
      "fieldtheory",
      "bridge",
      "node_modules",
      "fieldtheory",
      "README.md",
    ),
    'KARAKEEP_API_KEY = "replace-me"\nAuthorization: Bearer example-token\n',
  );

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.equal(result.status, 0, result.stderr);
});

test("generated inventory records versions, integrity, and licenses", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "out");

  const result = run(root, "macos-universal", output);
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(
    await readFile(path.join(output, "DEPENDENCY-INVENTORY.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, "vendor", "fieldtheory", "manifest.json"), "utf8"),
  );

  assert.deepEqual(
    inventory.components.map(
      ({ ecosystem, name, version, integrity, license }) => ({
        ecosystem,
        name,
        version,
        integrity,
        license,
      }),
    ),
    [
      {
        ecosystem: "bundled",
        name: "fieldtheory-cli",
        version: "1.3.22",
        integrity:
          "sha256-ba655ddaf8b819666ccac0a530d3757d579ed193ea6bd0e5c82d39f8993c5e58",
        license: "MIT",
      },
      {
        ecosystem: "bundled",
        name: "node",
        version: "22.20.0",
        integrity: [
          manifest.node.artifacts["darwin-arm64"].sha256,
          manifest.node.artifacts["darwin-x64"].sha256,
        ]
          .map((checksum) => `sha256-${checksum}`)
          .join(","),
        license: "MIT",
      },
      {
        ecosystem: "javascript",
        name: "react",
        version: "19.2.8",
        integrity: "sha512-react-integrity",
        license: "MIT",
      },
      {
        ecosystem: "rust",
        name: "serde",
        version: "1.0.229",
        integrity: "sha256-serde-checksum",
        license: "MIT OR Apache-2.0",
      },
    ],
    result.stderr,
  );
});

test("Windows inventory records the independently pinned SQLite executable", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "out");

  const result = run(root, "windows-x64", output);
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(
    await readFile(path.join(output, "DEPENDENCY-INVENTORY.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, "vendor", "fieldtheory", "manifest.json"), "utf8"),
  );

  assert.deepEqual(
    inventory.components.find(
      ({ ecosystem, name }) =>
        ecosystem === "bundled" && name === "sqlite3",
    ),
    {
      ecosystem: "bundled",
      name: "sqlite3",
      version: "3.53.4",
      integrity: `sha256-${manifest.sqlite.artifacts["win-x64"].executableSha256}`,
      license: "Public-Domain",
    },
  );
});

test("a drifting local build toolchain is rejected", async () => {
  const root = await createRepositoryFixture();
  const configFile = path.join(root, "release", "release-inputs.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.buildToolchains.node = "0.0.0";
  await writeJson(configFile, config);

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(
    result.stderr,
    /Build toolchain mismatch for node: expected 0\.0\.0, found \d+\.\d+\.\d+\./,
  );
});

test("Rust dependency inventory generation is deterministic and excludes app code", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "generated-rust-dependencies.json");

  const result = spawnSync(
    process.execPath,
    [
      rustInventoryScript,
      "--root",
      root,
      "--metadata",
      path.join(root, "cargo-metadata.json"),
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );

  assert.deepEqual(
    {
      status: result.status,
      inventory: JSON.parse(await readFile(output, "utf8")),
    },
    {
      status: 0,
      inventory: {
        schemaVersion: 1,
        packages: [
          {
            name: "serde",
            version: "1.0.229",
            license: "MIT OR Apache-2.0",
            source: "registry+https://github.com/rust-lang/crates.io-index",
          },
        ],
      },
    },
    result.stderr,
  );
});

test("release metadata refuses a dirty Git checkout", async () => {
  const root = await createRepositoryFixture();
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "release-test@example.invalid"],
    ["config", "user.name", "Release Test"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ]) {
    const git = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  await writeFile(path.join(root, "dist", "index.html"), "dirty build\n");

  const result = run(root, "macos-universal", path.join(root, "out"));

  assert.match(result.stderr, /Release checkout must be clean/);
});
