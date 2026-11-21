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

The machine-readable companion uses schema version 4 and the exact assertion
IDs and coverage matrix in [`README.md`](./README.md). It contains 43
assertions and exactly 75 typed records: one distinct record for every required
assertion/platform cell. The package, signature, notarization, Gatekeeper, DMG,
universal-architecture, signing-identity, and checkout rows are target-wide;
host, browser, workflow, and minimum-macOS rows require both native
architecture records. Do not reuse a command transcript or result file across
assertions.

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

| Binding or assertion ID | Required gate | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- | --- |
| `checkout:clean` | Clean source checkout is exactly the accepted commit | UNAVAILABLE | Template not executed |
| structural | Release metadata identifies the accepted commit, version, universal target, and DMG bundle | UNAVAILABLE | Template not executed |
| structural | Final DMG filename, byte size, and post-stapling SHA-256 match this record | UNAVAILABLE | Template not executed |
| `signature:application` | Application has a valid sealed Developer ID signature | UNAVAILABLE | Template not executed |
| `signature:dmg` | DMG has a valid Developer ID signature | UNAVAILABLE | Template not executed |
| `signing-identity:application-and-dmg` | Public certificate subject, Team ID, and certificate SHA-256 match the approved signing identity | UNAVAILABLE | Template not executed |
| `signature:nested-code` | Nested executables and libraries satisfy strict signature verification | UNAVAILABLE | Template not executed |
| `notarization:application-and-dmg` | Apple notarization is accepted and the ticket is stapled to the app and DMG | UNAVAILABLE | Template not executed |
| `gatekeeper:application-and-dmg` | Gatekeeper accepts the DMG and application | UNAVAILABLE | Template not executed |
| `dmg:hdiutil-verify` | `hdiutil verify` accepts the final DMG | UNAVAILABLE | Template not executed |
| `architecture:universal` | Application executable contains native `arm64` and `x86_64` slices | UNAVAILABLE | Template not executed |
| `package:release-inputs` | Packaged Field Theory, private Node runtimes, licenses, and notices match the release inputs | UNAVAILABLE | Template not executed |
| `package:no-python-or-browser-gui` | Packaged resources contain no Python runtime or browser GUI | UNAVAILABLE | Template not executed |

The machine IDs for these non-structural rows are
`signature:application`, `signature:dmg`,
`signing-identity:application-and-dmg`, `signature:nested-code`,
`notarization:application-and-dmg`,
`gatekeeper:application-and-dmg`, `dmg:hdiutil-verify`,
`architecture:universal`, `package:release-inputs`, and
`package:no-python-or-browser-gui`.
The clean-checkout audit record is `checkout:clean`; release metadata and final
artifact identity remain structural bindings enforced directly by the
finalizer.

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

| Assertion ID and host gate | Apple Silicon status and evidence | Native Intel status and evidence |
| --- | --- | --- |
| `host:installer-completes` — Final DMG installs with the expected Applications link | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:app-launches` — Installed app launches through Finder or LaunchServices | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:first-screen-connect-karakeep` — First screen reaches **Connect Karakeep** | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:component-versions` — App version and bundled component versions match this record | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:no-system-python` — App runs without a separately installed Python runtime | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:no-system-node` — App runs without a separately installed Node.js runtime | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:bundled-node-runtime` — Field Theory bridge executes the Node runtime inside the signed app bundle | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:no-runtime-download` — App performs no runtime or dependency download | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:fresh-state` — Fresh launch contains no previous destination, source, or delivery data | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `minimum-macos:executable-slices` — Executable slice declares the supported macOS 12.0 minimum | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |

The retained process evidence may name a bundle-relative executable such as
`Contents/Resources/resources/node/darwin-arm64/node`. It must not include the
absolute installation path or user directory.

## Supported browser matrix

Exercise an installed, already signed-in profile with explicit user consent.
Record only the browser name, architecture used for the check, aggregate
counts, and result. Never record profile names, profile paths, cookies, X
identity, bookmark content, or source URLs.

| Assertion ID and browser check | Apple Silicon status and evidence | Native Intel status and evidence |
| --- | --- | --- |
| `browser:google-chrome:discovery` — Google Chrome discovery and profile selection | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:google-chrome:x-acquisition` — Google Chrome X acquisition | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:microsoft-edge:discovery` — Microsoft Edge discovery and profile selection | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:microsoft-edge:x-acquisition` — Microsoft Edge X acquisition | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:brave:discovery` — Brave discovery and profile selection | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:brave:x-acquisition` — Brave X acquisition | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:chromium:discovery` — Chromium discovery and profile selection | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:chromium:x-acquisition` — Chromium X acquisition | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:firefox:discovery` — Firefox discovery and profile selection | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `browser:firefox:x-acquisition` — Firefox X acquisition | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |

Every browser row is required. A documented absence of an installed browser is
`UNAVAILABLE`, not `PASS`.

## X and File Source smoke transfers

Use a controlled Karakeep destination and synthetic or non-sensitive bookmark
records. Store only aggregate totals and safe assertions.

| Assertion ID and workflow check | Apple Silicon status and evidence | Native Intel status and evidence |
| --- | --- | --- |
| `workflow:https-destination-validation` — HTTPS destination validation succeeds without exposing its credential | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:x-consent-before-session` — X Source consent precedes session use | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:x-acquisition-progress-no-media` — X acquisition reports progress and completes without downloading media | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:x-folder-and-source-tags` — X folder names appear as folder tags and `twitter` appears as the source tag | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:x-transfer-preview` — X Transfer Preview reports total, pending, prior delivery, folders, and destination | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:x-delivery-result-totals` — Confirmed X delivery reports created, existing, retried, failed, and cancelled totals | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:x-repeat-delivery-preserves-content` — Repeated X delivery preserves existing Karakeep content and safely skips or completes prior delivery | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:field-theory-file-transfer` — Field Theory JSONL File Source previews in place and completes a confirmed delivery | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:chrome-netscape-file-transfer` — Chrome/Netscape File Source preserves title and folder tags through confirmed delivery | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:file-source-preserves-active-x` — File Source use does not replace the active X Source | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:cancellation-resume` — Cancellation leaves incomplete work pending and a later run can resume safely | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `workflow:evidence-sanitization` — Evidence and exported diagnostics contain no credential, X session value, bookmark content, or private path | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |

## Acceptance decision

- Required rows with `PASS`: `[count]`
- Required rows with `FAIL`: `[count]`
- Required rows with `UNAVAILABLE`: `[count]`
- Decision: `REJECTED`
- Decision evidence filename and SHA-256: `Template not executed`

Change the decision to `ACCEPTED` only when every required row is `PASS`, the
two architecture columns are complete, and the final DMG identity still
matches the record.
