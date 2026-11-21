# Require signed production installers

Production macOS apps and DMGs require Developer ID signatures and
notarization. Production Windows installers and executables require
Authenticode signatures. Keep signing credentials on the release hosts.
[Signed release acceptance](../release-acceptance/README.md)

The Apple Silicon DMG published with v0.1.1 is an explicitly approved unsigned
test build. [v0.1.1 release](https://github.com/rupertgermann/karakeep-import/releases/tag/v0.1.1)
