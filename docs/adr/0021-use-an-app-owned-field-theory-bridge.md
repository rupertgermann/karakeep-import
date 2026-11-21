# Use an app-owned Field Theory bridge

The bundled Field Theory package will remain an unchanged, checksum-verified
upstream release. An app-owned Node bridge will call the pinned package's
acquisition modules and expose a versioned NDJSON protocol for source
discovery, acquisition progress, cancellation, results, and redacted errors.
Tauri will not parse human CLI output, and bridge messages will never contain X
session values. Contract tests tie each bridge release to the exact bundled
Field Theory version.
