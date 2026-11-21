CREATE TABLE destinations (
    id INTEGER PRIMARY KEY,
    normalized_server TEXT NOT NULL,
    authenticated_user TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (normalized_server, authenticated_user)
) STRICT;

CREATE TABLE transfer_runs (
    id INTEGER PRIMARY KEY,
    destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
        status IN ('running', 'completed', 'partially_completed', 'interrupted')
    ),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    CHECK (
        (status = 'running' AND finished_at IS NULL)
        OR (status != 'running' AND finished_at IS NOT NULL)
    )
) STRICT;

CREATE TABLE delivery_attempts (
    id INTEGER PRIMARY KEY,
    transfer_run_id INTEGER NOT NULL REFERENCES transfer_runs(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_bookmark_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('created', 'existing', 'failed')),
    karakeep_bookmark_id TEXT,
    failure_stage TEXT,
    failure_code TEXT,
    attempted_at INTEGER NOT NULL,
    CHECK (
        (
            outcome IN ('created', 'existing')
            AND karakeep_bookmark_id IS NOT NULL
            AND failure_stage IS NULL
            AND failure_code IS NULL
        )
        OR (
            outcome = 'failed'
            AND karakeep_bookmark_id IS NULL
            AND failure_stage IS NOT NULL
            AND failure_code IS NOT NULL
        )
    )
) STRICT;

CREATE INDEX delivery_attempts_run
ON delivery_attempts(transfer_run_id);

CREATE INDEX delivery_attempts_bookmark
ON delivery_attempts(source, source_bookmark_id);

CREATE TABLE delivered_bookmarks (
    destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_bookmark_id TEXT NOT NULL,
    karakeep_bookmark_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('created', 'existing')),
    transfer_run_id INTEGER NOT NULL REFERENCES transfer_runs(id),
    delivered_at INTEGER NOT NULL,
    PRIMARY KEY (destination_id, source, source_bookmark_id)
) STRICT;
