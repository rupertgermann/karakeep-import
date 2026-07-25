# Scope delivery history by destination

The app will remember one active Karakeep connection at a time, while
partitioning delivery history by normalized server identity and authenticated
Karakeep user. Replacing an API key for the same destination does not make
bookmarks eligible again, but changing destination does. Previous destination
ledgers remain available for safe resume if the user later switches back; the
MVP will not expose simultaneous destination profiles.
