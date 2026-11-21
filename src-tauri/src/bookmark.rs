use serde::{Deserialize, Serialize};

/// A validated, read-only bookmark ready to display in a Transfer Preview.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkPreview {
    pub source_id: String,
    pub url: String,
    pub title: String,
    pub note: String,
    pub created_at: Option<String>,
    pub tags: Vec<String>,
    pub folders: Vec<String>,
}
