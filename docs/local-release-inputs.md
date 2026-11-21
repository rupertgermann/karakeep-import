# Local release inputs

Karakeep Transfer release builds are prepared on controlled local macOS and
Windows machines. GitHub Actions does not build, sign, package, or publish the
desktop app.

This stage prepares deterministic, unsigned installer inputs. Signing,
notarization, Authenticode, native installation tests, and publication are
separate release gates.

## Pinned inputs

[`release/release-inputs.json`](../release/release-inputs.json) pins the app
identity, app version, local Node.js, npm, and Rust toolchains, target triples,
bundle formats, and target-specific private Node runtimes.

The remaining authoritative inputs are:

- `release/release-notes.md`, containing the exact product/version heading and
  the required status, platform, browser, X compatibility, and manual-upgrade
  disclosures;
- `package-lock.json`, including exact JavaScript versions, package
  integrities, and license expressions;
- `src-tauri/Cargo.lock`, including exact Rust versions and crate checksums;
- `release/rust-dependencies.json`, the lock-matched Rust license inventory;
- `vendor/fieldtheory/manifest.json`, including the exact Field Theory commit,
  source and package SHA-256 values, private Node archive and executable
  SHA-256 values, and the Windows SQLite archive SHA-256, official SHA3-256,
  and executable SHA-256 values;
- the prepared `src-tauri/resources` tree, containing the unchanged Field
  Theory package, production bridge dependencies and license files, and the
  private Node executable for the native target. Windows x64 resources also
  contain only the pinned `sqlite3.exe` helper required by Field Theory's
  Chromium-cookie reader.

The command rejects release notes whose first heading does not exactly match
the configured product name and version, or which omit the unofficial status,
macOS or Windows support, Chrome, Edge, Brave, Chromium, or Firefox support,
best-effort X compatibility, or manual upgrade instructions.

The release-input command performs no downloads. It reopens each pinned Node
or SQLite archive left in the preparation cache, verifies its archive digest,
extracts the declared executable into a temporary directory, and verifies both
the independently pinned executable digest and the prepared runtime byte. It
fails if the current toolchains differ from the pinned versions, a lock or
license inventory is incomplete, the prepared resources are missing or
modified, Field Theory checksums disagree, packaged bridge code attempts to
download a runtime, or either the complete source resource tree or staged
resource tree (including production `node_modules` and NUL-containing files)
contains a password-equivalent value. Explicit placeholders in dependency
documentation, such as `replace-me`, are not treated as credentials.

## macOS arm64 inputs

Use a clean release checkout on Apple Silicon with macOS 14.8.9 or newer.
Populate the dependency and runtime caches before staging. npm and Cargo use
their lockfiles, and the Field Theory preparation script verifies the SHA-256
of the Node archive declared in `vendor/fieldtheory/manifest.json`.

```bash
npm ci --ignore-scripts
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
npm run prepare:fieldtheory
npm run build
npm run release:inputs -- --target macos-arm64
npm run release:build-candidate -- --input release-inputs/macos-arm64
```

The output is `release-inputs/macos-arm64`. Re-running preparation may
replace only that exact default target directory. A custom `--output` must be
a new, absent directory inside the checkout; protected paths and symlinked
paths are rejected. It contains the private `darwin-arm64` Node runtime,
the frontend build, Field Theory bridge resources, `RELEASE-METADATA.json`,
`RELEASE-NOTES.md`, `DEPENDENCY-INVENTORY.json`,
`THIRD-PARTY-NOTICES.md`, and `SHA256SUMS`.
It also contains `NATIVE-BUILD-COMMAND.txt`; that checksummed file invokes the
tracked release-build wrapper shown above. The wrapper requires a clean
checkout whose `HEAD` equals `RELEASE-METADATA.json`, verifies every
staged regular file is covered by `SHA256SUMS`, rejects symlinks and a
non-macOS host, rebuilds the tracked frontend locally, and prepares a fresh,
unique canonical staging tree. It requires the supplied staging tree to have
the same paths, bytes, and supported file modes as that canonical tree before
deriving the Tauri target and bundle format from staged metadata and supplying
an absolute canonical-input Tauri override. The temporary canonical tree stays
private until the Tauri build or dry run completes, so later changes to the
supplied staging directory cannot affect packaging; it is then removed. It
does not download or regenerate private runtime resources. Run it from the
checkout root on the controlled macOS release machine.

## Windows x64 inputs

Run the equivalent commands in a clean Windows x64 PowerShell checkout:

```powershell
npm ci --ignore-scripts
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
npm run prepare:fieldtheory
npm run build
npm run release:inputs -- --target windows-x64
npm run release:build-candidate -- --input release-inputs/windows-x64
```

The output is `release-inputs/windows-x64`. It contains only the Windows x64
private Node runtime, the pinned `sqlite3.exe` helper, and the same
deterministic metadata, notices, and checksum files. The packaged bridge puts
the private SQLite directory first on its Windows-only `PATH`; no separately
installed SQLite command is required. Its `NATIVE-BUILD-COMMAND.txt` contains
the tracked Windows wrapper command shown above; run it from the checkout root
on the controlled Windows release machine. The later issue #17 Authenticode gate must
verify every shipped executable, including this helper, as well as the app and
installer.

Do not prepare a Windows release from macOS or a macOS release from Windows.
Each target proceeds from this staging gate into its native, local signing and
installer-validation procedure.

## Reproducibility and inspection

The command derives `commit` and `sourceDateEpoch` from a clean `HEAD` and
fails outside a Git checkout. Optional explicit values are accepted only when
they exactly match that checkout state:

```bash
npm run release:inputs -- \
  --target macos-arm64 \
  --commit "$(git rev-parse HEAD)" \
  --source-date-epoch "$(git show -s --format=%ct HEAD)"
```

Run the same command twice against the same checkout and prepared resource
tree. `RELEASE-METADATA.json`, `RELEASE-NOTES.md`,
`DEPENDENCY-INVENTORY.json`, `THIRD-PARTY-NOTICES.md`, and `SHA256SUMS` must
be byte-identical. `RELEASE-METADATA.json` records the source note's SHA-256,
while `SHA256SUMS` covers the staged copy. These are deterministic input
checksums, not the final installer hashes produced after native packaging and
signing. Before the native package build:

1. verify every line in `SHA256SUMS`;
2. inspect the dependency inventory and notices;
3. inspect `RELEASE-NOTES.md` and confirm the release metadata names the
   expected commit, version, native target, bundle format, native build
   command, bundled runtimes, toolchain versions, and source release-note
   checksum;
4. run `NATIVE-BUILD-COMMAND.txt` from the native host; the wrapper rebuilds
   the tracked frontend, recreates canonical release inputs locally without
   downloading private runtimes, and packages only after an exact comparison
   with the supplied staging tree, then packages the canonical snapshot rather
   than the caller-supplied directory;
5. keep credentials outside the checkout, staged inputs, process arguments,
   and logs.

If `Cargo.lock` changes, populate the locked Cargo cache and regenerate the
license inventory offline:

```bash
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
npm run release:rust-inventory
```

Review every version/license change in `release/rust-dependencies.json`. The
local staging gate rejects a stale or incomplete Rust inventory.

## Acceptance evidence

Retain platform acceptance results separately from the deterministic build
inputs. Use the [macOS arm64 acceptance record](./release-acceptance/macos-arm64.md)
for the current release. The [unsigned universal preflight](./macos-universal-preflight.md)
records the earlier two-architecture build.
