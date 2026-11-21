# Retain private transfer data locally

The app will keep its bookmark snapshot and delivery ledger in the operating
system's application-data directory so later transfer runs can acquire
incrementally and resume safely. These datasets will contain neither X session
values nor API keys. The app will disclose their location and size and provide
an explicit action to delete them without affecting bookmarks already
delivered to Karakeep.
