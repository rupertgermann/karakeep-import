# Use SQLite for the delivery ledger

Field Theory will continue owning its JSONL bookmark snapshot, while the Tauri
app stores destinations, transfer runs, per-bookmark delivery state, retries,
and redacted failures in an app-owned SQLite database. Versioned migrations and
transactions will protect destination-scoped resume and completion-after-
tagging invariants. API keys and X session values are excluded from the
database, which remains exportable for diagnostics and deletable by the user.
