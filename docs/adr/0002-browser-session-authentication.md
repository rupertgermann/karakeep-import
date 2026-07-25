# Use browser-session authentication for X

The MVP will retrieve X bookmarks through the user's existing authenticated
browser session. The app will request permission before access and will not
persist, display, or log the extracted session values. OAuth is deferred
because it requires a separately configured X developer application, while
manual cookie entry is omitted because it would expose password-equivalent
values in the UI.
