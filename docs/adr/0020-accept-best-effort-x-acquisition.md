# Accept best-effort X acquisition

The app will use Field Theory's browser-session mode even though it depends on
X's internal GraphQL API and can break when X changes private behavior. The
product will identify itself as unaffiliated with X and Field Theory, will not
promise permanent acquisition compatibility, and will preserve existing
bookmark snapshots when new acquisition fails. A dedicated compatibility error
will explain when an app update may be required.
