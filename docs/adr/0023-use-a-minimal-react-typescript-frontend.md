# Use a minimal React and TypeScript frontend

The Tauri frontend will use React, TypeScript, and Vite with one explicit
reducer modeling setup, acquisition, preview, delivery, and results. It will
communicate through typed Tauri commands and events, reuse the current visual
design in plain CSS, and avoid a router, global state library, utility-CSS
framework, and component kit until the single-window workflow demonstrates a
real need for them.
