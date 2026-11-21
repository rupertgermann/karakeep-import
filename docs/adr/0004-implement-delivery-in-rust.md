# Implement Karakeep delivery in Rust

The packaged desktop app will implement Karakeep delivery and transfer
orchestration in its Tauri Rust backend. The current Python importer remains
the behavioral reference during migration but Python will not ship in the
desktop installer. This avoids a second bundled language runtime and removes
the local HTTP server and Python subprocess from the desktop security boundary,
at the cost of proving behavioral parity during the port.
