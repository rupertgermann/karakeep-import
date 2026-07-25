use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
};

use crate::private_data::{DeleteLocalTransferData, PrivateTransferData, ReplaceXSource};

const LEDGER_FILE: &str = "delivery-ledger.sqlite3";
const SNAPSHOT_FILE: &str = "field-theory/bookmarks.jsonl";
const ACQUISITION_STATE_DIRECTORY: &str = "field-theory/acquisition";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum ReplaceXSourceConfirmation {
    #[serde(rename = "replace-x-source")]
    Confirmed,
}

impl ReplaceXSourceConfirmation {
    pub fn capability(self) -> ReplaceXSource {
        ReplaceXSource::confirmed()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum DeleteLocalTransferDataConfirmation {
    #[serde(rename = "delete-local-transfer-data")]
    Confirmed,
}

impl DeleteLocalTransferDataConfirmation {
    pub fn capability(self) -> DeleteLocalTransferData {
        DeleteLocalTransferData::confirmed()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPrivateDataSummary {
    pub data_directory: String,
    pub ledger_bytes: u64,
    pub snapshot_bytes: u64,
    pub acquisition_state_bytes: u64,
    pub total_bytes: u64,
}

pub struct SettingsService {
    data_directory: PathBuf,
    private_data: PrivateTransferData,
}

impl SettingsService {
    pub fn from_app_data_dir(data_directory: impl Into<PathBuf>) -> Self {
        let data_directory = data_directory.into();
        Self::new(
            &data_directory,
            PrivateTransferData::new(
                data_directory.join(LEDGER_FILE),
                data_directory.join(SNAPSHOT_FILE),
                data_directory.join(ACQUISITION_STATE_DIRECTORY),
            ),
        )
    }

    pub fn new(data_directory: impl Into<PathBuf>, private_data: PrivateTransferData) -> Self {
        Self {
            data_directory: data_directory.into(),
            private_data,
        }
    }

    pub fn inspect_private_data(&self) -> io::Result<SettingsPrivateDataSummary> {
        let summary = self.private_data.inspect()?;
        Ok(SettingsPrivateDataSummary {
            data_directory: display_path(&self.data_directory),
            ledger_bytes: summary.ledger_bytes,
            snapshot_bytes: summary.snapshot_bytes,
            acquisition_state_bytes: summary.acquisition_state_bytes,
            total_bytes: summary.total_bytes,
        })
    }

    pub fn replace_x_source(&self, confirmation: ReplaceXSource) -> io::Result<()> {
        self.private_data.replace_x_source(confirmation)
    }

    pub fn delete_local_transfer_data(
        &self,
        confirmation: DeleteLocalTransferData,
    ) -> io::Result<()> {
        self.private_data.delete(confirmation)
    }
}

fn display_path(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::{DeleteLocalTransferDataConfirmation, ReplaceXSourceConfirmation};

    #[test]
    fn source_replacement_accepts_only_the_exact_confirmation_token() {
        let confirmation: ReplaceXSourceConfirmation = serde_json::from_str("\"replace-x-source\"")
            .expect("valid source replacement confirmation");

        assert_eq!(confirmation, ReplaceXSourceConfirmation::Confirmed);
    }

    #[test]
    fn source_replacement_rejects_an_unrecognized_confirmation_token() {
        let result = serde_json::from_str::<ReplaceXSourceConfirmation>("\"yes\"");

        assert!(result.is_err());
    }

    #[test]
    fn local_deletion_accepts_only_the_exact_confirmation_token() {
        let confirmation: DeleteLocalTransferDataConfirmation =
            serde_json::from_str("\"delete-local-transfer-data\"")
                .expect("valid local deletion confirmation");

        assert_eq!(confirmation, DeleteLocalTransferDataConfirmation::Confirmed);
    }

    #[test]
    fn local_deletion_rejects_an_unrecognized_confirmation_token() {
        let result = serde_json::from_str::<DeleteLocalTransferDataConfirmation>("\"true\"");

        assert!(result.is_err());
    }
}
