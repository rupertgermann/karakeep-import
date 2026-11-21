# Require signed public builds

Every public macOS app and DMG will be Developer ID signed and notarized, and
every public Windows installer and executable will be Authenticode signed.
Unsigned artifacts are limited to local development and automated tests, while
release credentials remain confined to the local release environments. No
temporary unsigned public release may bypass this gate.
