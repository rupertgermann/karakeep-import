# Native release acceptance

This directory defines the evidence required to accept and publish a Karakeep
Transfer desktop release. Deterministic release inputs are necessary, but they
do not prove that a signed installer works on a supported operating system.

Use the records in this order:

1. [`macos-universal.md`](./macos-universal.md) for the signed and notarized
   universal macOS candidate.
2. [`windows-x64.md`](./windows-x64.md) for the signed Windows x64 candidate.
3. [`publication.md`](./publication.md) only after both native records are
   accepted and the publication source satisfies its source-contraction gate.

Copy each template to a versioned Markdown record in this directory. Name
supporting files with the release version, platform, and a neutral evidence
label. Evidence filenames must not contain a user name, browser profile, local
path, server address, or source-account identity.

## Status vocabulary

Every evidence row uses exactly one of these statuses:

- `PASS`: the stated check ran against the recorded candidate and its retained,
  redacted evidence supports the result.
- `FAIL`: the check ran and the candidate did not satisfy it.
- `UNAVAILABLE`: the check did not run or its evidence cannot be retained.

`UNAVAILABLE` is not a weaker form of `PASS`. A candidate is accepted only when
every required row is `PASS`. Any `FAIL` or `UNAVAILABLE` result keeps the
candidate out of publication.

The templates start as `UNAVAILABLE` so an unexecuted record cannot look
accepted. Replace a status only after recording the evidence reference and its
SHA-256.

## Evidence binding

Every platform and publication record must identify:

- one full 40-character accepted Git commit;
- one application version;
- the clean source state used for the build;
- each exact artifact filename, byte size, and SHA-256 computed after all
  signing, notarization, stapling, or timestamping steps;
- the public signing certificate subject and stable public identifier;
- the native operating-system and architecture used for each check;
- the release metadata, dependency inventory, notices, and release notes that
  accompany the candidate.

Do not substitute an unsigned staging-input checksum for a final artifact
checksum. If signing or notarization changes an artifact, compute and retain a
new SHA-256.

Each retained evidence reference consists of a neutral filename and SHA-256.
Do not record an absolute path. The evidence file must contain only the
sanitized command excerpt or result needed to support its row.

## Confidentiality

Acceptance evidence is safe to publish with the release. It must not contain:

- Karakeep API keys, X cookies, authorization headers, passwords, signing
  private keys, certificate passwords, or notarization credentials;
- browser profile names or paths, home directories, temporary directories,
  machine names, account names, email addresses, or private server addresses;
- bookmark URLs, titles, notes, X account identity, or other bookmark content;
- raw process environments, request bodies, diagnostics containing content, or
  unreviewed command output.

Public certificate subjects, Apple Team IDs, and Authenticode certificate
thumbprints are required signing evidence and are not secret. Obtain secrets
from the controlled platform credential store; never pass them in a command
argument or copy them into a record.

If output cannot be sanitized without weakening the evidence, mark the row
`UNAVAILABLE`. Do not retain sensitive output merely to turn a gate green.

## Candidate rejection

Stop acceptance immediately when the source commit, version, artifact digest,
or signing identity changes. A changed artifact is a new candidate and needs a
complete native record. Record failures honestly; do not edit a failed record
into a passing record without identifying the replacement candidate.
