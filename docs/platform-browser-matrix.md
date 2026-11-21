# Platform browser matrix

Karakeep Transfer lists supported browsers in the order below. The pinned
Field Theory package resolves each profile root relative to the operating
system's home directory.
[Field Theory version and commit](../vendor/fieldtheory/manifest.json)

## Pinned browser roots

| UI order | Browser ID | macOS root below `$HOME` | Windows root below `%USERPROFILE%` |
| ---: | --- | --- | --- |
| 1 | `chrome` | `Library/Application Support/Google/Chrome` | `AppData\Local\Google\Chrome\User Data` |
| 2 | `edge` | `Library/Application Support/Microsoft Edge` | `AppData\Local\Microsoft\Edge\User Data` |
| 3 | `brave` | `Library/Application Support/BraveSoftware/Brave-Browser` | `AppData\Local\BraveSoftware\Brave-Browser\User Data` |
| 4 | `chromium` | `Library/Application Support/Chromium` | `AppData\Local\Chromium\User Data` |
| 5 | `firefox` | `Library/Application Support/Firefox` | `AppData\Roaming\Mozilla\Firefox` |

The Windows paths intentionally use `%USERPROFILE%`: the pinned implementation
joins these relative values to Node's `os.homedir()` instead of resolving
`LOCALAPPDATA` or `APPDATA`.

## Profile discovery

For Chromium-based browsers, the app lists `Default` and numbered `Profile n`
directories. It uses the name in each profile's `Preferences` file when it
can read it. For Firefox, the app reads `profiles.ini` and lists readable
profiles with relative or absolute paths.

## Verify discovery and X acquisition

```bash
npm ci --prefix fieldtheory-bridge
node --test fieldtheory-bridge/test/source-discovery.test.mjs
```

The tests use temporary profile roots to verify discovery, browser order,
profile names, and consent. Use the native acceptance records to verify access
to real profiles and acquisition from signed-in X sessions for signed release
candidates. X acquisition is best-effort.
[macOS acceptance](release-acceptance/macos-arm64.md) ·
[Windows acceptance](release-acceptance/windows-x64.md)
