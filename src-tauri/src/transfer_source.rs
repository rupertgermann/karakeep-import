use std::{collections::HashSet, error::Error, fmt, fs, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    fieldtheory::FieldTheoryState,
    file_source::{FileSourceFormat, FileSourcePreview, preview_file},
};

/// Identifies the source that must be revalidated immediately before preview
/// or delivery.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransferSourceRequest {
    X,
    File {
        path: PathBuf,
        format: FileSourceFormat,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferSourceErrorCode {
    XSourceUnavailable,
    FileUnreadable,
    InvalidFileSource,
}

/// A fixed, redacted error suitable for a desktop-command boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSourceError {
    code: TransferSourceErrorCode,
    message: &'static str,
}

impl TransferSourceError {
    pub fn code(&self) -> TransferSourceErrorCode {
        self.code
    }

    fn x_source_unavailable() -> Self {
        Self {
            code: TransferSourceErrorCode::XSourceUnavailable,
            message: "The active X Source is unavailable.",
        }
    }

    fn file_unreadable() -> Self {
        Self {
            code: TransferSourceErrorCode::FileUnreadable,
            message: "The selected file could not be read.",
        }
    }

    fn invalid_file_source() -> Self {
        Self {
            code: TransferSourceErrorCode::InvalidFileSource,
            message: "The selected file is not a valid supported File Source.",
        }
    }
}

impl fmt::Display for TransferSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for TransferSourceError {}

/// Resolves a source from its authoritative location. File Sources are read in
/// place and X snapshots remain behind `FieldTheoryState`.
pub fn resolve_transfer_source(
    request: &TransferSourceRequest,
    field_theory: &FieldTheoryState,
) -> Result<FileSourcePreview, TransferSourceError> {
    match request {
        TransferSourceRequest::X => field_theory
            .snapshot_delivery_source()
            .map_err(|_| TransferSourceError::x_source_unavailable()),
        TransferSourceRequest::File { path, format } => {
            let file = fs::File::open(path).map_err(|_| TransferSourceError::file_unreadable())?;
            let metadata = file
                .metadata()
                .map_err(|_| TransferSourceError::file_unreadable())?;
            if !metadata.file_type().is_file() {
                return Err(TransferSourceError::file_unreadable());
            }
            drop(file);

            preview_file(path, *format).map_err(|_| TransferSourceError::invalid_file_source())
        }
    }
}

/// Returns the folders shown in a transfer preview, preserving their first
/// spelling and appearance order while removing case-insensitive duplicates.
pub fn deduplicated_preview_folders(preview: &FileSourcePreview) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut folders = Vec::new();
    for folder in preview
        .bookmarks
        .iter()
        .flat_map(|bookmark| &bookmark.folders)
    {
        if seen.insert(folder.to_lowercase()) {
            folders.push(folder.clone());
        }
    }
    folders
}
