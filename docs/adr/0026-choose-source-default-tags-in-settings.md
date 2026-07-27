# Choose source default tags in Settings

The Python importer attaches two default tags to every Field Theory record,
`twitter` and `fieldtheory`, and one, `chrome`, to every Chrome record. ADR 0008
decided that `fieldtheory` is implementation plumbing and is never attached.
Parity with the script does not by itself justify writing an internal name into
a person's library, but neither does the app own the question: which marker tags
belong in a library is the library owner's preference.

Settings therefore carries the set of source default tags. A person selects
which of `twitter`, `fieldtheory`, and `chrome` a transfer attaches. **No default
tag is selected out of the box**, so a transfer attaches only the tags the export
itself carries plus any extra tags chosen for that run, and a person who wants a
source marker opts into it.

This supersedes ADR 0008 on the tag list only. Folder mapping, case-insensitive
deduplication, additive tagging, and recording a delivery only after every
required tag has attached are unchanged.

The Transfer Review option that suppresses source default tags remains, scoped to
one run: Settings decides which default tags exist, and the review screen decides
whether this particular run attaches them.
