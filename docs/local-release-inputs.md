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

## macOS universal inputs

Use a clean macOS 12-or-newer release checkout. Dependency and runtime cache
population is an explicit preparation step: npm and Cargo use their lockfiles,
and the Field Theory preparation script accepts only the Node archives declared
by `vendor/fieldtheory/manifest.json` after verifying SHA-256.

```bash
npm ci --ignore-scripts
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
npm run prepare:fieldtheory
npm run build
npm run release:inputs -- --target macos-universal
npm run tauri -- build --target universal-apple-darwin --bundles dmg
```

The output is `release-inputs/macos-universal`. It contains both macOS private
Node runtimes (`darwin-arm64` and `darwin-x64`), the frontend build, Field
Theory bridge resources, `RELEASE-METADATA.json`,
`DEPENDENCY-INVENTORY.json`, `THIRD-PARTY-NOTICES.md`, and `SHA256SUMS`.
It also contains `NATIVE-BUILD-COMMAND.txt`; that checksummed file is generated
from the declared `rustTarget` and `bundleFormat` and must contain the exact
Tauri command shown above. Run that command from the checkout root on the
controlled macOS release machine.

## Windows x64 inputs

Run the equivalent commands in a clean Windows x64 PowerShell checkout:

```powershell
npm ci --ignore-scripts
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
npm run prepare:fieldtheory
npm run build
npm run release:inputs -- --target windows-x64
npm run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis
```

The output is `release-inputs/windows-x64`. It contains only the Windows x64
private Node runtime, the pinned `sqlite3.exe` helper, and the same
deterministic metadata, notices, and checksum files. The packaged bridge puts
the private SQLite directory first on its Windows-only `PATH`; no separately
installed SQLite command is required. Its `NATIVE-BUILD-COMMAND.txt` contains
the exact Windows command shown above; run it from the checkout root on the
controlled Windows release machine. The later issue #17 Authenticode gate must
verify every shipped executable, including this helper, as well as the app and
installer.

Do not prepare a Windows release from macOS or a macOS release from Windows.
Each target proceeds from this staging gate into its native, local signing and
installer-validation procedure.

## Reproducibility and inspection

The command derives `commit` and `sourceDateEpoch` from `HEAD`. A caller may
pass full, explicit values for a reproduction:

```bash
npm run release:inputs -- \
  --target macos-universal \
  --commit "$(git rev-parse HEAD)" \
  --source-date-epoch "$(git show -s --format=%ct HEAD)"
```

Run the same command twice against the same checkout and prepared resource
tree. `RELEASE-METADATA.json`, `DEPENDENCY-INVENTORY.json`,
`THIRD-PARTY-NOTICES.md`, and `SHA256SUMS` must be byte-identical. Before the
native package build:

1. verify every line in `SHA256SUMS`;
2. inspect the dependency inventory and notices;
3. confirm the release metadata names the expected commit, version, native
   target, bundle format, native build command, bundled runtimes, and toolchain
   versions;
4. confirm `NATIVE-BUILD-COMMAND.txt` selects the same target and bundle format
   before running it on the native host;
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
inputs. The current unsigned macOS universal preflight is recorded in
[`macos-universal-preflight.md`](./macos-universal-preflight.md); its failed and
unavailable signing and smoke-test gates must be resolved before issue #16 can
be accepted.
