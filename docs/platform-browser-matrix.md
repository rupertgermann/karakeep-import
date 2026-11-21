# Platform browser matrix

Status: automated fixture evidence only. Native browser-session evidence is
unavailable.

Karakeep Transfer supports Google Chrome, Microsoft Edge, Brave, Chromium, and
Firefox in that stable UI order. The runtime roots below come from the pinned
Field Theory 1.3.22 package at commit
`4b4a0f677e7077ac76848408b22091fc34330391`, recorded in
[`vendor/fieldtheory/manifest.json`](../vendor/fieldtheory/manifest.json).
Field Theory resolves each value relative to the operating-system home
directory.

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

## Automated fixture evidence

[`fieldtheory-bridge/test/source-discovery.test.mjs`](../fieldtheory-bridge/test/source-discovery.test.mjs)
exercises the public `discoverSources` seam:

- Given representative `Default` and numbered Chromium profile directories for
  Chrome, Edge, Brave, and Chromium, plus relative Firefox profiles declared in
  `profiles.ini`;
- when discovery runs with those roots and an unsupported Safari fixture;
- then only the five supported browsers are returned, in the stable UI order
  above, with their profile IDs and display names.

Run:

```bash
node --test fieldtheory-bridge/test/source-discovery.test.mjs
```

This fixture proves the application allowlist, profile parsing, unsupported
browser exclusion, and result order. It injects temporary roots, so it does not
prove that a native installation resolves the pinned macOS or Windows roots,
can access a real browser profile, or can acquire bookmarks through a real X
session.

## Native evidence

| Platform | Chrome | Edge | Brave | Chromium | Firefox |
| --- | --- | --- | --- | --- | --- |
| macOS 12 or newer | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE |
| Windows 10 version 1803 or newer, x64 | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE |
| Windows 11, x64 | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE |

Every `UNAVAILABLE` entry requires a controlled native run with the browser
installed and signed into X. Retain, without X session values:

1. the Karakeep Transfer commit, signed artifact SHA-256, OS version/build, and
   browser version;
2. whether the browser and intended profile appeared in the UI;
3. whether explicit consent led to successful bookmark and folder acquisition;
4. the resulting bookmark/folder totals or the redacted compatibility failure;
5. references to the retained screenshot and redacted diagnostic evidence.

The automated fixture must not be used to mark the real browser-session or
native macOS/Windows acceptance criteria in GitHub issues #16 and #17 as
passed.
