# Build release artifacts locally

All macOS and Windows release artifacts will be compiled, tested, signed, and
packaged in controlled local release environments. GitHub Actions will not
build, sign, or package releases. Reproducible local release scripts will
produce the installers, checksums, dependency notices, and release metadata
needed for publication. The completed artifacts will be uploaded manually to
GitHub Releases, the sole MVP download channel.
