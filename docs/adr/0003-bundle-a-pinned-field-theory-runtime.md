# Bundle a pinned Field Theory runtime

Each desktop release will contain one exact Field Theory CLI version, its
dependencies, and a private Node.js runtime. Tauri will invoke that package as
an internal sidecar without depending on a system Node installation or
modifying `PATH`. Field Theory upgrades will arrive only through new signed app
releases, with the upstream version and MIT license recorded in the
distribution; runtime downloads and self-updates are deliberately excluded.
