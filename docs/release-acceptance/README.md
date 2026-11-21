# Native release acceptance

Use these records to accept and publish signed Karakeep Transfer installers.
Native tests verify that the packaged app works on its supported operating
systems. [Signing decision](../adr/0018-require-signed-public-builds.md)

Use the records in this order:

1. [`macos-arm64.md`](./macos-arm64.md) for the signed and notarized macOS
   Apple Silicon candidate.
2. [`windows-x64.md`](./windows-x64.md) for the signed Windows x64 candidate.
3. [`publication.md`](./publication.md) only after both native records are
   accepted and the publication source satisfies its source-contraction gate.

Prepare the workflow checks with the
[X and File Source test data](./transfer-fixtures/README.md).

Copy each template to a versioned Markdown record in this directory. The native
release finalizer additionally requires one machine-readable
`acceptance-evidence.json` file beside its referenced evidence files for each
target. Name supporting files with the release version, platform, and a neutral
evidence label. Evidence filenames must not contain a user name, browser
profile, local path, server address, or source-account identity.

## Status vocabulary

Every evidence row uses exactly one of these statuses:

- `PASS`: the stated check ran against the recorded candidate and its retained,
  redacted evidence supports the result.
- `FAIL`: the check ran and the candidate did not satisfy it.
- `UNAVAILABLE`: the check did not run or its evidence cannot be retained.

`UNAVAILABLE` is not a weaker form of `PASS`. A candidate is accepted only when
every required row is `PASS`. Any `FAIL` or `UNAVAILABLE` result keeps the
candidate out of publication.

The templates start as `UNAVAILABLE` so an unexecuted record cannot look
accepted. Replace a status only after recording the evidence reference and its
SHA-256.

## Evidence binding

Every platform and publication record must identify:

- one full 40-character accepted Git commit;
- one application version;
- one UTC `testedAt` timestamp and the clean source state used for the build;
- each exact artifact filename, byte size, and SHA-256 computed after all
  signing, notarization, stapling, or timestamping steps;
- every applicable signing scope, with the public certificate subject, stable
  public identifier, certificate digest, and successful timestamp status;
- the native operating-system and architecture used for each check;
- the release metadata, dependency inventory, notices, and release notes that
  accompany the candidate.

The JSON record uses schema version 4 from
[`../../release/acceptance-evidence.schema.json`](../../release/acceptance-evidence.schema.json).
Every named assertion is an object with exact status `PASS`. It contains
exactly one distinct typed JSON file for every platform listed below; files
cannot be shared across assertions. The target/platform pairs are exact:

- `macos-arm64`: `macos-arm64`;
- `windows-x64`: `windows-10-x64` and `windows-11-x64`.

`M` means Apple Silicon, `W` means both exact Windows platforms,
and `TW` means one target-wide record.

| Assertion ID | Coverage | Check type |
| --- | --- | --- |
| `checkout:clean` | both targets / TW | `clean-checkout` |
| `host:installer-completes` | both / M or W | `native-install` |
| `host:app-launches` | both / M or W | `native-launch` |
| `host:first-screen-connect-karakeep` | both / M or W | `first-screen` |
| `host:component-versions` | both / M or W | `component-versions` |
| `host:no-system-python` | both / M or W | `system-runtime-absence` |
| `host:no-system-node` | both / M or W | `system-runtime-absence` |
| `host:bundled-node-runtime` | both / M or W | `bundled-runtime` |
| `host:bundled-sqlite-helper` | Windows / W | `bundled-helper` |
| `host:no-runtime-download` | both / M or W | `no-runtime-download` |
| `host:fresh-state` | both / M or W | `fresh-state` |

Each browser has two independent required assertions on M or W:

| Browser | Discovery assertion | Acquisition assertion |
| --- | --- | --- |
| Google Chrome | `browser:google-chrome:discovery` | `browser:google-chrome:x-acquisition` |
| Microsoft Edge | `browser:microsoft-edge:discovery` | `browser:microsoft-edge:x-acquisition` |
| Brave | `browser:brave:discovery` | `browser:brave:x-acquisition` |
| Chromium | `browser:chromium:discovery` | `browser:chromium:x-acquisition` |
| Firefox | `browser:firefox:discovery` | `browser:firefox:x-acquisition` |

Discovery records use `browser-discovery`; acquisition records use
`browser-x-acquisition`.

| Workflow assertion ID | Coverage | Check type |
| --- | --- | --- |
| `workflow:https-destination-validation` | both / M or W | `destination-validation` |
| `workflow:x-consent-before-session` | both / M or W | `x-session-consent` |
| `workflow:x-acquisition-progress-no-media` | both / M or W | `x-acquisition` |
| `workflow:x-folder-and-source-tags` | both / M or W | `x-tag-mapping` |
| `workflow:x-transfer-preview` | both / M or W | `transfer-preview` |
| `workflow:x-delivery-result-totals` | both / M or W | `transfer-result` |
| `workflow:x-repeat-delivery-preserves-content` | both / M or W | `delivery-idempotency` |
| `workflow:field-theory-file-transfer` | both / M or W | `field-theory-file-transfer` |
| `workflow:chrome-netscape-file-transfer` | both / M or W | `chrome-file-transfer` |
| `workflow:file-source-preserves-active-x` | both / M or W | `source-isolation` |
| `workflow:cancellation-resume` | both / M or W | `transfer-resume` |
| `workflow:evidence-sanitization` | both / M or W | `evidence-sanitization` |

Package assertions are artifact-invariant and use one TW record:

| Assertion ID | Check type |
| --- | --- |
| `package:release-inputs` | `package-inventory` |
| `package:no-python-or-browser-gui` | `package-exclusions` |

macOS requires these additional assertions:

| Assertion ID | Coverage | Check type |
| --- | --- | --- |
| `signature:application` | TW | `developer-id-signature` |
| `signature:dmg` | TW | `developer-id-signature` |
| `signing-identity:application-and-dmg` | TW | `signing-identity` |
| `signature:nested-code` | TW | `developer-id-signature` |
| `notarization:application-and-dmg` | TW | `notarization` |
| `gatekeeper:application-and-dmg` | TW | `gatekeeper` |
| `dmg:hdiutil-verify` | TW | `dmg-verification` |
| `architecture:arm64` | TW | `arm64-architecture` |
| `minimum-macos:executable` | M | `minimum-macos-version` |

Windows requires these additional assertions:

| Assertion ID | Coverage | Check type |
| --- | --- | --- |
| `signing-identity:installer` | TW | `authenticode-signature` |
| `signing-identity:application` | TW | `authenticode-signature` |
| `signing-identity:bundled-node` | TW | `authenticode-signature` |
| `signing-identity:bundled-sqlite` | TW | `authenticode-signature` |
| `signature:other-shipped-pe` | TW | `authenticode-other-pe` |
| `application-payload:windows-x64` | TW | `x64-application-payload` |
| `authenticode:platform-trust` | W | `authenticode-trust` |

The macOS matrix requires 43 assertions and 43 typed records. The Windows
matrix requires 42 assertions and 75 typed records. Use the individual
assertion IDs listed above in each record.

Signing identity metadata is also exact. macOS has only the
`application-and-dmg` scope. Windows has exactly `installer`, `application`,
`bundled-node`, and `bundled-sqlite`. Each scope records its public subject,
stable public identifier, certificate digest, and successful timestamp status.
The related typed signing assertion proves the native check. The
`signature:other-shipped-pe` record is required even when no other PE is
shipped; its package-relative inventory must then show a zero-extra result.

The Windows `application-payload:windows-x64` assertion proves the installed
application and packaged runtime payload are x64 even though the pinned NSIS
bootstrapper is a PE32 i386 executable.

Do not substitute an unsigned staging-input checksum for a final artifact
checksum. If signing or notarization changes an artifact, compute and retain a
new SHA-256.

Each retained evidence reference declares a neutral JSON filename, SHA-256,
exact assertion ID, and exact native platform or `target-wide`. Do not record
an absolute path. References resolve relative to the JSON record. They must
name regular, non-symlinked files in that directory; the finalizer rejects
missing files, unsafe or private-looking names, digest mismatches, and reuse of
one file by more than one assertion.

Every referenced JSON file is itself a schema-versioned typed evidence record.
It repeats the target, accepted commit, final artifact filename, artifact byte
size, artifact SHA-256, assertion ID, platform, tool, check type, exact `PASS`
status, and a short sanitized result summary. It also contains a
`releaseInputs` object with the exact SHA-256 of
`RELEASE-METADATA.json`, `DEPENDENCY-INVENTORY.json`,
`THIRD-PARTY-NOTICES.md`, and `RELEASE-NOTES.md`. Those four bindings must
match the checksummed staging snapshot. These values must match the outer
reference and current finalization candidate. A text line saying `PASS`, an
untyped command transcript, or one shared file reused by many rows is not
evidence. Generated output names such as `acceptance-evidence.json` are
reserved and cannot be used by a referenced evidence file.

## Offline finalization

Run the finalizer only after native acceptance has produced the signed
installers and referenced evidence. It does not access credentials, sign an
artifact, publish a release, or independently reproduce platform trust
semantics. The retained native command results attest those semantics; the
finalizer binds and verifies their bytes.

Before assembling the release directory, the finalizer copies every validated
artifact, staged release material, acceptance record, and typed evidence record
into a private temporary snapshot and rechecks its digest. Assembly and final
checksums use only those snapshot bytes, so later changes to caller-supplied
paths cannot alter the finalized release.

Finalization structurally parses the artifact instead of trusting a filename
or magic bytes alone. A DMG must have a coherent UDIF trailer, bounded nonempty
data and XML-plist forks, `resource-fork`/`blkx` plist metadata, bounded optional
code-signature fields, coherent checksum records, and a nonzero bounded sector
count.

The Windows installer must match the actual pinned Tauri/NSIS bootstrap
contract: a bounded PE32 i386 image with coherent headers and sections,
followed exactly at the derived overlay boundary by the NSIS first header
(`0xDEADBEEF` and `NullsoftInst`). If Authenticode certificate-table data is
present, its file range bounds the NSIS overlay. The bootstrapper architecture
does not describe the installed application architecture; the separate typed
`application-payload:windows-x64` record supplies that proof.

Structural parsing does not verify a code signature, notarization, timestamp,
trust chain, installation, or runtime behavior. Those native semantics remain
attested by distinct typed evidence records produced on the required hosts.
The finalizer verifies the final artifact name, size, and digest and copies all
verified records into a target-specific evidence directory.

Each target's original `RELEASE-METADATA.json` is preserved byte for byte under
`targets/<target>/RELEASE-METADATA.json`. Its path and digest are bound into the
root release metadata and final checksum file. Both candidates must name the
same commit, product, and `sourceDateEpoch`; platform-specific target, bundle,
runtime, toolchain, and input fields remain available in their original target
metadata.

## Confidentiality

Acceptance evidence is safe to publish with the release. It must not contain:

- Karakeep API keys, X cookies, authorization headers, passwords, signing
  private keys, certificate passwords, or notarization credentials;
- browser profile names or paths, home directories, temporary directories,
  machine names, account names, email addresses, or private server addresses;
- bookmark URLs, titles, notes, X account identity, or other bookmark content;
- raw process environments, request bodies, diagnostics containing content, or
  unreviewed command output.

Public certificate subjects, Apple Team IDs, and Authenticode certificate
thumbprints are required signing evidence and are not secret. Obtain secrets
from the controlled platform credential store; never pass them in a command
argument or copy them into a record.

A signing subject must identify only the public certificate issuer and
organization. For example, `Developer ID Application: Example Organization
(ABCDE12345)` and `CN=Example Organization, O=Example Organization, C=US` are
publish-safe. Do not put email addresses, URLs, local paths, private hosts or
IP addresses, or account and machine identifiers in a signing subject.

If output cannot be sanitized without weakening the evidence, mark the row
`UNAVAILABLE`. Do not retain sensitive output merely to turn a gate green.

## Candidate rejection

Stop acceptance immediately when the source commit, version, artifact digest,
or signing identity changes. A changed artifact is a new candidate and needs a
complete native record. Record failures honestly; do not edit a failed record
into a passing record without identifying the replacement candidate.
