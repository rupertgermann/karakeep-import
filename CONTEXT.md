# Bookmark Transfer

This context covers moving a person's saved bookmarks from a source service
into their Karakeep library.

## Language

**Karakeep Transfer**:
The unofficial community desktop application that performs bookmark transfers
to Karakeep.
_Avoid_: Karakeep Importer, Field Theory app

**Transfer**:
A user-initiated, end-to-end movement of bookmarks from a source service into
Karakeep, including both retrieval and delivery.
_Avoid_: Sync, import

**Transfer Run**:
A single, manually started attempt to transfer eligible bookmarks in one
direction from a source service to Karakeep.
_Avoid_: Background sync, two-way sync

**Transfer Preview**:
A read-only summary of the bookmarks eligible for a transfer run, their
organization, prior delivery status, and destination.
_Avoid_: Dry run, simulation

**Acquisition**:
The part of a transfer run that retrieves bookmarks from the source service.
_Avoid_: Sync

**Delivery**:
The part of a transfer run that sends acquired bookmarks and their preserved
metadata to Karakeep.
_Avoid_: Import

**Karakeep Connection**:
A validated pairing of a Karakeep server and the credential that authorizes
delivery to it.
_Avoid_: Karakeep account, login

**Destination**:
The Karakeep server and authenticated user whose library receives delivered
bookmarks.
_Avoid_: Server, API key

**Compatible Destination**:
A destination that authenticates successfully and provides the Karakeep API
capabilities required for delivery.
_Avoid_: Supported version

**Bookmark Snapshot**:
The private local collection of source bookmarks available for current and
future transfer runs.
_Avoid_: Export file, backup

**Bookmark Record**:
A source bookmark's address and descriptive metadata, excluding copied image
and video binaries.
_Avoid_: Media archive

**Source Tag**:
A Karakeep human tag identifying the source service of a transferred bookmark.
The library owner chooses which source tags a transfer can attach.

**Folder Tag**:
A Karakeep human tag that preserves an X bookmark's folder membership using the
folder's visible name.
_Avoid_: Category, collection

**Existing Bookmark**:
A bookmark already present in Karakeep for the same source URL before delivery.
Its user-owned content is preserved.
_Avoid_: Duplicate bookmark

**Delivered Bookmark**:
A source bookmark that exists in Karakeep with every required source and folder
tag attached.
_Avoid_: Created bookmark, partially delivered bookmark

**Delivery Ledger**:
The private local record of transfer runs, delivery attempts, and completed
deliveries, used to resume and repeat transfer runs safely.
_Avoid_: Import log, bookmark database

**X Session**:
A user's existing authenticated X browser state, used temporarily to retrieve
bookmarks during a transfer run.
_Avoid_: X password, stored login

**X Source**:
The one browser and browser profile designated as the active origin of X
bookmarks.
_Avoid_: X account, browser session

**File Source**:
A user-selected Field Theory JSONL or Chrome bookmarks file used for one
transfer run without changing the active X source.
_Avoid_: Uploaded file, saved source
