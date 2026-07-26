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

static PROCESS_ENVIRONMENT_LOCK: Mutex<()> = Mutex::new(());

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("acquisition-bridge-fixture.mjs")
}

fn request(acquisition_id: &str) -> XAcquisitionRequest {
    request_for_profile(acquisition_id, "Default")
}

fn request_for_profile(acquisition_id: &str, profile_id: &str) -> XAcquisitionRequest {
    XAcquisitionRequest {
        acquisition_id: acquisition_id.to_string(),
        source: XSourceReference {
            browser_id: "chrome".to_string(),
            profile_id: profile_id.to_string(),
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
                | AcquisitionEvent::Resumable { .. }
                | AcquisitionEvent::Cancelled { .. }
                | AcquisitionEvent::Failed { .. }
        ) {
            return event;
        }
    }
}

fn run_acquisition(
    supervisor: &AcquisitionSupervisor,
    runner: &BridgeRunner,
    store: &SnapshotStore,
    request: XAcquisitionRequest,
) -> AcquisitionEvent {
    let (sender, receiver) = mpsc::channel();
    supervisor
        .start(runner, request, store.clone(), move |event| {
            sender.send(event).expect("event receiver remains open");
        })
        .expect("acquisition starts");
    terminal_event(&receiver)
}

fn persisted_text(path: &std::path::Path) -> String {
    fs::read_dir(path)
        .expect("private data directory")
        .map(|entry| entry.expect("private data entry").path())
        .map(|path| {
            if path.is_dir() {
                persisted_text(&path)
            } else {
                fs::read_to_string(path).expect("private text file")
            }
        })
        .collect()
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
fn resumable_acquisition_keeps_the_cursor_and_metadata_with_its_snapshot() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());

    let event = run_acquisition(&supervisor, &runner, &store, request("acquire-resumable"));

    assert_eq!(
        event,
        AcquisitionEvent::Resumable {
            acquisition_id: "acquire-resumable".to_string(),
            reason: karakeep_transfer_lib::fieldtheory::AcquisitionResumeReason::RateLimited,
        }
    );
    assert_eq!(
        (
            fs::read_to_string(store.root().join("acquisition/bookmarks-meta.json")).ok(),
            fs::read_to_string(
                store
                    .root()
                    .join("acquisition/bookmarks-backfill-state.json"),
            )
            .ok(),
        ),
        (
            Some("{\"totalBookmarks\":1}\n".to_string()),
            Some("{\"lastCursor\":\"resume-cursor\"}\n".to_string()),
        )
    );
    assert_eq!(
        (
            store.root().join("bookmarks-meta.json").exists(),
            store.root().join("bookmarks-backfill-state.json").exists(),
        ),
        (false, false)
    );
    assert!(matches!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request("acquire-resumable-retry"),
        ),
        AcquisitionEvent::Completed { .. }
    ));
    assert_eq!(
        [
            "backfill-bookmarks.jsonl",
            "bookmarks-meta.json",
            "bookmarks-backfill-state.json",
            "backfill-source.json",
        ]
        .map(|filename| store.root().join("acquisition").join(filename).exists()),
        [false, false, false, false]
    );
}

#[test]
fn partial_backfill_never_replaces_the_last_complete_snapshot() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    assert!(matches!(
        run_acquisition(&supervisor, &runner, &store, request("acquire-success")),
        AcquisitionEvent::Completed { .. }
    ));
    let complete_snapshot = fs::read_to_string(store.snapshot_path()).expect("complete snapshot");

    assert!(matches!(
        run_acquisition(&supervisor, &runner, &store, request("acquire-resumable")),
        AcquisitionEvent::Resumable { .. }
    ));
    let failure = run_acquisition(
        &supervisor,
        &runner,
        &store,
        request("acquire-compatibility"),
    );

    assert_eq!(
        (
            failure,
            fs::read_to_string(store.snapshot_path()).expect("complete snapshot remains"),
            fs::read_to_string(store.root().join("acquisition/backfill-bookmarks.jsonl"))
                .expect("partial backfill retained"),
        ),
        (
            AcquisitionEvent::Failed {
                acquisition_id: "acquire-compatibility".to_string(),
                code: AcquisitionFailureCode::XCompatibility,
                message: "X bookmark acquisition is temporarily incompatible. A Karakeep Transfer update may be required.".to_string(),
                previous_snapshot_available: true,
            },
            complete_snapshot,
            "{\"id\":\"partial\",\"tweetId\":\"partial\",\"url\":\"https://x.com/example/status/partial\",\"folderNames\":[]}\n".to_string(),
        )
    );
}

#[test]
fn snapshot_use_restores_a_complete_prior_promotion_after_interruption() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let state = store.root().join("acquisition");
    fs::create_dir_all(&state).expect("state directory");
    fs::write(
        store.snapshot_path(),
        "{\"id\":\"new\",\"tweetId\":\"new\",\"url\":\"https://x.com/example/status/new\",\"folderNames\":[]}\n",
    )
    .expect("interrupted new snapshot");
    fs::write(
        state.join("bookmarks.previous.jsonl"),
        "{\"id\":\"previous\",\"tweetId\":\"previous\",\"url\":\"https://x.com/example/status/previous\",\"folderNames\":[\"Research\"]}\n",
    )
    .expect("previous snapshot backup");
    fs::write(state.join("source.previous.json"), "{}\n").expect("previous source backup");

    let restored = store.delivery_source().expect("recovered delivery source");

    assert_eq!(
        (
            restored.bookmarks[0].source_id.as_str(),
            store
                .root()
                .join("acquisition/bookmarks.previous.jsonl")
                .exists(),
            store
                .root()
                .join("acquisition/source.previous.json")
                .exists(),
        ),
        ("previous", false, false)
    );
}

#[test]
fn snapshot_use_keeps_a_fully_promoted_snapshot_and_cleans_transaction_backups() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let state = store.root().join("acquisition");
    fs::create_dir_all(&state).expect("state directory");
    fs::write(
        store.snapshot_path(),
        "{\"id\":\"new\",\"tweetId\":\"new\",\"url\":\"https://x.com/example/status/new\",\"folderNames\":[]}\n",
    )
    .expect("promoted snapshot");
    fs::write(state.join("source.json"), "{}\n").expect("promoted source");
    fs::write(
        state.join("bookmarks.previous.jsonl"),
        "{\"id\":\"previous\",\"tweetId\":\"previous\",\"url\":\"https://x.com/example/status/previous\",\"folderNames\":[]}\n",
    )
    .expect("previous snapshot backup");
    fs::write(state.join("source.previous.json"), "{}\n").expect("previous source backup");

    let retained = store.delivery_source().expect("retained delivery source");

    assert_eq!(
        (
            retained.bookmarks[0].source_id.as_str(),
            store
                .root()
                .join("acquisition/bookmarks.previous.jsonl")
                .exists(),
            store
                .root()
                .join("acquisition/source.previous.json")
                .exists(),
        ),
        ("new", false, false)
    );
}

#[test]
fn first_promotion_interruption_never_exposes_a_snapshot_without_its_source_binding() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    fs::create_dir_all(store.root().join("acquisition")).expect("state directory");
    fs::write(
        store.snapshot_path(),
        "{\"id\":\"incomplete\",\"tweetId\":\"incomplete\",\"url\":\"https://x.com/example/status/incomplete\",\"folderNames\":[]}\n",
    )
    .expect("interrupted snapshot");

    assert_eq!(
        (
            store.has_snapshot(),
            store.snapshot_bytes().expect("snapshot bytes"),
            store.delivery_source().is_err(),
        ),
        (false, 0, true)
    );
}

#[test]
fn acquisition_child_uses_staging_owned_temporary_storage() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());

    assert!(matches!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request("acquire-private-temp")
        ),
        AcquisitionEvent::Completed { .. }
    ));
}

#[test]
fn compatibility_failure_preserves_the_previous_snapshot_and_redacts_session_values() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    assert!(matches!(
        run_acquisition(&supervisor, &runner, &store, request("acquire-success")),
        AcquisitionEvent::Completed { .. }
    ));
    let previous_snapshot = fs::read_to_string(store.snapshot_path()).expect("previous snapshot");
    let event = run_acquisition(
        &supervisor,
        &runner,
        &store,
        request("acquire-compatibility"),
    );

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
            previous_snapshot,
        )
    );
}

#[test]
fn reported_promotion_failure_keeps_the_prior_safe_snapshot() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    assert!(matches!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request_for_profile("acquire-profile-a", "Profile A"),
        ),
        AcquisitionEvent::Completed { .. }
    ));
    let prior_snapshot = fs::read_to_string(store.snapshot_path()).expect("prior snapshot");
    let state_directory = store.root().join("acquisition");
    fs::remove_dir_all(&state_directory).expect("remove state directory");
    fs::write(&state_directory, b"not a directory").expect("block promotion state");

    let event = run_acquisition(
        &supervisor,
        &runner,
        &store,
        request_for_profile("acquire-profile-b", "Profile B"),
    );

    assert_eq!(
        (
            event,
            fs::read_to_string(store.snapshot_path()).expect("prior snapshot remains"),
        ),
        (
            AcquisitionEvent::Failed {
                acquisition_id: "acquire-profile-b".to_string(),
                code: AcquisitionFailureCode::Unexpected,
                message: "X bookmark acquisition could not be completed.".to_string(),
                previous_snapshot_available: false,
            },
            prior_snapshot,
        )
    );
}

#[test]
fn failed_acquisition_for_another_source_neither_seeds_nor_offers_the_retained_snapshot() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    assert!(matches!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request_for_profile("acquire-profile-a", "Profile A"),
        ),
        AcquisitionEvent::Completed { .. }
    ));
    let profile_a_snapshot = fs::read_to_string(store.snapshot_path()).expect("profile A snapshot");
    let event = run_acquisition(
        &supervisor,
        &runner,
        &store,
        request_for_profile("acquire-cross-source-failure", "Profile B"),
    );

    assert_eq!(
        (
            event,
            fs::read_to_string(store.snapshot_path()).expect("profile A snapshot remains"),
        ),
        (
            AcquisitionEvent::Failed {
                acquisition_id: "acquire-cross-source-failure".to_string(),
                code: AcquisitionFailureCode::SourceUnavailable,
                message: "The selected browser profile is no longer available.".to_string(),
                previous_snapshot_available: false,
            },
            profile_a_snapshot,
        )
    );
}

#[test]
fn successful_acquisition_for_another_source_replaces_and_binds_the_snapshot() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    assert!(matches!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request_for_profile("acquire-profile-a", "Profile A"),
        ),
        AcquisitionEvent::Completed { .. }
    ));
    assert!(matches!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request_for_profile("acquire-profile-b", "Profile B"),
        ),
        AcquisitionEvent::Completed { .. }
    ));
    assert_eq!(
        fs::read_to_string(store.snapshot_path()).expect("profile B snapshot"),
        "{\"id\":\"profile-b\",\"tweetId\":\"profile-b\",\"url\":\"https://x.com/example/status/profile-b\",\"folderNames\":[]}\n"
    );

    assert_eq!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request_for_profile("acquire-same-source-failure", "Profile B"),
        ),
        AcquisitionEvent::Failed {
            acquisition_id: "acquire-same-source-failure".to_string(),
            code: AcquisitionFailureCode::XCompatibility,
            message: "X bookmark acquisition is temporarily incompatible. A Karakeep Transfer update may be required.".to_string(),
            previous_snapshot_available: true,
        }
    );
}

#[test]
fn source_binding_does_not_persist_the_browser_profile_path() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let profile_path = "Profiles/private-profile-path-canary";
    assert!(matches!(
        run_acquisition(
            &supervisor,
            &runner,
            &store,
            request_for_profile("acquire-private-profile", profile_path),
        ),
        AcquisitionEvent::Completed { .. }
    ));

    assert!(!persisted_text(store.root()).contains(profile_path));
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
    fs::create_dir_all(store.root().join("acquisition")).expect("state directory");
    fs::write(store.root().join("acquisition/source.json"), "{}\n").expect("source binding");
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
    fs::create_dir_all(store.root().join("acquisition")).expect("state directory");
    fs::write(store.root().join("acquisition/source.json"), "{}\n").expect("source binding");

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
    fs::create_dir_all(snapshot_root.join("acquisition")).expect("state directory");
    fs::write(snapshot_root.join("acquisition/source.json"), "{}\n").expect("source binding");
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
    let _environment_lock = PROCESS_ENVIRONMENT_LOCK
        .lock()
        .expect("process environment lock");
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
fn supervisor_keeps_password_equivalent_canaries_out_of_process_arguments() {
    let _environment_lock = PROCESS_ENVIRONMENT_LOCK
        .lock()
        .expect("process environment lock");
    let _api_key = ScopedEnvironment::set("KARAKEEP_API_KEY", "karakeep-key-canary-arguments-5519");
    let _x_session = ScopedEnvironment::set("X_SESSION_CANARY", "x-session-canary-arguments-8472");
    let temporary = tempfile::tempdir().expect("temporary directory");
    let store = SnapshotStore::new(temporary.path().join("fieldtheory"));
    let supervisor = AcquisitionSupervisor::default();
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());

    let event = run_acquisition(
        &supervisor,
        &runner,
        &store,
        request("acquire-argument-boundary"),
    );

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
