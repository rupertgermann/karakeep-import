# Record delivery only after tagging

The delivery ledger records attempts and their outcomes. It marks a bookmark
as delivered only after Karakeep confirms that the bookmark exists and has
every required tag. If a tag fails to attach, the bookmark stays pending. On
a later run, the app reuses the existing bookmark and retries the missing tags.
