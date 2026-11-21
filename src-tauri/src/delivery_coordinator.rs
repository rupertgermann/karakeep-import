use std::{
    collections::HashSet,
    error::Error,
    fmt,
    sync::{Arc, Mutex},
};

use serde::Serialize;

use crate::{
    delivery::{
        self, CancellationToken, DeliveryConfig, DeliveryProgress, DeliveryRunError,
        DeliveryTotals, ProgressSink, RecordStatus,
    },
    domain::{DestinationIdentity, RunStatus},
    file_source::FileSourcePreview,
    karakeep::{ApiErrorKind, KarakeepApi},
    transfer::{
        FileDeliverySource, SharedSqliteLedger, SqliteDeliveryLedgerAdapter, TransferPreviewCounts,
        preview_delivery_counts,
    },
};

const MAX_DELIVERY_ID_LENGTH: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DeliveryId(String);

impl DeliveryId {
    pub fn new(value: impl Into<String>) -> Result<Self, DeliveryCoordinatorError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_DELIVERY_ID_LENGTH
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(DeliveryCoordinatorError::for_code(
                DeliveryCoordinatorErrorCode::InvalidDeliveryId,
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryCoordinatorErrorCode {
    AlreadyActive,
    NoActiveDelivery,
    DeliveryIdMismatch,
    InvalidDeliveryId,
    InvalidConfiguration,
    StateUnavailable,
    LedgerUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryCoordinatorError {
    pub code: DeliveryCoordinatorErrorCode,
    pub message: &'static str,
}

impl DeliveryCoordinatorError {
    fn for_code(code: DeliveryCoordinatorErrorCode) -> Self {
        let message = match code {
            DeliveryCoordinatorErrorCode::AlreadyActive => {
                "Another delivery operation is already active."
            }
            DeliveryCoordinatorErrorCode::NoActiveDelivery => {
                "There is no active delivery operation."
            }
            DeliveryCoordinatorErrorCode::DeliveryIdMismatch => {
                "The requested delivery operation is unavailable."
            }
            DeliveryCoordinatorErrorCode::InvalidDeliveryId => {
                "The delivery operation identifier is invalid."
            }
            DeliveryCoordinatorErrorCode::InvalidConfiguration => {
                "The delivery configuration is invalid."
            }
            DeliveryCoordinatorErrorCode::StateUnavailable => {
                "The delivery operation state is unavailable."
            }
            DeliveryCoordinatorErrorCode::LedgerUnavailable => {
                "The local delivery ledger is unavailable."
            }
        };
        Self { code, message }
    }
}

impl fmt::Display for DeliveryCoordinatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for DeliveryCoordinatorError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryProgressSummary {
    pub completed: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryResult {
    pub delivered: usize,
    pub created: usize,
    pub existing: usize,
    pub retried: usize,
    pub failed: usize,
    pub cancelled: usize,
}

impl From<&DeliveryTotals> for DeliveryResult {
    fn from(totals: &DeliveryTotals) -> Self {
        Self {
            delivered: totals.delivered,
            created: totals.created,
            existing: totals.existing,
            retried: totals.retried,
            failed: totals.failed,
            cancelled: totals.cancelled,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryFailureCode {
    DestinationAuthentication,
    DestinationCompatibility,
    DeliveryFailed,
    Network,
    Unexpected,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryProgressEvent {
    #[serde(rename = "type")]
    event_type: &'static str,
    pub delivery_id: DeliveryId,
    pub progress: DeliveryProgressSummary,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DeliveryTerminalEvent {
    Completed {
        #[serde(rename = "deliveryId")]
        delivery_id: DeliveryId,
        result: DeliveryResult,
    },
    Cancelled {
        #[serde(rename = "deliveryId")]
        delivery_id: DeliveryId,
        result: DeliveryResult,
    },
    Failed {
        #[serde(rename = "deliveryId")]
        delivery_id: DeliveryId,
        code: DeliveryFailureCode,
        result: DeliveryResult,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum DeliveryEvent {
    Progress(DeliveryProgressEvent),
    Terminal(DeliveryTerminalEvent),
}

pub trait DeliveryEventSink: Send + Sync {
    fn publish(&self, event: DeliveryEvent);
}

pub struct DeliveryCoordinator {
    ledger: SharedSqliteLedger,
    config: DeliveryConfig,
    state: Arc<Mutex<DeliveryState>>,
}

impl DeliveryCoordinator {
    pub fn new(ledger: SharedSqliteLedger) -> Self {
        Self {
            ledger,
            config: DeliveryConfig::default(),
            state: Arc::new(Mutex::new(DeliveryState::default())),
        }
    }

    pub fn with_config(
        ledger: SharedSqliteLedger,
        config: DeliveryConfig,
    ) -> Result<Self, DeliveryCoordinatorError> {
        validate_config(&config)?;
        Ok(Self {
            ledger,
            config,
            state: Arc::new(Mutex::new(DeliveryState::default())),
        })
    }

    pub fn preview(
        &self,
        preview: &FileSourcePreview,
        destination: &DestinationIdentity,
        limit: Option<usize>,
    ) -> Result<TransferPreviewCounts, DeliveryCoordinatorError> {
        preview_delivery_counts(preview, &self.ledger, destination, limit).map_err(|_| {
            DeliveryCoordinatorError::for_code(DeliveryCoordinatorErrorCode::LedgerUnavailable)
        })
    }

    /// Runs one delivery on the calling thread.
    ///
    /// A caller can safely invoke this again with the same preview and
    /// destination after any terminal event. The destination-scoped ledger
    /// skips completed records and resumes pending records.
    pub fn run(
        &self,
        api: Arc<dyn KarakeepApi>,
        delivery_id: DeliveryId,
        preview: FileSourcePreview,
        destination: DestinationIdentity,
        events: Arc<dyn DeliveryEventSink>,
    ) -> Result<DeliveryTerminalEvent, DeliveryCoordinatorError> {
        Ok(self
            .prepare_run(
                api,
                delivery_id,
                preview,
                destination,
                events,
                self.config.clone(),
            )?
            .execute())
    }

    /// Reserves the active delivery slot before returning a runnable operation.
    ///
    /// This lets an asynchronous host acknowledge the start only after
    /// cancellation is available, then move the returned run onto its blocking
    /// worker without a start/cancel race.
    pub fn prepare_run(
        &self,
        api: Arc<dyn KarakeepApi>,
        delivery_id: DeliveryId,
        preview: FileSourcePreview,
        destination: DestinationIdentity,
        events: Arc<dyn DeliveryEventSink>,
        config: DeliveryConfig,
    ) -> Result<DeliveryRun, DeliveryCoordinatorError> {
        self.prepare(
            api,
            delivery_id,
            DeliveryBatch::Reviewed(preview),
            destination,
            events,
            config,
        )
    }

    /// Reuses the reviewed mapping for unfinished records from the last delivery.
    pub fn prepare_retry(
        &self,
        api: Arc<dyn KarakeepApi>,
        delivery_id: DeliveryId,
        retry_of: &DeliveryId,
        destination: DestinationIdentity,
        events: Arc<dyn DeliveryEventSink>,
        config: DeliveryConfig,
    ) -> Result<DeliveryRun, DeliveryCoordinatorError> {
        self.prepare(
            api,
            delivery_id,
            DeliveryBatch::Retry(retry_of),
            destination,
            events,
            config,
        )
    }

    fn prepare(
        &self,
        api: Arc<dyn KarakeepApi>,
        delivery_id: DeliveryId,
        batch: DeliveryBatch<'_>,
        destination: DestinationIdentity,
        events: Arc<dyn DeliveryEventSink>,
        mut config: DeliveryConfig,
    ) -> Result<DeliveryRun, DeliveryCoordinatorError> {
        validate_config(&config)?;
        let mut state = self.state.lock().map_err(|_| {
            DeliveryCoordinatorError::for_code(DeliveryCoordinatorErrorCode::StateUnavailable)
        })?;
        if state.active.is_some() {
            return Err(DeliveryCoordinatorError::for_code(
                DeliveryCoordinatorErrorCode::AlreadyActive,
            ));
        }
        let preview = match batch {
            DeliveryBatch::Reviewed(preview) => {
                state.retry = None;
                preview
            }
            DeliveryBatch::Retry(retry_of) => {
                config.pending_limit = None;
                state
                    .retry
                    .take_if(|retry| {
                        &retry.delivery_id == retry_of && retry.destination == destination
                    })
                    .ok_or_else(|| {
                        DeliveryCoordinatorError::for_code(
                            DeliveryCoordinatorErrorCode::DeliveryIdMismatch,
                        )
                    })?
                    .preview
            }
        };
        let cancellation = CancellationToken::new();
        state.active = Some(ActiveDelivery {
            delivery_id: delivery_id.clone(),
            cancellation: cancellation.clone(),
        });
        Ok(DeliveryRun {
            api,
            ledger: Arc::clone(&self.ledger),
            config,
            delivery_id: delivery_id.clone(),
            preview,
            destination,
            events,
            cancellation,
            active: ActiveDeliveryGuard {
                delivery_id,
                state: Arc::clone(&self.state),
            },
        })
    }

    pub fn cancel(&self, delivery_id: &DeliveryId) -> Result<(), DeliveryCoordinatorError> {
        let cancellation = {
            let state = self.state.lock().map_err(|_| {
                DeliveryCoordinatorError::for_code(DeliveryCoordinatorErrorCode::StateUnavailable)
            })?;
            let Some(active) = state.active.as_ref() else {
                return Err(DeliveryCoordinatorError::for_code(
                    DeliveryCoordinatorErrorCode::NoActiveDelivery,
                ));
            };
            if &active.delivery_id != delivery_id {
                return Err(DeliveryCoordinatorError::for_code(
                    DeliveryCoordinatorErrorCode::DeliveryIdMismatch,
                ));
            }
            active.cancellation.clone()
        };
        cancellation.cancel();
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.state
            .lock()
            .map_or(true, |state| state.active.is_some())
    }
}

#[must_use = "execute the prepared delivery run or drop it to release the active slot"]
pub struct DeliveryRun {
    api: Arc<dyn KarakeepApi>,
    ledger: SharedSqliteLedger,
    config: DeliveryConfig,
    delivery_id: DeliveryId,
    preview: FileSourcePreview,
    destination: DestinationIdentity,
    events: Arc<dyn DeliveryEventSink>,
    cancellation: CancellationToken,
    active: ActiveDeliveryGuard,
}

impl DeliveryRun {
    pub fn execute(mut self) -> DeliveryTerminalEvent {
        let adapter = match SqliteDeliveryLedgerAdapter::start(
            Arc::clone(&self.ledger),
            self.destination.clone(),
            self.preview.format,
        ) {
            Ok(adapter) => Arc::new(adapter),
            Err(_) => {
                return publish_terminal(
                    self.events.as_ref(),
                    DeliveryTerminalEvent::Failed {
                        delivery_id: self.delivery_id.clone(),
                        code: DeliveryFailureCode::DeliveryFailed,
                        result: DeliveryResult::default(),
                    },
                );
            }
        };
        let destination_id = adapter.destination_id();
        let engine_ledger: Arc<dyn delivery::DeliveryLedger> = adapter.clone();
        let engine = match delivery::DeliveryEngine::new(
            Arc::clone(&self.api),
            engine_ledger,
            self.config.clone(),
        ) {
            Ok(engine) => engine,
            Err(_) => {
                let _ = adapter.finish_run(RunStatus::Interrupted);
                return publish_terminal(
                    self.events.as_ref(),
                    DeliveryTerminalEvent::Failed {
                        delivery_id: self.delivery_id.clone(),
                        code: DeliveryFailureCode::Unexpected,
                        result: DeliveryResult::default(),
                    },
                );
            }
        };
        let source = FileDeliverySource::from_preview(&self.preview);
        let progress = CoordinatorProgressSink {
            delivery_id: self.delivery_id.clone(),
            events: Arc::clone(&self.events),
        };

        let report = match engine.run(&source, &destination_id, &self.cancellation, &progress) {
            Ok(report) => report,
            Err(error) => {
                let _ = adapter.finish_run(RunStatus::Interrupted);
                return publish_terminal(
                    self.events.as_ref(),
                    DeliveryTerminalEvent::Failed {
                        delivery_id: self.delivery_id.clone(),
                        code: failure_code(error),
                        result: DeliveryResult::default(),
                    },
                );
            }
        };
        if report.totals.pending > 0 {
            let retry_ids: HashSet<_> = report
                .records
                .iter()
                .filter(|record| record.status != RecordStatus::Delivered)
                .map(|record| record.source_id.as_str())
                .collect();
            self.preview
                .bookmarks
                .retain(|bookmark| retry_ids.contains(bookmark.source_id.as_str()));
            if let Ok(mut state) = self.active.state.lock() {
                state.retry = Some(RetryBatch {
                    delivery_id: self.delivery_id.clone(),
                    destination: self.destination,
                    preview: self.preview,
                });
            }
        }
        let classified_failure = classified_failure_code(&report.records);
        let authentication_failed =
            classified_failure == Some(DeliveryFailureCode::DestinationAuthentication);
        let run_status = if report.totals.cancelled > 0 {
            RunStatus::Interrupted
        } else if report.totals.failed > 0 {
            RunStatus::PartiallyCompleted
        } else {
            RunStatus::Completed
        };
        let result = DeliveryResult::from(&report.totals);
        if adapter.finish_run(run_status).is_err() && !authentication_failed {
            return publish_terminal(
                self.events.as_ref(),
                DeliveryTerminalEvent::Failed {
                    delivery_id: self.delivery_id.clone(),
                    code: DeliveryFailureCode::DeliveryFailed,
                    result,
                },
            );
        }

        let terminal = if let Some(code) =
            classified_failure.filter(|_| authentication_failed || report.totals.cancelled == 0)
        {
            DeliveryTerminalEvent::Failed {
                delivery_id: self.delivery_id.clone(),
                code,
                result,
            }
        } else if report.totals.cancelled > 0 {
            DeliveryTerminalEvent::Cancelled {
                delivery_id: self.delivery_id.clone(),
                result,
            }
        } else {
            DeliveryTerminalEvent::Completed {
                delivery_id: self.delivery_id.clone(),
                result,
            }
        };
        publish_terminal(self.events.as_ref(), terminal)
    }
}

enum DeliveryBatch<'a> {
    Reviewed(FileSourcePreview),
    Retry(&'a DeliveryId),
}

#[derive(Default)]
struct DeliveryState {
    active: Option<ActiveDelivery>,
    retry: Option<RetryBatch>,
}

struct RetryBatch {
    delivery_id: DeliveryId,
    destination: DestinationIdentity,
    preview: FileSourcePreview,
}

struct ActiveDelivery {
    delivery_id: DeliveryId,
    cancellation: CancellationToken,
}

struct ActiveDeliveryGuard {
    delivery_id: DeliveryId,
    state: Arc<Mutex<DeliveryState>>,
}

impl Drop for ActiveDeliveryGuard {
    fn drop(&mut self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.delivery_id == self.delivery_id)
        {
            state.active = None;
        }
    }
}

struct CoordinatorProgressSink {
    delivery_id: DeliveryId,
    events: Arc<dyn DeliveryEventSink>,
}

impl ProgressSink for CoordinatorProgressSink {
    fn publish(&self, progress: DeliveryProgress) {
        self.events
            .publish(DeliveryEvent::Progress(DeliveryProgressEvent {
                event_type: "progress",
                delivery_id: self.delivery_id.clone(),
                progress: DeliveryProgressSummary {
                    completed: progress.processed,
                    total: progress
                        .totals
                        .total
                        .saturating_sub(progress.totals.skipped),
                },
            }));
    }
}

fn validate_config(config: &DeliveryConfig) -> Result<(), DeliveryCoordinatorError> {
    if config.max_concurrency == 0
        || !config.requests_per_second.is_finite()
        || config.requests_per_second <= 0.0
        || config.pending_limit == Some(0)
    {
        return Err(DeliveryCoordinatorError::for_code(
            DeliveryCoordinatorErrorCode::InvalidConfiguration,
        ));
    }
    Ok(())
}

fn publish_terminal(
    events: &dyn DeliveryEventSink,
    terminal: DeliveryTerminalEvent,
) -> DeliveryTerminalEvent {
    events.publish(DeliveryEvent::Terminal(terminal.clone()));
    terminal
}

fn failure_code(error: DeliveryRunError) -> DeliveryFailureCode {
    match error {
        DeliveryRunError::Source(_) => DeliveryFailureCode::Unexpected,
        DeliveryRunError::Ledger(_) => DeliveryFailureCode::DeliveryFailed,
    }
}

fn classified_failure_code(records: &[delivery::RecordResult]) -> Option<DeliveryFailureCode> {
    let mut compatibility = false;
    let mut network = false;
    for kind in records
        .iter()
        .filter_map(|record| record.failure_kind.as_ref())
    {
        match kind {
            ApiErrorKind::Authentication => {
                return Some(DeliveryFailureCode::DestinationAuthentication);
            }
            ApiErrorKind::Compatibility => compatibility = true,
            ApiErrorKind::RateLimited { .. }
            | ApiErrorKind::Server
            | ApiErrorKind::Network
            | ApiErrorKind::Timeout => network = true,
            ApiErrorKind::Permanent => {}
        }
    }
    if compatibility {
        Some(DeliveryFailureCode::DestinationCompatibility)
    } else if network {
        Some(DeliveryFailureCode::Network)
    } else {
        None
    }
}
