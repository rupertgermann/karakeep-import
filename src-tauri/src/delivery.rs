use std::{
    collections::{HashSet, VecDeque},
    error::Error,
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use crate::karakeep::{
    ApiError, ApiErrorKind, BookmarkDraft, BookmarkOrigin, KarakeepApi, RequestCancellation,
};
use serde::Serialize;

pub use crate::karakeep::RequestCancellation as Cancellation;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DestinationId(String);

impl DestinationId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryRecord {
    pub source_id: String,
    pub bookmark: BookmarkDraft,
    pub required_tags: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceError(pub String);

impl fmt::Display for SourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for SourceError {}

pub trait DeliverySource: Send + Sync {
    fn records(&self) -> Result<Vec<DeliveryRecord>, SourceError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerError(pub String);

impl fmt::Display for LedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for LedgerError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LedgerStatus {
    Pending { attempts: usize },
    Delivered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDelivery {
    pub source_id: String,
    pub bookmark_id: Option<String>,
    pub origin: Option<BookmarkOrigin>,
    /// A redacted diagnostic supplied by the API or ledger boundary.
    pub error: String,
}

pub trait DeliveryLedger: Send + Sync {
    fn status(
        &self,
        destination: &DestinationId,
        source_id: &str,
    ) -> Result<LedgerStatus, LedgerError>;

    fn record_pending(
        &self,
        destination: &DestinationId,
        pending: PendingDelivery,
    ) -> Result<(), LedgerError>;

    fn record_delivered(
        &self,
        destination: &DestinationId,
        source_id: &str,
        bookmark_id: &str,
        origin: BookmarkOrigin,
    ) -> Result<(), LedgerError>;
}

#[derive(Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl RequestCancellation for CancellationToken {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordStatus {
    Delivered,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResult {
    pub source_id: String,
    pub origin: Option<BookmarkOrigin>,
    pub status: RecordStatus,
    pub retried: bool,
    pub error: Option<String>,
    #[serde(skip)]
    pub failure_kind: Option<ApiErrorKind>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Origin totals (`created` and `existing`) are independent from terminal
/// totals because a created bookmark can still fail tagging or be cancelled.
pub struct DeliveryTotals {
    pub total: usize,
    pub skipped: usize,
    pub created: usize,
    pub existing: usize,
    pub retried: usize,
    pub delivered: usize,
    pub cancelled: usize,
    pub failed: usize,
    pub pending: usize,
}

impl DeliveryTotals {
    fn observe(&mut self, result: &RecordResult) {
        match result.origin {
            Some(BookmarkOrigin::Created) => self.created += 1,
            Some(BookmarkOrigin::Existing) => self.existing += 1,
            None => {}
        }
        if result.retried {
            self.retried += 1;
        }
        match result.status {
            RecordStatus::Delivered => self.delivered += 1,
            RecordStatus::Failed => {
                self.failed += 1;
                self.pending += 1;
            }
            RecordStatus::Cancelled => {
                self.cancelled += 1;
                self.pending += 1;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryProgress {
    pub processed: usize,
    pub totals: DeliveryTotals,
    pub latest: RecordResult,
}

pub trait ProgressSink: Send + Sync {
    fn publish(&self, progress: DeliveryProgress);
}

pub struct NoopProgressSink;

impl ProgressSink for NoopProgressSink {
    fn publish(&self, _progress: DeliveryProgress) {}
}

pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
    fn sleep(&self, duration: Duration);
}

struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }

    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRunReport {
    pub records: Vec<RecordResult>,
    pub totals: DeliveryTotals,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: usize,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 5,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeliveryConfig {
    pub max_concurrency: usize,
    pub requests_per_second: f64,
    pub retry: RetryPolicy,
    /// Caps one run at the first N pending records. Records beyond the cap are
    /// left untouched and stay eligible for a later run.
    pub pending_limit: Option<usize>,
}

impl Default for DeliveryConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 4,
            requests_per_second: 4.0,
            retry: RetryPolicy::default(),
            pending_limit: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ConfigError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeliveryRunError {
    Source(SourceError),
    Ledger(LedgerError),
}

impl fmt::Display for DeliveryRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Source(error) => write!(formatter, "source failed: {error}"),
            Self::Ledger(error) => write!(formatter, "ledger failed: {error}"),
        }
    }
}

impl Error for DeliveryRunError {}

pub struct DeliveryEngine {
    api: Arc<dyn KarakeepApi>,
    ledger: Arc<dyn DeliveryLedger>,
    config: DeliveryConfig,
    clock: Arc<dyn Clock>,
    request_gate: Arc<RequestGate>,
}

impl DeliveryEngine {
    pub fn new(
        api: Arc<dyn KarakeepApi>,
        ledger: Arc<dyn DeliveryLedger>,
        config: DeliveryConfig,
    ) -> Result<Self, ConfigError> {
        Self::with_clock(api, ledger, config, Arc::new(SystemClock::new()))
    }

    pub fn with_clock(
        api: Arc<dyn KarakeepApi>,
        ledger: Arc<dyn DeliveryLedger>,
        config: DeliveryConfig,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, ConfigError> {
        if config.max_concurrency == 0 {
            return Err(ConfigError(
                "max_concurrency must be greater than zero".into(),
            ));
        }
        if !config.requests_per_second.is_finite() || config.requests_per_second <= 0.0 {
            return Err(ConfigError(
                "requests_per_second must be finite and greater than zero".into(),
            ));
        }
        let request_gate = Arc::new(RequestGate::new(config.requests_per_second, clock.clone()));
        Ok(Self {
            api,
            ledger,
            config,
            clock,
            request_gate,
        })
    }

    pub fn run(
        &self,
        source: &dyn DeliverySource,
        destination: &DestinationId,
        cancellation: &dyn Cancellation,
        progress: &dyn ProgressSink,
    ) -> Result<DeliveryRunReport, DeliveryRunError> {
        let records = source.records().map_err(DeliveryRunError::Source)?;
        let mut initial_totals = DeliveryTotals {
            total: records.len(),
            ..DeliveryTotals::default()
        };
        let mut pending = VecDeque::new();
        for (index, record) in records.into_iter().enumerate() {
            let prior_attempts = match self
                .ledger
                .status(destination, &record.source_id)
                .map_err(DeliveryRunError::Ledger)?
            {
                LedgerStatus::Delivered => {
                    initial_totals.skipped += 1;
                    continue;
                }
                LedgerStatus::Pending { attempts } => attempts,
            };
            pending.push_back((index, record, prior_attempts));
        }
        if let Some(limit) = self.config.pending_limit {
            pending.truncate(limit);
            initial_totals.total = initial_totals.skipped + pending.len();
        }

        let worker_count = self.config.max_concurrency.min(pending.len());
        let queue = Arc::new(Mutex::new(pending));
        let totals = Arc::new(Mutex::new(initial_totals));
        let completed = Arc::new(Mutex::new(Vec::new()));

        thread::scope(|scope| {
            for _ in 0..worker_count {
                let queue = queue.clone();
                let totals = totals.clone();
                let completed = completed.clone();
                scope.spawn(move || {
                    loop {
                        let Some((index, record, prior_attempts)) =
                            queue.lock().unwrap().pop_front()
                        else {
                            break;
                        };
                        let result = if cancellation.is_cancelled() {
                            cancelled(record.source_id, None, prior_attempts > 0)
                        } else {
                            self.deliver_one(record, destination, prior_attempts, cancellation)
                        };
                        let mut current_totals = totals.lock().unwrap();
                        current_totals.observe(&result);
                        let processed = current_totals.delivered
                            + current_totals.failed
                            + current_totals.cancelled;
                        progress.publish(DeliveryProgress {
                            processed,
                            totals: current_totals.clone(),
                            latest: result.clone(),
                        });
                        drop(current_totals);
                        completed.lock().unwrap().push((index, result));
                    }
                });
            }
        });

        let mut records = Arc::try_unwrap(completed)
            .unwrap_or_else(|_| unreachable!("delivery workers have joined"))
            .into_inner()
            .unwrap();
        records.sort_by_key(|(index, _)| *index);
        let records = records.into_iter().map(|(_, result)| result).collect();
        let totals = Arc::try_unwrap(totals)
            .unwrap_or_else(|_| unreachable!("delivery workers have joined"))
            .into_inner()
            .unwrap();
        Ok(DeliveryRunReport { records, totals })
    }

    fn deliver_one(
        &self,
        record: DeliveryRecord,
        destination: &DestinationId,
        prior_attempts: usize,
        cancellation: &dyn Cancellation,
    ) -> RecordResult {
        let resumed = prior_attempts > 0;
        let (ensured, ensure_retried) = match self.request_with_retry(cancellation, || {
            self.api.ensure_bookmark(&record.bookmark, cancellation)
        }) {
            Ok(result) => result,
            Err(RequestFailure::Cancelled { retried }) => {
                return self.record_cancellation(
                    destination,
                    record.source_id,
                    None,
                    None,
                    resumed || retried,
                );
            }
            Err(RequestFailure::Api { error, retried }) => {
                let failure_kind = error.kind.clone();
                return self.record_failure(
                    destination,
                    PendingDelivery {
                        source_id: record.source_id,
                        bookmark_id: None,
                        origin: None,
                        error: error.to_string(),
                    },
                    resumed || retried,
                    failure_kind,
                );
            }
        };
        let missing = missing_tags(&record.required_tags, &ensured.bookmark.human_tags);
        let mut retried = resumed || ensure_retried;
        if !missing.is_empty() {
            match self.request_with_retry(cancellation, || {
                self.api
                    .attach_tags(&ensured.bookmark.id, &missing, cancellation)
            }) {
                Ok(((), tag_retried)) => retried |= tag_retried,
                Err(RequestFailure::Cancelled {
                    retried: tag_retried,
                }) => {
                    return self.record_cancellation(
                        destination,
                        record.source_id,
                        Some(ensured.bookmark.id),
                        Some(ensured.origin),
                        retried || tag_retried,
                    );
                }
                Err(RequestFailure::Api {
                    error,
                    retried: tag_retried,
                }) => {
                    let failure_kind = error.kind.clone();
                    return self.record_failure(
                        destination,
                        PendingDelivery {
                            source_id: record.source_id,
                            bookmark_id: Some(ensured.bookmark.id),
                            origin: Some(ensured.origin),
                            error: error.to_string(),
                        },
                        retried || tag_retried,
                        failure_kind,
                    );
                }
            }
        }
        if let Err(error) = self.ledger.record_delivered(
            destination,
            &record.source_id,
            &ensured.bookmark.id,
            ensured.origin,
        ) {
            return failed(
                record.source_id,
                Some(ensured.origin),
                retried,
                None,
                error.to_string(),
            );
        }
        RecordResult {
            source_id: record.source_id,
            origin: Some(ensured.origin),
            status: RecordStatus::Delivered,
            retried,
            error: None,
            failure_kind: None,
        }
    }

    fn request_with_retry<T>(
        &self,
        cancellation: &dyn Cancellation,
        mut request: impl FnMut() -> Result<T, ApiError>,
    ) -> Result<(T, bool), RequestFailure> {
        let mut retried = false;
        for attempt in 0..=self.config.retry.max_retries {
            if cancellation.is_cancelled() {
                return Err(RequestFailure::Cancelled { retried });
            }
            self.request_gate.wait();
            match request() {
                Ok(value) => return Ok((value, retried)),
                Err(_error) if cancellation.is_cancelled() => {
                    return Err(RequestFailure::Cancelled { retried });
                }
                Err(error) if error.is_retryable() && attempt < self.config.retry.max_retries => {
                    retried = true;
                    self.clock.sleep(self.retry_delay(attempt, &error));
                }
                Err(error) => return Err(RequestFailure::Api { error, retried }),
            }
        }
        unreachable!("bounded retry loop always returns")
    }

    fn retry_delay(&self, attempt: usize, error: &ApiError) -> Duration {
        if let ApiErrorKind::RateLimited {
            retry_after: Some(delay),
        } = error.kind
        {
            return delay.min(self.config.retry.max_delay);
        }
        let multiplier = 2_u32.saturating_pow(attempt.min(u32::MAX as usize) as u32);
        self.config
            .retry
            .base_delay
            .saturating_mul(multiplier)
            .min(self.config.retry.max_delay)
    }

    fn record_failure(
        &self,
        destination: &DestinationId,
        pending: PendingDelivery,
        retried: bool,
        failure_kind: ApiErrorKind,
    ) -> RecordResult {
        let source_id = pending.source_id.clone();
        let origin = pending.origin;
        let error = pending.error.clone();
        let ledger_result = self.ledger.record_pending(destination, pending);
        match ledger_result {
            Ok(()) => failed(source_id, origin, retried, Some(failure_kind), error),
            Err(ledger_error) => failed(source_id, origin, retried, None, ledger_error.to_string()),
        }
    }

    fn record_cancellation(
        &self,
        destination: &DestinationId,
        source_id: String,
        bookmark_id: Option<String>,
        origin: Option<BookmarkOrigin>,
        retried: bool,
    ) -> RecordResult {
        let ledger_error = self
            .ledger
            .record_pending(
                destination,
                PendingDelivery {
                    source_id: source_id.clone(),
                    bookmark_id,
                    origin,
                    error: "cancelled".into(),
                },
            )
            .err()
            .map(|error| error.to_string());
        let mut result = cancelled(source_id, origin, retried);
        result.error = ledger_error;
        result
    }
}

enum RequestFailure {
    Api { error: ApiError, retried: bool },
    Cancelled { retried: bool },
}

struct RequestGate {
    interval: Duration,
    next_slot: Mutex<Duration>,
    clock: Arc<dyn Clock>,
}

impl RequestGate {
    fn new(requests_per_second: f64, clock: Arc<dyn Clock>) -> Self {
        Self {
            interval: Duration::from_secs_f64(1.0 / requests_per_second),
            next_slot: Mutex::new(Duration::ZERO),
            clock,
        }
    }

    fn wait(&self) {
        let mut next_slot = self.next_slot.lock().unwrap();
        let now = self.clock.now();
        let slot = now.max(*next_slot);
        let delay = slot.saturating_sub(now);
        if !delay.is_zero() {
            self.clock.sleep(delay);
        }
        *next_slot = slot.saturating_add(self.interval);
    }
}

fn failed(
    source_id: String,
    origin: Option<BookmarkOrigin>,
    retried: bool,
    failure_kind: Option<ApiErrorKind>,
    error: String,
) -> RecordResult {
    RecordResult {
        source_id,
        origin,
        status: RecordStatus::Failed,
        retried,
        error: Some(error),
        failure_kind,
    }
}

fn cancelled(source_id: String, origin: Option<BookmarkOrigin>, retried: bool) -> RecordResult {
    RecordResult {
        source_id,
        origin,
        status: RecordStatus::Cancelled,
        retried,
        error: None,
        failure_kind: None,
    }
}

fn missing_tags(required: &[String], current: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = current.iter().map(|tag| tag.to_lowercase()).collect();
    required
        .iter()
        .filter_map(|tag| {
            let trimmed = tag.trim();
            let normalized = trimmed.to_lowercase();
            if trimmed.is_empty() || !seen.insert(normalized) {
                None
            } else {
                Some(trimmed.to_owned())
            }
        })
        .collect()
}
