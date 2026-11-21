use std::path::PathBuf;

use karakeep_transfer_lib::{
    diagnostics::{ComponentStatus, DiagnosticsInput, StorageSummary, build_explicit_export},
    diagnostics_save::{DiagnosticsSaveDialog, DiagnosticsSaveError, save_diagnostics_export},
    redaction::SecretRedactor,
    versions::ComponentVersions,
};
use tempfile::tempdir;

const KARAKEEP_KEY_CANARY: &str = "ak2_SAVE_DIALOG_KEY_MUST_NOT_ESCAPE";
const X_SESSION_CANARY: &str = "x_session_SAVE_DIALOG_MUST_NOT_ESCAPE";

struct FixedDialog(Option<PathBuf>);

impl DiagnosticsSaveDialog for FixedDialog {
    fn choose_save_path(&self) -> Result<Option<PathBuf>, DiagnosticsSaveError> {
        Ok(self.0.clone())
    }
}

fn redacted_export() -> karakeep_transfer_lib::diagnostics::DiagnosticsExport {
    build_explicit_export(
        &DiagnosticsInput {
            source: ComponentStatus::Ready,
            destination: ComponentStatus::Ready,
            storage: StorageSummary {
                data_directory: format!(
                    "/private/{X_SESSION_CANARY}/karakeep-transfer/{KARAKEEP_KEY_CANARY}"
                ),
                snapshot_bytes: 10,
                ledger_bytes: 20,
            },
            last_failure: None,
        },
        ComponentVersions::new("0.1.0", "1.3.22", "22.20.0", "1"),
        &SecretRedactor::new([KARAKEEP_KEY_CANARY, X_SESSION_CANARY]),
    )
}

#[test]
fn selected_native_path_receives_only_the_redacted_diagnostics_payload() {
    let directory = tempdir().expect("temporary diagnostics directory");
    let destination = directory.path().join("diagnostics.json");

    let saved =
        save_diagnostics_export(&FixedDialog(Some(destination.clone())), &redacted_export())
            .expect("diagnostics save succeeds");
    let contents = std::fs::read_to_string(destination).expect("saved diagnostics");

    assert_eq!(
        (
            saved,
            contents.contains(KARAKEEP_KEY_CANARY),
            contents.contains(X_SESSION_CANARY),
            serde_json::from_str::<serde_json::Value>(&contents)
                .expect("saved diagnostics are JSON")["generatedByUserAction"]
                .as_bool(),
        ),
        (true, false, false, Some(true))
    );
}

#[test]
fn cancelled_native_dialog_returns_false_without_writing() {
    assert!(
        !save_diagnostics_export(&FixedDialog(None), &redacted_export())
            .expect("dialog cancellation succeeds")
    );
}
