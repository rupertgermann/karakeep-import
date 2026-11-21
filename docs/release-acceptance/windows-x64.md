# Signed Windows x64 acceptance record

Use this template for one final NSIS installer and its installed application.
Run the checks on controlled native Windows hosts, retain only sanitized
evidence, and follow the status rules in [`README.md`](./README.md).

## Record identity

- Overall status: `UNAVAILABLE`
- Candidate ID: `[version]-[short commit]-windows-x64`
- Application version: `[version]`
- Accepted source commit: `[full 40-character commit]`
- Source checkout clean: `UNAVAILABLE`
- Final NSIS filename: `[filename only]`
- Final NSIS size in bytes: `[bytes]`
- Final NSIS SHA-256: `[64 lowercase hexadecimal characters]`
- Test date in UTC: `[YYYY-MM-DD]`
- Release operator role: `[role, not a personal account name]`
- Notes: `Template not executed.`

The accepted source commit and version must match the values in the staged
`RELEASE-METADATA.json`, installer metadata, and installed application.
Recompute the installer SHA-256 after Authenticode signing and timestamping.

The pinned Tauri/NSIS installer bootstrapper is a PE32 i386 executable. That is
the expected installer structure and does not make the installed application
32-bit. The machine-readable schema version 4 record separately requires the
typed `application-payload:windows-x64` assertion for the installed application
and bundled runtime payload. It contains 42 assertions and exactly 75 typed
records according to the exact assertion IDs and coverage matrix in
[`README.md`](./README.md). Host, browser, workflow, SQLite-helper, and trust
rows require both Windows baselines. Checkout, package, signing, other-PE, and
x64-payload rows are target-wide. Do not reuse one transcript across
assertions.

## Artifact and Authenticode evidence

Run verification against the final NSIS installer and every executable shipped
inside the installed application. Use PowerShell variables so retained command
excerpts contain only artifact filenames or package-relative names.

Typical native checks include:

```powershell
Get-FileHash -Algorithm SHA256 $Installer
Get-AuthenticodeSignature $Installer
Get-AuthenticodeSignature $Application
Get-AuthenticodeSignature $BundledNode
Get-AuthenticodeSignature $BundledSqlite
signtool verify /pa /all /v $Installer
signtool verify /pa /all /v $Application
signtool verify /pa /all /v $BundledNode
signtool verify /pa /all /v $BundledSqlite
```

Retain the file's package-relative name, signature status, public signer
subject, public certificate thumbprint, and timestamp result. Do not retain its
absolute installed path.

| Binding or assertion ID | Required gate | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- | --- |
| `checkout:clean` | Clean source checkout is exactly the accepted commit | UNAVAILABLE | Template not executed |
| structural | Release metadata identifies the accepted commit, version, Windows x64 target, and NSIS bundle | UNAVAILABLE | Template not executed |
| structural | Final installer filename, byte size, and post-signing SHA-256 match this record | UNAVAILABLE | Template not executed |
| `signing-identity:installer` | NSIS installer has a valid Authenticode signature, trusted timestamp, and approved public identity | UNAVAILABLE | Template not executed |
| `signing-identity:application` | Installed Karakeep Transfer executable has a valid Authenticode signature, trusted timestamp, and approved public identity | UNAVAILABLE | Template not executed |
| `signing-identity:bundled-node` | Bundled Node executable has an approved valid signature and identity | UNAVAILABLE | Template not executed |
| `signing-identity:bundled-sqlite` | Bundled SQLite executable has an approved valid signature and identity | UNAVAILABLE | Template not executed |
| `signature:other-shipped-pe` | Every other shipped PE executable passes Authenticode verification, including a zero-extra inventory | UNAVAILABLE | Template not executed |
| `application-payload:windows-x64` | Installed application and bundled runtime payload are x64 | UNAVAILABLE | Template not executed |
| `package:release-inputs` | Packaged Field Theory, private Node runtime, SQLite helper, licenses, and notices match the release inputs | UNAVAILABLE | Template not executed |
| `package:no-python-or-browser-gui` | Packaged resources contain no Python runtime or browser GUI | UNAVAILABLE | Template not executed |

The target-wide machine IDs for the executable checks are
`signing-identity:installer`, `signing-identity:application`,
`signing-identity:bundled-node`, `signing-identity:bundled-sqlite`,
`signature:other-shipped-pe`, and
`application-payload:windows-x64`. Package checks use
`package:release-inputs` and `package:no-python-or-browser-gui`; clean checkout
uses `checkout:clean`. Release metadata and final artifact identity remain
structural bindings enforced directly by the finalizer.

The signing identity set is exact: installer, application, bundled Node, and
bundled SQLite. The `signature:other-shipped-pe` row is still required when the
candidate contains no additional PE executable; retain a package-relative PE
inventory showing the zero-extra result.

Record each public signing identity here:

| Package-relative executable | Public certificate subject | Public thumbprint | Trusted timestamp |
| --- | --- | --- | --- |
| NSIS installer | `[public subject]` | `[public thumbprint]` | UNAVAILABLE |
| Karakeep Transfer executable | `[public subject]` | `[public thumbprint]` | UNAVAILABLE |
| Bundled Node executable | `[public subject]` | `[public thumbprint]` | UNAVAILABLE |
| Bundled SQLite executable | `[public subject]` | `[public thumbprint]` | UNAVAILABLE |

Never record a certificate-store private-key reference, PFX filename or path,
PFX password, account name, or timestamping credential.

## Clean installation and operating-system baseline

Use clean supported hosts or clean virtual-machine snapshots. Do not reuse a
machine that already contains application data or a prior Karakeep Transfer
installation.

| Assertion ID and host gate | Windows 10 status and evidence | Windows 11 status and evidence |
| --- | --- | --- |
| `host:installer-completes` — Final NSIS installer completes without an unexpected warning | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:app-launches` — Installed app launches from the Start menu | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:first-screen-connect-karakeep` — First screen reaches **Connect Karakeep** | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:component-versions` — App version and bundled component versions match this record | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:no-system-python` — App runs without a separately installed Python runtime | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:no-system-node` — App runs without a separately installed Node.js runtime | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:bundled-node-runtime` — Field Theory bridge executes the Node runtime inside the installed app | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:bundled-sqlite-helper` — Chromium acquisition uses the bundled SQLite helper rather than a system executable | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:no-runtime-download` — App performs no runtime or dependency download | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `host:fresh-state` — Fresh launch contains no previous destination, source, or delivery data | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |
| `authenticode:platform-trust` — Platform verification reports a valid trust chain for the installer and installed executables | UNAVAILABLE — Template not executed | UNAVAILABLE — Template not executed |

The retained process evidence may name an app-relative executable such as
`resources/node/win-x64/node.exe`. It must not include the absolute
installation path, account name, or user directory.

## Supported browser matrix

Exercise an installed, already signed-in profile with explicit user consent.
Record only the browser name, Windows version used for the check, aggregate
counts, and result. Never record profile names, profile paths, cookies, X
identity, bookmark content, or source URLs.

| Assertion ID and browser check | Windows 10 status and evidence | Windows 11 status and evidence |
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

| Assertion ID and workflow check | Windows 10 status and evidence | Windows 11 status and evidence |
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

Change the decision to `ACCEPTED` only when every required row is `PASS`, both
Windows baseline columns are complete, and the final NSIS identity still
matches the record.
