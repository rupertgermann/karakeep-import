# Use an app-owned Field Theory bridge

The app verifies the checksum of the vendored Field Theory package. The
package includes a local patch to pause bookmark backfill on HTTP 429 and
save its progress. [Field Theory runtime notices](../../vendor/fieldtheory/THIRD_PARTY_NOTICES.md)

The app's Node bridge calls the package's acquisition modules. It sends
source discovery, acquisition progress, cancellation, results, and redacted
errors through a versioned NDJSON protocol. X session values stay out of
bridge messages.
