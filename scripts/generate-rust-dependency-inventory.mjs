import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function cargoMetadata(root, metadataFile) {
  if (metadataFile) {
    return JSON.parse(await readFile(path.resolve(metadataFile), "utf8"));
  }
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--offline",
      "--manifest-path",
      path.join(root, "src-tauri", "Cargo.toml"),
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not read locked Cargo metadata offline: ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function generate(options) {
  const root = path.resolve(options.root ?? scriptRoot);
  const output = path.resolve(
    options.output ?? path.join(root, "release", "rust-dependencies.json"),
  );
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Rust dependency inventory output must be inside the checkout.");
  }
  const metadata = await cargoMetadata(root, options.metadata);
  const packages = (metadata.packages ?? [])
    .filter((component) => component.source)
    .map(({ name, version, license, source }) => {
      if (!name || !version || !license || !source) {
        throw new Error(
          `Cargo metadata has incomplete dependency license data for ${name ?? "unknown"}.`,
        );
      }
      return { name, version, license, source };
    })
    .sort((left, right) =>
      `${left.name}\0${left.version}`.localeCompare(
        `${right.name}\0${right.version}`,
      ),
    );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  );
  process.stdout.write(`Recorded ${packages.length} locked Rust dependencies.\n`);
}

try {
  await generate(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
