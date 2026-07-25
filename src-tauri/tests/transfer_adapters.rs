use std::sync::{Arc, Mutex};

pub use karakeep_transfer_lib::{delivery, domain, file_source, karakeep, ledger};

#[path = "../src/transfer.rs"]
mod transfer;

use delivery::{
    DeliveryLedger as DeliveryLedgerContract, DeliverySource, LedgerStatus, PendingDelivery,
};
use domain::{
    BookmarkKey, DeliveryAttempt, DeliveryOutcome, DestinationIdentity, RunStatus, TimestampMillis,
};
use file_source::{FileSourcePreview, ResolvedFileSourceFormat};
use karakeep::{BookmarkDraft, BookmarkOrigin};
use ledger::DeliveryLedger;
use tempfile::tempdir;
use transfer::{
    FileDeliverySource, SharedSqliteLedger, SqliteDeliveryLedgerAdapter, preview_delivery_counts,
};

fn destination(server: &str, user: &str) -> DestinationIdentity {
    DestinationIdentity::new(server, user).expect("valid destination")
}

fn bookmark(source: &str, identifier: &str) -> BookmarkKey {
    BookmarkKey::new(source, identifier).expect("valid bookmark")
}

fn field_theory_preview() -> FileSourcePreview {
    FileSourcePreview {
        format: ResolvedFileSourceFormat::FieldTheoryJsonl,
        bookmarks: vec![
            karakeep_transfer_lib::bookmark::BookmarkPreview {
                source_id: "tweet-1".into(),
                url: "https://x.com/example/status/1".into(),
                title: "Saved post".into(),
                note: "Post text\nAuthor: Example".into(),
                created_at: Some("2024-01-02T03:04:05Z".into()),
                tags: vec!["twitter".into(), "Reading".into()],
                folders: vec!["Reading".into()],
            },
            karakeep_transfer_lib::bookmark::BookmarkPreview {
                source_id: "tweet-2".into(),
                url: "https://x.com/example/status/2".into(),
                title: "Another post".into(),
                note: String::new(),
                created_at: None,
                tags: vec!["twitter".into()],
                folders: Vec::new(),
            },
        ],
    }
}

#[test]
fn file_source_preview_maps_to_delivery_records_without_losing_metadata() {
    let source = FileDeliverySource::from_preview(&field_theory_preview());

    assert_eq!(
        source.records().expect("delivery records"),
        vec![
            delivery::DeliveryRecord {
                source_id: "tweet-1".into(),
                bookmark: BookmarkDraft {
                    url: "https://x.com/example/status/1".into(),
                    title: Some("Saved post".into()),
                    note: Some("Post text\nAuthor: Example".into()),
                    created_at: Some("2024-01-02T03:04:05Z".into()),
                },
                required_tags: vec!["twitter".into(), "Reading".into()],
            },
            delivery::DeliveryRecord {
                source_id: "tweet-2".into(),
                bookmark: BookmarkDraft {
                    url: "https://x.com/example/status/2".into(),
                    title: Some("Another post".into()),
                    note: None,
                    created_at: None,
                },
                required_tags: vec!["twitter".into()],
            },
        ]
    );
}

#[test]
fn preview_counts_are_destination_scoped_and_require_no_karakeep_client() {
    let shared = Arc::new(Mutex::new(
        DeliveryLedger::open_in_memory().expect("ledger opens"),
    ));
    let destination_a = destination("https://keep.example/one", "user-a");
    let destination_b = destination("https://keep.example/one", "user-b");
    {
        let mut ledger = shared.lock().expect("ledger lock");
        let run = ledger
            .start_run(&destination_a, TimestampMillis(1))
            .expect("run starts");
        ledger
            .record_attempt(
                run,
                &bookmark("x", "tweet-1"),
                DeliveryAttempt::Delivered {
                    karakeep_bookmark_id: "karakeep-1".into(),
                    outcome: DeliveryOutcome::Created,
                },
                TimestampMillis(2),
            )
            .expect("delivery recorded");
    }

    assert_eq!(
        (
            preview_delivery_counts(&field_theory_preview(), &shared, &destination_a)
                .expect("first destination preview"),
            preview_delivery_counts(&field_theory_preview(), &shared, &destination_b)
                .expect("second destination preview"),
        ),
        (
            transfer::TransferPreviewCounts {
                total: 2,
                pending: 1,
                previously_delivered: 1,
            },
            transfer::TransferPreviewCounts {
                total: 2,
                pending: 2,
                previously_delivered: 0,
            },
        )
    );
}

#[test]
fn chrome_preview_and_delivery_use_the_same_ledger_source() {
    let preview = FileSourcePreview {
        format: ResolvedFileSourceFormat::ChromeNetscape,
        bookmarks: vec![karakeep_transfer_lib::bookmark::BookmarkPreview {
            source_id: "https://example.com/article".into(),
            url: "https://example.com/article".into(),
            title: "Article".into(),
            note: "Chrome folder: Reading".into(),
            created_at: Some("2024-07-24T00:00:00Z".into()),
            tags: vec!["chrome".into(), "Reading".into()],
            folders: vec!["Reading".into()],
        }],
    };
    let shared = Arc::new(Mutex::new(
        DeliveryLedger::open_in_memory().expect("ledger opens"),
    ));
    let destination = destination("https://keep.example", "user-a");
    {
        let mut ledger = shared.lock().expect("ledger lock");
        let run = ledger
            .start_run(&destination, TimestampMillis(1))
            .expect("run starts");
        ledger
            .record_attempt(
                run,
                &bookmark("chrome", "https://example.com/article"),
                DeliveryAttempt::Delivered {
                    karakeep_bookmark_id: "karakeep-article".into(),
                    outcome: DeliveryOutcome::Existing,
                },
                TimestampMillis(2),
            )
            .expect("Chrome delivery recorded");
    }

    assert_eq!(
        preview_delivery_counts(&preview, &shared, &destination).expect("Chrome preview counts"),
        transfer::TransferPreviewCounts {
            total: 1,
            pending: 0,
            previously_delivered: 1,
        }
    );
}

#[test]
fn sqlite_adapter_records_retries_and_created_existing_outcomes() {
    let shared: SharedSqliteLedger = Arc::new(Mutex::new(
        DeliveryLedger::open_in_memory().expect("ledger opens"),
    ));
    let destination = destination("https://keep.example", "user-a");
    let adapter = SqliteDeliveryLedgerAdapter::start(
        Arc::clone(&shared),
        destination.clone(),
        ResolvedFileSourceFormat::FieldTheoryJsonl,
    )
    .expect("adapter starts an active run");
    let destination_id = adapter.destination_id();

    adapter
        .record_pending(
            &destination_id,
            PendingDelivery {
                source_id: "tweet-1".into(),
                bookmark_id: Some("karakeep-1".into()),
                origin: Some(BookmarkOrigin::Created),
                error: "tag delivery failed".into(),
            },
        )
        .expect("pending tagging is recorded");
    adapter
        .record_delivered(
            &destination_id,
            "tweet-1",
            "karakeep-1",
            BookmarkOrigin::Existing,
        )
        .expect("retry completion is recorded");
    adapter
        .record_delivered(
            &destination_id,
            "tweet-2",
            "karakeep-2",
            BookmarkOrigin::Created,
        )
        .expect("created completion is recorded");
    adapter
        .finish_run(RunStatus::Completed)
        .expect("active run finishes");

    let adapter_status = adapter
        .status(&destination_id, "tweet-1")
        .expect("adapter status");
    let ledger = shared.lock().expect("ledger lock");
    let history = ledger.history(&destination).expect("history");
    let retried = ledger
        .retry_count(&destination, &bookmark("x", "tweet-1"))
        .expect("retry count");
    let first = ledger
        .delivery_for(&destination, &bookmark("x", "tweet-1"))
        .expect("first delivery")
        .expect("first is delivered");
    let second = ledger
        .delivery_for(&destination, &bookmark("x", "tweet-2"))
        .expect("second delivery")
        .expect("second is delivered");

    assert_eq!(
        (
            adapter_status,
            retried,
            first.outcome,
            second.outcome,
            history.runs[0].status,
            history.runs[0].failed,
            history.runs[0].existing,
            history.runs[0].created,
        ),
        (
            LedgerStatus::Delivered,
            1,
            DeliveryOutcome::Existing,
            DeliveryOutcome::Created,
            RunStatus::Completed,
            1,
            1,
            1,
        )
    );
}

#[test]
fn sqlite_adapter_persists_only_redacted_failure_details() {
    let directory = tempdir().expect("temporary directory");
    let path = directory.path().join("delivery-ledger.sqlite3");
    let shared: SharedSqliteLedger = Arc::new(Mutex::new(
        DeliveryLedger::open(&path).expect("ledger opens"),
    ));
    let adapter = SqliteDeliveryLedgerAdapter::start(
        Arc::clone(&shared),
        destination("https://keep.example", "user-a"),
        ResolvedFileSourceFormat::FieldTheoryJsonl,
    )
    .expect("adapter starts an active run");
    let destination_id = adapter.destination_id();
    adapter
        .record_pending(
            &destination_id,
            PendingDelivery {
                source_id: "tweet-1".into(),
                bookmark_id: Some("karakeep-1".into()),
                origin: Some(BookmarkOrigin::Created),
                error: "bookmark-content-and-api-key-canary".into(),
            },
        )
        .expect("pending tagging is recorded");
    drop(adapter);
    drop(shared);

    let inspection = rusqlite::Connection::open(&path).expect("inspection connection");
    let (stage, code): (String, String) = inspection
        .query_row(
            "SELECT failure_stage, failure_code FROM delivery_attempts WHERE outcome = 'failed'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("redacted failure row");
    assert_eq!(
        (stage.as_str(), code.as_str()),
        ("attach_tags", "TAG_DELIVERY_FAILED")
    );
}

#[test]
fn sqlite_adapter_rejects_a_destination_outside_its_active_scope() {
    let shared = Arc::new(Mutex::new(
        DeliveryLedger::open_in_memory().expect("ledger opens"),
    ));
    let adapter = SqliteDeliveryLedgerAdapter::start(
        shared,
        destination("https://keep.example", "user-a"),
        ResolvedFileSourceFormat::ChromeNetscape,
    )
    .expect("adapter starts");

    assert!(
        adapter
            .status(
                &delivery::DestinationId::new("different destination"),
                "https://example.com",
            )
            .is_err()
    );
}
