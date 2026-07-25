use serde::Serialize;
use std::sync::RwLock;

use crate::{
    redaction::{DiagnosticSurface, SecretRedactor},
    versions::ComponentVersions,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentStatus {
    NotConfigured,
    Ready,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticFailure {
    BrowserAccess,
    DestinationAuthentication,
    DestinationCompatibility,
    Network,
    XCompatibility,
}

impl DiagnosticFailure {
    pub fn explanation(self) -> DiagnosticFailureExplanation {
        let (title, guidance) = match self {
            Self::BrowserAccess => (
                "Browser access unavailable",
                "Close the selected browser, confirm the browser profile still exists, and try again.",
            ),
            Self::DestinationAuthentication => (
                "Karakeep authentication failed",
                "Reconnect the destination with a valid Karakeep API key.",
            ),
            Self::DestinationCompatibility => (
                "Karakeep destination is not compatible",
                "Use a destination with the required authenticated API capabilities; v0.32.0 is the first tested baseline.",
            ),
            Self::Network => (
                "Network request failed",
                "Check the connection and confirm the Karakeep destination uses HTTPS or an explicitly accepted local exception.",
            ),
            Self::XCompatibility => (
                "X acquisition is temporarily unavailable",
                "X may have changed its private API. Existing snapshots remain available; check for a signed app update.",
            ),
        };

        DiagnosticFailureExplanation {
            kind: self,
            title,
            guidance,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticFailureExplanation {
    pub kind: DiagnosticFailure,
    pub title: &'static str,
    pub guidance: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorageSummary {
    pub data_directory: String,
    pub snapshot_bytes: u64,
    pub ledger_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticsInput {
    pub source: ComponentStatus,
    pub destination: ComponentStatus,
    pub storage: StorageSummary,
    pub last_failure: Option<DiagnosticFailure>,
}

impl Default for DiagnosticsInput {
    fn default() -> Self {
        Self {
            source: ComponentStatus::NotConfigured,
            destination: ComponentStatus::NotConfigured,
            storage: StorageSummary {
                data_directory: "not available".to_owned(),
                snapshot_bytes: 0,
                ledger_bytes: 0,
            },
            last_failure: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExport {
    pub generated_by_user_action: bool,
    pub includes_bookmark_content: bool,
    pub telemetry_enabled: bool,
    pub versions: ComponentVersions,
    pub source: ComponentStatus,
    pub destination: ComponentStatus,
    pub storage: RedactedStorageSummary,
    pub last_failure: Option<DiagnosticFailureExplanation>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedStorageSummary {
    pub data_directory: String,
    pub snapshot_bytes: u64,
    pub ledger_bytes: u64,
}

pub struct DiagnosticsStore {
    state: RwLock<DiagnosticsState>,
}

struct DiagnosticsState {
    input: DiagnosticsInput,
    versions: ComponentVersions,
    redactor: SecretRedactor,
}

impl Default for DiagnosticsStore {
    fn default() -> Self {
        Self::new(
            DiagnosticsInput::default(),
            ComponentVersions::current(),
            SecretRedactor::default(),
        )
    }
}

impl DiagnosticsStore {
    pub fn new(
        input: DiagnosticsInput,
        versions: ComponentVersions,
        redactor: SecretRedactor,
    ) -> Self {
        Self {
            state: RwLock::new(DiagnosticsState {
                input,
                versions,
                redactor,
            }),
        }
    }

    pub fn replace(
        &self,
        input: DiagnosticsInput,
        versions: ComponentVersions,
        redactor: SecretRedactor,
    ) -> Result<(), &'static str> {
        *self
            .state
            .write()
            .map_err(|_| "diagnostics state is unavailable")? = DiagnosticsState {
            input,
            versions,
            redactor,
        };
        Ok(())
    }

    pub fn set_source_status(&self, status: ComponentStatus) -> Result<(), &'static str> {
        self.state
            .write()
            .map_err(|_| "diagnostics state is unavailable")?
            .input
            .source = status;
        Ok(())
    }

    pub fn set_destination_status(&self, status: ComponentStatus) -> Result<(), &'static str> {
        self.state
            .write()
            .map_err(|_| "diagnostics state is unavailable")?
            .input
            .destination = status;
        Ok(())
    }

    pub fn record_source_failure(&self, failure: DiagnosticFailure) -> Result<(), &'static str> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "diagnostics state is unavailable")?;
        state.input.source = ComponentStatus::Unavailable;
        state.input.last_failure = Some(failure);
        Ok(())
    }

    pub fn record_destination_failure(
        &self,
        failure: DiagnosticFailure,
    ) -> Result<(), &'static str> {
        let mut state = self
            .state
            .write()
            .map_err(|_| "diagnostics state is unavailable")?;
        state.input.destination = ComponentStatus::Unavailable;
        state.input.last_failure = Some(failure);
        Ok(())
    }

    pub fn component_statuses(&self) -> Result<(ComponentStatus, ComponentStatus), &'static str> {
        let state = self
            .state
            .read()
            .map_err(|_| "diagnostics state is unavailable")?;
        Ok((state.input.source, state.input.destination))
    }

    pub fn explicit_export_with(
        &self,
        source: ComponentStatus,
        destination: ComponentStatus,
        storage: StorageSummary,
    ) -> Result<DiagnosticsExport, &'static str> {
        let state = self
            .state
            .read()
            .map_err(|_| "diagnostics state is unavailable")?;
        let input = DiagnosticsInput {
            source,
            destination,
            storage,
            last_failure: state.input.last_failure,
        };
        Ok(build_explicit_export(
            &input,
            state.versions.clone(),
            &state.redactor,
        ))
    }

    pub fn explicit_export(&self) -> Result<DiagnosticsExport, &'static str> {
        let state = self
            .state
            .read()
            .map_err(|_| "diagnostics state is unavailable")?;

        Ok(build_explicit_export(
            &state.input,
            state.versions.clone(),
            &state.redactor,
        ))
    }
}

pub fn build_explicit_export(
    input: &DiagnosticsInput,
    versions: ComponentVersions,
    redactor: &SecretRedactor,
) -> DiagnosticsExport {
    DiagnosticsExport {
        generated_by_user_action: true,
        includes_bookmark_content: false,
        telemetry_enabled: false,
        versions,
        source: input.source,
        destination: input.destination,
        storage: RedactedStorageSummary {
            data_directory: redactor.redact_text(
                DiagnosticSurface::Diagnostics,
                &input.storage.data_directory,
            ),
            snapshot_bytes: input.storage.snapshot_bytes,
            ledger_bytes: input.storage.ledger_bytes,
        },
        last_failure: input.last_failure.map(DiagnosticFailure::explanation),
    }
}
