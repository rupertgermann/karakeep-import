# Split import options into source mapping and delivery tuning

The Python importer `karakeep-import.py` exposes one flat list of command line
options. The MVP specification previously reserved all of them to the app. That
sentence forbade options that change what lands in a person's Karakeep library,
not only options that change throughput, so it is replaced by two tiers.

**Source mapping options** change what lands in Karakeep, are meaningful to the
person confirming the transfer, and belong on the Transfer Review screen next to
the confirm action, scoped to a single transfer run:

- extra tags applied to every record (`--tag`);
- suppress the source default tags (`--no-default-tags`);
- suppress export-carried tags, meaning Field Theory `tags` values and Chrome
  folder names (`--no-export-tags`);
- omit source titles (`--no-titles`);
- omit source notes (`--no-notes`);
- choose the source timestamp field for `createdAt` (`--timestamp-field`);
- cap the run at the first N pending records (`--limit`).

Because the preview is the approved snapshot that delivery replays, changing a
source mapping option re-previews and invalidates the previous approval.

**Delivery tuning options** change throughput rather than content, are already
implemented, and belong in an advanced Settings section that persists across
restarts and applies to the next run started after a change:

- worker count (`--workers`);
- requests per second (`--requests-per-second`);
- request timeout (`--timeout`);
- maximum retries (`--max-retries`).

The app keeps the default request timeout at 20 seconds rather than adopting the
script's 30, so that a person who changes nothing sees no change in behavior. The
script's value remains reachable through the setting.

**App-owned behavior** stays out of the user interface entirely:

- the delivery ledger and snapshot paths, because the app owns its private
  application-data layout and offers **Delete local transfer data** instead;
- retry backoff shape, because only the retry ceiling is user-meaningful;
- the mapping rules that compose a title, a note, and a tag list from a record,
  because their structure is a delivery contract rather than a preference.

**Superseded script options** are intentionally unsupported:

- `--state-file` and `--failure-file`, replaced by the SQLite delivery ledger;
- `--progress-every`, replaced by the typed delivery event stream;
- `--api-key-env`, replaced by the native credential vault;
- `--execute`, replaced by preview-then-confirm.
