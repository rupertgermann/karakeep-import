use std::{
    ffi::{OsStr, OsString},
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver},
    },
    time::Duration,
};

use karakeep_transfer_lib::{
    delivery::DeliveryLedger as _,
    domain::{DestinationIdentity, RunStatus},
    fieldtheory::{
        AcquisitionEvent, AcquisitionFailureCode, AcquisitionPhase, AcquisitionStartError,
        AcquisitionSupervisor, BridgeRunner, DestinationPreview, FieldTheoryState, SnapshotStore,
        XAcquisitionRequest, XSourceReference,
    },
    file_source::ResolvedFileSourceFormat,
    karakeep::BookmarkOrigin,
    ledger::DeliveryLedger,
    transfer::SqliteDeliveryLedgerAdapter,
};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("acquisition-bridge-fixture.mjs")
}

fn request(acquisition_id: &str) -> XAcquisitionRequest {
    XAcquisitionRequest {
        acquisition_id: acquisition_id.to_string(),
        source: XSourceReference {
            browser_id: "chrome".to_string(),
            profile_id: "Default".to_string(),
        },
    }
}

fn terminal_event(receiver: &Receiver<AcquisitionEvent>) -> AcquisitionEvent {
    loop {
        let event = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("terminal acquisition event");
        if matches!(
            event,
            AcquisitionEvent::Completed { .. }
                | AcquisitionEvent::Cancelled { .. }
                | AcquisitionEvent::Failed { .. }
        ) {
            return event;
        }
    }
}

struct ScopedEnvironment {
    key: &'static str,
    previous: Option<OsString>,
}

impl ScopedEnvironment {
    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        // SAFETY: this test restores the variable in Drop. Every child process
        // in this integration test is required to launch with a cleared,
        // allowlisted environment, so parallel acquisition tests cannot
        // observe the canary.
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, previous }
    }
}

impl Drop for ScopedEnvironment {
    fn drop(&mut self) {
        // SAFETY: restores the process environment to the state captured by
        // ScopedEnvironment::set before the guard is dropped.
        unsafe {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

#[test]
fn successful_acquisition_promotes_the_private_snapshot_after_progress() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let (sender, receiver) = mpsc::channel();

    supervisor
        .start(
            &runner,
            request("acquire-success"),
            store.clone(),
            move |event| {
                sender.send(event).expect("event receiver remains open");
            },
        )
        .expect("acquisition starts");
    let event = terminal_event(&receiver);

    assert_eq!(
        (
            event,
            fs::read_to_string(store.snapshot_path()).expect("promoted snapshot"),
        ),
        (
            AcquisitionEvent::Completed {
                acquisition_id: "acquire-success".to_string(),
                total: 2,
                added: 2,
                folders: vec!["Research".to_string()],
            },
            concat!(
                "{\"id\":\"one\",\"tweetId\":\"1\",\"url\":\"https://x.com/example/status/1\",\"folderNames\":[\"Research\"]}\n",
                "{\"id\":\"two\",\"tweetId\":\"2\",\"url\":\"https://x.com/example/status/2\",\"folderNames\":[]}\n",
            )
            .to_string(),
        )
    );
}

#[test]
fn compatibility_failure_preserves_the_previous_snapshot_and_redacts_session_values() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    fs::create_dir_all(store.root()).expect("snapshot directory");
    fs::write(store.snapshot_path(), "previous snapshot\n").expect("previous snapshot");
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let (sender, receiver) = mpsc::channel();

    supervisor
        .start(
            &runner,
            request("acquire-compatibility"),
            store.clone(),
            move |event| {
                sender.send(event).expect("event receiver remains open");
            },
        )
        .expect("acquisition starts");
    let event = terminal_event(&receiver);

    assert_eq!(
        (
            event,
            fs::read_to_string(store.snapshot_path()).expect("previous snapshot remains"),
        ),
        (
            AcquisitionEvent::Failed {
                acquisition_id: "acquire-compatibility".to_string(),
                code: AcquisitionFailureCode::XCompatibility,
                message: "X bookmark acquisition is temporarily incompatible. A Karakeep Transfer update may be required.".to_string(),
                previous_snapshot_available: true,
            },
            "previous snapshot\n".to_string(),
        )
    );
}

#[test]
fn cancellation_terminates_the_bridge_and_keeps_the_previous_snapshot_usable() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    fs::create_dir_all(store.root()).expect("snapshot directory");
    fs::write(store.snapshot_path(), "previous snapshot\n").expect("previous snapshot");
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let (sender, receiver) = mpsc::channel();

    supervisor
        .start(
            &runner,
            request("acquire-long"),
            store.clone(),
            move |event| {
                sender.send(event).expect("event receiver remains open");
            },
        )
        .expect("acquisition starts");
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("initial progress");
    supervisor
        .cancel("acquire-long")
        .expect("active acquisition cancels");
    let event = terminal_event(&receiver);

    assert_eq!(
        (
            event,
            fs::read_to_string(store.snapshot_path()).expect("previous snapshot remains"),
            supervisor.is_active(),
        ),
        (
            AcquisitionEvent::Cancelled {
                acquisition_id: "acquire-long".to_string(),
            },
            "previous snapshot\n".to_string(),
            false,
        )
    );
}

#[test]
fn a_second_acquisition_cannot_start_while_one_is_active() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let (sender, receiver) = mpsc::channel();

    supervisor
        .start(
            &runner,
            request("acquire-long"),
            store.clone(),
            move |event| {
                sender.send(event).expect("event receiver remains open");
            },
        )
        .expect("first acquisition starts");
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("first acquisition progress");
    let second = supervisor
        .start(&runner, request("acquire-second"), store, |_| {})
        .expect_err("second acquisition is rejected");
    supervisor
        .cancel("acquire-long")
        .expect("first acquisition cancels");
    terminal_event(&receiver);

    assert_eq!(second, AcquisitionStartError::OperationActive);
}

#[test]
fn snapshot_preview_partitions_pending_records_by_destination_without_delivery() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    fs::create_dir_all(store.root()).expect("snapshot directory");
    fs::write(
        store.snapshot_path(),
        concat!(
            "{\"id\":\"one\",\"tweetId\":\"1\",\"url\":\"https://x.com/example/status/1\",\"folderNames\":[\"Research\"]}\n",
            "{\"id\":\"two\",\"tweetId\":\"2\",\"url\":\"https://x.com/example/status/2\",\"folderNames\":[]}\n",
        ),
    )
    .expect("snapshot");
    let destination_identity =
        DestinationIdentity::new("https://keep.example/", "user-7").expect("destination identity");
    let ledger = Arc::new(Mutex::new(
        DeliveryLedger::open_in_memory().expect("ledger"),
    ));
    let delivery = SqliteDeliveryLedgerAdapter::start(
        Arc::clone(&ledger),
        destination_identity.clone(),
        ResolvedFileSourceFormat::FieldTheoryJsonl,
    )
    .expect("delivery adapter");
    delivery
        .record_delivered(
            &delivery.destination_id(),
            "1",
            "karakeep-1",
            BookmarkOrigin::Existing,
        )
        .expect("delivery");
    delivery
        .finish_run(RunStatus::Completed)
        .expect("delivery run finishes");
    let ledger = ledger.lock().expect("ledger lock");

    let preview = store
        .preview(
            &ledger,
            &destination_identity,
            DestinationPreview {
                server_url: "https://keep.example".to_string(),
                user_id: "user-7".to_string(),
                user_name: "Reader".to_string(),
            },
        )
        .expect("snapshot preview");

    assert_eq!(
        preview,
        karakeep_transfer_lib::fieldtheory::XTransferPreview {
            total: 2,
            pending: 1,
            previously_delivered: 1,
            folders: vec!["Research".to_string()],
            destination: DestinationPreview {
                server_url: "https://keep.example".to_string(),
                user_id: "user-7".to_string(),
                user_name: "Reader".to_string(),
            },
        }
    );
}

#[test]
fn snapshot_store_returns_the_parsed_retained_x_source_for_delivery() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    fs::create_dir_all(store.root()).expect("snapshot directory");
    fs::write(
        store.snapshot_path(),
        "{\"id\":\"one\",\"tweetId\":\"1\",\"url\":\"https://x.com/example/status/1\",\"folderNames\":[\"Research\"]}\n",
    )
    .expect("snapshot");

    let source = store
        .delivery_source()
        .expect("parsed retained X delivery source");

    assert_eq!(
        (
            source.format,
            source.bookmarks.len(),
            source.bookmarks[0].source_id.as_str(),
            source.bookmarks[0].tags.join(","),
        ),
        (
            ResolvedFileSourceFormat::FieldTheoryJsonl,
            1,
            "1",
            "twitter,Research".to_string(),
        )
    );
}

#[test]
fn field_theory_state_exposes_parsed_snapshot_data_without_its_private_path() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let snapshot_root = temporary.path().join("fieldtheory");
    fs::create_dir_all(&snapshot_root).expect("snapshot directory");
    fs::write(
        snapshot_root.join("bookmarks.jsonl"),
        "{\"id\":\"one\",\"tweetId\":\"1\",\"url\":\"https://x.com/example/status/1\",\"auth_token\":\"raw-auth-secret\",\"ct0\":\"raw-csrf-secret\"}\n",
    )
    .expect("snapshot");
    let state = FieldTheoryState::bundled(temporary.path(), temporary.path());

    let source = state
        .snapshot_delivery_source()
        .expect("parsed snapshot through application state");
    let serialized = serde_json::to_string(&source).expect("source serializes");

    assert_eq!(
        (
            source.bookmarks[0].url.as_str(),
            serialized.contains(&temporary.path().display().to_string()),
            serialized.contains("auth_token"),
            serialized.contains("ct0"),
        ),
        ("https://x.com/example/status/1", false, false, false)
    );
}

#[test]
fn rust_supervisor_never_surfaces_password_equivalent_bridge_stderr() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let (sender, receiver) = mpsc::channel();

    supervisor
        .start(
            &runner,
            request("acquire-compatibility"),
            store,
            move |event| {
                sender.send(event).expect("event receiver remains open");
            },
        )
        .expect("acquisition starts");
    let serialized = serde_json::to_string(&terminal_event(&receiver)).expect("event serializes");

    assert!(!serialized.contains("auth-token-canary-acquisition-8472"));
}

#[test]
fn supervisor_does_not_pass_a_karakeep_key_from_the_app_environment_to_field_theory() {
    let _environment =
        ScopedEnvironment::set("KARAKEEP_API_KEY", "karakeep-key-canary-acquisition-5519");
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let (sender, receiver) = mpsc::channel();

    supervisor
        .start(
            &runner,
            request("acquire-environment"),
            store,
            move |event| {
                sender.send(event).expect("event receiver remains open");
            },
        )
        .expect("acquisition starts");
    let event = terminal_event(&receiver);

    assert!(matches!(event, AcquisitionEvent::Completed { .. }));
}

#[test]
fn acquisition_progress_is_structured_for_frontend_events() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let (sender, receiver) = mpsc::channel();

    supervisor
        .start(&runner, request("acquire-progress"), store, move |event| {
            sender.send(event).expect("event receiver remains open");
        })
        .expect("acquisition starts");
    let event = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("progress event");

    assert_eq!(
        event,
        AcquisitionEvent::Progress {
            acquisition_id: "acquire-progress".to_string(),
            phase: AcquisitionPhase::Bookmarks,
            completed: 1,
            total: None,
        }
    );
}
