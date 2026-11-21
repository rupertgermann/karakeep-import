# Use a minimal React and TypeScript frontend

The single-window frontend uses React, TypeScript, and Vite. A reducer models
the transfer workflow. The frontend communicates with the Rust backend through
typed Tauri commands and events.

CSS defines the app's visual style. The shared dropdown uses Base UI Select
for its menu and keyboard behavior. [Dropdown component](../../src/Dropdown.tsx)
