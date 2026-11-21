# Build release artifacts locally

Build and package macOS and Windows installers on their native release
hosts. The local staging scripts prepare the installers' inputs, checksums,
dependency notices, and release metadata. Publish approved artifacts manually
on GitHub Releases. [Local release inputs](../local-release-inputs.md)

Production installers follow the signing and native acceptance process. The
v0.1.1 Apple Silicon test DMG also came from a local build. [Signing decision](0018-require-signed-public-builds.md)
