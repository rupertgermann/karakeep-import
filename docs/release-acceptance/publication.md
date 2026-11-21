# Manual release publication checklist

Use this checklist only after the signed macOS and Windows records are
`ACCEPTED`. It binds the accepted source commit to the release materials and
final signed artifacts. It records manual GitHub publication and verification
of the downloaded assets.

Follow the status and confidentiality rules in [`README.md`](./README.md).
Copy this template to a versioned publication record before use.

## Publication identity

- Overall status: `UNAVAILABLE`
- Release version: `[version]`
- Release tag: `[tag]`
- Accepted source commit: `[full 40-character commit]`
- macOS acceptance record filename and SHA-256: `[filename and digest]`
- Windows acceptance record filename and SHA-256: `[filename and digest]`
- Publication date in UTC: `[YYYY-MM-DD]`
- Release operator role: `[role, not a personal account name]`
- GitHub release URL: `[public URL after publication]`
- Notes: `Template not executed.`

## Source and cross-platform binding

The macOS and Windows artifacts must come from the same clean source commit and
version. The Tauri desktop app is the only supported product in the accepted
source and user documentation.

| Required gate | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- |
| macOS native record is `ACCEPTED` with no `FAIL` or `UNAVAILABLE` required row | UNAVAILABLE | Template not executed |
| Windows native record is `ACCEPTED` with no `FAIL` or `UNAVAILABLE` required row | UNAVAILABLE | Template not executed |
| Both native records identify the same full source commit and application version | UNAVAILABLE | Template not executed |
| Release metadata for both platforms identifies that same commit, version, and source date epoch | UNAVAILABLE | Template not executed |
| Platform-specific metadata differs only where the native target, bundle, or runtime inventory requires it | UNAVAILABLE | Template not executed |
| Accepted source checkout is clean and exactly matches the release tag | UNAVAILABLE | Template not executed |
| Legacy importer and browser GUI entry points, dedicated tests, and usage instructions have been removed from the accepted source | UNAVAILABLE | Template not executed |
| No GitHub Actions workflow builds, signs, packages, uploads, or publishes a release | UNAVAILABLE | Template not executed |

Do not infer source equality from matching version strings. Compare the full
commit recorded in both signed native records and both release metadata files.

## Release materials

Use unambiguous, platform-qualified filenames so the two metadata and inventory
files cannot overwrite each other during upload.

| Material | Required comparison | Status | Filename and final SHA-256 |
| --- | --- | --- | --- |
| Signed and notarized Apple Silicon DMG | Matches accepted macOS record after all signing and stapling | UNAVAILABLE | Template not executed |
| Signed Windows x64 NSIS installer | Matches accepted Windows record after all signing and timestamping | UNAVAILABLE | Template not executed |
| macOS release metadata | Accepted commit/version; expected macOS-only target fields | UNAVAILABLE | Template not executed |
| Windows release metadata | Accepted commit/version; expected Windows-only target fields | UNAVAILABLE | Template not executed |
| Dependency inventories | Shared components match; platform-only runtimes match each accepted package | UNAVAILABLE | Template not executed |
| Third-party notices | Each target's notice matches its own inventory; both target files are retained | UNAVAILABLE | Template not executed |
| Release notes | Byte-identical between platforms and match the reviewed release text | UNAVAILABLE | Template not executed |
| Final checksum file | Contains the final post-signing hash for every uploaded asset | UNAVAILABLE | Template not executed |

The release notes must state:

- that Karakeep Transfer is an unofficial community application;
- the supported macOS and Windows versions and architectures;
- the supported Chrome, Edge, Brave, Chromium, and Firefox matrix;
- that X acquisition uses a best-effort unofficial compatibility path;
- how a user manually downloads and installs this release as an upgrade.

Generate final checksums after signing, notarization, stapling, and
Authenticode timestamping. Checksums produced for unsigned staging inputs do
not satisfy this gate.

Third-party notices are target-specific. The macOS notice covers the bundled
arm64 Node executable. The Windows notice covers its bundled Node and SQLite
executables. Verify each notice against its own dependency inventory and
retain both reviewed files.

## Pre-publication review

Keep the GitHub release as a draft while completing these checks.

| Required gate | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- |
| Every final checksum is recomputed from the exact upload candidate | UNAVAILABLE | Template not executed |
| Final DMG still passes signature, notarization, stapling, Gatekeeper, and DMG verification | UNAVAILABLE | Template not executed |
| Final NSIS installer and all shipped executables still pass Authenticode verification | UNAVAILABLE | Template not executed |
| Release notes match the reviewed file byte for byte | UNAVAILABLE | Template not executed |
| Notices and inventories match the accepted packaged components | UNAVAILABLE | Template not executed |
| Release tag resolves to the accepted full commit | UNAVAILABLE | Template not executed |
| Draft release targets the accepted tag and contains no generated or unreviewed text | UNAVAILABLE | Template not executed |
| Asset list contains every required material exactly once and no unsigned candidate | UNAVAILABLE | Template not executed |
| Evidence bundle contains no secret, private path, private server address, account identity, or bookmark content | UNAVAILABLE | Template not executed |

Any mismatch rejects the publication candidate. Correct the source material,
rebuild the affected candidate, and repeat its native acceptance record rather
than editing a checksum or record to match unexpected bytes.

## Manual GitHub publication

The release operator performs these actions directly. GitHub Actions must not
build, sign, package, upload, or publish any release asset.

| Manual action | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- |
| Create or open the draft release for the accepted tag | UNAVAILABLE | Template not executed |
| Paste the reviewed release notes without modification | UNAVAILABLE | Template not executed |
| Upload the two signed installers and every reviewed release material | UNAVAILABLE | Template not executed |
| Compare the draft asset filenames and byte sizes with the publication record | UNAVAILABLE | Template not executed |
| Publish the draft only after every pre-publication row is `PASS` | UNAVAILABLE | Template not executed |
| Record the public release URL and UTC publication time | UNAVAILABLE | Template not executed |

Do not include command output that exposes a local path or authenticated GitHub
session. The public release URL, tag, commit, and asset filenames are safe
publication evidence.

## Downloaded-asset verification

After publication, download every public asset into a clean verification area.
Verification uses the downloaded bytes, not the upload candidates still on the
release host.

| Required gate | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- |
| Public release tag resolves to the accepted full commit | UNAVAILABLE | Template not executed |
| Every expected asset is downloadable without an authenticated release session | UNAVAILABLE | Template not executed |
| Every downloaded filename and byte size matches the publication record | UNAVAILABLE | Template not executed |
| Every downloaded SHA-256 matches the final checksum file and publication record | UNAVAILABLE | Template not executed |
| Downloaded DMG passes signature, notarization, stapling, Gatekeeper, and DMG verification | UNAVAILABLE | Template not executed |
| Downloaded NSIS installer and its installed executables pass Authenticode verification | UNAVAILABLE | Template not executed |
| Clean macOS installation from the downloaded DMG launches the accepted version | UNAVAILABLE | Template not executed |
| Clean Windows installation from the downloaded NSIS installer launches the accepted version | UNAVAILABLE | Template not executed |
| Downloaded notices, inventories, metadata, and release notes match the reviewed bytes | UNAVAILABLE | Template not executed |
| Public release page states the accepted support, compatibility, and upgrade information | UNAVAILABLE | Template not executed |

If a downloaded byte, signature, or release-page value differs, the release is
not accepted. Stop distribution, record the discrepancy, and prepare a
corrected release through the full acceptance flow; never replace a public
asset silently.

## Publication decision

- Required rows with `PASS`: `[count]`
- Required rows with `FAIL`: `[count]`
- Required rows with `UNAVAILABLE`: `[count]`
- Decision: `REJECTED`
- Decision evidence filename and SHA-256: `Template not executed`

Change the decision to `ACCEPTED` only when every required row is `PASS`, the
downloaded assets still match the signed native records, and the GitHub release
contains exactly the reviewed materials.
