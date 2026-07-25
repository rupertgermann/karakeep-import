# Use capability-based Karakeep compatibility

Karakeep v0.32.0 is the first tested delivery baseline, but the app will decide
compatibility from the required authenticated API contract rather than an exact
version string. Connection setup will perform non-mutating capability checks,
accept compatible newer instances, and explain which capability is missing
when rejecting an older or divergent instance. Contract tests will track every
release the app claims to support.
