# Prepare transfer acceptance for issue #12

Use the final signed candidate on each required platform. Run X acquisition
through a supported browser with a signed-in test account. Use the export
files for the separate File Source checks. [Native acceptance records](../README.md)

## Set up the test source and destination

1. Start from a clean installation. Use a dedicated browser profile for an X
   test account with access to bookmark folders and an empty bookmark list.
2. In **Connect Karakeep**, connect to a disposable Karakeep instance through
   a controlled test proxy with trusted HTTPS. Use an API key for the test
   instance. Keep the same destination address and account throughout the test.
3. Create posts using the text in the table. Bookmark each group when its step
   begins. Add A, C, and D to an X bookmark folder named `Release reading`
   when you bookmark them. Attach [the test image](probe-image.png) to B.

| Post text | Group | Purpose |
| --- | --- | --- |
| Release probe A | Initial | Text and folder metadata |
| Release probe B | Initial | Media present in the source post |
| Release probe C | Incremental | Link already present in Karakeep |
| Release probe D | Incremental | A transient delivery error |
| Release probe E | Pending | A permanent delivery error |
| Release probe F | Pending | Cancellation and resume |

## Run the X transfer

Start observing app and bridge traffic before acquisition. Count media transfers
separately from browser setup traffic and the destination's own crawler.

1. Bookmark A and B. Select the test browser profile and check that the app
   requires consent before **Use this X Source**. Give consent and select
   **Use this X Source**, then **Acquire X bookmarks**. Check progress and
   preview counts of two total, two pending, and zero previously delivered.
   Check that the source tag settings start unchecked. In the preview, turn
   **Attach tags from the export** off and check that the folder list clears.
   Turn it back on and keep the title and note options on. Set
   **Creation date** to **The source's own creation time**.
2. Select **Start transfer** and **Confirm transfer**. Expect two created and
   two delivered. Check source metadata, the `Release reading` tag on A,
   and the absence of source marker tags. For B, check for zero media bytes
   downloaded or uploaded by the app and bridge. Check that the destination
   receives a link bookmark.
3. Bookmark C and D. Add C's post URL to Karakeep separately with a distinct
   title, note, and human tag. Select the `twitter` source tag in **Settings**.
   Set **Maximum retries** to at least one in **Advanced delivery tuning**.
   Select **Save delivery tuning**.
   At the test proxy, return HTTP 503 once for D's bookmark creation request
   before forwarding the next attempt. Select **Choose another source** and
   reacquire. Check four total, two pending, and two previously delivered.
   Confirm delivery. Expect one existing, one created, two delivered, and one
   retried. Verify that C keeps its original title, note, and human tag. Check
   the folder and source tags on C and D, and that D appears once in Karakeep.
4. Bookmark E and reacquire. Return HTTP 400 for E's bookmark creation request
   without forwarding it to Karakeep. Expect one failed and E to stay pending.
5. Bookmark F and reacquire. Set **Workers** to one and pause the first
   pending bookmark creation request at the test proxy before forwarding it.
   Save the tuning and confirm delivery. Select **Cancel transfer** while the
   request is paused and before the timeout. Expect two cancelled. Discard
   the paused request and remove the fault rules.
   Select **Retry 2 pending** and expect E and F to reach Karakeep once each.
   Reacquire and check that the preview has zero pending.

Limit proxy rules to the intended test bookmark creation requests. Keep API
keys, request bodies, and post URLs out of logs and evidence.

## Run File Source smoke checks

1. Open [Field Theory JSONL](field-theory.jsonl) with **Use a bookmark file**.
   Expect two bookmarks. Check the first bookmark's title, note, creation
   date, and the `Synthetic export` and `Release reading` tags. Confirm
   delivery.
2. Open [Chrome bookmark export](chrome-bookmarks.html) the same way. Expect
   one bookmark with the title `Release & reference`, the creation date
   from the export, and the `Bookmarks bar` and `Release reading` tags.
   Confirm delivery.
3. Return to the X Source. Check that the browser profile and delivery
   progress are still available.

## Record the result

Record consent, progress and no-media observations, preview counts, tag
mapping, delivery totals, repeat and resume outcomes, and File Source results
under the corresponding workflow assertions in the
[native evidence matrix](../README.md#evidence-binding).
Bind each record to the signed installer's SHA-256 and the source commit.
Keep only aggregate counts and sanitized observations. Use `UNAVAILABLE`
when you cannot run a check or retain safe evidence.
