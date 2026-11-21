# Implement Karakeep delivery in Rust

The packaged desktop app implements Karakeep delivery and transfer orchestration
in its Tauri Rust backend. The original Python importer served as the behavioral
reference during migration. Implementing delivery in Rust avoids bundling a
second language runtime and removes the local HTTP server and Python subprocess
from the desktop security boundary.
