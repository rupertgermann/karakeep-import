# Require secure Karakeep connections by default

Karakeep connections will use HTTPS, except that loopback HTTP is accepted for
local development and desktop-hosted instances. Other HTTP destinations are
blocked unless the user explicitly accepts a destination-specific warning for
a trusted private network. The client will not follow an HTTPS-to-HTTP
downgrade redirect. This preserves self-hosted flexibility without silently
transmitting API keys in cleartext.
