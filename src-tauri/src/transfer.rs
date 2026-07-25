use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{
    delivery::{
        self, DeliverySource, LedgerError as ContractLedgerError, LedgerStatus, PendingDelivery,
        SourceError,
    },
    domain::{
        BookmarkKey, DeliveryAttempt, DeliveryOutcome, DeliveryStage, DestinationIdentity,
        FailureCode, RunStatus, TimestampMillis,
    },
    file_source::{FileSourcePreview, ResolvedFileSourceFormat},
    karakeep::{BookmarkDraft, BookmarkOrigin},
    ledger::{DeliveryLedger as SqliteLedger, TransferRunId},
};

pub(crate) const FIELD_THEORY_LEDGER_SOURCE: &str = "x";
const CHROME_LEDGER_SOURCE: &str = "chrome";

#[derive(Clone)]
pub struct FileDeliverySource {
    records: Vec<delivery::DeliveryRecord>,
}

impl FileDeliverySource {
    pub fn from_preview(preview: &FileSourcePreview) -> Self {
        let records = preview
            .bookmarks
            .iter()
            .map(|bookmark| delivery::DeliveryRecord {
                source_id: bookmark.source_id.clone(),
                bookmark: BookmarkDraft {
                    url: bookmark.url.clone(),
                    title: optional_text(&bookmark.title),
                    note: optional_text(&bookmark.note),
                    created_at: bookmark.created_at.clone(),
                },
                required_tags: bookmark.tags.clone(),
            })
            .collect();
        Self { records }
    }
}

impl DeliverySource for FileDeliverySource {
    fn records(&self) -> Result<Vec<delivery::DeliveryRecord>, SourceError> {
        Ok(self.records.clone())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreviewCounts {
    pub total: usize,
    pub pending: usize,
    pub previously_delivered: usize,
}

pub type SharedSqliteLedger = Arc<Mutex<SqliteLedger>>;

pub fn preview_delivery_counts(
    preview: &FileSourcePreview,
    ledger: &SharedSqliteLedger,
    destination: &DestinationIdentity,
) -> Result<TransferPreviewCounts, ContractLedgerError> {
    let ledger = lock_ledger(ledger)?;
    let source = ledger_source(preview.format);
    let mut previously_delivered = 0;
    for bookmark in &preview.bookmarks {
        let key = bookmark_key(source, &bookmark.source_id)?;
        if ledger
            .delivery_for(destination, &key)
            .map_err(sqlite_error)?
            .is_some()
        {
            previously_delivered += 1;
        }
    }
    Ok(TransferPreviewCounts {
        total: preview.bookmarks.len(),
        pending: preview.bookmarks.len() - previously_delivered,
        previously_delivered,
    })
}

pub struct SqliteDeliveryLedgerAdapter {
    ledger: SharedSqliteLedger,
    destination: DestinationIdentity,
    destination_id: delivery::DestinationId,
    run: TransferRunId,
    ledger_source: &'static str,
}

impl SqliteDeliveryLedgerAdapter {
    pub fn start(
        ledger: SharedSqliteLedger,
        destination: DestinationIdentity,
        format: ResolvedFileSourceFormat,
    ) -> Result<Self, ContractLedgerError> {
        let run = lock_ledger(&ledger)?
            .start_run(&destination, current_timestamp()?)
            .map_err(sqlite_error)?;
        Ok(Self {
            ledger,
            destination_id: destination_id_for(&destination),
            destination,
            run,
            ledger_source: ledger_source(format),
        })
    }

    pub fn destination_id(&self) -> delivery::DestinationId {
        self.destination_id.clone()
    }

    pub fn finish_run(&self, status: RunStatus) -> Result<(), ContractLedgerError> {
        lock_ledger(&self.ledger)?
            .finish_run(self.run, status, current_timestamp()?)
            .map_err(sqlite_error)
    }

    fn require_destination(
        &self,
        destination: &delivery::DestinationId,
    ) -> Result<(), ContractLedgerError> {
        if destination == &self.destination_id {
            Ok(())
        } else {
            Err(ContractLedgerError(
                "destination does not match the active transfer run".into(),
            ))
        }
    }

    fn bookmark_key(&self, source_id: &str) -> Result<BookmarkKey, ContractLedgerError> {
        bookmark_key(self.ledger_source, source_id)
    }
}

impl delivery::DeliveryLedger for SqliteDeliveryLedgerAdapter {
    fn status(
        &self,
        destination: &delivery::DestinationId,
        source_id: &str,
    ) -> Result<LedgerStatus, ContractLedgerError> {
        self.require_destination(destination)?;
        let key = self.bookmark_key(source_id)?;
        let ledger = lock_ledger(&self.ledger)?;
        if ledger
            .delivery_for(&self.destination, &key)
            .map_err(sqlite_error)?
            .is_some()
        {
            return Ok(LedgerStatus::Delivered);
        }
        let attempts = ledger
            .retry_count(&self.destination, &key)
            .map_err(sqlite_error)?;
        Ok(LedgerStatus::Pending {
            attempts: usize::try_from(attempts)
                .map_err(|_| ContractLedgerError("retry count is too large".into()))?,
        })
    }

    fn record_pending(
        &self,
        destination: &delivery::DestinationId,
        pending: PendingDelivery,
    ) -> Result<(), ContractLedgerError> {
        self.require_destination(destination)?;
        let key = self.bookmark_key(&pending.source_id)?;
        let cancelled = pending.error.eq_ignore_ascii_case("cancelled");
        let stage = if cancelled {
            DeliveryStage::Cancelled
        } else if pending.bookmark_id.is_some() {
            DeliveryStage::AttachTags
        } else {
            DeliveryStage::CreateBookmark
        };
        let code = match stage {
            DeliveryStage::Cancelled => "CANCELLED",
            DeliveryStage::AttachTags => "TAG_DELIVERY_FAILED",
            DeliveryStage::CreateBookmark | DeliveryStage::Network => "BOOKMARK_DELIVERY_FAILED",
        };
        let code = FailureCode::new(code)
            .map_err(|_| ContractLedgerError("invalid redacted failure code".into()))?;
        lock_ledger(&self.ledger)?
            .record_attempt(
                self.run,
                &key,
                DeliveryAttempt::Failed { stage, code },
                current_timestamp()?,
            )
            .map_err(sqlite_error)
    }

    fn record_delivered(
        &self,
        destination: &delivery::DestinationId,
        source_id: &str,
        bookmark_id: &str,
        origin: BookmarkOrigin,
    ) -> Result<(), ContractLedgerError> {
        self.require_destination(destination)?;
        let key = self.bookmark_key(source_id)?;
        let outcome = match origin {
            BookmarkOrigin::Created => DeliveryOutcome::Created,
            BookmarkOrigin::Existing => DeliveryOutcome::Existing,
        };
        lock_ledger(&self.ledger)?
            .record_attempt(
                self.run,
                &key,
                DeliveryAttempt::Delivered {
                    karakeep_bookmark_id: bookmark_id.to_owned(),
                    outcome,
                },
                current_timestamp()?,
            )
            .map_err(sqlite_error)
    }
}

fn optional_text(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

fn ledger_source(format: ResolvedFileSourceFormat) -> &'static str {
    match format {
        ResolvedFileSourceFormat::FieldTheoryJsonl => FIELD_THEORY_LEDGER_SOURCE,
        ResolvedFileSourceFormat::ChromeNetscape => CHROME_LEDGER_SOURCE,
    }
}

fn destination_id_for(destination: &DestinationIdentity) -> delivery::DestinationId {
    let server = destination.normalized_server();
    delivery::DestinationId::new(format!(
        "{}:{server}{}",
        server.len(),
        destination.authenticated_user()
    ))
}

fn bookmark_key(source: &str, source_id: &str) -> Result<BookmarkKey, ContractLedgerError> {
    BookmarkKey::new(source, source_id)
        .map_err(|_| ContractLedgerError("source bookmark identifier is invalid".into()))
}

fn lock_ledger(
    ledger: &SharedSqliteLedger,
) -> Result<MutexGuard<'_, SqliteLedger>, ContractLedgerError> {
    ledger
        .lock()
        .map_err(|_| ContractLedgerError("delivery ledger lock is unavailable".into()))
}

fn sqlite_error(error: crate::ledger::LedgerError) -> ContractLedgerError {
    ContractLedgerError(error.to_string())
}

fn current_timestamp() -> Result<TimestampMillis, ContractLedgerError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ContractLedgerError("system clock is before the Unix epoch".into()))?
        .as_millis();
    let millis = i64::try_from(millis)
        .map_err(|_| ContractLedgerError("system clock value is too large".into()))?;
    Ok(TimestampMillis(millis))
}
