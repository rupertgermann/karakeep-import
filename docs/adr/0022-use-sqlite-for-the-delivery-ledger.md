# Use SQLite for the delivery ledger

Field Theory owns the JSONL bookmark snapshot. The Tauri app stores
destinations, transfer runs, delivery state, retries, and redacted failures in
SQLite. Transactions keep delivery history scoped to the destination and
mark bookmarks as delivered after their required tags attach. API keys and X
session values stay out of the ledger.

In Settings, **Delete local transfer data** clears the ledger and acquisition
data. **Export diagnostics** writes a redacted report.
