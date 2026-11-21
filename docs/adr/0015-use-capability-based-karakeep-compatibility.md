# Use capability-based Karakeep compatibility

Karakeep v0.32.0 is the first tested delivery baseline, but the app will decide
compatibility from the required authenticated API contract rather than an exact
version string. Connection setup performs only these authenticated,
non-mutating checks:

- `GET /api/v1/users/me` verifies authentication and returns the stable
  destination identity used to partition delivery history.
- `GET /api/v1/bookmarks?limit=1&includeContent=false` verifies the bookmark
  listing contract without fetching bookmark content.

For a granular Karakeep v0.32 API key, connection therefore requires
`users:read` and bookmark read access; `bookmarks:readwrite` supplies the latter
and is also required for delivery. A full-access key satisfies both.

Karakeep v0.32 does not expose the current API key's scopes through a
non-mutating REST endpoint. Consequently, connection setup cannot distinguish a
`bookmarks:read` key from a `bookmarks:readwrite` key. Bookmark creation and tag
attachment capability are proven by the first real delivery. A scope failure is
reported as a delivery failure, and the bookmark is not recorded as delivered
until both the bookmark and all required tags exist.

Compatible newer instances are allowed. Authentication failures and missing or
divergent checked endpoints fail closed with a specific connection error.
Contract tests track every release the app claims to support.
