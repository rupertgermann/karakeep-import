use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use karakeep::{
    ApiError, ApiErrorKind, BookmarkDraft, BookmarkOrigin, EnsuredBookmark, KarakeepApi,
    KarakeepBookmark, RequestCancellation,
};
use karakeep_transfer_lib::{bookmark, delivery, domain, file_source, karakeep, ledger, transfer};

#[path = "../src/delivery_coordinator.rs"]
mod delivery_coordinator;

use delivery_coordinator::{
    DeliveryCoordinator, DeliveryCoordinatorErrorCode, DeliveryEvent, DeliveryEventSink,
    DeliveryFailureCode, DeliveryId, DeliveryRun, DeliveryTerminalEvent,
};

#[derive(Default)]
struct RecordingEvents {
    events: Mutex<Vec<DeliveryEvent>>,
}

impl RecordingEvents {
    fn events(&self) -> Vec<DeliveryEvent> {
        self.events.lock().expect("event lock").clone()
    }
}

impl DeliveryEventSink for RecordingEvents {
    fn publish(&self, event: DeliveryEvent) {
        self.events.lock().expect("event lock").push(event);
    }
}

#[derive(Default)]
struct SuccessfulApi {
    ensure_calls: AtomicUsize,
}

impl KarakeepApi for SuccessfulApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        let call = self.ensure_calls.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: format!("karakeep-{call}"),
                human_tags: vec!["twitter".into()],
            },
            origin: BookmarkOrigin::Created,
        })
    }

    fn attach_tags(
        &self,
        _bookmark_id: &str,
        _tags: &[String],
        _cancellation: &dyn RequestCancellation,
    ) -> Result<(), ApiError> {
        Ok(())
    }
}

struct FailOnceApi {
    ensure_calls: AtomicUsize,
}

impl FailOnceApi {
    fn new() -> Self {
        Self {
            ensure_calls: AtomicUsize::new(0),
        }
    }
}

impl KarakeepApi for FailOnceApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        if self.ensure_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(ApiError::new(
                ApiErrorKind::Permanent,
                "bookmark-content-and-api-key-canary",
            ));
        }
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: "karakeep-resumed".into(),
                human_tags: vec!["twitter".into()],
            },
            origin: BookmarkOrigin::Created,
        })
    }

    fn attach_tags(
        &self,
        _bookmark_id: &str,
        _tags: &[String],
        _cancellation: &dyn RequestCancellation,
    ) -> Result<(), ApiError> {
        Ok(())
    }
}

struct BlockingApi {
    started: Mutex<Option<mpsc::Sender<()>>>,
    ensure_calls: AtomicUsize,
}

impl KarakeepApi for BlockingApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        if self.ensure_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(EnsuredBookmark {
                bookmark: KarakeepBookmark {
                    id: "karakeep-before-cancel".into(),
                    human_tags: vec!["twitter".into()],
                },
                origin: BookmarkOrigin::Created,
            });
        }
        if let Some(started) = self.started.lock().expect("started lock").take() {
            started.send(()).expect("test receives start");
        }
        while !cancellation.is_cancelled() {
            thread::yield_now();
        }
        Err(ApiError::new(
            ApiErrorKind::Network,
            "cancelled-api-secret-canary",
        ))
    }

    fn attach_tags(
        &self,
        _bookmark_id: &str,
        _tags: &[String],
        _cancellation: &dyn RequestCancellation,
    ) -> Result<(), ApiError> {
        panic!("cancelled delivery must not attach tags")
    }
}

fn destination(user: &str) -> domain::DestinationIdentity {
    domain::DestinationIdentity::new("https://keep.example", user).expect("valid destination")
}

fn preview(ids: &[&str]) -> file_source::FileSourcePreview {
    file_source::FileSourcePreview {
        format: file_source::ResolvedFileSourceFormat::FieldTheoryJsonl,
        bookmarks: ids
            .iter()
            .map(|id| bookmark::BookmarkPreview {
                source_id: (*id).into(),
                url: format!("https://x.com/example/status/{id}"),
                title: format!("private-title-{id}"),
                note: format!("private-note-{id}"),
                created_at: Some("2024-01-02T03:04:05Z".into()),
                tags: vec!["twitter".into()],
                folders: Vec::new(),
            })
            .collect(),
    }
}

fn ledger() -> transfer::SharedSqliteLedger {
    Arc::new(Mutex::new(
        ledger::DeliveryLedger::open_in_memory().expect("ledger opens"),
    ))
}

fn fast_config() -> delivery::DeliveryConfig {
    delivery::DeliveryConfig {
        max_concurrency: 1,
        requests_per_second: 100_000.0,
        retry: delivery::RetryPolicy {
            max_retries: 0,
            base_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
        },
    }
}

fn delivery_id(value: &str) -> DeliveryId {
    DeliveryId::new(value).expect("valid delivery ID")
}

#[test]
fn coordinator_and_prepared_runs_can_cross_the_host_worker_boundary() {
    fn assert_send_sync<T: Send + Sync>() {}
    fn assert_send<T: Send>() {}

    assert_send_sync::<DeliveryCoordinator>();
    assert_send::<DeliveryRun>();
}

#[test]
fn preview_counts_are_scoped_to_the_supplied_destination() {
    let ledger = ledger();
    let first_destination = destination("user-a");
    let second_destination = destination("user-b");
    let source = preview(&["tweet-1", "tweet-2"]);
    let coordinator = DeliveryCoordinator::new(Arc::clone(&ledger));

    let completed = coordinator
        .run(
            Arc::new(SuccessfulApi::default()),
            delivery_id("delivery-preview"),
            source.clone(),
            first_destination.clone(),
            Arc::new(RecordingEvents::default()),
        )
        .expect("delivery completes");
    assert!(matches!(completed, DeliveryTerminalEvent::Completed { .. }));

    assert_eq!(
        (
            coordinator
                .preview(&source, &first_destination)
                .expect("first preview"),
            coordinator
                .preview(&source, &second_destination)
                .expect("second preview"),
        ),
        (
            transfer::TransferPreviewCounts {
                total: 2,
                pending: 0,
                previously_delivered: 2,
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
fn progress_and_completion_events_expose_only_aggregate_safe_totals() {
    let events = RecordingEvents::default();
    let api = Arc::new(SuccessfulApi::default());
    let coordinator = DeliveryCoordinator::with_config(ledger(), fast_config()).unwrap();
    let events = Arc::new(events);

    let terminal = coordinator
        .run(
            api.clone(),
            delivery_id("delivery-complete"),
            preview(&["bookmark-id-canary"]),
            destination("user-a"),
            events.clone(),
        )
        .expect("delivery completes");

    let DeliveryTerminalEvent::Completed {
        delivery_id,
        result,
    } = terminal
    else {
        panic!("expected completed terminal event");
    };
    assert_eq!(delivery_id.as_str(), "delivery-complete");
    assert_eq!(
        (
            result.created,
            result.existing,
            result.retried,
            result.failed,
            result.cancelled,
        ),
        (1, 0, 0, 0, 0)
    );
    assert_eq!(api.ensure_calls.load(Ordering::SeqCst), 1);

    let recorded = events.events();
    assert_eq!(
        serde_json::to_value(&recorded).expect("events serialize"),
        serde_json::json!([
            {
                "type": "progress",
                "deliveryId": "delivery-complete",
                "progress": {"completed": 1, "total": 1}
            },
            {
                "type": "completed",
                "deliveryId": "delivery-complete",
                "result": {
                    "created": 1,
                    "existing": 0,
                    "retried": 0,
                    "failed": 0,
                    "cancelled": 0
                }
            }
        ])
    );
    let serialized = serde_json::to_string(&recorded).expect("events serialize");
    for forbidden in [
        "bookmark-id-canary",
        "private-title",
        "private-note",
        "https://x.com",
        "karakeep-1",
        "\"error\"",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "events leaked forbidden value {forbidden}: {serialized}"
        );
    }
}

#[test]
fn one_active_delivery_can_be_cancelled_and_reports_partial_work_totals() {
    let (started_tx, started_rx) = mpsc::channel();
    let coordinator = Arc::new(DeliveryCoordinator::with_config(ledger(), fast_config()).unwrap());
    let first_id = delivery_id("delivery-active");
    let run_coordinator = Arc::clone(&coordinator);
    let run_id = first_id.clone();
    let run_events = Arc::new(RecordingEvents::default());
    let run = run_coordinator
        .prepare_run(
            Arc::new(BlockingApi {
                started: Mutex::new(Some(started_tx)),
                ensure_calls: AtomicUsize::new(0),
            }),
            run_id,
            preview(&["secret-bookmark-1", "secret-bookmark-2"]),
            destination("user-a"),
            run_events.clone(),
        )
        .expect("delivery reserves the active slot");
    let handle = thread::spawn(move || run.execute());
    started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("delivery starts");

    let busy = match coordinator.prepare_run(
        Arc::new(SuccessfulApi::default()),
        delivery_id("delivery-second"),
        preview(&["other"]),
        destination("user-a"),
        Arc::new(RecordingEvents::default()),
    ) {
        Ok(_) => panic!("a second delivery must be rejected"),
        Err(error) => error,
    };
    assert_eq!(busy.code, DeliveryCoordinatorErrorCode::AlreadyActive);

    coordinator
        .cancel(&first_id)
        .expect("active delivery cancels");
    let terminal = handle.join().expect("delivery thread joins");
    let DeliveryTerminalEvent::Cancelled { result, .. } = &terminal else {
        panic!("expected cancelled terminal event");
    };
    assert_eq!(
        (
            result.created,
            result.existing,
            result.retried,
            result.failed,
            result.cancelled,
        ),
        (1, 0, 0, 0, 1)
    );
    assert_eq!(
        run_events.events().last(),
        Some(&DeliveryEvent::Terminal(terminal))
    );
    let serialized = serde_json::to_string(&run_events.events()).unwrap();
    assert!(!serialized.contains("secret-bookmark"));
    assert!(!serialized.contains("cancelled-api-secret-canary"));
}

#[test]
fn failure_codes_match_the_frontend_contract() {
    assert_eq!(
        serde_json::to_value([
            DeliveryFailureCode::DestinationAuthentication,
            DeliveryFailureCode::DestinationCompatibility,
            DeliveryFailureCode::DeliveryFailed,
            DeliveryFailureCode::Network,
            DeliveryFailureCode::Unexpected,
        ])
        .unwrap(),
        serde_json::json!([
            "destination-authentication",
            "destination-compatibility",
            "delivery-failed",
            "network",
            "unexpected"
        ])
    );
}

#[test]
fn cancellation_is_available_as_soon_as_run_preparation_succeeds() {
    let api = Arc::new(SuccessfulApi::default());
    let coordinator = DeliveryCoordinator::with_config(ledger(), fast_config()).unwrap();
    let id = delivery_id("delivery-cancel-before-worker");
    assert!(!coordinator.is_active());
    let run = coordinator
        .prepare_run(
            api.clone(),
            id.clone(),
            preview(&["not-yet-started"]),
            destination("user-a"),
            Arc::new(RecordingEvents::default()),
        )
        .expect("run reserves active delivery");
    assert!(coordinator.is_active());

    coordinator
        .cancel(&id)
        .expect("prepared delivery is immediately cancellable");
    let terminal = run.execute();

    assert!(matches!(
        terminal,
        DeliveryTerminalEvent::Cancelled {
            result: delivery_coordinator::DeliveryResult { cancelled: 1, .. },
            ..
        }
    ));
    assert_eq!(api.ensure_calls.load(Ordering::SeqCst), 0);
    assert!(!coordinator.is_active());
}

#[test]
fn a_ledger_failure_emits_only_the_typed_failed_contract() {
    let ledger = ledger();
    let poisoned = Arc::clone(&ledger);
    let _ = thread::spawn(move || {
        let _guard = poisoned.lock().expect("ledger lock");
        panic!("poison the test ledger");
    })
    .join();
    let coordinator = DeliveryCoordinator::new(ledger);
    let events = Arc::new(RecordingEvents::default());

    let terminal = coordinator
        .run(
            Arc::new(SuccessfulApi::default()),
            delivery_id("delivery-failure"),
            preview(&["failure-bookmark-id-canary"]),
            destination("user-a"),
            events.clone(),
        )
        .expect("operational failure is a terminal event");
    assert_eq!(
        terminal,
        DeliveryTerminalEvent::Failed {
            delivery_id: delivery_id("delivery-failure"),
            code: DeliveryFailureCode::DeliveryFailed,
        }
    );
    assert_eq!(
        serde_json::to_value(events.events()).unwrap(),
        serde_json::json!([{
            "type": "failed",
            "deliveryId": "delivery-failure",
            "code": "delivery-failed"
        }])
    );
}

#[test]
fn a_later_run_resumes_pending_records_without_exposing_failure_details() {
    let ledger = ledger();
    let coordinator = DeliveryCoordinator::with_config(Arc::clone(&ledger), fast_config()).unwrap();
    let api = Arc::new(FailOnceApi::new());
    let source = preview(&["resume-bookmark-id-canary"]);
    let destination = destination("user-a");
    let first_events = Arc::new(RecordingEvents::default());

    let first = coordinator
        .run(
            api.clone(),
            delivery_id("delivery-first"),
            source.clone(),
            destination.clone(),
            first_events.clone(),
        )
        .unwrap();
    let DeliveryTerminalEvent::Completed { result, .. } = first else {
        panic!("expected completed terminal event with failed records");
    };
    assert_eq!((result.failed, result.cancelled), (1, 0));
    let first_json = serde_json::to_string(&first_events.events()).unwrap();
    assert!(!first_json.contains("bookmark-content-and-api-key-canary"));
    assert!(!first_json.contains("resume-bookmark-id-canary"));

    assert_eq!(
        coordinator
            .preview(&source, &destination)
            .expect("pending preview")
            .pending,
        1
    );
    let resumed = coordinator
        .run(
            api,
            delivery_id("delivery-resumed"),
            source.clone(),
            destination.clone(),
            Arc::new(RecordingEvents::default()),
        )
        .unwrap();
    let DeliveryTerminalEvent::Completed { result, .. } = resumed else {
        panic!("expected resumed completion");
    };
    assert_eq!(
        (
            result.created,
            result.existing,
            result.retried,
            result.failed,
            result.cancelled,
        ),
        (1, 0, 1, 0, 0)
    );
    assert_eq!(
        coordinator
            .preview(&source, &destination)
            .expect("completed preview")
            .pending,
        0
    );
}
