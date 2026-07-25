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

async function createRepositoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-inputs-test-"));
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
      version: "22.20.0",
      license: "MIT",
      artifacts: {
        "darwin-arm64": {
          file: "node-v22.20.0-darwin-arm64.tar.xz",
          sha256:
            "f2ed1fbdfb79afb9343dfbb609efde657b41e7efcd5215264ce78f8906356b4d",
        },
        "darwin-x64": {
          file: "node-v22.20.0-darwin-x64.tar.xz",
          sha256:
            "2a291f0a9555f5d6685d96ce9429da3d0ea3cd896c012702c6ee0015f818684e",
        },
        "win-x64": {
          file: "node-v22.20.0-win-x64.zip",
          sha256:
            "bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d",
        },
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
  await writeFile(path.join(resources, "node", "darwin-arm64", "node"), "arm64 node\n");
  await writeFile(path.join(resources, "node", "darwin-x64", "node"), "x64 node\n");
  await writeFile(path.join(resources, "node", "win-x64", "node.exe"), "windows node\n");
  await chmod(path.join(resources, "node", "darwin-arm64", "node"), 0o755);
  await chmod(path.join(resources, "node", "darwin-x64", "node"), 0o755);
  await writeFile(path.join(resources, "node", "LICENSE"), "Node MIT\n");
  await mkdir(path.join(resources, "fieldtheory", "bridge", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(resources, "fieldtheory", "bridge", "src", "index.mjs"),
    'process.stdout.write("ready\\n");\n',
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
});

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

test("generated inventory records versions, integrity, and licenses", async () => {
  const root = await createRepositoryFixture();
  const output = path.join(root, "out");

  const result = run(root, "macos-universal", output);
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(
    await readFile(path.join(output, "DEPENDENCY-INVENTORY.json"), "utf8"),
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
        integrity:
          "sha256-f2ed1fbdfb79afb9343dfbb609efde657b41e7efcd5215264ce78f8906356b4d,sha256-2a291f0a9555f5d6685d96ce9429da3d0ea3cd896c012702c6ee0015f818684e",
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
