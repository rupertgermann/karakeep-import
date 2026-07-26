# Signed macOS universal acceptance record

Use this template for one final universal DMG. Run the checks on controlled
macOS hosts, retain only sanitized evidence, and follow the status rules in
[`README.md`](./README.md).

## Record identity

- Overall status: `UNAVAILABLE`
- Candidate ID: `[version]-[short commit]-macos-universal`
- Application version: `[version]`
- Accepted source commit: `[full 40-character commit]`
- Source checkout clean: `UNAVAILABLE`
- Final DMG filename: `[filename only]`
- Final DMG size in bytes: `[bytes]`
- Final DMG SHA-256: `[64 lowercase hexadecimal characters]`
- Test date in UTC: `[YYYY-MM-DD]`
- Release operator role: `[role, not a personal account name]`
- Notes: `Template not executed.`

The accepted source commit and version must match the values in the staged
`RELEASE-METADATA.json` and the signed application bundle. Recompute the DMG
SHA-256 after signing, notarization, and stapling.

The machine-readable companion uses schema version 3. Each required row and
both native architecture columns need their own typed JSON evidence record.
Do not reuse one command transcript or result file across assertions.

## Artifact and signing evidence

Run verification against the final DMG and the application copied from that
DMG. Use shell variables while working so retained command excerpts contain
only artifact filenames, not local paths.

Typical native checks include:

```bash
shasum -a 256 "$DMG"
hdiutil verify "$DMG"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP"
spctl --assess --type open --context context:primary-signature -vv "$DMG"
spctl --assess --type execute -vv "$APP"
xcrun stapler validate "$DMG"
xcrun stapler validate "$APP"
lipo -archs "$APP/Contents/MacOS/karakeep-transfer"
```

Inspect the load commands of both executable slices and record that each
declares macOS 12.0 or newer as its minimum. Do not retain the mounted volume
path.

| Required gate | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- |
| Clean source checkout is exactly the accepted commit | UNAVAILABLE | Template not executed |
| Release metadata identifies the accepted commit, version, universal target, and DMG bundle | UNAVAILABLE | Template not executed |
| Final DMG filename, byte size, and post-stapling SHA-256 match this record | UNAVAILABLE | Template not executed |
| Application has a valid sealed Developer ID signature | UNAVAILABLE | Template not executed |
| DMG has a valid Developer ID signature | UNAVAILABLE | Template not executed |
| Public certificate subject, Team ID, and certificate SHA-256 match the approved signing identity | UNAVAILABLE | Template not executed |
| Nested executables and libraries satisfy strict signature verification | UNAVAILABLE | Template not executed |
| Apple notarization is accepted and the ticket is stapled to the app and DMG | UNAVAILABLE | Template not executed |
| Gatekeeper accepts the DMG and application | UNAVAILABLE | Template not executed |
| `hdiutil verify` accepts the final DMG | UNAVAILABLE | Template not executed |
| Application executable contains native `arm64` and `x86_64` slices | UNAVAILABLE | Template not executed |
| Both executable slices declare the supported macOS 12.0 minimum | UNAVAILABLE | Template not executed |
| Packaged Field Theory, private Node runtimes, licenses, and notices match the release inputs | UNAVAILABLE | Template not executed |
| Packaged resources contain no Python runtime or browser GUI | UNAVAILABLE | Template not executed |

Record the public signing identity here:

- Certificate subject: `[public subject]`
- Apple Team ID: `[public Team ID]`
- Certificate SHA-256: `[public certificate digest]`
- Trusted timestamp present: `UNAVAILABLE`

Never record the keychain name, keychain path, Apple account, application
password, API key, or notarization credential.

## Clean installation and architecture

Use clean supported hosts or clean virtual-machine snapshots. Do not reuse a
machine that already contains application data or a prior Karakeep Transfer
installation. A Rosetta launch on Apple Silicon does not replace native Intel
hardware evidence.

| Host gate | Apple Silicon macOS 12+ | Native Intel macOS 12+ | Redacted evidence filename and SHA-256 |
| --- | --- | --- | --- |
| Final DMG installs with the expected Applications link | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Installed app launches through Finder or LaunchServices | UNAVAILABLE | UNAVAILABLE | Template not executed |
| First screen reaches **Connect Karakeep** | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App version and bundled component versions match this record | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App runs without a separately installed Python runtime | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App runs without a separately installed Node.js runtime | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Field Theory bridge executes the Node runtime inside the signed app bundle | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App performs no runtime or dependency download | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Fresh launch contains no previous destination, source, or delivery data | UNAVAILABLE | UNAVAILABLE | Template not executed |

The retained process evidence may name a bundle-relative executable such as
`Contents/Resources/resources/node/darwin-arm64/node`. It must not include the
absolute installation path or user directory.

## Supported browser matrix

Exercise an installed, already signed-in profile with explicit user consent.
Record only the browser name, architecture used for the check, aggregate
counts, and result. Never record profile names, profile paths, cookies, X
identity, bookmark content, or source URLs.

| Browser | Discovery and profile selection | X acquisition | Evidence filename and SHA-256 |
| --- | --- | --- | --- |
| Google Chrome | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Microsoft Edge | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Brave | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Chromium | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Firefox | UNAVAILABLE | UNAVAILABLE | Template not executed |

Every browser row is required. A documented absence of an installed browser is
`UNAVAILABLE`, not `PASS`.

## X and File Source smoke transfers

Use a controlled Karakeep destination and synthetic or non-sensitive bookmark
records. Store only aggregate totals and safe assertions.

| Workflow check | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- |
| HTTPS destination validation succeeds without exposing its credential | UNAVAILABLE | Template not executed |
| X Source consent precedes session use | UNAVAILABLE | Template not executed |
| X acquisition reports progress and completes without downloading media | UNAVAILABLE | Template not executed |
| X folder names appear as folder tags and `twitter` appears as the source tag | UNAVAILABLE | Template not executed |
| X Transfer Preview reports total, pending, prior delivery, folders, and destination | UNAVAILABLE | Template not executed |
| Confirmed X delivery reports created, existing, retried, failed, and cancelled totals | UNAVAILABLE | Template not executed |
| Repeated X delivery preserves existing Karakeep content and safely skips or completes prior delivery | UNAVAILABLE | Template not executed |
| Field Theory JSONL File Source previews in place and completes a confirmed delivery | UNAVAILABLE | Template not executed |
| Chrome/Netscape File Source preserves title and folder tags through confirmed delivery | UNAVAILABLE | Template not executed |
| File Source use does not replace the active X Source | UNAVAILABLE | Template not executed |
| Cancellation leaves incomplete work pending and a later run can resume safely | UNAVAILABLE | Template not executed |
| Evidence and exported diagnostics contain no credential, X session value, bookmark content, or private path | UNAVAILABLE | Template not executed |

## Acceptance decision

- Required rows with `PASS`: `[count]`
- Required rows with `FAIL`: `[count]`
- Required rows with `UNAVAILABLE`: `[count]`
- Decision: `REJECTED`
- Decision evidence filename and SHA-256: `Template not executed`

Change the decision to `ACCEPTED` only when every required row is `PASS`, the
two architecture columns are complete, and the final DMG identity still
matches the record.
