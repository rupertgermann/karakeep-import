use std::{
    collections::{HashMap, VecDeque},
    sync::atomic::{AtomicUsize, Ordering},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};

use karakeep_transfer_lib::{
    delivery::{
        CancellationToken, Clock, DeliveryConfig, DeliveryEngine, DeliveryLedger, DeliveryProgress,
        DeliveryRecord, DeliverySource, DeliveryTotals, DestinationId, LedgerError, LedgerStatus,
        NoopProgressSink, PendingDelivery, ProgressSink, RecordResult, RecordStatus, RetryPolicy,
        SourceError,
    },
    karakeep::{
        ApiError, ApiErrorKind, BookmarkDraft, BookmarkOrigin, EnsuredBookmark, KarakeepApi,
        KarakeepBookmark, RequestCancellation,
    },
};

#[derive(Clone)]
struct VecSource(Vec<DeliveryRecord>);

impl DeliverySource for VecSource {
    fn records(&self) -> Result<Vec<DeliveryRecord>, SourceError> {
        Ok(self.0.clone())
    }
}

#[derive(Default)]
struct MemoryLedger {
    delivered: Mutex<Vec<String>>,
    pending: Mutex<Vec<PendingDelivery>>,
}

impl DeliveryLedger for MemoryLedger {
    fn status(
        &self,
        _destination: &DestinationId,
        source_id: &str,
    ) -> Result<LedgerStatus, LedgerError> {
        if self
            .delivered
            .lock()
            .unwrap()
            .iter()
            .any(|id| id == source_id)
        {
            return Ok(LedgerStatus::Delivered);
        }
        let attempts = self
            .pending
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.source_id == source_id)
            .count();
        Ok(LedgerStatus::Pending { attempts })
    }

    fn record_pending(
        &self,
        _destination: &DestinationId,
        pending: PendingDelivery,
    ) -> Result<(), LedgerError> {
        self.pending.lock().unwrap().push(pending);
        Ok(())
    }

    fn record_delivered(
        &self,
        _destination: &DestinationId,
        source_id: &str,
        _bookmark_id: &str,
        _origin: BookmarkOrigin,
    ) -> Result<(), LedgerError> {
        self.delivered.lock().unwrap().push(source_id.to_owned());
        Ok(())
    }
}

struct ExistingApi {
    attached: Mutex<Vec<String>>,
}

struct IncompleteTagApi {
    ensure_count: Mutex<usize>,
    attach_count: Mutex<usize>,
}

struct ScriptedApi {
    ensure_results: Mutex<VecDeque<Result<EnsuredBookmark, ApiError>>>,
    ensure_count: Arc<Mutex<usize>>,
}

struct ConcurrencyApi {
    active: AtomicUsize,
    max_active: AtomicUsize,
}

impl ConcurrencyApi {
    fn new() -> Self {
        Self {
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
        }
    }
}

impl KarakeepApi for ConcurrencyApi {
    fn ensure_bookmark(
        &self,
        draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(30));
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: draft.url.clone(),
                human_tags: Vec::new(),
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

struct TimedApi {
    clock: Arc<FakeClock>,
    request_times: Mutex<Vec<Duration>>,
}

struct CancelDuringEnsureApi {
    cancellation: CancellationToken,
    attach_count: AtomicUsize,
}

impl KarakeepApi for CancelDuringEnsureApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        self.cancellation.cancel();
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: "created-before-cancel".into(),
                human_tags: Vec::new(),
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
        self.attach_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct CancelAfterFirstProgress {
    cancellation: CancellationToken,
    events: Mutex<Vec<DeliveryProgress>>,
}

struct MixedOutcomeApi {
    attempts: Mutex<HashMap<String, usize>>,
}

struct WaitingForCancelApi {
    started: Arc<(Mutex<bool>, Condvar)>,
}

impl KarakeepApi for WaitingForCancelApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        let (started, condition) = &*self.started;
        *started.lock().unwrap() = true;
        condition.notify_one();
        while !cancellation.is_cancelled() {
            thread::yield_now();
        }
        Err(ApiError::new(ApiErrorKind::Network, "request cancelled"))
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

impl KarakeepApi for MixedOutcomeApi {
    fn ensure_bookmark(
        &self,
        draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        let source_id = draft.url.rsplit('/').next().unwrap().to_owned();
        let mut attempts = self.attempts.lock().unwrap();
        let attempt = attempts.entry(source_id.clone()).or_default();
        *attempt += 1;
        match (source_id.as_str(), *attempt) {
            ("created", _) => Ok(EnsuredBookmark {
                bookmark: KarakeepBookmark {
                    id: "created-id".into(),
                    human_tags: Vec::new(),
                },
                origin: BookmarkOrigin::Created,
            }),
            ("existing", _) => Ok(EnsuredBookmark {
                bookmark: KarakeepBookmark {
                    id: "existing-id".into(),
                    human_tags: Vec::new(),
                },
                origin: BookmarkOrigin::Existing,
            }),
            ("retry", 1) => Err(ApiError::new(ApiErrorKind::Network, "offline")),
            ("retry", _) => Ok(EnsuredBookmark {
                bookmark: KarakeepBookmark {
                    id: "retry-id".into(),
                    human_tags: Vec::new(),
                },
                origin: BookmarkOrigin::Existing,
            }),
            ("failed", _) => Err(ApiError::new(ApiErrorKind::Permanent, "rejected")),
            _ => unreachable!("unexpected source id"),
        }
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

#[derive(Default)]
struct RecordingProgress {
    events: Mutex<Vec<DeliveryProgress>>,
}

impl ProgressSink for RecordingProgress {
    fn publish(&self, progress: DeliveryProgress) {
        self.events.lock().unwrap().push(progress);
    }
}

impl ProgressSink for CancelAfterFirstProgress {
    fn publish(&self, progress: DeliveryProgress) {
        if progress.processed == 1 {
            self.cancellation.cancel();
        }
        self.events.lock().unwrap().push(progress);
    }
}

impl KarakeepApi for TimedApi {
    fn ensure_bookmark(
        &self,
        draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        self.request_times.lock().unwrap().push(self.clock.now());
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: draft.url.clone(),
                human_tags: Vec::new(),
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
        self.request_times.lock().unwrap().push(self.clock.now());
        Ok(())
    }
}

impl ScriptedApi {
    fn new(results: Vec<Result<EnsuredBookmark, ApiError>>) -> Self {
        Self {
            ensure_results: Mutex::new(results.into()),
            ensure_count: Arc::new(Mutex::new(0)),
        }
    }
}

impl KarakeepApi for ScriptedApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        *self.ensure_count.lock().unwrap() += 1;
        self.ensure_results
            .lock()
            .unwrap()
            .pop_front()
            .expect("script has an ensure response")
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

#[derive(Default)]
struct FakeClock {
    now: Mutex<Duration>,
    sleeps: Mutex<Vec<Duration>>,
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        *self.now.lock().unwrap()
    }

    fn sleep(&self, duration: Duration) {
        self.sleeps.lock().unwrap().push(duration);
        *self.now.lock().unwrap() += duration;
    }
}

fn ensured_created() -> EnsuredBookmark {
    EnsuredBookmark {
        bookmark: KarakeepBookmark {
            id: "bookmark-1".into(),
            human_tags: vec!["twitter".into(), "Reading".into()],
        },
        origin: BookmarkOrigin::Created,
    }
}

fn fast_retry_config(max_retries: usize) -> DeliveryConfig {
    DeliveryConfig {
        max_concurrency: 1,
        requests_per_second: 1_000.0,
        retry: RetryPolicy {
            max_retries,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(30),
        },
        pending_limit: None,
    }
}

impl KarakeepApi for IncompleteTagApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        let mut count = self.ensure_count.lock().unwrap();
        *count += 1;
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: "bookmark-1".into(),
                human_tags: vec!["twitter".into()],
            },
            origin: if *count == 1 {
                BookmarkOrigin::Created
            } else {
                BookmarkOrigin::Existing
            },
        })
    }

    fn attach_tags(
        &self,
        _bookmark_id: &str,
        _tags: &[String],
        _cancellation: &dyn RequestCancellation,
    ) -> Result<(), ApiError> {
        let mut count = self.attach_count.lock().unwrap();
        *count += 1;
        if *count == 1 {
            Err(ApiError::new(
                karakeep_transfer_lib::karakeep::ApiErrorKind::Permanent,
                "tag attachment rejected",
            ))
        } else {
            Ok(())
        }
    }
}

impl KarakeepApi for ExistingApi {
    fn ensure_bookmark(
        &self,
        _draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: "existing-1".into(),
                human_tags: vec!["TWITTER".into(), "Already there".into()],
            },
            origin: BookmarkOrigin::Existing,
        })
    }

    fn attach_tags(
        &self,
        _bookmark_id: &str,
        tags: &[String],
        _cancellation: &dyn RequestCancellation,
    ) -> Result<(), ApiError> {
        self.attached.lock().unwrap().extend_from_slice(tags);
        Ok(())
    }
}

fn record(source_id: &str, required_tags: &[&str]) -> DeliveryRecord {
    DeliveryRecord {
        source_id: source_id.into(),
        bookmark: BookmarkDraft {
            url: format!("https://x.com/example/status/{source_id}"),
            title: Some("Source title must not replace destination content".into()),
            note: Some("Source note must not replace destination content".into()),
            created_at: Some("2023-10-11T14:08:46Z".into()),
        },
        required_tags: required_tags.iter().map(|tag| (*tag).into()).collect(),
    }
}

#[test]
fn existing_bookmark_gets_only_missing_tags_before_it_is_recorded_delivered() {
    let api = Arc::new(ExistingApi {
        attached: Mutex::new(Vec::new()),
    });
    let ledger = Arc::new(MemoryLedger::default());
    let engine =
        DeliveryEngine::new(api.clone(), ledger.clone(), DeliveryConfig::default()).unwrap();

    let report = engine
        .run(
            &VecSource(vec![record("123", &["twitter", "Reading"])]),
            &DestinationId::new("https://karakeep.example.com/user-1"),
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(*api.attached.lock().unwrap(), ["Reading"]);
    assert_eq!(*ledger.delivered.lock().unwrap(), ["123"]);
    assert_eq!(report.records[0].origin, Some(BookmarkOrigin::Existing));
    assert_eq!(report.records[0].status, RecordStatus::Delivered);
    assert_eq!(report.totals.existing, 1);
    assert_eq!(report.totals.delivered, 1);
}

#[test]
fn incomplete_tagging_stays_pending_and_the_next_run_finishes_the_existing_bookmark() {
    let api = Arc::new(IncompleteTagApi {
        ensure_count: Mutex::new(0),
        attach_count: Mutex::new(0),
    });
    let ledger = Arc::new(MemoryLedger::default());
    let engine = DeliveryEngine::new(api, ledger.clone(), DeliveryConfig::default()).unwrap();
    let source = VecSource(vec![record("123", &["twitter", "Reading"])]);
    let destination = DestinationId::new("https://karakeep.example.com/user-1");

    let first = engine
        .run(
            &source,
            &destination,
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(first.records[0].origin, Some(BookmarkOrigin::Created));
    assert_eq!(first.records[0].status, RecordStatus::Failed);
    assert_eq!(first.totals.failed, 1);
    assert!(ledger.delivered.lock().unwrap().is_empty());
    assert_eq!(ledger.pending.lock().unwrap().len(), 1);

    let resumed = engine
        .run(
            &source,
            &destination,
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(resumed.records[0].origin, Some(BookmarkOrigin::Existing));
    assert_eq!(resumed.records[0].status, RecordStatus::Delivered);
    assert!(resumed.records[0].retried);
    assert_eq!(resumed.totals.existing, 1);
    assert_eq!(resumed.totals.retried, 1);
    assert_eq!(resumed.totals.delivered, 1);
    assert_eq!(*ledger.delivered.lock().unwrap(), ["123"]);
}

#[test]
fn retryable_api_failures_back_off_and_report_the_record_as_retried() {
    let cases = [
        (
            ApiErrorKind::RateLimited {
                retry_after: Some(Duration::from_secs(120)),
            },
            Duration::from_secs(30),
        ),
        (ApiErrorKind::Server, Duration::from_secs(1)),
        (ApiErrorKind::Network, Duration::from_secs(1)),
        (ApiErrorKind::Timeout, Duration::from_secs(1)),
    ];

    for (kind, expected_delay) in cases {
        let api = Arc::new(ScriptedApi::new(vec![
            Err(ApiError::new(kind, "temporary failure")),
            Ok(ensured_created()),
        ]));
        let clock = Arc::new(FakeClock::default());
        let engine = DeliveryEngine::with_clock(
            api,
            Arc::new(MemoryLedger::default()),
            fast_retry_config(1),
            clock.clone(),
        )
        .unwrap();

        let report = engine
            .run(
                &VecSource(vec![record("123", &["twitter", "Reading"])]),
                &DestinationId::new("destination"),
                &CancellationToken::new(),
                &NoopProgressSink,
            )
            .unwrap();

        assert_eq!(report.records[0].status, RecordStatus::Delivered);
        assert!(report.records[0].retried);
        assert_eq!(report.totals.retried, 1);
        assert_eq!(*clock.sleeps.lock().unwrap(), [expected_delay]);
    }
}

#[test]
fn retries_are_bounded_and_permanent_failures_are_not_retried() {
    let retryable_api = Arc::new(ScriptedApi::new(vec![
        Err(ApiError::new(ApiErrorKind::Server, "temporary one")),
        Err(ApiError::new(ApiErrorKind::Server, "temporary two")),
    ]));
    let retryable_calls = retryable_api.ensure_count.clone();
    let retryable = DeliveryEngine::with_clock(
        retryable_api,
        Arc::new(MemoryLedger::default()),
        fast_retry_config(1),
        Arc::new(FakeClock::default()),
    )
    .unwrap()
    .run(
        &VecSource(vec![record("retryable", &[])]),
        &DestinationId::new("destination"),
        &CancellationToken::new(),
        &NoopProgressSink,
    )
    .unwrap();

    assert_eq!(*retryable_calls.lock().unwrap(), 2);
    assert_eq!(retryable.records[0].status, RecordStatus::Failed);
    assert!(retryable.records[0].retried);

    let permanent_api = Arc::new(ScriptedApi::new(vec![Err(ApiError::new(
        ApiErrorKind::Permanent,
        "invalid request",
    ))]));
    let permanent_calls = permanent_api.ensure_count.clone();
    let permanent = DeliveryEngine::with_clock(
        permanent_api,
        Arc::new(MemoryLedger::default()),
        fast_retry_config(5),
        Arc::new(FakeClock::default()),
    )
    .unwrap()
    .run(
        &VecSource(vec![record("permanent", &[])]),
        &DestinationId::new("destination"),
        &CancellationToken::new(),
        &NoopProgressSink,
    )
    .unwrap();

    assert_eq!(*permanent_calls.lock().unwrap(), 1);
    assert_eq!(permanent.records[0].status, RecordStatus::Failed);
    assert!(!permanent.records[0].retried);
}

#[test]
fn multi_record_delivery_uses_bounded_concurrency() {
    let api = Arc::new(ConcurrencyApi::new());
    let engine = DeliveryEngine::new(
        api.clone(),
        Arc::new(MemoryLedger::default()),
        DeliveryConfig {
            max_concurrency: 2,
            requests_per_second: 10_000.0,
            ..DeliveryConfig::default()
        },
    )
    .unwrap();
    let source = VecSource(
        (0..6)
            .map(|index| record(&index.to_string(), &[]))
            .collect(),
    );
    let progress = RecordingProgress::default();

    let report = engine
        .run(
            &source,
            &DestinationId::new("destination"),
            &CancellationToken::new(),
            &progress,
        )
        .unwrap();

    assert_eq!(api.max_active.load(Ordering::SeqCst), 2);
    assert_eq!(report.totals.created, 6);
    assert_eq!(report.totals.delivered, 6);
    let events = progress.events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| (event.processed, event.totals.delivered))
            .collect::<Vec<_>>(),
        [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6)]
    );
}

#[test]
fn request_rate_limit_is_shared_by_all_workers() {
    let clock = Arc::new(FakeClock::default());
    let api = Arc::new(TimedApi {
        clock: clock.clone(),
        request_times: Mutex::new(Vec::new()),
    });
    let engine = DeliveryEngine::with_clock(
        api.clone(),
        Arc::new(MemoryLedger::default()),
        DeliveryConfig {
            max_concurrency: 3,
            requests_per_second: 2.0,
            retry: RetryPolicy::default(),
            pending_limit: None,
        },
        clock,
    )
    .unwrap();

    engine
        .run(
            &VecSource(vec![record("1", &["twitter"]), record("2", &["twitter"])]),
            &DestinationId::new("destination"),
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    let mut request_times = api.request_times.lock().unwrap().clone();
    request_times.sort();
    assert_eq!(
        request_times,
        [
            Duration::ZERO,
            Duration::from_millis(500),
            Duration::from_secs(1),
            Duration::from_millis(1_500),
        ]
    );
}

#[test]
fn cancellation_after_bookmark_creation_stops_tagging_and_does_not_mark_delivery() {
    let cancellation = CancellationToken::new();
    let api = Arc::new(CancelDuringEnsureApi {
        cancellation: cancellation.clone(),
        attach_count: AtomicUsize::new(0),
    });
    let ledger = Arc::new(MemoryLedger::default());
    let report = DeliveryEngine::new(api.clone(), ledger.clone(), fast_retry_config(0))
        .unwrap()
        .run(
            &VecSource(vec![record("123", &["Reading"])]),
            &DestinationId::new("destination"),
            &cancellation,
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(api.attach_count.load(Ordering::SeqCst), 0);
    assert!(ledger.delivered.lock().unwrap().is_empty());
    assert_eq!(ledger.pending.lock().unwrap().len(), 1);
    assert_eq!(report.records[0].origin, Some(BookmarkOrigin::Created));
    assert_eq!(report.records[0].status, RecordStatus::Cancelled);
    assert_eq!(report.totals.created, 1);
    assert_eq!(report.totals.cancelled, 1);
    assert_eq!(report.totals.pending, 1);

    let resumed_api = Arc::new(ExistingApi {
        attached: Mutex::new(Vec::new()),
    });
    let resumed = DeliveryEngine::new(resumed_api.clone(), ledger.clone(), fast_retry_config(0))
        .unwrap()
        .run(
            &VecSource(vec![record("123", &["Reading"])]),
            &DestinationId::new("destination"),
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(*resumed_api.attached.lock().unwrap(), ["Reading"]);
    assert_eq!(resumed.records[0].origin, Some(BookmarkOrigin::Existing));
    assert_eq!(resumed.records[0].status, RecordStatus::Delivered);
    assert!(resumed.records[0].retried);
}

#[test]
fn cancellation_stops_starting_more_records_and_progress_totals_stay_consistent() {
    let cancellation = CancellationToken::new();
    let api = Arc::new(ScriptedApi::new(vec![
        Ok(ensured_created()),
        Ok(ensured_created()),
        Ok(ensured_created()),
    ]));
    let calls = api.ensure_count.clone();
    let progress = CancelAfterFirstProgress {
        cancellation: cancellation.clone(),
        events: Mutex::new(Vec::new()),
    };
    let ledger = Arc::new(MemoryLedger::default());
    let report = DeliveryEngine::new(api, ledger.clone(), fast_retry_config(0))
        .unwrap()
        .run(
            &VecSource(vec![record("1", &[]), record("2", &[]), record("3", &[])]),
            &DestinationId::new("destination"),
            &cancellation,
            &progress,
        )
        .unwrap();

    assert_eq!(*calls.lock().unwrap(), 1);
    assert_eq!(report.totals.delivered, 1);
    assert_eq!(report.totals.cancelled, 2);
    assert_eq!(report.totals.pending, 2);
    assert!(
        ledger.pending.lock().unwrap().is_empty(),
        "records whose API work never started stay source-pending without a failed ledger attempt"
    );
    assert_eq!(
        report
            .records
            .iter()
            .map(|record| record.status)
            .collect::<Vec<_>>(),
        [
            RecordStatus::Delivered,
            RecordStatus::Cancelled,
            RecordStatus::Cancelled,
        ]
    );
    let events = progress.events.lock().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events.last().unwrap().totals, report.totals);
}

#[test]
fn final_and_structured_progress_totals_distinguish_every_delivery_outcome() {
    let ledger = Arc::new(MemoryLedger::default());
    ledger.delivered.lock().unwrap().push("skipped".into());
    let progress = RecordingProgress::default();
    let report = DeliveryEngine::with_clock(
        Arc::new(MixedOutcomeApi {
            attempts: Mutex::new(HashMap::new()),
        }),
        ledger,
        fast_retry_config(1),
        Arc::new(FakeClock::default()),
    )
    .unwrap()
    .run(
        &VecSource(vec![
            record("skipped", &[]),
            record("created", &[]),
            record("existing", &[]),
            record("retry", &[]),
            record("failed", &[]),
        ]),
        &DestinationId::new("destination"),
        &CancellationToken::new(),
        &progress,
    )
    .unwrap();

    assert_eq!(report.totals.total, 5);
    assert_eq!(report.totals.skipped, 1);
    assert_eq!(report.totals.created, 1);
    assert_eq!(report.totals.existing, 2);
    assert_eq!(report.totals.retried, 1);
    assert_eq!(report.totals.delivered, 3);
    assert_eq!(report.totals.failed, 1);
    assert_eq!(report.totals.cancelled, 0);
    assert_eq!(report.totals.pending, 1);

    let events = progress.events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.processed)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    assert_eq!(events.last().unwrap().totals, report.totals);
}

#[test]
fn active_api_work_observes_cancellation_without_starting_a_retry() {
    let started = Arc::new((Mutex::new(false), Condvar::new()));
    let cancellation = CancellationToken::new();
    let clock = Arc::new(FakeClock::default());
    let engine = DeliveryEngine::with_clock(
        Arc::new(WaitingForCancelApi {
            started: started.clone(),
        }),
        Arc::new(MemoryLedger::default()),
        fast_retry_config(5),
        clock.clone(),
    )
    .unwrap();
    let worker_cancellation = cancellation.clone();
    let worker = thread::spawn(move || {
        engine
            .run(
                &VecSource(vec![record("active", &[])]),
                &DestinationId::new("destination"),
                &worker_cancellation,
                &NoopProgressSink,
            )
            .unwrap()
    });

    let (has_started, condition) = &*started;
    let mut has_started = has_started.lock().unwrap();
    while !*has_started {
        has_started = condition.wait(has_started).unwrap();
    }
    cancellation.cancel();
    drop(has_started);
    let report = worker.join().unwrap();

    assert_eq!(report.records[0].status, RecordStatus::Cancelled);
    assert_eq!(report.totals.cancelled, 1);
    assert!(clock.sleeps.lock().unwrap().is_empty());
}

#[test]
fn progress_has_a_stable_serializable_frontend_contract() {
    let value = serde_json::to_value(DeliveryProgress {
        processed: 2,
        totals: DeliveryTotals {
            total: 3,
            created: 1,
            delivered: 1,
            failed: 1,
            pending: 1,
            ..DeliveryTotals::default()
        },
        latest: RecordResult {
            source_id: "123".into(),
            origin: Some(BookmarkOrigin::Created),
            status: RecordStatus::Delivered,
            retried: true,
            error: None,
            failure_kind: None,
        },
    })
    .unwrap();

    assert_eq!(
        value,
        serde_json::json!({
            "processed": 2,
            "totals": {
                "total": 3,
                "skipped": 0,
                "created": 1,
                "existing": 0,
                "retried": 0,
                "delivered": 1,
                "cancelled": 0,
                "failed": 1,
                "pending": 1
            },
            "latest": {
                "sourceId": "123",
                "origin": "created",
                "status": "delivered",
                "retried": true,
                "error": null
            }
        })
    );
}

/// Records every bookmark it is asked to create, so a test can prove which
/// records a run actually touched.
#[derive(Default)]
struct CountingApi {
    created: Mutex<Vec<String>>,
}

impl KarakeepApi for CountingApi {
    fn ensure_bookmark(
        &self,
        draft: &BookmarkDraft,
        _cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        self.created.lock().unwrap().push(draft.url.clone());
        Ok(EnsuredBookmark {
            bookmark: KarakeepBookmark {
                id: "bookmark".into(),
                human_tags: Vec::new(),
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

fn limited_config(limit: Option<usize>) -> DeliveryConfig {
    DeliveryConfig {
        max_concurrency: 1,
        pending_limit: limit,
        ..fast_retry_config(0)
    }
}

#[test]
fn a_limit_caps_the_run_at_the_first_pending_records_after_skipping_delivered_ones() {
    let ledger = Arc::new(MemoryLedger::default());
    ledger.delivered.lock().unwrap().push("already".into());
    let api = Arc::new(CountingApi::default());

    let report = DeliveryEngine::new(api.clone(), ledger.clone(), limited_config(Some(2)))
        .unwrap()
        .run(
            &VecSource(vec![
                record("already", &[]),
                record("first", &[]),
                record("second", &[]),
                record("third", &[]),
            ]),
            &DestinationId::new("destination"),
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(
        *api.created.lock().unwrap(),
        vec![
            "https://x.com/example/status/first".to_string(),
            "https://x.com/example/status/second".to_string(),
        ]
    );
    assert_eq!(report.totals.delivered, 2);
    assert_eq!(report.totals.skipped, 1);
    assert_eq!(report.totals.failed, 0);
    assert_eq!(report.totals.cancelled, 0);
    assert_eq!(report.totals.total, 3);
}

#[test]
fn records_beyond_the_limit_stay_pending_for_a_later_run() {
    let ledger = Arc::new(MemoryLedger::default());
    let api = Arc::new(CountingApi::default());
    let source = VecSource(vec![record("first", &[]), record("second", &[])]);

    DeliveryEngine::new(api.clone(), ledger.clone(), limited_config(Some(1)))
        .unwrap()
        .run(
            &source,
            &DestinationId::new("destination"),
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();
    assert!(ledger.pending.lock().unwrap().is_empty());

    let report = DeliveryEngine::new(api.clone(), ledger, limited_config(None))
        .unwrap()
        .run(
            &source,
            &DestinationId::new("destination"),
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(
        *api.created.lock().unwrap(),
        vec![
            "https://x.com/example/status/first".to_string(),
            "https://x.com/example/status/second".to_string(),
        ]
    );
    assert_eq!((report.totals.delivered, report.totals.skipped), (1, 1));
}

#[test]
fn a_limit_larger_than_the_pending_count_processes_every_pending_record() {
    let ledger = Arc::new(MemoryLedger::default());
    let api = Arc::new(CountingApi::default());

    let report = DeliveryEngine::new(api.clone(), ledger, limited_config(Some(10)))
        .unwrap()
        .run(
            &VecSource(vec![record("first", &[]), record("second", &[])]),
            &DestinationId::new("destination"),
            &CancellationToken::new(),
            &NoopProgressSink,
        )
        .unwrap();

    assert_eq!(api.created.lock().unwrap().len(), 2);
    assert_eq!(report.totals.delivered, 2);
    assert_eq!(report.totals.total, 2);
}
