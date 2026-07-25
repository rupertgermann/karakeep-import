use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use karakeep_transfer_lib::{
    domain::{
        BookmarkKey, DeliveryAttempt, DeliveryOutcome, DeliveryStage, DestinationIdentity,
        FailureCode, RunStatus, TimestampMillis,
    },
    ledger::{DeliveryLedger, LedgerError},
    private_data::{DeleteLocalTransferData, PrivateTransferData},
};

static NEXT_TEMP_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(label: &str) -> Self {
        let sequence = NEXT_TEMP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "karakeep-transfer-{label}-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("test directory is created");
        Self { path }
    }

    fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.path.join(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.path) {
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::NotFound,
                "test directory is removed: {error}"
            );
        }
    }
}

fn destination(server: &str, user: &str) -> DestinationIdentity {
    DestinationIdentity::new(server, user).expect("valid destination")
}

fn bookmark(id: &str) -> BookmarkKey {
    BookmarkKey::new("x", id).expect("valid bookmark key")
}

#[test]
fn completed_history_survives_migration_reopen_and_equivalent_destination_spelling() {
    let directory = TestDirectory::new("migration");
    let database_path = directory.join("app-data/delivery-ledger.sqlite3");
    let canonical = destination("HTTPS://Example.COM:443/karakeep/", "user-42");
    let equivalent = destination("https://example.com/karakeep", "user-42");

    assert_eq!(
        canonical.normalized_server(),
        "https://example.com/karakeep"
    );
    assert_eq!(canonical, equivalent);

    {
        let mut ledger = DeliveryLedger::open(&database_path).expect("ledger opens");
        let run = ledger
            .start_run(&canonical, TimestampMillis(1_000))
            .expect("run starts");
        ledger
            .record_attempt(
                run,
                &bookmark("tweet-1"),
                DeliveryAttempt::Delivered {
                    karakeep_bookmark_id: "karakeep-1".to_owned(),
                    outcome: DeliveryOutcome::Created,
                },
                TimestampMillis(1_100),
            )
            .expect("completed delivery is recorded");
        ledger
            .finish_run(run, RunStatus::Completed, TimestampMillis(1_200))
            .expect("run finishes");
    }

    let ledger = DeliveryLedger::open(&database_path).expect("migrated ledger reopens");
    assert_eq!(ledger.schema_version().expect("schema version"), 1);
    assert!(
        ledger
            .delivery_for(&equivalent, &bookmark("tweet-1"))
            .expect("delivery query")
            .is_some()
    );
}

#[test]
fn delivery_history_is_partitioned_by_server_and_authenticated_user() {
    let directory = TestDirectory::new("partition");
    let mut ledger = DeliveryLedger::open(directory.join("ledger.sqlite3")).expect("ledger opens");
    let destination_a = destination("https://keep.example/one", "user-a");
    let run = ledger
        .start_run(&destination_a, TimestampMillis(1))
        .expect("run starts");
    ledger
        .record_attempt(
            run,
            &bookmark("tweet-2"),
            DeliveryAttempt::Delivered {
                karakeep_bookmark_id: "karakeep-2".to_owned(),
                outcome: DeliveryOutcome::Existing,
            },
            TimestampMillis(2),
        )
        .expect("delivery is recorded");

    let same_destination = destination("https://KEEP.example:443/one/", "user-a");
    let other_user = destination("https://keep.example/one", "user-b");
    let other_server_path = destination("https://keep.example/two", "user-a");

    assert!(
        ledger
            .delivery_for(&same_destination, &bookmark("tweet-2"))
            .expect("same destination query")
            .is_some()
    );
    assert!(
        ledger
            .delivery_for(&other_user, &bookmark("tweet-2"))
            .expect("other user query")
            .is_none()
    );
    assert!(
        ledger
            .delivery_for(&other_server_path, &bookmark("tweet-2"))
            .expect("other server query")
            .is_none()
    );
}

#[test]
fn failed_tagging_remains_pending_and_only_records_a_redacted_retry() {
    let directory = TestDirectory::new("failed-tagging");
    let mut ledger = DeliveryLedger::open(directory.join("ledger.sqlite3")).expect("ledger opens");
    let destination = destination("https://keep.example", "user-a");
    let key = bookmark("tweet-3");
    let run = ledger
        .start_run(&destination, TimestampMillis(10))
        .expect("run starts");
    let code = FailureCode::new("TAG_REQUEST_FAILED").expect("redacted code");

    ledger
        .record_attempt(
            run,
            &key,
            DeliveryAttempt::Failed {
                stage: DeliveryStage::AttachTags,
                code,
            },
            TimestampMillis(11),
        )
        .expect("failure is recorded");

    assert!(
        ledger
            .delivery_for(&destination, &key)
            .expect("delivery query")
            .is_none()
    );
    assert_eq!(
        ledger.retry_count(&destination, &key).expect("retry count"),
        1
    );
    assert!(FailureCode::new("api_key=secret-value").is_err());
}

#[test]
fn duplicate_completion_rolls_back_its_attempt() {
    let directory = TestDirectory::new("rollback");
    let mut ledger = DeliveryLedger::open(directory.join("ledger.sqlite3")).expect("ledger opens");
    let destination = destination("https://keep.example", "user-a");
    let key = bookmark("tweet-4");
    let run = ledger
        .start_run(&destination, TimestampMillis(20))
        .expect("run starts");

    ledger
        .record_attempt(
            run,
            &key,
            DeliveryAttempt::Delivered {
                karakeep_bookmark_id: "karakeep-4".to_owned(),
                outcome: DeliveryOutcome::Created,
            },
            TimestampMillis(21),
        )
        .expect("first completion is recorded");
    let duplicate = ledger.record_attempt(
        run,
        &key,
        DeliveryAttempt::Delivered {
            karakeep_bookmark_id: "karakeep-other".to_owned(),
            outcome: DeliveryOutcome::Existing,
        },
        TimestampMillis(22),
    );

    assert!(matches!(duplicate, Err(LedgerError::AlreadyDelivered)));
    let history = ledger
        .history(&destination)
        .expect("destination history is readable");
    assert_eq!(history.delivered_total, 1);
    assert_eq!(history.runs[0].created, 1);
    assert_eq!(history.runs[0].existing, 0);
    assert_eq!(history.runs[0].failed, 0);
}

#[test]
fn history_reports_created_existing_and_failed_outcomes_per_run() {
    let directory = TestDirectory::new("history");
    let mut ledger = DeliveryLedger::open(directory.join("ledger.sqlite3")).expect("ledger opens");
    let destination = destination("https://keep.example", "user-a");
    let first_run = ledger
        .start_run(&destination, TimestampMillis(30))
        .expect("first run starts");
    ledger
        .record_attempt(
            first_run,
            &bookmark("tweet-5"),
            DeliveryAttempt::Delivered {
                karakeep_bookmark_id: "karakeep-5".to_owned(),
                outcome: DeliveryOutcome::Created,
            },
            TimestampMillis(31),
        )
        .expect("created outcome");
    ledger
        .record_attempt(
            first_run,
            &bookmark("tweet-6"),
            DeliveryAttempt::Failed {
                stage: DeliveryStage::AttachTags,
                code: FailureCode::new("TAG_TIMEOUT").expect("redacted code"),
            },
            TimestampMillis(32),
        )
        .expect("failed outcome");
    ledger
        .finish_run(
            first_run,
            RunStatus::PartiallyCompleted,
            TimestampMillis(33),
        )
        .expect("first run finishes");

    let second_run = ledger
        .start_run(&destination, TimestampMillis(40))
        .expect("second run starts");
    ledger
        .record_attempt(
            second_run,
            &bookmark("tweet-6"),
            DeliveryAttempt::Delivered {
                karakeep_bookmark_id: "karakeep-6".to_owned(),
                outcome: DeliveryOutcome::Existing,
            },
            TimestampMillis(41),
        )
        .expect("existing outcome");
    ledger
        .finish_run(second_run, RunStatus::Completed, TimestampMillis(42))
        .expect("second run finishes");

    let history = ledger.history(&destination).expect("history query");
    assert_eq!(history.delivered_total, 2);
    assert_eq!(history.runs.len(), 2);
    assert_eq!(
        (
            history.runs[0].status,
            history.runs[0].created,
            history.runs[0].existing,
            history.runs[0].failed,
        ),
        (RunStatus::PartiallyCompleted, 1, 0, 1)
    );
    assert_eq!(
        (
            history.runs[1].status,
            history.runs[1].created,
            history.runs[1].existing,
            history.runs[1].failed,
        ),
        (RunStatus::Completed, 0, 1, 0)
    );
}

struct PrivateDataFixture {
    _directory: TestDirectory,
    ledger_path: PathBuf,
    snapshot_path: PathBuf,
    acquisition_path: PathBuf,
    private_data: PrivateTransferData,
    destination: DestinationIdentity,
}

fn private_data_fixture(label: &str) -> PrivateDataFixture {
    let directory = TestDirectory::new(label);
    let ledger_path = directory.join("delivery-ledger.sqlite3");
    let snapshot_path = directory.join("fieldtheory/bookmarks.jsonl");
    let acquisition_path = directory.join("fieldtheory/acquisition");
    fs::create_dir_all(&acquisition_path).expect("acquisition directory");
    fs::write(
        &snapshot_path,
        include_bytes!("fixtures/bookmark-snapshot.jsonl"),
    )
    .expect("snapshot fixture");
    fs::write(acquisition_path.join("cursor"), b"opaque-cursor").expect("acquisition fixture");
    let private_data = PrivateTransferData::new(&ledger_path, &snapshot_path, &acquisition_path);
    let destination = destination("https://keep.example", "user-a");
    {
        let mut ledger = DeliveryLedger::open(&ledger_path).expect("ledger opens");
        let run = ledger
            .start_run(&destination, TimestampMillis(50))
            .expect("run starts");
        ledger
            .record_attempt(
                run,
                &bookmark("tweet-7"),
                DeliveryAttempt::Delivered {
                    karakeep_bookmark_id: "karakeep-7".to_owned(),
                    outcome: DeliveryOutcome::Created,
                },
                TimestampMillis(51),
            )
            .expect("delivery is recorded");
    }

    PrivateDataFixture {
        _directory: directory,
        ledger_path,
        snapshot_path,
        acquisition_path,
        private_data,
        destination,
    }
}

#[test]
fn private_data_inspection_reports_local_paths_and_sizes() {
    let fixture = private_data_fixture("private-data-inspection");

    let summary = fixture
        .private_data
        .inspect()
        .expect("private data summary");

    assert_eq!(summary.ledger_path, fixture.ledger_path);
    assert_eq!(summary.snapshot_path, fixture.snapshot_path);
    assert!(summary.ledger_bytes > 0);
    assert_eq!(
        summary.snapshot_bytes,
        include_bytes!("fixtures/bookmark-snapshot.jsonl").len() as u64
    );
}

#[test]
fn replacing_x_source_clears_only_snapshot_and_acquisition_state() {
    let fixture = private_data_fixture("private-data-source-replacement");

    fixture
        .private_data
        .replace_x_source()
        .expect("source replacement clears source data");
    assert!(!fixture.snapshot_path.exists());
    assert!(!fixture.acquisition_path.exists());
    assert!(fixture.ledger_path.exists());
    let ledger = DeliveryLedger::open(&fixture.ledger_path).expect("ledger remains readable");
    assert!(
        ledger
            .delivery_for(&fixture.destination, &bookmark("tweet-7"))
            .expect("delivery query")
            .is_some()
    );
}

#[test]
fn confirmed_local_data_deletion_removes_snapshot_ledger_and_side_state() {
    let fixture = private_data_fixture("private-data-deletion");

    fixture
        .private_data
        .delete(DeleteLocalTransferData::confirmed())
        .expect("confirmed deletion succeeds");

    assert!(!fixture.ledger_path.exists());
    assert!(!fixture.snapshot_path.exists());
    assert!(!fixture.acquisition_path.exists());
}
