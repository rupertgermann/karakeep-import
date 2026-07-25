# Record delivery only after tagging

A source bookmark enters the delivery ledger only after Karakeep has created or
confirmed the bookmark and attached every required source and folder tag. If
bookmark creation succeeds but tagging fails, the source remains pending; a
later run reuses the existing Karakeep bookmark and retries tagging. This
prevents partial delivery from being mistaken for completion.
