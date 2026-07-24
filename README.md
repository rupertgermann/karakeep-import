# Bookmark exports → Karakeep importer

This importer copies bookmarks from either
[Field Theory CLI](https://github.com/afar1/fieldtheory-cli) JSONL or a
Chrome/Netscape bookmarks HTML export into Karakeep. It uses Python's standard
library and has no third-party dependencies. Use it from the command line or
through its local browser-based graphical interface.

The importer:

- auto-detects Field Theory JSONL and Chrome bookmarks HTML inputs;
- validates source IDs, URLs, and duplicate records before contacting Karakeep;
- creates one Karakeep **link bookmark** for each source URL;
- preserves Chrome titles and folder paths;
- derives Field Theory titles from the author and tweet text;
- keeps source-specific content and metadata in the bookmark note;
- preserves the source timestamp as Karakeep's creation date;
- attaches source, export, folder, and command-line tags;
- authenticates against Karakeep before starting a live import;
- limits total API request throughput across concurrent workers;
- retries rate limits, temporary server errors, timeouts, and network errors;
- records completed records in an append-only state file so a run can be safely
  resumed.

Karakeep handles duplicate bookmark URLs. A duplicate returned by Karakeep is
tagged and recorded as complete in the same way as a newly created bookmark.

For Field Theory records, the importer does not upload files from
`~/.ft-bookmarks/media`. Karakeep crawls each link independently. The preserved
note keeps the original tweet content searchable when X does not provide useful
page content to Karakeep's crawler.

## Requirements

- Python 3.10 or later;
- a Field Theory JSONL export, by default
  `~/.ft-bookmarks/bookmarks.jsonl`, or a Chrome bookmarks HTML export;
- a Karakeep API key for live imports.

Run all examples from the repository root:

```bash
cd karakeep-bookmark-importer
```

## Use the graphical interface

The GUI runs on current macOS, Windows, and Linux desktop systems with Python
3.10 or later and a modern browser. It does not require Tk, Qt, Node.js, or
another GUI toolkit.

On macOS or Linux, start it from the repository root:

```bash
python3 karakeep-import-gui.py
```

On Windows, use the Python launcher:

```powershell
py karakeep-import-gui.py
```

The command binds an available port on `127.0.0.1`, prints the local URL, and
attempts to open the default browser. If the browser does not open, copy the
printed URL into it. Use `--no-browser` when you only want the URL printed.
The server is available only from the same computer and uses a per-run request
token to reject requests that did not originate from its page.

Choose a Field Theory JSONL or Chrome bookmarks HTML file, or leave the default
Field Theory path in place. Every command-line import option has a corresponding
control in the form. Extra tags are entered one per line.

Start with **Preview import**. Preview validates the export and streams the same
summary as the CLI without contacting Karakeep. Check the detected format,
record count, tags, timestamp count, and target API before continuing.

For a live run:

1. Enter the Karakeep server and execution settings.
2. Enter the API key in the masked field, or leave it blank to inherit the
   configured environment variable.
3. Select **Import live** and confirm the warning.

An API key entered in the GUI is passed only through the importer child
process's environment. It is not placed in command arguments, URLs, state
files, or output, and it is not persisted. State and failure logs retain the
same append-only resume and retry behavior documented below for the CLI.

The GUI disables its controls during a run and streams progress into the output
panel. A success or failure status appears when the importer exits. Stop the
terminal process with Ctrl+C when you are finished; closing the browser page
alone does not stop the local server.

## Preview an import

The default mode is a dry run. It validates and summarizes the input without an
API key and without sending data to Karakeep:

```bash
python3 karakeep-import.py
```

The summary reports the current input size, records already completed in the
state file, records pending in this run, usable timestamps, archived-media
references, static tags, and the normalized target API URL. Dry runs respect
selection and payload options such as `--limit`, `--timestamp-field`, and
`--tag`.

Use a different Field Theory export with `--input`:

```bash
python3 karakeep-import.py --input /path/to/bookmarks.jsonl
```

## Import Chrome bookmarks

Pass the exported HTML file to `--input`. The filename extension and Netscape
bookmark header identify it as a Chrome export:

```bash
python3 karakeep-import.py --input bookmarks_24.07.26.html
```

The dry run reports the bookmark count and usable source timestamps. Perform a
limited live import, inspect it in Karakeep, and then process the remainder:

```bash
python3 karakeep-import.py \
  --input bookmarks_24.07.26.html \
  --execute \
  --limit 10

python3 karakeep-import.py \
  --input bookmarks_24.07.26.html \
  --execute
```

Chrome bookmark titles are preserved. `ADD_DATE` becomes Karakeep's
`createdAt`, the folder path is written to the note, and every folder name is
attached as a human tag alongside the source tag `chrome`. A
`view-source:https://…` entry is imported using its underlying HTTPS URL.

Use `--input-format chrome` when an HTML export has an ambiguous filename:

```bash
python3 karakeep-import.py \
  --input /path/to/bookmarks-export \
  --input-format chrome
```

## Configure Karakeep

The default Karakeep server is the reserved placeholder
`https://karakeep.example.com`. Set `--server` to your own server root,
dashboard URL, or `/api/v1` URL; the importer normalizes it to the API base:

```bash
python3 karakeep-import.py \
  --server https://karakeep.example.com/dashboard/bookmarks
```

The `KARAKEEP_SERVER_ADDR` environment variable supplies the default for
`--server`:

```bash
export KARAKEEP_SERVER_ADDR=https://karakeep.example.com
```

For a live import, create an API key under **Settings → API Keys** in Karakeep.
Keep it out of command history and files:

```bash
read -s KARAKEEP_API_KEY
export KARAKEEP_API_KEY
```

Paste the key at the silent prompt and press Return. The importer reads
`KARAKEEP_API_KEY` only from the current process environment. Use
`--api-key-env` when the key is stored under another environment-variable name.

## Run an import

Start with a limited batch:

```bash
python3 karakeep-import.py --execute --limit 10
```

Inspect the results in Karakeep, then process all remaining records:

```bash
python3 karakeep-import.py --execute
```

The importer performs an authentication preflight and then processes records
with four workers. The process-wide default rate limit is four API requests per
second. A tagged bookmark normally uses one request to create or retrieve the
bookmark and one request to attach tags; Karakeep's separate background
crawling continues after the import finishes.

Progress is printed after the first completed record and every 25 completed
records thereafter. A successful run prints totals for created, existing, and
failed bookmarks.

## Resume and retry

Successful records are appended to `.karakeep-import-state.jsonl`. Subsequent
runs skip source IDs marked `complete`, including records completed by a
limited batch:

```bash
python3 karakeep-import.py --execute
```

A record is marked complete only after its tags have been attached. Interrupted
or incomplete records are therefore retried on the next run. Failure details
are appended to `.karakeep-import-errors.jsonl`, and a run containing any
failed records exits with status 1.

Both paths are configurable:

```bash
python3 karakeep-import.py --execute \
  --state-file var/import-state.jsonl \
  --failure-file var/import-errors.jsonl
```

State and failure files are append-only. Keep the state file to preserve resume
behavior. Removing it makes every source record eligible for processing again,
while Karakeep's URL deduplication still prevents duplicate link bookmarks.

## Bookmark mapping

| Karakeep field | Field Theory JSONL | Chrome bookmarks HTML |
| --- | --- | --- |
| `type` | `link` | `link` |
| `url` | Record `url` | Anchor `HREF`; a `view-source:` prefix is removed |
| `title` | Author name/handle plus a tweet excerpt, limited to 300 characters | Anchor text, limited to 300 characters |
| `note` | Tweet text, available metadata, quoted tweet text, and import marker | Folder path, `ADD_DATE`, and import marker |
| `createdAt` | Parsed `postedAt` | Parsed Unix `ADD_DATE` |
| `crawlPriority` | `low` | `low` |
| `source` | `import` | `import` |
| default tags | `twitter`, `fieldtheory` | `chrome` |
| export tags | Field Theory `tags` values | Every folder in the bookmark path |

All tags are attached as human tags and deduplicated case-insensitively.
Chrome entries must resolve to an HTTP or HTTPS URL.

The default `--timestamp-field source` selects `postedAt` for Field Theory and
`addedAt` for Chrome. Missing or unparseable timestamps are omitted, so
Karakeep uses its normal creation time. `bookmarkedAt` can be selected when a
Field Theory export contains it:

```bash
python3 karakeep-import.py --execute \
  --timestamp-field bookmarkedAt
```

Use the import time for every bookmark by omitting `createdAt`:

```bash
python3 karakeep-import.py --execute --timestamp-field none
```

## Command-line reference

```text
-h, --help
    Show the command help and exit.

--input PATH
    Field Theory JSONL or Chrome bookmarks HTML input file.
    Default: ~/.ft-bookmarks/bookmarks.jsonl

--input-format {auto,fieldtheory,chrome}
    Input format. Auto detects the filename extension and content header.
    Default: auto

--server URL
    Karakeep root, dashboard, or /api/v1 URL.
    Default: KARAKEEP_SERVER_ADDR, or
    https://karakeep.example.com when the variable is unset.

--execute
    Perform the live import. Without this flag the command is a dry run.

--api-key-env NAME
    Name of the environment variable containing the Karakeep API key.
    Default: KARAKEEP_API_KEY

--tag NAME
    Attach an additional static tag. Repeat the option for multiple tags.

--no-default-tags
    Omit source tags: twitter and fieldtheory, or chrome.

--no-export-tags
    Ignore Field Theory tags and Chrome folder names.

--no-titles
    Omit source titles and let Karakeep obtain titles by crawling.

--no-notes
    Omit source content and metadata from bookmark notes.

--timestamp-field {source,postedAt,bookmarkedAt,addedAt,none}
    Source timestamp field to store as Karakeep createdAt.
    Default: source

--workers N
    Number of concurrently processed records.
    Default: 4

--requests-per-second N
    Process-wide API request rate limit shared by all workers.
    Default: 4

--timeout SECONDS
    Timeout for each API request.
    Default: 30

--max-retries N
    Maximum retries after the initial attempt for each retryable API request.
    Default: 5

--limit N
    Process only the first N pending records.

--state-file PATH
    Append-only completed-record log used for resume behavior.
    Default: .karakeep-import-state.jsonl

--failure-file PATH
    Append-only failed-record log.
    Default: .karakeep-import-errors.jsonl

--progress-every N
    Print progress after every N completed records, in addition to the first.
    Default: 25
```

`--workers`, `--requests-per-second`, `--timeout`, `--limit`, and
`--progress-every` must be greater than zero. `--max-retries` accepts zero or a
positive integer.

See the same reference from the command:

```bash
python3 karakeep-import.py --help
```

## Verify the importer

The test suite uses a local fake Karakeep server and never contacts the live
instance:

```bash
python3 -m unittest discover -s tests -v
```
