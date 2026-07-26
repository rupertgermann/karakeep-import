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
  await writeFile(macosArtifact, "signed macOS installer\n");
  await writeFile(windowsArtifact, "signed Windows installer\n");

  const evidence = path.join(temporary, "evidence");
  const macosEvidence = path.join(evidence, "macos-universal.json");
  const windowsEvidence = path.join(evidence, "windows-x64.json");
  await mkdir(evidence);
  for (const [target, artifact, output] of [
    ["macos-universal", macosArtifact, macosEvidence],
    ["windows-x64", windowsArtifact, windowsEvidence],
  ]) {
    await writeJson(output, {
      schemaVersion: 1,
      target,
      commit,
      product,
      artifact: { sha256: await sha256(artifact) },
      gates: Object.fromEntries(gateNames.map((gate) => [gate, "PASS"])),
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

  assert.deepEqual(schema.properties.gates.required, gateNames);
  assert.equal(schema.properties.gates.additionalProperties, false);
  for (const gate of gateNames) {
    assert.deepEqual(schema.properties.gates.properties[gate], {
      const: "PASS",
    });
  }
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
  assert.equal(
    await readFile(
      path.join(
        fixture.output,
        "artifacts",
        "macos-universal",
        path.basename(fixture.macosArtifact),
      ),
      "utf8",
    ),
    "signed macOS installer\n",
  );
  assert.equal(
    await readFile(
      path.join(
        fixture.output,
        "artifacts",
        "windows-x64",
        path.basename(fixture.windowsArtifact),
      ),
      "utf8",
    ),
    "signed Windows installer\n",
  );
  assert.deepEqual(
    await readFile(path.join(fixture.output, "RELEASE-NOTES.md")),
    releaseNotes,
  );
  for (const target of ["macos-universal", "windows-x64"]) {
    assert.deepEqual(
      await readdir(path.join(fixture.output, "targets", target)),
      ["DEPENDENCY-INVENTORY.json", "THIRD-PARTY-NOTICES.md"],
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
  assert.deepEqual(
    await readdir(path.join(fixture.output, "acceptance-evidence")),
    ["macos-universal.json", "windows-x64.json"],
  );

  const metadata = JSON.parse(
    await readFile(path.join(fixture.output, "RELEASE-METADATA.json"), "utf8"),
  );
  assert.deepEqual(metadata.product, product);
  assert.equal(metadata.commit, fixture.commit);
  assert.equal(
    metadata.targets["macos-universal"].artifact.sha256,
    await sha256(fixture.macosArtifact),
  );
  assert.equal(
    metadata.targets["windows-x64"].artifact.sha256,
    await sha256(fixture.windowsArtifact),
  );

  const checksumLines = (
    await readFile(path.join(fixture.output, "SHA256SUMS"), "utf8")
  )
    .trim()
    .split("\n");
  assert.equal(checksumLines.length, 10);
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

test("rejects evidence whose release identity or artifact SHA does not match", async (t) => {
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
    evidence.gates[gate] = "pass";
    await writeJson(fixture.windowsEvidence, evidence);

    await assertRejected(
      fixture,
      new RegExp(`windows-x64 evidence gate is not PASS: ${gate}`),
      gate,
    );
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
