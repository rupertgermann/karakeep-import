use std::{
    error::Error,
    fmt, fs,
    path::{Path, PathBuf},
};

use rusqlite::{
    Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior, params,
};

use crate::domain::{
    BookmarkKey, DeliveryAttempt, DeliveryOutcome, DestinationIdentity, RunStatus, TimestampMillis,
};

const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_delivery_ledger.sql")];

#[derive(Debug)]
pub enum LedgerError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    RunNotFound,
    RunClosed,
    InvalidFinishedStatus,
    InvalidKarakeepBookmarkId,
    AlreadyDelivered,
    InvalidStoredValue(&'static str),
    UnsupportedSchema(i64),
}

impl fmt::Display for LedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(_) => formatter.write_str("delivery ledger file operation failed"),
            Self::Sqlite(_) => formatter.write_str("delivery ledger database operation failed"),
            Self::RunNotFound => formatter.write_str("transfer run was not found"),
            Self::RunClosed => formatter.write_str("transfer run is already closed"),
            Self::InvalidFinishedStatus => {
                formatter.write_str("a finished transfer run cannot remain running")
            }
            Self::InvalidKarakeepBookmarkId => {
                formatter.write_str("Karakeep bookmark identifier must not be empty")
            }
            Self::AlreadyDelivered => {
                formatter.write_str("bookmark is already delivered to this destination")
            }
            Self::InvalidStoredValue(field) => {
                write!(formatter, "delivery ledger contains an invalid {field}")
            }
            Self::UnsupportedSchema(version) => {
                write!(
                    formatter,
                    "delivery ledger schema version {version} is newer than this app"
                )
            }
        }
    }
}

impl Error for LedgerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for LedgerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for LedgerError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransferRunId(i64);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryRecord {
    pub source: String,
    pub source_bookmark_id: String,
    pub karakeep_bookmark_id: String,
    pub outcome: DeliveryOutcome,
    pub delivered_at: TimestampMillis,
    pub transfer_run_id: TransferRunId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferRunSummary {
    pub id: TransferRunId,
    pub status: RunStatus,
    pub started_at: TimestampMillis,
    pub finished_at: Option<TimestampMillis>,
    pub created: u64,
    pub existing: u64,
    pub failed: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DestinationHistory {
    pub destination: DestinationIdentity,
    pub delivered_total: u64,
    pub runs: Vec<TransferRunSummary>,
}

pub struct DeliveryLedger {
    connection: Connection,
    path: Option<PathBuf>,
}

impl DeliveryLedger {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, LedgerError> {
        let path = path.as_ref();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        Self::initialize(connection, Some(path.to_owned()))
    }

    pub fn open_in_memory() -> Result<Self, LedgerError> {
        Self::initialize(Connection::open_in_memory()?, None)
    }

    fn initialize(mut connection: Connection, path: Option<PathBuf>) -> Result<Self, LedgerError> {
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        migrate(&mut connection)?;
        Ok(Self { connection, path })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> Result<i64, LedgerError> {
        Ok(self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn start_run(
        &mut self,
        destination: &DestinationIdentity,
        started_at: TimestampMillis,
    ) -> Result<TransferRunId, LedgerError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let destination_id = ensure_destination(&transaction, destination, started_at)?;
        transaction.execute(
            "INSERT INTO transfer_runs (destination_id, status, started_at)
             VALUES (?1, 'running', ?2)",
            params![destination_id, started_at.0],
        )?;
        let run = TransferRunId(transaction.last_insert_rowid());
        transaction.commit()?;
        Ok(run)
    }

    pub fn record_attempt(
        &mut self,
        run: TransferRunId,
        bookmark: &BookmarkKey,
        attempt: DeliveryAttempt,
        attempted_at: TimestampMillis,
    ) -> Result<(), LedgerError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (destination_id, status) = run_scope(&transaction, run)?;
        if status != RunStatus::Running {
            return Err(LedgerError::RunClosed);
        }

        match attempt {
            DeliveryAttempt::Failed { stage, code } => {
                transaction.execute(
                    "INSERT INTO delivery_attempts (
                        transfer_run_id, source, source_bookmark_id, outcome,
                        failure_stage, failure_code, attempted_at
                     ) VALUES (?1, ?2, ?3, 'failed', ?4, ?5, ?6)",
                    params![
                        run.0,
                        bookmark.source(),
                        bookmark.identifier(),
                        stage.as_str(),
                        code.as_str(),
                        attempted_at.0
                    ],
                )?;
            }
            DeliveryAttempt::Delivered {
                karakeep_bookmark_id,
                outcome,
            } => {
                let karakeep_bookmark_id = karakeep_bookmark_id.trim();
                if karakeep_bookmark_id.is_empty() {
                    return Err(LedgerError::InvalidKarakeepBookmarkId);
                }
                transaction.execute(
                    "INSERT INTO delivery_attempts (
                        transfer_run_id, source, source_bookmark_id, outcome,
                        karakeep_bookmark_id, attempted_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        run.0,
                        bookmark.source(),
                        bookmark.identifier(),
                        outcome.as_str(),
                        karakeep_bookmark_id,
                        attempted_at.0
                    ],
                )?;
                if let Err(error) = transaction.execute(
                    "INSERT INTO delivered_bookmarks (
                        destination_id, source, source_bookmark_id,
                        karakeep_bookmark_id, outcome, transfer_run_id, delivered_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        destination_id,
                        bookmark.source(),
                        bookmark.identifier(),
                        karakeep_bookmark_id,
                        outcome.as_str(),
                        run.0,
                        attempted_at.0
                    ],
                ) {
                    if is_constraint_violation(&error) {
                        return Err(LedgerError::AlreadyDelivered);
                    }
                    return Err(error.into());
                }
            }
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn finish_run(
        &mut self,
        run: TransferRunId,
        status: RunStatus,
        finished_at: TimestampMillis,
    ) -> Result<(), LedgerError> {
        if status == RunStatus::Running {
            return Err(LedgerError::InvalidFinishedStatus);
        }
        let changed = self.connection.execute(
            "UPDATE transfer_runs
             SET status = ?1, finished_at = ?2
             WHERE id = ?3 AND status = 'running'",
            params![status.as_str(), finished_at.0, run.0],
        )?;
        if changed == 1 {
            return Ok(());
        }
        let exists = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM transfer_runs WHERE id = ?1)",
            [run.0],
            |row| row.get::<_, bool>(0),
        )?;
        if exists {
            Err(LedgerError::RunClosed)
        } else {
            Err(LedgerError::RunNotFound)
        }
    }

    pub fn delivery_for(
        &self,
        destination: &DestinationIdentity,
        bookmark: &BookmarkKey,
    ) -> Result<Option<DeliveryRecord>, LedgerError> {
        let Some(destination_id) = find_destination(&self.connection, destination)? else {
            return Ok(None);
        };
        self.connection
            .query_row(
                "SELECT source, source_bookmark_id, karakeep_bookmark_id,
                        outcome, delivered_at, transfer_run_id
                 FROM delivered_bookmarks
                 WHERE destination_id = ?1 AND source = ?2 AND source_bookmark_id = ?3",
                params![destination_id, bookmark.source(), bookmark.identifier()],
                |row| {
                    let outcome: String = row.get(3)?;
                    let outcome = DeliveryOutcome::from_str(&outcome).ok_or_else(|| {
                        rusqlite::Error::InvalidColumnType(
                            3,
                            "outcome".to_owned(),
                            rusqlite::types::Type::Text,
                        )
                    })?;
                    Ok(DeliveryRecord {
                        source: row.get(0)?,
                        source_bookmark_id: row.get(1)?,
                        karakeep_bookmark_id: row.get(2)?,
                        outcome,
                        delivered_at: TimestampMillis(row.get(4)?),
                        transfer_run_id: TransferRunId(row.get(5)?),
                    })
                },
            )
            .optional()
            .map_err(LedgerError::from)
    }

    pub fn retry_count(
        &self,
        destination: &DestinationIdentity,
        bookmark: &BookmarkKey,
    ) -> Result<u64, LedgerError> {
        let Some(destination_id) = find_destination(&self.connection, destination)? else {
            return Ok(0);
        };
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(*)
             FROM delivery_attempts AS attempt
             JOIN transfer_runs AS run ON run.id = attempt.transfer_run_id
             WHERE run.destination_id = ?1
               AND attempt.source = ?2
               AND attempt.source_bookmark_id = ?3
               AND attempt.outcome = 'failed'",
            params![destination_id, bookmark.source(), bookmark.identifier()],
            |row| row.get(0),
        )?;
        u64::try_from(count).map_err(|_| LedgerError::InvalidStoredValue("retry count"))
    }

    pub fn history(
        &self,
        destination: &DestinationIdentity,
    ) -> Result<DestinationHistory, LedgerError> {
        let Some(destination_id) = find_destination(&self.connection, destination)? else {
            return Ok(DestinationHistory {
                destination: destination.clone(),
                delivered_total: 0,
                runs: Vec::new(),
            });
        };
        let delivered_total: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM delivered_bookmarks WHERE destination_id = ?1",
            [destination_id],
            |row| row.get(0),
        )?;
        let mut statement = self.connection.prepare(
            "SELECT run.id, run.status, run.started_at, run.finished_at,
                    COALESCE(SUM(CASE WHEN attempt.outcome = 'created' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN attempt.outcome = 'existing' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN attempt.outcome = 'failed' THEN 1 ELSE 0 END), 0)
             FROM transfer_runs AS run
             LEFT JOIN delivery_attempts AS attempt ON attempt.transfer_run_id = run.id
             WHERE run.destination_id = ?1
             GROUP BY run.id
             ORDER BY run.id",
        )?;
        let rows = statement.query_map([destination_id], |row| {
            let status: String = row.get(1)?;
            let status = RunStatus::from_str(&status).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(
                    1,
                    "status".to_owned(),
                    rusqlite::types::Type::Text,
                )
            })?;
            Ok((
                row.get::<_, i64>(0)?,
                status,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        let mut runs = Vec::new();
        for row in rows {
            let (id, status, started_at, finished_at, created, existing, failed) = row?;
            runs.push(TransferRunSummary {
                id: TransferRunId(id),
                status,
                started_at: TimestampMillis(started_at),
                finished_at: finished_at.map(TimestampMillis),
                created: checked_count(created, "created count")?,
                existing: checked_count(existing, "existing count")?,
                failed: checked_count(failed, "failed count")?,
            });
        }
        Ok(DestinationHistory {
            destination: destination.clone(),
            delivered_total: checked_count(delivered_total, "delivered count")?,
            runs,
        })
    }
}

fn migrate(connection: &mut Connection) -> Result<(), LedgerError> {
    let current: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let latest = i64::try_from(MIGRATIONS.len())
        .map_err(|_| LedgerError::InvalidStoredValue("migration count"))?;
    if current > latest {
        return Err(LedgerError::UnsupportedSchema(current));
    }
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = i64::try_from(index + 1)
            .map_err(|_| LedgerError::InvalidStoredValue("migration version"))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(migration)?;
        transaction.pragma_update(None, "user_version", version)?;
        transaction.commit()?;
    }
    Ok(())
}

fn ensure_destination(
    transaction: &Transaction<'_>,
    destination: &DestinationIdentity,
    created_at: TimestampMillis,
) -> Result<i64, LedgerError> {
    transaction.execute(
        "INSERT INTO destinations (normalized_server, authenticated_user, created_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(normalized_server, authenticated_user) DO NOTHING",
        params![
            destination.normalized_server(),
            destination.authenticated_user(),
            created_at.0
        ],
    )?;
    find_destination(transaction, destination)?
        .ok_or(LedgerError::InvalidStoredValue("destination identifier"))
}

fn find_destination(
    connection: &Connection,
    destination: &DestinationIdentity,
) -> Result<Option<i64>, LedgerError> {
    Ok(connection
        .query_row(
            "SELECT id
             FROM destinations
             WHERE normalized_server = ?1 AND authenticated_user = ?2",
            params![
                destination.normalized_server(),
                destination.authenticated_user()
            ],
            |row| row.get(0),
        )
        .optional()?)
}

fn run_scope(
    transaction: &Transaction<'_>,
    run: TransferRunId,
) -> Result<(i64, RunStatus), LedgerError> {
    transaction
        .query_row(
            "SELECT destination_id, status FROM transfer_runs WHERE id = ?1",
            [run.0],
            |row| {
                let status: String = row.get(1)?;
                let status = RunStatus::from_str(&status).ok_or_else(|| {
                    rusqlite::Error::InvalidColumnType(
                        1,
                        "status".to_owned(),
                        rusqlite::types::Type::Text,
                    )
                })?;
                Ok((row.get(0)?, status))
            },
        )
        .optional()?
        .ok_or(LedgerError::RunNotFound)
}

fn is_constraint_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(sqlite_error, _)
            if sqlite_error.code == ErrorCode::ConstraintViolation
    )
}

fn checked_count(value: i64, field: &'static str) -> Result<u64, LedgerError> {
    u64::try_from(value).map_err(|_| LedgerError::InvalidStoredValue(field))
}
