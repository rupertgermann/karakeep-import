use std::{error::Error, fmt, time::Duration};

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDraft {
    pub url: String,
    pub title: Option<String>,
    pub note: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KarakeepBookmark {
    pub id: String,
    pub human_tags: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BookmarkOrigin {
    Created,
    Existing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsuredBookmark {
    pub bookmark: KarakeepBookmark,
    pub origin: BookmarkOrigin,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApiErrorKind {
    Authentication,
    Compatibility,
    RateLimited { retry_after: Option<Duration> },
    Server,
    Network,
    Timeout,
    Permanent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
    pub kind: ApiErrorKind,
    /// A user-safe message with credentials and session values already redacted.
    pub message: String,
}

impl ApiError {
    pub fn new(kind: ApiErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(
            self.kind,
            ApiErrorKind::RateLimited { .. }
                | ApiErrorKind::Server
                | ApiErrorKind::Network
                | ApiErrorKind::Timeout
        )
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ApiError {}

pub trait RequestCancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;
}

/// External Karakeep HTTP boundary.
///
/// `ensure_bookmark` must return an existing URL match without replacing any
/// user-owned destination fields. Implementations must also apply request
/// timeouts and stop active I/O when `cancellation` becomes true.
pub trait KarakeepApi: Send + Sync {
    fn ensure_bookmark(
        &self,
        draft: &BookmarkDraft,
        cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError>;

    fn attach_tags(
        &self,
        bookmark_id: &str,
        tags: &[String],
        cancellation: &dyn RequestCancellation,
    ) -> Result<(), ApiError>;
}
