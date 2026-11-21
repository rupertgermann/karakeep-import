# Bundle a pinned Field Theory runtime

The desktop app bundles a pinned Field Theory package, its dependencies, and
a private Node.js runtime. Tauri starts the bundled Node executable directly.
On Windows, the bridge prepends the bundled SQLite directory to its child
process `PATH` for Chromium cookie access. [Runtime configuration](../../fieldtheory-bridge/src/runtime-environment.mjs)

Users get Field Theory updates through new app builds. Build preparation
verifies the pinned artifacts and collects the licenses. [Pinned artifacts](../../vendor/fieldtheory/manifest.json)
