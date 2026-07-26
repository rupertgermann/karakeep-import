import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "finalize-release-candidates.mjs",
);
const evidenceSchemaFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "release",
  "acceptance-evidence.schema.json",
);
const product = {
  name: "Karakeep Transfer",
  identifier: "io.github.rupertgermann.karakeeptransfer",
  version: "0.1.0",
};
const gateNames = [
  "native baseline",
  "clean install",
  "no system runtime",
  "five-browser matrix",
  "X transfer",
  "File transfer",
  "signature",
  "platform verification",
];
const platformNames = {
  "macos-universal": ["macos-arm64", "macos-x86_64-native"],
  "windows-x64": ["windows-10-x64", "windows-11-x64"],
};
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
const releaseNotes = Buffer.from(
  "# Karakeep Transfer 0.1.0\n\nOffline release candidate.\n",
);

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function pass(evidence) {
  return { status: "PASS", evidence: [evidence] };
}

async function writeArtifact(file, target) {
  if (target === "macos-universal") {
    const content = Buffer.alloc(4096);
    const xml = Buffer.from(
      '<?xml version="1.0"?><plist version="1.0"><dict><key>resource-fork</key><dict><key>blkx</key><array/></dict></dict></plist>',
    );
    const xmlOffset = 2048;
    const trailer = content.length - 512;
    xml.copy(content, xmlOffset);
    content.write("koly", trailer, "ascii");
    content.writeUInt32BE(4, trailer + 4);
    content.writeUInt32BE(512, trailer + 8);
    content.writeUInt32BE(1, trailer + 12);
    content.writeBigUInt64BE(0n, trailer + 16);
    content.writeBigUInt64BE(0n, trailer + 24);
    content.writeBigUInt64BE(BigInt(xmlOffset), trailer + 32);
    content.writeBigUInt64BE(0n, trailer + 40);
    content.writeBigUInt64BE(0n, trailer + 48);
    content.writeUInt32BE(1, trailer + 56);
    content.writeUInt32BE(1, trailer + 60);
    content.fill(0x11, trailer + 64, trailer + 80);
    content.writeUInt32BE(2, trailer + 80);
    content.writeUInt32BE(32, trailer + 84);
    content.writeUInt32BE(0x12345678, trailer + 88);
    content.writeBigUInt64BE(BigInt(xmlOffset), trailer + 216);
    content.writeBigUInt64BE(BigInt(xml.length), trailer + 224);
    content.writeUInt32BE(2, trailer + 352);
    content.writeUInt32BE(32, trailer + 356);
    content.writeUInt32BE(0x9abcdef0, trailer + 360);
    content.writeUInt32BE(1, trailer + 488);
    content.writeBigUInt64BE(8n, trailer + 492);
    await writeFile(file, content);
    return;
  }
  const content = Buffer.alloc(4096);
  const peOffset = 0x80;
  const coffOffset = peOffset + 4;
  const optionalOffset = coffOffset + 20;
  const optionalSize = 0xe0;
  const sectionOffset = optionalOffset + optionalSize;
  content.write("MZ", 0, "ascii");
  content.writeUInt32LE(peOffset, 0x3c);
  content.write("PE\0\0", peOffset, "binary");
  content.writeUInt16LE(0x14c, coffOffset);
  content.writeUInt16LE(1, coffOffset + 2);
  content.writeUInt16LE(optionalSize, coffOffset + 16);
  content.writeUInt16LE(0x22, coffOffset + 18);
  content.writeUInt16LE(0x10b, optionalOffset);
  content.writeUInt32LE(0x1000, optionalOffset + 16);
  content.writeUInt32LE(0x1000, optionalOffset + 20);
  content.writeUInt32LE(0x2000, optionalOffset + 24);
  content.writeUInt32LE(0x400000, optionalOffset + 28);
  content.writeUInt32LE(0x1000, optionalOffset + 32);
  content.writeUInt32LE(0x200, optionalOffset + 36);
  content.writeUInt32LE(0x2000, optionalOffset + 56);
  content.writeUInt32LE(0x200, optionalOffset + 60);
  content.writeUInt32LE(16, optionalOffset + 92);
  content.writeUInt32LE(0x800, optionalOffset + 128);
  content.writeUInt32LE(0x100, optionalOffset + 132);
  content.write(".text\0\0\0", sectionOffset, "binary");
  content.writeUInt32LE(0x100, sectionOffset + 8);
  content.writeUInt32LE(0x1000, sectionOffset + 12);
  content.writeUInt32LE(0x200, sectionOffset + 16);
  content.writeUInt32LE(0x200, sectionOffset + 20);
  content.writeUInt32LE(0x60000020, sectionOffset + 36);
  const nsisHeader = 0x400;
  content.writeUInt32LE(0, nsisHeader);
  content.writeUInt32LE(0xdeadbeef, nsisHeader + 4);
  content.write("NullsoftInst", nsisHeader + 8, "ascii");
  content.writeUInt32LE(64, nsisHeader + 20);
  content.writeUInt32LE(0x800 - nsisHeader, nsisHeader + 24);
  await writeFile(file, content);
}

async function bindArtifactInEvidence(evidenceFile, artifact) {
  const evidence = await readJson(evidenceFile);
  evidence.artifact = {
    filename: path.basename(artifact),
    size: (await stat(artifact)).size,
    sha256: await sha256(artifact),
  };
  await writeJson(evidenceFile, evidence);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function refreshStagingChecksums(directory) {
  const names = [
    "DEPENDENCY-INVENTORY.json",
    "RELEASE-METADATA.json",
    "RELEASE-NOTES.md",
    "THIRD-PARTY-NOTICES.md",
  ];
  const lines = [];
  for (const name of names) {
    lines.push(`${await sha256(path.join(directory, name))}  ${name}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function writeStagedInputs(directory, target, commit) {
  await mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, "RELEASE-METADATA.json"), {
    schemaVersion: 1,
    product,
    commit,
    sourceDateEpoch: 1750000000,
    target,
    rustTarget:
      target === "macos-universal"
        ? "universal-apple-darwin"
        : "x86_64-pc-windows-msvc",
    bundleFormat: target === "macos-universal" ? "dmg" : "nsis",
    nativeBuildCommand: `build ${target}`,
    nodeRuntimes:
      target === "macos-universal"
        ? ["darwin-arm64", "darwin-x64"]
        : ["win-x64"],
    buildToolchains: {
      node: "22.20.0",
      npm: "10.9.3",
      rust: "1.93.0",
    },
    inputs: [
      {
        path: "release/release-inputs.json",
        sha256: "b".repeat(64),
      },
    ],
  });
  await writeFile(path.join(directory, "RELEASE-NOTES.md"), releaseNotes);
  await writeJson(path.join(directory, "DEPENDENCY-INVENTORY.json"), {
    schemaVersion: 1,
    components: [{ name: `${target}-dependency`, version: "1.0.0" }],
  });
  await writeFile(
    path.join(directory, "THIRD-PARTY-NOTICES.md"),
    `# ${target} notices\n`,
  );
  await refreshStagingChecksums(directory);
}

async function createFixture(t, { repositoryFiles = [] } = {}) {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "release-finalizer-test-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const root = path.join(temporary, "repo");
  await mkdir(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "release-test@example.invalid"]);
  git(root, ["config", "user.name", "Release Test"]);
  await writeFile(path.join(root, "README.md"), "# Release fixture\n");
  for (const relative of repositoryFiles) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "legacy placeholder\n");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  const commit = git(root, ["rev-parse", "HEAD"]);

  const inputs = path.join(temporary, "inputs");
  const macosInput = path.join(inputs, "macos-universal");
  const windowsInput = path.join(inputs, "windows-x64");
  await writeStagedInputs(macosInput, "macos-universal", commit);
  await writeStagedInputs(windowsInput, "windows-x64", commit);

  const artifacts = path.join(temporary, "artifacts");
  const macosArtifact = path.join(
    artifacts,
    "Karakeep.Transfer_0.1.0_universal.dmg",
  );
  const windowsArtifact = path.join(
    artifacts,
    "Karakeep.Transfer_0.1.0_x64-setup.exe",
  );
  await mkdir(artifacts);
  await writeArtifact(macosArtifact, "macos-universal");
  await writeArtifact(windowsArtifact, "windows-x64");

  const evidence = path.join(temporary, "evidence");
  const macosEvidence = path.join(evidence, "macos-universal.json");
  const windowsEvidence = path.join(evidence, "windows-x64.json");
  await mkdir(evidence);
  for (const [target, artifact, output] of [
    ["macos-universal", macosArtifact, macosEvidence],
    ["windows-x64", windowsArtifact, windowsEvidence],
  ]) {
    const artifactDetails = await stat(artifact);
    const artifactBinding = {
      filename: path.basename(artifact),
      size: artifactDetails.size,
      sha256: await sha256(artifact),
    };
    let recordNumber = 0;
    async function reference(assertionId, platform, checkType) {
      recordNumber += 1;
      const filename = `${target}-evidence-${String(recordNumber).padStart(2, "0")}.json`;
      const file = path.join(evidence, filename);
      await writeJson(file, {
        schemaVersion: 1,
        target,
        commit,
        artifact: artifactBinding,
        assertionId,
        platform,
        tool: "release-fixture",
        checkType,
        status: "PASS",
        resultSummary: `Verified ${checkType} for ${platform}`,
      });
      return {
        file: filename,
        sha256: await sha256(file),
        assertionId,
        platform,
      };
    }
    const signingScopes =
      target === "macos-universal"
        ? ["application-and-dmg"]
        : ["installer", "application", "bundled-node", "bundled-sqlite"];
    const checkout = pass(
      await reference("checkout:clean", "target-wide", "clean-checkout"),
    );
    const signingIdentities = [];
    for (const scope of signingScopes) {
      const assertionId = `signing-identity:${scope}`;
      signingIdentities.push({
        scope,
        assertionId,
        subject:
          target === "macos-universal"
            ? "Developer ID Application: Example Organization"
            : "CN=Example Organization",
        stableIdentifier:
          target === "macos-universal"
            ? "ABCDE12345"
            : "0123456789ABCDEF0123456789ABCDEF01234567",
        certificateSha256: "a".repeat(64),
        timestampStatus: "PASS",
        evidence: [
          await reference(
            assertionId,
            "target-wide",
            "signing-identity",
          ),
        ],
      });
    }
    const platforms = {};
    for (const platform of platformNames[target]) {
      platforms[platform] = pass(
        await reference(
          `platform:${platform}`,
          platform,
          "native-platform",
        ),
      );
    }
    const gates = {};
    for (const gate of gateNames) {
      const assertionId = gateAssertionIds[gate];
      const requiredPlatforms =
        gate === "signature" ? ["target-wide"] : platformNames[target];
      const references = [];
      for (const platform of requiredPlatforms) {
        references.push(
          await reference(
            assertionId,
            platform,
            assertionId.slice("gate:".length),
          ),
        );
      }
      gates[gate] = { status: "PASS", evidence: references };
    }
    const applicationPayload =
      target === "windows-x64"
        ? pass(
            await reference(
              "application-payload:windows-x64",
              "target-wide",
              "x64-application-payload",
            ),
          )
        : undefined;
    await writeJson(output, {
      schemaVersion: 3,
      target,
      commit,
      product,
      testedAt: "2026-07-26T12:00:00Z",
      checkout,
      artifact: artifactBinding,
      signingIdentities,
      platforms,
      gates,
      ...(applicationPayload ? { applicationPayload } : {}),
    });
  }

  return {
    temporary,
    root,
    commit,
    macosInput,
    windowsInput,
    macosArtifact,
    windowsArtifact,
    macosEvidence,
    windowsEvidence,
    output: path.join(temporary, "final"),
  };
}

function run(fixture) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--root",
      fixture.root,
      "--macos-input",
      fixture.macosInput,
      "--windows-input",
      fixture.windowsInput,
      "--macos-artifact",
      fixture.macosArtifact,
      "--windows-artifact",
      fixture.windowsArtifact,
      "--macos-evidence",
      fixture.macosEvidence,
      "--windows-evidence",
      fixture.windowsEvidence,
      "--output",
      fixture.output,
    ],
    { encoding: "utf8" },
  );
}

async function assertRejected(fixture, pattern, description) {
  const result = run(fixture);
  assert.notEqual(result.status, 0, description);
  assert.match(result.stderr, pattern, description);
  await assert.rejects(stat(fixture.output), { code: "ENOENT" });
}

test("acceptance evidence schema fixes the exact required PASS gates", async () => {
  const schema = await readJson(evidenceSchemaFile);

  assert.equal(schema.properties.schemaVersion.const, 3);
  assert.ok(schema.required.includes("testedAt"));
  assert.ok(schema.required.includes("signingIdentities"));
  assert.equal(schema.properties.signingIdentities.minItems, 1);
  assert.equal(
    schema.properties.signingIdentities.items.$ref,
    "#/$defs/signingIdentity",
  );
  assert.ok(
    schema.$defs.signingIdentity.required.includes("assertionId"),
  );
  assert.deepEqual(schema.$defs.evidenceReference.required, [
    "file",
    "sha256",
    "assertionId",
    "platform",
  ]);
  assert.equal(schema.$defs.typedEvidenceRecord.additionalProperties, false);
  assert.deepEqual(schema.$defs.typedEvidenceRecord.properties.status, {
    const: "PASS",
  });
  assert.deepEqual(schema.properties.gates.required, gateNames);
  assert.equal(schema.properties.gates.additionalProperties, false);
  assert.deepEqual(schema.$defs.evidenceReference.properties.file.not, {
    pattern:
      "^[Aa][Cc][Cc][Ee][Pp][Tt][Aa][Nn][Cc][Ee]-[Ee][Vv][Ii][Dd][Ee][Nn][Cc][Ee]\\.[Jj][Ss][Oo][Nn]$",
  });
  for (const gate of gateNames) {
    assert.deepEqual(schema.properties.gates.properties[gate], {
      $ref: "#/$defs/passWithEvidence",
    });
  }
  assert.deepEqual(
    schema.allOf[0].then.properties.platforms.required,
    platformNames["macos-universal"],
  );
  assert.deepEqual(schema.allOf[0].then.not.required, [
    "applicationPayload",
  ]);
  assert.deepEqual(
    schema.allOf[1].then.properties.platforms.required,
    platformNames["windows-x64"],
  );
  assert.deepEqual(schema.allOf[1].then.required, ["applicationPayload"]);
});

test("finalizes two verified native candidates into one offline release directory", async (t) => {
  const fixture = await createFixture(t);

  const result = run(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Finalized Karakeep Transfer 0\.1\.0/);
  assert.deepEqual(await readdir(path.join(fixture.output, "artifacts")), [
    "macos-universal",
    "windows-x64",
  ]);
  assert.deepEqual(
    await readFile(
      path.join(
        fixture.output,
        "artifacts",
        "macos-universal",
        path.basename(fixture.macosArtifact),
      ),
    ),
    await readFile(fixture.macosArtifact),
  );
  assert.deepEqual(
    await readFile(
      path.join(
        fixture.output,
        "artifacts",
        "windows-x64",
        path.basename(fixture.windowsArtifact),
      ),
    ),
    await readFile(fixture.windowsArtifact),
  );
  assert.deepEqual(
    await readFile(path.join(fixture.output, "RELEASE-NOTES.md")),
    releaseNotes,
  );
  for (const target of ["macos-universal", "windows-x64"]) {
    assert.deepEqual(
      await readdir(path.join(fixture.output, "targets", target)),
      [
        "DEPENDENCY-INVENTORY.json",
        "RELEASE-METADATA.json",
        "THIRD-PARTY-NOTICES.md",
      ],
    );
    assert.deepEqual(
      await readFile(
        path.join(fixture.output, "targets", target, "RELEASE-METADATA.json"),
      ),
      await readFile(
        path.join(
          target === "macos-universal"
            ? fixture.macosInput
            : fixture.windowsInput,
          "RELEASE-METADATA.json",
        ),
      ),
    );
    assert.equal(
      await readFile(
        path.join(
          fixture.output,
          "targets",
          target,
          "THIRD-PARTY-NOTICES.md",
        ),
        "utf8",
      ),
      `# ${target} notices\n`,
    );
  }
  for (const target of ["macos-universal", "windows-x64"]) {
    const files = await readdir(
      path.join(fixture.output, "acceptance-evidence", target),
    );
    assert.equal(files[0], "acceptance-evidence.json");
    assert.equal(
      files.length,
      target === "macos-universal" ? 20 : 24,
    );
    assert.ok(files.every((file) => file.endsWith(".json")));
  }

  const metadata = JSON.parse(
    await readFile(path.join(fixture.output, "RELEASE-METADATA.json"), "utf8"),
  );
  assert.deepEqual(metadata.product, product);
  assert.equal(metadata.commit, fixture.commit);
  assert.equal(metadata.sourceDateEpoch, 1750000000);
  assert.equal(
    metadata.targets["macos-universal"].artifact.sha256,
    await sha256(fixture.macosArtifact),
  );
  assert.equal(
    metadata.targets["windows-x64"].artifact.sha256,
    await sha256(fixture.windowsArtifact),
  );
  for (const [target, input] of [
    ["macos-universal", fixture.macosInput],
    ["windows-x64", fixture.windowsInput],
  ]) {
    const copiedMetadata = path.join(
      fixture.output,
      "targets",
      target,
      "RELEASE-METADATA.json",
    );
    assert.deepEqual(metadata.targets[target].releaseMetadata, {
      path: `targets/${target}/RELEASE-METADATA.json`,
      sha256: await sha256(copiedMetadata),
    });
    assert.equal(
      (await readJson(copiedMetadata)).sourceDateEpoch,
      1750000000,
    );
  }

  const checksumLines = (
    await readFile(path.join(fixture.output, "SHA256SUMS"), "utf8")
  )
    .trim()
    .split("\n");
  assert.equal(checksumLines.length, 54);
  assert.ok(
    checksumLines.some((line) => line.endsWith("  RELEASE-METADATA.json")),
  );
  for (const line of checksumLines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, line);
    assert.equal(
      await sha256(path.join(fixture.output, match[2])),
      match[1],
      match[2],
    );
  }
});

test("rejects the legacy self-asserted PASS-only evidence shape", async (t) => {
  const fixture = await createFixture(t);
  await writeJson(fixture.macosEvidence, {
    schemaVersion: 1,
    target: "macos-universal",
    commit: fixture.commit,
    product,
    artifact: { sha256: await sha256(fixture.macosArtifact) },
    gates: Object.fromEntries(gateNames.map((gate) => [gate, "PASS"])),
  });

  await assertRejected(
    fixture,
    /macos-universal evidence has an unsupported schema/,
  );
});

test("rejects a staging tree whose SHA256SUMS no longer matches", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    path.join(fixture.macosInput, "DEPENDENCY-INVENTORY.json"),
    '{"tampered":true}\n',
  );

  await assertRejected(
    fixture,
    /macos-universal staging checksum mismatch: DEPENDENCY-INVENTORY\.json/,
  );
});

test("rejects a staging tree with an unchecksummed file", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.windowsInput, "unexpected.txt"), "extra\n");

  await assertRejected(
    fixture,
    /windows-x64 SHA256SUMS does not cover the complete staging tree/,
  );
});

test("requires the current repository HEAD and a clean checkout", async (t) => {
  {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.root, "untracked.txt"), "dirty\n");
    await assertRejected(
      fixture,
      /Release checkout must be clean before finalization/,
      "dirty checkout",
    );
  }
  {
    const fixture = await createFixture(t);
    const metadataFile = path.join(
      fixture.macosInput,
      "RELEASE-METADATA.json",
    );
    const metadata = await readJson(metadataFile);
    metadata.commit = "0".repeat(40);
    await writeJson(metadataFile, metadata);
    await refreshStagingChecksums(fixture.macosInput);
    await assertRejected(
      fixture,
      /macos-universal release metadata commit does not match HEAD/,
      "stale staged commit",
    );
  }
});

test("rejects either post-removal legacy GUI path", async (t) => {
  for (const relative of [
    "karakeep-import-gui.py",
    "tests/test_karakeep_import_gui.py",
  ]) {
    const fixture = await createFixture(t, {
      repositoryFiles: [relative],
    });
    await assertRejected(
      fixture,
      new RegExp(`Legacy GUI release blocker is still present: ${relative}`),
      relative,
    );
  }
});

test("requires both staged targets to name the same product and version", async (t) => {
  const fixture = await createFixture(t);
  const metadataFile = path.join(
    fixture.windowsInput,
    "RELEASE-METADATA.json",
  );
  const metadata = await readJson(metadataFile);
  metadata.product = { ...metadata.product, version: "0.2.0" };
  await writeJson(metadataFile, metadata);
  await refreshStagingChecksums(fixture.windowsInput);
  const evidence = await readJson(fixture.windowsEvidence);
  evidence.product = metadata.product;
  await writeJson(fixture.windowsEvidence, evidence);

  await assertRejected(
    fixture,
    /Staged release product or version does not match across targets/,
  );
});

test("requires both staged targets to name the same source date epoch", async (t) => {
  const fixture = await createFixture(t);
  const metadataFile = path.join(
    fixture.windowsInput,
    "RELEASE-METADATA.json",
  );
  const metadata = await readJson(metadataFile);
  metadata.sourceDateEpoch += 1;
  await writeJson(metadataFile, metadata);
  await refreshStagingChecksums(fixture.windowsInput);

  await assertRejected(
    fixture,
    /Staged release source date epoch does not match across targets/,
  );
});

test("rejects evidence whose release or artifact identity does not match", async (t) => {
  for (const [description, mutate, pattern] of [
    [
      "target",
      (evidence) => {
        evidence.target = "windows-x64";
      },
      /macos-universal evidence target does not match/,
    ],
    [
      "commit",
      (evidence) => {
        evidence.commit = "0".repeat(40);
      },
      /macos-universal evidence commit does not match HEAD/,
    ],
    [
      "product",
      (evidence) => {
        evidence.product = { ...evidence.product, name: "Another Product" };
      },
      /macos-universal evidence product does not match/,
    ],
    [
      "artifact filename",
      (evidence) => {
        evidence.artifact.filename = "different-installer.dmg";
      },
      /macos-universal evidence artifact filename does not match/,
    ],
    [
      "artifact size",
      (evidence) => {
        evidence.artifact.size += 1;
      },
      /macos-universal evidence artifact size does not match/,
    ],
    [
      "artifact SHA-256",
      (evidence) => {
        evidence.artifact.sha256 = "0".repeat(64);
      },
      /macos-universal evidence artifact SHA-256 does not match/,
    ],
  ]) {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    mutate(evidence);
    await writeJson(fixture.macosEvidence, evidence);
    await assertRejected(fixture, pattern, description);
  }
});

test("requires every named native acceptance gate to be exactly PASS", async (t) => {
  for (const gate of gateNames) {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.windowsEvidence);
    evidence.gates[gate].status = "FAIL";
    await writeJson(fixture.windowsEvidence, evidence);

    await assertRejected(
      fixture,
      new RegExp(`windows-x64 evidence gate ${gate} is not PASS`),
      gate,
    );
  }
});

test("requires a UTC test timestamp and public signing identities", async (t) => {
  for (const [description, mutate, pattern] of [
    [
      "missing timestamp",
      (evidence) => {
        delete evidence.testedAt;
      },
      /macos-universal evidence test timestamp is not a valid UTC date-time/,
    ],
    [
      "non-UTC timestamp",
      (evidence) => {
        evidence.testedAt = "2026-07-26T12:00:00+02:00";
      },
      /macos-universal evidence test timestamp is not a valid UTC date-time/,
    ],
    [
      "missing identities",
      (evidence) => {
        delete evidence.signingIdentities;
      },
      /macos-universal evidence requires signing identities/,
    ],
    [
      "missing identity digest",
      (evidence) => {
        delete evidence.signingIdentities[0].certificateSha256;
      },
      /macos-universal evidence signing identity certificate SHA-256 is invalid/,
    ],
    [
      "missing timestamp attestation",
      (evidence) => {
        evidence.signingIdentities[0].timestampStatus = "UNAVAILABLE";
      },
      /macos-universal evidence signing identity timestamp status is not PASS/,
    ],
  ]) {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    mutate(evidence);
    await writeJson(fixture.macosEvidence, evidence);
    await assertRejected(fixture, pattern, description);
  }
});

test("requires the exact native platform set with referenced PASS evidence", async (t) => {
  const fixture = await createFixture(t);
  const evidence = await readJson(fixture.windowsEvidence);
  delete evidence.platforms["windows-11-x64"];
  await writeJson(fixture.windowsEvidence, evidence);

  await assertRejected(
    fixture,
    /windows-x64 evidence platforms do not match the required native set/,
  );
});

test("requires every attestation to contain referenced evidence", async (t) => {
  const fixture = await createFixture(t);
  const evidence = await readJson(fixture.macosEvidence);
  evidence.gates["X transfer"].evidence = [];
  await writeJson(fixture.macosEvidence, evidence);

  await assertRejected(
    fixture,
    /macos-universal evidence gate X transfer requires evidence references/,
  );
});

test("rejects reused untyped evidence even when its digest matches", async (t) => {
  const fixture = await createFixture(t);
  const file = path.join(
    path.dirname(fixture.macosEvidence),
    "macos-universal-reused-evidence.json",
  );
  await writeFile(file, "macos-universal sanitized native verification\n");
  const digest = await sha256(file);
  const evidence = await readJson(fixture.macosEvidence);
  evidence.checkout.evidence = [{
    file: path.basename(file),
    sha256: digest,
    assertionId: "checkout:clean",
    platform: "target-wide",
  }];
  evidence.signingIdentities[0].evidence = [{
    file: path.basename(file),
    sha256: digest,
    assertionId: evidence.signingIdentities[0].assertionId,
    platform: "target-wide",
  }];
  await writeJson(fixture.macosEvidence, evidence);

  await assertRejected(
    fixture,
    /macos-universal evidence file is reused across assertions/,
  );
});

test("rejects a unique reference whose contents are not a typed record", async (t) => {
  const fixture = await createFixture(t);
  const evidence = await readJson(fixture.macosEvidence);
  const file = path.join(
    path.dirname(fixture.macosEvidence),
    "macos-universal-untyped-evidence.json",
  );
  await writeFile(file, "PASS\n");
  evidence.checkout.evidence[0] = {
    ...evidence.checkout.evidence[0],
    file: path.basename(file),
    sha256: await sha256(file),
  };
  await writeJson(fixture.macosEvidence, evidence);

  await assertRejected(
    fixture,
    /macos-universal referenced evidence .* is not a typed evidence record/,
  );
});

test("binds typed records to the exact release, artifact, assertion, and platform", async (t) => {
  for (const [description, mutate, pattern] of [
    [
      "target",
      (record) => {
        record.target = "windows-x64";
      },
      /typed evidence record release or artifact binding does not match/,
    ],
    [
      "commit",
      (record) => {
        record.commit = "0".repeat(40);
      },
      /typed evidence record release or artifact binding does not match/,
    ],
    [
      "artifact",
      (record) => {
        record.artifact.sha256 = "0".repeat(64);
      },
      /typed evidence record release or artifact binding does not match/,
    ],
    [
      "assertion",
      (record) => {
        record.assertionId = "checkout:dirty";
      },
      /typed evidence record assertion or platform does not match/,
    ],
    [
      "platform",
      (record) => {
        record.platform = "macos-arm64";
      },
      /typed evidence record assertion or platform does not match/,
    ],
    [
      "check type",
      (record) => {
        record.checkType = "different-check";
      },
      /typed evidence record check did not PASS/,
    ],
    [
      "private result",
      (record) => {
        record.resultSummary = "Read cookie from /Users/example/profile";
      },
      /typed evidence record result summary is not sanitized/,
    ],
  ]) {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    const reference = evidence.checkout.evidence[0];
    const file = path.join(path.dirname(fixture.macosEvidence), reference.file);
    const record = await readJson(file);
    mutate(record);
    await writeJson(file, record);
    reference.sha256 = await sha256(file);
    await writeJson(fixture.macosEvidence, evidence);

    await assertRejected(fixture, pattern, description);
  }
});

test("requires outer references to declare their expected assertion and platform", async (t) => {
  for (const [description, mutate, pattern] of [
    [
      "outer assertion",
      (reference) => {
        reference.assertionId = "checkout:dirty";
      },
      /clean checkout reference assertion does not match/,
    ],
    [
      "outer platform",
      (reference) => {
        reference.platform = "macos-arm64";
      },
      /clean checkout reference platform does not match/,
    ],
    [
      "missing outer platform",
      (reference) => {
        delete reference.platform;
      },
      /clean checkout reference platform does not match/,
    ],
  ]) {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    mutate(evidence.checkout.evidence[0]);
    await writeJson(fixture.macosEvidence, evidence);

    await assertRejected(fixture, pattern, description);
  }
});

test("requires typed evidence platform coverage and signing scope binding", async (t) => {
  {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    evidence.gates["X transfer"].evidence.pop();
    await writeJson(fixture.macosEvidence, evidence);
    await assertRejected(
      fixture,
      /gate X transfer does not cover every required platform/,
      "gate platform coverage",
    );
  }
  {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    evidence.signingIdentities[0].assertionId =
      "signing-identity:different-scope";
    await writeJson(fixture.macosEvidence, evidence);
    await assertRejected(
      fixture,
      /signing identity assertion does not match its scope/,
      "signing scope assertion",
    );
  }
  {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.windowsEvidence);
    delete evidence.applicationPayload;
    await writeJson(fixture.windowsEvidence, evidence);
    await assertRejected(
      fixture,
      /x64 application payload is not PASS/,
      "x64 application payload",
    );
  }
});

test("rejects missing, modified, unsafe, and private-looking evidence files", async (t) => {
  {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    const reference = evidence.checkout.evidence[0];
    await rm(path.join(path.dirname(fixture.macosEvidence), reference.file));
    await assertRejected(
      fixture,
      /Required macos-universal referenced evidence .* is missing/,
      "missing referenced file",
    );
  }
  {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    const reference = evidence.checkout.evidence[0];
    await writeFile(
      path.join(path.dirname(fixture.macosEvidence), reference.file),
      "modified verification\n",
    );
    await assertRejected(
      fixture,
      /macos-universal referenced evidence SHA-256 mismatch/,
      "wrong referenced digest",
    );
  }
  for (const filename of [
    "../outside.txt",
    "alice-profile.txt",
    "acceptance-evidence.json",
    "Acceptance-Evidence.JSON",
  ]) {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    evidence.gates.signature.evidence[0].file = filename;
    await writeJson(fixture.macosEvidence, evidence);
    await assertRejected(
      fixture,
      /macos-universal evidence reference filename is unsafe or private-looking/,
      filename,
    );
  }
});

test("rejects magic-only buffers posing as native installers", async (t) => {
  for (const [target, artifactName] of [
    ["macos-universal", "macosArtifact"],
    ["windows-x64", "windowsArtifact"],
  ]) {
    const fixture = await createFixture(t);
    const content = Buffer.alloc(1024);
    if (target === "macos-universal") {
      content.write("koly", content.length - 512, "ascii");
    } else {
      content.write("MZ", 0, "ascii");
    }
    await writeFile(fixture[artifactName], content);
    await bindArtifactInEvidence(
      target === "macos-universal"
        ? fixture.macosEvidence
        : fixture.windowsEvidence,
      fixture[artifactName],
    );

    await assertRejected(
      fixture,
      new RegExp(
        `${target} signed artifact does not have a coherent native installer structure`,
      ),
      target,
    );
  }
});

test("rejects incoherent UDIF footer ranges and plist metadata", async (t) => {
  for (const [description, mutate] of [
    [
      "empty data fork",
      (content, trailer) => content.writeBigUInt64BE(0n, trailer + 32),
    ],
    [
      "plist beyond trailer",
      (content, trailer) => {
        content.writeBigUInt64BE(BigInt(trailer - 1), trailer + 216);
        content.writeBigUInt64BE(64n, trailer + 224);
      },
    ],
    [
      "unpaired code signature",
      (content, trailer) => content.writeBigUInt64BE(256n, trailer + 296),
    ],
    [
      "oversized checksum",
      (content, trailer) => content.writeUInt32BE(1024, trailer + 84),
    ],
    [
      "zero sectors",
      (content, trailer) => content.writeBigUInt64BE(0n, trailer + 492),
    ],
    [
      "missing plist block map",
      (content) => content.fill(0, 2048, 2176),
    ],
  ]) {
    const fixture = await createFixture(t);
    const content = await readFile(fixture.macosArtifact);
    mutate(content, content.length - 512);
    await writeFile(fixture.macosArtifact, content);

    await assertRejected(
      fixture,
      /macos-universal signed artifact does not have a coherent native installer structure/,
      description,
    );
  }
});

test("rejects incoherent PE and misplaced NSIS first headers", async (t) => {
  for (const [description, mutate] of [
    [
      "wrong bootstrap machine",
      (content) => content.writeUInt16LE(0x8664, 0x84),
    ],
    [
      "wrong optional-header format",
      (content) => content.writeUInt16LE(0x20b, 0x98),
    ],
    [
      "raw section beyond file",
      (content) => content.writeUInt32LE(content.length, 0x178 + 20),
    ],
    [
      "misplaced NSIS marker",
      (content) => {
        content.copy(content, 0x500, 0x400, 0x41c);
        content.fill(0, 0x400, 0x41c);
      },
    ],
    [
      "NSIS data beyond overlay",
      (content) => content.writeUInt32LE(content.length, 0x400 + 24),
    ],
  ]) {
    const fixture = await createFixture(t);
    const content = await readFile(fixture.windowsArtifact);
    mutate(content);
    await writeFile(fixture.windowsArtifact, content);

    await assertRejected(
      fixture,
      /windows-x64 signed artifact does not have a coherent native installer structure/,
      description,
    );
  }
});

test("rejects plain-text files posing as native installers", async (t) => {
  for (const [target, artifactName, pattern] of [
    [
      "macos-universal",
      "macosArtifact",
      /macos-universal signed artifact does not have a coherent native installer structure/,
    ],
    [
      "windows-x64",
      "windowsArtifact",
      /windows-x64 signed artifact does not have a coherent native installer structure/,
    ],
  ]) {
    const fixture = await createFixture(t);
    await writeFile(fixture[artifactName], `plain text ${target}\n`);
    await assertRejected(fixture, pattern, target);
  }
});

test("rejects evidence properties that its schema does not allow", async (t) => {
  for (const [scope, mutate] of [
    [
      "root",
      (evidence) => {
        evidence.operatorNotes = "not part of the publication contract";
      },
    ],
    [
      "product",
      (evidence) => {
        evidence.product.channel = "stable";
      },
    ],
    [
      "artifact",
      (evidence) => {
        evidence.artifact.path = "/private/signed-installer.dmg";
      },
    ],
    [
      "clean checkout",
      (evidence) => {
        evidence.checkout.note = "unsupported";
      },
    ],
    [
      "signing identity",
      (evidence) => {
        evidence.signingIdentities[0].privateKey = "unsupported";
      },
    ],
    [
      "gate signature reference",
      (evidence) => {
        evidence.gates.signature.evidence[0].size = 123;
      },
    ],
    [
      "gates",
      (evidence) => {
        evidence.gates["manual note"] = "PASS";
      },
    ],
  ]) {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    mutate(evidence);
    await writeJson(fixture.macosEvidence, evidence);

    await assertRejected(
      fixture,
      new RegExp(`macos-universal evidence ${scope} has unsupported properties`),
      scope,
    );
  }
});

test("rejects symlinked artifact and evidence inputs", async (t) => {
  {
    const fixture = await createFixture(t);
    const linkedArtifact = path.join(
      fixture.temporary,
      "linked-macos-artifact.dmg",
    );
    await symlink(fixture.macosArtifact, linkedArtifact);
    fixture.macosArtifact = linkedArtifact;
    await assertRejected(
      fixture,
      /Required macos-universal signed artifact is not a non-empty regular file/,
      "symlinked artifact",
    );
  }
  {
    const fixture = await createFixture(t);
    const linkedEvidence = path.join(
      fixture.temporary,
      "linked-macos-evidence.json",
    );
    await symlink(fixture.macosEvidence, linkedEvidence);
    fixture.macosEvidence = linkedEvidence;
    await assertRejected(
      fixture,
      /Required macos-universal acceptance evidence is not a non-empty regular file/,
      "symlinked evidence",
    );
  }
  {
    const fixture = await createFixture(t);
    const evidence = await readJson(fixture.macosEvidence);
    const reference = evidence.checkout.evidence[0];
    const evidenceDirectory = path.dirname(fixture.macosEvidence);
    const referenced = path.join(evidenceDirectory, reference.file);
    const real = path.join(evidenceDirectory, "native-verification-source.txt");
    await writeFile(real, await readFile(referenced));
    await rm(referenced);
    await symlink(real, referenced);
    await assertRejected(
      fixture,
      /Required macos-universal referenced evidence .* is not a non-empty regular file/,
      "symlinked referenced evidence",
    );
  }
});

test("requires byte-identical release notes from both staged targets", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    path.join(fixture.windowsInput, "RELEASE-NOTES.md"),
    Buffer.concat([releaseNotes, Buffer.from("\n")]),
  );
  await refreshStagingChecksums(fixture.windowsInput);

  await assertRejected(
    fixture,
    /Staged release notes are not byte-identical/,
  );
});
