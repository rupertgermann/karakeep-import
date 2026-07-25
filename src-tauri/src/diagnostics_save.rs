use std::{fs, path::PathBuf};

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::diagnostics::DiagnosticsExport;

pub trait DiagnosticsSaveDialog {
    fn choose_save_path(&self) -> Result<Option<PathBuf>, DiagnosticsSaveError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticsSaveError {
    Dialog,
    Serialize,
    Write,
}

impl DiagnosticsSaveError {
    pub const fn public_message(self) -> &'static str {
        match self {
            Self::Dialog => "diagnostics save destination is unavailable",
            Self::Serialize | Self::Write => "diagnostics could not be saved",
        }
    }
}

pub struct NativeDiagnosticsSaveDialog<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> NativeDiagnosticsSaveDialog<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> DiagnosticsSaveDialog for NativeDiagnosticsSaveDialog<R> {
    fn choose_save_path(&self) -> Result<Option<PathBuf>, DiagnosticsSaveError> {
        self.app
            .dialog()
            .file()
            .set_title("Save Karakeep Transfer diagnostics")
            .set_file_name("karakeep-transfer-diagnostics.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
            .map(|file| file.into_path().map_err(|_| DiagnosticsSaveError::Dialog))
            .transpose()
    }
}

pub fn save_diagnostics_export(
    dialog: &impl DiagnosticsSaveDialog,
    export: &DiagnosticsExport,
) -> Result<bool, DiagnosticsSaveError> {
    let Some(path) = dialog.choose_save_path()? else {
        return Ok(false);
    };
    let mut contents =
        serde_json::to_string_pretty(export).map_err(|_| DiagnosticsSaveError::Serialize)?;
    contents.push('\n');
    fs::write(path, contents).map_err(|_| DiagnosticsSaveError::Write)?;
    Ok(true)
}
