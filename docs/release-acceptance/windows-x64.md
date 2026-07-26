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
32-bit. The machine-readable schema version 3 record separately requires the
typed `application-payload:windows-x64` assertion for the installed application
and bundled runtime payload. Each required row and both Windows baseline
columns need distinct typed JSON evidence; do not reuse one transcript across
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

| Required gate | Status | Redacted evidence filename and SHA-256 |
| --- | --- | --- |
| Clean source checkout is exactly the accepted commit | UNAVAILABLE | Template not executed |
| Release metadata identifies the accepted commit, version, Windows x64 target, and NSIS bundle | UNAVAILABLE | Template not executed |
| Final installer filename, byte size, and post-signing SHA-256 match this record | UNAVAILABLE | Template not executed |
| NSIS installer has a valid Authenticode signature and trusted timestamp | UNAVAILABLE | Template not executed |
| Installed Karakeep Transfer executable has a valid Authenticode signature and trusted timestamp | UNAVAILABLE | Template not executed |
| Bundled Node executable has an approved valid signature | UNAVAILABLE | Template not executed |
| Bundled SQLite executable has an approved valid signature | UNAVAILABLE | Template not executed |
| Every other shipped PE executable passes Authenticode verification | UNAVAILABLE | Template not executed |
| Public signer subjects and certificate thumbprints match the approved signing identities | UNAVAILABLE | Template not executed |
| Windows platform verification reports a valid trust chain for the installer and installed executables | UNAVAILABLE | Template not executed |
| Packaged Field Theory, private Node runtime, SQLite helper, licenses, and notices match the release inputs | UNAVAILABLE | Template not executed |
| Packaged resources contain no Python runtime or browser GUI | UNAVAILABLE | Template not executed |

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

| Host gate | Windows 10 version 1803+ x64 | Windows 11 x64 | Redacted evidence filename and SHA-256 |
| --- | --- | --- | --- |
| Final NSIS installer completes without an unexpected warning | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Installed app launches from the Start menu | UNAVAILABLE | UNAVAILABLE | Template not executed |
| First screen reaches **Connect Karakeep** | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App version and bundled component versions match this record | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App runs without a separately installed Python runtime | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App runs without a separately installed Node.js runtime | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Field Theory bridge executes the Node runtime inside the installed app | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Chromium acquisition uses the bundled SQLite helper rather than a system executable | UNAVAILABLE | UNAVAILABLE | Template not executed |
| App performs no runtime or dependency download | UNAVAILABLE | UNAVAILABLE | Template not executed |
| Fresh launch contains no previous destination, source, or delivery data | UNAVAILABLE | UNAVAILABLE | Template not executed |

The retained process evidence may name an app-relative executable such as
`resources/node/win-x64/node.exe`. It must not include the absolute
installation path, account name, or user directory.

## Supported browser matrix

Exercise an installed, already signed-in profile with explicit user consent.
Record only the browser name, Windows version used for the check, aggregate
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

Change the decision to `ACCEPTED` only when every required row is `PASS`, both
Windows baseline columns are complete, and the final NSIS identity still
matches the record.
