# Provide a self-contained transfer workflow

The desktop app will let a user retrieve X bookmarks and deliver them to
Karakeep without installing or operating Python, Node.js, or a command-line
tool. Requiring a separately prepared Field Theory export remains an advanced
fallback, because making it the primary path would contradict the app's
zero-terminal product promise. Transfer runs are manually started, repeatable,
and one-way; the MVP will not add a scheduler, background process, or reverse
updates from Karakeep to X.
