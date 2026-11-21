# Split transfer options into source mapping and delivery tuning

The transfer review shows the options that affect the current run. Choose
extra tags, source and export tags, titles, notes, a creation-date field, and
a limit on pending bookmarks. Changing a mapping option refreshes the preview
and invalidates the previous approval. Delivery uses the mapping options from
the confirmed preview.

Advanced delivery tuning in Settings controls the worker count, requests per
second, request timeout, and maximum retries. Saved options persist across
restarts and apply to the next transfer. The default request timeout is 20
seconds.

The app owns the paths for the snapshot and ledger, the retry backoff, and
the rules that compose titles, notes, and tags from a source record.
