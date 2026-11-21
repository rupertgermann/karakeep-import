# Store Karakeep credentials in the operating system vault

The app will remember a validated Karakeep connection by storing its server URL
in ordinary app settings and its API key in macOS Keychain or Windows
Credential Manager. The key will never enter frontend storage, configuration
files, command arguments, logs, transfer state, or the Field Theory process.
Users can explicitly forget the connection, which removes the stored
credential.
