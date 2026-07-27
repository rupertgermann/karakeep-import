use std::{
    error::Error,
    fmt, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::{
    delivery::{DeliveryConfig, RetryPolicy},
    transfer_options::SourceDefaultTags,
};

/// Advanced delivery tuning. The behavior already exists; only the values are
/// configurable. Defaults reproduce the shipped behavior, including the 20
/// second request timeout that the app has always used.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeliveryTuning {
    pub workers: usize,
    pub requests_per_second: f64,
    pub timeout_seconds: u64,
    pub max_retries: usize,
}

impl Default for DeliveryTuning {
    fn default() -> Self {
        Self {
            workers: 4,
            requests_per_second: 4.0,
            timeout_seconds: 20,
            max_retries: 5,
        }
    }
}

impl DeliveryTuning {
    fn validate(&self) -> Result<(), PreferencesError> {
        if self.workers == 0
            || !self.requests_per_second.is_finite()
            || self.requests_per_second <= 0.0
            || self.timeout_seconds == 0
        {
            return Err(PreferencesError::OutOfRange);
        }
        Ok(())
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_seconds)
    }

    pub fn delivery_config(&self) -> DeliveryConfig {
        DeliveryConfig {
            max_concurrency: self.workers,
            requests_per_second: self.requests_per_second,
            retry: RetryPolicy {
                max_retries: self.max_retries,
                ..RetryPolicy::default()
            },
            pending_limit: None,
        }
    }
}

/// The preferences a person sets once, as opposed to the per-run choices made
/// on the Transfer Review screen.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferPreferences {
    /// No source marker tag is attached until a person selects one.
    pub default_tags: SourceDefaultTags,
    pub delivery_tuning: DeliveryTuning,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreferencesError {
    OutOfRange,
    Storage,
}

impl PreferencesError {
    pub fn message(self) -> &'static str {
        match self {
            Self::OutOfRange => {
                "Worker count, requests per second, and timeout must be greater than zero."
            }
            Self::Storage => "Settings could not be saved.",
        }
    }
}

impl fmt::Display for PreferencesError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl Error for PreferencesError {}

/// Stores preferences as ordinary app data next to the delivery ledger.
///
/// A run reads the preferences once when it starts, so a change never affects
/// a run already in progress.
pub struct PreferencesStore {
    path: PathBuf,
    cached: Mutex<Option<TransferPreferences>>,
}

impl PreferencesStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cached: Mutex::new(None),
        }
    }

    pub fn load(&self) -> Result<TransferPreferences, PreferencesError> {
        if let Ok(cached) = self.cached.lock()
            && let Some(preferences) = *cached
        {
            return Ok(preferences);
        }
        let preferences = self.read()?;
        if let Ok(mut cached) = self.cached.lock() {
            *cached = Some(preferences);
        }
        Ok(preferences)
    }

    pub fn save(
        &self,
        preferences: TransferPreferences,
    ) -> Result<TransferPreferences, PreferencesError> {
        preferences.delivery_tuning.validate()?;
        let contents =
            serde_json::to_vec_pretty(&preferences).map_err(|_| PreferencesError::Storage)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| PreferencesError::Storage)?;
        }
        fs::write(&self.path, contents).map_err(|_| PreferencesError::Storage)?;
        if let Ok(mut cached) = self.cached.lock() {
            *cached = Some(preferences);
        }
        Ok(preferences)
    }

    fn read(&self) -> Result<TransferPreferences, PreferencesError> {
        match fs::read_to_string(&self.path) {
            Ok(contents) => serde_json::from_str(&contents).map_err(|_| PreferencesError::Storage),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(TransferPreferences::default()),
            Err(_) => Err(PreferencesError::Storage),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
