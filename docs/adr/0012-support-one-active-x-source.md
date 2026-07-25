# Support one active X source

The MVP will treat one selected browser and browser profile as the active X
source because Field Theory's bookmark-cache metadata does not reliably
identify the authenticated X account. Replacing the source explicitly clears
its bookmark snapshot and acquisition state while preserving destination
delivery history. Simultaneous or automatically detected multi-account support
is outside the MVP.
